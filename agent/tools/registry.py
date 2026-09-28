"""Declarative tool registry: the components' declarations, wired for the model.

One source of truth: each component's own manifest (a component.json that
travels with it — see COMPONENTS.md), discovered by tools/catalog.py. From it
this module builds the OpenAI function-calling schema the model sees AND the
statement that satisfies a call — there is no second, host-side implementation
of any tool. A tool no manifest describes does not exist for the model, and a
component this host does not have contributes no tools at all: with nothing
installed the host's surface is the one tool it declares for itself (tools/host.py
— run_command, the bootstrap exception), and every tool call it cannot serve is
answered with the component's own name and reason.

What the host owns, and only the host owns:

  * the statement layer and its transport (tools/inst.py, tools/transport.py):
    arguments -> one terminal command, output -> the Envelope the loop consumes
    (tools/envelope.py);
  * the policy a component deliberately does not carry (`guard`: a path the
    workspace protects is not readable even when it is named explicitly);
  * the per-file undo the UI offers on a change result (`snapshot`);
  * the gates and modes under which a tool is offered at all;
  * the ONE declaration that is not a component's (tools/host.py), because the
    tool it declares is what this host has when no component is installed.

Everything else — what a tool is called, what it means, how its events look in
the UI — is the declaration's, and the declaration belongs to the component.
"""

from __future__ import annotations

import copy
import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..config import Config
from ..memory import MemoryStore
from ..prompts import render
from ..skills import cached_library
from . import catalog, filesystem, host, inst, rendezvous
from .envelope import Envelope
from .inst import InstError
from .transport import TransportError, failure_envelope
from .workspace import LocalWorkspace, Workspace

# (workspace, config, **args) -> the result the model reads
ToolImpl = Callable[..., Envelope]
# a refusal, or None to proceed — (workspace, config, args, arg), where `arg` is
# the argument this policy judges, from the tool's own declaration
# (catalog.Tool.access_arg) — never assumed to be "path".
GuardImpl = Callable[[Workspace, Config, dict[str, Any], str], Envelope | None]


@dataclass(frozen=True)
class Access:
    """One host policy word: how it is enforced, and the argument it judges when
    a declaration does not rename it.

    `guard` is the host's own refusal (None when the word needs no host-side
    check — permission rules alone judge `command`); `arg` is the default name
    the policy reads. The WORDS live in catalog.ACCESS_ARGS (the declaration
    vocabulary); this table binds each one to the implementation, and the keys
    are checked against that vocabulary at import time (see _check_vocabulary).
    """

    guard: GuardImpl | None
    arg: str


# The host POLICY a declaration may put a tool under, by the name it is declared
# with (catalog.Tool.access). Keeping the names in the declaration's vocabulary
# and the implementations here is the split: a component says "this names a path
# the workspace may protect", the host decides what protection means.
ACCESS: dict[str, Access] = {
    "read": Access(filesystem.guard_read, catalog.ACCESS_ARGS["read"]),
    "sweep": Access(filesystem.guard_grep, catalog.ACCESS_ARGS["sweep"]),
    "write": Access(filesystem.guard_write, catalog.ACCESS_ARGS["write"]),
    "command": Access(None, catalog.ACCESS_ARGS["command"]),
}


# The policies under which a call is "working ON a file" rather than sweeping for
# one: the context reader after a compaction re-reads the files a call NAMED, and
# READ/WRITE are the words that name exactly one. `sweep` (a search) deliberately
# stays out — it has no single file to re-read.
WATCHED_ACCESS: frozenset[str] = frozenset({"read", "write"})


def _check_vocabulary() -> None:
    """Neither half of the host's vocabulary can drift from the declarations
    behind it silently: every access word the declaration protocol lists must have
    an implementation here, and the host's own tool names must be exactly the ones
    tools/host.py declares. A mismatch is a host bug, not a component's, so it is
    loud."""
    assert set(ACCESS) == set(catalog.ACCESS_ARGS), (
        f"access vocabulary drift: catalog {sorted(catalog.ACCESS_ARGS)} vs registry {sorted(ACCESS)}"
    )
    assert set(host.names()) == set(catalog.HOST_TOOL_NAMES), (
        f"host tool drift: catalog {sorted(catalog.HOST_TOOL_NAMES)} vs host {sorted(host.names())}"
    )


_check_vocabulary()

# The words the host refuses a declaration over, said ONCE per process (a
# component's typo is a fact about its manifest, not something to repeat on every
# turn). The declaration itself stays in the table; only its tools are withheld.
_REPORTED: set[tuple[str, str, str]] = set()


