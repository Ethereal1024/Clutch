"""Server base class: the contract every backend host shares.

This machine is the EXECUTION layer (TODO.md D1): it opens projects, holds the
write lock, appends durable lines to a `.clc`, runs one tool call per request
(api/exec.py) and answers the run-slot lease its client claims (api/run_state.py).
The loop that drives a turn lives in the client; there is no model client on
this side any more (P4 removed the one that used to be here).

BaseServer is only `build_tools` + `build_workspace` now; the degraded SSH
backend needs no code here at all, since build_workspace is implemented per
server and the workspace/transport layer routes to the remote.

Broadcaster and RunState live here too (not in server.py) so the base has no
dependency on the HTTP layer.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from abc import ABC, abstractmethod
from typing import Any

from .config import Config
from .core.permission import PermissionGate
from .core.project_lock import LockHandle, ProjectLock, owner_summary
from .project import Project
from .tools.registry import ToolRegistry, build_tools
from .tools.workspace import LocalWorkspace, RemoteWorkspace, Workspace

# A window that stopped draining is not owed an unbounded buffer: every DURABLE
# event is already in the project log, and the subscriber carries the byte offset
# it has painted (ui/js/sse-stream.js), so what a slow window needs is not a
# backlog but its own re-read. Past this depth the queue is emptied and a single
# LAGGED marker is left: the consumer ends the stream, and the window's reconnect
# asks for everything after its offset -- idempotent, because the watermark makes
# a replay of already-painted records a no-op. The bound is depth of *frames*,
# not bytes: a run's deltas are a few bytes each, so this is tens of KB of text.
SUBSCRIBER_QUEUE_MAX = 4096


class _Lagged:
    """Marks a subscriber that fell behind: its stream must end so it re-reads.

    A marker and not an event: it is never serialized, never part of the log, and
    the only thing it means is "the frames you lost are in the log you can
    re-read from your own offset".
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<broadcaster: subscriber lagged>"


LAGGED = _Lagged()


def _drain(q: queue.Queue) -> None:
    """Empty a subscriber's queue, whatever it holds (see SUBSCRIBER_QUEUE_MAX)."""
    try:
        while True:
            q.get_nowait()
    except queue.Empty:
        pass


class Broadcaster:
    """Fan events out to subscribers. Each subscriber owns a bounded queue.

    A subscriber also names the project it watches (None = every project): the
    live fan-out filters another window's run out of its stream, so a stream
    watching a different project is no audience for this one's permission
    prompt — count() can say so (see PermissionGate.is_attached).
    """

    def __init__(self) -> None:
        self._subs: dict[queue.Queue, str | None] = {}
        self._lock = threading.Lock()

    def subscribe(self, project: str | None = None) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=SUBSCRIBER_QUEUE_MAX)
        with self._lock:
            self._subs[q] = project
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subs.pop(q, None)

    def publish(self, event: Any, project: str | None = None) -> None:
        """Fan one event out to the subscribers, optionally to one project.

        ``project`` narrows the fan-out to the streams that watch that .clc (plus
        the unfiltered ones): a host-made announcement about the ACTIVE project
        must not reach a window watching a different one, or that window paints
        a state that was never about its file. Durable events keep the default
        (everyone), because their admissibility is the run_project filter in
        agent/api/events.py _sse.
        """
        with self._lock:
            subs = [
                q for q, watched in self._subs.items()
                if project is None or watched is None or watched == project
            ]
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                # One marker, one remedy: the stream ends and the window re-reads
                # the log after its own offset (agent/api/events.py consumes this).
                _drain(q)
                try:
                    q.put_nowait(LAGGED)
                except queue.Full:  # another publisher refilled it: it is marked
                    pass

    def count(self, project: str | None = None) -> int:
        """Number of live SSE subscribers (is anyone watching the UI?).

        With a project: only the subscribers that would actually SEE that
        project's events — its own watchers plus the unfiltered ones — because
        a window on another project cannot answer this project's prompt."""
        with self._lock:
            if project is None:
                return len(self._subs)
            return sum(1 for watched in self._subs.values() if not watched or watched == project)


