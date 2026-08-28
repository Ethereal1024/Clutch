"""Transport: run a shell command against the environment the agent works in.

Local now (subprocess); SSH (via the exec bridge) comes with the degradation
layer. The workspace keeps exactly one handle on the environment, so tools stay
transport-agnostic.
"""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from typing import NamedTuple


class CommandResult(NamedTuple):
    code: int
    stdout: str
    stderr: str


class TransportError(RuntimeError):
    """Transport-level failure (spawn error, timeout, unreachable bridge).

    ``timeout=True`` means the command hit its deadline, so callers can say so
    explicitly instead of lumping it in with generic execution failures.
    """

    def __init__(self, message: str, *, timeout: bool = False) -> None:
        super().__init__(message)
        self.timeout = timeout


class Transport(ABC):
    @abstractmethod
    def run(self, command: str, timeout: float) -> CommandResult: ...


class LocalTransport(Transport):
    """Run commands via subprocess in a fixed cwd (the workspace root)."""

    def __init__(self, cwd: str) -> None:
        self.cwd = cwd

    def run(self, command: str, timeout: float) -> CommandResult:
        try:
            r = subprocess.run(
                command,
                shell=True,
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise TransportError(f"command timed out ({timeout:.0f}s)", timeout=True) from None
        except OSError as e:
            raise TransportError(f"command could not start: {e}") from e
        return CommandResult(r.returncode, r.stdout or "", r.stderr or "")


class SshTransport(Transport):
    """Run commands on a remote host through the Electron exec bridge.

    The remote only needs an sshd (no python, no SFTP, no base64): the client-side
    bridge turns POST /exec into an ssh exec channel. timeout is sent in ms (the
    bridge's remoteExec deadline); a timed-out remote exec comes back as code -1,
    surfaced here as TransportError(timeout=True) like LocalTransport.
    """

    def __init__(self, bridge_url: str) -> None:
        self.bridge_url = bridge_url.rstrip("/")

    def run(self, command: str, timeout: float) -> CommandResult:
        body = json.dumps({"command": command, "timeout": int(timeout * 1000)}).encode("utf-8")
        req = urllib.request.Request(
            self.bridge_url + "/exec",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout + 5) as r:
                payload = json.loads(r.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as e:
            raise TransportError(f"bridge error {e.code}: {e.read().decode('utf-8', errors='replace')}") from e
        except (urllib.error.URLError, OSError) as e:
            raise TransportError(f"bridge unreachable: {e}") from e
        if payload.get("code") == -1:
            raise TransportError(f"command timed out ({timeout:.0f}s)", timeout=True)
        return CommandResult(
            int(payload.get("code", 1)),
            payload.get("stdout", ""),
            payload.get("stderr", ""),
        )
