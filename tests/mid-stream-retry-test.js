"use strict";

// Mid-stream retry, UI half. The client retries a whole request when an attempt
// dies after streaming part of its answer; the retry notice that comes out of
// the stream carries discard=true, which tells the view that EVERYTHING the dead
// attempt drew is stale. If the view keeps it, the retried answer lands below a
// copy of the first attempt half-sentence.
//
// Like stream-render-test.js this extracts the REAL functions from the renderer and
// drives them against stubs, so a silent edit that drops the discard handling
// fails here instead of showing duplicated text to the user.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource, stateStub, runnableSnippet, installRecordLedger } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(src);

// ---- stub environment (only what the discarding path touches) ----
let cancelledRaf = [];
let appended = [];
// the shared state leaf (ui/src/renderer/state.ts), at its declared
// defaults: what used to be module-level globals is a field of this object
global.state = stateStub();
global.cancelAnimationFrame = (id) => { cancelledRaf.push(id); };
global.autoScroll = () => {};
global.pageSink = null;
global.eventsEl = { appendChild: (c) => { appended.push(c); } };
global.document = { createElement: (tag) => fakeNode(tag) };
global.state.textRenderRaf = 0;
global.state.thinkingRenderRaf = 0;
global.state.lastTextEl = null;
global.state.lastTextContent = "";
global.state.thinkingEl = null;
global.state.thinkingContent = "";
global.state.retryNoteEl = null;
global.streamRows = {};

// the text painter (stream-text.ts): dropOrphanLive closes a block with a real
// render pass (flushTextRender), so the block shows every character it is closed
// with — the stubs below are everything that pass touches
global.renderMarkdown = (t) => "<p>" + t + "</p>";
global.highlightCode = () => {};
global.typesetMath = () => {};
global.stream = { classList: { contains: () => false }, scrollHeight: 1000, scrollTop: 0 };

function fakeNode(tag) {
  const body = { innerHTML: "" };
  const node = {
    tag,
    className: "",
    textContent: "",
    children: [],
    removed: false,
    // a node on the page: dropOrphanLive keeps only what is still connected
    isConnected: true,
    _body: body,
    querySelector(sel) { return sel === ".body" ? body : null; },
    insertBefore(c) { node.children.push(c); return c; },
    appendChild(c) { c.parent = node; node.children.push(c); return c; },
    remove() {
      node.removed = true;
      if (node.parent) {
        const i = node.parent.children.indexOf(node);
        if (i >= 0) node.parent.children.splice(i, 1);
      }
    },
  };
  return node;
}

// ---- load the real code ----
(0, eval)(fnBody("clearStreamPreviews"));
(0, eval)(fnBody("dropScaffold"));
(0, eval)(fnBody("discardLivePartial"));
(0, eval)(fnBody("setRetryNote"));
(0, eval)(fnBody("clearRetryNote"));
// the text painter: flushTextRender is the pass dropOrphanLive closes a block with
const streamText = fs.readFileSync(path.join(ROOT, "ui", "src", "renderer", "stream-text.ts"), "utf8");
(0, eval)(runnableSnippet(streamText.slice(streamText.indexOf("export let textRenderLast"), streamText.indexOf("export function flushThinkingRender"))));
installRecordLedger(); // the ledger a cut files the block it closed in

// ---- 1) discardLivePartial: every live block of the dead attempt goes ----
const textNode = fakeNode("div");
const thinkNode = fakeNode("div");
const rowA = fakeNode("div");
const rowB = fakeNode("div");
global.state.textRenderRaf = 7;
global.state.thinkingRenderRaf = 8;
global.state.lastTextEl = textNode;
global.state.lastTextContent = "half an ans";
global.state.thinkingEl = thinkNode;
global.state.thinkingContent = "weighing";
global.streamRows = { a: { row: rowA }, b: { row: rowB } };

discardLivePartial();

