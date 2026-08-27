"""HTTP + SSE server that hosts the agent as a product.

Endpoints (all JSON except static/SSE):
  POST /api/run        {task, verify?} -> start run (409 if busy)
  POST /api/stop       cancel the running agent
  GET  /api/events     SSE: replay current session history, then live events
  GET  /api/workspace/tree   file tree under the workspace root
  GET  /api/workspace/file?path=  file content (workspace-constrained)
  GET  /api/sessions   list session JSONL files for replay
  GET  /api/health     {ok}
  GET  /*              static files from --ui-dir (the product frontend)

The agent's existing sink is fed into a thread-safe broadcaster; each SSE subscriber
gets a private queue. One run at a time; Stop sets a cancel flag checked by the loop.
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse, unquote

from .config import Config
from .core.terminate import Terminator
from .core.permission import PermissionEvaluator, PermissionGate
from .events import (
    Event,
    EventLog,
    PermissionRequestEvent,
    event_from_dict,
    event_to_json,
)
from .llm.client import LlmClient
from .loop import Agent
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
    except OSError:
        pass


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
    """Holds the live agent + cancel flag for the single active run.

    Sessions: a session is a persistent EventLog (sessions/<id>.jsonl). Runs
    within the same session share that log so the conversation continues;
    a new session starts with a fresh log.
    """

    def __init__(self, sessions_dir: Path) -> None:
        self.lock = threading.Lock()
        self.agent: Optional[Agent] = None
        self.task: str = ""
        self.busy = False
        self.cancel: Optional[threading.Event] = None
        self.log = EventLog()
        self.current_session: str = ""
        self.current_workdir: str = ""
        self.workspace: Optional[Workspace] = None
        self._sessions_dir = sessions_dir
        self.api_key: Optional[str] = None
        self.gate: Optional[PermissionGate] = None

    def start(
        self,
        task: str,
        workspace: Workspace,
        cancel: threading.Event,
        session_id: str = "",
        new_session: bool = False,
    ) -> bool:
        with self.lock:
            if self.busy:
                return False
            self.busy = True
            self.task = task
            self.cancel = cancel
            self.workspace = workspace

            import time

            if new_session or not session_id:
                # start a brand-new session
                seq = time.strftime("%Y%m%d-%H%M%S")
                self.current_session = f"session-{seq}"
                self.log = EventLog(path=str(self._sessions_dir / f"{self.current_session}.jsonl"))
                self.current_workdir = str(workspace.root)
                # bind the workdir to this session for follow-up runs
                wd_path = self._sessions_dir / f"{self.current_session}.workdir"
                wd_path.write_text(self.current_workdir, encoding="utf-8")
            else:
                # resume the given session (its log already exists)
                path = self._sessions_dir / f"{session_id}.jsonl"
                self.current_session = session_id
                if path.exists():
                    self.log = EventLog.load(str(path))
                else:
                    self.log = EventLog(path=str(path))
                wd_path = self._sessions_dir / f"{session_id}.workdir"
                self.current_workdir = wd_path.read_text(encoding="utf-8").strip() if wd_path.exists() else ""
        return True

    def finish(self) -> None:
        # keep the last workspace + log + session so a follow-up run can continue
        with self.lock:
            self.busy = False
            self.agent = None


class Handler(SimpleHTTPRequestHandler):
    server: "ClutchServer"

    # config/broadcaster/state/ui_dir/sessions_dir are set on the server instance;
    # this property exposes them uniformly to the handler.
    @property
    def _cfg(self) -> Config:
        return self.server.config  # type: ignore[attr-defined]

    @property
    def _state(self) -> RunState:
        return self.server.state  # type: ignore[attr-defined]

    @property
    def _broadcaster(self) -> Broadcaster:
        return self.server.broadcaster  # type: ignore[attr-defined]

    @property
    def _ui_dir(self) -> Path:
        return self.server.ui_dir  # type: ignore[attr-defined]

    @property
    def _sessions_dir(self) -> Path:
        return self.server.sessions_dir  # type: ignore[attr-defined]

    # ---- routing ----
    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/api/health":
                self._json({"ok": True})
            elif path == "/api/events":
                self._sse()
            elif path == "/api/workspace/tree":
                self._workspace_tree()
            elif path == "/api/workspace/file":
                self._workspace_file(parsed.query)
            elif path == "/api/sessions":
                self._sessions()
            elif path == "/api/sessions/replay":
                self._session_replay(parsed.query)
            else:
                self._static(path)
        except Exception as e:  # noqa: BLE001 -- never let a handler crash the server
            print(f"[clutch-server] handler error: {e}", file=sys.stderr)
            try:
                self._json({"error": f"internal error: {e}"}, status=500)
            except Exception:  # noqa: BLE001 -- response already started
                pass

    def do_POST(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/run":
                self._run()
            elif parsed.path == "/api/stop":
                self._stop()
            elif parsed.path == "/api/settings":
                self._settings()
            elif parsed.path == "/api/session/new":
                self._session_new()
            elif parsed.path == "/api/permission/respond":
                self._permission_respond()
            else:
                self._json({"error": "not found"}, status=404)
        except Exception as e:  # noqa: BLE001 -- never let a handler crash the server
            print(f"[clutch-server] handler error: {e}", file=sys.stderr)
            try:
                self._json({"error": f"internal error: {e}"}, status=500)
            except Exception:  # noqa: BLE001 -- response already started
                pass

    # ---- API implementations ----
    def _run(self) -> None:
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except Exception:  # noqa: BLE001
            return self._json({"error": "bad json body"}, status=400)
        task = (body.get("task") or "").strip()
        session_id = (body.get("session_id") or "").strip()
        new_session = bool(body.get("new_session"))
        config = self._cfg
        if body.get("verify"):
            config = _replace(config, verify_command=body["verify"])
        if body.get("workdir"):
            config = _replace(config, workdir=body["workdir"])

        if not task:
            return self._json({"error": "task is required"}, status=400)

        # session-bound workdir: a resumed session reuses its bound workdir;
        # a new session binds the requested (or default) workdir.
        if not new_session and session_id:
            bound = self._session_workdir(session_id)
            if bound:
                config = _replace(config, workdir=bound)
        workspace = Workspace(config.workdir)

        try:
            llm = LlmClient(
                api_key=self._state.api_key or config.api_key,
                model=config.model,
                base_url=config.base_url,
            )
        except Exception as e:  # noqa: BLE001 -- key/proxy/config failures are user-facing
            return self._json({"error": f"LLM init failed: {e}"}, status=500)

        terminator = Terminator(config)
        cancel = threading.Event()

        # start() claims the slot and creates/loads the session log FIRST,
        # so the agent writes into a file-backed log we can replay later.
        if not self._state.start(
            task, workspace, cancel, session_id=session_id, new_session=new_session
        ):
            return self._json({"error": "a run is already active"}, status=409)
        log = self._state.log

        def _on_ask(request_id: str, tool: str, args_repr: str, reason: str) -> None:
            # publish the permission request to the UI; the agent blocks until
            # the UI replies via /api/permission/respond
            self._broadcaster.publish(
                PermissionRequestEvent(
                    request_id=request_id, tool=tool, args_repr=args_repr, reason=reason
                )
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
            log=log,
            sink=self._broadcaster.publish,
            cancel=cancel,
            gate=gate,
        )

        def _worker() -> None:
            try:
                agent.run(task)
            finally:
                self._state.finish()

        threading.Thread(target=_worker, daemon=True).start()
        self._json({
            "status": "started",
            "workspace": str(workspace.root),
            "session_id": self._state.current_session,
        })

    def _stop(self) -> None:
        if self._state.cancel:
            self._state.cancel.set()
        self._json({"status": "cancelling"})

    def _settings(self) -> None:
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except Exception:  # noqa: BLE001
            return self._json({"error": "bad json body"}, status=400)
        api_key = (body.get("api_key") or "").strip()
        if not api_key:
            return self._json({"error": "api_key is required"}, status=400)
        with self._state.lock:
            self._state.api_key = api_key
        save_settings({"api_key": api_key})
        self._json({"status": "ok"})

    def _permission_respond(self) -> None:
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except Exception:  # noqa: BLE001
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
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = self._broadcaster.subscribe()
        try:
            # replay the current session history first
            for ev in self._state.log.events():
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
        self.wfile.write(f"data: {event_to_json(ev)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _workspace_tree(self) -> None:
        sb = self._state.workspace
        if sb is None:
            return self._json({"tree": [], "root": None})
        self._json({"tree": _walk(sb.root), "root": str(sb.root)})

    def _workspace_file(self, query: str) -> None:
        sb = self._state.workspace
        if sb is None:
            return self._json({"error": "no active workspace"}, status=400)
        from urllib.parse import parse_qs

        rel = (parse_qs(query).get("path") or [""])[0]
        try:
            p = sb.resolve(rel)
        except ValueError as e:
            return self._json({"error": str(e)}, status=400)
        if not p.is_file():
            return self._json({"error": "not a file"}, status=400)
        content = p.read_text(encoding="utf-8", errors="replace")
        self._json({"path": rel, "content": content})

    def _session_workdir(self, session_id: str) -> str:
        """Return the workdir bound to a session, or ''."""
        wd = self._sessions_dir / f"{session_id}.workdir"
        try:
            return wd.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def _session_new(self) -> None:
        if self._state.busy:
            return self._json({"error": "a run is active; wait for it to finish"}, status=409)
        import time

        seq = time.strftime("%Y%m%d-%H%M%S")
        session_id = f"session-{seq}"
        self._state.current_session = session_id
        self._state.log = EventLog(path=str(self._sessions_dir / f"{session_id}.jsonl"))
        self._state.current_workdir = ""
        self._json({"status": "ok", "session_id": session_id})

    def _sessions(self) -> None:
        items = []
        for f in sorted(self._sessions_dir.glob("*.jsonl")):
            summary = _session_summary(f)
            items.append({
                "name": f.stem,
                "id": f.stem,
                "path": str(f),
                "size": f.stat().st_size,
                "summary": summary,
            })
        self._json({"sessions": items})

    def _session_replay(self, query: str) -> None:
        from urllib.parse import parse_qs

        p = (parse_qs(query).get("path") or [""])[0]
        # only allow files inside the sessions dir
        try:
            full = (Path(p)).resolve()
            full.relative_to(self._sessions_dir.resolve())
        except (ValueError, FileNotFoundError):
            return self._json({"error": "invalid session path"}, status=400)
        try:
            log = EventLog.load(str(full))
        except FileNotFoundError:
            return self._json({"error": "session not found"}, status=404)
        self._json({"events": [json.loads(event_to_json(e)) for e in log.events()]})

    def _static(self, path: str) -> None:
        # delegate to SimpleHTTPRequestHandler against ui_dir
        self.directory = str(self._ui_dir)
        super().do_GET()

    def _json(self, obj: Dict[str, Any], status: int = 200) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:  # silence request spam
        print(f"[http] {self.address_string()} {fmt % args}")


def _replace(config: Config, **kw: Any) -> Config:
    import dataclasses

    return dataclasses.replace(config, **kw)


def _session_summary(path: Path) -> str:
    """First user task of a session file, as a readable label."""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "user_message":
                task = (data.get("content") or "").strip().replace("\n", " ")
                return task[:60]
    except OSError:
        pass
    return ""


def _walk(root: Path, prefix: str = "") -> list:
    """Build a simple file tree [{name, path, dir, children}]."""
    out = []
    try:
        entries = sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError:
        return out
    for e in entries:
        rel = str(e.relative_to(root))
        node: Dict[str, Any] = {"name": e.name, "path": rel, "dir": e.is_dir()}
        if e.is_dir():
            node["children"] = _walk(e)
        out.append(node)
    return out


class ClutchServer(ThreadingHTTPServer):
    pass


def build(
    config: Config,
    ui_dir: Path,
    sessions_dir: Path,
    broadcaster: Broadcaster,
    state: RunState,
) -> ClutchServer:
    srv = ClutchServer(("127.0.0.1", config.port), Handler)
    srv.broadcaster = broadcaster  # type: ignore[attr-defined]
    srv.config = config  # type: ignore[attr-defined]
    srv.state = state  # type: ignore[attr-defined]
    srv.ui_dir = ui_dir  # type: ignore[attr-defined]
    srv.sessions_dir = sessions_dir  # type: ignore[attr-defined]
    return srv


def main() -> int:
    parser = argparse.ArgumentParser(prog="clutch-server")
    parser.add_argument("--port", type=int, default=8890)
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument("--workdir", dest="workdir", default=None, help="default working directory (GUI can override per run)")
    parser.add_argument("--verify", default=None, help="verification command; empty disables the gate")
    parser.add_argument("--ui-dir", default=None, help="static frontend dir (default: ui/)")
    parser.add_argument("--sessions-dir", default=None, help="session JSONL dir (default: ./sessions)")
    args = parser.parse_args()

    config = Config()
    config.port = args.port
    config.model = args.model
    if args.workdir:
        config.workdir = args.workdir
    if args.verify:
        config.verify_command = args.verify

    base = Path(__file__).resolve().parent.parent
    ui_dir = Path(args.ui_dir) if args.ui_dir else base / "ui"
    sessions_dir = Path(args.sessions_dir) if args.sessions_dir else base / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    # default working directory outside the repo, so the agent cannot see clutch itself
    if not config.workdir:
        default_wd = Path.home() / "clutch-work"
        default_wd.mkdir(parents=True, exist_ok=True)
        config.workdir = str(default_wd)

    broadcaster = Broadcaster()
    state = RunState(sessions_dir)
    # restore the API key persisted by the GUI settings (outside the repo)
    state.api_key = load_settings().get("api_key")

    srv = build(config, ui_dir, sessions_dir, broadcaster, state)
    print(f"[clutch-server] http://127.0.0.1:{config.port}  (ui: {ui_dir})", flush=True)
    print(f"[clutch-server] workspace default: {config.workdir or '(temp)'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
