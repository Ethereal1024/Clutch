"""Thin-client plumbing: find (or lazily start) the skills service and ask it.

Policy (matches the workspace module's precedent): the service is the CLI's
execution path. Every call finds a live daemon for the root or spawns one
detached and waits for it to publish itself; `--no-server` is the explicit,
single-process alternative for reads, and re-pointing a root always needs the
daemon (it is daemon state).

A non-2xx answer from a live service is a VERDICT (unknown skill, bad file,
unreadable file): its reason travels back to the caller, status included. A
connection that fails or answers nonsense is transport trouble instead, and the
caller must not silently do the work locally — a service that died mid-call is
not the same thing as a service that said no.

Stdlib only (urllib, subprocess, json) — the zero-dependency promise holds.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import discovery

LAZY_START_SECONDS = 10.0  # how long a client waits for a service it just spawned
PROBE_TIMEOUT = 2.0  # /health budget — a live daemon answers instantly
REQUEST_TIMEOUT = 30.0  # read budget; a skill file is local prose


class ServiceUnavailable(Exception):
    """No service for this root and none could be started (CLI exit 2)."""


class ProtocolError(Exception):
    """A live service refused or could not answer (CLI exit 1): the caller's
    request is the problem, not the transport."""

    def __init__(self, status: int, message: str, available: list[str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.available = available or []


def base_url(root: str, *, url: str = "", port: int = 0) -> str:
    """Where the service for `root` answers: an explicit --url, then an explicit
    --port, then a live daemon from the discovery file, then a fresh spawn."""
    if url:
        return url.rstrip("/")
    if port:
        return f"http://127.0.0.1:{port}"
    record = discovery.read(root)
    if record and _healthy(_record_base(record)):
        return _record_base(record)
    if record:
        # published but not answering: it died in the last moments, so drop the
        # entry and let the fresh spawn below own the file
        discovery.remove(root)
    return _spawn_and_wait(root)


class Client:
    """The four calls, one URL."""

    def __init__(self, base: str, *, timeout: float = REQUEST_TIMEOUT) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout

    def health(self) -> dict:
        return self._get("/health")

    def catalog(self) -> dict:
        return self._get("/skills")

    def skill(self, name: str, file: str = "") -> dict:
        query = {"name": name}
        if file:
            query["file"] = file
        return self._get("/skill", query)

    def set_root(self, root: str) -> dict:
        return self._post("/root", {"root": root})

    # -- transport -------------------------------------------------------

    def _get(self, path: str, query: dict[str, str] | None = None) -> dict:
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return self._request(urllib.request.Request(url, method="GET"))

    def _post(self, path: str, payload: dict) -> dict:
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._request(request)

    def _request(self, request: urllib.request.Request) -> dict:
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return _json(response.read(), response.status)
        except urllib.error.HTTPError as err:
            with err:
                body = _json(err.read(), err.code, tolerate=True)
            raise ProtocolError(
                err.code, str(body.get("error") or err.reason), list(body.get("available") or [])
            ) from None
        except (urllib.error.URLError, OSError, ValueError) as err:
            raise ServiceUnavailable(f"skills service unreachable at {self.base}: {err}") from None


def _json(raw: bytes, status: int, *, tolerate: bool = False) -> dict:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        if tolerate:
            return {}
        raise ServiceUnavailable(f"skills service answered HTTP {status} with something that is not JSON") from None
    if not isinstance(payload, dict):
        if tolerate:
            return {}
        raise ServiceUnavailable(f"skills service answered HTTP {status} with {type(payload).__name__}, not an object")
    return payload


def _record_base(record: dict) -> str:
    return f"http://127.0.0.1:{record['port']}"


def _healthy(base: str) -> bool:
    try:
        with urllib.request.urlopen(base + "/health", timeout=PROBE_TIMEOUT) as response:
            return response.status == 200 and bool(json.loads(response.read().decode("utf-8")).get("ok"))
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _spawn_and_wait(root: str) -> str:
    """Start one detached service for this root and poll for its discovery entry."""
    try:
        child = _spawn(root)
    except OSError as err:
        raise ServiceUnavailable(f"could not start the skills service: {err}") from None
    deadline = time.monotonic() + LAZY_START_SECONDS
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise ServiceUnavailable(f"the skills service exited during startup (status {child.returncode})")
        record = discovery.read(root)
        if record and _healthy(_record_base(record)):
            return _record_base(record)
        time.sleep(0.05)
    raise ServiceUnavailable(f"the skills service did not become ready within {LAZY_START_SECONDS:g}s")


def _spawn(root: str) -> subprocess.Popen:
    """Detached service start: its own session on POSIX, DETACHED_PROCESS on
    Windows, stdio to the void either way — the service outlives this CLI call
    by design (that is where the re-pointed root lives)."""
    kwargs: dict = dict(
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    # carry the package's parent dir explicitly: a source checkout is not an
    # installed package, so the child's own `-m` import would not find us
    kwargs["env"] = _child_env()
    cmd = [sys.executable, "-m", "clutch_skills.server", "--root", str(Path(root).resolve())]
    return subprocess.Popen(cmd, **kwargs)


def _child_env() -> dict:
    env = dict(os.environ)
    package_parent = str(Path(__file__).resolve().parent.parent)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{package_parent}{os.pathsep}{existing}" if existing else package_parent
    return env
