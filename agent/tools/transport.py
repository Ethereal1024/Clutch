"""Transport: run a shell command against the environment the agent works in.

Local now (subprocess); SSH (via the exec bridge) comes with the degradation
layer. The workspace keeps exactly one handle on the environment, so tools stay
transport-agnostic.

Every run takes a ``cancel`` event (Stop): both transports poll it while the
command is in flight and kill the command tree within ~0.2s of it being set —
a Stop must not have to wait out a long build. Local kills the whole tree
(POSIX process group / Windows ``taskkill /T``); remote abandons the bridge
wait (the bridge's own deadline reaps the remote exec).
"""

from __future__ import annotations

import base64
import json
import os
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from typing import Any, NamedTuple

from .localshell import local_shell

# how often an in-flight run re-checks its deadline and the Stop event
_CANCEL_POLL = 0.15


class CommandResult(NamedTuple):
    code: int
    stdout: str
    stderr: str


class TransportError(RuntimeError):
    """Transport-level failure (spawn error, timeout, unreachable bridge).

    ``timeout=True`` means the command hit its deadline, so callers can say so
    explicitly instead of lumping it in with generic execution failures.
    ``aborted=True`` means Stop cancelled it — also distinct from a generic
    failure (the model should hear "the user stopped this", not "it broke").
    """

    def __init__(self, message: str, *, timeout: bool = False, aborted: bool = False) -> None:
        super().__init__(message)
        self.timeout = timeout
        self.aborted = aborted


class Transport(ABC):
    @abstractmethod
    def run(
        self, command: str, timeout: float, *, binary: bool = False, cancel: threading.Event | None = None
    ) -> CommandResult: ...


