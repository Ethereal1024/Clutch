"""The declaration table: one source, the UI protocol, the host's facts.

Run: .venv/bin/python -m tests.catalog_test

The host ships NO component and reads NO second place. What it can drive is what
its install root holds — one version directory per component, plus the table that
says this host holds it (tools/components.py) — and a declaration reaches the
table no other way. This suite pins that single path with declarations it installs
itself, plus the components this host holds where the fact is about what ships:

  * a bare host (nothing installed) offers run_command and NOTHING else — there
    is no host-side implementation of any component's tool, so an absent
    component takes its tools with it;
  * the one tool that is not a component's is declared like one all the same:
    run_command's name, prose, schema, policy word and UI block are data in the
    same vocabulary (tools/host.py), validated by the same diagnostics, and its
    name is vocabulary the catalog holds — a component that publishes it is
    refused rather than shadowing the tool the host's own policy is wired around;
  * one source, and one only: a component directory beside the host repo is not a
    declaration (a checkout is a place to BUILD an artifact from), and a
    manifest's own `directory` field has no say in where its code is — that is
    the version directory its install landed;
  * how a tool looks in the UI is the component's declaration, read through one
    place (catalog.ui_of) and completed with the two facts only the host knows
    (registry.ui: `mutates`, `undo`) — a write declares its own folding diff
    block while a run of reads shares one dense group, and the renderer holds
    no tool name;
  * the host's facts ride the schema: `$config.<field>` / `$skills` /
    `$backends` in a declaration are resolved to THIS host's values when the
    tool is wired, and no placeholder leaks through;
  * access is a vocabulary the HOST defines: every declared access is one the
    permission engine knows;
  * an argument reaches its tool in the shape its declaration declared (a
    spelling is converted, a wrong shape refused), and a `vars` key that would
    shadow an argument of the same name refuses the tool instead;
  * the argument host policy judges is the one the DECLARATION named: a
    component that calls its file argument `who` still enters the workspace's
    protection and still gets its undo record, so renaming an argument is not a
    way around the guard;
  * two components may declare one tool name — the registry is keyed by name, so
    the model is offered one schema and the later source answers, which is the
    deterministic answer this pins until the collision gets a voice (P1-7);
  * what the model is told about a component's tools travels with the component
    (audit 6): a `prompt` fragment inside its own directory reaches the system
    prompt only while that component is drivable, and the host's own prompt
    files name no tool that is not the host's.

Isolation: isolated_host() repoints the install root (CLUTCH_COMPONENTS_DIR) at a
temp directory and hands back a separate scratch directory, so nothing a check
writes for a fixture can be mistaken for a component, and the run never touches
the components installed for the user running it.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from agent.config import Config
from agent.core import permission
from agent.tools import catalog, components, facts, host, modules, registry, rendezvous
from agent.tools.envelope import Envelope
from agent.tools.localshell import local_shell
from agent.tools.registry import ToolRegistry, build_tools, prompt_section
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check

# ------------------------------------------------------------------ fixtures ---


@contextlib.contextmanager
def isolated_host() -> Iterator[Path]:
    """A host of one's own: a temp install root, and a scratch directory beside it.

    Yields the SCRATCH directory — where a check writes the code it wants a
    component to have, or an artifact to install — while the install root stays
    out of sight, exactly as a fresh host's would be. `_declare` is what puts a
    component into it.
    """
    with tempfile.TemporaryDirectory() as root:
        saved = os.environ.get(components.ROOT_ENV)
        os.environ[components.ROOT_ENV] = str(Path(root) / "components")
        try:
            yield Path(root)
        finally:
            if saved is None:
                os.environ.pop(components.ROOT_ENV, None)
            else:
                os.environ[components.ROOT_ENV] = saved
            catalog.invalidate()


def _declare(data: Mapping, *, code: Path | str | None = None, version: str = "1.0.0") -> Path:
    """Install ONE component for the isolated host, the way an artifact lands.

    A declaration with no install is nothing at all (catalog.registrations reads
    the install root and no other place), so a fixture that wants its declaration
    to be live lays down what the installer would: one version directory holding
    the manifest and the code the component runs — `code` is copied INTO it,
    because the version directory IS the component's directory — plus the table
    entry that says this host holds it. Answers that directory, for the checks
    that have to reach into the code they just installed.
    """
    name = str(data["name"])
    directory = components.root() / name / version
    directory.mkdir(parents=True, exist_ok=True)
    if code is not None:
        shutil.copytree(code, directory, dirs_exist_ok=True)
    declaration = {**data, "version": str(data.get("version", version))}
    (directory / components.MANIFEST).write_text(json.dumps(declaration), encoding="utf-8")
    components.reindex()  # the table learns what the disk now holds
    return directory


def _third_party(name: str, *, tool: str = "say_hello") -> dict:
    """A component declared the way a third party writes one: its own tools,
    its own command template, its own UI block — and nothing the host named."""
    return {
        "name": name,
        "subject": "network",
        "launch": {"argv": ["{py}", "{script}"], "entry": "tool.py"},
        "requires": ["python"],
        "ui": {"label": "hello", "status": True},
        "tools": [
            {
                "name": tool,
                "description": "say hello",
                "parameters": {"properties": {"who": {"type": "string"}}, "required": ["who"]},
                "command": "--envelope {who}",
                "ui": {"summary": "hello {who}", "group": "greet"},
            }
        ],
    }


def _spec(component: str, tool: str) -> catalog.Tool:
    """The declaration of one shipped tool, straight from the table."""
    mod = catalog.table()[component]
    for spec in mod.tools:
        if spec.name == tool:
            return spec
    raise AssertionError(f"{component} declares no {tool}")


@contextlib.contextmanager
def _reported() -> Iterator[list[catalog.Diagnostic]]:
    """What the host says about a declaration, collected for one check.

    The reports are said once per process (registry._REPORTED), so a check that
    wants to READ them swaps the sink instead of watching a log.
    """
    said: list[catalog.Diagnostic] = []
    real = registry._report
    registry._report = said.extend  # type: ignore[assignment]
    try:
        yield said
    finally:
        registry._report = real  # type: ignore[assignment]


def _answers(entries: list[tuple[str, str]] | None = None, *, payload: str = "", log: Path | None = None) -> str:
    """A component program that answers the host's fact question.

    One JSON array of `{"name", "description"}` on stdout — the host's own shape
    (tools/facts.py), which the answer below writes out verbatim; `payload`
    replaces it whole, for the answers that are NOT an answer. `log` makes the
    program record that it ran, which is how a check pins that a fact spent in
    three places still costs one process.
    """
    if not payload:
        payload = json.dumps([{"name": n, "description": d} for n, d in entries or []])
    record = "" if log is None else f"pathlib.Path({str(log)!r}).open('a').write('ran\\n')\n"
    return f"import pathlib\nimport sys\n{record}sys.stdout.write({payload!r})\n"


def _publisher(
    name: str,
    directory: Path,
    body: str,
    *,
    entry: str = "facts.py",
    tool: str = "load_thing",
    **extra: Any,
) -> dict:
    """A CLI component that PUBLISHES the `skills` host fact, plus one tool that
    spends it — the declaration the host asks, and the tool whose gate it answers.

    `body` is the component's own program: the host runs it, so it IS the answer
    the host gets (clutch-skills' `--facts` mode is the real one — see its own
    tests/test_cli.py). `extra` replaces any key of the declaration, which is how
    one check declares a bogus fact, an empty one or a daemon.
    """
    (directory / entry).write_text(body, encoding="utf-8")
    declaration: dict[str, Any] = {
        "name": name,
        "launch": {"argv": ["{py}", "{script}"], "entry": entry},
        "requires": ["python"],
        "facts": {"skills": "--facts list"},
        "tools": [
            {
                "name": tool,
                "description": "load one of $skills",
                "parameters": {
                    "properties": {
                        "name": {"type": "string", "enum": "$skills", "description": "one of $skills"},
                    },
                    "required": ["name"],
                },
                "gate": "skills",
                "command": "--envelope {name}",
            }
        ],
    }
    declaration.update(extra)
    _declare(declaration, code=directory)
    return declaration


# --------------------------------------------------------------------- facts ---


def check_the_host_declares_its_own_tool() -> None:
    """The one tool that is not a component's is declared like one all the same.

    `run_command` is the host's bootstrap exception (agent/tools/host.py): the
    host always has it, whatever is installed, so it cannot live in a component —
    the component that declared it could only be installed by first running a
    command. What makes it an exception rather than an accident is that it is
    DECLARED: its name, prose, schema, policy word and UI block are data in the
    same vocabulary a manifest's tool entry speaks (tools/host.py), parsed by the
    same parser and checked by the same diagnostics. And the vocabulary knows the
    name, so a component that publishes it is refused instead of shadowing the
    tool the user's Stop and the permission engine are wired around.
    """
    work, chat = Config(), Config(mode="chat")
    for config in (work, chat):
        for declared in host.declarations(config):
            spec = catalog.tool_of(declared.declaration)
            check(spec is not None, f"the host's own {declared.name} declaration parses as a tool")
            assert spec is not None
            check(
                catalog.tool_diagnostics(host.NAME, spec) == [],
                f"and names only words this host knows ({config.mode})",
            )
            check(
                declared.name in catalog.HOST_TOOL_NAMES,
                "every name the host declares for itself is in the vocabulary components are held to",
            )
    check(
        [d.name for d in host.declarations(work)] == [d.name for d in host.declarations(chat)],
        "the host's surface is the same in both modes",
    )
    check(
        host.declarations(work)[0].declaration["description"] != host.declarations(chat)[0].declaration["description"],
        "and only the prose it says about it is mode-picked (a different prompt file)",
    )

    with isolated_host() as root:
        code = root / "twin-code"
        code.mkdir()
        (code / "tool.py").write_text(
            "import json\nprint(json.dumps({'content': 'the component ran', 'code': 0}))\n", encoding="utf-8"
        )
        twin = _third_party("clutch-twin", tool="run_command")
        _declare(twin, code=code)

        declared = catalog.table()["clutch-twin"].tools[0]
        refusal = [d for d in catalog.component_diagnostics(catalog.table()["clutch-twin"]) if d.fatal]
        check(
            any(d.tool == declared.name and "host's own" in d.message for d in refusal),
            "a component publishing the host's own tool name is refused, with the reason",
        )

        config = Config()
        tools = build_tools(config)
        # the component is refused whole, so the only tools here are the host's own
        # — and with no project log open the two log readers are gated out, which
        # leaves the two command tools and the three the client answers
        check(
            [t.name for t in tools] == ["run_command", "trigger", "sleep", "start_tick", "end_tick"],
            "and it contributes nothing at all — not just no schema",
        )
        wired = tools[0]
        check(
            wired.host is not None and wired.module is None,
            "the run_command the model gets is the host's own implementation, never the component's statement",
        )
        ws = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-host-tool-"))
        result = ToolRegistry(tools).execute(ws, config, "run_command", {"command": "echo host-owns-this"})
        check(
            not result.error and "host-owns-this" in result.content,
            "and a call named run_command really runs the host's command",
        )


def check_bare_host_is_chat_only() -> None:
    """Nothing registered -> the host's whole surface is what it declares itself.

    The registry does not paper an absent component over: build_tools asks
    rendezvous whether the component is here, and a component that is not
    contributes no schema at all. What is left is the two command tools
    (run_command, trigger) and the three the CLIENT answers (sleep, start_tick,
    end_tick); the two log readers are gated out, because no project log is open.
    """
    with isolated_host():
        check(catalog.table() == {}, "a host with no registrations drives nothing")
        check(
            [t.name for t in build_tools(Config())] == ["run_command", "trigger", *host.client_native_names()],
            "with no component installed the host offers only its own tools",
        )
        check(not rendezvous.available(modules.WORKSPACE), "the workspace component is not available on a bare host")


def check_one_source_and_one_place_for_its_code() -> None:
    """An install is the only declaration, and it is also where the code is.

    Two things used to be spelled separately and are one thing now. A checkout
    beside the host repo registered itself, so what the host ran could be a
    working tree; and a manifest could carry a `directory` field, so a declaration
    had a say in where its code lived. Both are gone: the host reads the install
    root and nothing else, and a component's code is the version directory its
    install landed.
    """
    declaration = _third_party("clutch-x", tool="x_tool")
    with isolated_host() as root:
        # a checkout beside the host repo: a manifest and code, and nothing here
        # reads it — a checkout is a place to BUILD an artifact from
        checkout = root / "repo" / "clutch-x"
        checkout.mkdir(parents=True)
        (checkout / components.MANIFEST).write_text(
            json.dumps({**declaration, "version": "0.1.0"}), encoding="utf-8"
        )
        (checkout / "tool.py").write_text("print('[]')\n", encoding="utf-8")
        check("clutch-x" not in catalog.table(), "a checkout beside the repo is not a declaration")

        # the install IS the declaration and the code; a `directory` field in it
        # has no say in where that code is
        elsewhere = root / "elsewhere"
        elsewhere.mkdir()
        installed = _declare({**declaration, "directory": str(elsewhere)}, code=checkout)
        mod = catalog.table()["clutch-x"]
        check(mod.tools[0].name == "x_tool", "an installed declaration enters the table")
        check(mod.subject == catalog.NETWORK, "with the subject its own manifest names")
        resolved = rendezvous.resolve("clutch-x")
        check(
            resolved is not None and resolved.directory == installed,
            "and its code is the version directory the install landed, not a field's say-so",
        )
        check(rendezvous.available("clutch-x"), "so the component is drivable from there")
        check(
            catalog.registrations() == catalog.installed_registrations(),
            "the install root is the whole of what the table reads",
        )

        # a directory whose manifest names no component is not an install, table
        # or no table: read_manifest refuses it and the scan skips it
        nameless = components.root() / "clutch-nameless" / "1.0.0"
        nameless.mkdir(parents=True)
        (nameless / components.MANIFEST).write_text(json.dumps({"interface": "cli"}), encoding="utf-8")
        components.reindex()
        check(
            "clutch-nameless" not in catalog.table(),
            "a manifest that names no component is not one, whatever else it declares",
        )


def check_prompt_travels_with_the_declaration() -> None:
    """What the model is told about a component's tools is the component's own.

    The host's prompt names no tool it does not own (audit 6), so a component
    carries a `prompt` fragment inside its own directory and the host appends it
    to the system prompt while that component is drivable. Words and tools then
    arrive and leave together: a component that is absent, renamed or replaced by
    a third party cannot leave the prompt describing a tool the model cannot
    call. A fragment resolves like a tool description (the host's own facts are
    available in it), and one that cannot be read is said once — without taking
    the component's tools away, which still work.
    """
    with isolated_host() as root:
        code = root / "hello-code"
        code.mkdir()
        (code / "tool.py").write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        (code / "SAY.md").write_text(
            "## hello\n\nsay_hello is this component's, up to $config.read_max_chars chars.\n", encoding="utf-8"
        )
        declaration = _third_party("clutch-hello")
        declaration["prompt"] = "SAY.md"
        installed = _declare(declaration, code=code)

        cfg = Config()
        section = prompt_section(cfg)
        check(section.startswith("## hello"), "the declared fragment reaches the prompt section")
        check(
            str(cfg.read_max_chars) in section and "$config" not in section,
            "and the host's facts are resolved in it, exactly as in a tool description",
        )
        check("say_hello" in ToolRegistry(build_tools(cfg)).names(), "and names a tool that is really here")

        # a component the host cannot drive says nothing: the same filter that
        # withholds its tools withholds its words. No code at all is the plainest
        # case — the launch it names has nothing to start.
        gone = _third_party("clutch-gone", tool="gone_tool")
        gone["prompt"] = "SAY.md"
        _declare(gone)
        cfg = Config()
        check("gone_tool" not in [t.name for t in build_tools(cfg)], "a component with no code offers no tool")
        check(prompt_section(cfg) == section, "and adds nothing to the prompt either")

        # a fragment that cannot be read appends nothing, and is reported once
        # rather than refusing the component: its tools never needed the prose
        (installed / "SAY.md").unlink()
        reported: list[catalog.Diagnostic] = []
        real_report = registry._report
        registry._report = reported.extend  # type: ignore[assignment]
        try:
            check(prompt_section(cfg) == "", "an unreadable fragment appends nothing")
        finally:
            registry._report = real_report  # type: ignore[assignment]
        check(
            len(reported) == 1 and not reported[0].fatal and "SAY.md" in reported[0].message,
            "and the host names the file it could not read, once, without refusing anything",
        )
        check("say_hello" in ToolRegistry(build_tools(cfg)).names(), "the component's tools are untouched by it")


def check_host_prompt_names_no_component_tool() -> None:
    """The host's own prompt files name no tool a component owns (audit 6).

    A tool name written into ui/prompts/*.md is a promise about the surface
    THIS host happens to have installed, and it survives the component being
    absent, renamed or replaced — at which point the prompt tells the model about
    a tool it cannot call. The names belong in the components' own fragments
    (check_prompt_travels_with_the_declaration); `run_command` is the host's own
    tool, so it is the one tool name these files may carry. The skills catalog's
    header is no longer one of these files' either: audit 4 moved it to the
    component that serves the library, and it travels as that component's own
    fragment now (clutch-skills/PROMPT.md).
    """
    owned = {spec.name for mod in catalog.table().values() for spec in mod.tools}
    if not owned:
        print("SKIP: nothing installed for this host")
        return
    prompts = Path(__file__).resolve().parent.parent / "ui" / "prompts"
    for name in ("system.md", "mode_work.md", "mode_chat.md"):
        text = (prompts / name).read_text(encoding="utf-8")
        leaked = sorted(t for t in owned if re.search(rf"\b{re.escape(t)}\b", text))
        check(not leaked, f"the host's {name} names no component's tool (found {leaked})")


def check_host_prompt_offers_recall() -> None:
    """The host's workflow says WHEN to search the log, not only that it exists.

    The log readers are reachable only if the prompt asks for one at the moment
    the model plans: an anchor appended after the tool list states a fact ("there
    is a log"), and a fact at the end of a long prompt is not a trigger. This
    holds the two places that make it one — the numbered workflow step, and the
    anchor's own instruction — against a future edit that trims prose.

    Both names are the HOST's own tools (tools/host.py), so unlike a component's
    they are the host's to name here (check_host_prompt_names_no_component_tool).
    """
    prompts = Path(__file__).resolve().parent.parent / "ui" / "prompts"
    workflow = (prompts / "system.md").read_text(encoding="utf-8")
    check("grep_memory" in workflow, "the host's workflow names the log reader as a step")
    check("grep_memory" in workflow.split("2. ", 1)[0], "and that step comes before planning")
    anchor = (prompts / "recall.md").read_text(encoding="utf-8")
    check("grep_memory" in anchor and "read_memory" in anchor, "the recall anchor names both readers")
    check(
        re.search(r"no save tool|nothing to save", anchor) is not None,
        "and says there is nothing to save, which is the rule a deleted tool needs",
    )


def check_ui_protocol() -> None:
    """The tool's presentation is its declaration, with defaults filled in."""
    if modules.WORKSPACE not in catalog.table():
        print("SKIP: clutch-workspace is not installed for this host")
        return
    # a batch of reads: same group, folded body, no live preview
    read = catalog.ui_of(_spec(modules.WORKSPACE, "read_file"))
    grep = catalog.ui_of(_spec(modules.WORKSPACE, "grep"))
    check(read["group"] == grep["group"] == "read", "reads and greps share one dense group")
    check(read["collapse"] == "always" and read["preview"] == "none", "a read starts folded with no live preview")
    check(
        "{path}" in read["summary"] and "{lines}" in read["summary"],
        "the summary names its argument and the result's size",
    )
    # the call row keeps the tool's own name as its title; the row form is a
    # composition of parts — code body, path highlight — not a purpose word
    check(
        read["chip"] == catalog.DEFAULTS["chip"]
        and read["form"] == "row"
        and read["body"] == "code"
        and read["highlight"] == "path",
        "a read composes the row form: name chip, code body, path highlight",
    )
    check("style" not in read and "style" not in catalog.DEFAULTS, "the vocabulary has no purpose-word style key")

    # a write is its OWN row with its own block: it must not be swallowed by the
    # reads around it, and its diff is a folding block
    write = catalog.ui_of(_spec(modules.WORKSPACE, "write_file"))
    check(write["group"] is None, "a write declares no group: its result is its own block")
    check(write["body"] == "diff", "a write shows its diff")
    check(write["collapse"] == "long", "a long diff folds")
    check(
        write["chrome"] == "accent"
        and write["form"] == catalog.DEFAULTS["form"]
        and "{path}" in write["header"],
        "a write's own block wears accent chrome, titled by its declaration",
    )
    check(
        isinstance(write["preview"], dict) and write["preview"]["mode"] == "content",
        "a write previews the content it is streaming",
    )
    check(
        write["preview"]["keys"][0] == "✎path",
        "the preview marks the path it is writing",
    )

    # a tool the component did not describe gets the defaults, and every default
    # is a value the renderer understands: a row that is the tool's own name (the
    # chip) and no label, its arguments one click away, its result shown whole
    bare = catalog.Tool(name="bare", description="", parameters={})
    check(catalog.ui_of(bare) == catalog.DEFAULTS, "a tool with no ui block is rendered from the defaults alone")
    if modules.WEBSEARCH in catalog.table():
        plain = catalog.ui_of(_spec(modules.WEBSEARCH, "web_search"))
        check(
            plain["chip"] == "name" and plain["summary"] == "" and plain["preview"] == "args",
            "the plain row is the tool's own name, no label, its arguments streamed",
        )
        check(plain["body"] == "text" and plain["collapse"] == "never", "the default body is plain text, shown whole")
    # and a declaration overrides only the keys it names: an edit titles its own
    # block, while the chip and the label it says nothing about stay the protocol's
    # defaults (the tool's name on the left, no label beside it)
    edit = catalog.ui_of(_spec(modules.WORKSPACE, "edit_file"))
    check(
        edit["header"].startswith("✎")
        and edit["chip"] == catalog.DEFAULTS["chip"]
        and edit["summary"] == catalog.DEFAULTS["summary"],
        "a declaration overrides only the keys it names",
    )

    # the host completes the block with what only it knows. Needing a real
    # workspace daemon, this half is skipped where the component is absent.
    if not rendezvous.available(modules.WORKSPACE):
        print("SKIP: no clutch-workspace to resolve mutates/undo against")
        return
    reg = ToolRegistry(build_tools(Config()))
    check(
        reg.access("run_command") == "command" and reg.access("write_file") == "write",
        "the registry hands the loop the policy each declaration named",
    )
    check(reg.ui("write_file")["undo"] is True, "the host says it holds an undo record for a write")
    check(reg.ui("write_file")["mutates"] is True, "a write may change the file tree")
    check(reg.ui("read_file")["mutates"] is False and reg.ui("read_file")["undo"] is False, "a read changes nothing")
    check(reg.ui("run_command")["mutates"] is True, "the host's own command may change the tree")
    # a name this registry does not hold gets the defaults and nothing else: it
    # invented a `mutates` for a tool it cannot see, while the renderer already
    # reads an absent key as the same value (ui/src/renderer/app.ts UI_DEFAULTS)
    unknown = reg.ui("no_such_tool")
    check(unknown == {**catalog.DEFAULTS, "undo": False}, "an unknown tool gets the defaults alone")
    check("mutates" not in unknown, "and no `mutates` the host cannot derive")


def check_declared_access() -> None:
    """What a call may touch is the access its own DECLARATION names.

    permission.evaluate/escaped_paths read the policy string a declaration carries
    (permission.GUARDED_ARG) and never the tool's name, so this one field is what
    puts a component's tool under the workspace's fence and the user's prompts.
    Both ends are checked here: the components this repo develops name the policy
    they need, and nothing names one the engine does not know.
    """
    if modules.WORKSPACE not in catalog.table():
        print("SKIP: clutch-workspace is not installed for this host")
        return
    for component, tool, access in (
        (modules.WORKSPACE, "read_file", "read"),
        (modules.WORKSPACE, "grep", "sweep"),
        (modules.WORKSPACE, "write_file", "write"),
        (modules.WORKSPACE, "edit_file", "write"),
    ):
        check(_spec(component, tool).access == access, f"{tool} declares the {access} policy")
    if modules.WEBSEARCH in catalog.table():
        check(
            _spec(modules.WEBSEARCH, "web_search").access == "",
            "a tool that declares no access is left with none (no fence, no prompt)",
        )

    declared = {spec.access for mod in catalog.table().values() for spec in mod.tools}
    check(
        declared <= set(permission.GUARDED_ARG) | {""},
        f"every declared access is one the permission engine knows ({sorted(declared)})",
    )


def check_unknown_words_are_refused() -> None:
    """A host-defined word the host cannot read is refused, never guessed at.

    The direction is fail-CLOSED (COMPONENTS_REVIEW P0-2). An `access` this host
    does not know would leave the tool with NO policy — a tool the workspace's
    fence and the user's prompts do not cover, one typo away from the protection
    being gone — so the tool is withheld instead of offered half-read. The same
    goes for an `access_arg`/`snapshot_arg` naming an argument the tool does not
    declare: the policy would judge nothing. A cosmetic word (a `ui` key the
    renderer does not know) is reported WITHOUT taking the tool away — it works,
    it just looks plainer than its author meant.
    """
    with isolated_host() as root:
        code = root / "hello-code"
        code.mkdir()
        (code / "tool.py").write_text(
            "import json, sys\nprint(json.dumps({'content': 'echo:' + sys.argv[-1], 'code': 0}))\n",
            encoding="utf-8",
        )

        def register(name: str, tool: str, patch: Mapping) -> None:
            data = _third_party(name, tool=tool)
            data["tools"][0].update(patch)
            _declare(data, code=code)

        cfg = Config()

        def offered(name: str) -> list[str]:
            return [t.name for t in build_tools(cfg)]

        def diagnostic(component: str, tool: str) -> list[catalog.Diagnostic]:
            return [d for d in catalog.diagnostics() if d.component == component and d.tool == tool]

        register("clutch-typo-access", "say_access", {"access": "Read"})
        check("say_access" not in offered("say_access"), "a tool under an unknown access is not offered")
        check(
            [d.fatal for d in diagnostic("clutch-typo-access", "say_access")] == [True],
            "and the host names the word it could not read",
        )

        register("clutch-typo-gate", "say_gate", {"gate": "nomem"})
        check("say_gate" not in offered("say_gate"), "a tool under an unknown gate is not offered")

        register("clutch-typo-mode", "say_mode", {"modes": ["dream"]})
        check("say_mode" not in offered("say_mode"), "a tool offered in an unknown mode is not offered")

        register("clutch-typo-arg", "say_arg", {"access": "read", "access_arg": "file"})
        check("say_arg" not in offered("say_arg"), "an access_arg the tool does not declare is not offered")

        data = _third_party("clutch-facility", tool="say_facility")
        data["requires"] = ["python", "bash-frobnicator"]
        _declare(data, code=code)
        check("say_facility" not in offered("say_facility"), "an unknown facility takes the component's tools out")
        check(
            [d.fatal for d in diagnostic("clutch-facility", "")] == [True],
            "and the host names the facility it cannot stand on",
        )

        # a `vars` key that is also one of the tool's arguments: the host's value
        # shadows the model's when the statement renders, so the declaration is
        # refused rather than quietly dropping the argument the model passed
        data = _third_party("clutch-shadow", tool="say_shadow")
        data["vars"] = {"who": "host.port_url"}
        _declare(data, code=code)
        check("say_shadow" not in offered("say_shadow"), "a vars key that names an argument refuses the tool")
        check(
            [d.fatal for d in diagnostic("clutch-shadow", "say_shadow")] == [True],
            "and the host names the collision instead of shadowing with it",
        )

        data = _third_party("clutch-shadow-ok", tool="say_unshadowed")
        data["vars"] = {"root": "host.port_url"}
        _declare(data, code=code)
        check("say_unshadowed" in offered("say_unshadowed"), "a vars key no argument names is wired as before")

        # the accepted spellings, so the refusals above are about the WORD
        register("clutch-named-arg", "say_named", {"access": "write", "access_arg": "who"})
        reg = ToolRegistry(build_tools(cfg))
        check("say_named" in reg.names(), "an access_arg the tool DOES declare is wired")
        check(reg.access_arg("say_named") == "who", "and the policy judges that argument, not 'path'")
        check(reg.path_arg("say_named") == "who", "so a compaction re-reads the file it actually named")

        register("clutch-cosmetic", "say_looks", {"ui": {"summary": "hi {who}", "color": "red"}})
        check("say_looks" in offered("say_looks"), "a ui key the renderer does not know keeps the tool")
        check(
            [d.fatal for d in diagnostic("clutch-cosmetic", "say_looks")] == [False],
            "it is reported without refusing anything",
        )


def check_scalar_arguments_take_their_shape() -> None:
    """An argument reaches the tool in the shape its declaration declared.

    A model sometimes spells a number as a string, so the registry converts a
    value that spells the declared scalar and REFUSES one that does not — before
    any command is rendered, the same fail-closed stance the integer case always
    took (the invalid-arguments envelope names the argument and what it got),
    where passing the bad value on meant an opaque failure inside the tool. The
    declared shape is what decides, and a `type` the host has no rule for (a
    string, a list) passes through exactly as before.
    """
    seen: dict = {}

    def host(workspace, config, **args):  # a host tool: no component behind it
        seen.clear()
        seen.update(args)
        return Envelope("ok")

    shaped = registry.Tool(
        name="shaped",
        description="",
        parameters={
            "properties": {
                "n": {"type": "number"},
                "b": {"type": "boolean"},
                "i": {"type": "integer"},
                "s": {"type": "string"},
            }
        },
        host=host,
    )
    reg = ToolRegistry([shaped])
    cfg = Config()
    result = reg.execute(None, cfg, "shaped", {"n": "2.5", "b": "true", "i": "3", "s": 7})
    check(
        not result.error and seen == {"n": 2.5, "b": True, "i": 3, "s": 7},
        "a string that spells the declared scalar is converted, an unknown type is left alone",
    )
    check(reg.execute(None, cfg, "shaped", {"i": "3.5"}).error, "a spelling that is not the shape fails closed")
    check(reg.execute(None, cfg, "shaped", {"n": True}).error, "and a boolean is not a number")
    bad = reg.execute(None, cfg, "shaped", {"b": "yes"})
    check(bad.error and "b" in bad.content and "'yes'" in bad.content, "'yes' is not a boolean the host guesses")


def check_a_renamed_argument_is_still_policy() -> None:
    """Host policy follows the argument the declaration NAMED, never the word "path".

    The guard (filesystem._refuse_protected) and the per-file undo
    (registry._previous_content) are the host's own, and both ask the declaration
    which argument to judge (registry.access_arg / snapshot_arg). A component that
    calls the file it reads `who` must therefore still enter the workspace's
    protection and still get its undo record — otherwise P0-2's fail-open comes
    back as "rename the argument", and the one place that reads the resolved name
    is the one place that cannot be allowed to guess.
    """
    with isolated_host() as root:
        code = root / "renamed-code"
        code.mkdir()
        (code / "tool.py").write_text(
            "import json, pathlib, sys\n"
            "if '--write' in sys.argv:\n"
            "    pathlib.Path(sys.argv[-1]).write_text('new\\n', encoding='utf-8')\n"
            "print(json.dumps({'content': 'ok', 'code': 0}))\n",
            encoding="utf-8",
        )

        def register(name: str, tool: str, patch: Mapping) -> None:
            data = _third_party(name, tool=tool)
            data["tools"][0].update(patch)
            _declare(data, code=code)

        shape = {"parameters": {"properties": {"who": {"type": "string"}}, "required": ["who"]}}
        register("clutch-renamed", "peek", {**shape, "command": "--envelope {who}", "access": "read",
                                            "access_arg": "who"})
        register("clutch-renamed-write", "poke", {**shape, "command": "--write {who}", "access": "write",
                                                  "access_arg": "who", "snapshot": True, "snapshot_arg": "who"})
        cfg = Config()
        reg = ToolRegistry(build_tools(cfg))
        check(reg.access_arg("peek") == "who", "the declaration names the argument the policy judges")
        check(reg.access_arg("poke") == "who", "and the renamed argument rides the write policy too")
        if not local_shell().posix:
            print("SKIP: no POSIX shell to run the renamed-argument component")
            return
        ws = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-renamed-"))
        secret = Path(ws.root) / "school.clc"
        secret.write_text("secret\n", encoding="utf-8")
        ws.protect(secret)

        refused = reg.execute(ws, cfg, "peek", {"who": "school.clc"})
        check(
            refused.error and "protected" in refused.content,
            "a renamed path argument still enters the guard (no call reaches the component)",
        )

        note = Path(ws.root) / "note.txt"
        note.write_text("old\n", encoding="utf-8")
        wrote = reg.execute(ws, cfg, "poke", {"who": str(note)})
        check(not wrote.error and note.read_text(encoding="utf-8") == "new\n",
              "the declared write runs and lands the content it was told to")
        check(
            ws.restore(note) == "old\n",
            "and the host remembered the file the snapshot_arg name pointed at",
        )


def check_one_name_serves_one_tool() -> None:
    """Two components may declare one tool name; the model still sees exactly one.

    A tool name is what the model calls, so the registry holds one wiring per name
    ({t.name: t}, registry.py) — and which one wins is decided by the order the
    table is read in, which is the install root's own scan order (component names
    sorted, one version directory each). What is NOT there yet is a voice: the
    losing declaration disappears without a word, which is what
    COMPONENTS_REVIEW P1-7 asks for. This pins today's answer — the later entry
    wins, deterministically — so giving the collision a voice is a deliberate
    change with this test in the diff.
    """
    with isolated_host() as root:
        code = root / "dup-code"
        code.mkdir()
        (code / "tool.py").write_text(
            "import json\nprint(json.dumps({'content': 'x', 'code': 0}))\n", encoding="utf-8"
        )
        for name, word in (("clutch-first", "first"), ("clutch-second", "second")):
            data = _third_party(name, tool="dup")
            data["tools"][0]["command"] = f"--envelope {word}"
            _declare(data, code=code)  # the table's order is the install root's scan order
        cfg = Config()
        tools = build_tools(cfg)
        check([t.name for t in tools].count("dup") == 2, "both declarations are built (nothing is dropped here yet)")
        reg = ToolRegistry(tools)
        check(reg.names().count("dup") == 1, "the model is offered one schema for the name, never two")
        winner = reg.tool("dup")
        check(
            winner is not None and winner.module == "clutch-second",
            "and the source that comes later in the table is the one that answers",
        )


def check_table_is_memoized() -> None:
    """The table is the host's view of what is installed, so asking for it the
    dozen times a turn asks must cost one scan, not a dozen.

    The memo is keyed on the SHAPE of the sources (catalog.source_signature) and
    not on a timer: a source that appears, is pruned or is edited is picked up by
    the next lookup — nothing has to remember to invalidate — while a lookup that
    changes nothing re-reads nothing. Those two are the whole point, so both are
    pinned here.
    """
    with isolated_host():
        scans = {"n": 0}
        real = catalog.registrations

        def counted() -> list:
            scans["n"] += 1
            return real()

        catalog.registrations = counted  # type: ignore[assignment]
        try:
            check(catalog.table() == {}, "a host with no registrations has an empty table")
            scans["n"] = 0
            for _ in range(5):
                catalog.table()
            check(scans["n"] == 0, "a lookup that changes nothing re-reads nothing")

            _declare(_third_party("clutch-late"))
            check("clutch-late" in catalog.table(), "a registration landing IS picked up, without an invalidate")
            check(scans["n"] == 1, "and it cost exactly one re-read")

            # Pruning the version directory is the other half of the same promise
            # (and the one a directory mtime cannot be trusted for: this
            # filesystem does not move the parent's mtime on an rmdir). The
            # component directory stays, the payload is gone, so the table must
            # be re-read and the name must fall out of it.
            shutil.rmtree(components.root() / "clutch-late" / "1.0.0")
            check("clutch-late" not in catalog.table(), "a payload pruned out of its component directory is picked up too")
            check(scans["n"] == 2, "and that re-read costs one more")

            catalog.invalidate()
            catalog.table()
            check(scans["n"] == 3, "invalidate() makes the next lookup re-read")

            catalog.table()["clutch-scribble"] = None  # type: ignore[assignment]
            check("clutch-scribble" not in catalog.table(), "the memo is not scribbled on through a returned table")
        finally:
            catalog.registrations = real  # type: ignore[assignment]
            catalog.invalidate()


def check_host_facts_in_schema() -> None:
    """`$config.<field>` / `$skills` / `$backends` in a declaration become THIS
    host's values when the tool is wired — the component asks what only the
    host knows, and no placeholder leaks through."""
    declaration = {
        "name": "clutch-facts",
        "launch": {"argv": ["{py}", "{script}"], "entry": "tool.py"},
        "tools": [
            {
                "name": "fact_tool",
                "description": "reads up to $config.read_max_chars chars; backends: $backends; skills: $skills",
                "parameters": {
                    "properties": {"n": {"type": "integer", "description": "default $config.read_max_chars"}},
                    "required": ["n"],
                },
                "defaults": {"n": "$config.read_max_chars"},
                "command": "--n {n}",
            }
        ],
    }
    with isolated_host() as root:
        code = root / "facts-code"
        code.mkdir()
        (code / "tool.py").write_text("print('facts')\n", encoding="utf-8")  # resolve() wants the entry point
        _declare(declaration, code=code)
        cfg = Config()
        reg = ToolRegistry(build_tools(cfg))
        tool = reg.tool("fact_tool")
        check(tool is not None, "the registered tool is wired")
        check(
            str(cfg.read_max_chars) in tool.description and "$config" not in tool.description,
            "a $config placeholder becomes the host's value",
        )
        check(
            "bing" in tool.description and "$backends" not in tool.description,
            "the backends are this host's chain, spelled out",
        )
        check(tool.defaults.get("n") == cfg.read_max_chars, "a whole-value placeholder keeps the field's own type")
        check(
            "skills: none" in tool.description,
            "a published fact no component here answers reads as no value, never as a guess",
        )


def check_a_component_publishes_the_host_fact() -> None:
    """A host fact is ASKED of the component that publishes it — never scanned here.

    `$skills` used to be the host's own work: agent/skills.py walked a skills root
    the host configured itself, parsed frontmatter and rendered a section. That
    made the host the second implementation of a library the skills component
    already serves, and it had the host reading files that are the component's
    subject. The direction is reversed now (tools/facts.py): a component DECLARES
    the statement that answers a host fact (`facts: {"skills": ...}`), and the host
    asks that statement where it spends the fact — in a schema enum, in a sentence,
    in a prompt fragment, in a gate.

    What this check pins is that the three spendings read ONE answer, that the
    answer is the host's shape and not the component's own wire format, that
    every way of failing is fail-CLOSED (no value, the gate shuts, the fragment
    is dropped) and never silent, and that a library with nothing in it shuts the
    gate rather than offering an empty enum.
    """
    facts.forget()  # a library laid down out of band is not the last process's

    # one supplier: the enum, the sentence and the fragment all read its answer,
    # and a fact spent in three places still costs ONE process
    with isolated_host() as root:
        code = root / "pub-code"
        code.mkdir()
        (code / "PROMPT.md").write_text(
            "Available things (call load_thing to read one when relevant):\n$skills\n", encoding="utf-8"
        )
        log = root / "runs.log"
        _publisher(
            "clutch-pub",
            code,
            _answers([("alpha", "the first thing"), ("beta", "the second")], log=log),
            prompt="PROMPT.md",
        )
        cfg = Config()
        tool = ToolRegistry(build_tools(cfg)).tool("load_thing")
        check(tool is not None, "a gated tool whose fact a component answers is offered")
        assert tool is not None
        name = tool.parameters["properties"]["name"]
        check(name["enum"] == ["alpha", "beta"], "a whole-value fact becomes the enum the model picks from")
        check(
            name["description"] == "one of alpha, beta",
            "and the same fact inside a sentence reads as the names",
        )
        section = prompt_section(cfg)
        check(
            "- alpha: the first thing" in section and "- beta: the second" in section,
            "a LINE that is exactly the fact becomes one `- name: description` line per entry",
        )
        check("$skills" not in section and "$skills" not in tool.description, "with no placeholder left standing")
        check(
            log.read_text(encoding="utf-8").splitlines() == ["ran"],
            "and the component was run once for all three spendings (the answer is remembered per process)",
        )

    # an answered but EMPTY catalog is no value, not an empty enum: the gate shuts
    # and the fragment written around the fact is not appended — the tool it
    # describes is gone by the same condition
    with isolated_host() as root:
        code = root / "empty-code"
        code.mkdir()
        (code / "PROMPT.md").write_text("Available things:\n$skills\n", encoding="utf-8")
        _publisher("clutch-empty", code, _answers([]), prompt="PROMPT.md")
        cfg = Config()
        check("load_thing" not in ToolRegistry(build_tools(cfg)).names(), "an empty catalog shuts the gate")
        check(prompt_section(cfg) == "", "and the fragment written around the fact is dropped whole")

    # the component's OWN wire format is not an answer: `--json list` prints
    # {"root", "skills": [...]}, which is the component's contract with its own
    # callers — the host asked a question in ITS shape and reads an answer in it
    with isolated_host() as root:
        code = root / "wire-code"
        code.mkdir()
        own = json.dumps({"root": "/somewhere", "skills": [{"name": "alpha", "description": "d", "dir": "/x"}]})
        _publisher("clutch-wire", code, _answers(payload=own))
        cfg = Config()
        with _reported() as said:
            check(
                "load_thing" not in [t.name for t in build_tools(cfg)],
                "an answer in the component's own wire shape is not an answer",
            )
        check(
            any("not a JSON array" in d.message for d in said),
            "and the host says so in its own words, rather than reading a shape it did not ask for",
        )

    # a failed answer is fail-closed with the COMPONENT's reason: a library that
    # cannot be read is something the user has to see, never an empty catalog
    with isolated_host() as root:
        code = root / "fail-code"
        code.mkdir()
        _publisher(
            "clutch-fail",
            code,
            _answers([]) + "sys.stderr.write('the library is unreadable\\n')\nsys.exit(3)\n",
        )
        cfg = Config()
        with _reported() as said:
            check("load_thing" not in ToolRegistry(build_tools(cfg)).names(), "an answer that failed shuts the gate")
        check(
            any("the library is unreadable" in d.message and "exit 3" in d.message for d in said),
            "and the component's own reason is what the host says",
        )

    # two suppliers of one token: neither answers, and the host names both rather
    # than choosing one. Picking a library for the model is how two sources of
    # truth for one name start
    with isolated_host() as root:
        for name, tool in (("clutch-a", "load_a"), ("clutch-b", "load_b")):
            directory = root / f"{name}-code"
            directory.mkdir()
            _publisher(name, directory, _answers([("alpha", "d")]), entry=f"{name}.py", tool=tool)
        cfg = Config()
        with _reported() as said:
            offered = [t.name for t in build_tools(cfg)]
        check("load_a" not in offered and "load_b" not in offered, "two suppliers of one fact answer nothing at all")
        check(
            any("clutch-a" in d.message and "clutch-b" in d.message and "both publish it" in d.message for d in said),
            "and the host says which two, instead of quietly serving one of them",
        )

    # a word the host already MEANS is not a component's to publish: `project` is a
    # gate this host honors, so a fact of that name would leave the gate reading two
    # ways depending on who answered. So is a fact declared by a component that
    # cannot answer one (a daemon's statement belongs to one workspace, and a host
    # fact belongs to none)
    with isolated_host() as root:
        code = root / "bogus-code"
        code.mkdir()
        _publisher("clutch-bogus", code, _answers([("alpha", "d")]), facts={"project": "--facts list"})
        messages = [d.message for d in catalog.diagnostics()]
        check(
            any(d.fatal and "illegal fact 'project'" in d.message for d in catalog.diagnostics() if d.tool == ""),
            f"a fact token the host already means is refused ({messages})",
        )
        check("load_thing" not in [t.name for t in build_tools(Config())], "and the component contributes nothing")

        daemon = root / "daemon-code"
        daemon.mkdir()
        (daemon / "tool.py").write_text("print('[]')\n", encoding="utf-8")
        _declare(
            {
                "name": "clutch-daemon",
                "service": {},  # where its record would go: the home directory
                "facts": {"skills": "--envelope list"},
                "tools": [],
            },
            code=daemon,
        )
        check(
            any(d.fatal and "cannot publish the host fact" in d.message for d in catalog.diagnostics()),
            "and a daemon declaring one is refused too: only a CLI's statement runs outside a workspace",
        )
    facts.forget()


def check_registration() -> None:
    """A component installed for this host becomes a live tool."""
    with isolated_host() as root:
        code = root / "hello-code"
        code.mkdir()
        (code / "tool.py").write_text(
            "import json, sys\nprint(json.dumps({'content': 'echo:' + sys.argv[-1], 'code': 0}))\n",
            encoding="utf-8",
        )
        _declare(_third_party("clutch-hello"), code=code)

        check("clutch-hello" in catalog.table(), "a registration with a new name enters the table")
        check(rendezvous.unavailable_reason("clutch-hello") == "", "and is available through its own directory")
        cfg = Config()
        check("say_hello" in [t.name for t in build_tools(cfg)], "its tools are offered to the model")
        reg = ToolRegistry(build_tools(cfg))
        ui = reg.ui("say_hello")
        check(ui["group"] == "greet" and ui["summary"] == "hello {who}", "its ui block rides the protocol")
        check(ui["mutates"] is False and ui["undo"] is False, "the host derives the keys it did not declare")
        if local_shell().posix:
            ws = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-catalog-"))
            result = reg.execute(ws, cfg, "say_hello", {"who": "世界"})
            check(not result.error and result.content == "echo:世界", "and the tool is executable end to end")

        # What a declaration CONTRIBUTES is where its statement runs:
        # no `service` and no `launch` means no process here, so its statements are
        # the CLIENT's and `entry` names the module that client runs. The one wrong
        # answer — running it here because a word beside it was read as a kind —
        # would search the wrong network from the wrong machine and look like a
        # success, so the refusal is a sentence.
        elsewhere = _third_party("clutch-elsewhere", tool="say_elsewhere")
        del elsewhere["launch"]
        elsewhere["entry"] = "index.js"
        _declare(elsewhere, code=code)
        check(
            "runs on the client" in rendezvous.unavailable_reason("clutch-elsewhere"),
            "a declaration with no process here says this host has no channel to that client, "
            "instead of running it locally",
        )
        check(
            "say_elsewhere" not in [t.name for t in build_tools(Config())],
            "and its tools never reach the model (fail closed, not fail silently-local)",
        )

        # the contradiction is `entry` BESIDE a process here: one declaration
        # speaking two languages, refused rather than half-read
        both = _third_party("clutch-both", tool="say_both")
        both["entry"] = "index.js"
        _declare(both, code=code)
        fatal = [d.message for d in catalog.diagnostics() if d.fatal]
        check(
            any("declares `entry` and `launch`" in message for message in fatal),
            "a declaration naming `entry` and a `launch` is fatal: the client's module beside a process here",
        )
        check(
            "say_both" not in [t.name for t in build_tools(Config())],
            "and the component behind the contradiction contributes nothing",
        )

        # the retired words are REFUSED, not read: `interface`/`runs_on` say what
        # a contribution already says, and this host keeps one reading of a
        # declaration (invariant I3 — no second path, not even for an old release)
        legacy = _third_party("clutch-legacy", tool="say_legacy")
        legacy.update({"interface": "cli", "runs_on": "self"})
        _declare(legacy, code=code)
        check(
            "say_legacy" not in [t.name for t in build_tools(Config())],
            "a manifest still carrying `interface`/`runs_on` contributes nothing",
        )
        named = [d.message for d in catalog.diagnostics() if d.component == "clutch-legacy"]
        check(
            any("still declares `interface`" in message for message in named)
            and any("still declares `runs_on`" in message for message in named),
            "and the refusal names BOTH retired words back, instead of ignoring them",
        )
        check(
            all(d.fatal for d in catalog.diagnostics() if d.component == "clutch-legacy"),
            "the refusal is fatal: there is no half-read of a declaration this host cannot place",
        )


def check_installed_third_party() -> None:
    """An artifact the install layer lands registers itself too — the same path
    an installed SHIPPED component takes, with tools the host never declared."""
    with isolated_host() as root:
        artifact = root / "incoming"
        artifact.write_text(
            "#!/usr/bin/env python3\nimport json, sys\n"
            "print(json.dumps({'content': 'installed:' + sys.argv[-1], 'code': 0}))\n",
            encoding="utf-8",
        )
        artifact.chmod(artifact.stat().st_mode | stat.S_IEXEC)
        components.install(
            artifact,
            {
                "name": "clutch-thirdparty",
                "version": "1.0.0",
                "launch": {"binary": "clutch-thirdparty"},
                "tools": [
                    {
                        "name": "installed_tool",
                        "description": "a tool from an installed artifact",
                        "parameters": {"properties": {"q": {"type": "string"}}, "required": ["q"]},
                        "command": "--envelope {q}",
                    }
                ],
            },
        )
        check("clutch-thirdparty" in catalog.table(), "an installed artifact enters the table")
        check(rendezvous.available("clutch-thirdparty"), "and resolves to the code the install laid down")
        cfg = Config()
        check("installed_tool" in [t.name for t in build_tools(cfg)], "its declared tool joins the model's set")
        if local_shell().posix:
            reg = ToolRegistry(build_tools(cfg))
            ws = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-catalog-"))
            result = reg.execute(ws, cfg, "installed_tool", {"q": "hi"})
            check(
                not result.error and result.content == "installed:hi",
                "the installed tool runs its own executable",
            )


def main() -> int:
    check_ui_protocol()
    check_declared_access()
    check_unknown_words_are_refused()
    check_scalar_arguments_take_their_shape()
    check_a_renamed_argument_is_still_policy()
    check_one_name_serves_one_tool()
    check_table_is_memoized()
    check_the_host_declares_its_own_tool()
    check_bare_host_is_chat_only()
    check_one_source_and_one_place_for_its_code()
    check_prompt_travels_with_the_declaration()
    check_host_prompt_names_no_component_tool()
    check_host_prompt_offers_recall()
    check_host_facts_in_schema()
    check_a_component_publishes_the_host_fact()
    check_registration()
    check_installed_third_party()
    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
