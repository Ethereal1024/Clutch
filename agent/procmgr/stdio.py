"""Stdout survival for long-lived Clutch processes.

A Clutch daemon is routinely spawned by a parent that may die first (Electron
window, SSH session, another server). When that happens the daemon's stdout
becomes a dead socket: once its buffer fills, a plain ``print`` blocks forever,
and one blocked print can take a whole request handler — or a reaper loop —
down with it. This module carries the three pieces of machinery that make a
process's own logging impossible to hang or crash on, so the supervisor code
above it never has to think about stdio again.
"""

from __future__ import annotations

import os
import queue
import sys
import threading


def log(msg: str) -> None:
    """Log to stdout without EVER blocking or crashing the caller.

    When the process that spawned us dies, our stdout is a dead socket; once its
    buffer fills, a plain ``print`` blocks forever (a handler thread stuck in a
    post-``print`` is exactly the orphaned-supervisor "Empty reply" hang).
    make_stdout_nonblocking marks the fd non-blocking so the write raises
    BlockingIOError instead of blocking; we swallow it and drop the line.
    """
    try:
        print(msg, flush=True)
    except (OSError, ValueError):  # dead/full stdout: drop the log line
        pass


def make_stdout_nonblocking() -> None:
    """Turn a full write to stdout/stderr from a BLOCK into an exception, so a
    process's own logging (and any stdout-forwarding reader) can never hang."""
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


class SafeStdStream:
    """stdout/stderr that keeps serving when the parent is gone. The process is
    often spawned by a GUI shell and orphaned (re-parented to init/systemd) with
    its stdio socketpair dangling; a print to that dead socket then raises
    BrokenPipeError, which previously killed the request handler mid-response
    AND the reaper loop (both die on their first print) — the port stays
    squatted forever, leaking children and blocking every later start. Swallow
    stream errors so a dead parent can never take the server down.

    Windows has no fcntl, so make_stdout_nonblocking skips it there and a FULL
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
