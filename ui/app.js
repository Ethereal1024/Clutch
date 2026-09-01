"use strict";

// Session API base: 8890 is the supervisor's lifecycle port, never a real backend.
let DEFAULT_BASE = "http://127.0.0.1:8890";
let API_BASE = null; // resolved in resolveApiBase() before the app starts

async function resolveApiBase() {
  if (window.clutchApi && window.clutchApi.baseUrl) {
    // null/8890 = session not claimed yet (supervisor mid-spawn); retry
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const b = await window.clutchApi.baseUrl(); // IPC: this window's session port
        const clean = b ? String(b).replace(/\/+$/, "") : "";
        if (clean && clean !== "http://127.0.0.1:8890") {
          API_BASE = clean;
          DEFAULT_BASE = clean;
          return clean;
        }
      } catch {
        /* preload unavailable — plain-browser debugging */
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  // Still unresolved: leave null. 8890 is the supervisor's port (no session
  // API); the main process announces the real URL via backend:base-changed.
  return API_BASE; // null
}

const $ = (s) => document.querySelector(s);

const els = {
  task: $("#task-input"),
  run: $("#run-btn"),
  mode: $("#mode-btn"),
  status: $("#status"),
  stream: $("#stream"),
  tree: $("#tree"),
  workspace: $("#workspace-path"),
  projectLabel: $("#project-label"),
};

// agent mode for the next run: "work" (full tools) | "chat" (read-only); sticky per session
let agentMode = localStorage.getItem("clutch_mode") || "work";

function setMode(mode) {
  agentMode = mode === "chat" ? "chat" : "work";
  localStorage.setItem("clutch_mode", agentMode);
  els.mode.textContent = agentMode;
  els.mode.classList.toggle("chat-mode", agentMode === "chat");
  els.mode.title = agentMode === "chat"
    ? "chat: read-only analysis · click for work mode (full access). Applies to the next run."
    : "work: full access · click for chat mode (read-only analysis). Applies to the next run.";
}

let busy = false;
const stream = $("#stream");
const eventsEl = document.getElementById("events");
const jumpBottom = $("#jump-bottom");

// how far from the bottom the view counts as "following the stream"
const JUMP_BOTTOM_GAP = 80;

function nearBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < JUMP_BOTTOM_GAP;
}

// ↓ button visibility mirrors the latch; all latch paths report through here
function setJumpVisible(visible) {
  jumpBottom.classList.toggle("hidden", !visible);
}

// Latched tail-follow: reaching the bottom (or ↓) pins the view; only a user's
// upward scroll breaks the latch (the ↓ button returns to the tail).
let followTail = true;
let lastScrollTop = 0;

let gliding = false;
let glideRaf = 0;

function autoScroll(force) {
  if (stream.classList.contains("loading")) return;
  if (force) {
    // User-initiated jump (message send, ↓, Cmd/Ctrl+Down): tracked = instant pin,
    // untracked = the one smooth glide that re-latches on arrival.
    if (followTail) {
      if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
      gliding = false;
      stream.scrollTop = stream.scrollHeight;
      setJumpVisible(false);
    } else {
      glideToBottom();
    }
    return;
  }
  if (followTail) {
    // tracked: instant pin — never during a user jump-glide (untracked ↓)
    if (gliding) return;
    stream.scrollTop = stream.scrollHeight;
    setJumpVisible(false);
  } else {
    // untracked: content growth never moves the view; only the ↓ glide may
    setJumpVisible(true);
  }
}

// ---- jump-to-bottom glide (user-initiated only) ----
// scrollTo glides to the tail captured at call time; a rAF poll detects the
// landing and re-pins to absorb growth that arrived mid-glide.
function glideToBottom() {
  if (stream.classList.contains("loading")) return;
  cancelAnimationFrame(glideRaf);
  const target = stream.scrollHeight;
  if (stream.scrollTop >= target - 1) {
    // already at the tail: land straight into the latch
    gliding = false;
    followTail = true;
    setJumpVisible(false);
    return;
  }
  gliding = true;
  if (reducedMotion()) {
    stream.scrollTop = stream.scrollHeight;
    gliding = false;
    followTail = true;
    setJumpVisible(false);
    return;
  }
  stream.scrollTo({ top: target, behavior: "smooth" });
  const finish = () => {
    const bottom = stream.scrollHeight - stream.clientHeight;
    if (!gliding || Math.abs(stream.scrollTop - target) < 2 || Math.abs(stream.scrollTop - bottom) < 2) {
      gliding = false;
      // landed (or clamped to a new bottom): re-latch
      followTail = true;
      setJumpVisible(false);
      if (!stream.classList.contains("loading")) {
        stream.scrollTop = stream.scrollHeight; // absorb growth that arrived mid-glide
      }
      return;
    }
    glideRaf = requestAnimationFrame(finish);
  };
  glideRaf = requestAnimationFrame(finish);
}

// Async layout growth (fonts, images, math) can land after autoScroll: watch the
// CONTENT's height (never the viewport) and re-pin while latched.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (followTail && !stream.classList.contains("loading")) autoScroll();
  }).observe(eventsEl);
}

jumpBottom.addEventListener("click", () => {
  // autoScroll(force) decides: instant pin when tracked, smooth glide when untracked
  autoScroll(true);
});
// Cmd/Ctrl+Down anywhere: same jump-to-tail as the ↓ button
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
    autoScroll(true);
  }
});
let prevClientH = stream.clientHeight;
let prevScrollH = stream.scrollHeight;
// ignore latch changes ~120ms after the input box resizes: the clamp scroll
// event can fire before the shrunken viewport is observable
let suppressLatchUntil = 0;
stream.addEventListener("scroll", (e) => {
  // Only the user's own gestures update the latch. Programmatic scrolls fire
  // isTrusted=false and never touch it; a passive clamp (viewport or content
  // shrink) fires a TRUSTED scroll — ignore it via the fingerprints above.
  const cur = stream.scrollTop;
  if (!e.isTrusted) {
    lastScrollTop = cur;
    // refresh baselines on programmatic pins so clamp fingerprints never compare
    // against a stale baseline
    prevClientH = stream.clientHeight;
    prevScrollH = stream.scrollHeight;
    return;
  }
  // viewport resize / content shrink clamps fire trusted scrolls; none is a user
  // gesture, so they must neither cancel a glide nor drop the latch
  const viewportChanged = stream.clientHeight !== prevClientH;
  prevClientH = stream.clientHeight;
  const scrollShrank = stream.scrollHeight < prevScrollH;
  prevScrollH = stream.scrollHeight;
  if (viewportChanged || scrollShrank || performance.now() < suppressLatchUntil) {
    lastScrollTop = cur;
    return;
  }
  // a real user gesture takes over from any in-flight jump glide
  if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
  gliding = false;
  // only a scroll away from the bottom is a user intent to leave the latch
  const up = cur < lastScrollTop && !nearBottom();
  if (up) {
    followTail = false;
  } else if (nearBottom()) followTail = true;
  lastScrollTop = cur;
  // the button is visible exactly when NOT latched
  setJumpVisible(!followTail);
}, { passive: true });

function setStatus(state) {
  els.status.className = "badge " + (state || "idle");
  els.status.textContent = state || "idle";
  busy = state === "running" || state === "waiting";
  // the run button doubles as Stop while a run is in progress
  els.run.textContent = busy ? "■ Stop" : "▶ Run";
  els.run.classList.toggle("stop-mode", busy);
  els.run.disabled = busy ? false : !currentProject;
  // the mode applies to the next run only: lock the toggle while busy
  els.mode.disabled = busy;
  els.mode.title = busy
    ? "A run is in progress; the mode applies to the next run."
    : "chat: read-only analysis · work: full access (write/edit/any command). Applies to the next run.";
}

// tracks the most recent agent text block (created by streaming text_delta)
let lastTextEl = null;
let lastTextContent = "";
// thinking (reasoning) block
let thinkingEl = null;
let thinkingContent = "";
let compactionEl = null; // live "compressing context" block (compaction_delta)

// map tool_call_id -> {name, args} so a tool_result knows which tool produced it
const toolCalls = {};
// the group block currently collecting consecutive tool_calls (for merging)
let toolGroupEl = null;
// tool_call_id -> owning group: results land next to their own call row
const toolCallGroups = new Map();

function isReadTool(name) {
  return name === "read_file" || name === "grep";
}

// ensure a tool_group container exists for read/non-read rows
function ensureToolGroup(readGroup) {
  if (!toolGroupEl || toolGroupEl.closed || toolGroupEl.readGroup !== readGroup) {
    toolGroupEl = {
      el: document.createElement("div"),
      ids: new Set(),
      readGroup,
      closed: false,
    };
    toolGroupEl.el.className = "event tool_group";
    toolGroupEl.el.innerHTML = '<div class="hdr">tools</div>';
    (pageSink || eventsEl).appendChild(toolGroupEl.el);
  }
  return toolGroupEl;
}

// reserve a call row in its group; shared by the finished and streaming paths
function toolGroupFor(id, name) {
  const group = ensureToolGroup(isReadTool(name));
  group.ids.add(id);
  toolCallGroups.set(id, group);
  return group;
}

// shared tool-row skeleton: name chip + caller-specific tail
function makeToolRowBase(name) {
  const row = document.createElement("div");
  row.className = "tool-row";
  row.innerHTML = `<span class="tool-name">${escapeHtml(name)}</span>`;
  return row;
}

// one tool_call row (name + expandable args)
function makeToolRow(ev) {
  const row = makeToolRowBase(ev.name);
  let argsTxt = ev.arguments;
  try {
    if (ev.name === "run_command") {
      // the command itself, not the JSON envelope / {comment: ...} wrapper
      const parsed = JSON.parse(ev.arguments);
      argsTxt = parsed && typeof parsed.command === "string" ? "$ " + parsed.command : ev.arguments;
    } else {
      argsTxt = JSON.stringify(JSON.parse(ev.arguments), null, 1);
    }
  } catch (e) {}
  const argsBtn = document.createElement("span");
  argsBtn.className = "tool-args-btn";
  argsBtn.textContent = "args ▸";
  argsBtn.onclick = () => {
    const existing = row.querySelector(".fold");
    if (existing) {
      foldCollapse(existing, () => existing.remove());
      argsBtn.textContent = "args ▸";
    } else {
      argsBtn.textContent = "args ▾";
      const pre = document.createElement("pre");
      pre.className = "tool-args-detail";
      pre.textContent = argsTxt;
      const fold = wrapFold(pre);
      row.appendChild(fold);
      foldExpand(fold);
    }
  };
  row.appendChild(argsBtn);
  return row;
}

