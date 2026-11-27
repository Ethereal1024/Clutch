"use strict";

// The order of the transcript after a tab comes back from the DOM cache.
//
// Reported against a reopened .clc (fix-train): the run's closing answer read as
// if it had been written BEFORE the steps that produced it ("the conclusion is
// rendered ahead of the work"), and the panel then ended on tool rows and a raw
// `<edit_file>` block — so the session looked like it had no closing answer at
// all. Nothing was wrong with the log: its records are monotonic in offset (the
// store's own byte positions), and the same window read back through /api/log is
// in order. The pane reordered them.
//
// The mechanism: saveDomCache photographs a RUNNING transcript and carries the
// live pointers with the nodes (lastTextEl / lastTextContent / textSealed), so a
// restored tab can finish the block it was left on instead of opening a second
// copy under it. Those pointers name a block in the MIDDLE of the cached page —
// the last one the run had typed into — and dropOrphanLive (project.ts
// paintCachedView) seals it right after the restore: the deltas it was waiting
// for died with the tab that went away. Then the catch-up stream replays every
// record the tab missed, and the assistant_message branch used that pointer as
// its insertion anchor unconditionally:
//
//   if (live) eventsEl.insertBefore(wrap, live);
//
// which is right only while the block is still being fed (a step below the
// record, streaming now). A SEALED block is a finished row: a record that is
// newer than it went ABOVE it, and the log's order inverted from there on — the
// closing answer above the steps, and the run's `final` (whose summary repeats
// that answer) unable to find its own block, so it painted a fresh one.
//
// Run: node tests/render-order-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource, stateStub, runnableSnippet, installRecordLedger } = require("./harness.js");

const { fnBody } = slicer(uiSource());
// The source contract below is about one branch of one module, and `final` is a
// branch name several modules use: read THIS file rather than slicing the bundle.
const streamEvents = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "renderer", "stream-events.ts"), "utf8");

// ---- a DOM, just enough of one ------------------------------------------------
//
// The branch under test reads exactly five things off a node: childNodes (insert),
// parentNode/remove, isConnected (is the pointer's block still on the page?),
// querySelector(".body") (where a block's text lands) and className. `_root`
// marks the pane, so isConnected answers the way the browser would: a detached
// block is not a block the render state may trust.
function makeEl(tag) {
  const kids = [];
  const node = { nodeType: 1, tagName: String(tag).toUpperCase(), childNodes: kids, children: kids, parentNode: null, dataset: {}, style: {}, innerHTML: "", _class: "" };
  Object.defineProperty(node, "className", {
    get: () => node._class,
    set: (v) => { node._class = String(v); },
  });
  Object.defineProperty(node, "isConnected", {
    get: () => { let n = node; while (n) { if (n._root) return true; n = n.parentNode; } return false; },
  });
  node.appendChild = (child) => { detach(child); child.parentNode = node; kids.push(child); return child; };
  node.insertBefore = (child, ref) => {
    if (!ref) return node.appendChild(child);
    const at = kids.indexOf(ref);
    if (at < 0) return node.appendChild(child);
    detach(child);
    child.parentNode = node;
    kids.splice(at, 0, child);
    return child;
  };
  node.remove = () => detach(node);
  Object.defineProperty(node, "lastElementChild", {
    get: () => (kids.length ? kids[kids.length - 1] : null),
  });
  node.querySelector = (sel) => {
    const name = String(sel).replace(/^\./, "");
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (String(c.className).split(/\s+/).includes(name)) return c;
        const deeper = walk(c);
        if (deeper) return deeper;
      }
      return null;
    };
    return walk(node);
  };
  node.querySelectorAll = () => [];
  node.matches = () => false;
  node.classList = { contains: () => false, add() {}, remove() {}, toggle() { return false; } };
  return node;
}

function detach(child) {
  if (!child || !child.parentNode) return;
  const at = child.parentNode.childNodes.indexOf(child);
  if (at >= 0) child.parentNode.childNodes.splice(at, 1);
  child.parentNode = null;
}

// ---- the real render path, on stubs for everything that is not order ----------
//
// installRecordLedger gives the closed-block ledger (awaiting/awaitRecord/unawait/
// awaitingFor/completeRecord) and stream-text.ts paintTextBlock as the page runs
// them, so "the record completed ITS OWN block" is the shipping behaviour and not
// a stub of it. Only the pane's chrome is faked: markdown, highlighting, math,
// the completion divider.
installRecordLedger();

let blocks = [];   // every agent block the path opened
let dividers = []; // every completion divider, in the order it landed
let completions = 0;

