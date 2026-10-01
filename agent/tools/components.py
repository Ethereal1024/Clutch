"""Installed components: where a host finds the code a statement needs.

A component is a standalone artifact (clutch-workspace, clutch-memory,
clutch-websearch, clutch-skills) that a host installs FOR ITSELF, on ITS OWN
machine — the desktop process, or a remote server the client bootstrapped behind
an SSH tunnel. rendezvous.py owns what a component's PUBLISHED interface is;
this module owns where its artifact lands and how a host finds it:

    <root>/<name>/<version>/component.json    the manifest (interface, launch)
    <root>/<name>/<version>/...               the artifact's own files

Two properties are deliberate.

Machine-local and host-relative, exactly like the daemon discovery records: a
component installed for a host belongs to that host's filesystem, whether the
host is this desktop or a remote machine. Nothing in the install path is
"remote" or "local" — one client uploads the same artifact to whichever host it
is talking to, and this module is the receiving half.

Shape-agnostic: `install` takes opaque bytes plus a manifest and lays them down
atomically. The artifact may be a PyInstaller onefile, an archive of scripts, a
zipapp, a wheel unpacked by whoever built it — the shape is the component's own
business. Only the manifest and the published interface are the host's (R4), so
`verify` refuses a manifest whose name or interface contradicts the host's own
table BEFORE the artifact is used.

Where a host keeps track of all this — the registry table
--------------------------------------------------------
`<root>/registry.json` is the single source of truth for what this host holds:
one entry per installed (name, version), plus the one bit that is not a
filesystem fact at all — `disabled`, a component that is HERE and is not to be
driven. Reads resolve by the table (表里有就是有): a component directory placed
in the root by hand is not an install until the table says so. The disk is
scanned exactly twice — at bootstrap (no table yet: a host that has held
components since before there was one) and by an explicit `reindex()` — because
"a directory nobody recorded" and "a component of this host" are not the same
thing, and only the table may tell them apart. A rebuild believes the disk, so
the one thing the disk cannot carry — `disabled` — is forgotten with it, which
is the whole cost of a reindex and the reason it is never automatic. A table
that exists and cannot be READ is a loud refusal, not a silent rescan: the bytes
would survive a rescan but what this host believes it holds would not.

Two deviations from VS Code's own registry are deliberate, and both are noted
where they bite: the table lives beside the payloads rather than in a user-data
directory (this module has ONE root, repointable by ROOT_ENV, and tests redirect
it — a second location would be a second thing to keep in step), and the bytes
go before the entry does (VS Code drops the entry first and sweeps the leftovers
later with a `.obsolete` pass; Clutch has no sweeper, so a dropout there would
be a component that vanished from the table and stayed on the disk forever).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import tarfile
import tempfile
import threading
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import IO, Any

MANIFEST = "component.json"
ROOT_ENV = "CLUTCH_COMPONENTS_DIR"  # repoints the whole root (tests, unusual layouts)
ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".tar", ".zip")

# The wire contract between a client and the host it installs FOR: the manifest
# rides in a header — base64 of the JSON's UTF-8 bytes, because a header value
# is a ByteString (every code point <= 0xFF) and a declaration speaks the
# component's own language — and the artifact is the request body. The host's
# side of it is this module; the client's is ui/components.js.
MANIFEST_HEADER = "X-Clutch-Component"
DIGEST_FIELD = "digest"  # the manifest's record of the artifact's content hash
ARTIFACT_FIELD = "artifact"  # the artifact's own file name (its shape, by suffix)
SCRATCH = ".incoming"  # where a body lands while it is being received
CHUNK = 1 << 20  # bytes read from a body per pass

REGISTRY = "registry.json"  # the table beside the payload dirs: what this host holds
REGISTRY_SCHEMA = 1  # the table's own version, so a future shape is refused by name
DISABLED_FIELD = "disabled"  # here but not driven: the bytes stay, the tools go
LOCATION_FIELD = "location"  # the payload directory, relative to the root, "/"-joined

# One writer, and it is this process: the supervisor is threaded (a request per
# thread) and every write is a read-modify-write of one file. Two installs racing
# each other would otherwise each write back a table it read before the other
# changed it, and one of the two components would be silently forgotten.
_TABLE_LOCK = threading.RLock()


def manifest_from_header(raw: str | None) -> dict[str, Any]:
    """The manifest one install request carried in its header (the wire contract
    above), or ValueError when the value does not decode to a JSON object."""
    if not raw:
        raise ValueError(f"{MANIFEST_HEADER} is missing")
    try:
        payload = json.loads(base64.b64decode(raw, validate=True).decode("utf-8"))
    except ValueError as err:  # bad base64 (binascii.Error) and bad JSON alike
        raise ValueError(f"{MANIFEST_HEADER} must be base64 of a JSON object") from err
    if not isinstance(payload, dict):
        raise ValueError(f"{MANIFEST_HEADER} must be a JSON object")
    return payload

# A component's identity and its version string both end up in a path, so both
# are restricted to the shapes an install may name. The version may carry a
# content digest (`0.2.0+<hex>`), which is how the client's install gate works.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


def _check_name(name: str) -> None:
    """Refuse a component name that could never be an install on this host.

    Names are path components, so this is the traversal gate as much as a
    spelling rule: a name outside the shape an install may have would otherwise
    reach the filesystem, and "refuse the request" is the only safe answer —
    nothing about the caller's intent can make `../..` a component here.
    """
    if not _NAME_RE.match(name):
        raise ValueError(f"bad component name: {name!r}")


def _check_version(version: str) -> None:
    """Refuse a version string that could never name an install directory."""
    if not _VERSION_RE.match(version):
        raise ValueError(f"bad component version: {version!r}")

REQUIRED_FIELDS = ("name", "version", "interface")
INTERFACES = ("daemon", "cli")


def root() -> Path:
    """The component root of THIS host: where its installed components live.

    A machine-local bookkeeping path, like the daemon discovery records: a
    frozen app has no writable install directory of its own, so the host's user
    directory is the only place an install can land for sure.
    """
    override = os.environ.get(ROOT_ENV)
    if override:
        return Path(override)
    local = os.environ.get("LOCALAPPDATA")
    return Path(local) / "clutch" / "components" if local else Path.home() / ".clutch" / "components"


def component_root(name: str) -> Path:
    """The directory holding every installed version of one component."""
    return root() / name


# -- the table: what this host holds, and the one bit that is not a file fact --


def registry_path() -> Path:
    """The table's own file, beside the payload directories it describes."""
    return root() / REGISTRY


