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
import { highlightCode, typesetMath } from "./markdown";
import { closePerm, forgetAnsweredPerm, pendingPerm } from "./permissions";
import { clearStream, pageSink, setOlderPill } from "./project";
import { appendCompletion, renderEvent, renderMarkdown } from "./render-events";
import { SSE_RUN_LOST } from "./sse-stream";
import { state } from "./state";
import {
  appendThinkingRow, buildThinkingBlock, createAgentTextBlock,
  flushTextRender, flushThinkingRender, paintTextBlock, scheduleTextRender,
  scheduleThinkingRender,
} from "./stream-text";
import { eventsEl, stream } from "./els";
import {
  autoScroll, beginCatchUp, catchUp, endCatchUp, toolCallGroups, toolCalls,
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
    // text is on the log, so it is not this run's answer and no record of this run
    // may be mistaken for a continuation of it. A task queued INTO the run now
    // writing leaves the streaming block alone — that step has not finished, and
    // its next delta belongs to the block already on the page.
    if (state.textSealed) {
      state.lastTextEl = null;
      state.lastTextContent = "";
      state.textSealed = false;
    }
    // ...and no block of that run is still owed a record: its records are in the
    // log AHEAD of this message, so every one of them has already had its chance
    // to arrive — an entry left here could only be matched by a later run's text
    awaiting.length = 0;
    // ...and every ask id the run before it handed out is dead
    forgetAnsweredPerm();
  } else if (ev && ev.type === "final") {
    state.runSettled = true;
  }
  // reconnect history line: restore the honest on-disk older count. It also
  // OPENS the catch-up block: everything until the `replayed` frame is a record
  // this window is owed, and the view must not chase each one (stream-view.ts).
  if (ev && ev.type === "history") {
    setOlderPill(ev.older || 0);
    beginCatchUp();
    return;
  }
  // the catch-up is over: the view follows again, with a single move
  if (ev && ev.type === "replayed") {
    // ...and the block is IN the pane first: the batches addEvent held are
    // painted here, in order, because endCatchUp's one scroll has to land on
    // the real tail — not on a transcript that is still queued (a batch timer
    // would fire after the scroll and leave the view above its own ending).
    if (state.owedFlush) {
      clearTimeout(state.owedFlush);
      state.owedFlush = 0;
    }
    while (state.owedRecords.length) {
      const row = state.owedRecords.shift();
      if (row) row();
    }
    endCatchUp();
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
  // replayed status frames must not drive the live UI — but a LIVE permission
  // prompt is never a replay, and dropping it is how a run wedges: this frame is
  // host-made and never persisted (agent/events.py DURABLE_TYPES has no
  // permission_request), so it can only be the ask a blocked run is waiting on.
  // While the pane was "loading" (the /api/project/open reconstruction, whose
  // reader may never finish) such a frame was discarded and the prompt never
  // appeared — the run then waits with no dialog to answer it.
  if (stream.classList.contains("loading") && ev.type === "state_update") {
    return;
  }
  // ---- the catch-up block: paint in batches, not one SSE frame at a time ----
  //
  // Everything below is DOM work. While a catch-up is open (`history` …
  // `replayed`, stream-view.ts) the records arriving are the block the window
  // was owed, and a tunnel delivers each SSE frame in its own chunk: painting
  // per frame is a paint per record, so the transcript visibly assembled itself
  // row by row in many small bursts the moment the load card went (the reported
  // "a pile of messages loads itself at once"). Loopback hid it — the same block
  // arrives in one read and lands in one paint. So the work is held as thunks
  // and run together on a short timer: one batch is one frame's worth of rows
  // whatever the wire did, and `replayed` drains what is left BEFORE the view
  // follows again (the rows have to be in the pane when endCatchUp scrolls).
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
    if (!state.owedFlush) {
      // One flush per tick covers every record that arrived since the last one.
      // 40ms is short enough that no reader can see the batch and long enough
      // that a tunnel's worth of frames lands inside one (~25 paints a second,
      // against one per record before).
      state.owedFlush = setTimeout(() => {
        state.owedFlush = 0;
        const batch = state.owedRecords.splice(0, state.owedRecords.length);
        for (const row of batch) row();
      }, 40);
    }
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
      return true;
    }
    // ...or a block a cut closed whose record lagged behind the step that came
    // after it (the feeds are unordered by a whole step, not only by a delta): the
    // record fills that block in place and takes nothing from the step speaking now
    const owed = awaitingFor(ev.content);
    if (owed) {
      completeRecord(owed.el, ev.content);
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
      if (live) eventsEl.insertBefore(wrap, live);
      else (pageSink || eventsEl).appendChild(wrap);
    }
    return true;
  }
  if (ev.type === "final") {
    // the run is over: dismiss any stale permission prompt
    if (pendingPerm) closePerm();
    // ...and forget the answers it collected: an id belongs to one run, and this
    // one can never ask again (see forgetAnsweredPerm)
    forgetAnsweredPerm();
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
      } else {
        const owed = awaitingFor(want);
        if (owed) {
          // the step's record never landed: the block a cut closed is the one this
          // final completes, in place and whole
          completeRecord(owed.el, want);
          autoScroll();
        } else {
          // nothing of the answer is on the page: draw it above the divider, and
          // hand the pointer over so a straggling delta cannot open a second one
          const wrap = createAgentTextBlock();
          (pageSink || eventsEl).appendChild(wrap);
          state.lastTextEl = wrap;
          completeRecord(wrap, want);
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
      st.row.appendChild(argsButton(ev.arguments, uiOf(ev)));
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

