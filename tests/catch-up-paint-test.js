"use strict";

// A catch-up paints ONCE (ui/src/renderer/stream-events.ts `addEvent`).
//
// Over a tunnel the block a reconnecting stream is owed arrives as one SSE frame
// per record, each in its own task: anything that renders per frame (or per
// timer) shows the transcript assembling itself behind the load card — the
// device report "远端的事件流在标签页中加载是爆发性的，一次性闪过很多消息，最后才停在
// 尾部消息". The block is DATA until the server's `replayed` frame closes it: the
// rows are queued, and painted in the one task that closes the block, so the pane
// gets one layout and one scroll at the end — never a cascade of them.
//
// The other half is the invariant this file exists to keep: the queue must never
// outlive the block. `addEvent` advances the watermark (streamHighOffset) when a
// record ARRIVES, so a queued row that is dropped is a row the next reconnect
// will never be asked for again — a permanent hole in the transcript. Every path
// that ends a catch-up therefore goes through settleCatchUp() — it paints what
// the block queued AND closes the bracket: `replayed`, a new `history`, a
// closed/replaced stream, a tab switch saving its cache, and clearStream.
//
// The real modules run here (stream-view.ts and stream-events.ts are executed as
// classic scripts in this context, the way the page ran them): the batching, the
// catch-up bracket and autoScroll are the code that ships, not copies of it.
//
// Run: node tests/catch-up-paint-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, runnableSnippet, stateStub } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const renderer = (name) => read("ui/src/renderer/" + name + ".ts");