// render one tool_call row; consecutive calls append to the same group block
function addToolCallRow(ev) {
  const group = toolGroupFor(ev.tool_call_id, ev.name);
  group.el.appendChild(makeToolRow(ev));
  autoScroll();
}

// append a read tool's result as a collapsible row inside the tool group
function addReadResultRow(ev) {
  const call = toolCalls[ev.tool_call_id] || { name: "", args: {} };
  const { row, full } = buildReadRow(call, ev.content);
  toolGroupEl.el.appendChild(row);
  toolGroupEl.el.appendChild(full);
  autoScroll();
}

// live tool-call previews: callId -> {name, text, row, body, group}; reads stay
// collapsed, run_command shows just the command
const streamRows = {};

function friendlyArgs(name, raw) {
  if (name === "run_command") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.command === "string") return "$ " + parsed.command;
    } catch (e) {}
    let t = raw;
    const prefix = '{"command": "';
    if (t.startsWith(prefix)) t = t.slice(prefix.length);
    // mid-stream: cut at the closing quote so trailing fields never leak into the preview
    let end = -1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '"' && t[i - 1] !== "\\") { end = i; break; }
    }
    if (end >= 0) t = t.slice(0, end);
    return "$ " + t.replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  if (name === "write_file" || name === "edit_file") {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        const lines = [];
        if (p.path) lines.push(`✎ ${p.path}`);
        if (name === "write_file" && typeof p.content === "string") lines.push(p.content);
        if (name === "edit_file") {
          if (typeof p.old_string === "string") lines.push("- " + p.old_string);
          if (typeof p.new_string === "string") lines.push("+ " + p.new_string);
        }
        if (lines.length) return lines.join("\n");
      }
    } catch (e) {}
    // mid-stream: strip JSON braces/escapes so it reads as plain text
    return raw.replace(/^\{/, "").replace(/\}$/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return raw;
}

