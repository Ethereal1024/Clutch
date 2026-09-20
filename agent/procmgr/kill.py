"""Cross-platform process termination: the soft→hard ladder and the kernel
guarantee that a managed child can never outlive its supervisor.

Two layers live here:

- ``signal_soft`` / ``kill_hard`` / ``stop_process`` — the best-effort stop
  ladder. Never raises: a failed kill must not escape into a caller that has
  already unregistered the child.
- the Windows Job machinery — on POSIX a child killed through its process
  group dies with the group's reaper (which sits in the UI's process tree). On
  Windows there is no process group to lean on, so a supervisor that dies
  without walking its children leaves them alive forever. The kill-on-close
  Job hands that to the kernel instead.
"""

from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import time

from agent.procmgr.stdio import log

KILL_GRACE_S = 3.0


def signal_soft(proc: subprocess.Popen) -> None:
    """Ask a managed child to stop: SIGTERM to its process group (POSIX), or
    CTRL_BREAK_EVENT on Windows (the child is spawned with
    CREATE_NEW_PROCESS_GROUP).

    Best effort, and on Windows normally unavailable: CTRL_BREAK reaches only a
    process group that shares OUR console, while a packaged supervisor is
    spawned by Electron with windowsHide and has no console at all — so this
    raises OSError(WinError 6) instead of delivering anything. Every OSError
    (that one, ProcessLookupError, PermissionError) is left to kill_hard.
    """
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        else:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
    except OSError:
        return


def kill_hard(proc: subprocess.Popen) -> None:
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


def stop_process(proc: subprocess.Popen, guarantee: int | None = None) -> None:
    """Best effort stop of one managed child. Never raises.

    A failed kill must not escape into the caller: the HTTP stop endpoint has
    already unregistered the child by then, so an exception answered nothing
    AND leaked the child (the reaper could only bury it in a log line). Losing
    the graceful signal is survivable — kill_hard reaps the tree — losing the
    stop is not.

    ``guarantee`` (Windows) is the child's kill-on-close Job: closing its
    handle below is the last line of defense that terminates anything the
    attempts above missed — e.g. a venv/onefile launcher killed while its
    real interpreter lived on (proc.kill() reaps only the launcher).
    """
    try:
        if proc.poll() is not None:
            return  # already exited; only the Job cleanup below remains
        signal_soft(proc)
        try:
            proc.wait(timeout=KILL_GRACE_S)
            return
        except subprocess.TimeoutExpired:
            pass
        except OSError:  # pragma: no cover - child vanished while waiting
            return
        kill_hard(proc)
        try:
            proc.wait(timeout=KILL_GRACE_S)  # reap, and let the port go
        except (subprocess.TimeoutExpired, OSError):
            pass
    finally:
        job_close(guarantee)


# ---- Windows: a managed child must not outlive its supervisor ----
#
# POSIX kills a child through its process group, and the group's reaper (the
# supervisor) sits in the UI's process tree, so a dead window means a dead
# reaper AND a dead group. Windows has no process group to lean on: a
# supervisor that dies without walking its children (crash, TerminateProcess,
# Electron's tree dying first) leaves the child alive forever — an
# invisible zombie that still holds the .clc write lock, so every later open of
# that project lands read-only with no visible other window (observed in the
# wild: two leftover `python.exe` from a dev supervisor kept a project locked
# for good). The kernel answer is a Job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE:
# the child belongs to the Job, and when THIS process dies its handles close
# with it, so the kernel terminates the whole child tree — the venv/onefile
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


def descendant_pids(pid: int) -> list[int]:
    """Live descendants of `pid`, nearest first (Toolhelp32 snapshot).

    Empty on any failure — the walk only widens the Job's net, so a
    missed snapshot must never fail a child start.
    """
    if os.name != "nt":
        return []
    try:
        # use_last_error=True so the failure log's WinError is the real one
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        k32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        k32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcEntry)]
        k32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcEntry)]
        snap = k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        if not snap or snap == _INVALID_HANDLE_VALUE:
            log(f"[procmgr] descendant walk: snapshot failed (WinError {ctypes.get_last_error()})")
            return []
        pairs: list[tuple[int, int]] = []
        entry = _ProcEntry()
        entry.dwSize = ctypes.sizeof(entry)
        more = k32.Process32FirstW(snap, ctypes.byref(entry))
        while more:
            pairs.append((entry.th32ProcessID, entry.th32ParentProcessID))
            more = k32.Process32NextW(snap, ctypes.byref(entry))
        k32.CloseHandle(snap)
    except Exception as e:  # noqa: BLE001 - logged: net-widening only, the
        log(f"[procmgr] descendant walk failed: {e!r}")  # core Job holds
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


def job_assign(pid: int) -> int | None:
    """Put a fresh child process into a kill-on-close Job (Windows only).

    Returns the Job handle for stop_process to close, or None when the
    guarantee is unavailable. None is NOT a degenerate "keep going" answer: a
    child we cannot guarantee to kill is a child we must not run, so callers
    with require_kill_guarantee REFUSE to start it. POSIX always gets None —
    there the process group is the guarantee.
    """
    if os.name != "nt":
        return None
    try:
        # use_last_error=True: ctypes' own Win32 traffic would otherwise
        # clobber the real GetLastError value before we can read it
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
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
            log(f"[procmgr] Job assign failed: CreateJobObjectW (WinError {ctypes.get_last_error()})")
            return None
        limits = _JobLimits()
        limits.BasicLimitInformation.LimitFlags = _JOB_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
            job, _JOB_EXTENDED_LIMIT_INFO, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            log(f"[procmgr] Job assign failed: SetInformationJobObject (WinError {ctypes.get_last_error()})")
            k32.CloseHandle(job)
            return None
        proc = k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
        if not proc:
            log(f"[procmgr] Job assign failed: OpenProcess({pid}) (WinError {ctypes.get_last_error()})")
            k32.CloseHandle(job)
            return None
        ok = k32.AssignProcessToJobObject(job, proc)
        k32.CloseHandle(proc)
        if not ok:
            log(f"[procmgr] Job assign failed: AssignProcessToJobObject (WinError {ctypes.get_last_error()})")
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
            for d in descendant_pids(pid):
                h = k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, d)
                if h:
                    k32.AssignProcessToJobObject(job, h)  # same-job re-assign is a no-op
                    k32.CloseHandle(h)
        return job
    except Exception as e:  # noqa: BLE001 - logged, then refused by the caller
        log(f"[procmgr] Job assign failed: {e!r}")
        return None


def job_close(job: int | None) -> None:
    """Close the child's Job handle. With KILL_ON_JOB_CLOSE the kernel
    terminates every process still in the Job — the last line of defense when
    a kill missed a member (a launcher that died before its interpreter, a
    tree-walk that skipped a grandchild). Never raises."""
    if os.name != "nt" or not job:
        return
    try:
        ctypes.windll.kernel32.CloseHandle(job)
    except OSError:
        pass
