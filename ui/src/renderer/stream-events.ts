// the event pipeline — live call previews, the event sink, applyStreamEvent
//
// `addEvent` is the one entry every host event goes through, `applyStreamEvent`
// routes the streaming deltas, and the preview helpers keep a call row honest while
// its arguments are still arriving.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { autoFoldTurn } from "./auto-fold";
import { countdownMeter, noteToolStarted, settleAllCountdowns, settleCountdown } from "./countdown";
import { highlightCode, typesetMath } from "./markdown";
import { closePerm, forgetAnsweredPerm, pendingPerm } from "./permissions";
import { clearStream, pageSink, setOlderPill } from "./project";
import { appendCompletion, noteUserMessage, renderEvent, renderMarkdown } from "./render-events";
import { SSE_RUN_LOST } from "./sse-stream";
import { state } from "./state";
import {
  appendThinkingRow, buildThinkingBlock, createAgentTextBlock,
  flushTextRender, flushThinkingRender, landFoldsIn, paintTextBlock, scheduleTextRender,
  scheduleThinkingRender,
} from "./stream-text";
import { eventsEl } from "./els";
import {
  autoScroll, beginCatchUp, busy, catchUp, endCatchUp, toolCallGroups, toolCalls,
} from "./stream-view";
import { refreshRollbackAnchors } from "./task-rollback";
import {
  addToolCallRow, appendResultRow, argsButton, makeToolRowBase, previewText,
  toolGroupFor, uiOf, uiOfResult,
} from "./tool-render";
import { refreshTree } from "./workspace-panel";

// live tool-call previews: callId -> {name, ui, text, row, body, group}; the
// declaration decides what the row shows while the call is generated
export const streamRows = {};

export function handleToolCallDelta(ev) {
  let st = streamRows[ev.tool_call_id];
  if (!st) {
    if (!ev.name) return; // the start delta carries the name
    const ui = uiOf(ev);
    const group = toolGroupFor(ev.tool_call_id, ui);
    st = streamRows[ev.tool_call_id] = { name: ev.name, ui, text: "", row: null, body: null, group };
    st.row = makeToolRowBase(ui, ev.name);
    st.row.classList.add("stream");
    if (ui.preview === "none" || (ui.preview && ui.preview.mode === "none")) {
      // nothing to stream: the row stays just its name (a body too large to
      // preview), its result speaks when it lands
      const dots = document.createElement("span");
      dots.className = "muted";
      dots.textContent = "…";
      st.row.appendChild(dots);
    } else {
      st.body = document.createElement("pre");
      st.body.className = "tool-args-detail stream-pre";
      st.row.appendChild(st.body);
    }
    group.el.appendChild(st.row);
    autoScroll();
  }
  st.text += ev.delta;
  if (st.body) st.body.textContent = previewText(st.ui, st.name, st.text);
  // the preview grows in place (no scroll event): re-pin while latched
  autoScroll();
}

// remove previews left by an aborted turn (a tool call that streamed but never finished)
export function clearStreamPreviews() {
  for (const id of Object.keys(streamRows)) {
    if (streamRows[id]) streamRows[id].row.remove();
    delete streamRows[id];
  }
}

// Take the page down to the part of itself that is a PICTURE: the rows a live
// attempt draws beside its text are not. A half-streamed call has no record that
// will ever complete it (deltas are never stored), the reconnect chip belongs to
// a connection that is over, and a compaction still running has no `compaction`
// record yet — so a replay of the log would not show any of them either.
//
// The restore already does this: dropOrphanLive → dropScaffold/clearRetryNote is
// the first thing paintCachedView runs on the way back. What this export adds is
// the same teardown on the way OUT, so that a switch which happens to land while
// one of them is up costs a cache write instead of a replay — slots.ts hands this
// to saveDomCache as its `settle` (project.ts activateTab).
export function pruneTransient() {
  clearStreamPreviews(); // the half-streamed call rows, and their in-memory handles
  clearRetryNote(); // "connection lost — retrying"
  if (state.compactionEl) {
    state.compactionEl.remove();
    state.compactionEl = null;
  }
  landFoldsIn(eventsEl); // a fold/diff whose move will never finish (stream-text)
}

// a mid-stream retry (the attempt died after streaming part of the turn): the
// client restarts the request from scratch, so everything THIS attempt drew —
// the partial text, the reasoning block, the half-streamed tool rows — has to
// go, or it would sit above the retried answer as a stale copy. The retry
// notice announces it (discard=true); none of that partial output is durable
// (stream deltas are never stored), so nothing is lost by dropping it here.
//
// This is the ONE path that takes a block off the page: the attempt that wrote it
// is dead, and what replaces it streams the same text from its first word, so the
// half would only sit above a copy of itself.
export function discardLivePartial() {
  if (state.textRenderRaf) { cancelAnimationFrame(state.textRenderRaf); state.textRenderRaf = 0; }
  if (state.lastTextEl) {
    unawait(state.lastTextEl); // a cut may have filed it for a record that never comes
    state.lastTextEl.remove();
    state.lastTextEl = null;
  }
  state.lastTextContent = "";
  state.textSealed = false; // the block that held it is gone
  dropScaffold();
}