function handleToolCallDelta(ev) {
  let st = streamRows[ev.tool_call_id];
  if (!st) {
    if (!ev.name) return; // the start delta carries the name
    const group = toolGroupFor(ev.tool_call_id, ev.name);
    st = streamRows[ev.tool_call_id] = { name: ev.name, text: "", row: null, body: null, group };
    st.row = makeToolRowBase(ev.name);
    st.row.classList.add("stream");
    if (isReadTool(ev.name)) {
      // reads are large; the preview stays collapsed to just the name
      st.row.innerHTML += ` <span class="muted">…</span>`;
    } else {
      st.body = document.createElement("pre");
      st.body.className = "tool-args-detail stream-pre";
      st.row.appendChild(st.body);
    }
    group.el.appendChild(st.row);
    autoScroll();
  }
  st.text += ev.delta;
  if (st.body) st.body.textContent = friendlyArgs(st.name, st.text);
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

// one collapsible read row (toggle + summary + hidden code panel)
function buildReadRow(call, content) {
  const toolName = call.name || "";
  const path = (call.args && call.args.path) || "";
  const summary = toolName === "grep"
    ? `grep '${(call.args && call.args.pattern) || ""}' (${content ? content.split("\n").length : 0} lines)`
    : `read ${path || "file"} (${content ? content.split("\n").length : 0} lines)`;
  const row = document.createElement("div");
  row.className = "read-row";
  const toggle = document.createElement("span");
  toggle.className = "read-toggle";
  toggle.textContent = "▸";
  const lbl = document.createElement("span");
  lbl.textContent = summary;
  row.appendChild(toggle);
  row.appendChild(lbl);
  const full = document.createElement("pre");
  full.className = "read-detail"; // the wrapper carries the hidden state
  full.textContent = content;
  highlightPreByPath(full, path);
  const fold = wrapFold(full);
  row.onclick = () => {
    const wasHidden = toggleFold(fold);
    toggle.textContent = wasHidden ? "▾" : "▸";
  };
  return { row, full: fold };
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
  if (ev.type === "compaction_delta") {
    // live progress of an in-flight compaction (transient, not stored)
    if (ev.done) {
      if (compactionEl) { compactionEl.remove(); compactionEl = null; }
      return;
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
    compactionEl.querySelector("p").textContent = ev.chars > 0
      ? `summarizing earlier turns… ${ev.chars} chars streamed`
      : "compressing context — rolling earlier turns into a summary…";
    autoScroll();
    return;
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
    return;
  }
  if (ev.type === "assistant_message") {
    toolGroupEl = null;
    // stored sessions render the final message once (no delta stream)
    if (lastTextEl && lastTextEl.isConnected) {
      lastTextEl = null;
      lastTextContent = "";
      return;
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
    return;
  }
  if (ev.type === "final") {
    // the run is over: dismiss any stale permission prompt
    if (pendingPerm) closePerm();
    clearStreamPreviews(); // an aborted turn may have left half-streamed calls
    // fences may have closed since the last delta: one final render pass
    if (lastTextEl && lastTextEl.isConnected) highlightCode(lastTextEl);
    // completion divider; for non-completed runs the summary carries the reason
    appendCompletion(ev.status, ev.summary);
    refreshTree(); // a run finished; reflect any new files in the tree
    return;
  }
  if (ev.type === "tool_call" && ev.tool_call_id) {
    let args = {};
    try { args = JSON.parse(ev.arguments || "{}"); } catch (e) {}
    toolCalls[ev.tool_call_id] = { name: ev.name, args };
    const st = streamRows[ev.tool_call_id];
    if (st) {
      // the call finished: swap the live preview for the final row in the same group
      st.row.remove();
      streamRows[ev.tool_call_id] = undefined;
      toolGroupEl = st.group;
      toolGroupEl.ids.add(ev.tool_call_id);
      toolGroupEl.el.appendChild(makeToolRow(ev));
      autoScroll();
    } else {
      addToolCallRow(ev); // replay (no deltas) renders the final row directly
    }
    return;
  }
  if (ev.type === "tool_call_delta" && ev.tool_call_id) {
    handleToolCallDelta(ev);
    return;
  }

  // read results merge into their group; look it up by call id (the collector
  // may have moved elsewhere)
  if (ev.type === "tool_result" && toolCalls[ev.tool_call_id]) {
    const call = toolCalls[ev.tool_call_id];
    if (isReadTool(call.name)) {
      const group = toolCallGroups.get(ev.tool_call_id);
      if (group) {
        const prev = toolGroupEl;
        toolGroupEl = group; // addReadResultRow appends into the current collector
        addReadResultRow(ev);
        group.closed = true; // this group's calls have completed
        toolGroupEl = prev;
      } else {
        const el = renderEvent(ev);
        if (el) { (pageSink || eventsEl).appendChild(el); autoScroll(); }
      }
      return;
    }
  }

  // accumulate text and render once per frame (a full re-parse per token is O(n²))
  if (ev.type === "text_delta" && ev.content) {
    if (!lastTextEl) {
      lastTextEl = createAgentTextBlock();
      (pageSink || eventsEl).appendChild(lastTextEl);
    }
    lastTextContent += ev.content;
    scheduleTextRender();
    return;
  }

  // streaming reasoning: compact row while streaming, expandable on click
  if (ev.type === "reasoning_delta" && ev.content) {
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
    return;
  }

  if (ev.type === "step_start") {
    lastTextEl = null;
    lastTextContent = "";
    thinkingEl = null;
    thinkingContent = "";
  }

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

function createAgentTextBlock() {
  const wrap = document.createElement("div");
  wrap.className = "event text";
  wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
  return wrap;
}

// coalesced streaming render: one full-block render per frame, flushed by the
// next non-text event so a superseded block is always complete
let textRenderRaf = 0;
function renderTextBlock() {
  textRenderRaf = 0;
  if (!lastTextEl) return;
  const bodyEl = lastTextEl.querySelector(".body");
  bodyEl.innerHTML = renderMarkdown(lastTextContent);
  highlightCode(lastTextEl, true);
  if (!stream.classList.contains("loading")) typesetMath(lastTextEl); // deferred during load
  autoScroll();
}
function scheduleTextRender() {
  if (textRenderRaf) return;
  textRenderRaf = requestAnimationFrame(renderTextBlock);
}
function flushTextRender() {
  if (textRenderRaf) {
    cancelAnimationFrame(textRenderRaf);
    renderTextBlock();
  }
}

// height animation via WAAPI with overflow hidden (no scrollbar shift)
const FOLD_EASE = "cubic-bezier(.23, 1, .32, 1)";

// one fold/diff animation per element; cancel any in-flight one
function cancelFoldAnim(el) {
  if (el._foldAnim) { try { el._foldAnim.cancel(); } catch (e) {} }
  el._foldAnim = null;
}

function animateFold(el, from, to, onDone) {
  cancelFoldAnim(el);
  el.style.overflowY = "hidden";
  el.style.height = from + "px";
  const settle = () => {
    cancelFoldAnim(el);
    onDone();
    // the fold's height settled (or was cancelled): re-pin the tail if latched
    if (followTail && !stream.classList.contains("loading")) autoScroll();
  };
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.style.height = to + "px";
    settle();
    return;
  }
  const anim = el.animate(
    [{ height: from + "px" }, { height: to + "px" }],
    { duration: 200, easing: FOLD_EASE, fill: "forwards" }
  );
  el._foldAnim = anim;
  anim.onfinish = settle;
  followTailDuring(anim);
}

function resetFold(el) {
  el.style.height = "";
  el.style.overflowY = "";
}

// diff expand: grow from its collapsed 140px to the content height
function expandDiff(pre) {
  const start = pre.offsetHeight; // 140 while .diff-collapsed
  pre.classList.remove("diff-collapsed");
  const target = Math.min(pre.scrollHeight, 320);
  animateFold(pre, start, target, () => resetFold(pre));
}

function collapseDiff(pre) {
  animateFold(pre, pre.offsetHeight, 140, () => {
    pre.classList.add("diff-collapsed");
    resetFold(pre);
  });
}

// grid-rows accordion: animate 0fr<->1fr so large text never reflows per frame
function wrapFold(contentEl) {
  const inner = document.createElement("div");
  inner.className = "fold-inner";
  inner.appendChild(contentEl);
  const fold = document.createElement("div");
  fold.className = "fold hidden";
  fold.appendChild(inner);
  return fold;
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// keep the view pinned to the tail each frame while a fold/diff expands
function followTailDuring(anim) {
  let raf = requestAnimationFrame(function tick() {
    if (followTail && !stream.classList.contains("loading")) autoScroll();
    raf = requestAnimationFrame(tick);
  });
  const stop = () => cancelAnimationFrame(raf);
  anim.addEventListener("finish", stop, { once: true });
  anim.addEventListener("cancel", stop, { once: true });
}

function foldExpand(fold) {
  cancelFoldAnim(fold);
  fold.classList.remove("hidden");
  if (reducedMotion()) { fold.classList.add("open"); autoScroll(); return; }
  const anim = fold.animate(
    [{ gridTemplateRows: "0fr" }, { gridTemplateRows: "1fr" }],
    { duration: 200, easing: FOLD_EASE }
  );
  fold._foldAnim = anim;
  anim.onfinish = () => { fold._foldAnim = null; fold.classList.add("open"); };
  followTailDuring(anim);
}

function foldCollapse(fold, onDone) {
  cancelFoldAnim(fold);
  fold.classList.remove("open");
  if (reducedMotion()) { fold.classList.add("hidden"); if (onDone) onDone(); return; }
  const anim = fold.animate(
    [{ gridTemplateRows: "1fr" }, { gridTemplateRows: "0fr" }],
    { duration: 200, easing: FOLD_EASE }
  );
  fold._foldAnim = anim;
  anim.onfinish = () => {
    fold._foldAnim = null;
    fold.classList.add("hidden");
    if (onDone) onDone();
  };
}

function toggleFold(fold, onExpand) {
  const wasHidden = fold.classList.contains("hidden");
  if (wasHidden) {
    if (onExpand) onExpand(); // fill content before the wrapper sizes itself
    foldExpand(fold);
  } else {
    foldCollapse(fold);
  }
  return wasHidden;
}

// collapsible thinking row; shared by the stored-replay and live streaming paths
function buildThinkingBlock(initialLabel, initialContent) {
  const el = document.createElement("div");
  el.className = "event thinking";
  el.innerHTML = '<div class="hdr">thinking</div>';
  const row = document.createElement("div");
  row.className = "thinking-row";
  const toggle = document.createElement("span");
  toggle.className = "read-toggle";
  toggle.textContent = "▸";
  const lbl = document.createElement("span");
  lbl.className = "thinking-label";
  lbl.textContent = initialLabel;
  row.appendChild(toggle);
  row.appendChild(lbl);
  el.appendChild(row);
  const full = document.createElement("pre");
  full.className = "thinking-full";
  full.textContent = initialContent;
  full._content = initialContent; // per-block copy; survives step_start resets
  const fold = wrapFold(full);
  el.appendChild(fold);
  // click toggles between the compact row and the full reasoning text
  row.onclick = () => {
    const wasHidden = toggleFold(fold, () => { full.textContent = full._content; });
    toggle.textContent = wasHidden ? "▾" : "▸";
  };
  return { el, full, fold };
}

// thinking row rebuilt from a stored assistant_message.reasoning
function appendThinkingRow(reasoning) {
  const block = buildThinkingBlock("thinking", reasoning);
  (pageSink || eventsEl).appendChild(block.el);
}

// typeset LaTeX; pre/code are skipped so code stays literal
const MATH_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/;

function typesetMath(el) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  if (!el || !MATH_RE.test(el.textContent)) return;
  // typesetting changes height asynchronously: re-pin the tail when it settles
  MathJax.typesetPromise([el]).then(() => autoScroll()).catch(() => {});
}

// gate: only scan when a $…$ pair survives in non-code text
function hasMathText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("pre, code").forEach((n) => n.remove());
  return MATH_RE.test(clone.textContent);
}

// typeset replayed math block-by-block so the progress bar tracks the work
async function typesetProgressively(root, onPct) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  const blocks = Array.from(root.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
  if (!blocks.length) return;
  for (let i = 0; i < blocks.length; i++) {
    try { await MathJax.typesetPromise([blocks[i]]); } catch (e) {}
    onPct((i + 1) / blocks.length);
    await new Promise((r) => setTimeout(r, 0)); // let the bar repaint between blocks
  }
}

// syntax-highlight a freshly rendered block; streaming skips a last-element
// diagram (its fence may still be open)
function highlightCode(root, streaming = false) {
  if (typeof hljs === "undefined" || !root) return;
  root.querySelectorAll("pre code").forEach((el) => {
    try { hljs.highlightElement(el); } catch (e) {}
  });
  renderMermaid(root, streaming).catch((e) => console.warn("[mermaid]", e));
}

let mermaidInitialized = false;
// rendered SVGs cached by source: restore synchronously on streaming re-renders
const mermaidCache = new Map();

// is this pre the last meaningful child? streaming skips it (fence may be open)
function isLastElement(pre) {
  let n = pre.nextSibling;
  while (n) {
    if (n.nodeType === 1) return false;
    if (n.nodeType === 3 && n.textContent.trim()) return false;
    n = n.nextSibling;
  }
  return true;
}

// render mermaid: skip a last-element block mid-stream (open fence), keep
// broken source literal (async parse gate)
async function renderMermaid(root, streaming = false) {
  if (typeof mermaid === "undefined" || !root) return;
  if (!mermaidInitialized) {
    mermaidInitialized = true;
    try {
      // palette follows the UI: accent red strokes/lines, neutral dark fills
      const accent =
        (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "").trim() || "#EF4444";
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        themeVariables: {
          // strokes & lines: accent red
          lineColor: accent,
          primaryBorderColor: accent,
          secondaryBorderColor: accent,
          tertiaryBorderColor: accent,
          // sequence diagram
          actorBorder: accent,
          actorLineColor: accent,
          signalColor: accent,
          labelBoxBorderColor: accent,
          noteBorderColor: accent,
          activationBorderColor: accent,
          // gantt: active = red fill, planned = grey, done = darker grey
          taskBorderColor: accent,
          taskBkgColor: "#2d2d33",
          taskBkg: "#2d2d33", // harmless alias for any theme that reads it
          taskTextColor: "#d4d4d8",
          taskTextLightColor: "#d4d4d8",
          activeTaskBorderColor: accent,
          activeTaskBkgColor: accent,
          activeTaskBkg: accent,
          activeTaskTextColor: "#0F0F10",
          doneTaskBorderColor: "#52525b",
          doneTaskBkgColor: "#1c1c1f",
          doneTaskBkg: "#1c1c1f",
          doneTaskTextColor: "#a1a1aa",
          todayLineColor: accent,
          // clusters / subgraphs
          clusterBorder: accent,
          // state diagrams: also override the outer container's legacy border1
          stateBorder: accent,
          border1: accent,
          // fills & labels: neutral dark greys
          noteBkgColor: "#1c1c1f",
          noteTextColor: "#d4d4d8",
          edgeLabelBackground: "#1c1c1f",
          clusterBkg: "#1c1c1f",
          taskTextOutsideColor: "#a1a1aa",
          activationBkgColor: "#27272a",
          // pie: first slice red, rest grayscale (pie0 unused)
          pie1: accent,
          pie2: "#27272a",
          pie3: "#3f3f46",
          pie4: "#52525b",
          pie5: "#71717a",
          pie6: "#8b8b94",
          pie7: "#a1a1aa",
          pie8: "#b8b8c0",
          pie9: "#c9c9d0",
          pie10: "#d4d4d8",
          pie11: "#e0e0e4",
          pie12: "#ededf0",
          // git graphs: grayscale + red (git0-git7)
          git0: accent,
          git1: "#71717a",
          git2: "#d4d4d8",
          git3: "#3f3f46",
          git4: "#a1a1aa",
          git5: "#27272a",
          git6: "#b8b8c0",
          git7: "#52525b",
        },
      });
      // never let the parser's error path paint its giant error diagram
      mermaid.parseError = (err) => console.warn("[mermaid]", err);
    } catch (e) {
      return;
    }
  }
  const pending = [];
  for (const code of root.querySelectorAll("pre code.language-mermaid")) {
    const pre = code.parentElement;
    if (!pre) continue;
    const src = code.textContent;
    if (pre.dataset.mermaidSrc === src) continue; // this exact source already drawn
    const cached = mermaidCache.get(src);
    if (cached) {
      // a streaming re-render rebuilt the DOM: restore the SVG synchronously
      pre.classList.add("mermaid-rendered");
      pre.textContent = "";
      pre.insertAdjacentHTML("beforeend", cached);
      pre.dataset.mermaidSrc = src;
      continue;
    }
    // gate 1 — possible unclosed fence mid-stream: don't draw half a diagram
    if (streaming && isLastElement(pre)) continue;
    // gate 2 — async syntax check before rendering; broken source stays literal
    let parsed = true;
    let parseErr = null;
    try {
      parsed = await mermaid.parse(src);
    } catch (e) {
      parsed = false;
      parseErr = e;
    }
    if (!parsed) {
      showMermaidError(pre, parseErr);
      pre.dataset.mermaidSrc = src; // identical broken source: no re-parse loop
      continue;
    }
    pre.dataset.mermaidSrc = src; // mark in-flight so deltas don't double-render
    pending.push({ pre, src });
  }
  for (const { pre, src } of pending) {
    mermaid
      .render("mmd-" + Math.random().toString(36).slice(2), src)
      .then(({ svg }) => {
        // a later delta may have rebuilt the DOM: re-locate the block by source
        let target = null;
        for (const el of root.querySelectorAll("pre code.language-mermaid")) {
          if (el.textContent === src) { target = el.parentElement; break; }
        }
        if (!target) return;
        // gate 3 — render can resolve a giant error diagram; never let it hit the DOM
        if (/Parse error on line|Lexical error on line|Syntax error in text|Parse error[:\s]/.test(svg)) {
          showMermaidError(target, null);
          delete target.dataset.mermaidSrc; // a corrected source can retry
          return;
        }
        if (mermaidCache.size > 100) mermaidCache.clear();
        mermaidCache.set(src, svg);
        // securityLevel "strict" already sanitizes the SVG; keep the block chrome
        target.classList.add("mermaid-rendered");
        target.textContent = "";
        target.insertAdjacentHTML("beforeend", svg);
        target.dataset.mermaidSrc = src;
        if (followTail) autoScroll(); // a diagram can be taller than its source
      })
      .catch((e) => {
        // keep the literal source; drop the marker so a corrected source can retry
        if (pre.isConnected) {
          showMermaidError(pre, e);
          delete pre.dataset.mermaidSrc;
        }
      });
  }
}

// mark a failed diagram with a small inline notice; the parser message goes
// into the hover title
function showMermaidError(pre, detail) {
  if (!pre || !pre.classList) return;
  pre.classList.add("mermaid-failed");
  if (!pre.querySelector(".mermaid-error")) {
    const tip = document.createElement("div");
    tip.className = "mermaid-error";
    tip.textContent = "Invalid diagram syntax; the original code was kept.";
    const msg = detail && (detail.message || String(detail));
    if (msg) tip.title = "mermaid: " + msg;
    pre.appendChild(tip);
  }
}

