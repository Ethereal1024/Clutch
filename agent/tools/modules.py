"""Where the standalone tool modules live, and which interpreter runs them.

Each decoupled tool component has its own repository (clutch-workspace /
clutch-memory / clutch-websearch / clutch-skills), checked out next to the host
repo in the dev layout. The host never imports them, and — since the host ships
no built-in component (see COMPONENTS.md) — the RUNTIME never names them either:
a component is discovered through its own manifest (tools/catalog.py), and these
names are kept in one place for the consumers that are allowed to point — the
tests, `config.skills_dir`'s default (a position to look the library up at), and
the UI's list of what to ship on install (ui/components.js).

Three things every consumer of a module needs, kept in one place:

  module_dir(name)    the dev CHECKOUT of a module, next to the host repo
  component_dir(name) where this host actually finds the module it may run: an
                      installed component first (tools/components.py — a host
                      installs what it runs, on its own machine), then the
                      checkout. Every host-side lookup goes through this one,
                      so "installed" and "checked out" can never disagree
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

# The four components this repo develops, in one place so a rename is one edit —
# a list for the consumers that may point (tests, config's default, the UI's ship
# list), never a host-side registration of them.
WORKSPACE = "clutch-workspace"
MEMORY = "clutch-memory"
WEBSEARCH = "clutch-websearch"
SKILLS = "clutch-skills"


def repo_root() -> Path:
    """The host repo root (this file lives at <root>/agent/tools/modules.py)."""
    return Path(__file__).resolve().parents[2]


def module_dir(name: str) -> Path:
    """The checkout directory of a standalone module (the dev layout)."""
    return repo_root() / name


def component_dir(name: str) -> Path:
    """Where THIS host finds `name`: its installed component first, then the
    dev checkout next to the host repo.

    The two are interchangeable here on purpose: a host may be a desktop process
    in a source checkout or a remote machine where the client uploaded the
    component's artifact, and what the host runs is in both cases "the code of
    this component on this machine" — one thing, one accessor. Only a RESOLVABLE
    install shadows the checkout (tools/components.installed requires a valid
    manifest naming this component), so a half-written version directory cannot
    hide a working checkout.
    """
    return components.installed(name) or module_dir(name)


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