def _report(diags: list[catalog.Diagnostic]) -> None:
    """Say, once each, why the host is not offering some declared tools."""
    from ..procmgr.stdio import log

    for d in diags:
        key = (d.component, d.tool, d.message)
        if key in _REPORTED:
            continue
        _REPORTED.add(key)
        where = f"{d.component}/{d.tool}" if d.tool else d.component
        log(f"[components] refusing {where}: {d.message}")


@dataclass
class Tool:
    """One tool, wired: the statement that satisfies a call, plus the host's take.

    `inst` is the component's own part of the terminal command (tools/inst.py):
    placeholders filled from the model's arguments, prefixed with the launch
    rendezvous renders from the artifact's shape, run through the workspace's
    transport, its output unwrapped back into an Envelope. A daemon
    component's `inst` is the whole line — the loopback call IS its interface.

    `host` is the one other kind of tool: one the HOST owns and no component
    implements (tools/host.py — run_command: the command IS the statement, and
    the host's permission engine is the boundary it runs inside). It is not a
    fallback for anything: a tool with neither `inst` nor `host` cannot exist,
    because a declaration without a command never becomes a Tool unless the host
    declares it itself and brings the implementation (see build_tools).

    `access` is the policy the tool's DECLARATION put it under (catalog.Tool.access)
    — the one thing permission.evaluate and permission.escaped_paths read to decide
    what a call may touch. `access_arg` is the argument that policy judges, and
    `snapshot_arg` the argument the undo record reads — both resolved from the
    declaration (catalog.Tool.access_arg / snapshot_arg) with the vocabulary's
    default filled in, so nothing downstream has to assume "path".

    `guard` is host policy a component deliberately does not carry: the
    workspace module's fence refuses mutations and hides broad sweeps but still
    serves a path named explicitly, while the project's .clc must stay
    unreadable even then (see filesystem._refuse_protected). `defaults` rides
    the statement payload UNDER the model's own arguments: an argument the model
    left out gets the host's default instead of a hole in the request.

    `snapshot` marks the statements that OVERWRITE the file named in their
    `snapshot_arg` argument. The component that performs such a write keeps its
    own undo stack (the daemon's /undo pops its newest write, for its CLI), but
    the per-file "undo" the UI offers on a change result is served by THIS
    process — so the content the write is about to replace is recorded here too,
    and only for a write that actually happened.

    `ui` is the component's presentation declaration (catalog.DEFAULTS), already
    defaulted: the UI renders a tool it did not design from this block alone.

    `cancelable` is the one thing Stop needs to know about a call: a HOST tool
    that accepts a `cancel` event says so here, at the wiring, instead of the
    registry asking its signature (which read a plain `**kwargs` host tool as
    uncancelable). A component's statement is always cancelable — its transport
    carries the event — so the flag is about the host's own tool only.
    """

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema (properties + required)
    inst: str | None = None  # the component's own part of the statement
    module: str | None = None  # which component serves the statement
    host: ToolImpl | None = None  # the host's own tool (no component behind it)
    cancelable: bool = False  # Stop reaches this call (a host tool that declares it)
    access: str = ""  # the policy its declaration put it under ("" = unguarded)
    access_arg: str = ""  # the argument that policy judges
    guard: GuardImpl | None = None  # host policy the component does not make
    defaults: Mapping[str, Any] | None = None  # statement payload defaults
    snapshot: bool = False  # the statement overwrites snapshot_arg
    snapshot_arg: str = ""  # the argument the undo record reads
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


def _wire(spec: catalog.Tool, config: Config, *, owner: str, implementation: host.HostImpl | None = None) -> Tool:
    """One declaration -> the tool the model sees and the host runs.

    The description and the schema alike are run through `_resolve`, so a
    manifest's `$config.<field>` / `$skills` / `$backends` tokens become the
    host facts they name — the component says WHAT it wants to know about this
    host, the host answers with its own values.

    The policy words are resolved here too, and a declaration that names one the
    host does not know is refused by the CALLER (build_tools, which asks
    catalog.tool_diagnostics first) — never wired half-read.

    `owner` names who declared it — a component, or the host itself for the
    bootstrap exception (tools/host.py) — and `implementation` is what a
    declaration has only when the host made it: a component's statement IS its
    implementation, so it brings none and is carried out by its statement."""
    access = ACCESS.get(spec.access)
    access_arg = spec.access_arg or (access.arg if access else "")
    return Tool(
        name=spec.name,
        description=_resolve(spec.description, config),
        parameters=copy.deepcopy(_resolve(dict(spec.parameters), config)),
        inst=spec.command if implementation is None else None,
        module=owner if implementation is None else None,
        host=implementation,
        cancelable=implementation is not None,
        access=spec.access,
        access_arg=access_arg,
        guard=access.guard if access else None,
        defaults=_resolve(dict(spec.defaults), config),
        snapshot=spec.snapshot,
        snapshot_arg=spec.snapshot_arg or access_arg or "path",
        ui=catalog.ui_of(spec),
    )


