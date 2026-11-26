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
// The rule the fix keeps: a text block either STREAMS (deltas extend it) or it is
// CLOSED (state.textSealed), and a closed block has exactly one writer left — the
// durable record that owns it: its step's assistant_message, or the run's `final`,
// which repeats the last one (run-state.ts foldRun closes a turn with it). A
// record whose content EXTENDS the block writes it whole, in place, and closes it;
// deltas still in flight for that step are text the block already says and are
// dropped. step_start opens the seal again, and step_start only: it is the one
// boundary that rides the same ordered feed as the deltas, while a
// `user_message` — the record that opens the next turn — rides the log's feed and
// may land in the middle of the step still writing (a task queued into it). So a
// task's message ends the TURN (`busy` false: nothing is drawing) and never the
// step. The seal is per model step, never a mute. A cut (a reconnect, a tab
// switch) CLOSES the block it can no longer feed instead of taking it off the
// page, and files it with the record that still owes it (the `awaiting` ledger).
//
// Like the other runners here this one drives the REAL addEvent/applyStreamEvent
// and the real text-render path against stubs, so a silent edit fails it.

const { check, summary, slicer, stateStub, runnableSnippet, uiSource, uiModules, installRecordLedger } = require("./harness.js");

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
    // a record's block goes above the block that is still streaming (the page
    // reads in the log's own order)
    insertBefore(child, ref) {
      child.parent = node;
      const i = node.children.indexOf(ref);
      if (i >= 0) node.children.splice(i, 0, child); else node.children.push(child);
      return child;
    },
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
// everything the branches this runner never enters would reach for
global.setRetryNote = () => {};
global.closePerm = () => {};
global.forgetAnsweredPerm = () => {};
global.pendingPerm = null;
// the send outbox (js/render-events.ts noteUserMessage): what a delivered task
// does to the composer, which is not this runner's subject
global.noteUserMessage = () => {};
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
// the replay bracket (stream-view.ts): the evals below run as classic scripts, so
// the real functions resolve this free name against the global scope
global.catchUp = false;
// ...and so does the view's own "a run is drawing into this pane right now"
// (stream-view.ts), which decides whether a task's message may touch the
// streaming pointers (stream-events.ts)
global.busy = false;

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
(0, eval)(runnableSnippet(fnBody("dropScaffold")));
(0, eval)(runnableSnippet(fnBody("discardLivePartial")));
// the closed-block ledger (stream-events.ts): a cut KEEPS the block it closed and
// files it with the record that still owes it, so that record writes it whole
installRecordLedger();
// ...and the record's own block (stream-events.ts rememberRecord): the final reads
// it, so the runner drives the real one. Absent on the code before the fix, where
// the checks below then fail on the duplicate they were written for.
if (/function rememberRecord/.test(src)) (0, eval)(runnableSnippet(fnBody("rememberRecord")));
(0, eval)(runnableSnippet(fnBody("dropOrphanLive")));
(0, eval)(runnableSnippet(fnBody("applyStreamEvent")));
(0, eval)(runnableSnippet(fnBody("addEvent")));

// the coalesced render is a frame away; this runner paints it by hand
const paintPending = () => global.flushTextRender();

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
  state.lastRecordEl = null; // the block the newest durable record drew
  state.lastRecordText = "";
  state.textRenderRaf = 0;
  state.retryNoteEl = null;
  state.runSettled = false;
  state.sseRunLostPending = false;
  global.catchUp = false; // the replay bracket (stream-view.ts)
  global.busy = false; // a run drawing into this pane (stream-view.ts)
  global.awaiting.length = 0; // a fresh pane holds no block a record still owes
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

// ---- 5. a record that belongs to an EARLIER step lands above the newer block ----
freshPane();
addEvent({ type: "text_delta", content: "step two is already speaking" });
addEvent({ type: "assistant_message", content: "step one's text" }); // the same two feeds, a step behind
check(state.lastTextEl === textBlocks()[1] && state.lastTextContent === "step two is already speaking",
  "a record its live block does not extend leaves the pointer with the step that is writing now");
check(textBlocks().length === 2 && textBlocks()[0]._body.innerHTML === "<p>step one's text</p>",
  "and the record draws its own block ABOVE it: the page reads in the log's own order");
check(textBlocks()[1]._body.innerHTML !== "<p>step one's text</p>",
  "the newer step's block keeps its own text: two steps are never merged into one answer");