// What an attempt in flight draws beside its text: the reasoning row, and the tool
// rows whose arguments are still arriving. Deltas both, nothing of them is stored,
// so neither a cut nor a retry can keep one — no record would ever complete it.
function dropScaffold() {
  if (state.thinkingRenderRaf) { cancelAnimationFrame(state.thinkingRenderRaf); state.thinkingRenderRaf = 0; }
  if (state.thinkingEl) { state.thinkingEl.remove(); state.thinkingEl = null; }
  state.thinkingContent = "";
  clearStreamPreviews();
}

// ---- a cut: the block is CLOSED, and its record writes it ----
//
// The window's own socket came back (sse-stream.ts es.onopen) or a tab came back
// (project.ts paintCachedView) — either way the text block that was streaming
// stopped being fed, and no delta after this point continues it. A delta is never
// stored (agent/events.py keeps finals), so the chunks that arrive after the cut
// are the text AFTER a gap, and appending them is what the reader saw as an answer
// beginning mid-sentence ("，下一次") with everything above it gone.
//
// So a cut CLOSES the block instead of taking it off the page, and one rule holds
// from there on: a text block either STREAMS (deltas extend it) or it is CLOSED
// (state.textSealed), and a closed block's text has exactly one writer left — the
// record that owns it, the step's assistant_message, or the run's `final`, which
// repeats the last one (run-state.ts foldRun writes the closing answer as the
// completed summary). Both write it WHOLE, in place, and only into a block their
// text starts with. That prefix is the identity this page has always used between
// a record and its own deltas (assistant_message below), and it is what lets a
// record that lags a whole step still land in its block instead of over the step
// now speaking.
//
// Taking the block off the page is the same loss seen from the other side: the
// record that painted it is behind addEvent's watermark and is never re-delivered,
// so a removed block is a paragraph gone for good — the pane ended at a
// `completed` divider with the closing prose missing ("git output → completed")
// while the .clc had held the answer all along.
export function dropOrphanLive() {
  const live = state.lastTextEl && state.lastTextEl.isConnected ? state.lastTextEl : null;
  if (live && state.lastTextContent) {
    // Is a record still owed for this text? Not once the step's record adopted it
    // (textSealed) or the run ended: the copy on the page is the log's own then.
    const owed = !(state.textSealed || state.runSettled);
    flushTextRender(); // the block shows every character it is closed with
    state.textSealed = true;
    if (owed) awaitRecord(live, state.lastTextContent);
    dropScaffold(); // the reasoning row and the half-streamed calls are not text
  } else {
    discardLivePartial(); // an empty block: nothing on the page worth keeping
  }
  state.toolGroupEl = null;
  clearRetryNote(); // a reconnect may have skipped the event that would clear it
}

// ---- the blocks the log still owes text to ----
//
// A cut closed them (dropOrphanLive), so their text is on the page but not in the
// log this window can read any more, and the record that owns them has not landed.
// A list, not a slot: a step can be cut more than once, and the feeds into addEvent
// are unordered, so a record can arrive a whole step behind its block.
const awaiting = [];

function awaitRecord(el, text) {
  if (!awaiting.some((w) => w.el === el)) awaiting.push({ el, text });
}

function unawait(el) {
  const i = awaiting.findIndex((w) => w.el === el);
  if (i >= 0) awaiting.splice(i, 1);
}

// The block a record of `text` completes: the newest one still on the page whose
// text that record extends. Nodes something took off the pane (clearStream, a
// replayed tab's own repaint) are dropped on the way past — a block that is not on
// the page can never be filled, and no other bookkeeping has to be told.
function awaitingFor(text) {
  if (!text) return null;
  for (let i = awaiting.length - 1; i >= 0; i--) {
    if (!awaiting[i].el.isConnected) awaiting.splice(i, 1);
  }
  for (let i = awaiting.length - 1; i >= 0; i--) {
    const w = awaiting[i];
    if (w.text && text.startsWith(w.text)) return w;
  }
  return null;
}

