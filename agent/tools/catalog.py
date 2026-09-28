"""The component catalog: what this host knows how to drive, and how to show it.

A component is a standalone program that publishes an interface the host speaks
to (a per-workspace daemon over loopback HTTP, or one process per call). The
host imports NOTHING from it: it holds a DECLARATION of the component — what it
is spoken to as and where it runs (interface / runs_on), whose resources it
serves (subject), how one of its processes starts (launch), which host facts its
statements need (vars), which tools it publishes (each with the model-facing
schema, the one statement that satisfies a call, and how the UI presents it),
and how the user sees the component's own state (ui).

There is no host-side implementation behind any of it, and no fallback either:
a tool this catalog does not describe does not exist for the model, and a
component that is absent takes its tools with it and nothing else (see
registry.build_tools). A host with nothing installed can chat and nothing more.

Zero built-ins, three sources
-----------------------------
The host ships NO component declaration — not even for the components its own
repo develops. A component is declared by the component, in a `component.json`
manifest that travels WITH it (the same shape at every stop, like an editor
extension's package manifest), and this module only DISCOVERS and MERGES:

  * a dev CHECKOUT beside the host repo — any sibling directory carrying a
    component.json (the whole of the development path: edit the manifest, the
    host picks it up, nothing to install);
  * an INSTALLED artifact — the manifest tools/components.py laid down in this
    host's install root, which is the package's own manifest plus the install
    facts (version, digest);
  * a REGISTRATION in the user's catalog directory — the out-of-tree escape
    hatch, one JSON file per component, and the last word.

The declaration is data. Nothing here executes a tool; `registry` turns a
declaration into the Tool the model sees, `rendezvous` turns its coordinates
into a running process, and `ui/app.js` turns its `ui` block into pixels.
The full manifest spec is COMPONENTS.md at the repo root.

The UI protocol (declared per tool, consumed by ui/app.js)
----------------------------------------------------------
The host renders tool events it did not design, so the component says how its
events look — and ui/app.js contains no tool name at all. Every tool event
carries this block (events.ToolCallEvent.ui), so a replayed session renders the
same way and a component installed later is rendered without a UI change.

Keys, all optional; DEFAULTS applies to a key the declaration leaves out. Each
key composes ONE named part of the row or the result, and every default
reproduces the plain look: the tool's name as the row's chip, its arguments one
click away, its result its own whole block.

    group     calls naming the same group collect into ONE dense block: each
              call's row, with its result folded into that row, in one place —
              so a run of small results scans as a column of one-liners. None =
              the call is its own row and its result is its own block (a call
              that lands changes must not be swallowed by the read-only ones
              around it). The value is an opaque namespace: the renderer groups
              by equality and never interprets it.
    chip      "name" the row leads with the tool's own name, "none" it does not —
              a row whose summary already says what the call is reads better
              without the name repeated beside it.
    summary   the row's one-line label; {placeholders} are the call's argument
              names plus the computed facts {lines} (result lines; "…" until the
              result lands) and {name} (the tool's own name). "" = no label.
    preview   the LIVE row while the call streams, either a mode or
              {mode, keys}: "args" the raw argument JSON, "content" the
              arguments' own text, "command" the unwrapped command argument
              under its `mark` (the shell prompt it reads as, "$ " by default),
              "none" nothing to stream. Under "content", `keys` names the
              arguments to print, in order, and a leading "-"/"+"/"✎" on a key
              is a mark printed before its value — that is how a write declares
              "the file being written, with its content", and an edit declares
              "- old / + new".
    header    the label of a result that is its own block ({placeholders} as in
              summary); "" = the summary this call would wear in a group, else
              "result". The host keeps the one verdict it owns: a failed call
              reads "result ⚠" whatever the declaration asked for.
    form      what the result IS — the one shape the renderer routes on, and a
              composition of the parts below, never a tool's purpose:
              "block" (the default) a header line over its body; "row" a
              one-line collapsible row, `summary` as the label and the body
              folding under it — landing beside its call inside the group's
              block, or in a quiet block of its own when the call collected
              nowhere (a replayed log page).
    body      what the result renders as: "text" the content, "code" a code
              panel, "diff" the unified diff it returned, "none" nothing but
              the status line.
    highlight decoration painted onto a code body: "path" highlights it by the
              call's `path` argument.
    chrome    extra chrome on the block: "accent" turns the header into the
              accent chip.
    collapse  "always" the body starts folded, "long" folded past a size
              threshold, "never" shown whole.
    mutates   the call may change what the file tree shows. Optional: the host
              derives it from what it knows (a statement that overwrites a path,
              or the host's own command), and a component that changes the tree
              some other way declares it itself.

Two more keys ride every block and no declaration sets them, because only the
host can answer them: `undo` (this call has an undo record the UI can offer) and
the derived default of `mutates`.

A component's own state reaches the UI the same way: its `ui` block carries
`label` (what to call it in the interface) and `status` (True = the host tells
the user when this component is unavailable, so a missing tool is explained
instead of silently disappearing — see registry.components_unavailable).
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field, fields, replace
from pathlib import Path
from typing import Any

from . import components, modules

# How a component is spoken to.
DAEMON = "daemon"  # a per-workspace HTTP service discovered through a record
CLI = "cli"  # one command line per call

# Where a component's process runs, RELATIVE TO THE HOST BEING ASKED.
SELF = "self"
OTHER = "other"  # another host, through a channel of its own (none yet)

# Whose resources a component serves — which decides whether a statement may run
# for a given workspace at all (registry.module_blocked_reason).
WORKSPACE_FS = "workspace-fs"
FOREIGN_FS = "foreign-fs"
NETWORK = "network"
PROJECT_FILE = "project-file"
SKILL_LIB = "skill-library"

# What the UI does with a tool that declares no `ui` block: a plain block, its
# name as the row's chip, its arguments streamed, its result shown whole. Any
# tool works out of the box; a component only has to speak up when it looks
# different. `mutates` is a key the HOST derives when the declaration leaves it
# out (registry.ui), which is why it has no default here.
DEFAULTS: dict[str, Any] = {
    "group": None,
    "chip": "name",
    "summary": "",
    "preview": "args",
    "header": "",
    "form": "block",
    "body": "text",
    "collapse": "never",
    "highlight": "",
    "chrome": "",
}
UI_KEYS = tuple(DEFAULTS) + ("mutates",)


# ------------------------------------------------- the host's own vocabulary ----
# The words a declaration may use that the HOST defines, listed once so a word
# this host does not know can be refused instead of silently failing (see
# Diagnostics below). A component chooses the value — which policy, which gate,
# which facility — and never invents the word.

# access: the policy a tool is put under, with the argument that policy judges by
# default. A declaration may RENAME that argument (`Tool.access_arg`) — a path
# argument called `file` still enters the workspace's fence — but the word and
# its meaning stay the host's. "" = the host applies no policy. Read by
# permission.GUARDED_ARG and registry.ACCESS.
ACCESS_ARGS: dict[str, str] = {
    "read": "path",  # a path the workspace may protect
    "sweep": "path",  # a path a broad search walks
    "write": "path",  # a path the call may overwrite
    "command": "command",  # the shell text a command-shaped tool runs
}
# gate: a host-side condition that must hold for the tool to be offered at all
# (registry._gate_ok). "" / "always" = no condition.
GATES: tuple[str, ...] = ("", "always", "project", "skills")
# modes: the agent modes a tool is offered in (config.Config.mode).
MODES: tuple[str, ...] = ("work", "chat")
# requires: the host facilities a component may declare it stands on
# (rendezvous.unavailable_reason answers whether each holds on this host).
FACILITIES: tuple[str, ...] = ("python", "posix-shell", "curl")


@dataclass(frozen=True)
class Diagnostic:
    """A host-defined word a declaration used that this host does not know.

    The direction is deliberately fail-CLOSED (COMPONENTS_REVIEW P0-2): a word
    the host cannot read is never guessed at. `fatal` marks the ones that stop
    the host from running the declaration at all — an unknown `access` would
    leave a tool unguarded (the workspace's protection one typo away from gone),
    and an unknown `gate` / `mode` / facility leaves the host unable to answer
    the question the word asks. A cosmetic word (a `ui` key the renderer does
    not know) is reported WITHOUT refusing the tool: it works, it just looks
    plainer than its author meant.
    """

    component: str
    tool: str  # "" for a word about the component itself
    message: str
    fatal: bool = True


def _known(words) -> str:
    return ", ".join(repr(w) for w in words)


def tool_diagnostics(component: str, spec: Tool) -> list[Diagnostic]:
    """The host-defined words THIS tool names that the host does not know."""
    out: list[Diagnostic] = []
    declared = spec.parameters.get("properties", {}) if isinstance(spec.parameters, Mapping) else {}
    if spec.access and spec.access not in ACCESS_ARGS:
        out.append(
            Diagnostic(component, spec.name, f"unknown access {spec.access!r} (host knows {_known(ACCESS_ARGS)})")
        )
    if spec.gate not in GATES:
        # "" is a valid gate (no gate) and never worth naming back at the tool
        named = _known([g for g in GATES if g])
        out.append(Diagnostic(component, spec.name, f"unknown gate {spec.gate!r} (host knows {named})"))
    for mode in spec.modes:
        if mode not in MODES:
            out.append(Diagnostic(component, spec.name, f"unknown mode {mode!r} (host offers {_known(MODES)})"))
    for arg in (spec.access_arg, spec.snapshot_arg):
        if arg and arg not in declared:
            out.append(
                Diagnostic(component, spec.name, f"argument {arg!r} is not among the tool's declared parameters")
            )
    for key in spec.ui or {}:
        if key not in UI_KEYS:
            out.append(
                Diagnostic(
                    component, spec.name, f"unknown ui key {key!r} (renderer knows {_known(UI_KEYS)})", fatal=False
                )
            )
    return out


def component_diagnostics(component: Component) -> list[Diagnostic]:
    """Every host word a component's declaration read wrongly, its tools' too."""
    out = [
        Diagnostic(component.name, "", f"unknown facility in requires: {f!r} (host knows {_known(FACILITIES)})")
        for f in component.requires
        if f not in FACILITIES
    ]
    for spec in component.tools:
        out.extend(tool_diagnostics(component.name, spec))
    return out


def diagnostics(table_: Mapping[str, Component] | None = None) -> list[Diagnostic]:
    """Every declaration word this host cannot honor, over the whole table.

    Data, not a side effect: the host refuses the affected tools at wiring
    (registry.build_tools) and the caller can read back exactly which words and
    where. A caller that wants them out loud logs each once (registry._report).
    """
    known = table() if table_ is None else table_
    out: list[Diagnostic] = []
    for component in known.values():
        out.extend(component_diagnostics(component))
    return out


@dataclass(frozen=True)
class Launch:
    """How this host STARTS one component process — the artifact's shape, never
    its interface.

    `argv` is a template in argv words (not a shell line: these are handed to
    Popen as separate words, so nothing here is quoted — shell quoting belongs
    to the statement layer, tools/inst.py): `{py}` is the interpreter that can
    run the component, `{dir}` the component's directory on this host, `{script}`
    its entry-point file (`entry`). A `binary` names an executable INSIDE the
    component directory that supersedes the template when it is installed: that
    is how a PyInstaller onefile needs no interpreter and no checkout at all.
    `importable` says the component is a package driven by `-m`, so its own
    directory has to be on PYTHONPATH.

    Nothing above is a restriction on what a component MAY be — a onefile, a
    script, a package, an executable of any language, as long as it accepts the
    invocation contract (--workspace/--idle/--protect for a daemon, --envelope
    for a CLI).
    """

    argv: tuple[str, ...] = ()
    entry: str = ""  # the entry-point FILE inside the component ({script})
    binary: str = ""  # an installed executable that supersedes argv
    importable: bool = False


@dataclass(frozen=True)
class Tool:
    """One tool a component publishes — its whole host-visible surface.

    `description` is the model-facing text. `parameters` is JSON Schema; a
    string value anywhere in the declaration may carry the host-fact
    placeholders `$config.<field>`, `$skills` and `$backends`, resolved by the
    registry from what only the host knows.

    `command` is the statement template `inst.render` fills — the part of the
    line that is the COMPONENT's own business, never how its process starts
    (that is `Component.launch`, which rendezvous renders from the artifact's
    shape). A daemon's statement is the whole line (the loopback call IS the
    interface); a CLI's is only the flags after the executable, so the same
    declaration drives a checkout under an interpreter and an installed onefile.
    `defaults` rides the payload UNDER the model's arguments.

    `access` is the host POLICY this tool is subject to — the vocabulary the host
    defines and no declaration invents: "read" / "write" / "sweep" name a path
    argument the workspace may protect, "command" names the shell text a
    command-shaped tool runs, "" nothing (catalog.ACCESS_ARGS is the list). It is
    what the host's permission engine and guards judge a call by
    (permission.GUARDED_ARG), so a component installed later enters that policy
    without an edit to the host. `access_arg` names the argument that policy
    judges when it is not the word's default — a tool whose path argument is
    called `file` says `access_arg: "file"` and gets the same fence, guard and
    snapshot as one that calls it `path`.
    `snapshot` marks a statement that OVERWRITES a path, so the host can keep the
    per-file undo the UI offers (the module keeps its own stack; this is the
    host's); `snapshot_arg` names the argument that holds that path (default:
    `access_arg`, else "path"). `modes` are the agent modes the tool is offered
    in. `gate` names a host-side condition that must hold — "project" (a project
    memory store is open) or "skills" (skills are enabled and there is one to
    load) — and a shut gate means the tool is simply not offered
    (registry._gate_ok).
    """

    name: str
    description: str
    parameters: Mapping[str, Any]
    command: str | None = None
    defaults: Mapping[str, Any] = field(default_factory=dict)
    access: str = ""
    access_arg: str = ""  # the argument `access` judges ("" = the word's default)
    snapshot: bool = False
    snapshot_arg: str = ""  # the argument `snapshot` records ("" = access_arg, else "path")
    modes: tuple[str, ...] = ("work", "chat")
    gate: str = ""
    ui: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Component:
    """A component's published coordinates (the host's side of R4).

    `name` is the component's identity: the install name of its artifact, and by
    convention the directory name of its dev checkout beside the repo (one
    string, so a rename is one edit). `directory` overrides where a
    registration says its code lives (a component registered out-of-tree).

    `interface` is how the host talks to it; `runs_on` is whose machine its
    process runs on; `subject` is whose resources it serves. `launch` is how it
    is started. `vars` maps a statement placeholder to the host fact that fills
    it. `requires` names the host facilities it needs, so an unavailable
    component can say WHY instead of silently disappearing, and `ui` says how
    the user sees it.
    """

    name: str
    interface: str = DAEMON
    runs_on: str = SELF
    subject: str = WORKSPACE_FS
    launch: Launch = Launch()
    discovery_env: str = ""  # env var that repoints the discovery directory
    app_dir: str = ""  # directory under %LOCALAPPDATA% / ~ holding the records
    prefix: str = ""  # discovery file name prefix
    requires: tuple[str, ...] = ()
    vars: Mapping[str, str] = field(default_factory=dict)
    ui: Mapping[str, Any] = field(default_factory=dict)
    tools: tuple[Tool, ...] = ()
    directory: str = ""  # explicit code directory (a registration, not a checkout)


# --------------------------------------------- host facts a schema may ask for -


# The backends this host's own config can switch on for network search, in chain
# order, with the config field that enables each ("" = always available). This
# is a HOST fact — which knobs this machine's config has — not a declaration:
# any component may spend `$backends` in its schema text and the host renders
# what it knows, exactly as it does `$config.<field>` and `$skills`.
_BACKENDS = (("tavily", "tavily_api_key"), ("searxng", "searxng_url"), ("bing", ""), ("ddg", ""))


def available_backends(config) -> tuple[str, ...]:
    """The backends this machine has configured, in chain order (prompt text).
    An unconfigured service does not exist here — no name, no install advice."""
    return tuple(name for name, field in _BACKENDS if not field or getattr(config, field, ""))


# --------------------------------------------------------- registration -------


def catalog_dir() -> Path:
    """The user's catalog directory: registrations that are not installs.

    A component whose code lives somewhere out-of-tree (a checkout under work, a
    locally built onefile) is registered by dropping its declaration in here —
    one JSON file per component, the same manifest shape a package carries. The
    whole directory is machine-local bookkeeping, like the install root, and
    CLUTCH_COMPONENTS_CATALOG repoints it (tests, unusual layouts).
    """
    override = os.environ.get("CLUTCH_COMPONENTS_CATALOG")
    if override:
        return Path(override)
    return components.root() / "catalog.d"


def _component_of(data: Mapping[str, Any]) -> Component | None:
    """One declaration dict -> a Component, or None when it is not one.

    This is the protocol all three registration sources speak — a checkout's
    manifest, an installed manifest, a catalog file. A declaration the host
    cannot drive (no name, an interface it does not know) is refused HERE rather
    than half-registered and mysteriously broken later.
    """
    name = str(data.get("name", ""))
    interface = str(data.get("interface", DAEMON))
    if not name or interface not in (DAEMON, CLI):
        return None
    launch = data.get("launch") if isinstance(data.get("launch"), dict) else {}
    tools: list[Tool] = []
    for raw in data.get("tools", []) or []:
        spec = _tool_of(raw)
        if spec is not None:
            tools.append(spec)
    ui = data.get("ui") if isinstance(data.get("ui"), dict) else {}
    return Component(
        name=name,
        interface=interface,
        runs_on=str(data.get("runs_on", SELF)),
        subject=str(data.get("subject", WORKSPACE_FS)),
        launch=Launch(
            argv=tuple(str(w) for w in launch.get("argv", ()) or ()),
            entry=str(launch.get("entry", "") or ""),
            binary=str(launch.get("binary", "") or ""),
            importable=bool(launch.get("importable", False)),
        ),
        discovery_env=str(data.get("discovery_env", "") or ""),
        app_dir=str(data.get("app_dir", "") or ""),
        prefix=str(data.get("prefix", "") or ""),
        requires=tuple(str(r) for r in data.get("requires", ()) or ()),
        vars={str(k): str(v) for k, v in (data.get("vars") or {}).items()},
        ui=ui,
        tools=tuple(tools),
        directory=str(data.get("directory", "") or ""),
    )


def _tool_of(raw: Any) -> Tool | None:
    """One tool declaration -> a Tool, or None when it names no usable tool.

    A description that is not text is a malformed tool, and the tool is refused:
    the spec (COMPONENTS.md) says a description is the model-facing string, and
    a declaration the host cannot read as written is better absent than
    garbled."""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name", ""))
    description = raw.get("description", "")
    if not name or not isinstance(description, str):
        return None
    return Tool(
        name=name,
        description=description,
        parameters=raw.get("parameters") if isinstance(raw.get("parameters"), dict) else {},
        command=raw.get("command") or None,
        defaults=raw.get("defaults") or {},
        access=str(raw.get("access", "") or ""),
        access_arg=str(raw.get("access_arg", "") or ""),
        snapshot=bool(raw.get("snapshot", False)),
        snapshot_arg=str(raw.get("snapshot_arg", "") or ""),
        modes=tuple(str(m) for m in raw.get("modes", ("work", "chat"))),
        gate=str(raw.get("gate", "") or ""),
        ui=raw.get("ui") if isinstance(raw.get("ui"), dict) else {},
    )


def _read_json(path: Path) -> Mapping[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def checkout_registrations() -> list[Mapping[str, Any]]:
    """The declarations of the dev checkouts beside the host repo.

    Any sibling directory of the repo that carries a component.json IS a
    component, in exactly the shape an installed one declares — this is the
    whole development path (edit the manifest, restart, nothing to install) and
    it is how the components this repo develops are registered without the host
    naming a single one of them. Sorted by directory name, so the merge stays
    deterministic; a malformed manifest is simply not a component.
    """
    found: list[Mapping[str, Any]] = []
    base = modules.repo_root()
    if not base.is_dir():
        return found
    for path in sorted(base.iterdir()):
        if not path.is_dir():
            continue
        data = _read_json(path / components.MANIFEST)
        if data is not None:
            found.append(data)
    return found


def installed_registrations() -> list[Mapping[str, Any]]:
    """The declarations of the components installed for THIS host, in install
    order.

    One pass over the install root (components.installed_records): the manifest
    that resolved a component's version directory IS its declaration, so it is
    read once and used for both jobs.
    """
    return [manifest for _name, _directory, manifest in components.installed_records()]


def registrations() -> list[Mapping[str, Any]]:
    """Every declaration this host knows, in merge order (lowest precedence
    first).

    Three sources, all machine-local: a dev checkout beside the repo, the
    manifest of each component installed for THIS host (tools/components.py's
    landing dir), and the user's catalog directory. Order is stable (checkouts
    by name, then the install root, then the catalog files by name) so a later
    entry wins deterministically when two declare the same component — an
    installed artifact over its checkout, a catalog file over both.
    """
    found: list[Mapping[str, Any]] = [*checkout_registrations(), *installed_registrations()]
    base = catalog_dir()
    if base.is_dir():
        for path in sorted(base.glob("*.json")):
            data = _read_json(path)
            if data is not None:
                found.append(data)
    return found


def _stamp(path: str | Path) -> tuple[int, int] | None:
    """(mtime_ns, size) of one file or directory, or None when it is not there."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _scan(directory: Path) -> list[os.DirEntry]:
    """One directory's entries, by name. scandir, so "is this a directory?" costs
    no syscall of its own (the readdir entry already knows) — this runs on every
    lookup, so it is the whole reason the signature can be asked that often."""
    try:
        with os.scandir(directory) as entries:
            return sorted(entries, key=lambda e: e.name)
    except OSError:
        return []


