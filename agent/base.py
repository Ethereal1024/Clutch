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

import queue
import threading
import time
from abc import ABC, abstractmethod
from typing import Any

from .config import Config
from .core.permission import PermissionGate
from .core.project_lock import LockHandle, ProjectLock, ProjectOpenConflict
from .project import Project, open_project_lazy
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
        api/workspace), the write-claim retry (below) and the release handler
        (server.py install_release_handler). It is therefore answered WITHOUT
        the lock: the release handler reads it from a signal path that holds no
        lock, and it must not be able to wait behind a run that is exactly what
        it is asking about.

        Expiry is lazy and needs no timer: every claim carries a monotonic
        deadline (claim_run), and the first reader past it sees False. There is
        no deadline-less hold: the backend loop that used to set the flag
        without one was removed in P4, and a lease whose holder cannot renew is
        exactly what this shape is for.
        """
        return self._busy and time.monotonic() < self.run_lease_until

    def claim_run(self, project: str, ttl_s: float = LEASE_DEFAULT_S) -> str:
        """Claim or renew the run slot for `project`; answer "" or a refusal code.

        This is the HOST's half of the flag (POST /api/run/state, api/run_state):
        the loop that drives a turn lives in the client, so the client is the
        only one who can say the turn is still alive.

        Refusals, each naming a different problem:
          "no_project"       nothing is open to run in
          "project_mismatch" this session has another .clc open
          "run_active"       the slot is another window's host: two drivers on
                             one turn would write it twice
        """
        with self.lock:
            active = self.project
            if active is None:
                return "no_project"
            if str(active.path) != project:
                return "project_mismatch"
            if self.busy and self.run_project != project:
                return "run_active"
            self._busy = True
            self.run_project = project
            self.run_lease_until = time.monotonic() + ttl_s
        return ""

    def release_run(self, project: str) -> bool:
        """Give the slot back if `project`'s host holds it; say whether it did.

        The project and its write lock stay (a follow-up turn continues the same
        .clc); only the "in flight" claim goes. A release from a non-holder is not an error — Stop can be pressed
        twice, or after the lease already expired by itself — it answers False.
        """
        with self.lock:
            if not self.busy or self.run_project != project:
                return False
            self._busy = False
            self.run_lease_until = 0.0
            self.run_project = None
            return True

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
        switch invalidates the open project's workspace (paths differ per mode)."""
        with self.lock:
            self.backend_mode = mode
            self.bridge_url = bridge_url
            self.remote_root = remote_root
            # a mode switch invalidates any previously-opened project's workspace
            prev = self.project
            self.project = None
            self.workspace = None
            self._retire_lock(prev)

    def set_project(self, project: Project, workspace: Workspace | None = None) -> Workspace:
        """Make `project` the active one, retiring the project it REPLACES.

        The retire is here, at the single choke point where a project stops being
        the active one, so no caller can forget it: a window holds the write lock
        on at most its currently-open project, and a lock outliving its project
        would be unreachable — no project keeps the handle, so nothing could ever
        hand it back and every other window would be locked out of that .clc
        until this server exits."""
        with self.lock:
            prev = self.project
            self.project = project
            if workspace is None:
                workspace = self.build_workspace(str(project.workdir))
            self.workspace = workspace
            # an answer is only the answer to a call IN THIS workspace: the same
            # id arriving after a project switch is not the same call, and its
            # memo would describe files this project never had
            self.exec_answered.clear()
            self._retire_lock(prev, keep=project.lock)
            return self.workspace

    def reclaim_write_claim(self) -> bool:
        """Open the ACTIVE project FOR WRITE again, once its lock is free.

        The other half of the same invariant, and now the only way a read-only
        window gets its claim back: the release path that watched for silence is
        gone (a session no longer hands its lock back for being quiet — the
        host's reconciler ends an orphaned session instead, see
        agent/core/lock_reconcile.py), so nothing but this may re-take one.
        Read-only is only ever the FALLBACK for a conflict (ui/js/project.js
        says so when it offers it), never a mode the user chose: the moment the
        window that held the .clc is gone — it quit, its client died, its
        tunnel was torn down, its session was reaped — the window still looking
        at the file must be able to become its writer again, without re-opening
        the project (that would repaint its whole transcript) and without first
        sending a task.

        Until this existed, read_only was a one-way latch: a window that fell
        back once kept the badge (and the session kept refusing to append) long
        after the kernel said the file was free. That is the reported "ghost
        read-only", and it is why freeing the lock was not enough.

        Never while busy (the run's claim has to stand) and never over another
        holder (the kernel still refuses). Returns True when the claim is now
        this window's.
        """
        with self.lock:
            if self.busy:
                return False
            project, ws = self.project, self.workspace
        if project is None or not project.read_only or project.lock is not None:
            return False
        try:
            fresh = open_project_lazy(project.path, workspace=ws)
        except (ProjectOpenConflict, OSError, ValueError):
            return False
        with self.lock:
            if self.project is not project:
                # a window (or a run) replaced the project while this one was
                # being opened: the claim it just took belongs to nobody.
                ProjectLock.release(fresh.lock)
                fresh.lock = None
                return False
            self.project = fresh
            self.workspace = ws
        return True

    def _retire_lock(self, prev: Project | None, keep: LockHandle | None = None) -> None:
        """Hand back the write lock of a project that stops being the active one.

        `keep` is the handle the INCOMING project already owns: re-opening the
        SAME .clc for write reuses the held lock (see ProjectLock.acquire), and
        releasing it would unlock the file this window just (re)claimed. A
        read-only open passes no keep — it gives up the write claim on purpose —
        and so does a project replaced by another path."""
        if prev is None or prev.lock is None or prev.lock is keep:
            return
        ProjectLock.release(prev.lock)
        prev.lock = None

class BaseServer(ABC):
    """Shared assembly contract. Subclasses implement build_workspace only."""

    def __init__(self, config: Config, broadcaster: Broadcaster, state: RunState) -> None:
        self.config = config
        self.broadcaster = broadcaster
        self.state = state

    def build_tools(self, project: Project | None = None, config: Config | None = None) -> ToolRegistry:
        """Tools for a run; config overrides self.config for a per-run mode
        (chat read-only toolset vs work's full set).

        The run's workspace goes with them: which components may be offered
        depends on which machine the root is on (`registry._serves_this_workspace`),
        and a local session must not be handed a plugin that reads a DIFFERENT
        machine's files under the local `read_file` name. `state.workspace` is
        the open project's workspace (set_project); before a project is open it
        is None, which offers everything.

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
