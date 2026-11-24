"""The component catalog: what this host knows how to drive, and how to show it.

A component is a standalone program whose statements the host speaks — a process
that stays and is spoken to over loopback HTTP, one process per call, or NO
process here at all, in which case the client that declared it renders and runs
the statement. The host imports NOTHING from it: it holds a DECLARATION of the
component — what it contributes (`service` = a process that stays, `launch` = a
process this host starts per call, neither = the client's own `entry` module),
whose resources it serves (subject), which host facts its statements need (vars)
and which host facts IT answers (facts), which tools it publishes (each with the
model-facing schema, the one statement that satisfies a call, and how the UI
presents it), and how the user sees the component's own state (ui).

There is no host-side implementation behind any of it, and no fallback either:
a tool this catalog does not describe does not exist for the model, and a
component that is absent takes its tools with it and nothing else (see
registry.build_tools). A host with nothing installed can chat and nothing more.

A few declarations are not a component's, and they are declared rather than
assumed: `run_command` (the single bootstrap exception) and the two readers of
the project's own log, `grep_memory` / `read_memory`. They live in tools/host.py
in this very vocabulary, and no component may publish their names
(HOST_TOOL_NAMES below).

Zero built-ins, one source
--------------------------
The host ships NO component declaration — not even for the components its own
repo develops. A component is declared by the component, in a `component.json`
manifest that travels WITH it (the same shape at every stop, like an editor
extension's package manifest), and this module DISCOVERS it in exactly one
place:

  * an INSTALLED artifact — the manifest tools/components.py laid down in this
    host's install root, which is the package's own manifest plus the install
    facts (version, digest).

ONE PATH, AND IT IS THE INSTALL. There is no second reading and no precedence:
a name is either held by this host, with the version directory that IS its
code and the manifest inside it that IS its declaration, or it does not exist
here at all. A dev checkout beside the host repo is NOT a source — it is
nothing but a directory to BUILD an artifact from, and a host that wants to run
what a checkout contains installs it (scripts/install-component.py does exactly
the two steps a release does: archive, then `components.install`). That is why
nothing here merges two declarations of one name field by field any more: the
"which half came from where" question cannot be asked of a record that has one
origin, and an installed artifact can no longer shadow — or be shadowed by —
code that happened to sit next to the repo.

The one other declaration that can reach this table is not a registration: the
components a CLIENT says IT runs (tools/channel.py). Those have no bytes here
at all. Their declaration and their code are the client's own install, which is
what keeps a client plugin on the same rule from the client's side.

The declaration is data. Nothing here executes a tool; `registry` turns a
declaration into the Tool the model sees, `rendezvous` turns its coordinates
into a running process, and `ui/js/tool-render.js` turns its `ui` block into
pixels (`ui/app.js` + `ui/js/*` are the renderer; ui/index.html fixes the order).
The full manifest spec is what `read_manifest` and the validators below accept.

The UI protocol (declared per tool, consumed by ui/js/tool-render.js)
----------------------------------------------------------
The host renders tool events it did not design, so the component says how its
events look — and the renderer contains no tool name at all. Every tool event
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

import hashlib
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

from ..config import Config
from . import components, hostconfig

# How a component is spoken to is not a word in the declaration: the declaration
# already says what it CONTRIBUTES, and that is the answer. A `service`
# block = a process that stays and publishes what a statement names (started by
# `launch` when it declares one); a `launch` alone = a process this host starts per
# call; NEITHER = no process here at all, so the component contributes only what it
# carries (prompt, facts, data) and any statement it declares is the CLIENT's
# (tools/channel.py). A declaration that names a process here AND an `entry` is
# refused rather than half-read (component_diagnostics).
#
# There is one reading of a declaration and it does not depend on when the release
# was published. The old words `interface` and `runs_on` said the same thing a
# contribution already says, and this host does not keep a second way of saying it:
# a manifest that still carries one is REFUSED by name (RETIRED_WORDS,
# component_diagnostics), not read for whichever half this host can guess at.

# Whose resources a component serves — which decides whether a statement may run
# for a given workspace at all (registry.module_blocked_reason). The workspace's
# own filesystem has one subject and two halves: a component whose process this
# host starts answers for THIS machine, and one that only declares an `entry`
# reaches the machine holding the root over a channel (rendezvous.
# reaches_another_machine). FOREIGN_FS is 0.1.x's word for that second half and is
# still read as one.
WORKSPACE_FS = "workspace-fs"
FOREIGN_FS = "foreign-fs"
NETWORK = "network"
PROJECT_FILE = "project-file"

# What the UI does with a tool that declares no `ui` block: a plain block, its
# name as the row's chip, its arguments streamed, its result shown whole. Any
# tool works out of the box; a component only has to speak up when it looks
# different. `mutates` is a key the HOST derives when the declaration leaves it
# out (registry.ui), which is why it has no default here.
#
# The table below is the built-in one; `DEFAULTS` is what the host really uses,
# the document merged over it (hostconfig). The renderer's own copy in
# ui/js/tool-render.js is only what an unreadable document — or a host that predates
# GET /api/host — leaves in force, and a call's own `ui` block still wins over
# both.
DEFAULT_UI: dict[str, Any] = {
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
DEFAULTS: dict[str, Any] = hostconfig.ui(DEFAULT_UI)
UI_KEYS = tuple(DEFAULTS) + ("mutates",)


# ------------------------------------------------- the host's own vocabulary ----
# The words a declaration may use that the HOST defines, listed once so a word
# this host does not know can be refused instead of silently failing (see
# Diagnostics below). A component chooses the value — which policy, which gate,
# which facility — and never invents the word.
#
# Two of these tables are also the host's own extension point: the `access` words
# (and the guard each is enforced by) and the named `gate` conditions may be
# named by the host's DOCUMENT as well as by this file — `~/.clutch/host.json`,
# or CLUTCH_HOST_CONFIG (tools/hostconfig.py). What is written below is then the
# built-in default, merged over word by word, and only implementations the host
# ALREADY has can be named: a document chooses, it never brings code.

# The guard implementations this host has, by the name a document calls one
# (hostconfig: `"guard": "guard_read"`). registry._GUARD_IMPLS binds each name to
# the function, and _check_vocabulary keeps the two lists equal: a name here that
# nothing implements would otherwise be a policy word with no policy behind it.
GUARD_IMPLS: tuple[str, ...] = ("guard_read", "guard_grep", "guard_write")
# The gate conditions this host has, likewise named (registry._GATE_IMPLS
# implements them; the same check keeps the lists equal). A gate word may ALSO be
# the name of a fact a component publishes (see `published`): the condition is
# then "that fact has something in it", which is a question only the publishing
# component can answer, and the only condition a declaration needs in order to
# offer a tool over its own catalog. The host therefore knows exactly one
# condition of its own, and inherits every other one from a declaration.
GATE_IMPLS: tuple[str, ...] = ("project",)

# access: the policy a tool is put under, with the argument that policy judges by
# default. A declaration may RENAME that argument (`Tool.access_arg`) — a path
# argument called `file` still enters the workspace's fence — but the word and
# its meaning stay the host's. "" = no host-side guard (the permission engine
# still judges the call). Read by permission.GUARDED_ARG and registry.ACCESS —
# both of which read the MERGED table below, not this one.
DEFAULT_ACCESS: dict[str, hostconfig.AccessWord] = {
    "read": hostconfig.AccessWord("guard_read", "path"),  # a path the workspace may protect
    "sweep": hostconfig.AccessWord("guard_grep", "path"),  # a path a broad search walks
    "write": hostconfig.AccessWord("guard_write", "path"),  # a path the call may overwrite
    "command": hostconfig.AccessWord("", "command"),  # the shell text a command-shaped tool runs
}
ACCESS_WORDS: dict[str, hostconfig.AccessWord] = hostconfig.access(DEFAULT_ACCESS, GUARD_IMPLS)
ACCESS_ARGS: dict[str, str] = {word: rec.arg for word, rec in ACCESS_WORDS.items()}
# gate: a host-side condition that must hold for the tool to be offered at all
# (registry._gate_ok). "" / "always" = no condition, and are structural rather
# than declared: only the NAMED conditions are the document's to add or drop.
DEFAULT_GATES: dict[str, str] = {"project": "project"}
GATE_WORDS: dict[str, str] = hostconfig.gates(DEFAULT_GATES, GATE_IMPLS)
GATES: tuple[str, ...] = ("", "always", *GATE_WORDS)
# modes: the agent modes a tool is offered in (config.Config.mode).
MODES: tuple[str, ...] = ("work", "chat")
# requires: the host facilities a component may declare it stands on
# (rendezvous.unavailable_reason answers whether each holds on this host).
FACILITIES: tuple[str, ...] = ("python", "posix-shell", "curl")
# The tool names the HOST itself declares: the bootstrap exception (tools/host.py).
# The host always has exactly these — with nothing installed they ARE its
# whole surface — so a component cannot publish one of them: a name the model
# already means something by is not a component's to redefine (see
# component_diagnostics). The declarations behind the names live in
# agent/tools/host.py; registry._check_vocabulary keeps the two lists equal.
HOST_TOOL_NAMES: tuple[str, ...] = ("run_command", "grep_memory", "read_memory")
# The names the host declares for ITSELF again when the session's root is on
# another machine (the ssh backend: tools/host.py `_REMOTE_DECLARATIONS`). These
# are NOT reserved the way HOST_TOOL_NAMES are: the same four names are what
# `clutch-workspace` (subject workspace-fs) publishes on a local root, where its
# own daemon really performs them — a component may declare them, and must,
# because on a local machine there is nothing else. What the ssh backend adds is
# the case no component can cover: a root with no process behind it, where the
# host's own implementation (tools/filesystem.py) IS the tool. registry.
# build_tools therefore drops a component's copy of a name the host already holds
# in THIS session, and keeps it whenever the host holds nothing.
REMOTE_TOOL_NAMES: tuple[str, ...] = ("read_file", "grep", "write_file", "edit_file")
# facts: the host facts a component may PUBLISH, because only its own code can
# compute them. `vars` is the other direction (what a component consumes from the
# host); a `facts` key is a host fact a component ANSWERS — a component declares
# the statement that produces it, and the host asks that statement when it needs
# the value (tools/facts.py).
#
# The vocabulary is the DECLARATIONS'. This host keeps no list of its own: a
# token exists because a component says it answers it, and what the host
# guarantees is the SHAPE of the answer (one JSON array of `{"name",
# "description"}` — facts.py) and that exactly ONE component answers it
# (component_diagnostics: two suppliers would be two truth sources behind one name
# the model picks a value from). `published()` is that list, read off the merged
# table — so a component that is absent publishes nothing, a component that is
# installed is the whole of what can be asked, and a new fact costs the host no
# edit at all.
_FACT_NAME = re.compile(r"[a-z][a-z0-9_]*\Z")


# Names the host already MEANS: the words it spends inside a placeholder
# (answers.placeholder) and the gates it honors (GATE_WORDS). A fact may not take
# one, or `$backends` / a gate `project` would read two ways depending on who
# answered. Read off the host's own vocabulary, so a word this machine's document
# adds is reserved without a second edit.
def _reserved() -> tuple[str, ...]:
    return ("backends", *GATE_WORDS)


def _publishable(token: str) -> bool:
    """Whether a `facts` token is a word this host can carry at all: a bare name,
    and not one it already means."""
    return bool(_FACT_NAME.match(token)) and token not in _reserved()


def published(table_: Mapping[str, Component] | None = None) -> tuple[str, ...]:
    """Every host fact the components on this table publish, in table order."""
    known = table() if table_ is None else table_
    return tuple(dict.fromkeys(token for component in known.values() for token in component.facts))


# settings: the knobs a component lets a PERSON set (catalog.Component.settings).
# The host draws the form and stores the values from the declaration alone
# (tools/settings.py), the way an editor draws an extension's contributed
# configuration — it knows no specific knob of anybody. One entry is
#
#     "library.root": {"type": "string", "default": "", "description": "..."}
#
# `type` is one of SETTING_TYPES, `default` is where the control starts and what
# a per-setting reset returns to, `description` is the sentence under it. An
# `enum` adds `enum` (its options), an `array` adds `items` (always "string": a
# box of comma-separated words). The values come back to the component through
# the interface it already has for host facts — a `vars` entry naming
# `host.settings` is the path of the document holding them (statement.host_vars).
SETTING_TYPES: tuple[str, ...] = ("boolean", "string", "number", "integer", "array", "enum")
# A sectioned key (`library.root`) is the shape VS Code users read a setting by,
# and the dot costs nothing anywhere else: it is one word in a JSON object.
_SETTING_NAME = re.compile(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\Z")


def setting_value(spec: Mapping[str, Any], value: Any) -> tuple[Any, bool]:
    """One value read as the setting's type: (the value, whether it fit).

    The single place a setting's type MEANS something, so the form (what to
    draw), the store (what to keep) and the diagnostics (what a default must be)
    cannot disagree — and a value a client sends is judged by the same rule the
    declaration was read by. `enum` is a string that must be one of its options.
    """
    kind = str(spec.get("type", ""))
    if kind == "boolean":
        fit = isinstance(value, bool)
        return (value, True) if fit else (False, False)
    if kind == "string":
        fit = isinstance(value, str)
        return (value, True) if fit else ("", False)
    if kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0, False
        if kind == "integer":
            return (int(value), True) if value == int(value) else (0, False)
        return value, True
    if kind == "array":
        fit = isinstance(value, (list, tuple)) and all(isinstance(item, str) for item in value)
        return (list(value), True) if fit else ([], False)
    if kind == "enum":
        options = spec.get("enum")
        allowed = [o for o in options if isinstance(o, str)] if isinstance(options, list) else []
        fit = isinstance(value, str) and value in allowed
        return (value, True) if fit else (allowed[0] if allowed else "", False)
    return None, False


def setting_defaults(component: Component) -> dict[str, Any]:
    """Where every setting of one component starts, in declaration order."""
    out: dict[str, Any] = {}
    for key, spec in component.settings.items():
        value, ok = setting_value(spec, spec.get("default")) if isinstance(spec, Mapping) else (None, False)
        if ok:
            out[key] = value
    return out


@dataclass(frozen=True)
class Diagnostic:
    """A host-defined word a declaration used that this host does not know.

    The direction is deliberately fail-CLOSED: a word
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
    if spec.gate not in GATES and spec.gate not in published():
        # "" is a valid gate (no gate) and never worth naming back at the tool.
        # A published fact is a gate too: the condition is "that fact has
        # something in it" (gates._gate_ok), and only the component publishing it
        # can answer.
        named = _known([g for g in GATES if g] + [t for t in published() if t not in GATES])
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


