"""Declarative tool registry: the components' declarations, wired for the model.

One source of truth: each component's own manifest (a component.json that
travels with it — see COMPONENTS.md), discovered by tools/catalog.py. From it
this module builds the OpenAI function-calling schema the model sees AND the
statement that satisfies a call — there is no second, host-side implementation
of any tool. A tool no manifest describes does not exist for the model, and a
component this host does not have contributes no tools at all: with nothing
installed the host's surface is run_command and nothing else, and every tool
call it cannot serve is answered with the component's own name and reason.

What the host owns, and only the host owns:

  * the statement layer and its transport (tools/inst.py, tools/transport.py):
    arguments -> one terminal command, output -> the {content, error, diff}
    envelope the loop consumes;
  * the policy a component deliberately does not carry (`guard`: a path the
    workspace protects is not readable even when it is named explicitly);
  * the per-file undo the UI offers on a change result (`snapshot`);
  * the gates and modes under which a tool is offered at all.

Everything else — what a tool is called, what it means, how its events look in
the UI — is the declaration's, and the declaration belongs to the component.
"""

from __future__ import annotations

import copy
import inspect
import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import Config
from ..memory import MemoryStore
from ..prompts import render
from ..skills import cached_library
from . import catalog, filesystem, inst, rendezvous, shell
from .inst import InstError
from .transport import TransportError, failure_envelope
from .workspace import LocalWorkspace, Workspace

# (workspace, config, **args) -> dict{content, error?}
ToolImpl = Callable[..., dict[str, Any]]
# (workspace, config, args) -> dict{content, error?} | None -- a refusal, or None to proceed
GuardImpl = Callable[[Workspace, Config, dict[str, Any]], dict[str, Any] | None]

# The host POLICY a declaration may put a tool under, by the name it is declared
# with (catalog.Tool.access). Keeping the names in the declaration and the
# implementations here is the split: a component says "this names a path the
# workspace may protect", the host decides what protection means.
GUARDS: dict[str, GuardImpl] = {
    "read": filesystem.guard_read,
    "sweep": filesystem.guard_grep,
    "write": filesystem.guard_write,
}


@dataclass
class Tool:
    """One tool, wired: the statement that satisfies a call, plus the host's take.

    `inst` is the component's own part of the terminal command (tools/inst.py):
    placeholders filled from the model's arguments, prefixed with the launch
    rendezvous renders from the artifact's shape, run through the workspace's
    transport, its output unwrapped back into {content, error, diff}. A daemon
    component's `inst` is the whole line — the loopback call IS its interface.

    `host` is the one other kind of tool: one the HOST owns and no component
    implements (run_command — the command IS the statement, and the host's
    permission engine is the boundary it runs inside). It is not a fallback for
    anything: a tool with neither `inst` nor `host` cannot exist, because a
    declaration without a command never becomes a Tool (see build_tools).

    `access` is the policy the tool's DECLARATION put it under (catalog.Tool.access)
    — the one thing permission.evaluate and permission.escaped_paths read to decide
    what a call may touch.

    `guard` is host policy a component deliberately does not carry: the
    workspace module's fence refuses mutations and hides broad sweeps but still
    serves a path named explicitly, while the project's .clc must stay
    unreadable even then (see filesystem._refuse_protected). `defaults` rides
    the statement payload UNDER the model's own arguments: an argument the model
    left out gets the host's default instead of a hole in the request.

    `snapshot` marks the statements that OVERWRITE the file named in their
    `path` argument. The component that performs such a write keeps its own undo
    stack (the daemon's /undo pops its newest write, for its CLI), but the
    per-file "undo" the UI offers on a change result is served by THIS process —
    so the content the write is about to replace is recorded here too, and only
    for a write that actually happened.

    `ui` is the component's presentation declaration (catalog.DEFAULTS), already
    defaulted: the UI renders a tool it did not design from this block alone.
    """

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema (properties + required)
    inst: str | None = None  # the component's own part of the statement
    module: str | None = None  # which component serves the statement
    host: ToolImpl | None = None  # the host's own tool (no component behind it)
    access: str = ""  # the policy its declaration put it under ("" = unguarded)
    guard: GuardImpl | None = None  # host policy the component does not make
    defaults: Mapping[str, Any] | None = None  # statement payload defaults
    snapshot: bool = False  # the statement overwrites args["path"]
    ui: Mapping[str, Any] = field(default_factory=dict)

    def to_openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": self.parameters.get("properties", {}),
                    "required": self.parameters.get("required", []),
                },
            },
        }


