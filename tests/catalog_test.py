"""The component declaration: the UI protocol, and a user's own components.

Run: .venv/bin/python -m tests.catalog_test

Three facts this suite pins, all of them the point of the declaration table:

  * with nothing installed the host offers NO tool but its own command — there
    is no host-side implementation of a component's tool, so an absent component
    takes its tools with it (the "chat only" surface);
  * how a tool looks in the UI is the COMPONENT's declaration, read through one
    place (catalog.ui_of) and completed with the two facts only the host knows
    (registry.ui: `mutates`, `undo`) — so a write declares its own folding diff
    block while a run of reads shares one dense group, and the renderer holds no
    tool name;
  * a THIRD-PARTY component registers itself: a declaration dropped in the user's
    catalog directory, or an artifact the install layer lands, enters the table
    with its own tools and is executable end to end.

Isolation: CLUTCH_COMPONENTS_DIR / CLUTCH_COMPONENTS_CATALOG point at a temp
root, so the run never touches the components installed for the user running it.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

from agent.config import Config
from agent.core import permission
from agent.tools import catalog, components, modules, rendezvous
from agent.tools.localshell import local_shell
from agent.tools.registry import ToolRegistry, build_tools
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check


def _spec(component: str, tool: str) -> catalog.Tool:
    """The declaration of one shipped tool, straight from the table."""
    mod = catalog.table()[component]
    for spec in mod.tools:
        if spec.name == tool:
            return spec
    raise AssertionError(f"{component} declares no {tool}")


def check_no_components_is_chat_only() -> None:
    """Nothing installed -> the host's whole surface is its own command.

    The registry does not paper an absent component over: build_tools asks
    rendezvous whether the component is here, and a component that is not
    contributes no schema at all. Point resolution at a bare host and the tool
    table is run_command and nothing else.
    """
    cfg = Config()
    with tempfile.TemporaryDirectory() as bare:
        previous = os.environ.get(components.ROOT_ENV)
        real_dir = modules.module_dir
        os.environ[components.ROOT_ENV] = bare
        modules.module_dir = lambda name: Path(bare) / name  # no checkout either
        try:
            names = [t.name for t in build_tools(cfg)]
            check(names == ["run_command"], "with no component installed the host offers only run_command")
            check(
                not rendezvous.available(modules.WORKSPACE),
                "the workspace component is not available on a bare host",
            )
        finally:
            modules.module_dir = real_dir
            if previous is None:
                os.environ.pop(components.ROOT_ENV, None)
            else:
                os.environ[components.ROOT_ENV] = previous


def check_ui_protocol() -> None:
    """The tool's presentation is its declaration, with defaults filled in."""
    # a batch of reads: same group, folded body, no live preview
    read = catalog.ui_of(_spec(modules.WORKSPACE, "read_file"))
    grep = catalog.ui_of(_spec(modules.WORKSPACE, "grep"))
    check(read["group"] == grep["group"] == "read", "reads and greps share one dense group")
    check(read["collapse"] == "always" and read["preview"] == "none", "a read starts folded with no live preview")
    check(
        "{path}" in read["summary"] and "{lines}" in read["summary"],
        "the summary names its argument and the result's size",
    )
    # its summary already says what the call is, so the row does not repeat the
    # tool's own name beside it
    check(read["chip"] == "none" and read["style"] == "read", "a read declares no chip and an exploration style")

    # a write is its OWN row with its own block: it must not be swallowed by the
    # reads around it, and its diff is a folding block
    write = catalog.ui_of(_spec(modules.WORKSPACE, "write_file"))
    check(write["group"] is None, "a write declares no group: its result is its own block")
    check(write["body"] == "diff", "a write shows its diff")
    check(write["collapse"] == "long", "a long diff folds")
    check(
        write["style"] == "write" and "{path}" in write["header"],
        "a write's own block is chromed as a change, titled by its declaration",
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
    puts a component's tool under the workspace's fence and the user's prompts. A
    value outside the vocabulary is silently unguarded — hence both ends here: the
    shipped tools name the policy they need, and nothing names one the engine does
    not know.
    """
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


def _declaration(directory: Path, *, tool: str) -> dict:
    """A third-party CLI component, declared the way a user writes one: its own
    tools, its own command template, and its own UI block."""
    return {
        "name": "clutch-hello",
        "interface": "cli",
        "subject": "network",
        "directory": str(directory),
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


def check_registration() -> None:
    """A declaration in the user's catalog directory becomes a live tool."""
    with tempfile.TemporaryDirectory() as root:
        previous_root = os.environ.get(components.ROOT_ENV)
        previous_cat = os.environ.get("CLUTCH_COMPONENTS_CATALOG")
        cat = Path(root) / "catalog.d"
        cat.mkdir()
        code = Path(root) / "hello-code"
        code.mkdir()
        (code / "tool.py").write_text(
            "import json, sys\nprint(json.dumps({'content': 'echo:' + sys.argv[-1], 'code': 0}))\n",
            encoding="utf-8",
        )
        (cat / "hello.json").write_text(json.dumps(_declaration(code, tool="say_hello")), encoding="utf-8")

        os.environ[components.ROOT_ENV] = root
        os.environ["CLUTCH_COMPONENTS_CATALOG"] = str(cat)
        try:
            check("clutch-hello" in catalog.table(), "a registration with a new name enters the table")
            check(rendezvous.unavailable_reason("clutch-hello") == "", "and is available through its own directory")
            cfg = Config()
            names = [t.name for t in build_tools(cfg)]
            check("say_hello" in names, "its tools are offered to the model")
            reg = ToolRegistry(build_tools(cfg))
            ui = reg.ui("say_hello")
            check(ui["group"] == "greet" and ui["summary"] == "hello {who}", "its ui block rides the protocol")
            check(ui["mutates"] is False and ui["undo"] is False, "the host derives the keys it did not declare")
            if local_shell().posix:
                ws = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-catalog-"))
                result = reg.execute(ws, cfg, "say_hello", {"who": "世界"})
                check(not result["error"] and result["content"] == "echo:世界", "and the tool is executable end to end")
        finally:
            if previous_cat is None:
                os.environ.pop("CLUTCH_COMPONENTS_CATALOG", None)
            else:
                os.environ["CLUTCH_COMPONENTS_CATALOG"] = previous_cat
            if previous_root is None:
                os.environ.pop(components.ROOT_ENV, None)
            else:
                os.environ[components.ROOT_ENV] = previous_root


def check_installed_third_party() -> None:
    """An artifact the install layer lands registers itself too — the same path
    an installed SHIPPED component takes, with tools the host never declared."""
    with tempfile.TemporaryDirectory() as root:
        previous_root = os.environ.get(components.ROOT_ENV)
        previous_cat = os.environ.get("CLUTCH_COMPONENTS_CATALOG")
        os.environ[components.ROOT_ENV] = root
        os.environ["CLUTCH_COMPONENTS_CATALOG"] = str(Path(root) / "catalog.d")  # empty
        try:
            artifact = Path(root) / "incoming"
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
                    not result["error"] and result["content"] == "installed:hi",
                    "the installed tool runs its own executable",
                )
        finally:
            if previous_cat is None:
                os.environ.pop("CLUTCH_COMPONENTS_CATALOG", None)
            else:
                os.environ["CLUTCH_COMPONENTS_CATALOG"] = previous_cat
            if previous_root is None:
                os.environ.pop(components.ROOT_ENV, None)
            else:
                os.environ[components.ROOT_ENV] = previous_root


def main() -> int:
    check_ui_protocol()
    check_declared_access()
    check_no_components_is_chat_only()
    check_registration()
    check_installed_third_party()
    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
