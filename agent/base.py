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
from .llm import LlmClient, create_llm_client
from .loop import Agent
from .project import Project
from .tools.registry import ToolRegistry, build_default_tools
from .tools.workspace import LocalWorkspace, RemoteWorkspace, Workspace


class Broadcaster:
    """Fan events out to subscribers. Each subscriber owns a queue.Queue."""

    def __init__(self) -> None:
        self._subs: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, event: Any) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            q.put(event)

    def count(self) -> int:
        """Number of live SSE subscribers (is anyone watching the UI?)."""
        with self._lock:
            return len(self._subs)


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
        # SSH degradation layer: when set, tools/.clc/fs run through the exec bridge
        self.backend_mode: str = "local"  # "local" | "ssh"
        self.bridge_url: str | None = None
        self.remote_root: str | None = None  # initial browse root on the remote

    def build_workspace(self, root: str) -> Workspace:
        """Workspace factory: RemoteWorkspace in ssh mode, LocalWorkspace otherwise."""
        if self.backend_mode == "ssh" and self.bridge_url:
            return RemoteWorkspace(root, self.bridge_url)
        return LocalWorkspace(root)

    def set_backend(self, mode: str, bridge_url: str | None = None, remote_root: str | None = None) -> None:
        """Switch the SSH-degradation backend (mode: "local" | "ssh"). A mode
        switch invalidates any previously-opened project's workspace: paths and
        transport differ per mode, so the UI must re-open the project after."""
        with self.lock:
            self.backend_mode = mode
            self.bridge_url = bridge_url
            self.remote_root = remote_root
            # a mode switch invalidates any previously-opened project's workspace
            self.project = None
            self.workspace = None
            self.gate = None

    def set_project(self, project: Project, workspace: Workspace | None = None) -> Workspace:
        with self.lock:
            self.project = project
            if workspace is None:
                workspace = self.build_workspace(str(project.workdir))
            self.workspace = workspace
            return self.workspace

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


class BaseServer(ABC):
    """Shared run-assembly contract. Subclasses implement build_workspace only."""

    def __init__(self, config: Config, broadcaster: Broadcaster, state: RunState) -> None:
        self.config = config
        self.broadcaster = broadcaster
        self.state = state

    def _build_llm(self, api_key: str, model: str, cfg: Config) -> LlmClient:
        """Assemble one LLM client — the only construction site in the repo.
        build_llm and the per-run compactor closure both go through here, so a
        new client knob (timeout, retries, …) is added in exactly one place."""
        return create_llm_client(
            provider="openai",
            api_key=api_key,
            model=model,
            base_url=cfg.base_url,
            request_timeout=cfg.llm_request_timeout,
            max_retries=cfg.llm_max_retries,
            retryable_status=cfg.llm_retryable_status,
        )

    def build_llm(self) -> LlmClient:
        """LLM client for this server. Raises RuntimeError when no API key."""
        return self._build_llm(self.state.api_key or self.config.api_key, self.config.model, self.config)

    def build_tools(self, project: Project | None = None, config: Config | None = None) -> ToolRegistry:
        """Tools for a run. ``config`` overrides self.config so a per-run mode
        (chat read-only toolset) takes effect; work mode keeps the full set."""
        cfg = config or self.config
        return ToolRegistry(build_default_tools(cfg, memories=project.memories if project else None))

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
        """Assemble and claim a run on the project: workspace + LLM + tools + gate
        + Agent. Returns the Agent (caller runs it) or None when a run is already
        active. ``config`` overrides this server's config per run (e.g. a
        per-request verify command); build_llm/build_tools still use self.config.
        """
        cfg = config or self.config
        # reuse the workspace the UI already built for this project (set_project),
        # so the file tree and the agent's run share ONE workspace instance;
        # fall back to building a fresh one when none is open or its root is a
        # different directory (eval harness calls start_task without set_project)
        workspace = self.state.workspace
        if workspace is None or workspace.root != project.workdir:
            workspace = self.build_workspace(project)
        workspace.protect(project.path)
        llm = self.build_llm()  # before claiming the slot: a bad key must not stick busy
        # separate summarizer for compaction is built lazily (only on the first
        # compaction) via a factory that captures the resolved key — no per-run
        # client construction, and a missing key only surfaces inside the
        # best-effort compaction fallback.
        compactor_factory = None
        if cfg.compaction_model and cfg.compaction_model != cfg.model:
            api_key = self.state.api_key or cfg.api_key

            def _make_compactor() -> LlmClient:
                return self._build_llm(api_key, cfg.compaction_model, cfg)

            compactor_factory = _make_compactor
        cancel = cancel or threading.Event()
        if not self.state.start(task, workspace, cancel):
            return None
        gate = PermissionGate(
            evaluator=PermissionEvaluator(),
            on_ask=on_ask,
            auto_allow=cfg.non_interactive,
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
            compactor_factory=compactor_factory,
            memories=project.memories,
        )
