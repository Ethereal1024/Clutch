"""The file tools over a workspace, plus the host policy that guards them.

Two populations, one file, and the split is the backend's:

  * In the LOCAL backend the workspace COMPONENT (`clutch-workspace`, subject
    `workspace-fs`) declares read_file / grep / write_file / edit_file and its
    own daemon performs them. Nothing here is wired then: a host-side stand-in
    beside a component that really runs would be a second, silently divergent
    definition of what "read" means, which is exactly what the tool
    constitution forbids.
  * In the SSH backend there is no process on the far side to serve them —
    that is the premise of the backend, and the reason the tools are declared
    by the HOST there (tools/host.py: `_REMOTE_DECLARATIONS`). The
    implementation is this file: the same four calls, over the `Workspace`
    interface, whose `RemoteWorkspace` half is plain POSIX sh (cat / ls / find |
    xargs grep / printf appends) so a device that can only run an sshd shell is
    enough.

So this file holds the only implementation that exists on THIS side, and it is
wired in exactly the one backend where no component can be. The model-facing
text (line numbers, continuation hints, the diff, `(no matches)`) lives in
agent/prompts/tools/<name>.md and is byte-identical to the component's
description, so a call reads the same whichever machine served it.

That promise covers the answers too, not just the prose: a failed call says
exactly what the component's `--json` envelope says (`file not found: x`,
`old_string appears 2 times in x`) — no `ERROR: ` prefix, because the
component does not add one either (error-ness is the envelope's `error` field,
not a word in the sentence). tests/conform.test.js is the referee. The `ERROR: `
messages that DO stay are the ones a component never produces because the
policy is the host's alone: a protected path, an escape from the root, and a
transport/IO failure. Those are not divergences; they are the host speaking.

`guard_*` is the one thing a component does NOT carry, in either backend:
protection has to be checked on the host's side because the component's fence
deliberately covers only some of it — the fence refuses a mutation and hides a
path from broad sweeps, but still serves a path the caller names explicitly.
A read of the project's .clc is exactly the case it leaves open, so the refusal
lives here and the registry's guards ask these functions before the component
(or the host tool below) is ever spoken to.
"""

from __future__ import annotations

import difflib
import re
from pathlib import Path

from ..config import Config
from ..prompts import render
from .envelope import Envelope
from .workspace import Workspace


def _result(content: str, error: bool = False, diff: str = "") -> Envelope:
    return Envelope(content, error=error, diff=diff)


# --------------------------------------------------------------- host policy --


def _refuse_protected(workspace: Workspace, path: str, *, write: bool) -> Envelope | None:
    """The host's own protected-path refusal, or None when it does not apply."""
    try:
        p = workspace.resolve(path)
    except (OSError, ValueError):
        return None  # not a containment question: the component decides
    if not workspace.is_protected(p):
        return None
    template = "errors/protected_write.md" if write else "errors/protected_read.md"
    return _result(render(template, path=path), error=True)


def guard_read(workspace: Workspace, _config: Config, args: dict, arg: str = "path") -> Envelope | None:
    """registry guard: a protected path is not readable, named or not.

    `arg` is the argument the tool's own declaration says holds the path
    (catalog.Tool.access_arg -> registry.Tool.access_arg) — a component that
    calls it `file` is guarded exactly the same."""
    return _refuse_protected(workspace, str(args.get(arg, "")), write=False)


def guard_write(workspace: Workspace, _config: Config, args: dict, arg: str = "path") -> Envelope | None:
    """registry guard: a protected path is not writable/editable."""
    return _refuse_protected(workspace, str(args.get(arg, "")), write=True)


def guard_grep(workspace: Workspace, _config: Config, args: dict, arg: str = "path") -> Envelope | None:
    """registry guard: grep never searches a protected file — a walk skips it,
    and naming it explicitly yields the same empty result the walk produces."""
    path = str(args.get(arg) or ".")
    try:
        p = workspace.resolve(path)
    except (OSError, ValueError):
        return None
    if workspace.is_protected(p):
        return _result("(no matches)")
    return None


# ------------------------------------------------------------- the four tools --
#
# Each of these is wired as a HOST tool, and `registry._invoke` hands every host
# tool the Stop event (`cancel=`). The four accept it and do not consult it: a
# call is one workspace round trip whose transport already carries the session's
# timeout, and there is no loop of partial work here for a Stop to cut between.