class RunState:
    """Holds the run slot, the permission gates, and the active project.

    A project is a single .clc file; its working directory is the directory that
    contains it. Runs within the same project share the project's event log so
    the conversation continues across runs. Also owns the SSH degradation mode:
    backend_mode/bridge_url/remote_root select RemoteWorkspace vs LocalWorkspace.
    """

    # The run slot is a LEASE, not a latch (P2-3). The host drives the turn now
    # and says so on POST /api/run/state; a host that dies (kill -9, a phone
    # reclaimed by the OS, a tunnel cut mid-turn) cannot say anything, and a
    # latch nobody can release would refuse every project switch and keep the
    # supervisor from ever reaping the session. So the claim carries a deadline,
    # the host renews it every heartbeat (ui/run-session.js), and the honest
    # answer comes back by itself. Long enough that a stalled step or a shaky
    # hop does not lose it (6 heartbeats of slack), short enough that a dead
    # host costs two minutes, not a session.
    LEASE_DEFAULT_S = 120.0
    HEARTBEAT_S = 20.0

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self._busy = False
        # the write claim: the kernel lock on the .clc this session is RUNNING.
        # None = idle = the file is open here but not claimed, so another window
        # may take it (and this one may take it back). One claim at a time,
        # because a session drives at most one turn.
        self._claim_lock: LockHandle | None = None
        self._claim_path: str | None = None
        # monotonic deadline of the current lease; 0.0 = no claim is held (a
        # claim ALWAYS carries one: api/run_state.claim_run sets it and the
        # release paths clear it, so there is no such thing as a deadline-less
        # hold any more — that was the retired /api/run path)
        self.run_lease_until: float = 0.0
        self.project: Project | None = None
        self.workspace: Workspace | None = None
        self.api_key: str | None = None
        # Gates whose prompts are still answerable. The exec endpoint
        # (api/exec.py) serves one call per request and several may be in flight
        # for one turn, so a prompt whose gate were only the last one assigned
        # could be neither answered (api/events._permission_respond) nor
        # resolved by a Stop that reached the client.
        self.gates: list[PermissionGate] = []
        # tool_call_id -> the call's interrupt event, so POST /api/exec/cancel
        # reaches the command tree that is still running on this machine — and,
        # through the same event, the permission prompt the call may be blocked
        # on instead (api/exec._CallCancel)
        self.exec_cancels: dict[str, threading.Event] = {}
        # tool_call_id -> (name, arguments, the answer that id already got). The
        # id is the call's identity on the wire, so TWO requests carrying the
        # same id and the same request are one call — and the side effect must
        # happen once. Without this memo the endpoint could only refuse a
        # duplicate while it was still in flight; once answered, the id was
        # forgotten (api/exec.py popped the cancel entry in `finally`) and the
        # repeat ran the tool a second time: an appending edit appended twice,
        # a background command started twice, byte for byte. The arguments ride
        # along because a client that reuses an id for a DIFFERENT call is a
        # client bug, not a replay: that one runs. Bounded by api/exec.DONE_KEEP
        # (oldest evicted), so the memo cannot grow with the session.
        self.exec_answered: dict[str, tuple[str, str, dict]] = {}
        # trust mode (agent/core/permission.py TRUST_COUNTDOWN_S): the window's
        # armed flag, mirrored here by POST /api/permission/trust so the
        # countdown can run on THIS side. The page's own clock is a frozen
        # WebView's problem; this one keeps ticking (see PermissionGate.trust).
        self.trust_armed: bool = False
        # project of the active run; SSE subscribers filter live events by it
        self.run_project: str | None = None
        # when set, tools/.clc/fs run through the exec bridge
        self.backend_mode: str = "local"  # "local" | "ssh"
        self.bridge_url: str | None = None
        self.remote_root: str | None = None  # initial browse root on the remote

    @property
    def busy(self) -> bool:
        """Is a run in flight right now?

        The ONE answer five other places read: `/api/health`'s in_flight
        (api/routing), the status frame a reconnecting window is handed
        (api/events), the project-switch and rollback gates (api/project,
        api/workspace), and the release handler (server.py
        install_release_handler). It is therefore answered WITHOUT the lock: the
        release handler reads it from a signal path that holds no lock, and it
        must not be able to wait behind a run that is exactly what it is asking
        about.

        Expiry is lazy and needs no timer: every claim carries a monotonic
        deadline (claim_run), and the first reader past it sees False. There is
        no deadline-less hold: the backend loop that used to set the flag
        without one was removed in P4, and a lease whose holder cannot renew is
        exactly what this shape is for. The kernel lock the claim stands on is
        dropped by the same expiry (server.py's claim watch loop calls
        drop_expired_claim), because a dead host cannot hand back anything.
        """
        return self._busy and time.monotonic() < self.run_lease_until

    def owns_claim(self, path: str | None = None) -> bool:
        """Does THIS session hold the .clc's write claim right now?

        The claim is the RUN's, not the open project's: this is the question
        every writer asks before it touches the file (api/log.py, api/exec.py),
        and the answer is the kernel's lock plus this session's own record of
        taking it. With ``path``: is the claim on THAT file (abspath-compared,
        so `/x/./a.clc` and `/x/a.clc` are one file)."""
        with self.lock:
            if self._claim_lock is None or self._claim_lock.released:
                return False
            return path is None or self._claim_path == os.path.abspath(path)

    def foreign_claim(self, path: str | None = None) -> bool:
        """Is ANOTHER session running a turn on this .clc? (See foreign_lock.)"""
        return self.foreign_lock(path)["held"]

    def foreign_lock(self, path: str | None = None) -> dict:
        """The foreign claim on this .clc: ``{held, owner}``.

        Asked of the KERNEL (a trial lock, so a crashed holder left nothing to
        trust) and answered against our own claim: a lock this session holds is
        not foreign, and neither is the zero-length window inside claim_run
        where the kernel lock is already taken — both facts move under
        self.lock, so no reader can see half of one.

        ``owner`` is the holder's own statement about itself
        (project_lock.owner_summary): which process holds it, which machine that
        process runs on, and the start tick that names it. It is reported
        because a claim nobody can use is not answerable from this side alone —
        a far host can never see the claiming window, so the machine named by
        ``claim_host`` is the only one that can prove it gone
        (agent/core/project_lock.py, lock_reconcile.witnessed). Handing the
        record to the pages is what lets that machine say so and free the file.
        Absence is doubt: a holder that left no record reports None, never a
        guess.

        This is what "read-only" means now. It is not a property of the OPEN (an
        idle project is open everywhere and claimed nowhere); it is a fact about
        the file at one moment, it changes without anybody telling this session,
        and whoever shows it to the user has to watch it (server.py
        claim_watch_loop)."""
        with self.lock:
            target = path if path is not None else (str(self.project.path) if self.project else None)
            if target is None:
                return {"held": False, "owner": None}
            mine = (
                self._claim_lock is not None
                and not self._claim_lock.released
                and self._claim_path == os.path.abspath(target)
            )
        if mine:
            return {"held": False, "owner": None}
        lock = ProjectLock.inspect(str(target))
        held = bool(lock["held"])
        return {"held": held, "owner": owner_summary(lock["owner"]) if held else None}

    def claim_run(self, project: str, ttl_s: float = LEASE_DEFAULT_S) -> str:
        """Claim or renew the run slot for `project`; answer "" or a refusal code.

        This is the HOST's half of the flag (POST /api/run/state, api/run_state):
        the loop that drives a turn lives in the client, so the client is the
        only one who can say the turn is still alive. And because the loop writes
        the file, the claim is also the .clc's WRITE CLAIM — the OS lock is taken
        here, so exactly one session can be appending at a time and the kernel,
        not a promise, decides which one.

        Refusals, each naming a different problem:
          "no_project"       nothing is open to run in
          "project_mismatch" this session has another .clc open
          "read_only"        this session opened it in "never write" mode
          "run_active"       another session holds the file: two drivers on one
                             turn would write it twice
        """
        key = os.path.abspath(project)
        with self.lock:
            active = self.project
            if active is None:
                return "no_project"
            if os.path.abspath(str(active.path)) != key:
                return "project_mismatch"
            if active.read_only:
                return "read_only"
            if self._claim_lock is not None and not self.busy:
                # the lease lapsed: the turn it stood for is over, and the lock
                # it left behind is ours to hand back (a dead host cannot)
                self._drop_claim_locked()
            if self._claim_path == key and self._claim_lock is not None:
                self._busy = True  # a renewal: the same claim, a fresh deadline
                self.run_lease_until = time.monotonic() + ttl_s
                self.run_project = project
                return ""
            lock = ProjectLock.acquire(key)
            if lock is None:
                return "run_active"
            self._claim_lock = lock
            self._claim_path = key
            self._busy = True
            self.run_project = project
            self.run_lease_until = time.monotonic() + ttl_s
            # The resident log is a snapshot of the file as this session opened
            # it, and the session that just handed the claim over may have
            # appended to it. Read those lines now, or this turn would reason
            # about a conversation with a hole in it AND append after lines it
            # never saw. Under the claim, so nobody can append behind the read.
            active.log.catch_up()
        return ""

    def release_run(self, project: str) -> bool:
        """Give the claim back if `project`'s host holds it; say whether it did.

        The project stays open (a follow-up turn continues the same .clc) and
        becomes unclaimed, which is what lets ANY window take it — this one
        included — without a reload: an idle project is claimed by nobody. A
        release from a non-holder is not an error — Stop can be pressed twice, or
        after the lease already expired by itself — it answers False.
        """
        key = os.path.abspath(project)
        with self.lock:
            if self._claim_path != key or self._claim_lock is None:
                return False
            self._drop_claim_locked()
            return True

    def drop_expired_claim(self) -> bool:
        """Hand the claim back when its lease lapsed and its host never did.

        The lease is the host's promise that it is still driving; the kernel lock
        is the FILE's guarantee that one session writes. A host that dies holding
        both leaves the lock with nothing behind it — and the kernel cannot see a
        lease — so this process is the only one that can free the file. Called by
        the claim watch loop (server.py), which also says the run is over to the
        windows this session is streaming to.

        Returns True when it dropped a claim (the caller has something to
        announce)."""
        with self.lock:
            if self._claim_lock is None or self.busy:
                return False
            return self._drop_claim_locked()

    def _drop_claim_locked(self) -> bool:
        """Give the write claim back. Caller holds self.lock.

        Releasing the kernel lock inside self.lock is a close(2) and an flock —
        no callback, no blocking on another lock — and it keeps "the file is
        free" and "this session says it is idle" from being observable apart."""
        lock = self._claim_lock
        self._claim_lock = None
        self._claim_path = None
        self._busy = False
        self.run_lease_until = 0.0
        self.run_project = None
        ProjectLock.release(lock)
        return lock is not None

    def build_workspace(self, root: str) -> Workspace:
        """Workspace factory: RemoteWorkspace in ssh mode, LocalWorkspace otherwise."""
        if self.backend_mode == "ssh" and self.bridge_url:
            return RemoteWorkspace(root, self.bridge_url)
        return LocalWorkspace(root)

    def live_gates(self) -> list[PermissionGate]:
        """Every gate a permission prompt could still be waiting on.

        The exec endpoint (api/exec.py) opens one per call, and several can be
        in flight within one turn. Answering a prompt reads this: an ask nobody
        can reach is a tool call that waits for an answer that cannot be typed.
        """
        with self.lock:
            return [g for g in self.gates if g is not None]

    def set_backend(self, mode: str, bridge_url: str | None = None, remote_root: str | None = None) -> None:
        """Switch the SSH-degradation backend (mode: "local" | "ssh"). A mode
        switch invalidates the open project's workspace (paths differ per mode),
        and with the project goes the claim that was taken on it."""
        with self.lock:
            self._drop_claim_locked()
            self.backend_mode = mode
            self.bridge_url = bridge_url
            self.remote_root = remote_root
            # a mode switch invalidates any previously-opened project's workspace
            self.project = None
            self.workspace = None

    def set_project(self, project: Project, workspace: Workspace | None = None) -> Workspace:
        """Make `project` the active one.

        A claim belongs to the .clc it was taken on, so replacing that project
        hands it back here — the one choke point where a project stops being the
        active one, so no caller can forget it. A claim outliving its project
        would be unreachable: nothing keeps the handle, so nothing could ever
        release it and every other window would be locked out of that .clc until
        this server exits. (A switch during a run cannot happen: every opener
        refuses while busy. This is the invariant, not the gate.)"""
        with self.lock:
            if self._claim_path is not None and self._claim_path != os.path.abspath(str(project.path)):
                self._drop_claim_locked()
            self.project = project
            if workspace is None:
                workspace = self.build_workspace(str(project.workdir))
            self.workspace = workspace
            # an answer is only the answer to a call IN THIS workspace: the same
            # id arriving after a project switch is not the same call, and its
            # memo would describe files this project never had
            self.exec_answered.clear()
            return self.workspace

