"""Cross-process write locking for .clc project files.

Every UI window runs its own agent-server process, and two windows must never
append/rewrite the same .clc concurrently. A window's server holds an exclusive
lock on each .clc it opens for write; a second server opening the same project
gets a ProjectOpenConflict (HTTP 409 + code project_open_conflict) and the UI
offers read-only instead.

The lock is an OS-level file lock on <tmp>/clutch-<sha1(path)[:16]>.lock, keyed
by the .clc's absolute path: an flock on POSIX, a byte-range lock (LockFileEx,
through msvcrt.locking) on Windows. This covers BOTH local and
SSH-degradation workspaces: every Clutch window (local or remote-backed) is a
process on the CLIENT machine, so they all lock the same local file and
arbitrate with each other through the kernel. Keying by the remote absolute path
(e.g. /root/test.clc) means two windows pointing at the same remote project
collide exactly like two windows on a local project.

Both are KERNEL locks, and that is the whole point: the OS drops the lock when
the holding process dies (a documented guarantee for both flock and
LockFileEx), so a crashed server leaves no stale lock, no TTL and no recovery
path. Windows deliberately does NOT use a pid-carrying marker file (the earlier
design): a marker was stealable whenever the holder's pid was unreadable —
OpenProcess on another user's or on an elevated process is denied with
ACCESS_DENIED, which read as "dead" — and it read as "still held" after Windows
recycled that pid, so a crashed holder could leave a project unopenable until
the user hand-deleted the marker. A byte-range lock has neither failure mode: it
carries no pid at all.

The lock FILE is never deleted, only unlocked, on either backend: unlinking it
while a waiter already holds a handle would let two processes lock two different
files that share one name. It stays a 0-byte file in the temp dir, one per .clc
opened for write.

It lives in the OS temp dir — the workspace tree (local or remote) stays
untouched, so an SSH user needs NO write permission on the remote project
directory (the old remote lock-file failed for non-root users on root-owned
dirs).

Trade-off (accepted): the lock is host-local and the temp dir is per-user, so
two different CLIENTS (machines) SSH-ing to the same remote, or two USERS on one
Windows machine sharing a project directory, do NOT arbitrate with each other.
Clutch is a single-user, single-client tool, so this is accepted — the old
remote file only ever arbitrated Clutch-vs-Clutch anyway (never against external
editors on the remote).

The same process re-opening the same project (reopen within one window) must
not conflict with itself: an flock and a byte-range lock are both exclusive even
between two handles of one process, so acquired handles are cached by path and
reused.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from typing import IO

from .errors import AgentError

try:  # POSIX: the lock is an flock (see _acquire_local for the Windows one)
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

try:  # Windows: the lock is a byte-range lock on a CRT fd
    import msvcrt
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None


class ProjectOpenConflict(AgentError):
    """Another process (window) holds the write lock on this .clc."""

    def __init__(self, path: str) -> None:
        super().__init__(
            code="project_open_conflict",
            message="project is open in another window",
            detail=path,
        )


@dataclass
class LockHandle:
    """A held lock. release() drops it; a crashed holder frees it automatically
    because the OS releases the lock when the process exits — the flock fd on
    POSIX, the LockFileEx region on Windows (dropped when its file handle is
    closed, including by process death)."""

    clc_path: str
    fd: int | None = None  # POSIX: the flock fd; None on Windows
    file: IO[bytes] | None = None  # Windows: the locked file (its CRT fd holds the region)


def _local_lock_path(clc_path: str) -> str:
    digest = hashlib.sha1(os.path.abspath(clc_path).encode("utf-8")).hexdigest()[:16]
    return os.path.join(tempfile.gettempdir(), f"clutch-{digest}.lock")


class ProjectLock:
    """Static acquire/release API. One exclusive lock per .clc path."""

    # same-process handles keyed by the .clc path: a reopen must reuse the held
    # lock (an flock and a byte-range lock are both exclusive even between two
    # handles of one process)
    _held: dict[str, LockHandle] = {}

    @classmethod
    def acquire(cls, clc_path: str) -> LockHandle | None:
        """Take the exclusive write lock on a .clc.

        Returns the handle on success, None when another process holds it —
        callers decide whether to raise ProjectOpenConflict or surface the
        conflict differently."""
        key = os.path.abspath(clc_path)
        held = cls._held.get(key)
        if held is not None:
            return held  # same window re-open: reuse, never self-conflict
        handle = cls._acquire_local(key)
        if handle is not None:
            cls._held[key] = handle
        return handle

    @staticmethod
    def _acquire_local(key: str) -> LockHandle | None:
        lock_path = _local_lock_path(key)
        if fcntl is not None:
            try:
                fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            except OSError:
                return None
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                return None
            return LockHandle(clc_path=key, fd=fd)
        # Windows: no flock, so lock a byte range instead (LockFileEx behind
        # msvcrt.locking) — the flock equivalent: one exclusive region, refused
        # immediately when another process holds it, and dropped by the OS when
        # its holder dies. msvcrt wants a CRT fd, hence the builtin open; the
        # file is created if missing, reused if not, and NEVER unlinked (see the
        # module docstring). byte 0 is the region everyone locks: the file is
        # usually empty, and locking past EOF is well defined.
        if msvcrt is None or os.name != "nt":  # pragma: no cover - flock-less POSIX
            return None
        try:
            f = open(lock_path, "a+b")
        except OSError:
            return None
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            f.close()
            return None
        return LockHandle(clc_path=key, file=f)

    @classmethod
    def release(cls, handle: LockHandle | None) -> None:
        """Drop a lock: unlock+close the fd (POSIX) or the file holding the
        byte-range lock (Windows). The OS also frees either one if this process
        dies while holding it, so no stale lock survives a crash — which is what
        lets both backends skip any liveness/TTL recovery."""
        if handle is None:
            return
        cls._held.pop(handle.clc_path, None)
        if handle.file is not None:
            if msvcrt is not None:
                try:
                    msvcrt.locking(handle.file.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            try:
                handle.file.close()  # closing releases the region either way
            except OSError:
                pass
        if handle.fd is not None:
            if fcntl is not None:
                try:
                    fcntl.flock(handle.fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            try:
                os.close(handle.fd)
            except OSError:
                pass

    @classmethod
    def release_all(cls) -> None:
        """Drop every lock this process holds (e.g. on a backend mode switch,
        where the window's whole project context is invalidated)."""
        for handle in list(cls._held.values()):
            cls.release(handle)
