"""Host policy for the file tools: the protected-path guard, and nothing else.

The tools themselves — read_file / grep / write_file / edit_file — are the
clutch-workspace COMPONENT's, declared in tools/catalog.py and performed by the
component's daemon (or its installed executable). This file holds no
implementation of any of them: a host-side stand-in would be a second, silently
divergent definition of what "read" means, which is exactly what the tool
constitution forbids. What is left is the one thing the component does NOT
carry: the host's own refusal to read or write a path the workspace protects.

Protection has to be checked on the host's side because the component's fence
deliberately covers only some of it: the fence refuses a mutation and hides a
path from broad sweeps, but still serves a path the caller names explicitly
(that is its stated rule). A read of the project's .clc is exactly the case it
leaves open, so the refusal lives here and the registry's guards ask this
function before the component is ever spoken to.
"""

from __future__ import annotations

from ..config import Config
from ..prompts import render
from .envelope import Envelope
from .workspace import Workspace


def _result(content: str, error: bool = False, diff: str = "") -> Envelope:
    return Envelope(content, error=error, diff=diff)


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