// map a file extension to a highlight.js language id for bare <pre> results
const CODE_LANGS = {
  py: "python", js: "javascript", mjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", html: "xml", htm: "xml", xml: "xml",
  css: "css", scss: "scss", json: "json", md: "markdown", sh: "bash",
  bash: "bash", yaml: "yaml", yml: "yaml", c: "c", h: "c", cpp: "cpp",
  hpp: "cpp", go: "go", rs: "rust", java: "java", sql: "sql", rb: "ruby",
  php: "php", r: "r", diff: "diff",
};
function highlightPreByPath(pre, path) {
  if (typeof hljs === "undefined") return;
  const ext = String(path || "").split(".").pop().toLowerCase();
  const lang = CODE_LANGS[ext] || "";
  if (lang) pre.classList.add("language-" + lang);
  try {
    if (pre.querySelector("code")) {
      hljs.highlightElement(pre.querySelector("code"));
    } else {
      const code = document.createElement("code");
      code.textContent = pre.textContent;
      pre.textContent = "";
      pre.appendChild(code);
      hljs.highlightElement(code);
    }
  } catch (e) {}
}

function appendCompletion(status, summary) {
  const div = document.createElement("div");
  div.className = "completion";
  div.textContent = status === "completed" ? "completed" : status;
  (pageSink || eventsEl).appendChild(div);
  // completed summaries duplicate the streamed text; only abort/error reasons are shown
  if (status !== "completed" && summary) {
    const note = document.createElement("div");
    note.className = "completion-note";
    note.textContent = summary;
    (pageSink || eventsEl).appendChild(note);
  }
  // live runs re-pin to the completion divider; never yank a user who scrolled up
  if (!stream.classList.contains("loading")) {
    // never yank mid-glide: the user's jump animation owns the scroll until it lands
    if (gliding) return;
    if (followTail) stream.scrollTop = stream.scrollHeight;
    else setJumpVisible(true);
  }
}

function renderEvent(ev) {
  const wrap = document.createElement("div");
  const body = document.createElement("div");
  body.className = "body";
  let appendedBody = false; // write+diff appends body itself; skip the trailing append

  switch (ev.type) {
    case "user_message": {
      wrap.className = "event user";
      wrap.innerHTML = '<div class="hdr">task</div>';
      body.className = "body";
      // hard-wrapped markdown (breaks: true): WYSIWYG line breaks
      body.innerHTML = renderMarkdown(ev.content, true);
      break;
    }
    case "tool_result": {
      const call = toolCalls[ev.tool_call_id] || { name: "", args: {} };
      const toolName = call.name || "";
      const isRead = isReadTool(toolName);
      const isWrite = toolName === "write_file" || toolName === "edit_file";
      // any tool that could change the filesystem (blacklist of read-only tools)
      if (toolName && !isRead && toolName !== "load_skill") scheduleTreeRefresh();

      wrap.className = "event tool_result" + (ev.is_error ? " error" : "")
        + (isRead ? " read" : "") + (isWrite ? " write" : "");
      const hdr = isWrite ? (toolName === "edit_file" ? "✎ edited" : "✓ wrote") : (ev.is_error ? "result ⚠" : "result");
      wrap.innerHTML = `<div class="hdr">${hdr}</div>`;
      body.className = "body md-plain";

      if (isRead) {
        const { row, full } = buildReadRow(call, ev.content);
        wrap.appendChild(row);
        wrap.appendChild(full);
        appendedBody = true; // the read content lives in the panel, not body
        break;
      }

      if (isWrite && ev.diff) {
        // show the file change as a unified diff
        const path = call.args.path || "";
        wrap.innerHTML = `<div class="hdr">✓ wrote <span class="diff-file">${escapeHtml(path)}</span></div>`;
        body.textContent = ev.content; // summary line (e.g. OK: wrote /x (+5 -2 lines))
        wrap.appendChild(body);
        appendedBody = true;
        const pre = renderDiff(ev.diff);
        wrap.appendChild(pre);
        if (ev.diff.split("\n").length > 60) {
          pre.classList.add("diff-collapsed");
          const expand = document.createElement("button");
          expand.className = "diff-expand";
          const setLabel = () => {
            expand.textContent = pre.classList.contains("diff-collapsed") ? "Show full diff" : "Hide diff";
          };
          setLabel();
          expand.onclick = () => {
            if (pre.classList.contains("diff-collapsed")) expandDiff(pre);
            else collapseDiff(pre);
            setLabel();
          };
          wrap.appendChild(expand);
        }
        // user-side undo: reverts the last snapshot of this file on the server
        const undoBtn = document.createElement("button");
        undoBtn.className = "diff-expand undo-btn";
        undoBtn.textContent = "↶ undo";
        undoBtn.onclick = async () => {
          try {
            const res = await fetch(API_BASE + "/api/workspace/revert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: call.args.path }),
            });
            const data = await res.json();
            if (res.ok && data && data.status === "ok") {
              undoBtn.textContent = "↶ undone";
              undoBtn.disabled = true;
              refreshTree();
            } else {
              undoBtn.textContent = "↶ no snapshot";
              undoBtn.disabled = true;
            }
          } catch (e) {
            undoBtn.textContent = "↶ failed";
            undoBtn.disabled = true;
          }
        };
        wrap.appendChild(undoBtn);
        break;
      }

      body.textContent = ev.content;
      break;
    }
    case "state_update": {
      if (ev.key === "execution_status" && ev.value) setStatus(ev.value);
      return null;
    }
    case "permission_request": {
      openPerm(ev);
      return null;
    }
    default:
      return null;
  }
  if (!appendedBody) wrap.appendChild(body);
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// markdown via marked + DOMPurify (LLM output is untrusted); breaks=true
// hard-wraps user tasks
function renderMarkdown(text, breaks = false) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  try {
    const src = String(text);
    // protect math from marked's backslash escapes via ⟦MATHn⟧ placeholders
    const math = [];
    const protectedSrc = src.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => {
      math.push(m);
      return `⟦MATH${math.length - 1}⟧`;
    });
    const html = breaks ? marked.parse(protectedSrc, { breaks: true }) : marked.parse(protectedSrc);
    const restored = html.replace(/⟦MATH(\d+)⟧/g, (_, i) => math[+i]);
    return DOMPurify.sanitize(restored);
  } catch (e) {
    return escapeHtml(text);
  }
}

// render a unified diff string as a <pre> with per-line +/- colouring
function renderDiff(diff) {
  const pre = document.createElement("pre");
  pre.className = "diff-view";
  const lines = diff.split("\n");
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    if (line.startsWith("+++") || line.startsWith("---")) {
      div.className = "diff-hunk";
    } else if (line.startsWith("+")) {
      div.className = "diff-add";
    } else if (line.startsWith("-")) {
      div.className = "diff-del";
    } else if (line.startsWith("@")) {
      div.className = "diff-meta";
    }
    pre.appendChild(div);
  }
  return pre;
}

// ---- run / stop ----
async function run() {
  const task = els.task.value.trim();
  if (!task || busy) return;
  if (!currentProject) return;
  els.task.value = ""; // the task is now "in the stream"; keep the input clear
  els.task.style.height = TASK_BASE_H + "px"; // animate the input back to its default size
  // sending a message returns to the live tail unconditionally
  followTail = true;
  autoScroll(true);
  // runs append to the active project; the mode travels with the request
  const payload = { task, mode: agentMode, project: currentProject };
  try {
    const r = await fetch(API_BASE + "/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    if (data.workspace) els.workspace.textContent = data.workspace;
    refreshTree();
  } catch (e) {
    addEvent({ type: "final", status: "error", summary: "run failed: " + e.message });
  }
}

async function stop() {
  await fetch(API_BASE + "/api/stop", { method: "POST" });
}

els.run.addEventListener("click", () => (busy ? stop() : run()));
els.mode.addEventListener("click", () => {
  if (busy) return; // disabled + guard: the active run's mode is already fixed
  setMode(agentMode === "chat" ? "work" : "chat");
});
setMode(agentMode); // paint the stored mode on startup
els.task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
});

// ---- task input auto-grow (grows as you type, shrinks back after sending) ----
const TASK_BASE_H = els.task.offsetHeight; // default 3-row height
function autoGrowTask() {
  const was = els.task.style.height;
  if (!els.task.value.trim()) {
    els.task.style.height = TASK_BASE_H + "px";
  } else {
    els.task.style.height = "auto";
    els.task.style.height = Math.min(els.task.scrollHeight, Math.round(window.innerHeight * 0.3)) + "px";
  }
  // the input resize clamps scrollTop; the listener ignores it, so re-pin while
  // typing to stay on the tail
  if (was !== els.task.style.height) {
    suppressLatchUntil = performance.now() + 120;
    if (followTail && !nearBottom()) autoScroll();
  }
}
els.task.addEventListener("input", autoGrowTask);

// ---- API settings modal ----
// endpoint persisted on the backend + client proxy; profiles pick the backend
function customSelect(root) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cselect-btn";
  if (root.getAttribute("title")) btn.title = root.getAttribute("title");
  const valueEl = document.createElement("span");
  valueEl.className = "cselect-value";
  const arrow = document.createElement("span");
  arrow.className = "cselect-arrow";
  btn.appendChild(valueEl);
  btn.appendChild(arrow);
  const pop = document.createElement("div");
  pop.className = "cselect-pop";
  root.classList.add("cselect");
  root.appendChild(btn);
  root.appendChild(pop);

  const opts = []; // {value, text}
  let selected = null;
  const listeners = [];

  function render() {
    const o = opts.find((x) => x.value === selected);
    valueEl.textContent = o ? o.text : "";
    pop.innerHTML = "";
    for (const opt of opts) {
      const row = document.createElement("div");
      row.className = "cselect-opt" + (opt.value === selected ? " active" : "");
      row.textContent = opt.text;
      row.addEventListener("click", () => {
        const changed = opt.value !== selected;
        selected = opt.value;
        render();
        root.classList.remove("open");
        if (changed) for (const fn of listeners) fn();
      });
      pop.appendChild(row);
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    root.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) root.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") root.classList.remove("open");
  });

  return {
    set innerHTML(_v) { opts.length = 0; selected = null; render(); }, // only ever cleared
    appendChild(opt) { opts.push({ value: opt.value, text: opt.textContent }); render(); },
    get value() { return selected || ""; },
    set value(v) { selected = v; render(); },
    get disabled() { return root.classList.contains("disabled"); },
    set disabled(b) { root.classList.toggle("disabled", !!b); },
    addEventListener(_ev, fn) { listeners.push(fn); },
    focus() { btn.focus(); },
  };
}

