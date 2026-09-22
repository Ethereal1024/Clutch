"""Declarative tool registry.

Single source of truth: one Tool definition yields both the OpenAI function-calling
schema and the local execution entry. Tool descriptions live here as schema data;
error texts live in agent/prompts/.
"""

from __future__ import annotations

import inspect
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable

from ..config import Config
from ..memory import MemoryStore
from ..prompts import render
from ..skills import cached_library
from . import filesystem, inst, modules, rendezvous, shell, websearch
from .inst import InstError
from .transport import TransportError, failure_envelope
from .workspace import LocalWorkspace, Workspace

# (workspace, config, **args) -> dict{content, error?}
ToolImpl = Callable[..., dict[str, Any]]
# (workspace, config, args) -> dict{content, error?} | None -- a refusal, or None to proceed
GuardImpl = Callable[[Workspace, Config, dict[str, Any]], dict[str, Any] | None]


@dataclass
class Tool:
    """One tool: the statement that satisfies a call, plus the host's own take.

    `inst` is the terminal command a call becomes (tools/inst.py): placeholders
    filled from the model's arguments, run through the workspace's transport,
    its output unwrapped back into the {content, error, diff} envelope. A
    statement that drives a standalone module's service names it in `module`,
    and that path is taken only while the module is actually there — R2 of the
    tool constitution: a deleted module degrades to `func`, the host's own
    implementation, instead of taking the host down with it.

    `guard` is host policy a module deliberately does not carry: the workspace
    module's fence refuses mutations and hides broad sweeps but still serves a
    path named explicitly, while the project's .clc must stay unreadable even
    then (see filesystem._refuse_protected). `defaults` rides the statement
    payload UNDER the model's own arguments: an argument the model left out
    gets the host's default instead of a hole in the request.

    `snapshot` marks the statements that OVERWRITE the file named in their
    `path` argument. The module that performs such a write keeps its own undo
    stack (the daemon's /undo pops its newest write, for its CLI), but the
    per-file "undo" the UI offers on a change result is served by THIS process
    — so the content the write is about to replace is recorded here too,
    exactly as the host's in-process implementation records it (and, like that
    implementation, only for a write that actually happened).
    """

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema (properties + required)
    func: ToolImpl | None = None  # the host's own implementation (fallback)
    inst: str | None = None  # the terminal statement (module-served path)
    module: str | None = None  # which standalone module serves the statement
    guard: GuardImpl | None = None  # host policy the module does not make
    defaults: Mapping[str, Any] | None = None  # statement payload defaults
    snapshot: bool = False  # the statement overwrites args["path"]

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


def _daemon(command: str) -> str:
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
        f"-H {{auth}} --data-binary {{*}} -w {{status}} http://127.0.0.1:{{port}}{command}"
    )


_READ_FILE = _daemon("/read_file")
_GREP = _daemon("/grep")
_WRITE_FILE = _daemon("/write_file")
_EDIT_FILE = _daemon("/edit_file")

# A CLI module is one process per call, driven on the APP host (its subject is
# the project file / the network / the skill library, never the workspace's
# machine), so its line names the interpreter and the module's own entry point.
# `--envelope` asks for the host's {content, code} object instead of the
# module's own machine output; a package module needs its checkout on
# PYTHONPATH. The module owns its flags — the host only knows the line (R4).
_MEMORY_CLI = "{py} {script} --endpoint {base} --envelope"
_WEBSEARCH_CLI = "{py} {script}"
_SKILLS_CLI = "PYTHONPATH={dir} {py} -m clutch_skills --envelope"


def module_ready(workspace: Workspace, module: str | None) -> bool:
    """True when this host can actually run `module`'s statements for this call.

    Three facts, all local: the module is on disk and drivable
    (`rendezvous.available` — R2's star acceptance: a deleted module degrades
    the call, never the host); a DAEMON module additionally needs a LOCAL
    workspace, because it serves the filesystem of the machine it runs on (a
    remote workspace keeps the host's transport-based implementation, which
    speaks to the remote side over the SSH bridge); a CLI module runs on the
    APP host whatever kind of workspace the call came from — its subject is the
    project file / the network / the skill library, never the workspace's
    machine.
    """
    if module is None or not rendezvous.available(module):
        return False
    return not rendezvous.is_local(module) or isinstance(workspace, LocalWorkspace)


