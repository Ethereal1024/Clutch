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
    reader that open holds (a seek locally, one byte-range read on a remote host).
    A component would have to be handed those bytes over a second channel to say
    the same thing — a second copy of the file, and a second thing to keep in sync.

"Declared" is what this module is for: what the model sees of each one — its name,
its prose, its schema, the policy it runs under, how its call looks — is data in
the very vocabulary a manifest's tool entry speaks (catalog.Tool), parsed by the
same parser and checked by the same diagnostics (registry._bootstrap), so there is
one declaration shape in this host and one place to look for these tools.

The other four — `read_file`, `grep`, `write_file`, `edit_file` — are the same
kind of declaration for the one session where no component can carry them: a
workspace on ANOTHER machine (`RemoteWorkspace`, the ssh backend). There the far
side is an sshd shell and nothing else — no daemon to install, no python to
assume — so the calls that shape a session's work have no process to serve them;
the host declares them and tools/filesystem.py is their implementation over plain
POSIX sh (cat / ls / find | xargs grep / printf). They are the host's ONLY in that
session: on a local root `clutch-workspace` declares the same four names and its
daemon performs them, which is why these are not in HOST_TOOL_NAMES (no component
may take those names) but in catalog.REMOTE_TOOL_NAMES (a component's copies of
these are dropped only when the host is holding them — registry.build_tools).

`declarations(config, remote=...)` is therefore what the session's ROOT decides:
the four bootstrap tools always, plus the four workspace tools when the root is
a workspace this host can only reach through a shell.

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
inheritable. The four in `_REMOTE_DECLARATIONS` are the opposite case and say so:
they are a component's names too, and the list they agree with
(catalog.REMOTE_TOOL_NAMES) is exactly what `remote_names()` answers.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable, NamedTuple

from ..config import Config
from ..prompts import render
from . import filesystem, recall, shell
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


# The four workspace tools, for the session whose root is another machine's (see
# the module docstring). Every field is the one `clutch-workspace` publishes for
# the same name on a local root — the schema, the policy, the undo flag, the
# presentation — because a call has to read the same whichever machine served it;
# what only these have is `implementation`, and what only these need is `modes`
# on the two writers: chat mode must not offer a write, and on a remote root
# there is no component declaration left for the mode filter to have excluded.
_REMOTE_DECLARATIONS: tuple[Declaration, ...] = (
    Declaration(
        "read_file",
        {
            "parameters": {
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "file path OR directory path, relative to the workspace root",
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "max chars to read (default $config.read_max_chars)",
                    },
                    "offset": {"type": "integer", "description": "1-based start line for a line-range read"},
                    "limit": {"type": "integer", "description": "max lines to read when offset is given"},
                },
                "required": ["path"],
            },
            "defaults": {"max_chars": "$config.read_max_chars"},
            "access": "read",
            "ui": {
                "group": "read",
                "form": "row",
                "body": "code",
                "collapse": "always",
                "highlight": "path",
                "preview": "none",
                "summary": "read {path} ({lines} lines)",
            },
        },
        filesystem.read_file,
    ),
    Declaration(
        "grep",
        {
            "parameters": {
                "properties": {
                    "pattern": {"type": "string", "description": "regex to search for"},
                    "path": {
                        "type": "string",
                        "description": "subdirectory or file to search (default: whole workspace)",
                    },
                    "include": {"type": "string", "description": "filename glob filter (e.g. '*.py')"},
                },
                "required": ["pattern"],
            },
            "defaults": {"path": ".", "include": ""},
            "access": "sweep",
            "ui": {
                "group": "read",
                "form": "row",
                "body": "code",
                "collapse": "always",
                "highlight": "path",
                "preview": "none",
                "summary": "grep {pattern} ({lines} lines)",
            },
        },
        filesystem.grep,
    ),
    Declaration(
        "write_file",
        {
            "parameters": {
                "properties": {
                    "path": {"type": "string", "description": "file path, relative to the workspace root"},
                    "content": {"type": "string", "description": "full file content"},
                },
                "required": ["path", "content"],
            },
            "access": "write",
            "snapshot": True,
            "modes": ["work"],
            "ui": {
                "chrome": "accent",
                "header": "✓ wrote {path}",
                "body": "diff",
                "collapse": "long",
                "preview": {"mode": "content", "keys": ["✎path", "content"]},
            },
        },
        filesystem.write_file,
    ),
    Declaration(
        "edit_file",
        {
            "parameters": {
                "properties": {
                    "path": {"type": "string", "description": "file path, relative to the workspace root"},
                    "old_string": {
                        "type": "string",
                        "description": "exact text to replace (must appear exactly once)",
                    },
                    "new_string": {"type": "string", "description": "replacement text"},
                },
                "required": ["path", "old_string", "new_string"],
            },
            "access": "write",
            "snapshot": True,
            "modes": ["work"],
            "ui": {
                "chrome": "accent",
                "header": "✎ edited {path}",
                "body": "diff",
                "collapse": "long",
                "preview": {"mode": "content", "keys": ["✎path", "-old_string", "+new_string"]},
            },
        },
        filesystem.edit_file,
    ),
)


def remote_names() -> tuple[str, ...]:
    """The tool names the host declares for a workspace on another machine
    (catalog.REMOTE_TOOL_NAMES) — names a component also declares, and the reason
    build_tools drops a component's copy only when the host is holding them."""
    return tuple(d.name for d in _REMOTE_DECLARATIONS)


def declarations(config: Config, *, remote: bool = False) -> tuple[Declaration, ...]:
    """The host's own declarations, complete: each one's model-facing text is the
    host's own prose file for it, picked by mode.

    `remote` is the session's ROOT, not a preference: a workspace this host can
    only reach through a shell has no process to serve the four file tools, so the
    host declares them; a local root has `clutch-workspace`, whose daemon does, and
    two definitions of "read" would be exactly the second truth source this file
    exists to avoid.

    The prose is a file beside the host's other prompt text rather than a Python
    string, like every other word the host says to the model; which file is the
    host's own convention (`tools/<name>.md`, `tools/<name>_chat.md`), and a
    component carries its own instead (`Component.prompt`).
    """
    chat = config.mode == "chat"
    declared = _DECLARATIONS + _CLIENT_NATIVE_DECLARATIONS + (_REMOTE_DECLARATIONS if remote else ())
    return tuple(
        d._replace(declaration={"name": d.name, "description": render(_prose(d.name, chat)), **d.declaration})
        for d in declared
    )


def _prose(name: str, chat: bool) -> str:
    """Which of the host's prompt files carries one tool's model-facing text.

    The four bootstrap tools (`run_command`, `trigger`, and the two log readers)
    have a work and a chat wording, because the same call means something else in
    each mode (a command's read-only classifier, the log readers' scope). The four
    workspace tools do not: `read_file` says the same thing in chat and in work,
    and the writers are not offered in chat at all (`modes: ["work"]`), so there is
    one file for each and no `_chat` twin to keep in sync.

    Client-native tools (sleep, start_tick, end_tick) have one wording: they are
    not conditional on mode and have one `.md` file each.
    """
    if name in remote_names() or name in client_native_names():
        return f"tools/{name}.md"
    return f"tools/{name}_chat.md" if chat else f"tools/{name}.md"
