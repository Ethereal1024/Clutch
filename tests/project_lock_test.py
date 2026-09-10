"""ProjectLock must hold up on BOTH host platforms.

The lock is an OS-level file lock: an flock on POSIX, a byte-range lock
(LockFileEx, through msvcrt.locking) on Windows. Both are KERNEL locks — the OS
drops the lock when the holding process dies — so the property that matters is
not only "a second claim is refused" but "a KILLED holder frees it". Proving
that needs a real second process, which is why these tests spawn one: the
pid-marker design this replaced could be exercised with mocks, a kernel lock
cannot.

Run: uv run python -m tests.project_lock_test
"""

from __future__ import annotations

import itertools
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from agent.core import project_lock as pl
from tests.testsupport import check

ROOT = Path(__file__).resolve().parents[1]

_counter = itertools.count()


def _fresh_key(tmp: str) -> str:
    """A unique fake .clc path (the lock path is derived from it, so each test
    gets its own lock file in the same temp dir)."""
    return os.path.join(tmp, f"proj-{os.getpid()}-{next(_counter)}.clc")


def _reset() -> None:
    pl.ProjectLock._held.clear()


def test_claim_and_self_reuse(tmp: str) -> None:
    """The host's REAL backend end to end: the claim holds, a same-process
    reopen reuses it (never self-conflicts), a second independent claim is
    refused (both an flock and a byte-range lock are exclusive even between two
    handles of one process), and release frees it for the next claim."""
    _reset()
    key = _fresh_key(tmp)
    h = pl.ProjectLock.acquire(key)
    check(h is not None, "the claim holds on the host's own backend")
    check((h.fd is None) != (h.file is None), "the handle names exactly one backend (flock fd / locked file)")
    check(pl.ProjectLock.acquire(key) is h, "same-process reopen reuses the held lock (never self-conflicts)")
    check(pl.ProjectLock._acquire_local(key) is None, "a second independent claim is refused while held")
    pl.ProjectLock.release(h)
    check(pl.ProjectLock._held == {}, "release forgets the handle")
    h2 = pl.ProjectLock._acquire_local(key)
    check(h2 is not None, "release frees the lock for the next claim")
    pl.ProjectLock.release(h2)
    check(os.path.exists(pl._local_lock_path(key)), "the lock FILE is reused, never deleted")
    os.unlink(pl._local_lock_path(key))  # tidy this test's own temp lock file


def test_cross_process_refusal_and_crash_release(tmp: str) -> None:
    """A REAL second process. The child claims the key and reports; the parent
    must be refused while the child lives, and must win right after the child is
    KILLED — no pid check, no liveness probe, no hand-deleting a stale marker
    (each of which was a real failure mode of the pid-marker design: an
    unreadable pid read as "dead", a recycled pid read as "still held")."""
    _reset()
    key = _fresh_key(tmp)
    lock_path = pl._local_lock_path(key)
    child = subprocess.Popen(
        [sys.executable, "-m", "tests.project_lock_test", "--hold", key],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        line = child.stdout.readline().strip()
        check(line == "held", f"a real second process claims the lock (child said {line!r})")
        check(pl.ProjectLock.acquire(key) is None, "the parent's claim is refused while the child holds it")
        child.kill()
        child.wait(timeout=10)
        h = None
        for _ in range(50):  # the OS drops the lock at process death
            h = pl.ProjectLock.acquire(key)
            if h is not None:
                break
            time.sleep(0.1)
        check(h is not None, "the OS frees the lock when the holder is KILLED (crash-safe, no reclaim code)")
        pl.ProjectLock.release(h)
        h2 = pl.ProjectLock.acquire(key)
        check(h2 is not None, "the lock is claimable again after the release")
        pl.ProjectLock.release(h2)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        os.unlink(lock_path)


def test_release_all(tmp: str) -> None:
    """release_all drops every held lock (backend mode switch) and frees them
    for the next claim."""
    _reset()
    keys = [_fresh_key(tmp) for _ in range(2)]
    handles = [pl.ProjectLock.acquire(k) for k in keys]
    check(all(h is not None for h in handles), "both claims hold")
    pl.ProjectLock.release_all()
    check(pl.ProjectLock._held == {}, "release_all forgets every handle")
    again = pl.ProjectLock.acquire(keys[0])
    check(again is not None, "release_all frees the locks for the next claim")
    check(pl.ProjectLock.acquire(keys[1]) is not None, "the second lock is free too")
    pl.ProjectLock.release_all()
    for k in keys:
        os.unlink(pl._local_lock_path(k))  # tidy this test's own temp lock files


def _hold(key: str) -> int:
    """Child mode (`--hold <key>`): take the lock, report on stdout, then wait to
    be killed — the crash-release test needs a holder that never cleans up."""
    h = pl.ProjectLock.acquire(key)
    print("held" if h is not None else "refused", flush=True)
    while True:
        time.sleep(1)


if __name__ == "__main__":
    if "--hold" in sys.argv:
        sys.exit(_hold(sys.argv[sys.argv.index("--hold") + 1]))
    tmp = tempfile.mkdtemp(prefix="clutch-lock-test-")
    try:
        test_claim_and_self_reuse(tmp)
        test_cross_process_refusal_and_crash_release(tmp)
        test_release_all(tmp)
    finally:
        for name in os.listdir(tmp):
            os.unlink(os.path.join(tmp, name))
        os.rmdir(tmp)
    print("project_lock_test: all checks passed")
