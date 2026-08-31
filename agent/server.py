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
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .base import BaseServer, Broadcaster, RunState
from .config import REASONING_EFFORT_LEVELS, Config, flatten_settings
from .core.project_lock import ProjectLock, ProjectOpenConflict
from .events import (
    Event,
    FinalEvent,
    PermissionRequestEvent,
    StateUpdateEvent,
    event_to_json,
)
from .project import Project, create_project, open_project_lazy
from .tools.transport import SshTransport
from .tools.workspace import RemoteWorkspace, Workspace, parse_ls_entries, shq

# a client hanging up mid-SSE surfaces as one of these on the socket write;
# end cleanly, never let socketserver print a BrokenPipeError traceback
_SSE_ERR = (BrokenPipeError, ConnectionResetError, ValueError)


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


class HttpAgentServer(BaseServer):
    """The run-assembly contract for the HTTP host; routing lives in Handler."""

    def build_workspace(self, project: Project) -> Workspace:
        return self.state.build_workspace(str(project.workdir))


class Handler(BaseHTTPRequestHandler):
    server: ClutchServer  # type: ignore

    # the app (HttpAgentServer) holds config/broadcaster/state; expose them to the
    # handler uniformly.
    @property
    def _app(self) -> HttpAgentServer:
        return self.server.app

    @property
    def _cfg(self) -> Config:
        return self._app.config

    @property
    def _state(self) -> RunState:
        return self._app.state

    @property
    def _broadcaster(self) -> Broadcaster:
        return self._app.broadcaster

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
            params = parse_qs(parsed.query)
            self._sse(
                (params.get("project") or [None])[0],
                (params.get("replay") or ["1"])[0] != "0",
            )
        elif path == "/api/history":
            self._history()
        elif path == "/api/workspace/tree":
            self._workspace_tree()
        elif path == "/api/fs/list":
            self._fs_list()
        elif path == "/api/settings":
            self._settings_get()
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
            self._settings_post()
        elif parsed.path == "/api/permission/respond":
            self._permission_respond()
        elif parsed.path == "/api/workspace/revert":
            self._workspace_revert()
        elif parsed.path == "/api/backend":
            self._backend()
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
        mode = body.get("mode")
        if mode in ("chat", "work"):
            config = _replace(config, mode=mode)

        if not task:
            return self._json({"error": "task is required"}, status=400)

        project = self._state.project
        req_project = (body.get("project") or "").strip()
        if req_project and (project is None or str(project.path) != req_project):
            # a different window's project: switch the active project to this
            # window's file so each UI window's runs append to its own .clc
            full = Path(req_project).resolve()
            if full.suffix != ".clc" or not full.is_file():
                return self._json({"error": f"cannot open project: {req_project}"}, status=400)
            try:
                ws = self._state.build_workspace(str(full.parent))
                project = open_project_lazy(full, workspace=ws)
                self._state.set_project(project, workspace=ws)
            except ProjectOpenConflict:
                return self._json(
                    {"error": "project is open in another window", "code": "project_open_conflict"},
                    status=409,
                )
            except (OSError, ValueError) as e:
                return self._json({"error": f"cannot open project: {e}"}, status=500)
        if project is None:
            return self._json({"error": "no project open; create or open one first"}, status=400)
        if project.read_only:
            return self._json(
                {"error": "project opened read-only; close the other window first"}, status=409
            )

        def _on_ask(request_id: str, tool: str, args_repr: str, reason: str) -> bool:
            # publish the permission request to the UI; with no SSE subscriber
            # the gate denies instead of blocking forever
            if self._broadcaster.count() == 0:
                return False
            self._broadcaster.publish(
                PermissionRequestEvent(request_id=request_id, tool=tool, args_repr=args_repr, reason=reason)
            )
            return True

        try:
            agent = self._app.start_task(task, project, on_ask=_on_ask, cancel=None, config=config)
        except RuntimeError as e:
            # missing API key: an anticipated, user-facing condition
            return self._json({"error": f"LLM init failed: {e}"}, status=500)
        if agent is None:
            return self._json({"error": "a run is already active"}, status=409)
        self._state.gate = agent.gate
        # tag the active run with its project so SSE subscribers on other
        # projects can filter it out of their live stream
        self._state.run_project = str(project.path)

        def _worker() -> None:
            # run() emits a graceful error final for anticipated AgentError
            # failures; anything else (e.g. the SSH tunnel dying under a degraded
            # backend) must surface as an error final instead of a silent idle.
            try:
                agent.run(task)
            except Exception as e:  # noqa: BLE001 -- last-resort user-facing final
                print(f"[clutch] run crashed: {e}", file=sys.stderr)
                try:
                    self._broadcaster.publish(FinalEvent(status="error", summary=f"run crashed: {e}"))
                    self._broadcaster.publish(StateUpdateEvent(value="error"))
                except Exception:  # noqa: BLE001
                    pass
            finally:
                self._state.finish()

        threading.Thread(target=_worker, daemon=True).start()
        self._json(
            {
                "status": "started",
                "workspace": str(agent.workspace.root),
                "project": str(project.path),
            }
        )

    def _stop(self) -> None:
        if self._state.cancel:
            self._state.cancel.set()
        # a run may be blocked on a permission prompt (gate.require waits): Stop
        # must unblock it, otherwise the agent stays stuck until the 60s timeout
        gate = self._state.gate
        if gate is not None:
            for rid in list(gate.pending_ids()):
                gate.resolve(rid, False)
        self._json({"status": "cancelling"})

    def _settings_post(self) -> None:
        """Save the flat LLM settings (base_url / model / api_key /
        reasoning_effort) and apply them to the live server config."""
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)

        reasoning_effort = (body.get("reasoning_effort") or "").strip()
        if reasoning_effort and reasoning_effort not in REASONING_EFFORT_LEVELS:
            return self._json(
                {"error": f"reasoning_effort must be one of {', '.join(REASONING_EFFORT_LEVELS)}"},
                status=400,
            )
        base_url = (body.get("base_url") or "").strip()
        model = (body.get("model") or "").strip()
        api_key = (body.get("api_key") or "").strip()
        if not any((base_url, model, api_key)) and "reasoning_effort" not in body:
            return self._json({"error": "nothing to save"}, status=400)

        with self._state.lock:
            if api_key:
                self._state.api_key = api_key
            if base_url:
                self._cfg.base_url = base_url
            if model:
                self._cfg.model = model
            # empty value clears the knob (provider default); None = unset
            if "reasoning_effort" in body:
                self._cfg.llm_reasoning_effort = reasoning_effort or None
        saved = flatten_settings(load_settings())
        if base_url:
            saved["base_url"] = base_url
        if model:
            saved["model"] = model
        if api_key:
            saved["api_key"] = api_key
        if "reasoning_effort" in body:
            if reasoning_effort:
                saved["reasoning_effort"] = reasoning_effort
            else:
                saved.pop("reasoning_effort", None)  # empty = clear the knob
        save_settings(saved)
        self._json({"status": "ok"})

    def _settings_get(self) -> None:
        """Current LLM endpoint config for the settings modal (no credentials)."""
        saved = flatten_settings(load_settings())
        self._json(
            {
                "base_url": self._cfg.base_url or saved.get("base_url", ""),
                "model": self._cfg.model or saved.get("model", ""),
                "reasoning_effort": self._cfg.llm_reasoning_effort or saved.get("reasoning_effort", ""),
                "has_api_key": bool(self._state.api_key or self._cfg.api_key or saved.get("api_key")),
            }
        )

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

    def _backend(self) -> None:
        """Switch between the local and the SSH-degradation backend. The renderer
        posts {mode:"ssh", bridge, workspace} when bootstrap fails on a host that
        has no Python, and {mode:"local"} when it disconnects/resets."""
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        mode = body.get("mode") or "local"
        if mode == "ssh":
            bridge = (body.get("bridge") or "").strip()
            if not bridge:
                return self._json({"error": "bridge is required for ssh mode"}, status=400)
            root = (body.get("workspace") or "").strip() or str(Path.home())
            self._state.set_backend("ssh", bridge, root)
        else:
            self._state.set_backend("local")
        # a mode switch invalidates the window's project context (set_backend
        # clears it): drop any locks it still holds so they never linger
        ProjectLock.release_all()
        self._json({"status": "ok"})

    def _project_for_sse(self, project_q: str | None) -> Project | None:
        """Resolve the project an SSE subscriber asked to watch: the global
        active one when no project is given (or it matches), otherwise open the
        requested .clc fresh. Failures degrade to None (skip replay)."""
        try:
            if project_q:
                global_proj = self._state.project
                if global_proj is not None and str(global_proj.path) == project_q:
                    return global_proj
                full = Path(project_q).resolve()
                if full.suffix == ".clc" and full.is_file():
                    ws = self._state.build_workspace(str(full.parent))
                    # SSE only replays/watchs: open read-only so a subscriber
                    # never takes the write lock (or fights the real writer)
                    return open_project_lazy(full, workspace=ws, read_only=True)
                return None
            return self._state.project
        except (OSError, ValueError):
            return None

    def _sse(self, project_q: str | None = None, replay: bool = True) -> None:
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
            try:
                self._write_sse(StateUpdateEvent(key="execution_status", value="idle"))
                # replay durable events only (deltas are transient); replay=False
                # skips it when the UI just rendered the open NDJSON stream
                if replay:
                    project = self._project_for_sse(project_q)
                    if project is not None:
                        log = project.log
                        # lazy log: resident events replay with byte offsets + the
                        # on-disk older count
                        self._write_sse_raw({"type": "history", "older": max(0, log.cpr_start())})
                        for off, ev in log.items():
                            self._write_sse(ev, offset=off)
            except _SSE_ERR:
                return  # client went away mid-status/replay: nothing left to stream
            # then live events
            while True:
                try:
                    ev = q.get(timeout=15)
                    rp = self._state.run_project
                    if rp and project_q and rp != project_q:
                        continue  # another window's run: don't leak its events here
                    self._write_sse(ev)
                except queue.Empty:
                    try:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                    except _SSE_ERR:
                        break
                except _SSE_ERR:
                    break
        finally:
            self._broadcaster.unsubscribe(q)

    def _write_sse(self, ev: Event, offset: int | None = None) -> None:
        """Emit one SSE event; with ``offset`` the payload is {offset, event} (the
        lazy replay/open wire shape), otherwise the bare event JSON. event_to_json
        already returns a serialized string, so only the wrapped shape is
        re-serialized (no double encoding)."""
        if offset is not None:
            payload = json.dumps({"offset": offset, "event": json.loads(event_to_json(ev))})
        else:
            payload = event_to_json(ev)
        self.wfile.write(f"data: {payload}\n\n".encode())
        self.wfile.flush()

    def _write_sse_raw(self, obj: dict) -> None:
        self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
        self.wfile.flush()

    def _workspace_tree(self) -> None:
        qs = parse_qs(urlparse(self.path).query)
        expanded = qs.get("expanded", [])
        show_hidden = qs.get("hidden", ["0"])[0] == "1"
        sb = self._state.workspace
        if sb is None:
            return self._json({"tree": [], "root": None})
        if isinstance(sb, RemoteWorkspace):
            tree = _walk_remote(sb, expanded, show_hidden)
        else:
            tree = _walk(sb.root, sb, expanded, show_hidden)
        self._json({"tree": tree, "root": str(sb.root)})

    def _workspace_revert(self) -> None:
        """User-side undo: restore the last snapshot of a file in the workspace
        (the write_file/edit_file tools record a snapshot before every overwrite).
        Backs the UI's "↶ undo" button on a change result."""
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        path = (body.get("path") or "").strip()
        ws = self._state.workspace
        if ws is None or not path:
            return self._json({"error": "no workspace open"}, status=400)
        try:
            p = ws.resolve(path)
        except ValueError as e:
            return self._json({"error": str(e)}, status=400)
        if ws.is_protected(p):
            return self._json({"error": "protected file"}, status=400)
        if ws.restore(p) is None:
            return self._json({"error": "no snapshot to restore"}, status=404)
        self._json({"status": "ok", "path": str(p)})

    def _fs_list(self) -> None:
        """Server-side directory browser (the UI picks projects from here).

        One level, starts at the server user's home (or the SSH remote's home in
        degradation mode). Reachable only via the local bind or the SSH tunnel, so
        no auth is needed.
        """
        qs = parse_qs(urlparse(self.path).query)
        raw = (qs.get("path") or [""])[0]
        show_hidden = qs.get("hidden", ["0"])[0] == "1"
        if self._state.backend_mode == "ssh" and self._state.bridge_url:
            return self._fs_list_remote(raw, show_hidden)
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

    def _fs_list_remote(self, raw: str, show_hidden: bool) -> None:
        """One-level remote directory listing via a single ls exec over the bridge."""
        transport = SshTransport(self._state.bridge_url)
        base = self._state.remote_root or "~"
        if raw:
            target = raw if raw.startswith("/") else base.rstrip("/") + "/" + raw
        else:
            target = base
        if target == "~" or target.startswith("~/"):
            home = transport.run("echo $HOME", _FS_LIST_TIMEOUT).stdout.strip() or base
            target = home if target == "~" else home + target[1:]
        r = transport.run(f"ls -1AF {shq(target)}", _FS_LIST_TIMEOUT)
        if r.code != 0:
            return self._json({"error": f"not a directory: {target}"})
        entries = []
        for name, is_dir in parse_ls_entries(r.stdout):
            # dirs are always shown even when hidden (the browser needs a way
            # into dot-directories); hidden files are filtered like _walk
            if not is_dir and not show_hidden and name.startswith("."):
                continue
            # link targets need an extra readlink exec per symlink; skip (P2 MVP)
            entries.append({"name": name, "path": target.rstrip("/") + "/" + name, "dir": is_dir, "link": None})
        parent = target.rsplit("/", 1)[0] if target != "/" else None
        self._json({"path": target, "parent": parent, "entries": entries, "error": None})

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
        ws = None
        try:
            if self._state.backend_mode == "ssh" and self._state.bridge_url:
                ws = self._state.build_workspace(str(Path(dirname)))
                project = create_project(Path(dirname) / name, name, model=self._cfg.model, workspace=ws)
            else:
                project = create_project(Path(dirname) / name, name, model=self._cfg.model)
        except OSError as e:
            return self._json({"error": f"cannot create project: {e}"}, status=400)
        self._state.set_project(project, workspace=ws)
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
        if full.suffix != ".clc":
            return self._json({"error": "not a .clc project file"}, status=400)
        if self._state.backend_mode != "ssh":
            # remote paths don't exist on the local filesystem; the open itself
            # reports a missing remote file via workspace.read
            if not full.is_file():
                return self._json({"error": "not a .clc project file"}, status=400)
        read_only = bool(body.get("read_only")) or str(body.get("read_only", "")).lower() == "true"
        self._open_stream_start(full, read_only=read_only)

    def _open_stream_start(self, full: Path, read_only: bool = False) -> None:
        # build the workspace first (ssh mode -> RemoteWorkspace over the bridge),
        # so the lock and index/load/append all hit the same remote host
        ws = self._state.build_workspace(str(full.parent))
        # write lock: the window that opens a project for write is its only
        # writer. Conflict -> HTTP 409 + code so the UI can offer read-only
        # without parsing the NDJSON stream for the error line.
        lock = None
        if not read_only:
            # one window holds the write lock on at most its CURRENTLY-open
            # project: opening a different project releases the previous one so
            # it never lingers behind a moved-away window
            prev = self._state.project
            if prev is not None and prev.lock is not None and str(prev.path) != str(full):
                ProjectLock.release(prev.lock)
                prev.lock = None
            lock = ProjectLock.acquire(str(full))
            if lock is None:
                return self._json(
                    {"error": "project is open in another window", "code": "project_open_conflict"},
                    status=409,
                )
        # stream the open as NDJSON so the UI can show real file-parse progress;
        # errors are reported inline as an {"error": ...} line
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
            project = open_project_lazy(full, on_progress=on_progress, workspace=ws, read_only=read_only)
        except ProjectOpenConflict as e:
            if lock is not None:
                ProjectLock.release(lock)
            emit({"error": str(e), "code": e.code})
            return
        except (OSError, ValueError) as e:
            if lock is not None:
                ProjectLock.release(lock)
            emit({"error": f"cannot open project: {e}"})
            return
        self._state.set_project(project, workspace=ws)
        # meta after the (single-pass, no-JSON) index scan: the header lives in the
        # same indexed read, so emitting it afterwards costs no extra fetch
        emit(
            {
                "meta": {
                    "project": str(full),
                    "name": project.meta.name,
                    "workdir": str(full.parent),
                    "read_only": project.read_only,
                }
            }
        )
        # lazy log: only the model window (since the newest compaction line) is
        # resident; "older" = event-region BYTES still on disk, paged via /api/history
        log = project.log
        pairs = log.items()
        emit({"count": len(pairs), "older": max(0, log.cpr_start())})
        for off, ev in pairs:
            emit({"offset": off, "event": json.loads(event_to_json(ev))})
        emit({"done": True})

    def _history(self) -> None:
        """Scroll-up paging for a lazily-opened project: PURE DISK read of the
        durable events in the byte range before ``before`` (relative offsets,
        exclusive, max ``limit`` bytes) and return them with their offsets. The
        UI prepends the page and trusts the response's server-side ``older``
        count (honest even after a reconnect dropped pages the UI already
        rendered). The page never enters the resident log: history browsing is
        decoupled from the model context (which is only the window since the
        newest compaction line)."""
        qs = parse_qs(urlparse(self.path).query)
        try:
            before = int(qs.get("before", ["0"])[0])
            limit = min(max(int(qs.get("limit", ["262144"])[0]), 4096), 4 * 1024 * 1024)
        except ValueError:
            return self._json({"error": "bad query"}, status=400)
        project = self._state.project
        log = project.log if project is not None else None
        if log is None:
            return self._json({"events": [], "older": 0})
        lo = max(0, before - limit)
        pairs = log.read_page(lo, before)
        self._json(
            {
                "events": [{"offset": off, "event": json.loads(event_to_json(ev))} for off, ev in pairs],
                "older": max(0, lo),
            }
        )

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


