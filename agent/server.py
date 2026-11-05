"""API-only HTTP + SSE server hosting the agent (the UI is a separate app).

Endpoints (all JSON except SSE/NDJSON):
  POST /api/project/new    {dir, name} -> create a .clc project file
  POST /api/project/open   {path} -> load a .clc project (NDJSON stream)
  POST /api/run            {task} -> start run on the active project (409 if busy)
  POST /api/stop           cancel the running agent
  POST /api/llm/base       {base_url, model} re-point the LIVE run's LLM endpoint
                           in memory (the claiming client's model path moved; not
                           persisted — see api/settings._llm_base_post)
  GET  /api/events         SSE: replay active project history, then live events
  GET  /api/log            the .clc as a byte-addressed log for the host's loop:
                           {items, windowBytes, cprStart, lastCompaction}
  POST /api/log {event}    append ONE durable event, answered as persisted
                           (with the offset the log stamped on it)
  POST /api/log/window {offset}  slide the model window start (header write)
  POST /api/exec {name, arguments, tool_call_id}  run ONE tool call here and
                           answer its envelope {tool_call_id, content,
                           is_error, diff}; the only permission judge (D3)
  POST /api/exec/cancel {tool_call_id}  interrupt that call's running command
  GET  /api/declarations   the declaration files this machine holds, plus the
                           values only this machine knows (availability, the
                           named config knobs, backends, published facts, the
                           ui/access/gate tables, whether a project is open) —
                           the data the HOST derives the tool surface from
  GET  /api/session        the facts one turn is asked with: mode, shell,
                           components prose, context window budget, memory anchor
  GET  /api/workspace/tree   file tree under the project's working directory
  GET  /api/workspace/checkpoints  log offsets a whole-task rollback can undo
  POST /api/workspace/rollback {offset} undo every file change from that task on
  GET  /api/fs/list           server-side directory browser (one level)
  POST /api/channel {port, token, components}  the client's plugin declarations
  GET  /api/channel        what this session holds (never the token)
  DELETE /api/channel      forget them (the client went away)
  GET  /api/health         {ok, in_flight}  in_flight: a run is live right now

A session can also be RELEASED from outside (the last window's exit,
/api/shutdown, a reap that raced a run's start). A SIGTERM with a run in flight
is therefore answered with one durable final before this process goes — the
ending the run could not write for itself. See install_release_handler. The
decision to release an orphan — a session whose claiming window is dead — is the
host's, taken from the kernel's own process identity: see
agent/core/lock_reconcile.py. This process never guesses it from silence.

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
from .api.channel import ChannelMixin
from .api.decls import DeclsMixin
from .api.events import EventsMixin
from .api.exec import ExecMixin
from .api.log import LogMixin
from .api.project import ProjectMixin
from .api.routing import RoutingMixin
from .api.run import RunMixin
from .api.session import SessionMixin
from .api.settings import SettingsMixin
from .api.workspace import WorkspaceMixin
from .base import BaseServer, Broadcaster, RunState
from .config import API_PROTOCOLS, REASONING_EFFORT_LEVELS, Config, flatten_settings
from .core.project_lock import set_context as set_lock_context
from .events import FinalEvent, StateUpdateEvent
from .project import Project
from .tools.workspace import Workspace

# a client hanging up mid-SSE surfaces as one of these on the socket write;
# end cleanly, never let socketserver print a traceback. The class is host
# dependent: POSIX gives BrokenPipeError (EPIPE) or ConnectionResetError
# (ECONNRESET) when the peer is gone, Windows gives ConnectionAbortedError
# (WSAECONNABORTED/WSAECONNRESET), so leaving it out spams one traceback per
# closed window on Windows. ValueError covers a write on an already-closed
# stream, TimeoutError the send deadline below (a peer that stopped reading
# raises nothing at all without it).
_SSE_ERR = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ValueError, TimeoutError)

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

# How long ONE frame may take to leave this host before the stream is declared
# dead. A peer that stops READING — a window that hung, a half-open tunnel whose
# client side is gone while its kernel keeps ACKing — makes send() block with
# nothing to wait for: writes neither fail nor finish. A blocked write is worse
# than a lost frame, because the handler never returns: its
# `finally: unsubscribe()` never runs (agent/api/events.py _sse), so the
# subscriber stays in the Broadcaster and count() keeps answering "a UI is
# watching" for a window that will never see another byte. That count is what
# decides whether a permission ask is handed to the UI at all and whether the
# gate's detach grace starts, so a ghost is not cosmetic — it is how an ask
# reaches a queue nobody drains and the run wedges (observed live: an ask
# published at 17:27 unanswered until the user's Stop 8 minutes later).
#
# A frame is small (one event) and the recovery is free: a stream that ends
# leaves its window re-reading the log after its own offset, and that read is
# idempotent. So the bound only has to be longer than a slow-but-progressing
# link needs for one frame — seconds — and much shorter than the minutes a
# wedged run costs.
SSE_WRITE_TIMEOUT_S = 20

# How often the live loop looks for the peer's FIN (see peer_gone from the busy
# path in agent/api/events.py _sse). The idle branch checks it on every
# keepalive, but a run that streams deltas never reaches that branch: without
# this probe a peer that CLOSED its socket keeps being written into — its kernel
# buffer swallows megabytes before any write blocks — and goes on counting as an
# audience that can answer a prompt. Paced because per-token frames must not pay
# a syscall each; a FIN cannot arrive so fast that a second of delay matters.
SSE_PEER_CHECK_SEC = 1.0


def peer_gone(conn) -> bool:
    """Whether the client has closed its side of this SSE connection.

    A peer that half-closes — a torn-down tunnel, a window destroyed without a
    close-notify — leaves the socket in CLOSE-WAIT, and our writes keep
    succeeding into the kernel buffer (megabytes of keepalives and events,
    observed live) so the stream looks "attached" long after its window is gone.
    That count is what answers "is anyone watching this project?" (the gate's
    is_attached), so a ghost subscriber is not cosmetic: it keeps a quiet stream
    alive and its session's prompt answerable by nobody.

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


