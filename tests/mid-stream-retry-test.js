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
const { check, summary, slicer, uiSource } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(src);

// ---- stub environment (only what the discarding path touches) ----
let cancelledRaf = [];
let appended = [];
global.cancelAnimationFrame = (id) => { cancelledRaf.push(id); };
global.autoScroll = () => {};
global.pageSink = null;
global.eventsEl = { appendChild: (c) => { appended.push(c); } };
global.document = { createElement: (tag) => fakeNode(tag) };
global.textRenderRaf = 0;
global.lastTextEl = null;
global.lastTextContent = "";
global.thinkingEl = null;
global.thinkingContent = "";
global.retryNoteEl = null;
global.streamRows = {};

function fakeNode(tag) {
  return {
    tag,
    className: "",
    textContent: "",
    children: [],
    removed: false,
    appendChild(c) { this.children.push(c); return c; },
    remove() { this.removed = true; },
  };
}

// ---- load the real code ----
(0, eval)(fnBody("clearStreamPreviews"));
(0, eval)(fnBody("discardLivePartial"));
(0, eval)(fnBody("setRetryNote"));
(0, eval)(fnBody("clearRetryNote"));

// ---- 1) discardLivePartial: every live block of the dead attempt goes ----
const textNode = fakeNode("div");
const thinkNode = fakeNode("div");
const rowA = fakeNode("div");
const rowB = fakeNode("div");
global.textRenderRaf = 7;
global.lastTextEl = textNode;
global.lastTextContent = "half an ans";
global.thinkingEl = thinkNode;
global.thinkingContent = "weighing";
global.streamRows = { a: { row: rowA }, b: { row: rowB } };

discardLivePartial();

check(textNode.removed, "the partial text block is removed from the page");
check(global.lastTextEl === null && global.lastTextContent === "", "the live text buffer is reset");
check(thinkNode.removed, "the streaming reasoning block is removed too");
check(global.thinkingEl === null && global.thinkingContent === "", "the reasoning buffer is reset");
check(rowA.removed && rowB.removed, "half-streamed tool-call rows go as well");
check(Object.keys(global.streamRows).length === 0, "no streamed tool row is left behind");
check(cancelledRaf.indexOf(7) >= 0 && global.textRenderRaf === 0, "a queued text render is cancelled");

// ---- 2) the retry notice still renders after a discard ----
setRetryNote({ attempt: 1, max_retries: 3, message: "Connection interrupted. - retrying (1/3)" });
check(appended.length === 1, "the chip is appended to the event list");
const chip = appended[0];
check(chip.children.length === 1 && chip.children[0].textContent.includes("retrying (1/3)"),
  "the chip shows the retry message from the client");
check(chip.children[0].textContent.charAt(0) === "\u26a0", "the chip is marked as a warning");
clearRetryNote();
check(chip.removed && global.retryNoteEl === null, "the chip is dropped when new tokens arrive");

// ---- 3) wiring: the llm_retry branch asks for the drop BEFORE it shows the chip ----
const apply = fnBody("applyStreamEvent");
const at = apply.indexOf("if (ev.type === \"llm_retry\")");
check(at >= 0, "applyStreamEvent still has an llm_retry branch");
const next = apply.indexOf("if (ev.type ===", at + 5);
const branch = apply.slice(at, next < 0 ? apply.length : next);
check(branch.includes("if (ev.discard) discardLivePartial();"),
  "the branch drops the live partial when the notice carries discard");
check(branch.indexOf("discardLivePartial()") < branch.indexOf("setRetryNote(ev)"),
  "the stale blocks are gone before the retry chip appears");
check(branch.indexOf("setRetryNote(ev)") >= 0, "the chip is still shown for a plain notice");

summary("mid-stream-retry-test", "discard semantics hold on the UI side");
