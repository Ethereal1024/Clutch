"""The install layer's receiving half: landing dir, version gate, wire contract.

Run: .venv/bin/python -m tests.components_api_test

A component belongs to the machine its server runs on, so the supervisor of that
machine is what a client installs ONTO. This suite pins the two answers a client
acts on — what is already here (GET /api/components) and whether an upload was
taken (POST /api/components/install) — plus the discipline that makes the gate
trustworthy: the artifact's DIGEST decides, never the manifest's claim, and a
body that lies or ends early leaves the host exactly as it was.

The artifact reaches a host two ways, and both go through that one gate: the
request's body (a client that alone holds the bytes — a checkout, a prebuilt
artifact) or an `artifact_url` the host fetches FOR ITSELF, which is the default
because the machine that will run the bytes is the one that needs them
(PLUGIN_PLAN.md 零之四.4). The fetch is exercised over a real socket, not a patched
`urlopen`: only http(s) is spoken, the response is capped and never read whole,
and what arrives is weighed against the declared digest like any other body.

It also pins the reverse half, which answers the same way (a verdict, or the
host's own sentence as error-as-data): what versions this machine holds
(GET /api/components/versions), and letting one go (DELETE /api/components/…),
which refuses to delete a component's bytes while a daemon of it is running that
this process did not start — nothing goes out from under a running process, and
nothing is signalled or deleted on the way to a refusal. The third verb changes
no bytes at all (POST /api/components/<name>/disable|enable): it decides whether
this machine DRIVES the component, which is why it lives in the same table the
installs are recorded in, and why a component this machine does not hold is
answered `absent` rather than refused.

It also pins the table itself — `<root>/registry.json`, the single source of
truth for what this host holds: a component directory placed in the root by hand
is not an install until the table says so (`reindex()` is the deliberate way back
to the disk), and a read on a host with no root creates nothing.

Isolation: CLUTCH_COMPONENTS_DIR points at a temp root, so the run never touches
the components installed for the user running it.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agent.supervisor import Supervisor, build_server
from agent.tools import catalog, components, modules, rendezvous
from tests.testsupport import check, http_get

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache"}


def _post_artifact(base: str, name: str, data: bytes, *, digest: str, artifact: str = "", **extra) -> tuple[int, str]:
    """One install request, exactly as a client sends it: manifest in the header
    (base64 of the JSON's UTF-8 bytes — components.manifest_from_header's contract),
    artifact as the body."""
    manifest = {"name": name, "version": digest[:16], "interface": "cli", "digest": digest, **extra}
    if artifact:
        manifest["artifact"] = artifact
    header = base64.b64encode(json.dumps(manifest).encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        f"{base}/api/components/install",
        data=data,
        headers={components.MANIFEST_HEADER: header, "Content-Type": "application/octet-stream"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _post_manifest(base: str, name: str, *, digest: str, data: bytes = b"", **extra) -> tuple[int, str]:
    """One install request that carries NO bytes: the manifest in the header names
    the artifact's URL (`artifact_url`) and the host fetches it for itself. This is
    the default shape of an install (PLUGIN_PLAN.md 零之四.4); `_post_artifact`
    above is the fallback, for when the client alone holds the bytes."""
    manifest = {"name": name, "version": digest[:16], "interface": "cli", "digest": digest, **extra}
    header = base64.b64encode(json.dumps(manifest).encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        f"{base}/api/components/install",
        data=data,
        headers={components.MANIFEST_HEADER: header},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


class _SilentFiles(SimpleHTTPRequestHandler):
    """A file server that does not narrate: this suite's output is its checks."""

    def log_message(self, *args) -> None:
        pass


