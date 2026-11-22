"""The .clc write lock must die with the app that claimed it — even when the app
is SIGKILLed, crashes, or the machine's UI is gone with no chance to send a
release. Two mechanisms answer that, and both are checked here with real
processes, because the whole point is that the KERNEL decides:

  * the session's own watchdog (agent/core/claim_watch.py) asks the kernel once
    a second whether the claiming process still exists, and ends the session
    when the answer is a proven "no". Its exit IS the release: the flock goes
    with the process, no record to trust and no TTL to expire.
  * the supervisor's release ladder (agent/supervisor.py stop_session) reads the
    same fact when a client says goodbye: a claim proven dead stops the child
    even while an `in_flight` lease is still unexpired, because the run loop
    lives in the client that no longer exists. A claim this host CANNOT see (a
    tunnel's client pid lives on the client) is doubt, and doubt never ends work.

Cases that must NOT fire matter as much as the ones that must: an unreadable
process is "unknown" (never "dead"), and a recycled pid is not the claimant.

Run: uv run python -m tests.claim_watch_test
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from agent.core import claim_watch, procstat
from agent.core.project_lock import ProjectLock
from tests.supervisor_test import start_supervisor, wait_until
from tests.testsupport import check, http_post

ROOT = Path(__file__).resolve().parents[1]
BANNER_RE = re.compile(r"\[clutch-server\] http://127\.0\.0\.1:(\d+)")


def _sleeper() -> subprocess.Popen:
    """A process this test owns completely: it can be a live claimant, or a dead
    one once it is killed (its start tick was read while it lived)."""
    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _dead_identity() -> dict:
    """A (pid, starttime) pair the kernel now calls dead — the crash case."""
    proc = _sleeper()
    ident = procstat.identity(proc.pid)
    proc.kill()
    proc.wait(timeout=10)
    check(ident is not None and procstat.state(ident["pid"], ident["starttime"]) == "dead",
          "a killed process is a proven-dead claim (pid + start tick, not a bare pid)")
    return ident


def _banner_port(proc: subprocess.Popen, seconds: float = 30.0) -> int:
    """The port a real session child picked, read off its banner."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            raise AssertionError(f"the session child exited before its banner (rc={proc.poll()})")
        m = BANNER_RE.search(line)
        if m:
            return int(m.group(1))
    raise AssertionError("the session child never printed its port banner")


