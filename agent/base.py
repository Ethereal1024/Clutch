"""Server base class: the contract every backend host shares.

The HTTP server (HttpAgentServer) and the eval harness both go through
BaseServer.build_llm/build_tools/build_workspace/start_task, so a run assembled
here behaves identically whether it serves SSE over HTTP or runs headless in an
eval. The degraded SSH backend needs no code here at all: build_workspace is
implemented per server, and the workspace/transport layer routes to the remote.

Broadcaster and RunState live here too (not in server.py) so the base has no
dependency on the HTTP layer.
"""

from __future__ import annotations

import queue
import threading
from abc import ABC, abstractmethod
from typing import Any

from .config import Config
from .core.permission import PermissionEvaluator, PermissionGate
from .core.project_lock import LockHandle, ProjectLock, ProjectOpenConflict
from .llm import LlmClient, create_llm_client
from .loop import Agent
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
    """Holds the live agent, cancel flag, and the active project.

    A project is a single .clc file; its working directory is the directory that
    contains it. Runs within the same project share the project's event log so
    the conversation continues across runs. Also owns the SSH degradation mode:
    backend_mode/bridge_url/remote_root select RemoteWorkspace vs LocalWorkspace.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.busy = False
        self.cancel: threading.Event | None = None
        self.project: Project | None = None
        self.workspace: Workspace | None = None
        self.api_key: str | None = None
        # The LLM client of the run in flight (None between runs). It is held here
        # — not only inside the Agent — because the endpoint it talks to belongs
        # to the CLIENT that claimed this session, and that client can move it
        # while the run is going (POST /api/llm/base, see api/settings).
        self.llm: LlmClient | None = None
        self.gate: PermissionGate | None = None
        # Gates whose prompts are still answerable. `gate` above is the RUN's own
        # gate (a run is one slot); the exec endpoint (api/exec.py) serves one
        # call per request — several may be in flight for one turn, and a prompt
        # whose gate were only the last one assigned could be neither answered
        # (api/events._permission_respond) nor resolved by Stop (api/run._stop).
        self.gates: list[PermissionGate] = []
        # tool_call_id -> the call's interrupt event, so POST /api/exec/cancel
        # reaches the command tree that is still running on this machine
        self.exec_cancels: dict[str, threading.Event] = {}
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

    def build_workspace(self, root: str) -> Workspace:
        """Workspace factory: RemoteWorkspace in ssh mode, LocalWorkspace otherwise."""
        if self.backend_mode == "ssh" and self.bridge_url:
            return RemoteWorkspace(root, self.bridge_url)
        return LocalWorkspace(root)

    def live_gates(self) -> list[PermissionGate]:
        """Every gate a permission prompt could still be waiting on.

        The run's own gate first (one run slot), then the exec endpoint's live
        ones (one per call). Answering a prompt and Stop both read this: an ask
        nobody can reach is a run that never ends, and a tool call that waits for
        an answer that cannot be typed is the same failure one layer down.
        """
        with self.lock:
            return [g for g in [self.gate, *self.gates] if g is not None]

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
            self.gate = None
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

    def start(
        self, task: str, workspace: Workspace, cancel: threading.Event, llm: LlmClient | None = None
    ) -> bool:
        with self.lock:
            if self.busy:
                return False
            self.busy = True
            self.cancel = cancel
            self.workspace = workspace
            # claimed under the same lock as `busy`: a re-point reads this to
            # decide whether there is a live client to move, and a window where
            # busy is True and llm is not yet set would be one it cannot reach
            self.llm = llm
        return True

    def finish(self) -> None:
        # keep the project + workspace so a follow-up run can continue
        with self.lock:
            self.busy = False
            self.run_project = None
            # the run is over: the next one builds its own client from the config
            # a re-point already updated, so holding this one would only make
            # "is there a live client?" answer yes when nothing is running
            self.llm = None


class BaseServer(ABC):
    """Shared run-assembly contract. Subclasses implement build_workspace only."""

    def __init__(self, config: Config, broadcaster: Broadcaster, state: RunState) -> None:
        self.config = config
        self.broadcaster = broadcaster
        self.state = state

    def _build_llm(self, api_key: str, model: str, cfg: Config) -> LlmClient:
        """Assemble one LLM client — the only construction site in the repo."""
        return create_llm_client(
            api_key=api_key,
            model=model,
            base_url=cfg.base_url,
            protocol=cfg.llm_api_protocol,
            request_timeout=cfg.llm_request_timeout,
            read_timeout=cfg.llm_read_timeout,
            max_retries=cfg.llm_max_retries,
            retryable_status=cfg.llm_retryable_status,
            reasoning_effort=cfg.llm_reasoning_effort,
        )

    def build_llm(self) -> LlmClient:
        """LLM client for this server. Raises RuntimeError when no API key."""
        return self._build_llm(self.state.api_key or self.config.api_key, self.config.model, self.config)

    def build_tools(self, project: Project | None = None, config: Config | None = None) -> ToolRegistry:
        """Tools for a run; config overrides self.config for a per-run mode
        (chat read-only toolset vs work's full set).

        The run's workspace goes with them: which components may be offered
        depends on which machine the root is on (`registry._serves_this_workspace`),
        and a local session must not be handed a plugin that reads a DIFFERENT
        machine's files under the local `read_file` name. `state.workspace` is
        the run's workspace by the time this is asked (start_task claims the slot
        first); before any run it is None, which offers everything.

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

    def start_task(
        self,
        task: str,
        project: Project,
        on_ask=None,
        cancel: threading.Event | None = None,
        config: Config | None = None,
    ) -> Agent | None:
        """Assemble and claim a run on the project: workspace + LLM + tools +
        gate + Agent. Returns the Agent (caller runs it) or None when a run is
        already active.
        """
        cfg = config or self.config
        # reuse the UI-built workspace when it matches the project root, else build fresh
        workspace = self.state.workspace
        if workspace is None or workspace.root != project.workdir:
            workspace = self.build_workspace(project)
        workspace.protect(project.path)
        llm = self.build_llm()  # before claiming the slot: a bad key must not stick busy
        cancel = cancel or threading.Event()
        if not self.state.start(task, workspace, cancel, llm=llm):
            return None
        gate = PermissionGate(
            evaluator=PermissionEvaluator(),
            on_ask=on_ask,
            auto_allow=cfg.non_interactive,
            # a prompt is only answerable by a UI watching THIS project: when
            # that stream is gone for good (a wrongly-closed connection), the
            # gate denies instead of holding the run — and with it the project's
            # write lock — forever
            is_attached=lambda: self.broadcaster.count(str(project.path)) > 0,
            # trust mode: the countdown belongs on this side (a backgrounded
            # phone freezes the renderer and its timers with it), and the flag is
            # read live so arming/disarming mid-prompt behaves like the button
            trust=lambda: self.state.trust_armed,
        )
        return Agent(
            llm=llm,
            registry=self.build_tools(project, cfg),
            workspace=workspace,
            config=cfg,
            log=project.log,
            sink=self.broadcaster.publish,
            cancel=cancel,
            gate=gate,
        )