def settings_diagnostics(component: Component) -> list[Diagnostic]:
    """The `settings` block, read as the form the host will draw.

    A declaration the host cannot draw is refused rather than drawn as a plain
    text box: a `type` outside SETTING_TYPES, an `enum` with no options, an
    `array` of something that is not a string, or a `default` that is not a value
    of the type it claims all leave a control that would send the component
    something it cannot read. The DESCRIPTION is the one non-fatal miss — the
    form still works without a sentence beside it, it just explains nothing.
    """
    out: list[Diagnostic] = []
    for key, spec in component.settings.items():
        what = f"setting {key!r}"
        if not _SETTING_NAME.match(key):
            out.append(
                Diagnostic(
                    component.name,
                    "",
                    f"{what} is not a name (a dotted word: [a-z][a-z0-9_]*, like `library.root`)",
                )
            )
            continue
        if not isinstance(spec, Mapping):
            out.append(Diagnostic(component.name, "", f"{what} must be an object with at least a `type`"))
            continue
        if not str(spec.get("description", "")).strip():
            out.append(
                Diagnostic(component.name, "", f"{what} says nothing about itself (no `description`)", fatal=False)
            )
        kind = str(spec.get("type", ""))
        if kind not in SETTING_TYPES:
            out.append(
                Diagnostic(component.name, "", f"{what} has unknown type {kind!r} (host draws {_known(SETTING_TYPES)})")
            )
            continue
        if kind == "enum" and not (isinstance(spec.get("enum"), list) and spec["enum"]):
            out.append(Diagnostic(component.name, "", f"{what} is an enum with no `enum` list to pick from"))
        if kind == "array" and spec.get("items", "string") != "string":
            detail = f"{what} is an array of {spec.get('items')!r}: the host draws strings only"
            out.append(Diagnostic(component.name, "", detail))
        if "default" not in spec:
            # Not cosmetic: the control starts at its default and a per-setting
            # reset returns to it, so a setting without one has nowhere to start.
            out.append(Diagnostic(component.name, "", f"{what} declares no default (a setting says where it starts)"))
        elif not setting_value(spec, spec["default"])[1]:
            out.append(Diagnostic(component.name, "", f"{what} declares a default that is not a {kind}"))
    return out


