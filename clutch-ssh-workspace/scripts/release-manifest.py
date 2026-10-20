#!/usr/bin/env python3
"""Write this component's release manifest — the one file a client's market reads.

Usage: release-manifest.py <artifact.tar.gz> <component.json> <out.json> [--asset NAME]

    {"schema": 1, "name": ..., "interface": ..., "runs_on": ...,
     "version": ...,
     "declaration": {"asset": "component.json", "sha256": "<64 hex>"},
     "artifacts": {"any": {"asset": "clutch-ssh-workspace.tar.gz", "sha256": "<64 hex>"}}}

Why `runs_on` is in here, and why this script is not a copy of a generic one:
`ui/components.js#parseManifest()` reads it off the RELEASE manifest, and the page
derives where an install goes from `interface` + `runs_on` alone
(`ui/components.js#destinationOf`). A packaged client has no checkout to ask, so a
manifest that leaves it out falls back to "self" — and then the market answers

    clutch-ssh-workspace is a plugin, so its implementation is this client:
    its declaration has to say runs_on: "other", and this one says "self"

i.e. the row is offered and cannot be installed. The declaration says it; this
manifest has to repeat it. Both digests are sha256 of the BYTES AS PUBLISHED: the
client downloads the artifact into a digest-named file and refuses anything that
does not hash to the pin, so this script must run on exactly the files that will
be uploaded, unmoved and unedited.

Assets are named RELATIVE to the manifest (the release that holds it), so the same
manifest works from a GitHub release, a mirror, or a directory on disk.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

SCHEMA = 1
REQUIRED = ("name", "interface", "version")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="write clutch-component.json for one release")
    parser.add_argument("artifact", type=Path, help="the artifact, as it will be published")
    parser.add_argument("declaration", type=Path, help="the component's own component.json")
    parser.add_argument("out", type=Path, help="where to write the manifest")
    parser.add_argument("--asset", default="", help="the artifact's published name (default: its own path's)")
    args = parser.parse_args()

    for path in (args.artifact, args.declaration):
        if not path.is_file():
            print(f"no such file: {path}", file=sys.stderr)
            return 1
    try:
        declared = json.loads(args.declaration.read_text(encoding="utf-8"))
    except ValueError as err:
        print(f"{args.declaration} is not JSON: {err}", file=sys.stderr)
        return 1
    for field in REQUIRED:
        value = declared.get(field) if isinstance(declared, dict) else None
        if not isinstance(value, str) or not value:
            print(f"the declaration names no {field}", file=sys.stderr)
            return 1

    # A plugin whose manifest does not repeat runs_on is uninstallable in the
    # market (see the module docstring), so its absence is a hard error here
    # rather than a field quietly left out.
    runs_on = declared.get("runs_on")
    if declared["interface"] == "plugin" and runs_on != "other":
        print(
            f"the declaration names runs_on {runs_on!r}; a plugin runs on this client, so the "
            f"release manifest must say \"other\" (ui/components.js#destinationOf)",
            file=sys.stderr,
        )
        return 1

    manifest = {
        "schema": SCHEMA,
        "name": declared["name"],
        "interface": declared["interface"],
        "version": declared["version"],
        "declaration": {"asset": args.declaration.name, "sha256": digest(args.declaration)},
        "artifacts": {"any": {"asset": args.asset or args.artifact.name, "sha256": digest(args.artifact)}},
    }
    if isinstance(runs_on, str) and runs_on:
        manifest["runs_on"] = runs_on
    args.out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{args.out}: {manifest['name']} {manifest['version']} (runs_on {manifest.get('runs_on', '(unstated)')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
