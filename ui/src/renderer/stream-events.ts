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
  flushTextRender, flushThinkingRender, renderTextBlock, scheduleTextRender,
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
// `keepText` is the one exception, and it is not a retry: a block that holds a
// durable assistant_message's text (textSealed) or that of a run already closed
// (runSettled) is the log's own copy of an answer, not a partial. A reconnect
// must still release the pointer — a record the outage made this window miss has
// to be able to open its own block — but it must not delete what the log says.
export function discardLivePartial(keepText = false) {
  if (state.textRenderRaf) { cancelAnimationFrame(state.textRenderRaf); state.textRenderRaf = 0; }
  if (state.thinkingRenderRaf) { cancelAnimationFrame(state.thinkingRenderRaf); state.thinkingRenderRaf = 0; }
  if (state.lastTextEl) { if (!keepText) state.lastTextEl.remove(); state.lastTextEl = null; }
  state.lastTextContent = "";
  state.textSealed = false; // the block that held the durable text is gone
  if (state.thinkingEl) { state.thinkingEl.remove(); state.thinkingEl = null; }
  state.thinkingContent = "";
  clearStreamPreviews();
}

// The same teardown, asked for by the WINDOW's own socket instead of by a
// `discard` notice: a reconnect (sse-stream.ts es.onopen) restarts the streaming
// state, and an UNFINISHED block is as dead to this view as a retried one is — a
// delta is never stored (agent/events.py keeps finals), so the window cannot
// continue that block, only abandon it. The agent's own answer to the same
// failure is to reissue the request and re-stream the turn from its start, and
// the log replays whatever this window never painted; both draw the turn again,
// complete.
//
// Keeping an unfinished block instead is the reported freeze: "thinking… 412
// chars" left on screen for good under a run that is no longer thinking, a
// second live block opening beside it, and the turn's own assistant_message
// rendering a duplicate of the text under the stale first half. But the rule is
// about the DELTAS, not the block: once a step's durable record has adopted the
// text (textSealed) or the run's final has landed (runSettled), there is no
// delta this window is owed — only a record it already painted. Dropping that
// node is the other reported loss, an answer the log has and the pane does not.
//
// So a KEPT block is remembered here (carriedTextEl/carriedText): the live
// pointer is still released below, but the run's `final` can then recognise its
// own answer already on the page instead of painting a second copy of it.
let carriedTextEl = null;
let carriedText = "";