def _serve(directory: Path) -> tuple[str, ThreadingHTTPServer]:
    """A throwaway HTTP file server over `directory`, the stand-in for a release
    host: the fetch path is then exercised over a real socket — a real URL, a real
    response, the real 404 — rather than against a patched urlopen."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(_SilentFiles, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}", server


def _delete(url: str) -> tuple[int, str]:
    """One removal request, exactly as a client sends it: the verb carries the
    component's name in the path, `?version=` names one version to drop."""
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _post_verb(url: str) -> tuple[int, str]:
    """One state request, exactly as a client sends it: the verb names the
    component and the state in the path and carries no body at all — there is
    nothing to send for a switch that touches no bytes."""
    req = urllib.request.Request(url, data=b"", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _sleeper() -> subprocess.Popen:
    """A live pid nothing in this suite owns: the stand-in for a daemon."""
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


def _entries_of(records: list[dict]) -> list[tuple[str, str]]:
    """The identity of each table entry, without the fields under test: which
    component it names and which of its versions this host believes it holds."""
    return [(str(record["name"]), str(record["version"])) for record in records]


def _tar_checkout(name: str, into: Path) -> Path:
    """A dev-mode artifact: the checkout, archived at its top level (the shape a
    client with no prebuilt onefile has to send)."""
    src = modules.module_dir(name)
    out = into / f"{name}.tar.gz"
    with tarfile.open(out, "w:gz") as tf:
        for path in sorted(src.rglob("*")):
            rel = path.relative_to(src)
            if any(part in SKIP_DIRS for part in rel.parts) or path.suffix == ".pyc":
                continue
            tf.add(path, arcname=str(rel))
    return out


def main() -> int:
    root = tempfile.mkdtemp(prefix="clutch-components-")
    os.environ[components.ROOT_ENV] = root
    sup = None
    try:
        # 1. nothing installed, so nothing to report and nothing current
        check(components.inventory() == [], "a fresh host has no components installed")
        check(not components.current("clutch-memory", "1.0.0", "0" * 64), "nothing is current before an install")

        # 2. the wire contract, minus HTTP: claims are checked against the bytes
        blob = b"#!/bin/sh\nexit 0\n"
        digest = components.digest_of(blob)
        artifact = Path(root) / "spooled"
        artifact.write_bytes(blob)
        try:
            components.accept(artifact, {"name": "clutch-memory", "version": "1.0.0", "interface": "cli"})
            check(False, "an install with no declared digest is refused")
        except ValueError as err:
            check("declares no digest" in str(err), "an install with no declared digest is refused")
        try:
            components.accept(
                artifact,
                {"name": "clutch-memory", "version": "1.0.0", "interface": "cli", "digest": "0" * 64},
            )
            check(False, "bytes that do not match the declared digest are refused")
        except ValueError as err:
            check("hashes to" in str(err), "bytes that do not match the declared digest are refused")
        check(components.installed("clutch-memory") is None, "a refused install landed nothing")

        first = components.accept(
            artifact, {"name": "clutch-memory", "version": "1.0.0", "interface": "cli", "digest": digest}
        )
        check(first["status"] == "installed", "an artifact whose digest matches is installed")
        check(components.installed_version("clutch-memory") == "1.0.0", "the host resolves the installed version")
        check(components.current("clutch-memory", "1.0.0", digest), "and it is current for that digest")
        check(not components.current("clutch-memory", "1.0.0", "0" * 64), "a different digest is not current")
        again = components.accept(
            artifact, {"name": "clutch-memory", "version": "1.0.0", "interface": "cli", "digest": digest}
        )
        check(again["status"] == "current", "the same version + digest is the gate: nothing to check")

        # 3. the version string is the client's claim, the content is the fact: a
        #    REBUILT 1.0.0 replaces the old one instead of being skipped
        blob2 = blob + b"# rebuilt\n"
        artifact.write_bytes(blob2)
        second = components.accept(
            artifact,
            {"name": "clutch-memory", "version": "1.0.0", "interface": "cli", "digest": components.digest_of(blob2)},
        )
        check(second["status"] == "installed", "the same version with different bytes is replaced")
        check(
            components.installed_digest("clutch-memory") == components.digest_of(blob2),
            "the digest follows the bytes",
        )
        check(
            (Path(second["path"]) / "clutch-memory").read_bytes() == blob2,
            "a single-file artifact lands named after its component",
        )
        check(components.inventory() == [
            {
                "name": "clutch-memory",
                "version": "1.0.0",
                "interface": "cli",
                "digest": components.digest_of(blob2),
                "disabled": False,
            }
        ], "the inventory is the manifest's claims plus the install's real digest")

        # 3c. the table itself: what this host believes it holds is a FILE, not a
        #     walk of the root, and it says where each payload is (relative, so the
        #     whole root can be repointed without rewriting it).
        table = json.loads((Path(root) / components.REGISTRY).read_text(encoding="utf-8"))
        check(
            table["schema"] == components.REGISTRY_SCHEMA and len(table["components"]) == 1,
            "one install leaves one entry in this host's table",
        )
        entry = table["components"][0]
        check(
            entry["name"] == "clutch-memory"
            and entry["version"] == "1.0.0"
            and entry[components.DISABLED_FIELD] is False
            and entry[components.LOCATION_FIELD] == "clutch-memory/1.0.0",
            "the entry names the component, its version, whether it is driven, and its payload's place",
        )
        check(
            _entries_of(components.entries()) == [("clutch-memory", "1.0.0")],
            "and entries() answers straight out of it",
        )
        # the table is the truth: a directory nobody recorded is NOT an install,
        # even though the manifests in it are perfectly readable
        planted = components.component_root("clutch-planted") / "1.0.0"
        planted.mkdir(parents=True)
        (planted / components.MANIFEST).write_text(
            json.dumps({"name": "clutch-planted", "version": "1.0.0", "interface": "cli"}),
            encoding="utf-8",
        )
        check(
            components.installed("clutch-planted") is None and not components.versions("clutch-planted"),
            "a component directory nobody recorded is not an install: the table is what says so",
        )
        check(
            _entries_of(components.reindex()) == [("clutch-memory", "1.0.0"), ("clutch-planted", "1.0.0")],
            "reindex() is the deliberate way back to the disk, and it finds both",
        )
        check(
            components.installed("clutch-planted") is not None,
            "after which the planted component IS one this host holds",
        )
        components.remove("clutch-planted")

        # 3b. the version a CLIENT sends is `<the component's own>+<digest16>`:
        #     the client records a version it can list, and the host reads the
        #     shape it has always read (_VERSION_RE). It has to be a legal install
        #     name AND it has to come back out of the inventory unchanged, because
        #     a page lists what this function returns.
        blob3 = blob + b"# the composite version\n"
        composite_artifact = Path(root) / "composite"
        composite_artifact.write_bytes(blob3)
        composite = f"0.1.0+{components.digest_of(blob3)[:16]}"
        third = components.accept(
            composite_artifact,
            {
                "name": "clutch-memory",
                "version": composite,
                "interface": "cli",
                "digest": components.digest_of(blob3),
            },
        )
        check(third["status"] == "installed", "a version carrying its own content digest installs")
        check(components.installed_version("clutch-memory") == composite, "and the host resolves it by that version")
        check(
            components.component_root("clutch-memory").joinpath(composite).is_dir(),
            "the version is a legal directory name, whatever rides after the +",
        )
        check(
            sorted(d.name for d in components.component_root("clutch-memory").iterdir() if d.is_dir()) == [composite],
            "one machine, one version: installing it replaced the bare-digest directory",
        )
        check(
            components.installed_digest("clutch-memory") == components.digest_of(blob3),
            "and the digest stays the content's own, not the version's tail",
        )

        # 4. an interface the host's table cannot hold is refused before it lands
        try:
            components.accept(
                artifact,
                {
                    "name": "clutch-memory",
                    "version": "2.0.0",
                    "interface": "telepathy",
                    "digest": components.digest_of(blob2),
                },
            )
            check(False, "a manifest with an unknown interface is refused")
        except ValueError as err:
            check("interface" in str(err), "a manifest with an unknown interface is refused")

        # 5. spool: a body is streamed to scratch space, and its name's suffixes
        #    survive (the install layer tells an archive from an executable by them)
        body = os.urandom(components.CHUNK + 4096)
        spooled = components.spool(_Reader(body), len(body), name="clutch-skills-1.0.0.tar.gz")
        try:
            check(spooled.read_bytes() == body, "a body larger than one chunk arrives byte for byte")
            check(spooled.name.endswith(".tar.gz"), "the artifact's suffix survives being spooled")
        finally:
            spooled.unlink()
        short = components.spool(_Reader(b"half"), 99)
        try:
            check(short.read_bytes() == b"half", "a body that ends early is kept for the digest to judge")
        finally:
            short.unlink()

        # 6. a checkout, archived: the shape a client sends when it has no
        #    prebuilt onefile. Landing it must make the host RUN it — the whole
        #    point of a landing dir is that resolution finds it there.
        tar = _tar_checkout(modules.MEMORY, Path(root))
        digest_ws = components.digest(tar)
        result = components.accept(
            tar,
            {
                "name": modules.MEMORY,
                "version": digest_ws[:16],
                "interface": catalog.CLI,
                "digest": digest_ws,
                "artifact": tar.name,
            },
        )
        check(result["status"] == "installed", "an archived checkout installs too")
        resolved = rendezvous.resolve(modules.MEMORY)
        check(
            resolved is not None and resolved.installed and resolved.directory == Path(result["path"]),
            "the host resolves the component to the installed artifact, not to a checkout",
        )
        check(
            resolved.argv == (modules.python_exe(), str(resolved.directory / "memory.py")),
            "and the launch template reads the entry point out of the install",
        )
        # the checkout archives its own component.json, so the landed record is
        # the artifact's declaration with the request's install facts on top —
        # a host that never saw the checkout still receives a whole component
        declared = components.read_manifest(Path(result["path"]))
        check(
            declared is not None and "save_memory" in {t.get("name") for t in declared.get("tools", [])},
            "a declaring archive lands whole: the artifact's own manifest is the record",
        )
        check(
            declared.get("version") == digest_ws[:16] and declared.get("digest") == digest_ws,
            "the request's install facts sit on top of the artifact's declaration",
        )
        foreign = Path(root) / "foreign-src"
        foreign.mkdir()
        (foreign / components.MANIFEST).write_text(
            json.dumps({"name": "clutch-a", "version": "1.0.0", "interface": "cli"}), encoding="utf-8"
        )
        foreign_tar = Path(root) / "foreign.tar.gz"
        with tarfile.open(foreign_tar, "w:gz") as tf:
            tf.add(foreign / components.MANIFEST, arcname=components.MANIFEST)
        try:
            components.install(foreign_tar, {"name": "clutch-b", "version": "1.0.0", "interface": "cli"})
            check(False, "an artifact declaring a DIFFERENT component is refused")
        except ValueError as err:
            check("declares itself" in str(err), "an artifact declaring a different component is refused")

        # 7. the HTTP face: the same two answers a client acts on. A real
        #    supervisor, so the wiring is exercised and not just the functions.
        sup = Supervisor(agent_cmd=[sys.executable, "-m", "agent.server"], cwd=str(ROOT), reap_interval_s=0.2)
        srv = build_server(0, sup)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"

        st, body_json = http_get(f"{base}/api/components")
        listed = json.loads(body_json)["components"]
        check(
            st == 200 and {c["name"] for c in listed} == {modules.MEMORY},
            "GET /api/components lists the host's installs",
        )
        check(
            all(c["digest"] for c in listed),
            "every listed component carries the digest the client's gate compares",
        )

        st, body_json = _post_artifact(base, "clutch-memory", blob, digest=digest)
        check(
            st == 200 and json.loads(body_json)["status"] == "installed",
            "an upload is taken and answered with a verdict",
        )
        st, body_json = _post_artifact(base, "clutch-memory", blob, digest=digest)
        check(st == 200 and json.loads(body_json)["status"] == "current", "re-uploading what is installed is a no-op")
        check(
            [d.name for d in components.component_root(modules.MEMORY).iterdir()] == [digest[:16]],
            "one component, one version: the replaced install is dropped, not piled up",
        )
        st, body_json = _post_artifact(
            base, "clutch-websearch", blob2, digest=components.digest_of(blob2), artifact="clutch-websearch"
        )
        check(st == 200 and json.loads(body_json)["status"] == "installed", "a second component installs the same way")
        check(
            components.installed_version("clutch-websearch") == components.digest_of(blob2)[:16],
            "the version is the client's",
        )
        st, body_json = _post_artifact(base, "clutch-websearch", blob2, digest=components.digest_of(blob2))
        check(st == 200 and json.loads(body_json)["status"] == "current", "the second upload is gated out")

        st, body_json = _post_artifact(base, "clutch-skills", blob2, digest="0" * 64)
        check(st == 400 and "hashes to" in json.loads(body_json)["error"], "a lying upload is refused with a reason")
        check(components.installed("clutch-skills") is None, "and it landed nothing")

        req = urllib.request.Request(
            f"{base}/api/components/install",
            data=blob,
            headers={"Content-Type": "application/octet-stream"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=15)
            check(False, "an install with no manifest header is refused")
        except urllib.error.HTTPError as e:
            check(e.code == 400, "an install with no manifest header is refused")

        scratch = components.root() / components.SCRATCH
        check(list(scratch.iterdir()) == [], "no spooled body is left behind")
        listed = json.loads(http_get(f"{base}/api/components")[1])["components"]
        check(
            {c["name"] for c in listed} == {modules.MEMORY, modules.WEBSEARCH},
            "the inventory grew by each install and by neither refusal",
        )

        # 7b. the other way an artifact arrives (PLUGIN_PLAN.md 零之四.4): a request
        #     with NO body that names the URL its bytes are at, so the machine that
        #     will RUN them fetches them itself. The gate afterwards is the same one
        #     — the digest the request declared is measured against what arrived —
        #     so a URL is the default way the bytes get here, not a way around the
        #     version gate, and the direction a request came from changes nothing
        #     downstream of `receive`.
        served = Path(root) / "served"
        served.mkdir(parents=True, exist_ok=True)
        local_file = served / "clutch-remote"
        local_file.write_bytes(b"#!/bin/sh\necho remote\n")
        filesource, files = _serve(served)
        remote_digest = components.digest_of(local_file.read_bytes())
        try:
            st, body_json = _post_manifest(
                base,
                "clutch-remote",
                digest=remote_digest,
                artifact="clutch-remote",
                artifact_url=f"{filesource}/clutch-remote",
            )
            check(
                st == 200 and json.loads(body_json)["status"] == "installed",
                "a body-less request that names a URL is installed: this host fetched the bytes itself",
            )
            landed = components.installed("clutch-remote")
            check(
                landed is not None and (landed / "clutch-remote").read_bytes() == local_file.read_bytes(),
                "and what landed is exactly what the URL served",
            )
            check(
                list((components.root() / components.SCRATCH).iterdir()) == [],
                "the fetch left no scratch file behind",
            )
            st, body_json = _post_manifest(
                base,
                "clutch-remote",
                digest=remote_digest,
                artifact="clutch-remote",
                artifact_url=f"{filesource}/clutch-remote",
            )
            check(
                st == 200 and json.loads(body_json)["status"] == "current",
                "and asking again is gated out on the digest this machine already holds",
            )

            st, body_json = _post_manifest(
                base,
                "clutch-remote",
                digest="0" * 64,
                artifact="clutch-remote",
                artifact_url=f"{filesource}/clutch-remote",
            )
            check(
                st == 400 and "hashes to" in json.loads(body_json)["error"],
                "fetched bytes that do not hash to the declared digest are refused: the pin is the gate, not the URL",
            )
            st, body_json = _post_manifest(
                base,
                "clutch-remote",
                digest=remote_digest,
                artifact="clutch-remote",
                artifact_url=f"file://{local_file}",
            )
            check(
                st == 400 and "http(s)" in json.loads(body_json)["error"],
                "a file: URL is refused: the install endpoint is not a way to read this host's own disk",
            )
            st, body_json = _post_manifest(base, "clutch-remote", digest=remote_digest, artifact="clutch-remote")
            check(
                st == 400 and "no artifact" in json.loads(body_json)["error"],
                "a request with neither a body nor a URL has nothing to install",
            )
            check(
                components.installed("clutch-remote") is not None,
                "and not one of those refusals touched what is already installed",
            )

            # the cap and the timeout are what keep a fetch from being a way to
            # fill this host's disk or wedge its request thread. Both live in
            # components.download, so they are pinned there, against the same real
            # server: one artifact past the cap, and one URL that is not there.
            cap = 1 << 20
            (served / "too-big").write_bytes(b"x" * (2 * cap))
            try:
                components.download(f"{filesource}/too-big", limit=cap)
                check(False, "an artifact past the cap is refused rather than spooled")
            except ValueError as err:
                check("larger than 1 MiB" in str(err), "an artifact past the cap is refused, in the cap's own words")
            try:
                components.download(f"{filesource}/not-here")
                check(False, "a URL that answers 404 is refused rather than installed")
            except OSError as err:
                check("404" in str(err), "a URL that answers 404 is refused rather than installed")
            check(
                list((components.root() / components.SCRATCH).iterdir()) == [],
                "and neither refusal leaves a half-written file in the scratch directory",
            )

            st, body_json = _delete(f"{base}/api/components/clutch-remote")
            check(
                st == 200 and json.loads(body_json)["status"] == "removed",
                "a component that arrived by URL is removable like any other",
            )
        finally:
            files.shutdown()

        # 8. the reverse verbs. Library first: a host can hold more than one
        #    version (an install prunes, but nothing forces a machine to hold only
        #    what one install made), and letting go is aimed at ONE of them.
        #    The versions below are put in the root BY HAND, so the table has to
        #    be told to believe the disk (reindex): a directory nobody recorded is
        #    not an install, which is exactly what 3c pinned.
        hand = components.component_root("clutch-handmade")
        for ver in ("1.0.0", "2.0.0"):
            (hand / ver).mkdir(parents=True)
            (hand / ver / components.MANIFEST).write_text(
                json.dumps({"name": "clutch-handmade", "version": ver, "interface": "cli", "digest": ver * 8}),
                encoding="utf-8",
            )
        components.reindex()
        held = components.versions("clutch-handmade")
        check(
            [record["version"] for record in held] == ["2.0.0", "1.0.0"],
            "versions() lists every installed version, newest first",
        )
        check(held[0]["resolved"] and not held[1]["resolved"], "and marks the one this host would launch")
        check(components.installed_version("clutch-handmade") == "2.0.0", "which is the version a launch resolves to")
        check(components.versions("clutch-nothing-installed") == [], "a component this host does not hold has no versions")
        refused = 0
        for bad in ("../escape", ".hidden", ""):
            try:
                components.versions(bad)
            except ValueError:
                refused += 1
        check(refused == 3, "a name that could never be an install is refused, not answered with an empty list")

        dropped = components.remove("clutch-handmade", "1.0.0")
        check(
            dropped == {"status": "removed", "name": "clutch-handmade", "removed": ["1.0.0"]},
            "removing one version is a verdict, not an assumption that it worked",
        )
        check(
            components.installed_version("clutch-handmade") == "2.0.0",
            "and what the host runs is untouched by a stale version going away",
        )
        try:
            components.remove("clutch-handmade", "9.9.9")
            check(False, "a version this host does not hold is refused")
        except ValueError as err:
            check("is not installed on this host" in str(err), "a version this host does not hold is refused")
        check(hand.is_dir(), "and a refused removal deleted nothing")
        try:
            components.remove("clutch-handmade", stop=lambda _name: "it is running")
            check(False, "the caller's refusal stops the removal")
        except ValueError as err:
            check(
                "it is running" in str(err) and hand.is_dir(),
                "the caller's refusal (a process of it is running) lands BEFORE anything is deleted",
            )
        whole = components.remove("clutch-handmade")
        check(
            whole["status"] == "removed" and whole["removed"] == ["2.0.0"],
            "a version-less removal takes the component whole",
        )
        check(
            components.installed("clutch-handmade") is None and not hand.exists(),
            "which is the component's own directory gone, staging and all",
        )
        check(
            components.remove("clutch-handmade") == {"status": "absent", "name": "clutch-handmade", "removed": []},
            "removing what is not installed is absent, not an error",
        )

        # 8b. the one thing the filesystem cannot say: is any of it RUNNING. Ours
        #     is stopped first (stop-then-delete); another process's daemon is a
        #     refusal, and its bytes stay. The discovery directory is repointed so
        #     this suite can neither see nor disturb the daemons of the machine it
        #     runs on.
        workspace_mod = catalog.table()[modules.WORKSPACE]
        check(
            workspace_mod.discovery_env and workspace_mod.interface == catalog.DAEMON,
            "the fixture is a daemon component with a repointable discovery directory",
        )
        os.environ[workspace_mod.discovery_env] = str(Path(root) / "discovery")
        try:
            ours = _sleeper()
            key = (modules.WORKSPACE, str(Path(root) / "workspace"))
            with rendezvous._LOCK:
                rendezvous._HANDLES[key] = rendezvous.Handle(
                    service=rendezvous.Service(module=modules.WORKSPACE, port=1234, token="t", pid=ours.pid),
                    fences=(),
                    proc=ours,
                )
            check(rendezvous.stop_for_removal(modules.WORKSPACE) == "", "a daemon of ours is stopped, not refused")
            check(
                ours.poll() is not None and key not in rendezvous._HANDLES,
                "and it really is stopped and forgotten before any byte would go",
            )

            st, body_json = _post_artifact(base, modules.WORKSPACE, blob, digest=digest, interface="daemon")
            check(
                st == 200 and json.loads(body_json)["status"] == "installed",
                "a daemon component installs through the same endpoint as a one-process one",
            )
            foreign = _sleeper()
            record = rendezvous._record_path(str(Path(root) / "elsewhere"), workspace_mod)
            try:
                record.parent.mkdir(parents=True, exist_ok=True)
                record.write_text(
                    json.dumps({"version": rendezvous.RECORD_VERSION, "port": 4321, "token": "t", "pid": foreign.pid}),
                    encoding="utf-8",
                )
                check(
                    [service.pid for service in rendezvous.live_daemons(modules.WORKSPACE)] == [foreign.pid],
                    "a running daemon is found from its own record, with no workspace named",
                )
                refusal = rendezvous.stop_for_removal(modules.WORKSPACE)
                check(
                    f"pid {foreign.pid}" in refusal and "did not start" in refusal,
                    "another process's daemon is a refusal, and the refusal names its pid",
                )
                check(foreign.poll() is None, "and it is left running: a pid read off disk is not a licence to signal")
                st, body_json = _delete(f"{base}/api/components/{modules.WORKSPACE}")
                check(
                    st == 400 and "did not start" in json.loads(body_json)["error"],
                    "a removal over HTTP is refused while a daemon this host did not start is serving it",
                )
                check(
                    components.installed(modules.WORKSPACE) is not None,
                    "and a refused removal left the artifact exactly where it was",
                )
            finally:
                record.unlink(missing_ok=True)
                foreign.terminate()
                foreign.wait(timeout=10)
            st, body_json = _delete(f"{base}/api/components/{modules.WORKSPACE}")
            check(
                st == 200 and json.loads(body_json)["status"] == "removed",
                "with nothing of it running, the same removal goes through",
            )
            check(components.installed(modules.WORKSPACE) is None, "and the host no longer resolves it")
        finally:
            os.environ.pop(workspace_mod.discovery_env, None)

        # 8c. the same two verbs over HTTP, for a component with no daemon at all
        st, body_json = http_get(f"{base}/api/components/versions?name={modules.MEMORY}")
        payload = json.loads(body_json)
        check(
            st == 200 and bool(payload["versions"]) and payload["versions"][0]["resolved"],
            "GET /api/components/versions names what this host holds, and which one it runs",
        )
        check(payload["versions"][0]["digest"] == digest, "and carries the digest the client's gate compares")
        st, body_json = http_get(f"{base}/api/components/versions?name=..%2F..%2Fetc")
        check(
            st == 400 and "bad component name" in json.loads(body_json)["error"],
            "a name that could never be an install is refused over HTTP too",
        )
        st, body_json = http_get(f"{base}/api/components/versions")
        check(
            st == 400 and "name is required" in json.loads(body_json)["error"],
            "asking for versions without naming a component is refused",
        )

        st, body_json = _delete(f"{base}/api/components/{modules.WEBSEARCH}?version=9.9.9")
        check(
            st == 400 and "is not installed on this host" in json.loads(body_json)["error"],
            "removing a version this host does not hold is refused",
        )
        st, body_json = _delete(f"{base}/api/components/{modules.WEBSEARCH}")
        check(
            st == 200
            and json.loads(body_json) == {"status": "removed", "name": modules.WEBSEARCH, "removed": [components.digest_of(blob2)[:16]]},
            "DELETE takes the component whole and answers which versions went",
        )
        check(components.installed(modules.WEBSEARCH) is None, "and the host no longer resolves it")
        listed = json.loads(http_get(f"{base}/api/components")[1])["components"]
        check({c["name"] for c in listed} == {modules.MEMORY}, "the inventory shrank by exactly that component")
        st, body_json = _delete(f"{base}/api/components/{modules.WEBSEARCH}")
        check(st == 200 and json.loads(body_json)["status"] == "absent", "removing it again is absent, not an error")
        st, _body = _delete(f"{base}/api/components/")
        check(st == 404, "a removal that names no component is not found")

        # 8d. the switch: the third verb on this layer, and the only one that
        #     writes to the table without touching a byte. "Stop driving this on
        #     THAT machine" is a fact about the machine that owns the component,
        #     so the bit lives in the same table its installs are recorded in,
        #     and a page reads it back out of GET /api/components.
        installed_dir = components.installed(modules.MEMORY)
        check(installed_dir is not None, "clutch-memory is installed for this host before the switch")
        st, body_json = _post_verb(f"{base}/api/components/{modules.MEMORY}/disable")
        check(
            st == 200
            and json.loads(body_json) == {"status": "disabled", "name": modules.MEMORY, "disabled": True},
            "disabling a component is a verdict, in the machine's own words",
        )
        listed = json.loads(http_get(f"{base}/api/components")[1])["components"]
        check(
            [c["disabled"] for c in listed if c["name"] == modules.MEMORY] == [True],
            "a stopped component stays listed, and the listing says which one is stopped",
        )
        check(
            (installed_dir / modules.MEMORY).read_bytes() == blob,
            "with its bytes exactly where they were: the switch is not a removal",
        )
        check(not rendezvous.available(modules.MEMORY), "and this host stops offering its tools while it is stopped")
        st, body_json = _post_verb(f"{base}/api/components/{modules.MEMORY}/enable")
        check(
            st == 200
            and json.loads(body_json) == {"status": "enabled", "name": modules.MEMORY, "disabled": False},
            "starting it again is the same verb the other way — nothing here is irreversible",
        )
        check(
            rendezvous.available(modules.MEMORY) and (installed_dir / modules.MEMORY).read_bytes() == blob,
            "with its tools back and its bytes still the same ones",
        )

        # a component this machine does not hold is an ANSWER, not an error: the
        # request was aimed at the machine that owns the directory, and "make
        # sure it is stopped here" is already true when it is not here at all.
        st, body_json = _post_verb(f"{base}/api/components/clutch-nothing/disable")
        check(
            st == 200 and json.loads(body_json) == {"status": "absent", "name": "clutch-nothing"},
            "stopping a component this host does not hold is answered, not refused",
        )
        check(
            all(record["name"] != "clutch-nothing" for record in components.entries()),
            "and nothing was recorded for it",
        )
        st, body_json = _post_verb(f"{base}/api/components/..%2F..%2Fetc/disable")
        check(
            st == 400 and "bad component name" in json.loads(body_json)["error"],
            "a name that could never be an install is refused before anything is read or written",
        )
        st, _body = _post_verb(f"{base}/api/components/disable")
        check(st == 404, "a switch that names no component is not found, not a component called ''")

        srv.shutdown()
    finally:
        if sup is not None:
            sup.shutdown_all()
        os.environ.pop(components.ROOT_ENV, None)
        shutil.rmtree(root, ignore_errors=True)

    print("\nall passed")
    return 0


class _Reader:
    """A stream that hands out at most `n` bytes per read, like a socket."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.at = 0

    def read(self, n: int) -> bytes:
        chunk = self.data[self.at : self.at + n]
        self.at += len(chunk)
        return chunk


if __name__ == "__main__":
    raise SystemExit(main())
