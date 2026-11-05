"""The lock reconciler must free a .clc whose WINDOW is gone, and must not touch
one whose window is merely silent.

Both halves need real processes, because the whole point is that the kernel
decides: a holder that exists, a holder that exited, a claimant that was frozen
(SIGSTOP) versus one that was killed. Mocks would only prove the regex.

Run: uv run python -m tests.lock_reconcile_test
"""

from __future__ import annotations

import itertools
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from agent.core import lock_reconcile as lr
from agent.core import procstat
from agent.core import project_lock as pl
from tests.testsupport import check

ROOT = Path(__file__).resolve().parents[1]
_counter = itertools.count()


def _key(tmp: str) -> str:
    """A unique .clc path under the isolated lock dir."""
    return os.path.join(tmp, f"proj-{os.getpid()}-{next(_counter)}.clc")


def _spawn(*args: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-m", "tests.lock_reconcile_test", *args],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def _await_line(proc: subprocess.Popen, want: str) -> str:
    """Read the child's stdout until its handshake word. The child also prints
    its own check() lines ("ok: ...") on the way there, so those are skipped —
    but a FAIL is news, and silence (the child died) is louder."""
    while True:
        raw = proc.stdout.readline()
        if not raw:
            raise AssertionError(f"child exited before reporting {want!r} (rc={proc.poll()})")
        line = raw.strip()
        if line.startswith("FAIL:"):
            raise AssertionError(f"child refused to hold: {line}")
        if line.startswith("ok:"):
            continue
        check(line == want, f"child reported {line!r}, expected {want!r}")
        return line


def _state_of(key: str) -> lr.LockState | None:
    """The scan entry for one .clc. Matched by lock FILE as well as by project:
    a lock with no readable record (an older holder) names no project at all."""
    lock_path = pl._local_lock_path(os.path.abspath(key))
    for state in lr.scan():
        if state.lock_path == lock_path:
            return state
    return None


def _await_state(key: str, want: str | tuple[str, ...], timeout: float = 10.0) -> lr.LockState:
    wants = (want,) if isinstance(want, str) else want
    deadline = time.monotonic() + timeout
    seen = ""
    while time.monotonic() < deadline:
        state = _state_of(key)
        if state is not None:
            seen = state.state
            if state.state in wants:
                return state
        time.sleep(0.05)
    raise AssertionError(f"lock state {seen!r} never became one of {wants!r}")


def _await_gone(proc: subprocess.Popen, timeout: float = 15.0) -> None:
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
        raise AssertionError("the holder survived revocation") from None


def test_record_roundtrip(tmp: str) -> None:
    """The holder DESCRIBES itself: pid, start tick, boot, project, host, since —
    and the description leaves with the lock."""
    pl.ProjectLock._held.clear()
    key = _key(tmp)
    me = procstat.identity(os.getpid())
    h = pl.ProjectLock.acquire(key)
    check(h is not None, "the claim holds")
    owner = pl.ProjectLock.owner(key)
    check(owner is not None, "a held lock carries an owner record")
    check(owner["pid"] == os.getpid(), "the record names the holding pid")
    check(owner["starttime"] == me["starttime"], "the record pins the holder's start tick (not just a pid)")
    check(owner["boot_id"] == me["boot_id"], "the record pins the boot the tick belongs to")
    check(owner["project"] == os.path.abspath(key), "the record names the project it locks")
    check(isinstance(owner.get("since"), (int, float)), "the record says since when")
    check(pl.ProjectLock.inspect(key)["held"], "the kernel agrees the lock is held")
    check(_state_of(key).state in ("live", "unclaimed"), "a held lock is not reported free")
    pl.ProjectLock.annotate(h, port=1234, claim="window")
    check(pl.ProjectLock.owner(key)["port"] == 1234, "annotate adds facts the holder learned later")
    pl.ProjectLock.release(h)
    check(pl.ProjectLock.owner(key) is None, "a released lock stops claiming an owner")
    check(not pl.ProjectLock.inspect(key)["held"], "the kernel agrees it is free")
    os.unlink(pl._local_lock_path(key))


def test_killed_holder_leaves_a_stale_record_and_is_cleared(tmp: str) -> None:
    """A holder killed outright frees the lock (kernel) but leaves its record
    behind: "stale" — free, with a description of somebody gone. The reconciler
    blanks it, and only because the kernel says nobody holds it."""
    pl.ProjectLock._held.clear()
    key = _key(tmp)
    child = _spawn("--hold", key, "no-claim")
    try:
        _await_line(child, "held")
        # no claim identity was given, so the record cannot name a window: the
        # lock is "unclaimed", which is still held and still attributed to a
        # live holder (never revoked for lack of a claim).
        state = _await_state(key, ("live", "unclaimed"))
        check(state.held, "the child's lock is held")
        child.kill()
        child.wait(timeout=10)
        state = _await_state(key, "stale")
        check(state.owner is not None, "the dead child's record is still there")
        check(state.holder_state == "dead", "the record's pid is reported dead, not unknown")
        report = lr.reconcile()
        check(os.path.abspath(key) in report["cleared"], f"the stale record was cleared ({report})")
        check(pl.ProjectLock.owner(key) is None, "no record is left claiming a dead holder")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        os.unlink(pl._local_lock_path(key))


def test_dead_window_revokes_the_session(tmp: str) -> None:
    """THE accident: a session process outlives the window that claimed it. The
    window is a real process here; killing it is what a closed window does."""
    pl.ProjectLock._held.clear()
    key = _key(tmp)
    claimant = _spawn("--claimant")
    _await_line(claimant, "claimant")
    child = _spawn("--hold", key, str(claimant.pid))
    try:
        _await_line(child, "held")
        state = _await_state(key, "live")
        check(state.claim_state == "live", "the claiming window is alive: the lock stays")
        report = lr.reconcile()
        check(report["revoked"] == [], "a live window's lock is never revoked")
        check(child.poll() is None, "the session survives with its window")

        claimant.kill()
        claimant.wait(timeout=10)
        state = _await_state(key, "orphan")
        check(state.holder_state == "live", "the session itself is still running (that is the trap)")
        check(state.claim_state == "dead", "the window that claimed it is provably gone")
        report = lr.reconcile()
        check(len(report["revoked"]) == 1, f"the orphaned session was revoked ({report})")
        _await_gone(child)
        check(not pl.ProjectLock.inspect(key)["held"], "the kernel freed the lock with the session")
        check(pl.ProjectLock.owner(key) is None, "and the record went with it")
    finally:
        for p in (child, claimant):
            if p.poll() is None:
                p.kill()
                p.wait(timeout=10)
        os.unlink(pl._local_lock_path(key))


def test_frozen_window_keeps_its_lock(tmp: str) -> None:
    """A backgrounded phone: its process EXISTS but runs no timer. That must keep
    the lock — the case every timeout in this tree got wrong."""
    pl.ProjectLock._held.clear()
    key = _key(tmp)
    claimant = _spawn("--claimant")
    _await_line(claimant, "claimant")
    child = _spawn("--hold", key, str(claimant.pid))
    try:
        _await_line(child, "held")
        _await_state(key, "live")
        os.kill(claimant.pid, signal.SIGSTOP)  # frozen, not dead
        try:
            state = _await_state(key, "live")
            check(state.claim_state == "live", "a frozen window still exists, so its claim stands")
            report = lr.reconcile()
            check(report["revoked"] == [] and child.poll() is None, "a frozen window loses nothing")
        finally:
            os.kill(claimant.pid, signal.SIGCONT)
    finally:
        for p in (child, claimant):
            if p.poll() is None:
                p.kill()
                p.wait(timeout=10)
        os.unlink(pl._local_lock_path(key))


def test_run_in_flight_is_left_alone_until_forced(tmp: str) -> None:
    """A run that outlives its window is the one case that may keep the lock: the
    session itself answers that a run is live, and no clock overrules it."""
    pl.ProjectLock._held.clear()
    key = _key(tmp)
    claimant = _spawn("--claimant")
    _await_line(claimant, "claimant")
    child = _spawn("--hold", key, str(claimant.pid))
    try:
        _await_line(child, "held")
        _await_state(key, "live")
        claimant.kill()
        claimant.wait(timeout=10)
        _await_state(key, "orphan")
        report = lr.reconcile(run_state=lambda _port: True)
        check(report["revoked"] == [], "a live run keeps its session and its lock")
        check(child.poll() is None, "the session is untouched")
        freed, why = lr.revoke(_await_state(key, "orphan"))
        check(freed, f"the user's own reclaim still works on it ({why})")
        _await_gone(child)
        check(not pl.ProjectLock.inspect(key)["held"], "and the lock comes free")
    finally:
        for p in (child, claimant):
            if p.poll() is None:
                p.kill()
                p.wait(timeout=10)
        os.unlink(pl._local_lock_path(key))


def test_ghost_and_unowned_are_reported_not_killed(tmp: str) -> None:
    """Two states this module must NOT act on.

    ghost: the record's holder is dead but the lock is still held — a descendant
    inherited the fd. Killing the recorded pid would kill nothing (it is gone);
    the holder cannot be named, so the report is all there is.
    unowned: a lock held by a build that wrote no record. Nothing to verify.
    """
    pl.ProjectLock._held.clear()
    key = _key(tmp)
    child = _spawn("--ghost", key)
    try:
        _await_line(child, "held")
        state = _await_state(key, "ghost")
        check(state.held and state.holder_state == "dead", "the fd outlived the recorded holder")
        report = lr.reconcile()
        check(report["revoked"] == [], "an unnameable holder is never signalled")
        check(state.state == "ghost", "and it is reported as a ghost")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        try:
            os.unlink(pl._local_lock_path(key))
        except FileNotFoundError:
            pass

    key2 = _key(tmp)
    plain = _spawn("--hold", key2, "no-record")
    try:
        _await_line(plain, "held")
        state = _await_state(key2, "unowned")
        check(state.owner is None and state.held, "a record-less holder is 'unowned', still held")
        report = lr.reconcile()
        check(report["revoked"] == [] and plain.poll() is None, "unowned locks are left alone")
    finally:
        if plain.poll() is None:
            plain.kill()
            plain.wait(timeout=10)
        os.unlink(pl._local_lock_path(key2))


def test_reclaim_refuses_a_live_window(tmp: str) -> None:
    """The UI's one-click reclaim is not a licence to shoot a live window."""
    pl.ProjectLock._held.clear()
    key = _key(tmp)
    claimant = _spawn("--claimant")
    _await_line(claimant, "claimant")
    child = _spawn("--hold", key, str(claimant.pid))
    try:
        _await_line(child, "held")
        _await_state(key, "live")
        verdict = lr.reclaim(key)
        check(verdict["revoked"] is False, "a live window's lock is refused")
        check(child.poll() is None and pl.ProjectLock.inspect(key)["held"], "and stays held")
        claimant.kill()
        claimant.wait(timeout=10)
        _await_state(key, "orphan")
        verdict = lr.reclaim(key)
        check(verdict["revoked"] is True, f"a proven orphan is reclaimed ({verdict})")
        _await_gone(child)
        check(not pl.ProjectLock.inspect(key)["held"], "the project is openable again")
    finally:
        for p in (child, claimant):
            if p.poll() is None:
                p.kill()
                p.wait(timeout=10)
        os.unlink(pl._local_lock_path(key))


# ---- child modes -------------------------------------------------------------


def _child_hold(key: str, claim: str) -> int:
    """Hold a lock like a session does, then wait to be killed."""
    # A session learns its own port before it opens any project, so its records
    # carry one (reconcile needs it to ask /api/health whether a run is live).
    pl.set_context(port=19400)
    if claim and claim != "no-claim" and claim != "no-record":
        # what agent.server does from --claim-pid: name the window process and
        # pin ITS start tick, so a recycled pid cannot pass for that window
        ident = procstat.identity(int(claim))
        check(ident is not None, "the child was handed a live claim pid")
        pl.set_context(claim="window", claim_pid=int(claim), claim_start=ident["starttime"])
    if claim == "no-record":
        handle = pl.ProjectLock._acquire_local(os.path.abspath(key))
    else:
        handle = pl.ProjectLock.acquire(key)
    print("held" if handle is not None else "refused", flush=True)
    while True:
        time.sleep(1)


def _child_ghost(key: str) -> int:
    """Take a lock, then fork: the parent exits (so the RECORD's pid dies) while
    the child keeps the inherited fd — the one way a held lock can name a dead
    holder."""
    handle = pl.ProjectLock.acquire(key)
    print("held" if handle is not None else "refused", flush=True)
    if handle is None:
        return 1
    pid = os.fork()
    if pid == 0:  # the fd holder: no record of its own, no cleanup
        while True:
            time.sleep(1)
    os._exit(0)  # the recorded holder exits while the fork keeps the lock


def _child_claimant() -> int:
    print("claimant", flush=True)
    while True:
        time.sleep(1)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        tmp = tempfile.mkdtemp(prefix="clutch-lockdir-")
        os.environ["CLUTCH_LOCK_DIR"] = tmp  # every child inherits it
        try:
            test_record_roundtrip(tmp)
            test_killed_holder_leaves_a_stale_record_and_is_cleared(tmp)
            test_dead_window_revokes_the_session(tmp)
            if hasattr(os, "fork") and os.name == "posix":
                test_frozen_window_keeps_its_lock(tmp)
            test_run_in_flight_is_left_alone_until_forced(tmp)
            if hasattr(os, "fork") and os.name == "posix":
                test_ghost_and_unowned_are_reported_not_killed(tmp)
            test_reclaim_refuses_a_live_window(tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        print("lock_reconcile_test: all checks passed")
        sys.exit(0)
    if args[0] == "--claimant":
        sys.exit(_child_claimant())
    if args[0] == "--hold":
        sys.exit(_child_hold(args[1], args[2] if len(args) > 2 else "no-claim"))
    if args[0] == "--ghost":
        sys.exit(_child_ghost(args[1]))
    raise SystemExit(f"unknown mode: {args[0]}")