def component_diagnostics(component: Component) -> list[Diagnostic]:
    """Every host word a component's declaration read wrongly, its tools' too.

    Three things are checked here rather than in tool_diagnostics, because each
    straddles two levels. A `vars` key that is also one of a tool's declared
    arguments: host vars shadow the model's argument of the same name when the
    statement is rendered (inst.render), so the model's value would be silently
    dropped — a call that names a path the host then replaces. The declaration is
    refused instead of quietly meaning something else. A tool that publishes one
    of the host's OWN names (HOST_TOOL_NAMES): the host always has that tool, so a
    component declaring it would either shadow it or lose silently, and the model
    would have no way to tell which one it is calling. And a `facts` entry: a
    token the host does not know (it would be a fact nothing ever spends), or a
    fact published by a component whose statement does not stand alone — a
    service's statement is spoken to one workspace and a client-side component's is
    the client's, while a host fact belongs to no workspace and is answered here
    (tools/facts.py). And what the declaration CONTRIBUTES, which every other word
    is now derived from: a `service` is a process that STAYS, a
    `launch` alone is one this host starts per call, and `entry` is the CLIENT's own
    module — so `entry` beside either is a declaration speaking two languages. A
    contribution of neither process nor `entry` is LEGAL: the component has no
    process and contributes only what it carries (prompt, facts, data), because a
    component is not required to be a tool (invariant I5). A client-side component's
    tools MUST carry a `command`: that template is the statement the client itself
    runs, sent to it verbatim (tools/statement.py, tools/channel.py) — a tool
    without one is a tool nothing could carry out.
    """
    out = [
        Diagnostic(component.name, "", f"unknown facility in requires: {f!r} (host knows {_known(FACILITIES)})")
        for f in component.requires
        if f not in FACILITIES
    ]
    # The place a statement runs is now a DERIVATION, not a word: a declaration
    # says what it contributes and the host reads the rest out of that. `entry` is
    # the client's own module, so naming it beside a process here is one
    # declaration speaking two languages — refused rather than half-read, because
    # either reading would run a statement on a machine the author did not mean.
    # A contribution of NEITHER process nor `entry` is not an error: the component
    # then has no process on this machine and is not the client's to run either —
    # it contributes what it carries (prompt, facts, data), and a component is not
    # required to be a tool (invariant I5).
    for word in component.retired:
        out.append(
            Diagnostic(
                component.name,
                "",
                f"a component still declares `{word}`, a word this host no longer reads: where a statement "
                f"runs is derived from what the declaration CONTRIBUTES (`service`/`launch` = a process on "
                f"this host, `entry` = the client's own module), so drop the word and declare the contribution",
            )
        )
    if component.entry and component.runs_here:
        which = "`service`" if component.resident else "`launch`"
        out.append(
            Diagnostic(
                component.name,
                "",
                f"a component declares `entry` and {which}: `entry` is the module the CLIENT runs for a "
                f"component with no process here, and {which} starts one on this host",
            )
        )
    for token in component.facts:
        if not _publishable(token):
            # Failure is only about the WORD: whether anyone answers it, and
            # whether exactly one does, is a question about the table
            # (diagnostics), because a supplier may be installed later.
            out.append(
                Diagnostic(
                    component.name,
                    "",
                    f"illegal fact {token!r}: a published host fact is a bare name ([a-z][a-z0-9_]*) and not "
                    f"a word this host already means ({_known(_reserved())})",
                )
            )
        elif component.resident:
            out.append(
                Diagnostic(
                    component.name,
                    "",
                    f"a component whose service answers cannot publish the host fact {token!r}: a service's "
                    f"statement belongs to one workspace, and a host fact belongs to none",
                )
            )
        elif component.client_side:
            out.append(
                Diagnostic(
                    component.name,
                    "",
                    f"a component whose statement is the client's cannot publish the host fact {token!r}: "
                    f"its statements run there, and a host fact is answered here",
                )
            )
    out.extend(settings_diagnostics(component))
    for spec in component.tools:
        declared = spec.parameters.get("properties", {}) if isinstance(spec.parameters, Mapping) else {}
        for key in component.vars:
            if key in declared:
                out.append(
                    Diagnostic(
                        component.name,
                        spec.name,
                        f"vars key {key!r} is also an argument of this tool: the host's value would shadow "
                        f"the model's, so rename one of them",
                    )
                )
        if spec.name in HOST_TOOL_NAMES:
            out.append(
                Diagnostic(
                    component.name,
                    spec.name,
                    f"tool name {spec.name!r} is the host's own (the host always offers it), so a component "
                    f"cannot publish it — rename this tool",
                )
            )
        if component.client_side and not spec.command:
            out.append(
                Diagnostic(
                    component.name,
                    spec.name,
                    "a tool of a component whose statements are the client's must carry a command: it IS the "
                    "statement the client declared, and a tool without one names nothing this host could ask "
                    "the client to run",
                )
            )
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
    # A fact is a question the host asks and exactly ONE component answers: two
    # suppliers would be two truth sources behind a name the model picks a value
    # from, and which one it reached would depend on table order. Whether anyone
    # answers, and whether one does, is a question about the TABLE and never about
    # one declaration — a supplier may be installed later — so it is asked here,
    # over the whole of it, and not in component_diagnostics.
    suppliers: dict[str, list[str]] = {}
    for component in known.values():
        for token in filter(_publishable, component.facts):
            suppliers.setdefault(token, []).append(component.name)
    for token, names in suppliers.items():
        if len(names) > 1:
            out.append(
                Diagnostic(
                    names[-1],
                    "",
                    f"host fact {token!r} is published by {_known(names)}: a fact has one supplier, or the host "
                    f"would ask whichever of them the table happened to name first",
                )
            )
    return out


