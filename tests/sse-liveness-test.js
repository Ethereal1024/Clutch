"use strict";

// Regression test for the frozen-window disconnect: the UI sat on "thinking"
// with a Stop button that did nothing, while the run went on and the record
// later showed messages the view had never displayed. The live stream had died
// silently -- a half-open socket raises no error in EventSource, the old
// keepalive was a `: comment` (invisible to every listener) and stop() swallowed
// each failure -- so `busy`, a CACHED server state refreshed only by that
// stream, stayed true forever.
//
// Like stream-render-test.js this runner does NOT re-implement the fix: it pulls
// the real functions out of the renderer and drives them against a fake
// EventSource, so a silent edit that reintroduces the freeze fails here.
//
// Run: node tests/sse-liveness-test.js

const { check, summary, slicer, uiSource } = require("./harness.js");

const src = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(src);

// ---- the wire contract with the server (agent/server.py) ----
check(/const SSE_KEEPALIVE_MS = 15000;/.test(src),
  "renderer keepalive window matches the 15s keepalive the server sends");
check(/es\.addEventListener\("ping", sseFrame\)/.test(src),
  "the keepalive is consumed as a NAMED event: an idle stream can prove it lives");
check(/const SSE_STALE_MS = SSE_KEEPALIVE_MS \* 3;/.test(src),
  "three missed keepalives (not one) are the threshold for a dead stream");
check(/const SSE_ERROR_WINDOW_MS = 30000;/.test(src),
  "a base that stops answering is TIMED, not counted: a count is a budget in seconds");
