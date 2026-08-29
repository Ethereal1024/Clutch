"""Filesystem tools: read_file / write_file / list_dir.

Each tool returns a structured dict; the registry formats it for the model.
"""

from __future__ import annotations

import difflib
from pathlib import Path

from ..config import Config
from ..prompts import render
from .workspace import Workspace


def _result(content: str, error: bool = False, diff: str = "") -> dict:
    return {"content": content, "error": error, "diff": diff}


def read_file(workspace: Workspace, config: Config, path: str, max_chars: int = 0) -> dict:
    limit = max_chars or config.read_max_chars
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(render("errors/protected_read.md", path=path), error=True)
        try:
            text = workspace.read(str(p))
        except FileNotFoundError:
            return _result(render("errors/file_missing.md", path=path), error=True)
        if len(text) > limit:
            text = text[:limit] + f"\n... [truncated, file is {len(text)} chars]"
        return _result(text)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return _result(render("errors/read_failed.md", error=e), error=True)


def write_file(workspace: Workspace, config: Config, path: str, content: str) -> dict:
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(render("errors/protected_write.md", path=path), error=True)
        # capture the previous content (if any) to build a unified diff
        old = ""
        try:
            old = workspace.read(str(p))
        except FileNotFoundError:
            pass
        workspace.write(str(p), content)
        diff = _unified_diff(old, content, rel=p.relative_to(workspace.root))
        adds = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
        dels = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
        summary = f"OK: wrote {p} (+{adds} -{dels} lines)" if old else f"OK: wrote {p} ({len(content)} chars)"
        return _result(summary, diff=diff)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(render("errors/write_failed.md", error=e), error=True)


def _unified_diff(old: str, new: str, rel: str) -> str:
    """Return a unified diff string between old and new file contents."""
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    diff_lines = list(difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{rel}", tofile=f"b/{rel}", n=3))
    # unified_diff returns [] when files are identical; treat identical as "no changes"
    return "".join(diff_lines)


def list_dir(workspace: Workspace, config: Config, path: str = ".") -> dict:
    try:
        p: Path = workspace.resolve(path)
        try:
            entries = workspace.list(str(p))
        except NotADirectoryError:
            return _result(render("errors/not_a_directory.md", path=path), error=True)
        lines = sorted(entries)
        return _result("\n".join(lines) if lines else "(empty directory)")
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(f"ERROR: {e}", error=True)
