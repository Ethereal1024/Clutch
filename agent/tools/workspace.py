"""Workspace directory + path safety.

The agent works in the project's directory (the folder containing its .clc file).
Paths are resolved then checked to stay inside the workspace root; permission
rules guard risky actions. Certain files (the project's own .clc) are protected:
the agent cannot read, write, or even list them.

Workspace is the base class: it owns root/path-safety/transport and lets
subclasses define how files are actually touched. LocalWorkspace uses Path
operations; RemoteWorkspace (SSH degradation layer) maps read/write/list to sh
commands executed through the transport. Tools only see the Workspace interface,
so local and remote behave identically.
"""

from __future__ import annotations

import tempfile
import time
from abc import ABC, abstractmethod
from pathlib import Path

from .transport import CommandResult, LocalTransport, SshTransport, Transport


def shq(s: str) -> str:
    """Single-quote a path for sh: `'` -> `'\\''` (works on any POSIX shell)."""
    return "'" + s.replace("'", "'\\''") + "'"


class Workspace(ABC):
    def __init__(self, root: str | None = None, transport: Transport | None = None) -> None:
        self._own_dir = root is None
        self.root: Path = Path(root) if root else Path(tempfile.mkdtemp(prefix="clutch-"))
        self.root.mkdir(parents=True, exist_ok=True)
        self._transport = transport or LocalTransport(str(self.root))
        self._protected: set[Path] = set()

    def protect(self, path: Path) -> None:
        """Mark a file as invisible/unusable to the agent (e.g. the .clc project file)."""
        self._protected.add(Path(path).resolve())

    def is_protected(self, path: Path) -> bool:
        try:
            return Path(path).resolve() in self._protected
        except OSError:
            return False

    def visible_entries(self, root: Path) -> list[Path]:
        """Directory entries excluding protected files."""
        out = []
        for ent in sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if self.is_protected(ent):
                continue
            out.append(ent)
        return out

    def resolve(self, rel_path: str) -> Path:
        """Resolve a path to inside the workspace; raise ValueError on escape."""
        p = (self.root / rel_path).resolve()
        if not p.is_relative_to(self.root):
            raise ValueError(f"path escapes workspace: {rel_path!r}")
        return p

    def run(self, command: str, timeout: float) -> CommandResult:
        """Run a shell command in the workspace; transport-specific cwd handling."""
        return self._transport.run(command, timeout)

    @abstractmethod
    def read(self, path: str) -> str:
        """Return file contents; raise FileNotFoundError if missing."""

    @abstractmethod
    def write(self, path: str, content: str) -> None:
        """Create or overwrite a file (parents created as needed)."""

    @abstractmethod
    def list(self, path: str) -> list[str]:
        """Directory entries (dirs end with '/'), protected files excluded; raise NotADirectoryError."""

    @abstractmethod
    def append_line(self, path: str, line: str) -> None:
        """Append one line to a file (the remote .clc EventLog writer)."""

    def cleanup(self) -> None:
        if self._own_dir:
            import shutil

            shutil.rmtree(self.root, ignore_errors=True)


class LocalWorkspace(Workspace):
    def read(self, path: str) -> str:
        p = self.resolve(path)
        if not p.is_file():
            raise FileNotFoundError(path)
        return p.read_text(encoding="utf-8", errors="replace")

    def write(self, path: str, content: str) -> None:
        p = self.resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")

    def list(self, path: str) -> list[str]:
        p = self.resolve(path)
        if not p.is_dir():
            raise NotADirectoryError(path)
        return sorted(f.name + ("/" if f.is_dir() else "") for f in self.visible_entries(p))

    def append_line(self, path: str, line: str) -> None:
        p = self.resolve(path)
        with open(p, "a", encoding="utf-8") as f:
            f.write(line + "\n")


class RemoteWorkspace(Workspace):
    """Workspace whose files live on a remote host reached over the exec bridge.

    Every exec starts a fresh shell, so read/write/list use absolute paths and
    run() prefixes `cd '<root>' &&` for the same cwd semantics as LocalWorkspace.
    File operations are plain POSIX sh — cat, a quoted heredoc (no base64, no
    SFTP), ls — so any device that can run an sshd shell works.
    """

    def __init__(self, root: str | None, bridge_url: str) -> None:
        super().__init__(root, transport=SshTransport(bridge_url))

    def run(self, command: str, timeout: float) -> CommandResult:
        return self._transport.run(f"cd {shq(str(self.root))} && {command}", timeout)

    def read(self, path: str) -> str:
        p = self.resolve(path)
        r = self._transport.run(f"cat {shq(str(p))}", 60.0)
        if r.code != 0:
            raise FileNotFoundError(str(p))
        return r.stdout

    def write(self, path: str, content: str) -> None:
        p = self.resolve(path)
        # quoted heredoc: content is fully literal ($, backticks, quotes all safe);
        # strips the file's own trailing newline so the heredoc's own one restores it
        delim = f"CLUTCH_EOF_{time.time_ns()}"
        body = content[:-1] if content.endswith("\n") else content
        cmd = f"mkdir -p {shq(str(p.parent))} && cat > {shq(str(p))} <<'{delim}'\n{body}\n{delim}"
        r = self._transport.run(cmd, 60.0)
        if r.code != 0:
            raise OSError(f"write failed (exit {r.code}): {(r.stderr or r.stdout)[:300]}")

    def list(self, path: str) -> list[str]:
        p = self.resolve(path)
        # ls alone succeeds on a plain file; test -d first so a non-dir surfaces
        # as NotADirectoryError like LocalWorkspace.list
        r = self._transport.run(f"test -d {shq(str(p))} && ls -1AF {shq(str(p))}", 60.0)
        if r.code != 0:
            raise NotADirectoryError(str(p))
        out = []
        for entry in r.stdout.splitlines():
            if not entry:
                continue
            if entry.endswith("/"):  # ls -1AF marks dirs with a trailing /
                out.append(entry)
                continue
            name = entry[:-1] if entry[-1] in ("*", "@") else entry
            if self.is_protected(p / name):
                continue
            out.append(name)
        return sorted(out)

    def append_line(self, path: str, line: str) -> None:
        p = self.resolve(path)
        delim = f"CLUTCH_EOF_{time.time_ns()}"
        cmd = f"cat >> {shq(str(p))} <<'{delim}'\n{line}\n{delim}"
        r = self._transport.run(cmd, 30.0)
        if r.code != 0:
            raise OSError(f"append failed (exit {r.code}): {(r.stderr or r.stdout)[:300]}")
