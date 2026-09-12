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
  - on Windows each session child is assigned to a kill-on-close Job
    (_job_assign): the stale reaper needs THIS process alive, so a supervisor
    that dies without reaping (crash, TerminateProcess, Electron's tree going
    down with it) would orphan the session — the Job makes the kernel kill the
    whole session tree the moment this process's Job handles die with it. An
    orphaned session is not cosmetic: it keeps holding its .clc write lock,
    and reopening that project then lands read-only with no visible other
    window.

Locking: each session child is an independent process, so the .clc write lock
is a kernel file lock (flock / LockFileEx) on the machine's tmp dir —
process-level mutual exclusion, released by the OS on exit, no TTL needed.
(noclobber+TTL remains only for
the execBridge-degraded path, where the agent process and the project files
live on different machines.)
"""

from __future__ import annotations

import argparse
import ctypes
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
SESSION_START_TIMEOUT_S = 30.0  # child port banner: onefile extraction is slow on a remote
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
    server down.

    Windows has no fcntl, so _make_stdout_nonblocking skips it there and a FULL
    pipe would block the printing thread forever (the same orphaned-supervisor
    hang, reached without an exception). When fcntl is unavailable the stream
    therefore decouples writes through a bounded queue drained by one daemon
    thread: write() enqueues (or drops, never blocks) and the drain thread
    absorbs however long the dead pipe stalls."""

    _QUEUE_MAX = 1000

    def __init__(self, inner, async_when_no_fcntl: bool | None = None) -> None:
        self._inner = inner
        self._queue: queue.Queue | None = None
        if inner is None:  # pythonw: no console streams at all; no-ops below
            return
        try:
            import fcntl  # noqa: F401
            has_fcntl = True
        except ImportError:
            has_fcntl = False
        if async_when_no_fcntl or (async_when_no_fcntl is None and not has_fcntl):
            self._queue = queue.Queue(maxsize=self._QUEUE_MAX)
            threading.Thread(target=self._drain, daemon=True, name="clutch-stdio-drain").start()

    def _drain(self) -> None:
        assert self._inner is not None and self._queue is not None
        while True:
            data = self._queue.get()
            try:
                self._inner.write(data)
                self._inner.flush()
            except Exception:  # noqa: BLE001 -- dead/full stream: drop the line
                pass

    def write(self, data):
        if self._queue is not None:  # async mode: never block, drop on overflow
            try:
                self._queue.put_nowait(data)
            except queue.Full:
                pass
            return len(data)
        if self._inner is None:
            return len(data)
        try:
            return self._inner.write(data)
        except (OSError, ValueError, TypeError, AttributeError):
            return len(data)

    def flush(self):
        if self._queue is not None or self._inner is None:
            return
        try:
            self._inner.flush()
        except (OSError, ValueError, AttributeError):
            pass


@dataclass
class Session:
    session_id: str
    proc: subprocess.Popen
    port: int
    last_beat: float = field(default_factory=time.time)
    # Windows: kill-on-close Job holding the whole session tree; its handle
    # dies with this supervisor, and so does the session (None = unavailable)
    job: int | None = None


def _signal_soft(proc: subprocess.Popen) -> None:
    """Ask a session child to stop: SIGTERM to its process group (POSIX), or
    CTRL_BREAK_EVENT on Windows (the child is spawned with
    CREATE_NEW_PROCESS_GROUP).

    Best effort, and on Windows normally unavailable: CTRL_BREAK reaches only a
    process group that shares OUR console, while a packaged supervisor is
    spawned by Electron with windowsHide and has no console at all — so this
    raises OSError(WinError 6) instead of delivering anything. Every OSError
    (that one, ProcessLookupError, PermissionError) is left to _kill_hard.
    """
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        else:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
    except OSError:
        return


def _kill_hard(proc: subprocess.Popen) -> None:
    """Stop of last resort, when the child ignored (or never got) the soft
    signal: SIGKILL to the group (POSIX), or taskkill /T on Windows.

    taskkill rather than proc.kill(): TerminateProcess reaps only the direct
    child, so the shell it ran commands in — and whatever that shell started —
    stays behind as an orphan holding its port. /T walks the tree.
    """
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass
        return
    try:
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
            capture_output=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()  # taskkill missing or denied: still drop the direct child
    except OSError:
        pass