def source_signature() -> tuple:
    """What the three registration sources look like RIGHT NOW, cheaply.

    Only the SHAPE is read — the files and directories a registration is read
    FROM, by mtime and size — never a manifest, so a table built from them can
    be reused while nothing has changed. It covers everything the loaders look
    at: a checkout directory appearing (or its component.json being edited), an
    install landing or a version being pruned (both touch the component's own
    directory), a registration file in the catalog directory, and the two
    environment variables that repoint the roots. Cheap enough to ask on every
    lookup, which is what makes the memoization safe rather than stale.

    Out of reach, deliberately: a file EDITED in place inside an installed
    component's version directory (a hand-patched manifest) does not move any
    directory's mtime — `catalog.invalidate()` is how a caller says so.
    """
    repo = modules.repo_root()
    checkouts = [
        (entry.name, _stamp(entry.path + os.sep + components.MANIFEST))
        for entry in _scan(repo)
        if entry.is_dir()
    ]
    install_root = components.root()
    installs = [
        (entry.name, _stamp(entry.path))
        for entry in _scan(install_root)
        if entry.is_dir() and entry.name != components.SCRATCH
    ]
    directory = catalog_dir()
    registrations = [(entry.name, _stamp(entry.path)) for entry in _scan(directory) if entry.name.endswith(".json")]
    return (
        str(repo),
        tuple(checkouts),
        str(install_root),
        tuple(installs),
        str(directory),
        tuple(registrations),
        os.environ.get(components.ROOT_ENV, ""),
        os.environ.get("CLUTCH_COMPONENTS_CATALOG", ""),
    )