# per-exec timeout for remote directory browsing (one ls / echo $HOME over the bridge)
_FS_LIST_TIMEOUT = 30.0


def _tree_node(name: str, child_rel: str, is_dir: bool) -> dict[str, Any]:
    """One workspace-tree node: {name, path, dir, link} (link resolved by the
    local walk, which has the file system at hand)."""
    return {"name": name, "path": child_rel, "dir": is_dir, "link": None}


def _should_list(rel: str, child_rel: str, expanded: set[str]) -> bool:
    """Whether a child dir gets listed now: the root, an explicitly expanded
    dir, or a dir directly under an expanded one (the one-level lookahead)."""
    return rel == "" or child_rel in expanded or rel in expanded


def _walk_remote(ws: Workspace, expanded: list[str], show_hidden: bool) -> list:
    """Remote counterpart of _walk: same lazy partial walk (root + expanded dirs +
    one-level lookahead), but every level lists all its directories in ONE exec
    (RemoteWorkspace.list_many), so a tree costs ~depth round trips instead of one
    per directory. Entries come from the shared parse_ls_entries parser."""
    expanded = set(expanded)
    children: dict[str, list[dict[str, Any]]] = {}
    by_path: dict[str, dict[str, Any]] = {}

    frontier: list[str] = [""]
    while frontier:
        listed = ws.list_many(frontier)  # one SSH round trip per tree level
        next_frontier: list[str] = []
        for rel in frontier:
            out: list[dict[str, Any]] = []
            for name, is_dir in parse_ls_entries("\n".join(listed.get(rel, []))):
                if not show_hidden and name.startswith("."):
                    continue
                child_rel = name if rel == "" else f"{rel}/{name}"
                node = _tree_node(name, child_rel, is_dir)
                out.append(node)
                if is_dir:
                    by_path[child_rel] = node
                    if _should_list(rel, child_rel, expanded):
                        next_frontier.append(child_rel)
            children[rel] = out
        frontier = next_frontier

    # attach each listed level under its parent dir node
    for rel, out in children.items():
        if rel == "":
            continue
        parent = by_path.get(rel)
        if parent is not None:
            parent["children"] = out
    return children[""]


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
            child_rel = str(e.relative_to(root))
            node = _tree_node(e.name, child_rel, e.is_dir())
            node["link"] = str(e.resolve()) if e.is_symlink() else None
            # symlinked dirs are shown as leaves: prevents escaping into system
            # trees and symlink cycles; the agent's tools still follow links, so
            # only the UI is affected
            if e.is_dir() and not e.is_symlink():
                if _should_list(rel, child_rel, expanded):
                    node["children"] = build(e, child_rel)
            out.append(node)
        return out

    return build(root, "")