// Write a block's whole text — the pass renderTextBlock makes, aimed at the node
// the record names instead of at the streaming pointer — and close it. The pointer
// only ever names the block of the step writing now (step_start releases it), so a
// block it names keeps the record's text and the seal, while a block an EARLIER
// step left behind is completed where it stands and the render state stays with
// the step that is still speaking.
function completeRecord(el, text) {
  paintTextBlock(el, text, true);
  unawait(el);
  if (state.lastTextEl !== el) return;
  state.lastTextContent = text;
  state.textSealed = true;
}

// The block the newest durable assistant_message drew, whichever path drew it. The
// run's `final` repeats exactly that record's text (run-state.ts foldRun closes a
// completed turn by writing its last assistant_message as the summary), so it is
// the block the final has to complete — a stored session, a replayed transcript
// and a tail a restored tab rebuilt have no live block at all, and the record's own
// block is then the only copy of the answer on the page.
//
// A history page renders into an off-DOM sink (project.ts loadOlder): those rows
// belong to the turns above the tail, not to its answer, so they are not
// remembered. A node that left the page is pruned where it is read (the final),
// like the awaiting ledger's.
function rememberRecord(el, text) {
  if (pageSink || !text) return;
  state.lastRecordEl = el;
  state.lastRecordText = text;
}

// transient "connection lost — retrying…" chip. Shown when an LLM stream
// attempt fails (network drop / read timeout) and the client reconnects with
// backoff; removed as soon as new tokens arrive, the compaction clears, or the
// run ends — so the UI never looks frozen.
export function setRetryNote(ev) {
  if (state.retryNoteEl) state.retryNoteEl.remove();
  state.retryNoteEl = document.createElement("div");
  state.retryNoteEl.className = "event llm-note live";
  const p = document.createElement("p");
  p.className = "body";
  const fallback = `connection lost — retrying (${ev.attempt}/${ev.max_retries || "…"})`;
  p.textContent = "⚠ " + (ev.message || fallback);
  state.retryNoteEl.appendChild(p);
  (pageSink || eventsEl).appendChild(state.retryNoteEl);
  autoScroll();
}

export function clearRetryNote() {
  if (state.retryNoteEl) {
    state.retryNoteEl.remove();
    state.retryNoteEl = null;
  }
}

// ---- the run-settled ledger, and the one announcement that reads it ----
//
// The ledger itself (sseRunLostPending / runSettled, declared in sse-stream.ts
// beside sseRunAtRisk) is written in exactly one place, because a run has one
// shape here: a task opens it and a `final` closes it, live or replayed, and both
// walk addEvent. What the window says about a run it lost is the transcript's
// business — a run must not end without a record of it, and a toast that
// dismisses itself leaves none.
export function announceRunLost() {
  state.sseRunLostPending = false; // asked once, answered once
  if (state.runSettled) return; // the log already ended this run: never a second ending
  // the shape the local failed run uses (render-events.ts run): the
  // completion divider exists for exactly this, and it is durable, re-readable,
  // and impossible to miss on a phone nobody was holding
  addEvent({ type: "final", status: "error", summary: SSE_RUN_LOST });
}

// The one way a catch-up block ends: paint every record it queued, in order, and
// then close the bracket — one layout, one scroll, in the one task that calls this.
// See the block's comment inside addEvent: the queue is DATA until the server
// closes the block (`replayed`), and a record is counted in the watermark when it
// ARRIVES, so a queued row dropped here is a row no later `?since=` would ever
// resend. That is why every way a block can end comes through this function and
// not through endCatchUp() alone — a drain that left the bracket open would hold
// every record that followed it too (a fresh connect with no `since` never sends
// the `replayed` that would close it).
export function settleCatchUp() {
  while (state.owedRecords.length) {
    const row = state.owedRecords.shift();
    if (row) row();
  }
  endCatchUp(); // the bracket's one move, now that the rows are in the pane
}

