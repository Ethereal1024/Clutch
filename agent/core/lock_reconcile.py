"""The ONE reconciler for .clc write locks: who holds each lock, and may it stay?

Every other liveness rule in this tree is a promise: a heartbeat that the client
promises to send, a subscriber count the client promises to drop, a grace period
that guesses how long a disconnected client might come back. Promises cannot
separate the two cases that matter, because both look identical from the inside:

  * a window that is GONE (closed, crashed) — its lock must be released now
  * a window that is merely SILENT (a phone in the background is frozen, timers
    included) — its lock must be kept, however long the silence lasts

That is why every timeout in this tree (300s, 600s, "detached") is a guess that
is wrong for one of the two cases. This module uses facts instead: the lock file
carries an owner record naming the OS process that claimed the session
(agent/core/project_lock.py), and whether that process still exists is a kernel
fact (agent/core/procstat.py: pid + starttime + boot_id, so a recycled pid is not
mistaken for the process that recorded it). A frozen window's process exists; a
closed window's process does not. The two cases separate without a clock.

Only ONE thing may be revoked, and only on positive proof:

    state       kernel says        record says              who may free it
    ---------   ----------------   ----------------------   -------------------
    free        not held           -                        nobody (nothing held)
    stale       not held           a record                this module (blank it)
    live        held               holder + claim alive     nobody
    unclaimed   held               no claim identity        nobody (report only)
    unverifiable held              claim on another host    nobody (report only)
    ghost       held               holder process dead      nobody (fd inherited)
    orphan      held               holder alive, claim dead this module, after
                                                            asking the session
                                                            whether a run is live

``orphan`` is the case the accidents were made of: a session process that
outlived the window it served. Its own liveness is not the question — the WINDOW
is what the lock is for, and the window's process is gone. Before terminating it
the reconciler asks the session (through its /api/health, passed in as
``run_state``) whether a run is in flight: a run that is still working outlives
its window by design, so a POSITIVE answer earns it more time — with no timer at
all, and the next pass asks again. A doubt is not that answer.

Revocation is ordinary: SIGTERM the session's process group (the supervisor
spawns it as its own group leader), then wait for the KERNEL to drop the flock —
the only proof that a lock is free — and only then blank the record. Nothing
here unlinks a lock file, and nothing here takes a lock it would keep.

Who runs it: the per-machine supervisor (agent/supervisor.py), every
RECONCILE_INTERVAL_S, because it is the process that already outlives windows
and owns the sessions. The scan is idempotent, so running it twice is harmless.
It sees the locks in THIS user's temp dir — the same place a session of this user
creates them (see project_lock._local_lock_path).
"""

from __future__ import annotations

import glob
import json
import os
import signal
import time
from dataclasses import dataclass
from typing import Callable

from . import procstat
from .project_lock import ProjectLock, lock_dir

RECONCILE_INTERVAL_S = 30.0
# How long a terminated holder may take to let go, before we escalate. Not a
# liveness guess: the session has already been proven windowless, and this is
# only the time a process needs to die (flock is released at exit, before it is
# reaped).
REVOKE_GRACE_S = 8.0

# Every state scan() may report. Only "stale" and "orphan" are actionable.
FREE = "free"
STALE = "stale"
LIVE = "live"
UNCLAIMED = "unclaimed"
UNVERIFIABLE = "unverifiable"
GHOST = "ghost"
ORPHAN = "orphan"
UNOWNED = "unowned"

# Answers `run_state(port)` may give (see agent/supervisor.py session_run_state):
# True = a run is live, False = the session proved itself idle, None = a doubt.
RunState = Callable[[int], "bool | None"]


@dataclass
class LockState:
    """One lock file, as the kernel and the record together describe it."""

    project: str | None  # the .clc the record names; None when the record is unreadable
    lock_path: str
    held: bool
    state: str
    owner: dict | None = None
    holder_state: str = "unknown"  # procstat verdict on the recorded holder pid
    claim_state: str = "unknown"  # ... on the recorded claim pid
    detail: str = ""

    def as_dict(self) -> dict:
        return {
            "project": self.project,
            "lock_path": self.lock_path,
            "held": self.held,
            "state": self.state,
            "owner": self.owner,
            "holder_state": self.holder_state,
            "claim_state": self.claim_state,
            "detail": self.detail,
        }