def main() -> int:
    # ---- 1. nothing to watch is not "gone" ----
    # A session claimed by an OS process is the only case this module can speak
    # about. The Android bridge and a build from before claims existed have no
    # pid, and a watchdog that guessed there would end work nobody abandoned.
    fired: list[int] = []
    never = lambda: fired.append(1)  # noqa: E731 (one-line callback)
    check(claim_watch.watch(None, "", never) is None, "an OS-less claim starts no watcher")
    check(claim_watch.watch(0, "", never) is None, "and a zero pid is not a claim either")

    # ---- 2. a LIVE claim never fires, and can be stopped ----
    live = _sleeper()
    try:
        ident = procstat.identity(live.pid)
        check(ident is not None and claim_watch.verdict(live.pid, ident["starttime"]) == "live",
              "a running claimant reads 'live'")
        stop = threading.Event()
        hit = threading.Event()
        t = claim_watch.watch(live.pid, ident["starttime"], hit.set, poll_s=0.1, stop=stop)
        time.sleep(0.6)  # several polls
        check(not hit.is_set(), "a live claimant is never fired: the window is still there")
        check(t is not None and t.is_alive(), "the watcher is still polling")
        stop.set()
        t.join(2.0)
        check(not t.is_alive() and not hit.is_set(),
              "a stopped watcher exits without ever claiming the app is gone")
    finally:
        live.kill()
        live.wait(timeout=10)

    # ---- 3. the crash guarantee: a killed claimant fires the callback, once ----
    gone = _sleeper()
    ident = procstat.identity(gone.pid)
    check(ident is not None, "the claimant's identity was readable while it lived")
    hits: list[float] = []

    def on_gone() -> None:
        hits.append(time.monotonic())

    t = claim_watch.watch(gone.pid, ident["starttime"], on_gone, poll_s=0.1)
    check(t is not None, "a claimed session starts its watchdog")
    time.sleep(0.3)
    check(not hits, "nothing fires while the claimant lives")
    gone.kill()  # SIGKILL: no chance to say goodbye — exactly the Electron crash
    gone.wait(timeout=10)
    check(wait_until(lambda: bool(hits), 3.0, "the watchdog noticing a SIGKILLed claimant"),
          "a SIGKILLed claimant is noticed inside the poll budget")
    t.join(2.0)
    check(not t.is_alive(), "the watcher returns after firing (it is not a leak)")
    check(len(hits) == 1, "and it fires exactly once")

    # ---- 4. a RECYCLED pid never passes for the claimant ----
    # The guarantee is (pid, start tick, boot), not a number a busy machine can
    # hand to an unrelated process. This case is indistinguishable from a crash
    # by pid alone — which is why pid alone is never the question.
    recycled = _sleeper()
    try:
        ident = procstat.identity(recycled.pid)
        if ident and ident["starttime"]:
            stale_tick = str(int(ident["starttime"]) + 1)
            check(claim_watch.verdict(recycled.pid, stale_tick) == "dead",
                  "a live pid with the WRONG start tick is 'dead', not the claimant")
            hit = threading.Event()
            t = claim_watch.watch(recycled.pid, stale_tick, hit.set, poll_s=0.1)
            check(wait_until(hit.is_set, 3.0, "the watchdog refusing a recycled pid"),
                  "the watchdog fires for a recycled pid although that pid is alive")
            t.join(2.0)
        else:
            check(True, "this host has no start ticks: the recycled-pid case cannot be built here")
    finally:
        recycled.kill()
        recycled.wait(timeout=10)

    # ---- 5. doubt never fires ----
    # "I cannot read this process" is not "the app is gone". A permission
    # problem, a container boundary or a transient /proc failure must leave the
    # session serving; only positive proof ends it.
    orig_verdict = claim_watch.verdict
    try:
        claim_watch.verdict = lambda *a, **k: "unknown"  # type: ignore[assignment]
        hit = threading.Event()
        t = claim_watch.watch(os.getpid(), "", hit.set, poll_s=0.05)
        time.sleep(0.5)  # ten polls, each answering "unknown"
        check(not hit.is_set(), "an 'unknown' claim never ends the session")
        check(t is not None and t.is_alive(), "and the watcher keeps asking")
    finally:
        claim_watch.verdict = orig_verdict
        hit.set()  # release case 5's watcher: our own pid is live, it would poll forever

    # ---- 6. the supervisor's ladder: a proven-dead claim outvotes a live lease ----
    # `in_flight` is the CLIENT's memory (a 120 s lease it renews), not backend
    # work: the run loop lives in the client. So a claim the kernel proved dead
    # ends the child even while the lease still says busy — otherwise the lock
    # outlives the app by up to the lease, which is the leak this fixes.
    sup, port, _ = start_supervisor(stale_s=60, idle_timeout_s=60)
    base = f"http://127.0.0.1:{port}"
    try:
        st, body = http_post(f"{base}/api/session/start")
        d = json.loads(body)
        sid, child = d["session_id"], f"http://127.0.0.1:{d['port']}"
        check(st == 200 and sid in sup.sessions, "a session is up for the ladder case")
        with tempfile.TemporaryDirectory() as tdir:
            st, body = http_post(f"{child}/api/project/new", {"dir": tdir, "name": "ladder"})
            clc = json.loads(body)["project"]
            st, body = http_post(f"{child}/api/run/state", {"busy": True, "project": clc})
            check(json.loads(body).get("busy") is True, "its client holds an in_flight lease")
            dead = _dead_identity()
            record = sup.sessions[sid]
            child_pid = record.proc.pid
            # the claim fields the supervisor records when the window claims the
            # session; written by hand here because this session was started
            # without one (a direct API start, the Android bridge's shape)
            record.claim_pid, record.claim_start = dead["pid"], dead["starttime"]
            check(sup.stop_session(sid) == "stopped",
                  "a release whose CLIENT is proven DEAD stops the child (the lease is not evidence)")
            check(sid not in sup.sessions, "and no record is left behind")
            check(wait_until(lambda: not procstat.alive(child_pid), 10.0, "the stopped child exiting"),
                  "the child itself is gone: the .clc died with it")

        # ---- 7. a claim this host cannot see is DOUBT, and doubt keeps the work ----
        # A tunnelled client's pid lives on the CLIENT. The far host can never
        # prove it gone (a frozen phone must keep its run), so an unverifiable
        # claim plus a live lease is exactly the case the reaper's window is for.
        st, body = http_post(f"{base}/api/session/start")
        d = json.loads(body)
        sid, child = d["session_id"], f"http://127.0.0.1:{d['port']}"
        with tempfile.TemporaryDirectory() as tdir:
            st, body = http_post(f"{child}/api/project/new", {"dir": tdir, "name": "remote"})
            clc = json.loads(body)["project"]
            st, body = http_post(f"{child}/api/run/state", {"busy": True, "project": clc})
            record = sup.sessions[sid]
            check(not record.claim_pid, "a session claimed from another machine names no local pid")
            check(sup.stop_session(sid) == "detached",
                  "an unverifiable claim with a run in flight is LEFT RUNNING (detached)")
            check(sid in sup.sessions and sup.sessions[sid].detached is True,
                  "and the record is marked: no window owns it any more")
            check(record.proc.poll() is None, "the child is still alive, still holding its turn")
            check(sup.stop_session(sid, leaving=True) == "stopped",
                  "but an explicit leave-for-good stops it regardless")
            check(sid not in sup.sessions, "and the child is reaped out of the table")
    finally:
        sup.shutdown_all()

    # ---- 8. end to end: a real session child, a real SIGKILL, a free .clc ----
    # No supervisor, no client, no reclaim pass: the child is killed by its own
    # watchdog and the kernel releases the write lock with it. This is the path
    # an Electron crash takes.
    locktmp = tempfile.mkdtemp(prefix="clutch-claim-lock-")
    old_lockdir = os.environ.get("CLUTCH_LOCK_DIR")
    os.environ["CLUTCH_LOCK_DIR"] = locktmp
    claimant = _sleeper()
    ident = procstat.identity(claimant.pid)
    proc = None
    try:
        with tempfile.TemporaryDirectory() as tdir:
            proc = subprocess.Popen(
                [
                    sys.executable, "-m", "agent.server", "--port", "0",
                    "--claim-pid", str(claimant.pid), "--claim-start", ident["starttime"],
                ],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            port = _banner_port(proc)
            sess = f"http://127.0.0.1:{port}"
            st, body = http_post(f"{sess}/api/project/new", {"dir": tdir, "name": "crashed"})
            check(st == 200, "the claimed session opens a project")
            clc = json.loads(body)["project"]
            check(ProjectLock.inspect(clc)["held"] is True, "and holds the .clc's write lock")
            owner = ProjectLock.owner(clc) or {}
            check(owner.get("claim_pid") == claimant.pid,
                  "the lock's record names the claiming app process")
            check(claimant.poll() is None and proc.poll() is None,
                  "app and session are both up")

            claimant.kill()  # the app dies with no chance to send anything
            claimant.wait(timeout=10)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                check(False, "a session whose app was SIGKILLed ends itself")
            check(proc.returncode == 0,
                  "it exits through the release path (a clean final, not a crash)")
            check(ProjectLock.inspect(clc)["held"] is False,
                  "the kernel freed the .clc with the session: no reclaim, no prompt")
            out = proc.stdout.read() if proc.stdout else ""
            check("the app that claimed this session is gone; releasing" in out,
                  "and it said so, on the record, before leaving")
    finally:
        for p in (proc, claimant):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait(timeout=10)
        if old_lockdir is None:
            os.environ.pop("CLUTCH_LOCK_DIR", None)
        else:
            os.environ["CLUTCH_LOCK_DIR"] = old_lockdir
        shutil.rmtree(locktmp, ignore_errors=True)

    print("\nclaim_watch: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
