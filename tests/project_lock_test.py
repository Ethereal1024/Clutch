"""ProjectLock must hold up on BOTH host platforms.

POSIX claims the lock with flock; Windows has no fcntl — there the claim is an
O_EXCL marker file carrying the holder pid, and a crashed holder's stale marker
is reclaimed through a pid-liveness check. These tests simulate the Windows
branch on the POSIX dev machine (fcntl patched to None, os.name to "nt",
_pid_alive to its contract) so the Windows logic is exercised on every platform,
and they pin the POSIX flock behavior that must not regress.

The simulated host OS is never touched: no real Windows filesystem, no real
ctypes — only the module's own decision logic.

Run: uv run python -m tests.project_lock_test
"""

from __future__ import annotations

import itertools
import os
import subprocess
import tempfile
import unittest.mock as mock

from agent.core import project_lock as pl
from tests.testsupport import check

_counter = itertools.count()


def _fresh_key(tmp: str) -> str:
    """A unique fake .clc path (the lock path is derived from it, so each test
    gets its own lock file in the same temp dir)."""
    return os.path.join(tmp, f"proj-{os.getpid()}-{next(_counter)}.clc")


def _reset() -> None:
    pl.ProjectLock._held.clear()


def test_posix_flock_claim_and_self_reuse(tmp: str) -> None:
    """fcntl is real here: the claim is an flock, a same-process reopen reuses
    it, a second independent flock is refused, and release frees it."""
    _reset()
    key = _fresh_key(tmp)
    h = pl.ProjectLock.acquire(key)
    check(h is not None and h.fd is not None and h.marker is None, "posix claim holds an flock fd (no marker)")
    check(pl.ProjectLock.acquire(key) is h, "same-process reopen reuses the held lock (never self-conflicts)")
    import fcntl

    fd = os.open(pl._local_lock_path(key), os.O_RDWR)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            check(False, "second independent flock is refused while held")
        except OSError:
            check(True, "second independent flock is refused while held")
    finally:
        os.close(fd)
    pl.ProjectLock.release(h)
    check(pl.ProjectLock._held == {}, "release forgets the handle")
    h2 = pl.ProjectLock.acquire(key)
    check(h2 is not None, "release frees the lock for the next claim")
    pl.ProjectLock.release(h2)
    os.unlink(pl._local_lock_path(key))  # tidy the temp lock file


def test_posix_pid_liveness() -> None:
    """_pid_alive on the real host (POSIX branch): own pid alive, a reaped pid
    dead, non-pids dead."""
    check(pl._pid_alive(os.getpid()), "own pid reads as alive")
    p = subprocess.Popen(["sleep", "30"])
    p.kill()
    p.wait()  # reap: no zombie — kill(0) must now fail
    check(not pl._pid_alive(p.pid), "a reaped pid reads as dead")
    check(not pl._pid_alive(0) and not pl._pid_alive(-5), "non-pids read as dead")


def test_windows_claim_uses_pid_marker(tmp: str) -> None:
    """Simulated Windows: no fcntl, nt branch. The FIRST O_EXCL open must win
    (the removed O_CREAT probe used to create the file and doom it), the marker
    carries the holder pid, a live holder refuses a second claim, and release
    removes the marker."""
    _reset()
    with (
        mock.patch.object(pl, "fcntl", None),
        mock.patch.object(pl.os, "name", "nt"),
        mock.patch.object(pl, "_pid_alive", return_value=True),
    ):
        key = _fresh_key(tmp)
        lock_path = pl._local_lock_path(key)
        h = pl.ProjectLock.acquire(key)
        check(
            h is not None and h.fd is None and h.marker == lock_path,
            "nt claim is an O_EXCL marker file (old probe-then-O_EXCL could never win)",
        )
        with open(lock_path, encoding="ascii") as f:
            check(f.read().strip() == str(os.getpid()), "marker carries the holder pid")
        _reset()  # pretend a second process/window is claiming
        check(pl.ProjectLock.acquire(key) is None, "a live holder's marker refuses the second claim")
        _reset()
        h3 = pl.ProjectLock.acquire(key)
        check(h3 is None, "still refused while the live marker exists")
        os.unlink(lock_path)
        _reset()
        h4 = pl.ProjectLock.acquire(key)
        check(h4 is not None, "after the marker is gone the claim wins")
        pl.ProjectLock.release(h)
        pl.ProjectLock.release(h4)
        check(not os.path.exists(lock_path), "release removes the marker file")
    _reset()


def test_windows_stale_marker_reclaim(tmp: str) -> None:
    """Simulated Windows reclaim: a dead holder's marker is unlinked, a live
    holder's and a garbage marker are kept (fail closed)."""
    with (
        mock.patch.object(pl, "fcntl", None),
        mock.patch.object(pl.os, "name", "nt"),
        mock.patch.object(pl, "_pid_alive", lambda pid: pid == os.getpid()),
    ):
        # dead holder: marker unlinked
        lock_path = pl._local_lock_path(_fresh_key(tmp))
        with open(lock_path, "wb") as f:
            f.write(b"99999999")
        check(pl._reclaim_stale(lock_path) is True, "a dead holder's marker is reclaimed")
        check(not os.path.exists(lock_path), "reclaim unlinks the stale marker")
        # live holder: kept
        with open(lock_path, "wb") as f:
            f.write(str(os.getpid()).encode("ascii"))
        check(pl._reclaim_stale(lock_path) is False, "a live holder's marker is kept")
        check(os.path.exists(lock_path), "live marker survives the reclaim attempt")
        # garbage: kept (conservative)
        with open(lock_path, "wb") as f:
            f.write(b"not-a-pid")
        check(pl._reclaim_stale(lock_path) is False, "a garbage marker is treated as held")
        check(os.path.exists(lock_path), "garbage marker is not stolen")
        os.unlink(lock_path)

        # full flow: acquire reclaims a stale marker and wins on the retry
        key = _fresh_key(tmp)
        lock_path = pl._local_lock_path(key)
        with open(lock_path, "wb") as f:
            f.write(b"99999999")  # dead holder's leftover
        _reset()
        h = pl.ProjectLock.acquire(key)
        check(h is not None, "acquire reclaims a dead holder's marker and wins")
        pl.ProjectLock.release(h)


def test_release_all(tmp: str) -> None:
    """release_all drops every held lock (backend mode switch) and cleans up."""
    with (
        mock.patch.object(pl, "fcntl", None),
        mock.patch.object(pl.os, "name", "nt"),
        mock.patch.object(pl, "_pid_alive", return_value=True),
    ):
        _reset()
        keys = [_fresh_key(tmp) for _ in range(2)]
        handles = [pl.ProjectLock.acquire(k) for k in keys]
        check(all(h is not None for h in handles), "both claims hold")
        pl.ProjectLock.release_all()
        check(pl.ProjectLock._held == {}, "release_all forgets every handle")
        check(all(not os.path.exists(pl._local_lock_path(k)) for k in keys), "release_all removes every marker")
    _reset()


if __name__ == "__main__":
    tmp = tempfile.mkdtemp(prefix="clutch-lock-test-")
    try:
        test_posix_flock_claim_and_self_reuse(tmp)
        test_posix_pid_liveness()
        test_windows_claim_uses_pid_marker(tmp)
        test_windows_stale_marker_reclaim(tmp)
        test_release_all(tmp)
    finally:
        for name in os.listdir(tmp):
            os.unlink(os.path.join(tmp, name))
        os.rmdir(tmp)
    print("project_lock_test: all checks passed")
