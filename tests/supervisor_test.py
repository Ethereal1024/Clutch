"""Supervisor end-to-end check: spawns real agent.server session children and
exercises lifecycle + the cross-process lock semantics the architecture relies on.

Run: uv run python -m tests.supervisor_test

The lock test is the important one: two SESSION CHILDREN (separate processes,
each with its own _held cache) take the same .clc's kernel lock on this
machine's tmp dir —
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
from pathlib import Path

from agent.supervisor import Supervisor, _SafeStdStream, build_server
from tests.testsupport import check, http_get, http_post

ROOT = Path(__file__).resolve().parents[1]


def wait_until(pred, timeout_s: float = 10.0, what: str = "condition") -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    check(False, f"timed out waiting for {what}")
    return False


def shutdown_post(base: str) -> tuple[int, str]:
    """POST /api/shutdown, tolerating a reply torn by self-teardown.

    Arming the exit flag can beat the HTTP response on the wire: the
    supervisor may already be gone when the answer would arrive, so the
    reply is best-effort — the exit event is the real verdict.
    """
    try:
        return http_post(f"{base}/api/shutdown")
    except OSError:
        return 0, ""


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
        check(st == 409, "child 2 gets 409 on same project (kernel lock)")
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
        len(cmd_frozen) == 1 and cmd_frozen[0].endswith("agent-server.exe" if os.name == "nt" else "agent-server"),
        "frozen build spawns the sibling agent-server binary",
    )
    with _m.patch.object(sys, "frozen", False, create=True):
        cmd_dev = _agent_cmd_default()
    check(
        "-m" in cmd_dev and "agent.server" in cmd_dev,
        "dev build spawns python -m agent.server",
    )

    # ---- 9. dead-parent resilience (orphaned supervisor: stdout is a dead stream) ----
    # prints on the dead stream must not kill the handler / reaper
    import os as _os

    # a pipe whose read end is already closed: writing raises (BrokenPipeError
    # on POSIX, OSError [Errno 22] on Windows). Portable where the old
    # `fdopen(socket.fileno())` was not — a Windows socket handle is not a CRT
    # fd, so fdopen there fails with [WinError 6] before the test even starts.
    _r, _w = _os.pipe()
    _os.close(_r)  # peer gone
    dead_out = _os.fdopen(_w, "w")  # text stream over the dead pipe
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
    st, body = shutdown_post(base7)
    check(st in (200, 0), "shutdown accepted (reply may be torn by self-teardown)")
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
    st, _ = shutdown_post(base8)
    check(st in (200, 0), "shutdown accepted at n==0 (reply may be torn by self-teardown)")
    ok = wait_until(lambda: sup8.exit_event.is_set(), 6.0, "exit after last session (shutdown flag)")
    check(ok, "shutdown supervisor exits as soon as its sessions are gone")
    sup8.shutdown_all()

    # ---- 11. stop when the graceful signal is UNDELIVERABLE (W2) ----
    # A packaged supervisor is spawned by Electron with windowsHide: it has NO
    # console, so CTRL_BREAK_EVENT cannot be delivered and os.kill raises
    # OSError (WinError 6) instead. That must not escape _kill: /api/session/stop
    # has already unregistered the session by then, so an exception answers
    # nothing AND leaks the child (an orphan keeps the port). _kill_hard must
    # still reap it.
    import agent.supervisor as _sv

    class _NoConsole:
        """A live Popen whose graceful stop is unavailable (rest delegates)."""

        def __init__(self, proc) -> None:
            self._p = proc
            self.pid = proc.pid

        def poll(self):
            return self._p.poll()

        def wait(self, timeout=None):
            return self._p.wait(timeout)

        def kill(self):
            return self._p.kill()

        def send_signal(self, sig):
            if os.name == "nt":
                raise OSError(6, "The handle is invalid")  # WinError 6: no console
            return self._p.send_signal(sig)

    grace = _sp.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        stdout=_sp.DEVNULL,
        stderr=_sp.DEVNULL,
        creationflags=getattr(_sp, "CREATE_NEW_PROCESS_GROUP", 0),
        start_new_session=(os.name != "nt"),  # POSIX: own group, so killpg hits only it
    )
    with _m.patch.object(_sv, "KILL_GRACE_S", 0.5):
        t0 = time.time()
        Supervisor._kill(_NoConsole(grace))  # the old code raised here
        took = time.time() - t0
    check(grace.poll() is not None, "an undeliverable graceful signal still reaps the child")
    check(took < 5.0, "kill returns promptly (no unbounded wait on a dead signal)")
    grace.kill()

    # ---- 12. the WHOLE tree goes down, not just the direct child (W2) ----
    # A session child runs commands through a shell; stopping only the direct
    # child leaves that shell — and whatever it started — behind as an orphan
    # holding the port. The grandchild's heartbeat is the witness: it must stop
    # beating the moment the session child is stopped.
    with tempfile.TemporaryDirectory() as tdir:
        hb = Path(tdir) / "beat.txt"
        hb_py = Path(tdir) / "beat.py"
        hb_py.write_text(
            "import os, sys, time\n"
            "p = sys.argv[1]\n"
            "for _ in range(300):  # never outlives the test, even if leaked\n"
            "    open(p, 'w').write(str(os.getpid()))\n"
            "    time.sleep(0.1)\n",
            encoding="utf-8",
            newline="\n",
        )
        parent_py = Path(tdir) / "parent.py"
        parent_py.write_text(
            "import subprocess, sys, time\n"
            "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\n"
            "time.sleep(60)\n",
            encoding="utf-8",
            newline="\n",
        )
        tree = _sp.Popen(
            [sys.executable, str(parent_py), str(hb_py), str(hb)],
            stdout=_sp.DEVNULL,
            stderr=_sp.DEVNULL,
            creationflags=getattr(_sp, "CREATE_NEW_PROCESS_GROUP", 0),
            start_new_session=(os.name != "nt"),
        )
        check(wait_until(hb.exists, 10.0, "grandchild heartbeat"), "the shell's child is running")
        check(tree.poll() is None, "the session child is running")
        Supervisor._kill(tree)
        check(tree.poll() is not None, "direct session child reaped")
        time.sleep(0.8)  # let the last in-flight heartbeat land
        first = hb.stat().st_mtime_ns
        time.sleep(1.2)
        check(hb.stat().st_mtime_ns == first, "the shell's child went down with the tree (no orphan)")
        # safety net: if a failure above leaked the witness, stop it directly
        try:
            leaked = int(hb.read_text().strip() or "0")
            beat = hb.stat().st_mtime_ns
            time.sleep(0.4)
            if leaked and hb.stat().st_mtime_ns != beat:
                if os.name == "nt":
                    _sp.run(["taskkill", "/F", "/PID", str(leaked)], capture_output=True)
                else:
                    os.kill(leaked, 9)
        except (OSError, ValueError):
            pass

    # ---- 13. a supervisor that DIES must not orphan the session (Windows Job) ----
    # The reaper only runs while the supervisor lives; a supervisor killed
    # without walking its children (crash, TerminateProcess, Electron's tree
    # going down first) used to leave the session child alive forever — an
    # invisible zombie still holding its .clc write lock, so reopening the
    # project landed read-only with no visible other window. The kill-on-close
    # Job hands that to the kernel: the OS closes a dying process's handles,
    # and the Job's last handle closing terminates every member. The witness
    # here is a grandchild holding a real LISTENING port (the stand-in for the
    # .clc lock): launcher + grandchild must BOTH die when the Job handle does.
    if os.name == "nt":
        import ctypes
        import socket as _socket

        with tempfile.TemporaryDirectory() as tdir:
            grandchild_py = Path(tdir) / "server.py"
            grandchild_py.write_text(
                "import socket, sys, time\n"
                "s = socket.socket()\n"
                "s.bind(('127.0.0.1', 0))\n"
                "s.listen(1)\n"
                "print(f'[clutch-server] http://127.0.0.1:{s.getsockname()[1]}', flush=True)\n"
                "time.sleep(60)\n",
                encoding="utf-8",
                newline="\n",
            )
            launcher_py = Path(tdir) / "launcher.py"
            launcher_py.write_text(
                "import subprocess, sys, time\n"
                "from pathlib import Path\n"
                "# the supervisor appends its own CLI (e.g. '--port 0') AFTER the\n"
                "# command; forward it untouched, like the real agent launcher does\n"
                "sib = Path(sys.argv[0]).resolve().parent / 'server.py'\n"
                "subprocess.Popen([sys.executable, str(sib), *sys.argv[1:]])  # stdout inherited\n"
                "time.sleep(60)\n",
                encoding="utf-8",
                newline="\n",
            )
            sup9 = Supervisor(
                agent_cmd=[sys.executable, str(launcher_py)],
                cwd=str(ROOT),
                stale_s=60,
                idle_timeout_s=60,
            )
            sess9 = sup9.start_session()
            check(sess9 is not None, "job: session started")
            check(sess9.job is not None, "session child assigned to a kill-on-close Job")
            check(sess9.port and sess9.port > 0, "job: grandchild banner parsed through the launcher")

            # Job membership must already cover the GRANDCHILD (the venv/onefile
            # launcher spawns its real interpreter as a child; a Job missing it
            # is exactly the leak this guards against)
            class _PidList(ctypes.Structure):
                # JOBOBJECT_BASIC_PROCESS_ID_LIST with headroom for 64 pids.
                # (Class 1 / accounting is NOT portable for this: its struct
                # must match the build's exact size — 40 classic, 48 on newer
                # Win11 — anything else fails with ERROR_BAD_LENGTH.)
                _fields_ = [
                    ("NumberOfAssignedProcesses", ctypes.c_uint32),
                    ("NumberOfProcessIdsInList", ctypes.c_uint32),
                    ("ProcessIdList", ctypes.c_size_t * 64),
                ]

            pids = _PidList()
            k32 = ctypes.windll.kernel32
            k32.QueryInformationJobObject.argtypes = [
                ctypes.c_void_p,
                ctypes.c_int,
                ctypes.POINTER(_PidList),
                ctypes.c_uint32,
                ctypes.POINTER(ctypes.c_uint32),
            ]
            rl = ctypes.c_uint32(0)
            ok = k32.QueryInformationJobObject(
                sess9.job, 3, ctypes.byref(pids), ctypes.sizeof(pids), ctypes.byref(rl)
            )  # 3 = JobObjectBasicProcessIdList
            listed = {pids.ProcessIdList[i] for i in range(pids.NumberOfProcessIdsInList)}
            check(
                bool(ok) and len(listed) >= 2 and sess9.proc.pid in listed,
                "the launcher's child is inside the Job",
            )

            def _port_open() -> bool:
                s = _socket.socket()
                s.settimeout(0.5)
                try:
                    s.connect(("127.0.0.1", sess9.port))
                    return True
                except OSError:
                    return False
                finally:
                    s.close()

            check(_port_open(), "the grandchild's port is serving before the supervisor dies")
            # simulate the supervisor DYING with no cleanup: the OS closes every
            # handle it owns — the Job's (last) handle among them
            k32.CloseHandle(ctypes.c_void_p(sess9.job))
            sess9.job = None  # a double close could hit a recycled handle
            check(
                wait_until(lambda: sess9.proc.poll() is not None, 10.0, "launcher death"),
                "the launcher died with the Job",
            )
            check(
                wait_until(lambda: not _port_open(), 10.0, "grandchild port close"),
                "the grandchild went down with the Job (no orphan holding resources)",
            )

    print("\nSUPERVISOR TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