// ---- 6. a finished run's pointers end with the turn, not with a step ----
//
// The orin duplicate: a task queued INTO a run that is still drawing arrives while
// that step is mid-answer, and the step's own record can reach this sink AHEAD of
// its remaining deltas. The old branch unsealed the block on that message, so the
// tail opened a SECOND block holding only the end of the answer ("…拔掉 micro-USB
// 线"). `busy` (stream-view.ts) is what separates such a message from one that
// opens the pane's next run.
freshPane();
addEvent({ type: "text_delta", content: "answer" });
addEvent({ type: "assistant_message", content: "answer" });
addEvent({ type: "user_message", content: "next task" });
check(state.textSealed === false, "a new task, once nothing is running, is a new turn: nothing of the last one is still collecting text");

// the reported shape, in order: a record that leads its own tail, and the task the
// user queued into that same step
freshPane();
global.busy = true; // a run is drawing into this pane
addEvent({ type: "text_delta", content: OPEN });
addEvent({ type: "assistant_message", content: OPEN + TAIL }); // the record, ahead of its own tail
addEvent({ type: "user_message", content: "继续" }); // ...and a task queued into the same step
check(state.textSealed === true && state.lastTextEl === textBlocks()[0],
  "a task queued into a running step does not unseal the block that step is finishing");
addEvent({ type: "text_delta", content: TAIL }); // the step's leftover deltas
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "the leftover tail adds no block and repeats nothing: one answer, one block, whole");
check(state.lastTextContent === OPEN + TAIL,
  "…and the pointer still holds the step's whole text, so what follows can complete it");

// ...and the run's final, which repeats the whole answer, completes THAT block
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL });
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "the final completes the one block in place: no second whole-answer copy under the tail");
check(state.lastRecordEl === textBlocks()[0] && state.lastRecordText === OPEN + TAIL,
  "…and the ledger the task did NOT wipe still names it: the step's record was never orphaned");

// the same message with nothing running DOES wipe it: that run is over
freshPane();
addEvent({ type: "text_delta", content: "answer" });
addEvent({ type: "assistant_message", content: "answer" });
check(state.lastRecordEl !== null, "a record the pane holds is in the ledger");
addEvent({ type: "user_message", content: "next task" });
check(state.lastRecordEl === null && state.lastRecordText === "" && global.awaiting.length === 0,
  "a new task, once nothing is running, forgets the block the run before it drew");

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

// ---- 8. the reconnect: a settled answer is kept, an unfinished one becomes a hole ----
//
// The reported loss this pins: the window's own socket reconnects (minimize, a
// phone returning from the background, the stale watchdog), es.onopen drops the
// live partial, and the block it deleted held the DURABLE closing prose — a
// record the replay can never re-deliver, because addEvent drops every record at
// or below the offset this window already painted. The pane then ended at a
// `completed` divider with no answer above it ("git output → completed") while
// the .clc held the answer all along.

freshPane();
addEvent({ type: "text_delta", content: OPEN });
addEvent({ type: "assistant_message", content: OPEN + TAIL }); // the step's record adopted it
check(state.textSealed === true, "the block holds its step's durable record");
const adoptedEl = state.lastTextEl;
dropOrphanLive(); // ...and then the socket comes back
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "a reconnect KEEPS a block that holds the durable record: the closing prose is not lost");
check(state.lastTextEl === adoptedEl && state.lastTextContent === OPEN + TAIL,
  "…and keeps the pointer to it: the record that owns this text is the only writer it has left");
check(global.awaiting.length === 0,
  "…filing nothing: a block its record already wrote is owed nothing by the log");
check(state.textSealed === true,
  "…and the seal keeps the step's straggling deltas from repeating what the block says");

freshPane();
addEvent({ type: "text_delta", content: OPEN }); // still streaming: no record for it yet
check(state.textSealed === false, "an unfinished block is not sealed");
const cutEl = state.lastTextEl;
dropOrphanLive();
check(textBlocks().length === 1 && !cutEl.removed,
  "a cut KEEPS an unfinished block: its deltas are never stored, so deleting it is the opening lost for good");
check(state.lastTextEl === cutEl && state.lastTextContent === OPEN && state.textSealed === true,
  "…closes it and keeps the pointer, so the text after the cut cannot append itself to the half");
check(global.awaiting.length === 1 && global.awaiting[0].el === cutEl && global.awaiting[0].text === OPEN,
  "…and files it for the record that owns it, so that record can write THIS block whole");
addEvent({ type: "text_delta", content: TAIL }); // the chunks that arrive after the cut
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 0,
  "a closed block takes no more deltas: the text after the gap opens no block of its own");

