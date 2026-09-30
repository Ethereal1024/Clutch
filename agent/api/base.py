"""The request plumbing every endpoint mixin inherits: responses and the app handoff.

An endpoint needs three things beyond the request itself — the config, the run
state, and the broadcaster — and all three hang off the server, attached by
`build()` in agent/server.py. This module owns that handoff and the uniform ways
to answer: CORS, a JSON body, the request body read, and the peer-gone handling
that keeps a closed window from printing a traceback per request.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from typing import TYPE_CHECKING, Any

from ..base import Broadcaster, RunState
from ..config import Config

if TYPE_CHECKING:  # annotations only: importing agent.server at runtime would be circular
    from ..server import ClutchServer, HttpAgentServer


class HandlerBase(BaseHTTPRequestHandler):
    """The HTTP plumbing shared by every endpoint mixin.

    Only this class derives from BaseHTTPRequestHandler; the concern mixins are
    plain classes that agent/server.py composes into Handler.
    """

    server: ClutchServer  # type: ignore

    # the app (HttpAgentServer) holds config/broadcaster/state; expose them to the
    # handler uniformly.
    @property
    def _app(self) -> HttpAgentServer:
        return self.server.app

    @property
    def _cfg(self) -> Config:
        return self._app.config

    @property
    def _state(self) -> RunState:
        return self._app.state

    @property
    def _broadcaster(self) -> Broadcaster:
        return self._app.broadcaster

    def _server_module(self) -> Any:
        """The process module, ``agent.server``.

        Two things the endpoint mixins still need live there, both addressed BY
        THAT MODULE'S NAME from outside this package: the settings store
        (tests/server_test.py patches ``server.load_settings``;
        agent/tools/hostconfig.py documents ``server._settings_path``) and the SSE
        pacing constant (tests/server_test.py patches
        ``server.SSE_KEEPALIVE_SEC`` to prove the keepalive fires).

        They are therefore read through here, per call, never bound at import
        time: a module-level import would freeze the value against such a patch,
        and — because agent/server.py imports this package while it is still
        executing — would import a half-initialized module.
        """
        from .. import server

        return server

    # A client that vanishes mid-request — window closed, or the UI's health
    # probe aborted by its timeout (server-bootstrap.js) — leaves the next
    # read/write on a dead socket. Windows reports WSAECONNABORTED/WSAECONNRESET
    # (ConnectionAbortedError/ConnectionResetError) where POSIX usually just
    # returns EOF, so without this socketserver prints a full traceback once per
    # closed window (the failure happens in handle_one_request's request-line
    # read, before any of our code runs). Real handler bugs are not
    # ConnectionErrors and still print.
    _PEER_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)

    def handle(self) -> None:
        try:
            super().handle()
        except self._PEER_GONE:
            self.close_connection = True

    def _cors(self) -> None:
        # the UI runs on its own origin/host; every response must be readable there
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:  # noqa: N802
        # CORS preflight for POST + Content-Type from the UI's origin
        self.send_response(204)
        self._cors()
        self.end_headers()
    def _read_body(self) -> dict | None:
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except ValueError:
            # malformed JSON body or Content-Length header: user error -> 400
            return None
        return data if isinstance(data, dict) else None

    def _json(self, obj: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:  # silence request spam
        print(f"[http] {self.address_string()} {format % args}")


