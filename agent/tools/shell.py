"""Shell tool: run_command inside the workspace.

Poka-yoke (make it hard for the model to misuse):
- syntax pre-check: py_compile Python files before running
- blocked list: commands that hang in a non-TTY pipe (bare python, vim, less, ...)
- timeout: kill long-running commands
- truncation: cap output to protect context
- explicit empty-output message: no ambiguity about whether the command ran
"""

from __future__ import annotations

import shlex
from pathlib import Path

from ..config import Config
from .transport import TransportError
from .workspace import Workspace

INTERACTIVE_HINT = (
    "Interactive commands are blocked here. Write code with write_file and run it as "
    "`python3 file.py` with scripted input (stdin or a --test flag)."
)


def run_command(workspace: Workspace, config: Config, command: str) -> dict:
    reason = _blocked_reason(config, command)
    if reason:
        return {"content": f"ERROR: {reason}", "error": True}

    if not command.strip():
        return {"content": "ERROR: empty command", "error": True}

    # Path escape guard: reject tokens that look like file paths resolving outside
    # the workspace. We check the tokenized command first, then run the raw string
    # through a shell so `&&`, pipes and redirections keep their real meaning.
    for tok in shlex.split(command):
        try:
            p = workspace.resolve(tok)
        except ValueError:
            return {"content": f"ERROR: path escapes workspace: {tok!r}", "error": True}
        # protected files (the .clc project file) are off-limits to commands too
        if workspace.is_protected(p):
            return {"content": f"ERROR: cannot operate on protected file: {tok!r}", "error": True}

    args = shlex.split(command)
    if args and args[0] in ("python", "python3"):
        file_arg = next((a for a in args[1:] if not a.startswith("-") and a.endswith(".py")), None)
        if file_arg:
            try:
                p: Path = workspace.resolve(file_arg)
            except ValueError as e:
                return {"content": f"ERROR: {e}", "error": True}
            err = _syntax_check(workspace, str(p))
            if err:
                return {"content": f"ERROR: {err}", "error": True}

    try:
        r = workspace.run(command, config.command_timeout)
    except TransportError as e:
        if e.timeout:
            return {
                "content": f"ERROR: command timed out ({config.command_timeout:.0f}s). {INTERACTIVE_HINT}",
                "error": True,
            }
        return {"content": f"ERROR: execution failed: {e}", "error": True}
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return {"content": f"ERROR: execution failed: {e}", "error": True}

    parts = []
    if r.stdout:
        parts.append(f"stdout:\n{config.truncate(r.stdout)}")
    if r.stderr:
        parts.append(f"stderr:\n{config.truncate(r.stderr)}")

    if r.code != 0:
        body = "\n".join(parts) if parts else "(no output)"
        return {"content": f"ERROR: command failed (exit {r.code})\n{body}", "error": True}
    if not parts:
        return {"content": "OK: command succeeded, no output."}
    return {"content": "OK: command succeeded\n" + "\n".join(parts)}


def _blocked_reason(config: Config, command: str) -> str | None:
    stripped = command.strip()
    parts = stripped.split(maxsplit=1)
    first = parts[0] if parts else ""

    # bare python/python3 (no file, -m module, or -c code arg) would drop into a REPL and hang
    if first in ("python", "python3"):
        rest = shlex.split(parts[1]) if len(parts) > 1 else []
        # safe non-interactive forms: `python3 file.py`, `python3 -m module`, `python3 -c code`
        has_file = any(a.endswith(".py") for a in rest if not a.startswith("-"))
        if not (has_file or "-m" in rest or "-c" in rest):
            return INTERACTIVE_HINT
        return None

    for prefix in config.blocked_prefixes:
        if stripped.startswith(prefix + " "):
            return INTERACTIVE_HINT
    return None


def _syntax_check(workspace: Workspace, path: str) -> str | None:
    try:
        text = workspace.read(path)
    except FileNotFoundError:
        return f"syntax check failed: file not found: {path}"
    # compile() in-process: no subprocess/interpreter to invoke, so it also works
    # under PyInstaller (where sys.executable is the bundle, not a python binary)
    try:
        compile(text, path, "exec")
    except SyntaxError as e:
        return f"syntax check failed: {e.msg} (line {e.lineno})"
    return None
