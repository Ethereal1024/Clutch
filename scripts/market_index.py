#!/usr/bin/env python3
"""Generate the market index -- the ONE list every Clutch client reads.

Why this exists
---------------
Until now a client carried a list of SOURCES (`ui/components.sources.json`: one
URL per module release, five of them) and read all five on the plugin page. That
is a list per client per version: five serial reads, five failure modes, and no
place that says which VERSION of a module is the current one -- every line said
`releases/latest`, so the answer was whatever the module happened to publish
last.

This script turns one hand-edited file (`market/entries.json`) plus the
manifests those entries are pinned to into one generated document:

    {"schema": 2, "entries": [{id, name, manifest, manifest_sha256, version, ...}]}

which is published (fixed tag `market`, asset `index.json`) and shipped as the
committed snapshot `ui/market.snapshot.json`. Three consequences worth naming:

  * ONE read for the page (`ui/components.js readIndex`), not five.
  * The index is AUTHORITATIVE for which version is current: the manifest URL is
    VERSION-PINNED (`.../releases/download/v0.1.0/clutch-component.json`), so
    `manifest_sha256` is a pin that can actually be enforced, and publishing a
    new module release installs nothing until its line here is bumped.
  * Publishing a module stays the module's own business: this file names a URL
    and pins its digest. The host still ships zero component bytes.

`--check` is the CI gate: the committed snapshot must equal what the entries
produce today, so an entry bump without a regenerated snapshot fails the build
instead of shipping a stale list.

Usage:
  python3 scripts/market_index.py --write            # rewrite the snapshot
  python3 scripts/market_index.py --check            # CI: snapshot is current
  python3 scripts/market_index.py --print            # stdout (the release asset)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENTRIES = ROOT / "market" / "entries.json"
SNAPSHOT = ROOT / "ui" / "market.snapshot.json"

SCHEMA = 2
MANIFEST_SCHEMA = 1
# Same shapes the client checks with (ui/components.js): an id is a namespace and
# a name, a digest is a hex sha256. Validated here too, so a typo is a CI failure
# with a file name rather than a market row that silently does not install.
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ATTEMPTS = 5
RETRY_SECONDS = 1.0
TIMEOUT = 30


class Problem(Exception):
    """A reason a page (or a CI log) can read, not a stack trace."""


def fetch(url: str) -> bytes:
    """The bytes at `url`, asked up to ATTEMPTS times -- a release host redirect
    can drop one connection (a redirect chain is several connections, each of
    them its own chance to die), and a CI gate that failed on that would be a
    gate people learn to re-run rather than trust. The wait between asks is a
    second: a connection that just died is not ready to be asked again."""
    last: Exception | None = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
                if r.status != 200:
                    raise Problem(f"answered {r.status}")
                return r.read()
        except urllib.error.HTTPError as e:
            # an ANSWER (404, 502): asking again gets the same one
            raise Problem(f"answered {e.code}") from e
        except Exception as e:  # noqa: BLE001 - a connection failure of any kind
            last = e
            if attempt == ATTEMPTS:
                break
            time.sleep(RETRY_SECONDS)
    raise Problem(f"could not be reached ({last})")


def string_field(entry: dict, key: str, where: str, *, required: bool = True, what: str = "") -> str:
    value = entry.get(key, "")
    if value == "" and not required:
        return ""
    if not isinstance(value, str) or not value.strip():
        raise Problem(f"{where}: {key} is not a non-empty string" + (f" ({what})" if what else ""))
    return value.strip()


def load_entries(path: pathlib.Path) -> list[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise Problem(f"{path} is missing") from e
    except json.JSONDecodeError as e:
        raise Problem(f"{path} is not JSON: {e}") from e
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA:
        raise Problem(f"{path}: schema has to be {SCHEMA}")
    entries = doc.get("entries")
    if not isinstance(entries, list) or not entries:
        raise Problem(f"{path}: entries has to be a non-empty list")

    ids: dict[str, str] = {}
    names: dict[str, str] = {}
    out = []
    for i, raw in enumerate(entries):
        where = f"{path}: entries[{i}]"
        if not isinstance(raw, dict):
            raise Problem(f"{where} is not an object")
        ident = string_field(raw, "id", where, what="<owner>/<name>")
        if not ID_RE.match(ident):
            raise Problem(f"{where}: id {ident!r} is not <owner>/<name>")
        if ident.lower() in ids:
            raise Problem(f"{where}: id {ident!r} is already used by {ids[ident.lower()]}")
        ids[ident.lower()] = ident
        name = string_field(raw, "name", where)
        if not NAME_RE.match(name):
            raise Problem(f"{where}: name {name!r} is not a lowercase component name")
        if name in names:
            raise Problem(f"{where}: name {name!r} is already used by {names[name]}")
        names[name] = ident
        manifest = string_field(raw, "manifest", where, what="a version-pinned release manifest")
        if not re.match(r"^https?://", manifest):
            raise Problem(f"{where}: manifest {manifest!r} is not an http(s) URL")
        # A `latest` URL would make manifest_sha256 a pin on a moving document --
        # the one thing this index exists to stop saying.
        if "/releases/latest/" in manifest:
            raise Problem(
                f"{where}: manifest points at releases/latest -- the index decides which version is "
                f"current, so the URL has to name one (.../releases/download/v<version>/...)"
            )
        version = string_field(raw, "version", where)
        summary = string_field(raw, "summary", where, required=False)
        homepage = string_field(raw, "homepage", where, required=False)
        license_name = string_field(raw, "license", where, required=False)
        tags = raw.get("tags", [])
        if not isinstance(tags, list) or any(not isinstance(t, str) or not t.strip() for t in tags):
            raise Problem(f"{where}: tags has to be a list of non-empty strings")
        out.append(
            {
                "id": ident,
                "name": name,
                "manifest": manifest,
                "version": version,
                "summary": summary,
                "tags": [t.strip() for t in tags],
                "homepage": homepage,
                "license": license_name,
            }
        )
    return out


def read_manifest(entry: dict) -> dict:
    """The manifest an entry points at, checked against what the entry claims.

    Three agreements are enforced, and each one is a lie the index could
    otherwise tell: the bytes are the ones the digest names (checked by the
    client too, from `manifest_sha256`), the manifest is the component the entry
    names, and it is the version the entry calls current.
    """
    url = entry["manifest"]
    try:
        body = fetch(url)
    except Problem as e:
        raise Problem(f"{entry['id']}: {url} {e}") from e
    try:
        manifest = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Problem(f"{entry['id']}: {url} is not JSON ({e})") from e
    if not isinstance(manifest, dict) or manifest.get("schema") != MANIFEST_SCHEMA:
        raise Problem(f"{entry['id']}: {url} declares schema {manifest.get('schema') if isinstance(manifest, dict) else '?'}, not {MANIFEST_SCHEMA}")
    if manifest.get("name") != entry["name"]:
        raise Problem(f"{entry['id']}: {url} declares {manifest.get('name')!r}, not {entry['name']!r}")
    if manifest.get("version") != entry["version"]:
        raise Problem(
            f"{entry['id']}: the index says {entry['version']}, {url} says {manifest.get('version')!r} "
            f"-- bump the entry to the version the release actually carries"
        )
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        raise Problem(f"{entry['id']}: {url} names no artifact, so no machine could install it")
    for platform, pin in artifacts.items():
        sha = pin.get("sha256") if isinstance(pin, dict) else ""
        if not isinstance(sha, str) or not SHA_RE.match(sha):
            raise Problem(f"{entry['id']}: {url} pins no sha256 for its {platform} artifact")
    return {
        "manifest_sha256": hashlib.sha256(body).hexdigest(),
    }


def build(entries_path: pathlib.Path = ENTRIES) -> dict:
    entries = load_entries(entries_path)
    out = []
    problems = []
    for entry in entries:
        try:
            facts = read_manifest(entry)
        except Problem as e:
            problems.append(str(e))
            continue
        out.append({**entry, **facts})
    if problems:
        raise Problem("\n".join(problems))
    return {"schema": SCHEMA, "entries": out}


def render(doc: dict) -> str:
    """The document as bytes, deterministically: same entries in, same file out,
    which is what makes `--check` a comparison rather than a coin toss."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write", action="store_true", help=f"rewrite {SNAPSHOT.relative_to(ROOT)}")
    parser.add_argument("--check", action="store_true", help="fail when the committed snapshot is stale")
    parser.add_argument("--print", dest="to_print", action="store_true", help="write the index to stdout")
    parser.add_argument("--entries", default=str(ENTRIES), help="the curation file (default market/entries.json)")
    parser.add_argument("--out", default=str(SNAPSHOT), help="where --write puts it (default ui/market.snapshot.json)")
    args = parser.parse_args(argv)
    if not (args.write or args.check or args.to_print):
        parser.error("one of --write, --check, --print is required")

    try:
        text = render(build(pathlib.Path(args.entries)))
    except Problem as e:
        print(f"market index: {e}", file=sys.stderr)
        return 1

    if args.to_print:
        sys.stdout.write(text)
    if args.write:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"market index: wrote {out.relative_to(ROOT)} ({len(json.loads(text)['entries'])} entries)")
    if args.check:
        committed = pathlib.Path(args.out)
        if not committed.exists():
            print(f"market index: {committed.relative_to(ROOT)} is missing -- run --write", file=sys.stderr)
            return 1
        if committed.read_text(encoding="utf-8") != text:
            print(
                f"market index: {committed.relative_to(ROOT)} is stale -- run "
                f"`python3 scripts/market_index.py --write` and commit the result",
                file=sys.stderr,
            )
            return 1
        print(f"market index: {committed.relative_to(ROOT)} matches market/entries.json")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