def _entry_directory(record: dict[str, Any]) -> Path:
    """The payload directory one table entry names.

    The entry's location is relative to the root, so the whole root can be moved
    or repointed (ROOT_ENV) without rewriting the table — which is not a
    convenience: a test redirects the root, and a table holding absolute paths
    would then describe another machine's filesystem.
    """
    location = str(record.get(LOCATION_FIELD) or "")
    if not location:
        return component_root(str(record.get("name", ""))) / str(record.get("version", ""))
    return root() / location


def _entry(
    name: str,
    version: str,
    directory: Path,
    manifest: dict[str, Any],
    *,
    disabled: bool = False,
) -> dict[str, Any]:
    """One table entry: which component, which version, what its bytes hash to,
    where its payload is, and whether this host is to drive it."""
    try:
        location = directory.relative_to(root()).as_posix()
    except ValueError:  # a payload outside the root: recorded as it is, not guessed
        location = directory.as_posix()
    return {
        "name": name,
        "version": version,
        "interface": str(manifest.get("interface", "")),
        DIGEST_FIELD: str(manifest.get(DIGEST_FIELD, "")),
        LOCATION_FIELD: location,
        DISABLED_FIELD: bool(disabled),
    }


def _scan_entries() -> list[dict[str, Any]]:
    """What the root ACTUALLY holds, read off the disk: the bootstrap scan.

    Every version directory that carries a usable manifest naming its own parent
    component, in name order. This is not how a read resolves a component — the
    table is (see the module docstring) — so it runs only when there is no table
    yet, and when `reindex()` is asked for one deliberately.
    """
    base = root()
    if not base.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for child in sorted(base.iterdir()):
        if not child.is_dir() or child.name == SCRATCH:
            continue
        for version_dir in sorted(child.iterdir()):
            if not version_dir.is_dir() or version_dir.name.endswith(".installing"):
                continue
            manifest = read_manifest(version_dir)
            if manifest is None or manifest["name"] != child.name:
                continue
            out.append(_entry(child.name, str(manifest["version"]), version_dir, manifest))
    return out