def _classify(held: bool, owner: dict | None) -> tuple[str, str, str, str]:
    """(state, holder_state, claim_state, detail) for one lock."""
    if not held:
        if owner is not None:
            return STALE, "dead", "dead", "the holder is gone; the kernel freed the lock"
        return FREE, "unknown", "unknown", ""
    if owner is None:
        return (
            UNOWNED,
            "unknown",
            "unknown",
            "held by a lock file with no owner record (a build before records)",
        )
    holder = procstat.state(owner.get("pid"), owner.get("starttime", ""), owner.get("boot_id", ""))
    if holder != "live":
        return (
            GHOST,
            holder,
            "unknown",
            "the recorded holder is gone but the lock is still held: a descendant inherited the fd",
        )
    claim_pid = owner.get("claim_pid")
    if not isinstance(claim_pid, int):
        return (
            UNCLAIMED,
            holder,
            "unknown",
            "the holder names no claiming window process, so its window cannot be verified here",
        )
    claim = procstat.state(claim_pid, owner.get("claim_start", ""), owner.get("boot_id", ""))
    if claim == "live":
        return LIVE, holder, claim, "the window that claimed it is alive"
    if claim == "dead":
        return ORPHAN, holder, claim, "the window that claimed it is gone"
    return (
        UNVERIFIABLE,
        holder,
        claim,
        "the claiming process cannot be seen from this host (a remote claim)",
    )


def scan(tmp: str | None = None) -> list[LockState]:
    """Every lock in the temp dir, classified. Read-only: it never takes a lock
    it would keep and never signals anything."""
    directory = tmp or lock_dir()
    states: list[LockState] = []
    for lock_path in sorted(glob.glob(os.path.join(directory, "clutch-*.lock"))):
        owner = _read(lock_path)
        # "Is it held?" is asked of the lock FILE, which is the thing the kernel
        # locks. The record only says who, and may be missing (an older holder).
        held = _held_by_path(lock_path)
        state, holder_state, claim_state, detail = _classify(held, owner)
        states.append(
            LockState(
                project=(owner or {}).get("project"),
                lock_path=lock_path,
                held=held,
                state=state,
                owner=owner,
                holder_state=holder_state,
                claim_state=claim_state,
                detail=detail,
            )
        )
    return states


def _read(lock_path: str) -> dict | None:
    """A record read straight off a lock file (ProjectLock.owner takes a .clc
    path; the scan has the lock file itself)."""
    try:
        with open(lock_path, "rb") as f:
            raw = f.read(4096)
    except OSError:
        return None
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("v") != 1 or not isinstance(record.get("pid"), int):
        return None
    return record


def _held_by_path(lock_path: str) -> bool:
    """Is this LOCK FILE held? (A record-less lock names no project, so the
    question is asked of the file, not of a .clc path.)"""
    from .project_lock import _trial_locked

    return _trial_locked(lock_path)


def _await_free(project: str | None, lock_path: str, grace: float) -> bool:
    """Wait for the KERNEL to drop the lock. Its release is the only proof that
    the holder is really gone; a killed process keeps the lock until it exits."""
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        held = ProjectLock.inspect(project)["held"] if project else _held_by_path(lock_path)
        if not held:
            return True
        time.sleep(0.05)
    return False


def _signal(pid: int, sig: int) -> None:
    """Signal a session's process GROUP when it leads one (the supervisor spawns
    every session with start_new_session=True), so its tool children go with it;
    a pid that does not lead its group gets the signal alone."""
    try:
        if os.name == "posix" and os.getpgid(pid) == pid:
            os.killpg(pid, sig)
        else:
            os.kill(pid, sig)
    except OSError:
        pass


