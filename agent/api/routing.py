"""The URL surface: which path and method reaches which endpoint.

Nothing here does work; every branch is one line naming the endpoint it calls.
Kept apart from the implementations so the API's shape reads in one screen — a
new endpoint shows up here and in the endpoint list in agent/server.py's
module docstring, and nowhere else.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse


class RoutingMixin:
    "Dispatch only: the URL table this API answers to."
    # ---- routing ----
    # Handlers raise on unexpected errors: ThreadingHTTPServer prints the full
    # traceback (handle_error) and closes the connection, exposing bugs loudly.

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            # in_flight is what the supervisor's stale-session rule asks: a run
            # in flight is the child's own liveness evidence, so a window that
            # went silent (a phone in the background, its timers frozen) must
            # not cost an in-flight run its session.
            self._json({"ok": True, "in_flight": bool(self._state.busy)})
        elif path == "/api/events":
            params = parse_qs(parsed.query)
            # since=<byte offset>: the highest .clc offset this window has already
            # painted. Absent (or unusable) means "I have painted nothing", which
            # is the legacy replay=1; replay=0 is the legacy "the open NDJSON
            # stream already rendered it" and is kept for 0.1.18 clients.
            raw_since = (params.get("since") or [None])[0]
            try:
                since = max(0, int(raw_since)) if raw_since is not None else None
            except ValueError:
                since = None
            self._sse(
                (params.get("project") or [None])[0],
                (params.get("replay") or ["1"])[0] != "0",
                since,
            )
        elif path == "/api/history":
            self._history()
        elif path == "/api/workspace/tree":
            self._workspace_tree()
        elif path == "/api/fs/list":
            self._fs_list()
        elif path == "/api/clc":
            self._clc_read()
        elif path == "/api/settings":
            self._settings_get()
        elif path == "/api/host":
            self._host_get()
        else:
            self._json({"error": "not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/project/new":
            self._project_new()
        elif parsed.path == "/api/project/open":
            self._project_open()
        elif parsed.path == "/api/run":
            self._run()
        elif parsed.path == "/api/stop":
            self._stop()
        elif parsed.path == "/api/settings":
            self._settings_post()
        elif parsed.path == "/api/permission/respond":
            self._permission_respond()
        elif parsed.path == "/api/workspace/revert":
            self._workspace_revert()
        elif parsed.path == "/api/backend":
            self._backend()
        elif parsed.path == "/api/clc/append":
            self._clc_append()
        elif parsed.path == "/api/clc/patch":
            self._clc_patch()
        else:
            self._json({"error": "not found"}, status=404)
