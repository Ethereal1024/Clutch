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
from .workspace import LocalWorkspace, RemoteWorkspace


class MockBridge(BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:  # silence request spam
        pass

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/exec":
            self.send_response(404)
            self.end_headers()
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        cmd = body.get("command", "")
        timeout_ms = body.get("timeout", 60000)
        try:
            r = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=timeout_ms / 1000
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

        # trailing-newline semantics (heredoc adds one; documented)
        ws.write("no-nl.txt", "abc")
        check(ws.read("no-nl.txt") == "abc\n", "remote write appends one trailing newline")

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
        ws.protect(Path(rtmp) / "sub" / "secret.txt")
        ws.write("sub/secret.txt", "x")
        check("secret.txt" not in ws.list("sub"), "remote list hides protected files")

        # append_line -> quoted heredoc >>, round trips special chars too
        ws.append_line("log.txt", '{"a": "$x"}')
        ws.append_line("log.txt", "second")
        check(ws.read("log.txt") == '{"a": "$x"}\nsecond\n', "remote append_line")

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
