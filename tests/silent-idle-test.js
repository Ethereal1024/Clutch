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
// The announcement is a record, not a notification. The status frame cannot make
// one — it arrives BEFORE the replay, so it does not yet know whether the log
// ends the run (the departing session appends a final of its own when it is
// released mid-run: agent/server.py record_release) — so it only asks the
// question (sseRunLostPending), and the block the server brackets between
// `history` and `replayed` answers it (js/stream-events.js). A toast that
// dismisses itself was the old answer, and it is the thing this runner must not
// find again.
//
// The runner pulls the REAL switchBackend / dropStaleBackend / renderEvent /
// addEvent / applyStreamEvent / appendCompletion / clearStream out of the
// renderer and drives them, so the journey cannot be broken at one end (the
// move), the middle (the frame that reveals the outcome) or the other (the block
// that answers it) without this failing.
//
// Run: node tests/silent-idle-test.js

const { check, summary, slicer, uiSource } = require("./harness.js");

const APP = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(APP);

// ---- the wire contract: a flag that survives from the move to the frame ----
check(/^let sseRunAtRisk = false;$/m.test(APP),
  "an in-flight run at risk is real module state (it has to outlive the base)");
check(/^let sseRunLostPending = false;$/m.test(APP),
  "the question the revealing frame asks outlives the stream that answered it");
check(/^let runSettled = false;$/m.test(APP),
  "and the ledger it is answered against is state of its own");
check(/if \(busy && clean !== API_BASE\) sseRunAtRisk = true;/.test(fnBody("switchBackend")),
  "moving the base while a run is in flight records it");
check(/if \(busy\) sseRunAtRisk = true;/.test(fnBody("dropStaleBackend")),
  "so does dropping the base under a run (the tunnel-end path)");
check(/if \(ev\.value === "idle" && sseRunAtRisk\)/.test(fnBody("renderEvent")),
  "the status frame that reveals the outcome is where it is answered");
check(/sseRunLostPending = true;/.test(fnBody("renderEvent")),
  "with a question, not an answer: the log has not spoken yet");