@dataclass(frozen=True)
class Launch:
    """How this host STARTS one component process — the artifact's shape, never a
    kind named beside it.

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
    invocation contract (--workspace/--idle/--protect when it stays and publishes
    a service, --envelope when it answers one call and exits).
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
    placeholders `$config.<field>`, `$<fact>` for any fact a component publishes
    (catalog.published) and `$backends`, resolved by the registry from what only
    the host knows.

    `command` is the statement template `inst.render` fills — the part of the
    line that is the COMPONENT's own business, never how its process starts
    (that is `Component.launch`, which rendezvous renders from the artifact's
    shape). When the component declares a `service`, the statement is the whole
    line (the loopback call IS the statement); otherwise it is only the flags
    after the executable, so the same declaration drives a checkout under an
    interpreter and an installed onefile. `defaults` rides the payload UNDER the
    model's arguments.

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
    in. `gate` names a host-side condition that must hold — "project" (this
    session has a project log to read), or the name of a fact some component
    publishes, in which case the condition is "that fact has something in it"
    (registry._gate_ok, catalog.published) — and a shut gate means the tool is
    simply not offered, not offered-with-an-error.
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
class Service:
    """Where a component's service publishes what it is serving, and how the host
    finds it.

    A `service` block is the whole statement "this component's process STAYS": the
    host starts it once per workspace, reads `{port} {token} {pid}` off the record
    it publishes, and releases it when idle (rendezvous). A declaration without one
    is a line the host runs per call — its `launch` is then that line's prefix — or
    the client's, which this host never runs at all. PRESENCE, never a word about a
    kind, is what decides that, so "daemon" stops being something a manifest has to
    claim.

    `discovery_env` is the env var that repoints the directory (tests, parallel
    checkouts), `app_dir` the directory itself under %LOCALAPPDATA% (or
    `~/.<app_dir>` elsewhere), `prefix` the record's file-name prefix — the record's
    name carries a hash of the workspace it serves, so one directory holds them all.
    """

    discovery_env: str = ""
    app_dir: str = ""
    prefix: str = ""

    def directory(self) -> Path:
        """The directory this service publishes its records in.

        Keyed on the declaration, not on a workspace: a record's NAME carries the
        workspace (a hash of its root, see `record`), so listing the directory is
        how a caller learns which workspaces are being served without guessing
        roots — rendezvous.live_daemons is that caller.
        """
        override = os.environ.get(self.discovery_env)
        if override:
            return Path(override)
        local = os.environ.get("LOCALAPPDATA")
        return Path(local) / self.app_dir if local else Path.home() / f".{self.app_dir}"

    def record(self, root: str) -> Path:
        """The discovery file the service for workspace `root` publishes."""
        digest = hashlib.sha256(os.path.normcase(root).encode("utf-8")).hexdigest()[:32]
        return self.directory() / f"{self.prefix}{digest}.json"


@dataclass(frozen=True)
class Component:
    """A component's published coordinates (the host's side of R4).

    `name` is the component's identity: the install name of its artifact, and
    with it the directory name under this host's install root. Where its code
    is, is not a field — it is the version directory the install resolved to
    (rendezvous.resolve); a declaration has no say in it, so two declarations
    of one name cannot point at two directories.

    `subject` is whose resources it serves, and what it CONTRIBUTES is the whole
    answer to where its statements run — the declaration says that
    once and the three predicates below read it out: `service` present means the
    process STAYS and publishes the facts a statement needs (`launch` starts it),
    `launch` alone means one process per call here, and neither means no process
    here at all — the statement is the CLIENT's, and `entry` names the module that
    client runs. `vars` maps a statement placeholder to the host fact that fills
    it. `requires` names the host facilities it needs, so an unavailable component
    can say WHY instead of silently disappearing, and `ui` says how the user sees
    it.

    `prompt` is the fragment of model-facing prose the component carries for the
    system prompt (a file inside its own directory, like `launch.entry`): the
    words its own tools are called by, and how to use them together. See
    registry.prompt_section — the host writes no such word itself.

    `facts` maps a HOST fact this component PUBLISHES to the statement that
    answers it: `{"catalog": "--facts list"}`. It is the reverse of `vars` — there
    a component asks the host for something only the host knows, here it offers
    something only the component can compute (its own catalog, its own scan). The
    tokens are the DECLARATIONS' vocabulary (catalog.published) — the host keeps no
    list of its own — and so is the ANSWER SHAPE: one JSON array of `{"name",
    "description"}` on stdout, whatever the component's own `--json` contract looks
    like. One fact has one supplier. Only a component whose statement stands ALONE
    may publish one: a service's statements are spoken to one workspace, and a host
    fact belongs to none (see tools/facts.py).

    `settings` is the form this component lets a PERSON fill in — one entry per
    knob, `{"type", "default", "description", ...}` — drawn and stored by the host
    (tools/settings.py) from nothing but this declaration, the way an editor draws
    an extension's contributed configuration. The values come back to the component
    through the one interface it already has for host facts: a `vars` entry naming
    `host.settings` (statement.host_vars) is the path of the document holding them.
    """

    name: str
    # Retired declaration words this manifest still carries (RETIRED_WORDS). Kept
    # only so the refusal can name them back: nothing reads them for meaning.
    retired: tuple[str, ...] = ()
    subject: str = WORKSPACE_FS
    launch: Launch = Launch()
    # Presence = "this process stays and publishes what a statement names"; the
    # launch above then only starts it. None means the launch is the prefix of
    # every call instead (statement.py).
    service: Service | None = None
    # Presence = "no process on this host at all": the module the CLIENT runs for
    # each statement. The host never reads the file, only the name it refuses to
    # do without (component_diagnostics).
    entry: str = ""
    requires: tuple[str, ...] = ()
    vars: Mapping[str, str] = field(default_factory=dict)
    facts: Mapping[str, str] = field(default_factory=dict)  # host fact -> the statement that answers it
    settings: Mapping[str, Any] = field(default_factory=dict)  # the knobs this component lets a person set
    ui: Mapping[str, Any] = field(default_factory=dict)
    tools: tuple[Tool, ...] = ()
    prompt: str = ""  # fragment of model-facing prose, inside this component's directory

    @property
    def resident(self) -> bool:
        """A process that STAYS here and publishes what a statement names."""
        return self.service is not None

    @property
    def launch_declared(self) -> bool:
        """A process this host STARTS (per call, and to bring a service up)."""
        return bool(self.launch.argv or self.launch.entry or self.launch.binary or self.launch.importable)

    @property
    def runs_here(self) -> bool:
        """Some process of this component is this machine's to start."""
        return self.resident or self.launch_declared

    @property
    def client_side(self) -> bool:
        """No process here at all: nothing but the declaration crossed, so the
        statement is the client's to render and run (tools/statement.py Client)."""
        return not self.runs_here


