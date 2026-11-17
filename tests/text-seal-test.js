"use strict";

// Regression test for the split answer: one assistant turn painted as TWO
// `.event text` blocks ("agent" headers), its closing sentence cut in half.
//
// The two feeds into addEvent() are unordered. The step's deltas come over the
// run's own IPC channel (run-host.ts emit → wc.send("run:event")); the durable
// assistant_message comes from the log's SSE feed (POST /api/log → agent
// broadcast → sse-stream). The record can therefore land BETWEEN two deltas of
// its own step. The old branch dropped the live block's pointer there, so the
// block on screen kept the text up to its last delta and the leftover tail
// opened a second block underneath it — the reported 11-17 15:11 transcript,
// where "……不是代码问题——所以我没替你" and "改 App 的安装目录。" became two
// answers. The .clc held one complete assistant_message the whole time.
//
// The fix: the record is the authoritative copy of its step's text. When it
// arrives with a live block that its content EXTENDS, it adopts the text into
// that block and seals it; deltas still in flight for the step are the text the
// block already says and are dropped. step_start (and a new user_message) open
// the seal again — the seal is per model step, never a mute.
//
// Like the other runners here this one drives the REAL addEvent/applyStreamEvent
// and the real text-render path against stubs, so a silent edit fails it.

const { check, summary, slicer, stateStub, runnableSnippet, uiSource, uiModules } = require("./harness.js");

const src = uiSource(); // the renderer, every module in page-load order
const { fnBody } = slicer(src);
const moduleOf = (name) => (uiModules().find((m) => m.file === name) || {}).code || "";

// ---- stub environment ----
let rafQ = [];
global.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
global.cancelAnimationFrame = (id) => { rafQ[id - 1] = null; };

// a fake element: what createAgentTextBlock/renderTextBlock/eventsEl touch. The
// block's `.body` is a stable object, so a re-render is visible as its innerHTML.
function fakeEl(tag) {
  const body = { innerHTML: "" };
  const node = {
    tag,
    className: "",
    innerHTML: "",
    children: [],
    isConnected: true,
    parent: null,
    _body: body,
    querySelector(sel) { return sel === ".body" ? body : null; },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
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

global.state = stateStub(); // the shared state leaf, at its declared defaults
const eventsEl = fakeEl("div");
global.eventsEl = eventsEl;
global.pageSink = null;
global.document = { createElement: fakeEl };
global.stream = { classList: { contains: () => false }, scrollHeight: 1000, scrollTop: 0 };
global.renderMarkdown = (t) => "<p>" + t + "</p>";
global.highlightCode = () => {};
global.typesetMath = () => {};
global.autoScroll = () => {};
global.renderEvent = () => null; // nothing outside the streaming layer is under test
global.clearRetryNote = undefined; // the real one, loaded below
global.flushThinkingRender = () => {}; // the reasoning path is not under test here
global.flushThinkingRender = () => {}; // the reasoning path is not under test here
// everything the branches this runner never enters would reach for
global.pageSink = null;
global.setRetryNote = () => {};
global.closePerm = () => {};
global.forgetAnsweredPerm = () => {};
global.pendingPerm = null;
global.appendCompletion = () => {};
global.refreshTree = () => {};
global.autoFoldTurn = () => {};
global.refreshRollbackAnchors = () => {};
global.appendThinkingRow = () => {};
global.addToolCallRow = () => {};
global.argsButton = () => null;
global.uiOf = () => ({});
global.handleToolCallDelta = () => {};
global.uiOfResult = () => ({});
global.appendResultRow = () => {};
global.clearStreamPreviews = () => {};
global.toolCalls = {};
global.toolCallGroups = new Map();
global.streamRows = {};
global.announceRunLost = () => {};
global.setOlderPill = () => {};
global.beginCatchUp = () => {};
global.endCatchUp = () => {};
global.clearStream = () => {};

// ---- load the real code ----
// the coalesced text render (stream-text.ts): renderTextBlock is what paints the
// block, so the assertion is about the body a reader actually sees
const fs = require("fs");
const path = require("path");
const streamText = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "renderer", "stream-text.ts"), "utf8");
const textSlice = slicer(streamText);
(0, eval)(runnableSnippet(textSlice.fnBody("createAgentTextBlock")));
(0, eval)(runnableSnippet(streamText.slice(streamText.indexOf("export let textRenderLast"), streamText.indexOf("export function flushThinkingRender"))));
(0, eval)(runnableSnippet(fnBody("clearRetryNote")));
(0, eval)(runnableSnippet(fnBody("discardLivePartial")));
(0, eval)(runnableSnippet(fnBody("applyStreamEvent")));
(0, eval)(runnableSnippet(fnBody("addEvent")));

// ---- helpers over the pane ----
const textBlocks = () => eventsEl.children.filter((el) => /(^|\s)event(\s|$)/.test(el.className) && /(^|\s)text(\s|$)/.test(el.className));
const occurrences = (hay, needle) => hay.split(needle).length - 1;
const OPEN = "这不是代码问题——也不是环境没装好——所以我没替你";
const TAIL = "改 App 的安装目录。";