global.state = stateStub();
global.pageSink = null;
global.catchUp = false;
global.stream = { classList: { contains: () => false } };
global.renderMarkdown = (t) => "<p>" + t + "</p>";
global.highlightCode = () => {};
global.typesetMath = () => {};
global.autoScroll = () => {};
global.appendThinkingRow = () => {};
global.pendingPerm = null;
global.closePerm = () => {};
global.forgetAnsweredPerm = () => {};
global.settleAllCountdowns = () => {};
// the call-row registry (js/tool-render.ts): rows here are fake nodes, so nothing
// on the page can be claimed abandoned (tool-render.ts)
global.markAbortedCalls = () => {};
global.noteCallRow = () => {};
global.settleCallRow = () => {};
global.clearStreamPreviews = () => {};
global.clearRetryNote = () => {};
global.refreshTree = () => {};
global.autoFoldTurn = () => {};
global.refreshRollbackAnchors = () => {};
global.discardLivePartial = () => {};
global.setRetryNote = () => {};
global.noteToolStarted = () => {};
global.createAgentTextBlock = () => {
  const wrap = makeEl("div");
  wrap.className = "event text";
  const body = makeEl("div");
  body.className = "body";
  wrap.appendChild(body);
  blocks.push(wrap);
  return wrap;
};
global.appendCompletion = (status, text) => {
  completions++;
  const el = makeEl("div");
  el.className = "event completion";
  el.dataset.status = String(status);
  el._text = String(text || "");
  eventsEl.appendChild(el); // render-events.ts appendCompletion appends to the pane
  dividers.push(el);
};

// the branch under test, verbatim
(0, eval)(runnableSnippet(fnBody("rememberRecord")));
(0, eval)(runnableSnippet(fnBody("applyStreamEvent")));

// ---- the pane a restored tab comes back to -----------------------------------
//
// What saveDomCache photographed: a task row, the block the run had typed into
// ("Now let me run the training again:", sealed by dropOrphanLive on the way
// back), and the tool rows of that step. Everything above it in the real pane is
// earlier history none of this test's records touch.
let eventsEl = null;

function restoredPane() {
  eventsEl = makeEl("div");
  eventsEl._root = true; // the pane: nodes under it are on the page
  global.eventsEl = eventsEl;
  const task = makeEl("div");
  task.className = "event user";
  const cut = makeEl("div"); // the block the pane was left on, now sealed
  cut.className = "event text";
  const cutBody = makeEl("div");
  cutBody.className = "body";
  cut.appendChild(cutBody);
  cutBody.innerHTML = "<p>Now let me run the training again:</p>";
  const call = makeEl("div");
  call.className = "event tool stream";
  eventsEl.appendChild(task);
  eventsEl.appendChild(cut);
  eventsEl.appendChild(call);
  blocks = [cut]; // the cached page's only agent block
  global.state.lastTextEl = cut;
  global.state.lastTextContent = "Now let me run the training again:";
  global.state.textSealed = true; // dropOrphanLive closed it: no delta continues it
  global.state.lastRecordEl = null;
  global.state.lastRecordText = "";
  return { task, cut, call };
}

const ANSWER =
  "The GRU training converged (step loss0.00010 per-frame), but closed-loop is worse " +
  "than the memoryless screen. The culprit is clear: the fire head is randomly " +
  "initialized and never trained.\n\nLet me fix this by defaulting `with_fire=False`.";