# The words a declaration used to name its place with, before place became a
# derivation from what the component CONTRIBUTES. Nothing reads them; a manifest
# that still carries one is refused (component_diagnostics) instead of being read
# by a rule kept alive for old releases — one declaration, one reading.
RETIRED_WORDS: tuple[str, ...] = ("interface", "runs_on")


# --------------------------------------------- host facts a schema may ask for -


# The backends this host's own config can switch on for network search, in chain
# order, with the config field that enables each ("" = always available). This
# is a HOST fact — which knobs this machine's config has — not a declaration:
# any component may spend `$backends` in its schema text and the host renders
# what it knows, exactly as it does `$config.<field>` and any published fact.
#
# The chain the document may replace whole (a chain is ordered, so there is no
# key to merge on): `DEFAULT_BACKENDS` is the built-in one, `_BACKENDS` what the
# host really uses, and BACKEND_FIELDS is the `Config`'s own field list, read off
# the dataclass — a backend is switched on by the host's config, so a name no
# field can turn on is not a backend this host has.
DEFAULT_BACKENDS: tuple[hostconfig.Backend, ...] = (
    hostconfig.Backend("tavily", "tavily_api_key"),
    hostconfig.Backend("searxng", "searxng_url"),
    hostconfig.Backend("bing", ""),
    hostconfig.Backend("ddg", ""),
)
BACKEND_FIELDS = frozenset(f.name for f in fields(Config))
_BACKENDS = hostconfig.backends(DEFAULT_BACKENDS, BACKEND_FIELDS)


