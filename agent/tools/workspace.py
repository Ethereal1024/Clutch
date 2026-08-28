"""Workspace directory + path safety.

The agent works in the project's directory (the folder containing its .clc file).
Paths are resolved then checked to stay inside the workspace root; permission
rules guard risky actions. Certain files (the project's own .clc) are protected:
the agent cannot read, write, or even list them.
"""

from __future__ import annotations

import tempfile
from pathlib import Path


class Workspace:
    def __init__(self, root: str | None = None) -> None:
        self._own_dir = root is None
        self.root: Path = Path(root) if root else Path(tempfile.mkdtemp(prefix="clutch-"))
        self.root.mkdir(parents=True, exist_ok=True)
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

    def cleanup(self) -> None:
        if self._own_dir:
            import shutil

            shutil.rmtree(self.root, ignore_errors=True)