def read_file(
    workspace: Workspace,
    config: Config,
    path: str,
    max_chars: int = 0,
    offset: int = 0,
    limit: int = 0,
    cancel: object = None,
) -> Envelope:
    limit_chars = max_chars or config.read_max_chars
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(render("errors/protected_read.md", path=path), error=True)
        # a directory reads as its entry listing; workspace.list raises
        # NotADirectoryError for a file or missing path
        try:
            entries = workspace.list(str(p))
        except NotADirectoryError:
            entries = None
        if entries is not None:
            if offset > 0 or limit > 0:
                msg = "cannot read a line range of a directory; list it without offset/limit"
                return _result(msg, error=True)
            return _result("\n".join(entries) if entries else "(empty directory)")
        try:
            text = workspace.read(str(p))
        except FileNotFoundError:
            return _result(render("errors/file_missing.md", path=path), error=True)
        if offset > 0 or limit > 0:
            return _read_range(text, offset, limit, limit_chars)
        if len(text) > limit_chars:
            # point the model at the first unread line instead of re-serving the same head
            head = text[:limit_chars]
            next_offset = head.count("\n") + 1
            text = head + f"\n... [truncated, file is {len(text)} chars; use offset={next_offset} to continue]"
        return _result(text)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return _result(render("errors/read_failed.md", error=e), error=True)


def _read_range(text: str, offset: int, limit: int, limit_chars: int) -> Envelope:
    """Read lines [offset, offset+limit) (1-based) with line numbers; a range
    that cannot fit the char budget is an ERROR, not a silent truncation."""
    lines = text.splitlines()
    total = len(lines)
    start = max(0, offset - 1) if offset > 0 else 0
    end = start + limit if limit > 0 else total
    selected = lines[start:end]
    body = "\n".join(f"{i + 1}: {ln}" for i, ln in enumerate(selected, start=start))
    if len(body) > limit_chars:
        return _result(
            f"the requested range (lines {start + 1}-{end}) exceeds the read limit of "
            f"{limit_chars} chars. Use a smaller limit, or search with grep instead.",
            error=True,
        )
    shown = start + len(selected)
    if shown < total:
        body += f"\n... (showing lines {start + 1}-{shown} of {total}; use offset={shown + 1} to continue)"
    return _result(body)


def write_file(workspace: Workspace, config: Config, path: str, content: str, cancel: object = None) -> Envelope:
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
        # external paths (approved escapes): show the absolute path in the diff header
        try:
            rel = p.relative_to(workspace.root)
        except ValueError:
            rel = p
        diff = _unified_diff(old, content, rel=rel)
        adds = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
        dels = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
        summary = f"OK: wrote {path} (+{adds} -{dels} lines)" if old else f"OK: wrote {path} ({len(content)} chars)"
        return _result(summary, diff=diff)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(render("errors/write_failed.md", error=e), error=True)


def edit_file(
    workspace: Workspace,
    config: Config,
    path: str,
    old_string: str,
    new_string: str,
    cancel: object = None,
) -> Envelope:
    """Targeted string replacement: one occurrence of old_string becomes new_string
    (tiny diffs keep the context small instead of re-emitting the whole file)."""
    try:
        p: Path = workspace.resolve(path)
        if workspace.is_protected(p):
            return _result(render("errors/protected_write.md", path=path), error=True)
        try:
            text = workspace.read(str(p))
        except FileNotFoundError:
            return _result(f"file not found: {path} — use write_file to create it", error=True)
        if not old_string:
            return _result("old_string is required", error=True)
        count = text.count(old_string)
        if count == 0:
            return _result(f"old_string not found in {path}", error=True)
        if count > 1:
            return _result(f"old_string appears {count} times in {path}", error=True)
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
        return _result(f"OK: edited {path} (+{adds} -{dels} lines)", diff=diff)
    except ValueError as e:
        return _result(f"ERROR: {e}", error=True)
    except Exception as e:  # noqa: BLE001
        return _result(render("errors/write_failed.md", error=e), error=True)


def _unified_diff(old: str, new: str, rel: str | Path) -> str:
    """Return a unified diff string between old and new file contents."""
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    diff_lines = list(difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{rel}", tofile=f"b/{rel}", n=3))
    return "".join(diff_lines)


def grep(
    workspace: Workspace,
    config: Config,
    pattern: str,
    path: str = ".",
    include: str = "",
    cancel: object = None,
) -> Envelope:
    try:
        # The declaration says "Python-style regex", so the pattern is judged by
        # the engine the declaration names, HERE — before the far side sees it.
        # A bad pattern then reads the same on both backends (`invalid regex: …`,
        # the component's frozen words) instead of one engine's stderr.
        re.compile(pattern)
        hits = workspace.grep(pattern, path=path, include=include or None)
    except re.error as e:
        return _result(f"invalid regex: {e}", error=True)
    except FileNotFoundError:
        return _result(f"file not found: {path}", error=True)
    except NotADirectoryError:
        return _result(f"file not found: {path}", error=True)
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