export function addEvent(ev) {
  // lazy wire shape: {offset, event} carries each durable event's byte offset
  // so the UI can page the earlier records
  let wireOffset = null; // the record's own offset, kept for the row it renders
  if (ev && typeof ev === "object" && ev.event && typeof ev.offset === "number") {
    wireOffset = ev.offset;
    // Replay HEALS, it does not re-render. A reconnecting stream replays the log
    // from its window start, so every event this window already painted arrives
    // again (the transcript visibly doubled after a reconnect). Offsets are the
    // log's own monotonic byte positions inside the .clc (agent/core/lazy.py),
    // so a record at or below the highest one already rendered is one of those.
    // The history paging path (pageSink) walks BACKWARDS through older records
    // on purpose and is exempt: it never moves this watermark.
    if (!pageSink) {
      if (state.streamHighOffset !== null && ev.offset <= state.streamHighOffset) return;
      state.streamHighOffset = Math.max(state.streamHighOffset === null ? 0 : state.streamHighOffset, ev.offset);
    }
    if (ev.offset > 0) state.oldestOffset = state.oldestOffset === null ? ev.offset : Math.min(state.oldestOffset, ev.offset);
    ev = ev.event;
  }
  // the ledger behind announceRunLost, above: a task opens a run, a final closes
  // it — whichever way the record arrived
  if (ev && ev.type === "user_message") {
    // A task the user starts now closes the question a released run left open
    // (the session never served the window the log that would have answered it):
    // the window has moved on, and the loss belongs ABOVE the new task's row, as
    // the record of what happened to the run before it.
    if (state.sseRunLostPending) announceRunLost();
    state.runSettled = false;
    // A task opens a NEW run: the block the run before it left is CLOSED, and its
    // text is on the log, so it is not this run's answer — no record of this run
    // may be mistaken for a continuation of it, and no block of that run is still
    // owed a record (its records are in the log AHEAD of this message, so every
    // one of them already had its chance to arrive; an entry left here could only
    // be matched by a later run's text).
    //
    // A turn boundary, though — never a step boundary. `step_start` is the only
    // step boundary (run-host.ts emits it before every model() call, on the SAME
    // ordered feed as the deltas); this record cannot stand in for one, because
    // the durable log feed and the IPC event feed are UNORDERED, and a step's own
    // assistant_message can reach this sink AHEAD of that step's remaining
    // deltas. Unsealing the block here would then hand that tail a block of its
    // own, holding only the END of the answer — the "whole answer, then the last
    // few lines" duplicate (orin).
    //
    // `busy` is what tells the two apart: a task queued INTO a run that is still
    // drawing arrives with the view busy, and there the pointers and the ledger
    // belong to the step in flight. A message that opens the pane's NEXT run
    // arrives once nothing is running, and there they are the finished turn's
    // leftovers.
    if (!busy) {
      state.lastTextEl = null;
      state.lastTextContent = "";
      state.textSealed = false;
      state.lastRecordEl = null;
      state.lastRecordText = "";
      awaiting.length = 0;
    }
    // ...and every ask id the run before it handed out is dead
    forgetAnsweredPerm();
    // The composer's outbox (render-events.ts): the row this window's own send
    // became is in the pane now, so the message leaves the box — here, and never
    // on the click, which is what made a send over a tunnel look like it vanished.
    noteUserMessage(ev.content);
  } else if (ev && ev.type === "final") {
    state.runSettled = true;
  }
  // reconnect history line: restore the honest on-disk older count. It also
  // OPENS the catch-up block: everything until the `replayed` frame is a record
  // this window is owed, and the view must not chase each one (stream-view.ts).
  // A block that never closed (its stream went away mid-answer) is painted first:
  // those rows are the transcript's PREFIX, and they are already counted in the
  // watermark, so dropping them would be a hole the next reconnect never asks for.
  if (ev && ev.type === "history") {
    settleCatchUp();
    setOlderPill(ev.older || 0);
    beginCatchUp();
    return;
  }
  // the catch-up is over: the view follows again, with a single move
  if (ev && ev.type === "replayed") {
    // ...and the block is IN the pane first: what addEvent held is painted here,
    // in order, because the bracket's one scroll has to land on the real tail —
    // not on a transcript that is still queued. This one task is the block's
    // whole paint: one layout, one scroll, no cascade of either.
    settleCatchUp();
    // The block that just closed is also the first moment this window may read
    // the workspace tree: the session resolved the project this stream named
    // BEFORE it served that block (agent/api/events.py _project_for_sse), and a
    // session that was replaced under us (a tunnel end, a self-heal, a re-claim)
    // adopts it there. Reading earlier — from onopen — can race that open and
    // blank the panel (sse-stream.ts). This is what repaints it after a
    // reconnect without the user having to send a message.
    refreshTree();
    // The block that just closed is the log's whole answer to the question the
    // status frame asked (sse-stream.ts sseRunLostPending): a final inside it
    // ended the run and said so — the departing session writes one when it is
    // released mid-run (agent/server.py record_release) — and its absence is the
    // window's own ending to state. Only the `replayed` frame can tell the two
    // apart, which is why the flag waits for it and never guesses earlier.
    if (state.sseRunLostPending) announceRunLost();
    return;
  }
  // the offset this window asked to continue from is past the end of the log
  // (the .clc was replaced under it): appending the served window would leave
  // two transcripts on one screen, so the pane starts over instead
  if (ev && ev.type === "resync") {
    clearStream();
    return;
  }
  // Nothing here mutes what the host says about this window's session for the
  // shape of the pane. Both of those frames are HOST-MADE and never persisted
  // (agent/events.py DURABLE_TYPES holds neither), so neither is ever part of a
  // replay: the status frame a connect finds is computed from the host's state
  // at that moment (agent/api/events.py `_sse`), and a permission ask is the one
  // a blocked run is waiting on. Dropping them for a "loading" pane is how a run
  // wedges: this window was reconstructing history, the ask never appeared, and
  // the run sat in gate.require — which waits forever by design. The status frame
  // is the same rule the other way round: a window rebuilding its pane is
  // EXACTLY the window that missed the last word about the run (another window
  // started one, its own ended, a claim took the project), and the reconstruction
  // may never finish — nothing later would repeat it.

  // ---- the catch-up block: paint it once, when the server closes it ----
  //
  // Everything below is DOM work. While a catch-up is open (`history` …
  // `replayed`, stream-view.ts) the records arriving are the block the window
  // was owed, and over a tunnel each one is its OWN SSE frame in its own task:
  // painting per frame is a paint per record, so the transcript visibly
  // assembles itself row by row while the reader watches — the reported "一次
  // 性闪过很多消息，最后才停在尾部消息". Loopback hid it (the same block arrives in
  // one read and lands in one paint), and a timer between the frames only lowers
  // the rate: the cascade is still a cascade.
  //
  // The block is DATA until its closing frame. The rows are held as thunks and
  // painted by the one task that closes the block (`replayed`), so the pane takes
  // the catch-up in a single layout and the view moves once, afterwards, through
  // autoScroll — which respects the latch. Nothing here waits on a guess: the
  // server brackets its answer explicitly (agent/api/events.py `_sse`), so the
  // end of the block is a frame, not a timeout.
  //
  // The invariant that makes holding safe: addEvent advances the watermark
  // (state.streamHighOffset) when a record ARRIVES, so a queued row that is
  // dropped is a row no later `?since=` will ever send again. settleCatchUp() is
  // therefore the one ending EVERY way a block can end goes through — `replayed`,
  // a new `history`, a replaced/closed stream (sse-stream.ts), a tab switch saving
  // its cache (project.ts) — and clearStream drops the queue only because it drops
  // the pane and the watermark together.
  const paint = () => {
    // finalize the coalesced text block before any non-text event
    if (ev && ev.type !== "text_delta") flushTextRender();
    // the same for the reasoning block: a non-reasoning event is the end of that
    // stream, so the char counter has to land on its final value in this frame —
    // before the next block takes the tail (step_start drops the block outright).
    if (ev && ev.type !== "reasoning_delta") flushThinkingRender();
    // events that break a tool group; results follow their own tool_calls
    if (["user_message", "text_delta", "reasoning_delta", "final", "step_start"].includes(ev.type)) {
      state.toolGroupEl = null;
    }
    if (applyStreamEvent(ev)) return;

    const el = renderEvent(ev);
    if (el) {
      // the record's own byte offset rides on the row: it is what the roll-back
      // gesture on a task row addresses (task-rollback.ts), and the server's
      // journal is keyed by exactly this number
      if (wireOffset !== null && !pageSink) el.dataset.offset = String(wireOffset);
      (pageSink || eventsEl).appendChild(el);
      // user tasks render markdown too; replay hits this path as well.
      // NOTE: className is "event user" (two tokens) — classList.contains("event.user")
      // would be a single-token lookup and ALWAYS false (live math never typeset);
      // use CSS selector semantics like the replay path's ".event.user .body".
      if (el.matches(".event.user")) highlightCode(el);
      // user tasks may carry LaTeX; live path only (replay batches it after insertion)
      if (el.matches(".event.user") && !pageSink) typesetMath(el);
      autoScroll();
    }
  };
  if (catchUp && !pageSink) {
    state.owedRecords.push(paint);
    return;
  }
  paint();
}

