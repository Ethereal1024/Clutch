"""Kernel-verified process identity: "is this still the process I recorded?"

A pid is a NUMBER, not an identity: the kernel recycles it, and on POSIX a
zombie keeps its number until somebody reaps it. So ``os.kill(pid, 0)``
answers "some process has this number" — which reads as "alive" for a dead
window whose pid a stranger now holds, and as "alive" for a zombie that serves
nothing. Both mistakes were made by earlier liveness checks in this tree (see
agent/core/project_lock.py's history).

The identity of a process is (pid, starttime): starttime is field 22 of
/proc/<pid>/stat, counted in clock ticks since boot, so a recycled pid can never
carry the starttime that was recorded for the process that is gone. ``boot_id``
pins the comparison to one boot, because starttime restarts from zero when the
machine does.

Verdicts are three-valued on purpose:
  - "live"    — the recorded process is still running
  - "dead"    — it exited (or the recorded identity does not match what runs now)
  - "unknown" — this host cannot see that pid's table (a pid on ANOTHER machine,
                a kernel without /proc). A doubt is never read as either verdict:
                the callers of this module decide, and a lock is only ever
                revoked on a positive "dead".
"""

from __future__ import annotations

import os
from pathlib import Path

_BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
_STAT = "/proc/{pid}/stat"
_CMDLINE = "/proc/{pid}/cmdline"

# /proc/<pid>/stat, field numbers (1-based): 1 pid, 2 comm, 3 state, ... 22 starttime.
# Everything before state is "<pid> (<comm>) ", and comm may contain spaces and
# parentheses, so the split happens AFTER the last ')' and the index is field-3.
_STARTTIME_INDEX = 19


def boot_id() -> str:
    """This boot's kernel id; "" where the kernel does not name one (Windows,
    macOS). Empty means "starttime cannot be pinned to a boot here"."""
    try:
        return _BOOT_ID.read_text(encoding="ascii").strip()
    except OSError:
        return ""


def _stat_fields(pid: int) -> list[str] | None:
    """The stat fields AFTER comm, or None when the process is gone or this host
    has no /proc."""
    try:
        raw = Path(_STAT.format(pid=pid)).read_text(encoding="ascii", errors="replace")
    except OSError:
        return None
    _head, sep, rest = raw.rpartition(")")
    if not sep:
        return None
    return rest.split()


def starttime(pid: int) -> str | None:
    """The process's start tick, as the string the kernel prints; None when it
    has no /proc entry (gone, or no /proc on this host)."""
    fields = _stat_fields(pid)
    if fields is None or len(fields) <= _STARTTIME_INDEX:
        return None
    return fields[_STARTTIME_INDEX]


def identity(pid: int) -> dict | None:
    """{pid, starttime, boot_id} for a live-or-recently-dead pid, or None when
    the pid is not a process this host can name.

    This is what a record stores instead of a bare pid: it is the whole answer to
    "is it still YOU?". starttime may be "" on a host without /proc; the caller
    then compares pids only, which is weaker and says so (see state()).
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    tick = starttime(pid)
    if tick is None and os.name != "nt":
        return None
    return {"pid": pid, "starttime": tick or "", "boot_id": boot_id()}


def _windows_alive(pid: int) -> bool:
    """Windows has no /proc: ask the kernel by opening the process and waiting
    on it with a zero timeout. A process that has exited signals its handle even
    while the handle (and the pid) still exist."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    synchronize = 0x00100000
    wait_timeout = 0x00000102
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return False  # gone (or a process this user may not open: treat as gone)
    try:
        return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
    finally:
        kernel32.CloseHandle(handle)


def state(pid: int, started: str = "", boot: str = "") -> str:
    """'live' | 'dead' | 'unknown' for the process (pid, started) on boot ``boot``.

    ``started`` empty means the caller has no start tick (a record written on a
    host without /proc): the pid alone is then the only evidence, which is the
    weak check this module exists to avoid — it is still better than guessing,
    and the caller is told by the returned verdict alone, so it must treat
    "live" without a start tick as the weaker fact it is.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return "dead"
    if os.name == "nt":
        return "live" if _windows_alive(pid) else "dead"
    fields = _stat_fields(pid)
    if fields is None:
        # No /proc entry here. On a host WITH /proc that is "gone"; without one
        # (macOS) this module cannot tell, and says so.
        return "dead" if _BOOT_ID.exists() or Path("/proc/self").exists() else "unknown"
    if boot:
        mine = boot_id()
        if mine and boot != mine:
            # A start tick recorded on another boot names a different instant:
            # this pid's do-not-match is proof, not doubt.
            return "dead"
    if fields and fields[0] in ("Z", "X", "x"):
        return "dead"  # exited; only waiting to be reaped
    if started and len(fields) > _STARTTIME_INDEX and fields[_STARTTIME_INDEX] != started:
        return "dead"  # the number was recycled: another process holds it now
    return "live"


def alive(pid: int, started: str = "", boot: str = "") -> bool:
    return state(pid, started, boot) == "live"


def command(pid: int) -> str:
    """A process's argv, joined — for a human-readable report, never a decision.
    Empty when it cannot be read (gone, no permission, no /proc)."""
    try:
        raw = Path(_CMDLINE.format(pid=pid)).read_bytes()
    except OSError:
        return ""
    args = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
    return " ".join(args)[:200]
