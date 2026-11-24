#!/usr/bin/env python3
"""Install a component checkout through the host's own install channel.

Why this exists
---------------
A component is code a host RUNS, and the code a host runs is the code the host
HOLDS: `<root>/<name>/<version>/` plus the registry entry that says so
(agent/tools/components.py). A checkout inside the host repo is a SOURCE, not an
install — the host never resolves a run to a working tree, and a working tree
that happened to sit beside the repo would be a second place a component's
declaration could come from.

So the dev loop has one honest way left to drive uncommitted component code:
turn the working tree into an artifact and install it, exactly as a client's
upload does. This script is that step and nothing else:

    checkout -> archive (scripts/build-component-tar.sh, the same builder a
    release uses) -> digest -> components.install(..., version="<v>+<digest16>")

The version carries the content hash for the same reason a client-installed one
does: re-running after an edit has to REPLACE the install, and a version string
that stayed put would make "the source changed" and "the host holds this" the
same claim. Only the checkout's own `component.json` is read, and the artifact is
installed WITH it, so what the host later parses is the file the component ships.

Usage:
  python3 scripts/install-component.py clutch-skills
  python3 scripts/install-component.py clutch-skills clutch-websearch
  python3 scripts/install-component.py --list        # what this host holds
  python3 scripts/install-component.py --dry-run clutch-skills
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "scripts" / "build-component-tar.sh"
sys.path.insert(0, str(ROOT))

from agent.tools import components  # noqa: E402


class Problem(Exception):
    """A reason a terminal can read, not a stack trace."""


def archive_of(checkout: pathlib.Path, into: pathlib.Path) -> pathlib.Path:
    """One artifact from one checkout, built by the release builder itself.

    The archive is a build product on its way to a digest, so it lives in a
    temporary directory: nothing here is a second copy of a component on disk,
    and the install root holds the only one that matters.
    """
    out = into / f"{checkout.name}.tar.gz"
    try:
        proc = subprocess.run(
            ["bash", str(BUILD), str(checkout), str(out)],
            capture_output=True,
            text=True,
        )
    except OSError as e:
        raise Problem(f"{checkout.name}: cannot run {BUILD.relative_to(ROOT)} ({e})") from e
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip() or f"exit {proc.returncode}"
        raise Problem(f"{checkout.name}: {BUILD.relative_to(ROOT)} failed: {detail}")
    if not out.is_file():
        raise Problem(f"{checkout.name}: {BUILD.relative_to(ROOT)} wrote no archive")
    return out


def install_checkout(checkout: pathlib.Path, *, dry_run: bool = False) -> str:
    """Install one checkout for THIS host and say what landed."""
    manifest = components.read_manifest(checkout)
    if manifest is None:
        raise Problem(
            f"{checkout}: no readable {components.MANIFEST} naming a component "
            f"(a checkout without one is not an artifact, only source)"
        )
    name = str(manifest["name"])
    with tempfile.TemporaryDirectory(prefix="clutch-component-") as tmp:
        artifact = archive_of(checkout, pathlib.Path(tmp))
        digest = components.digest(artifact)
        version = f"{manifest['version']}+{digest[:16]}"
        if components.current(name, version, digest):
            return f"{name} {version}: this host already holds it"
        if dry_run:
            return f"{name} {version}: would install ({artifact.stat().st_size} bytes)"
        # The request's manifest IS the declaration plus the install facts: the
        # artifact's own component.json is merged UNDER it by components.install,
        # and the digest is what a later gate compares bytes by.
        directory = components.install(artifact, {**manifest, components.DIGEST_FIELD: digest}, version=version)
    return f"{name} {version}: installed at {directory}"


def list_held() -> str:
    """What this host holds, one line per component — the install root's answer."""
    held = components.inventory()
    if not held:
        return f"no components installed under {components.root()}"
    return "\n".join(
        f"{record['name']} {record['version']}" + (" (disabled)" if record.get(components.DISABLED_FIELD) else "")
        for record in held
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "checkouts", nargs="*", metavar="CHECKOUT", help="a component checkout carrying a component.json"
    )
    parser.add_argument("--list", action="store_true", help="print what this host holds and exit")
    parser.add_argument("--dry-run", action="store_true", help="say what would be installed, install nothing")
    args = parser.parse_args(argv)
    if args.list:
        print(list_held())
        return 0
    if not args.checkouts:
        parser.error("name at least one component checkout (or --list)")

    failed = 0
    for raw in args.checkouts:
        checkout = pathlib.Path(raw)
        if not checkout.is_absolute():
            # a bare name is the dev layout's checkout, so `clutch-skills` means
            # the same directory from any cwd; a path that is not one of those
            # is read relative to where the caller stands
            checkout = ROOT / checkout if (ROOT / checkout).is_dir() else checkout.resolve()
        try:
            print(install_checkout(checkout, dry_run=args.dry_run))
        except (Problem, ValueError) as e:
            print(f"install-component: {e}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