class ClutchServer(ThreadingHTTPServer):
    # the app (HttpAgentServer) holds config/broadcaster/state; injected by build()
    app: HttpAgentServer


def build(
    config: Config,
    broadcaster: Broadcaster,
    state: RunState,
) -> ClutchServer:
    app = HttpAgentServer(config, broadcaster, state)
    srv = ClutchServer((config.host, config.port), Handler)
    srv.app = app
    return srv


def main() -> int:
    defaults = Config()
    parser = argparse.ArgumentParser(prog="clutch-server")
    parser.add_argument("--host", default=defaults.host, help="bind address (0.0.0.0 to expose to other devices)")
    parser.add_argument("--port", type=int, default=defaults.port)
    parser.add_argument("--model", default=None)
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
    if args.verify:
        config.verify_command = args.verify

    # LLM endpoint resolution — precedence: CLI args > env > GUI-saved settings
    # (flat ~/.clutch/settings.json; legacy profile-map files migrate on read)
    saved = flatten_settings(load_settings())
    if args.base_url:
        config.base_url = args.base_url
    elif not config.base_url:
        config.base_url = saved.get("base_url", "")
    if args.model:
        config.model = args.model
    elif not config.model:
        config.model = saved.get("model", "")
    # API key: env > saved settings > config default
    config.api_key = config.api_key or saved.get("api_key")
    # reasoning_effort: env-less; saved settings only
    if not config.llm_reasoning_effort:
        config.llm_reasoning_effort = saved.get("reasoning_effort") or None
    api_key = config.api_key
    if args.base_url and not api_key:
        # the client-side proxy injects the real key; the server only needs a
        # placeholder. No env fallback: the key comes from the UI settings
        # (state.api_key) or an explicit config.api_key.
        api_key = "proxy"

    broadcaster = Broadcaster()
    state = RunState()
    # restore the settings persisted by the GUI (api key + LLM endpoint)
    state.api_key = api_key

    srv = build(config, broadcaster, state)
    # --port 0 makes the OS pick a free port; stdout is the only channel back to
    # the spawning Electron shell, so print the REAL bound port — always as the
    # loopback address, because the UI's port regex keys on 127.0.0.1:<port>.
    bound_port = srv.server_address[1]
    # resolved LLM endpoint, for diagnosing which endpoint a session targets;
    # the label keeps the line from ever matching the port banner regex
    print(
        f"[clutch-server] LLM: model={config.model} base_url={config.base_url}",
        flush=True,
    )
    print(f"[clutch-server] http://127.0.0.1:{bound_port}  (API only; start the UI separately)", flush=True)
    # No lock cleanup on exit is needed: every project lock is a flock in the
    # local OS temp dir, and the kernel releases it when this process dies.
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
