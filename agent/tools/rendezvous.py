"""Rendezvous: how the host reaches a component's process, once it has one.

catalog.py declares WHAT a component is and what it publishes; this file is the
mechanics of getting to it. The host imports NOTHING from a component — it may
point at nothing but the component's PUBLISHED interface, in the two shapes that
comes in: a per-workspace daemon discovered through a record and spoken to over
loopback HTTP, and a one-process command line the app host runs itself.
`prepare()` returns whichever one a statement needs.

A component that is not on this machine is not an error to be papered over: it
has no tools (registry.build_tools) and `unavailable_reason()` is the sentence a
client can show. Nothing here answers on a component's behalf.

Three facts describe a component and they are independent (see
catalog.Component): WHAT a statement is spoken to as (interface: a per-workspace
daemon over loopback HTTP, or one process per call), WHERE its process runs
relative to the host being asked (runs_on), and WHOSE resources it serves
(subject). Today every component in the table runs on the host that asks
(runs_on=SELF) — which makes the axis invisible, and that is the point: a
component that serves ANOTHER machine's filesystem (an ssh workspace), or one
that is called FROM another host (a client-side component behind a reverse
channel), adds an ENTRY to the table, never a branch to a tool.

Where a component's artifact comes from is a different question again, and
tools/components.py answers it: the host runs the component installed on ITS own
machine, falling back to the dev checkout next to the repo.

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

from . import catalog, components, modules
from .localshell import local_shell, shq
from .transport import LocalTransport

TOKEN_HEADER = "X-Clutch-Token"  # the module daemons' auth header (frozen contract)
RECORD_VERSION = 1
READY_SECONDS = 10.0  # how long a daemon we just spawned has to publish itself
PROBE_SECONDS = 2.0  # /health budget — a live daemon answers at once
DEFAULT_IDLE = 600.0  # the daemon's own idle default; CLUTCH_RENDEZVOUS_IDLE overrides

# The vocabulary (interface / runs_on / subject — catalog.py's constants) is the
# DECLARATION's, and this file reads it from there rather than restating it: two
# spellings of "cli" would be two things to keep in step.

class RendezvousError(RuntimeError):
    """No usable service for this workspace and none could be started."""


@dataclass(frozen=True)
class Resolved:
    """A component found ON THIS HOST: where its code is and how one process of
    it starts. The launch, never the interface — see catalog.Component."""

    module: catalog.Component
    directory: Path
    argv: tuple[str, ...]  # the words to execute, before the component's own flags
    installed: bool  # a real install for this host, not the dev checkout
    template: bool  # argv came from the declaration's template, not the artifact's own executable


def resolve(module: str) -> Resolved | None:
    """This host's copy of `module`, or None when it has none it could run.

    One lookup for every consumer (`available`, `launch_prefix`, `_start`), so
    "installed" and "checked out" can never be read two different ways: the host
    runs the artifact installed on ITS own machine, and falls back to the dev
    checkout beside the host repo (modules.component_dir, components.installed).
    A registration may name the code's own directory for an out-of-tree
    component, and that is used instead.

    `installed` is a fact about the LAYER, not about the manifest: a checkout
    carries a component.json of its own now, so "has a manifest" no longer
    separates the two — "is the directory the install root resolves to" does.
    """
    mod = catalog.table().get(module)
    if mod is None:
        return None
    resolved_install = components.resolve(mod.name)
    install_dir = resolved_install[0] if resolved_install else None
    directory = Path(mod.directory) if mod.directory else (install_dir or modules.module_dir(mod.name))
    if not directory.is_dir():
        return None
    installed_here = install_dir is not None and directory == install_dir
    # the manifest the install resolved BY is already in hand; only an
    # out-of-tree or checked-out directory has to be read here
    manifest = resolved_install[1] if installed_here else components.read_manifest(directory)
    rendered = render_launch(mod, directory, manifest, installed=installed_here)
    if rendered is None:
        return None
    argv, template = rendered
    return Resolved(
        module=mod,
        directory=directory,
        argv=argv,
        installed=installed_here,
        template=template,
    )


def render_launch(
    mod: catalog.Component,
    directory: Path,
    manifest: dict | None = None,
    *,
    installed: bool = False,
) -> tuple[tuple[str, ...], bool] | None:
    """(argv words, they came from the declaration's template) for one process of
    `mod` inside `directory`, or None when nothing there can be started.

    An INSTALLED component may ship its own executable, and that supersedes the
    template — the artifact's shape is the installer's business, and this is how
    a onefile needs neither interpreter nor checkout. Two names are honoured:
    the one its manifest declares, then the one its declaration declares, then —
    for an install only — the install layer's own convention, an executable
    named after the component (components.install lays a single-file artifact
    down exactly so).

    Otherwise the declaration's TEMPLATE is rendered with what only the host
    knows: `{py}` the interpreter, `{dir}` this directory, `{name}` the
    component's name, `{script}` its entry-point file.

    Nothing here is a shell: the words go to Popen as they are, so a component
    whose name contains a space needs no quoting and a template word cannot
    smuggle one in (quoting belongs to the statement layer, tools/inst.py).
    """
    declared = (manifest or {}).get("launch")
    names = [
        declared.get("binary") if isinstance(declared, dict) else "",
        mod.launch.binary,
        mod.name if installed else "",
    ]
    for candidate in names:
        if not isinstance(candidate, str) or not candidate:
            continue
        exe = directory / candidate
        if exe.is_file() and os.access(exe, os.X_OK):
            return (str(exe),), False
    if not mod.launch.argv:
        return None
    variables = {"py": modules.python_exe(), "dir": str(directory), "name": mod.name}
    if mod.launch.entry:
        entry = directory / mod.launch.entry
        if not entry.is_file():
            return None
        variables["script"] = str(entry)
    return tuple(_fill(word, variables) for word in mod.launch.argv), True


def _fill(template: str, variables: dict[str, str]) -> str:
    """Substitute the host placeholders a template word names. An unknown
    placeholder is left standing rather than crashing the host: it is visible in
    the command line, which is where a template bug belongs."""
    for key, value in variables.items():
        template = template.replace("{" + key + "}", value)
    return template


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

    Facts, all of them local and cheap: the artifact is here (installed for this
    host, or checked out beside the repo) and this host has the facilities the
    component declares it needs (`requires`). When it is not, the component has
    no tools — `unavailable_reason()` is the sentence to show.
    """
    return not unavailable_reason(module)


def unavailable_reason(module: str) -> str:
    """Why this host cannot drive `module` ("" when it can), as one sentence.

    `requires` is what makes this explainable instead of a silent no: a
    component declares the host facilities it stands on (an interpreter, curl —
    a daemon is spoken to through a `curl` statement — a POSIX shell), and the
    missing one is named here rather than left to be inferred from a mysterious
    failure later.
    """
    mod = catalog.table().get(module)
    if mod is None:
        return f"unknown component: {module}"
    resolved = resolve(module)
    if resolved is None:
        return f"{mod.name} is not installed on this host"
    if "posix-shell" in mod.requires and not local_shell().posix:
        return (
            f"{mod.name} needs a POSIX shell to be driven, and this host's "
            f"shell is {local_shell().name}"
        )
    if "curl" in mod.requires and shutil.which("curl") is None:
        return (
            f"{mod.name} is a daemon spoken to over loopback HTTP and this host "
            f"has no curl"
        )
    if resolved.template and "{py}" in mod.launch.argv[0] and modules.python_missing():
        return (
            f"{mod.name} runs under Python and this host has no interpreter that "
            f"can run it (CLUTCH_PYTHON unset, no python on PATH)"
        )
    return ""


def serves_workspace_fs(module: str) -> bool:
    """True when the component serves the WORKSPACE root's own filesystem.

    Its subject is the machine the root lives on, so a statement may only be
    spoken to it while the workspace IS that machine (registry.module_blocked_reason); a
    component serving anything else — the app's project file, the network, the
    skill library — is unaffected by where the workspace lives. Keyed on the
    subject and not on the interface: a daemon serving a foreign filesystem over
    a channel it owns is a daemon too, and it is not this.
    """
    mod = catalog.table().get(module)
    return mod is not None and mod.subject == catalog.WORKSPACE_FS


def host_vars(mod: catalog.Component, config) -> dict[str, str]:
    """The host facts a component's declaration asks for, by their published
    names (catalog.Component.vars: "host.port_url" -> {base}).

    These are the values only the host knows and only a particular component
    needs: the project file's content service, and the skills root. The prefix
    of a CLI line is NOT here — that is the artifact's own launch, rendered by
    launch_prefix() so a checkout, a package and an installed onefile all drive
    the same declaration.
    """
    # NB: a key here must never be one of a tool's own argument names — the
    # renderer fills {name} from the CALL's arguments, and a host var of the
    # same name would silently overwrite the model's value (clutch-memory's
    # `--title {name}` is exactly that).
    facts = {
        "host.port_url": lambda: f"http://127.0.0.1:{config.port}",
        "config.skills_dir": lambda: str(getattr(config, "skills_dir", "") or ""),
    }
    out: dict[str, str] = {}
    for name, fact in mod.vars.items():
        make = facts.get(fact)
        if make is not None:
            out[name] = make()
    return out


def launch_prefix(module: str) -> str:
    """How one CLI component process STARTS, as a line prefix ("" for a daemon,
    whose process this file starts itself when a statement needs a service).

    This is the launch contract: the artifact's shape decides the prefix — an
    interpreter plus an entry-point file for a checkout, `-m <package>` with its
    directory on PYTHONPATH for a package, a bare executable for an installed
    onefile — and the declaration only says which flags follow it. A component
    therefore needs no second implementation to be installed as a binary.
    """
    mod = catalog.table().get(module)
    if mod is None or mod.interface != catalog.CLI:
        return ""
    resolved = resolve(module)
    if resolved is None:
        raise RendezvousError(unavailable_reason(module))
    words = [shq(word) for word in resolved.argv]
    if resolved.module.launch.importable:
        words.insert(0, f"PYTHONPATH={shq(str(resolved.directory))}")
    return " ".join(words)


@dataclass(frozen=True)
class Statement:
    """One statement, ready to render and run: where it runs and what fills it.

    `prefix` is how the component's process starts (a CLI's launch; "" for a
    daemon, whose line is the whole loopback call); `vars` are the host
    placeholders the template names (a daemon's port/token/status, a CLI's
    endpoint/root facts); `runner` is the transport that carries the rendered
    line (the workspace's own for a daemon module — the filesystem it serves is
    its machine's — the app host's for a CLI, whose subject is the app's project
    file / the network / the skill library).
    """

    vars: dict[str, str]
    runner: Any
    prefix: str = ""


def prepare(module: str, workspace: Any, config) -> Statement:
    """Everything one statement needs before it can be rendered and run.

    A daemon module is reached through the workspace's own transport (loopback
    from the machine that owns the files); a CLI module is reached through the
    app host's, whatever kind of workspace the call came from.
    """
    mod = catalog.table().get(module)
    if mod is None:
        raise RendezvousError(f"unknown module: {module}")
    if mod.interface == catalog.CLI:
        return Statement(
            vars=host_vars(mod, config),
            runner=LocalTransport(str(modules.repo_root())),
            prefix=launch_prefix(module),
        )
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
    mod = catalog.table().get(module)
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


def _record_path(root: str, mod: catalog.Component) -> Path:
    """The discovery file a module daemon for this workspace publishes."""
    override = os.environ.get(mod.discovery_env)
    if override:
        base = Path(override)
    else:
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) / mod.app_dir if local else Path.home() / f".{mod.app_dir}"
    digest = hashlib.sha256(os.path.normcase(root).encode("utf-8")).hexdigest()[:32]
    return base / f"{mod.prefix}{digest}.json"


