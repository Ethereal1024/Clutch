"""Workspace directory + path safety.

The agent works in the user's chosen directory (not a private sandbox). Paths are
resolved then checked to stay inside the workspace root; permission rules (not a
hidden sandbox) guard risky actions that leave it.
"""

from __future__ import annotations

import tempfile
from pathlib import Path


class Workspace:
    def __init__(self, root: str | None = None) -> None:
        # caller-provided dir is the user's working directory; a temp dir is the
        # default when none is given (e.g. CLI without --workdir)
        self._own_dir = root is None
        self.root: Path = Path(root) if root else Path(tempfile.mkdtemp(prefix="clutch-"))
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, rel_path: str) -> Path:
        """Resolve a path to inside the workspace; raise ValueError on escape."""
        p = (self.root / rel_path).resolve()
        if not p.is_relative_to(self.root):
            raise ValueError(f"path escapes workspace: {rel_path!r}")
        return p

    def is_in_workspace(self, path: str) -> bool:
        """True if the given (possibly absolute) path resolves inside the root."""
        try:
            p = (self.root / path).resolve()
            return p.is_relative_to(self.root)
        except (ValueError, OSError):
            return False

    def cleanup(self) -> None:
        if self._own_dir:
            import shutil

            shutil.rmtree(self.root, ignore_errors=True)
