"""Cross-process write locking for .clc project files.

Every UI window runs its own agent-server process, and two windows must never
append/rewrite the same .clc concurrently. A window's server holds an exclusive
lock on each .clc it opens for write; a second server opening the same project
gets a ProjectOpenConflict (HTTP 409 + code project_open_conflict) and the UI
offers read-only instead.

The lock is a flock on <tmp>/clutch-<sha1(path)[:16]>.lock, keyed by the .clc's
absolute path. This covers BOTH local and SSH-degradation workspaces: every
Clutch window (local or remote-backed) is a process on the CLIENT machine, so
they all flock the same local file and arbitrate with each other through the
kernel. Keying by the remote absolute path (e.g. /root/test.clc) means two
windows pointing at the same remote project collide exactly like two windows on
a local project.

The lock lives in the OS temp dir — the workspace tree (local or remote) stays
untouched, so an SSH user needs NO write permission on the remote project
directory (the old remote lock-file failed for non-root users on root-owned
dirs). The kernel releases the flock when the holding process dies, so a crashed
server leaves no stale lock and no TTL is needed (the old remote lock-file +
6h TTL recovery is gone).

Trade-off: the flock lives on the CLIENT, so two different clients (machines)
SSH-ing to the same remote do NOT arbitrate with each other. Clutch is a
single-user, single-client tool, so this is accepted — the old remote file only
ever arbitrated Clutch-vs-Clutch anyway (never against external editors on the
remote).

The same process re-opening the same project (reopen within one window) must
not conflict with itself: flock is exclusive even between two fds of one
process, so acquired handles are cached by path and reused.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass

from .errors import AgentError

try:  # POSIX; Windows has no flock (see _acquire_local fallback)
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None


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
    because the kernel releases the flock when the process exits."""

    clc_path: str
    fd: int | None = None  # the flock fd (POSIX) / O_EXCL fd (Windows)


def _local_lock_path(clc_path: str) -> str:
    digest = hashlib.sha1(os.path.abspath(clc_path).encode("utf-8")).hexdigest()[:16]
    return os.path.join(tempfile.gettempdir(), f"clutch-{digest}.lock")


class ProjectLock:
    """Static acquire/release API. One exclusive lock per .clc path."""

    # same-process handles keyed by the .clc path: a reopen must reuse the held
    # lock (flock is exclusive even between two fds of one process)
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
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        except OSError:
            return None
        if fcntl is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                return None
        else:  # pragma: no cover - Windows: O_EXCL atomic create instead
            try:
                fd2 = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            except OSError:
                os.close(fd)
                return None
            os.close(fd)
            fd = fd2
        return LockHandle(clc_path=key, fd=fd)

    @classmethod
    def release(cls, handle: LockHandle | None) -> None:
        """Drop a lock: unlock+close the fd. The kernel also frees it if this
        process dies while holding it — no stale lock survives a crash."""
        if handle is None:
            return
        cls._held.pop(handle.clc_path, None)
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
            if fcntl is None:  # Windows: remove the O_EXCL marker file
                try:
                    os.unlink(_local_lock_path(handle.clc_path))
                except OSError:
                    pass

    @classmethod
    def release_all(cls) -> None:
        """Drop every lock this process holds (e.g. on a backend mode switch,
        where the window's whole project context is invalidated)."""
        for handle in list(cls._held.values()):
            cls.release(handle)