export function dropOrphanLive() {
  // A sealed block (its step's assistant_message adopted its text) or one that
  // belongs to a run already closed (its final landed) is NOT a partial. The
  // deltas it might still be owed are never stored, and the record that drew it
  // is never re-delivered — addEvent's watermark drops every replay at or below
  // what this window has already painted — so removing the node is a permanent
  // loss: the pane ends at a `completed` divider with the closing prose gone
  // ("git output → completed") while the .clc has held the answer all along.
  // Only an unsealed block mid-step is as dead as a retried one, and only that
  // one may go.
  const keepText = Boolean(state.lastTextEl && state.lastTextEl.isConnected &&
    (state.textSealed || state.runSettled));
  carriedTextEl = keepText ? state.lastTextEl : null;
  carriedText = keepText ? (state.lastTextContent || "") : "";
  discardLivePartial(keepText);
  // the pointer is released either way (a record the outage made this window miss
  // has to be able to open its own block); the seal still says the step's deltas
  // would only repeat what the kept block already shows
  if (keepText) state.textSealed = true;
  state.toolGroupEl = null;
  clearRetryNote(); // a reconnect may have skipped the event that would clear it
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
    // a task opens a NEW run: nothing of the run before it may keep collecting
    // text — its durable copy is on the log and its block is final (stream-events'
    // assistant_message seals a block once it holds the record)
    state.textSealed = false;
    // ...and a block a reconnect carried out of that run is not this run's answer
    carriedTextEl = null;
    carriedText = "";
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
    // means the dead attempt had already streamed part of this turn: drop the
    // live partial before the retried answer starts drawing
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
    // Stored sessions render the final message once (no delta stream). The LIVE
    // case is not that simple: this record rides the log's own feed (POST
    // /api/log → broadcast → SSE) while its step's deltas ride the run's IPC
    // feed, and the two are unordered — the record can land between two deltas
    // of its own step. Dropping the pointer there (what this did) left the
    // block holding the text up to its last delta and let the leftover tail
    // open a SECOND block underneath: one answer painted as two, its closing
    // sentence cut in half ("…所以我没替你" / "改 App 的安装目录。").
    if (state.lastTextEl && state.lastTextEl.isConnected) {
      const live = state.lastTextContent || "";
      // the record is that step's complete text and it EXTENDS what the block
      // streamed: adopt it in place — the block keeps its node, its position and
      // its scroll — and seal it, because the deltas still in flight for this
      // step are the text it already says. A later step_start opens a new block
      // (and clears the seal); a delta cannot, while this one is sealed.
      if (ev.content && ev.content.startsWith(live)) {
        state.lastTextContent = ev.content;
        state.textSealed = true;
        renderTextBlock(true);
        return true;
      }
      // not this step's text at all (this record arrived after the NEXT step had
      // opened its block — the same two feeds, lagging by a whole step): leave
      // that block to its own deltas and stop owning this one, as before
      state.lastTextEl = null;
      state.lastTextContent = "";
      return true;
    }
    // thinking renders above the agent text; skip if a live reasoning stream already
    // rendered this turn
    if (ev.reasoning && !(state.thinkingEl && state.thinkingEl.isConnected)) appendThinkingRow(ev.reasoning);
    if (ev.content) {
      const wrap = createAgentTextBlock();
      wrap.querySelector(".body").innerHTML = renderMarkdown(ev.content);
      highlightCode(wrap);
      (pageSink || eventsEl).appendChild(wrap);
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
    // It is — unless something took the block off (dropOrphanLive's discard, a
    // replayed pane, a step the outage swallowed), and the log's replay starts at
    // this window's watermark, so the assistant_message that drew it is never
    // re-delivered. That is the reported ending: "git output → completed", the
    // closing prose gone, while the .clc holds it. The final carries that text
    // itself (run-state.ts foldRun closes a turn by writing its last
    // assistant_message as the completed summary), so this is the one record that
    // can put the answer back — and the last place that can notice it is missing.
    if (!pageSink && !catchUp && ev.status === "completed" && String(ev.summary || "").trim()) {
      const want = String(ev.summary || "");
      const live = state.lastTextEl && state.lastTextEl.isConnected ? (state.lastTextContent || "") : "";
      if (live) {
        // the block on the page is already drawing this answer (its step's record
        // adopted the same text). Complete it if the outage cut it short, but never
        // paint a second copy: a doubled answer is the other reported bug.
        if (live !== want && want.startsWith(live)) {
          state.lastTextContent = want;
          state.textSealed = true;
          renderTextBlock(true);
        }
      } else if (!(carriedTextEl && carriedTextEl.isConnected && want.startsWith(carriedText))) {
        // no live block owns the answer, and no reconnect kept a copy of it either
        const wrap = createAgentTextBlock();
        wrap.querySelector(".body").innerHTML = renderMarkdown(want);
        highlightCode(wrap);
        (pageSink || eventsEl).appendChild(wrap);
        state.lastTextEl = wrap;
        state.lastTextContent = want;
        state.textSealed = true;
        autoScroll();
      }
    }
    carriedTextEl = null; // the run is over: nothing carries past its final
    carriedText = "";
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
    // This step's durable record already adopted the text (assistant_message
    // above): a delta that arrives afterwards is part of what the block says,
    // so appending it would repeat the tail and opening a block would be the
    // split answer again. The seal is per model step — step_start clears it.
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

