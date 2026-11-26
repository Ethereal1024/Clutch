"use strict";

// Regression test for the transcript that visibly DOUBLED after a reconnect.
//
// A reconnecting stream heals by re-reading the log, and the window's answer to
// "from where" is a watermark — the highest log offset already rendered
// (streamHighOffset, declared beside oldestOffset in js/project.js), which
// js/sse-stream.js now sends as `?since=`. Whatever the server sends from there
// (a window's tail, or — the 0.1.18 compat path — a window that reaches back
// past it) a record at or below the watermark is one this window already
// painted. The offsets are the log's own monotonic byte positions inside the
// .clc (agent/core/lazy.py appends `self._file_bytes - self._base` per record),
// so they never restart, not even across a compaction.
//
// The same block closes with the server's `replayed` frame: a catch-up paints
// without dragging the view (js/stream-view.js beginCatchUp/endCatchUp), and a
// `resync` frame (the offset cannot be continued from) restarts the pane.
//
// The history paging path is the exception, and must stay one: it walks
// BACKWARDS through older records into an off-DOM sink (pageSink), so it is
// exempt from the watermark and never moves it.
//
// Like the other runners, this pulls the REAL addEvent / clearStream out of the
// renderer and drives them against stubs.
//
// Run: node tests/replay-dedupe-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource, stateStub, installRecordLedger } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const APP = uiSource(); // the renderer, every module in page load order
const PROJECT = fs.readFileSync(path.join(ROOT, "ui", "src", "renderer", "project.ts"), "utf8");
const STATE = fs.readFileSync(path.join(ROOT, "ui", "src", "renderer", "state.ts"), "utf8");
const { fnBody } = slicer(APP);

// ---- 1. the watermark is real module state, reset with the pane ----
check(/^\s*streamHighOffset: null,$/m.test(STATE) && /^\s*oldestOffset: null,$/m.test(STATE),
  "the watermark is module state beside the other stream state (oldestOffset)");
check(/state\.streamHighOffset = null;/.test(fnBody("clearStream")),
  "and a fresh project pane forgets it: the next transcript starts empty");

// ---- the wire shape the two paths use ----
// SSE frames are {offset, event} for a durable record — the replay's shape, and
// (since a live append stamps the record with its offset) the live one too;
// paging unwraps its own {offset, event} records; a delta stays bare
check(/function addEvent\(ev\)/.test(APP) &&
  /ev\.event && typeof ev\.offset === "number"/.test(fnBody("addEvent")),
  "the runner drives the real thing: a record is {offset, event} on the wire");
check(/^export function reconnectSSE\(\)/m.test(APP) &&
  /openStream\(\);/.test(fnBody("reconnectSSE")) && !/new EventSource/.test(fnBody("reconnectSSE")),
  "the reconnecting stream re-opens the log the pane ADOPTED (openStream reads the scope): a heal never reads another project");
