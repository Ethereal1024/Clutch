"""Per-machine supervisor: spawns and manages session subprocesses.

Every UI window is a SESSION: the supervisor spawns one agent.server child
(--port 0, random port parsed from its stdout banner) per session and reports
the port back. The window then talks to its child DIRECTLY (locally, or over
its own tunnel forward) — the supervisor never proxies traffic, it only owns
the lifecycle: spawn, beat, release, reap. No message it forwards carries work
(the model path lives in the client, not in the child — see the P4 note below).

Endpoints:

    POST /api/session/start      -> {session_id, port}
    POST /api/session/stop       -> release the session child: a child that is
                                    provably idle (or whose claiming process is
                                    provably gone) is stopped; one with a run in
                                    flight is LEFT RUNNING — unless the request
                                    says {leaving: true} (the app is quitting,
                                    and then nothing may outlive it)
    POST /api/session/heartbeat  -> keep the session alive (stale ones die)
    GET  /api/health             -> ok

    GET  /api/locks              -> every .clc write lock this user's temp dir
                                    knows, classified (held? by whom? alive?)
    POST /api/locks/reclaim      -> {project, witness?}: free a lock whose claiming
                                    window is PROVEN gone; refuses a live window.
                                    A claim that names another machine is freed
                                    only on THAT machine's witness ({host, pid,
                                    start} — its own kernel's answer), because it
                                    is the only machine that can know.

Component install (the install layer's receiving half — a component always
belongs to the machine its server runs on, so this process is who a client
installs ONTO, whether it is this desktop or a device behind a tunnel):

    GET    /api/components          -> {components: [{name, version, digest, disabled}]}
    GET    /api/components/versions -> ?name= -> one record per installed version
    POST   /api/components/install  -> take one artifact; the manifest rides in the
                                       X-Clutch-Component header (base64 of its
                                       JSON), the artifact is either the
                                       body or an artifact_url this host fetches
                                       -> {status: "installed"|"current", ...}
    DELETE /api/components/<name>   -> ?version= names ONE version to drop; without
                                       it the component goes whole
                                       -> {status: "removed"|"absent", ...}

Component settings (the knobs a component declares for a PERSON to set — the
declaration is the form, so the host serves it as data and draws nothing):

    GET  /api/components/settings  -> ?name= -> {name, schema, values}
    POST /api/components/settings  -> {name, values: {key: value}} ->
                                      {status: "saved", values: {...}} — the
                                      whole document; a key or a value the
                                      declaration does not carry is refused as
                                      error-as-data

The removal verbs are the install endpoint's reverse, and answer the same way: a
verdict, or the host's own sentence as error-as-data. They refuse while a daemon
of the component is running that this process did not start (rendezvous.
stop_for_removal) — see components.remove.

Lifecycle (per product decision):
  - the FIRST window starts the supervisor (Electron probes /api/health and
    spawns it when down); the LAST window's exit ends it — each window stops
    its session on close, and the supervisor self-exits after an idle grace
    once no sessions remain. A stale-session reaper also clears sessions whose
    window crashed (heartbeat stops) — but silence is a question, not a
    verdict: it asks the child (GET /api/health -> in_flight) and a run in
    flight outvotes it, so a frozen window (a phone in the background, with no
    timers) cannot cost a live run its session.
  - on Windows each session child is assigned to a kill-on-close Job by the
    generic layer (agent.procmgr.kill): a supervisor that dies without reaping
    (crash, TerminateProcess, Electron's tree going down with it) would orphan
    the session — the Job makes the kernel kill the whole session tree the
    moment this process's Job handles die with it. An orphaned session is not
    cosmetic: it keeps holding its .clc write lock, and reopening that project
    then lands read-only with no visible other window.

Locking: each session child is an independent process, so the .clc write lock
is a kernel file lock (flock / LockFileEx) on the machine's tmp dir —
process-level mutual exclusion, released by the OS on exit, no TTL needed.
(noclobber+TTL remains only for
the execBridge-degraded path, where the agent process and the project files
live on different machines.)

Layering: the spawn/port/reap/kill/stdio machinery lives in agent/procmgr —
the general Clutch process-management layer, built to manage every resident
process (workspace daemons next). This module is the session specialization:
the heartbeat contract with UI windows, the agent-server child command, the
fail-fast refusal to run an unkillable session, and the HTTP lifecycle API.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import sys
import threading
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

from agent.build import version as build_version
from agent.core import lock_reconcile, procstat
from agent.procmgr import kill
from agent.procmgr.stdio import SafeStdStream, log, make_stdout_nonblocking
from agent.procmgr.supervise import (
    IDLE_TIMEOUT_S,
    REAP_INTERVAL_S,
    STALE_S,
    ManagedProcess,
    ProcessSupervisor,
    SpawnSpec,
)
from agent.tools import catalog, components, rendezvous, settings

DEFAULT_PORT = 8890
PORT_BANNER_RE = re.compile(r"\[clutch-server\] http://127\.0\.0\.1:(\d+)")
SESSION_START_TIMEOUT_S = 30.0  # child port banner: onefile extraction is slow on a remote
HEALTH_PROBE_TIMEOUT_S = 1.0  # a live child answers at once; a wedged one is no evidence


def session_run_state(port: int | None) -> bool | None:
    """Ask a session child whether a run is in flight, over its /api/health.

    THREE answers, because the two callers need opposite doubts: True = a run
    is live, False = the child PROVED itself idle, None = it could not be told
    apart (no port, connection refused, a timeout, an answer we cannot read).
    The reaper treats a doubt as idle — an unreachable child is garbage to
    collect (see session_in_flight); a release treats a doubt as busy — a stop
    must never end what may be a live run, and the reaper collects the child
    later, once it can prove the child idle.
    """
    if not port:
        return None
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=HEALTH_PROBE_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
    except (OSError, ValueError, HTTPException):
        return None
    if not isinstance(body, dict) or "in_flight" not in body:
        return None
    return bool(body["in_flight"])


def session_in_flight(port: int | None) -> bool:
    """Whether a run is provably live in this child (the reaper's question).

    False on ANY doubt — no port, connection refused, a timeout, an answer we
    cannot read. This is corroboration, never the contract: only a positive
    answer ever keeps a silent window's session alive.
    """
    return session_run_state(port) is True

# session-specific names for the generic layer's timers (kept for greppability:
# the UI's heartbeat budget is defined against SESSION_STALE_S)
SESSION_STALE_S = STALE_S


# compat re-export: the dead-parent resilience test constructs this directly
_SafeStdStream = SafeStdStream


@dataclass
class Session(ManagedProcess):
    """A session record: the generic child plus the session-facing names the
    HTTP API and the tests use (session_id, job)."""

    # The window that claimed this session, as the kernel knew it at spawn:
    # (pid, starttime). This is the fact the reaper uses to decide whether the
    # silence is a frozen window (still a live process) or a dead one — a
    # heartbeat is a message that a backgrounded window cannot send, a process
    # in /proc is not. None for a remote claim: that pid lives on the client's
    # machine and this host can never check it (the claim is recorded on the
    # lock, naming its machine, for that machine to attest to).
    claim_pid: int | None = None
    claim_start: str | None = None

    @property
    def session_id(self) -> str:
        return self.key

    @property
    def job(self) -> int | None:
        return self.guarantee

    @job.setter
    def job(self, value: int | None) -> None:
        self.guarantee = value


class SessionSupervisor(ProcessSupervisor):
    """Owns session children. No session logic itself — just spawn, route the
    port back, and reap. Thread-safe: the processes dict is guarded by a lock
    (aliased below as ``sessions``)."""

    # compat alias: the kill-ladder test calls Supervisor._kill(proc) directly
    _kill = staticmethod(kill.stop_process)

    def __init__(
        self,
        agent_cmd: list[str],
        cwd: str | None = None,
        stale_s: float = SESSION_STALE_S,
        idle_timeout_s: float = IDLE_TIMEOUT_S,
        reap_interval_s: float = REAP_INTERVAL_S,
        start_timeout_s: float = SESSION_START_TIMEOUT_S,
    ) -> None:
        super().__init__(
            stale_s=stale_s,
            idle_timeout_s=idle_timeout_s,
            reap_interval_s=reap_interval_s,
            # None = platform default: on Windows an unkillable session is
            # refused (start_session below never runs an orphan-in-waiting)
            require_kill_guarantee=None,
            label="supervisor",
        )
        self.agent_cmd = list(agent_cmd)
        self.cwd = cwd
        self.start_timeout_s = start_timeout_s
        self.sessions = self.processes  # same dict, session-named for callers

    # ---- session lifecycle ----

    def start_session(
        self,
        base_url: str | None = None,
        model: str | None = None,
        reasoning_effort: str | None = None,
        api_protocol: str | None = None,
        claim_pid: int | None = None,
        claim_start: str | None = None,
        claim_host: str | None = None,
    ) -> Session | None:
        """Spawn one agent.server child on a random port, learning the port from
        its stdout banner. None when the child never prints it. base_url/model
        are forwarded as --base-url/--model: a REMOTE session's LLM endpoint and
        model belong to the claiming client (which owns the settings), not to
        the remote host's own ~/.clutch/settings.json — that file usually has no
        model at all, and an empty model aborts the run before it starts. The
        reasoning_effort / api_protocol knobs ride along for the same reason:
        the child validates them through argparse choices, so an unknown value
        fails the spawn loudly instead of being silently ignored.

        ``claim_host`` names the machine the claiming window runs on — the
        client's, whenever this session was started for a window behind a
        tunnel. This host decides a claim only when that machine is its own: a
        local claim is pinned to the kernel's identity here and REFUSED when
        there is no such process, while a remote one is forwarded verbatim (the
        child records it so the machine named can attest to it later, and this
        host's reaper never reads its own pid table into it)."""
        cmd = [*self.agent_cmd, "--port", "0"]
        if base_url:
            cmd += ["--base-url", base_url]
        if model:
            cmd += ["--model", model]
        if reasoning_effort:
            cmd += ["--reasoning-effort", reasoning_effort]
        if api_protocol:
            cmd += ["--api-protocol", api_protocol]
        claim_is_local = not claim_host or claim_host == socket.gethostname()
        pinned_start: str | None = None
        if claim_pid:
            if claim_is_local:
                # The child records WHICH window claimed it, as THIS kernel knew
                # it, so this host can later prove that window is gone instead of
                # waiting out a timer (see agent/core/lock_reconcile.py). Pin the
                # start tick too: a bare pid is recycled, a (pid, starttime,
                # boot) identity is not. An identity that cannot be read is
                # refused here — spawning a session no one can ever attribute is
                # the orphan this replaces.
                ident = procstat.identity(claim_pid)
                if ident is None:
                    log(f"[supervisor] refusing a session for claim pid {claim_pid}: no such process")
                    return None
                pinned_start = ident["starttime"]
                cmd += ["--claim-pid", str(claim_pid), "--claim-start", pinned_start]
            else:
                # The claimant is a process on the client's machine: forward the
                # facts as the client reported them (it read its own /proc) and
                # say whose machine they belong to. They ride into the child's
                # lock records for that machine's attestation; they are
                # NOT this host's liveness answer about anything.
                cmd += ["--claim-host", claim_host, "--claim-pid", str(claim_pid)]
                if claim_start:
                    cmd += ["--claim-start", claim_start]
        spec = SpawnSpec(
            cmd=cmd,
            cwd=self.cwd,
            banner_re=PORT_BANNER_RE,
            start_timeout_s=self.start_timeout_s,
        )
        record = self.spawn(uuid.uuid4().hex[:12], spec, beat_required=True)
        if record is None:
            return None
        # A remote claim stays "unknown" to the reaper on purpose: this host has
        # no local process to check, and the same pid here would be a stranger.
        record.claim_pid = claim_pid if claim_is_local else None
        record.claim_start = pinned_start if claim_is_local else None
        log(f"[supervisor] session {record.key} on port {record.port}")
        return record  # a Session: _make_record builds the session shape

    def stop_session(self, session_id: str | None, *, leaving: bool = False) -> str:
        """A client is leaving its session; say what became of the child.

        Returns "stopped", "detached" or "unknown".

        ``leaving`` is the APP going away for good (its quit gate sends it): no
        process is left that could come back for a turn this session serves, so
        the child is ended NOW — a lease, a heartbeat or a later reconciler pass
        must never keep alive what the app that claimed it just closed. The
        child's own SIGTERM handler records its `released` final, so the
        transcript still settles (agent/server.py, install_release_handler).

        Without ``leaving`` the client is merely moving (a hop dropped, a slot
        was re-claimed, one tab closed, a window reload). Three answers, in this
        order:

        1. the CLAIM is provably DEAD — stop. The run loop lives in the CLIENT
           now (P2-3), so nothing is left that could finish a turn; a surviving
           child would only hold the lock nobody can use. This is the one fact a
           timer cannot state (pid + start tick, agent/core/procstat), and it
           outvotes any lease: `in_flight` is the client's own memory
           (agent/api/run_state.py, 120 s), not backend work.
        2. the child PROVES itself idle — stop, as eager cleanup. Dropping a
           claim nobody will come back for is exactly what keeps the next
           window from being told "this project is already open".
        3. otherwise (a run in flight, or a child that cannot be asked) — keep
           the child and mark the record ``detached`` so the reaper holds it to
           the plain heartbeat window from now on (see _stale). A frozen phone's
           run, and a claim this host cannot see (a tunnelled client's pid lives
           on the client), are both doubt, and doubt never ends work.
        """
        with self._lock:
            record = self.processes.get(session_id) if session_id else None
        if record is None:
            return "unknown"
        if leaving:
            self.stop(session_id)
            log(f"[supervisor] session {session_id} stopped (the app left for good)")
            return "stopped"
        claim_state = "unknown"
        if record.claim_pid and record.claim_start:
            claim_state = procstat.state(record.claim_pid, record.claim_start)
        if claim_state == "dead":
            self.stop(session_id)
            log(f"[supervisor] session {session_id} stopped (the process that claimed it is gone)")
            return "stopped"
        # The claim says nothing is wrong. That is not the same as "leave it":
        # an idle child is eager cleanup — the window's own release is what a
        # tab close, a reload and a re-claim all send, and keeping a child
        # nobody will ever call again is how a .clc stayed locked (and the next
        # window got the "already open" prompt). Only the child's POSITIVE
        # answer of a run in flight keeps it, and only for a claim that is not
        # provably dead: the run loop lives in the client, so a live claim is a
        # client that may still come back for the turn it is driving.
        run = session_run_state(record.port)
        if run is False:
            self.stop(session_id)
            log(f"[supervisor] session {session_id} stopped (idle, and its client released it)")
            return "stopped"
        why = (
            "its client process is alive"
            if claim_state == "live"
            else "its client cannot be verified from this host"
        )
        if run:
            why += " and a run is in flight"
        with self._lock:
            if self.processes.get(session_id) is record:
                record.detached = True  # no window owns this one any more
        log(f"[supervisor] session {session_id} {why} - left running for the reaper")
        return "detached"

    def heartbeat(self, session_id: str | None) -> bool:
        return self.beat(session_id)

    # ---- hooks ----

    def _make_record(self, key, proc, port, guarantee, beat_required) -> Session:
        return Session(
            key=key,
            proc=proc,
            port=port,
            guarantee=guarantee,
            last_beat=time.time(),
            beat_required=beat_required,
        )

    def _log_stale(self, key: str) -> None:
        log(f"[supervisor] reaping stale session {key}")

    def _stale(self, record: Session, now: float) -> bool:
        """A session is stale only when its window went silent AND the child
        reports nothing in flight.

        The heartbeat contract is with the WINDOW, and a window goes silent
        without dying: an Android app in the background is frozen, its timers
        included, so no beat can be sent while the run it started is still
        going. Reaping then does not clear a dead window — it kills a live run
        mid-flight, which is exactly the "run silently flips to idle" outage.
        So silence is a question, not a verdict: the child lives on this
        machine and answers about itself in-process. A run in flight is the
        child's own liveness evidence, so refresh the beat and leave it alone
        however long the run takes — deliberately unbounded, because a run
        that never ends is a wedged run (its own bug, and its own Stop
        button), not a reason to kill a session that is still working.

        The exception is a record its window RELEASED (stop_session marked it
        ``detached``): there is no window to come back for the run, so the
        child's own evidence has nothing to protect and no one to report to —
        a run there can only be one nobody can see or stop. Those are held to
        the plain heartbeat window (``now - last_beat > stale_s``), so the
        child, and the project lock it took, come back within one window of the
        release. Note what is NOT done here: the child is not stopped at release
        (its run still gets to write its own final, and a re-claim inside the
        window can still re-bind to it), and this is not a try limit on the
        reconnect ladder — the window is the same 300s a backgrounded phone
        gets.

        Before any of that, a LOCAL claim is checked against the kernel: the
        spawning window's pid+starttime (claim_pid/claim_start) still being a
        live process means the window exists and is merely mute — a frozen or
        throttled window, not a departed one — so the beat is refreshed and
        nothing is reaped. A remote claim has no local pid (None) and keeps the
        plain heartbeat window."""
        if not super()._stale(record, now):
            return False
        if record.detached:
            log(f"[supervisor] session {record.key} was released - reaping after its stale window")
            return True
        if record.claim_pid and record.claim_start:
            # The heartbeat is a message; the process is a fact. A window that
            # is frozen (backgrounded phone, suspended app), throttled, or just
            # slow sends no beat, but its process is still there — and a run it
            # started must not die because the message stopped. So before the
            # silence is treated as death, ask the kernel whether the claiming
            # window still exists: only its absence is evidence. (This is the
            # same identity the lock reconciler uses on the lock record, one
            # layer up: the lock's claimant is the window, the session's is too.)
            if procstat.state(record.claim_pid, record.claim_start) == "live":
                log(f"[supervisor] session {record.key} silent but claim pid {record.claim_pid} is alive - not reaping")
                self.beat(record.key)
                return False
        if not session_in_flight(record.port):
            return True
        log(f"[supervisor] session {record.key} has a run in flight - not reaping")
        self.beat(record.key)  # the child vouches for itself: normal contract resumes next pass
        return False


# legacy name: tests, entry scripts and older docs all say Supervisor
Supervisor = SessionSupervisor


# ---- HTTP layer (thin: only session lifecycle endpoints) ----

class _Handler(BaseHTTPRequestHandler):
    supervisor: Supervisor = None  # injected by the server builder

    def log_message(self, fmt, *args) -> None:  # quiet by default
        pass

    def _json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except ValueError:
            return {}

    def _route(self) -> tuple[str, dict[str, str]]:
        """The request's path and its single-valued query, in one place.

        A component's own name is a path segment (DELETE /api/components/<name>),
        so the two are read together rather than compared as one string. A query
        parameter that is spelled but empty (`?name=`) is absent, not "", which
        is what makes a missing name a plain refusal.
        """
        parsed = urlsplit(self.path)
        return parsed.path, {key: values[0] for key, values in parse_qs(parsed.query).items()}

    def do_GET(self) -> None:
        path, query = self._route()
        if path == "/api/health":
            # the build and the pid are what lets a client tell "my supervisor"
            # from the predecessor an upgrade left holding this port (see
            # agent/build.py): it retires that one by pid instead of reusing it
            self._json({"status": "ok", "version": build_version(), "pid": os.getpid()})
        elif path == "/api/components":
            # the version gate, host-side: what this machine already runs
            self._json({"components": components.inventory()})
        elif path == "/api/locks":
            # Every lock this user's temp dir holds, classified by the kernel's
            # answer plus the holder's own record. Read-only: a scan never takes
            # a lock it would keep and never signals anything.
            self._json({"locks": [state.as_dict() for state in lock_reconcile.scan()]})
        elif path == "/api/components/settings":
            self._component_settings(query.get("name", ""))
        elif path == "/api/components/versions":
            name = query.get("name", "")
            if not name:
                self._json({"error": "name is required"}, 400)
                return
            try:
                self._json({"name": name, "versions": components.versions(name)})
            except ValueError as err:
                self._json({"error": str(err)}, 400)
        else:
            self._json({"error": "not found"}, 404)

    def _install_component(self) -> None:
        """Take one component artifact onto THIS machine.

        The install layer's HTTP face (agent/tools/components.py owns the logic):
        the manifest rides in a header as base64 of its JSON, the artifact is the
        request body or an `artifact_url` this host fetches for itself, and the
        answer is a verdict — the client never gets to assume its upload landed.
        A component belongs to the machine its server runs on, so the supervisor
        is where a client installs it: this process IS that machine's resident
        server, and it knows its own install root.
        """
        try:
            manifest = components.manifest_from_header(
                self.headers.get(components.MANIFEST_HEADER)
            )
        except ValueError as err:
            self._json({"error": str(err)}, 400)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            artifact = components.receive(self.rfile, length, manifest)
        except (ValueError, OSError) as err:
            # a body-less request that names no URL, a URL that is not http(s),
            # a fetch that failed or overran: all the same shape of answer
            self._json({"error": str(err)}, 400)
            return
        # The scratch file leaves before the verdict does, never after it: a
        # client acts on the answer the moment it reads it, and one of those
        # acts is asking whether this host still holds the spooled bytes.
        # Unlinking BELOW the response (a `finally` around the write) answers
        # that question with whatever the scheduler did — this machine's own
        # suite caught it about one run in four — which is no answer at all.
        # The `finally` stays where it is; only the write moves out of it.
        try:
            answer = (components.accept(artifact, manifest), 200)
        except (ValueError, OSError) as err:
            answer = ({"error": str(err)}, 400)
        finally:
            artifact.unlink(missing_ok=True)
        self._json(*answer)

    def _remove_component(self, name: str, version: str = "") -> None:
        """Take one component (or one of its versions) back OFF this machine.

        The install endpoint's reverse, composed the same way: `components` owns
        the bytes and the verdict, `rendezvous` owns the one thing the bytes do
        not tell (`stop_for_removal` — is any of it running, and is that daemon
        ours to stop). It is asked first, and a refusal is answered before
        anything is deleted, so a refused removal has no side effects.
        """
        try:
            self._json(components.remove(name, version, stop=rendezvous.stop_for_removal))
        except (ValueError, OSError) as err:
            self._json({"error": str(err)}, 400)

    def _set_component_state(self, name: str, disabled: bool) -> None:
        """Stop driving one component on THIS machine, or start again.

        The one write on this layer that touches no bytes: `components` owns the
        table entry (and the rule that a component this host does not hold is
        `absent` — an answer, not an error), so this is only the wire face of it.
        A name that could never be an install is refused before anything is read
        or written, exactly as the removal verb refuses one.
        """
        try:
            self._json(components.set_disabled(name, disabled))
        except ValueError as err:
            self._json({"error": str(err)}, 400)

    def do_DELETE(self) -> None:
        path, query = self._route()
        prefix = "/api/components/"
        if not path.startswith(prefix) or not path[len(prefix) :]:
            self._json({"error": "not found"}, 404)
            return
        self._remove_component(path[len(prefix) :], query.get("version", ""))

    def do_POST(self) -> None:
        sup = self.supervisor
        path, _query = self._route()
        if path == "/api/session/start":
            body = self._read_body()
            claim_pid = body.get("claim_pid")
            claim_host = body.get("claim_host")
            claim_start = body.get("claim_start")
            sess = sup.start_session(
                base_url=body.get("base_url") or None,
                model=body.get("model") or None,
                # the client LLM knobs ride with the claim, exactly like the model
                reasoning_effort=body.get("reasoning_effort") or None,
                api_protocol=body.get("api_protocol") or None,
                # the OS process of the window claiming this session, and the
                # machine it runs on: the one fact that lets the RIGHT host tell
                # "window gone" from "window silent" later, without a timer
                # (core/lock_reconcile.py). A claim this host cannot see is
                # recorded, never checked here.
                claim_pid=claim_pid if isinstance(claim_pid, int) and claim_pid > 0 else None,
                claim_start=claim_start if isinstance(claim_start, str) and claim_start else None,
                claim_host=claim_host if isinstance(claim_host, str) and claim_host else None,
            )
            if sess is None:
                self._json({"error": "session start failed"}, 500)
            else:
                self._json({"session_id": sess.session_id, "port": sess.port})
        elif path == "/api/session/stop":
            body = self._read_body()
            verdict = sup.stop_session(
                body.get("session_id"),
                # the app is quitting, not moving: nothing may outlive it
                leaving=bool(body.get("leaving")),
            )
            if verdict == "unknown":
                self._json({"status": "unknown"}, 404)
            else:
                # "detached" is not an error: the release was honoured, and a
                # client that is still alive may come back for its session —
                # exactly what a hop loss or a re-claim wants
                self._json({"status": "ok" if verdict == "stopped" else "detached"})
        elif path == "/api/session/heartbeat":
            body = self._read_body()
            ok = sup.heartbeat(body.get("session_id"))
            # a purely liveness beat: the run's model path lives in the client
            # (P4), so a {base_url, model} in the body is read as nothing
            self._json({"status": "ok" if ok else "unknown"}, 200 if ok else 404)
        elif path == "/api/locks/reclaim":
            # The user's own hand on a project the host can PROVE is orphaned.
            # A live window is refused here, and the verdict says so, so the UI
            # can report what happened instead of assuming it worked.
            #
            # `witness` is the claiming machine's own answer about its window
            # ({"host", "pid", "start"}), and it only ever unlocks a claim that
            # records THAT machine: lock_reconcile.witnessed() compares it with
            # the record field by field, so a witness about some other process is
            # ignored whole rather than applied to this lock. The check lives
            # there, in the one reconciler, not in this handler.
            body = self._read_body() or {}
            project = body.get("project")
            if not project:
                self._json({"error": "project is required"}, 400)
                return
            verdict = lock_reconcile.reclaim(project, witness=body.get("witness"), log=log)
            self._json(verdict)
        elif path == "/api/components/settings":
            self._save_component_settings()
        elif path == "/api/components/install":
            self._install_component()
        elif path.startswith("/api/components/") and path.endswith("/disable"):
            self._toggle_component(path, "/disable", True)
        elif path.startswith("/api/components/") and path.endswith("/enable"):
            self._toggle_component(path, "/enable", False)
        elif path == "/api/shutdown":
            # Normal close: exit once no sessions remain. ARM-ONLY, on purpose:
            # this supervisor is machine-wide and may be serving windows other
            # than the one that is leaving (a second app instance, a remote
            # client behind a tunnel), so a shutdown POST must never kill a
            # session it was not asked to stop. Stopping THIS client's sessions
            # is the explicit per-session {leaving:true} release, and a client
            # that died without one is caught by each session's own claim
            # watchdog (agent/core/claim_watch.py). The arm itself is
            # arm-only-when-empty (a sticky flag could kill a re-claim).
            sup.request_idle_exit()
            self._json({"status": "ok"})
        else:
            self._json({"error": "not found"}, 404)

    def _component_settings(self, name: str) -> None:
        """The knobs one component lets a person set, and where each one stands.

        The DECLARATION is the form: the host serves it as data (`schema`) beside
        the current values and draws nothing itself — the way an editor draws an
        extension's contributed configuration, knowing no setting of its own. The
        values come from the same store the component's own statement reads
        (tools/settings.py), so the form and the component can never disagree
        about what a knob is set to.
        """
        if not name:
            self._json({"error": "name is required"}, 400)
            return
        component = catalog.table().get(name)
        if component is None:
            self._json({"error": f"no component named {name!r} on this host"}, 404)
            return
        schema = {key: dict(spec) for key, spec in component.settings.items() if isinstance(spec, Mapping)}
        try:
            current = settings.values(name, component)
        except settings.BadFile as err:
            # the stored document is there and unreadable: it is NOT "every knob at
            # its default" (that answer is what let the next save overwrite it), so
            # the form is told what to fix instead of being drawn over the loss
            self._json({"error": str(err)}, 500)
            return
        self._json({"name": name, "schema": schema, "values": current})

    def _save_component_settings(self) -> None:
        """Set the knobs a person touched; answer the whole document back.

        PARTIAL on purpose (tools/settings.py: write): a form sends what changed,
        so two windows open on one machine cannot overwrite each other's work with
        a stale copy of the rest. A key or a value the declaration does not carry
        is refused as error-as-data like every other verb here, and nothing is
        written when it is.
        """
        body = self._read_body()
        name = body.get("name") if isinstance(body, dict) else None
        updates = body.get("values") if isinstance(body, dict) else None
        if not isinstance(name, str) or not name:
            self._json({"error": "name is required"}, 400)
            return
        if not isinstance(updates, dict):
            self._json({"error": "values must be an object"}, 400)
            return
        component = catalog.table().get(name)
        if component is None:
            self._json({"error": f"no component named {name!r} on this host"}, 404)
            return
        try:
            saved = settings.write(name, component, updates)
        except settings.BadSetting as err:
            self._json({"error": str(err)}, 400)
            return
        except settings.BadFile as err:
            # nothing was written: the document it could not read is still there
            self._json({"error": str(err)}, 500)
            return
        self._json({"status": "saved", "values": saved})

    def _toggle_component(self, path: str, suffix: str, disabled: bool) -> None:
        """`/api/components/<name>/disable|enable`: the switch, not the bytes.

        `disabled` is the bit the table STORES (True: here, and not to be
        driven), so each route passes what its own word MEANS — `/disable` True,
        `/enable` False — instead of a state this layer would have to translate
        back, which is exactly how a switch ends up upside down.

        The name is a path segment (the removal verb's own shape), so it is read
        out of the same prefix; a request that names nothing (`/disable` alone) is
        not found rather than a component called "".
        """
        name = path[len("/api/components/") : -len(suffix)]
        if not name:
            self._json({"error": "not found"}, 404)
            return
        self._set_component_state(name, disabled)


def _agent_cmd_default() -> list[str]:
    """Dev: run agent.server with this interpreter. PyInstaller onefile: launch
    the agent-server binary next to the supervisor."""
    if getattr(sys, "frozen", False):
        # Windows bundles carry the .exe suffix
        exe = "agent-server.exe" if os.name == "nt" else "agent-server"
        return [os.path.join(os.path.dirname(sys.executable), exe)]
    return [sys.executable, "-m", "agent.server"]


def build_server(port: int, sup: Supervisor) -> ThreadingHTTPServer:
    handler = type("ClutchSupervisorHandler", (_Handler,), {"supervisor": sup})
    try:
        return ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError as e:
        # an occupied port kills silently; say exactly what happened
        raise SystemExit(
            f"[clutch-supervisor] ERROR: cannot bind 127.0.0.1:{port} — port in use "
            f"({e}). Close the other Clutch/agent server on this port and retry."
        ) from e


def main() -> int:
    # wrap before the first print: a dead stdout must not crash startup
    sys.stdout = SafeStdStream(sys.stdout)
    sys.stderr = SafeStdStream(sys.stderr)

    ap = argparse.ArgumentParser(prog="agent.supervisor")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--idle-timeout", type=float, default=IDLE_TIMEOUT_S,
                    help="exit after this many seconds with zero sessions")
    ap.add_argument("--agent-cmd", default=None,
                    help="executable used to spawn session children (default: "
                         "this interpreter + -m agent.server)")
    ap.add_argument("--cwd", default=None, help="working dir for session children")
    args = ap.parse_args()

    agent_cmd = ([args.agent_cmd] if args.agent_cmd else _agent_cmd_default())
    if args.cwd:
        cwd = args.cwd
    elif getattr(sys, "frozen", False):
        cwd = os.path.expanduser("~")  # no repo root inside the bundle
    else:
        cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sup = Supervisor(agent_cmd=agent_cmd, cwd=cwd, idle_timeout_s=args.idle_timeout)
    # a dead/full stdout must never hang logging or the session-start handler
    make_stdout_nonblocking()
    srv = build_server(args.port, sup)
    bound_port = srv.server_address[1]
    log(f"[clutch-supervisor] http://127.0.0.1:{bound_port}  (session lifecycle API)")

    def _on_term(_signum, _frame):
        # The log line is a courtesy; ENDING the sessions is the point. So a
        # dead stdout must never stand between the two: the old order logged
        # first, a reentrant write raised RuntimeError, and shutdown_all() never
        # ran — every session (and the project lock it held) survived its host.
        try:
            log("[supervisor] SIGTERM, shutting sessions down")
        except Exception:  # noqa: BLE001 - nothing may keep the sessions alive
            pass
        try:
            sup.shutdown_all()
        finally:
            sup.exit_event.set()
        sys.exit(0)

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _on_term)

    threading.Thread(target=sup.reap_loop, daemon=True).start()
    # The ONE reconciler for .clc write locks (agent/core/lock_reconcile.py).
    # This process outlives the windows it serves, which is what it takes to
    # notice a window that is GONE while its session still holds the project.
    # Each pass asks the kernel (is the lock held? does the claiming process
    # still exist?) and, for an orphan, the session itself (is a run in
    # flight?) — never a clock, because to a clock a frozen phone and a closed
    # window look the same, and one of them must keep its lock.
    threading.Thread(
        target=lock_reconcile.loop,
        kwargs={"run_state": session_run_state, "log": log, "stop": sup.exit_event},
        name="clutch-lock-reconcile",
        daemon=True,
    ).start()

    def _exit_watch() -> None:
        # stop the HTTP server too, or serve_forever keeps the process alive
        while not sup.exit_event.is_set():
            time.sleep(0.2)
        srv.shutdown()

    threading.Thread(target=_exit_watch, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        sup.shutdown_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
