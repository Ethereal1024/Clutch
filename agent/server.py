"""HTTP + SSE server that hosts the agent as a product.

Endpoints (all JSON except static/SSE):
  POST /api/run        {task, verify?, game?, scenario?} -> start run (409 if busy)
  POST /api/stop       cancel the running agent
  GET  /api/events     SSE: replay current session history, then live events
  GET  /api/scenarios  built-in demo scenarios (name, task, verify)
  GET  /api/sandbox/tree   file tree under the sandbox root
  GET  /api/sandbox/file?path=  file content (sandbox-constrained)
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
import shutil
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse, unquote

from .config import Config
from .core.terminate import Terminator
from .events import Event, EventLog, event_from_dict, event_to_json
from .llm.client import LlmClient
from .loop import Agent
from .tools.registry import ToolRegistry, build_default_tools
from .tools.sandbox import Sandbox


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
    """Holds the live agent + cancel flag for the single active run."""

    def __init__(self, sessions_dir: Path) -> None:
        self.lock = threading.Lock()
        self.agent: Optional[Agent] = None
        self.task: str = ""
        self.busy = False
        self.cancel: Optional[threading.Event] = None
        self.log = EventLog()
        self.sandbox: Optional[Sandbox] = None
        self._sessions_dir = sessions_dir
        self.api_key: Optional[str] = None

    def start(self, task: str, sandbox: Sandbox, cancel: threading.Event) -> bool:
        with self.lock:
            if self.busy:
                return False
            self.busy = True
            self.task = task
            self.cancel = cancel
            self.sandbox = sandbox
            # persist each run to a timestamped session file for replay
            import time

            name = time.strftime("session-%Y%m%d-%H%M%S")
            self.log = EventLog(path=str(self._sessions_dir / f"{name}.jsonl"))
        return True

    def finish(self) -> None:
        # keep the last sandbox + log for inspection after the run completes;
        # only release the busy flag so a new run can start
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

    @property
    def _scenarios_dir(self) -> Path:
        return self.server.scenarios_dir  # type: ignore[attr-defined]

    # ---- routing ----
    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/api/health":
                self._json({"ok": True})
            elif path == "/api/events":
                self._sse()
            elif path == "/api/sandbox/tree":
                self._sandbox_tree()
            elif path == "/api/sandbox/file":
                self._sandbox_file(parsed.query)
            elif path == "/api/sessions":
                self._sessions()
            elif path == "/api/sessions/replay":
                self._session_replay(parsed.query)
            elif path == "/api/scenarios":
                self._scenarios()
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
        scenario = body.get("scenario")
        task = (body.get("task") or "").strip()
        config = self._cfg
        if body.get("verify"):
            config = _replace(config, verify_command=body["verify"])
        if body.get("game"):
            config = _replace(config, game_file=body["game"])
        sandbox = Sandbox(config.sandbox_dir)

        # scenario preset: load task + verify from scenarios/<name>/, seed the sandbox
        if scenario:
            sdir = self._scenarios_dir / scenario
            task_file = sdir / "task.md"
            verify_file = sdir / "verify.sh"
            if task_file.exists():
                task = task_file.read_text(encoding="utf-8").strip()
            seed = sdir / "seed"
            if sdir.exists() and seed.exists():
                shutil.copytree(seed, sandbox.root, dirs_exist_ok=True)
            if verify_file.exists():
                verify_cmd = verify_file.read_text(encoding="utf-8").strip().splitlines()[0]
                config = _replace(config, verify_command=verify_cmd)

        if not task:
            return self._json({"error": "task is required"}, status=400)

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

        # start() claims the slot and creates the persisted session log FIRST,
        # so the agent writes into a file-backed log we can replay later.
        if not self._state.start(task, sandbox, cancel):
            return self._json({"error": "a run is already active"}, status=409)
        log = self._state.log

        agent = Agent(
            llm=llm,
            registry=ToolRegistry(build_default_tools(config)),
            sandbox=sandbox,
            config=config,
            log=log,
            sink=self._broadcaster.publish,
            cancel=cancel,
        )

        def _worker() -> None:
            try:
                agent.run(task)
            finally:
                self._state.finish()

        threading.Thread(target=_worker, daemon=True).start()
        self._json({"status": "started", "sandbox": str(sandbox.root)})

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

    def _sandbox_tree(self) -> None:
        sb = self._state.sandbox
        if sb is None:
            return self._json({"tree": [], "root": None})
        self._json({"tree": _walk(sb.root), "root": str(sb.root)})

    def _sandbox_file(self, query: str) -> None:
        sb = self._state.sandbox
        if sb is None:
            return self._json({"error": "no active sandbox"}, status=400)
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

    def _sessions(self) -> None:
        items = []
        for f in sorted(self._sessions_dir.glob("*.jsonl")):
            items.append({"name": f.stem, "path": str(f), "size": f.stat().st_size})
        self._json({"sessions": items})

    def _scenarios(self) -> None:
        items = []
        for d in sorted(self._scenarios_dir.iterdir()):
            task_file = d / "task.md"
            verify_file = d / "verify.sh"
            if not (task_file.exists() and verify_file.exists()):
                continue
            items.append({
                "name": d.name,
                "label": d.name.replace("_", " "),
                "task": task_file.read_text(encoding="utf-8").strip(),
                "verify": verify_file.read_text(encoding="utf-8").strip().splitlines()[0],
            })
        self._json({"scenarios": items})

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
    scenarios_dir: Optional[Path] = None,
) -> ClutchServer:
    srv = ClutchServer(("127.0.0.1", config.port), Handler)
    srv.broadcaster = broadcaster  # type: ignore[attr-defined]
    srv.config = config  # type: ignore[attr-defined]
    srv.state = state  # type: ignore[attr-defined]
    srv.ui_dir = ui_dir  # type: ignore[attr-defined]
    srv.sessions_dir = sessions_dir  # type: ignore[attr-defined]
    srv.scenarios_dir = scenarios_dir or (Path(__file__).resolve().parent.parent / "scenarios")  # type: ignore[attr-defined]
    return srv


def main() -> int:
    parser = argparse.ArgumentParser(prog="clutch-server")
    parser.add_argument("--port", type=int, default=8890)
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument("--sandbox", default=None, help="default sandbox dir")
    parser.add_argument("--verify", default=None)
    parser.add_argument("--game", default=None)
    parser.add_argument("--ui-dir", default=None, help="static frontend dir (default: ui/)")
    parser.add_argument("--sessions-dir", default=None, help="session JSONL dir (default: ./sessions)")
    args = parser.parse_args()

    config = Config()
    config.port = args.port
    config.model = args.model
    if args.sandbox:
        config.sandbox_dir = args.sandbox
    if args.verify:
        config.verify_command = args.verify
    if args.game:
        config.game_file = args.game

    base = Path(__file__).resolve().parent.parent
    ui_dir = Path(args.ui_dir) if args.ui_dir else base / "ui"
    sessions_dir = Path(args.sessions_dir) if args.sessions_dir else base / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    # persistent default sandbox so artifacts survive across runs (and are inspectable)
    if not config.sandbox_dir:
        default_sb = base / "sandbox"
        default_sb.mkdir(parents=True, exist_ok=True)
        config.sandbox_dir = str(default_sb)

    broadcaster = Broadcaster()
    state = RunState(sessions_dir)
    # restore the API key persisted by the GUI settings (outside the repo)
    state.api_key = load_settings().get("api_key")

    srv = build(config, ui_dir, sessions_dir, broadcaster, state)
    print(f"[clutch-server] http://127.0.0.1:{config.port}  (ui: {ui_dir})", flush=True)
    print(f"[clutch-server] sandbox default: {config.sandbox_dir or '(temp)'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
