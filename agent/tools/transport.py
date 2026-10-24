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

from .envelope import Envelope
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


def failure_envelope(err: TransportError, *, timeout_seconds: float) -> Envelope:
    """One rendering of a transport failure as the model's envelope.

    A transport verdict is not the command's: an abort is the user's Stop, a
    timeout is the budget, anything else means the command never ran. Every
    caller that turns one into a tool result (run_command, the statement layer)
    asks here, so the model reads the same prose wherever the command came from.
    """
    from ..prompts import render  # local: the transport stays a leaf module

    if err.aborted:
        return Envelope(render("errors/command_aborted.md"), error=True)
    if err.timeout:
        return Envelope(
            render(
                "errors/command_timeout.md",
                seconds=f"{timeout_seconds:.0f}s",
                hint=render("errors/interactive_hint.md"),
            ),
            error=True,
        )
    return Envelope(render("errors/execution_failed.md", error=err), error=True)


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


# ---- a child's bytes -> the text the model reads -----------------------------

_fallback_encodings: tuple[str, ...] | None = None


def _norm_codec(name: str) -> str:
    """One spelling for "is this the same codec?": utf-8 / UTF8 / 'utf_8' are."""
    return name.lower().replace("-", "").replace("_", "").replace(" ", "")


def _code_page_encodings() -> tuple[str, ...]:
    """The code pages a Windows child writes in, best first (computed once).

    Only Windows has a second spelling to try: cmd.exe's builtins (dir, type,
    echo) and most console programs write the OEM code page, tools that hand
    their text to a pipe write the ANSI one — on a Chinese box both are 936
    (GBK). On POSIX the answer is always UTF-8, so nothing else is tried there:
    latin-1 "succeeds" on any byte sequence and would silently mangle them.
    """
    global _fallback_encodings
    if _fallback_encodings is None:
        found: list[str] = []
        if os.name == "nt":
            try:
                import ctypes  # noqa: PLC0415 -- Windows-only, imported lazily

                kernel32 = ctypes.windll.kernel32
                # 65001 IS UTF-8 (already tried) and UTF-16/32 never reaches a
                # pipe as the raw bytes we read here
                for cp in (kernel32.GetOEMCP(), kernel32.GetACP()):
                    cp = int(cp)
                    if cp and cp not in (65001, 1200, 1201, 12000, 12001):
                        name = f"cp{cp}"
                        if all(_norm_codec(name) != _norm_codec(e) for e in found):
                            found.append(name)
            except Exception:  # noqa: BLE001 -- no ctypes/kernel32: keep locale
                pass
            try:
                import locale  # noqa: PLC0415

                name = locale.getpreferredencoding(False)
                if name and _norm_codec(name) not in ("utf8", "cp65001"):
                    if all(_norm_codec(name) != _norm_codec(e) for e in found):
                        found.append(name)
            except Exception:  # noqa: BLE001 -- best effort only
                pass
        _fallback_encodings = tuple(found)
    return _fallback_encodings


def _split_lines(data: bytes) -> list[bytes]:
    """Lines split on LF only, terminator kept.

    LF (with the CR before it) is how a command terminates a line. The other
    break points ``bytes.splitlines()`` uses (\\v, \\f, \\x1c-\\x1e) are bytes
    a writer can mean as TEXT, and cutting there would let one fragment decide
    another's encoding. No split point can fall inside a multi-byte character:
    every lead and continuation byte is >= 0x80.
    """
    pieces = data.split(b"\n")
    lines = [piece + b"\n" for piece in pieces[:-1]]
    if pieces[-1]:
        lines.append(pieces[-1])
    return lines


def _decode_line(raw: bytes) -> str:
    for encoding in ("utf-8", *_code_page_encodings()):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def decode_output(data: bytes) -> str:
    """A command's raw output as the text the model reads.

    UTF-8 is tried first and whole: Git Bash/MSYS tools, the agent's own
    children and everything modern write it. But on a Chinese Windows box
    cmd.exe's builtins and console programs write GBK (code page 936), and
    decoding those bytes as UTF-8 replaced every Chinese character with U+FFFD
    — the mojibake the model used to get for any output containing Chinese. So:
    the whole buffer as UTF-8, then as the host's code pages, then line by line,
    because one command can mix writers (a Windows exe's GBK line after a Git
    Bash tool's UTF-8 one).
    """
    if not data:
        return ""
    for encoding in ("utf-8", *_code_page_encodings()):
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return "".join(_decode_line(line) for line in _split_lines(data))


class LocalTransport(Transport):
    """Run commands via subprocess in a fixed cwd (the workspace root).

    The shell comes from local_shell(): a POSIX host's /bin/sh via shell=True;
    on Windows a detected Git Bash via `bash -c <cmd>` (the agent speaks POSIX)
    or, absent any bash, cmd.exe via shell=True — see localshell's module
    docstring. Output bytes go through decode_output(): UTF-8 when they are
    UTF-8, the host's code page (GBK on a Chinese Windows box) when they are
    not — a plain utf-8/replace decode is what turned every Chinese line of
    `dir` output into U+FFFD.
    """

    def __init__(self, cwd: str) -> None:
        self.cwd = cwd

    def run(
        self, command: str, timeout: float, *, binary: bool = False, cancel: threading.Event | None = None
    ) -> CommandResult:
        shell = local_shell()
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
            decode_output(b"".join(out)),
            decode_output(b"".join(err)),
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
                detail = err.read().decode("utf-8", errors="replace")
                raise TransportError(f"bridge error {err.code}: {detail}") from err
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
