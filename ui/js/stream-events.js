// the event pipeline — live call previews, the event sink, applyStreamEvent
//
// `addEvent` is the one entry every host event goes through, `applyStreamEvent`
// routes the streaming deltas, and the preview helpers keep a call row honest while
// its arguments are still arriving.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// live tool-call previews: callId -> {name, ui, text, row, body, group}; the
// declaration decides what the row shows while the call is generated
const streamRows = {};

function handleToolCallDelta(ev) {
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
function clearStreamPreviews() {
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
function discardLivePartial() {
  if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
  if (lastTextEl) { lastTextEl.remove(); lastTextEl = null; }
  lastTextContent = "";
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  thinkingContent = "";
  clearStreamPreviews();
}

// The same teardown, asked for by the WINDOW's own socket instead of by a
// `discard` notice: a reconnect (js/sse-stream.js es.onopen) restarts the
// streaming state, and the attempt whose deltas it can no longer receive is as
// dead to this view as a retried one is — a delta is never stored (agent/events.py
// keeps finals), so the window cannot continue that block, only abandon it. The
// agent's own answer to the same failure is to reissue the request and re-stream
// the turn from its start, and the log replays whatever this window never painted;
// both draw the turn again, complete.
//
// Keeping the nodes instead is the reported freeze: "thinking… 412 chars" left on
// screen for good under a run that is no longer thinking, a second live block
// opening beside it, and the turn's own assistant_message rendering a duplicate
// of the text under the stale first half.
function dropOrphanLive() {
  discardLivePartial();
  toolGroupEl = null;
  clearRetryNote(); // a reconnect may have skipped the event that would clear it
}

// transient "connection lost — retrying…" chip. Shown when an LLM stream
// attempt fails (network drop / read timeout) and the client reconnects with
// backoff; removed as soon as new tokens arrive, the compaction clears, or the
// run ends — so the UI never looks frozen.
function setRetryNote(ev) {
  if (retryNoteEl) retryNoteEl.remove();
  retryNoteEl = document.createElement("div");
  retryNoteEl.className = "event llm-note live";
  const p = document.createElement("p");
  p.className = "body";
  const fallback = `connection lost — retrying (${ev.attempt}/${ev.max_retries || "…"})`;
  p.textContent = "⚠ " + (ev.message || fallback);
  retryNoteEl.appendChild(p);
  (pageSink || eventsEl).appendChild(retryNoteEl);
  autoScroll();
}

function clearRetryNote() {
  if (retryNoteEl) {
    retryNoteEl.remove();
    retryNoteEl = null;
  }
}

// ---- the run-settled ledger, and the one announcement that reads it ----
//
// The ledger itself (sseRunLostPending / runSettled, declared in js/sse-stream.js
// beside sseRunAtRisk) is written in exactly one place, because a run has one
// shape here: a task opens it and a `final` closes it, live or replayed, and both
// walk addEvent. What the window says about a run it lost is the transcript's
// business — a run must not end without a record of it, and a toast that
// dismisses itself leaves none.
function announceRunLost() {
  sseRunLostPending = false; // asked once, answered once
  if (runSettled) return; // the log already ended this run: never a second ending
  // the shape the local failed run uses (js/render-events.js run): the
  // completion divider exists for exactly this, and it is durable, re-readable,
  // and impossible to miss on a phone nobody was holding
  addEvent({ type: "final", status: "error", summary: SSE_RUN_LOST });
}

function addEvent(ev) {
  // lazy wire shape: {offset, event} carries each durable event's byte offset
  // so the UI can page the earlier records
  if (ev && typeof ev === "object" && ev.event && typeof ev.offset === "number") {
    // Replay HEALS, it does not re-render. A reconnecting stream replays the log
    // from its window start, so every event this window already painted arrives
    // again (the transcript visibly doubled after a reconnect). Offsets are the
    // log's own monotonic byte positions inside the .clc (agent/core/lazy.py),
    // so a record at or below the highest one already rendered is one of those.
    // The history paging path (pageSink) walks BACKWARDS through older records
    // on purpose and is exempt: it never moves this watermark.
    if (!pageSink) {
      if (streamHighOffset !== null && ev.offset <= streamHighOffset) return;
      streamHighOffset = Math.max(streamHighOffset === null ? 0 : streamHighOffset, ev.offset);
    }
    if (ev.offset > 0) oldestOffset = oldestOffset === null ? ev.offset : Math.min(oldestOffset, ev.offset);
    ev = ev.event;
  }
  // the ledger behind announceRunLost, above: a task opens a run, a final closes
  // it — whichever way the record arrived
  if (ev && ev.type === "user_message") {
    // A task the user starts now closes the question a released run left open
    // (the session never served the window the log that would have answered it):
    // the window has moved on, and the loss belongs ABOVE the new task's row, as
    // the record of what happened to the run before it.
    if (sseRunLostPending) announceRunLost();
    runSettled = false;
    // a task opens a NEW run: every ask id the run before it handed out is dead
    forgetAnsweredPerm();
  } else if (ev && ev.type === "final") {
    runSettled = true;
  }
  // reconnect history line: restore the honest on-disk older count. It also
  // OPENS the catch-up block: everything until the `replayed` frame is a record
  // this window is owed, and the view must not chase each one (js/stream-view.js).
  if (ev && ev.type === "history") {
    setOlderPill(ev.older || 0);
    beginCatchUp();
    return;
  }
  // the catch-up is over: the view follows again, with a single move
  if (ev && ev.type === "replayed") {
    endCatchUp();
    // The block that just closed is the log's whole answer to the question the
    // status frame asked (sse-stream.js sseRunLostPending): a final inside it
    // ended the run and said so — the departing session writes one when it is
    // released mid-run (agent/server.py record_release) — and its absence is the
    // window's own ending to state. Only the `replayed` frame can tell the two
    // apart, which is why the flag waits for it and never guesses earlier.
    if (sseRunLostPending) announceRunLost();
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
  // events that break a tool group; results follow their own tool_calls
  if (["user_message", "text_delta", "reasoning_delta", "final", "step_start"].includes(ev.type)) {
    toolGroupEl = null;
  }
  if (applyStreamEvent(ev)) return;

  const el = renderEvent(ev);
  if (el) {
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
function applyStreamEvent(ev) {
  if (ev.type === "compaction_delta") {
    // live progress of an in-flight compaction (transient, not stored)
    if (ev.done) {
      if (compactionEl) { compactionEl.remove(); compactionEl = null; }
      clearRetryNote();
      return true;
    }
    if (!compactionEl) {
      compactionEl = document.createElement("div");
      compactionEl.className = "event compaction live";
      compactionEl.innerHTML = '<div class="hdr">compressing context</div>';
      const p = document.createElement("p");
      p.className = "body muted";
      compactionEl.appendChild(p);
      (pageSink || eventsEl).appendChild(compactionEl);
    }
    // a note (e.g. the summary stream dropped and is retrying) overrides the counter
    compactionEl.querySelector("p").textContent = ev.note
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
    if (compactionEl) { compactionEl.remove(); compactionEl = null; }
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
    toolGroupEl = null;
    // stored sessions render the final message once (no delta stream)
    if (lastTextEl && lastTextEl.isConnected) {
      lastTextEl = null;
      lastTextContent = "";
      return true;
    }
    // thinking renders above the agent text; skip if a live reasoning stream already
    // rendered this turn
    if (ev.reasoning && !(thinkingEl && thinkingEl.isConnected)) appendThinkingRow(ev.reasoning);
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
    // fences may have closed since the last delta: one final render pass
    if (lastTextEl && lastTextEl.isConnected) highlightCode(lastTextEl);
    // completion divider; for non-completed runs the summary carries the reason
    appendCompletion(ev.status, ev.summary);
    refreshTree(); // a run finished; reflect any new files in the tree
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
    if (!lastTextEl) {
      lastTextEl = createAgentTextBlock();
      (pageSink || eventsEl).appendChild(lastTextEl);
    }
    lastTextContent += ev.content;
    scheduleTextRender();
    return true;
  }

  // streaming reasoning: compact row while streaming, expandable on click
  if (ev.type === "reasoning_delta" && ev.content) {
    clearRetryNote(); // thinking is flowing again: the reconnect landed
    thinkingContent += ev.content;
    if (!thinkingEl) {
      const block = buildThinkingBlock("", "");
      thinkingEl = block.el;
      (pageSink || eventsEl).appendChild(thinkingEl);
    }
    thinkingEl.querySelector(".thinking-label").textContent =
      "thinking… " + thinkingContent.length + " chars";
    // keep the block's own copy in sync; update it live if the full text is open
    const full = thinkingEl.querySelector(".thinking-full");
    full._content = thinkingContent;
    const fold = thinkingEl.querySelector(".fold");
    if (fold && !fold.classList.contains("hidden")) full.textContent = full._content;
    autoScroll();
    return true;
  }

  if (ev.type === "step_start") {
    // a new LLM turn begins: reset the streaming blocks (and any stale chip);
    // nothing to draw itself — step_start falls through to renderEvent (no case,
    // so no node) after the reset
    lastTextEl = null;
    lastTextContent = "";
    thinkingEl = null;
    thinkingContent = "";
    clearRetryNote();
  }

  return false;
}