check(!/notice\(/.test(fnBody("renderEvent")),
  "and not with a toast that dismisses itself (the phone learned nothing)");
check(fnBody("renderEvent").split("sseRunAtRisk = false;").length - 1 === 2,
  "both outcomes retire the flag (the run is gone, or it was still there)");
check(/if \(sseRunLostPending\) announceRunLost\(\);/.test(fnBody("addEvent")),
  "the block's closing frame is where the question is answered");
check(/if \(runSettled\) return;/.test(fnBody("announceRunLost")),
  "and never over a run the log ended itself");
check(/runSettled = true;/.test(fnBody("addEvent")) &&
  /runSettled = false;/.test(fnBody("addEvent")),
  "one ledger, written only where every record passes (live and replayed)");
check(/runSettled = false;/.test(fnBody("clearStream")),
  "a cleared pane holds no run's ending");
check(APP.split("SSE_RUN_LOST").length - 1 === 2,
  "the wording has one home: the announcement that states the loss");

// the wording itself, lifted from the renderer's own declaration: what the phone
// would read is what this runner asserts, never a copy that can drift from it
const DECL = APP.match(/const SSE_RUN_LOST = ([\s\S]+?);\n/);
check(DECL !== null, "the wording for a lost run is declared where the window can render it");
const RUN_LOST = DECL ? (0, eval)(DECL[1]) : "";
check(typeof RUN_LOST === "string" && /nothing is running now/.test(RUN_LOST),
  "and it says the one thing a badge cannot: nothing is running now");

// ---- stub environment ----
const store = new Map();
const notices = []; // every toast raised, so "not a toast" is pinned, not assumed
const statuses = [];
const rendered = []; // the transcript: what the real render paths actually painted
const pins = []; // every write autoScroll makes to the view's scrollTop

function fakeEl(tag) {
  return {
    tag,
    className: "",
    textContent: "",
    innerHTML: "",
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    matches() { return false; },
    querySelector() { return null; },
    remove() {},
    isConnected: true,
  };
}

global.SUPERVISOR_BASE = "http://127.0.0.1:8890";
global.API_BASE = null;
global.busy = false;
global.sseRunAtRisk = false;
global.sseRunLostPending = false;
global.runSettled = false;
global.SSE_RUN_LOST = RUN_LOST; // the renderer's own wording, declared above
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// the session URL is per window (js/backend-lifecycle.js): switchBackend and
// dropStaleBackend both write it here, and neither may reach for a storage the
// page did not give it
const session = new Map();
global.sessionStorage = {
  getItem: (k) => (session.has(k) ? session.get(k) : null),
  setItem: (k, v) => session.set(k, String(v)),
  removeItem: (k) => session.delete(k),
};
global.reconnectSSE = () => {};
global.notice = (m) => notices.push(m);
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
global.document = { createElement: (tag) => fakeEl(tag) };
global.eventsEl = {
  set innerHTML(v) {
    if (v === "") rendered.length = 0;
  },
  get innerHTML() {
    return "";
  },
  appendChild: (el) => rendered.push(el),
};
global.pageSink = null;
// the view: a real element's two scroll fields and nothing else
global.stream = {
  classList: { contains: () => false },
  scrollHeight: 1000,
  get scrollTop() {
    return pins.length ? pins[pins.length - 1] : 0;
  },
  set scrollTop(v) {
    pins.push(v);
  },
};
global.streamHighOffset = null;
global.oldestOffset = null;
global.olderRemaining = 0;
global.toolGroupEl = null;
global.lastTextEl = null;
global.lastTextContent = "";
global.thinkingEl = null;
global.thinkingContent = "";
global.textRenderRaf = 0;
global.thinkingRenderRaf = 0;
global.compactionEl = null;
global.retryNoteEl = null;
global.cancelAnimationFrame = () => {};
global.setOlderPill = () => {};
global.flushTextRender = () => {};
global.flushThinkingRender = () => {}; // addEvent finalizes the reasoning block too
global.highlightCode = () => {};
global.typesetMath = () => {};
global.catchUp = false;
global.followTail = true;
global.gliding = false;
global.glideRaf = 0;
global.setJumpVisible = () => {};
// what the real `final` path touches (js/stream-events.js applyStreamEvent ->
// js/render-events.js appendCompletion: the divider the announcement rides on)
global.pendingPerm = null;
global.closePerm = () => {};
// the answered-ask marks addEvent clears at a run boundary (js/permissions.js):
// this runner drives the real final/addEvent paths, but no prompt is involved
global.forgetAnsweredPerm = () => {};
global.clearStreamPreviews = () => {};
global.clearRetryNote = () => {};
global.refreshTree = () => {};

for (const name of [
  "switchBackend", "dropStaleBackend", "escapeHtml", "renderMarkdown",
  "appendCompletion", "renderEvent", "applyStreamEvent", "addEvent",
  "announceRunLost", "clearStream", "beginCatchUp", "endCatchUp", "autoScroll",
]) {
  (0, eval)(fnBody(name));
}

// the completion divider appendCompletion builds: status text, then the reason
function completion() {
  const i = rendered.findIndex((el) => el.className === "completion");
  if (i < 0) return null;
  const next = rendered[i + 1];
  return {
    status: rendered[i].textContent,
    note: next && next.className === "completion-note" ? next.textContent : "",
  };
}
const completionCount = () => rendered.filter((el) => el.className === "completion").length;
const statusFrame = (value) =>
  addEvent({ type: "state_update", key: "execution_status", value });
const frame = (offset, event) => ({ offset, event });

// ---- 1) a run is live when the window's session is replaced ----
setStatus("running");
check(global.busy === true, "a live run has the window running");
check(switchBackend("http://127.0.0.1:31002") === true,
  "the host re-points this window at a new session");
check(global.sseRunAtRisk === true,
  "the in-flight run is recorded before the new stream speaks");

statusFrame("idle"); // the new session's first frame: it has nothing in flight
check(statuses[statuses.length - 1] === "idle" && global.busy === false,
  "the frame is still painted: Stop must not pretend a run is behind it");
check(global.sseRunLostPending === true,
  "and the loss becomes a question the log is about to answer");
check(notices.length === 0, "not a toast: one that dismisses itself is not a record");
addEvent({ type: "history", older: 0 });
check(completion() === null, "the answer is not the status frame's to give");
addEvent({ type: "replayed", count: 0 });
const stated = completion();
check(stated && stated.status === "error", "the transcript states the run's ending instead");
check(stated && /nothing is running now/.test(stated.note),
  "with words, in the completion divider the phone keeps");
check(global.sseRunLostPending === false,
  "the question is spent: one announcement per lost run");
check(global.runSettled === true, "and the record it wrote closes the run");
statusFrame("idle");
check(completionCount() === 1, "a later idle frame repeats nothing");

// ---- 2) the departing session wrote the ending itself ----
clearStream(); // a fresh pane: the new session's log is what this window paints
check(global.runSettled === false, "a cleared pane holds no run's ending");
setStatus("running");
switchBackend("http://127.0.0.1:31003");
statusFrame("idle");
check(global.sseRunLostPending === true, "the same question is asked");
addEvent({ type: "history", older: 0 });
addEvent(frame(140, {
  type: "final",
  status: "error",
  summary: "the host released this session while the run was in flight",
}));
addEvent({ type: "replayed", count: 1 });
const fromLog = completion();
check(completionCount() === 1 && fromLog && fromLog.status === "error",
  "the log's own final is the ending: exactly one completion");
check(/the host released this session/.test(fromLog.note),
  "and the window invents no second one above it");
check(!/nothing is running now/.test(fromLog.note),
  "the wording stays the departing session's");
check(global.sseRunLostPending === false && global.runSettled === true,
  "the question is answered by the record, and closes it");

// ---- 3) the run was NOT lost (the stream only reconnected) ----
clearStream();
setStatus("running");
switchBackend("http://127.0.0.1:31004");
statusFrame("running"); // the host's real state: still in flight
check(global.sseRunAtRisk === false && global.sseRunLostPending === false,
  "a frame that still reports running is not a loss");
addEvent({ type: "history", older: 0 });
addEvent({ type: "replayed", count: 0 });
check(completionCount() === 0, "and no ending is invented for a run that is still there");
addEvent(frame(300, { type: "final", status: "completed", summary: "" }));
statusFrame("idle"); // the run ended on its own afterwards
addEvent({ type: "replayed", count: 0 });
check(completionCount() === 1 && completion().status === "completed",
  "an ordinary end stays quiet: the run's own final is its record");

// ---- 4) an idle window that moves base has no run to lose ----
clearStream();
setStatus("idle");
switchBackend("http://127.0.0.1:31005");
statusFrame("idle");
addEvent({ type: "replayed", count: 0 });
check(global.sseRunAtRisk === false && global.sseRunLostPending === false &&
  completionCount() === 0,
  "no run in flight, nothing to lose and nothing to announce");

// ---- 5) a session that never serves the log: the next task closes it ----
// (the replay block is the answer; when the session serves none — the window's
// .clc is not openable for it — the question must not travel into the new task
// silently, and it must not be answered late, above a later run)
clearStream();
setStatus("running");
switchBackend("http://127.0.0.1:31006");
statusFrame("idle");
check(global.sseRunLostPending === true, "the question is open with no block behind it");
addEvent(frame(400, { type: "user_message", content: "next task" }));
const rows = rendered.map((el) => el.className);
check(rows.indexOf("completion") >= 0,
  "a task started on a session that serves no log still states the loss");
check(rows.indexOf("completion") < rows.indexOf("event user"),
  "and it goes ABOVE the new task, as the record of what came before it");
check(global.sseRunLostPending === false && global.runSettled === false,
  "the question is closed, and the new task's run is open");
addEvent({ type: "replayed", count: 0 });
check(completionCount() === 1, "the block that closes later repeats nothing");

// ---- 6) the tunnel-end path (the phone's own report) ----
clearStream();
setStatus("running");
dropStaleBackend(); // the forwarded port died with the tunnel
check(global.API_BASE === null, "the dead base is dropped");
check(global.sseRunAtRisk === true, "and the run that lived on it is recorded");
statusFrame("idle"); // the session re-claimed after the reconnect
addEvent({ type: "replayed", count: 0 });
const phone = completion();
check(phone && /nothing is running now/.test(phone.note),
  "the run is not allowed to disappear into an idle badge on the phone either");

// ---- 7) the sentinel still never becomes a base ----
setStatus("idle");
check(switchBackend("http://127.0.0.1:8890") === false && global.sseRunAtRisk === false,
  "a refused base is not a move (no false alarm either)");

check(notices.length === 0, "and not one toast was raised anywhere in this journey");

summary("silent-idle");
