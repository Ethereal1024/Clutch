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
// the real functions out of ui/app.js and drives them against a fake
// EventSource, so a silent edit that reintroduces the freeze fails here.
//
// Run: node tests/sse-liveness-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const APP = path.join(__dirname, "..", "ui", "app.js");
const src = fs.readFileSync(APP, "utf8");
const { fnBody } = slicer(src);

// ---- the wire contract with the server (agent/server.py) ----
check(/const SSE_KEEPALIVE_MS = 15000;/.test(src),
  "renderer keepalive window matches the 15s keepalive the server sends");
check(/es\.addEventListener\("ping", sseFrame\)/.test(src),
  "the keepalive is consumed as a NAMED event: an idle stream can prove it lives");
check(/const SSE_STALE_MS = SSE_KEEPALIVE_MS \* 3;/.test(src),
  "three missed keepalives (not one) are the threshold for a dead stream");
check(/const SSE_MAX_ERRORS = 4;/.test(src),
  "a base that stops answering is counted instead of retried in silence");
check(/es\.onerror = \(\) => \{\n    \/\/ the browser reconnects/.test(src),
  "es.onerror is no longer an empty auto-reconnect stub");
check(/notice\("could not reach the backend to stop/.test(src),
  "stop() surfaces the failure instead of an empty catch");
check(/let sseLastFrameAt = 0;[\s\S]{0,240}?let sseWatchdog = null;/.test(src),
  "the liveness state is real module state, not a per-stream local");

// ---- stub environment ----
const notices = [];
const statuses = [];
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
// the module-level stream state of ui/app.js: its let-declarations are NOT
// visible to an indirect eval of one function at a time, so the runner owns
// the storage here (the block below asserts the source declares it for real)
global.sseLastFrameAt = 0;
global.sseErrors = 0;
global.sseDown = false;
global.sseWatchdog = null;
global.SSE_STALE_MS = 45000;
global.SSE_MAX_ERRORS = 4;
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
global.notice = (m) => notices.push(m);
global.reconnectSSE = () => {
  reconnects++;
};
global.switchBackendResolved = async () => {
  probes++;
  return true;
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
let fetchImpl = async () => {
  throw new Error("Failed to fetch");
};
global.apiFetch = (p, o) => fetchImpl(p, o);

// ---- load the real code ----
for (const name of ["sseFrame", "sseDegrade", "sseWatchdogTick", "startSseWatchdog", "connectSSE", "stop"]) {
  (0, eval)(fnBody(name));
}

(async () => {
  // ---- 1) a stream is armed: one stream, keepalive listened for BY NAME ----
  connectSSE(true);
  const es1 = instances[instances.length - 1];
  check(es1 && es1.url.includes("/api/events?"), "connectSSE opens the events stream");
  check((es1.listeners.ping || []).length === 1, "the named keepalive is listened for by name");
  check(es1.url.includes("replay=1"), "a fresh stream asks for the history replay");

  // ---- 2) half-open stream: silent past three keepalives, no ES error at all --
  es1.fireOpen();
  setStatus("running");
  check(global.busy === true, "an open stream with a run in flight keeps the button on Stop");
  global.sseLastFrameAt = Date.now() - global.SSE_STALE_MS - 1;
  sseWatchdogTick();
  check(notices.length === 1 && /lost the live stream/.test(notices[0]),
    "a silent stream is reported, not painted over");
  check(global.busy === false && statuses[statuses.length - 1] === "idle",
    "the cached running state is dropped: the button reacts again");
  check(reconnects === 1, "the dead stream is re-established on this window base");

  // ---- 3) one report per outage, not one per tick ----
  // a second stale window does retry the link -- once per window, not once
  // per 5s tick -- but it must not re-announce what the user already knows
  global.sseLastFrameAt = Date.now() - global.SSE_STALE_MS - 1;
  const reconnectsAfterOutage = reconnects;
  sseWatchdogTick();
  check(notices.length === 1, "an ongoing outage is not re-announced every tick");
  check(reconnects === reconnectsAfterOutage + 1,
    "a window that stays stale retries the link once, not once per tick");

  // ---- 4) any frame, event or keepalive, clears the outage ----
  const es2 = instances[instances.length - 1];
  es2.firePing();
  check(global.sseDown === false, "a keepalive frame proves liveness again");
  const quietReconnects = reconnects;
  global.sseLastFrameAt = Date.now();
  sseWatchdogTick();
  check(notices.length === 1 && reconnects === quietReconnects,
    "a live stream triggers nothing");

  // ---- 5) a base that is GONE: EventSource retries forever in silence ----
  connectSSE(false);
  const es3 = instances[instances.length - 1];
  es3.fireOpen();
  check(global.sseErrors === 0, "a connect resets the failure count");
  es3.fireError();
  es3.fireError();
  es3.fireError();
  check(notices.length === 1, "a couple of dropped connects are still just a blip");
  es3.fireError();
  check(notices.length === 2 && /the backend did not answer/.test(notices[1]),
    "a base that never answers is reported once the failures pile up");
  check(global.busy === false, "no stream, no cached running state");

  // ---- 6) Stop that cannot be delivered: the click answers, and heals ----
  fetchImpl = async () => {
    throw new Error("Failed to fetch");
  };
  setStatus("running");
  await stop();
  check(/could not reach the backend to stop/.test(notices[notices.length - 1]),
    "an undeliverable Stop says so (the old catch swallowed it)");
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
