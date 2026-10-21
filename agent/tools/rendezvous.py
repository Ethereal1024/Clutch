"""Rendezvous: how the host reaches a component's process, once it has one.

catalog.py declares WHAT a component is and what it publishes; this file is the
mechanics of getting to it. The host imports NOTHING from a component — it may
point at nothing but the component's PUBLISHED interface, in the two shapes that
comes in: a per-workspace daemon named by a record (this file starts it, watches
its pid, and hands a statement the facts it needs — the SPEAKING is the
statement's own text), and a one-process command line the app host runs itself.
Which of the two a call needs, and the line it renders, is tools/statement.py:
this file's job ends at a live `Service` (or a resolved artifact), never at a
rendered statement.

A component that is not on this machine is not an error to be papered over: it
has no tools (registry.build_tools) and `unavailable_reason()` is the sentence a
client can show. Nothing here answers on a component's behalf.

Three facts describe a component and they are independent (see
catalog.Component): WHAT a statement is spoken to (a `service` — a per-workspace
process over loopback HTTP, whose record this file finds — or a line the app host
runs itself), WHERE its process runs relative to the host being asked (derived:
a `service` or a `launch` = here, neither = the client that declared it), and
WHOSE resources it serves (subject). Every component that declares a process runs
on the host that asks, and the axis is ENFORCED rather than decorative: a
CLIENT-side declaration (Component.client_side) contributes no tools until this
host has a channel to that client machine (`unavailable_reason` says so, as a
sentence a client can show) — it must never quietly run here, which is the one
thing the derivation forbids. So a component that serves ANOTHER machine's
filesystem (an ssh workspace), or one that is called FROM another host (a
client-side component behind a reverse channel), adds an ENTRY to the table, never
a branch to a tool.

Where a component's artifact comes from is a different question again, and
tools/components.py answers it: the host runs the component installed on ITS own
machine, falling back to the dev checkout next to the repo.

Lifecycle: a daemon started from here is fenced with the workspace's protected
paths at spawn time (the module's fence IS spawn-time policy — its own docs say
"to change it, stop the daemon and restart"), and is stopped when this process
exits. The host owns the children it starts — but only those: a daemon it merely
found is ridden when that daemon is already fenced at least as much as the call
needs (see Handle, `_covers`), and left running when this process exits without
having started it. A daemon that cannot be ridden because its fence is too small
is left running too: it is not ours to stop, its own idle timer ends it, and it
cannot unpublish its replacement (a daemon removes the record only while the
record still names it — see discovery.remove).

Nothing here speaks the component's protocol. HOW a daemon is called is the
declaration's `command`; the host's whole contribution to it is facts — a port,
a token, a pid — and the record's shape, which is the one thing the host
dictates (see `_read_record`).
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import catalog, channel, components, modules
from .localshell import local_shell

RECORD_VERSION = 1
READY_SECONDS = 10.0  # how long a daemon we just spawned has to publish itself
STOP_SECONDS = 2.0  # how long a stopped child may take to wind down before it is killed
DEFAULT_IDLE = 600.0  # the daemon's own idle default; CLUTCH_RENDEZVOUS_IDLE overrides

# The vocabulary (subject, and the service/launch derivation — catalog.Component)
# is the DECLARATION's, and this file reads it from there rather than restating
# it: two spellings of "no process here" would be two things to keep in step.


class RendezvousError(RuntimeError):
    """No usable service for this workspace and none could be started."""


@dataclass(frozen=True)
class Resolved:
    """A component found ON THIS HOST: where its code is and how one process of
    it starts. The launch, never where the statement is spoken — see
    catalog.Component."""

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
    """A live module daemon: where it answers and how a statement authenticates.

    These are FACTS the host read out of the daemon's own record, not words of
    any protocol: a statement that wants an HTTP header, a path, or a query
    spells all of it in the component's own text (inst.render quotes a host
    value like any other word, so `-H 'X-Clutch-Token: {token}'` is the shape).
    """

    module: str
    port: int
    token: str
    pid: int

    def vars(self) -> dict[str, str]:
        """The host placeholders a statement template may use (see inst.render)."""
        return {"port": str(self.port), "token": self.token, "pid": str(self.pid)}


@dataclass
class Handle:
    """Everything this host knows about ONE (module, workspace root) daemon:
    where it answers (`service`), the fence it was SPAWNED with (`fences` — a
    spawn-time policy, see fence_globs), and the child, when the child is ours
    (`proc`; None when another Clutch started it and this one is only riding).

    The host owns its children: a daemon we started must be waited on, or an
    exited daemon stays a zombie and still answers os.kill(pid, 0) — "release()
    stopped it" would be a lie the OS keeps telling.
    """

    service: Service
    fences: tuple[str, ...]
    proc: subprocess.Popen | None = None


_LOCK = threading.RLock()
# One daemon per (module, workspace root) — so one entry per daemon. This used
# to be three tables (the service keyed by (module, root, fences), the fence by
# (module, root), the child by pid) holding three facets of the same fact, and
# keeping them in step by hand was the bug: a key still carrying a fence nobody
# was asking for any more went on naming a daemon whose pid had long died, so
# the next call read somebody else's healthy record, called it "a changed
# fence", and killed it. Alternating fences restarted the daemon every call.
_HANDLES: dict[tuple[str, str], Handle] = {}


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

    `disabled` is asked HERE rather than in `resolve()`, and that placement is
    the whole point: the switch is about the COMPONENT, not about one copy of it,
    so a stopped component's tools are gone even when the code that would run is
    the dev checkout beside the repo. Left to resolve(), a disabled component on
    a dev machine would still hand the model its tools — "disabled in the page,
    and the tool is still there" — which is the one reading the flag exists to
    prevent.
    """
    mod = catalog.table().get(module)
    if mod is None:
        return f"unknown component: {module}"
    if components.disabled(mod.name):
        return f"{mod.name} is disabled on this host (its tools are off; the bytes stay)"
    if mod.client_side:
        # Fail CLOSED, and before `resolve`: this component has no process on this
        # machine at all (neither `service` nor `launch`), so its bytes are not
        # here and "not installed on this host" would be a lie about the wrong
        # thing. There is exactly ONE door through that refusal, and it is a live
        # channel that holds this component's declaration (tools/channel.py): the
        # client said what it runs and where to call it, so this host can drive it
        # without ever launching it. Anything else — no push, an older push that
        # did not name it, a client-side declaration nobody implements — is "no
        # channel", never a quiet local run, which is what the derivation exists to
        # forbid.
        if channel.holds(mod.name):
            return ""
        return (
            f"{mod.name} runs on the client that calls it and this host "
            f"has no channel to that client"
        )
    resolved = resolve(module)
    if resolved is None:
        return f"{mod.name} is not installed on this host"
    if "posix-shell" in mod.requires and not local_shell().posix:
        return (
            f"{mod.name} needs a POSIX shell to be driven, and this host's "
            f"shell is {local_shell().name}"
        )
    if "curl" in mod.requires and shutil.which("curl") is None:
        return f"{mod.name} is driven through curl and this host has no curl"
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
    subject and not on how the statement is spoken: a service serving a foreign
    filesystem over a channel it owns is a service too, and it is not this.
    """
    mod = catalog.table().get(module)
    return mod is not None and mod.subject == catalog.WORKSPACE_FS


def serves_foreign_fs(module: str) -> bool:
    """True when the component serves a filesystem that is NOT the root's machine.

    The other half of the sentence above, and the one `TODO(ssh-workspace)` asked
    for: a `foreign-fs` component reaches the machine on the far side of a
    channel (clutch-ssh-workspace, over an ssh tunnel), so it is the workspace
    that has to be somewhere else for its tools to mean anything. On a local
    session the same tools exist natively, and calling this one there would read
    or write a different machine than the root names.
    """
    mod = catalog.table().get(module)
    return mod is not None and mod.subject == catalog.FOREIGN_FS


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


def _covers(fenced: tuple[str, ...], wanted: tuple[str, ...]) -> bool:
    """True when a daemon fenced with `fenced` already enforces `wanted`.

    A fence cannot be widened after the fact — it is spawn-time policy inside
    the component — so the only question is whether the daemon protects AT
    LEAST this much. Over-fencing is the safe direction (fence_globs): the cost
    of keeping a fence too long is the component refusing a path this host
    stopped protecting, never the component touching one it should not.
    """
    return set(wanted) <= set(fenced)


def _widen(fenced: tuple[str, ...], wanted: tuple[str, ...]) -> tuple[str, ...]:
    """Both fences, for the daemon that replaces one: the fence only ever GROWS
    for a (module, root), so the next call asking for what the replaced daemon
    had does not have to replace this one too."""
    return tuple(sorted(set(fenced) | set(wanted)))


def _child(handle: Handle | None, pid: int) -> subprocess.Popen | None:
    """The child this host started, when `handle` still describes that same
    daemon — the only case in which reaping it is our business."""
    return handle.proc if handle is not None and handle.service.pid == pid else None


def service(root: str | Path, module: str, protect: Iterable[Path | str] = ()) -> Service:
    """The live service for this workspace, starting one when needed.

    Raises RendezvousError when the module is not available or the daemon never
    became ready — callers report that as error-as-data, never as a crash.

    The fence is the one reason a live daemon is ever replaced: it is fixed at
    spawn time, so a daemon is ridden when it is fenced AT LEAST as much as
    this call asks (`_covers`; over-fencing is the safe direction) and replaced
    with one carrying the wider set when it is not. Two fences alternating
    therefore cost one restart, then nothing — where the key-per-fence this
    replaces restarted on every single call.
    """
    mod = catalog.table().get(module)
    if mod is None:
        raise RendezvousError(f"unknown module: {module}")
    if mod.service is None:
        raise RendezvousError(f"{module} publishes no service: its statements run as one process per call")
    record_of = mod.service
    resolved = str(Path(root).resolve())
    wanted = fence_globs(protect, resolved)
    key = (module, resolved)
    with _LOCK:
        handle = _HANDLES.get(key)
        if handle is not None and _pid_alive(handle.service.pid) and _covers(handle.fences, wanted):
            return handle.service
        record = _read_record(resolved, record_of)
        live = _service(module, record) if record is not None else None
        fenced = _fenced_with(resolved, record_of, live, handle)
        if live is not None and _covers(fenced, wanted):
            _HANDLES[key] = Handle(service=live, fences=fenced, proc=_child(handle, live.pid))
            return live
        # Something else is serving this workspace, or what is serving it wears
        # too small a fence. Our OWN child is stopped before it is replaced; a
        # daemon we merely found is left running — it is not ours to signal (a
        # record outlives its daemon, see _read_record), its idle timer ends it,
        # and the replacement we start publishes over it.
        _HANDLES.pop(key, None)
        _stop(handle.proc if handle is not None else None)
        return _start(resolved, mod, record_of, _widen(fenced, wanted))


def release(root: str | Path, module: str) -> None:
    """Stop this process's daemon for this workspace (best effort) and forget it.

    Only a child THIS process started: for a daemon that was merely found, this
    is a forget, not a kill (see release_all — the same rule, for the same
    reason: ownership is what makes stopping safe).
    """
    resolved = str(Path(root).resolve())
    with _LOCK:
        handle = _HANDLES.pop((module, resolved), None)
        if handle is not None:
            _stop(handle.proc)


def release_all() -> None:
    """Stop every daemon THIS process started, and forget them all (process
    exit / test teardown).

    A daemon this process ADOPTED — one another window started, or one of ours
    that is simply being ridden again — is forgotten and left running: it is not
    ours to kill, and its own idle timer is what ends it.
    """
    with _LOCK:
        for handle in list(_HANDLES.values()):
            _stop(handle.proc)
        _HANDLES.clear()


atexit.register(release_all)


# -- removal: what a component's bytes must not be removed from under ----------


def live_daemons(module: str) -> list[Service]:
    """Every daemon of `module` that is alive right now, whichever workspace it
    serves and whichever process started it.

    The records on disk are the only list of a component's daemons that exists —
    this process publishes none of its own, and a record is named by a HASH of
    the workspace it serves, so no root can be enumerated from a name. Listing
    the module's own record directory is therefore the way to ask the machine
    the only question it can answer from the filesystem: is anything of this
    component running? The `.host` notes beside the records are this host's
    fence bookkeeping, not records (see _note_path).

    A component that publishes no service has no resident process at all: nothing
    to list.
    """
    mod = catalog.table().get(module)
    if mod is None or mod.service is None:
        return []
    try:
        candidates = sorted(mod.service.directory().glob(f"{mod.service.prefix}*.json"))
    except OSError:  # no directory yet is not an error, and not a daemon either
        return []
    out: list[Service] = []
    for path in candidates:
        if path.name.endswith(".host.json"):
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        record = _live_record(payload)
        if record is not None:
            out.append(_service(module, record))
    return out


def stop_for_removal(module: str) -> str:
    """Why this host must NOT remove `module`'s artifact ("" when it may), having
    first stopped every daemon of OURS for it.

    Removing a component is not only a filesystem act: a daemon of it that is
    running is a process reading the very bytes that would go. So the rule is
    "stop first, then delete", with the ownership rule this file already keeps
    (release, _stop): a daemon THIS process started is stopped — our own child,
    whose SIGTERM path unpublishes its record on the way out — and a daemon this
    process did NOT start is not ours to signal, so its presence is a REFUSAL
    with the pid named, and the artifact stays. That is the same verdict a
    foreign daemon gets everywhere else here: a pid read off disk is not a
    licence to kill, and a host that cannot stop the process must not delete
    the code it is running.

    A handle with no child (`proc is None`) is a daemon we ADOPTED — somebody
    else started it — so it is refused by the same rule, not stopped.
    """
    with _LOCK:
        ours = [
            (key, handle)
            for key, handle in _HANDLES.items()
            if key[0] == module and handle.proc is not None
        ]
        for key, handle in ours:
            _HANDLES.pop(key, None)
            _stop(handle.proc)
        foreign = live_daemons(module)
    if foreign:
        pids = ", ".join(str(service.pid) for service in foreign)
        return (
            f"{module} is being served right now by a daemon this process did not start "
            f"(pid {pids}): stop it first — a component's bytes are not removed from under "
            f"a running process"
        )
    return ""


# -- discovery: the record a daemon publishes, and its readiness ---------------


def _read_record(root: str, service: catalog.Service) -> dict | None:
    """The published record, or None when it is missing, corrupt, or dead.

    The record's SHAPE is the one thing the host dictates: the component writes
    the file, the host reads a version, a port, a token and a pid out of it.
    Nothing about HOW the daemon is called is named here — that is the
    declaration's statement, and the host only fills its facts in.
    """
    try:
        payload = json.loads(service.record(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return _live_record(payload)


def _live_record(payload: Any) -> dict | None:
    """The record's payload when it names a daemon that is ALIVE right now (None
    otherwise): the shape check and the pid check every reader of a record makes,
    in one place, because a record outlives the daemon that wrote it."""
    if not isinstance(payload, dict) or payload.get("version") != RECORD_VERSION:
        return None
    port, pid, token = payload.get("port"), payload.get("pid"), payload.get("token")
    if not (isinstance(port, int) and 0 < port <= 65535 and isinstance(token, str) and token):
        return None
    if not (isinstance(pid, int) and _pid_alive(pid)):
        return None
    return payload


def _note_path(root: str, service: catalog.Service) -> Path:
    """Where this host writes down the fence it spawned the daemon with.

    Beside the daemon's own record, because that is what it describes: the
    record says who is serving this workspace, the note says how WE fenced
    them. The component neither writes it nor reads it — the fence is the
    host's policy, and no component contract has to carry it for a second
    Clutch window to ride a daemon this one already fenced properly.
    """
    record = service.record(root)
    return record.with_name(f"{record.stem}.host{record.suffix}")


def _fenced_with(
    root: str, service: catalog.Service, live: Service | None, handle: Handle | None
) -> tuple[str, ...]:
    """The fence the daemon now serving this workspace was spawned with.

    Known when it is the daemon this process rides (one it started, or one it
    adopted earlier), or when a host process left a note naming exactly this
    pid. A daemon nobody can account for counts as UNFENCED, which is what
    makes "a fence there is something to enforce is never trusted to a
    stranger" hold across windows and restarts too — at the price of one
    restart, paid once, instead of one per call.
    """
    if live is None:
        return ()
    if handle is not None and handle.service.pid == live.pid:
        return handle.fences
    note = _note(root, service, live.pid)
    return note if note is not None else ()


def _note(root: str, service: catalog.Service, pid: int) -> tuple[str, ...] | None:
    """The fence recorded for the daemon at `pid`, or None when no note
    describes THAT daemon (none, junk, or one left about an older daemon)."""
    try:
        payload = json.loads(_note_path(root, service).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("pid") != pid:
        return None
    protect = payload.get("protect")
    if not isinstance(protect, list) or not all(isinstance(glob, str) for glob in protect):
        return None
    return tuple(protect)


def _write_note(root: str, service: catalog.Service, pid: int, fences: tuple[str, ...]) -> None:
    """Record the fence the daemon we just started was given.

    Best effort: a host that cannot write it loses reuse ACROSS processes,
    never correctness — its own handle still knows the fence."""
    path = _note_path(root, service)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"pid": pid, "protect": list(fences)}), encoding="utf-8")
    except OSError:
        pass


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


def _stop(proc: subprocess.Popen | None) -> None:
    """Stop a daemon THIS process started, and wait for it.

    Only a child we started: a daemon we merely found answers to whoever
    started it, and the host cannot tell a pid taken from a stale record from
    any other process holding that number — a signal is not something to aim
    at a number read off disk.

    The signal is SIGTERM, which a daemon of ours treats as "wind down" (it
    unpublishes its record on the way out); a daemon that ignores it is killed.
    """
    if proc is None:
        return
    try:
        proc.terminate()
    except OSError:
        pass
    _reap(proc)


def _reap(proc: subprocess.Popen) -> None:
    """Wait for a child we stopped; kill it if the signal did not land."""
    try:
        proc.wait(timeout=READY_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=STOP_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            pass


# -- starting a daemon: detached, fenced, and outliving this call --------------


def _import_dirs(resolved: Resolved) -> list[Path]:
    """The roots to put on a spawned daemon's PYTHONPATH: the component's own,
    and only when its launch says it is a package that has to be imported
    (`-m <package>`), never a sibling's (the dependency graph is a star)."""
    return [resolved.directory] if resolved.module.launch.importable else []