def revoke(lock: LockState, *, grace: float = REVOKE_GRACE_S) -> tuple[bool, str]:
    """Terminate a PROVEN windowless holder and wait for the kernel to free its
    lock. Returns (freed, why). Callers must have proven the claim dead: this
    function trusts its argument and does not second-guess it."""
    owner = lock.owner or {}
    pid = owner.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False, "no holder pid in the record"
    started, boot = owner.get("starttime", ""), owner.get("boot_id", "")
    # Re-check the identity IMMEDIATELY before signalling: the scan may be
    # seconds old, and a recycled pid would be a stranger's process.
    if procstat.state(pid, started, boot) != "live":
        return _await_free(lock.project, lock.lock_path, grace), "holder already gone"
    _signal(pid, signal.SIGTERM)
    if _await_free(lock.project, lock.lock_path, grace):
        return True, "terminated"
    if procstat.state(pid, started, boot) == "live":
        _signal(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
    return _await_free(lock.project, lock.lock_path, grace), "killed"


def reconcile(
    *,
    force: bool = False,
    run_state: RunState | None = None,
    tmp: str | None = None,
    log: Callable[[str], None] | None = None,
    grace: float = REVOKE_GRACE_S,
) -> dict:
    """One pass: clear stale records, revoke proven orphans, report the rest.

    ``force`` is the user's own hand (the UI's one-click reclaim): it revokes a
    proven orphan even when its session reports a run in flight, because a user
    looking at a locked project is the only authority on whether that run is
    still wanted. Without it, a live run is left alone — and no timer overrules
    it either way.
    """
    say = log or (lambda _msg: None)
    report: dict = {"scanned": 0, "cleared": [], "revoked": [], "kept": [], "errors": []}
    for lock in scan(tmp):
        report["scanned"] += 1
        if lock.state == STALE:
            if lock.project and ProjectLock.blank_record(lock.project):
                report["cleared"].append(lock.project)
                say(f"[locks] cleared a stale record: {lock.project}")
            continue
        if lock.state != ORPHAN:
            if lock.held:
                report["kept"].append(lock.as_dict())
            continue
        port = (lock.owner or {}).get("port")
        run = None
        if not force and run_state is not None and isinstance(port, int):
            try:
                run = run_state(port)
            except Exception:  # noqa: BLE001 - a probe must never break the pass
                run = None
        if run is True:
            kept = lock.as_dict()
            kept["detail"] = "the window is gone but a run is in flight - left alone"
            report["kept"].append(kept)
            say(f"[locks] {lock.project}: window gone, run in flight - not revoking")
            continue
        try:
            freed, why = revoke(lock, grace=grace)
        except Exception as err:  # noqa: BLE001
            report["errors"].append({"project": lock.project, "error": str(err)})
            continue
        if freed:
            if lock.project:
                ProjectLock.blank_record(lock.project)
            report["revoked"].append({"project": lock.project, "pid": (lock.owner or {}).get("pid"), "why": why})
            say(f"[locks] revoked the orphan holding {lock.project} ({why})")
        else:
            report["errors"].append({"project": lock.project, "error": f"lock still held after {why}"})
            say(f"[locks] {lock.project}: {why}, but the lock is still held")
    return report


def reclaim(project: str, *, log: Callable[[str], None] | None = None) -> dict:
    """The user's one-click reclaim of ONE project: revoke it if — and only if —
    its holder is a PROVEN orphan (a live window is never taken away by a
    button; the UI can report that instead).

    Returns the lock before the attempt, what was done, and why, so the UI can
    say what actually happened instead of assuming it worked."""
    key = os.path.abspath(project)
    before = ProjectLock.inspect(key)
    target = _state_for_lock(before)
    report: dict = {"project": key, "before": before, "revoked": False, "why": ""}
    if not before["held"]:
        if ProjectLock.blank_record(key):
            report["why"] = "the lock was already free; its record is cleared"
        else:
            report["why"] = "the lock was already free"
        return report
    if target.state != ORPHAN:
        report["why"] = target.detail or "the holder is not a proven orphan"
        return report
    freed, why = revoke(target)
    if freed:
        ProjectLock.blank_record(key)
        report["revoked"] = True
        report["why"] = why
        if log:
            log(f"[locks] user reclaimed {key}: {why}")
    else:
        report["why"] = f"{why}, but the lock is still held"
    return report


def _state_for_lock(inspect: dict) -> LockState:
    owner = inspect.get("owner")
    state, holder_state, claim_state, detail = _classify(inspect["held"], owner)
    return LockState(
        project=inspect["project"],
        lock_path=inspect["lock_path"],
        held=inspect["held"],
        state=state,
        owner=owner,
        holder_state=holder_state,
        claim_state=claim_state,
        detail=detail,
    )


def loop(
    interval_s: float = RECONCILE_INTERVAL_S,
    *,
    run_state: RunState | None = None,
    log: Callable[[str], None] | None = None,
    stop=None,
) -> None:
    """Run reconcile() every ``interval_s`` until ``stop`` is set. Never raises:
    a broken pass must not end the loop (the locks would then never be
    reconciled again, which is the silence every patch in this area died of)."""
    while stop is None or not stop.is_set():
        try:
            reconcile(run_state=run_state, log=log)
        except Exception as err:  # noqa: BLE001
            if log:
                log(f"[locks] reconcile pass failed: {err}")
        if stop is not None:
            stop.wait(interval_s)
        else:
            time.sleep(interval_s)
