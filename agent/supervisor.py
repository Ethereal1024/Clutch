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
SESSION_START_TIMEOUT_S = 30.0  # wait for the child's port banner (onefile extraction on a slow remote can take a while)
SESSION_STALE_S = 10.0  # no heartbeat for this long -> reap the session (heartbeat interval is 8s)
REAP_INTERVAL_S = 2.0
IDLE_TIMEOUT_S = 8.0  # no sessions for this long -> self-exit
KILL_GRACE_S = 3.0


def _log(msg: str) -> None:
    """Log to stdout without EVER blocking or crashing the caller.

    When the process that spawned us dies, our stdout is a dead socket; once its
    buffer fills, a plain ``print`` blocks forever (the handler thread stuck in
    the post-session ``print`` is exactly the orphaned-supervisor "Empty reply"
    hang). _make_stdout_nonblocking marks the fd non-blocking so the write
    raises BlockingIOError instead of blocking; we swallow it and drop the line.
    """
    try:
        print(msg, flush=True)
    except (OSError, ValueError):  # dead/full stdout: drop the log line
        pass


def _make_stdout_nonblocking() -> None:
    """Turn a full write to stdout/stderr from a BLOCK into an exception, so the
    supervisor's own logging (and the _wait_port forwarder) can never hang."""
    try:
        import fcntl
    except ImportError:
        return
    for fd in (1, 2):
        try:
            flags = fcntl.fcntl(fd, fcntl.F_GETFL)
            fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        except OSError:
            pass


