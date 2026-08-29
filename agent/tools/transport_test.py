"""Transport + RemoteWorkspace round-trip check against an inline mock bridge.

Run: uv run python -m agent.tools.transport_test

The mock bridge speaks the exec-bridge /exec contract (POST -> sh) against a
temp "remote" root, so the SSH degradation path is exercised without ssh2 or a
real device: heredoc quoting ($, backticks, quotes), trailing-newline handling,
cd semantics, ls parsing, protected hiding, append_line, and the SshTransport
timeout -> TransportError(timeout=True) surface.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ..testsupport import check
from .transport import SshTransport, TransportError
from .workspace import _EXEC_CHUNK_BYTES, LocalWorkspace, RemoteWorkspace


class MockBridge(BaseHTTPRequestHandler):
    # peak single exec-command length seen (asserts RemoteWorkspace chunking caps
    # the command under the sshd's limit even for large content)
    max_cmd_len = 0
    # total /exec POSTs issued (asserts list_many batches a level into one exec)
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
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout_ms / 1000)
            code, stdout, stderr = r.returncode, r.stdout or "", r.stderr or ""
        except subprocess.TimeoutExpired:
            code, stdout, stderr = -1, "", ""
        resp = json.dumps({"code": code, "stdout": stdout, "stderr": stderr}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(resp)


def main() -> int:
    with tempfile.TemporaryDirectory() as rtmp:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), MockBridge)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        bridge = f"http://127.0.0.1:{srv.server_address[1]}"

        ws = RemoteWorkspace(rtmp, bridge)

        # heredoc round trip: $, backticks, single/double quotes, tab, newline
        tricky = "l1\nwith $VAR `bt` 'sq' \"dq\"\n\ttab\tend\n"
        ws.write("sub/deep/f.txt", tricky)
        check(ws.read("sub/deep/f.txt") == tricky, "remote write/read byte-identical")
        check(ws.read("sub/deep/f.txt") == LocalWorkspace(rtmp).read("sub/deep/f.txt"), "matches local bytes")

        # byte-exact writes: printf adds no newline (heredoc's trailing-\n caveat is gone)
        ws.write("no-nl.txt", "abc")
        check(ws.read("no-nl.txt") == "abc", "remote write is byte-exact (no added newline)")

        # large content: single multi-KB command would kill a minimal sshd — chunking
        # must keep every exec command under the cap AND preserve the bytes exactly
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
        check(r.code == 0 and r.stdout.strip() == rtmp, "remote run cwd = root")

        # oversized run_command: rejected up front (TransportError) instead of killing
        # the tunnel — and it never reaches the bridge (max_cmd_len stays small)
        try:
            ws.run("echo " + ("x" * 20000), 30.0)
            check(False, "oversized command raises TransportError")
        except TransportError:
            check(True, "oversized command raises TransportError before exec")
        check(
            MockBridge.max_cmd_len <= _EXEC_CHUNK_BYTES + 200,
            f"rejected command never reached the bridge (max {MockBridge.max_cmd_len} bytes)",
        )
        ws.protect(Path(rtmp) / "sub" / "secret.txt")
        ws.write("sub/secret.txt", "x")
        check("secret.txt" not in ws.list("sub"), "remote list hides protected files")

        # list_many: one exec lists a whole level; results match per-dir list();
        # missing dirs come back empty. Also hidden entries are NOT pre-filtered by
        # ls (the tree walk filters), so a dotfile dir appears here too.
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

        srv.shutdown()

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
