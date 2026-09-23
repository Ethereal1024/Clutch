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
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tarfile
import zipfile
from pathlib import Path
from typing import Any

MANIFEST = "component.json"
ROOT_ENV = "CLUTCH_COMPONENTS_DIR"  # repoints the whole root (tests, unusual layouts)
ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".tar", ".zip")

# A component's identity and its version string both end up in a path, so both
# are restricted to the shapes an install may name. The version may carry a
# content digest (`0.2.0+<hex>`), which is how the client's install gate works.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")

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


def installed(name: str) -> Path | None:
    """The newest installed version of `name` that carries a valid manifest.

    Newest by the manifest's own version string, not by directory mtime: an
    install is a copy of a directory tree, so its mtime says when the copy
    happened, not which artifact is newer. A directory without a manifest is
    not an installed component (a half-finished install, a stray directory, a
    checkout that happens to sit here) and is never resolved.
    """
    base = component_root(name)
    if not base.is_dir():
        return None
    found: list[tuple[str, Path]] = []
    for child in base.iterdir():
        if not child.is_dir() or child.name.endswith(".installing"):
            continue
        manifest = read_manifest(child)
        if manifest is None or manifest["name"] != name:
            continue
        found.append((str(manifest["version"]), child))
    if not found:
        return None
    return max(found)[1]


def installed_version(name: str) -> str:
    """The version string of the resolved install ("" when nothing is installed)."""
    directory = installed(name)
    if directory is None:
        return ""
    manifest = read_manifest(directory) or {}
    return str(manifest.get("version", ""))


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


def install(artifact: Path | str, manifest: dict[str, Any], *, version: str | None = None) -> Path:
    """Lay one component artifact down for this host, atomically.

    `artifact` is a single file: an archive (unpacked in place) or an executable
    (installed as <name> and marked +x) — the two shapes a client can deliver
    without needing anything else on the host. `manifest` becomes the installed
    `component.json`; `version` overrides its version field (a caller that gates
    on a content hash puts the hash here).

    The install happens in a sibling `.installing` directory that is renamed into
    place at the end, so a version directory is either complete or absent — a
    reader never resolves a half-written component. Running installs of the same
    version replace each other.
    """
    artifact = Path(artifact)
    name = str(manifest.get("name", ""))
    ver = str(version or manifest.get("version", ""))
    if not _NAME_RE.match(name):
        raise ValueError(f"bad component name: {name!r}")
    if not _VERSION_RE.match(ver):
        raise ValueError(f"bad component version: {ver!r}")
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
        else:
            # a single-file artifact (a PyInstaller onefile, a script): the
            # component's own name is the executable the manifest may name
            exe = staging / name
            shutil.copyfile(artifact, exe)
            exe.chmod(exe.stat().st_mode | 0o755)
        (staging / MANIFEST).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        shutil.rmtree(target, ignore_errors=True)
        staging.rename(target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return target


def uninstall(name: str, version: str | None = None) -> None:
    """Remove one installed version, or every version of a component."""
    base = component_root(name)
    if version is None:
        shutil.rmtree(base, ignore_errors=True)
        return
    if not _VERSION_RE.match(version):
        raise ValueError(f"bad component version: {version!r}")
    shutil.rmtree(base / version, ignore_errors=True)


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
