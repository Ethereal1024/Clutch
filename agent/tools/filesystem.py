"""Filesystem tools: read_file / write_file / list_dir.

Each tool returns a structured dict; the registry formats it for the model.
"""

from __future__ import annotations

import difflib
import re
from pathlib import Path

from ..config import Config
from ..prompts import render
from .workspace import Workspace


def _result(content: str, error: bool = False, diff: str = "") -> dict:
    return {"content": content, "error": error, "diff": diff}


def read_file(
    workspace: Workspace,
    config: Config,
    path: str,
    max_chars: int = 0,
    offset: int = 0,
    limit: int = 0,
) -> dict:
    limit_chars = max_chars or config.read_max_chars
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(render("errors/protected_read.md", path=path), error=True)
        try:
            text = workspace.read(str(p))
        except FileNotFoundError:
            return _result(render("errors/file_missing.md", path=path), error=True)
        if offset > 0 or limit > 0:
            return _read_range(text, offset, limit, limit_chars)
        if len(text) > limit_chars:
            # tell the model how to continue (offset = the first unread line)
            # instead of silently re-serving the same truncated head, so it pages
            # forward rather than re-reading the file
            head = text[:limit_chars]
            next_offset = head.count("\n") + 1
            text = head + f"\n... [truncated, file is {len(text)} chars; use offset={next_offset} to continue]"
        return _result(text)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return _result(render("errors/read_failed.md", error=e), error=True)


def _read_range(text: str, offset: int, limit: int, limit_chars: int) -> dict:
    """Read lines [offset, offset+limit) (1-based) with line numbers, so the model
    reads only the slice it needs and can continue with offset=end+1. An explicit
    range that cannot fit the char budget is an ERROR, not a silent truncation —
    the model must narrow the limit or use grep (Claude Code's Read behavior)."""
    lines = text.splitlines()
    total = len(lines)
    start = max(0, offset - 1) if offset > 0 else 0
    end = start + limit if limit > 0 else total
    selected = lines[start:end]
    body = "\n".join(f"{i + 1}: {ln}" for i, ln in enumerate(selected, start=start))
    if len(body) > limit_chars:
        return _result(
            f"ERROR: the requested range (lines {start + 1}-{end}) exceeds the read limit of "
            f"{limit_chars} chars. Use a smaller limit, or search with grep instead.",
            error=True,
        )
    shown = start + len(selected)
    if shown < total:
        body += f"\n... (showing lines {start + 1}-{shown} of {total}; use offset={shown + 1} to continue)"
    return _result(body)


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
        if old:
            workspace.snapshot(p, old)
        workspace.write(str(p), content)
        # external paths (user-approved escapes) aren't under the root; show the
        # absolute path in the diff header then
        try:
            rel = p.relative_to(workspace.root)
        except ValueError:
            rel = p
        diff = _unified_diff(old, content, rel=rel)
        adds = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
        dels = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
        summary = f"OK: wrote {p} (+{adds} -{dels} lines)" if old else f"OK: wrote {p} ({len(content)} chars)"
        return _result(summary, diff=diff)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(render("errors/write_failed.md", error=e), error=True)


def edit_file(workspace: Workspace, config: Config, path: str, old_string: str, new_string: str) -> dict:
    """Targeted string replacement (Claude Code-style Edit): one occurrence of
    old_string is replaced with new_string. Tiny diffs — a change costs hundreds of
    tokens instead of re-emitting the whole file, so the context stays small and
    mid-task compaction (which wiped whole-file rewrites) is avoided."""
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(render("errors/protected_write.md", path=path), error=True)
        try:
            text = workspace.read(str(p))
        except FileNotFoundError:
            return _result(f"ERROR: file not found: {path} — use write_file to create it", error=True)
        if not old_string:
            return _result("ERROR: old_string is required", error=True)
        count = text.count(old_string)
        if count == 0:
            return _result(
                f"ERROR: old_string not found in {path}. The file's current content is in an "
                f"earlier read; re-read it if needed and provide a unique block of context.",
                error=True,
            )
        if count > 1:
            return _result(
                f"ERROR: old_string appears {count} times in {path}. Include more surrounding "
                "lines so it matches exactly once.",
                error=True,
            )
        new = text.replace(old_string, new_string, 1)
        workspace.snapshot(p, text)
        workspace.write(str(p), new)
        try:
            rel = p.relative_to(workspace.root)
        except ValueError:
            rel = p
        diff = _unified_diff(text, new, rel=rel)
        adds = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
        dels = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
        return _result(f"OK: edited {p} (+{adds} -{dels} lines)", diff=diff)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(render("errors/write_failed.md", error=e), error=True)


def revert_file(workspace: Workspace, config: Config, path: str) -> dict:
    """Restore the previous content of a file (the last write/edit is undone)."""
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(render("errors/protected_write.md", path=path), error=True)
        restored = workspace.restore(p)
        if restored is None:
            return _result(f"ERROR: no snapshot to restore for {path} — this file was never overwritten", error=True)
        return _result(f"OK: restored {p} to the previous content (undo of the last write/edit)")
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(f"ERROR: {e}", error=True)


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


def grep(workspace: Workspace, config: Config, pattern: str, path: str = ".", include: str = "") -> dict:
    try:
        hits = workspace.grep(pattern, path=path, include=include or None)
    except re.error as e:
        return _result(f"ERROR: invalid regex: {e}", error=True)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(f"ERROR: {e}", error=True)
    if not hits:
        return _result("(no matches)")
    lines: list[str] = []
    current: str | None = None
    for fpath, lineno, text in hits:
        if current != fpath:
            if current is not None:
                lines.append("")
            current = fpath
            lines.append(f"{fpath}:")
        lines.append(f"  Line {lineno}: {text[:300]}")
    content = "\n".join(lines)
    if len(hits) >= 100:
        content += "\n\n(Results capped at 100; use a more specific pattern or path.)"
    return _result(content)