def _previous_content(workspace: Workspace, args: dict[str, Any]) -> tuple[Any, str] | None:
    """(resolved path, content) of the file a module-served write is about to
    replace — the host's own undo bookkeeping for the statement path.

    The module performs the write, and its daemon keeps its own undo stack (the
    /undo its CLI pops: the newest write, whoever made it). The per-file revert
    the UI offers on a change result is answered by THIS process, so the content
    the write is about to replace has to be recorded here too, exactly as
    filesystem.write_file/edit_file record it when they do the writing. None
    means there is nothing to remember: a file that does not exist yet has no
    previous content, and the host's own implementation does not remember it
    either (a creation is not a change the UI can revert)."""
    try:
        p = workspace.resolve(str(args.get("path", "")))
        old = workspace.read(str(p))
    except (OSError, ValueError):
        return None
    return (p, old) if old else None





def _str_param(desc: str) -> dict[str, Any]:
    return {"type": "string", "description": desc}


def build_default_tools(config: Config, memories: MemoryStore | None = None) -> list[Tool]:
    chat_mode = config.mode == "chat"
    tools = [
        Tool(
            name="read_file",
            description=render("tools/read_file.md", read_max_chars=config.read_max_chars),
            parameters={
                "properties": {
                    "path": _str_param("file path OR directory path, relative to the workspace root"),
                    "max_chars": {
                        "type": "integer",
                        "description": f"max chars to read (default {config.read_max_chars})",
                    },
                    "offset": {
                        "type": "integer",
                        "description": "1-based start line for a line-range read",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "max lines to read when offset is given",
                    },
                },
                "required": ["path"],
            },
            func=lambda sb, cfg, **kw: filesystem.read_file(sb, cfg, **kw),
            inst=_READ_FILE,
            module=modules.WORKSPACE,
            guard=filesystem.guard_read,
            defaults={"max_chars": config.read_max_chars},
        ),
        Tool(
            name="grep",
            description=render("tools/grep.md"),
            parameters={
                "properties": {
                    "pattern": _str_param("regex to search for"),
                    "path": _str_param("subdirectory or file to search (default: whole workspace)"),
                    "include": _str_param("filename glob filter (e.g. '*.py')"),
                },
                "required": ["pattern"],
            },
            func=lambda sb, cfg, **kw: filesystem.grep(sb, cfg, **kw),
            inst=_GREP,
            module=modules.WORKSPACE,
            guard=filesystem.guard_grep,
            defaults={"path": ".", "include": ""},
        ),
    ]

    # chat mode: no write tools. The model never sees write_file/edit_file — the
    # schema is the hard boundary, the system prompt the soft guide (prompts/).
    if not chat_mode:
        tools.append(
            Tool(
                name="write_file",
                description=render("tools/write_file.md"),
                parameters={
                    "properties": {
                        "path": _str_param("file path, relative to the workspace root"),
                        "content": _str_param("full file content"),
                    },
                    "required": ["path", "content"],
                },
                func=lambda sb, cfg, **kw: filesystem.write_file(sb, cfg, **kw),
                inst=_WRITE_FILE,
                module=modules.WORKSPACE,
                guard=filesystem.guard_write,
                snapshot=True,
            )
        )
        tools.append(
            Tool(
                name="edit_file",
                description=render("tools/edit_file.md"),
                parameters={
                    "properties": {
                        "path": _str_param("file path, relative to the workspace root"),
                        "old_string": _str_param("exact text to replace (must appear exactly once)"),
                        "new_string": _str_param("replacement text"),
                    },
                    "required": ["path", "old_string", "new_string"],
                },
                func=lambda sb, cfg, **kw: filesystem.edit_file(sb, cfg, **kw),
                inst=_EDIT_FILE,
                module=modules.WORKSPACE,
                guard=filesystem.guard_write,
                snapshot=True,
            )
        )

    # run_command exists in both modes; in chat mode its description advertises the
    # read-only restriction and the tool rejects anything not provably read-only.
    # Deliberately NOT a statement with a module behind it: the command IS the
    # statement, and the host's permission engine (read-only classifier, escape
    # and protected-path guard, Stop) is the boundary it runs inside — host
    # policy, not a module's business (a module would only re-say "run this").
    tools.append(
        Tool(
            name="run_command",
            description=render("tools/run_command_chat.md" if chat_mode else "tools/run_command.md"),
            parameters={
                "properties": {
                    "command": _str_param("shell command string to run"),
                },
                "required": ["command"],
            },
            func=lambda sb, cfg, cancel=None, **kw: shell.run_command(sb, cfg, cancel=cancel, **kw),
        )
    )

    # web access: read-only network tools in BOTH modes — chat's read-only
    # contract is about the workspace; a GET touches nothing local
    tools.append(
        Tool(
            name="web_search",
            description=render(
                "tools/web_search.md",
                max_results=config.web_search_max_results,
                backends=" or ".join(websearch.available_backends(config)),
            ),
            parameters={
                "properties": {
                    "query": _str_param("search string (engine syntax like site: and quoted phrases works)"),
                    "max_results": {
                        "type": "integer",
                        "description": f"cap on returned entries (default {config.web_search_max_results})",
                    },
                    "backend": _str_param(
                        f"pin one backend: {' | '.join(websearch.available_backends(config))}"
                        " (default: fall through the chain)"
                    ),
                },
                "required": ["query"],
            },
            func=lambda sb, cfg, cancel=None, **kw: websearch.web_search(sb, cfg, cancel=cancel, **kw),
            inst=_WEBSEARCH_CLI + " search --envelope [--max-results {max_results}] [--backend {backend}] {query}",
            module=modules.WEBSEARCH,
            defaults={"max_results": config.web_search_max_results},
        )
    )
    tools.append(
        Tool(
            name="web_fetch",
            description=render("tools/web_fetch.md", max=config.read_max_chars),
            parameters={
                "properties": {
                    "url": _str_param("http(s) URL to fetch"),
                    "max_chars": {
                        "type": "integer",
                        "description": f"max chars of extracted text to return (default {config.read_max_chars})",
                    },
                    "start": {
                        "type": "integer",
                        "description": "0-based char offset to continue a truncated fetch",
                    },
                },
                "required": ["url"],
            },
            func=lambda sb, cfg, cancel=None, **kw: websearch.web_fetch(sb, cfg, cancel=cancel, **kw),
            inst=_WEBSEARCH_CLI + " fetch --envelope [--max-chars {max_chars}] [--start {start}] {url}",
            module=modules.WEBSEARCH,
            defaults={"max_chars": config.read_max_chars},
        )
    )

    if config.enable_skills:
        skill_tool = _build_load_skill(config)
        if skill_tool is not None:
            tools.append(skill_tool)
    if memories is not None:
        tools.extend(_build_memory_tools(memories))
    return tools