// ---- a node with the three things the paint path writes through ----
function shell() {
  const set = new Set();
  const kids = [];
  return {
    kids,
    get children() { return kids; },
    get innerHTML() { return ""; },
    set innerHTML(v) { kids.length = 0; },
    appendChild(c) { kids.push(c); return c; },
    replaceChildren() { kids.length = 0; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: {
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
      contains: (c) => set.has(c),
    },
    addEventListener() {},
    // the pane announces its own moments through events (auto-fold listens for them
    // in the page; this stub has no listeners, so announcing is all a record does)
    dispatchEvent() {},
    removeEventListener() {},
    matches() { return false; },
    getAttribute() { return null; },
    style: {},
  };
}

// ---- the stub environment (only what addEvent's DOM path touches) ----
let scrollWrites = [];
let markedTasks = [];   // the task id at each scroll, for the "one task" claim
let task = 0;           // advanced by the driver between "network" frames
let olderPill = -1;
let appendedAt = [];    // task id at each row append

function fakeRow() {
  return {
    dataset: {},
    matches() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    style: {},
    isConnected: true,
  };
}

const eventsEl = shell();
const stream = shell();
stream.scrollTop = 0;
stream.scrollHeight = 4000;
stream.clientHeight = 600;
Object.defineProperty(stream, "scrollTop", {
  get: () => stream._top || 0,
  set: (v) => { stream._top = v; scrollWrites.push(v); markedTasks.push(task); },
});

global.eventsEl = eventsEl;
global.stream = stream;
global.state = stateStub();
global.state.apiBase = "http://host/api";  // setStatus's run-button guard
global.pageSink = null;
global.currentProject = "x.clc";
global.els = { status: shell(), run: shell(), mode: shell() };
global.$ = () => shell();
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
global.performance = { now: () => 0 };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.document = {
  addEventListener() {},
  createElement: () => fakeRow(),
  getElementById: () => shell(),
};
// stream-text.ts: the two flush passes a non-text record ends
global.foldHoldsScroll = () => false;
global.reducedMotion = () => true;
global.flushTextRender = () => {};
global.flushThinkingRender = () => {};
global.highlightCode = () => {};
// the math pass, counted: an answer that arrives as a RECORD (no delta streamed
// it) is typeset by stream-events.ts itself, and the paging sink is not (the
// history page typesets its own blocks once they are in the pane)
let mathTypeset = [];
global.typesetMath = (el) => { mathTypeset.push(el); };
// stream-events.ts's other imports: none of them is what this runner measures
global.autoFoldTurn = () => {};
global.closePerm = () => {};
global.forgetAnsweredPerm = () => {};
global.pendingPerm = () => null;
// the send outbox (js/render-events.ts noteUserMessage) is the composer's
// concern: this runner has no composer and no send in flight
global.noteUserMessage = () => {};
global.clearStream = () => {
  // project.ts clearStream, reduced to the parts this context can see: the pane,
  // the queue and the bracket go together (its source is pinned in §6)
  eventsEl.kids.length = 0;
  state.owedRecords.length = 0;
  endCatchUp();
};
global.setOlderPill = (n) => { olderPill = n; };
global.appendCompletion = () => {};
global.refreshRollbackAnchors = () => {};
global.refreshTree = () => {};
global.renderMarkdown = (t) => "<p>" + t + "</p>";
global.SSE_RUN_LOST = "the session running this task went away";
global.appendThinkingRow = () => {};
global.buildThinkingBlock = () => fakeRow();
// an agent text block with a real `.body`: the record path below writes the
// rendered markdown into it (stream-events.ts block of its own)
global.createAgentTextBlock = () => {
  const row = fakeRow();
  const body = shell();
  row.querySelector = (sel) => (sel === ".body" ? body : null);
  row.body = body;
  return row;
};
global.paintTextBlock = () => {};
global.scheduleTextRender = () => {};
global.scheduleThinkingRender = () => {};
global.addToolCallRow = () => fakeRow();
global.appendResultRow = () => {};
global.argsButton = () => fakeRow();
global.makeToolRowBase = () => fakeRow();
global.previewText = () => "";
global.toolGroupFor = () => null;
global.uiOf = () => ({});
global.uiOfResult = () => ({});
global.renderEvent = (ev) => { appendedAt.push({ task, type: ev && ev.type }); return fakeRow(); };

// ---- load the REAL modules ----
require("vm").runInThisContext(runnableSnippet(renderer("stream-view")), { filename: "stream-view.ts" });
require("vm").runInThisContext(runnableSnippet(renderer("stream-events")), { filename: "stream-events.ts" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// one SSE frame off a tunnel: its own task, the timer queue free to run between
const frame = async (ev) => { addEvent(ev); task++; await sleep(6); };
const rec = (offset) => ({ offset, event: { type: "user_message", text: "task " + offset } });

async function main() {
  // ---- 1) the block is data until its closing frame ----
  scrollWrites = []; markedTasks = []; appendedAt = []; olderPill = -1;
  await frame({ type: "history", older: 7 });
  check(olderPill === 7, "the `history` frame restores the on-disk older count");
  for (let i = 1; i <= 12; i++) await frame(rec(i * 100));
  await sleep(120); // well past any batch timer: the block is still open
  check(eventsEl.kids.length === 0,
    "no record of an OPEN catch-up is painted (12 frames in, the pane is untouched)");
  check(scrollWrites.length === 0, "...and the view has not moved");

  // ---- 2) its closing frame paints the whole block, once, in one task ----
  const before = task;
  await frame({ type: "replayed", count: 12 });
  check(eventsEl.kids.length === 12, "`replayed` paints every record of the block");
  check(appendedAt.every((a) => a.task === before),
    "all 12 rows land in ONE task (one layout, one paint)");
  check(appendedAt.map((a) => a.type).join(",") === Array(12).fill("user_message").join(","),
    "...in the log's own order");
  check(scrollWrites.length === 1, "the view moves exactly once, at the block's end");
  check(scrollWrites[0] === stream.scrollHeight, "...to the block's tail");

  // ---- 3) the live tail after it is NOT held: a frame is a paint ----
  const liveTask = task;
  await frame(rec(1300));
  check(eventsEl.kids.length === 13 && appendedAt[12].task === liveTask,
    "a live record after the block paints in its own frame, with no batching");

  // ---- 4) every ending settles the block: paint it, then close it ----
  // a stream replaced mid-block: connectSSE/closeSSE call this before they close.
  // It paints what the block queued AND closes the bracket, because the frame
  // that would have closed it (`replayed`) died with the stream — and a bracket
  // left open holds every record that follows it too.
  appendedAt = [];
  await frame({ type: "history", older: 3 });
  for (let i = 14; i <= 18; i++) await frame({ offset: i * 100, event: { type: "user_message", text: "t" + i } });
  check(eventsEl.kids.length === 13, "a second catch-up holds its rows too");
  const drainTask = task;
  let moves = scrollWrites.length;
  settleCatchUp();
  check(eventsEl.kids.length === 18, "settleCatchUp() paints what the block had queued");
  check(appendedAt.every((a) => a.task === drainTask), "...in one task too");
  check(scrollWrites.length === moves + 1, "...and the view moves once for the block it closed");

  // a second `history` (a retried stream) settles the earlier block first: the
  // rows queued for the stream that went away are the transcript's prefix
  appendedAt = [];
  await frame({ type: "history", older: 1 });
  await frame(rec(2000));
  await frame(rec(2100));
  check(eventsEl.kids.length === 18, "the retried block is held");
  appendedAt = [];
  const drainAt = task;
  moves = scrollWrites.length;
  await frame({ type: "history", older: 1 });
  check(eventsEl.kids.length === 20, "a new `history` settles the block before opening its own");
  check(appendedAt.length === 2 && appendedAt.every((a) => a.task === drainAt),
    "...painted as it was, in the one task that settles it");
  check(scrollWrites.length === moves + 1, "...with the one move of the block it closed");
  await frame(rec(2200));
  check(eventsEl.kids.length === 20, "the new block's own records are held");
  const closeAt = task;
  await frame({ type: "replayed", count: 1 });
  check(eventsEl.kids.length === 21 && appendedAt[2] && appendedAt[2].task === closeAt,
    "...and the new block closes on its own record, in a later task");

  // ---- 5) clearStream ends the bracket: no row waits for a frame never coming ----
  const movesBeforeClear = scrollWrites.length;
  clearStream();
  check(eventsEl.kids.length === 0, "clearStream empties the pane");
  check(scrollWrites.length === movesBeforeClear, "...and closes the bracket it emptied, with no stray move");
  await frame(rec(3000));
  check(eventsEl.kids.length === 1,
    "a record after clearStream paints immediately (the catch-up is over)");
  check(scrollWrites.length === movesBeforeClear + 1, "and the view follows it (one move)");

  // ---- 6) the paths that end a catch-up outside this file settle it ----
  // (source contracts: these modules cannot be executed without the whole app)
  const sse = renderer("sse-stream");
  // the ONE function that ends a socket settles the block first, so nothing that
  // closes a stream — a new adoption, a heal, a dropped base, the welcome page —
  // can strand a queued row: every one of them goes through closeSocket
  const socket = sse.slice(sse.indexOf("function closeSocket("), sse.indexOf("function openStream("));
  check(/settleCatchUp\(\)/.test(socket),
    "the one way a socket ends settles the block it was still delivering (a queued row is never stranded)");
  check((sse.match(/es\.close\(\)/g) || []).length === 1 &&
    sse.indexOf("es.close()") > sse.indexOf("function closeSocket("),
    "and it is the only close the stream has: the three doors cannot each remember their own teardown");
  check(/onerror[\s\S]{0,600}settleCatchUp\(\)/.test(sse),
    "es.onerror settles it: the browser retries the SAME ?since=, so a queued row would be dropped forever");
  const project = renderer("project");
  const savePoint = project.indexOf("saveDomCache(prev.id)");
  check(savePoint > 0 && project.lastIndexOf("settleCatchUp()", savePoint) > 0,
    "activateTab settles the block before it caches the tab it leaves (the cache carries the watermark)");
  const clearAt = project.indexOf("export function clearStream");
  const clearSrc = clearAt < 0 ? "" : project.slice(clearAt, project.indexOf("// ---- scroll-up paging", clearAt));
  check(/state\.owedRecords\.length = 0/.test(clearSrc) && /endCatchUp\(\)/.test(clearSrc),
    "clearStream drops the queue and closes the bracket with the pane it empties");

  // ---- 7) an answer that arrives as a RECORD keeps its math ----
  // The reported bug: the tail of a restored tab showed bare `$\omega$` / `$$…$$`.
  // A record painted as a block of its own never streamed, so no delta and no
  // completing record owes it a math pass — stream-events.ts has to run it. (The
  // markdown pass was never the problem: renderMarkdown protects every $…$ pair.)
  const answer = "the direction is $\\omega$ bucketed, so $$\\varepsilon \\approx r\\,(\\omega-\\hat\\omega)$$";
  mathTypeset = [];
  const beforeRecord = eventsEl.kids.length;
  await frame({ offset: 4000, event: { type: "assistant_message", content: answer } });
  check(eventsEl.kids.length === beforeRecord + 1, "a record with no live block paints a block of its own");
  check(mathTypeset.length === 1,
    "…and that block is TYPESET: its record is final, so nothing else would ever run the math pass");
  check(mathTypeset[0] && mathTypeset[0].body, "…on the block it just painted");

  // the history page's sink is the one exception: project.ts (loadOlder) typesets
  // the blocks once it has moved them into the pane, so a math pass here would be
  // a second one over the same rows
  mathTypeset = [];
  global.pageSink = shell();
  await frame({ offset: 4100, event: { type: "assistant_message", content: answer } });
  check(mathTypeset.length === 0, "a paged history row is not typeset into the sink (project.ts does it after insertion)");
  global.pageSink = null;
  check(/if \(!pageSink\) typesetMath\(wrap\)/.test(renderer("stream-events")),
    "the record path typesets only outside a paging sink");

  summary("catch-up-paint");
}

main();