def _bootstrap(config: Config) -> list[Tool]:
    """The host's OWN declarations (tools/host.py), wired like any other.

    The one exception to "the declaration belongs to a component", and it is a
    DECLARATION all the same (COMPONENTS.md §十一): the same shape, the same
    parser (catalog.tool_of), the same diagnostics a manifest goes through. What
    it adds is the implementation — host code, where a component's statement is
    its implementation — and it is why this tool can never be absent: with
    nothing installed it is the host's whole surface.

    A word the host itself cannot honor is a host bug, so it is LOUD here (an
    assert) rather than dropped the way a component's unreadable declaration is
    (that is what _drivable's refusals are for): there is nothing for the model
    to fall back on if the host's own declaration is wrong."""
    out: list[Tool] = []
    for declared in host.declarations(config):
        spec = catalog.tool_of(declared.declaration)
        assert spec is not None, f"the host's own declaration is not a tool: {declared.declaration!r}"
        fatal = [d.message for d in catalog.tool_diagnostics(host.NAME, spec) if d.fatal]
        assert not fatal, f"the host's own {declared.name} declaration is invalid: {'; '.join(fatal)}"
        out.append(_wire(spec, config, owner=host.NAME, implementation=declared.implementation))
    return out


def build_tools(config: Config, memories: MemoryStore | None = None) -> list[Tool]:
    """Every tool this host can offer right now, in one pass over the catalog.

    A component that is not installed contributes nothing here: no schema, no
    "not installed" stub, no host-side stand-in. The client shows the user
    `unavailable_reason()` instead (components_unavailable), because a tool the
    model cannot call is not a thing the model should see.

    The host's own tool comes first and is the one tool that is always there
    (`_bootstrap`); every other tool is a component's, and a component that tried
    to publish one of the host's own names is refused by the catalog before it
    gets here.

    A declaration word the host does not know refuses what it governs rather than
    running half-read (catalog.Diagnostics): an unknown facility takes the whole
    component's tools out, an unknown `access`/`gate`/`mode`/argument name takes
    just its tool — the model never sees the schema of a call the host would
    judge wrongly. Each refusal is said once (registry._report). Which components
    can be driven at all is one filter for the whole model-facing surface
    (`_drivable`), shared with the prompt fragments they carry."""
    tools: list[Tool] = _bootstrap(config)
    for component in _drivable():
        for spec in component.tools:
            if config.mode not in spec.modes:
                continue
            if not _gate_ok(spec.gate, config, memories):
                continue
            tools.append(_wire(spec, config, owner=component.name))
    return tools


def _drivable() -> list[catalog.Component]:
    """The components this host can drive right now, each refusal said once.

    One filter for everything a component says to the model — the tools it
    declares and the prompt fragment it carries alike: a declaration naming a word
    the host cannot honor contributes nothing (catalog.component_diagnostics), and
    neither does a component this host cannot launch at all
    (rendezvous.available). Read in one place so the schema and the prose can
    never disagree about what is here.
    """
    out: list[catalog.Component] = []
    for component in catalog.table().values():
        fatal = [d for d in catalog.component_diagnostics(component) if d.fatal]
        if fatal:
            _report(fatal)
            continue
        if not rendezvous.available(component.name):
            continue
        out.append(component)
    return out


def prompt_section(config: Config) -> str:
    """What the components themselves tell the model, joined ("" when none does).

    A component may name a `prompt` file inside its own directory
    (catalog.Component.prompt); this reads it and returns the fragments in table
    order. It is why the host's own prose names no tool it does not own: what the
    model is told about a component's tools travels with the component, so one
    that is absent, renamed or replaced by a third party cannot leave the prompt
    describing tools that are not here.

    A fragment is resolved exactly like a tool description, so a component may
    spend `$config.<field>` / `$skills` / `$backends` in it too. One that cannot
    be read is not fatal — the component's tools still work — but it is not silent
    either: nothing is appended and the word is said once, like every other the
    host cannot honor.
    """
    return "\n\n".join(text for text in (_fragment(c, config) for c in _drivable() if c.prompt) if text)