def _build_memory_tools(memories: MemoryStore) -> list[Tool]:
    """Project memory tools: save/load/search durable facts in the .clc."""

    def save(ws, cfg, title: str, content: str) -> dict:
        title = (title or "").strip()
        content = (content or "").strip()
        if not title:
            return {"content": "ERROR: title is required", "error": True}
        if not content:
            return {"content": "ERROR: content is required", "error": True}
        memories.save(title, content)
        return {"content": f"OK: saved memory '{title}'"}

    def load(ws, cfg, name: str) -> dict:
        m = memories.get((name or "").strip())
        if m is None:
            return {"content": f"ERROR: no memory named {name!r}", "error": True}
        return {"content": f"[{m.title}]\n{m.content}"}

    def search(ws, cfg, query: str) -> dict:
        q = (query or "").strip()
        hits = memories.search(q) if q else sorted(memories.items().values(), key=lambda m: -m.updated)
        if not hits:
            return {"content": "(no memories found)"}
        lines = [f"- {m.title}: {m.content[:200].replace(chr(10), ' ')}" for m in hits[:10]]
        return {"content": "\n".join(lines)}

    return [
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
                    "title": _str_param("very short one-line summary of the memory"),
                    "content": _str_param("full detail to remember"),
                },
                "required": ["title", "content"],
            },
            func=save,
            inst=_MEMORY_CLI + " save --title {title} --content {content}",
            module=modules.MEMORY,
        ),
        Tool(
            name="load_memory",
            description="Read one stored memory's full content by its exact title.",
            parameters={
                "properties": {"name": _str_param("the memory title to load")},
                "required": ["name"],
            },
            func=load,
            inst=_MEMORY_CLI + " load --title {name}",
            module=modules.MEMORY,
        ),
        Tool(
            name="search_memory",
            description=(
                "Search stored project memories by title or content; returns matching "
                "titles with snippets. Call with a topic to recall relevant long-term "
                "facts; an empty query lists the most recent memories."
            ),
            parameters={
                "properties": {"query": _str_param("topic to search for; empty lists recent")},
                "required": [],
            },
            func=search,
            inst=_MEMORY_CLI + " search [--query {query}]",
            module=modules.MEMORY,
        ),
    ]