const modal = $("#settings-modal");
const keyInput = $("#api-key-input");
const modelInput = $("#model-input");
const reasoningEffortInput = customSelect($("#reasoning-effort-input"));
// reasoning-effort options
for (const [v, t] of [["", "default"], ["low", "low"], ["medium", "medium"], ["max", "max"]]) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = t;
  reasoningEffortInput.appendChild(o);
}
reasoningEffortInput.value = "";
const llmUrlInput = $("#llm-url-input");
const profileSelect = customSelect($("#llm-profile-select"));

function llmProfiles() {
  try {
    return JSON.parse(localStorage.getItem("clutch_llm_profiles") || "{}");
  } catch (e) {
    return {};
  }
}

function saveLlmProfiles(profiles) {
  localStorage.setItem("clutch_llm_profiles", JSON.stringify(profiles));
}

function renderLlmProfiles(activeName) {
  const profiles = llmProfiles();
  profileSelect.innerHTML = "";
  const names = Object.keys(profiles).sort();
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name === activeName ? name + " ✓" : name;
    profileSelect.appendChild(opt);
  }
  // empty list = no profiles: disable the picker
  profileSelect.disabled = names.length === 0;
  profileSelect.value = names.includes(activeName) ? activeName : (names[0] || "");
  // Delete/Edit act on the selected profile: grey them out when none is selected
  $("#llm-profile-del").disabled = !profileSelect.value;
  $("#llm-profile-edit").disabled = !profileSelect.value;
}

// apply a saved profile: fill the form and push it to the backend immediately
async function applyLlmProfile(name) {
  const p = llmProfiles()[name];
  if (!p) return;
  keyInput.value = p.api_key || "";
  llmUrlInput.value = p.base_url || "";
  modelInput.value = p.model || "";
  reasoningEffortInput.value = p.reasoning_effort || "";
  localStorage.setItem("clutch_llm_active", name);
  renderLlmProfiles(name);
  await pushSettings();
}

profileSelect.addEventListener("change", async () => {
  const name = profileSelect.value;
  if (name) await applyLlmProfile(name);
  else renderLlmProfiles("");
});

const profileNameInput = $("#llm-profile-name");

function saveProfileAs(name, oldName) {
  const profiles = llmProfiles();
  if (oldName && oldName !== name) delete profiles[oldName]; // rename: drop the old key
  profiles[name] = {
    base_url: llmUrlInput.value.trim(),
    model: modelInput.value.trim(),
    api_key: keyInput.value.trim(),
    reasoning_effort: reasoningEffortInput.value.trim(),
  };
  saveLlmProfiles(profiles);
  localStorage.setItem("clutch_llm_active", name);
  renderLlmProfiles(name);
}

// ---- LLM profile editor (mirrors the SSH connection modal) ----
// pick to apply, ＋ New (blank), Edit, Delete; url/key/model fields live here
const llmProfileModal = $("#llm-profile-modal");
const llmProfileTitle = $("#llm-profile-title");
const llmProfileError = $("#llm-profile-error");
let editingProfile = null; // the profile being edited, or null for a new one

function showLlmProfileError(msg) {
  llmProfileError.textContent = msg;
  llmProfileError.classList.remove("hidden");
  profileNameInput.classList.add("profile-name-error");
}
function clearLlmProfileError() {
  llmProfileError.classList.add("hidden");
  llmProfileError.textContent = "";
  profileNameInput.classList.remove("profile-name-error");
}

function openLlmProfileEditor(name) {
  // ＋ New (no name) opens a BLANK form; Edit prefills the selected profile
  const p = name ? llmProfiles()[name] : null;
  editingProfile = name && p ? name : null;
  llmProfileTitle.textContent = editingProfile ? "Edit profile: " + editingProfile : "New LLM profile";
  profileNameInput.value = editingProfile || "";
  llmUrlInput.value = (p && p.base_url) || "";
  keyInput.value = (p && p.api_key) || "";
  modelInput.value = (p && p.model) || "";
  reasoningEffortInput.value = (p && p.reasoning_effort) || "";
  clearLlmProfileError();
  llmProfileModal.classList.remove("hidden", "closing");
  profileNameInput.focus();
}
function closeLlmProfileEditor() {
  editingProfile = null;
  closeModal(llmProfileModal);
}

$("#llm-profile-new").addEventListener("click", () => openLlmProfileEditor());
$("#llm-profile-edit").addEventListener("click", () => openLlmProfileEditor(profileSelect.value));
$("#llm-profile-cancel").addEventListener("click", closeLlmProfileEditor);
dismissOnOverlayPress(llmProfileModal, closeLlmProfileEditor);

$("#llm-profile-save").addEventListener("click", async () => {
  const name = profileNameInput.value.trim();
  if (!name) {
    clearLlmProfileError();
    showLlmProfileError("Give this profile a name.");
    profileNameInput.focus();
    return;
  }
  // a name conflicts only when it belongs to a DIFFERENT profile
  const taken = llmProfiles()[name];
  if (taken && name !== editingProfile) {
    showLlmProfileError("A profile named \"" + name + "\" already exists — pick a different name.");
    profileNameInput.focus();
    return;
  }
  const oldName = editingProfile;
  editingProfile = null;
  saveProfileAs(name, oldName);
  closeModal(llmProfileModal);
  await pushSettings(); // apply the new/edited profile to the backend
});

profileNameInput.addEventListener("input", clearLlmProfileError);

profileNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("#llm-profile-save").click();
  }
});

$("#llm-profile-del").addEventListener("click", () => {
  const name = profileSelect.value;
  if (!name) return; // nothing selected: nothing to delete
  if (!confirm("Delete profile \"" + name + "\"?")) return;
  const profiles = llmProfiles();
  delete profiles[name];
  saveLlmProfiles(profiles);
  if (localStorage.getItem("clutch_llm_active") === name) localStorage.removeItem("clutch_llm_active");
  renderLlmProfiles("");
});

async function openSettings() {
  modal.classList.remove("hidden", "closing");
  // url/key/model fields live in the profile editor; nothing to prefill here
  renderLlmProfiles(localStorage.getItem("clutch_llm_active") || "");
}
function closeSettings() {
  closeModal(modal);
}
// push the profile-editor form values to the backend
async function pushSettings() {
  const key = keyInput.value.trim();
  const llmUrl = llmUrlInput.value.trim();
  const model = modelInput.value.trim();
  const payload = {
    base_url: llmUrl,
    model,
    // always sent: empty value clears the knob on the backend
    reasoning_effort: reasoningEffortInput.value.trim(),
  };
  if (key) payload.api_key = key;
  try {
    const r = await fetch(API_BASE + "/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    if (key) localStorage.setItem("clutch_api_key", key);
    localStorage.setItem("clutch_llm", JSON.stringify({ model, base_url: llmUrl }));
    // keep the client-side LLM proxy in sync (it reads the local settings file)
    if (window.clutchSettings && window.clutchSettings.save) {
      await window.clutchSettings.save({ api_key: key, model, base_url: llmUrl });
    }
    return true;
  } catch (e) {
    addEvent({ type: "final", status: "error", summary: "save settings failed: " + e.message });
    return false;
  }
}
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-close").addEventListener("click", closeSettings);
$("#older-pill").addEventListener("click", loadOlder);
dismissOnOverlayPress(modal, closeSettings);

// close only when the press STARTS on the overlay (a drag released outside
// must not close it)
function dismissOnOverlayPress(overlayEl, onClose) {
  overlayEl.addEventListener("mousedown", (e) => {
    if (e.target === overlayEl) onClose();
  });
}

const MODAL_CLOSE_MS = 180;

// animated close: fade the overlay, then land display:none when done
function closeModal(overlayEl, onDone) {
  if (!overlayEl || overlayEl.classList.contains("hidden") || overlayEl.classList.contains("closing")) return;
  const finish = () => {
    // reopened before the animation finished: this stale timer must not hide it
    if (!overlayEl.classList.contains("closing")) return;
    overlayEl.classList.remove("closing");
    overlayEl.classList.add("hidden");
    if (onDone) onDone();
  };
  overlayEl.classList.add("closing");
  if (reducedMotion()) finish();
  else setTimeout(finish, MODAL_CLOSE_MS);
}

// ---- SSH connection (in the project picker) ----
const connSelect = customSelect($("#conn-select"));
const connStatus = $("#conn-status");
const connNewHost = $("#conn-new-host");
const connNewUser = $("#conn-new-user");
const connNewPort = $("#conn-new-port");

const passModal = $("#ssh-pass-modal");
const passInput = $("#ssh-pass-input");
const passLabel = $("#ssh-pass-label");
let passResolve = null;

function sshConns() {
  try {
    return JSON.parse(localStorage.getItem("clutch_ssh_connections") || "[]");
  } catch (e) {
    return [];
  }
}

function upsertConn(host, user, port) {
  const list = sshConns().filter((c) => !(c.host === host && c.user === user && String(c.port) === String(port)));
  list.unshift({ host, user, port: String(port) });
  localStorage.setItem("clutch_ssh_connections", JSON.stringify(list));
  localStorage.setItem("clutch_ssh_host", host);
  localStorage.setItem("clutch_ssh_user", user);
  localStorage.setItem("clutch_ssh_port", String(port));
}

function connLabel(c) {
  return `${c.user}@${c.host}:${c.port}`;
}

function renderConnSelector() {
  const override = localStorage.getItem("clutch_api_url");
  const connected = override && localStorage.getItem("clutch_ssh_connected");
  const cHost = localStorage.getItem("clutch_ssh_host");
  const cUser = localStorage.getItem("clutch_ssh_user");
  const cPort = localStorage.getItem("clutch_ssh_port");
  connSelect.innerHTML = "";
  const localOpt = document.createElement("option");
  localOpt.value = "local";
  localOpt.textContent = "Local (this machine)";
  connSelect.appendChild(localOpt);
  // keep the connected host entry selected instead of adding a synthetic URL
  let connectedValue = null;
  for (const c of sshConns()) {
    const label = connLabel(c);
    const isConnected =
      connected && c.host === cHost && c.user === cUser && String(c.port) === String(cPort);
    const opt = document.createElement("option");
    opt.value = "ssh:" + label;
    opt.textContent = isConnected ? label + " ✓" : label;
    connSelect.appendChild(opt);
    if (isConnected) connectedValue = opt.value;
  }
  if (connected) {
    if (connectedValue) {
      connSelect.value = connectedValue;
    } else {
      // connected via a path that didn't save a host: still show user@host:port
      const opt = document.createElement("option");
      opt.value = "ssh:__connected__";
      opt.textContent = cHost
        ? cUser + "@" + cHost + (cPort ? ":" + cPort : "") + " ✓"
        : "SSH: " + override + " ✓";
      connSelect.appendChild(opt);
      connSelect.value = "ssh:__connected__";
    }
  } else {
    connSelect.value = "local";
  }
  connStatus.textContent = connected ? "Connected: " + override : "Using " + API_BASE;
}

// switch the active backend in place without a full page reload
function switchBackend(url) {
  API_BASE = url.replace(/\/+$/, "");
  localStorage.setItem("clutch_api_url", API_BASE);
  reconnectSSE();
}

// ask the main process for the current backend URL; re-apply degrade mode
// to the new session
async function switchBackendResolved() {
  if (!window.clutchApi) return false;
  const url = await window.clutchApi.baseUrl();
  if (url) {
    switchBackend(url);
    await reapplyDegradeIfNeeded();
  }
  return Boolean(url);
}

// degrade mode is a per-process setting that dies with the session: re-apply
// it whenever the session is (re)claimed
async function reapplyDegradeIfNeeded() {
  const raw = localStorage.getItem("clutch_degrade");
  if (!raw || !window.clutchTunnel) return;
  const s = await window.clutchTunnel.status();
  if (!s.active || !s.execBridge) {
    // the tunnel is gone: degrade mode is meaningless, drop the marker
    localStorage.removeItem("clutch_degrade");
    return;
  }
  let bridge = null;
  try {
    bridge = JSON.parse(raw).bridge;
  } catch (e) {
    localStorage.removeItem("clutch_degrade");
    return;
  }
  try {
    await fetch(API_BASE + "/api/backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ssh", bridge, workspace: "~" }),
    });
  } catch (e) {
    /* best effort: the next re-apply retries */
  }
}

