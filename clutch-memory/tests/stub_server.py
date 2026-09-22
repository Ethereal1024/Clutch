"""Test double: the .clc content service contract over a REAL file.

This stub is the wire contract as seen from outside the host — the same
three endpoints, the same JSON shapes, real byte semantics (append adds
exactly one \\n; patch never grows the file). If the host and this stub
ever disagree, the contract has drifted and both sides must be re-checked.
"""

from __future__ import annotations

import base64
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class _StubHandler(BaseHTTPRequestHandler):
    server: "_StubServer"

    def _json(self, obj, status: int = 200) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/clc":
            return self._json({"error": "not found"}, status=404)
        qs = parse_qs(parsed.query)
        size = os.path.getsize(self.server.clc_path)
        lo = int((qs.get("lo") or ["0"])[0])
        hi = int((qs.get("hi") or [str(size)])[0])
        if lo < 0 or hi < lo:
            return self._json({"error": "invalid range"}, status=400)
        lo, hi = min(lo, size), min(hi, size)
        with open(self.server.clc_path, "rb") as f:
            f.seek(lo)
            data = f.read(hi - lo)
        self._json({"size": size, "b64": base64.b64encode(data).decode("ascii")})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if parsed.path == "/api/clc/append":
            line = body.get("line")
            if not isinstance(line, str) or "\n" in line or "\r" in line:
                return self._json({"error": "line must be one line"}, status=400)
            with self.server.write_lock:
                off = os.path.getsize(self.server.clc_path)
                with open(self.server.clc_path, "a", encoding="utf-8", newline="\n") as f:
                    f.write(line + "\n")
                total = os.path.getsize(self.server.clc_path)
            return self._json({"offset": off, "size": total})
        if parsed.path == "/api/clc/patch":
            offset, b64 = body.get("offset"), body.get("b64")
            data = base64.b64decode(b64, validate=True)
            with self.server.write_lock:
                size = os.path.getsize(self.server.clc_path)
                if not isinstance(offset, int) or offset < 0 or offset + len(data) > size:
                    return self._json({"error": "patch must stay in place"}, status=400)
                with open(self.server.clc_path, "r+b") as f:
                    f.seek(offset)
                    f.write(data)
            return self._json({"size": size})
        return self._json({"error": "not found"}, status=404)

    def log_message(self, format: str, *args) -> None:  # silence request spam
        pass


class _StubServer(ThreadingHTTPServer):
    def __init__(self, clc_path: str) -> None:
        super().__init__(( "127.0.0.1", 0), _StubHandler)
        self.clc_path = clc_path
        self.write_lock = threading.Lock()


def start_stub(clc_path: str) -> tuple[_StubServer, str]:
    """Serve the contract over ``clc_path``; returns (server, base_url)."""
    srv = _StubServer(clc_path)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"