freshPane();
addEvent({ type: "text_delta", content: OPEN });
addEvent({ type: "assistant_message", content: OPEN + TAIL });
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL });
check(state.runSettled === true, "the run is settled once its final landed");
dropOrphanLive();
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "the closing prose of a finished run also survives a reconnect (runSettled, not the seal, is what keeps it)");
check(global.awaiting.length === 0,
  "…and a finished run owes no record: nothing is filed for it");

// ---- 9. a live `completed` final puts its answer back when the pane lost it ----
//
// The final is the last record that can notice the answer is missing: foldRun
// (run-state.ts) closes a turn by writing its last assistant_message AS the
// completed summary, so the text is right there — and appendCompletion itself
// prints nothing for `completed`, so no other frame carries it.
freshPane();
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL });
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "no block on the page: the final's own text is painted above the divider");

freshPane();
addEvent({ type: "text_delta", content: OPEN });
addEvent({ type: "assistant_message", content: OPEN + TAIL });
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL });
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "the answer is already on the page: the final adds the divider, never a second copy of it");

freshPane();
global.catchUp = true; // a replayed window: the records themselves draw the turn
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL });
check(textBlocks().length === 0,
  "a REPLAYED final paints nothing: the replayed assistant_message is what draws the answer");
global.catchUp = false;

freshPane();
addEvent({ type: "final", status: "completed", summary: "" }); // a run with no answer to restore
check(textBlocks().length === 0, "an empty completed summary paints nothing");

freshPane();
addEvent({ type: "final", status: "aborted", summary: "the reason" });
check(textBlocks().length === 0,
  "only a completed run hands its text over: an aborted run's summary is the reason, shown by the divider");

freshPane();
addEvent({ type: "text_delta", content: OPEN });
addEvent({ type: "assistant_message", content: OPEN + TAIL });
dropOrphanLive(); // the reconnect keeps the sealed answer and its pointer
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL }); // ...the final lands after it
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "a final that follows the keep does not paint the kept answer a second time");

freshPane();
addEvent({ type: "text_delta", content: OPEN });
addEvent({ type: "assistant_message", content: OPEN + TAIL });
dropOrphanLive();
addEvent({ type: "user_message", content: "next task" });
addEvent({ type: "final", status: "completed", summary: "a different answer" });
check(textBlocks().length === 2 && occurrences(textBlocks()[1]._body.innerHTML, "a different answer") === 1,
  "a new task ends the run before it: its own answer is drawn even though the last one was kept");

// ---- 10. the cut: a switched-away pane keeps its half, its record writes it whole ----
//
// The reported regression, exactly: the reader comes back to the tab and the
// answer begins mid-sentence ("，下一次") with everything above it gone. A delta
// is never stored and the record that painted the block was already delivered, so
// a discarded half can never be continued NOR repainted — the halved block IS the
// only copy of the opening this window will ever hold. So a cut CLOSES the block
// (dropOrphanLive) and files it with the record that owns it: the continuation is
// dropped instead of appended, and the step's own record — or, if that never
// lands, the run's final — writes the block's text whole.
freshPane();
addEvent({ type: "text_delta", content: OPEN });
paintPending();
dropOrphanLive(); // the reader switched away and came back
addEvent({ type: "text_delta", content: TAIL }); // the chunks that arrive after the cut
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 0,
  "the text after the cut paints no block of its own: never an answer that starts mid-sentence");
addEvent({ type: "assistant_message", content: OPEN + TAIL }); // the step's durable record
check(textBlocks().length === 1 &&
  occurrences(textBlocks()[0]._body.innerHTML, OPEN) === 1 &&
  occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "that record writes the closed block WHOLE: the opening is back where it was, the tail appears once");
check(state.lastTextContent === OPEN + TAIL && state.textSealed === true,
  "…and the block is the step's copy again, so what is still in flight for it repeats nothing");
check(global.awaiting.length === 0, "…and nothing is left filed for it");
addEvent({ type: "text_delta", content: TAIL }); // a straggler of the same step
check(occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "a straggler after the completion adds nothing to it");

// a record that lags a whole step still completes ITS block, without seizing the
// step now speaking (the two feeds into addEvent are unordered)
freshPane();
addEvent({ type: "text_delta", content: OPEN });
paintPending();
dropOrphanLive();
addEvent({ type: "step_start" }); // the next model step begins while the pane was away
addEvent({ type: "text_delta", content: "second step" });
paintPending();
check(textBlocks().length === 2 && state.lastTextContent === "second step",
  "the next step streams into a block of its own, as it would have without the outage");
