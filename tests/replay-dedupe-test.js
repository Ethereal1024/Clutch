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
const { check, summary, slicer, uiSource } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const APP = uiSource(); // the renderer, every module in page load order
const PROJECT = fs.readFileSync(path.join(ROOT, "ui", "js", "project.js"), "utf8");
const { fnBody } = slicer(APP);

// ---- 1. the watermark is real module state, reset with the pane ----
check(/^let streamHighOffset = null;/m.test(PROJECT),
  "the watermark is module state beside the other stream state (oldestOffset)");
check(/streamHighOffset = null;/.test(fnBody("clearStream")),
  "and a fresh project pane forgets it: the next transcript starts empty");

// ---- the wire shape the two paths use ----
// SSE frames are {offset, event} for a durable record — the replay's shape, and
// (since a live append stamps the record with its offset) the live one too;
// paging unwraps its own {offset, event} records; a delta stays bare
check(/function addEvent\(ev\)/.test(APP) &&
  /ev\.event && typeof ev\.offset === "number"/.test(fnBody("addEvent")),
  "the runner drives the real thing: a record is {offset, event} on the wire");
check(/^function reconnectSSE\(\)/m.test(APP) &&
  /connectSSE\(\)/.test(fnBody("reconnectSSE")),
  "the reconnecting stream is a plain connect: the watermark is read in one place");
check(/if \(streamHighOffset !== null\) qs\.set\("since"/.test(fnBody("connectSSE")),
  "and it asks for exactly the records after that watermark, or for the window when there are none");

// ---- stub environment ----
const rendered = [];
const pill = [];
const pins = []; // every write autoScroll actually makes to the view's scrollTop
let pagingSink = null;
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
global.setOlderPill = (n) => pill.push(n);
global.flushTextRender = () => {};
global.flushThinkingRender = () => {}; // addEvent finalizes the reasoning block too
global.applyStreamEvent = () => false;
global.renderEvent = (ev) => ({ ev, matches: () => false });
global.highlightCode = () => {};
global.typesetMath = () => {};
// the catch-up bracket (js/stream-view.js): the runner drives the real pair AND
// the real autoScroll, so the guard is exercised and not re-implemented
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

for (const name of ["addEvent", "clearStream", "beginCatchUp", "endCatchUp", "autoScroll"]) {
  (0, eval)(fnBody(name));
}

const frame = (offset, event) => ({ offset, event });

// ---- 2. the log this window already painted ----
addEvent(frame(10, { type: "user_message", text: "one" }));
check(rendered.length === 1 && global.streamHighOffset === 10 && global.oldestOffset === 10,
  "a record is rendered, and it sets both marks");

addEvent(frame(22, { type: "user_message", text: "two" }));
check(rendered.length === 2 && global.streamHighOffset === 22,
  "the next record advances the watermark");
check(global.oldestOffset === 10,
  "while the OLDEST mark stays put: it is what the paging walk asks from");

// the reconnect: the same window is replayed from its start
const afterLive = rendered.length;
addEvent(frame(10, { type: "user_message", text: "one" }));
addEvent(frame(22, { type: "user_message", text: "two" }));
check(rendered.length === afterLive,
  "a replayed record at or below the watermark is not painted twice");
check(global.streamHighOffset === 22, "and the watermark does not move for it");
check(global.oldestOffset === 10, "nor does the oldest mark");

// the replay continues past what this window has seen: the new tail lands
addEvent(frame(31, { type: "final", status: "ok", summary: "done" }));
check(rendered.length === afterLive + 1 && global.streamHighOffset === 31,
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
check(rendered.length === afterLive + 2 && global.streamHighOffset === 35,
  "a live durable frame is painted and moves the watermark onto its own record");

// a transient delta never reaches the log: no offset, never replayed, and it
// must not be deduped or move the watermark
addEvent({ type: "text_delta", text: "hi" });
check(rendered.length === afterLive + 3 && global.streamHighOffset === 35,
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
check(global.streamHighOffset === 35,
  "and the watermark is untouched by the walk (it must not become the paging head)");
check(global.oldestOffset === 2, "while the oldest mark follows the walk, as it must");
global.pageSink = null;

// a page below the watermark does not blind the next live record either
addEvent(frame(44, { type: "final", status: "ok", summary: "next" }));
check(rendered.length === afterLive + 5 && global.streamHighOffset === 44,
  "the next live record is still painted after a page-back");

// ---- 5. a fresh pane starts from scratch ----
clearStream();
check(global.streamHighOffset === null && global.oldestOffset === null &&
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
// who had scrolled up along with it)
check(global.catchUp === true, "the 'history' frame opens the catch-up");
const pinsBefore = pins.length;
addEvent(frame(50, { type: "user_message", text: "owed" }));
addEvent(frame(61, { type: "final", status: "ok", summary: "owed" }));
check(rendered.length === beforeNotice + 2 && pins.length === pinsBefore,
  "its records are painted without moving the view");
check(global.catchUp === true, "and the block is still open: only the server closes it");
addEvent({ type: "replayed", count: 2 });
check(global.catchUp === false, "the 'replayed' frame closes the catch-up");
check(pins.length === pinsBefore + 1 && pins[pins.length - 1] === 1000,
  "and the view moves exactly once, at the end, onto the tail");
addEvent({ type: "replayed", count: 0 });
check(pins.length === pinsBefore + 1, "a close with nothing open moves nothing");

// ---- 8. an offset the log cannot continue from restarts the pane ----
// (the .clc was replaced under this window: appending the served window would
// leave two transcripts on one screen)
const beforeResync = rendered.length;
addEvent(frame(72, { type: "user_message", text: "second transcript" }));
check(rendered.length === beforeResync + 1, "the served window lands...");
addEvent({ type: "resync" });
check(rendered.length === 0 && global.streamHighOffset === null &&
  global.oldestOffset === null,
  "...and 'resync' starts it over instead of leaving two on one screen");

summary("replay-dedupe");