check(/es\.onerror = \(\) => \{\n    \/\/ the browser reconnects/.test(src),
  "es.onerror is no longer an empty auto-reconnect stub");
check(/connectionLost\("could not reach the session to stop the task/.test(src),
  "stop() surfaces the failure instead of an empty catch (through the dialog)");
check(/^let sseLastFrameAt = 0;/m.test(src) && /^let sseErrorsSince = 0;/m.test(src) &&
  /^let sseDown = false;/m.test(src) && /^let sseWatchdog = null;/m.test(src) &&
  /^let sseSuspended = false;/m.test(src),
  "the liveness state is real module state, not a per-stream local");

// ---- stub environment ----
const notices = [];
const statuses = [];
const losses = []; // connectionLost() calls: the one dialog that owns a loss
let reconnects = 0;
let probes = 0;
const instances = [];

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
global.API_BASE = "http://127.0.0.1:43761";
global.currentProject = "/tmp/demo.clc";
global.es = null;
global.busy = false;
// how far this window has painted (js/project.js): a fresh window has nothing
// to ask for, so the stream serves the resident window
global.streamHighOffset = null;
// the module-level stream state of the renderer: its let-declarations are NOT
// visible to an indirect eval of one function at a time, so the runner owns
// the storage here (the block below asserts the source declares it for real)
global.sseLastFrameAt = 0;
global.sseErrorsSince = 0;
global.sseDown = false;
global.sseSuspended = false; // the page is running here: android-resume covers the other case
global.sseWatchdog = null;
global.SSE_KEEPALIVE_MS = 15000;
global.setTimeout = () => 1;
global.clearTimeout = () => {};
// the watchdog reads visibility now (a hidden page is not a witness); these
// runners drive one function at a time, so the page state is the runner's
global.document = { hidden: false };
global.SSE_STALE_MS = 45000;
global.SSE_ERROR_WINDOW_MS = 30000;
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
global.notice = (m) => notices.push(m);
// the disconnect funnel: this runner drives sse-stream.js, whose only answer to
// a dead stream is to raise the dialog (ui/js/conn-lost.js). What the dialog
// then does is conn-lost-modal-test.js's business.
global.connectionLost = (reason) => losses.push(reason);
global.resolveConnectionLost = () => {};
global.connBusy = false;
global.reconnectSSE = () => {
  reconnects++;
};
global.switchBackendResolved = async () => {
  probes++;
  return true;
};
global.addEvent = () => {};
global.refreshTree = () => {};
// The reconnect's teardown of the blocks the dead stream drew lives in
// stream-events.js (dropOrphanLive) and is driven for real by
// mid-stream-retry-test.js; this runner loads sse-stream.js alone, so it only
// needs to count that the reconnect ASKS for it.
let orphansDropped = 0;
global.dropOrphanLive = () => {
  orphansDropped++;
};
global.clearRetryNote = () => {};
global.cancelAnimationFrame = () => {};
global.textRenderRaf = 0;
global.lastTextEl = null;
global.lastTextContent = "";
global.thinkingEl = null;
global.thinkingContent = "";
global.toolGroupEl = null;
let fetchImpl = async () => {
  throw new Error("Failed to fetch");
};
global.apiFetch = (p, o) => fetchImpl(p, o);

// ---- load the real code ----
for (const name of ["sseFrame", "sseDegrade", "sseWatchdogTick", "startSseWatchdog", "connectSSE", "sseSuspend", "sseResume", "stop"]) {
  (0, eval)(fnBody(name));
}

(async () => {
  // ---- 1) a stream is armed: one stream, keepalive listened for BY NAME ----
  connectSSE();
  const es1 = instances[instances.length - 1];
  check(es1 && es1.url.includes("/api/events?"), "connectSSE opens the events stream");
  check((es1.listeners.ping || []).length === 1, "the named keepalive is listened for by name");
  check(!/replay/.test(es1.url) && !/[?&]since=/.test(es1.url),
    "a window that has painted nothing asks for the resident window, not an offset");

  // ---- 2) half-open stream: silent past three keepalives, no ES error at all --
  es1.fireOpen();
  check(orphansDropped === 1, "a reconnect drops the live blocks the dead stream left (the frozen 'thinking… N chars')");
  setStatus("running");
  check(global.busy === true, "an open stream with a run in flight keeps the button on Stop");
  global.sseLastFrameAt = Date.now() - global.SSE_STALE_MS - 1;
  sseWatchdogTick();
  check(losses.length === 1 && /lost the live stream/.test(losses[0]),
    "a silent stream raises the disconnect dialog, not a self-dismissing toast");
  check(notices.length === 0, "and nothing is said twice: one funnel, one announcement");
  check(global.busy === true && statuses[statuses.length - 1] === "running",
    "the cached run state is left for the host's own status frame to settle");
  check(reconnects === 1, "the dead stream is re-established on this window base");

  // ---- 3) one report per outage, not one per tick ----
  // a second stale window does retry the link -- once per window, not once
  // per 5s tick -- but it must not re-announce what the user already knows
  global.sseLastFrameAt = Date.now() - global.SSE_STALE_MS - 1;
  const reconnectsAfterOutage = reconnects;
  sseWatchdogTick();
  check(losses.length === 1, "an ongoing outage is not re-announced every tick");
  check(reconnects === reconnectsAfterOutage + 1,
    "a window that stays stale retries the link once, not once per tick");

  // ---- 4) any frame, event or keepalive, clears the outage ----
  const es2 = instances[instances.length - 1];
  es2.firePing();
  check(global.sseDown === false, "a keepalive frame proves liveness again");
  const quietReconnects = reconnects;
  global.sseLastFrameAt = Date.now();
  sseWatchdogTick();
  check(losses.length === 1 && reconnects === quietReconnects,
    "a live stream triggers nothing");

  // ---- 5) a base that is GONE: EventSource retries forever in silence ----
  connectSSE();
  const es3 = instances[instances.length - 1];
  es3.fireOpen();
  check(global.sseErrorsSince === 0, "a connect opens a fresh failure window");
  es3.fireError();
  es3.fireError();
  es3.fireError();
  check(losses.length === 1, "a couple of dropped connects are still just a blip");
  // a burst of quick refusals is not a verdict: the question is how long the
  // base has been silent, and a phone whose tunnel is mid-redial fails a whole
  // handful of connects in the first seconds of the outage
  for (let i = 0; i < 20; i++) es3.fireError();
  check(losses.length === 1, "twenty more failures in the same second are still one blip");
  global.sseErrorsSince = Date.now() - global.SSE_ERROR_WINDOW_MS - 1;
  es3.fireError();
  check(losses.length === 2 && /the backend did not answer for 30s/.test(losses[1]),
    "a base that has not answered for the whole window is reported once");

  // ---- 6) Stop that cannot be delivered: the click answers, and heals ----
  fetchImpl = async () => {
    throw new Error("Failed to fetch");
  };
  setStatus("running");
  const noticesBeforeFailedStop = notices.length;
  await stop();
  check(losses.length === 3 && /could not reach the session to stop the task/.test(losses[2]),
    "an undeliverable Stop is a LOST SESSION, and the dialog (not a toast) says so");
  check(notices.length === noticesBeforeFailedStop,
    "no toast competes with the dialog for the same failure");
  check(global.busy === false && statuses[statuses.length - 1] === "idle",
    "an undeliverable Stop stops pretending the window is running it");
  check(probes === 1, "an undeliverable Stop re-resolves this session (the heal)");

  // ---- 7) Stop that lands: nothing is claimed on its behalf ----
  const before = notices.length;
  fetchImpl = async () => ({ status: "cancelling" });
  setStatus("running");
  await stop();
  check(notices.length === before && probes === 1,
    "a delivered Stop stays quiet: the stream carries the aborted final");
  check(global.busy === true, "a delivered Stop leaves the stream in charge of the status");

  summary("sse-liveness");
})();