# ---- Windows: a session child must not outlive this supervisor ----
#
# POSIX kills a session through its process group, and the group's reaper (this
# supervisor) sits in the UI's process tree, so a dead window means a dead
# reaper AND a dead group. Windows has no process group to lean on: a
# supervisor that dies without walking its children (crash, TerminateProcess,
# Electron's tree dying first) leaves the session child alive forever — an
# invisible zombie that still holds the .clc write lock, so every later open of
# that project lands read-only with no visible other window (observed in the
# wild: two leftover `python.exe` from a dev supervisor kept a project locked
# for good). The kernel answer is a Job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE:
# the session belongs to the Job, and when THIS process dies its handles close
# with it, so the kernel terminates the whole session tree — the venv/onefile
# launcher AND the real interpreter it spawned, plus anything they start. That
# also covers the kill path: TerminateProcess on a launcher reaps only the
# launcher, while the interpreter inside the Job dies with the Job's handle.

_JOB_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_EXTENDED_LIMIT_INFO = 9  # JobObjectExtendedLimitInformation
_JOB_BASIC_ACCOUNTING_INFO = 1  # JobObjectBasicAccountingInformation
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_TERMINATE = 0x0001
_TH32CS_SNAPPROCESS = 0x2
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _JobBasicLimits(ctypes.Structure):
    """JOBOBJECT_BASIC_LIMIT_INFORMATION (only LimitFlags is ever set)."""

    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _JobIoCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_ulonglong)
        for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    ]


class _JobLimits(ctypes.Structure):
    """JOBOBJECT_EXTENDED_LIMIT_INFORMATION."""

    _fields_ = [
        ("BasicLimitInformation", _JobBasicLimits),
        ("IoInfo", _JobIoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _ProcEntry(ctypes.Structure):
    """PROCESSENTRY32W (Toolhelp32 snapshot row: pid + parent pid)."""

    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ProcessID", ctypes.c_uint32),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", ctypes.c_uint32),
        ("cntThreads", ctypes.c_uint32),
        ("th32ParentProcessID", ctypes.c_uint32),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_uint32),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def _descendant_pids(pid: int) -> list[int]:
    """Live descendants of `pid`, nearest first (Toolhelp32 snapshot).

    Empty on any failure — the walk only widens the Job's net, so a
    missed snapshot must never fail a session start.
    """
    if os.name != "nt":
        return []
    try:
        k32 = ctypes.windll.kernel32
        k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        k32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        k32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcEntry)]
        k32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcEntry)]
        snap = k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        if not snap or snap == _INVALID_HANDLE_VALUE:
            return []
        pairs: list[tuple[int, int]] = []
        entry = _ProcEntry()
        entry.dwSize = ctypes.sizeof(entry)
        more = k32.Process32FirstW(snap, ctypes.byref(entry))
        while more:
            pairs.append((entry.th32ProcessID, entry.th32ParentProcessID))
            more = k32.Process32NextW(snap, ctypes.byref(entry))
        k32.CloseHandle(snap)
    except Exception:  # noqa: BLE001 - never fatal
        return []
    children: dict[int, list[int]] = {}
    for p, pp in pairs:
        children.setdefault(pp, []).append(p)
    out: list[int] = []
    frontier, seen = [pid], {pid}
    while frontier:
        nxt: list[int] = []
        for f in frontier:
            for c in children.get(f, ()):
                if c not in seen:
                    seen.add(c)
                    out.append(c)
                    nxt.append(c)
        frontier = nxt
    return out


def _job_assign(pid: int) -> int | None:
    """Put a fresh session child into a kill-on-close Job (Windows only).

    Returns the Job handle for _kill to close, or None when Jobs are
    unavailable — a Job is a safety net, never a requirement, so every
    failure degrades to the previous behavior.
    """
    if os.name != "nt":
        return None
    try:
        k32 = ctypes.windll.kernel32
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        k32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        k32.OpenProcess.restype = ctypes.c_void_p
        k32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32]
        k32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        k32.CloseHandle.argtypes = [ctypes.c_void_p]

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        limits = _JobLimits()
        limits.BasicLimitInformation.LimitFlags = _JOB_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
            job, _JOB_EXTENDED_LIMIT_INFO, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            k32.CloseHandle(job)
            return None
        proc = k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
        if not proc:
            k32.CloseHandle(job)
            return None
        ok = k32.AssignProcessToJobObject(job, proc)
        k32.CloseHandle(proc)
        if not ok:
            k32.CloseHandle(job)
            return None
        # Job membership is NOT retroactive: a fast launcher (the venv stub
        # CreateProcess'es its real interpreter the instant it starts) can
        # spawn its child BEFORE we get here, and that child inherits no Job
        # and escapes the kill-on-close net — precisely the orphan that kept
        # a .clc locked in the wild. Pull every already-live descendant in,
        # re-walking briefly for children born in the race window; a member's
        # own later children inherit the Job for free.
        for wait in (0.0, 0.05, 0.1):
            if wait:
                time.sleep(wait)
            for d in _descendant_pids(pid):
                h = k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, d)
                if h:
                    k32.AssignProcessToJobObject(job, h)  # same-job re-assign is a no-op
                    k32.CloseHandle(h)
        return job
    except Exception:  # noqa: BLE001 - never fatal
        return None


