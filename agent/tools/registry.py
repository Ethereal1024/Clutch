"""Declarative tool registry.

Single source of truth: one Tool definition yields both the OpenAI function-calling
schema and the local execution entry. Tool descriptions live here as schema data;
error texts live in agent/prompts/.
"""

from __future__ import annotations

import inspect
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..config import Config
from ..memory import MemoryStore
from ..prompts import render
from ..skills import cached_library
from . import filesystem, shell, websearch
from .transport import _drain, _kill_tree
from .workspace import LocalWorkspace, Workspace

# (workspace, config, **args) -> dict{content, error?}
ToolImpl = Callable[..., dict[str, Any]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema (properties + required)
    func: ToolImpl
    # True = run func in a child process (tools/cli.py) instead of in-process;
    # opt-in per tool so migration is gradual. execute() ignores it for remote
    # workspaces (the child would hit the LOCAL disk) and under frozen builds
    # (sys.executable is the bundle, not python).
    subprocess: bool = False

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
            subprocess=True,  # pilot: first tool migrated to child execution
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
            )
        )

    # run_command exists in both modes; in chat mode its description advertises the
    # read-only restriction and the tool rejects anything not provably read-only.
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
        ),
        Tool(
            name="load_memory",
            description="Read one stored memory's full content by its exact title.",
            parameters={
                "properties": {"name": _str_param("the memory title to load")},
                "required": ["name"],
            },
            func=load,
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
            name: "cancel" in inspect.signature(t.func).parameters for name, t in self._tools.items()
        }

    def schemas(self) -> list[dict[str, Any]]:
        return [t.to_openai_schema() for t in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools)

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
            # subprocess tools run in a child process — but only where that is
            # meaningful (see Tool.subprocess): frozen builds and remote
            # workspaces fall back to the plain in-process call
            use_child = (
                tool.subprocess
                and not getattr(sys, "frozen", False)
                and isinstance(workspace, LocalWorkspace)
            )
            if use_child:
                result = self._exec_subprocess(workspace, config, name, args, cancel)
            elif self._cancelable.get(name):
                result = tool.func(workspace, config, cancel=cancel, **args)
            else:
                result = tool.func(workspace, config, **args)
        except TypeError as e:
            result = {"content": render("errors/invalid_arguments.md", error=e), "error": True}
        except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
            result = {"content": render("errors/tool_exception.md", error=e), "error": True}
        # normalize: every tool result carries error/diff so callers can index them
        result.setdefault("error", False)
        result.setdefault("diff", "")
        return result

    def _exec_subprocess(
        self,
        workspace: Workspace,
        config: Config,
        name: str,
        args: dict[str, Any],
        cancel: threading.Event | None,
    ) -> dict[str, Any]:
        """Run the tool function in a child process (tools/cli.py).

        Same {content, error, diff} contract, one JSON serialization hop: args
        go in as stdin JSON, the child's result dict comes back as stdout JSON.
        Crash / timeout / cancel produce the same error-as-data dict the
        in-process boundary would. Platform notes: pipes stay BINARY (no
        text=True — Windows would translate newlines); the payload rides stdin
        (no argv 32K limit, no console codepage); on POSIX the child gets its
        own session/process group so the tree kill cannot take the agent down.
        """
        payload = json.dumps(
            {
                "name": name,
                "args": args,
                "workspace_root": str(workspace.root),
                "mode": config.mode,
                "read_max_chars": config.read_max_chars,
                "protected": [str(p) for p in workspace.protected()],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        # -m resolves `agent` via cwd; parents[2] is the repo root
        repo_root = Path(__file__).resolve().parents[2]
        env = {**os.environ, "PYTHONUTF8": "1"}  # child tracebacks in utf-8 too
        proc = subprocess.Popen(
            [sys.executable, "-m", "agent.tools.cli"],
            cwd=str(repo_root),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=os.name == "posix",
        )
        out: list[bytes] = []
        err: list[bytes] = []
        # drain threads start BEFORE the stdin write: a child blocked writing
        # stdout while we block writing stdin would deadlock both pipes
        readers = [
            threading.Thread(target=_drain, args=(proc.stdout, out), daemon=True),
            threading.Thread(target=_drain, args=(proc.stderr, err), daemon=True),
        ]
        for t in readers:
            t.start()
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except OSError:
            pass  # child died early; its stderr surfaces below
        deadline = time.monotonic() + config.command_timeout
        code: int | None = None
        while True:
            if cancel is not None and cancel.is_set():
                _kill_tree(proc)
                return {"content": "ERROR: tool call canceled", "error": True}
            try:
                code = proc.wait(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() > deadline:
                    _kill_tree(proc)
                    return {
                        "content": f"ERROR: tool timed out after {config.command_timeout}s",
                        "error": True,
                    }
        for t in readers:
            t.join(timeout=5)
        try:
            return json.loads(b"".join(out).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            tail = b"".join(err).decode("utf-8", "replace")[-2000:]
            return {
                "content": f"ERROR: tool subprocess crashed (exit {code}): {tail}",
                "error": True,
            }

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
