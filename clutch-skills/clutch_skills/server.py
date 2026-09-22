"""The skills service: one long-lived HTTP process per skills root.

    python -m clutch_skills.server --root DIR [--port N] [--idle SECONDS] [--no-publish]

Binds 127.0.0.1 on a random port, publishes root+port+pid to a discovery file
(see discovery.py), and serves the library so a session can read the catalog and
load one skill without spawning a process per call. Everything is stdlib.

Protocol — all JSON, loopback only, no auth (nothing here is worth a token; see
discovery.py):

    GET  /health                -> {"ok", "root", "pid", "skills"}
    GET  /skills                -> {"root", "skills": [{"name","description","dir"}]}
    GET  /skill?name=&file=     -> {"root","name","description","dir","file","content"}
    POST /root {"root": DIR}    -> {"ok", "root", "skills"}      re-point, no restart

Statuses carry the meaning here (unlike the workspace daemon, whose verdict
rides HTTP 200 because a sysexits code has no legal HTTP spelling): 200 ok, 400
for a caller-fixable request (missing field, bad file, escape, non-UTF-8, a root
that is not a directory), 404 for an unknown skill or path. The 404 for a skill
carries "available": [names] — a caller that guessed a name can answer with the
real ones instead of failing blind.

Nothing is cached: editing a SKILL.md takes effect on the next request, and the
service holds no state but its root. Lifecycle: an idle watchdog exits after
--idle seconds without a request (default 600), SIGTERM/SIGINT exit gracefully,
and both paths remove the discovery file.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import discovery, skills
from .skills import SkillError

BUNDLED_ROOT = Path(__file__).resolve().parent.parent / "skills"
DEFAULT_IDLE_SECONDS = 600.0
# A caller-fixable library complaint is a 400; an unknown skill is the 404 that
# carries the available names.
_STATUS = {
    "unknown-skill": 404,
    "no-root": 400,
    "bad-file": 400,
    "escape": 400,
    "not-text": 400,
    "too-large": 400,
}


def health_payload(root: Path, pid: int) -> dict:
    return {"ok": True, "root": str(root), "pid": pid, "skills": len(skills.catalog(root))}


def catalog_payload(root: Path) -> dict:
    """The catalog as it goes on the wire. One source for this shape on purpose:
    the service and the CLI's --no-server path must answer byte-identically, and
    the host reads this same object."""
    return {
        "root": str(root),
        "skills": [{"name": s.name, "description": s.description, "dir": s.directory} for s in skills.catalog(root)],
    }


def skill_payload(root: Path, name: str, file: str) -> dict:
    skill, rel, text = skills.read_text(root, name, file or skills.DEFAULT_SKILL_FILE)
    return {
        "root": str(root),
        "name": skill.name,
        "description": skill.description,
        "dir": skill.directory,
        "file": rel,
        "content": text,
    }


class Service:
    """The state a skills daemon owns: which root it serves, and nothing else."""

    def __init__(self, root: Path, idle: float, publish: bool = True) -> None:
        self.root = skills.checked_root(root)
        self.idle = idle
        self.publish = publish
        self.pid = os.getpid()
        self.port = 0
        self.server: ThreadingHTTPServer | None = None
        self.lock = threading.RLock()  # serializes re-pointing against readers
        self.busy = 0  # requests in flight (the idle check defers to them)
        self._last_activity = time.monotonic()
        self._stop = threading.Event()

    def touch(self) -> None:
        self._last_activity = time.monotonic()

    # -- the four answers ------------------------------------------------

    def health(self) -> dict:
        return health_payload(self.root, self.pid)

    def catalog(self) -> dict:
        return catalog_payload(self.root)

    def skill(self, name: str, file: str) -> dict:
        return skill_payload(self.root, name, file)

    def set_root(self, root: str) -> dict:
        """Re-point at another root: the daemon starts serving the new library
        immediately and re-publishes discovery under the new key (the key IS the
        root), so clients that discover by root find it there."""
        new_root = skills.checked_root(root)
        with self.lock:
            old_root = self.root
            self.root = new_root
        if self.publish and old_root != new_root:
            discovery.remove(str(old_root))
            discovery.write(str(new_root), self.port)
        return self.health()

    def available(self) -> list[str]:
        try:
            return [s.name for s in skills.catalog(self.root)]
        except SkillError:
            return []  # the caller is already getting an error; don't mask it

    # -- lifecycle -------------------------------------------------------

    def shutdown_soon(self) -> None:
        """Ask the serve loop to wind down (signal handler / watchdog land here)."""
        self._stop.set()
        threading.Thread(target=self._stop_serving, daemon=True).start()

    def _stop_serving(self) -> None:
        if self.server is not None:
            self.server.shutdown()

    def watchdog(self) -> None:
        """Idle suicide: after --idle seconds without a request, unpublish and
        exit. A request in flight defers the check to the next tick."""
        while not self._stop.wait(0.5):
            with self.lock:
                busy, idle_for = self.busy, time.monotonic() - self._last_activity
            if not busy and idle_for >= self.idle:
                self.shutdown_soon()
                return


class _Handler(BaseHTTPRequestHandler):
    """A small HTTP skin over Service. Never logs: a spawned daemon's stderr is
    a void, and the banner is the daemon's voice."""

    service: Service  # wired in serve()

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        try:
            self._get()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:  # noqa: N802 - http.server naming
        try:
            self._post()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _get(self) -> None:
        svc = self.service
        svc.touch()
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path.rstrip("/") or "/"
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parts.query).items()}
        with svc.lock, _counting(svc):
            if path == "/health":
                return self._respond(200, svc.health())
            if path == "/skills":
                return self._respond(200, svc.catalog())
            if path == "/skill":
                return self._library(lambda: svc.skill(query.get("name", ""), query.get("file", "")))
            return self._respond(404, {"error": f"unknown path: {self.path}"})

    def _post(self) -> None:
        svc = self.service
        svc.touch()
        path = urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"
        if path != "/root":
            return self._respond(404, {"error": f"unknown path: {self.path}"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (OSError, ValueError):
            return self._respond(400, {"error": "request body must be one JSON object"})
        if not isinstance(payload, dict) or not isinstance(payload.get("root"), str):
            return self._respond(400, {"error": 'request body must be {"root": "<directory>"}'})
        with _counting(svc):
            self._library(lambda: svc.set_root(payload["root"]))

    def _library(self, call) -> None:
        """Answer a library call, turning SkillError into its status + reason."""
        try:
            self._respond(200, call())
        except SkillError as err:
            body = {"error": err.message}
            if err.code == "unknown-skill":
                body["available"] = self.service.available()
            self._respond(_STATUS.get(err.code, 400), body)
        except OSError as err:  # a filesystem-level failure is the caller's 400 too
            self._respond(400, {"error": str(err)})
        except Exception as err:  # noqa: BLE001 - name it a bug, keep serving
            traceback.print_exc()
            self._respond(500, {"error": f"internal error: {err}"})

    def _respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass


class _counting:
    """Mark one request in flight so the idle watchdog cannot fire mid-request."""

    def __init__(self, svc: Service) -> None:
        self.svc = svc

    def __enter__(self) -> None:
        self.svc.busy += 1

    def __exit__(self, *exc: object) -> None:
        self.svc.busy -= 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clutch-skills",
        description=(
            "Skills service: serve a skills root over loopback HTTP "
            "(usually started lazily by the CLI, not by hand)."
        ),
        allow_abbrev=False,
    )
    parser.add_argument(
        "--root",
        default=str(BUNDLED_ROOT),
        metavar="DIR",
        help=f"skills root to serve (default: the bundled {BUNDLED_ROOT})",
    )
    parser.add_argument("--port", type=int, default=0, metavar="N", help="port to bind (default: a random free port)")
    parser.add_argument(
        "--idle",
        type=float,
        default=DEFAULT_IDLE_SECONDS,
        metavar="SECONDS",
        help=f"exit after this much inactivity (default {DEFAULT_IDLE_SECONDS:g})",
    )
    parser.add_argument("--no-publish", action="store_true", help="do not write a discovery file (tests, embedded use)")
    return parser


def serve(args: argparse.Namespace) -> int:
    try:
        service = Service(Path(args.root), idle=args.idle, publish=not args.no_publish)
    except SkillError as err:
        print(f"clutch-skills: {err.message}", file=sys.stderr)
        return 1
    _Handler.service = service
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), _Handler)
    service.server = httpd
    service.port = httpd.server_address[1]
    if service.publish:
        discovery.write(str(service.root), service.port)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, lambda *_: service.shutdown_soon())
        except (OSError, ValueError):  # not the main thread / unsupported
            pass
    threading.Thread(target=service.watchdog, daemon=True).start()

    banner = f"clutch-skills ready: root={service.root} port={service.port} pid={service.pid} idle={args.idle:g}s"
    print(banner, flush=True)
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        httpd.server_close()
        if service.publish:
            discovery.remove(str(service.root))
        print(f"clutch-skills stopped: root={service.root}", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    return serve(build_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
