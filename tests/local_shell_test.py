"""Windows local-shell adaptation: ONE shell decision, every consumer agrees.

localshell decides which shell local run_command text executes under (the
host's POSIX sh / a detected Git Bash / cmd.exe). These tests PIN that decision
(reset_cache) and verify every consumer follows it:

  - split_command                    tokenizer flavor (backslash + quoting rules)
  - LocalTransport.run               spawn shape (argv vs shell=True, utf-8 decode)
  - shell.run_command/_blocked_reason  unparseable-command guard + REPL lexer
  - PermissionEvaluator.escaped_paths  flavor comes from the WORKSPACE, so a
                                     remote (SSH) workspace tokenizes POSIX even
                                     on a host pinned to cmd
  - context.derive_messages          the local-environment hint (and its absence
                                     on posix-sh / remote workspaces)
  - supervisor._SafeStdStream        the no-fcntl (Windows) stdio degradation

Run: uv run python3 -m tests.local_shell_test
"""

from __future__ import annotations

import subprocess
import tempfile
import threading
import time

from tests.testsupport import check

from agent.config import Config
from agent.core.context import derive_messages
from agent.core.lazy import LazyEventLog
from agent.core.permission import PermissionEvaluator
from agent.supervisor import _SafeStdStream
from agent.tools import shell as shell_mod
from agent.tools.localshell import LocalShell, local_shell, reset_cache, split_command
from agent.tools.transport import LocalTransport
from agent.tools.workspace import LocalWorkspace, RemoteWorkspace

# pinned decisions (argv here is never spawned except in the recorder test,
# which intercepts subprocess.run)
POSIX = LocalShell(argv=None, posix=True, name="posix-sh")
BASH = LocalShell(argv=(r"C:\Program Files\Git\bin\bash.exe", "-c"), posix=True, name="bash")
CMD = LocalShell(argv=None, posix=False, name="cmd")


def test_split_command() -> None:
    # ---- 1. explicit flavors: the two tokenizers ----
    check(split_command("echo 'a b'", posix=True) == ["echo", "a b"], "posix: single quotes group")
    check(
        split_command(r"echo C:\Users", posix=True) == ["echo", "C:Users"],
        "posix: unquoted backslash is an escape (shlex eats it)",
    )
    check(
        split_command(r'type "C:\Program Files\x.txt"', posix=False)
        == ["type", r"C:\Program Files\x.txt"],
        "cmd: quoted backslash path survives intact",
    )
    check(
        split_command(r"type C:\Users\x.txt", posix=False) == ["type", r"C:\Users\x.txt"],
        "cmd: backslashes literal, never an escape",
    )
    check(
        split_command(r'echo \"hello\"', posix=False) == ["echo", '"hello"'],
        "cmd: 2n rule - \" is a literal quote",
    )
    check(split_command('a "" b', posix=False) == ["a", "", "b"], "cmd: bare double quotes yield an empty argument")
    check(split_command('echo "oops', posix=False) is None, "cmd: unbalanced quote -> None")
    check(split_command('echo "oops', posix=True) is None, "posix: unbalanced quote -> None")
    check(
        split_command(r'type "C:\path\"', posix=False) is None,
        "cmd: trailing backslash escapes the closing quote -> unbalanced -> None",
    )

    # ---- 2. no explicit flavor: follows the pinned decision ----
    reset_cache(POSIX)
    check(split_command(r"echo C:\Users") == ["echo", "C:Users"], "default flavor follows a pinned posix decision")
    reset_cache(CMD)
    check(split_command(r"echo C:\Users") == ["echo", r"C:\Users"], "default flavor follows a pinned cmd decision")


def test_classify_cmd() -> None:
    # ---- 3. chat-mode classifier speaks cmd when told to ----
    check(shell_mod.classify_command("dir", posix=False)[0] == "read", "cmd: dir is read-only")
    check(shell_mod.classify_command("type a.txt", posix=False)[0] == "read", "cmd: type is read-only")
    check(shell_mod.classify_command("del x.txt", posix=False)[0] == "write", "cmd: del is a write")
    check(shell_mod.classify_command("dir>a.txt", posix=False)[0] == "write", "cmd: redirect marker inside a token -> write")
    check(
        shell_mod.classify_command("echo hi && type a.txt", posix=False)[0] == "read",
        "cmd: && chain of read-only segments",
    )
    check(
        shell_mod.classify_command("del x && type a.txt", posix=False)[0] == "write",
        "cmd: one write segment poisons the chain",
    )
    check(
        shell_mod.classify_command(r'del "x&&y"', posix=False)[0] == "write",
        "cmd: quoted && over-splits, verdict stays conservative",
    )