def _read_table() -> list[dict[str, Any]] | None:
    """The stored table, or None when this host has no table yet.

    A table that cannot be read is NOT quietly re-derived from the disk: the
    bytes would still be there, but what this host believes it holds would change
    under it — a component could reappear from a stale directory, or a disable
    could evaporate. So a broken table is a loud refusal, and `reindex()` is the
    deliberate way to rebuild one.
    """
    path = registry_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as err:
        raise ValueError(f"{path} could not be read: {err}") from err
    try:
        payload = json.loads(raw)
    except ValueError as err:
        raise ValueError(f"{path} is not valid JSON ({err}) — reindex() rebuilds it from the disk") from err
    if not isinstance(payload, dict) or payload.get("schema") != REGISTRY_SCHEMA:
        raise ValueError(f"{path} is not a schema-{REGISTRY_SCHEMA} component registry")
    listed = payload.get("components")
    if not isinstance(listed, list):
        raise ValueError(f"{path} carries no component list")
    out: list[dict[str, Any]] = []
    for record in listed:
        if not isinstance(record, dict) or not isinstance(record.get("name"), str) or not record["name"]:
            raise ValueError(f"{path} has an entry that names no component")
        out.append(
            {
                "name": record["name"],
                "version": str(record.get("version", "")),
                "interface": str(record.get("interface", "")),
                DIGEST_FIELD: str(record.get(DIGEST_FIELD, "")),
                LOCATION_FIELD: str(record.get(LOCATION_FIELD, "")),
                DISABLED_FIELD: bool(record.get(DISABLED_FIELD, False)),
            }
        )
    return out


def _write_table(entries: list[dict[str, Any]]) -> None:
    """Lay the table down atomically: a reader sees the whole old table or the
    whole new one, never half of either — the discipline `install` uses for a
    payload. Written INSIDE the root, so it travels with what it describes."""
    path = registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema": REGISTRY_SCHEMA, "components": entries}
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix="." + REGISTRY + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _update_table(mutate: Callable[[list[dict[str, Any]]], list[dict[str, Any]]]) -> None:
    """One read-modify-write of the table, under the one lock (_TABLE_LOCK)."""
    with _TABLE_LOCK:
        _write_table(mutate(entries()))


def entries() -> list[dict[str, Any]]:
    """What this host holds, one record per (name, version): the table itself.

    The single source of truth, so a read never has to look at the install root:
    a directory nobody recorded is not a component of this host, and a recorded
    one stays listed even while its payload is being replaced. The disk is read
    ONCE, when there is no table at all — a host that has held components since
    before there was one — and what is found is written down, so the bootstrap
    happens once per machine rather than once per read.

    A read on a host with no root at all answers [] and creates nothing: reading
    is not installing, and a machine with no component directory has nothing.
    """
    with _TABLE_LOCK:
        stored = _read_table()
        if stored is not None:
            return stored
        scanned = _scan_entries()
        if root().is_dir():
            _write_table(scanned)
        return scanned


def reindex() -> list[dict[str, Any]]:
    """Rebuild the table from what the root actually holds, and answer with it.

    The deliberate counterpart of the bootstrap scan: a component directory put
    in the root by hand — a copy from another machine, a fixture in a test, a
    host whose table was lost — is not an install until the table says so. This
    forgets what the table believed and believes the disk instead, which is the
    only thing that may make a component appear out of nowhere.
    """
    with _TABLE_LOCK:
        scanned = _scan_entries()
        _write_table(scanned)
        return scanned


def disabled(name: str) -> bool:
    """True when this host holds `name` and is NOT to drive it.

    Here but not driven (see `set_disabled`): the bytes are untouched and the
    component stays listed, and the ONE thing this decides is whether its tools
    exist. `rendezvous.unavailable_reason` is where it bites, which is also what
    keeps a dev checkout from standing in for a component the user stopped —
    otherwise the worst pair there is: "disabled" in the page, and the tool still
    there because what ran was the checkout.
    """
    return any(str(record["name"]) == name and bool(record.get(DISABLED_FIELD)) for record in entries())


