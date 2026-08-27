"""Sandbox directory + path safety.

All tools run inside this directory; cwd is fixed and every path is resolved then
checked to stay inside the sandbox root, preventing `../` escapes.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


class Sandbox:
    def __init__(self, root: str | None = None) -> None:
        # temp dir when not provided; caller-provided dir is reused (visible in demos)
        self._own_dir = root is None
        self.root: Path = Path(root) if root else Path(tempfile.mkdtemp(prefix="clutch-"))
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, rel_path: str) -> Path:
        """Resolve a path to inside the sandbox; raise ValueError on escape."""
        p = (self.root / rel_path).resolve()
        if not p.is_relative_to(self.root):
            raise ValueError(f"path escapes sandbox: {rel_path!r}")
        return p

    def reset(self) -> None:
        """Clear all contents, keeping the root dir (avoids residue from past runs)."""
        import shutil

        for child in self.root.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)

    def cleanup(self) -> None:
        if self._own_dir:
            import shutil

            shutil.rmtree(self.root, ignore_errors=True)
