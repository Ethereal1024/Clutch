"""The host's own tools, and why they are not components'.

With nothing installed the host's whole surface is its own four tools, and each
of them is here for a reason a component could not be:

  * `run_command` — the loop's escape hatch, the way anything gets looked at on a
    machine before a component is there. It cannot be a component: the component
    that declared it could only be installed by first running a command, so the
    host would have nothing to install it with. It is the ONE declared bootstrap
    exception.
  * `trigger` — the same command text, waited on. `run_command` answers inside
    config.command_timeout (30 s) because it is the loop's look-around tool; a
    build or a training run outlives that, and the model's only other way to wait
    is to poll, which spends a model call per look. A component could not declare
    it: a statement is run with the same command budget (that is the number the
    registry hands `Statement.execute`), so a declaration promising a longer wait
    would be a promise its own runner would break. The clock is the host's.
  * `grep_memory` / `read_memory` — the readers of the project's own log (recall.py).
    The file they read is the one file this host writes, protects, and already
    holds open: the loop appends to its bytes, and reading it back means using the
    reader that open holds (a seek into the same file).
    A component would have to be handed those bytes over a second channel to say
    the same thing — a second copy of the file, and a second thing to keep in sync.

"Declared" is what this module is for: what the model sees of each one — its name,
its prose, its schema, the policy it runs under, how its call looks — is data in
the very vocabulary a manifest's tool entry speaks (catalog.Tool), parsed by the
same parser and checked by the same diagnostics (registry._bootstrap), so there is
one declaration shape in this host and one place to look for these tools.

The four workspace tools — `read_file`, `grep`, `write_file`, `edit_file` — are
NOT here, and the absence is deliberate: they are `clutch-workspace`'s to declare,
and its daemon performs them on the machine the root lives on. A session whose
root has no daemon therefore has no file tools at all — `run_command` is the one
way its files are read and written. The host used to declare the four itself for
exactly that session; that copy is gone (it was a second definition of what
"read" means, and nothing here could honor it), so a root with no daemon has no
file tools rather than a host-side imitation. What decides which components a
session may offer stays in registry.build_tools.

What a component's declaration does not have, and these must, is the
implementation: a component's statement IS its implementation, while the host's
tools are host code — the command text is one statement, the log reader is
another — and what decides whether each may run stays here too
(registry.Tool.access -> permission: the read-only classifier, the escape and
protected-path guard, the timeout, truncation and Stop, all of them the host's).
A component would only re-say "run this" while every decision stayed in the host.

The four in `_DECLARATIONS` are also the names no component may take: a component
that publishes one of them is refused where every other unreadable word is refused
(catalog.component_diagnostics), `names()` is the vocabulary entry
catalog.HOST_TOOL_NAMES, and registry._check_vocabulary asserts at import that
the two lists agree. The exception is declared, then, and not quietly
inheritable.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable, NamedTuple

from ..config import Config
from ..prompts import render
from . import recall, shell
from .envelope import Envelope

# What the host calls itself when a refusal or a diagnostic has to name the owner
# of one of its own declarations. Not a component: nothing is installed,
# discovered or launched under this name.
NAME = "clutch-host"

# (workspace, config, **args) -> the result the model reads — the host's side of
# registry.ToolImpl, spelled here so a host declaration carries its own code.
HostImpl = Callable[..., Envelope]


class Declaration(NamedTuple):
    """One tool the host declares for itself.

    `declaration` is manifest-shaped data (a `tools` entry of a component.json),
    without the name and the prose, which `declarations()` fills in from the two
    fields beside it; `implementation` is the host code that satisfies it — the
    one field a component's declaration never has, because a component's
    statement is its implementation.

    `needs_log` is what a host tool cannot say in a manifest: it reads the
    session's own project log, and the log is not an argument the model may pass
    — the registry hands the open's log in (registry.ToolRegistry._invoke), so
    the model can never point the reader at a file of its choosing.

    `client_native` marks a tool that runs on the client, not in the execution
    layer. The client dispatch path recognizes this flag and runs the tool
    directly without calling /api/exec. The implementation is None for these.
    """

    name: str
    declaration: Mapping[str, Any]
    implementation: HostImpl
    needs_log: bool = False
    client_native: bool = False


# The host's own tools, as data. A declaration here may name any word the host's
# vocabulary has (access / gate / modes / ui keys), and every one of them is
# validated exactly as a component's would be.
_DECLARATIONS: tuple[Declaration, ...] = (
    Declaration(
        "run_command",
        {
            "parameters": {
                "properties": {"command": {"type": "string", "description": "shell command string to run"}},
                "required": ["command"],
            },
            "access": "command",
            "ui": {"preview": "command"},
        },
        shell.run_command,
    ),
    Declaration(
        "trigger",
        {
            "parameters": {
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "shell command string to run; the loop waits for it to finish "
                        "(up to six hours) instead of the command tool's short budget",
                    },
                },
                "required": ["command"],
            },
            "access": "command",
            "ui": {"preview": "command", "summary": "trigger {command}"},
        },
        shell.run_trigger,
    ),
    Declaration(
        "grep_memory",
        {
            "parameters": {
                "properties": {
                    "pattern": {"type": "string", "description": "regular expression, matched per line"},
                    "include": {
                        "type": "string",
                        "description": "only lines of this event type (a glob: user_message, tool_*, note, ...)",
                    },
                    "max_hits": {
                        "type": "integer",
                        "description": "stop after this many matching lines (default 20, at most 200)",
                    },
                },
                "required": ["pattern"],
            },
            # No host-side path policy: the tool has no path argument at all, and
            # the one file it reads is the one the workspace's fence exists to
            # protect — the inverted case recall.py's docstring explains.
            "access": "",
            # Only a session with a project open has a log to read; with none, the
            # model is not offered a reader that could only say "no log".
            "gate": "project",
            "ui": {
                "group": "memory",
                "form": "row",
                "summary": "grep memory /{pattern}/",
                "preview": {"mode": "content", "keys": ["pattern"]},
                "collapse": "long",
            },
        },
        recall.grep_memory,
        needs_log=True,
    ),
    Declaration(
        "read_memory",
        {
            "parameters": {
                "properties": {
                    "offset": {
                        "type": "integer",
                        "description": "1-based line to start at (omit for the newest lines)",
                    },
                    "limit": {"type": "integer", "description": "how many lines to read (default 40, at most 200)"},
                },
                "required": [],
            },
            "access": "",
            "gate": "project",
            "ui": {
                "group": "memory",
                "form": "row",
                "summary": "read memory",
                "preview": {"mode": "content", "keys": ["offset", "limit"]},
                "collapse": "long",
            },
        },
        recall.read_memory,
        needs_log=True,
    ),
)

# The tools whose implementation is the CLIENT's, not the execution layer's.
# A `sleep` that suspends the loop, and a ticker (`start_tick`/`end_tick`) that
# pokes it awake: neither is a shell statement, neither writes anything, and
# neither has any business in a permission engine — what they do is wait and
# append to the log the client already owns. The declaration travels to the
# model exactly like the host's own (same parser, same diagnostics, same prose
# convention), but the CALL is answered by the client host's dispatcher
# (ui/src/host/client-tools.ts) without a POST /api/exec round trip, and a call
# for one of these names that reaches the exec endpoint anyway is refused there
# rather than run (registry.ToolRegistry._invoke).
#
# `trigger` used to live here and does not any more: it runs a command, so it
# belongs to the layer that owns the command policy and the transport clock —
# see its entry in `_DECLARATIONS` and tools/shell.py:run_trigger.
_CLIENT_NATIVE_DECLARATIONS: tuple[Declaration, ...] = (
    Declaration(
        "sleep",
        {
            "parameters": {
                "properties": {
                    "seconds": {
                        "type": "number",
                        "description": "how long to suspend the loop, in seconds (at most 3600; "
                        "0 is refused — use start_tick for a heartbeat)",
                    },
                },
                "required": ["seconds"],
            },
            "access": "",
            "ui": {
                "group": "time",
                "form": "row",
                "summary": "sleep {seconds}s",
                "collapse": "never",
                "chrome": "quiet",
            },
        },
        None,
        client_native=True,
    ),
    Declaration(
        "start_tick",
        {
            "parameters": {
                "properties": {
                    "seconds": {
                        "type": "number",
                        "description": "seconds between ticks (at least 1)",
                    },
                },
                "required": ["seconds"],
            },
            "access": "",
            "ui": {
                "group": "time",
                "form": "row",
                "summary": "start tick every {seconds}s",
                "collapse": "never",
                "chrome": "quiet",
            },
        },
        None,
        client_native=True,
    ),
    Declaration(
        "end_tick",
        {
            "parameters": {
                "properties": {},
                "required": [],
            },
            "access": "",
            "ui": {
                "group": "time",
                "form": "row",
                "summary": "end tick",
                "collapse": "never",
                "chrome": "quiet",
            },
        },
        None,
        client_native=True,
    ),
)


def client_native_names() -> tuple[str, ...]:
    """The tool names whose implementation is the client's own dispatcher, not
    the execution layer's. These are offered to the model alongside the host's
    own four; the names are reserved exactly as HOST_TOOL_NAMES are (no
    component may publish them)."""
    return tuple(d.name for d in _CLIENT_NATIVE_DECLARATIONS)


def names() -> tuple[str, ...]:
    """The tool names the host declares for itself — the vocabulary of the
    bootstrap exception (catalog.HOST_TOOL_NAMES), and the names no component may
    publish. Client-native tools are part of the same reserved surface: a
    component publishing `sleep` would be two implementations of one promise."""
    return tuple(d.name for d in _DECLARATIONS + _CLIENT_NATIVE_DECLARATIONS)


def declarations(config: Config) -> tuple[Declaration, ...]:
    """The host's own declarations, complete: each one's model-facing text is the
    host's own prose file for it, picked by mode.

    The prose is a file beside the host's other prompt text rather than a Python
    string, like every other word the host says to the model; which file is the
    host's own convention (`tools/<name>.md`, `tools/<name>_chat.md`), and a
    component carries its own instead (`Component.prompt`).
    """
    chat = config.mode == "chat"
    declared = _DECLARATIONS + _CLIENT_NATIVE_DECLARATIONS
    return tuple(
        d._replace(declaration={"name": d.name, "description": render(_prose(d.name, chat)), **d.declaration})
        for d in declared
    )


def _prose(name: str, chat: bool) -> str:
    """Which of the host's prompt files carries one tool's model-facing text.

    The four bootstrap tools (`run_command`, `trigger`, and the two log readers)
    have a work and a chat wording, because the same call means something else in
    each mode (a command's read-only classifier, the log readers' scope).

    Client-native tools (sleep, start_tick, end_tick) have one wording: they are
    not conditional on mode and have one `.md` file each.
    """
    if name in client_native_names():
        return f"tools/{name}.md"
    return f"tools/{name}_chat.md" if chat else f"tools/{name}.md"
