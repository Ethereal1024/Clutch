"""Which build this process came from — the one number an upgrade argument needs.

The supervisor owns a FIXED machine-wide port (8890) and outlives the app that
started it: it exits only after a grace period with zero sessions. An upgrade
therefore installs a new binary under the feet of the OLD one still serving that
port, and the old one is kept busy by the sessions the NEW app keeps starting on
it. Nothing on screen says so; every host-side call (component install, the
installed-version table) simply keeps running the code the update just replaced,
which reads as "the fix did not ship".

The only question a client can ask over that port is ``GET /api/health``, so the
answer has to name the build: ``ui/server-bootstrap.js`` compares it with its own
and retires a predecessor instead of reusing it (see ensureSupervisor).

Where the number comes from, in order:

  - ``CLUTCH_BUILD_VERSION``: a build that already knows the release it cuts;
  - ``VERSION`` beside the frozen binary (PyInstaller ``--add-data``), so the
    shipped onefile answers for itself instead of guessing its release;
  - ``VERSION`` at the root of the source tree, which is where the dev path
    (``python -m agent.supervisor``) reads it.

An unknown build answers ``""``, never a guess: a client that cannot name its own
build must not compare, and a host that cannot name its own must be replaceable
rather than trusted.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def version() -> str:
    """This build's release number, or "" when it cannot be told."""
    from_env = os.environ.get("CLUTCH_BUILD_VERSION", "").strip()
    if from_env:
        return from_env
    for path in _candidates():
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if text:
            return text
    return ""


def _candidates():
    """The VERSION files this build may have been stamped with, likeliest first."""
    if getattr(sys, "frozen", False):
        # onefile: the bundle's data files land in _MEIPASS; a onedir/renamed
        # install may instead keep VERSION next to the executable
        bundle = getattr(sys, "_MEIPASS", None)
        if bundle:
            yield Path(bundle) / "VERSION"
        yield Path(sys.executable).resolve().parent / "VERSION"
    yield Path(__file__).resolve().parent.parent / "VERSION"
