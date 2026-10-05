"""API-only HTTP + SSE server hosting the agent (the UI is a separate app).

Endpoints (all JSON except SSE/NDJSON):
  POST /api/project/new    {dir, name} -> create a .clc project file
  POST /api/project/open   {path} -> load a .clc project (NDJSON stream)
  POST /api/run            {task} -> start run on the active project (409 if busy)
  POST /api/stop           cancel the running agent
  GET  /api/events         SSE: replay active project history, then live events
  GET  /api/workspace/tree   file tree under the project's working directory
  GET  /api/fs/list           server-side directory browser (one level)
  GET  /api/clc?lo&hi         byte range of the active .clc -> {size, b64}
  POST /api/clc/append {line} append one line -> {offset, size}
  POST /api/clc/patch {offset, b64}  in-place byte patch (never grows the file)
  GET  /api/health         {ok, in_flight}  in_flight: a run is live right now

A session can also be RELEASED from outside (the last window's exit,
/api/shutdown, a reap that raced a run's start). A SIGTERM with a run in flight
is therefore answered with one durable final before this process goes — the
ending the run could not write for itself. See install_release_handler.

CORS is wide open (Access-Control-Allow-Origin: *) so the decoupled UI can live
on another origin/host. The API key travels in request bodies, not cookies, so a
wildcard origin leaks nothing. Bind --host 0.0.0.0 to expose beyond localhost.

The agent's existing sink is fed into a thread-safe broadcaster; each SSE subscriber
gets a private queue. One run at a time; Stop sets a cancel flag checked by the loop.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import signal
import socket
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

from .api.base import HandlerBase
from .api.events import EventsMixin
from .api.project import ProjectMixin
from .api.routing import RoutingMixin
from .api.run import RunMixin
from .api.settings import SettingsMixin
from .api.workspace import WorkspaceMixin
from .base import BaseServer, Broadcaster, RunState
from .config import API_PROTOCOLS, REASONING_EFFORT_LEVELS, Config, flatten_settings
from .events import FinalEvent
from .project import Project
from .tools.workspace import Workspace

# a client hanging up mid-SSE surfaces as one of these on the socket write;
# end cleanly, never let socketserver print a traceback. The class is host
# dependent: POSIX gives BrokenPipeError (EPIPE) or ConnectionResetError
# (ECONNRESET) when the peer is gone, Windows gives ConnectionAbortedError
# (WSAECONNABORTED/WSAECONNRESET), so leaving it out spams one traceback per
# closed window on Windows. ValueError covers a write on an already-closed
# stream.
_SSE_ERR = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ValueError)

# Idle gap after which the stream reasserts that it is still there. Bounded by
# nothing on the client side: a half-open TCP connection (writes vanish into a
# peer that will never answer) raises no error here and no error in the
# browser's EventSource either, which is why the client is told explicitly.
SSE_KEEPALIVE_SEC = 15

# The keepalive is a NAMED event, not the usual `: comment` heartbeat. A
# comment never reaches any listener — an EventSource client cannot tell a
# live-but-idle stream from a socket that died an hour ago, and the UI's
# "running" state is a CACHE it can only refresh from this stream: an
# unnoticed death leaves the window showing a run that is not there, with a
# Stop button that posts into nothing. A named event lands in
# addEventListener("ping"), which is what lets the renderer prove liveness
# (ui/js/sse-stream.js SSE_KEEPALIVE_MS must match this value).
SSE_PING_FRAME = b"event: ping\ndata: {}\n\n"


def peer_gone(conn) -> bool:
    """Whether the client has closed its side of this SSE connection.

    A peer that half-closes — a torn-down tunnel, a window destroyed without a
    close-notify — leaves the socket in CLOSE-WAIT, and our writes keep
    succeeding into the kernel buffer (megabytes of keepalives and events,
    observed live) so the stream looks "attached" long after its window is gone.
    That count is what answers "is anyone watching this project?" (the gate's
    is_attached, and the unattended-lock watchdog below), so a ghost subscriber
    is not cosmetic: it holds the write lock of a .clc nobody is looking at.

    Readability first, then a non-blocking MSG_PEEK: b"" means the peer's FIN
    has arrived, a byte means the peer sent something (a pipelined request),
    nothing at all means alive and quiet. Nothing is ever consumed. A socket
    that refuses MSG_PEEK (an SSL wrapper) is left alone rather than guessed at.
    """
    if conn is None:
        return False
    try:
        ready, _, _ = select.select([conn], [], [], 0)
    except (OSError, ValueError):
        return True
    if not ready:
        return False
    try:
        return conn.recv(1, socket.MSG_PEEK) == b""
    except ValueError:  # no MSG_PEEK on this socket type: cannot tell, assume alive
        return False
    except OSError:  # reset/aborted: the connection can no longer be written to
        return True


# How long a project may keep its write lock with no window watching it. The
# lock arbitrates two windows EDITING one .clc, and a project nobody watches has
# no editor: the window that opened it is gone (the app quit, the client died,
# the tunnel will not come back) and the lock left behind is not a claim but a
# leak — every other window is refused with "already open in another window" for
# as long as it lasts. That is the state the user reports as "the .clc is locked
# again", minutes after the window that held it disappeared.
#
# Neither zero nor the supervisor's STALE_S (300 s, which must cover a client's
# whole tunnel-redial ladder): a window is legitimately absent for a moment at a
# time. This is the same evidence and the same window the permission gate uses to
# decide a prompt has nobody left to answer it (DETACH_GRACE_S,
# agent/core/permission.py): a stream gone that long is not a window that comes
# back to edit. A window that DOES come back re-enters exactly like a run does —
# its .clc is re-opened for write (/api/run carries the project) — which is also
# where it learns somebody else took it.
UNATTENDED_GRACE_S = 30.0
UNATTENDED_POLL_S = 2.0


def unattended_lock_watchdog(
    state: RunState,
    broadcaster: Broadcaster,
    grace_s: float = UNATTENDED_GRACE_S,
    poll_s: float = UNATTENDED_POLL_S,
) -> threading.Thread:
    """Hand back the active project's write lock once its audience is gone.

    Polls "is a window watching the active project?" (the broadcaster's live
    subscriber count, now that a half-closed peer stops counting) and, after
    `grace_s` of continuous silence, re-opens the project READ-ONLY — which
    releases the flock while leaving the window's transcript, tree and SSE scope
    intact for whoever comes back (RunState.release_write_claim).

    A run in flight is NOT an absent window: it is a writer that is still there
    (the supervisor keeps a session with a run for the same reason), and it
    appends to this .clc, so the claim stands for as long as it lasts. It does
    not stop the clock: when the run ends with still nobody watching, the lock
    goes on the next tick instead of waiting out the supervisor's stale window.
    """
    def _loop() -> None:
        watched: Path | None = None
        unattended_since: float | None = None
        while True:
            time.sleep(poll_s)
            project = state.project
            if project is None or project.read_only or project.lock is None:
                watched, unattended_since = None, None
                continue
            if project.path != watched:
                watched, unattended_since = project.path, None
            if state.busy:
                continue
            if broadcaster.count(str(project.path)) > 0:
                unattended_since = None
                continue
            now = time.monotonic()
            if unattended_since is None:
                unattended_since = now
                continue
            if now - unattended_since >= grace_s:
                if state.release_write_claim():
                    print(
                        f"[clutch-server] no window watching {project.path.name}: "
                        "released its write lock",
                        flush=True,
                    )
                watched, unattended_since = None, None

    thread = threading.Thread(target=_loop, name="clutch-unattended-lock", daemon=True)
    thread.start()
    return thread


def _settings_path() -> Path:
    return Path.home() / ".clutch" / "settings.json"


def load_settings() -> dict:
    """Read persisted settings (api_key). The file lives outside the repo on purpose."""
    p = _settings_path()
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_settings(data: dict) -> None:
    p = _settings_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        p.chmod(0o600)  # owner-only, the file holds a credential
    except OSError as e:
        print(f"[clutch-server] cannot persist settings: {e}", file=sys.stderr)


class HttpAgentServer(BaseServer):
    """The run-assembly contract for the HTTP host; routing lives in Handler."""

    def build_workspace(self, project: Project) -> Workspace:
        return self.state.build_workspace(str(project.workdir))


class Handler(
    RoutingMixin,
    RunMixin,
    SettingsMixin,
    EventsMixin,
    WorkspaceMixin,
    ProjectMixin,
    HandlerBase,
):
    """One request's handler, assembled from the concern mixins in agent/api/.

    The bases are ordered so the endpoint mixins win over the plumbing: only
    HandlerBase derives from BaseHTTPRequestHandler. Each mixin resolves the rest
    through `self` at call time, which is why their order among themselves does
    not matter beyond this line.
    """


class ClutchServer(ThreadingHTTPServer):
    # the app (HttpAgentServer) holds config/broadcaster/state; injected by build()
    app: HttpAgentServer


def build(
    config: Config,
    broadcaster: Broadcaster,
    state: RunState,
) -> ClutchServer:
    app = HttpAgentServer(config, broadcaster, state)
    srv = ClutchServer((config.host, config.port), Handler)
    srv.app = app
    # Publish the port the socket ACTUALLY got. With --port 0 — how the
    # supervisor spawns every session child — the OS picks it, and the host facts
    # a component's statement renders from (host.port_url, i.e.
    # clutch-memory's --endpoint) have to name the port that is listening. Left
    # at 0, a component is pointed at http://127.0.0.1:0 and its first read dies
    # with "Connection refused": the tool is in the model's surface but can never
    # reach this process.
    config.port = srv.server_address[1]
    return srv


# What a released run's durable ending says. The run could not write its own
# final (nothing of its own code is running any more), and the alternative — a
# `.clc` tail ending in a tool_result or an assistant_message with no final —
# is a transcript that cannot settle: the window watches `running` flip to
# `idle` with nothing to explain it, and the run's outcome is unknowable from
# the file afterwards.
RELEASED_SUMMARY = "the host released this session while the run was in flight"


def record_release(state: RunState) -> None:
    """Write the ending a run in flight could not write for itself.

    A session is released from OUTSIDE (the last window's exit, /api/shutdown,
    a reap that raced the run's start), so no code of the run's own gets to run
    again: if there was a run in flight, the durable record of how it ended has
    to be written here, on the way out.

    Deliberately not the cancel path. /api/stop means the user asked, and the
    loop answers that itself with a cancelled-flavoured final; a release is
    something only the departing process can report, and it is an ERROR — the
    work stopped for a reason that had nothing to do with the task.

    The run slot is read without the lock (a signal handler must never block on
    a lock some worker holds). It cannot change hands underneath us: POST
    /api/run refuses to replace the active project while busy, so during a run
    ``state.project`` IS the running project, and ``busy`` only ever goes
    True -> False.
    """
    project = state.project
    if project is None or not state.busy:
        return
    try:
        project.log.append(FinalEvent(status="error", summary=RELEASED_SUMMARY))
        print(f"[clutch-server] {RELEASED_SUMMARY}", flush=True)
    except Exception as e:  # noqa: BLE001 - already going down: never mask why
        print(f"[clutch-server] cannot record the release: {e}", file=sys.stderr)


def install_release_handler(state: RunState) -> None:
    """Make this process say how a run ended when the host releases it.

    The supervisor's stop ladder opens with a SIGTERM to the process group and
    waits KILL_GRACE_S before the hard kill (agent/procmgr/kill.py), so there is
    a window to write one line — and one line is all this takes.

    POSIX-only by construction: the ladder's Windows step is a Job close, which
    is a hard kill with no deliverable signal. There, a released run leaves the
    unsettled transcript above, and the client has to cope with a run that
    simply stops — see ui/js/sse-stream.js's stale-run rule.
    """
    if os.name != "posix":
        return

    def _on_term(_signum, _frame) -> None:
        record_release(state)
        # the signal means "go away now", so never resume serving: raising here
        # unwinds the main thread out of serve_forever, the only way out that
        # does not need a second thread (shutdown() may not be called by the
        # thread that is serving)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _on_term)


def main() -> int:
    defaults = Config()
    parser = argparse.ArgumentParser(prog="clutch-server")
    parser.add_argument("--host", default=defaults.host, help="bind address (0.0.0.0 to expose to other devices)")
    parser.add_argument("--port", type=int, default=defaults.port)
    parser.add_argument("--model", default=None)
    parser.add_argument(
        "--reasoning-effort",
        choices=REASONING_EFFORT_LEVELS,
        default=None,
        help="reasoning effort the claiming client wants (rides with --model; default = saved settings)",
    )
    parser.add_argument(
        "--api-protocol",
        choices=API_PROTOCOLS,
        default=None,
        help="API protocol the claiming client wants: chat | responses (rides with --model)",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help=(
            "LLM API base URL. Point at the client-side proxy "
            "(http://127.0.0.1:8892/v1) when the server has no internet."
        ),
    )
    args = parser.parse_args()

    config = Config()
    config.host = args.host
    config.port = args.port

    # LLM endpoint resolution — precedence: CLI args > env > GUI-saved settings
    # (flat ~/.clutch/settings.json; legacy profile-map files migrate on read)
    saved = flatten_settings(load_settings())
    if args.base_url:
        config.base_url = args.base_url
    elif not config.base_url:
        config.base_url = saved.get("base_url", "")
    if args.model:
        config.model = args.model
    elif not config.model:
        config.model = saved.get("model", "")
    # API key: env > saved settings > config default
    config.api_key = config.api_key or saved.get("api_key")
    # reasoning_effort / api_protocol: env-less; precedence is CLI (the session
    # claim) > saved settings. A claiming client owns them for the same reason
    # it owns the model: the remote host has no usable settings file of its own.
    if args.reasoning_effort:
        config.llm_reasoning_effort = args.reasoning_effort
    elif not config.llm_reasoning_effort:
        config.llm_reasoning_effort = saved.get("reasoning_effort") or None
    if args.api_protocol:
        config.llm_api_protocol = args.api_protocol
    elif not config.llm_api_protocol:
        config.llm_api_protocol = saved.get("api_protocol") or None
    api_key = config.api_key
    if args.base_url and not api_key:
        # the client-side proxy injects the real key; the server only needs a
        # placeholder. No env fallback: the key comes from the UI settings
        # (state.api_key) or an explicit config.api_key.
        api_key = "proxy"

    broadcaster = Broadcaster()
    state = RunState()
    # restore the settings persisted by the GUI (api key + LLM endpoint)
    state.api_key = api_key

    srv = build(config, broadcaster, state)
    # a session released mid-run still leaves a settled transcript (POSIX)
    install_release_handler(state)
    # a window that went away must not keep its project's write lock (see the
    # watchdog's own comment: waiting out the supervisor's stale window instead
    # leaves the .clc locked for minutes after its window is gone)
    unattended_lock_watchdog(state, broadcaster)
    # --port 0 makes the OS pick a free port; stdout is the only channel back to
    # the spawning Electron shell, so print the REAL bound port — always as the
    # loopback address, because the UI's port regex keys on 127.0.0.1:<port>.
    bound_port = config.port  # build() published what the socket got, not the 0
    # resolved LLM endpoint, for diagnosing which endpoint a session targets;
    # the label keeps the line from ever matching the port banner regex
    print(
        f"[clutch-server] LLM: model={config.model} base_url={config.base_url} "
        f"protocol={config.llm_api_protocol or 'chat'}",
        flush=True,
    )
    print(f"[clutch-server] http://127.0.0.1:{bound_port}  (API only; start the UI separately)", flush=True)
    # No lock cleanup on exit is needed: every project lock is a kernel lock
    # (flock / LockFileEx) in the local OS temp dir, and the OS releases it when
    # this process dies.
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
