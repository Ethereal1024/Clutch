"""Transport + RemoteWorkspace round-trip check against an inline mock bridge.

Run: uv run python -m tests.transport_test

The mock bridge speaks the exec-bridge /exec contract (POST -> sh) against a
temp "remote" root, so the SSH degradation path is exercised without ssh2 or a
real device: heredoc quoting ($, backticks, quotes), trailing-newline handling,
cd semantics, ls parsing, protected hiding, append_line, and the SshTransport
timeout -> TransportError(timeout=True) surface.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agent.tools.transport import LocalTransport, SshTransport, TransportError
from agent.tools.workspace import _EXEC_CHUNK_BYTES, LocalWorkspace, RemoteWorkspace, shq
from tests.testsupport import check, posix_shell_argv

# the mock "remote" parses commands with a POSIX shell, exactly like the real
# remote's exec bridge (/bin/sh on POSIX, Git Bash / MSYS2 bash on Windows)
SH = posix_shell_argv()


def remote_root(path: str) -> str:
    """A local directory in the spelling the mock's POSIX shell resolves.

    The mock remote IS this machine's directory tree, seen through a POSIX
    shell: on Windows that shell (Git Bash) answers `/tmp` for %TEMP% (its own
    mount point) and keeps POSIX spellings in every path it prints, so the
    "remote" root must be spelled the way that shell spells it — the real
    remote is POSIX and only the mock needs the translation."""
    if os.name != "nt":
        return path
    return shell_pwd(path.replace("\\", "/"))


def shell_pwd(path: str) -> str:
    """How the mock's shell prints that directory (`pwd` under Git Bash answers
    /c/Users/... for C:\\Users\\... — the same directory, other spelling)."""
    r = subprocess.run([*SH, f"cd {shq(path)} && pwd"], capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


class MockBridge(BaseHTTPRequestHandler):
    # peak exec-command length seen (chunking caps under the sshd limit)
    max_cmd_len = 0
    # total /exec POSTs issued (list_many batches a level into one exec)
    post_count = 0

    def log_message(self, *a) -> None:  # silence request spam
        pass

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/exec":
            self.send_response(404)
            self.end_headers()
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        cmd = body.get("command", "")
        MockBridge.max_cmd_len = max(MockBridge.max_cmd_len, len(cmd.encode("utf-8")))
        MockBridge.post_count += 1
        timeout_ms = body.get("timeout", 60000)
        try:
            r = subprocess.run(
                [*SH, cmd] if SH else cmd,
                shell=SH is None,
                capture_output=True,
                text=True,
                timeout=timeout_ms / 1000,
            )
            code, stdout, stderr = r.returncode, r.stdout or "", r.stderr or ""
        except subprocess.TimeoutExpired:
            code, stdout, stderr = -1, "", ""
        resp = json.dumps({"code": code, "stdout": stdout, "stderr": stderr}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(resp)


def main() -> int:
    if SH is None:
        print("SKIP: no POSIX shell on this host (Windows without Git Bash / MSYS2)")
        print("      the mock remote runs `sh -c` like exec-bridge.js on a real remote;")
        print("      cmd.exe cannot run heredocs/printf/base64, so this check needs one.")
        return 0
    with tempfile.TemporaryDirectory() as rtmp:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), MockBridge)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        bridge = f"http://127.0.0.1:{srv.server_address[1]}"

        # regression (macOS SSH): constructing a RemoteWorkspace must not touch
        # the LOCAL filesystem — the root lives on the remote host, and macOS
        # autofs (/home) fails a local mkdir with [Errno 45] ENOTSUP, which
        # surfaced as "cannot create project: [Errno 45] Operation not
        # supported: '/home/<user>'".
        mkdir_calls: list[str] = []
        real_mkdir = Path.mkdir

        def _rec_mkdir(self, *a, **k):  # pure recorder: no real FS writes
            mkdir_calls.append(str(self))

        Path.mkdir = _rec_mkdir  # type: ignore[method-assign]
        try:
            _ = RemoteWorkspace("/home/remote-user/proj", bridge)
        finally:
            Path.mkdir = real_mkdir  # type: ignore[method-assign]
        check(
            not any(c.startswith("/home/") for c in mkdir_calls),
            "RemoteWorkspace construction never mkdirs the remote root locally",
        )

        made = Path(rtmp) / "init-made" / "deep"
        _ = LocalWorkspace(str(made))
        check(made.is_dir(), "LocalWorkspace still creates its root (behavior kept)")

        ws = RemoteWorkspace(remote_root(rtmp), bridge)

        # heredoc round trip: $, backticks, single/double quotes, tab, newline
        tricky = "l1\nwith $VAR `bt` 'sq' \"dq\"\n\ttab\tend\n"
        ws.write("sub/deep/f.txt", tricky)
        check(ws.read("sub/deep/f.txt") == tricky, "remote write/read byte-identical")
        check(ws.read("sub/deep/f.txt") == LocalWorkspace(rtmp).read("sub/deep/f.txt"), "matches local bytes")

        # byte-exact writes: printf adds no newline (heredoc's trailing-\n caveat is gone)
        ws.write("no-nl.txt", "abc")
        check(ws.read("no-nl.txt") == "abc", "remote write is byte-exact (no added newline)")

        # large content: chunking keeps every exec under the cap, bytes exact
        big = "".join(f"line {i:04d} with $VAR and 'quotes' and \"dquotes\" and \ttab\t\n" for i in range(300))  # ~21KB
        ws.write("big.txt", big)
        check(ws.read("big.txt") == big, "large remote write byte-exact (chunked)")

        # the .clc case: one huge single-line event (JSONL) appends without a newline split
        event = '{"type": "tool_result", "content": "' + ("x" * 24000) + '"}'
        ws.append_line("session.clc", event)
        check(
            LocalWorkspace(rtmp).read("session.clc") == event + "\n",
            "large single-line append byte-exact (chunked, one trailing newline)",
        )
        # every exec command stays well under the sshd's ~8KB drop threshold
        check(
            MockBridge.max_cmd_len <= _EXEC_CHUNK_BYTES + 200,
            f"exec commands chunked under the cap (max {MockBridge.max_cmd_len} bytes)",
        )

        # ls parsing + cd semantics + protected hiding + error mapping
        entries = ws.list(".")
        check("sub/" in entries and "no-nl.txt" in entries, "remote list dirs end with '/'")
        try:
            ws.read("missing.txt")
            check(False, "remote read raises FileNotFoundError")
        except FileNotFoundError:
            check(True, "remote read raises FileNotFoundError")
        try:
            ws.list("no-nl.txt")
            check(False, "remote list raises NotADirectoryError")
        except NotADirectoryError:
            check(True, "remote list raises NotADirectoryError")
        r = ws.run("pwd", 30.0)
        check(r.code == 0 and r.stdout.strip() == str(ws.root), "remote run cwd = root")

        # oversized run_command: rejected up front, never reaches the bridge
        try:
            ws.run("echo " + ("x" * 20000), 30.0)
            check(False, "oversized command raises TransportError")
        except TransportError:
            check(True, "oversized command raises TransportError before exec")
        check(
            MockBridge.max_cmd_len <= _EXEC_CHUNK_BYTES + 200,
            f"rejected command never reached the bridge (max {MockBridge.max_cmd_len} bytes)",
        )
        ws.protect(Path(str(ws.root)) / "sub" / "secret.txt")
        ws.write("sub/secret.txt", "x")
        check("secret.txt" not in ws.list("sub"), "remote list hides protected files")

        # list_many: one exec lists a level; hidden entries not pre-filtered
        (Path(rtmp) / "a").mkdir()
        (Path(rtmp) / "a" / "inner").mkdir()
        (Path(rtmp) / "b").mkdir()
        (Path(rtmp) / "b" / "f.txt").write_text("x")
        MockBridge.post_count = 0
        many = ws.list_many([".", "a", "b", "missing"])
        check(
            MockBridge.post_count == 1,
            f"list_many batches the whole level into one exec (got {MockBridge.post_count})",
        )
        check(
            many["."] == ws.list(".") and many["a"] == ws.list("a") and many["b"] == ws.list("b"),
            "list_many matches per-dir list()",
        )
        check(many["missing"] == [], "list_many maps a missing dir to []")
        check("inner/" in many["a"] and "f.txt" in many["b"], "list_many parses dirs/files")
        check(MockBridge.max_cmd_len <= _EXEC_CHUNK_BYTES + 200, "list_many command stays under the exec cap")

        # append_line -> quoted heredoc >>, round trips special chars too
        ws.append_line("log.txt", '{"a": "$x"}')
        ws.append_line("log.txt", "second")
        check(ws.read("log.txt") == '{"a": "$x"}\nsecond\n', "remote append_line")

        # remote grep: shell grep on the far side, paths root-relative, include filter
        hits = ws.grep("VAR", path="sub")
        check(
            any(f == "sub/deep/f.txt" for f, _, _ in hits) and all(f.startswith("sub/") for f, _, _ in hits),
            "remote grep finds hits with root-relative paths",
        )
        check(ws.grep("VAR", path="sub", include="*.log") == [], "remote grep include filter excludes")
        check(ws.grep("no_such_token_zzz") == [], "remote grep no matches -> []")
        # find-based file list (busybox-safe) skips hidden files and the protected .clc
        ws.write(".hidden.py", "SECRET_TOKEN hidden\n")
        ws.write("open.txt", "SECRET_TOKEN open\n")
        prot = Path(rtmp) / "secret.clc"
        ws.protect(prot)
        ws.write("secret.clc", "SECRET_TOKEN protected\n")
        hit_names = {f for f, _, _ in ws.grep("SECRET_TOKEN")}
        check("open.txt" in hit_names, "remote grep searches normal files")
        check(
            "secret.clc" not in hit_names and ".hidden.py" not in hit_names,
            "remote grep skips hidden + protected files",
        )

        # SshTransport surfaces a remote timeout as TransportError(timeout=True)
        try:
            SshTransport(bridge).run("sleep 5", 1.0)
            check(False, "remote timeout raises TransportError")
        except TransportError as e:
            check(e.timeout, "remote timeout -> TransportError(timeout=True)")

        # ---- Stop during a command: the cancel event kills the wait promptly ----
        import time as _time

        lt = LocalTransport(rtmp)

        # baseline: the rewritten path still runs plain commands
        r = lt.run("echo hi", 30.0)
        check(r.code == 0 and r.stdout.strip() == "hi", "LocalTransport plain run after the rewrite")

        # Stop mid-command: TransportError(aborted=True) in ~1s, not after the
        # command; the `touch` after the sleep also proves the TREE died (no
        # late write from a survivor — taskkill /T locally, killpg on POSIX)
        late = Path(rtmp) / "late.txt"
        cancel = threading.Event()
        threading.Timer(0.7, cancel.set).start()
        t0 = _time.monotonic()
        try:
            lt.run(f"sleep 120 && touch {shq(remote_root(str(late)))}", 300.0, cancel=cancel)
            check(False, "cancelled local command raises TransportError")
        except TransportError as e:
            elapsed = _time.monotonic() - t0
            check(e.aborted and not e.timeout, f"local cancel -> TransportError(aborted=True) (timeout={e.timeout})")
            check(elapsed < 10, f"local cancel aborts promptly (took {elapsed:.1f}s)")
        time.sleep(1.0)  # a survivor would write its marker within this window
        check(not late.exists(), "the killed tree never ran its tail (no late writes)")

        # the deadline path still surfaces as TransportError(timeout=True)
        t0 = _time.monotonic()
        try:
            lt.run("sleep 120", 1.0)
            check(False, "local timeout raises TransportError")
        except TransportError as e:
            check(e.timeout and not e.aborted, "local deadline -> TransportError(timeout=True)")
            check(_time.monotonic() - t0 < 10, "local timeout is prompt")

        # Stop on the remote path: the agent's WAIT ends promptly (the bridge's
        # own short deadline below reaps the abandoned remote exec)
        cancel = threading.Event()
        threading.Timer(0.7, cancel.set).start()
        t0 = _time.monotonic()
        try:
            SshTransport(bridge).run("sleep 30", 2.0, cancel=cancel)
            check(False, "cancelled remote exec raises TransportError")
        except TransportError as e:
            check(e.aborted and not e.timeout, "remote cancel -> TransportError(aborted=True)")
            check(_time.monotonic() - t0 < 10, f"remote cancel abandons the wait promptly (took {_time.monotonic() - t0:.1f}s)")

        srv.shutdown()

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
