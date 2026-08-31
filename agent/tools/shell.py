"""Shell tool: run_command inside the workspace.

Poka-yoke (make it hard for the model to misuse):
- chat-mode read-only gate: a static classifier proves a command cannot touch
  the workspace; anything not provably read-only is rejected up front
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
from ..prompts import render
from .transport import TransportError
from .workspace import Workspace

# ---- chat-mode read-only classification ----
# static analysis can only prove read-only: whitelist (default deny)
_READ_ONLY_CMDS = frozenset(
    {
        "ls", "cat", "grep", "find", "pwd", "cd", "whoami", "id", "uname", "date",
        "echo", "printf", "which", "type", "true", "false", "test", "[",
        "df", "du", "free", "uptime", "ps", "lsusb", "lspci", "lscpu", "dmesg",
        "nvidia-smi", "ip", "ss", "netstat", "ping", "hostname", "who", "w",
        "sort", "uniq", "head", "tail", "wc", "diff", "stat", "file",
        "basename", "dirname", "realpath", "readlink", "seq", "cut", "tr",
        "getent", "history", "git", "sed", "curl",
    }
)

# Common write/state-changing commands: only for a sharper error message
_WRITE_CMDS = frozenset(
    {
        "rm", "mv", "cp", "touch", "mkdir", "rmdir", "ln", "chmod", "chown",
        "chgrp", "tee", "dd", "mkfs", "mount", "umount", "truncate", "install",
        "unlink", "scp", "rsync", "wget", "make", "cmake", "ninja", "npm",
        "npx", "yarn", "pnpm", "pip", "pip2", "pip3", "pipx", "apt", "apt-get",
        "yum", "dnf", "brew", "gcc", "g++", "clang", "clang++", "go", "cargo",
        "rustc", "javac", "tar", "zip", "unzip", "gzip", "gunzip", "xz",
        "bzip2", "patch", "kill", "pkill", "killall", "systemctl", "service",
        "docker", "podman", "git", "sed", "curl", "find",
    }
)

# git subcommands that never touch the index/worktree/refs
_GIT_READ = frozenset(
    {
        "status", "log", "diff", "show", "rev-parse", "ls-files", "describe",
        "blame", "grep", "cat-file", "ls-tree", "count-objects", "help", "version",
    }
)

# git subcommands that mutate the repo; ambiguous ones (branch/tag/stash/config)
# are conservatively treated as write
_GIT_WRITE = frozenset(
    {
        "add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset",
        "checkout", "switch", "restore", "clean", "init", "clone", "mv", "rm",
        "stash", "tag", "branch", "config", "remote", "submodule", "apply",
        "cherry-pick", "revert", "gc", "prune", "pack", "update-index",
        "update-ref", "symbolic-ref", "write-tree", "commit-tree", "notes",
        "am", "format-patch", "filter-branch", "reflog", "worktree", "archive",
    }
)

# separator tokens: split the command into segments, each judged on its own
_SEPARATORS = frozenset({";", "&&", "||", "|", "|&", "&"})


def _tokenize(command: str) -> list[str] | None:
    """Split a command into shell tokens (quotes honored, separators split out).
    Returns None when the command cannot be tokenized (unbalanced quotes)."""
    try:
        lex = shlex.shlex(command, posix=True, punctuation_chars="|;&")
        lex.whitespace_split = True
        return list(lex)
    except ValueError:
        return None


def _segment(seg: list[str]) -> str:
    """First command token of a segment, skipping VAR=value prefix assignments."""
    for tok in seg:
        if "=" in tok and not tok.startswith("-"):
            continue
        return tok
    return ""


def _classify_segment(seg: list[str]) -> str:
    """Classify one command segment (no separators inside) as read/write/unknown."""
    if not seg:
        return "read"
    # ">" = output redirect (quoted too, conservatively); "<" alone is read-only input
    for tok in seg:
        if ">" in tok:
            return "write"
    name = _segment(seg)
    if not name:
        return "read"  # pure VAR=val assignment: no side effects
    if "/" in name:
        return "unknown"  # path-invoked binary (./script.sh, /bin/...): unprovable
    rest = seg[1:]

    if name == "git":
        subs = [t for t in rest if not t.startswith("-")]
        if any(s in _GIT_WRITE for s in subs):
            return "write"
        if any(s in _GIT_READ for s in subs):
            return "read"
        return "read"  # bare `git` / `git -C dir` → default status, read-only
    if name == "sed":
        if any(t == "-i" or t.startswith("--in-place") for t in rest):
            return "write"
        return "read"
    if name == "curl":
        # -o/--output write a file; combined short flags (-so) contain "o"
        if any(t.startswith("--output") or t.startswith("--remote-name") for t in rest):
            return "write"
        if any(t.startswith("-") and not t.startswith("--") and "o" in t for t in rest):
            return "write"
        return "read"
    if name == "find":
        if any(t in ("-delete", "-exec", "-execdir", "-ok") or t.startswith(("-fprint", "-fls")) for t in rest):
            return "write"
        return "read"

    if name in _READ_ONLY_CMDS:
        return "read"
    if name in _WRITE_CMDS:
        return "write"
    return "unknown"


def classify_command(command: str) -> tuple[str, str]:
    """Static read-only check for chat mode.

    Returns (verdict, detail) where verdict is "read", "write" or "unknown".
    "read" means the command is provably free of workspace side effects;
    anything else must be rejected in chat mode (default deny).
    """
    if not command.strip():
        return "read", "empty command"
    if "\n" in command:
        # newline-separated commands run sequentially: every line must be read-only
        for line in command.splitlines():
            verdict, detail = classify_command(line)
            if verdict != "read":
                return verdict, f"{detail} (line: {line.strip()!r})"
        return "read", "multi-line command"
    if "$(" in command or "`" in command:
        return "unknown", "command substitution ($(...) or backticks) cannot be statically analyzed"
    tokens = _tokenize(command)
    if tokens is None:
        return "unknown", "command cannot be parsed (unbalanced quotes?)"
    # command-separator segments: each one must be read-only
    seg: list[str] = []
    for tok in tokens:
        if tok in _SEPARATORS:
            verdict = _classify_segment(seg)
            if verdict != "read":
                detail = f"segment {_segment(seg) or '?'!r} is a {verdict} operation"
                return verdict, detail
            seg = []
        else:
            seg.append(tok)
    verdict = _classify_segment(seg)
    if verdict == "read":
        return "read", "read-only command"
    name = _segment(seg)
    if verdict == "write":
        return "write", f"'{name}' is a write operation"
    return "unknown", f"'{name}' cannot be proven read-only"


def run_command(workspace: Workspace, config: Config, command: str) -> dict:
    reason = _blocked_reason(config, command)
    if reason:
        return {"content": f"ERROR: {reason}", "error": True}

    # chat mode: only provably read-only commands may run (default deny)
    if config.mode == "chat":
        verdict, detail = classify_command(command)
        if verdict != "read":
            return {
                "content": render("errors/read_only_command.md", verdict=verdict, detail=detail, command=command[:300]),
                "error": True,
            }

    if not command.strip():
        return {"content": render("errors/empty_command.md"), "error": True}

    # Path escape guard: reject tokens resolving outside the workspace
    for tok in shlex.split(command):
        try:
            p = workspace.resolve(tok)
        except ValueError:
            return {"content": render("errors/path_escape.md", token=repr(tok)), "error": True}
        # protected files (the .clc project file) are off-limits to commands too
        if workspace.is_protected(p):
            return {"content": render("errors/protected_command.md", token=repr(tok)), "error": True}

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
                "content": render(
                    "errors/command_timeout.md",
                    seconds=f"{config.command_timeout:.0f}s",
                    hint=render("errors/interactive_hint.md"),
                ),
                "error": True,
            }
        return {"content": render("errors/execution_failed.md", error=e), "error": True}
    except Exception as e:  # noqa: BLE001 -- tool boundary: report to model
        return {"content": render("errors/execution_failed.md", error=e), "error": True}

    parts = []
    if r.stdout:
        parts.append(f"stdout:\n{config.truncate(r.stdout)}")
    if r.stderr:
        parts.append(f"stderr:\n{config.truncate(r.stderr)}")

    if r.code != 0:
        body = "\n".join(parts) if parts else "(no output)"
        return {"content": render("errors/command_failed.md", code=r.code, body=body), "error": True}
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
            return render("errors/interactive_hint.md")
        return None

    for prefix in config.blocked_prefixes:
        if stripped.startswith(prefix + " "):
            return render("errors/interactive_hint.md")
    return None


def _syntax_check(workspace: Workspace, path: str) -> str | None:
    try:
        text = workspace.read(path)
    except FileNotFoundError:
        return f"syntax check failed: file not found: {path}"
    # compile() in-process: no subprocess, works under PyInstaller too
    try:
        compile(text, path, "exec")
    except SyntaxError as e:
        return f"syntax check failed: {e.msg} (line {e.lineno})"
    return None