# How often a WATCHING window asks the kernel for its write claim back. Read-only
# is only ever the fallback for a conflict (ui/js/project.js offers it on a 409
# and says so), never a mode the user chose, so the moment the other holder is
# gone the window still looking at the .clc has to become its writer again —
# without sending a task and without reopening the project (that would repaint
# its whole transcript). Until something asked, read_only was a one-way latch:
# the badge, and every run refused behind it, outlived the lock by hours.
#
# Nothing here hands a claim BACK. The ask either wins a lock the kernel says is
# free or is refused by it, and a session no longer releases its claim for being
# quiet: the host's reconciler ends an orphaned session instead, from the window's
# own pid (agent/core/lock_reconcile.py). Two seconds is a poll on the KERNEL,
# not a guess about a window — what decides is the claim, never elapsed time.
CLAIM_REASK_POLL_S = 2.0


def claim_reask_loop(
    state: RunState, broadcaster: Broadcaster, poll_s: float = CLAIM_REASK_POLL_S
) -> None:
    """Keep a watching window's fallback honest, one kernel question at a time.

    Only a project that is read-only, actively open here and WATCHED (at least
    one live stream on its key) is a candidate: with nobody looking there is no
    editor to hand the claim to, and the first window that reconnects asks again
    through its open/replay (agent/api/events.py _project_for_sse).

    A grant is announced as `project_read_only: False`: the claim is state only
    this process knows, so the window's badge cannot follow it any other way.
    """
    while True:
        time.sleep(poll_s)
        project = state.project
        if project is None or not project.read_only:
            continue
        if broadcaster.count(str(project.path)) == 0:
            continue
        if not state.reclaim_write_claim():
            continue
        broadcaster.publish(
            StateUpdateEvent(key="project_read_only", value=False),
            project=str(project.path),
        )


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
    SessionMixin,
    SettingsMixin,
    ChannelMixin,
    EventsMixin,
    WorkspaceMixin,
    ProjectMixin,
    LogMixin,
    ExecMixin,
    DeclsMixin,
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
    # a component's statement renders from (host.port_url, a component's
    # --endpoint) have to name the port that is listening. Left
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

# The release ending belongs to the PROCESS, and is written at most once. Two
# sources can signal the same session within a moment of each other: the host's
# reap ladder, and its lock reconciler ending an orphan's process group
# (agent/core/lock_reconcile.py). A SIGTERM handler runs once per
# delivery, so a second signal would append a second final to a .clc whose tail
# is supposed to hold exactly one ending — the transcript would then end twice,
# with the same words, and the window could not tell a double release from a
# run that ended and then, somehow, ended again.
_release_guard = threading.Lock()
_release_recorded = False


def record_release(state: RunState) -> None:
    """Write the ending a run in flight could not write for itself.

    A session is released from OUTSIDE (the last window's exit, /api/shutdown,
    a reap that raced the run's start, a run with no window left to serve), so
    no code of the run's own gets to run again: if there was a run in flight,
    the durable record of how it ended has to be written here, on the way out.

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
    global _release_recorded
    with _release_guard:
        if _release_recorded:
            return
        project = state.project
        if project is None or not state.busy:
            return
        _release_recorded = True
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
        "--claim-pid",
        type=int,
        default=None,
        help=(
            "the window process that claimed this session (the supervisor passes "
            "its pid). Written into every project lock's owner record, so the host "
            "can prove the window is gone instead of guessing with a timer"
        ),
    )
    parser.add_argument(
        "--claim-start",
        default=None,
        help=(
            "that window's /proc start tick: pid + tick + boot is an identity the "
            "kernel cannot recycle, so a reused pid never passes for the window"
        ),
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
    # A window that went away does not keep its project's write lock: the claim
    # record names the claiming WINDOW process, and the host's reconciler ends a
    # session whose claimant the kernel reports dead (agent/core/lock_reconcile.py).
    # Nothing here watches for silence — a heartbeat or subscriber count cannot
    # tell a closed window from a tunnelled phone, and guessing was the incident.

    # --port 0 makes the OS pick a free port; stdout is the only channel back to
    # the spawning Electron shell, so print the REAL bound port — always as the
    # loopback address, because the UI's port regex keys on 127.0.0.1:<port>.
    bound_port = config.port  # build() published what the socket got, not the 0
    # Name this session in the records its project locks carry: the port it
    # serves on, and the WINDOW process that claimed it. That record is how the
    # host tells an orphan (window gone, lock must go) from a frozen phone
    # (window exists, silence means nothing) without a clock — see
    # agent/core/lock_reconcile.py. Both facts arrive before any project can be
    # opened, because opening one is an HTTP request and serving starts below.
    set_lock_context(
        port=bound_port,
        claim="window" if args.claim_pid else None,
        claim_pid=args.claim_pid,
        claim_start=args.claim_start,
    )
    # a window that fell back to read-only gets its claim back the moment the
    # kernel says the .clc is free — by ASKING, never by releasing anything
    threading.Thread(
        target=claim_reask_loop,
        args=(state, broadcaster),
        name="clutch-claim-reask",
        daemon=True,
    ).start()
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