def _start(
    root: str, mod: catalog.Component, service: catalog.Service, fences: tuple[str, ...]
) -> Service:
    """Spawn one daemon and wait for it to publish ITSELF.

    Readiness is the record: a daemon publishes the moment its socket is
    listening, and the record is the component's own promise that it is there —
    the host does not call the component to ask (it knows no call). The record
    it waits for has to be NEW: a daemon we could not ride is left running (see
    `service`), and its record is still on disk while our child boots; adopting
    that one would claim, in the note below, a fence it never wore.
    """
    resolved = resolve(mod.name)
    if resolved is None:
        raise RendezvousError(unavailable_reason(mod.name))
    before = _read_record(root, service)
    was = before["pid"] if before is not None else None
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
        record = _read_record(root, service)
        if record is not None and record["pid"] != was:
            svc = _service(mod.name, record)
            # the fence travels with the record, for the host processes that
            # did not spawn this daemon: without the note they would have to
            # replace one they could have ridden
            _write_note(root, service, svc.pid, fences)
            _HANDLES[(mod.name, root)] = Handle(service=svc, fences=fences, proc=proc)
            return svc
        time.sleep(0.05)
    try:  # a daemon that never published is ours to clean up
        proc.kill()
        proc.wait(timeout=STOP_SECONDS)
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