def _read_record(root: str, mod: catalog.Component) -> dict | None:
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


def _import_dirs(resolved: Resolved) -> list[Path]:
    """The roots to put on a spawned daemon's PYTHONPATH: the component's own,
    and only when its launch says it is a package that has to be imported
    (`-m <package>`), never a sibling's (the dependency graph is a star)."""
    return [resolved.directory] if resolved.module.launch.importable else []


def _start(
    root: str, mod: catalog.Component, fences: tuple[str, ...], key: tuple[str, str, tuple[str, ...]]
) -> Service:
    resolved = resolve(mod.name)
    if resolved is None:
        raise RendezvousError(unavailable_reason(mod.name))
    cmd = [*resolved.argv, "--workspace", root, "--idle", _idle()]
    for glob in fences:
        cmd += ["--protect", glob]
    try:
        env = modules.module_env(_import_dirs(resolved))
        proc = subprocess.Popen(cmd, cwd=str(resolved.directory), env=env, **_detach())
    except OSError as err:
        raise RendezvousError(f"could not start the {mod.name} daemon: {err}") from None
    deadline = time.monotonic() + READY_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RendezvousError(f"the {mod.name} daemon exited during startup (status {proc.returncode})")
        record = _read_record(root, mod)
        if record is not None:
            svc = _service(mod.name, record)
            if _healthy(svc):
                _FENCED[(mod.name, root)] = fences
                _CACHE[key] = svc
                _PROCS[svc.pid] = proc
                return svc
        time.sleep(0.05)
    try:  # a daemon that never published is ours to clean up
        proc.kill()
        proc.wait(timeout=PROBE_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        pass
    raise RendezvousError(f"the {mod.name} daemon did not become ready within {READY_SECONDS:g}s")


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
