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
// background (see sseSuspend/sseResume) announces nothing, because there the
// window knows it was away — nothing has to be guessed, and the stream that
// replaces a socket Doze killed carries the host's own status.
const SSE_KEEPALIVE_MS = 15000; // must match agent/server.py SSE_KEEPALIVE_SEC
const SSE_STALE_MS = SSE_KEEPALIVE_MS * 3; // one missed keepalive is not death
const SSE_MAX_ERRORS = 4; // EventSource retries ~3s apart: ~12s of a dead base
const SSE_RESUME_PROBE_MS = 2000; // a queued keepalive is flushed with the unfreeze
let sseLastFrameAt = 0; // last byte the stream actually delivered
let sseFrames = 0; // monotonic proof of life: any frame bumps it
let sseErrors = 0; // consecutive failed connects; reset by es.onopen
let sseDown = false; // told once per outage, not once per tick
let sseWatchdog = null;
// the PAGE is gone (phone backgrounded): see sseSuspend/sseResume
let sseSuspended = false;
let sseSuspendedAt = 0;
let sseProbe = null;
// the watchdog itself saw the page hidden (a WebView may hide without saying so)
let sseHiddenTick = false;
// A run was in flight when this window's SESSION was replaced: a tunnel end, the
// host's self-heal, a re-claim, the user's own connect to another host — the
// host releases the old session, and the new one starts with nothing in flight.
// The status frame that follows then honestly says idle, and painting that in
// silence is the reported "the task went idle by itself": the run is gone and
// nobody said so. The flag travels from the move (backend-lifecycle.js) to the
// frame that reveals the outcome (render-events.js).
let sseRunAtRisk = false;

// any frame (event or keepalive) proves the pipe still carries bytes
function sseFrame() {
  sseLastFrameAt = Date.now();
  sseFrames++;
  sseDown = false;
}

// The stream can no longer be trusted: stop vetoing the buttons of the user,
// and say why. `busy` comes back on its own once a stream is live again: the
// first frame of every connect is the host's own status (agent/server.py _sse),
// so a run that is still in flight returns as running instead of leaving the
// window idle for the rest of the run.
function sseDegrade(reason) {
  if (sseDown) return;
  sseDown = true;
  if (busy) setStatus("idle");
  notice("lost the live stream (" + reason + ") — reconnecting; the task may still be running");
}

function sseWatchdogTick() {
  if (!API_BASE || !es) return;
  // A hidden page is not a witness: some WebViews hide it without ever
  // announcing a freeze, and whatever they announce, a page nobody is watching
  // can conclude nothing from silence. So a hidden tick suspends instead of
  // judging — the same treatment the platform's own signal gets — and the return
  // goes through sseResume's two-second probe, which finds the pipe either alive
  // (nothing to do) or gone (replaced without a word). Judging here instead was
  // the phone's "switch app, come back and the run was idle": the wall-clock gap
  // of the whole background counted as a dead stream.
  if (document.hidden) {
    sseHiddenTick = true;
    sseSuspend();
    return;
  }
  if (sseSuspended) {
    // A suspension the PLATFORM announced is the platform's to close (its own
    // resume fires on the way back). Only the one the watchdog opened has no
    // other observer, so only that one is closed here.
    if (!sseHiddenTick) return;
    sseResume();
  }
  if (Date.now() - sseLastFrameAt < SSE_STALE_MS) return;
  // re-arm first: one report + one reconnect per stale window, not per tick
  sseLastFrameAt = Date.now();
  sseDegrade("no keepalive for " + Math.round(SSE_STALE_MS / 1000) + "s");
  reconnectSSE(false); // the base may have been re-claimed under us
}

// ---- the page is not the stream: a suspended window is silence by design ----
// Android freezes the WebView while the app is in the background, its timers
// with it, so on return the first watchdog tick sees a gap as long as the whole
// background and calls it a dead stream: the phone's "switch app, come back and
// the run went idle, with lost the live stream (no keepalive for 45s)".
// Nothing can be concluded from a period in which no JS ran, so the gap is
// forgiven and only the silence AFTER the page is back counts. What a spell in
// the background CAN leave behind is a socket the radio quietly dropped (Doze
// closes without a FIN, which no onerror ever reports), so a spell longer than
// one keepalive interval is followed by a short probe: a live pipe flushes its
// queued keepalive the moment the renderer unfreezes, a dead one stays silent
// and is replaced WITHOUT announcing a loss (the page was away — the user lost
// nothing) and WITHOUT dropping the cached run state: the reconnect carries the
// host's own status (agent/server.py), so a run still in flight stays running.
function sseSuspend() {
  if (sseSuspended) return; // one suspension, however many times it is announced
  sseSuspended = true;
  sseSuspendedAt = Date.now();
}

function sseResume() {
  if (!sseSuspended) return;
  const awayFor = Date.now() - sseSuspendedAt;
  sseSuspended = false;
  sseHiddenTick = false; // whoever observed the hide, the page is back
  sseLastFrameAt = Date.now(); // the gap is forgiven, never judged
  if (sseProbe) { clearTimeout(sseProbe); sseProbe = null; }
  // away for less than one keepalive: the pipe owed us nothing yet, and the
  // ordinary watchdog window (now re-armed) is a fair judge
  if (!API_BASE || !es || awayFor < SSE_KEEPALIVE_MS) return;
  const frames = sseFrames; // what a proof of life would have had to move
  sseProbe = setTimeout(() => {
    sseProbe = null;
    if (sseSuspended || !es) return; // went away again, or the stream is gone
    if (sseFrames !== frames) return; // the pipe spoke: the queued frame landed
    reconnectSSE(false); // silent: nothing to announce, nothing to reset
  }, SSE_RESUME_PROBE_MS);
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

function connectSSE(replay = true) {
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
  // ?project= scopes the stream to this window's .clc; replay=0 right after
  // open/create already rendered the history
  const qs = new URLSearchParams();
  if (currentProject) qs.set("project", currentProject);
  qs.set("replay", replay ? "1" : "0");
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
// late-heal path
function reconnectSSE(replay = true) {
  if (es) es.close();
  connectSSE(replay);
}