# The table, and the source shape it was built from (catalog.source_signature).
# A lookup asks the sources whether they still look the same — cheap — and only
# re-reads them when they do not, so one turn's dozens of lookups cost one scan.
_TABLE: tuple[tuple, dict[str, Component]] | None = None


def invalidate() -> None:
    """Forget the memoized table: the next `table()` re-reads every source.

    Nothing in normal operation has to call this — a source appearing, being
    pruned or being edited is visible in the signature — but a caller that
    changed something the signature cannot see (an installed manifest edited in
    place) can say so, and the tests that lay sources down out of band do.
    """
    global _TABLE
    _TABLE = None


# The merge reads these off the dataclasses rather than repeating them: a field
# added to Component or Launch later is merged (or carried) by the same rule.
_COMPONENT_FIELDS = frozenset(f.name for f in fields(Component))
_LAUNCH_FIELDS = frozenset(f.name for f in fields(Launch))


def _named(data: Mapping[str, Any], names: frozenset[str]) -> set[str]:
    """Which of `names` the declaration actually writes down.

    Judged on the raw JSON, never on the parsed object: the proposal is "named
    means override", so `requires: []` and `discovery_env: ""` are a declaration
    saying "none" — a value the `or`-chained merge could not express, because it
    read every false-y field as "not mentioned" and carried the earlier one.
    """
    return {k for k in data if k in names}


