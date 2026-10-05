"""The live channel: SSE, plus the two POSTs a blocked run needs from the UI.

`_sse` replays the active project's history and then streams live events out of
the broadcaster's private queue; `_permission_respond` and `_backend` resolve a
permission ask and re-point the session's backend. The keepalive frame is a NAMED
event, not a comment heartbeat — the reasoning is on SSE_PING_FRAME in
agent/server.py, and ui/js/sse-stream.js keys its liveness check on that name.
Paced through `_server_module()` so tests/server_test.py's SSE_KEEPALIVE_SEC patch
still reaches the loop.
"""

from __future__ import annotations

import json
import queue
import time
from pathlib import Path

from ..base import LAGGED
from ..core.lazy import LazyEventLog
from ..core.project_lock import ProjectLock
from ..events import Event, PermissionRequestEvent, StateUpdateEvent, event_to_json
from ..project import Project, open_project_lazy


def _arm_send_deadline(host, conn) -> None:
    """Cap how long ONE frame may take to leave this host (SSE_WRITE_TIMEOUT_S).

    A peer that stopped READING (a hung window, a tunnel whose client side is
    gone while its kernel still ACKs) makes send() block with nothing to wait
    for. That is the failure that hid the worst bug this module has had: the
    handler sits in the write, its `finally: unsubscribe()` never runs, and the
    Broadcaster goes on counting a subscriber that will never see another byte —
    so the gate publishes an ask to nobody and holds the run forever.

    With the deadline the blocked frame raises (TimeoutError, in host._SSE_ERR),
    the live loop breaks, and the subscription ends with it. The cost of ending
    a stream is zero: every durable frame is in the log the window re-reads from
    its own offset when it comes back.
    """
    timeout = getattr(host, "SSE_WRITE_TIMEOUT_S", 0)
    if not timeout or conn is None:
        return
    try:
        conn.settimeout(timeout)
    except OSError:
        # a socket wrapper that cannot take a deadline (an exotic SSL layer):
        # peer_gone still catches the closed peer, and a blocked write is no
        # worse here than it was before
        pass