class BaseServer(ABC):
    """Shared assembly contract. Subclasses implement build_workspace only."""

    def __init__(self, config: Config, broadcaster: Broadcaster, state: RunState) -> None:
        self.config = config
        self.broadcaster = broadcaster
        self.state = state

    def build_tools(self, project: Project | None = None, config: Config | None = None) -> ToolRegistry:
        """Tools for a run; config overrides self.config for a per-run mode
        (chat read-only toolset vs work's full set).

        The run's workspace goes with them: a remote root has no daemon of ours to
        answer for the workspace's own filesystem, so the host declares the four
        file tools itself there (`tools/host.py`) and a component publishing one of
        those names is dropped rather than wired twice (`registry.build_tools`'s
        `held`); a call still asks `prompt.module_blocked_reason` before it runs.
        `state.workspace` is the open project's workspace (set_project); before a
        project is open it is None, which offers everything.

        The project's log goes with them too, and it is the same object in both
        places: `build_tools` needs it to answer the `project` gate, and the
        registry needs it to hand the log readers the file they read. No path
        travels — the readers can only read the log this run is logged in."""
        cfg = config or self.config
        log = project.log if project else None
        return ToolRegistry(build_tools(cfg, log=log, workspace=self.state.workspace), log=log)

    @abstractmethod
    def build_workspace(self, project: Project) -> Workspace:
        """Workspace for a project's working directory (local or remote)."""
