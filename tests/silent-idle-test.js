"use strict";

// Regression test for the silent half of the report: a run that was in flight
// when this window's SESSION was replaced came back as a bare "idle" badge.
//
// The replacement is legitimate — a tunnel end, the host's self-heal, a re-claim
// after a blip, the user connecting to another host: the host releases the
// session the run lived in. What is NOT legitimate is the silence: the new
// session's first frame honestly reports idle, and the window repainted itself
// as if the user had simply never started anything. The run (and anything it had
// already done) vanished without a word.
//
// The runner pulls the REAL switchBackend / dropStaleBackend / renderEvent out of
// the renderer and drives them, so the flag cannot be dropped from one end of the
// journey (the move) or the other (the frame that reveals the outcome).
//
// Run: node tests/silent-idle-test.js

const { check, summary, slicer, uiSource } = require("./harness.js");

const APP = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(APP);

// ---- the wire contract: a flag that survives from the move to the frame ----
check(/^let sseRunAtRisk = false;$/m.test(APP),
  "an in-flight run at risk is real module state (it has to outlive the base)");
check(/if \(busy && clean !== API_BASE\) sseRunAtRisk = true;/.test(fnBody("switchBackend")),
  "moving the base while a run is in flight records it");
check(/if \(busy\) sseRunAtRisk = true;/.test(fnBody("dropStaleBackend")),
  "so does dropping the base under a run (the tunnel-end path)");
check(/if \(ev\.value === "idle" && sseRunAtRisk\)/.test(fnBody("renderEvent")),
  "the status frame that reveals the outcome is where it is answered");
check(/notice\("the connection to the session running this task was lost/.test(fnBody("renderEvent")),
  "with words — the badge alone was the bug");
check(/sseRunAtRisk = false;/.test(fnBody("switchBackend").length ? APP : APP) &&
  fnBody("renderEvent").split("sseRunAtRisk = false;").length - 1 === 2,
  "both outcomes retire the flag (the run is gone, or it was still there)");

// ---- stub environment ----
const store = new Map();
const notices = [];
const statuses = [];
global.SUPERVISOR_BASE = "http://127.0.0.1:8890";
global.API_BASE = null;
global.busy = false;
global.sseRunAtRisk = false;
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.reconnectSSE = () => {};
global.notice = (m) => notices.push(m);
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
// renderEvent builds its row shells before dispatching; state_update needs no
// more than something to assign className on
global.document = { createElement: () => ({ className: "", appendChild() {} }) };

for (const name of ["switchBackend", "dropStaleBackend", "renderEvent"]) {
  (0, eval)(fnBody(name));
}

const lastNotice = () => notices[notices.length - 1];
const frame = (value) => renderEvent({ type: "state_update", key: "execution_status", value });

// ---- 1) a run is live when the window's session is replaced ----
setStatus("running");
check(global.busy === true, "a live run has the window running");
check(switchBackend("http://127.0.0.1:31002") === true, "the host re-points this window at a new session");
check(global.sseRunAtRisk === true, "the in-flight run is recorded before the new stream speaks");

const noticesBefore = notices.length;
frame("idle"); // the new session's first frame: it has nothing in flight
check(statuses[statuses.length - 1] === "idle" && global.busy === false,
  "the frame is still painted: Stop must not pretend a run is behind it");
check(notices.length === noticesBefore + 1 && /nothing is running now/.test(lastNotice()),
  "and the loss is announced instead of slipped in");
check(global.sseRunAtRisk === false, "the flag is spent: one announcement per lost run");
frame("idle");
check(notices.length === noticesBefore + 1, "a later idle frame repeats nothing");

// ---- 2) the run was NOT lost (the stream only reconnected) ----
setStatus("running");
switchBackend("http://127.0.0.1:31003");
frame("running"); // the host's real state: still in flight
check(notices.length === noticesBefore + 1 && global.busy === true,
  "a frame that still reports running is not a loss");
check(global.sseRunAtRisk === false, "and it retires the flag");
frame("idle"); // the run ended on its own afterwards
check(notices.length === noticesBefore + 1, "an ordinary end stays quiet: no invented loss");

// ---- 3) an idle window that moves base has no run to lose ----
setStatus("idle");
switchBackend("http://127.0.0.1:31004");
check(global.sseRunAtRisk === false, "no run in flight, nothing at risk");
frame("idle");
check(notices.length === noticesBefore + 1, "and the new session's idle is just the truth");

// ---- 4) the tunnel-end path (the phone's own report) ----
setStatus("running");
dropStaleBackend(); // the forwarded port died with the tunnel
check(global.API_BASE === null, "the dead base is dropped");
check(global.sseRunAtRisk === true, "and the run that lived on it is recorded");
frame("idle"); // the session re-claimed after the reconnect
check(notices.length === noticesBefore + 2 && /nothing is running now/.test(lastNotice()),
  "the run is not allowed to disappear into an idle badge on the phone either");

// ---- 5) the sentinel still never becomes a base ----
check(switchBackend("http://127.0.0.1:8890") === false && global.sseRunAtRisk === false,
  "a refused base is not a move (no false alarm either)");

summary("silent-idle");
