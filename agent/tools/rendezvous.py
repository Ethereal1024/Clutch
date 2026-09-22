"""Rendezvous: how the host reaches a standalone tool module.

The tool constitution (R1/R2) makes every tool its own module and keeps the
host's dependency graph a star: modules may point at the host's generic
services, the host may point at nothing but a module's PUBLISHED interface.
This file is the host's half of that contract, in the two shapes a published
interface comes in: a per-workspace daemon discovered through a record and
spoken to over loopback HTTP, and a one-process command line the app host runs
itself. `prepare()` returns whichever one a statement needs.

Everything duplicated here is deliberate and frozen (R4): the module directory,
the discovery file name, the record's shape and the token header. The host
imports NOTHING from a module — deleting a checkout must degrade to the host's
own implementation, never break it (see `available()` and Tool.func).

Local by design: a daemon module serves the filesystem of the machine it runs
on, so that path only ever applies to a local workspace; a remote workspace
keeps the host's transport-based implementation. A CLI module, by contrast,
always runs on the app host — its subject is the project file the server already
owns, not the workspace's machine.

Lifecycle: a daemon started from here is fenced with the workspace's protected
paths at spawn time (the module's fence IS spawn-time policy — its own docs say
"to change it, /shutdown and restart"), and is asked to stop again when this
process exits. The host owns the children it starts.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import modules
from .localshell import local_shell
from .transport import LocalTransport

TOKEN_HEADER = "X-Clutch-Token"  # the module daemons' auth header (frozen contract)
RECORD_VERSION = 1
READY_SECONDS = 10.0  # how long a daemon we just spawned has to publish itself
PROBE_SECONDS = 2.0  # /health budget — a live daemon answers at once
DEFAULT_IDLE = 600.0  # the daemon's own idle default; CLUTCH_RENDEZVOUS_IDLE overrides

DAEMON = "daemon"  # a module that serves over HTTP, discovered and started here
CLI = "cli"  # a module that is driven as one command line per call


class RendezvousError(RuntimeError):
    """No usable service for this workspace and none could be started."""


@dataclass(frozen=True)
class Module:
    """A standalone module's published coordinates (the host's side of R4).

    Two kinds, and the difference is only WHERE a statement runs: a `daemon`
    module serves a machine's filesystem (so a local workspace reaches it over
    loopback HTTP, discovered through a published record and started on
    demand), while a `cli` module is one process per call that is always driven
    on the APP host (its subject is the app's own project file / the network /
    the skill library, never the workspace's machine).
    """

    dirname: str  # checkout directory next to the host repo
    kind: str = DAEMON
    daemon: str = ""  # `python -m <daemon>` starts its per-workspace service
    cli: tuple[str, ...] = ()  # argv after the interpreter, e.g. ("memory.py",)
    importable: bool = False  # the CLI is a package: PYTHONPATH must name its dir
    discovery_env: str = ""  # env var that repoints the discovery directory
    app_dir: str = ""  # directory under %LOCALAPPDATA% / ~ holding the records
    prefix: str = ""  # discovery file name prefix


_WORKSPACE = Module(
    dirname=modules.WORKSPACE,
    daemon="clutch_workspace.daemon",
    discovery_env="CLUTCH_WORKSPACE_DISCOVERY_DIR",
    app_dir="clutch-workspace",
    prefix="d-",
)
_MEMORY = Module(dirname=modules.MEMORY, kind=CLI, cli=("memory.py",))
_WEBSEARCH = Module(dirname=modules.WEBSEARCH, kind=CLI, cli=("websearch.py",))
_SKILLS = Module(dirname=modules.SKILLS, kind=CLI, cli=("-m", "clutch_skills"), importable=True)
_TABLE = {
    modules.WORKSPACE: _WORKSPACE,
    modules.MEMORY: _MEMORY,
    modules.WEBSEARCH: _WEBSEARCH,
    modules.SKILLS: _SKILLS,
}


@dataclass(frozen=True)
class Service:
    """A live module daemon: where it listens and how to authenticate."""

    module: str
    port: int
    token: str
    pid: int

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def vars(self) -> dict[str, str]:
        """The host placeholders a statement template may use (see inst.render)."""
        return {
            "port": str(self.port),
            "token": self.token,
            "auth": f"{TOKEN_HEADER}:{self.token}",
            # curl's own `-w` format: a newline plus the HTTP status, which
            # unwrap() reads as the transport's verdict (never the command's)
            "status": "\\n%{http_code}",
        }


_LOCK = threading.RLock()
_CACHE: dict[tuple[str, str, tuple[str, ...]], Service] = {}
# pid -> the child WE spawned. The host owns its children: a daemon we started
# must be waited on, or an exited daemon stays a zombie and still answers
# os.kill(pid, 0) — "release() stopped it" would be a lie the OS keeps telling.
_PROCS: dict[int, subprocess.Popen] = {}
# (module, root) -> the fence globs we spawned that daemon with. A record does
# not carry its fence, so this is the only way to know whether a daemon we see
# is fenced the way the caller needs.
_FENCED: dict[tuple[str, str], tuple[str, ...]] = {}


def available(module: str) -> bool:
    """True when this host could actually drive `module`'s statements.

    Facts, all of them local and cheap: the checkout is there (R2's star
    acceptance — a deleted module must not take the host down), the local shell
    is POSIX enough for a quoted statement, and — for a daemon module — curl
    exists to speak its HTTP. Anything else and the host uses its own
    implementation instead.
    """
    mod = _TABLE.get(module)
    if mod is None or not modules.module_dir(mod.dirname).is_dir():
        return False
    if not local_shell().posix:
        return False
    if mod.kind == DAEMON:
        return shutil.which("curl") is not None
    return bool(mod.cli)


def is_local(module: str) -> bool:
    """True when the module serves the WORKSPACE's machine (a daemon module).

    A daemon module is a per-workspace service over the filesystem it runs on,
    so it can only be reached while the workspace is local. A CLI module always
    runs on the app host, whatever kind of workspace the call came from.
    """
    mod = _TABLE.get(module)
    return mod is not None and mod.kind == DAEMON


def cli_vars(module: str, config) -> dict[str, str]:
    """The host placeholders a CLI module's statement renders with.

    Three are universal: {py} is the interpreter that runs the module, {dir} its
    checkout (which a package module gets as PYTHONPATH), and {script} the
    module's entry-point file when it is one (`clutch-memory/memory.py`). The
    rest are what only the host knows and only a particular module needs: the
    project file's content service, and the skills root when the session pointed
    at one of its own.
    """
    mod = _TABLE[module]
    out = {"py": modules.python_exe(), "dir": str(modules.module_dir(mod.dirname))}
    if len(mod.cli) == 1 and mod.cli[0].endswith(".py"):
        # the module's entry point as one path, so a statement names it without
        # gluing a quoted directory to a bare file name
        out["script"] = str(modules.module_dir(mod.dirname) / mod.cli[0])
    if module == modules.MEMORY:
        # the .clc content service IS this process: the module writes the
        # project file through the endpoint the server publishes on loopback
        out["base"] = f"http://127.0.0.1:{config.port}"
    elif module == modules.SKILLS and getattr(config, "skills_dir", None) is not None:
        out["root"] = str(config.skills_dir)
    return out


@dataclass(frozen=True)
class Statement:
    """One statement, ready to render and run: where it runs and what fills it.

    `vars` are the host placeholders its template names (a daemon's port/token/
    status, a CLI's interpreter and checkout); `runner` is the transport that
    carries the rendered line (the workspace's own for a daemon module — the
    filesystem it serves is its machine's — the app host's for a CLI, whose
    subject is the app's project file / the network / the skill library).
    """

    vars: dict[str, str]
    runner: Any


def prepare(module: str, workspace: Any, config) -> Statement:
    """Everything one statement needs before it can be rendered and run.

    A daemon module is reached through the workspace's own transport (loopback
    from the machine that owns the files); a CLI module is reached through the
    app host's, whatever kind of workspace the call came from.
    """
    mod = _TABLE.get(module)
    if mod is None:
        raise RendezvousError(f"unknown module: {module}")
    if mod.kind == CLI:
        return Statement(vars=cli_vars(module, config), runner=LocalTransport(str(modules.repo_root())))
    service_ = service(workspace.root, module, protect=workspace.protected())
    return Statement(vars=service_.vars(), runner=workspace)


def fence_globs(protected: Iterable[Path | str], root: str | Path) -> tuple[str, ...]:
    """Translate the workspace's protected paths into the module's fence globs.

    The module matches a glob against several spellings of the path a request
    names (as-given, basename, CWD-relative suffixes), so a fence has to be
    given in those spellings too. Over-fencing is the safe direction: the host
    protects a handful of project files, never a whole tree."""
    base = Path(root).resolve()
    out: set[str] = set()
    for raw in protected:
        p = Path(str(raw))
        out.add(str(p))
        out.add(p.name)
        try:
            rel = Path(p).resolve().relative_to(base)
        except (OSError, ValueError):
            continue
        out.add(str(rel))
        out.add(rel.as_posix())
    return tuple(sorted(g for g in out if g and g not in (".", "/")))


def service(root: str | Path, module: str, protect: Iterable[Path | str] = ()) -> Service:
    """The live service for this workspace, starting one when needed.

    Raises RendezvousError when the module is not available or the daemon never
    became ready — callers report that as error-as-data, never as a crash.
    """
    mod = _TABLE.get(module)
    if mod is None:
        raise RendezvousError(f"unknown module: {module}")
    resolved = str(Path(root).resolve())
    fences = fence_globs(protect, resolved)
    key = (module, resolved, fences)
    with _LOCK:
        cached = _CACHE.get(key)
        if cached is not None and _pid_alive(cached.pid):
            return cached
        _CACHE.pop(key, None)
        record = _read_record(resolved, mod)
        # A daemon we did not start may carry a different fence, and the record
        # does not say which: when there is a fence to enforce, replace it
        # rather than trust it (silently serving a .clc unfenced is the one
        # failure this policy exists to prevent).
        seen = _service(module, record) if record is not None else None
        remembered = not fences or _FENCED.get((module, resolved)) == fences
        if seen is not None and remembered and _healthy(seen):
            _CACHE[key] = seen
            return seen
        if record is not None:
            _stop(record, pid=record.get("pid"))
        return _start(resolved, mod, fences, key)


def release(root: str | Path, module: str) -> None:
    """Stop this workspace's daemon (best effort) and drop it from the cache."""
    resolved = str(Path(root).resolve())
    with _LOCK:
        for key in [k for k in _CACHE if k[0] == module and k[1] == resolved]:
            svc = _CACHE.pop(key)
            _stop({"port": svc.port, "token": svc.token}, pid=svc.pid)
        _FENCED.pop((module, resolved), None)


def release_all() -> None:
    """Stop every daemon this process started (process exit / test teardown)."""
    with _LOCK:
        for svc in list(_CACHE.values()):
            _stop({"port": svc.port, "token": svc.token}, pid=svc.pid)
        _CACHE.clear()
        _FENCED.clear()


atexit.register(release_all)


# -- discovery: the record a daemon publishes, and its readiness ---------------


def _record_path(root: str, mod: Module) -> Path:
    """The discovery file a module daemon for this workspace publishes."""
    override = os.environ.get(mod.discovery_env)
    if override:
        base = Path(override)
    else:
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) / mod.app_dir if local else Path.home() / f".{mod.app_dir}"
    digest = hashlib.sha256(os.path.normcase(root).encode("utf-8")).hexdigest()[:32]
    return base / f"{mod.prefix}{digest}.json"


def _read_record(root: str, mod: Module) -> dict | None:
    """The published record, or None when it is missing, corrupt, or dead."""
    try:
        payload = json.loads(_record_path(root, mod).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("version") != RECORD_VERSION:
        return None
    port, pid, token = payload.get("port"), payload.get("pid"), payload.get("token")
    if not (isinstance(port, int) and 0 < port <= 65535 and isinstance(token, str) and token):
        return None
    if not (isinstance(pid, int) and _pid_alive(pid)):
        return None
    return payload


def _service(module: str, record: dict) -> Service:
    return Service(module=module, port=int(record["port"]), token=str(record["token"]), pid=int(record["pid"]))


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # someone else's live process
        return True
    except OSError:
        return False
    # a zombie has exited: it only waits to be reaped, and it serves nothing.
    # Without this, "release() stopped the daemon" cannot be observed on POSIX
    # for a child of our own (kill(pid, 0) succeeds until somebody waits).
    return not _is_zombie(pid)


def _is_zombie(pid: int) -> bool:
    """True when the process has exited but has not been reaped yet (POSIX)."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except OSError:
        return False  # Windows (no /proc) or already gone: not our verdict to make
    # "<pid> (<comm>) <state> ..." — comm may contain anything, so split after it
    try:
        return stat.rsplit(")", 1)[1].split()[0] == "Z"
    except (IndexError, AttributeError):
        return False


def _healthy(svc: Service) -> bool:
    """A GET /health that answers {"ok": true} — a live daemon of our protocol."""
    request = urllib.request.Request(f"{svc.url}/health", headers={TOKEN_HEADER: svc.token})
    try:
        with urllib.request.urlopen(request, timeout=PROBE_SECONDS) as response:
            return response.status == 200 and bool(json.loads(response.read().decode("utf-8")).get("ok"))
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _stop(record: dict, pid: int | None = None) -> None:
    """Best-effort /shutdown: the daemon unpublishes and exits on its own.

    When the pid is one we spawned, the child is also waited on — the daemon
    outlives this call by design, and nothing else will reap it."""
    request = urllib.request.Request(
        f"http://127.0.0.1:{record['port']}/shutdown",
        data=b"{}",
        headers={"Content-Type": "application/json", TOKEN_HEADER: str(record["token"])},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=PROBE_SECONDS):
            pass
    except (urllib.error.URLError, OSError, ValueError):
        pass
    if pid:
        _reap(pid)


def _reap(pid: int) -> None:
    """Wait for a child we started; kill it if the shutdown did not land."""
    proc = _PROCS.pop(pid, None)
    if proc is None:
        return
    try:
        proc.wait(timeout=READY_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=PROBE_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            pass


# -- starting a daemon: detached, fenced, and outliving this call --------------


def _start(root: str, mod: Module, fences: tuple[str, ...], key: tuple[str, str, tuple[str, ...]]) -> Service:
    if not available(mod.dirname):
        raise RendezvousError(f"the {mod.dirname} module is not available")
    directory = modules.module_dir(mod.dirname)
    cmd = [
        modules.python_exe(),
        "-m",
        mod.daemon,
        "--workspace",
        root,
        "--idle",
        _idle(),
    ]
    for glob in fences:
        cmd += ["--protect", glob]
    try:
        proc = subprocess.Popen(cmd, cwd=str(directory), env=modules.module_env(), **_detach())
    except OSError as err:
        raise RendezvousError(f"could not start the {mod.dirname} daemon: {err}") from None
    deadline = time.monotonic() + READY_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RendezvousError(f"the {mod.dirname} daemon exited during startup (status {proc.returncode})")
        record = _read_record(root, mod)
        if record is not None:
            svc = _service(mod.dirname, record)
            if _healthy(svc):
                _FENCED[(mod.dirname, root)] = fences
                _CACHE[key] = svc
                _PROCS[svc.pid] = proc
                return svc
        time.sleep(0.05)
    try:  # a daemon that never published is ours to clean up
        proc.kill()
        proc.wait(timeout=PROBE_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        pass
    raise RendezvousError(f"the {mod.dirname} daemon did not become ready within {READY_SECONDS:g}s")


def _idle() -> str:
    return os.environ.get("CLUTCH_RENDEZVOUS_IDLE") or f"{DEFAULT_IDLE:g}"


def _detach() -> dict:
    """stdio to the void: the daemon outlives this call by design (its undo
    stack is the module's own), so it must not hold our pipes."""
    kwargs: dict = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return kwargs