def _drain(pipe, sink: list[bytes]) -> None:
    """Reader thread body: append everything a child pipe emits until EOF."""
    try:
        for chunk in iter(lambda: pipe.read(65536), b""):
            sink.append(chunk)
    except (OSError, ValueError):
        pass  # closed under us by the tree kill
    finally:
        try:
            pipe.close()
        except OSError:
            pass


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill the whole child tree, not just the direct child: a Stop must not
    leave the command's grandchildren running (the local twin of the
    supervisor's kill guarantee). POSIX: the child got its own process group
    (start_new_session), so a group SIGKILL is exact. Windows: ``taskkill /T``
    walks the tree; plain TerminateProcess (proc.kill) would only reap the
    shell and orphan whatever it spawned."""
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return
        except OSError:
            pass  # already gone or no group: fall through to the direct kill
    else:
        try:
            r = subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
            )
            if r.returncode == 0:
                return
        except (OSError, subprocess.TimeoutExpired):
            pass  # taskkill missing/denied: still drop the direct child
    try:
        proc.kill()
    except OSError:
        pass  # already dead


class LocalTransport(Transport):
    """Run commands via subprocess in a fixed cwd (the workspace root).

    The shell comes from local_shell(): a POSIX host's /bin/sh via shell=True;
    on Windows a detected Git Bash via `bash -c <cmd>` (the agent speaks POSIX)
    or, absent any bash, cmd.exe via shell=True — see localshell's module
    docstring. Text mode is pinned to utf-8/replace: a Chinese Windows box
    would otherwise decode command output as GBK and hand the model mojibake.
    """

    def __init__(self, cwd: str) -> None:
        self.cwd = cwd

    def run(
        self, command: str, timeout: float, *, binary: bool = False, cancel: threading.Event | None = None
    ) -> CommandResult:
        shell = local_shell()
        text = not binary
        try:
            proc = subprocess.Popen(
                [*shell.argv, command] if shell.argv else command,
                shell=shell.argv is None,
                cwd=self.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                # own session/process group on POSIX: the tree kill below then
                # cannot take the session server (a group mate) down with it
                start_new_session=os.name == "posix",
            )
        except OSError as e:
            raise TransportError(f"command could not start: {e}") from e

        # reader threads (not communicate()): the poll loop below must be free
        # to wait in small slices, and the pipes must never back up a blocked
        # child while we wait
        out: list[bytes] = []
        err: list[bytes] = []
        readers = [
            threading.Thread(target=_drain, args=(proc.stdout, out), daemon=True),
            threading.Thread(target=_drain, args=(proc.stderr, err), daemon=True),
        ]
        for t in readers:
            t.start()

        deadline = time.monotonic() + timeout
        while True:
            try:
                code = proc.wait(timeout=_CANCEL_POLL)
                break
            except subprocess.TimeoutExpired:
                if cancel is not None and cancel.is_set():
                    _kill_tree(proc)
                    proc.wait(timeout=10)
                    raise TransportError("command aborted by Stop", aborted=True) from None
                if time.monotonic() >= deadline:
                    _kill_tree(proc)
                    proc.wait(timeout=10)
                    raise TransportError(f"command timed out ({timeout:.0f}s)", timeout=True) from None
        for t in readers:
            t.join(timeout=10)
        if binary:
            # raw bytes round-tripped through latin-1 (lossless byte <-> str)
            return CommandResult(
                code,
                b"".join(out).decode("latin-1"),
                b"".join(err).decode("latin-1"),
            )
        return CommandResult(
            code,
            b"".join(out).decode("utf-8", errors="replace"),
            b"".join(err).decode("utf-8", errors="replace"),
        )


class SshTransport(Transport):
    """Run commands on a remote host through the Electron exec bridge.

    The remote only needs an sshd (no python, no SFTP, no base64): the client-side
    bridge turns POST /exec into an ssh exec channel, and for binary=True returns
    the raw stdout base64-encoded CLIENT-side. timeout is sent in ms (the
    bridge's remoteExec deadline); a timed-out remote exec comes back as code -1,
    surfaced here as TransportError(timeout=True) like LocalTransport.
    """

    def __init__(self, bridge_url: str) -> None:
        self.bridge_url = bridge_url.rstrip("/")

    def run(
        self, command: str, timeout: float, *, binary: bool = False, cancel: threading.Event | None = None
    ) -> CommandResult:
        body = json.dumps({"command": command, "timeout": int(timeout * 1000), "binary": binary}).encode(
            "utf-8"
        )
        req = urllib.request.Request(
            self.bridge_url + "/exec",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        # urlopen parks in a socket read until the bridge answers, and a socket
        # timeout would cut off a legitimately slow command — so the call runs
        # in a helper thread and Stop abandons the wait. The bridge's own
        # deadline still reaps the remote exec; only the agent's wait ends.
        result: dict[str, Any] = {}

        def _call() -> None:
            try:
                with urllib.request.urlopen(req, timeout=timeout + 5) as r:
                    result["payload"] = json.loads(r.read().decode("utf-8", errors="replace"))
            except Exception as e:  # noqa: BLE001 -- re-raised by kind below
                result["error"] = e

        worker = threading.Thread(target=_call, daemon=True)
        worker.start()
        while worker.is_alive():
            if cancel is not None and cancel.is_set():
                raise TransportError("command aborted by Stop", aborted=True) from None
            worker.join(_CANCEL_POLL)
        err = result.get("error")
        if err is not None:
            if isinstance(err, urllib.error.HTTPError):
                raise TransportError(f"bridge error {err.code}: {err.read().decode('utf-8', errors='replace')}") from err
            raise TransportError(f"bridge unreachable: {err}") from err
        payload = result["payload"]
        if payload.get("code") == -1:
            raise TransportError(f"command timed out ({timeout:.0f}s)", timeout=True)
        if binary:
            raw = base64.b64decode(payload.get("stdout_b64") or "")
            return CommandResult(
                int(payload.get("code", 1)),
                raw.decode("latin-1"),
                payload.get("stderr", ""),
            )
        return CommandResult(
            int(payload.get("code", 1)),
            payload.get("stdout", ""),
            payload.get("stderr", ""),
        )
