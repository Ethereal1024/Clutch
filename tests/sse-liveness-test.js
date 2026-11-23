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

const { check, summary, slicer, uiSource, stateStub } = require("./harness.js");

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
check(/es\.onerror = \(\) => \{[\s\S]{0,900}?sseDegrade\("the backend did not answer/.test(src),
  "es.onerror is no longer an empty auto-reconnect stub");
check(/connectionLost\("could not reach the session to stop the task/.test(src),
  "stop() surfaces the failure instead of an empty catch (through the dialog)");
// `export let`: the bindings are the stream's own module state, exported because
// the watchdog and the resume path read them from other modules — a per-stream
// local would reset with every reconnect and lose the gap the resume forgives
check(/^export let sseLastFrameAt = 0;/m.test(src) && /^export let sseErrorsSince = 0;/m.test(src) &&
  /^export let sseDown = false;/m.test(src) && /^export let sseWatchdog = null;/m.test(src) &&
  /^export let sseSuspended = false;/m.test(src),
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

// the shared state leaf (ui/src/renderer/state.ts), at its declared defaults:
// the painted watermark and the live blocks are fields of it, not globals
global.state = stateStub();
global.EventSource = FakeEventSource;
global.setInterval = () => 1; // the watchdog timer is driven by hand below
global.state.apiBase = "http://127.0.0.1:43761";
global.currentProject = "/tmp/demo.clc";
global.es = null;
global.busy = false;
// how far this window has painted (js/project.js): a fresh window has nothing
// to ask for, so the stream serves the resident window
global.state.streamHighOffset = null;
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
// settleCatchUp() (stream-events.ts) closes the catch-up bracket with
// endCatchUp, which is stream-view.ts's one move: the drain and that move are
// tests/catch-up-paint-test.js's subject, so the bracket's move is stubbed here
// and the real settleCatchUp (in the eval list below) still runs.
global.endCatchUp = () => {};
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
global.notice = (m) => notices.push(m);
// the disconnect funnel: this runner drives sse-stream.js, whose only answer to
// a dead stream is to raise the dialog (ui/src/renderer/conn-lost.ts). What the dialog
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
// The workspace tree this window reads: on open it is read only when no project
// is named — a named project is resolved by the session AFTER the headers this
// frame reports, so the read belongs to the `replayed` frame (section 8 below).
let treeRefreshes = 0;
global.refreshTree = () => {
  treeRefreshes++;
};
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
global.state.textRenderRaf = 0;
global.state.lastTextEl = null;
global.state.lastTextContent = "";
global.state.thinkingEl = null;
global.state.thinkingContent = "";
global.state.toolGroupEl = null;
let fetchImpl = async () => {
  throw new Error("Failed to fetch");
};
global.apiFetch = (p, o) => fetchImpl(p, o);

// The run loop is the HOST's (P1-4): Stop and Run are IPC calls into
// window.clutchRun, and there is no page-side /api/stop any more. The host's
// answers arrive in two shapes — ui/preload.js resolves {ok,error} and
// ui/src/renderer/bridge-shim.ts rejects (an unreachable bridge IS a dead channel) — so the
// stub can be either, and hostCall() (loaded below) is what normalises them.
let hostStop = async () => ({ ok: true });
const hostStops = { count: 0 };
global.window = {
  clutchRun: {
    start: async () => ({ ok: true }),
    drive: async () => ({ ok: true }),
    stop: () => {
      hostStops.count++;
      return hostStop();
    },
  },
};

// ---- load the real code ----
// settleCatchUp is here because connectSSE/closeSSE/es.onerror end the catch-up
// block before they let go of a stream; what a drain paints, and when it must
// happen, is tests/catch-up-paint-test.js's subject, not this runner's.
for (const name of ["hostCall", "sseFrame", "sseDegrade", "sseWatchdogTick", "startSseWatchdog", "connectSSE", "settleCatchUp", "sseSuspend", "sseResume", "stop"]) {
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
  // The click is one host call now (no second POST /api/stop path — a page-side
  // stop would leave the host loop driving a turn nobody owns). An unreachable
  // bridge rejects with no code at all, which is the reported "Failed to fetch".
  setStatus("running");
  const stopsBefore = hostStops.count;
  hostStop = async () => {
    throw new Error("Failed to fetch");
  };
  const noticesBeforeFailedStop = notices.length;
  await stop();
  check(hostStops.count === stopsBefore + 1,
    "the click is handed to the host loop, not to a page-side stop of its own");
  check(losses.length === 3 && /could not reach the session to stop the task/.test(losses[2]),
    "an undeliverable Stop is a LOST SESSION, and the dialog (not a toast) says so");
  check(notices.length === noticesBeforeFailedStop,
    "no toast competes with the dialog for the same failure");
  check(global.busy === false && statuses[statuses.length - 1] === "idle",
    "an undeliverable Stop stops pretending the window is running it");
  check(probes === 1, "an undeliverable Stop re-resolves this session (the heal)");

  // ---- 6b) a host that ANSWERED and refused stays inline, like any refusal --
  // {ok:false, code} is ui/preload.js's shape: the session is reachable, so this
  // is not the lost-session dialog — it is a transcript line the user can act on
  setStatus("running");
  hostStop = async () => ({ ok: false, code: "run_active", error: "another window is driving this run" });
  const lossesBeforeRefusal = losses.length;
  await stop();
  check(losses.length === lossesBeforeRefusal,
    "a refusal does not claim the session is lost: the host answered");
  check(/backend refused to stop the task/.test(notices[notices.length - 1] || ""),
    "a refusal says so inline, with the host's own reason");
  check(global.busy === false && probes === 2,
    "a refusal still gives the button back and re-resolves the session");

  // ---- 6c) a build with no host loop: an honest absence, not a fake POST ----
  const noLoop = global.window.clutchRun.stop;
  delete global.window.clutchRun.stop;
  const noticesBeforeNoLoop = notices.length;
  await stop();
  check(/no host run loop/.test(notices[notices.length - 1] || "") && notices.length === noticesBeforeNoLoop + 1,
    "a page without the loop says it cannot stop, rather than inventing a second stop path");
  global.window.clutchRun.stop = noLoop;

  // ---- 7) Stop that lands: nothing is claimed on its behalf ----
  const before = notices.length;
  hostStop = async () => ({ ok: true });
  setStatus("running");
  await stop();
  check(notices.length === before && probes === 2,
    "a delivered Stop stays quiet: the stream carries the aborted final");
  check(global.busy === true, "a delivered Stop leaves the stream in charge of the status");

  // ---- 8) the workspace tree is read where the SESSION has answered ----
  // A session replaced under this window (a tunnel end, the host's self-heal, a
  // re-claim — ui/host-core.js claimWindowBackend) starts with no project: it
  // ADOPTS the one this stream names, and it does so AFTER the response headers
  // that fire onopen. A tree read from onopen can therefore race that open and
  // be answered "nothing open" — the reported blank workspace panel after a
  // reconnect, which only recovered when the user sent a task. So a window that
  // names a project reads the tree when the block the server brackets around
  // that answer closes instead (js/stream-events.js `replayed`, driven for real
  // by replay-dedupe-test.js).
  const opened = treeRefreshes;
  connectSSE();
  instances[instances.length - 1].fireOpen();
  check(treeRefreshes === opened,
    "onopen does not read the tree for a named project: it would race the session's own open");
  // no project named: the tree cannot race anything, and it is still read here
  global.currentProject = "";
  connectSSE();
  instances[instances.length - 1].fireOpen();
  check(treeRefreshes === opened + 1,
    "a window with no project still resyncs the tree on open, as it always did");

  summary("sse-liveness");
})();