# -- declaration -> the schema the model sees ---------------------------------


_PLACEHOLDER = re.compile(r"\$(config\.[a-z_]+|skills|backends)\b")


def _resolve(value: Any, config: Config) -> Any:
    """A declaration's schema value with the host's own facts filled in.

    Two placeholders, both of them things only this host knows when it builds
    the schema: `$config.<field>` (a knob the user set) and the two computed
    lists `$skills` (the skill names on this machine) and `$backends` (the
    search backends it is configured for). A value that IS `$skills` stays a
    list — an enum — while the same token inside a sentence reads as the list;
    likewise a value that IS `$config.<field>` keeps the knob's own type (a
    default of `$config.read_max_chars` is the integer the statement sends), and
    the same placeholder inside a sentence is spelled out.
    """
    if isinstance(value, str):
        if value == "$skills":
            return list(_skills(config))
        if value.startswith("$config."):  # a whole value: the host's own type
            return getattr(config, value.split(".", 1)[1], "")
        return _PLACEHOLDER.sub(lambda m: _fact(m.group(1), config), value)
    if isinstance(value, list):
        return [_resolve(v, config) for v in value]
    if isinstance(value, dict):
        return {k: _resolve(v, config) for k, v in value.items()}
    return value


def _fact(token: str, config: Config) -> str:
    if token == "skills":
        return ", ".join(_skills(config)) or "none"
    if token == "backends":
        return " or ".join(catalog.available_backends(config)) or "none"
    return str(getattr(config, token.split(".", 1)[1], ""))


def _skills(config: Config) -> tuple[str, ...]:
    """The skill names THIS machine has (the host's fact, not the component's
    work): the model picks a name from the enum before anything runs, so the
    host must be able to answer it without asking the skill component."""
    return cached_library(config.skills_dir).names()


def _gate_ok(gate: str, config: Config, memories: MemoryStore | None) -> bool:
    """Whether a tool's declared host-side condition holds at all (see
    catalog.Tool.gate). A tool whose gate is shut is not offered — it is not
    offered-with-an-error, because the model would only learn to stop trying."""
    if gate in ("", "always"):
        return True
    if gate == "project":
        return memories is not None
    if gate == "skills":
        # skills off entirely, or nothing to load: an enum over an empty library
        # is a schema that offers the model nothing to pick
        return config.enable_skills and bool(_skills(config))
    return False


def _wire(component: catalog.Component, spec: catalog.Tool, config: Config) -> Tool:
    """One declaration -> the tool the model sees and the host runs.

    The description and the schema alike are run through `_resolve`, so a
    manifest's `$config.<field>` / `$skills` / `$backends` tokens become the
    host facts they name — the component says WHAT it wants to know about this
    host, the host answers with its own values."""
    return Tool(
        name=spec.name,
        description=_resolve(spec.description, config),
        parameters=copy.deepcopy(_resolve(dict(spec.parameters), config)),
        inst=spec.command,
        module=component.name,
        access=spec.access,
        guard=GUARDS.get(spec.access),
        defaults=_resolve(dict(spec.defaults), config),
        snapshot=spec.snapshot,
        ui=catalog.ui_of(spec),
    )


def build_tools(config: Config, memories: MemoryStore | None = None) -> list[Tool]:
    """Every tool this host can offer right now, in one pass over the catalog.

    A component that is not installed contributes nothing here: no schema, no
    "not installed" stub, no host-side stand-in. The client shows the user
    `unavailable_reason()` instead (components_unavailable), because a tool the
    model cannot call is not a thing the model should see.
    """
    tools: list[Tool] = [_run_command(config)]
    for component in catalog.table().values():
        if not rendezvous.available(component.name):
            continue
        for spec in component.tools:
            if config.mode not in spec.modes:
                continue
            if not _gate_ok(spec.gate, config, memories):
                continue
            tools.append(_wire(component, spec, config))
    return tools


def components_unavailable(config: Config) -> list[dict[str, str]]:
    """The components this host is MISSING, for the UI to explain — and only the
    ones whose declaration asks to be explained (catalog Component.ui.status).

    A component that says `status: True` declares that its absence is something
    the user should be told about, in the words its own declaration chooses
    (`ui.label`). One that says nothing about its state disappears quietly, which
    is the right default for an optional extra.
    """
    out: list[dict[str, str]] = []
    for component in catalog.table().values():
        if not component.ui.get("status"):
            continue
        reason = rendezvous.unavailable_reason(component.name)
        if reason:
            out.append(
                {
                    "name": component.name,
                    "label": str(component.ui.get("label", component.name)),
                    "reason": reason,
                }
            )
    return out