def _fragment(component: catalog.Component, config: Config) -> str | None:
    """One component's prompt fragment, or None when there is nothing to append."""
    resolved = rendezvous.resolve(component.name)
    if resolved is None:  # _drivable() already said why; nothing to read here
        return None
    path = Path(component.prompt)
    if not path.is_absolute():  # relative to the component's own directory
        path = resolved.directory / path
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError as e:
        _report(
            [
                catalog.Diagnostic(
                    component.name, "", f"prompt fragment {component.prompt!r} cannot be read ({e})", fatal=False
                )
            ]
        )
        return None
    return str(_resolve(text, config)) or None


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


def _previous_content(workspace: Workspace, args: dict[str, Any], arg: str) -> tuple[Any, str] | None:
    """(resolved path, content) of the file a component's write is about to
    replace — the host's own undo bookkeeping for the statement path.

    `arg` is the argument that named that path, from the tool's own declaration
    (registry.Tool.snapshot_arg) — the host never assumes it is called "path".
    The component performs the write, and its daemon keeps its own undo stack
    (the /undo its CLI pops: the newest write, whoever made it). The per-file
    revert the UI offers on a change result is answered by THIS process, so the
    content the write is about to replace has to be recorded here too. None
    means there is nothing to remember: a file that does not exist yet has no
    previous content, and a creation is not a change the UI can revert."""
    try:
        p = workspace.resolve(str(args.get(arg, "")))
        old = workspace.read(str(p))
    except (OSError, ValueError):
        return None
    return (p, old) if old else None


