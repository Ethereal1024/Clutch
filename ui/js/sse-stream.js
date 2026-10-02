// the event stream itself — liveness watchdog, connect, reconnect
//
// One EventSource per window, kept honest by the host's own named keepalive: the
// watchdog, the stale/error budgets, and the suspend/resume path the phone needs.
// SSE_KEEPALIVE_MS must stay in step with agent/server.py.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// ---- SSE live stream + session list ----
let es = null;

// The live stream is the ONLY thing that refreshes `busy` (the running or
// waiting state of the run), so however it dies, the window must not keep
// rendering a cached "running" as if it were live: that is the window stuck on
// thinking with a Stop button that does nothing. The run is fine on the host,
// the pipe to it is not. Three causes, three local answers:
//   * a half-open TCP connection: writes vanish and EventSource NEVER fires
//     onerror. The keepalive of the server is a real named event (see
//     agent/server.py SSE_PING_FRAME), so silence past three of them is proof
//     of death, not a slow run;
//   * a base that is gone (tunnel torn down, session reaped): EventSource
//     retries forever in silence, so the failures are counted instead;
//   * a Stop click that could not be delivered (see stop()).
// Every recovery is announced: a silent one is indistinguishable from a freeze.
// The one exception is a recovery the USER caused by leaving: coming back from a
// background announces nothing, because there the window knows it was away.
//
// What this window knows when it (re)connects is exactly ONE thing: the highest
// .clc byte offset it has painted (streamHighOffset, declared with the rest of
// the stream state in js/project.js), and that is what every connect says —
// `?since=`. That read is the one deliberate exception to the load-order rule
// above: the declaration sits in a file loaded LATER, which is harmless because
// the value is only read when a stream is (re)connected, long after the page has
// loaded (a `let` below is in TDZ only during the scripts' own evaluation). The
// socket is transport, and
// whatever the platform did to it while the page was not running (a backlog to
// drain, a half-open connection, one Doze killed without a FIN) the answer is
// the same, and it is not a guess: close it, and ask the log for what is after
// the offset. A re-read is idempotent (a record at or below the watermark is
// never painted twice), so nothing here has to decide whether the pipe is still
// good — the probe that used to decide, and the `replay` flag it fed, are gone.
const SSE_KEEPALIVE_MS = 15000; // must match agent/server.py SSE_KEEPALIVE_SEC
const SSE_STALE_MS = SSE_KEEPALIVE_MS * 3; // one missed keepalive is not death
const SSE_MAX_ERRORS = 4; // EventSource retries ~3s apart: ~12s of a dead base
let sseLastFrameAt = 0; // last byte the stream actually delivered
let sseErrors = 0; // consecutive failed connects; reset by es.onopen
let sseDown = false; // told once per outage, not once per tick
let sseWatchdog = null;
// the PAGE is gone (phone backgrounded): see sseSuspend/sseResume
let sseSuspended = false;
// A run was in flight when this window's SESSION was replaced: a tunnel end, the
// host's self-heal, a re-claim, the user's own connect to another host — the
// host releases the old session, and the new one starts with nothing in flight.
// The status frame that follows then honestly says idle, and painting that in
// silence is the reported "the task went idle by itself": the run is gone and
// nobody said so. The flag travels from the move (backend-lifecycle.js) to the
// frame that reveals the outcome (render-events.js).
let sseRunAtRisk = false;
// That frame only REVEALS the outcome; it cannot state it. The departing session
// appends a final of its own when it releases a run in flight (agent/server.py
// record_release), and the new session replays every record this window had not
// painted — so the ending may already be in the block that follows the status
// frame, and saying "the run was lost here" above the record that explains it
// would be a second, invented ending. The status frame therefore only ASKS the
// question (this flag), and the block the server brackets between `history` and
// `replayed` — its whole answer — is where it is settled (js/stream-events.js).
let sseRunLostPending = false;
// Whether the transcript has painted the current run's ending: opened by the
// task that starts a run, closed by the `final` that ends it, live or replayed.
// The answer above is never invented while this says the log already gave one.
let runSettled = false;
// what the window says when the log it is owed ends the run with nothing
const SSE_RUN_LOST = "the session running this task went away while it was in " +
  "flight — nothing is running now";

