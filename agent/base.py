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
from .core.project_lock import LockHandle, ProjectLock
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

    def publish(self, event: Any) -> None:
        with self._lock:
            subs = list(self._subs)
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
        self.gate: PermissionGate | None = None
        # project of the active run; SSE subscribers filter live events by it
        self.run_project: str | None = None
        # when set, tools/.clc/fs run through the exec bridge
        self.backend_mode: str = "local"  # "local" | "ssh"
        self.bridge_url: str | None = None
        self.remote_root: str | None = None  # initial browse root on the remote
        # serializes .clc appends/in-place writes from the /api/clc* endpoints:
        # the size-then-append offset handoff and the event log's
        # note_bytes_written bookkeeping both need writes to be race-free.
        # Host housekeeping — invisible to the endpoint contract.
        self.clc_lock = threading.Lock()

    def build_workspace(self, root: str) -> Workspace:
        """Workspace factory: RemoteWorkspace in ssh mode, LocalWorkspace otherwise."""
        if self.backend_mode == "ssh" and self.bridge_url:
            return RemoteWorkspace(root, self.bridge_url)
        return LocalWorkspace(root)

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

    def release_write_claim(self) -> bool:
        """Open the active project READ-ONLY, handing its write lock back.

        The lock arbitrates two windows EDITING one .clc, so a project no window
        is watching has no editor and must not keep other windows out of the file
        (agent/server.py's unattended watchdog is the caller). The project stays
        ACTIVE: whoever comes back keeps its transcript, its tree and its SSE
        scope, and simply finds that its claim is gone — a run re-opens the
        project for write anyway (/api/run carries the project), which is the
        honest place to discover that another window took it.

        A run in flight is a writer that is still there, so this refuses while
        busy: releasing the lock under a running writer is exactly the two
        writers the lock exists to prevent. Returns True when the lock was
        handed back.
        """
        with self.lock:
            if self.busy:
                return False
            project, ws = self.project, self.workspace
        if project is None or project.read_only or project.lock is None:
            return False
        try:
            # read-only first so the file is never unlocked without a project
            # behind it, then swap: set_project retires the old lock
            fresh = open_project_lazy(project.path, workspace=ws, read_only=True)
        except (OSError, ValueError):
            return False
        with self.lock:
            if self.project is not project:  # a window got here first: leave it
                return False
            self.project = fresh
            self.workspace = ws
            self._retire_lock(project)
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

    def start(self, task: str, workspace: Workspace, cancel: threading.Event) -> bool:
        with self.lock:
            if self.busy:
                return False
            self.busy = True
            self.cancel = cancel
            self.workspace = workspace
        return True

    def finish(self) -> None:
        # keep the project + workspace so a follow-up run can continue
        with self.lock:
            self.busy = False
            self.run_project = None


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
        (chat read-only toolset vs work's full set)."""
        cfg = config or self.config
        return ToolRegistry(build_tools(cfg, memories=project.memories if project else None))

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
        if not self.state.start(task, workspace, cancel):
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
            memories=project.memories,
        )
