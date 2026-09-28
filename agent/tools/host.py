"""The host's own tool: one declaration, and why there is exactly one.

With nothing installed the host's whole surface is `run_command` — the loop's
escape hatch, the way anything gets looked at on a machine before a component is
there. It cannot be a component: the component that declared it could only be
installed by first running a command, so the host would have nothing to install
it with. It is therefore the ONE declared bootstrap exception (COMPONENTS.md),
and "declared" is what this module is for: what the model sees of it — its name,
its prose, its schema, the policy it runs under, how its call looks — is data in
the very vocabulary a manifest's tool entry speaks (catalog.Tool), parsed by the
same parser and checked by the same diagnostics (registry._bootstrap), so there
is one declaration shape in this host and one place to look for this tool.

What a component's declaration does not have, and this one must, is the
implementation: a component's statement IS its implementation, while the host's
tool is host code — the command text is the statement, and what decides whether
it may run stays here too (registry.Tool.access -> permission: the read-only
classifier, the escape and protected-path guard, the timeout, truncation and
Stop, all of them shell.run_command's). A component would only re-say "run this"
while every decision stayed in the host.

These declarations are also the names no component may take: a component that
publishes one of them is refused where every other unreadable word is refused
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
from . import shell
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

    `declaration` is manifest-shaped data (a `tools` entry of COMPONENTS.md §四),
    without the name and the prose, which `declarations()` fills in from the two
    fields beside it; `implementation` is the host code that satisfies it — the
    one field a component's declaration never has, because a component's
    statement is its implementation.
    """

    name: str
    declaration: Mapping[str, Any]
    implementation: HostImpl


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
)


def names() -> tuple[str, ...]:
    """The tool names the host declares for itself — the vocabulary of the
    bootstrap exception (catalog.HOST_TOOL_NAMES), and the names no component may
    publish."""
    return tuple(d.name for d in _DECLARATIONS)


def declarations(config: Config) -> tuple[Declaration, ...]:
    """The host's own declarations, complete: each one's model-facing text is the
    host's own prose file for it, picked by mode.

    The prose is a file beside the host's other prompt text rather than a Python
    string, like every other word the host says to the model; which file is the
    host's own convention (`tools/<name>.md`, `tools/<name>_chat.md`), and a
    component carries its own instead (`Component.prompt`).
    """
    chat = config.mode == "chat"
    return tuple(
        d._replace(declaration={"name": d.name, "description": render(_prose(d.name, chat)), **d.declaration})
        for d in _DECLARATIONS
    )


def _prose(name: str, chat: bool) -> str:
    """Which of the host's prompt files carries one tool's model-facing text."""
    return f"tools/{name}_chat.md" if chat else f"tools/{name}.md"