def available_backends(config) -> tuple[str, ...]:
    """The backends this machine has configured, in chain order (prompt text).
    An unconfigured service does not exist here — no name, no install advice."""
    return tuple(b.name for b in _BACKENDS if not b.field or getattr(config, b.field, ""))


# --------------------------------------------------------- registration -------


_LEGACY_SERVICE_KEYS = ("discovery_env", "app_dir", "prefix")


def _service_of(data: Mapping[str, Any]) -> Service | None:
    """The declaration's `service`, or None when it declares none.

    `service: {}` is a declaration too — the three fields have defaults, so the
    presence of the KEY decides, never its truthiness. The same three keys used to
    ride the top level of a manifest, and are still read from there: a release
    published before this host learned the word is still on someone's machine, and
    it keeps driving exactly as it did.
    """
    raw = data.get("service")
    if not isinstance(raw, Mapping):
        if not any(key in data for key in _LEGACY_SERVICE_KEYS):
            return None
        raw = data
    return Service(
        discovery_env=str(raw.get("discovery_env", "") or ""),
        app_dir=str(raw.get("app_dir", "") or ""),
        prefix=str(raw.get("prefix", "") or ""),
    )


def _component_of(data: Mapping[str, Any]) -> Component | None:
    """One declaration dict -> a Component, or None when it is not one.

    This is the protocol one declaration speaks: the manifest an install laid
    down in this host's install root. A declaration the host
    cannot drive AT ALL (nothing that could name it) is refused HERE rather than
    half-registered and mysteriously broken later; everything narrower than that
    (what the declaration contributes, and whether one machine could satisfy it)
    is component_diagnostics' business, because those refusals need the
    table's words to say something useful.
    """
    name = str(data.get("name", ""))
    if not name:
        return None
    launch = data.get("launch") if isinstance(data.get("launch"), dict) else {}
    tools: list[Tool] = []
    for raw in data.get("tools", []) or []:
        spec = tool_of(raw)
        if spec is not None:
            tools.append(spec)
    ui = data.get("ui") if isinstance(data.get("ui"), dict) else {}
    # A fact whose statement is empty or missing is NOT published: the key is a
    # promise to answer, and a blank line is not an answer (tools/facts.py reads
    # the absence as "this component publishes nothing of the sort").
    raw_facts = data.get("facts") if isinstance(data.get("facts"), Mapping) else {}
    return Component(
        name=name,
        retired=tuple(word for word in RETIRED_WORDS if word in data),
        subject=str(data.get("subject", WORKSPACE_FS)),
        launch=Launch(
            argv=tuple(str(w) for w in launch.get("argv", ()) or ()),
            entry=str(launch.get("entry", "") or ""),
            binary=str(launch.get("binary", "") or ""),
            importable=bool(launch.get("importable", False)),
        ),
        service=_service_of(data),
        entry=str(data.get("entry", "") or ""),
        requires=tuple(str(r) for r in data.get("requires", ()) or ()),
        vars={str(k): str(v) for k, v in (data.get("vars") or {}).items()},
        facts={str(k): str(v or "").strip() for k, v in raw_facts.items() if str(v or "").strip()},
        # A setting whose spec is not an object is kept as it stands — the
        # diagnostics say what is wrong with it (settings_diagnostics) and the
        # form skips it; dropping it here would hide the mistake from the author.
        settings={
            str(k): dict(v) if isinstance(v, Mapping) else v
            for k, v in (data.get("settings") if isinstance(data.get("settings"), Mapping) else {}).items()
        },
        ui=ui,
        tools=tuple(tools),
        prompt=str(data.get("prompt", "") or ""),
    )