def _job_close(job: int | None) -> None:
    """Close the session's Job handle. With KILL_ON_JOB_CLOSE the kernel
    terminates every process still in the Job — the last line of defense when
    a kill missed a member (a launcher that died before its interpreter, a
    tree-walk that skipped a grandchild). Never raises."""
    if os.name != "nt" or not job:
        return
    try:
        ctypes.windll.kernel32.CloseHandle(job)
    except OSError:
        pass


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
        # set by POST /api/shutdown: exit as soon as no sessions remain
        self.exit_when_idle = False

    # ---- session lifecycle ----

    def start_session(self, base_url: str | None = None) -> Session | None:
        """Spawn one agent.server child on a random port, learning the port from
        its stdout banner. None when the child never prints it. base_url is
        forwarded as --base-url."""
        # refresh the idle timer before spawning (a slow child must not let the
        # reaper self-exit mid-start) and clear a pending shutdown flag
        with self._lock:
            self.last_activity = time.time()
            self.exit_when_idle = False
        try:
            env = dict(os.environ)
            cmd = [*self.agent_cmd, "--port", "0"]
            if base_url:
                cmd += ["--base-url", base_url]
            # POSIX: own process group -> group kill. Windows has no setsid/
            # killpg; a new process group lets CTRL_BREAK reach the child.
            spawn: dict = {"start_new_session": True} if os.name == "posix" else {}
            if os.name == "nt":
                spawn["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            proc = subprocess.Popen(
                cmd,
                cwd=self.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                **spawn,
            )
        except OSError as e:  # pragma: no cover - venv/bundle missing
            _log(f"[supervisor] spawn failed: {e}")
            return None
        # assign BEFORE anything else: the venv/onefile launcher spawns its real
        # interpreter within milliseconds, and that interpreter must be born
        # inside the Job (membership is inherited from the launcher)
        job = _job_assign(proc.pid)
        port = self._wait_port(proc)
        if port is None:
            _log("[supervisor] session child never printed its port")
            self._kill(proc, job)
            return None
        sess = Session(session_id=uuid.uuid4().hex[:12], proc=proc, port=port, job=job)
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
        self._kill(sess.proc, sess.job)
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
        # an unhandled exception here would strand the supervisor and leak
        # session children; log and keep going
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
        """Read the child's stdout until the port banner appears, forwarding
        lines to our stdout so the pipe never fills. Banner detection is
        decoupled from forwarding so a blocked stdout can't delay the banner."""
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
    def _kill(proc: subprocess.Popen, job: int | None = None) -> None:
        """Best effort stop of one session child. Never raises.

        A failed kill must not escape into the caller: /api/session/stop has
        already unregistered the session by then, so an exception answered
        nothing AND leaked the child (the reaper could only bury it in a log
        line). Losing the graceful signal is survivable — _kill_hard reaps the
        tree — losing the stop is not.

        ``job`` (Windows) is the session's kill-on-close Job: closing its
        handle below is the last line of defense that terminates anything the
        attempts above missed — e.g. a venv/onefile launcher killed while its
        real interpreter lived on (proc.kill() reaps only the launcher).
        """
        try:
            if proc.poll() is not None:
                return  # already exited; only the Job cleanup below remains
            _signal_soft(proc)
            try:
                proc.wait(timeout=KILL_GRACE_S)
                return
            except subprocess.TimeoutExpired:
                pass
            except OSError:  # pragma: no cover - child vanished while waiting
                return
            _kill_hard(proc)
            try:
                proc.wait(timeout=KILL_GRACE_S)  # reap, and let the port go
            except (subprocess.TimeoutExpired, OSError):
                pass
        finally:
            _job_close(job)


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
            # normal close: exit once no sessions remain; arm the flag only
            # when nothing is running (a sticky flag could kill a re-claim)
            with sup._lock:
                if not sup.sessions:
                    sup.exit_when_idle = True
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
    # a dead/full stdout must never hang logging or the session-start handler
    _make_stdout_nonblocking()
    srv = build_server(args.port, sup)
    bound_port = srv.server_address[1]
    _log(f"[clutch-supervisor] http://127.0.0.1:{bound_port}  (session lifecycle API)")

    def _on_term(_signum, _frame):
        _log("[supervisor] SIGTERM, shutting sessions down")
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