def set_disabled(name: str, state: bool = True) -> dict[str, Any]:
    """Stop driving `name`, or start driving it again — a verdict, and nothing else.

    The reverse verb that is not a removal: the bytes stay exactly where they are,
    the component stays in the inventory (marked), and the only thing that
    changes is whether this host offers its tools. Nothing here is irreversible,
    so nothing here is confirmed — an install rewrites bytes, a removal deletes
    them, this one just stops asking for them.

    VS Code keeps the same bit on the CLIENT (a storage key, nothing written into
    the extension directory); Clutch keeps it in the table of the machine that
    OWNS the component, because that is the machine a page is talking to and the
    one place installs are already recorded. A component this host does not hold
    is "absent" — an ANSWER, not an error: "make sure it is stopped here" is
    already true when it is not here at all, and the machine that was asked is
    simply not the machine that holds it.
    """
    _check_name(name)
    with _TABLE_LOCK:
        table = entries()
        held = [record for record in table if str(record["name"]) == name]
        if not held:
            return {"status": "absent", "name": name}
        for record in held:
            record[DISABLED_FIELD] = bool(state)
        _write_table(table)
    return {"status": "disabled" if state else "enabled", "name": name, DISABLED_FIELD: bool(state)}


def read_manifest(directory: Path | str) -> dict[str, Any] | None:
    """The manifest of an installed component directory, or None when there is
    none, it is not valid JSON, or it is missing a required field."""
    try:
        payload = json.loads((Path(directory) / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    for field in REQUIRED_FIELDS:
        if not isinstance(payload.get(field), str) or not payload[field]:
            return None
    return payload


def _resolve_records(
    name: str, records: list[dict[str, Any]]
) -> tuple[dict[str, Any], Path, dict[str, Any]] | None:
    """The winning table entry of ONE component, with its directory and manifest.

    Newest by the entry's own version string, not by directory mtime: an install
    is a copy of a directory tree, so its mtime says when the copy happened, not
    which artifact is newer. The manifest is still READ, because the manifest is
    what the host launches by (its `launch` shape, the tools it declares) — so a
    recorded version whose payload cannot be read is not resolvable: the table
    says this host holds it, and bytes nobody can read are not a component this
    host can run.

    Record, directory and manifest come back together because callers need more
    than one of them: `resolve` wants two, `inventory` wants the record's own
    `disabled`, the catalog wants the manifest.
    """
    if not records:
        return None
    record = max(records, key=lambda candidate: str(candidate["version"]))
    directory = _entry_directory(record)
    manifest = read_manifest(directory)
    if manifest is None or str(manifest["name"]) != name:
        return None
    return record, directory, manifest


def resolve(name: str) -> tuple[Path, dict[str, Any]] | None:
    """(directory, manifest) of the newest installed version of `name`, or None.

    Table-driven: WHICH versions this host holds is the table's answer, and this
    picks the newest of them. The manifest is returned WITH the directory it was
    resolved by — picking the winner means reading it, and every caller needs it
    (the host's launch, the catalog's declaration).
    """
    found = _resolve_records(name, [record for record in entries() if str(record["name"]) == name])
    return (found[1], found[2]) if found else None


def installed(name: str) -> Path | None:
    """The directory of the newest installed version of `name` (None: none is)."""
    resolved = resolve(name)
    return resolved[0] if resolved else None


def _held() -> list[tuple[dict[str, Any], Path, dict[str, Any]]]:
    """Every component installed for THIS host, resolved once each: the table
    entry that won, the directory it names, and the manifest it carries.

    One table read and one manifest read per component (resolve's own rule), in
    name order so every view built on it is deterministic. The record comes back
    with the rest because one of the facts a page is shown — `disabled` — lives
    in the table and nowhere else.
    """
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in entries():
        grouped.setdefault(str(record["name"]), []).append(record)
    out: list[tuple[dict[str, Any], Path, dict[str, Any]]] = []
    for name in sorted(grouped):
        found = _resolve_records(name, grouped[name])
        if found is not None:
            out.append(found)
    return out


def installed_records() -> list[tuple[str, Path, dict[str, Any]]]:
    """Every component installed for THIS host, resolved once each: its name, the
    version directory that resolves, and the manifest that directory carries.

    The two faces built on this (`inventory`, the catalog's registrations) are
    views of the same records, not two passes over the same files.
    """
    return [(str(record["name"]), directory, manifest) for record, directory, manifest in _held()]


def installed_version(name: str) -> str:
    """The version string of the resolved install ("" when nothing is installed)."""
    resolved = resolve(name)
    return str(resolved[1].get("version", "")) if resolved else ""


# -- the receiving half: what a client ships, and the gate it is measured by ---


def inventory() -> list[dict[str, Any]]:
    """Every component installed for THIS host, one record per name.

    This is what a client reads before it uploads anything: which components the
    host already holds, and at which version + digest. The gate is answered by
    the machine that would RUN the code, never assumed by the machine that ships
    it. A directory without a usable manifest is not an install and is not listed.

    `disabled` rides along because a page has to be able to say it: a component
    that is here and stopped is still HELD (it stays listed, with its bytes), and
    the flag is what separates "not installed" from "not driven".
    """
    return [
        {
            "name": str(record["name"]),
            "version": str(manifest.get("version", "")),
            "interface": str(manifest.get("interface", "")),
            "digest": str(manifest.get(DIGEST_FIELD, "")),
            DISABLED_FIELD: bool(record.get(DISABLED_FIELD, False)),
        }
        for record, _directory, manifest in _held()
    ]


def installed_digest(name: str) -> str:
    """The content digest recorded for the resolved install ("" when unknown).

    The client's half of the version gate: `current()` compares this against the
    digest of the artifact it holds, so a rebuild of the same version is not
    mistaken for the same artifact.
    """
    resolved = resolve(name)
    return str(resolved[1].get(DIGEST_FIELD, "")) if resolved else ""


def current(name: str, version: str, digest: str) -> bool:
    """True when this host already holds exactly that artifact.

    The version gate, keyed on CONTENT and not on the version string: the
    version is the client's claim, the digest is the bytes it would send, and
    only the pair means "nothing to upload". A component re-installed under the
    same version but different bytes (a rebuilt 0.2.0, a dev checkout that
    changed) is not current, so a stale install is replaced rather than kept.
    """
    if not digest:
        return False
    directory = installed(name)
    if directory is None:
        return False
    manifest = read_manifest(directory) or {}
    return str(manifest.get("version", "")) == str(version) and str(manifest.get(DIGEST_FIELD, "")) == digest


# -- the reverse verbs: what this host holds, version by version, and letting go


def versions(name: str) -> list[dict[str, Any]]:
    """Every version of `name` installed on THIS host, newest first ([]: none).

    The finer list `inventory()` is too coarse to give: the inventory names one
    record per component (the one `resolve()` would launch), while a machine can
    hold an older version beside it — and letting go is aimed at ONE version, so
    it has to be nameable. The order is `resolve()`'s own comparison (newest by
    the table's version string), so the first record is the one this host runs,
    and `resolved` marks exactly that one.

    Table-driven like every read here: the versions listed are the ones the table
    records, so a version whose directory has gone is still named — and letting
    go of it is how such a record is cleared (remove() drops the entry with the
    bytes). A name that could never be an install is refused rather than answered
    with []: the caller asked about something that cannot exist here, and an empty
    list would read as "not installed".
    """
    _check_name(name)
    records = [record for record in entries() if str(record["name"]) == name]
    if not records:
        return []
    resolved = resolve(name)
    resolved_directory = resolved[0] if resolved else None
    out: list[dict[str, Any]] = []
    for record in records:
        directory = _entry_directory(record)
        out.append(
            {
                "name": name,
                "version": str(record["version"]),
                "interface": str(record.get("interface", "")),
                "digest": str(record.get(DIGEST_FIELD, "")),
                "path": str(directory),
                "resolved": directory == resolved_directory,
                DISABLED_FIELD: bool(record.get(DISABLED_FIELD, False)),
            }
        )
    return sorted(out, key=lambda record: record["version"], reverse=True)


def remove(name: str, version: str = "", *, stop: Callable[[str], str] | None = None) -> dict[str, Any]:
    """Make this host hold less of `name`: drop ONE version, or all of them.

    A verdict, like every other write on this layer (`accept`): what was actually
    removed, so a page repeats the host's own sentence instead of assuming a
    delete landed. Three outcomes:

      - "removed" — the version directory (or the component's whole directory)
        is gone; `removed` lists the versions that were there
      - "absent" — a version-less removal of something this host does not hold.
        NOT an error: what was asked for ("make sure none of it is here") is
        already true, and an error would have a page report a problem that is
        not one.
      - ValueError — a name that could never be an install, or a `version` that
        names nothing installed here. Nothing could make such a request true, so
        it is refused with the reason, and nothing was touched.

    The removal is the directory the version resolves by, so it cannot be aimed
    at anything else on the filesystem. A version-less removal takes the
    component's own directory whole — every version, plus whatever a crashed
    install left staging inside it (`.installing` is inside that directory, not
    a second thing to remember).

    The bytes go FIRST and the table entry follows (the deviation the module
    docstring records): a version that is gone from the disk but still recorded
    would be a component the host believes it holds and cannot run — the whole
    reason there is a table — while an entry that outlives its bytes by a moment
    is only a directory the table names and the disk does not have (which
    `resolve` already refuses). A directory that will not go raises, and then
    nothing was forgotten either.

    `stop` is the one thing this module cannot know: whether a process of the
    component is RUNNING right now, which is not a filesystem fact (rendezvous
    owns it, and owns the rule about daemons this host did not start). It is
    called once, only when there is something to remove, and returns the
    sentence to refuse with ("" when the bytes may go) — so a refusal to remove
    happens BEFORE anything is signalled or deleted. Omitted, the caller is
    saying it has already dealt with that.
    """
    _check_name(name)
    if version:
        _check_version(version)
        present = {record["version"]: Path(record["path"]) for record in versions(name)}
        if version not in present:
            raise ValueError(f"{name} {version} is not installed on this host")
        victims = [present[version]]
        removed = [version]
    else:
        removed = [record["version"] for record in versions(name)]
        if not removed:
            # nothing recorded for it: "make sure none of it is here" is already
            # true. A directory left in the root without a table entry is not a
            # component of this host (see the module docstring), so this is
            # absent rather than a number to delete.
            return {"status": "absent", "name": name, "removed": []}
        victims = [component_root(name)]
    if stop is not None:
        refusal = stop(name)
        if refusal:
            raise ValueError(refusal)
    for victim in victims:
        if not victim.exists():
            continue  # the table named bytes that are already gone: the entry still goes
        try:
            shutil.rmtree(victim)
        except OSError as err:
            # the verdict is about what happened, so a directory that would not
            # go is reported and not answered with "removed"
            raise OSError(f"{victim} could not be removed: {err}") from err
    _forget(name, version if version else "")
    return {"status": "removed", "name": name, "removed": removed}


def _forget(name: str, version: str = "") -> None:
    """Drop the table's record of bytes that are no longer there.

    Called AFTER the directories are gone (remove's own order), so the table
    never claims less than the disk holds. `version` empty means the whole
    component: every version of it, exactly what a version-less removal took.
    """
    _update_table(
        lambda table: [
            record
            for record in table
            if not (str(record["name"]) == name and (not version or str(record["version"]) == version))
        ]
    )


def spool(stream: IO[bytes], length: int, name: str = "") -> Path:
    """Write an incoming body to a scratch file in the install root; the caller
    deletes it.

    Streamed in chunks rather than read whole: an artifact is a PyInstaller
    onefile (tens of megabytes) and the receiving host needs no more of it in
    memory than the hashing pass touches. `name` is the artifact's own file name
    when the uploader declared one — the shape of an artifact is read from its
    suffix (an archive is unpacked, anything else is one executable), so that
    name has to survive being spooled under a scratch name.

    A body that ends early is not an error here: `accept` refuses it on its
    digest, which is the same verdict a body that lied would get.
    """
    scratch = root() / SCRATCH
    scratch.mkdir(parents=True, exist_ok=True)
    suffixes = "".join(Path(name).suffixes) if name else ""
    fd, path = tempfile.mkstemp(dir=str(scratch), prefix="artifact-", suffix=suffixes)
    with os.fdopen(fd, "wb") as fh:
        remaining = max(int(length), 0)
        while remaining > 0:
            chunk = stream.read(min(CHUNK, remaining))
            if not chunk:
                break
            fh.write(chunk)
            remaining -= len(chunk)
    return Path(path)


def accept(artifact: Path | str, manifest: dict[str, Any]) -> dict[str, Any]:
    """Take one uploaded artifact into this host's install root, or refuse it.

    `manifest` is what the uploader CLAIMS (name, version, interface, the
    artifact's digest, plus whatever launch shape the artifact has); the
    artifact's bytes are what is true. Two verdicts, and a ValueError carrying
    the reason the caller reports as error-as-data:

      - this version + digest is already installed -> "current" (the version
        gate, so a reconnect does not re-upload 30 MB)
      - otherwise -> "installed", and the host resolves the component to it from
        now on (modules.component_dir prefers a resolvable install)

    The digest is checked FIRST and against the received bytes, because the
    manifest is what the host later resolves the component BY: installing bytes
    whose identity is only a claim would make every later launch a guess.
    """
    manifest = dict(manifest)
    name = str(manifest.get("name", ""))
    version = str(manifest.get("version", ""))
    declared = str(manifest.get(DIGEST_FIELD, ""))
    if not declared:
        raise ValueError(f"the install request declares no {DIGEST_FIELD}")
    if current(name, version, declared):
        return {"status": "current", "name": name, "version": version, "digest": declared}
    actual = digest(artifact)
    if actual != declared:
        raise ValueError(f"the artifact hashes to {actual}, not the declared {declared}")
    directory = install(artifact, manifest, version=version)
    return {
        "status": "installed",
        "name": name,
        "version": version,
        "digest": declared,
        "path": str(directory),
    }


def verify(directory: Path | str, *, name: str, interface: str) -> str:
    """Why this host must NOT use the component installed at `directory` ("" when
    it may).

    The host's table is the frozen contract (R4); the manifest is what the
    installer recorded. When they disagree about which component this is or how
    it is spoken to, the artifact is not the one the host asked for — refusing
    to use it is the only safe answer, and it is a sentence the caller can show.
    """
    manifest = read_manifest(directory)
    if manifest is None:
        return f"{directory} is not an installed component (no usable {MANIFEST})"
    if manifest["name"] != name:
        return f"installed component is {manifest['name']!r}, expected {name!r}"
    if manifest["interface"] != interface:
        return (
            f"the installed {name} is a {manifest['interface']} component, "
            f"this host speaks to it as a {interface}"
        )
    return ""


def digest(path: Path | str) -> str:
    """The sha256 of a file — the client's content-hash version gate, the same
    idea the server bundle uses (ui/server-bundle.js)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def digest_of(data: bytes) -> str:
    """The sha256 of bytes held in memory — what a client hashes before it
    uploads, and what the host checks the received body against."""
    return hashlib.sha256(data).hexdigest()


def install(artifact: Path | str, manifest: dict[str, Any], *, version: str | None = None) -> Path:
    """Lay one component artifact down for this host, atomically.

    `artifact` is a single file: an archive (unpacked in place) or an executable
    (installed as <name> and marked +x) — the two shapes a client can deliver
    without needing anything else on the host. The installed `component.json` is
    the request's `manifest` merged over the artifact's own (see
    _merge_declaration: an archive that carries its declaration lands whole, a
    thin header is enough for it); `version` overrides the record's version
    field (a caller that gates on a content hash puts the hash here).

    The install happens in a sibling `.installing` directory that is renamed into
    place at the end, so a version directory is either complete or absent — a
    reader never resolves a half-written component. Running installs of the same
    version replace each other, and every OTHER version of that component is
    dropped: a host runs one version, so a leftover could only be something
    resolution might pick instead (the newest by version string, which is
    arbitrary for the content-hash versions a client installs).

    The table learns what the disk now holds LAST (see the module docstring's
    order): the entry is written only after the bytes are in place and the other
    versions are gone, so a failed install leaves the table saying exactly what
    is still there. The one bit that is NOT about bytes — `disabled` — rides
    across: it belongs to the component, not to a version, so reinstalling what a
    user stopped does not quietly start driving it again.
    """
    artifact = Path(artifact)
    name = str(manifest.get("name", ""))
    ver = str(version or manifest.get("version", ""))
    _check_name(name)
    _check_version(ver)
    interface = str(manifest.get("interface", ""))
    if interface not in INTERFACES:
        raise ValueError(f"manifest declares interface {interface!r}, expected one of {INTERFACES}")
    if not artifact.is_file():
        raise ValueError(f"artifact is not a file: {artifact}")

    record = {**manifest, "name": name, "version": ver}
    target = component_root(name) / ver
    staging = target.with_name(target.name + ".installing")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    try:
        if artifact.name.endswith(ARCHIVE_SUFFIXES):
            _unpack(artifact, staging)
            record = _merge_declaration(staging, record)
        else:
            # a single-file artifact (a PyInstaller onefile, a script): the
            # component's own name is the executable the manifest may name
            exe = staging / name
            shutil.copyfile(artifact, exe)
            exe.chmod(exe.stat().st_mode | 0o755)
        # the installed record is what the host later resolves the component BY
        # (catalog.registrations reads it back), so it is the declaration of
        # record: the wire manifest plus whatever the artifact itself declared
        (staging / MANIFEST).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        shutil.rmtree(target, ignore_errors=True)
        staging.rename(target)
        _prune(name, keep=target)
        _remember(target, record)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return target


def _remember(directory: Path, manifest: dict[str, Any]) -> None:
    """Record one installed version in the table (see the module docstring).

    Called AFTER the bytes are in place and the older versions are gone, and the
    entry REPLACES any record of the same (name, version) — an install of a
    version this host already had is the same component at the same version, so a
    second entry would only be a way to name the same directory twice. What a
    name carries across versions is its `disabled` bit: stopping a component is
    about the component, so an install (a rebuilt 0.1.0, a newer release) does not
    turn it back on by itself.
    """
    name = str(manifest["name"])
    version = str(manifest["version"])

    def mutate(table: list[dict[str, Any]]) -> list[dict[str, Any]]:
        stopped = any(str(record["name"]) == name and bool(record.get(DISABLED_FIELD)) for record in table)
        kept = [
            record
            for record in table
            if not (str(record["name"]) == name and str(record["version"]) == version)
        ]
        return [*kept, _entry(name, version, directory, manifest, disabled=stopped)]

    _update_table(mutate)


def _merge_declaration(staging: Path, wire: dict[str, Any]) -> dict[str, Any]:
    """The installed record: the artifact's own declaration, refined by the
    request's facts.

    A component's declaration travels WITH it (COMPONENTS.md): an archive that
    carries its own component.json declares its tools, its launch shape and its
    UI block, and the header the client sent needs to carry only the install
    facts — so a thin header over a declaring artifact still lands a component
    the host can drive. The header wins on every field it names (it is what the
    digest was measured for); a package manifest naming a DIFFERENT component is
    a refusal rather than a merge, because the bytes are then not the component
    the request said they were. A missing or malformed package manifest is
    simply no declaration, and the wire manifest stands alone.
    """
    try:
        declared = json.loads((staging / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        declared = None
    if not isinstance(declared, dict):
        return wire
    inner = str(declared.get("name", ""))
    if inner and inner != str(wire.get("name", "")):
        raise ValueError(f"the artifact declares itself as {inner!r}, not {wire.get('name')!r}")
    return {**declared, **wire}


def _prune(name: str, keep: Path) -> None:
    """Remove every installed version of `name` except `keep` (best effort), and
    forget the versions whose bytes went with them.

    A host runs one version, so the others are not "older releases it could go
    back to" — they are directories resolution might pick instead, and the same
    is true of their table entries.
    """
    kept = keep.name
    for child in component_root(name).iterdir():
        if child != keep:
            shutil.rmtree(child, ignore_errors=True)
    _update_table(
        lambda table: [
            record
            for record in table
            if not (str(record["name"]) == name and str(record["version"]) != kept)
        ]
    )


def _unpack(archive: Path, into: Path) -> None:
    """Unpack an archive into `into`, refusing members that escape it.

    A component artifact is whatever the client uploaded, so member names are
    untrusted input: an absolute path or a `..` would write outside the
    component's own directory. Refuse the whole archive rather than skip members
    — a component that tried is not a component to install."""
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for member in zf.namelist():
                _refuse_escape(member)
            zf.extractall(into)
        return
    with tarfile.open(archive) as tf:
        for member in tf.getmembers():
            _refuse_escape(member.name)
            if member.issym() or member.islnk():
                _refuse_escape(os.path.join(os.path.dirname(member.name), member.linkname))
        tf.extractall(into)


def _refuse_escape(member: str) -> None:
    norm = os.path.normpath(member.replace("\\", "/"))
    if norm.startswith("/") or norm == ".." or norm.startswith("../"):
        raise ValueError(f"artifact member escapes the component directory: {member!r}")
