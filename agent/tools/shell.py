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
import subprocess
import sys
from pathlib import Path

from ..config import Config
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
        if tok.startswith("/") or "/../" in tok or tok.startswith("../") or tok.endswith("/.."):
            try:
                workspace.resolve(tok)
            except ValueError:
                return {"content": f"ERROR: path escapes workspace: {tok!r}", "error": True}
        # protected files (the .clc project file) are off-limits to commands too
        try:
            if workspace.is_protected(workspace.resolve(tok)):
                return {"content": f"ERROR: cannot operate on protected file: {tok!r}", "error": True}
        except ValueError:
            pass

    args = shlex.split(command)
    if args and args[0] in ("python", "python3"):
        file_arg = next((a for a in args[1:] if not a.startswith("-") and a.endswith(".py")), None)
        if file_arg:
            try:
                p: Path = workspace.resolve(file_arg)
            except ValueError as e:
                return {"content": f"ERROR: {e}", "error": True}
            err = _syntax_check(p)
            if err:
                return {"content": f"ERROR: {err}", "error": True}

    try:
        # shell=True keeps shell semantics (&&, pipes, redirects) that the model
        # expects; workspace cwd + the path guard above bound what it can touch.
        r = subprocess.run(
            command,
            shell=True,
            cwd=workspace.root,
            capture_output=True,
            text=True,
            timeout=config.command_timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "content": f"ERROR: command timed out ({config.command_timeout:.0f}s). {INTERACTIVE_HINT}",
            "error": True,
        }
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return {"content": f"ERROR: execution failed: {e}", "error": True}

    parts = []
    if r.stdout:
        parts.append(f"stdout:\n{_truncate(config, r.stdout)}")
    if r.stderr:
        parts.append(f"stderr:\n{_truncate(config, r.stderr)}")

    if r.returncode != 0:
        body = "\n".join(parts) if parts else "(no output)"
        return {"content": f"ERROR: command failed (exit {r.returncode})\n{body}", "error": True}
    if not parts:
        return {"content": "OK: command succeeded, no output."}
    return {"content": "OK: command succeeded\n" + "\n".join(parts)}


def _blocked_reason(config: Config, command: str) -> str | None:
    stripped = command.strip()
    parts = stripped.split(maxsplit=1)
    first = parts[0] if parts else ""

    # bare python/python3 (no file or -m module arg) would drop into a REPL and hang
    if first in ("python", "python3"):
        rest = shlex.split(parts[1]) if len(parts) > 1 else []
        # safe non-interactive forms: `python3 file.py` or `python3 -m module`
        has_file = any(a.endswith(".py") for a in rest if not a.startswith("-"))
        has_module = "-m" in rest
        if not (has_file or has_module):
            return INTERACTIVE_HINT
        return None

    for prefix in config.blocked_prefixes:
        if stripped.startswith(prefix + " "):
            return INTERACTIVE_HINT
    return None


def _syntax_check(path: Path) -> str | None:
    if not path.is_file():
        return f"syntax check failed: file not found: {path}"
    r = subprocess.run(
        [sys.executable, "-m", "py_compile", str(path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if r.returncode != 0:
        return f"syntax check failed:\n{r.stderr.strip()[:2000]}"
    return None


def _truncate(config: Config, text: str) -> str:
    if len(text) <= config.output_limit:
        return text
    omitted = len(text) - config.output_head - config.output_tail
    return (
        f"{text[:config.output_head]}\n... [{omitted} chars omitted] ...\n"
        f"{text[-config.output_tail:]}"
    )