def _refine(known: Component, declared: Component, data: Mapping[str, Any]) -> Component:
    """One later registration merged over the component it refines.

    Every field the later declaration NAMES wins, with the value `_component_of`
    already normalised for it; every field it leaves out carries from `known`
    untouched. `launch` is merged at ITS field level for the same reason one
    level up — a thin manifest that names only `binary` (or only `importable`)
    keeps the earlier `argv` and `entry` instead of restating them.

    Built with dataclasses.replace over the named fields, not a hand-written
    constructor: the old one silently reset any field it did not know about, so
    adding a field to Component meant remembering this function too.
    """
    named = {f: getattr(declared, f) for f in _named(data, _COMPONENT_FIELDS) if f != "name"}
    if "launch" in named:
        raw = data.get("launch")
        inner = _named(raw, _LAUNCH_FIELDS) if isinstance(raw, Mapping) else set()
        named["launch"] = replace(known.launch, **{f: getattr(declared.launch, f) for f in inner})
    return replace(known, **named)


def _build_table() -> dict[str, Component]:
    out: dict[str, Component] = {}
    for data in registrations():
        declared = _component_of(data)
        if declared is None:
            continue
        known = out.get(declared.name)
        if known is None:
            out[declared.name] = declared
            continue
        out[declared.name] = _refine(known, declared, data)
    return out