// any frame (event or keepalive) proves the pipe still carries bytes
function sseFrame() {
  sseLastFrameAt = Date.now();
  sseDown = false;
}

// The stream can no longer be trusted: this window has no backend, and it says
// so through the one dialog that owns the way back.
//
// This used to slip the badge to idle and raise a notice that dismissed itself
// after 8 seconds — the reported "the task went idle by itself, silently, while
// the picker still said Connected". Three missed keepalives is not a hiccup, and
// a toast is not an announcement. The badge is left alone here on purpose: once
// a session answers, the host's own status frame says whether the run is still
// in flight (it is the same frame a reconnecting window gets — agent/api/
// events.py _sse), which is the only honest answer available.
function sseDegrade(reason) {
  if (sseDown) return;
  sseDown = true;
  connectionLost("lost the live stream (" + reason + ")");
}

function sseWatchdogTick() {
  if (!API_BASE || !es) return;
  // A hidden page is not a witness: some WebViews hide it without ever
  // announcing a freeze, and whatever they announce, a page nobody is watching
  // can conclude nothing from silence. So a hidden tick suspends instead of
  // judging — the same treatment the platform's own signal gets, and the return
  // resyncs (see sseResume). Judging here instead was the phone's "switch app,
  // come back and the run was idle": the wall-clock gap of the whole background
  // counted as a dead stream.
  if (document.hidden) {
    sseSuspend();
    return;
  }
  if (sseSuspended) {
    // Suspended, and the page is visibly running again: either the platform
    // never announced its own resume (some WebViews freeze without a matching
    // "resume"), or the tick that hid us raced the one that shows us. Both
    // spell the same thing — a gap no JS observed — so both are closed the
    // same way, and sseResume is idempotent if the platform did announce.
    sseResume();
    return;
  }
  if (Date.now() - sseLastFrameAt < SSE_STALE_MS) return;
  // re-arm first: one report + one reconnect per stale window, not per tick
  sseLastFrameAt = Date.now();
  sseDegrade("no keepalive for " + Math.round(SSE_STALE_MS / 1000) + "s");
  reconnectSSE(); // the base may have been re-claimed under us
}

// ---- the page is not the stream: a suspended window is silence by design ----
// Android freezes the WebView while the app is in the background, its timers
// with it, so on return the first watchdog tick sees a gap as long as the whole
// background and calls it a dead stream: the phone's "switch app, come back and
// the run went idle, with lost the live stream (no keepalive for 45s)".
// Nothing can be concluded from a period in which no JS ran, so a return says
// only what this window has always said when it opens a stream: close the old
// one and ask the log for everything after streamHighOffset. Whether the radio
// dropped the socket while we were away (Doze closes without a FIN, which no
// onerror ever reports) or the socket is fine under a backlog, the answer is
// the same and it is not a guess: the re-read is idempotent, so the worst case
// is that the frames we already painted arrive again and are dropped by the
// watermark. That is why there is no probe here any more — a probe was a guess
// about the pipe, and the offset is a fact about the log.
//
// The resync announces nothing: the page was away, the user lost nothing, and
// the reconnect carries the host's own status frame, so a run still in flight
// stays running.
function sseSuspend() {
  sseSuspended = true; // idempotent: one flag, however many times it is announced
}

function sseResume() {
  if (!sseSuspended) return;
  sseSuspended = false;
  sseLastFrameAt = Date.now(); // the gap is forgiven, never judged
  if (!API_BASE || !es) return; // no stream yet: connectSSE will use the offset
  reconnectSSE();
}

