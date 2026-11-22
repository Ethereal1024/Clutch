"""The session's own answer to "the app that claimed me is gone".

Every other guard in this tree is somebody ELSE noticing, and every one of them
fails the same way:

  * the client's quit hook (ui/src/host/main.ts) runs no code at all after a
    SIGKILL, a crash, or a power cut;
  * the supervisor's reconciler (agent/core/lock_reconcile.py) needs a pass —
    30 s and a grace period — before it even looks;
  * the reaper waits out the heartbeat window (300 s) first.

In each of those gaps the process that holds the .clc write lock outlives the
app that claimed it, and the next start opens onto a lock nobody is using (the
"Take this project back?" prompt).

This module closes the gap from the INSIDE, in the only process that can: the
session asks the kernel one question per second — "does the process that
claimed me still exist?" — and ends itself the moment the answer is "no".

Two things make that a fact rather than another guess:

  * liveness is (pid, starttime, boot_id), never a bare pid (agent/core/procstat):
    a recycled pid cannot pass for the claiming process, and an unreadable
    process is "unknown", never "dead". Only positive proof ends the session.
  * the session holds the lock, so its exit IS the release: the kernel drops the
    flock / byte-range lock when the process goes (agent/core/project_lock.py),
    with no record to trust and no TTL to expire.

A claim that names another machine (a tunnelled session: the client's pid lives
on the client) can never be checked here and therefore never fires — a remote
host has no business guessing about a process it cannot see. That case is the
client's own job, through the same explicit release POST the quit gate sends.
"""

from __future__ import annotations

import threading
import time

from . import procstat

# How often the session asks. One second is the whole latency budget of this
# design: a closed window, a crashed shell and a SIGKILLed Electron are one fact
# (the process is gone) and it is answered within a second — instead of the
# reconciler's 30 s, the reaper's 300 s, or never.
CLAIM_POLL_S = 1.0


def verdict(claim_pid, claim_start="", boot="") -> str:
    """The kernel's answer about the claiming process: live | dead | unknown.

    Thin on purpose: the one place that decides what "gone" means is
    agent/core/procstat.state (pid + start tick + boot), so this module and the
    lock reconciler can never disagree about the same process.
    """
    return procstat.state(claim_pid, claim_start or "", boot)


def watch(claim_pid, claim_start, on_gone, *, poll_s=CLAIM_POLL_S, boot="", stop=None):
    """Call ``on_gone()`` once when the claiming process is PROVEN gone.

    Returns the watcher thread, or None when there is nothing to watch: a
    session claimed without an OS process (the Android bridge, a build from
    before claims existed) can never be proven windowless, and guessing is
    exactly what this replaces.

    ``on_gone`` runs on the watcher thread, so it must end the process itself
    (see agent/server.py's _claim_gone): the caller's main thread is inside
    serve_forever and only a signal / an exit gets it out.
    """
    if not isinstance(claim_pid, int) or claim_pid <= 0:
        return None

    def _loop():
        while stop is None or not stop.is_set():
            if stop is not None:
                # a Set event wakes this immediately; the poll stays the bound
                # for production, where there is no stop flag at all
                if stop.wait(poll_s):
                    return
            else:
                time.sleep(poll_s)
            if verdict(claim_pid, claim_start, boot) == "dead":
                on_gone()
                return

    t = threading.Thread(target=_loop, name="clutch-claim-watch", daemon=True)
    t.start()
    return t
