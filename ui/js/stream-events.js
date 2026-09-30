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

function addEvent(ev) {
  // lazy wire shape: {offset, event} carries each durable event's byte offset
  // so the UI can page the earlier records
  if (ev && typeof ev === "object" && ev.event && typeof ev.offset === "number") {
    if (ev.offset > 0) oldestOffset = oldestOffset === null ? ev.offset : Math.min(oldestOffset, ev.offset);
    ev = ev.event;
  }
  // reconnect history line: restore the honest on-disk older count
  if (ev && ev.type === "history") {
    setOlderPill(ev.older || 0);
    return;
  }
  // replayed status/permission events must not drive the live UI
  if (stream.classList.contains("loading") &&
      (ev.type === "state_update" || ev.type === "permission_request")) {
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