// ---- SSH-tools degradation (host alive but unusable for bootstrap) ----
// local agent, remote exec bridge; true = degraded, false = tunnel dead

async function tryDegradeToSshTools() {
  if (!window.clutchTunnel) return false;
  const s = await window.clutchTunnel.status();
  // degradable only while the tunnel is alive (a dead tunnel has no bridge)
  if (!s.active || !s.execBridge) return false;
  // resolve the current backend first: the main process may have fallen back
  // to a fresh local session
  const url = await window.clutchApi.baseUrl();
  if (!url) return "not running";
  try {
    const r = await fetch(url + "/api/backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ssh", bridge: s.execBridge, workspace: "~" }),
    });
    if (!r.ok) return "not running";
  } catch (e) {
    return "unreachable";
  }
  // persist the mode: the session process may be re-created later
  localStorage.setItem("clutch_degrade", JSON.stringify({ bridge: s.execBridge }));
  return true;
}

async function resetBackendLocal() {
  try {
    await fetch(DEFAULT_BASE + "/api/backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "local" }),
    });
  } catch (e) {
    /* the local server may be down; the renderer still falls back in place */
  }
}

// restore the picker's normal browsing state after a connect/disconnect
function refreshPicker() {
  showPickerBody();
  loadDir("", false); // re-list the (new) backend from home; keep the remembered dir
  renderConnSelector();
}

function showPasswordPrompt(label) {
  return new Promise((resolve) => {
    passLabel.textContent = label;
    passInput.value = "";
    passResolve = resolve;
    passModal.classList.remove("hidden", "closing");
    passInput.focus();
  });
}

function closePasswordPrompt() {
  // resolve immediately (the connect flow is waiting); only the visual close animates
  closeModal(passModal);
  if (passResolve) passResolve(null);
  passResolve = null;
}

let connBusy = false; // a connect is in flight: ignore re-clicks
let lastConn = null;  // { host, user, port, statusEl } of the last attempt (Retry)

// collapse the picker body during a connect/failure; only the conn bar remains
function hidePickerBody() {
  $("#fs-body").classList.add("collapsed");
}
function showPickerBody() {
  $("#fs-body").classList.remove("collapsed");
  $("#fs-new").classList.toggle("hidden", fsMode !== "new");
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.add("hidden");
}

let activeConnStatus = null; // status element of the modal currently connecting

// connection progress bar: the tunnel reports coarse stages over IPC
const CONN_STAGES = {
  auth: { pct: 10, label: "Connecting…" },
  probe: { pct: 22, label: "Inspecting remote…" },
  install: { pct: 35, label: "Installing remote server…" },
  "install:upload": { pct: 45, label: "Uploading server…" },
  "install:start": { pct: 70, label: "Starting server…" },
  forward: { pct: 90, label: "Starting tunnel…" },
};
function updateConnProgress(stage) {
  const s = CONN_STAGES[stage];
  if (activeConnStatus) activeConnStatus.textContent = s ? s.label : "Working…";
  for (const bar of [$("#conn-progress"), $("#conn-new-progress")]) {
    if (bar.classList.contains("hidden")) continue;
    const fill = bar.querySelector(".conn-progress-fill");
    if (s) {
      fill.classList.remove("indeterminate");
      fill.style.width = s.pct + "%";
    } else {
      fill.classList.add("indeterminate"); // unknown stage: keep the bar animating
      fill.style.width = "";
    }
  }
}

function setFsConnecting(host, statusEl) {
  activeConnStatus = statusEl;
  statusEl.textContent = "Connecting to " + host + "…";
  hidePickerBody();
  $("#conn-actions").classList.add("hidden");
  // animate the bar under the active modal (the new-connection popup has its own)
  const bar = statusEl && statusEl.id === "conn-new-status" ? $("#conn-new-progress") : $("#conn-progress");
  bar.classList.remove("hidden");
  const fill = bar.querySelector(".conn-progress-fill");
  fill.classList.add("indeterminate");
  fill.style.width = "";
}

function setFsConnectError(msg, statusEl) {
  activeConnStatus = statusEl;
  statusEl.textContent = msg;
  hidePickerBody();
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.remove("hidden"); // offer Retry / Cancel
}

async function handleSshConnect(host, user, port, statusEl) {
  if (!window.clutchTunnel) {
    statusEl.textContent = "SSH requires the desktop app (Electron).";
    return;
  }
  if (connBusy) {
    statusEl.textContent = "connecting…";
    return;
  }
  if (!host || !user) {
    statusEl.textContent = "host and user are required";
    return;
  }
  lastConn = { host, user, port, statusEl }; // Retry re-uses this on failure
  connBusy = true;
  setFsConnecting(host, statusEl); // sets the status text + shows the progress bar
  try {
    // try keys/agent first; only prompt for a password if auth fails
    let res = await window.clutchTunnel.connect({ host, user, port: Number(port) });
    if (!res.ok && res.error && /authentication/i.test(res.error)) {
      const pw = await showPasswordPrompt("Password for " + user + "@" + host);
      if (!pw) {
        setFsConnectError("connection cancelled", statusEl);
        return;
      }
      res = await window.clutchTunnel.connect({ host, user, port: Number(port), password: pw });
    }
    if (res.ok) {
      upsertConn(host, user, port);
      localStorage.setItem("clutch_ssh_connected", "1");
      // the tunnel URL is the supervisor control channel; the API base is the
      // per-window session, decided by the main process
      await switchBackendResolved();
      refreshPicker();
      return true;
    } else {
      // host alive but unbootstrappable: degrade to SSH-tools
      const degraded = await tryDegradeToSshTools();
      if (degraded === true) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        await switchBackendResolved(); // the local server is now remote-backed
        refreshPicker();
        return true;
      }
      // false = tunnel never came up; string = local backend down (the real failure)
      setFsConnectError(
        degraded === false
          ? "connection failed: " + (res.error || "could not connect")
          : "SSH connected, but the local agent server is " + degraded,
        statusEl
      );
    }
  } catch (e) {
    setFsConnectError("connection failed: " + e.message, statusEl);
  } finally {
    connBusy = false;
  }
}

connSelect.addEventListener("change", async () => {
  const v = connSelect.value;
  if (v === "local") {
    if (localStorage.getItem("clutch_ssh_connected")) {
      await window.clutchTunnel.disconnect();
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
      await resetBackendLocal(); // end any SSH degradation on the local server
      await switchBackendResolved(); // stay in the picker, back to the local backend
      refreshPicker();
    }
    return;
  }
  if (v.startsWith("ssh:") && !v.includes("__connected__")) {
    // switching: drop any current tunnel first, then connect to the new host
    if (localStorage.getItem("clutch_ssh_connected")) {
      await window.clutchTunnel.disconnect();
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade");
    }
    const [user, hostPort] = v.slice(4).split("@");
    const [host, port] = hostPort.split(":");
    await handleSshConnect(host, user, port || "22", connStatus);
  }
});

// new-connection popup (only shown when the user asks to add an SSH host)
const connNewModal = $("#conn-new-modal");
const connNewStatus = $("#conn-new-status");

function openConnNew() {
  connNewHost.value = localStorage.getItem("clutch_ssh_host") || "";
  connNewUser.value = localStorage.getItem("clutch_ssh_user") || "";
  connNewPort.value = localStorage.getItem("clutch_ssh_port") || "22";
  connNewStatus.textContent = "";
  connNewModal.classList.remove("hidden", "closing");
  connNewHost.focus();
}
function closeConnNew() {
  closeModal(connNewModal);
}
$("#conn-new").addEventListener("click", openConnNew);
$("#conn-new-cancel").addEventListener("click", closeConnNew);
$("#conn-new-connect").addEventListener("click", async () => {
  const host = connNewHost.value.trim();
  const user = connNewUser.value.trim();
  const port = connNewPort.value.trim() || "22";
  const ok = await handleSshConnect(host, user, port, connNewStatus);
  if (ok) closeConnNew(); // stay in the picker
});
dismissOnOverlayPress(connNewModal, closeConnNew);
connNewHost.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#conn-new-connect").click();
});
$("#conn-retry").addEventListener("click", () => {
  if (lastConn) handleSshConnect(lastConn.host, lastConn.user, lastConn.port, lastConn.statusEl);
});
$("#conn-cancel").addEventListener("click", async () => {
  localStorage.removeItem("clutch_ssh_connected");
  localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
  resetBackendLocal(); // end any SSH degradation on the local server
  closeConnNew(); // a new-connection attempt may have failed with its modal open
  await switchBackendResolved(); // in-place fallback to the local backend
  refreshPicker();
});
if (window.clutchTunnel && window.clutchTunnel.onProgress) {
  window.clutchTunnel.onProgress(updateConnProgress); // drive the connect progress bar
}
$("#ssh-pass-ok").addEventListener("click", () => {
  const pw = passInput.value;
  closeModal(passModal);
  if (passResolve) passResolve(pw);
  passResolve = null;
});
$("#ssh-pass-cancel").addEventListener("click", closePasswordPrompt);
dismissOnOverlayPress(passModal, closePasswordPrompt);
passInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#ssh-pass-ok").click();
});

