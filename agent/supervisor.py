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
  - on Windows each session child is assigned to a kill-on-close Job by the
    generic layer (agent.procmgr.kill): a supervisor that dies without reaping
    (crash, TerminateProcess, Electron's tree going down with it) would orphan
    the session — the Job makes the kernel kill the whole session tree the
    moment this process's Job handles die with it. An orphaned session is not
    cosmetic: it keeps holding its .clc write lock, and reopening that project
    then lands read-only with no visible other window.

Locking: each session child is an independent process, so the .clc write lock
is a kernel file lock (flock / LockFileEx) on the machine's tmp dir —
process-level mutual exclusion, released by the OS on exit, no TTL needed.
(noclobber+TTL remains only for
the execBridge-degraded path, where the agent process and the project files
live on different machines.)

Layering: the spawn/port/reap/kill/stdio machinery lives in agent/procmgr —
the general Clutch process-management layer, built to manage every resident
process (workspace daemons next). This module is the session specialization:
the heartbeat contract with UI windows, the agent-server child command, the
fail-fast refusal to run an unkillable session, and the HTTP lifecycle API.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent.procmgr import kill
from agent.procmgr.stdio import SafeStdStream, log, make_stdout_nonblocking
from agent.procmgr.supervise import (
    IDLE_TIMEOUT_S,
    REAP_INTERVAL_S,
    STALE_S,
    ManagedProcess,
    ProcessSupervisor,
    SpawnSpec,
)

DEFAULT_PORT = 8890
PORT_BANNER_RE = re.compile(r"\[clutch-server\] http://127\.0\.0\.1:(\d+)")
SESSION_START_TIMEOUT_S = 30.0  # child port banner: onefile extraction is slow on a remote

# session-specific names for the generic layer's timers (kept for greppability:
# the UI's heartbeat budget is defined against SESSION_STALE_S)
SESSION_STALE_S = STALE_S

# compat re-export: the dead-parent resilience test constructs this directly
_SafeStdStream = SafeStdStream


class Session(ManagedProcess):
    """A session record: the generic child plus the session-facing names the
    HTTP API and the tests use (session_id, job)."""

    @property
    def session_id(self) -> str:
        return self.key

    @property
    def job(self) -> int | None:
        return self.guarantee

    @job.setter
    def job(self, value: int | None) -> None:
        self.guarantee = value


class SessionSupervisor(ProcessSupervisor):
    """Owns session children. No session logic itself — just spawn, route the
    port back, and reap. Thread-safe: the processes dict is guarded by a lock
    (aliased below as ``sessions``)."""

    # compat alias: the kill-ladder test calls Supervisor._kill(proc) directly
    _kill = staticmethod(kill.stop_process)

    def __init__(
        self,
        agent_cmd: list[str],
        cwd: str | None = None,
        stale_s: float = SESSION_STALE_S,
        idle_timeout_s: float = IDLE_TIMEOUT_S,
        reap_interval_s: float = REAP_INTERVAL_S,
        start_timeout_s: float = SESSION_START_TIMEOUT_S,
    ) -> None:
        super().__init__(
            stale_s=stale_s,
            idle_timeout_s=idle_timeout_s,
            reap_interval_s=reap_interval_s,
            # None = platform default: on Windows an unkillable session is
            # refused (start_session below never runs an orphan-in-waiting)
            require_kill_guarantee=None,
            label="supervisor",
        )
        self.agent_cmd = list(agent_cmd)
        self.cwd = cwd
        self.start_timeout_s = start_timeout_s
        self.sessions = self.processes  # same dict, session-named for callers

    # ---- session lifecycle ----

    def start_session(self, base_url: str | None = None) -> Session | None:
        """Spawn one agent.server child on a random port, learning the port from
        its stdout banner. None when the child never prints it. base_url is
        forwarded as --base-url."""
        cmd = [*self.agent_cmd, "--port", "0"]
        if base_url:
            cmd += ["--base-url", base_url]
        spec = SpawnSpec(
            cmd=cmd,
            cwd=self.cwd,
            banner_re=PORT_BANNER_RE,
            start_timeout_s=self.start_timeout_s,
        )
        record = self.spawn(uuid.uuid4().hex[:12], spec, beat_required=True)
        if record is None:
            return None
        log(f"[supervisor] session {record.key} on port {record.port}")
        return record  # a Session: _make_record builds the session shape

    def stop_session(self, session_id: str | None) -> bool:
        ok = self.stop(session_id)
        if ok:
            log(f"[supervisor] session {session_id} stopped")
        return ok

    def heartbeat(self, session_id: str | None) -> bool:
        return self.beat(session_id)

    # ---- hooks ----

    def _make_record(self, key, proc, port, guarantee, beat_required) -> Session:
        return Session(
            key=key,
            proc=proc,
            port=port,
            guarantee=guarantee,
            last_beat=time.time(),
            beat_required=beat_required,
        )

    def _log_stale(self, key: str) -> None:
        log(f"[supervisor] reaping stale session {key}")


# legacy name: tests, entry scripts and older docs all say Supervisor
Supervisor = SessionSupervisor


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
            # normal close: exit once no sessions remain (arm-only-when-empty
            # lives in the generic layer: a sticky flag could kill a re-claim)
            sup.request_idle_exit()
            self._json({"status": "ok"})
        else:
            self._json({"error": "not found"}, 404)


def _agent_cmd_default() -> list[str]:
    """Dev: run agent.server with this interpreter. PyInstaller onefile: launch
    the agent-server binary next to the supervisor."""
    if getattr(sys, "frozen", False):
        # Windows bundles carry the .exe suffix
        exe = "agent-server.exe" if os.name == "nt" else "agent-server"
        return [os.path.join(os.path.dirname(sys.executable), exe)]
    return [sys.executable, "-m", "agent.server"]


def build_server(port: int, sup: Supervisor) -> ThreadingHTTPServer:
    handler = type("ClutchSupervisorHandler", (_Handler,), {"supervisor": sup})
    try:
        return ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError as e:
        # an occupied port kills silently; say exactly what happened
        raise SystemExit(
            f"[clutch-supervisor] ERROR: cannot bind 127.0.0.1:{port} — port in use "
            f"({e}). Close the other Clutch/agent server on this port and retry."
        ) from e


def main() -> int:
    # wrap before the first print: a dead stdout must not crash startup
    sys.stdout = SafeStdStream(sys.stdout)
    sys.stderr = SafeStdStream(sys.stderr)

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
    # a dead/full stdout must never hang logging or the session-start handler
    make_stdout_nonblocking()
    srv = build_server(args.port, sup)
    bound_port = srv.server_address[1]
    log(f"[clutch-supervisor] http://127.0.0.1:{bound_port}  (session lifecycle API)")

    def _on_term(_signum, _frame):
        log("[supervisor] SIGTERM, shutting sessions down")
        sup.shutdown_all()
        sup.exit_event.set()
        sys.exit(0)

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _on_term)

    threading.Thread(target=sup.reap_loop, daemon=True).start()

    def _exit_watch() -> None:
        # stop the HTTP server too, or serve_forever keeps the process alive
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
