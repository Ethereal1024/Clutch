"""The declaration table: discovery, merge, the UI protocol, the host's facts.

Run: .venv/bin/python -m tests.catalog_test

The host ships NO component (COMPONENTS.md): what it can drive is whatever its
three registration sources hold — a dev checkout beside the repo, an installed
artifact, a file in the user's catalog directory — merged by name, a later
source overriding only the fields it names. This suite pins that pipeline with
declarations it writes itself, plus the components this repo develops where the
fact is about what ships:

  * a bare host (no checkout, nothing installed, empty catalog) offers
    run_command and NOTHING else — there is no host-side implementation of any
    component's tool, so an absent component takes its tools with it;
  * a checkout is discovered by its manifest, and a manifest that names no
    component is not one;
  * merge precedence: an installed manifest refines the checkout's declaration
    field by field, and a catalog registration is the last word — where "refines"
    means "named means override", at every level (a field an empty list names is
    cleared, a launch is merged field by field);
  * how a tool looks in the UI is the component's declaration, read through one
    place (catalog.ui_of) and completed with the two facts only the host knows
    (registry.ui: `mutates`, `undo`) — a write declares its own folding diff
    block while a run of reads shares one dense group, and the renderer holds
    no tool name;
  * the host's facts ride the schema: `$config.<field>` / `$skills` /
    `$backends` in a declaration are resolved to THIS host's values when the
    tool is wired, and no placeholder leaks through;
  * access is a vocabulary the HOST defines: every declared access is one the
    permission engine knows.

Isolation: isolated_host() repoints the install root (CLUTCH_COMPONENTS_DIR),
the catalog directory (CLUTCH_COMPONENTS_CATALOG) and modules.repo_root at a
temp tree, so the run never touches the components installed for the user
running it.
"""

from __future__ import annotations

import contextlib
import json
import os
import stat
import tempfile
from collections.abc import Iterator, Mapping
from pathlib import Path

from agent.config import Config
from agent.core import permission
from agent.tools import catalog, components, modules, rendezvous
from agent.tools.localshell import local_shell
from agent.tools.registry import ToolRegistry, build_tools
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check

# ------------------------------------------------------------------ fixtures ---


@contextlib.contextmanager
def isolated_host(checkouts: Mapping[str, Mapping | None] | None = None) -> Iterator[Path]:
    """A host of one's own: temp install root and catalog, repo_root repointed
    at a temp tree holding `checkouts` (directory name -> manifest; None lays
    the directory down without one).

    Yields the temp root, for callers that need to put an artifact or a code
    directory somewhere the isolated host can see.
    """
    with tempfile.TemporaryDirectory() as root:
        saved = (
            os.environ.get(components.ROOT_ENV),
            os.environ.get("CLUTCH_COMPONENTS_CATALOG"),
            modules.repo_root,
        )
        base = Path(root) / "repo"
        base.mkdir()
        for name, data in (checkouts or {}).items():
            directory = base / name
            directory.mkdir()
            if data is not None:
                (directory / components.MANIFEST).write_text(json.dumps(data), encoding="utf-8")
        os.environ[components.ROOT_ENV] = root
        os.environ["CLUTCH_COMPONENTS_CATALOG"] = str(Path(root) / "catalog.d")
        modules.repo_root = lambda: base  # type: ignore[method-assign]
        try:
            yield Path(root)
        finally:
            modules.repo_root = saved[2]  # type: ignore[method-assign]
            for key, previous in ((components.ROOT_ENV, saved[0]), ("CLUTCH_COMPONENTS_CATALOG", saved[1])):
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous


def _write_registration(data: Mapping) -> None:
    """One registration in the (isolated) user's catalog directory."""
    directory = catalog.catalog_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{data['name']}.json").write_text(json.dumps(data), encoding="utf-8")