addEvent({ type: "assistant_message", content: OPEN + TAIL }); // the step before it, one step late
check(textBlocks().length === 2 && occurrences(textBlocks()[0]._body.innerHTML, OPEN) === 1 &&
  occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "the late record fills the OLD block in place and opens no third one");
check(state.lastTextContent === "second step",
  "…and leaves the render state with the step that is writing now");

// the record never lands (the pane was away for the whole end of that step): the
// run's final carries the same answer, so it is the one that writes the block
freshPane();
addEvent({ type: "text_delta", content: OPEN });
paintPending();
dropOrphanLive();
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL });
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, OPEN) === 1 &&
  occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "a final whose record never arrived writes the closed block whole, above its divider");

// a record that does NOT extend the closed block is another step's answer: it
// paints its own block above it and leaves the closed block exactly as the reader
// left it
freshPane();
addEvent({ type: "text_delta", content: OPEN });
paintPending();
dropOrphanLive();
addEvent({ type: "assistant_message", content: "an unrelated answer" });
check(textBlocks().length === 2 && occurrences(textBlocks()[0]._body.innerHTML, "an unrelated answer") === 1,
  "a record the closed block does not extend opens its own block, above it");
check(occurrences(textBlocks()[1]._body.innerHTML, OPEN) === 1 &&
  occurrences(textBlocks()[1]._body.innerHTML, TAIL) === 0,
  "…and the closed block is not touched by it");
check(global.awaiting.length === 1 && global.awaiting[0].el === textBlocks()[1],
  "…it is still filed for the record that owns it");

// the next task ends what the run before it left: its records are in the log AHEAD
// of the new message, so no record of the new run may complete an old block
freshPane();
addEvent({ type: "text_delta", content: OPEN });
paintPending();
dropOrphanLive();
addEvent({ type: "user_message", content: "next task" });
check(global.awaiting.length === 0 && state.lastTextEl === null && state.textSealed === false,
  "a new task drops the ledger: the run before it is over, and its records had their chance");
addEvent({ type: "assistant_message", content: OPEN + TAIL }); // a late record of the old run
check(textBlocks().length === 2, "…so its late record draws a block of its own");
check(occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 0,
  "…the block the reader left stays exactly as it was");
check(occurrences(textBlocks()[1]._body.innerHTML, TAIL) === 1,
  "…and the late record is drawn whole, once");

// a dead attempt is the one block that IS removed: the retry re-streams from its
// own first word, so keeping it would leave the opening standing above a copy
freshPane();
addEvent({ type: "text_delta", content: OPEN });
paintPending();
dropOrphanLive();
addEvent({ type: "llm_retry", discard: true, attempt: 1, max_retries: 3 });
check(textBlocks().length === 0,
  "a discarded attempt takes its closed half with it: the retried answer starts from its beginning");
check(global.awaiting.length === 0, "…and nothing is left filed for a block that is gone");
addEvent({ type: "text_delta", content: OPEN });
paintPending();
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, OPEN) === 1,
  "and the retried text paints one block, once");

// ---- 11. source-level guards: the rule the fix lives in ----
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
check(/if \(state\.textSealed\) return true;/.test(fnBody("applyStreamEvent")),
  "a closed block takes no more deltas: what follows a cut cannot be appended to the half");