def _run_command(config: Config) -> Tool:
    """The host's own tool — the one statement that is not a component's.

    Deliberately not a component: the command IS the statement, and the host's
    permission engine (read-only classifier, escape and protected-path guard,
    Stop) is the boundary it runs inside. A component would only re-say "run
    this" while the decision stayed here.
    """
    chat_mode = config.mode == "chat"
    return Tool(
        name="run_command",
        description=render("tools/run_command_chat.md" if chat_mode else "tools/run_command.md"),
        parameters={
            "properties": {"command": {"type": "string", "description": "shell command string to run"}},
            "required": ["command"],
        },
        host=lambda workspace, cfg, cancel=None, **kw: shell.run_command(workspace, cfg, cancel=cancel, **kw),
        access="command",
        ui={"preview": "command"},
    )


def module_blocked_reason(workspace: Workspace, module: str | None) -> str:
    """Why this host cannot run `module`'s statements for THIS call ("" = it can).

    Two facts, both local. The component has to be here and drivable
    (`rendezvous.unavailable_reason` — nothing on the host's side can stand in
    for it), and a component whose SUBJECT is the workspace root's own
    filesystem additionally needs the root to live HERE, because it serves the
    filesystem of the machine it runs on. A component serving anything else runs
    on the app host whatever kind of workspace the call came from — its subject
    is the project file / the network / the skill library, never the workspace's
    machine.
    """
    if module is None:
        return "no component serves this tool"
    missing = rendezvous.unavailable_reason(module)
    if missing:
        return missing
    # TODO(ssh-workspace): this branch disappears with the component that serves
    # a foreign filesystem over a channel of its own — that component's subject
    # is FOREIGN_FS and it is driven from here, so the root's home stops mattering.
    if rendezvous.serves_workspace_fs(module) and not isinstance(workspace, LocalWorkspace):
        return (
            f"{module} serves the filesystem of the machine this workspace root lives on, "
            f"and this root is another machine's"
        )
    return ""


def _previous_content(workspace: Workspace, args: dict[str, Any]) -> tuple[Any, str] | None:
    """(resolved path, content) of the file a component's write is about to
    replace — the host's own undo bookkeeping for the statement path.

    The component performs the write, and its daemon keeps its own undo stack
    (the /undo its CLI pops: the newest write, whoever made it). The per-file
    revert the UI offers on a change result is answered by THIS process, so the
    content the write is about to replace has to be recorded here too. None
    means there is nothing to remember: a file that does not exist yet has no
    previous content, and a creation is not a change the UI can revert."""
    try:
        p = workspace.resolve(str(args.get("path", "")))
        old = workspace.read(str(p))
    except (OSError, ValueError):
        return None
    return (p, old) if old else None


