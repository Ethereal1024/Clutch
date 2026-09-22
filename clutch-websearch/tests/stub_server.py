"""A searxng-shaped search endpoint + a link-carrying page, over a real socket.

Pins the module's contract from the OUTSIDE: enabling searxng is enough to
search (no keyless backend needs to be reachable), the chain really parses a
backend's JSON, and the fetch path really keeps hrefs — the P0 fix, proven
through HTTP rather than through the extractor's return value.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# a page whose only pointer to the repository is a button label + href: the
# exact shape that cost the postmortem session four honest 404s
PAGE = """<html><head><title>SRU project</title></head><body>
<nav>home / code / about</nav>
<p>Official code lives on GitHub:</p>
<a href="/orgs/leggedrobotics/repos"><div><img alt="GitHub" src="gh.png"></div></a>
<footer>contact</footer></body></html>"""


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 -- http.server's spelling
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/search":
            q = urllib.parse.parse_qs(parsed.query).get("q", [""])[0]
            body = json.dumps(
                {
                    "results": [
                        {
                            "title": f"About {q}",
                            "url": "https://example.com/first",
                            "content": f"a snippet mentioning {q}",
                        },
                        {"title": "Second", "url": "https://example.com/second", "content": "another snippet"},
                    ]
                }
            ).encode("utf-8")
            ctype = "application/json"
        elif parsed.path == "/page.html":
            body, ctype = PAGE.encode("utf-8"), "text/html; charset=utf-8"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:  # keep the test output clean
        return


@contextmanager
def start_stub():
    """Yield the stub's base URL (127.0.0.1, ephemeral port)."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