class EventsMixin:
    "The SSE stream and the POSTs that answer a live run."
    def _permission_respond(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        request_id = (body.get("request_id") or "").strip()
        allow = bool(body.get("allow"))
        gate = self._state.gate
        if gate is None or not request_id:
            return self._json({"error": "no pending permission request"}, status=400)
        if not gate.resolve(request_id, allow):
            return self._json({"error": "request not found or already resolved"}, status=404)
        self._json({"status": "ok"})

    def _backend(self) -> None:
        """Switch between the local and the SSH-degradation backend. The renderer
        posts {mode:"ssh", bridge, workspace} when bootstrap fails on a host that
        has no Python, and {mode:"local"} when it disconnects/resets."""
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        mode = body.get("mode") or "local"
        if mode == "ssh":
            bridge = (body.get("bridge") or "").strip()
            if not bridge:
                return self._json({"error": "bridge is required for ssh mode"}, status=400)
            root = (body.get("workspace") or "").strip() or str(Path.home())
            self._state.set_backend("ssh", bridge, root)
        else:
            self._state.set_backend("local")
        # a mode switch invalidates the window's project context (set_backend
        # clears it): drop any locks it still holds so they never linger
        ProjectLock.release_all()
        self._json({"status": "ok"})

    def _project_for_sse(self, project_q: str | None) -> Project | None:
        """Resolve the project an SSE subscriber asked to watch: the global
        active one when no project is given (or it matches), otherwise open the
        requested .clc fresh. Failures degrade to None (skip replay)."""
        try:
            if project_q:
                global_proj = self._state.project
                if global_proj is not None and str(global_proj.path) == project_q:
                    return global_proj
                full = self._project_path(project_q)
                if full.suffix == ".clc" and (self._state.backend_mode == "ssh" or full.is_file()):
                    ws = self._state.build_workspace(str(full.parent))
                    # SSE only replays/watchs: open read-only so a subscriber
                    # never takes the write lock (or fights the real writer)
                    return open_project_lazy(full, workspace=ws, read_only=True)
                return None
            return self._state.project
        except (OSError, ValueError):
            return None

    def _sse(self, project_q: str | None = None, replay: bool = True,
             since: int | None = None) -> None:
        """One window's view of one project: a status frame, the records it is
        owed, then the live tail.

        The wire has exactly one way to say "I have painted up to here": ``since``
        (a .clc byte offset, the same space the log's own offsets live in, and the
        same one ui/js/stream-events.js keeps as its watermark). Everything this
        handler sends is a function of that offset and the log:

        * ``since`` absent -- a window that has painted nothing (boot, a fresh
          project): serve the resident window, and let the older-pill account for
          the rest. ``replay`` stays the legacy spelling of this (0.1.18 clients).
        * ``since = N`` -- serve EVERY durable record after N, read from disk as
          well as memory: the resident window starts at the newest compaction
          line, so a window that was away longer than that is still owed the
          records in between. Skipping them would be a silent hole in a
          transcript, which is the one thing a reconnect may not produce.
        * ``since`` past the end of the log -- the file was replaced under this
          window, so its offset cannot be continued from at all: say so
          (``{"type": "resync"}``, the renderer starts the pane over) and serve
          the window, rather than answer a request that cannot be honoured.

        Deltas and host-made announcements are never in the log, so a catch-up
        cannot recover them: their durable outcome (the message they were
        streaming) is replayed instead.
        """
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        host = self._server_module()  # the pacing constants and the ping frame live there
        _arm_send_deadline(host, self.connection)
        # the subscription names the project this stream watches: it is the
        # audience for that project's prompts (and no other's)
        q = self._broadcaster.subscribe(project_q)
        try:
            # the status frame is a RESET for a window that has nothing in
            # flight (a project switch, an interrupted run) — and it is also
            # what a RECONNECTING window gets (EventSource retry, a phone
            # returning from the background, a tunnel healer). Saying "idle"
            # there was a lie the moment a run was still in flight: the window
            # painted a running task as idle for the rest of the run, since the
            # run emits its own "running" only once, at the start. So report the
            # host's real state instead: in flight for the project this stream
            # watches = running, anything else = idle.
            in_flight = bool(self._state.busy) and (
                not project_q or self._state.run_project == project_q
            )
            try:
                self._write_sse(StateUpdateEvent(
                    key="execution_status", value="running" if in_flight else "idle"))
                # replay durable events only (deltas are transient); replay=False
                # skips it when the UI just rendered the open NDJSON stream
                if replay or since is not None:
                    project = self._project_for_sse(project_q)
                    if project is not None:
                        log = project.log
                        if since is not None and since > log.cpr_start() + log.window_bytes():
                            # the offset is past the end of this log: the pane can
                            # not be continued from it, and saying nothing would
                            # leave two different transcripts on one screen
                            self._write_sse_raw({"type": "resync"})
                            since = None
                        # lazy log: resident events replay with byte offsets + the
                        # on-disk older count
                        self._write_sse_raw({"type": "history", "older": max(0, log.cpr_start())})
                        owed = self._owed_records(log, since)
                        for off, ev in owed:
                            self._write_sse(ev, offset=off)
                        # the block is closed explicitly: the renderer paints a
                        # catch-up in one pass and scrolls once, and only this
                        # frame tells it the block is over
                        self._write_sse_raw({"type": "replayed", "count": len(owed)})
            except host._SSE_ERR:
                return  # client went away mid-status/replay: nothing left to stream
            # every permission ask still waiting. An ask is STATE, not a frame
            # that was sent once: a window can miss its publish (a reload
            # mid-ask, an EventSource between reconnects, a renderer still
            # reconstructing history — which drops live prompts on purpose), and
            # a prompt nobody has seen blocks the run until the user gives up on
            # it. So every (re)connect of a stream that can answer the ask is
            # handed the ones still on the table — the same event, same
            # request_id, which the UI renders in place (or recovers after a
            # reload), and the gate re-announces while they wait (REANNOUNCE_S).
            try:
                gate = self._state.gate
                rp = self._state.run_project
                if gate is not None and not (rp and project_q and rp != project_q):
                    for request_id, tool, args_repr, reason in gate.pending_asks():
                        self._write_sse(PermissionRequestEvent(
                            request_id=request_id, tool=tool, args_repr=args_repr, reason=reason))
            except host._SSE_ERR:
                return  # client went away: nothing left to stream
            # then live events
            peer_check_at = time.monotonic() + host.SSE_PEER_CHECK_SEC
            while True:
                try:
                    ev = q.get(timeout=host.SSE_KEEPALIVE_SEC)
                    if ev is LAGGED:
                        # this window stopped draining (a phone in the background
                        # holds a socket that never errors): ending the stream is
                        # the honest answer and costs nothing, because every frame
                        # it missed is in the log it will ask for again
                        break
                    rp = self._state.run_project
                    if rp and project_q and rp != project_q:
                        continue  # another window's run: don't leak its events here
                    # A run that streams deltas never falls into the idle branch
                    # below, which is the only place the keepalive looks for a
                    # peer that CLOSED its socket. So look here too: the FIN is
                    # already at the socket (peer_gone), while the kernel buffer
                    # would keep swallowing writes for megabytes — time in which
                    # this stream still answers "a UI is watching" (the gate's
                    # is_attached) to a window that is gone. Paced: a per-token
                    # stream must not pay a select() per frame for a fact that
                    # cannot change faster than this.
                    now = time.monotonic()
                    if now >= peer_check_at:
                        peer_check_at = now + host.SSE_PEER_CHECK_SEC
                        if host.peer_gone(self.connection):
                            break
                    self._write_sse(ev)
                except queue.Empty:
                    try:
                        # the peer may be gone WITHOUT the write failing (a
                        # half-closed tunnel: writes land in a buffer nobody
                        # reads). Notice it, so the subscription ends and the
                        # count that answers "is anyone watching?" stops
                        # counting a ghost — see agent/server.py peer_gone.
                        if host.peer_gone(self.connection):
                            break
                        self.wfile.write(host.SSE_PING_FRAME)
                        self.wfile.flush()
                    except host._SSE_ERR:
                        break
                except host._SSE_ERR:
                    break
        finally:
            self._broadcaster.unsubscribe(q)

    @staticmethod
    def _owed_records(log: LazyEventLog, since: int | None) -> list[tuple[int, Event]]:
        """The durable records a (re)connecting window is owed, in file order.

        Without ``since``: the resident window, which is what a window that has
        painted nothing wants (the older-pill accounts for the rest). With
        ``since``: every record after that byte offset, from DISK as well as
        memory — the resident window starts at the newest compaction line, so a
        window that was away longer than that would otherwise be handed a
        transcript with a gap in it, silently.
        """
        if since is None:
            return log.items()
        start = log.cpr_start()
        # read_page is [lo, hi): strict, because a record AT the watermark is one
        # this window has already painted (the renderer skips it either way, but
        # sending it back is a wire cost with no reader)
        older = log.read_page(since + 1, start) if since < start else []
        return older + [(off, ev) for off, ev in log.items() if off > since]

    def _write_sse(self, ev: Event, offset: int | None = None) -> None:
        """Emit one SSE event; with ``offset`` the payload is {offset, event} (the
        lazy replay/open wire shape), otherwise the bare event JSON. event_to_json
        already returns a serialized string, so only the wrapped shape is
        re-serialized (no double encoding).

        A DURABLE event carries its own log offset, stamped when the log appended
        it (agent/core/lazy.py), so the live frame is the same {offset, event}
        shape the replay sends: the renderer's watermark can then skip what this
        window already painted instead of painting the whole window again after a
        reconnect. Deltas and host-made announcements (a status, a permission
        ask, a crashed run's final) are never appended, so they stay bare.
        """
        if offset is None:
            offset = getattr(ev, "log_offset", None)
        if offset is not None:
            payload = json.dumps({"offset": offset, "event": json.loads(event_to_json(ev))})
        else:
            payload = event_to_json(ev)
        self.wfile.write(f"data: {payload}\n\n".encode())
        self.wfile.flush()

    def _write_sse_raw(self, obj: dict) -> None:
        self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
        self.wfile.flush()
