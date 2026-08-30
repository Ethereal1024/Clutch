"""Per-machine supervisor: spawns and manages session subprocesses.

Every UI window is a SESSION: the supervisor spawns one agent.server child
(--port 0, random port parsed from its stdout banner) per session and reports
the port back. The window then talks to its child DIRECTLY (locally, or over
its own tunnel forward) — the supervisor never proxies traffic, it only owns
the lifecycle:

    POST /api/session/start      -> {session_id, port}
    POST /api/session/stop       -> kill the session child
    POST /api/session/heartbeat  -> keep the session alive (stale ones die)
    GET  /api/health             -> ok

Lifecycle (per product decision):
  - the FIRST window starts the supervisor (Electron probes /api/health and
    spawns it when down); the LAST window's exit ends it — each window stops
    its session on close, and the supervisor self-exits after an idle grace
    once no sessions remain. A stale-session reaper also clears sessions whose
    window crashed (heartbeat stops).

Locking: each session child is an independent process, so the .clc write lock
is plain flock on the machine's tmp dir — process-level mutual exclusion,
freed by the kernel on exit, no TTL needed. (noclobber+TTL remains only for
the execBridge-degraded path, where the agent process and the project files
live on different machines.)
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8890
PORT_BANNER_RE = re.compile(r"\[clutch-server\] http://127\.0\.0\.1:(\d+)")
SESSION_START_TIMEOUT_S = 20.0  # wait for the child's port banner
SESSION_STALE_S = 30.0  # no heartbeat for this long -> reap the session
REAP_INTERVAL_S = 2.0
IDLE_TIMEOUT_S = 8.0  # no sessions for this long -> self-exit
KILL_GRACE_S = 3.0


@dataclass
class Session:
    session_id: str
    proc: subprocess.Popen
    port: int
    last_beat: float = field(default_factory=time.time)


class Supervisor:
    """Owns session children. No session logic itself — just spawn, route the
    port back, and reap. Thread-safe: sessions dict guarded by a lock."""

    def __init__(
        self,
        agent_cmd: list[str],
        cwd: str | None = None,
        stale_s: float = SESSION_STALE_S,
        idle_timeout_s: float = IDLE_TIMEOUT_S,
        reap_interval_s: float = REAP_INTERVAL_S,
        start_timeout_s: float = SESSION_START_TIMEOUT_S,
    ) -> None:
        self.agent_cmd = list(agent_cmd)
        self.cwd = cwd
        self.stale_s = stale_s
        self.idle_timeout_s = idle_timeout_s
        self.reap_interval_s = reap_interval_s
        self.start_timeout_s = start_timeout_s
        self.sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self.last_activity = time.time()  # last moment a session existed
        self.exit_event = threading.Event()

    # ---- session lifecycle ----

    def start_session(self, base_url: str | None = None) -> Session | None:
        """Spawn one agent.server child on a random port and learn the port
        from its stdout banner. None when the child never prints it.

        base_url (e.g. the remote LLM reverse-proxy) is forwarded to the child
        as --base-url; the local supervisor omits it and the session uses the
        environment's CLUTCH_API_KEY instead."""
        try:
            env = dict(os.environ)
            env["CLUTCH_SUPERVISOR_PID"] = str(os.getpid())
            cmd = [*self.agent_cmd, "--port", "0"]
            if base_url:
                cmd += ["--base-url", base_url]
            proc = subprocess.Popen(
                cmd,
                cwd=self.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # own process group -> group kill
                env=env,
            )
        except OSError as e:  # pragma: no cover - venv/bundle missing
            print(f"[supervisor] spawn failed: {e}", flush=True)
            return None
        port = self._wait_port(proc)
        if port is None:
            print("[supervisor] session child never printed its port", flush=True)
            self._kill(proc)
            return None
        sess = Session(session_id=uuid.uuid4().hex[:12], proc=proc, port=port)
        with self._lock:
            self.sessions[sess.session_id] = sess
            self.last_activity = time.time()
        print(f"[supervisor] session {sess.session_id} on port {port}", flush=True)
        return sess

    def stop_session(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        with self._lock:
            sess = self.sessions.pop(session_id, None)
            self.last_activity = time.time()
        if sess is None:
            return False
        self._kill(sess.proc)
        print(f"[supervisor] session {session_id} stopped", flush=True)
        return True

    def heartbeat(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        with self._lock:
            sess = self.sessions.get(session_id)
            if sess is None:
                return False
            sess.last_beat = time.time()
        return True

    def shutdown_all(self) -> None:
        """Best effort: kill every session child (idle exit / SIGTERM)."""
        with self._lock:
            sids = list(self.sessions.keys())
        for sid in sids:
            self.stop_session(sid)

    # ---- reaper: stale sessions + idle self-exit ----

    def reap_loop(self) -> None:
        while not self.exit_event.is_set():
            now = time.time()
            stale: list[str] = []
            with self._lock:
                for sid, sess in list(self.sessions.items()):
                    if now - sess.last_beat > self.stale_s:
                        stale.append(sid)
                n = len(self.sessions)
            for sid in stale:
                print(f"[supervisor] reaping stale session {sid}", flush=True)
                self.stop_session(sid)
            if n == 0 and now - self.last_activity > self.idle_timeout_s:
                print("[supervisor] idle, exiting", flush=True)
                self.exit_event.set()
                break
            self.exit_event.wait(self.reap_interval_s)

    # ---- internals ----

    def _wait_port(self, proc: subprocess.Popen) -> int | None:
        """Read the child's stdout until the port banner appears (then keep
        forwarding everything to our stdout so the pipe never fills)."""
        q: "queue.Queue[int]" = queue.Queue()

        def forward() -> None:
            try:
                for raw in proc.stdout:
                    line = raw.decode("utf-8", "replace")
                    m = PORT_BANNER_RE.search(line)
                    if m:
                        q.put(int(m.group(1)))
                    sys.stdout.write(line)
                    sys.stdout.flush()
            except Exception:  # noqa: BLE001 - pipe closed, child gone
                pass

        threading.Thread(target=forward, daemon=True).start()
        try:
            return q.get(timeout=self.start_timeout_s)
        except queue.Empty:
            return None

    @staticmethod
    def _kill(proc: subprocess.Popen) -> None:
        if proc.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                return
        try:
            proc.wait(timeout=KILL_GRACE_S)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


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
        except (ValueError, json.JSONDecodeError):
            return {}

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self._json({"status": "ok"})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        sup = self.supervisor
        if self.path == "/api/session/start":
            body = self._read_body()
            sess = sup.start_session(base_url=body.get("base_url") or None)
            if sess is None:
                self._json({"error": "session start failed"}, 500)
            else:
                self._json({"session_id": sess.session_id, "port": sess.port})
        elif self.path == "/api/session/stop":
            sid = self._read_body().get("session_id")
            ok = sup.stop_session(sid)
            self._json({"status": "ok" if ok else "unknown"}, 200 if ok else 404)
        elif self.path == "/api/session/heartbeat":
            sid = self._read_body().get("session_id")
            ok = sup.heartbeat(sid)
            self._json({"status": "ok" if ok else "unknown"}, 200 if ok else 404)
        else:
            self._json({"error": "not found"}, 404)


def _agent_cmd_default() -> list[str]:
    """Default command to spawn session children.

    Dev: the same interpreter that runs the supervisor, launching agent.server
    from the repo root (agent package importable).

    PyInstaller onefile (sys.frozen): the supervisor binary lives in the app's
    extraResources directory (Electron's resourcesPath), and the agent-server
    binary sits next to it — launch it directly. `sys.executable` is the
    extracted onefile runtime, so `-m agent.server` would find no module.
    """
    if getattr(sys, "frozen", False):
        return [os.path.join(os.path.dirname(sys.executable), "agent-server")]
    return [sys.executable, "-m", "agent.server"]


def build_server(port: int, sup: Supervisor) -> ThreadingHTTPServer:
    handler = type("ClutchSupervisorHandler", (_Handler,), {"supervisor": sup})
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main() -> int:
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
    srv = build_server(args.port, sup)
    bound_port = srv.server_address[1]
    print(f"[clutch-supervisor] http://127.0.0.1:{bound_port}  (session lifecycle API)", flush=True)

    def _on_term(signum, frame):  # noqa: ARG001
        print("[supervisor] SIGTERM, shutting sessions down", flush=True)
        sup.shutdown_all()
        sup.exit_event.set()
        sys.exit(0)

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _on_term)

    threading.Thread(target=sup.reap_loop, daemon=True).start()

    def _exit_watch() -> None:
        # idle/stale lifecycle ends the reaper loop; stop the HTTP server too,
        # otherwise serve_forever keeps the process alive forever
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
