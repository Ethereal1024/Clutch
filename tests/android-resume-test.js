"use strict";

// Regression test for the phone's "switch app, come back" report: the session
// fell from running to idle with "lost the live stream (no keepalive for 45s)".
//
// Android freezes the WebView while the app is in the background, so the
// watchdog's wall-clock staleness test measured the whole background as a dead
// stream -- silence that no JS could have observed is not evidence about the
// pipe. The fix is not a longer tolerance and not a probe: a returning window
// says the ONE thing it actually knows -- the byte offset it has painted
// (streamHighOffset, sent as `?since=`) -- and closes the old stream so the
// server can answer it from the log. The run state it keeps alive is restored
// by the first frame of that new stream, which carries the HOST's real status
// (agent/api/events.py _sse) instead of the unconditional "idle" that used to
// repaint a running task as idle for the rest of the run.
//
// Like sse-liveness-test.js, this runner pulls the REAL functions out of
// the renderer and drives them against a fake EventSource and fake timers, so a
// silent edit that reintroduces the false positive fails here.
//
// Run: node tests/android-resume-test.js

const { check, summary, slicer, uiSource } = require("./harness.js");

const src = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(src);

// ---- the return contract (js/sse-stream.js, js/stream-view.js) ----
check(!/SSE_RESUME_PROBE_MS/.test(src),
  "there is no resume probe: a probe was a guess about the pipe, the offset is a fact");
check(!/sseFrames/.test(src),
  "and no liveness counter: nothing has to be inferred from 'a frame moved'");
check(/sseResume\(\);/.test(fnBody("sseWatchdogTick")),
  "the watchdog hands the return to sseResume instead of judging the gap itself");
check(/sseSuspend/.test(fnBody("sseWatchdogTick")),
  "and it refuses to judge a page that was not running");