check(/if \(!busy\) \{\s*state\.lastTextEl = null;\s*state\.lastTextContent = "";\s*state\.textSealed = false;/.test(fnBody("addEvent")),
  "a task's message unseals only once nothing is drawing: a step's own leftover tail keeps the block it belongs to");
check(!/if \(state\.textSealed\) \{\s*state\.lastTextEl = null;/.test(fnBody("addEvent")),
  "…and never unconditionally: the feeds are unordered, so that message can land inside the step writing now");
check(/const owed = !\(state\.textSealed \|\| state\.runSettled\);/.test(fnBody("dropOrphanLive")) &&
  /awaitRecord\(live, state\.lastTextContent\)/.test(fnBody("dropOrphanLive")) &&
  /state\.textSealed = true;/.test(fnBody("dropOrphanLive")),
  "a cut closes the block and files it, unless its record already wrote it or the run is over");
check(/flushTextRender\(\);/.test(fnBody("dropOrphanLive")),
  "…and paints it first: the block a record will overwrite shows every character it was closed with");
check(!/function forgetHoles|addHole\(|discardLivePartial\(keepText/.test(src),
  "no second mechanism: the ledger prunes a block something took off the page (awaitingFor), nothing else tracks it");
check(/const owed = awaitingFor\(ev\.content\);/.test(fnBody("applyStreamEvent")) &&
  /completeRecord\(owed\.el, ev\.content\);/.test(fnBody("applyStreamEvent")),
  "the step's record writes its own closed block whole, wherever it stands on the page");
check(/if \(live\) eventsEl\.insertBefore\(wrap, live\);/.test(fnBody("applyStreamEvent")),
  "a record that extends nothing draws its own block above the step speaking now (the page is in log order)");
check(/if \(!awaiting\[i\]\.el\.isConnected\) awaiting\.splice\(i, 1\);/.test(fnBody("awaitingFor")),
  "the ledger prunes a block something took off the page, so no other bookkeeping has to be told");
check(!/forgetHoles/.test(fnBody("clearStream")),
  "and clearing the pane needs no tell: a block that is off the page is pruned when a record looks for it");
check(/paintTextBlock\(el, text, true\);/.test(fnBody("completeRecord")),
  "one painter for both writers: a closed block is painted by the same pass the streaming block is");

// ---- 11. a REPLAYED turn is drawn by its record, and its final completes THAT block ----
//
// The reported duplicate, exactly: a restored tab (and an opened project) replays
// the log, and the six durable types come from that replay and nowhere else — no
// step_start, no delta, so no live block and nothing in the `awaiting` ledger. The
// record paints the turn; the run's final follows it immediately with the SAME
// text as its summary (run-state.ts foldRun closes a completed turn by writing its
// last assistant_message as the summary). The final used to see no live block and
// nothing owed, so it painted a block of its own — the same answer twice, under two
// `agent` headers.
freshPane();
addEvent({ type: "assistant_message", content: OPEN + TAIL });
check(state.lastRecordEl === textBlocks()[0] && state.lastRecordText === OPEN + TAIL,
  "the block a record drew is remembered: the final that repeats it has something to complete");
addEvent({ type: "final", status: "completed", summary: OPEN + TAIL });
check(textBlocks().length === 1 && occurrences(textBlocks()[0]._body.innerHTML, TAIL) === 1,
  "a replayed turn that ends in its final is ONE block: the final completes the record's block");
check(state.lastTextEl === textBlocks()[0] && state.textSealed === true,
  "…and the pointer is on it, so nothing that follows can open a second one");

// the whole transcript, the way a tab switch delivers it: user, answer, final, again
freshPane();
addEvent({ type: "user_message", content: "first task" });
addEvent({ type: "assistant_message", content: "answer one" });
addEvent({ type: "final", status: "completed", summary: "answer one" });
addEvent({ type: "user_message", content: "second task" });
addEvent({ type: "assistant_message", content: "answer two" });
addEvent({ type: "final", status: "completed", summary: "answer two" });
check(textBlocks().length === 2 &&
  occurrences(textBlocks()[0]._body.innerHTML, "answer one") === 1 &&
  occurrences(textBlocks()[1]._body.innerHTML, "answer two") === 1,
  "a replayed two-turn transcript is TWO blocks: each turn's record draws its answer once, and its final adds none");

// a new task ends it: the block a run left is not the next run's answer
freshPane();
addEvent({ type: "assistant_message", content: "answer one" });
addEvent({ type: "user_message", content: "next task" });
check(state.lastRecordEl === null && state.lastRecordText === "",
  "a new task forgets the block the run before it drew");
addEvent({ type: "final", status: "completed", summary: "a different answer" });
check(textBlocks().length === 2 && occurrences(textBlocks()[1]._body.innerHTML, "a different answer") === 1,
  "…so its own final is drawn: no record of this run is mistaken for the previous run's block");

// a record that a paged history row drew is not the tail's answer (project.ts
// renders older pages into an off-DOM sink)
check(/if \(pageSink \|\| !text\) return;/.test(moduleOf("stream-events.ts")),
  "a block drawn into the off-DOM history sink is not remembered: rows above the tail are not its answer");
check(/rememberRecord\(wrap, ev\.content\)/.test(fnBody("applyStreamEvent")) &&
  /rememberRecord\(owed\.el, ev\.content\)/.test(fnBody("applyStreamEvent")),
  "every path that draws a record remembers its block: its own, and the cut block it fills");
check(/state\.lastRecordEl = null;/.test(fnBody("clearStream")) &&
  /state\.lastRecordText = "";/.test(fnBody("clearStream")),
  "a fresh project pane forgets it: no final completes a node the pane that left owned");

summary("text-seal-test");
