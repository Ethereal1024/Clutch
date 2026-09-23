"""The install layer's receiving half: landing dir, version gate, wire contract.

Run: .venv/bin/python -m tests.components_api_test

A component belongs to the machine its server runs on, so the supervisor of that
machine is what a client installs ONTO. This suite pins the two answers a client
acts on — what is already here (GET /api/components) and whether an upload was
taken (POST /api/components/install) — plus the discipline that makes the gate
trustworthy: the artifact's DIGEST decides, never the manifest's claim, and a
body that lies or ends early leaves the host exactly as it was.

Isolation: CLUTCH_COMPONENTS_DIR points at a temp root, so the run never touches
the components installed for the user running it.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tarfile
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

from agent.supervisor import Supervisor, build_server
from agent.tools import catalog, components, modules, rendezvous
from tests.testsupport import check, http_get

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache"}


def _post_artifact(base: str, name: str, data: bytes, *, digest: str, artifact: str = "", **extra) -> tuple[int, str]:
    """One install request, exactly as a client sends it: manifest in the header,
    artifact as the body."""
    manifest = {"name": name, "version": digest[:16], "interface": "cli", "digest": digest, **extra}
    if artifact:
        manifest["artifact"] = artifact
    req = urllib.request.Request(
        f"{base}/api/components/install",
        data=data,
        headers={components.MANIFEST_HEADER: json.dumps(manifest), "Content-Type": "application/octet-stream"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


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
            {"name": "clutch-memory", "version": "1.0.0", "interface": "cli", "digest": components.digest_of(blob2)}
        ], "the inventory is the manifest's claims plus the install's real digest")

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
