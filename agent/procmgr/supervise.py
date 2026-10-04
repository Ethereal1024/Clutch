"""Generic supervised-child machinery: spawn, port discovery, stop, reaping.

This is the layer every long-lived Clutch process manager builds on — the
session supervisor (agent/supervisor.py) today, the workspace daemon and other
residents later. It owns, thread-safely:

- spawn: child process on a random port (banner discovered from stdout), with
  the Windows kill-on-close Job assigned BEFORE the banner wait, and a
  fail-fast refusal when the kill guarantee is required but unavailable
- stop: the soft→hard→Job-close ladder (agent.procmgr.kill)
- beat: optional heartbeat liveness, enforced by the reaper only for records
  that declare ``beat_required``
- reap_loop: stale-child reaping + idle self-exit; never raises (a broken pass
  must not kill the reaper — that would leak every remaining child)
- stale rule: ``_stale(record, now)`` — the one question the reaper asks per
  record. The base answer is the heartbeat contract; a tenant overrides it to
  let the child's own evidence overrule a silent window (agent/supervisor.py
  asks ``/api/health`` before reaping a session with a run in flight).

It deliberately knows nothing about sessions: the caller supplies identity
keys, the child command, and the policy knobs (heartbeat on/off, kill
guarantee required/optional).
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass

from agent.procmgr import kill
from agent.procmgr.stdio import log

# No heartbeat for this long -> reap the session. The window has to cover the
# case the field reports kept naming: a phone (or a laptop lid) that went away
# with a run still in flight. At 10s the host reaped the session before the
# client could come back, so the window that returned had nothing to re-bind to
# and the run was simply gone. 300s is the room a backgrounded app needs, and it
# is NOT the same question as "is the ssh hop alive" (ui/tunnel-connect.js declares
# a hop dead in ~45s): a session is a process on this host that outlives every hop
# to it, and a hop that died is a claim to re-bind (ui/host-core.js
# rebindTunnelBackend), not a reason to reap what nothing asked to stop.
# ui/supervisor-client.js HEARTBEAT_STALE_MS mirrors this value: a client that
# gave up sooner would be declaring the session gone while the host still holds it.
STALE_S = 300.0
REAP_INTERVAL_S = 2.0
IDLE_TIMEOUT_S = 8.0  # no children for this long -> self-exit


@dataclass
class SpawnSpec:
    """How to spawn one managed child."""

    cmd: list[str]
    cwd: str | None = None
    # port discovery: the child prints a banner on stdout; None = don't wait
    # for any banner (the child's port is learned out of band)
    banner_re: re.Pattern | None = None
    start_timeout_s: float = 30.0  # onefile extraction is slow on a remote


@dataclass
class ManagedProcess:
    """One supervised child. ``key`` is the caller's identity for it (a
    session id, a workspace hash, ...). ``guarantee`` is the Windows
    kill-on-close Job holding the whole child tree; its handle dies with this
    supervisor, and so does the child (None = unavailable, e.g. POSIX)."""

    key: str
    proc: subprocess.Popen
    port: int | None
    guarantee: int | None
    last_beat: float
    beat_required: bool  # False: the reaper never reaps this one by staleness


def wait_port(proc: subprocess.Popen, banner_re: re.Pattern, timeout_s: float) -> int | None:
    """Read the child's stdout until the port banner appears, forwarding lines
    to our stdout so the pipe never fills. Banner detection is decoupled from
    forwarding so a blocked stdout can't delay the banner."""
    q: "queue.Queue[int]" = queue.Queue()
    sink: "queue.Queue[str]" = queue.Queue()

    def reader() -> None:
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace")
                m = banner_re.search(line)
                if m:
                    q.put(int(m.group(1)))
                sink.put(line)
        except Exception:  # noqa: BLE001 - pipe closed, child gone
            pass

    def forwarder() -> None:
        while True:
            # sink.get() blocks forever and cannot raise (no timeout): there is
            # nothing to catch around it. Only the write needs a guard.
            line = sink.get()
            try:
                sys.stdout.write(line)
                sys.stdout.flush()
            except (OSError, ValueError):  # stdout gone: stop forwarding
                return

    threading.Thread(target=reader, daemon=True).start()
    threading.Thread(target=forwarder, daemon=True).start()
    try:
        return q.get(timeout=timeout_s)
    except queue.Empty:
        return None