class ToolRegistry:
    def __init__(self, tools: list[Tool]) -> None:
        self._tools = {t.name: t for t in tools}
        # a host tool opts into Stop by declaring a `cancel` parameter
        # (run_command does); component statements get Stop from their transport
        self._cancelable = {
            name: t.host is not None and "cancel" in inspect.signature(t.host).parameters
            for name, t in self._tools.items()
        }

    def schemas(self) -> list[dict[str, Any]]:
        return [t.to_openai_schema() for t in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools)

    def access(self, name: str) -> str:
        """The policy this tool's declaration put it under ("" = unguarded).

        What a call may touch is decided by this string and the guarded argument
        it names (permission.GUARDED_ARG) — the evaluator never sees a tool name,
        so a component installed later is subject to the same policy vocabulary
        as the components this repo develops.
        """
        tool = self._tools.get(name)
        return tool.access if tool is not None else ""

    def ui(self, name: str) -> dict[str, Any]:
        """One tool's presentation block, for the call events the UI renders from.

        The component's declaration with its defaults filled in (catalog.ui_of),
        plus the two facts only THIS process can answer and a declaration
        therefore does not have to: whether the host holds an undo record for the
        call (`undo`), and whether the call may change what the file tree the UI
        shows (`mutates` — a component's write, or the host's own command; a
        declaration that knows better can say so itself).
        """
        tool = self._tools.get(name)
        if tool is None:
            return {**catalog.DEFAULTS, "mutates": True, "undo": False}
        return {
            **tool.ui,
            "mutates": bool(tool.ui.get("mutates", tool.snapshot or tool.host is not None)),
            "undo": bool(tool.snapshot),
        }

    def tool(self, name: str) -> Tool | None:
        """One tool's definition (its statement, policy and presentation), for
        callers that need the wiring rather than a call — the statement tests,
        the session's schema export."""
        return self._tools.get(name)

    def execute(
        self,
        workspace: Workspace,
        config: Config,
        name: str,
        args: dict[str, Any],
        cancel: threading.Event | None = None,
    ) -> dict[str, Any]:
        tool = self._tools.get(name)
        if tool is None:
            return {
                "content": render("unknown_tool.md", tool=name, available=", ".join(self.names())),
                "error": True,
            }
        try:
            args = self._coerce_types(tool, args)
            result = self._invoke(workspace, config, tool, args, cancel)
        except TypeError as e:
            result = {"content": render("errors/invalid_arguments.md", error=e), "error": True}
        except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
            result = {"content": render("errors/tool_exception.md", error=e), "error": True}
        # normalize: every tool result carries error/diff so callers can index them
        result.setdefault("error", False)
        result.setdefault("diff", "")
        return result

    def _invoke(
        self,
        workspace: Workspace,
        config: Config,
        tool: Tool,
        args: dict[str, Any],
        cancel: threading.Event | None,
    ) -> dict[str, Any]:
        """One call: the host's policy, then the one implementation of it.

        There is no precedence to speak of any more — a tool's implementation is
        exactly one of two things (the component's statement, or the host's own
        command) and the wiring says which. A statement whose component is not
        runnable for this call is answered with the reason, never with a stand-in.
        """
        if tool.guard is not None:
            refused = tool.guard(workspace, config, args)
            if refused is not None:
                return refused
        if tool.inst is None:
            if tool.host is None:  # unreachable: build_tools never wires one
                return {"content": f"ERROR: tool {tool.name} has no implementation", "error": True}
            if self._cancelable.get(tool.name):
                return tool.host(workspace, config, cancel=cancel, **args)
            return tool.host(workspace, config, **args)
        blocked = module_blocked_reason(workspace, tool.module)
        if blocked:
            return {"content": f"ERROR: {blocked}", "error": True}
        # the component performs the write; the host keeps the undo record, but
        # only once the statement has actually overwritten something — a refused
        # or failed edit must not leave a snapshot the UI could "restore"
        remembered = _previous_content(workspace, args) if tool.snapshot else None
        result = self._exec_statement(workspace, config, tool, args, cancel)
        if remembered is not None and not result.get("error"):
            workspace.snapshot(remembered[0], remembered[1])
        return result

    def _exec_statement(
        self,
        workspace: Workspace,
        config: Config,
        tool: Tool,
        args: dict[str, Any],
        cancel: threading.Event | None,
    ) -> dict[str, Any]:
        """Run one tool statement: the launch, then the component's own flags.

        Which transport carries the line — and which host placeholders the
        template gets — is the component's kind: a daemon is spoken to on the
        workspace's machine through the service it publishes, a CLI on the app
        host through whatever the artifact's launch turns out to be (an
        interpreter and a checkout, or an installed executable)."""
        try:
            statement = rendezvous.prepare(tool.module, workspace, config)
            command = inst.render(tool.inst, args, vars=statement.vars, defaults=tool.defaults or {})
        except rendezvous.RendezvousError as e:
            return {"content": f"ERROR: {e}", "error": True}
        except InstError as e:
            return {"content": render("errors/invalid_arguments.md", error=e), "error": True}
        if statement.prefix:
            command = f"{statement.prefix} {command}".rstrip()
        try:
            result = statement.runner.run(command, config.command_timeout, cancel=cancel)
        except TransportError as e:
            return failure_envelope(e, timeout_seconds=config.command_timeout)
        return inst.unwrap(result, service=f"the {tool.module} service")

    @staticmethod
    def _coerce_types(tool: Tool, args: dict[str, Any]) -> dict[str, Any]:
        """Coerce args to the declared JSON Schema types (models sometimes pass strings)."""
        props = tool.parameters.get("properties", {})
        for key, spec in props.items():
            if key not in args:
                continue
            if spec.get("type") == "integer" and not isinstance(args[key], int):
                try:
                    args[key] = int(args[key])
                except (TypeError, ValueError):
                    pass
        return args
