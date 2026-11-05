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
LockFileEx), so a crashed holder leaves no stale lock, no TTL and no recovery
path. That guarantee is about a DEAD holder. It says nothing about a LIVE one
whose window is gone — the case this module used to leave to timers in the
supervisor, and the case that kept a .clc locked for minutes (or forever) when
a session outlived the window that claimed it.

So the lock file also carries an OWNER RECORD — who holds this lock, on which
boot, and which window process claimed it. Two rules keep the record from
becoming the pid-marker this design deliberately rejected:

  * the record is a REPORT, never the arbiter. "Is it held?" is asked of the
    kernel (a non-blocking trial lock), and "may I take it?" is the kernel's
    answer alone. A record that says "held" on a lock the kernel grants is
    ignored and overwritten by the new holder.
  * liveness is (pid, starttime, boot_id), not a bare pid (agent/core/procstat):
    the pid-marker failed because an unreadable pid read as "dead" (ACCESS_DENIED
    on another user's process) and a recycled pid read as "held". A start tick
    cannot be recycled, and an unreadable process is "unknown", never "dead".

What the record is FOR: the one reconciler (agent/core/lock_reconcile.py) can
tell a session whose window is provably gone (the claiming process no longer
exists — kernel facts, no timers, no heartbeats) from a window that is merely
silent (a frozen phone: its process exists, so its claim stands however long the
silence lasts). Only the first may be revoked.

The lock FILE is never deleted, only unlocked and rewritten, on either backend:
unlinking it while a waiter already holds a handle would let two processes lock
two different files that share one name. It stays in the temp dir, one per .clc
opened for write, at most RECORD_MAX bytes.

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

A lock's lifetime is the ACTIVE project's lifetime: a window holds the write
lock on at most its currently-open project, so replacing it (RunState.set_project
/ set_backend, the choke point) hands the old handle back. Nothing else keeps
that handle, so a lock outliving its project would be unreachable: never
released, it would lock every other window out of that .clc until this server
exits.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import tempfile
import time
from dataclasses import dataclass, field
from typing import IO

from . import procstat
from .errors import AgentError

try:  # POSIX: the lock is an flock (see _acquire_local for the Windows one)
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

try:  # Windows: the lock is a byte-range lock on a CRT fd
    import msvcrt
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None

# Version of the owner record layout. A reader that does not know the version
# says nothing about the record rather than guessing at fields.
RECORD_VERSION = 1
# One small JSON object; anything longer is not a record we wrote (or a torn
# write) and is ignored whole.
RECORD_MAX = 4096

# Facts only the serving process knows, filled once by agent.server at startup
# and merged into every record written afterwards (see set_context).
_CONTEXT: dict = {}


# The part of an owner record a CLIENT can use: who holds the lock, on which
# host, since when, and which window process claimed it. Everything else in the
# record (boot id, start tick) is for the reconciler, not for the UI.
OWNER_FIELDS = ("pid", "host", "since", "claim", "claim_pid", "port")


def owner_summary(record: dict | None) -> dict | None:
    """Spell an owner record for a caller that wants to SAY who has the lock.
    None when the holder left no record (an older build): absence is doubt,
    never a guess."""
    if not record:
        return None
    return {key: record[key] for key in OWNER_FIELDS if record.get(key) is not None}


class ProjectOpenConflict(AgentError):
    """Another process (window) holds the write lock on this .clc."""

    def __init__(self, path: str) -> None:
        super().__init__(
            code="project_open_conflict",
            message="project is open in another window",
            detail=path,
        )
        # The holder's own statement about itself, read at the moment of the
        # conflict: a UI can name the window that has the project (and the host
        # can be asked to free a lock whose window is proven gone).
        self.owner = owner_summary(ProjectLock.owner(path))


@dataclass
class LockHandle:
    """A held lock. release() drops it; a crashed holder frees it automatically
    because the OS releases the lock when the process exits — the flock fd on
    POSIX, the LockFileEx region on Windows (dropped when its file handle is
    closed, including by process death)."""

    clc_path: str
    fd: int | None = None  # POSIX: the flock fd; None on Windows
    file: IO[bytes] | None = None  # Windows: the locked file (its CRT fd holds the region)
    released: bool = False  # release() is idempotent: see below
    # Extra facts merged into this handle's on-disk record (claim pid, port, ...)
    record: dict = field(default_factory=dict)


def lock_dir() -> str:
    """Where lock files live: the OS temp dir (per user), or ``CLUTCH_LOCK_DIR``
    when set. One answer for both the holder and the reconciler, because a
    reconciler looking somewhere else than the holders do is worse than none."""
    return os.environ.get("CLUTCH_LOCK_DIR") or tempfile.gettempdir()


def _local_lock_path(clc_path: str) -> str:
    digest = hashlib.sha1(os.path.abspath(clc_path).encode("utf-8")).hexdigest()[:16]
    return os.path.join(lock_dir(), f"clutch-{digest}.lock")


def set_context(**fields) -> None:
    """Name the facts that only the server knows about itself — its port, and
    the window process that claimed it — so every record written from now on
    carries them. Values of None are "not known", never "blank": a field left
    out is absent from the record, and a reader must read its absence as doubt."""
    for key, value in fields.items():
        if value is not None:
            _CONTEXT[key] = value


def _record_bytes(key: str, extra: dict | None = None) -> bytes:
    """The record for ``key`` as this process would write it now."""
    me = procstat.identity(os.getpid()) or {}
    record = {
        "v": RECORD_VERSION,
        "pid": os.getpid(),
        "starttime": me.get("starttime", ""),
        "boot_id": me.get("boot_id", ""),
        "host": socket.gethostname(),
        "project": key,
        "since": round(time.time(), 3),
    }
    record.update(_CONTEXT)
    record.update(extra or {})
    return (json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")


def _rewrite(handle: LockHandle, data: bytes) -> None:
    """Replace the lock file's contents. Safe without any extra lock ONLY
    because the caller holds the exclusive lock on it, which is what makes the
    record a single writer's statement rather than a race."""
    try:
        if handle.fd is not None:
            os.ftruncate(handle.fd, 0)
            os.pwrite(handle.fd, data, 0)
        elif handle.file is not None:
            handle.file.seek(0)
            handle.file.truncate()
            handle.file.write(data)
            handle.file.flush()
    except OSError:
        pass  # the record is a courtesy; the kernel lock is the lock


def _trial_locked(lock_path: str) -> bool:
    """Does ANY process hold this lock? Asked of the kernel on a FRESH handle
    and dropped again at once.

    A fresh open is a fresh open file description, so it conflicts with the
    holder's lock even when the holder is this very process — which is what
    makes "is it held?" answerable without disturbing what we hold."""
    if fcntl is not None:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        except OSError:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)
        return False
    if msvcrt is not None and os.name == "nt":
        try:
            f = open(lock_path, "a+b")
        except OSError:
            return False
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return True
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        f.close()
        return False
    return False


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
            _rewrite(held, _record_bytes(key, held.record))  # same window re-open: reuse, never self-conflict
            return held
        handle = cls._acquire_local(key)
        if handle is not None:
            _rewrite(handle, _record_bytes(key, handle.record))
            cls._held[key] = handle
        return handle

    @classmethod
    def annotate(cls, handle: LockHandle | None, **fields) -> None:
        """Add facts to a HELD lock's record (the window that claimed this
        session, the port it listens on). Callers use this when the fact is
        learned after the project opens; a released handle is ignored, since
        writing then would claim a lock this process no longer holds."""
        if handle is None or handle.released:
            return
        handle.record.update({k: v for k, v in fields.items() if v is not None})
        _rewrite(handle, _record_bytes(handle.clc_path, handle.record))

    @classmethod
    def owner(cls, clc_path: str) -> dict | None:
        """The record the holder wrote, or None when there is none this build can
        read (an older holder, a blank file, a torn or unknown-version write).

        Read-only and lock-free: it is a report ABOUT the holder, and asking for
        it must never disturb what the holder holds."""
        try:
            with open(_local_lock_path(os.path.abspath(clc_path)), "rb") as f:
                raw = f.read(RECORD_MAX)
        except OSError:
            return None
        try:
            record = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None
        if not isinstance(record, dict) or record.get("v") != RECORD_VERSION:
            return None
        if not isinstance(record.get("pid"), int):
            return None
        return record

    @classmethod
    def inspect(cls, clc_path: str) -> dict:
        """The lock's state as the kernel and the record together describe it:
        ``{project, lock_path, held, owner}``. ``held`` is the kernel's answer;
        ``owner`` is the holder's own statement (None when unreadable)."""
        key = os.path.abspath(clc_path)
        lock_path = _local_lock_path(key)
        return {
            "project": key,
            "lock_path": lock_path,
            "held": _trial_locked(lock_path),
            "owner": cls.owner(key),
        }

    @classmethod
    def blank_record(cls, clc_path: str) -> bool:
        """Erase a record that describes a lock NOBODY holds.

        Takes the lock itself first, so it can never blank a live holder's record
        (the trial and the write are the same acquisition): True when the record
        is blank afterwards, False when the lock is held and was left alone."""
        key = os.path.abspath(clc_path)
        handle = cls._acquire_local(key)
        if handle is None:
            return False
        try:
            _rewrite(handle, b"")
            return True
        finally:
            cls.release(handle)

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
        lets both backends skip any liveness/TTL recovery.

        Idempotent per HANDLE, not just per path: a caller that already dropped a
        handle (and left it referenced somewhere) must not close it a second time
        — by then the fd NUMBER can belong to an unrelated open file, and closing
        it would pull that file, socket or pipe out from under its owner."""
        if handle is None or handle.released:
            return
        handle.released = True
        cls._held.pop(handle.clc_path, None)
        # A released lock tells the truth about itself: a record left behind
        # would name this process as the holder of a lock it no longer holds.
        _rewrite(handle, b"")
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
