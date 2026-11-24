"""Where the standalone tool modules live, and which interpreter runs them.

Each decoupled component has its own repository, checked out inside the host
repo in the dev layout: clutch-workspace and clutch-skills are tool modules the
host runs, clutch-websearch is a CLIENT plugin the client runs. The host never
imports any of them, and — since the host ships no built-in component — the
RUNTIME never names them either: a component is discovered through the manifest
its install laid down (tools/catalog.py), and these names are kept in one place
for the consumers that are allowed to point — the tests, config's default, and
the UI's list of what to build an artifact from (ui/components.js).

Three things every consumer of a module needs, kept in one place:

  module_dir(name)    the CHECKOUT of a module, inside the host repo. A place to
                      BUILD an artifact from, never a place the host runs from:
                      a checkout the host wants to drive is installed first
                      (scripts/install-component.py)
  component_dir(name) where this host finds the module it runs: the installed
                      version directory (tools/components.py), and nothing else.
                      None when this host does not hold it — an absent install
                      is absent, not a checkout standing in for one
  python_exe()        the interpreter that runs it. Under a frozen build
                      sys.executable is the app bundle, not a Python, so it must
                      never be handed a `-m module` command line; CLUTCH_PYTHON
                      names an interpreter explicitly, PATH is asked next, and a
                      LOGIN shell answers last — the PATH this process inherited
                      is not the PATH the machine's own shell has.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

from . import components

# The components this repo develops, in one place so a rename is one edit —
# a list for the consumers that may point (tests, config's default, the UI's ship
# list), never a host-side registration of them.
WORKSPACE = "clutch-workspace"
WEBSEARCH = "clutch-websearch"
SKILLS = "clutch-skills"


def repo_root() -> Path:
    """The host repo root (this file lives at <root>/agent/tools/modules.py)."""
    return Path(__file__).resolve().parents[2]


def module_dir(name: str) -> Path:
    """The checkout directory of a standalone module (the dev layout).

    This is a SOURCE TO BUILD FROM and nothing more. Two consumers, both of them
    builders: the tests that lay a component down to exercise it, and
    scripts/install-component.py, which archives a checkout into an artifact.
    The host itself never reads a directory this returns.
    """
    return repo_root() / name


def component_dir(name: str) -> Path | None:
    """Where THIS host finds `name` when it runs it: the installed version
    directory, or None when it does not hold the component.

    One path, because a component is one thing: what a host holds is what it
    runs. A checkout beside the repo is not an alternative spelling of an
    install — see module_dir.
    """
    return components.installed(name)


# The question a login shell is asked, verbatim, and the wall it may not cross:
# `bash -lc` sources the machine's profile, which is the only place a conda/pyenv/
# homebrew install puts itself on PATH — and it is a process, so it is asked once.
LOGIN_PROBE = "command -v python3 || command -v python"
LOGIN_PROBE_TIMEOUT = 8.0

# One answer per process: [] = not asked yet, [""] = asked, and there is none.
_INTERPRETER: list[str] = []


def _login_shell_python() -> str:
    """The interpreter a LOGIN shell finds, or "" when it finds none.

    A process inherits the PATH of whatever started it, and for a packaged app
    that is not the PATH the machine's own shell has: launched from Finder, or
    from an ssh command that is not a login shell, the environment is the bare
    `/usr/bin:/bin:/usr/sbin:/sbin`, and a `python3` installed under conda, pyenv
    or homebrew is simply not in it. The commands this session runs DO start a
    login shell (that is how a user's terminal is answered), so the interpreter
    that exists for the user is the one this host should drive a component with —
    otherwise a component that is installed and healthy is dropped as
    "the host has no interpreter", which is a fact about this process and not
    about the machine.

    Only a path that is absolute, a file, executable and named `python*` is
    taken: a shell answering with an alias, a function, or its own error text is
    not something a `-m module` line can be handed to.
    """
    if os.name == "nt" or not shutil.which("bash"):
        return ""
    try:
        out = subprocess.run(
            ["bash", "-lc", LOGIN_PROBE],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=LOGIN_PROBE_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    for line in out.stdout.decode("utf-8", "replace").splitlines():
        cand = line.strip()
        if not cand.startswith("/"):
            continue
        path = Path(cand)
        if not path.name.startswith("python"):
            continue
        if not path.is_file() or not os.access(path, os.X_OK):
            continue
        return str(path)
    return ""


def _interpreter() -> str:
    """The one resolution both questions below share: CLUTCH_PYTHON, then PATH,
    then the login shell — memoized, because the login shell answer costs a
    process and cannot change under a running host."""
    if _INTERPRETER:
        return _INTERPRETER[0]
    found = os.environ.get("CLUTCH_PYTHON") or ""
    if not found:
        for name in ("python3", "python"):
            hit = shutil.which(name)
            if hit:
                found = hit
                break
    if not found:
        found = _login_shell_python()
    _INTERPRETER[:] = [found]
    return found


def python_exe() -> str:
    """The interpreter for `-m <module>` / `<module>/<script>.py` command lines.

    A frozen build's sys.executable is the app itself (it would relaunch the
    UI), so the bundle falls back to CLUTCH_PYTHON, then PATH, then the login
    shell (`_login_shell_python`: the packaged app's PATH is not the machine's).
    A source checkout uses its own interpreter, which is exactly the one the
    tests and the dev server run under.
    """
    if not getattr(sys, "frozen", False):
        return sys.executable
    return _interpreter() or sys.executable


def python_missing() -> bool:
    """True when this host has no interpreter that can run a `-m` component: a
    frozen build's sys.executable is the app itself, so it needs CLUTCH_PYTHON, a
    python on PATH, or one a login shell can name (the same order python_exe()
    falls back in — one resolution, so the answer and the command line agree)."""
    if not getattr(sys, "frozen", False):
        return False
    return not _interpreter()


def module_env(import_dirs: Iterable[Path | str] = (), extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for a spawned component process, on top of this host's own.

    `import_dirs` are the roots the child has to be able to `import` from — a
    component's OWN directory, and only when its launch says it is importable.
    Never a sibling's: the dependency graph is a star, so no component is put
    next to another one to import it. A source checkout is not an installed
    package, so without this even the child's own `-m` package is not found.
    """
    env = dict(os.environ)
    parts = [str(Path(d)) for d in import_dirs]
    existing = env.get("PYTHONPATH")
    if parts:
        env["PYTHONPATH"] = os.pathsep.join([*parts, existing] if existing else parts)
    env.setdefault("PYTHONUTF8", "1")
    if extra:
        env.update(extra)
    return env
