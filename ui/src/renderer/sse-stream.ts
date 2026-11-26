// the event stream itself — liveness watchdog, connect, reconnect
//
// One EventSource per window, kept honest by the host's own named keepalive: the
// watchdog, the stale/error budgets, and the suspend/resume path the phone needs.
// SSE_KEEPALIVE_MS must stay in step with agent/server.py.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { connectionLost, resolveConnectionLost } from "./conn-lost";
import { pushTrustArmed } from "./permissions";
import { state } from "./state";
import { addEvent, dropOrphanLive, settleCatchUp } from "./stream-events";
import { refreshTree } from "./workspace-panel";

// ---- SSE live stream + session list ----
export let es = null;

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
//     retries forever in silence, so the failures are timed instead — a count
//     would be a budget in seconds, and seconds are what a redial is spending;
//   * a Stop click that could not be delivered (see stop()).
// Every recovery is announced: a silent one is indistinguishable from a freeze.
// The one exception is a recovery the USER caused by leaving: coming back from a
// background announces nothing, because there the window knows it was away.
//
// What this window knows when it (re)connects is exactly ONE thing: the highest
// .clc byte offset it has painted (state.streamHighOffset, beside the rest of the
// stream state), and that is what every connect says — `?since=`. The socket is
// transport, and whatever the platform did to it while the page was not running
// (a backlog to drain, a half-open connection, one Doze killed without a FIN) the
// answer is the same, and it is not a guess: close it, and ask the log for what is
// after the offset. A re-read is idempotent (a record at or below the watermark is
// never painted twice), so nothing here has to decide whether the pipe is still
// good — the probe that used to decide, and the `replay` flag it fed, are gone.
//
// WHICH log is asked is not a thing this file re-derives either — see "what the
// live stream reads" below: state.streamProject is adopted once, by the pane that
// takes a project, and every later read of it (the `?project=` this socket names,
// the tree it resyncs, the log each heal re-reads) comes from there. It is why
// this file imports nothing from project.ts: the window's belief about what it is
// looking at moves at a different moment than the pane does.
export const SSE_KEEPALIVE_MS = 15000; // must match agent/server.py SSE_KEEPALIVE_SEC
export const SSE_STALE_MS = SSE_KEEPALIVE_MS * 3; // one missed keepalive is not death
// How long a base may keep failing to answer before the window stops believing
// it has a session. A COUNT of failures was a budget in seconds — EventSource
// retries ~3s apart, so four of them was ~12s — and the seconds it spent were
// exactly the seconds a phone's tunnel takes to redial after a blip: the window
// declared the base dead while the reconnect that would have restored it was
// still running, and the dialog it raised outlived the outage. Time is the
// honest question, and a burst of quick refusals is not an answer to it.
export const SSE_ERROR_WINDOW_MS = 30000; // failing for this long, uninterruptedly = dead base
export let sseLastFrameAt = 0; // last byte the stream actually delivered
export let sseErrorsSince = 0; // when the current run of failed connects began (0 = none)
export let sseDown = false; // told once per outage, not once per tick
export let sseWatchdog = null;
// the PAGE is gone (phone backgrounded): see sseSuspend/sseResume
export let sseSuspended = false;
// A run was in flight when this window's SESSION was replaced: a tunnel end, the
// host's self-heal, a re-claim, the user's own connect to another host — the
// host releases the old session, and the new one starts with nothing in flight.
// The status frame that follows then honestly says idle, and painting that in
// silence is the reported "the task went idle by itself": the run is gone and
// nobody said so. The flag travels from the move (backend-lifecycle.ts) to the
// frame that reveals the outcome (render-events.ts).
// That frame only REVEALS the outcome; it cannot state it. The departing session
// appends a final of its own when it releases a run in flight (agent/server.py
// record_release), and the new session replays every record this window had not
// painted — so the ending may already be in the block that follows the status
// frame, and saying "the run was lost here" above the record that explains it
// would be a second, invented ending. The status frame therefore only ASKS the
// question (this flag), and the block the server brackets between `history` and
// `replayed` — its whole answer — is where it is settled (stream-events.ts).
// Whether the transcript has painted the current run's ending: opened by the
// task that starts a run, closed by the `final` that ends it, live or replayed.
// The answer above is never invented while this says the log already gave one.
// what the window says when the log it is owed ends the run with nothing
export const SSE_RUN_LOST = "the session running this task went away while it was in " +
  "flight — nothing is running now";