check(textNode.removed, "the partial text block is removed from the page");
check(global.state.lastTextEl === null && global.state.lastTextContent === "", "the live text buffer is reset");
check(thinkNode.removed, "the streaming reasoning block is removed too");
check(global.state.thinkingEl === null && global.state.thinkingContent === "", "the reasoning buffer is reset");
check(rowA.removed && rowB.removed, "half-streamed tool-call rows go as well");
check(Object.keys(global.streamRows).length === 0, "no streamed tool row is left behind");
check(cancelledRaf.indexOf(7) >= 0 && global.state.textRenderRaf === 0, "a queued text render is cancelled");
check(cancelledRaf.indexOf(8) >= 0 && global.state.thinkingRenderRaf === 0, "…and the queued reasoning render with it");

// ---- 2) the retry notice still renders after a discard ----
setRetryNote({ attempt: 1, max_retries: 3, message: "Connection interrupted. - retrying (1/3)" });
check(appended.length === 1, "the chip is appended to the event list");
const chip = appended[0];
check(chip.children.length === 1 && chip.children[0].textContent.includes("retrying (1/3)"),
  "the chip shows the retry message from the client");
check(chip.children[0].textContent.charAt(0) === "\u26a0", "the chip is marked as a warning");
clearRetryNote();
check(chip.removed && global.state.retryNoteEl === null, "the chip is dropped when new tokens arrive");

// ---- 3) wiring: the llm_retry branch asks for the drop BEFORE it shows the chip ----
const apply = fnBody("applyStreamEvent");
const at = apply.indexOf("if (ev.type === \"llm_retry\")");
check(at >= 0, "applyStreamEvent still has an llm_retry branch");
const next = apply.indexOf("if (ev.type ===", at + 5);
const branch = apply.slice(at, next < 0 ? apply.length : next);
check(/if \(ev\.discard\) discardLivePartial\(\);/.test(branch),
  "the branch drops the live partial when the notice carries discard — the one path that takes a block off the page");
check(branch.indexOf("discardLivePartial()") < branch.indexOf("setRetryNote(ev)"),
  "the stale blocks are gone before the retry chip appears");
check(branch.indexOf("setRetryNote(ev)") >= 0, "the chip is still shown for a plain notice");
check(!/addHole|openHole|dropHole/.test(apply),
  "and a retry needs no hole bookkeeping: discardLivePartial drops the ledger entry with the block");

// ---- 4) the WINDOW's socket: a reconnect CLOSES the block instead of dropping it ----
//
// The other half of the same failure, with no notice to react to. When the
// window's own SSE socket dies mid-turn, the deltas it missed are never stored,
// so the partial the dead stream drew can never be CONTINUED — deleting it is the
// opening of the answer lost for good. A cut therefore CLOSES the block and files
// it with the record that still owes it (text-seal-test.js pins what that record
// then writes). What must still go is everything no record will ever come back
// for: the frozen reasoning block, the half-streamed call rows, the stale chip.
(0, eval)(fnBody("dropOrphanLive"));

const text2 = fakeNode("div");
const think2 = fakeNode("div");
const rowC = fakeNode("div");
const chip2 = fakeNode("div");
global.state.textRenderRaf = 3;
global.state.thinkingRenderRaf = 4;
global.state.lastTextEl = text2;
global.state.lastTextContent = "half a thought";
global.state.thinkingEl = think2;
global.state.thinkingContent = "weighing it up";
global.streamRows = { c: { row: rowC } };
global.state.retryNoteEl = chip2;
global.state.toolGroupEl = fakeNode("div");
cancelledRaf = [];

dropOrphanLive();

check(!text2.removed && global.state.lastTextEl === text2 && global.state.lastTextContent === "half a thought",
  "a reconnect KEEPS a half-streamed block and keeps the pointer: its deltas are never stored, so the block IS the only copy of that opening");
check(global.state.textSealed === true,
  "…it closes it, so the text after the cut cannot be appended to the half");
check(text2._body.innerHTML === "<p>half a thought</p>",
  "…painted with every character it is closed with, not with the last frame's text");
