"""Which shell do LOCAL run_command commands execute under?

The agent (the model) writes POSIX sh: ls/cat/grep, sh quoting, `&&` chains.
On a POSIX host subprocess(shell=True) honors that dialect directly. On
Windows shell=True means cmd.exe — no ls/cat/grep and different quoting — so
when a bash exists (Git for Windows / MSYS2) LocalTransport runs commands
through `bash -c` instead and the POSIX dialect works unchanged. Without any
bash the transport degrades to cmd.exe and the model adapts to the errors it
sees; everything that reasons about command TEXT degrades with it, always in
the safe direction (chat mode's whitelist stops matching -> default deny;
escape verdicts fall back to asking).

The choice is ONE cached decision shared by everyone who must agree with it:
  - LocalTransport.run     how the command is spawned (argv vs shell=True)
  - localshell.split_command  how command TEXT is tokenized — POSIX shlex eats
                           backslashes (C:\\Users -> C:Users), which corrupts
                           every escape verdict on a cmd-flavored host; the
                           Windows flavor follows CommandLineToArgvW rules
  - context.build_messages one "local environment" line so the model speaks
                           the right dialect from the first command

Detection (nt only, cached): CLUTCH_BASH env override, the standard Git for
Windows install locations, then PATH — except System32's bash.exe, which is
the WSL launcher: it executes in the LINUX filesystem, a different machine as
far as a C:\\ workspace is concerned. A candidate is accepted only after a
`bash -c echo` probe succeeds.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass


@dataclass(frozen=True)
class LocalShell:
    """The shell local commands will run under. ``argv`` is the spawn prefix
    (None => subprocess shell=True); ``posix`` says the command text is POSIX
    sh and must be tokenized as such."""

    argv: tuple[str, ...] | None
    posix: bool
    name: str  # "posix-sh" | "bash" | "cmd"


# Standard Git-for-Windows bash locations, most common first. WSL's
# System32\bash.exe is deliberately NOT here (see module docstring).
_BASH_CANDIDATES = (
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files\Git\usr\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\bin\bash.exe"),
    os.path.expandvars(r"%USERPROFILE%\scoop\apps\git\current\bin\bash.exe"),
)

_cache: LocalShell | None = None


def local_shell() -> LocalShell:
    """The (cached) shell decision for this host. Tests: reset_cache."""
    global _cache
    if _cache is None:
        _cache = _detect()
    return _cache


def reset_cache(shell: LocalShell | None = None) -> None:
    """Tests only: pin a shell choice (None re-enables detection)."""
    global _cache
    _cache = shell


def _detect() -> LocalShell:
    if os.name != "nt":
        return LocalShell(argv=None, posix=True, name="posix-sh")
    path_bash = shutil.which("bash")
    for cand in (os.environ.get("CLUTCH_BASH"), *_BASH_CANDIDATES, path_bash):
        if not cand or not os.path.isfile(cand) or _is_wsl_launcher(cand):
            continue
        if _probe_bash(cand):
            return LocalShell(argv=(cand, "-c"), posix=True, name="bash")
    return LocalShell(argv=None, posix=False, name="cmd")


def _is_wsl_launcher(path: str) -> bool:
    """True for a bash.exe inside the Windows system dir: the WSL launcher,
    whose filesystem is the Linux subsystem, not the workspace's drive."""
    sysdir = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    try:
        norm = os.path.normcase(os.path.abspath(path))
        return norm.startswith(os.path.normcase(sysdir) + os.sep)
    except OSError:  # pragma: no cover - unresolvable path: judge it by probe
        return False


def _probe_bash(path: str) -> bool:
    """A bash that cannot run a trivial -c command is not a shell we can use
    (broken MSYS install, WSL distro without a default distro, ...)."""
    try:
        r = subprocess.run(
            [path, "-c", "echo clutch-bash-ok"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "clutch-bash-ok" in (r.stdout or "")


def split_command(command: str, posix: bool | None = None) -> list[str] | None:
    """Tokenize command text the way the shell that will RUN it parses it.

    ``posix=None`` follows the local shell decision (``local_shell()``); an
    explicit True/False overrides it — REMOTE (SSH) commands always run under
    the remote POSIX shell even on a Windows app host, so their callers must
    pass True no matter what the app host is.

    POSIX flavor: shlex.split (quotes, backslash escapes). Windows/cmd flavor:
    double quotes only, backslashes literal, per CommandLineToArgvW (a run of
    n backslashes before a quote becomes n/2 backslashes and toggles quoting
    when n is even, or n//2 backslashes + a literal quote when odd). Returns
    None when the command cannot be parsed (unbalanced quotes) so every caller
    can take its conservative unparseable path."""
    if local_shell().posix if posix is None else posix:
        try:
            return shlex.split(command)
        except ValueError:
            return None
    return _split_windows(command)


def _split_windows(command: str) -> list[str] | None:
    out: list[str] = []
    tok: list[str] = []
    started = False  # a bare `""` still yields an (empty) argument
    in_quotes = False
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if ch == "\\":
            j = i
            while j < n and command[j] == "\\":
                j += 1
            runs = j - i
            if j < n and command[j] == '"':
                whole, rest = divmod(runs, 2)
                tok.append("\\" * whole)
                if rest:  # odd run: the quote is escaped, i.e. literal
                    tok.append('"')
                    started = True
                else:
                    in_quotes = not in_quotes
                    started = True
                i = j + 1
            else:
                tok.append("\\" * runs)
                started = True
                i = j
            continue
        if ch == '"':
            in_quotes = not in_quotes
            started = True
            i += 1
            continue
        if ch in " \t" and not in_quotes:
            if tok or started:
                out.append("".join(tok))
                tok, started = [], False
            i += 1
            continue
        tok.append(ch)
        started = True
        i += 1
    if in_quotes:
        return None
    if tok or started:
        out.append("".join(tok))
    return out