def _third_party(name: str, *, tool: str = "say_hello", directory: str = "") -> dict:
    """A component declared the way a third party writes one: its own tools,
    its own command template, its own UI block — and nothing the host named."""
    return {
        "name": name,
        "interface": "cli",
        "subject": "network",
        "directory": directory,
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


# --------------------------------------------------------------------- facts ---


def check_bare_host_is_chat_only() -> None:
    """Nothing registered -> the host's whole surface is its own command.

    The registry does not paper an absent component over: build_tools asks
    rendezvous whether the component is here, and a component that is not
    contributes no schema at all.
    """
    with isolated_host():
        check(catalog.table() == {}, "a host with no registrations drives nothing")
        check(
            [t.name for t in build_tools(Config())] == ["run_command"],
            "with no component installed the host offers only run_command",
        )
        check(not rendezvous.available(modules.WORKSPACE), "the workspace component is not available on a bare host")


def check_checkout_discovery_and_precedence() -> None:
    """A checkout is its own registration; an install refines it; a catalog
    file is the last word."""
    declaration = _third_party("clutch-x", tool="x_tool")
    with isolated_host(
        {
            "clutch-x": declaration,
            "clutch-nameless": {"interface": "cli"},  # a manifest that names nothing
        }
    ) as root:
        table = catalog.table()
        check("clutch-x" in table, "a checkout with a usable manifest enters the table")
        check("clutch-nameless" not in table, "a manifest that names no component is not a component")
        check(table["clutch-x"].subject == catalog.NETWORK, "the checkout declares its own subject")
        check(table["clutch-x"].tools[0].name == "x_tool", "the checkout's tools are the table's")

        # an install refines: a thin manifest names only the install facts, and
        # every field it leaves out carries over from the checkout
        artifact = root / "artifact"
        artifact.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        components.install(artifact, {"name": "clutch-x", "version": "9.9.9", "interface": "daemon"})
        merged = catalog.table()["clutch-x"]
        check(merged.interface == catalog.DAEMON, "the install's interface overrides the checkout's")
        check(merged.subject == catalog.NETWORK, "a field the install leaves out carries")
        check(merged.tools[0].name == "x_tool", "a thin install rides on the checkout's declaration")

        # a catalog registration is the last word, field by field
        _write_registration({**declaration, "interface": "cli", "subject": "workspace-fs"})
        final = catalog.table()["clutch-x"]
        check(
            final.interface == catalog.CLI and final.subject == catalog.WORKSPACE_FS,
            "a catalog registration overrides both earlier sources",
        )


def check_merge_is_named_means_override() -> None:
    """A later declaration overrides exactly the fields it NAMES, at every level.

    The rule used to be three rules in one function: some fields were read off
    the raw JSON, some off the parsed object, and `vars`/`ui` were deep-merged
    while everything else was replaced whole. Two consequences it could not
    express: a field could not be CLEARED (an empty list read as "not
    mentioned"), and `launch` could only be replaced whole (a thin manifest that
    knew the binary still had to restate the argv). Both are named here.
    """
    checkout = {
        "name": "clutch-m",
        "interface": "cli",
        "subject": "network",
        "launch": {"argv": ["{py}", "{script}"], "entry": "tool.py"},
        "requires": ["python", "curl"],
        "vars": {"base": "host.port_url", "token": "config.token"},
        "ui": {"label": "before", "status": True},
    }
    with isolated_host({"clutch-m": checkout}):
        _write_registration(
            {
                "name": "clutch-m",
                "requires": [],  # NAMED and empty: none, not "as before"
                "launch": {"binary": "clutch-m"},  # one launch field, not the whole shape
                "vars": {"token": "config.other"},  # named: the block, not a key-by-key merge
                "ui": {"label": "after"},  # named: the block whole, like every other field
            }
        )
        merged = catalog.table()["clutch-m"]
        check(merged.requires == (), "an empty list names the field and clears it")
        check(
            merged.launch.binary == "clutch-m" and merged.launch.argv == ("{py}", "{script}"),
            "launch refines field by field: the binary it names wins, the argv it does not carries",
        )
        check(merged.launch.entry == "tool.py", "and the entry the later manifest never mentions carries too")
        check(
            merged.interface == catalog.CLI and merged.subject == catalog.NETWORK,
            "a field the later declaration leaves out still carries",
        )
        check(merged.ui == {"label": "after"}, "ui is replaced whole, not deep-merged")
        check(merged.vars == {"token": "config.other"}, "vars is replaced whole too — one merge semantic")


def check_ui_protocol() -> None:
    """The tool's presentation is its declaration, with defaults filled in."""
    if modules.WORKSPACE not in catalog.table():
        print("SKIP: no clutch-workspace checkout beside the repo")
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
    if modules.MEMORY in catalog.table():
        plain = catalog.ui_of(_spec(modules.MEMORY, "save_memory"))
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


def check_declared_access() -> None:
    """What a call may touch is the access its own DECLARATION names.

    permission.evaluate/escaped_paths read the policy string a declaration carries
    (permission.GUARDED_ARG) and never the tool's name, so this one field is what
    puts a component's tool under the workspace's fence and the user's prompts.
    Both ends are checked here: the components this repo develops name the policy
    they need, and nothing names one the engine does not know.
    """
    if modules.WORKSPACE not in catalog.table():
        print("SKIP: no clutch-workspace checkout beside the repo")
        return
    for component, tool, access in (
        (modules.WORKSPACE, "read_file", "read"),
        (modules.WORKSPACE, "grep", "sweep"),
        (modules.WORKSPACE, "write_file", "write"),
        (modules.WORKSPACE, "edit_file", "write"),
        (modules.MEMORY, "load_memory", "read"),
    ):
        check(_spec(component, tool).access == access, f"{tool} declares the {access} policy")

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
            data = _third_party(name, tool=tool, directory=str(code))
            data["tools"][0].update(patch)
            _write_registration(data)

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

        data = _third_party("clutch-facility", tool="say_facility", directory=str(code))
        data["requires"] = ["python", "bash-frobnicator"]
        _write_registration(data)
        check("say_facility" not in offered("say_facility"), "an unknown facility takes the component's tools out")
        check(
            [d.fatal for d in diagnostic("clutch-facility", "")] == [True],
            "and the host names the facility it cannot stand on",
        )

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

            _write_registration(_third_party("clutch-late"))
            check("clutch-late" in catalog.table(), "a registration landing IS picked up, without an invalidate")
            check(scans["n"] == 1, "and it cost exactly one re-read")

            catalog.invalidate()
            catalog.table()
            check(scans["n"] == 2, "invalidate() makes the next lookup re-read")

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
        "interface": "cli",
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
        _write_registration({**declaration, "directory": str(code)})
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


def check_registration() -> None:
    """A declaration in the user's catalog directory becomes a live tool."""
    with isolated_host() as root:
        code = root / "hello-code"
        code.mkdir()
        (code / "tool.py").write_text(
            "import json, sys\nprint(json.dumps({'content': 'echo:' + sys.argv[-1], 'code': 0}))\n",
            encoding="utf-8",
        )
        _write_registration(_third_party("clutch-hello", directory=str(code)))

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
                "interface": "cli",
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
    check_table_is_memoized()
    check_bare_host_is_chat_only()
    check_checkout_discovery_and_precedence()
    check_merge_is_named_means_override()
    check_host_facts_in_schema()
    check_registration()
    check_installed_third_party()
    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