def tool_of(raw: Any) -> Tool | None:
    """One tool declaration -> a Tool, or None when it names no usable tool.

    A description that is not text is a malformed tool, and the tool is refused:
    the spec says a description is the model-facing string, and
    a declaration the host cannot read as written is better absent than
    garbled.

    Public because the host's own declarations are parsed by it too
    (tools/host.py: the bootstrap exception, wired in registry._bootstrap) — one
    parser for every declaration there is, a manifest's and the host's alike."""
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


def installed_registrations() -> list[Mapping[str, Any]]:
    """The declarations of the components installed for THIS host, in install
    order.

    One pass over the install root (components.installed_records): the manifest
    that resolved a component's version directory IS its declaration, so it is
    read once and used for both jobs.
    """
    return [manifest for _name, _directory, manifest in components.installed_records()]


def registrations() -> list[Mapping[str, Any]]:
    """Every declaration this host knows: one per installed component.

    The install root is the only source (see the module docstring). There is no
    second registration of a name and therefore no order to get right: a name
    appears once, or not at all.
    """
    return installed_registrations()


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


def _version_dirs(component_dir: Path) -> tuple[str, ...]:
    """The version directories one component holds, by name.

    The signature needs these NAMES and cannot lean on the component directory's
    mtime for them: a filesystem is free not to move a directory's mtime when an
    entry inside it is removed (this one does not, for a rmdir), so "an install
    landed" or "the payload was pruned" would otherwise be invisible until the
    process restarted. Staging directories (`*.installing`) are left out — they
    are an install in flight, not a shape a registration is read from.
    """
    return tuple(
        entry.name
        for entry in _scan(component_dir)
        if entry.is_dir() and not entry.name.endswith(".installing")
    )


