"""The host's policy that guards a workspace's file tools.

The tools themselves are the workspace COMPONENT's: `clutch-workspace` (subject
`workspace-fs`) declares read_file / grep / write_file / edit_file and its own
daemon performs them, on the machine the root lives on. There is no host-side
stand-in beside it — a second, silently divergent definition of what "read" means
is exactly what the tool constitution forbids — and no imitation for a session
whose root this host cannot run that component on: such a root has
`run_command`, not a copy of the four.

`guard_*` is the one thing a component does NOT carry, in either backend:
protection has to be checked on the host's side because the component's fence
deliberately covers only some of it — the fence refuses a mutation and hides a
path from broad sweeps, but still serves a path the caller names explicitly. A
read of the project's .clc is exactly the case it leaves open, so the refusal
lives here and the registry's guards ask these functions before the component is
ever spoken to.
"""

from __future__ import annotations

from ..config import Config
from ..prompts import render
from .envelope import Envelope
from .workspace import Workspace


def _result(content: str, error: bool = False) -> Envelope:
    return Envelope(content, error=error)


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
