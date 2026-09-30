"use strict";

// Regression test for the phone's "switch app, come back" report: the session
// fell from running to idle with "lost the live stream (no keepalive for 45s)".
//
// Android freezes the WebView while the app is in the background, so the
// watchdog's wall-clock staleness test measured the whole background as a dead
// stream -- silence that no JS could have observed is not evidence about the
// pipe. The fix forgives the gap (sseSuspend/sseResume) and probes the pipe
// afterwards; the run state it keeps alive is restored by the reconnecting
// stream, whose first frame carries the HOST's real status (agent/server.py
// _sse) instead of the unconditional "idle" that used to repaint a running task
// as idle for the rest of the run.
//
// Like sse-liveness-test.js, this runner pulls the REAL functions out of
// the renderer and drives them against a fake EventSource and fake timers, so a
// silent edit that reintroduces the false positive fails here.
//
// Run: node tests/android-resume-test.js

const { check, summary, slicer, uiSource } = require("./harness.js");

const src = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(src);

// ---- the wire contract with the server (agent/server.py) ----
check(/const SSE_RESUME_PROBE_MS = 2000;/.test(src),
  "a queued keepalive is given a short window to land after the unfreeze");
check(/if \(sseSuspended\) return;/.test(fnBody("sseWatchdogTick")),
  "the watchdog refuses to judge a page that was not running");
check(/document\.addEventListener\("visibilitychange"/.test(src),
  "background/foreground is observed (visibilitychange)");
check(/document\.addEventListener\("freeze", sseSuspend\)/.test(src) &&
  /document\.addEventListener\("resume", sseResume\)/.test(src),
  "the WebView being frozen outright is observed too (Page Lifecycle)");
check(/window\.addEventListener\("pagehide", sseSuspend\)/.test(src) &&
  /window\.addEventListener\("pageshow", sseResume\)/.test(src),
  "a bfcache-style suspend is observed as well");
check(/sseFrames\+\+;/.test(src),
  "liveness is a monotonic counter, so 'a frame arrived' is testable");
check(!/sseDegrade|setStatus|notice\(/.test(fnBody("sseResume")),
  "returning from the background announces nothing and resets nothing (probe included)");

// ---- stub environment ----
const notices = [];
const statuses = [];
let reconnects = 0;
const instances = [];
let timers = []; // one-shot timers (the resume probe) fired by hand

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
global.setTimeout = (fn) => timers.push(fn); // the resume probe: fired by hand
global.clearTimeout = () => {};
global.API_BASE = "http://127.0.0.1:43761";
global.currentProject = "/tmp/demo.clc";
global.es = null;
global.busy = false;
// the module-level stream state of the renderer: its let-declarations are NOT
// visible to an indirect eval of one function at a time, so the runner owns
// the storage here (the source checks above assert the declarations exist)
global.sseLastFrameAt = 0;
global.sseFrames = 0;
global.sseErrors = 0;
global.sseDown = false;
global.sseSuspended = false;
global.sseSuspendedAt = 0;
global.sseProbe = null;
global.sseWatchdog = null;
global.SSE_KEEPALIVE_MS = 15000;
global.SSE_STALE_MS = 45000;
global.SSE_MAX_ERRORS = 4;
global.SSE_RESUME_PROBE_MS = 2000;
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
global.notice = (m) => notices.push(m);
global.reconnectSSE = () => {
  reconnects++;
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

// ---- load the real code ----
for (const name of ["sseFrame", "sseDegrade", "sseWatchdogTick", "startSseWatchdog", "connectSSE", "sseSuspend", "sseResume"]) {
  (0, eval)(fnBody(name));
}

function fireProbe() {
  const fn = timers.shift();
  check(typeof fn === "function", "the resume probe is a one-shot timer");
  if (fn) fn();
}

// ---- 1) a run is live and the phone goes away ----
connectSSE(true);
const es1 = instances[instances.length - 1];
es1.fireOpen();
setStatus("running");
check(global.busy === true, "a live run has the button on Stop");

sseSuspend();
// the WebView was frozen for three minutes: no timer, no frame, no JS at all
global.sseSuspendedAt = Date.now() - 180000;
global.sseLastFrameAt = Date.now() - 180000;
sseWatchdogTick();
check(notices.length === 0, "silence while the page was not running is not a lost stream");
check(reconnects === 0, "and it does not tear the stream down from the background");
check(global.busy === true && statuses[statuses.length - 1] === "running",
  "the cached run state is left alone while the page is away");

// a second hidden event must not restart the clock (the absence is the whole gap)
const suspendedAt = global.sseSuspendedAt;
sseSuspend();
check(global.sseSuspendedAt === suspendedAt, "the suspension keeps its first timestamp");

// ---- 2) back: the gap is forgiven, the pipe gets a chance to speak ----
sseResume();
check(notices.length === 0, "returning from the background announces nothing");
check(global.busy === true && statuses[statuses.length - 1] === "running",
  "and the status is not forced idle on the way back");
check(timers.length === 1, "a long absence arms an order-of-liveness probe");
check(Date.now() - global.sseLastFrameAt < 5000, "the background gap is forgiven, not judged");

es1.firePing(); // the keepalive the server sent while the page was frozen
fireProbe();
check(reconnects === 0, "a frame right after the return proves the pipe: no reconnect");

// ---- 3) the pipe really died (Doze drops it with no FIN) ----
sseSuspend();
global.sseSuspendedAt = Date.now() - 180000;
sseResume();
fireProbe();
check(reconnects === 1, "a pipe that stays silent after the return is replaced");
check(notices.length === 0, "the replacement is silent: the page was away, nothing was lost");
check(global.busy === true, "and the cached run state survives the replacement");
check(global.sseProbe === null, "the probe disarms itself");

// ---- 4) a short hop owes no probe ----
sseSuspend();
global.sseSuspendedAt = Date.now() - 1000;
sseResume();
check(timers.length === 0, "away for less than one keepalive: nothing to probe");

// ---- 5) a stream that stays silent after the return is STILL reported ----
// (the fix forgives the background, it does not blind the watchdog)
global.sseLastFrameAt = Date.now() - global.SSE_STALE_MS - 1;
sseWatchdogTick();
check(notices.length === 1 && /lost the live stream/.test(notices[0]),
  "a pipe that never speaks again is reported, not painted over");
check(global.busy === false && statuses[statuses.length - 1] === "idle",
  "and only then does the cached running state go");

// ---- 6) resume without a suspension is a no-op ----
const reconnectsBefore = reconnects;
sseResume();
check(timers.length === 0 && reconnects === reconnectsBefore,
  "a resume with nothing suspended changes nothing");

summary("android-resume");
