"""API-only HTTP + SSE server hosting the agent (the UI is a separate app).

Endpoints (all JSON except SSE/NDJSON):
  POST /api/project/new    {dir, name} -> create a .clc project file
  POST /api/project/open   {path} -> load a .clc project (NDJSON stream)
  POST /api/run            {task} -> start run on the active project (409 if busy)
  POST /api/stop           cancel the running agent
  GET  /api/events         SSE: replay active project history, then live events
  GET  /api/workspace/tree   file tree under the project's working directory
  GET  /api/health         {ok}

CORS is wide open (Access-Control-Allow-Origin: *) so the decoupled UI can live
on another origin/host. The API key travels in request bodies, not cookies, so a
wildcard origin leaks nothing. Bind --host 0.0.0.0 to expose beyond localhost.

The agent's existing sink is fed into a thread-safe broadcaster; each SSE subscriber
gets a private queue. One run at a time; Stop sets a cancel flag checked by the loop.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import Config
from .core.permission import PermissionEvaluator, PermissionGate
from .events import (
    DURABLE_TYPES,
    Event,
    PermissionRequestEvent,
    StateUpdateEvent,
    event_to_json,
)
from .llm.client import LlmClient
from .loop import Agent
from .project import Project, create_project, open_project, read_header
from .tools.registry import ToolRegistry, build_default_tools
from .tools.workspace import Workspace


def _settings_path() -> Path:
    return Path.home() / ".clutch" / "settings.json"


def load_settings() -> dict:
    """Read persisted settings (api_key). The file lives outside the repo on purpose."""
    p = _settings_path()
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_settings(data: dict) -> None:
    p = _settings_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        p.chmod(0o600)  # owner-only, the file holds a credential
    except OSError as e:
        print(f"[clutch-server] cannot persist settings: {e}", file=sys.stderr)


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

    def publish(self, event: Event) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            q.put(event)


class RunState:
    """Holds the live agent, cancel flag, and the active project.

    A project is a single .clc file; its working directory is the directory that
    contains it. Runs within the same project share the project's event log so
    the conversation continues across runs.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.busy = False
        self.cancel: threading.Event | None = None
        self.project: Project | None = None
        self.workspace: Workspace | None = None
        self.api_key: str | None = None
        self.gate: PermissionGate | None = None

    def set_project(self, project: Project) -> Workspace:
        with self.lock:
            self.project = project
            self.workspace = Workspace(str(project.workdir))
            self.workspace.protect(project.path)
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