check(global.awaiting.length === 1 && global.awaiting[0].el === text2 && global.awaiting[0].text === "half a thought",
  "…and filed for the record that owns it, so that record writes THIS block whole");
check(think2.removed && global.state.thinkingEl === null && global.state.thinkingContent === "",
  "…and the frozen reasoning block does go (the 'stuck in thinking' the user saw)");
check(rowC.removed && Object.keys(global.streamRows).length === 0, "…and any half-streamed tool row");
check(chip2.removed && global.state.retryNoteEl === null, "…and the stale retry chip");
check(cancelledRaf.indexOf(3) >= 0 && global.state.textRenderRaf === 0, "…the render it had queued lands now");
check(cancelledRaf.indexOf(4) >= 0 && global.state.thinkingRenderRaf === 0, "…and the reasoning render beside it is cancelled");
check(global.state.toolGroupEl === null, "…and closing the tool group it was drawing into");

// wiring: the reconnect reaches that teardown, and no longer just nulls the refs
const sse = fs.readFileSync(path.join(ROOT, "ui", "src", "renderer", "sse-stream.ts"), "utf8");
const onopen = sse.slice(sse.indexOf("es.onopen = () => {"));
const onopenBody = onopen.slice(0, onopen.indexOf("\n  };"));
check(onopenBody.includes("dropOrphanLive();"),
  "es.onopen closes the block the stream can no longer feed");
check(!/lastTextEl = null|thinkingEl = null/.test(onopenBody),
  "…and does not reset the references alone, which left the frozen nodes behind");

// ---- 5) a reconnect KEEPS what the log already says ----
//
// The other side of the same cut, and the reported loss. A block whose text a
// step's durable assistant_message has taken over (textSealed), or one that
// belongs to a run whose final has landed (runSettled), is not a partial: the
// replay a reconnect starts is filtered at this window's watermark, so the record
// that drew it is never re-delivered and removing the node is permanent. The pane
// then ends at a `completed` divider with the closing prose gone — "git output →
// completed" — while the .clc has held the answer all along.
//
// Such a block owes the log nothing, so nothing is filed for it: its own record
// already wrote it, and the pointer stays with it so the run's final writes into
// THIS block instead of painting the answer a second time.
global.awaiting.length = 0; // section 4 filed its block; these are blocks nothing is owed for
const sealedEl = fakeNode("div");
const think3 = fakeNode("div");
global.state.lastTextEl = sealedEl;
global.state.lastTextContent = "the closing report";
global.state.textSealed = true; // its step's record wrote this text
global.state.runSettled = false;
global.state.thinkingEl = think3;
global.state.retryNoteEl = null;
dropOrphanLive();
check(!sealedEl.removed, "a reconnect keeps a block that holds a durable record's text");
check(global.awaiting.length === 0,
  "…and files nothing: a block its record wrote is owed no text by the log");
check(global.state.lastTextEl === sealedEl && global.state.lastTextContent === "the closing report",
  "…keeping the pointer to it, so the run's final writes into THIS block");
check(global.state.textSealed === true, "…and keeping the seal, so the step's straggling deltas are dropped");
check(think3.removed, "the reasoning block is still a partial and still goes");

const settledEl = fakeNode("div");
global.state.lastTextEl = settledEl;
global.state.lastTextContent = "the closing report";
global.state.textSealed = false;
global.state.runSettled = true; // the run's final already landed
dropOrphanLive();
check(!settledEl.removed && global.state.lastTextEl === settledEl,
  "…and the closing prose of a finished run survives too (runSettled, not the seal, is what keeps it)");
check(global.awaiting.length === 0, "…a finished run owes no record either");

global.state.lastTextEl = null;
global.state.lastTextContent = "";
global.state.textSealed = false;
global.state.runSettled = false;
global.awaiting.length = 0;

summary("mid-stream-retry-test", "discard semantics hold on the UI side");