// reconcile the stored URL with the tunnel's real state; a live tunnel is
// authoritative, a dead-tunnel leftover falls back to the local backend
async function reconciledBackendUrl() {
  if (!window.clutchTunnel) return null;
  const s = await window.clutchTunnel.status();
  const override = localStorage.getItem("clutch_api_url");
  const flag = localStorage.getItem("clutch_ssh_connected");
  if (s.active) {
    // live tunnel: the main process owns this window's session URL — ask it
    const target = await window.clutchApi.baseUrl();
    if (target && override !== target) {
      localStorage.setItem("clutch_ssh_connected", "1");
      return target;
    }
    return null;
  }
  if (flag) {
    // stale SSH leftover: fall back to the local backend via the main process
    localStorage.removeItem("clutch_ssh_connected");
    await switchBackendResolved();
    return null; // switchBackendResolved already switched
  }
  return null;
}

// tunnel died mid-session: fall back to the local backend in place
if (window.clutchTunnel) {
  window.clutchTunnel.onEnd(async () => {
    // the tunnel (and its exec bridge) is gone: any degrade mode dies with it
    localStorage.removeItem("clutch_degrade");
    if (localStorage.getItem("clutch_ssh_connected")) {
      localStorage.removeItem("clutch_ssh_connected");
      resetBackendLocal(); // end any SSH degradation on the local server
      await switchBackendResolved(); // the main process re-claims a local session
      if (!fsModal.classList.contains("hidden")) refreshPicker();
    }
  });
}

// the main process re-established this window's session: point the app at the new URL
if (window.clutchApi && window.clutchApi.onBaseChanged) {
  window.clutchApi.onBaseChanged((url) => {
    if (url) switchBackend(url);
  });
}

// ---- permission confirm ----
const permModal = $("#perm-modal");
let pendingPerm = null;
function openPerm(ev) {
  pendingPerm = ev;
  $("#perm-tool").textContent = `Tool: ${ev.tool} — ${ev.reason || ""}`;
  const argsEl = $("#perm-args");
  let txt = ev.args_repr || "";
  let isJson = false;
  if (ev.tool === "run_command") {
    // permission prompts show the command itself, not the {comment: ...} envelope
    try {
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed.command === "string") txt = "$ " + parsed.command;
    } catch (e) {}
  } else {
    try { txt = JSON.stringify(JSON.parse(txt), null, 2); isJson = true; } catch (e) {}
  }
  argsEl.textContent = "";
  if (typeof hljs !== "undefined" && isJson) {
    const code = document.createElement("code");
    code.className = "language-json";
    code.textContent = txt;
    argsEl.appendChild(code);
    try { hljs.highlightElement(code); } catch (e) {}
  } else {
    argsEl.textContent = txt;
  }
  permModal.classList.remove("hidden", "closing");
  setStatus("waiting");
}
function closePerm() {
  // respond immediately (the agent is blocked); only the visual close animates
  closeModal(permModal);
  pendingPerm = null;
}
async function respondPerm(allow) {
  if (!pendingPerm) return;
  const rid = pendingPerm.request_id;
  closePerm();
  setStatus("running");
  try {
    await fetch(API_BASE + "/api/permission/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: rid, allow }),
    });
  } catch (e) {}
}
$("#perm-allow").addEventListener("click", () => respondPerm(true));
$("#perm-deny").addEventListener("click", () => respondPerm(false));
dismissOnOverlayPress(permModal, () => respondPerm(false));

// ---- workspace tree ----
let lastTreeSig = "";
let treeRefreshTimer = null;

// dotfiles hidden everywhere until the shared toggle turns them on
let showHidden = localStorage.getItem("clutch_show_hidden") === "1";

function updateHiddenToggles() {
  $("#fs-hidden-toggle").checked = showHidden;
  $("#tree-hidden-toggle").checked = showHidden;
}

function toggleHidden() {
  showHidden = !showHidden;
  localStorage.setItem("clutch_show_hidden", showHidden ? "1" : "0");
  updateHiddenToggles();
  // re-list the picker's current dir and the tree with the new visibility
  if (!fsModal.classList.contains("hidden")) loadDir(fsPath);
  refreshTree();
}

$("#fs-hidden-toggle").addEventListener("change", toggleHidden);
$("#tree-hidden-toggle").addEventListener("change", toggleHidden);
updateHiddenToggles();

// file changes only arrive via tool results: debounced refresh, no polling
function scheduleTreeRefresh() {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(refreshTree, 300);
}

async function refreshTree() {
  try {
    const params = new URLSearchParams();
    if (showHidden) params.set("hidden", "1");
    for (const p of expandedDirs) params.append("expanded", p);
    const qs = params.toString() ? "?" + params : "";
    const r = await fetch(API_BASE + "/api/workspace/tree" + qs);
    const data = await r.json();
    if (data.root) els.workspace.textContent = data.root;
    // include expansion state in the signature so a toggle always re-renders
    const sig = JSON.stringify([...expandedDirs]) + "|" + JSON.stringify(data.tree || []);
    if (sig === lastTreeSig) return; // unchanged: keep expansion state
    lastTreeSig = sig;
    els.tree.innerHTML = "";
    for (const node of data.tree || []) els.tree.appendChild(renderNode(node, 0));
  } catch (e) {}
}

const expandedDirs = new Set();

