"""Cross-process write locking for .clc project files.

Every UI window runs its own agent-server process, and two windows must never
append/rewrite the same .clc concurrently. A window's server holds an exclusive
lock on each .clc it opens for write; a second server opening the same project
gets a ProjectOpenConflict (HTTP 409 + code project_open_conflict) and the UI
offers read-only instead.

Local workspaces: flock on <tmp>/clutch-<sha1(abs path)[:16]>.lock. The lock
lives in the OS temp dir — the workspace tree stays untouched — and the kernel
releases it automatically when the holding process dies, so a crashed server
leaves no stale lock behind.

Remote (ssh) workspaces: flock cannot reach the remote host, so the lock is an
atomic lock-file created over the exec bridge:
    (set -C; date +%s > <dir>/.clc.lock)
POSIX noclobber makes the redirect fail when the file already exists, so a
successful creation means we hold the lock. A crashed window leaves the file
behind; the timestamp + TTL (6h) reclaims it — PIDs are useless here because
every exec is a fresh shell and the local server PID is meaningless remotely.

The same process re-opening the same project (reopen within one window) must
not conflict with itself: flock is exclusive even between two fds of one
process, so acquired handles are cached by path and reused.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from ..tools.workspace import RemoteWorkspace, Workspace, _REMOTE_IO_TIMEOUT, shq
from .errors import AgentError

try:  # POSIX; Windows has no flock (see _acquire_local fallback)
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

# How long a remote lock-file may outlive its holder before another window may
# reclaim it (crash recovery). 6h covers any realistic run; only a window that
# idled longer gets preempted, which is an acceptable edge case.
_REMOTE_LOCK_TTL_S = 6 * 3600


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
    """A held lock. release() drops it; local fds are also freed by the kernel
    when the process exits, remote lock-files by the TTL after a crash."""

    kind: str  # "local" | "remote"
    clc_path: str
    fd: int | None = None  # local: the flock fd (POSIX) / O_EXCL fd (Windows)
    lock_file: str | None = None  # remote: remote <dir>/.clc.lock
    workspace: Workspace | None = None  # remote: to rm the lock on release


def _local_lock_path(clc_path: str) -> str:
    digest = hashlib.sha1(os.path.abspath(clc_path).encode("utf-8")).hexdigest()[:16]
    return os.path.join(tempfile.gettempdir(), f"clutch-{digest}.lock")


class ProjectLock:
    """Static acquire/release API. One exclusive lock per .clc path."""

    # same-process handles, keyed by the absolute .clc path: a reopen in the
    # same window must reuse the held lock — flock is exclusive even between
    # two fds of one process, so a fresh flock would self-conflict.
    _held: dict[str, LockHandle] = {}

    @classmethod
    def acquire(cls, clc_path: str, workspace: Workspace | None = None) -> LockHandle | None:
        """Take the exclusive write lock on a .clc.

        Returns the handle on success, None when another process holds it —
        callers decide whether to raise ProjectOpenConflict or surface the
        conflict differently."""
        key = os.path.abspath(clc_path)
        held = cls._held.get(key)
        if held is not None:
            return held  # same window re-open: reuse, never self-conflict
        if isinstance(workspace, RemoteWorkspace):
            handle = cls._acquire_remote(key, workspace)
        else:
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
        return LockHandle(kind="local", clc_path=key, fd=fd)

    @staticmethod
    def _acquire_remote(key: str, workspace: RemoteWorkspace) -> LockHandle | None:
        lock_file = str(Path(key).parent / ".clc.lock")
        if not ProjectLock._remote_try_create(workspace, lock_file):
            # the lock file exists: stale if its timestamp is older than the TTL
            ts = workspace.run(f"cat {shq(lock_file)} 2>/dev/null", _REMOTE_IO_TIMEOUT).stdout.strip()
            if ts.isdigit() and time.time() - int(ts) > _REMOTE_LOCK_TTL_S:
                workspace.run(f"rm -f {shq(lock_file)}", _REMOTE_IO_TIMEOUT)
                if not ProjectLock._remote_try_create(workspace, lock_file):
                    return None
            else:
                return None
        return LockHandle(kind="remote", clc_path=key, lock_file=lock_file, workspace=workspace)

    @staticmethod
    def _remote_try_create(workspace: RemoteWorkspace, lock_file: str) -> bool:
        # (set -C; ...) scopes noclobber to the subshell; the redirect fails
        # atomically when the lock file already exists -> someone else holds it
        res = workspace.run(f"(set -C; date +%s > {shq(lock_file)}) 2>/dev/null", _REMOTE_IO_TIMEOUT)
        return res.code == 0

    @classmethod
    def release(cls, handle: LockHandle | None) -> None:
        """Drop a lock: local fds unlock+close, remote lock-files are rm'd (best
        effort — a dead bridge is fine, the TTL reclaims the lock later)."""
        if handle is None:
            return
        cls._held.pop(handle.clc_path, None)
        if handle.kind == "local" and handle.fd is not None:
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
        elif handle.kind == "remote":
            if handle.lock_file and handle.workspace is not None:
                try:
                    handle.workspace.run(f"rm -f {shq(handle.lock_file)}", _REMOTE_IO_TIMEOUT)
                except Exception:
                    pass  # bridge gone: TTL reclaims it later

    @classmethod
    def release_all_remote(cls) -> None:
        """atexit hook: best-effort rm of every remote lock this process holds
        (only meaningful while the ssh tunnel is still alive)."""
        for handle in list(cls._held.values()):
            if handle.kind == "remote":
                cls.release(handle)