function freshPane() {
  eventsEl.children.length = 0;
  eventsEl.innerHTML = "";
  rafQ = [];
  state.lastTextEl = null;
  state.lastTextContent = "";
  state.textSealed = false;
  state.textRenderRaf = 0;
  state.retryNoteEl = null;
  state.runSettled = false;
  state.sseRunLostPending = false;
}

// ---- 1. the reported sequence: the record lands between two deltas ----
freshPane();
addEvent({ type: "text_delta", content: OPEN }); // the step is still streaming
addEvent({ type: "assistant_message", content: OPEN + TAIL }); // ...and the record arrives
addEvent({ type: "text_delta", content: TAIL }); // the leftover tail, after it
check(textBlocks().length === 1,
  "one turn is one block: the tail that arrives after the durable record opens no second block");
check(state.lastTextContent === OPEN + TAIL,
  "the block holds the record's whole text (the record is the authoritative copy of its step)");
check(textBlocks()[0] && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "and the block ON SCREEN shows the closing sentence, exactly once");
check(state.textSealed === true, "the block is sealed: what is still in flight for this step says what it already says");

// ---- 2. the ordinary order is unchanged: the record after the whole stream ----
freshPane();
addEvent({ type: "text_delta", content: OPEN + TAIL });
addEvent({ type: "assistant_message", content: OPEN + TAIL });
check(textBlocks().length === 1 && state.lastTextContent === OPEN + TAIL,
  "a record that arrives after every delta adds nothing: still one block, still one copy");
check(occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1, "the answer is not repeated by the adopt path");

// ---- 3. the replay path is untouched: a record with no live block draws one ----
freshPane();
addEvent({ type: "assistant_message", content: OPEN + TAIL });
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "a stored session (no deltas at all) renders the message once, as before");
check(state.textSealed === false, "and it seals nothing: there is no live step to protect");

// ---- 4. the seal lasts one model step ----
freshPane();
addEvent({ type: "text_delta", content: "first" });
addEvent({ type: "assistant_message", content: "first done" });
addEvent({ type: "text_delta", content: " late" });
check(textBlocks().length === 1 && state.lastTextContent === "first done",
  "a delta after the record is dropped: the block is that step's final text");
addEvent({ type: "step_start" });
check(state.textSealed === false, "a new model step opens the seal");
addEvent({ type: "text_delta", content: "second step" });
check(textBlocks().length === 2 && state.lastTextContent === "second step",
  "and its first delta draws a block of its own, in order, under the first");

// ---- 5. a record that belongs to an EARLIER step never clobbers the newer block ----
freshPane();
addEvent({ type: "text_delta", content: "step two is already speaking" });
addEvent({ type: "assistant_message", content: "step one's text" }); // the same two feeds, a step behind
check(state.lastTextEl === null && state.lastTextContent === "",
  "a record its live block does not extend releases the pointer instead of adopting");
check(textBlocks().length === 1 && textBlocks()[0]._body.innerHTML !== "<p>step one's text</p>",
  "and the newer step's block keeps its own text: two steps are never merged into one answer");

// ---- 6. a new task opens the seal; so does a discarded partial ----
freshPane();
addEvent({ type: "text_delta", content: "answer" });
addEvent({ type: "assistant_message", content: "answer" });
addEvent({ type: "user_message", content: "next task" });
check(state.textSealed === false, "a new task is a new run: nothing of the last one is still collecting text");

freshPane();
addEvent({ type: "text_delta", content: "answer" });
addEvent({ type: "assistant_message", content: "answer" });
discardLivePartial();
check(state.textSealed === false && state.lastTextEl === null,
  "a discarded live partial re-opens the seal: the block it protected is gone");

// ---- 7. a stray delta after the run's final stays on the one block ----
freshPane();
addEvent({ type: "text_delta", content: "the answer" });
addEvent({ type: "assistant_message", content: "the answer" });
addEvent({ type: "final", status: "ok", summary: "done" });
addEvent({ type: "text_delta", content: "the answer" }); // an echo, not a second answer
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, "the answer") === 1,
  "a delta echoing the finished answer does not paint it again");

// ---- 8. source-level guards: the state the fix lives in ----
const STATE = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "renderer", "state.ts"), "utf8");
const PROJECT = moduleOf("project.ts");
check(/^\s*textSealed: false,$/m.test(STATE),
  "the seal is declared state beside lastTextEl/lastTextContent, at 'not sealed'");
check(/state\.textSealed = false;/.test(fnBody("clearStream")),
  "a fresh project pane forgets it: the next transcript starts unsealed");
check(/const savedTextSealed = state\.textSealed;/.test(PROJECT) &&
  /state\.textSealed = savedTextSealed;/.test(PROJECT),
  "history paging (which renders records into an off-DOM sink) saves and restores it");
check(!/if \(state\.lastTextEl && state\.lastTextEl\.isConnected\) \{\s*state\.lastTextEl = null;\s*state\.lastTextContent = "";\s*return true;\s*\}/.test(src),
  "the one-way latch that dropped the pointer is gone: a live block is never abandoned mid-step");

summary("text-seal-test");
