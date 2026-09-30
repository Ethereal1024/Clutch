#!/usr/bin/env python3
"""Print the skill-library root this host installs into, and nothing else.

The library is the COMPONENT's, not the host's: `clutch-skills` serves
`<its own directory>/skills` unless someone hands it a `--root`, so the host has
no path of its own to default to any more (`config.skills_dir` is None). This
script is how a host-side installer asks the right question in the right order:

  1. `config.skills_dir`, when the host IS pinned to a root — a fact about the
     host's configuration, and the component would be told the same value.
  2. otherwise the component's own answer: its `list` payload carries the root
     it actually serves (clutch_skills.server.catalog_payload -> {"root", ...}),
     asked through the same launch and transport every other host statement
     uses (`rendezvous.prepare_cli` renders the prefix for a checkout, a package
     or an installed onefile alike; the runner is the app host's).

Nothing is guessed and nothing is created: a root the component does not have is
not a root (the CLI's own checked_root refuses it), and a component that is not
on this machine is a failure with its reason on stderr, exit 1. The caller
decides whether that is fatal.

Run: python3 scripts/skills-root.py     (prints one absolute path)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.config import Config  # noqa: E402
from agent.tools import modules, rendezvous  # noqa: E402
from agent.tools.transport import TransportError  # noqa: E402

# The line that answers "which root": the component's own list payload, read from
# the filesystem in that one process (--no-server), as one JSON object (--json).
# Not a declaration template — no component publishes "where is your library" as
# a HOST fact — but it is the component's published machine contract, which is
# all a host is allowed to read.
PAYLOAD = "--no-server --json list"


def served_root(config: Config) -> str:
    """The root the skill library lives at for this host, or a reason it has none."""
    pinned = getattr(config, "skills_dir", None)
    if pinned:
        return str(Path(str(pinned)).expanduser())
    try:
        ready = rendezvous.prepare_cli(modules.SKILLS, config)
    except rendezvous.RendezvousError as e:
        raise SystemExit(f"skills-root: {e}")
    command = f"{ready.prefix} {PAYLOAD}".strip()
    try:
        result = ready.runner.run(command, config.command_timeout)
    except TransportError as e:
        raise SystemExit(f"skills-root: could not ask {modules.SKILLS}: {e}")
    if result.code != 0:
        said = (result.stderr or result.stdout).strip().splitlines()
        raise SystemExit(f"skills-root: {modules.SKILLS} exited {result.code}: {said[0] if said else 'it said nothing'}")
    try:
        payload = json.loads(result.stdout)
        root = payload["root"]
    except (ValueError, KeyError, TypeError):
        raise SystemExit(f"skills-root: {modules.SKILLS} answered no root: {result.stdout.strip()[:120]!r}")
    if not isinstance(root, str) or not root:
        raise SystemExit(f"skills-root: {modules.SKILLS} answered an empty root")
    return root


def main() -> int:
    print(served_root(Config()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
