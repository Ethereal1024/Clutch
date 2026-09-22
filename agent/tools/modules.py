"""Where the standalone tool modules live, and which interpreter runs them.

Each decoupled tool is its own module directory next to the host repo
(clutch-workspace / clutch-memory / clutch-websearch / clutch-skills). The host
never imports them — R2 of the tool constitution: the dependency graph is a
star, modules point at the host's generic services, the host points at nothing
but their published interfaces (an HTTP surface, a CLI's stdout contract).

Two things every consumer of a module needs, kept in one place:

  module_dir(name)   the checkout of a module, used to build PYTHONPATH for a
                     spawned daemon and to invoke a module's CLI by path
  python_exe()       the interpreter that runs it. Under a frozen build
                     sys.executable is the app bundle, not a Python, so it must
                     never be handed a `-m module` command line; CLUTCH_PYTHON
                     names an interpreter explicitly, and PATH is the last
                     resort.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# Module directory names, in one place so a rename is one edit.
WORKSPACE = "clutch-workspace"
MEMORY = "clutch-memory"
WEBSEARCH = "clutch-websearch"
SKILLS = "clutch-skills"


def repo_root() -> Path:
    """The host repo root (this file lives at <root>/agent/tools/modules.py)."""
    return Path(__file__).resolve().parents[2]


def module_dir(name: str) -> Path:
    """The checkout directory of a standalone module."""
    return repo_root() / name


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


def module_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for a spawned module process: every module dir on
    PYTHONPATH (a source checkout is not an installed package, so a child's own
    `-m` import would not find its siblings) on top of the parent's env."""
    env = dict(os.environ)
    parts = [str(module_dir(n)) for n in (WORKSPACE, MEMORY, WEBSEARCH, SKILLS) if module_dir(n).is_dir()]
    existing = env.get("PYTHONPATH")
    if parts:
        env["PYTHONPATH"] = os.pathsep.join([*parts, existing] if existing else parts)
    env.setdefault("PYTHONUTF8", "1")
    if extra:
        env.update(extra)
    return env