class _SafeStdStream:
    """stdout/stderr that keeps serving when the parent is gone. The supervisor
    is often spawned by Electron and orphaned (re-parented to init/systemd) with
    its stdio socketpair dangling; a print to that dead socket then raises
    BrokenPipeError, which previously killed the request handler mid-response
    AND the reaper loop (both die on their first print) — the port stays
    squatted forever, leaking session children and blocking every later
    session/start. Swallow stream errors so a dead parent can never take the
    server down."""

    def __init__(self, inner):
        self._inner = inner

    def write(self, data):
        try:
            return self._inner.write(data)
        except (OSError, ValueError, TypeError):
            return len(data)

    def flush(self):
        try:
            self._inner.flush()
        except (OSError, ValueError):
            pass


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
        # set by POST /api/shutdown (normal app close): once no sessions remain,
        # exit immediately instead of waiting out the idle grace — a deliberately
        # closed supervisor must never linger as an orphan
        self.exit_when_idle = False

    # ---- session lifecycle ----

    def start_session(self, base_url: str | None = None) -> Session | None:
        """Spawn one agent.server child on a random port and learn the port
        from its stdout banner. None when the child never prints it.

        base_url (e.g. the remote LLM reverse-proxy) is forwarded to the child
        as --base-url; the local supervisor omits it and the session uses the
        environment's CLUTCH_API_KEY instead."""
        # refresh the idle timer BEFORE spawning: the session is only registered
        # once the child prints its port (up to start_timeout_s), and a slow
        # child (e.g. a PyInstaller onefile extracting on the remote) must not
        # let the idle reaper self-exit mid-start
        with self._lock:
            self.last_activity = time.time()
        try:
            env = dict(os.environ)
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
            _log(f"[supervisor] spawn failed: {e}")
            return None
        port = self._wait_port(proc)
        if port is None:
            _log("[supervisor] session child never printed its port")
            self._kill(proc)
            return None
        sess = Session(session_id=uuid.uuid4().hex[:12], proc=proc, port=port)
        with self._lock:
            self.sessions[sess.session_id] = sess
            self.last_activity = time.time()
        _log(f"[supervisor] session {sess.session_id} on port {port}")
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
        _log(f"[supervisor] session {session_id} stopped")
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
        # The reaper is the supervisor's only self-governance (stale-session
        # reap + idle self-exit): one unhandled exception killing this thread
        # would leave the supervisor squatted on its port forever, leaking
        # session children. Never let that happen — log and keep going.
        while not self.exit_event.is_set():
            try:
                now = time.time()
                stale: list[str] = []
                with self._lock:
                    for sid, sess in list(self.sessions.items()):
                        if now - sess.last_beat > self.stale_s:
                            stale.append(sid)
                    n = len(self.sessions)
                    exit_when_idle = self.exit_when_idle
                for sid in stale:
                    _log(f"[supervisor] reaping stale session {sid}")
                    self.stop_session(sid)
                if n == 0 and (exit_when_idle or now - self.last_activity > self.idle_timeout_s):
                    _log("[supervisor] idle, exiting")
                    self.exit_event.set()
                    break
            except Exception as e:  # noqa: BLE001 - a broken pass must not kill the reaper
                _log(f"[supervisor] reap_loop error: {e}")
            self.exit_event.wait(self.reap_interval_s)

    # ---- internals ----

    def _wait_port(self, proc: subprocess.Popen) -> int | None:
        """Read the child's stdout until the port banner appears (then keep
        forwarding everything to our stdout so the pipe never fills).

        Banner detection is DECOUPLED from the stdout forward: a reader thread
        drains the child's pipe and queues every line, a separate forwarder
        writes them to our stdout best-effort. The old single-thread design
        blocked on ``sys.stdout.write`` (e.g. when the supervisor is orphaned
        and its stdout is a dead socket) BEFORE reaching the banner line, so
        session/start hung and the child was killed on a false timeout."""
        q: "queue.Queue[int]" = queue.Queue()
        sink: "queue.Queue[str]" = queue.Queue()

        def reader() -> None:
            try:
                for raw in proc.stdout:
                    line = raw.decode("utf-8", "replace")
                    m = PORT_BANNER_RE.search(line)
                    if m:
                        q.put(int(m.group(1)))
                    sink.put(line)
            except Exception:  # noqa: BLE001 - pipe closed, child gone
                pass

        def forwarder() -> None:
            while True:
                try:
                    line = sink.get()
                except Exception:  # noqa: BLE001
                    return
                try:
                    sys.stdout.write(line)
                    sys.stdout.flush()
                except (OSError, ValueError):  # stdout gone: stop forwarding
                    return

        threading.Thread(target=reader, daemon=True).start()
        threading.Thread(target=forwarder, daemon=True).start()
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
        elif self.path == "/api/shutdown":
            # normal client close: exit as soon as no sessions remain (skips the
            # idle grace). Never kills an in-use supervisor (n must be 0 first).
            with sup._lock:
                sup.exit_when_idle = True
            self._json({"status": "ok"})
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
    try:
        return ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError as e:
        # an occupied port is the classic silent killer: the supervisor dies and
        # the caller only sees "backend not reachable". Say exactly what happened
        # (and, for the remote, /tmp/clutch-server.log carries this line).
        raise SystemExit(
            f"[clutch-supervisor] ERROR: cannot bind 127.0.0.1:{port} — port in use "
            f"({e}). Close the other Clutch/agent server on this port and retry."
        ) from e


def main() -> int:
    # wrap before the first print: an orphaned supervisor writes to a dead
    # socketpair (see _SafeStdStream) — a startup print must not crash it either
    sys.stdout = _SafeStdStream(sys.stdout)
    sys.stderr = _SafeStdStream(sys.stderr)

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
    # a dead/full stdout (orphaned supervisor) must never hang our logging or the
    # session-start handler (see _log/_make_stdout_nonblocking)
    _make_stdout_nonblocking()
    srv = build_server(args.port, sup)
    bound_port = srv.server_address[1]
    _log(f"[clutch-supervisor] http://127.0.0.1:{bound_port}  (session lifecycle API)")

    def _on_term(signum, frame):  # noqa: ARG001
        _log("[supervisor] SIGTERM, shutting sessions down")
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