def table() -> dict[str, Component]:
    """The components this host may drive: every registration, merged by name.

    There is no base catalog — a host with no registrations drives nothing. Each
    later registration (see registrations() for the order) refines the one it
    agrees with by name, and the rule is "named means override": a field the
    later declaration writes down wins (its normalised value), a field it leaves
    out carries from before, and inside `launch` the same rule applies field by
    field. Naming a field is therefore also how a declaration CLEARS it —
    `requires: []` means none, not "as before" — and there is one merge semantic
    for the whole record instead of a deep-merge here and an overwrite there.
    That is what makes a thin install manifest (how the artifact starts, at which
    digest) ride on the declaration its checkout or package carries, and a
    third-party component simply has no earlier declaration and enters whole.

    The result is MEMOIZED on the shape of the sources (source_signature): the
    table is the host's view of what is installed, and asking for it dozens of
    times in one turn must cost one scan, not dozens. Returned as a copy —
    callers keep it, nobody owns it."""
    global _TABLE
    signature = source_signature()
    if _TABLE is None or _TABLE[0] != signature:
        _TABLE = (signature, _build_table())
    return dict(_TABLE[1])


def ui_of(spec: Tool) -> dict[str, Any]:
    """The tool's presentation, defaults filled in — the one place a component's
    UI keys are read, so the renderer can never see a half-specified block. The
    host's own two keys ride on top of this (registry.ToolRegistry.ui)."""
    out = dict(DEFAULTS)
    for key, value in (spec.ui or {}).items():
        if key in UI_KEYS:
            out[key] = value
    return out