function renderNode(node, depth) {
  const wrap = document.createElement("div");
  wrap.className = "tree-branch";
  const row = document.createElement("div");
  row.className = "tree-node " + (node.dir ? "dir" : "file");
  row.style.paddingLeft = (depth * 12) + "px";
  const label = node.link ? `${node.name} → ${node.link}` : node.name;
  row.innerHTML =
    `<span class="icon">${node.dir ? "▸" : "·"}</span>` +
    `<span class="name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
  wrap.appendChild(row);
  if (node.dir) {
    const isOpen = expandedDirs.has(node.path);
    const children = document.createElement("div");
    children.className = "tree-children";
    children.style.display = isOpen ? "" : "none";
    if (isOpen) row.querySelector(".icon").textContent = "▾";
    if (isOpen) {
      for (const c of node.children || []) children.appendChild(renderNode(c, depth + 1));
    }
    row.addEventListener("click", (e) => {
      e.stopPropagation(); // don't bubble to ancestor dirs (would collapse them)
      const open = children.style.display !== "none";
      if (open) {
        expandedDirs.delete(node.path);
        children.style.display = "none"; // instant collapse; refresh prunes deep data
        row.querySelector(".icon").textContent = "▸";
      } else {
        expandedDirs.add(node.path);
        row.querySelector(".icon").textContent = "▾";
        // clear first: rapid toggles reuse this element
        children.innerHTML = "";
        // reveal the pre-loaded lookahead level instantly, then fetch deeper
        if (node.children && node.children.length) {
          for (const c of node.children) children.appendChild(renderNode(c, depth + 1));
          children.style.display = "";
        }
      }
      // debounced: rapid toggles coalesce into one fetch; the re-render keeps expansion
      scheduleTreeRefresh();
    });
    // children are siblings of the row, so the row's hover box never covers the subtree
    wrap.appendChild(children);
  }
  return wrap;
}

// ---- SSE live stream + session list ----
let es = null;

function connectSSE(replay = true) {
  // backend not claimed yet: the main process announces the real URL via
  // backend:base-changed -> switchBackend -> reconnectSSE
  if (!API_BASE) return;
  // INVARIANT: at most one live stream per window. es is module-level and its
  // callers are many (boot, switchBackend, open/new project, base-changed
  // heal); the owner enforces single-stream here, so any call order — e.g. the
  // boot IIFE switching backends before its trailing connect — replaces the
  // old stream instead of leaking a second one (two live streams deliver every
  // event twice: the per-token stutter).
  if (es) es.close();
  // ?project= scopes the stream to this window's .clc; replay=0 right after
  // open/create already rendered the history
  const qs = new URLSearchParams();
  if (currentProject) qs.set("project", currentProject);
  qs.set("replay", replay ? "1" : "0");
  es = new EventSource(API_BASE + "/api/events?" + qs.toString());
  es.onmessage = (e) => {
    try { addEvent(JSON.parse(e.data)); } catch (err) {}
  };
  // on (re)connect the server replays stored history: reset the streaming state
  es.onopen = () => {
    lastTextEl = null;
    lastTextContent = "";
    thinkingEl = null;
    thinkingContent = "";
    toolGroupEl = null;
    if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
    // the backend (re)connected, possibly after a self-heal restart: resync the tree
    refreshTree();
  };
  es.onerror = () => { /* auto-reconnect */ };
}

// point the SSE stream at the (possibly new) API_BASE; when es is null (boot
// before the backend resolved) this CREATES the stream — that is exactly the
// late-heal path
function reconnectSSE(replay = true) {
  if (es) es.close();
  connectSSE(replay);
}

let currentProject = ""; // path of the active .clc project file

function clearStream() {
  eventsEl.innerHTML = ""; // clear session content; the overlay/events wrapper stay mounted
  lastTextEl = null;
  lastTextContent = "";
  thinkingEl = null;
  thinkingContent = "";
  if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
  oldestOffset = null; // fresh project: no loaded events yet
  setOlderPill(0);
}

// ---- scroll-up paging (lazily-opened projects) ----
// olderRemaining mirrors the server's on-disk count, so a dropped page
// never makes the pill lie
let olderRemaining = 0;
let oldestOffset = null; // byte offset of the oldest loaded (rendered) non-task event
let paging = false;   // one history fetch at a time
// when non-null, addEvent appends into this off-DOM sink instead of #events
let pageSink = null;

function setOlderPill(n) {
  olderRemaining = Math.max(0, n | 0);
  const pill = document.getElementById("older-pill");
  if (olderRemaining > 0) {
    pill.classList.remove("hidden");
    const kb = Math.max(1, Math.ceil(olderRemaining / 1024));
    const label = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
    document.getElementById("older-label").textContent =
      `load earlier records (${label})`;
  } else {
    pill.classList.add("hidden");
  }
}

async function loadOlder() {
  if (paging || stream.classList.contains("loading") || !oldestOffset || olderRemaining <= 0) return;
  paging = true;
  try {
    const anchor = eventsEl.firstElementChild; // identity survives the prepend
    const res = await fetch(API_BASE + `/api/history?before=${oldestOffset}&limit=262144`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || res.status);
    const page = data.events || [];
    if (!page.length) { setOlderPill(0); return; }
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    // render the page through the full replay pipeline into an off-DOM sink,
    // then prepend it in one pass; save/restore live-stream state
    const sink = document.createElement("div");
    sink.style.display = "contents"; // transparent wrapper: children lay out in #events
    const savedLastTextEl = lastTextEl, savedLastTextContent = lastTextContent;
    const savedThinkingEl = thinkingEl, savedThinkingContent = thinkingContent;
    const savedToolGroupEl = toolGroupEl;
    lastTextEl = null; lastTextContent = "";
    thinkingEl = null; thinkingContent = "";
    toolGroupEl = null;
    pageSink = sink;
    try {
      for (const item of page) addEvent(item); // unwrap tracks oldestOffset
    } finally {
      pageSink = null;
      lastTextEl = savedLastTextEl; lastTextContent = savedLastTextContent;
      thinkingEl = savedThinkingEl; thinkingContent = savedThinkingContent;
      toolGroupEl = savedToolGroupEl;
    }
    // typeset AFTER insertion: MathJax needs real layout
    const mathBlocks = Array.from(sink.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
    const frag = document.createDocumentFragment();
    while (sink.firstChild) frag.appendChild(sink.firstChild);
    eventsEl.insertBefore(frag, eventsEl.firstElementChild);
    if (typeof MathJax !== "undefined" && typeof MathJax.typesetPromise === "function") {
      for (const b of mathBlocks) {
        try { await MathJax.typesetPromise([b]); } catch (e) {}
        await new Promise((r) => setTimeout(r, 0)); // repaint between blocks
      }
    }
    // prepending (and typesetting) shifted the content down: re-anchor the view
    if (anchor && anchorTop !== null) {
      stream.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
    setOlderPill(data.older);
  } catch (e) {
    alert("Failed to load earlier records: " + e.message);
  } finally {
    paging = false;
  }
}

function setProjectInfo(info) {
  currentProject = info.project || "";
  els.projectLabel.textContent = info.name || "";
  els.projectLabel.title = currentProject;
  if (info.workdir) els.workspace.textContent = info.workdir;
  // read-only badge: visible only while the active project is read-only
  const badge = document.getElementById("readonly-badge");
  if (badge) badge.classList.toggle("hidden", !info.read_only);
  setStatus("idle");
}

function hideWelcome() {
  document.getElementById("welcome").classList.add("hidden");
  els.run.disabled = busy || !currentProject;
}

async function openProject(path, readOnly = false) {
  if (busy) return;
  const prog = document.getElementById("open-progress");
  const fill = prog.querySelector(".open-progress-fill");
  const label = prog.querySelector(".open-progress-label");
  const setPct = (pct) => {
    fill.style.width = pct + "%";
    label.textContent = Math.round(pct) + "%";
  };
  try {
    const r = await fetch(API_BASE + "/api/project/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...(readOnly ? { read_only: true } : {}) }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const e = new Error(err.error || r.status);
      e.code = err.code || null; // e.g. project_open_conflict (HTTP 409)
      throw e;
    }
    clearStream();
    stream.classList.add("loading"); // history reconstruction: no entrance motion
    prog.classList.remove("hidden");
    setPct(0);
    // /api/project/open streams NDJSON: meta, progress, event, done
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let started = false;
    let processed = 0;
    let totalEvents = 0;
    let rendered = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.error) {
          const e = new Error(msg.error);
          e.code = msg.code || null;
          throw e;
        }
        if (msg.meta) {
          setProjectInfo({
            project: msg.meta.project,
            name: msg.meta.name,
            workdir: msg.meta.workdir,
            read_only: !!msg.meta.read_only,
          });
          hideWelcome();
          started = true;
        } else if (msg.count) {
          totalEvents = msg.count;
          // lazy open: "older" = durable records still on disk before the loaded tail
          if (typeof msg.older === "number") setOlderPill(msg.older);
        } else if (msg.progress && msg.progress.total) {
          // phase A: server file parse maps to the first 50% of the bar
          setPct(50 * msg.progress.done / msg.progress.total);
        } else if (msg.event) {
          // {offset, event}: addEvent unwraps and tracks the oldest loaded offset
          addEvent(msg);
          // phase B: client rendering of the events maps to 50-90%
          if (totalEvents) setPct(50 + 40 * (++rendered / totalEvents));
        }
        // yield periodically so the browser paints the bar and streams events progressively
        if (++processed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    // phase C: typeset replayed math as the remaining 90-100%
    await typesetProgressively(eventsEl, (f) => setPct(90 + 10 * f));
    if (started) setPct(100);
    prog.classList.add("hidden");
    stream.classList.remove("loading"); // instant reveal — no fade, no replay
    stream.scrollTop = stream.scrollHeight; // jump straight to the end of the record
    // re-scope the live stream to the new project; replay=0 (history already rendered)
    reconnectSSE(false);
    refreshTree();
  } catch (e) {
    prog.classList.add("hidden");
    stream.classList.remove("loading");
    // same project open for write in another window: offer read-only instead of failing
    if (e && e.code === "project_open_conflict") {
      const wantReadOnly = confirm(
        "This project is already open in another window.\nOpen it read-only? Read-only mode cannot run tasks."
      );
      if (wantReadOnly) {
        await openProject(path, true); // retry without the write lock
        return;
      }
      return; // cancelled: keep the previous project as-is
    }
    alert("Failed to open project: " + e.message);
    // a network "Failed to fetch" usually means the remote session forward died
    console.error("[openProject] failed:", { api: API_BASE, path, error: e && e.message });
  }
}

async function createProject(dir, name) {
  if (busy) return;
  try {
    const r = await fetch(API_BASE + "/api/project/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, name }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    clearStream();
    setProjectInfo(data);
    hideWelcome();
    reconnectSSE(false); // new empty project: nothing to replay, just live events
    refreshTree();
  } catch (e) {
    alert("Failed to create project: " + e.message);
  }
}

// ---- server file browser (unified open/new on the backend's filesystem) ----
const fsModal = $("#fs-modal");
let fsMode = "open";
let fsPath = "";
let fsParent = null;

function openFsBrowser(mode) {
  if (busy) return;
  fsMode = mode;
  fsPath = "";
  fsParent = null;
  $("#fs-title").textContent = mode === "new" ? "New project" : "Open project";
  $("#fs-create").classList.toggle("hidden", mode !== "new");
  $("#fs-name-input").value = "";
  showPickerBody(); // normal browsing: path bar + file list + (new-project area)
  $("#fs-up").disabled = false;
  $("#fs-go").disabled = false;
  $("#fs-path-input").disabled = false;
  fsModal.classList.remove("hidden", "closing");
  // settle the stored URL against the tunnel's real state first, then list once
  reconciledBackendUrl().then((url) => {
    if (url) switchBackend(url);
    // reopen where the user last left the browser instead of the home directory
    loadDir(localStorage.getItem("clutch_fs_last_dir") || "");
    renderConnSelector();
  });
}

function closeFsBrowser() {
  closeModal(fsModal);
}

function fsRow(label, cls, onClick) {
  const row = document.createElement("div");
  row.className = "fs-row " + cls;
  row.textContent = label;
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

// wait for the backend to be claimed (cold start: supervisor spawn + session
// child boot take a few seconds) so a click during that window just works
// instead of telling the user to close and re-click
function waitBackend(ms = 20000) {
  if (API_BASE) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (API_BASE || Date.now() - t0 >= ms) {
        clearInterval(iv);
        resolve(Boolean(API_BASE));
      }
    }, 200);
  });
}

async function loadDir(path, remember = true) {
  const listEl = $("#fs-list");
  if (!API_BASE) {
    // backend not claimed yet (supervisor mid-spawn): show progress and pick
    // the listing up automatically the moment the session is up
    listEl.innerHTML = '<div class="fs-row plain">connecting to backend…</div>';
    if (!(await waitBackend())) {
      listEl.innerHTML = '<div class="fs-row error-row">backend did not come up — close this dialog and retry</div>';
      return;
    }
  }
  listEl.innerHTML = '<div class="fs-row plain">loading…</div>';
  try {
    const r = await fetch(
      API_BASE + "/api/fs/list?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "")
    );
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || r.status);
    fsPath = data.path;
    fsParent = data.parent;
    // remember the last browsed directory (re-lists pass remember=false)
    if (remember) localStorage.setItem("clutch_fs_last_dir", fsPath);
    $("#fs-path-input").value = data.path;
    listEl.innerHTML = "";
    if (data.parent) {
      listEl.appendChild(fsRow(".. (up)", "dir", () => loadDir(data.parent)));
    }
    for (const e of data.entries) {
      const label = e.link ? e.name + " → " + e.link : e.name;
      if (e.dir) {
        listEl.appendChild(fsRow(label, "dir", () => loadDir(e.path)));
      } else if (e.name.endsWith(".clc") && fsMode === "open") {
        listEl.appendChild(
          fsRow(label, "file clc", () => {
            closeFsBrowser();
            openProject(e.path);
          })
        );
      } else {
        listEl.appendChild(fsRow(label, "file plain"));
      }
    }
    if (!listEl.children.length) listEl.appendChild(fsRow("(empty)", "plain"));
  } catch (e) {
    // a remembered last directory may be gone: forget it and retry from home once
    const remembered = localStorage.getItem("clutch_fs_last_dir");
    if (remembered && path === remembered) {
      localStorage.removeItem("clutch_fs_last_dir");
      loadDir("");
      return;
    }
    listEl.innerHTML = "";
    listEl.appendChild(
      fsRow(
        "Cannot reach backend at " + API_BASE + " (" + (e.message || e) + "). Reconnect SSH or check the backend URL.",
        "error-row"
      )
    );
    listEl.appendChild(
      fsRow("Reset to local backend", "action", async () => {
        localStorage.removeItem("clutch_ssh_connected");
        localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
        await switchBackendResolved();
        refreshPicker();
      })
    );
  }
}

$("#fs-cancel").addEventListener("click", closeFsBrowser);
$("#fs-up").addEventListener("click", () => {
  if (fsParent) loadDir(fsParent);
});
$("#fs-go").addEventListener("click", () => loadDir($("#fs-path-input").value.trim()));
$("#fs-path-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadDir($("#fs-path-input").value.trim());
});
$("#fs-create").addEventListener("click", () => {
  const name = $("#fs-name-input").value.trim();
  if (!name || !fsPath) return;
  closeFsBrowser();
  createProject(fsPath, name);
});
dismissOnOverlayPress(fsModal, closeFsBrowser);

$("#new-project-btn").addEventListener("click", () => openFsBrowser("new"));
$("#open-project-btn").addEventListener("click", () => openFsBrowser("open"));
$("#welcome-new").addEventListener("click", () => openFsBrowser("new"));
$("#welcome-open").addEventListener("click", () => openFsBrowser("open"));

// settle the stored URL before connecting SSE; connectSSE is idempotent, so a
// switch inside reconciledBackendUrl (stale-SSH fallback, tunnel target) plus
// the trailing call still leaves exactly one live stream
(async () => {
  await resolveApiBase(); // learn this window's session port (IPC) first
  const url = await reconciledBackendUrl();
  if (url) switchBackend(url);
  connectSSE();
})();