// any frame (event or keepalive) proves the pipe still carries bytes
export function sseFrame() {
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
export function sseDegrade(reason) {
  if (sseDown) return;
  sseDown = true;
  connectionLost("lost the live stream (" + reason + ")");
}

export function sseWatchdogTick() {
  if (!state.apiBase || !es) return;
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
export function sseSuspend() {
  sseSuspended = true; // idempotent: one flag, however many times it is announced
}

export function sseResume() {
  if (!sseSuspended) return;
  sseSuspended = false;
  sseLastFrameAt = Date.now(); // the gap is forgiven, never judged
  if (!state.apiBase || !es) return; // no stream yet: connectSSE will use the offset
  reconnectSSE();
}

// every way the platform announces that this page stops running: a hidden tab,
// the WebView frozen outright (Page Lifecycle), a bfcache-style suspend
document.addEventListener("visibilitychange", () => (document.hidden ? sseSuspend() : sseResume()));
document.addEventListener("freeze", sseSuspend);
document.addEventListener("resume", sseResume);
window.addEventListener("pagehide", sseSuspend);
window.addEventListener("pageshow", sseResume);

export function startSseWatchdog() {
  if (sseWatchdog) return; // one timer per window, however many streams it had
  sseWatchdog = setInterval(sseWatchdogTick, 5000);
}

// ---- what the live stream reads ---------------------------------------------
//
// One EventSource reads ONE log, and that log is not derivable from the window's
// globals: `currentProject` is the window's belief about what it is looking at,
// and it moves at a different moment than the pane does (a tab switch closes the
// old stream, claims the new tab's own session, and only then replays a project —
// in between, the belief still names the tab that was LEFT). A connect that
// re-read that belief could open a socket onto a log no pane is showing, and that
// log's records would land in the pane that is still loading — one project's
// answer drawn into another tab, which is what "the two tabs show each other's
// project" was.
//
// So the log is a fact this module HOLDS (state.streamProject), and the three
// doors below are its whole vocabulary:
//   * connectSSE(project) — ADOPT: the pane now shows this log. The one and only
//     way a stream STARTS, and it names the log itself, so nothing here has to
//     guess what the window is looking at.
//   * reconnectSSE()      — HEAL: that same log, on whatever base this window has
//     now. It cannot choose a log, so it cannot invent one: with none adopted
//     there is nothing to heal. That is what makes "a reconnect during a load
//     connected to the tab we just left" impossible instead of merely unlikely.
//   * closeSSE()          — LET GO: no pane owns a log any more (the welcome page,
//     the last tab closed, a switch whose own load has not adopted one yet).
export function connectSSE(project: string) {
  state.streamProject = project;
  openStream();
}

// The base is the other half of a read, and it is not adopted here: it belongs to
// the session (adoptBase), and a heal is exactly "the session moved, the log did
// not". WHICH log is not this door's to ask — openStream reads the adopted scope
// and opens nothing without one — so a heal cannot invent a read, it can only
// re-open the one the pane took. A window whose session is gone closes its socket
// and KEEPS the scope, so the URL the host announces next (backend:base-changed ->
// switchBackend) heals this same read instead of leaving the pane without one.
export function reconnectSSE() {
  if (!state.apiBase) {
    closeSocket();
    return;
  }
  openStream();
}

export function closeSSE() {
  state.streamProject = null;
  closeSocket();
}

// the ONE way a socket ends, whatever ended it. A block the stream was still
// delivering ends with it: its rows are already counted in the watermark (addEvent
// counts a record when it ARRIVES), so a dropped queue is a hole the next `?since=`
// would never fill, and a bracket left open would hold the next stream's rows
// behind a `replayed` it never sends. Paint them into the pane they belong to, and
// close the block, before anything is asked of another stream.
function closeSocket() {
  settleCatchUp();
  if (!es) return;
  try {
    es.close();
  } catch (e) {
    /* already closed */
  }
  es = null;
}

// The ONE way a socket starts, and the only place `es` is assigned: it reads the
// adopted scope and nothing else, so a socket can never describe a log its pane is
// not showing. Private on purpose — the three doors above are the vocabulary, and
// a caller that could open a stream directly could open one nobody adopted.
function openStream() {
  // The log this socket reads, read once and fixed for its whole life: every frame
  // it delivers and every tree it resyncs is about THIS project. null = no log was
  // adopted, so there is nothing to read.
  const project = state.streamProject;
  if (project === null) return;
  // backend not claimed yet: the main process announces the real URL via
  // backend:base-changed -> switchBackend -> reconnectSSE, and that heals this
  // same scope as soon as it lands
  if (!state.apiBase) return;
  // INVARIANT: at most one live stream per window. es is module-level and its
  // callers are many (boot, base-changed heal, open/new project); the owner
  // enforces single-stream here, so any call order — e.g. the boot IIFE switching
  // backends before its adoption — replaces the old stream instead of leaking a
  // second one (two live streams deliver every event twice: the per-token stutter).
  closeSocket();
  // ?project= scopes the stream to that log. ?since= is the offset we have already
  // painted: the server answers with every durable record after it, so a
  // (re)connect reads the log instead of guessing what the pipe missed — and with
  // nothing painted yet (a fresh window) the parameter is left off, which asks for
  // the resident window. The server still honours `replay` for 0.1.18 clients that
  // have no watermark; this window never sends it, because it has something better
  // to say than "paint it again".
  const qs = new URLSearchParams();
  if (project) qs.set("project", project);
  if (state.streamHighOffset !== null) qs.set("since", String(state.streamHighOffset));
  es = new EventSource(state.apiBase + "/api/events?" + qs.toString());
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
    sseErrorsSince = 0;
    sseFrame();
    // A session really answered: this is the ONLY thing that closes the
    // disconnect dialog (ui/src/renderer/conn-lost.ts). Nothing else may — an adopted URL
    // is not a session (the forwarded port can be dead), and with no dialog left
    // the window would sit on a port nobody serves. An open stream has the
    // host's own status frame behind it, so a run still in flight stays running.
    resolveConnectionLost();
    // The session that just answered may be a REPLACEMENT (host self-heal, a
    // re-claim after a tunnel end) and a fresh one starts with trust disarmed —
    // the countdown it runs for an armed prompt (agent/api/events.py
    // _permission_trust) would then never fire. The push is idempotent, so the
    // cheap thing is to say it again on every connect.
    if (typeof pushTrustArmed === "function") pushTrustArmed();
    // A session really answered, and everything the PREVIOUS stream drew is now
    // un-updatable — the deltas it missed are gone for good. So the block that was
    // streaming is CLOSED (stream-events.ts dropOrphanLive): a live partial left as
    // it is would be APPENDED to by the next delta, i.e. an answer that jumps
    // mid-sentence, and the step's durable record could no longer repair it. Closed,
    // the text the reader had stays on the page and that record writes it whole; the
    // "thinking… N chars" block a run is no longer writing is the one thing that goes.
    dropOrphanLive();
    // The tree is read where the SESSION has answered, never here. This frame is
    // the response HEADERS arriving, and the host resolves the project this
    // stream names (agent/api/events.py _project_for_sse) after them, so a read
    // from here can race that open and be answered "nothing open" — the reported
    // blank workspace panel after a reconnect. The end of the block the server
    // brackets around that answer (stream-events.ts `replayed`) is the first
    // moment the read cannot race it. With no project named there is nothing to
    // race: the tree is read here, as it always was.
    if (!project) refreshTree();
  };
  es.onerror = () => {
    // The browser retries the SAME URL, so the `?since=` of the retry is the one
    // this window asked with — a record still sitting in the catch-up queue would
    // be dropped by the watermark when the block arrives again and could never be
    // asked for a second time. End the block now: the screen then matches the
    // watermark, the view is not left chasing rows it already holds, and the
    // retry opens a block of its own that closes whatever is still missing.
    settleCatchUp();
    // the browser reconnects on its own, but a base that is GONE retries
    // forever without a word: a cached "running" past that window is a claim
    // we can no longer support, so it goes and the button reacts
    if (!sseErrorsSince) sseErrorsSince = Date.now();
    if (Date.now() - sseErrorsSince >= SSE_ERROR_WINDOW_MS) {
      sseDegrade("the backend did not answer for " + Math.round(SSE_ERROR_WINDOW_MS / 1000) + "s");
    }
  };
  startSseWatchdog();
}