check(/if \(document\.hidden\) \{/.test(fnBody("sseWatchdogTick")),
  "a hidden page is treated as suspended by the watchdog too (the platform may never say so)");
check(/reconnectSSE\(\)/.test(fnBody("sseResume")),
  "the return reconnects: that is how a gap is closed, however it was announced");
check(!/sseDegrade|setStatus|notice\(/.test(fnBody("sseResume")),
  "returning from the background announces nothing and resets nothing");
check(/sseDegrade\(/.test(fnBody("sseWatchdogTick")),
  "and the watchdog still REPORTS a stream that goes silent under a watching page");
check(/qs\.set\("since", String\(streamHighOffset\)\)/.test(fnBody("connectSSE")),
  "every connect says how far this window has read");
check(!/qs\.set\("replay"/.test(src),
  "and never asks for a blind replay: the offset says it better");
check(/^function reconnectSSE\(\)/.test(fnBody("reconnectSSE")) &&
  /connectSSE\(\)/.test(fnBody("reconnectSSE")) && !/es\.close/.test(fnBody("reconnectSSE")),
  "reconnect is the same door as connect: no caller can ask for the wrong history");
check(/document\.addEventListener\("visibilitychange"/.test(src),
  "background/foreground is observed (visibilitychange)");
check(/document\.addEventListener\("freeze", sseSuspend\)/.test(src) &&
  /document\.addEventListener\("resume", sseResume\)/.test(src),
  "the WebView being frozen outright is observed too (Page Lifecycle)");
check(/window\.addEventListener\("pagehide", sseSuspend\)/.test(src) &&
  /window\.addEventListener\("pageshow", sseResume\)/.test(src),
  "a bfcache-style suspend is observed as well");

// ---- stub environment ----
const notices = [];
const statuses = [];
// the one funnel for a detected disconnect (js/conn-lost.js): a lost stream is
// announced there, not by a toast, and its dialog is closed by proof of life
// (the stream's own onopen)
const losses = [];
let resolved = 0;
let reconnects = 0;
const instances = [];
const timers = []; // nothing here may arm a timer any more

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    instances.push(this);
  }
  addEventListener(type, cb) {
    (this.listeners[type] = this.listeners[type] || []).push(cb);
  }
  close() {
    this.closed = true;
  }
  fireOpen() {
    if (this.onopen) this.onopen();
  }
  fireError() {
    if (this.onerror) this.onerror();
  }
  firePing() {
    for (const cb of this.listeners.ping || []) cb();
  }
}

global.EventSource = FakeEventSource;
global.setInterval = () => 1; // the watchdog timer is driven by hand below
global.setTimeout = (fn) => timers.push(fn); // must stay empty: no probe, no timer
global.clearTimeout = () => {};
global.API_BASE = "http://127.0.0.1:43761";
global.currentProject = "/tmp/demo.clc";
global.es = null;
global.streamHighOffset = null;
global.busy = false;
// the module-level stream state of the renderer: its let-declarations are NOT
// visible to an indirect eval of one function at a time, so the runner owns
// the storage here (the source checks above assert the declarations exist)
global.sseLastFrameAt = 0;
global.sseErrors = 0;
global.sseDown = false;
global.sseSuspended = false;
global.sseWatchdog = null;
global.SSE_KEEPALIVE_MS = 15000;
global.SSE_STALE_MS = 45000;
global.SSE_MAX_ERRORS = 4;
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
global.notice = (m) => notices.push(m);
global.connectionLost = (m) => losses.push(m);
global.resolveConnectionLost = () => {
  resolved++;
};
global.addEvent = () => {};
global.refreshTree = () => {};
global.clearRetryNote = () => {};
global.cancelAnimationFrame = () => {};
global.textRenderRaf = 0;
global.lastTextEl = null;
global.lastTextContent = "";
global.thinkingEl = null;
global.thinkingContent = "";
global.toolGroupEl = null;
// the watchdog reads the page's own visibility (a hidden page is not a witness)
global.document = { hidden: false };

// ---- load the real code ----
for (const name of ["sseFrame", "sseDegrade", "sseWatchdogTick", "startSseWatchdog",
  "connectSSE", "reconnectSSE", "sseSuspend", "sseResume"]) {
  (0, eval)(fnBody(name));
}
// count the reconnects without replacing the behaviour: the real one still runs
const realReconnect = global.reconnectSSE;
global.reconnectSSE = () => {
  reconnects++;
  realReconnect();
};

// ---- 1) a run is live and the phone goes away ----
connectSSE();
const es1 = instances[instances.length - 1];
check(!/[?&]since=/.test(es1.url),
  "painted nothing yet: the connect asks for the resident window, not an offset");
check(!/replay/.test(es1.url), "and carries no replay flag at all");
es1.fireOpen();
check(resolved === 1,
  "a live session closes the disconnect dialog: the open is the proof, not the URL");
setStatus("running");
check(global.busy === true, "a live run has the button on Stop");

sseSuspend();
check(global.sseSuspended === true, "a hide the platform announced is recorded, not judged");
sseSuspend();
check(global.sseSuspended === true,
  "and a second announcement changes nothing: the flag is the whole state");

// ---- 2) back: the gap is never judged, the stream is simply replaced ----
// the WebView was frozen for three minutes: no timer, no frame, no JS at all
global.sseLastFrameAt = Date.now() - 180000;
sseResume();
check(global.sseSuspended === false, "the return closes the suspension");
check(reconnects === 1, "and reconnects: the window closes the pipe it can no longer trust");
check(losses.length === 0 && notices.length === 0,
  "silently: the page was away, the user lost nothing, no dialog, no toast");
check(Date.now() - global.sseLastFrameAt < 5000,
  "the background gap is forgiven, not judged");
check(timers.length === 0, "and nothing is armed to decide anything later");
check(global.busy === true && statuses[statuses.length - 1] === "running",
  "the cached run state is left to the new stream's own status frame");

// the reconnect is a re-read, not a re-guess: it carries what this window painted
global.streamHighOffset = 4096;
reconnects = 0;
sseSuspend();
sseResume();
const es2 = instances[instances.length - 1];
check(/[?&]since=4096(&|$)/.test(es2.url),
  "the reconnect asks for exactly the records after the offset it has painted");
check(es2 !== es1 && es1.closed === true,
  "and the old pipe is closed: one live stream per window");
check(reconnects === 1, "one release, one reconnect");

// ---- 3) no wall-clock gate decides whether a return is worth a resync ----
reconnects = 0;
sseSuspend(); // a hop so short the pipe owed us nothing
sseResume();
check(reconnects === 1,
  "even a moment away resyncs: a re-read is idempotent, so a short one costs nothing");
check(timers.length === 0, "and there is still no probe to arm");

// ---- 4) a platform that hides the page without a word is not judged either ----
// (some WebViews just stop drawing and throttle the timers: no visibilitychange,
// no freeze — the watchdog has to notice by itself, or the whole background is
// counted as a dead stream again)
setStatus("running");
document.hidden = true;
const r0 = reconnects;
const n0 = notices.length;
global.sseLastFrameAt = Date.now() - global.SSE_STALE_MS - 1;
sseWatchdogTick();
check(global.sseSuspended === true, "a hidden tick suspends the stream instead of judging it");
check(reconnects === r0 && losses.length === 0 && notices.length === n0,
  "and says nothing: silence behind a page nobody sees is not a loss");

// three minutes later, back on screen, the tick is the only observer
global.sseLastFrameAt = Date.now() - 180000;
document.hidden = false;
sseWatchdogTick();
check(global.sseSuspended === false && reconnects === r0 + 1,
  "the visible tick closes a suspension the platform never announced");
check(losses.length === 0 && notices.length === n0, "silently: the user lost nothing while away");
check(global.busy === true, "and the run state survives the return");
timers.length = 0;
es2.firePing();
check(timers.length === 0, "the keepalive the server queued behind the freeze is just a frame now");

// ---- 5) a stream that goes silent under a WATCHING page is still reported ----
// (the fix forgives the background, it does not blind the watchdog)
const statusesBeforeLoss = statuses.length;
global.sseLastFrameAt = Date.now() - global.SSE_STALE_MS - 1;
sseWatchdogTick();
check(losses.length === 1 && /lost the live stream/.test(losses[0]),
  "a pipe that never speaks again is reported, not painted over");
check(notices.length === 0,
  "and it is the disconnect dialog that says so: no toast competes with it");
check(reconnects === r0 + 2, "with a replace: the base may have been re-claimed under us");
check(statuses.length === statusesBeforeLoss && global.busy === true,
  "the badge is left for the host's own status frame once a session answers");

// ---- 6) resume without a suspension is a no-op ----
const r1 = reconnects;
sseResume();
check(reconnects === r1 && timers.length === 0,
  "a resume with nothing suspended changes nothing");

summary("android-resume");