class Handler(BaseHTTPRequestHandler):
    server: ClutchServer  # type: ignore

    # config/broadcaster/state are set on the server instance;
    # this property exposes them uniformly to the handler.
    @property
    def _cfg(self) -> Config:
        return self.server.config

    @property
    def _state(self) -> RunState:
        return self.server.state

    @property
    def _broadcaster(self) -> Broadcaster:
        return self.server.broadcaster

    # ---- routing ----
    # Handlers raise on unexpected errors: ThreadingHTTPServer prints the full
    # traceback (handle_error) and closes the connection, exposing bugs loudly.

    def _cors(self) -> None:
        # the UI runs on its own origin/host; every response must be readable there
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:  # noqa: N802
        # CORS preflight for POST + Content-Type from the UI's origin
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            self._json({"ok": True})
        elif path == "/api/events":
            self._sse()
        elif path == "/api/workspace/tree":
            self._workspace_tree()
        elif path == "/api/fs/list":
            self._fs_list()
        else:
            self._json({"error": "not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/project/new":
            self._project_new()
        elif parsed.path == "/api/project/open":
            self._project_open()
        elif parsed.path == "/api/run":
            self._run()
        elif parsed.path == "/api/stop":
            self._stop()
        elif parsed.path == "/api/settings":
            self._settings()
        elif parsed.path == "/api/permission/respond":
            self._permission_respond()
        else:
            self._json({"error": "not found"}, status=404)

    # ---- API implementations ----
    def _read_body(self) -> dict | None:
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except ValueError:
            # malformed JSON body or Content-Length header: user error -> 400
            return None
        return data if isinstance(data, dict) else None

    def _run(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        task = (body.get("task") or "").strip()
        config = self._cfg
        if body.get("verify"):
            config = _replace(config, verify_command=body["verify"])

        if not task:
            return self._json({"error": "task is required"}, status=400)

        project = self._state.project
        if project is None:
            return self._json({"error": "no project open; create or open one first"}, status=400)
        workspace = self._state.workspace or Workspace(str(project.workdir))
        workspace.protect(project.path)

        try:
            llm = LlmClient(
                api_key=self._state.api_key or config.api_key,
                model=config.model,
                base_url=config.base_url,
            )
        except RuntimeError as e:
            # missing API key: an anticipated, user-facing condition
            return self._json({"error": f"LLM init failed: {e}"}, status=500)

        cancel = threading.Event()

        # start() claims the slot
        if not self._state.start(task, workspace, cancel):
            return self._json({"error": "a run is already active"}, status=409)

        def _on_ask(request_id: str, tool: str, args_repr: str, reason: str) -> None:
            # publish the permission request to the UI; the agent blocks until
            # the UI replies via /api/permission/respond
            self._broadcaster.publish(
                PermissionRequestEvent(request_id=request_id, tool=tool, args_repr=args_repr, reason=reason)
            )

        gate = PermissionGate(
            evaluator=PermissionEvaluator(),
            on_ask=_on_ask,
            auto_allow=config.non_interactive,
        )
        self._state.gate = gate

        agent = Agent(
            llm=llm,
            registry=ToolRegistry(build_default_tools(config)),
            workspace=workspace,
            config=config,
            log=project.log,
            sink=self._broadcaster.publish,
            cancel=cancel,
            gate=gate,
        )

        def _worker() -> None:
            # an unexpected error here propagates: Python prints the thread
            # traceback, and finally resets the busy flag. run() already emits a
            # graceful error final for anticipated AgentError failures.
            try:
                agent.run(task)
            finally:
                self._state.finish()

        threading.Thread(target=_worker, daemon=True).start()
        self._json(
            {
                "status": "started",
                "workspace": str(workspace.root),
                "project": str(project.path),
            }
        )

    def _stop(self) -> None:
        if self._state.cancel:
            self._state.cancel.set()
        self._json({"status": "cancelling"})

    def _settings(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        api_key = (body.get("api_key") or "").strip()
        if not api_key:
            return self._json({"error": "api_key is required"}, status=400)
        with self._state.lock:
            self._state.api_key = api_key
        save_settings({"api_key": api_key})
        self._json({"status": "ok"})

    def _permission_respond(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        request_id = (body.get("request_id") or "").strip()
        allow = bool(body.get("allow"))
        gate = self._state.gate
        if gate is None or not request_id:
            return self._json({"error": "no pending permission request"}, status=400)
        if not gate.resolve(request_id, allow):
            return self._json({"error": "request not found or already resolved"}, status=404)
        self._json({"status": "ok"})

    def _sse(self) -> None:
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = self._broadcaster.subscribe()
        try:
            # always reset the UI status first so a stale "running" never locks the
            # taskbar after a project switch or an interrupted run
            self._write_sse(StateUpdateEvent(key="execution_status", value="idle"))
            # replay the active project history first (only durable display
            # events — streaming deltas are transient and never replayed)
            project = self._state.project
            if project is not None:
                for ev in project.events():
                    if ev.type in DURABLE_TYPES:
                        self._write_sse(ev)
            # then live events
            while True:
                try:
                    ev = q.get(timeout=15)
                    self._write_sse(ev)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                except BrokenPipeError:
                    break
        finally:
            self._broadcaster.unsubscribe(q)

    def _write_sse(self, ev: Event) -> None:
        self.wfile.write(f"data: {event_to_json(ev)}\n\n".encode())
        self.wfile.flush()

    def _workspace_tree(self) -> None:
        qs = parse_qs(urlparse(self.path).query)
        expanded = qs.get("expanded", [])
        show_hidden = qs.get("hidden", ["0"])[0] == "1"
        sb = self._state.workspace
        if sb is None:
            return self._json({"tree": [], "root": None})
        self._json({"tree": _walk(sb.root, sb, expanded, show_hidden), "root": str(sb.root)})

    def _fs_list(self) -> None:
        """Server-side directory browser (the UI picks projects from here).

        One level, starts at the server user's home. Reachable only via the
        local bind or the SSH tunnel, so no auth is needed.
        """
        qs = parse_qs(urlparse(self.path).query)
        raw = (qs.get("path") or [""])[0]
        show_hidden = qs.get("hidden", ["0"])[0] == "1"
        if raw:
            p = Path(raw).expanduser()
            if not p.is_absolute():
                p = Path.home() / p
            root = p.resolve()
        else:
            root = Path.home().resolve()
        if not root.is_dir():
            return self._json({"error": f"not a directory: {root}"})
        try:
            entries = sorted(root.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        except OSError as e:
            return self._json({"error": f"cannot list directory: {e}"})
        if not show_hidden:
            entries = [e for e in entries if not e.name.startswith(".")]
        parent = str(root.parent) if root.parent != root else None
        self._json(
            {
                "path": str(root),
                "parent": parent,
                "entries": [
                    {
                        "name": e.name,
                        "path": str(e),
                        "dir": e.is_dir(),
                        "link": str(e.resolve()) if e.is_symlink() else None,
                    }
                    for e in entries
                ],
                "error": None,
            }
        )

    def _project_new(self) -> None:
        if self._state.busy:
            return self._json({"error": "a run is active; wait for it to finish"}, status=409)
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        dirname = (body.get("dir") or "").strip()
        name = (body.get("name") or "").strip()
        if not dirname or not name:
            return self._json({"error": "dir and name are required"}, status=400)
        try:
            project = create_project(Path(dirname) / name, name, model=self._cfg.model)
        except OSError as e:
            return self._json({"error": f"cannot create project: {e}"}, status=400)
        self._state.set_project(project)
        self._json(
            {
                "status": "ok",
                "project": str(project.path),
                "name": project.meta.name,
                "workdir": str(project.workdir),
            }
        )

    def _project_open(self) -> None:
        if self._state.busy:
            return self._json({"error": "a run is active; wait for it to finish"}, status=409)
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        path = (body.get("path") or "").strip()
        if not path:
            return self._json({"error": "path is required"}, status=400)
        full = Path(path).resolve()
        if not full.is_file() or full.suffix != ".clc":
            return self._json({"error": "not a .clc project file"}, status=400)
        self._open_stream_start(full)

    def _open_stream_start(self, full: Path) -> None:
        # stream the open as NDJSON so the UI can show real file-parse progress;
        # errors after headers are reported inline as an {"error": ...} line
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def emit(obj) -> None:
            self.wfile.write((json.dumps(obj) + "\n").encode("utf-8"))
            self.wfile.flush()

        def on_progress(done: int, total: int) -> None:
            emit({"progress": {"done": done, "total": total}})

        try:
            meta = read_header(full)
        except OSError as e:
            emit({"error": f"cannot open project: {e}"})
            return
        # meta first so the UI can leave the welcome screen and show the bar
        emit(
            {
                "meta": {
                    "project": str(full),
                    "name": meta.name,
                    "workdir": str(full.parent),
                }
            }
        )
        try:
            project = open_project(full, on_progress=on_progress)
        except (OSError, ValueError) as e:
            emit({"error": f"cannot open project: {e}"})
            return
        self._state.set_project(project)
        # display projection: only durable final events, so old sessions stored
        # as full streaming logs still load fast (opencode loads parts, not deltas)
        display = [e for e in project.events() if e.type in DURABLE_TYPES]
        emit({"count": len(display)})
        for ev in display:
            emit({"event": json.loads(event_to_json(ev))})
        emit({"done": True})

    def _json(self, obj: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:  # silence request spam
        print(f"[http] {self.address_string()} {format % args}")


def _replace(config: Config, **kw: Any) -> Config:
    return dataclasses.replace(config, **kw)


def _walk(root: Path, workspace: Workspace | None, expanded: list[str], show_hidden: bool) -> list:
    """Lazy partial tree walk: list children only for the root, the currently
    expanded dirs, and their direct children (one level of lookahead). Deeper
    levels are fetched as they get expanded, so opening a big project never walks
    the whole tree up front. show_hidden keeps dotfiles out of every level."""
    expanded = set(expanded)

    def list_entries(p: Path) -> list[Path]:
        if workspace is not None:
            entries = workspace.visible_entries(p)
        else:
            try:
                entries = sorted(p.iterdir(), key=lambda e: (e.is_file(), e.name.lower()))
            except OSError:
                return []
        if not show_hidden:
            entries = [e for e in entries if not e.name.startswith(".")]
        return entries

    def build(p: Path, rel: str) -> list:
        out = []
        for e in list_entries(p):
            node: dict[str, Any] = {
                "name": e.name,
                "path": str(e.relative_to(root)),
                "dir": e.is_dir(),
                "link": str(e.resolve()) if e.is_symlink() else None,
            }
            # don't recurse into symlinked dirs (display-only): prevents escaping
            # into system trees and symlink cycles; the agent's tools still follow
            # links, so only the UI is affected
            if e.is_dir() and not e.is_symlink():
                child_rel = str(e.relative_to(root))
                # list this dir if it is the root, expanded, or directly under an
                # expanded dir (the one-level lookahead); otherwise stop
                listed = rel == "" or child_rel in expanded or rel in expanded
                if listed:
                    node["children"] = build(e, child_rel)
            out.append(node)
        return out

    return build(root, "")


class ClutchServer(ThreadingHTTPServer):
    # shared runtime state, injected by build(); the Handler reaches them via self.server
    config: Config
    state: RunState
    broadcaster: Broadcaster


def build(
    config: Config,
    broadcaster: Broadcaster,
    state: RunState,
) -> ClutchServer:
    srv = ClutchServer((config.host, config.port), Handler)
    srv.broadcaster = broadcaster
    srv.config = config
    srv.state = state
    return srv


def main() -> int:
    parser = argparse.ArgumentParser(prog="clutch-server")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to expose to other devices)")
    parser.add_argument("--port", type=int, default=8890)
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument(
        "--base-url",
        default=None,
        help=(
            "LLM API base URL. Point at the client-side proxy "
            "(http://127.0.0.1:8892/v1) when the server has no internet."
        ),
    )
    parser.add_argument("--verify", default=None, help="verification command; empty disables the gate")
    args = parser.parse_args()

    config = Config()
    config.host = args.host
    config.port = args.port
    config.model = args.model
    if args.base_url:
        config.base_url = args.base_url
        # the client-side proxy injects the real key; server only needs a placeholder
        if not (config.api_key or os.environ.get("DEEPSEEK_API_KEY")):
            config.api_key = "proxy"
    if args.verify:
        config.verify_command = args.verify

    broadcaster = Broadcaster()
    state = RunState()
    # restore the API key persisted by the GUI settings (outside the repo)
    state.api_key = load_settings().get("api_key")

    srv = build(config, broadcaster, state)
    print(f"[clutch-server] http://{config.host}:{config.port}  (API only; start the UI separately)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
