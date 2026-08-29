"""Declarative tool registry.

Single source of truth: one Tool definition yields both the OpenAI function-calling
schema and the local execution entry. Tool descriptions live here as schema data;
error texts live in agent/prompts/.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from ..config import Config
from ..prompts import render
from ..skills import cached_library
from . import filesystem, shell
from .workspace import Workspace

# (workspace, config, **args) -> dict{content, error?}
ToolImpl = Callable[..., Dict[str, Any]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema (properties + required)
    func: ToolImpl

    def to_openai_schema(self) -> Dict[str, Any]:
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


def _str_param(desc: str, required: bool = True) -> dict:
    return {"type": "string", "description": desc}


def build_default_tools(config: Config) -> List[Tool]:
    tools = [
        Tool(
            name="read_file",
            description=(
                "Read a file in the workspace. path is relative to the workspace root. "
                f"Large files are truncated; use max_chars to control the size (default {config.read_max_chars}). "
                "Only read files relevant to the task; content-creation tasks do not "
                "need to explore the workspace."
            ),
            parameters={
                "properties": {
                    "path": _str_param("file path, relative to the workspace root"),
                    "max_chars": {
                        "type": "integer",
                        "description": "max chars to read (default 20000)",
                    },
                },
                "required": ["path"],
            },
            func=lambda sb, cfg, **kw: filesystem.read_file(sb, cfg, **kw),
        ),
        Tool(
            name="write_file",
            description=(
                "Create or overwrite a file in the workspace. path is relative to the "
                "workspace root. This is the only way to create/modify code files: "
                "whole-file rewrite, do not edit files any other way."
            ),
            parameters={
                "properties": {
                    "path": _str_param("file path, relative to the workspace root"),
                    "content": _str_param("full file content"),
                },
                "required": ["path", "content"],
            },
            func=lambda sb, cfg, **kw: filesystem.write_file(sb, cfg, **kw),
        ),
        Tool(
            name="list_dir",
            description="List the contents of a directory in the workspace. path defaults to '.'.",
            parameters={
                "properties": {
                    "path": _str_param("directory path, relative to the workspace root", required=False),
                },
                "required": [],
            },
            func=lambda sb, cfg, **kw: filesystem.list_dir(sb, cfg, **kw),
        ),
        Tool(
            name="run_command",
            description=(
                "Run a shell command in the workspace and return its output. cwd is fixed to "
                "the workspace root. Run Python with `python3 file.py` (syntax-checked first). "
                "Network is available: fetch remote content with curl or wget (save with a "
                "relative -o path; absolute output paths are blocked). "
                "Interactive commands are blocked (bare python, vi, vim, less). When a program "
                "needs input, use scripted input (stdin pipe or CLI args), or add a `--test` "
                "self-test mode that verifies behavior without interaction."
            ),
            parameters={
                "properties": {
                    "command": _str_param("shell command string to run"),
                },
                "required": ["command"],
            },
            func=lambda sb, cfg, **kw: shell.run_command(sb, cfg, **kw),
        ),
    ]

    if config.enable_skills:
        skill_tool = _build_load_skill(config)
        if skill_tool is not None:
            tools.append(skill_tool)
    return tools


def _build_load_skill(config: Config) -> Optional[Tool]:
    """Model-chosen skill loader: enum of available skills; content pulled on demand."""
    lib = cached_library(config.skills_dir)
    if not lib.skills:
        return None
    names = lib.names()
    return Tool(
        name="load_skill",
        description=(
            "Load a skill's instructions into context. Available skills are listed in "
            "the system prompt; call this ONLY when the task falls in a skill's domain, "
            "otherwise ignore them. The loaded instructions then guide how you work."
        ),
        parameters={
            "properties": {
                "name": {
                    "type": "string",
                    "enum": names,
                    "description": "skill to load, one of: " + ", ".join(names),
                },
                "file": _str_param(
                    "optional file inside the skill directory to read instead of SKILL.md "
                    "(e.g. resources/template.html)",
                    required=False,
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
            "content": f"ERROR: unknown skill {name!r}; available: {', '.join(lib.names()) or 'none'}",
            "error": True,
        }
    root = skill.dir.resolve()
    path = (skill.dir / file).resolve()
    if not path.is_relative_to(root):
        return {"content": f"ERROR: skill file escapes skill directory: {file!r}", "error": True}
    if not path.is_file():
        return {"content": f"ERROR: no such file in skill {name!r}: {file!r}", "error": True}
    try:
        return {"content": path.read_text(encoding="utf-8", errors="replace")}
    except OSError as e:
        return {"content": f"ERROR: cannot read skill file: {e}", "error": True}


class ToolRegistry:
    def __init__(self, tools: List[Tool]) -> None:
        self._tools = {t.name: t for t in tools}

    def schemas(self) -> List[Dict[str, Any]]:
        return [t.to_openai_schema() for t in self._tools.values()]

    def names(self) -> List[str]:
        return list(self._tools)

    def execute(self, workspace: Workspace, config: Config, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        tool = self._tools.get(name)
        if tool is None:
            return {
                "content": render("unknown_tool.md", tool=name, available=", ".join(self.names())),
                "error": True,
            }
        try:
            args = self._coerce_types(tool, args)
            result = tool.func(workspace, config, **args)
        except TypeError as e:
            result = {"content": f"ERROR: invalid arguments ({e}); check names and types", "error": True}
        except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
            result = {"content": f"ERROR: tool exception: {e}", "error": True}
        # normalize: every tool result carries error/diff so callers can index them
        result.setdefault("error", False)
        result.setdefault("diff", "")
        return result

    @staticmethod
    def _coerce_types(tool: Tool, args: Dict[str, Any]) -> Dict[str, Any]:
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
