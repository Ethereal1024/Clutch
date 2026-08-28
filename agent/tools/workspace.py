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
from abc import ABC, abstractmethod
from pathlib import Path

from .transport import CommandResult, LocalTransport, Transport


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
