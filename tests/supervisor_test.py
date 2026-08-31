"""Supervisor end-to-end check: spawns real agent.server session children and
exercises lifecycle + the cross-process lock semantics the architecture relies on.

Run: uv run python -m tests.supervisor_test

The lock test is the important one: two SESSION CHILDREN (separate processes,
each with its own _held cache) flock the same .clc on this machine's tmp dir —
the second open must get 409 via the kernel, exactly like the remote-supervisor
case. This is what the shared-process architecture could never provide.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from agent.supervisor import Supervisor, _SafeStdStream, build_server
from tests.testsupport import check

ROOT = Path(__file__).resolve().parents[1]


def http_get(url: str) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def http_post(url: str, body: dict | None = None) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def wait_until(pred, timeout_s: float = 10.0, what: str = "condition") -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    check(False, f"timed out waiting for {what}")
    return False


def start_supervisor(**kwargs) -> tuple[Supervisor, int, threading.Thread]:
    sup = Supervisor(
        agent_cmd=[sys.executable, "-m", "agent.server"],
        cwd=str(ROOT),
        reap_interval_s=0.2,
        **kwargs,
    )
    srv = build_server(0, sup)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    threading.Thread(target=sup.reap_loop, daemon=True).start()
    return sup, srv.server_address[1], t


def main() -> int:
    # ---- 1. lifecycle ----
    sup, port, _ = start_supervisor(stale_s=60, idle_timeout_s=60)
    base = f"http://127.0.0.1:{port}"

    st, body = http_get(f"{base}/api/health")
    check(st == 200 and '"ok"' in body, "supervisor health ok")

    st, body = http_post(f"{base}/api/session/start")
    check(st == 200, "session start accepted")
    d1 = json.loads(body)
    sid1, port1 = d1["session_id"], d1["port"]
    check(len(sid1) > 0 and isinstance(port1, int), "session returns id + port")

    # the session child is a full agent server
    st, _ = http_get(f"http://127.0.0.1:{port1}/api/health")
    check(st == 200, "session child is healthy")

    st, body = http_post(f"{base}/api/session/start")
    d2 = json.loads(body)
    sid2, port2 = d2["session_id"], d2["port"]
    check(sid1 != sid2 and port1 != port2, "two sessions get distinct ports")

    # ---- 2. REAL cross-process lock: two session children, same .clc ----
    with tempfile.TemporaryDirectory() as sdir:
        proj_dir = Path(sdir) / "work"
        proj_dir.mkdir()
        s1 = f"http://127.0.0.1:{port1}"
        s2 = f"http://127.0.0.1:{port2}"

        st, body = http_post(f"{s1}/api/project/new", {"dir": str(proj_dir), "name": "demo"})
        check(st == 200, "child 1 creates project")
        clc = Path(json.loads(body)["project"])
        check(clc.exists(), ".clc file exists")

        st, _ = http_post(f"{s1}/api/project/open", {"path": str(clc)})
        check(st == 200, "child 1 opens project (holds flock)")

        st, body = http_post(f"{s2}/api/project/open", {"path": str(clc)})
        check(st == 409, "child 2 gets 409 on same project (kernel flock)")
        check("project_open_conflict" in body, "409 carries conflict code")

        # different projects never conflict
        st, body = http_post(f"{s2}/api/project/new", {"dir": str(proj_dir), "name": "other"})
        clc2 = Path(json.loads(body)["project"])
        st, _ = http_post(f"{s2}/api/project/open", {"path": str(clc2)})
        check(st == 200, "child 2 opens a different project freely")

        # child 1 exit releases the lock via the kernel -> child 2 can reopen
        st, _ = http_post(f"{base}/api/session/stop", {"session_id": sid1})
        check(st == 200, "session 1 stopped")
        st, _ = http_post(f"{s2}/api/project/open", {"path": str(clc)})
        check(st == 200, "lock freed on process exit (no TTL needed)")

        # heartbeat unknown session -> 404
        st, _ = http_post(f"{base}/api/session/heartbeat", {"session_id": "nope"})
        check(st == 404, "heartbeat for unknown session rejected")

        st, _ = http_post(f"{base}/api/session/stop", {"session_id": sid2})
        check(st == 200, "session 2 stopped")

    sup.shutdown_all()

    # ---- 3. stale-session reaping (crashed window: heartbeat stops) ----
    sup2, port2b, _ = start_supervisor(stale_s=0.6, idle_timeout_s=60)
    base2 = f"http://127.0.0.1:{port2b}"
    st, body = http_post(f"{base2}/api/session/start")
    sid3 = json.loads(body)["session_id"]
    check(sid3 in sup2.sessions, "session registered")
    # no heartbeats: the reaper must kill it
    ok = wait_until(lambda: sid3 not in sup2.sessions, 10.0, "stale session reaped")
    check(ok, "stale session reaped without heartbeat")
    sup2.shutdown_all()

    # ---- 4. heartbeat keeps a session alive ----
    sup3, port3, _ = start_supervisor(stale_s=0.6, idle_timeout_s=60)
    base3 = f"http://127.0.0.1:{port3}"
    st, body = http_post(f"{base3}/api/session/start")
    sid4 = json.loads(body)["session_id"]
    for _ in range(8):
        st, _ = http_post(f"{base3}/api/session/heartbeat", {"session_id": sid4})
        check(st == 200, "heartbeat accepted")
        time.sleep(0.25)
    check(sid4 in sup3.sessions, "heartbeated session survives past stale window")
    sup3.shutdown_all()

    # ---- 5. idle self-exit (last window closed) ----
    sup4, port4, _ = start_supervisor(stale_s=60, idle_timeout_s=0.8)
    base4 = f"http://127.0.0.1:{port4}"
    st, body = http_post(f"{base4}/api/session/start")
    sid5 = json.loads(body)["session_id"]
    st, _ = http_post(f"{base4}/api/session/stop", {"session_id": sid5})
    ok = wait_until(lambda: sup4.exit_event.is_set(), 10.0, "supervisor idle-exit")
    check(ok, "supervisor self-exits after last session stops")
    sup4.shutdown_all()

    # ---- 6. no parent watchdog: a session child ignores CLUTCH_SUPERVISOR_PID ----
    import subprocess as _sp

    wd_env = dict(os.environ)
    wd_env["CLUTCH_SUPERVISOR_PID"] = "999999"  # would have killed the old watchdog
    wd = _sp.Popen(
        [sys.executable, "-m", "agent.server", "--port", "0"],
        cwd=str(ROOT),
        env=wd_env,
        stdout=_sp.DEVNULL,
        stderr=_sp.DEVNULL,
    )
    time.sleep(7)  # the old watchdog fired at ~5s; surviving past this proves it is gone
    check(wd.poll() is None, "session child survives a bogus CLUTCH_SUPERVISOR_PID (no watchdog)")
    wd.terminate()
    wd.wait(timeout=10)

    # ---- 7. base_url forwarding (remote sessions point at the LLM proxy) ----
    sup5, port5, _ = start_supervisor(stale_s=60, idle_timeout_s=60)
    base5 = f"http://127.0.0.1:{port5}"
    st, body = http_post(f"{base5}/api/session/start", {"base_url": "http://127.0.0.1:8892/v1"})
    check(st == 200, "session start with base_url accepted")
    d5 = json.loads(body)
    args5 = sup5.sessions[d5["session_id"]].proc.args
    check(
        "--base-url" in args5 and "http://127.0.0.1:8892/v1" in args5,
        "base_url forwarded to the session child (--base-url ...)",
    )
    sup5.shutdown_all()

    # ---- 8. agent command resolution: dev vs PyInstaller (sys.frozen) ----
    import unittest.mock as _m

    from agent.supervisor import _agent_cmd_default

    with _m.patch.object(sys, "frozen", True, create=True):
        cmd_frozen = _agent_cmd_default()
    check(
        len(cmd_frozen) == 1 and cmd_frozen[0].endswith("agent-server"),
        "frozen build spawns the sibling agent-server binary",
    )
    with _m.patch.object(sys, "frozen", False, create=True):
        cmd_dev = _agent_cmd_default()
    check(
        "-m" in cmd_dev and "agent.server" in cmd_dev,
        "dev build spawns python -m agent.server",
    )

    # ---- 9. dead-parent resilience (orphaned supervisor: stdout is a dead socket) ----
    # prints on the dead stream must not kill the handler / reaper
    import os as _os
    import socket as _sock

    a, _b = _sock.socketpair()
    _b.close()  # peer gone: writes to `a` raise BrokenPipeError
    dead_out = _os.fdopen(a.fileno(), "w")  # text stream over the dead socket
    _orig_out, _orig_err = sys.stdout, sys.stderr
    try:
        sys.stdout = _SafeStdStream(dead_out)
        sys.stderr = _SafeStdStream(dead_out)
        sup6, port6, _ = start_supervisor(stale_s=60, idle_timeout_s=60)
        st, body = http_post(f"http://127.0.0.1:{port6}/api/session/start")
        check(st == 200, "session/start still responds when stdout is a dead socket")
        sid6 = json.loads(body)["session_id"]
        st, _ = http_post(f"http://127.0.0.1:{port6}/api/session/stop", {"session_id": sid6})
        check(st == 200, "session/stop still responds")
        sup6.shutdown_all()
    finally:
        sys.stdout, sys.stderr = _orig_out, _orig_err
        try:
            dead_out.close()  # flush may hit the dead socket
        except (OSError, ValueError, TypeError):
            pass

    # ---- 10. /api/shutdown (normal app close: exit when empty, never in-use) ----
    sup7, port7, _ = start_supervisor(stale_s=60, idle_timeout_s=30)
    base7 = f"http://127.0.0.1:{port7}"
    st, body = http_post(f"{base7}/api/shutdown")
    check(st == 200, "shutdown accepted")
    time.sleep(2)
    check(sup7.exit_event.is_set(), "shutdown with no sessions exits promptly (no idle grace)")
    sup7.shutdown_all()

    sup8, port8, _ = start_supervisor(stale_s=60, idle_timeout_s=30)
    base8 = f"http://127.0.0.1:{port8}"
    st, body = http_post(f"{base8}/api/session/start")
    sid8 = json.loads(body)["session_id"]
    st, _ = http_post(f"{base8}/api/shutdown")
    check(st == 200, "shutdown accepted while a session is live")
    time.sleep(2)
    check(not sup8.exit_event.is_set(), "shutdown does NOT kill an in-use supervisor")
    # a shutdown POST with sessions live is IGNORED (never armed): otherwise one
    # instance's exit would kill the supervisor the moment ANOTHER window's
    # re-claim transiently hit n==0
    st, _ = http_post(f"{base8}/api/session/stop", {"session_id": sid8})
    check(st == 200, "session stopped")
    time.sleep(3)
    check(not sup8.exit_event.is_set(), "ignored in-use shutdown leaves no sticky flag")
    # the real last-window path: shutdown POST at n==0 arms and exits promptly
    st, _ = http_post(f"{base8}/api/shutdown")
    check(st == 200, "shutdown accepted at n==0")
    ok = wait_until(lambda: sup8.exit_event.is_set(), 6.0, "exit after last session (shutdown flag)")
    check(ok, "shutdown supervisor exits as soon as its sessions are gone")
    sup8.shutdown_all()

    print("\nSUPERVISOR TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