def test_run_command_guard() -> None:
    # ---- 4. run_command guard + the python REPL lexer ----
    reset_cache(CMD)
    with tempfile.TemporaryDirectory() as tmp:
        ws = LocalWorkspace(tmp)
        r = shell_mod.run_command(ws, Config(), 'echo "unbalanced')
        check(
            bool(r.get("error")) and "cannot be parsed" in r["content"],
            "cmd: unparseable command is rejected before any execution",
        )
    cfg = Config()
    check(shell_mod._blocked_reason(cfg, 'python -c "print(1)"', posix=False) is None, "cmd: python -c is non-interactive")
    check(shell_mod._blocked_reason(cfg, "python", posix=False) is not None, "cmd: bare python is still blocked")
    check(shell_mod._blocked_reason(cfg, "python -m json.tool", posix=True) is None, "posix: python -m is non-interactive")


def test_transport_spawn() -> None:
    # ---- 5. spawn shape follows the pinned shell (recorder, nothing exec'd) ----
    calls: list[dict] = []

    def fake_run(args, **kw):
        calls.append({"args": args, **kw})
        return subprocess.CompletedProcess(args, 0, "spawned", "")

    orig = subprocess.run
    subprocess.run = fake_run
    try:
        reset_cache(BASH)
        with tempfile.TemporaryDirectory() as tmp:
            LocalTransport(tmp).run("echo hi", 5)
        check(
            calls[-1]["args"] == [BASH.argv[0], "-c", "echo hi"],
            "bash: spawned as an argv list through bash -c",
        )
        check(calls[-1]["shell"] is False, "bash: shell=False")
        check(
            calls[-1]["encoding"] == "utf-8" and calls[-1]["errors"] == "replace",
            "bash: text decoded utf-8/replace",
        )

        reset_cache(CMD)
        with tempfile.TemporaryDirectory() as tmp:
            LocalTransport(tmp).run("echo hi", 5)
        check(isinstance(calls[-1]["args"], str) and calls[-1]["args"] == "echo hi", "cmd: spawned as a bare string")
        check(calls[-1]["shell"] is True, "cmd: shell=True")
        check(calls[-1]["encoding"] == "utf-8", "cmd: text decoded utf-8")
    finally:
        subprocess.run = orig

    # ---- 6. a REAL posix spawn end-to-end (incl. non-ascii decode) ----
    reset_cache(POSIX)
    with tempfile.TemporaryDirectory() as tmp:
        r = LocalTransport(tmp).run("echo clutch-shell-ok", 10)
        check(r.code == 0 and "clutch-shell-ok" in r.stdout, "posix spawn really executes")
        u = LocalTransport(tmp).run("printf '中文'", 10)
        check("中文" in u.stdout, "utf-8 forced decode round-trips non-ascii output")


def test_workspace_exec_shell() -> None:
    # ---- 7. the workspace is the flavor source ----
    reset_cache(CMD)
    with tempfile.TemporaryDirectory() as tmp:
        lws = LocalWorkspace(tmp)
        check(lws.exec_shell() is local_shell(), "local workspace exec_shell IS the pinned decision")
    rws = RemoteWorkspace("/srv/proj", "http://127.0.0.1:9")
    sh = rws.exec_shell()
    check(sh.posix is True and sh.name == "posix-sh", "remote workspace is ALWAYS posix, whatever the host decided")


def test_permission_flavor() -> None:
    # ---- 8. escaped_paths tokenizes in the WORKSPACE's flavor ----
    pe = PermissionEvaluator()
    reset_cache(CMD)
    with tempfile.TemporaryDirectory() as tmp:
        lws = LocalWorkspace(tmp)
        esc = pe.escaped_paths("run_command", '{"command": "type \'/etc/hostname\'"}', lws)
        check(
            esc == frozenset(),
            "cmd flavor: a single-quoted token is not a sh quote (kept literal, reads relative)",
        )
        esc3 = pe.escaped_paths("run_command", '{"command": "cat \\"unbalanced"}', lws)
        check(esc3 == frozenset(), "unparseable command -> conservative empty escape set")
    # the remote shell is POSIX even though the HOST is cmd-pinned: the same
    # quoting must parse as sh and flag the escape (the ssh-from-Windows case)
    rws = RemoteWorkspace("/srv/proj", "http://127.0.0.1:9")
    esc2 = pe.escaped_paths("run_command", '{"command": "grep \'a b\' /etc/hosts"}', rws)
    check(
        len(esc2) == 1 and any("hosts" in str(p) for p in esc2),
        "remote workspace tokenizes POSIX despite the cmd-pinned host",
    )