def source_signature() -> tuple:
    """What the one registration source looks like RIGHT NOW, cheaply.

    Only the SHAPE is read — the directories a registration is read FROM, and the
    version directories inside each component, by name — never a manifest, so a
    table built from them can be reused while nothing has changed. It covers
    everything the loader looks at: an install landing or a version being pruned
    (both change the version names, whichever way the filesystem treats the
    component directory's mtime) and the environment variable that repoints the
    root. Cheap enough to ask on every lookup, which is what makes the
    memoization safe rather than stale.

    Out of reach, deliberately: a file EDITED in place inside an installed
    component's version directory (a hand-patched manifest) moves no name and no
    directory mtime — `catalog.invalidate()` is how a caller says so.
    """
    install_root = components.root()
    installs = [
        (entry.name, _stamp(entry.path), _version_dirs(entry.path))
        for entry in _scan(install_root)
        if entry.is_dir() and entry.name != components.SCRATCH
    ]
    # A push over the client's channel is an ARRIVAL the disk will never show
    # (tools/channel.py keeps it in memory), and it changes the table as surely as
    # a manifest appearing does. Its generation is the shape of that source.
    from . import channel  # late: channel imports this module at import time

    return (
        str(install_root),
        tuple(installs),
        os.environ.get(components.ROOT_ENV, ""),
        channel.generation(),
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


def _build_table() -> dict[str, Component]:
    out: dict[str, Component] = {}
    for data in registrations():
        declared = _component_of(data)
        if declared is not None:
            out[declared.name] = declared
    # The client's push is a DIFFERENT machine's install, not a second
    # declaration of one of this host's: it describes a process the CLIENT runs,
    # with the fields read from the client's own manifest. So it is added to the
    # table whole and replaces a name outright — there is no field-level merge
    # between two machines, because a component is one install on one machine.
    from . import channel  # late: channel imports this module at import time

    for name, component in channel.declarations().items():
        out[name] = component
    return out


def table() -> dict[str, Component]:
    """The components this host may drive: one entry per install, plus what a
    client runs.

    There is no base catalog — a host with nothing installed drives nothing.
    Every name comes from ONE declaration of ONE installed component (see
    registrations()), so nothing is merged and nothing is shadowed: what is in
    the table is what this host holds, at the version it holds.

    The result is MEMOIZED on the shape of the source (source_signature): the
    table is the host's view of what is installed, and asking for it dozens of
    times in one turn must cost one scan, not dozens. Returned as a copy —
    callers keep it, nobody owns it.

    One entry is not an install here at all: the components the CLIENT says it
    runs, pushed over its channel (tools/channel.py). They are the client's own
    install — declared by the client's manifest, run by the client's code — and
    their arrival is part of the signature, so a push is picked up exactly like
    an install that landed."""
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
