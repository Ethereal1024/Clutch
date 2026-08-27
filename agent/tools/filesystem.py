"""Filesystem tools: read_file / write_file / list_dir.

Each tool returns a structured dict; the registry formats it for the model.
"""

from __future__ import annotations

import difflib
from pathlib import Path

from ..config import Config
from .workspace import Workspace


def _result(content: str, error: bool = False, diff: str = "") -> dict:
    return {"content": content, "error": error, "diff": diff}


def read_file(workspace: Workspace, config: Config, path: str, max_chars: int = 0) -> dict:
    limit = max_chars or config.read_max_chars
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(f"ERROR: cannot read protected file: {path}", error=True)
        if not p.is_file():
            return _result(f"ERROR: not a file or missing: {path}", error=True)
        text = p.read_text(encoding="utf-8", errors="replace")
        if len(text) > limit:
            text = text[:limit] + f"\n... [truncated, file is {p.stat().st_size} bytes]"
        return _result(text)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return _result(f"ERROR: read failed: {e}", error=True)


def write_file(workspace: Workspace, config: Config, path: str, content: str) -> dict:
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(f"ERROR: cannot write protected file: {path}", error=True)
        # capture the previous content (if any) to build a unified diff
        old = ""
        if p.is_file():
            old = p.read_text(encoding="utf-8", errors="replace")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        diff = _unified_diff(old, content, rel=p.relative_to(workspace.root))
        adds = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
        dels = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
        summary = f"OK: wrote {p} (+{adds} -{dels} lines)" if old else f"OK: wrote {p} ({len(content)} chars)"
        return _result(summary, diff=diff)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(f"ERROR: write failed: {e}", error=True)


def _unified_diff(old: str, new: str, rel: str) -> str:
    """Return a unified diff string between old and new file contents."""
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    diff_lines = list(
        difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{rel}", tofile=f"b/{rel}", n=3)
    )
    # unified_diff returns [] when files are identical; treat identical as "no changes"
    return "".join(diff_lines)


def list_dir(workspace: Workspace, config: Config, path: str = ".") -> dict:
    try:
        p: Path = workspace.resolve(path)
        if not p.is_dir():
            return _result(f"ERROR: not a directory: {path}", error=True)
        lines = sorted(f.name + ("/" if f.is_dir() else "") for f in workspace.visible_entries(p))
        return _result("\n".join(lines) if lines else "(empty directory)")
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(f"ERROR: {e}", error=True)