def test_context_hint() -> None:
    # ---- 9. the system prompt names the dialect (and stays silent on posix) ----
    with tempfile.TemporaryDirectory() as tmp:
        ws = LocalWorkspace(tmp)
        reset_cache(CMD)
        sys_cmd = derive_messages(LazyEventLog.in_memory(), Config(), "task", workspace=ws)[0]["content"]
        check("cmd.exe" in sys_cmd, "cmd host: prompt tells the model the dialect up front")
        reset_cache(BASH)
        sys_bash = derive_messages(LazyEventLog.in_memory(), Config(), "task", workspace=ws)[0]["content"]
        check(
            "Git Bash" in sys_bash and "cmd.exe" not in sys_bash,
            "bash host: prompt names Git Bash, not cmd",
        )
        reset_cache(POSIX)
        sys_posix = derive_messages(LazyEventLog.in_memory(), Config(), "task", workspace=ws)[0]["content"]
        check(
            "cmd.exe" not in sys_posix and "Git Bash" not in sys_posix,
            "posix host: no platform line (zero prompt diff)",
        )
        reset_cache(CMD)
        sys_nows = derive_messages(LazyEventLog.in_memory(), Config(), "task")[0]["content"]
        check("cmd.exe" not in sys_nows, "no workspace arg (server/eval callers): no platform line")
        rws = RemoteWorkspace("/srv/proj", "http://127.0.0.1:9")
        sys_remote = derive_messages(LazyEventLog.in_memory(), Config(), "task", workspace=rws)[0]["content"]
        check("cmd.exe" not in sys_remote, "remote workspace: no local-dialect line (the remote is POSIX)")


def test_safe_std_stream() -> None:
    # ---- 10. supervisor stdio degradation (Windows has no fcntl) ----
    s = _SafeStdStream(None)  # pythonw: no console streams at all
    check(s.write("abc") == 3 and s._queue is None, "pythonw (inner=None): write no-ops with len")
    s.flush()

    class _Boom:
        def write(self, data):
            raise AttributeError("no console under pythonw")

        def flush(self):
            raise OSError("dead")

    sb = _SafeStdStream(_Boom())
    check(sb.write("x") == 1, "sync write swallows AttributeError")
    sb.flush()

    class _Recorder:
        def __init__(self):
            self.items: list[str] = []
            self.lock = threading.Lock()

        def write(self, data):
            with self.lock:
                self.items.append(data)
            return len(data)

        def flush(self):
            pass

    rec = _Recorder()
    sa = _SafeStdStream(rec, async_when_no_fcntl=True)
    check(sa._queue is not None, "forced async: writer queue active")
    check(sa.write("hello") == 5, "async write returns len immediately")
    deadline = time.time() + 3
    while time.time() < deadline:
        with rec.lock:
            if rec.items:
                break
        time.sleep(0.02)
    with rec.lock:
        check(bool(rec.items) and rec.items[0] == "hello", "async write lands via the drain thread")

    # queue full: the WRITER must never block (a dead parent's full pipe on
    # Windows would otherwise hang the printing thread forever)
    class _Gated:
        def __init__(self):
            self.gate = threading.Event()
            self.items: list[str] = []

        def write(self, data):
            self.gate.wait(5)
            self.items.append(data)
            return len(data)

        def flush(self):
            pass

    g = _Gated()
    sg = _SafeStdStream(g, async_when_no_fcntl=True)
    t0 = time.time()
    for i in range(_SafeStdStream._QUEUE_MAX + 50):
        sg.write(f"line-{i}")
    check(time.time() - t0 < 2.0, "writes never block even when the queue is full")
    g.gate.set()
    deadline, last = time.time() + 3, -1
    while time.time() < deadline:
        if len(g.items) != last:
            last = len(g.items)
        else:
            break
        time.sleep(0.05)
    check(
        0 < len(g.items) < _SafeStdStream._QUEUE_MAX + 50,
        "overflow drops lines instead of blocking or crashing",
    )


def main() -> int:
    try:
        test_split_command()
        test_classify_cmd()
        test_run_command_guard()
        test_transport_spawn()
        test_workspace_exec_shell()
        test_permission_flavor()
        test_context_hint()
        test_safe_std_stream()
    finally:
        reset_cache(None)  # never leak a pinned flavor into other test modules
    print("local_shell_test: all green")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
