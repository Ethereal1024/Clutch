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

Two sources, one shape
----------------------
  * the SHIPPED catalog below — the components this distribution knows about;
  * a REGISTRATION — the `component.json` of an installed artifact
    (tools/components.py lands it), or a JSON file in the user's catalog
    directory. A registration with a name the shipped catalog does not carry
    enters the table with its own tools: that is how a third-party component
    makes itself available, and it is the whole of R4.

The declaration is data. Nothing here executes a tool; `registry` turns a
declaration into the Tool the model sees, `rendezvous` turns its coordinates
into a running process, and `ui/app.js` turns its `ui` block into pixels.

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
              so a run of reads scans as a column of one-liners. None = the call
              is its own row and its result is its own block (a write must not be
              swallowed by the reads around it).
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
    style     how the result is chromed: "plain", "read" (an exploration result:
              its content as a collapsible code panel), "write" (a change: the
              header is the accent chip over the diff).
    body      "text" the result content, "diff" the unified diff it returned,
              "none" nothing but the status line.
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
from dataclasses import dataclass, field
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
    "style": "plain",
    "body": "text",
    "collapse": "never",
}
UI_KEYS = tuple(DEFAULTS) + ("mutates",)


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

    `description` is either literal text (a third-party manifest) or `(prompt
    name, variables)` (the shipped catalog's markdown, rendered with the host's
    config). `parameters` is JSON Schema; a string value in it may be the
    placeholder `$config.<field>` or the list placeholder `$skills`, resolved by
    the registry from what only the host knows.

    `command` is the statement template `inst.render` fills — the part of the
    line that is the COMPONENT's own business, never how its process starts
    (that is `Component.launch`, which rendezvous renders from the artifact's
    shape). A daemon's statement is the whole line (the loopback call IS the
    interface); a CLI's is only the flags after the executable, so the same
    declaration drives a checkout under an interpreter and an installed onefile.
    `defaults` rides the payload UNDER the model's arguments.

    `access` is the host POLICY this tool is subject to — the vocabulary the host
    defines and no declaration invents: "read" / "write" / "sweep" name a `path`
    argument the workspace may protect, "command" names the shell text a
    command-shaped tool runs, "" nothing. It is what the host's permission
    engine and guards judge a call by (permission.GUARDED_ARG), so a component
    installed later enters that policy without an edit to the host.
    `snapshot` marks a statement that OVERWRITES `path`, so the host can keep the
    per-file undo the UI offers (the module keeps its own stack; this is the
    host's). `modes` are the agent modes the tool is offered in. `gate` names a
    host-side condition that must hold — "project" (a project memory store is
    open) or "skills" (skills are enabled and there is one to load) — and a shut
    gate means the tool is simply not offered (registry._gate_ok).
    """

    name: str
    description: str | tuple[str, Mapping[str, Any]]
    parameters: Mapping[str, Any]
    command: str | None = None
    defaults: Mapping[str, Any] = field(default_factory=dict)
    access: str = ""
    snapshot: bool = False
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


# ------------------------------------------------ the shipped catalog ---------


def _daemon(path: str) -> str:
    """One statement against a standalone module daemon's HTTP surface.

    Every part of this line is the host's half of a frozen contract (R4): the
    path, the JSON body, the token header, the status trailer. The host imports
    nothing from the module — it only knows how to speak to it. --noproxy keeps
    a configured proxy away from 127.0.0.1; -w prints the HTTP status, which
    unwrap() reads as the TRANSPORT's verdict (the command's own verdict rides
    the 200 body, so a 200 that says "file not found" stays a command verdict).
    """
    return (
        "curl -sS --noproxy 127.0.0.1 -H 'Content-Type: application/json' "
        f"-H {{auth}} --data-binary {{*}} -w {{status}} http://127.0.0.1:{{port}}{path}"
    )


def _str(desc: str) -> dict[str, Any]:
    return {"type": "string", "description": desc}


# Web search backends the shipped websearch component speaks, in chain order,
# with the config field that enables each ("" = always available). Declaration
# only: the host does not search, it renders the component's options into the
# model-facing description.
_BACKENDS = (("tavily", "tavily_api_key"), ("searxng", "searxng_url"), ("bing", ""), ("ddg", ""))


def available_backends(config) -> tuple[str, ...]:
    """The backends this machine has configured, in chain order (prompt text).
    An unconfigured service does not exist here — no name, no install advice."""
    return tuple(name for name, field in _BACKENDS if not field or getattr(config, field, ""))


_WORKSPACE = Component(
    name=modules.WORKSPACE,
    subject=WORKSPACE_FS,
    launch=Launch(argv=("{py}", "-m", "clutch_workspace.daemon"), importable=True),
    discovery_env="CLUTCH_WORKSPACE_DISCOVERY_DIR",
    app_dir="clutch-workspace",
    prefix="d-",
    requires=("python", "posix-shell", "curl"),
    ui={"label": "workspace files", "status": True},
    tools=(
        Tool(
            name="read_file",
            description=("tools/read_file.md", {"read_max_chars": "$config.read_max_chars"}),
            parameters={
                "properties": {
                    "path": _str("file path OR directory path, relative to the workspace root"),
                    "max_chars": {
                        "type": "integer",
                        "description": "max chars to read (default $config.read_max_chars)",
                    },
                    "offset": {"type": "integer", "description": "1-based start line for a line-range read"},
                    "limit": {"type": "integer", "description": "max lines to read when offset is given"},
                },
                "required": ["path"],
            },
            command=_daemon("/read_file"),
            defaults={"max_chars": "$config.read_max_chars"},
            access="read",
            ui={
                "group": "read",
                "style": "read",
                "body": "text",
                "collapse": "always",
                "preview": "none",
                "summary": "read {path} ({lines} lines)",
            },
        ),
        Tool(
            name="grep",
            description=("tools/grep.md", {}),
            parameters={
                "properties": {
                    "pattern": _str("regex to search for"),
                    "path": _str("subdirectory or file to search (default: whole workspace)"),
                    "include": _str("filename glob filter (e.g. '*.py')"),
                },
                "required": ["pattern"],
            },
            command=_daemon("/grep"),
            defaults={"path": ".", "include": ""},
            access="sweep",
            ui={
                "group": "read",
                "style": "read",
                "body": "text",
                "collapse": "always",
                "preview": "none",
                "summary": "grep {pattern} ({lines} lines)",
            },
        ),
        Tool(
            name="write_file",
            description=("tools/write_file.md", {}),
            parameters={
                "properties": {
                    "path": _str("file path, relative to the workspace root"),
                    "content": _str("full file content"),
                },
                "required": ["path", "content"],
            },
            command=_daemon("/write_file"),
            access="write",
            snapshot=True,
            modes=("work",),
            ui={
                "style": "write",
                "header": "✓ wrote {path}",
                "body": "diff",
                "collapse": "long",
                "preview": {"mode": "content", "keys": ["✎path", "content"]},
            },
        ),
        Tool(
            name="edit_file",
            description=("tools/edit_file.md", {}),
            parameters={
                "properties": {
                    "path": _str("file path, relative to the workspace root"),
                    "old_string": _str("exact text to replace (must appear exactly once)"),
                    "new_string": _str("replacement text"),
                },
                "required": ["path", "old_string", "new_string"],
            },
            command=_daemon("/edit_file"),
            access="write",
            snapshot=True,
            modes=("work",),
            ui={
                "style": "write",
                "header": "✎ edited {path}",
                "body": "diff",
                "collapse": "long",
                "preview": {"mode": "content", "keys": ["✎path", "-old_string", "+new_string"]},
            },
        ),
    ),
)

_MEMORY = Component(
    name=modules.MEMORY,
    interface=CLI,
    subject=PROJECT_FILE,
    launch=Launch(argv=("{py}", "{script}"), entry="memory.py"),
    requires=("python",),
    vars={"base": "host.port_url"},
    ui={"label": "project memory", "status": True},
    tools=(
        Tool(
            name="save_memory",
            description=(
                "Save a durable fact from this conversation to project memory — a key "
                "decision, a user preference, or an important detail worth remembering "
                "across sessions. title must be a very short one-line summary (<=80 chars); "
                "content is the full detail. Saving the same title again overwrites it."
            ),
            parameters={
                "properties": {
                    "title": _str("very short one-line summary of the memory"),
                    "content": _str("full detail to remember"),
                },
                "required": ["title", "content"],
            },
            command="--endpoint {base} --envelope save --title {title} --content {content}",
            gate="project",
        ),
        Tool(
            name="load_memory",
            description="Read one stored memory's full content by its exact title.",
            parameters={
                "properties": {"name": _str("the memory title to load")},
                "required": ["name"],
            },
            command="--endpoint {base} --envelope load --title {name}",
            gate="project",
            access="read",
        ),
        Tool(
            name="search_memory",
            description=(
                "Search stored project memories by title or content; returns matching "
                "titles with snippets. Call with a topic to recall relevant long-term "
                "facts; an empty query lists the most recent memories."
            ),
            parameters={
                "properties": {"query": _str("topic to search for; empty lists recent")},
                "required": [],
            },
            command="--endpoint {base} --envelope search [--query {query}]",
            gate="project",
        ),
    ),
)

_WEBSEARCH = Component(
    name=modules.WEBSEARCH,
    interface=CLI,
    subject=NETWORK,
    launch=Launch(argv=("{py}", "{script}"), entry="websearch.py"),
    requires=("python",),
    ui={"label": "web access", "status": True},
    tools=(
        Tool(
            name="web_search",
            description=(
                "tools/web_search.md",
                {"max_results": "$config.web_search_max_results", "backends": "$backends"},
            ),
            parameters={
                "properties": {
                    "query": _str("search string (engine syntax like site: and quoted phrases works)"),
                    "max_results": {
                        "type": "integer",
                        "description": "cap on returned entries (default $config.web_search_max_results)",
                    },
                    "backend": _str("pin one backend: $backends (default: fall through the chain)"),
                },
                "required": ["query"],
            },
            command="search --envelope [--max-results {max_results}] [--backend {backend}] {query}",
            defaults={"max_results": "$config.web_search_max_results"},
        ),
        Tool(
            name="web_fetch",
            description=("tools/web_fetch.md", {"max": "$config.read_max_chars"}),
            parameters={
                "properties": {
                    "url": _str("http(s) URL to fetch"),
                    "max_chars": {
                        "type": "integer",
                        "description": "max chars of extracted text to return (default $config.read_max_chars)",
                    },
                    "start": {"type": "integer", "description": "0-based char offset to continue a truncated fetch"},
                },
                "required": ["url"],
            },
            command="fetch --envelope [--max-chars {max_chars}] [--start {start}] {url}",
            defaults={"max_chars": "$config.read_max_chars"},
        ),
    ),
)

_SKILLS = Component(
    name=modules.SKILLS,
    interface=CLI,
    subject=SKILL_LIB,
    launch=Launch(argv=("{py}", "-m", "clutch_skills"), importable=True),
    requires=("python",),
    vars={"root": "config.skills_dir"},
    ui={"label": "skill library", "status": True},
    tools=(
        Tool(
            name="load_skill",
            description=("tools/load_skill.md", {}),
            parameters={
                "properties": {
                    "name": {
                        "type": "string",
                        "enum": "$skills",
                        "description": "skill to load, one of: $skills",
                    },
                    "file": _str(
                        "optional file inside the skill directory to read instead of SKILL.md "
                        "(e.g. resources/template.html)"
                    ),
                },
                "required": ["name"],
            },
            command="--envelope [--root {root}] show {name} [--file {file}]",
            gate="skills",
        ),
    ),
)

SHIPPED: tuple[Component, ...] = (_WORKSPACE, _MEMORY, _WEBSEARCH, _SKILLS)


# --------------------------------------------------------- registration -------


def catalog_dir() -> Path:
    """The user's catalog directory: registrations that are not installs.

    A component whose code lives somewhere out-of-tree (a checkout under work, a
    locally built onefile) is registered by dropping its declaration in here —
    one JSON file per component, the same shape the shipped catalog holds. The
    whole directory is machine-local bookkeeping, like the install root, and
    CLUTCH_COMPONENTS_CATALOG repoints it (tests, unusual layouts).
    """
    override = os.environ.get("CLUTCH_COMPONENTS_CATALOG")
    if override:
        return Path(override)
    return components.root() / "catalog.d"


def _component_of(data: Mapping[str, Any]) -> Component | None:
    """One declaration dict -> a Component, or None when it is not one.

    This is the protocol an installed manifest and a user catalog file both
    speak. A declaration the host cannot drive (no name, an interface it does
    not know) is refused HERE rather than half-registered and mysteriously
    broken later.
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
    """One tool declaration -> a Tool, or None when it names no usable tool."""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name", ""))
    if not name:
        return None
    description = raw.get("description", "")
    if isinstance(description, dict):  # {"prompt": ..., "vars": {...}} (shipped)
        description = (str(description.get("prompt", "")), description.get("vars", {}) or {})
    if not isinstance(description, (str, tuple)):
        description = str(description)
    return Tool(
        name=name,
        description=description,
        parameters=raw.get("parameters") if isinstance(raw.get("parameters"), dict) else {},
        command=raw.get("command") or None,
        defaults=raw.get("defaults") or {},
        access=str(raw.get("access", "") or ""),
        snapshot=bool(raw.get("snapshot", False)),
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


def registrations() -> list[Mapping[str, Any]]:
    """Every declaration on this host that is not the shipped catalog.

    Two sources, both machine-local: the manifest of each component installed
    for THIS host (tools/components.py's landing dir) and the user's catalog
    directory. Order is stable (install root first, then the catalog files by
    name) so a later entry wins deterministically when two name the same
    component.
    """
    found: list[Mapping[str, Any]] = []
    for record in components.inventory():
        directory = modules.component_dir(record["name"])
        manifest = components.read_manifest(directory)
        if manifest is not None:
            found.append(manifest)
    base = catalog_dir()
    if base.is_dir():
        for path in sorted(base.glob("*.json")):
            data = _read_json(path)
            if data is not None:
                found.append(data)
    return found


def table() -> dict[str, Component]:
    """The components this host may drive: the shipped catalog, overlaid by
    every registration.

    A registration for a name the catalog already carries contributes what it
    declares and keeps the rest: an installed `clutch-memory` whose manifest
    only records how it starts does not lose the tools the catalog describes,
    while a third-party component brings tools of its own.
    """
    out: dict[str, Component] = {c.name: c for c in SHIPPED}
    for data in registrations():
        declared = _component_of(data)
        if declared is None:
            continue
        known = out.get(declared.name)
        if known is None:
            out[declared.name] = declared
            continue
        # a registration refines a known component: an empty field means "as
        # shipped", a declared one wins (an artifact's own launch shape, a
        # third-party tool added to a component)
        out[declared.name] = Component(
            name=known.name,
            interface=declared.interface if data.get("interface") else known.interface,
            runs_on=declared.runs_on,
            subject=declared.subject,
            launch=declared.launch if declared.launch.argv or declared.launch.binary else known.launch,
            discovery_env=declared.discovery_env or known.discovery_env,
            app_dir=declared.app_dir or known.app_dir,
            prefix=declared.prefix or known.prefix,
            requires=declared.requires or known.requires,
            vars={**known.vars, **declared.vars},
            ui={**known.ui, **declared.ui},
            tools=declared.tools or known.tools,
            directory=declared.directory or known.directory,
        )
    return out


def ui_of(spec: Tool) -> dict[str, Any]:
    """The tool's presentation, defaults filled in — the one place a component's
    UI keys are read, so the renderer can never see a half-specified block. The
    host's own two keys ride on top of this (registry.ToolRegistry.ui)."""
    out = dict(DEFAULTS)
    for key, value in (spec.ui or {}).items():
        if key in UI_KEYS:
            out[key] = value
    return out