class ToolRegistry:
    def __init__(self, tools: list[Tool]) -> None:
        self._tools = {t.name: t for t in tools}
        # Stop reaches a call the wiring says it reaches (Tool.cancelable).
        # run_command declares it; a component statement always has it, because
        # its transport carries the event. Asking a signature instead would read
        # a plain `**kwargs` host tool as uncancelable.
        self._cancelable = {name: t.cancelable for name, t in self._tools.items()}

    def schemas(self) -> list[dict[str, Any]]:
        return [t.to_openai_schema() for t in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools)

    def access(self, name: str) -> str:
        """The policy this tool's declaration put it under ("" = unguarded).

        What a call may touch is decided by this string and the argument it names
        (registry.access_arg, permission.GUARDED_ARG) — the evaluator never sees a
        tool name, so a component installed later is subject to the same policy
        vocabulary as the components this repo develops.
        """
        tool = self._tools.get(name)
        return tool.access if tool is not None else ""

    def access_arg(self, name: str) -> str:
        """The argument `access` judges for this tool ("" when it is unguarded).

        Named by the tool's own declaration (catalog.Tool.access_arg) with the
        vocabulary's default filled in, so the permission gate judges the
        argument this tool actually uses even when it is not called `path`."""
        tool = self._tools.get(name)
        return tool.access_arg if tool is not None else ""

    def path_arg(self, name: str) -> str:
        """The argument in which this call NAMED A FILE ("" when it named none).

        The two policies under which a call is "working on a file" rather than
        sweeping for one: read and write. The context reader after a compaction
        tells the model to re-read the files it was working on and it learns
        which argument holds one from here — never from a tool name, so a
        component's read tool is remembered exactly like the ones this repo
        develops."""
        tool = self._tools.get(name)
        if tool is None or tool.access not in WATCHED_ACCESS:
            return ""
        return tool.access_arg

    def ui(self, name: str) -> dict[str, Any]:
        """One tool's presentation block, for the call events the UI renders from.

        The component's declaration with its defaults filled in (catalog.ui_of),
        plus the two facts only THIS process can answer and a declaration
        therefore does not have to: whether the host holds an undo record for the
        call (`undo`), and whether the call may change what the file tree the UI
        shows (`mutates` — a component's write, or the host's own command; a
        declaration that knows better can say so itself).

        A name no tool declares gets the defaults and nothing more: a call event
        for a tool this registry does not hold (a stale session, a verb typed by
        hand) is rendered from what the renderer already assumes, never from a
        `mutates` this process invented for a tool it cannot see.
        """
        tool = self._tools.get(name)
        if tool is None:
            return {**catalog.DEFAULTS, "undo": False}
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
    ) -> Envelope:
        tool = self._tools.get(name)
        if tool is None:
            return Envelope(
                render("unknown_tool.md", tool=name, available=", ".join(self.names())), error=True
            )
        try:
            args = self._coerce_types(tool, args)
            return self._invoke(workspace, config, tool, args, cancel)
        except TypeError as e:
            return Envelope(render("errors/invalid_arguments.md", error=e), error=True)
        except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
            return Envelope(render("errors/tool_exception.md", error=e), error=True)

    def _invoke(
        self,
        workspace: Workspace,
        config: Config,
        tool: Tool,
        args: dict[str, Any],
        cancel: threading.Event | None,
    ) -> Envelope:
        """One call: the host's policy, then the one implementation of it.

        There is no precedence to speak of any more — a tool's implementation is
        exactly one of two things (the component's statement, or the host's own
        command) and the wiring says which. A statement whose component is not
        runnable for this call is answered with the reason, never with a stand-in.
        """
        if tool.guard is not None:
            refused = tool.guard(workspace, config, args, tool.access_arg)
            if refused is not None:
                return refused
        if tool.inst is None:
            if tool.host is None:  # unreachable: build_tools never wires one
                return Envelope(f"ERROR: tool {tool.name} has no implementation", error=True)
            if self._cancelable.get(tool.name):
                return tool.host(workspace, config, cancel=cancel, **args)
            return tool.host(workspace, config, **args)
        blocked = module_blocked_reason(workspace, tool.module)
        if blocked:
            return Envelope(f"ERROR: {blocked}", error=True)
        # the component performs the write; the host keeps the undo record, but
        # only once the statement has actually overwritten something — a refused
        # or failed edit must not leave a snapshot the UI could "restore"
        remembered = _previous_content(workspace, args, tool.snapshot_arg) if tool.snapshot else None
        result = self._exec_statement(workspace, config, tool, args, cancel)
        if remembered is not None and not result.error:
            workspace.snapshot(remembered[0], remembered[1])
        return result

    def _exec_statement(
        self,
        workspace: Workspace,
        config: Config,
        tool: Tool,
        args: dict[str, Any],
        cancel: threading.Event | None,
    ) -> Envelope:
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
            return Envelope(f"ERROR: {e}", error=True)
        except InstError as e:
            return Envelope(render("errors/invalid_arguments.md", error=e), error=True)
        if statement.prefix:
            command = f"{statement.prefix} {command}".rstrip()
        try:
            result = statement.runner.run(command, config.command_timeout, cancel=cancel)
        except TransportError as e:
            return failure_envelope(e, timeout_seconds=config.command_timeout)
        return inst.unwrap(result, service=f"the {tool.module} service")

    @staticmethod
    def _coerce_types(tool: Tool, args: dict[str, Any]) -> dict[str, Any]:
        """Coerce args to the declared JSON Schema scalar types (models sometimes
        pass strings).

        Every shape is judged the same way: a value already of the declared shape
        passes, a spelling of it is converted, and anything else is an INVALID
        argument — raised here, where the caller already has the
        invalid-arguments envelope (the TypeError handler in execute), and said
        with the argument and what it got. Leaving a bad value in place sent it
        into the tool, where it either blew up as an opaque failure or was
        ignored. `boolean` is the strictest: "yes" is not a guess this host makes
        — only true/false in either case, or the 0/1 JSON Schema also spells true
        and false. A `type` the host has no rule for (a string, a list) passes
        through untouched."""
        props = tool.parameters.get("properties", {})
        for key, spec in props.items():
            if key not in args:
                continue
            kind, value = spec.get("type"), args[key]
            if kind == "integer":
                if isinstance(value, int) and not isinstance(value, bool):
                    continue
                try:
                    args[key] = int(value)
                except (TypeError, ValueError):
                    raise TypeError(f"argument {key!r} must be an integer, got {value!r}") from None
            elif kind == "number":
                if isinstance(value, bool):
                    raise TypeError(f"argument {key!r} must be a number, got {value!r}")
                if isinstance(value, (int, float)):
                    continue
                try:
                    args[key] = float(value)
                except (TypeError, ValueError):
                    raise TypeError(f"argument {key!r} must be a number, got {value!r}") from None
            elif kind == "boolean" and not isinstance(value, bool):
                word = value.strip().lower() if isinstance(value, str) else ""
                if word in ("true", "false"):
                    args[key] = word == "true"
                elif isinstance(value, int) and value in (0, 1):
                    args[key] = bool(value)
                else:
                    raise TypeError(f"argument {key!r} must be true or false, got {value!r}")
        return args