// every way the platform announces that this page stops running: a hidden tab,
// the WebView frozen outright (Page Lifecycle), a bfcache-style suspend
document.addEventListener("visibilitychange", () => (document.hidden ? sseSuspend() : sseResume()));
document.addEventListener("freeze", sseSuspend);
document.addEventListener("resume", sseResume);
window.addEventListener("pagehide", sseSuspend);
window.addEventListener("pageshow", sseResume);

function startSseWatchdog() {
  if (sseWatchdog) return; // one timer per window, however many streams it had
  sseWatchdog = setInterval(sseWatchdogTick, 5000);
}

function connectSSE() {
  // backend not claimed yet: the main process announces the real URL via
  // backend:base-changed -> switchBackend -> reconnectSSE
  if (!API_BASE) return;
  // INVARIANT: at most one live stream per window. es is module-level and its
  // callers are many (boot, switchBackend, open/new project, base-changed
  // heal); the owner enforces single-stream here, so any call order — e.g. the
  // boot IIFE switching backends before its trailing connect — replaces the
  // old stream instead of leaking a second one (two live streams deliver every
  // event twice: the per-token stutter).
  if (es) es.close();
  // ?project= scopes the stream to this window's .clc. ?since= is the offset we
  // have already painted: the server answers with every durable record after
  // it, so a (re)connect reads the log instead of guessing what the pipe missed
  // — and with nothing painted yet (a fresh window) the parameter is left off,
  // which asks for the resident window. The server still honours `replay` for
  // 0.1.18 clients that have no watermark; this window never sends it, because
  // it has something better to say than "paint it again".
  const qs = new URLSearchParams();
  if (currentProject) qs.set("project", currentProject);
  if (streamHighOffset !== null) qs.set("since", String(streamHighOffset));
  es = new EventSource(API_BASE + "/api/events?" + qs.toString());
  sseFrame(); // the stream is starting: never stale before its first byte
  es.onmessage = (e) => {
    sseFrame();
    // a dropped event silently desyncs the view from the log: never swallow it
    try { addEvent(JSON.parse(e.data)); } catch (err) { console.warn("[sse] undecodable event", err); }
  };
  // the keepalive of the server is a NAMED event, so it arrives here and not
  // in onmessage: the only proof that an idle-but-open socket is still there
  es.addEventListener("ping", sseFrame);
  // on (re)connect the server replays stored history: reset the streaming state
  es.onopen = () => {
    sseErrors = 0;
    sseFrame();
    // A session really answered: this is the ONLY thing that closes the
    // disconnect dialog (ui/js/conn-lost.js). Nothing else may — an adopted URL
    // is not a session (the forwarded port can be dead), and with no dialog left
    // the window would sit on a port nobody serves. An open stream has the
    // host's own status frame behind it, so a run still in flight stays running.
    resolveConnectionLost();
    lastTextEl = null;
    lastTextContent = "";
    thinkingEl = null;
    thinkingContent = "";
    toolGroupEl = null;
    clearRetryNote(); // a reconnect may have skipped the event that would clear it
    if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
    // the backend (re)connected, possibly after a self-heal restart: resync the tree
    refreshTree();
  };
  es.onerror = () => {
    // the browser reconnects on its own, but a base that is GONE retries
    // forever without a word: past a few failures the cached "running" is a
    // claim we can no longer support, so it goes and the button reacts
    sseErrors++;
    if (sseErrors >= SSE_MAX_ERRORS) sseDegrade("the backend did not answer");
  };
  startSseWatchdog();
}

// point the SSE stream at the (possibly new) API_BASE; when es is null (boot
// before the backend resolved) this CREATES the stream — that is exactly the
// late-heal path. connectSSE reads the watermark itself, so there is no amount
// of history a caller could get wrong: this is a plain alias and callers that
// used to pass replay/no-replay may keep their shape.
function reconnectSSE() {
  connectSSE();
}