class ProcessSupervisor:
    """Owns managed children. No tenant logic itself — just spawn, register,
    and reap. Thread-safe: the processes dict is guarded by a lock."""

    def __init__(
        self,
        stale_s: float = STALE_S,
        idle_timeout_s: float = IDLE_TIMEOUT_S,
        reap_interval_s: float = REAP_INTERVAL_S,
        require_kill_guarantee: bool | None = None,
        label: str = "procmgr",
    ) -> None:
        self.stale_s = stale_s
        self.idle_timeout_s = idle_timeout_s
        self.reap_interval_s = reap_interval_s
        # None = platform default (required on Windows, where an unreaped child
        # is an orphan forever; optional on POSIX, where the process group is
        # the guarantee)
        self.require_kill_guarantee = require_kill_guarantee
        self.label = label
        self.processes: dict[str, ManagedProcess] = {}
        self._lock = threading.Lock()
        self.last_activity = time.time()  # last moment a child existed
        self.exit_event = threading.Event()
        # armed by request_idle_exit: exit as soon as no children remain
        self.exit_when_idle = False

    # ---- child lifecycle ----

    def spawn(self, key: str, spec: SpawnSpec, *, beat_required: bool) -> ManagedProcess | None:
        """Spawn one child; None on any failure (spawn error, refused kill
        guarantee, banner never printed). beat_required=True makes the reaper
        enforce the heartbeat contract for this child."""
        # refresh the idle timer before spawning (a slow child must not let the
        # reaper self-exit mid-start) and clear a pending shutdown flag
        with self._lock:
            self.last_activity = time.time()
            self.exit_when_idle = False
        try:
            env = dict(os.environ)
            # POSIX: own process group -> group kill. Windows has no setsid/
            # killpg; a new process group lets CTRL_BREAK reach the child.
            spawn_kwargs: dict = {"start_new_session": True} if os.name == "posix" else {}
            if os.name == "nt":
                spawn_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            proc = subprocess.Popen(
                spec.cmd,
                cwd=spec.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                **spawn_kwargs,
            )
        except OSError as e:  # pragma: no cover - missing venv/bundle
            log(f"[{self.label}] spawn failed: {e}")
            return None
        # assign BEFORE anything else: the venv/onefile launcher spawns its real
        # interpreter within milliseconds, and that interpreter must be born
        # inside the Job (membership is inherited from the launcher)
        guarantee = kill.job_assign(proc.pid)
        need_guarantee = (
            self.require_kill_guarantee if self.require_kill_guarantee is not None else os.name == "nt"
        )
        if need_guarantee and guarantee is None:
            # No Job = no guarantee this child can ever be killed. We do not
            # run children we cannot kill: refuse loudly instead of silently
            # degrading into an orphan-in-waiting (the exact failure mode that
            # kept a .clc locked read-only in the wild).
            log(f"[{self.label}] kill-on-close Job unavailable - refusing an unkillable child")
            kill.stop_process(proc, None)
            return None
        port: int | None = None
        if spec.banner_re is not None:
            port = wait_port(proc, spec.banner_re, spec.start_timeout_s)
            if port is None:
                log(f"[{self.label}] child never printed its port")
                kill.stop_process(proc, guarantee)
                return None
        record = self._make_record(
            key=key,
            proc=proc,
            port=port,
            guarantee=guarantee,
            beat_required=beat_required,
        )
        with self._lock:
            self.processes[record.key] = record
            self.last_activity = time.time()
        return record

    def stop(self, key: str | None) -> bool:
        """Unregister and kill one child. False when the key is unknown."""
        if not key:
            return False
        with self._lock:
            record = self.processes.pop(key, None)
            self.last_activity = time.time()
        if record is None:
            return False
        kill.stop_process(record.proc, record.guarantee)
        return True

    def beat(self, key: str | None) -> bool:
        """Refresh a child's liveness. False when the key is unknown."""
        if not key:
            return False
        with self._lock:
            record = self.processes.get(key)
            if record is None:
                return False
            record.last_beat = time.time()
        return True

    def request_idle_exit(self) -> None:
        """Arm the exit flag — but only when nothing is running. A sticky flag
        could kill a re-claim: one tenant's exit transiently hitting n==0 must
        not pre-arm a shutdown that fires under another tenant's feet."""
        with self._lock:
            if not self.processes:
                self.exit_when_idle = True

    def shutdown_all(self) -> None:
        """Best effort: kill every child (idle exit / SIGTERM)."""
        with self._lock:
            keys = list(self.processes.keys())
        for key in keys:
            self.stop(key)

    # ---- reaper: stale children + idle self-exit ----

    def reap_loop(self) -> None:
        # an unhandled exception here would strand the supervisor and leak
        # children; log and keep going
        while not self.exit_event.is_set():
            try:
                now = time.time()
                # judge outside the lock: a tenant's stale rule may put a
                # question to the child (the session supervisor asks
                # /api/health), and no blocking probe runs with the lock held
                with self._lock:
                    records = list(self.processes.values())
                stale = [r.key for r in records if self._stale(r, now)]
                for key in stale:
                    # judging took a probe (a tenant may ask the child), so the
                    # window may have stopped this one meanwhile: reaping what
                    # is no longer here would log a kill that never happened
                    with self._lock:
                        known = key in self.processes
                    if not known:
                        continue
                    self._log_stale(key)
                    self.stop(key)
                with self._lock:
                    n = len(self.processes)
                    exit_when_idle = self.exit_when_idle
                    last_activity = self.last_activity
                if n == 0 and (exit_when_idle or now - last_activity > self.idle_timeout_s):
                    log(f"[{self.label}] idle, exiting")
                    self.exit_event.set()
                    break
            except Exception as e:  # noqa: BLE001 - a broken pass must not kill the reaper
                log(f"[{self.label}] reap_loop error: {e}")
            self.exit_event.wait(self.reap_interval_s)

    # ---- hooks ----

    def _make_record(
        self, key: str, proc: subprocess.Popen, port: int | None, guarantee: int | None, beat_required: bool
    ) -> ManagedProcess:
        """Record factory. Tenants subclass ManagedProcess (e.g. the session
        supervisor's Session) and override this to store their own shape."""
        return ManagedProcess(
            key=key,
            proc=proc,
            port=port,
            guarantee=guarantee,
            last_beat=time.time(),
            beat_required=beat_required,
        )

    def _log_stale(self, key: str) -> None:
        log(f"[{self.label}] reaping stale {key}")

    def _stale(self, record: ManagedProcess, now: float) -> bool:
        """Is this record reclaimable as stale? The base rule IS the heartbeat
        contract: a ``beat_required`` child that has not beaten within
        ``stale_s``. Tenants override it to add evidence the CHILD can give
        about itself — the heartbeat's counterparty is the window, which can go
        silent for reasons that have nothing to do with the child's work (a
        phone in the background has no timers). A rule that finds the child
        alive should refresh ``last_beat`` rather than invent a grace number:
        the record then re-enters the normal contract on the next pass."""
        return record.beat_required and now - record.last_beat > self.stale_s