(async () => {
  // ---- 1) a record newer than a SEALED block must not go above it ----
  //
  // This is the reported inversion. The record is the step AFTER the block the
  // pane was left on, and its text does not extend that block's (a different
  // step), so neither the in-place branch (prefix match) nor the owed-ledger
  // branch can take it: it needs a block of its own, and the only question is
  // where that block goes.
  {
    const { cut, call } = restoredPane();
    const before = eventsEl.childNodes.length;
    const handled = applyStreamEvent({ type: "assistant_message", content: ANSWER, reasoning: "" });
    check(handled === true, "1a) the durable assistant_message is handled by the stream layer");
    check(eventsEl.childNodes.length === before + 1, "1b) it opened exactly one block");
    const at = eventsEl.childNodes.indexOf(blocks[blocks.length - 1]);
    check(at > eventsEl.childNodes.indexOf(cut) && at > eventsEl.childNodes.indexOf(call),
      `1c) the record's block lands BELOW the sealed block and its tool rows (index ${at} of ${eventsEl.childNodes.length - 1}), not above them`);
    check(eventsEl.childNodes[eventsEl.childNodes.length - 1] === blocks[blocks.length - 1],
      "1d) …which on a catch-up (nothing streaming below it) is the tail: the page reads in the log's order");
    const painted = blocks[blocks.length - 1].querySelector(".body").innerHTML;
    check(painted.includes("The GRU training converged") && painted.includes("with_fire=False"),
      "1e) and the block holds the whole record text (markdown pass ran on it)");
  }

  // ---- 2) a block still being FED is still the anchor ----
  //
  // The one case insertBefore exists for: the feeds into the sink are unordered by
  // a step, so a record can land while a LATER step is streaming below it. That
  // block is not a finished row — its position is the step that owns it, and the
  // record belongs above.
  {
    restoredPane();
    global.state.textSealed = false; // still taking deltas of a step that began after this record
    const live = global.state.lastTextEl;
    applyStreamEvent({ type: "assistant_message", content: ANSWER, reasoning: "" });
    const at = eventsEl.childNodes.indexOf(blocks[blocks.length - 1]);
    check(at >= 0 && at < eventsEl.childNodes.indexOf(live),
      "2a) with the block still streaming, the record's block goes above it (the log order it was written in)");
    check(!global.state.textSealed && global.state.lastTextEl === live,
      "2b) and the streaming pointer stays with the step that is speaking");
  }

  // ---- 3) the run's final completes the record's block, it does not paint a copy ----
  //
  // run-state.ts foldRun closes a completed turn by writing its last
  // assistant_message as the summary, so on a replay the final repeats text the
  // record already painted. One answer, one block.
  {
    restoredPane();
    applyStreamEvent({ type: "assistant_message", content: ANSWER, reasoning: "" });
    const answer = blocks[blocks.length - 1];
    const count = blocks.length;
    completions = 0;
    applyStreamEvent({ type: "final", status: "completed", summary: ANSWER });
    check(blocks.length === count, "3a) the final that repeats the record's text paints NO second block");
    check(global.state.lastTextEl === answer && global.state.lastTextContent === ANSWER,
      "3b) it adopts the record's block, so a straggling delta cannot open one under it");
    check(completions === 1 && dividers[dividers.length - 1].parentNode === eventsEl,
      "3c) the completion divider lands once, in the pane");
    check(eventsEl.childNodes.indexOf(dividers[dividers.length - 1]) > eventsEl.childNodes.indexOf(answer),
      "3d) …below the answer it closes");
  }

  // ---- 4) a final whose text is NOT the record's: one block, at the tail ----
  //
  // fix-train ended exactly here: the model wrote its tool call into the TEXT
  // channel (`<edit_file><parameter name="path">…`), so the run's summary is that
  // raw string and no block on the page starts with it. It is not the record's
  // answer, so it may not overwrite one — but there is exactly one of it, and it
  // goes last.
  {
    restoredPane();
    applyStreamEvent({ type: "assistant_message", content: ANSWER, reasoning: "" });
    const count = blocks.length;
    const xml = '<edit_file>\n<parameter name="path">/root/x/recurrent_obs.py</parameter>\n</edit_file>';
    applyStreamEvent({ type: "final", status: "completed", summary: xml });
    check(blocks.length === count + 1, "4a) a final carrying text no block starts with draws one block (not zero, not two)");
    const tail = eventsEl.childNodes[eventsEl.childNodes.length - 2];
    check(tail === blocks[blocks.length - 1], "4b) it lands above the divider, at the tail");
    check(eventsEl.childNodes.filter((n) => String(n.className).includes("event text")).length ===
      blocks.length, "4c) the cached block, the record's block and the final's: no copy of the answer");
  }

  // ---- 5) source contract: the seal and the pane's tail are part of the anchor test ----
  const branch = streamEvents.slice(streamEvents.indexOf('if (ev.type === "assistant_message")'), streamEvents.indexOf('if (ev.type === "final")'));
  const code = branch.replace(/\/\/[^\n]*/g, ""); // the prose above names the very call it warns about
  check(/const anchor = live && \(!state\.textSealed \|\| live === eventsEl\.lastElementChild\)/.test(code),
    "5a) only a block that is being fed, or one that is still the pane's last row, is an insertion anchor");
  check(/if \(anchor\) eventsEl\.insertBefore\(wrap, anchor\)/.test(code) &&
    /else \(pageSink \|\| eventsEl\)\.appendChild\(wrap\)/.test(code),
    "5b) everything else appends: a closed block the page has painted past cannot be a position");

  summary("render-order-test");
})();