def _build_load_skill(config: Config) -> Tool | None:
    """Model-chosen skill loader: enum of available skills; content pulled on demand."""
    lib = cached_library(config.skills_dir)
    if not lib.skills:
        return None
    names = lib.names()
    return Tool(
        name="load_skill",
        description=render("tools/load_skill.md"),
        parameters={
            "properties": {
                "name": {
                    "type": "string",
                    "enum": names,
                    "description": "skill to load, one of: " + ", ".join(names),
                },
                "file": _str_param(
                    "optional file inside the skill directory to read instead of SKILL.md "
                    "(e.g. resources/template.html)"
                ),
            },
            "required": ["name"],
        },
        func=_load_skill,
        inst=_SKILLS_CLI + " [--root {root}] show {name} [--file {file}]",
        module=modules.SKILLS,
    )


def _load_skill(_workspace: Workspace, config: Config, name: str, file: str = "SKILL.md") -> dict:
    """Serve SKILL.md (or a sub-file) from the skill's directory; error-as-data."""
    lib = cached_library(config.skills_dir)
    skill = lib.get(name)
    if skill is None:
        return {
            "content": render("errors/skill_unknown.md", skill=repr(name), available=", ".join(lib.names()) or "none"),
            "error": True,
        }
    root = skill.dir.resolve()
    path = (skill.dir / file).resolve()
    if not path.is_relative_to(root):
        return {"content": render("errors/skill_escape.md", file=repr(file)), "error": True}
    if not path.is_file():
        return {
            "content": render("errors/skill_missing.md", skill=repr(name), file=repr(file)),
            "error": True,
        }
    try:
        return {"content": path.read_text(encoding="utf-8", errors="replace")}
    except OSError as e:
        return {"content": render("errors/skill_read_failed.md", error=e), "error": True}


class ToolRegistry:
    def __init__(self, tools: list[Tool]) -> None:
        self._tools = {t.name: t for t in tools}
        # a tool opts into Stop by declaring a `cancel` parameter on its func
        # (run_command does); the rest get the exact same call as before
        self._cancelable = {
            name: t.func is not None and "cancel" in inspect.signature(t.func).parameters
            for name, t in self._tools.items()
        }

    def schemas(self) -> list[dict[str, Any]]:
        return [t.to_openai_schema() for t in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools)

    def tool(self, name: str) -> Tool | None:
        """One tool's definition (its statement, guard and fallback), for callers
        that need the wiring rather than a call — the statement tests, the
        session's schema export."""
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
        """One call, in precedence order: the host's guard, the module's
        statement, the host's own implementation (see Tool)."""
        if tool.guard is not None:
            refused = tool.guard(workspace, config, args)
            if refused is not None:
                return refused
        if tool.inst is not None and module_ready(workspace, tool.module):
            # the module performs the write; the host keeps the undo record, but
            # only once the statement has actually overwritten something — a
            # refused or failed edit must not leave a snapshot the UI could
            # "restore" (the host's own implementation records after validating
            # for the same reason)
            remembered = _previous_content(workspace, args) if tool.snapshot else None
            result = self._exec_statement(workspace, config, tool, args, cancel)
            if remembered is not None and not result.get("error"):
                workspace.snapshot(remembered[0], remembered[1])
            return result
        if tool.func is None:  # statement-only tool, module gone: say so, don't crash
            return {"content": f"ERROR: tool {tool.name} has no implementation on this host", "error": True}
        if self._cancelable.get(tool.name):
            return tool.func(workspace, config, cancel=cancel, **args)
        return tool.func(workspace, config, **args)

    def _exec_statement(
        self,
        workspace: Workspace,
        config: Config,
        tool: Tool,
        args: dict[str, Any],
        cancel: threading.Event | None,
    ) -> dict[str, Any]:
        """Run one tool statement: render -> the statement's transport -> the
        module's envelope (tools/inst.py owns both translations, so the model's
        argument values arrive at the service byte-for-byte whichever transport
        carried the line). Which transport that is — and which host placeholders
        the template gets — is the module's own kind: a daemon module is spoken
        to on the workspace's machine, a CLI module on the app host."""
        try:
            statement = rendezvous.prepare(tool.module, workspace, config)
            command = inst.render(tool.inst, args, vars=statement.vars, defaults=tool.defaults or {})
        except rendezvous.RendezvousError as e:
            return {"content": f"ERROR: {e}", "error": True}
        except InstError as e:
            return {"content": render("errors/invalid_arguments.md", error=e), "error": True}
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