// the live event layer: every event type whose handling depends on streaming
// state — coalesced text/thinking buffers, the live compaction block, retry
// chips, tool-call grouping, plus the durable renders that coordinate that
// state (compaction, assistant_message, final). Returns true when the event is
// fully handled; false means "plain durable render" and addEvent falls through
// to renderEvent() (user_message, tool_result, state_update, permission_request,
// step_start — which only resets the stream blocks above — and unknown types).
export function applyStreamEvent(ev) {
  if (ev.type === "tool_started") {
    // the call is being ENTERED now: the one anchor a countdown may count from
    // (its durable record was written before the calls ahead of it ran)
    noteToolStarted(ev);
    return true;
  }
  if (ev.type === "compaction_delta") {
    // live progress of an in-flight compaction (transient, not stored)
    if (ev.done) {
      if (state.compactionEl) { state.compactionEl.remove(); state.compactionEl = null; }
      clearRetryNote();
      return true;
    }
    if (!state.compactionEl) {
      state.compactionEl = document.createElement("div");
      state.compactionEl.className = "event compaction live";
      state.compactionEl.innerHTML = '<div class="hdr">compressing context</div>';
      const p = document.createElement("p");
      p.className = "body muted";
      state.compactionEl.appendChild(p);
      (pageSink || eventsEl).appendChild(state.compactionEl);
    }
    // a note (e.g. the summary stream dropped and is retrying) overrides the counter
    state.compactionEl.querySelector("p").textContent = ev.note
      ? ev.note
      : ev.chars > 0
        ? `summarizing earlier turns… ${ev.chars} chars streamed`
        : "compressing context — rolling earlier turns into a summary…";
    autoScroll();
    return true;
  }
  if (ev.type === "llm_retry") {
    // transient: an LLM stream attempt failed; the client is reconnecting with
    // backoff (never stored; the next delta removes the chip). discard=true
    // means the dead attempt had already streamed part of this turn: everything
    // it drew goes before the retried answer starts drawing (discardLivePartial,
    // which is the only thing in this file that takes a block off the page).
    if (ev.discard) discardLivePartial();
    setRetryNote(ev);
    return true;
  }
  if (ev.type === "compaction") {
    // the durable compaction record: replace the live block with the final notice
    if (state.compactionEl) { state.compactionEl.remove(); state.compactionEl = null; }
    const el = document.createElement("div");
    el.className = "event compaction";
    el.innerHTML = '<div class="hdr">context compressed</div>';
    const p = document.createElement("p");
    p.className = "body muted";
    const summary = (ev.summary || "").trim();
    p.textContent = summary
      ? "Earlier turns were rolled into a " + summary.length + "-char summary to fit the context window."
      : "The conversation was compacted to fit the context window.";
    el.appendChild(p);
    (pageSink || eventsEl).appendChild(el);
    autoScroll();
    return true;
  }
  if (ev.type === "assistant_message") {
    state.toolGroupEl = null;
    const live = state.lastTextEl && state.lastTextEl.isConnected ? state.lastTextEl : null;
    // The record of a step EXTENDS the text its deltas streamed — and the two
    // feeds into addEvent are unordered, so it can land between two of them.
    // Adopting it in place is what keeps one answer one block: the block keeps its
    // node, its position and its scroll, and a block a cut closed inside this step
    // is completed here, whole.
    if (live && ev.content && ev.content.startsWith(state.lastTextContent || "")) {
      completeRecord(live, ev.content);
      rememberRecord(live, ev.content);
      return true;
    }
    // ...or a block a cut closed whose record lagged behind the step that came
    // after it (the feeds are unordered by a whole step, not only by a delta): the
    // record fills that block in place and takes nothing from the step speaking now
    const owed = awaitingFor(ev.content);
    if (owed) {
      completeRecord(owed.el, ev.content);
      rememberRecord(owed.el, ev.content);
      autoScroll();
      return true;
    }
    // thinking renders above the agent text; skip if a live reasoning stream already
    // rendered this turn
    if (ev.reasoning && !(state.thinkingEl && state.thinkingEl.isConnected)) appendThinkingRow(ev.reasoning);
    // A block of its own: the record of a step whose block this pane does not hold
    // — a stored session (no deltas at all), a replayed transcript, or a step whose
    // text went with a pane that was away. Each record is drawn once (addEvent's
    // watermark), so this is never a second copy of a block already on the page.
    if (ev.content) {
      const wrap = createAgentTextBlock();
      wrap.querySelector(".body").innerHTML = renderMarkdown(ev.content);
      highlightCode(wrap);
      // A step still streaming below it began after this record was written, so the
      // record's block goes above it: the page reads in the log's own order. (A
      // paging pass has no live block at all — project.ts renders pages into a sink.)
      //
      // A block is that anchor in exactly two shapes. STILL BEING FED (unsealed): a
      // step that began after this record is speaking, and its rows may already be on
      // the page below it, so the block's position is not its own row count. Or
      // CLOSED and still the last row: a cut closed the step in flight a moment ago
      // and this record is the step before it.
      //
      // A CLOSED block with rows painted after it is neither: the page has moved
      // past it, so this record is newer than every row on the page and belongs at
      // the tail. That is exactly what a restored tab hit — saveDomCache/
      // restoreDomCache put back lastTextEl pointing at a sealed block in the MIDDLE
      // of the cached transcript (the block the run was typing into when the tab was
      // left; dropOrphanLive seals it on the way back), and then every replayed
      // record whose text did not start with that block's went above it: the run's
      // closing answer ("The GRU training converged…", the step after the one the
      // pane was left on) landed ABOVE the steps that produced it, so the reopened
      // .clc read as answer-first-then-work — and its tail, which no answer ever
      // reached, ended on tool rows and a raw call tag the model had typed as text
      // instead of calling the tool. The log's order was never in doubt: its records
      // are monotonic in offset, and the pane was the thing that reordered them.
      const anchor = live && (!state.textSealed || live === eventsEl.lastElementChild) ? live : null;
      if (anchor) eventsEl.insertBefore(wrap, anchor);
      else (pageSink || eventsEl).appendChild(wrap);
      // The record's text is final, so its math is typeset HERE: this block has no
      // delta to defer to and no completing record behind it — a stored session, a
      // replayed transcript, a reconnect's catch-up, a step whose text went with a
      // pane that was away. The live pass that typesets is the STREAMING one
      // (stream-text.ts paintTextBlock) and this block never streamed, so without
      // this call the answer's LaTeX stays raw — the reported bare `$\omega$`,
      // `$$\varepsilon …$$` at the tail of a tab that had just been restored. The
      // markdown pass is not the problem: it protects every $…$ pair (⟦MATHn⟧,
      // render-events.ts renderMarkdown) and MathJax renders the text whole.
      // A paging sink is skipped: the history page typesets its own blocks once
      // they are in the pane (project.ts loadOlder).
      if (!pageSink) typesetMath(wrap);
      rememberRecord(wrap, ev.content); // the block a following final completes
    }
    return true;
  }
  if (ev.type === "final") {
    // the run is over: dismiss any stale permission prompt
    if (pendingPerm) closePerm();
    // ...and forget the answers it collected: an id belongs to one run, and this
    // one can never ask again (see forgetAnsweredPerm)
    forgetAnsweredPerm();
    // the run is over: no call is waiting any more, so no meter keeps counting
    // one (a call aborted by Stop never gets a result to settle it)
    settleAllCountdowns();
    clearStreamPreviews(); // an aborted turn may have left half-streamed calls
    clearRetryNote(); // a lost stream that never recovered leaves no chip behind
    // The divider below says "completed" and nothing else (render-events.ts
    // appendCompletion), so the answer it closes has to be on the page already.
    // It is — unless the pane never had it, and the log's replay starts at this
    // window's watermark, so no record will be re-delivered to draw it. The final
    // itself carries that text (run-state.ts foldRun closes a turn by writing its
    // last assistant_message as the completed summary), so it is the one record
    // that can put the answer back where the block would have been.
    if (!pageSink && !catchUp && ev.status === "completed" && String(ev.summary || "").trim()) {
      const want = String(ev.summary || "");
      const live = state.lastTextEl && state.lastTextEl.isConnected ? state.lastTextEl : null;
      if (live && want.startsWith(state.lastTextContent || "")) {
        // the block on the page is this answer's, whole or cut short by an outage:
        // write the answer into it and close it, never a second copy under the first
        completeRecord(live, want);
        rememberRecord(live, want);
      } else {
        const owed = awaitingFor(want);
        // ...or the record itself already put the answer on the page. A stored
        // session, a replayed transcript and a tail a restored tab rebuilt paint
        // RECORDS only: the step's assistant_message drew a block of its own, and
        // this final repeats exactly that text (run-state.ts foldRun) — so the
        // final completes the block the record drew. A block of its own here is the
        // reported one answer twice, under two `agent` headers.
        const recorded =
          state.lastRecordEl &&
          state.lastRecordEl.isConnected &&
          state.lastRecordText &&
          want.startsWith(state.lastRecordText)
            ? state.lastRecordEl
            : null;
        if (owed) {
          // the step's record never landed: the block a cut closed is the one this
          // final completes, in place and whole
          completeRecord(owed.el, want);
          autoScroll();
        } else if (recorded) {
          // nothing of the answer is missing: the record's block is completed where
          // the record left it, above the divider, in one copy. The pointer goes
          // with it, as in the branch above: the answer is whole, and a delta still
          // in flight for this step must not open a second block under it
          state.lastTextEl = recorded;
          completeRecord(recorded, want);
          rememberRecord(recorded, want);
          autoScroll();
        } else {
          // nothing of the answer is on the page: draw it above the divider, and
          // hand the pointer over so a straggling delta cannot open a second one
          const wrap = createAgentTextBlock();
          (pageSink || eventsEl).appendChild(wrap);
          state.lastTextEl = wrap;
          completeRecord(wrap, want);
          rememberRecord(wrap, want);
          autoScroll();
        }
      }
    }
    // fences may have closed since the last delta: one final render pass
    if (state.lastTextEl && state.lastTextEl.isConnected) highlightCode(state.lastTextEl);
    // completion divider; for non-completed runs the summary carries the reason
    appendCompletion(ev.status, ev.summary);
    refreshTree(); // a run finished; reflect any new files in the tree
    // the task is over: fold its middle away, leaving the opening task and this
    // closing record (auto-fold.ts). The head of the fold re-opens it.
    autoFoldTurn();
    // ...and this task's file changes are in the rollback journal now, so re-read
    // the anchors: without this a long-press on the message would be answered
    // from the set fetched when the project opened (task-rollback.ts)
    if (!pageSink) refreshRollbackAnchors();
    return true;
  }
  if (ev.type === "tool_call" && ev.tool_call_id) {
    let args = {};
    // the server forwards the model's raw argument string: if it is not JSON, the
    // call must not silently render with no arguments at all
    try { args = JSON.parse(ev.arguments || "{}"); } catch (e) { console.warn("[tool] arguments are not JSON", e); }
    toolCalls[ev.tool_call_id] = { name: ev.name, args, ui: ev.ui || {} };
    const st = streamRows[ev.tool_call_id];
    if (st) {
      // the call finished: the live row settles to its final form in place —
      // chip and args expander, the preview body gone
      st.row.classList.remove("stream");
      const preview = st.row.querySelector(".stream-pre");
      if (preview) preview.remove();
      const dots = st.row.querySelector(".muted");
      if (dots) dots.remove();
      const ui = uiOf(ev);
      const meter = countdownMeter(ui, ev);
      if (meter) st.row.appendChild(meter);
      st.row.appendChild(argsButton(ev.arguments, ui));
      st.body = null;
      streamRows[ev.tool_call_id] = undefined;
      autoScroll();
    } else {
      addToolCallRow(ev); // replay (no deltas) renders the final row directly
    }
    return true;
  }
  if (ev.type === "tool_call_delta" && ev.tool_call_id) {
    clearRetryNote(); // args are flowing again: the reconnect landed
    handleToolCallDelta(ev);
    return true;
  }

  // the call is over: its row stops counting down — the result row says how the
  // wait ended, and a finished call must never keep a clock running
  if (ev.type === "tool_result" && ev.tool_call_id) settleCountdown(ev.tool_call_id);

  // a row-form result lands beside its call, in the block their calls collect
  // in; every other result is its own block after the calls (renderEvent)
  if (ev.type === "tool_result" && toolCalls[ev.tool_call_id]) {
    const call = toolCalls[ev.tool_call_id];
    const ui = uiOfResult(ev);
    const group = ui.group ? toolCallGroups.get(ev.tool_call_id) : null;
    if (group && ui.form === "row") {
      appendResultRow(group, ui, call, ev);
      group.closed = true; // this group's calls have completed
      return true;
    }
  }

  // accumulate text and render once per frame (a full re-parse per token is O(n²))
  if (ev.type === "text_delta" && ev.content) {
    clearRetryNote(); // text is flowing again: the reconnect landed
    // A closed block takes no more deltas: either they are text the block already
    // says (its record wrote it whole) or they are the text after a gap no delta
    // can fill (a cut closed the block). Appending either would repeat or misplace
    // it, and opening a block of its own is the mid-sentence answer itself.
    // step_start opens the seal: the next step's text starts a block.
    if (state.textSealed) return true;
    if (!state.lastTextEl) {
      state.lastTextEl = createAgentTextBlock();
      (pageSink || eventsEl).appendChild(state.lastTextEl);
    }
    state.lastTextContent += ev.content;
    scheduleTextRender();
    return true;
  }

  // streaming reasoning: compact row while streaming, expandable on click
  if (ev.type === "reasoning_delta" && ev.content) {
    clearRetryNote(); // thinking is flowing again: the reconnect landed
    state.thinkingContent += ev.content;
    if (!state.thinkingEl) {
      const block = buildThinkingBlock("", "");
      state.thinkingEl = block.el;
      (pageSink || eventsEl).appendChild(state.thinkingEl);
    }
    // NOTHING is written to the DOM here: a delta per token means the label's
    // width, the block's own copy and autoScroll's `scrollHeight` read would each
    // pay a forced layout thousands of times over a long think — the freeze this
    // shape was reported as. The coalesced render (stream-text.ts) does one pass
    // per frame, and flushThinkingRender() fixes the counter on the last one.
    scheduleThinkingRender();
    return true;
  }

  if (ev.type === "step_start") {
    // a new LLM turn begins: reset the streaming blocks (and any stale chip);
    // nothing to draw itself — step_start falls through to renderEvent (no case,
    // so no node) after the reset
    state.lastTextEl = null;
    state.lastTextContent = "";
    state.textSealed = false; // a new step's deltas are its own text, not the last one's
    state.thinkingEl = null;
    state.thinkingContent = "";
    clearRetryNote();
  }

  return false;
}

