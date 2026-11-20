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
                      names an interpreter explicitly, and PATH is the last
                      resort.
"""

from __future__ import annotations

import os
import shutil
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


def python_exe() -> str:
    """The interpreter for `-m <module>` / `<module>/<script>.py` command lines.

    A frozen build's sys.executable is the app itself (it would relaunch the
    UI), so the bundle falls back to CLUTCH_PYTHON and then PATH. A source
    checkout uses its own interpreter, which is exactly the one the tests and
    the dev server run under.
    """
    if not getattr(sys, "frozen", False):
        return sys.executable
    override = os.environ.get("CLUTCH_PYTHON")
    if override:
        return override
    for name in ("python3", "python"):
        found = shutil.which(name)
        if found:
            return found
    return sys.executable


def python_missing() -> bool:
    """True when this host has no interpreter that can run a `-m` component: a
    frozen build's sys.executable is the app itself, so it needs CLUTCH_PYTHON or
    a python on PATH (the same order python_exe() falls back in)."""
    if not getattr(sys, "frozen", False):
        return False
    return not (os.environ.get("CLUTCH_PYTHON") or shutil.which("python3") or shutil.which("python"))


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
