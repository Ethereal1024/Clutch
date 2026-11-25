"""API-only HTTP + SSE server hosting the agent (the UI is a separate app).

Endpoints (all JSON except SSE/NDJSON):
  POST /api/project/new    {dir, name} -> create a .clc project file
  POST /api/project/open   {path} -> load a .clc project (NDJSON stream)
  POST /api/run/state      {busy, project?, ttl_ms?} the HOST's lease on the run
                           slot: claim/renew while it drives a turn, release when
                           it ends (the loop lives in the client — see api/run_state).
                           There is no POST /api/run: the backend runs no loop (P4)
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
  GET  /api/fs/stat           is this path a dir, a file, or nothing yet? (the
                              address bar's one question; absent is an answer)
  POST /api/fs/mkdir {dir, name}  one new folder inside the shown directory
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
gets a private queue. One run at a time: the slot is a LEASE the host renews
(POST /api/run/state) while it drives a turn, or — until P4 retires the backend
loop — that loop's own claim; Stop sets a cancel flag checked by the loop.
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
from .api.run_state import RunStateMixin
from .api.session import SessionMixin
from .api.settings import SettingsMixin
from .api.workspace import WorkspaceMixin
from .base import BaseServer, Broadcaster, RunState
from .config import API_PROTOCOLS, REASONING_EFFORT_LEVELS, Config, flatten_settings
from .core import claim_watch
from .core.project_lock import ProjectLock, set_context as set_lock_context
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


# How often a session asks the kernel what its project's run claim is doing.
#
# The claim is a RUN claim, so it changes without anybody telling this process:
# the other window's run ends, or a run STARTS in another window on the .clc this
# one is merely looking at. Three things follow from the answer, and all three
# have to be said out loud, because no other process can say them here:
#
#   * "this project is somebody else's run now" -- `running_elsewhere`, which is
#     the page's pill and its read-only composer. The session's own "opened as a
#     viewer" mode is NOT re-announced here: it is fixed at open and the status
#     frame says it on every connect;
#   * that run's transcript, which is on disk and in nobody's resident log here
#     (:func:`LazyEventLog.catch_up`), published row by row to whoever is watching;
#   * a lease of ours that lapsed while the process lived (a frozen window, a
#     tunnel that ate the heartbeats). The watchdog frees it here, so the file can
#     be claimed again instead of waiting for the next claimant to notice.
#
# Two seconds is a poll on the KERNEL, not a guess about a window — it is the same
# question every endpoint that writes asks, asked on a timer because a page has no
# way to ask it itself.
CLAIM_WATCH_POLL_S = 2.0


def claim_watch_loop(
    state: RunState, broadcaster: Broadcaster, poll_s: float = CLAIM_WATCH_POLL_S
) -> None:
    """Follow the run claim on this session's project and say what it means.

    Everything announced here is a TRANSITION: the page already knows the state
    it was told at connect (agent/api/events.py's status frame asks the same
    question), so a tick that changes nothing publishes nothing. The tracker is
    dropped when there is no project, so re-opening one re-announces.

    Following the other session's run means reading its lines out of the file:
    it appends in another process, and nothing here would otherwise publish them.
    The reader is `LazyEventLog.catch_up`, the same catch-up a claimant runs
    before reasoning over a log somebody else wrote — and it is run only while a
    foreign run exists AND somebody is watching, so an idle session polls the
    kernel and touches no file. That read is also the one thing here that can
    fail on a live session (a remote workspace whose bridge just went away), and
    a failed tick is caught and retried instead of ending the thread: this is the
    only process that can announce the other window's run, drop this one's own
    lapsed lease, or follow that run's lines, so a watcher that died is a page
    left read-only forever with nothing left anywhere to end it.
    """
    last: tuple[str, bool] | None = None  # (project, running elsewhere) as last announced
    following = False  # was a foreign run being followed on the last tick?
    while True:
        time.sleep(poll_s)
        project = state.project
        if project is None:
            last = None
            following = False
            continue
        path = str(project.path)
        if last is not None and last[0] != path:
            following = False  # another project: nothing was being followed here
        # Everything below touches the KERNEL, the file and the broadcaster, and
        # a tick that raises takes the whole WATCHER with it: the thread ends, and
        # with it go the three things only it can say (a lapsed lease dropped, the
        # other window's run announced, its lines followed). The failure mode is
        # silent and permanent — a project left read-only in every window with no
        # process anywhere left to end it — so a bad tick is reported and the
        # poll goes on. The one read that can raise on a healthy session is the
        # foreign run's catch-up (a remote workspace read through a bridge that
        # went away), which is exactly a reason to try again, not to give up.
        try:
            # a lease that lapsed with the process still alive: the turn it stood
            # for is over, and the page must not keep painting it as running
            if state.drop_expired_claim():
                broadcaster.publish(
                    StateUpdateEvent(key="execution_status", value="idle"), project=path
                )
            foreign = state.foreign_lock(path)  # another session RUNS it, right now
            held = foreign["held"]
            if last is None or last[0] != path or last[1] != held:
                broadcaster.publish(
                    StateUpdateEvent(
                        key="running_elsewhere", value=held,
                        # the holder's own record, so a page whose machine is the
                        # one that claimed it can prove that window gone and free
                        # the file (agent/events.py StateUpdateEvent.claim_owner)
                        claim_owner=foreign["owner"],
                    ),
                    project=path,
                )
                # ...and only a published change counts as announced: a tick that
                # failed below has to say it again, or the page keeps the last
                # state it was told while this loop believes it was told
                last = (path, held)
            # Read the foreign run's new lines. `held or following`: the tick that
            # ends a foreign run is also a tick that has not read its tail yet.
            follow, following = held or following, held
            if not follow or broadcaster.count(path) == 0:
                continue  # nobody is looking: the next open or connect catches up
            for _off, ev in project.log.catch_up():
                broadcaster.publish(ev, project=path)
        except Exception as err:  # noqa: BLE001 - see above: a bad tick is not the end
            print(f"[clutch-server] claim watch tick failed: {err}", flush=True)


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
    RunStateMixin,
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


def has_open_turn(project: Project) -> bool:
    """Return True iff the .clc log currently holds an open (un-finalled) turn.

    This is the Python equivalent of ui/src/host/run-state.ts:foldRun. A turn
    is open iff the durable events after the last ``final`` contain at least one
    ``user_message``. The log is the source of truth (run-state.ts:1-10), not
    the in-memory lease flag: a lease can expire or be skipped during shutdown
    while the log correctly shows an open turn, and vice-versa.

    Uses the resident window (project.log.events()), which always covers the
    tail — only pre-window history might be compacted away, and a compaction
    boundary is itself a durable event that resets the region.
    """
    try:
        events = project.log.events()
        # Walk backwards to find the last final; everything after it is the region.
        last_final_idx = -1
        for i in range(len(events) - 1, -1, -1):
            if events[i].type == "final":
                last_final_idx = i
                break
        region = events[last_final_idx + 1 :]
        return any(ev.type == "user_message" for ev in region)
    except Exception:  # noqa: BLE001 - defensive: a broken log is not an open turn
        return False


def record_release(state: RunState) -> None:
    """Write the ending a run in flight could not write for itself.

    A session is released from OUTSIDE (the last window's exit, /api/shutdown,
    a reap that raced the run's start, a run with no window left to serve), so
    no code of the run's own gets to run again: if there was a run in flight,
    the durable record of how it ended has to be written here, on the way out.

    Deliberately not the cancel path. /api/stop means the user asked, and the
    loop answers that itself with a cancelled-flavoured final; a release is
    something only the departing process can report, and it is a status of its
    own — `released`, not `completed` (the task never finished) and not `error`
    (a live loop's word for a turn it is still there to continue). The work
    stopped for a reason that had nothing to do with the task, and the turn is
    over, so the window must fold it closed rather than offer a continuation
    into a session that is no longer serving.

    The guard against writing twice is here, not in has_open_turn, so the
    check is single-shot even if two signal deliveries race. has_open_turn
    reads the log (not the lease) so it stays correct across shutdown races,
    lease expiry, and the client's release POST arriving before or after.

    And it is the CLAIM holder's record to write, no one else's: a session that
    is merely looking at the project while another window runs it has no turn of
    its own to end, and appending here would put a `released` line inside that
    window's turn. A releasing session that is running writes it before it hands
    the .clc back (server.py _claim_gone), so the claim is still held here.
    """
    global _release_recorded
    with _release_guard:
        if _release_recorded:
            return
        project = state.project
        if project is None or not state.owns_claim(str(project.path)):
            # a run in flight in ANOTHER window is not ours to end: its final is
            # that window's to write, and this line would land in the middle of
            # its turn -- after a context this session never read
            return
        if not has_open_turn(project):
            return
        _release_recorded = True
        try:
            project.log.append(FinalEvent(status="released", summary=RELEASED_SUMMARY))
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
        "--claim-host",
        default=None,
        help=(
            "the machine the claiming window runs on. It defaults to this host "
            "(a local window); a session started for a window on another machine "
            "names that machine, and then this host records the claim without "
            "ever reading its own process table into it"
        ),
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help=(
            "LLM API base URL (any OpenAI-compatible endpoint). Overrides the "
            "saved settings and the environment for this session."
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
        # A --base-url endpoint that was given no key still gets a non-empty one:
        # the OpenAI client refuses to build without it, and a keyless local
        # endpoint does not look at the value. The real key comes from the UI
        # settings (state.api_key) or an explicit config.api_key.
        api_key = "proxy"

    broadcaster = Broadcaster()
    state = RunState()
    # restore the settings persisted by the GUI (api key + LLM endpoint)
    state.api_key = api_key

    srv = build(config, broadcaster, state)
    # a session released mid-run still leaves a settled transcript (POSIX)
    install_release_handler(state)
    # A window that went away does not keep its project's write lock, and this
    # process is where that is decided — not by a timer here, and not by the
    # host's reconciler 30 s later. See _claim_gone below.
    # Silence is still never evidence: a heartbeat or subscriber count cannot
    # tell a closed window from a tunnelled phone, and guessing was the incident.
    # What IS evidence is the kernel's answer about the claiming process.

    # --port 0 makes the OS pick a free port; stdout is the only channel back to
    # the spawning Electron shell, so print the REAL bound port — always as the
    # loopback address, because the UI's port regex keys on 127.0.0.1:<port>.
    bound_port = config.port  # build() published what the socket got, not the 0
    # Name this session in the records its project locks carry: the port it
    # serves on, and the app process that claimed it (the Electron MAIN process —
    # whose death IS the app's death; a renderer can be replaced while the window
    # lives). That record is how the host tells an orphan (app gone, lock must go)
    # from a frozen client (process exists, silence means nothing) without a
    # clock — see agent/core/lock_reconcile.py. Both facts arrive before any
    # project can be opened, because opening one is an HTTP request and serving
    # starts below.
    #
    # A claim names the machine it lives on (--claim-host). For a session a far
    # side started for a client behind a tunnel, that is the CLIENT's machine and
    # this host can never see the claiming process; the record still names it,
    # because the only machine that can prove that window gone is the one named.
    here = socket.gethostname()
    claim_host = args.claim_host or here
    claim_is_local = claim_host == here
    set_lock_context(
        port=bound_port,
        claim="window" if args.claim_pid else None,
        claim_host=claim_host if args.claim_pid else None,
        claim_pid=args.claim_pid,
        claim_start=args.claim_start,
    )

    # THE guarantee: this session does not outlive the app that claimed it, and
    # the .clc write locks it holds die with it (the kernel drops them at exit).
    #
    # Not a timer and not a heartbeat: the kernel's answer about the claiming
    # process, asked once a second by the only process that can act on it. A
    # closed window, a crashed shell, a `kill -9` and a power cut are the same
    # fact here (the process is gone) and all of them end with this process
    # exiting. Nothing on this side is lost by that: the run loop lives in the
    # client (P2-3), so a run whose client is gone has no one left to finish it —
    # a surviving session would only hold a lock nobody can use, which is what
    # the next start then asked the user to "reclaim".
    def _claim_gone() -> None:
        print("[clutch-server] the app that claimed this session is gone; releasing", flush=True)
        record_release(state)  # a run in flight still gets its `released` final
        ProjectLock.release_all()  # free the .clc NOW instead of at process death
        if os.name == "posix":
            # reuse the release path: one final (guarded), then out of serve_forever
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(3.0)  # a main thread stuck in a handler must not pin the locks
        os._exit(0)  # Windows: no deliverable SIGTERM (the documented caveat)

    # The watchdog runs on the machine that can SEE the claiming process. When
    # the claim names another machine this pid is not ours to read — the same
    # number here may well be some stranger — and that machine's session is the
    # one that ends it: the client asks this host's /api/locks/reclaim with its
    # own kernel's answer (lock_reconcile.witnessed).
    if claim_is_local:
        claim_watch.watch(args.claim_pid, args.claim_start, _claim_gone)

    # follow the run claim on this session's project: another window's run makes
    # the pages here read-only and its transcript arrive as it is written, and
    # this session's own lapsed lease is freed instead of waiting to be noticed
    threading.Thread(
        target=claim_watch_loop,
        args=(state, broadcaster),
        name="clutch-claim-watch",
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