check(/if \(state\.streamHighOffset !== null\) qs\.set\("since"/.test(fnBody("openStream")),
  "and it asks for exactly the records after that watermark, or for the window when there are none");

// ---- stub environment ----
const rendered = [];
const pill = [];
const pins = []; // every write autoScroll actually makes to the view's scrollTop
let pagingSink = null;
// the shared state leaf (ui/src/renderer/state.ts), at its declared
// defaults: the two watermarks are fields of it, not globals
global.state = stateStub();
global.eventsEl = {
  set innerHTML(v) {
    if (v === "") rendered.length = 0;
  },
  get innerHTML() {
    return "";
  },
  appendChild: (el) => rendered.push(el),
  // the pane's own announcements (the catch-up bracket ends with one, auto-fold's
  // `clutch:pane-settled`): a real pane dispatches, and this runner has no listeners
  dispatchEvent: () => {},
};
global.pageSink = null;
// the view: a real element's two scroll fields and nothing else (autoScroll only
// reads scrollHeight and writes scrollTop while latched)
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
global.state.streamHighOffset = null;
global.state.oldestOffset = null;
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
global.setOlderPill = (n) => pill.push(n);
global.flushTextRender = () => {};
global.flushThinkingRender = () => {}; // addEvent finalizes the reasoning block too
global.applyStreamEvent = () => false;
// a rendered row carries the record's own byte offset (js/stream-events.js
// addEvent stamps dataset.offset): the roll-back gesture reads it off the row,
// and this runner renders the real rows
global.renderEvent = (ev) => ({ ev, dataset: {}, matches: () => false });
global.highlightCode = () => {};
global.typesetMath = () => {};
// the catch-up bracket (js/stream-view.js): the runner drives the real pair AND
// the real autoScroll, so the guard is exercised and not re-implemented
global.busy = false; // a run drawing into this pane (stream-view.ts)
global.catchUp = false;
global.followTail = true;
global.gliding = false;
global.glideRaf = 0;
global.setJumpVisible = () => {};
// the run-settled ledger addEvent writes (js/stream-events.js): no run is at
// stake here — what the window says about a LOST one is tests/silent-idle-test.js
global.sseRunLostPending = false;
global.runSettled = false;
// the run-boundary marks addEvent clears (js/permissions.js answeredPerm): this
// runner cares about offsets, not prompts — what the mark does for a new run is
// tests/perm-run-scope-test.js
global.forgetAnsweredPerm = () => {};
// the send outbox (js/render-events.ts noteUserMessage) answers the composer,
// not the pane: this runner replays offsets with no send in flight
global.noteUserMessage = () => {};
// the journal anchors a cleared pane drops (js/task-rollback.js, which loads
// after this module): they belong to the project that just left, so clearStream
// forgets them with the transcript. What a stale set would cost is that
// module's subject — here the pane is.
global.resetRollbackAnchors = () => {};
// the workspace-panel read the `replayed` frame makes (js/workspace-panel.js):
// the session has resolved the project this stream names by then, and only then
// is a tree read unable to race it (asserted below and in sse-liveness-test.js)
let treeRefreshes = 0;
global.refreshTree = () => {
  treeRefreshes++;
};

// the closed-block ledger the reconnect teardown files a kept block in (stream-events.ts)
installRecordLedger();

for (const name of ["addEvent", "settleCatchUp", "clearStream", "beginCatchUp", "endCatchUp", "autoScroll"]) {
  (0, eval)(fnBody(name));
}

const frame = (offset, event) => ({ offset, event });

// ---- 2. the log this window already painted ----
addEvent(frame(10, { type: "user_message", text: "one" }));
check(rendered.length === 1 && global.state.streamHighOffset === 10 && global.state.oldestOffset === 10,
  "a record is rendered, and it sets both marks");

addEvent(frame(22, { type: "user_message", text: "two" }));
check(rendered.length === 2 && global.state.streamHighOffset === 22,
  "the next record advances the watermark");
check(global.state.oldestOffset === 10,
  "while the OLDEST mark stays put: it is what the paging walk asks from");

// the reconnect: the same window is replayed from its start
const afterLive = rendered.length;
addEvent(frame(10, { type: "user_message", text: "one" }));
addEvent(frame(22, { type: "user_message", text: "two" }));
check(rendered.length === afterLive,
  "a replayed record at or below the watermark is not painted twice");
check(global.state.streamHighOffset === 22, "and the watermark does not move for it");
check(global.state.oldestOffset === 10, "nor does the oldest mark");

// the replay continues past what this window has seen: the new tail lands
addEvent(frame(31, { type: "final", status: "ok", summary: "done" }));
check(rendered.length === afterLive + 1 && global.state.streamHighOffset === 31,
  "and the part of the replay this window had missed is painted");

// a compaction rewrites the log but not the offsets (agent/api/events.py replays
// by offset): a record straddling the watermark is still one record
addEvent(frame(31, { type: "final", status: "ok", summary: "done" }));
check(rendered.length === afterLive + 1, "one record, one paint, however often it is replayed");

// ---- 3. a live durable frame is stamped like a replayed one ----
// The server stamps a durable record with the offset it was appended at
// (agent/core/lazy.py -> agent/api/events.py _write_sse), so the LIVE frame is
// the same {offset, event} shape the replay sends. That is what makes the
// watermark survive a reconnect instead of only a replay: without the stamp a
// record painted live never moved it, and the reconnecting stream painted the
// whole window again.
addEvent(frame(35, { type: "assistant_message", content: "live" }));
check(rendered.length === afterLive + 2 && global.state.streamHighOffset === 35,
  "a live durable frame is painted and moves the watermark onto its own record");

// a transient delta never reaches the log: no offset, never replayed, and it
// must not be deduped or move the watermark
addEvent({ type: "text_delta", text: "hi" });
check(rendered.length === afterLive + 3 && global.state.streamHighOffset === 35,
  "a delta stays a bare frame: painted, and the watermark is left alone");

// the reconnect: the replay re-sends the very record this window painted live
addEvent(frame(35, { type: "assistant_message", content: "live" }));
check(rendered.length === afterLive + 3,
  "and its replay is not painted a second time: the live copy already counted");

// ---- 4. the paging path is exempt, and does not move the watermark ----
global.pageSink = { appendChild: (el) => rendered.push(el) };
addEvent(frame(2, { type: "user_message", text: "older" }));
check(rendered.length === afterLive + 4,
  "an older page is rendered even though its offset is far below the watermark");
check(global.state.streamHighOffset === 35,
  "and the watermark is untouched by the walk (it must not become the paging head)");
check(global.state.oldestOffset === 2, "while the oldest mark follows the walk, as it must");
global.pageSink = null;

// a page below the watermark does not blind the next live record either
addEvent(frame(44, { type: "final", status: "ok", summary: "next" }));
check(rendered.length === afterLive + 5 && global.state.streamHighOffset === 44,
  "the next live record is still painted after a page-back");

// ---- 5. a fresh pane starts from scratch ----
clearStream();
check(global.state.streamHighOffset === null && global.state.oldestOffset === null &&
  rendered.length === 0,
  "clearing the pane drops the transcript and both marks");
addEvent(frame(10, { type: "user_message", text: "reopened" }));
check(rendered.length === 1,
  "so the same offsets can be painted again: a reopened project is not a replay");

// ---- 6. the one-shot recovery notice is not part of the transcript ----
const beforeNotice = rendered.length;
addEvent({ type: "history", older: 4096 });
check(rendered.length === beforeNotice && pill[pill.length - 1] === 4096,
  "the replay's 'history' frame restores the older-pill count and paints nothing");

// ---- 7. a catch-up paints in one pass: the view moves once, at its end ----
// (the block the server brackets between `history` and `replayed`: without the
// bracket a returning phone scrolls once per replayed record, dragging a user
// who had scrolled up along with it — and without the batch, a tunnel paints
// once per FRAME, which is a transcript that visibly assembles itself)
check(global.catchUp === true, "the 'history' frame opens the catch-up");
const pinsBefore = pins.length;
addEvent(frame(50, { type: "user_message", text: "owed" }));
addEvent(frame(61, { type: "final", status: "ok", summary: "owed" }));
check(rendered.length === beforeNotice && pins.length === pinsBefore,
  "its records are held as paint work, not appended one SSE frame at a time");
check(global.catchUp === true, "and the block is still open: only the server closes it");
addEvent({ type: "replayed", count: 2 });
check(rendered.length === beforeNotice + 2,
  "the 'replayed' frame paints the whole block before the view moves");
check(global.catchUp === false, "and it closes the catch-up");
check(pins.length === pinsBefore + 1 && pins[pins.length - 1] === 1000,
  "and the view moves exactly once, at the end, onto the real tail");
// the same frame is the first moment the workspace tree may be read: the host
// resolves the project this stream named BEFORE it serves that block
// (agent/api/events.py _project_for_sse), and a session that was replaced under
// this window adopts it there. A read from onopen beats that open and is
// answered "nothing open" — the blank panel after a reconnect (sse-liveness-test.js)
check(treeRefreshes === 1, "and it re-reads the workspace tree, now that the session's project is settled");
addEvent({ type: "replayed", count: 0 });
check(pins.length === pinsBefore + 1, "a close with nothing open moves nothing");
check(treeRefreshes === 2,
  "an empty catch-up re-reads the tree too: that is the ordinary idle reconnect");

// ---- 8. an offset the log cannot continue from restarts the pane ----
// (the .clc was replaced under this window: appending the served window would
// leave two transcripts on one screen)
const beforeResync = rendered.length;
addEvent(frame(72, { type: "user_message", text: "second transcript" }));
check(rendered.length === beforeResync + 1, "the served window lands...");
addEvent({ type: "resync" });
check(rendered.length === 0 && global.state.streamHighOffset === null &&
  global.state.oldestOffset === null,
  "...and 'resync' starts it over instead of leaving two on one screen");

// ---- 9. a block that is abandoned drops its held paint work ----
// (a resync, a project switch: those rows belong to the pane that is going away,
// and a queue that outlived the clear would append them into the new one)
addEvent({ type: "history", older: 0 });
const heldBefore = rendered.length;
addEvent(frame(90, { type: "user_message", text: "never painted" }));
check(rendered.length === heldBefore, "a record is held while its block is open");
addEvent({ type: "resync" });
check(global.state.owedRecords.length === 0,
  "and the resync that starts the pane over drops the held rows with it");

summary("replay-dedupe");
