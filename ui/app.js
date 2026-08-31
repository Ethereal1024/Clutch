"use strict";

// Where the agent API lives. Every window gets its own SESSION child from the
// machine supervisor (see server-bootstrap.js): an agent.server spawned with
// --port 0, its random port learned via preload IPC (window.clutchApi.baseUrl
// is an async call into the main process). DEFAULT_BASE tracks the RESOLVED
// session base so SSH fallbacks land back on THIS window's own session, never
// on a guessed default port; localStorage is deliberately NOT used for the
// initial base — a persisted random port would be dead by the next launch.
// SSH connections / manual picker URLs still route through switchBackend().
// The 8890 fallback only matters when the preload IPC is unavailable
// (plain-browser debugging without Electron): no session exists, so it is an
// unreachable placeholder, not a real backend address.
let DEFAULT_BASE = "http://127.0.0.1:8890";
let API_BASE = null; // resolved in resolveApiBase() before the app starts

async function resolveApiBase() {
  let base = "http://127.0.0.1:8890";
  if (window.clutchApi && window.clutchApi.baseUrl) {
    // a session URL is the ONLY valid backend; 8890 is the supervisor
    // (lifecycle-only), so a null/8890 answer means the session couldn't be
    // claimed yet — a second window booting while the supervisor is mid-spawn
    // can transiently fail, so retry a few times before accepting the fallback
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const b = await window.clutchApi.baseUrl(); // IPC: this window's session port
        const clean = b ? String(b).replace(/\/+$/, "") : "";
        if (clean && clean !== "http://127.0.0.1:8890") {
          base = clean;
          break;
        }
      } catch {
        /* preload unavailable (plain-browser debugging) — keep the placeholder */
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  API_BASE = base;
  DEFAULT_BASE = base;
  return base;
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

// agent mode for the next run: "work" (full tools) | "chat" (read-only).
// Sticky per session (localStorage); applied in the /api/run payload, so a
// switch only affects the NEXT run, never a running one.
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

// The floating ↓ button's visibility mirrors the latch, and is updated in exactly
// this one place: autoScroll, the scroll latch and appendCompletion all report
// through here, so no path can leave the button and the latch out of sync.
function setJumpVisible(visible) {
  jumpBottom.classList.toggle("hidden", !visible);
}

// Follow the tail of the stream, but never during project-load (content is hidden
// then), and never yank the view back down if the user has scrolled up to read —
// a floating '↓' button appears instead so they can return to the live tail.
// followTail is latched state, not a live distance check: reaching the bottom
// (or clicking ↓) enters the tail, and fresh content keeps us pinned even though
// the gap to the bottom then grows past JUMP_BOTTOM_GAP. Only the user's own
// upward scroll breaks the latch — programmatic smooth glides stay latched.
let followTail = true;
let lastScrollTop = 0;

let gliding = false;
let glideRaf = 0;

function autoScroll(force) {
  if (stream.classList.contains("loading")) return;
  if (force) {
    // User-initiated jump (message send, ↓ button, Cmd/Ctrl+Down). The two
    // states are decoupled: tracked = instant pin (streaming never animates);
    // untracked = the one smooth glide, which owns the scroll until it lands
    // and re-latches on arrival.
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
    // tracked: instant pin — but never during a user jump-glide (untracked ↓)
    if (gliding) return;
    stream.scrollTop = stream.scrollHeight;
    setJumpVisible(false);
  } else {
    // untracked: content growth never moves the view; only the ↓ glide may
    setJumpVisible(true);
  }
}

// ---- jump-to-bottom glide (user-initiated only) ----
// The original native smooth animation, restored: scrollTo smooths to the tail
// captured at call time. The gliding flag makes the animation exclusive — every
// other scroll/heigh change is ignored until it lands, so nothing can fight it.
// A rAF poll detects the landing (target reached, clamped to a new bottom, or
// interrupted by a real user scroll) and then re-pins once to absorb any content
// growth that arrived mid-glide.
function glideToBottom() {
  if (stream.classList.contains("loading")) return;
  cancelAnimationFrame(glideRaf);
  const target = stream.scrollHeight;
  if (stream.scrollTop >= target - 1) {
    // already at the tail: nothing to travel — land straight into the latch
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
      // landed (or clamped to a new bottom): re-latch — the smooth glide was the
      // only animated moment, and fresh content pins instantly from here on
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

// WebFont / image / any async layout growth can land AFTER the render path's own
// autoScroll (font swap, image load, MathJax typeset, fold settle), leaving a
// latched view hovering mid-air — and #stream disables native anchoring
// (overflow-anchor: none), so the browser never compensates on its own. Watch
// the CONTENT's height, not the viewport's: whenever the content grows while
// latched, re-pin. The task input resizing the viewport never changes
// eventsEl's height, so this observer can never re-trigger the resize jump it
// exists to absorb.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (followTail && !stream.classList.contains("loading")) autoScroll();
  }).observe(eventsEl);
}

jumpBottom.addEventListener("click", () => {
  // no pre-latch here: autoScroll(force) decides by state — instant pin when
  // already tracked, the smooth ↓ glide when untracked (which re-latches on
  // landing). The resulting scroll event is isTrusted=false and never touches
  // the latch.
  autoScroll(true);
});
// Cmd/Ctrl+Down anywhere: same jump-to-tail as the ↓ button (glides via autoScroll(true))
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
    autoScroll(true);
  }
});
let prevClientH = stream.clientHeight;
let prevScrollH = stream.scrollHeight;
// armed by autoGrowTask for ~120ms after the input box resizes: the clamp scroll
// event that resize triggers can fire BEFORE the shrunken viewport is observable
// (clientHeight may not have settled yet), so blanket-ignore latch changes in
// that window — the resize itself is never a user scroll gesture.
let suppressLatchUntil = 0;
stream.addEventListener("scroll", (e) => {
  // Only the user's own gestures update the latch. Programmatic scrolls (smooth
  // glides, force jumps) fire isTrusted=false and never touch it. A passive
  // clamp is NOT isTrusted=false though: when the task input grows and shrinks
  // the viewport, scrollTop gets clamped down and the browser fires a trusted
  // scroll event — treating that as "the user scrolled up" would drop the latch
  // and pop the ↓ button while typing. A shrunken viewport is the fingerprint
  // of such a clamp, so ignore scrolls that coincide with it; the time window
  // above catches the clamp even when the fingerprint is not yet visible.
  // The same clamp happens when the CONTENT shrank — e.g. a streamed tool_call
  // preview (full args, up to 320px) is swapped for its final collapsed row —
  // and a shrunken scrollHeight is the fingerprint there.
  const cur = stream.scrollTop;
  if (!e.isTrusted) {
    lastScrollTop = cur;
    // Programmatic pins never fire a trusted event, so without this refresh the
    // clamp fingerprints below compare against a stale baseline: a long pinned
    // stream (thinking + grep results) freezes prevScrollH/prevClientH, and the
    // next genuine clamp (fold collapse, preview swap, viewport resize) is then
    // misread as a user scroll-up, dropping the latch mid-stream.
    prevClientH = stream.clientHeight;
    prevScrollH = stream.scrollHeight;
    return;
  }
  // ANY viewport-size change (the task input grow/shrink resizes this flex
  // scroller; browser window resize) or content shrink (fold collapse, preview
  // swap) clamps scrollTop and fires a trusted scroll event — none of those is
  // a user gesture, so they must neither cancel an in-flight jump glide nor
  // drop the latch. The send-time input reset is exactly such a resize.
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
  // A clamp can only land the view at the (new) bottom edge; only a scroll away
  // from it is a user intent to leave the latch. Guarding `up` with nearBottom()
  // is defense-in-depth: even if a fingerprint misses (racing a huge fold
  // collapse), the clamp still reads as "at the bottom" and the latch survives.
  const up = cur < lastScrollTop && !nearBottom();
  if (up) {
    followTail = false;
  } else if (nearBottom()) followTail = true;
  lastScrollTop = cur;
  // the button is visible exactly when NOT latched: followTail=true must hide it
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
  // a run is pinned to the mode it started with: switching mid-run would only
  // relabel the button, not change the running agent — lock the toggle while
  // busy (generic button:disabled styling greys it out)
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
// tool_call_id -> owning group: a tool_result must land in ITS group even when a
// later call (or an interleaved thinking block that reset toolGroupEl) moved the
// collector elsewhere — otherwise the result renders orphaned outside the group.
const toolCallGroups = new Map();

function isReadTool(name) {
  return name === "read_file" || name === "grep";
}

// Ensure a tool_group container exists for read/non-read rows and return it.
// Consecutive calls share the block; a new user turn / text / thinking closes it.
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

// Reserve a tool call in its read/non-read group and record its id — shared by
// the finished-call path and the streaming preview path, so both land in the
// same group.
function toolGroupFor(id, name) {
  const group = ensureToolGroup(isReadTool(name));
  group.ids.add(id);
  toolCallGroups.set(id, group);
  return group;
}

// The shared tool-row skeleton: name chip + caller-specific tail. Finished calls
// add the args toggle (makeToolRow); streaming previews add a live body instead.
function makeToolRowBase(name) {
  const row = document.createElement("div");
  row.className = "tool-row";
  row.innerHTML = `<span class="tool-name">${escapeHtml(name)}</span>`;
  return row;
}

// Build one tool_call row (name + expandable args). Does not touch the group.
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

// Render one tool_call row; consecutive calls append to the same group block.
// Read tools (read_file/grep) keep their results in the same block too.
function addToolCallRow(ev) {
  const group = toolGroupFor(ev.tool_call_id, ev.name);
  group.el.appendChild(makeToolRow(ev));
  autoScroll();
}

// Append a read tool's result as a collapsible row inside the tool group.
function addReadResultRow(ev) {
  const call = toolCalls[ev.tool_call_id] || { name: "", args: {} };
  const { row, full } = buildReadRow(call, ev.content);
  toolGroupEl.el.appendChild(row);
  toolGroupEl.el.appendChild(full);
  autoScroll();
}

// live-streamed tool-call previews: callId -> {name, text, row, body, group}. The
// model's tool-call arguments arrive as tool_call_delta chunks; this shows the call
// being generated (a file being written, a command being typed) inside the SAME
// 'tools' group the finished call will use, so the live view matches the final one.
// Reads stay collapsed (their content is huge); run_command shows just the command
// and write/edit show the content/strings, not the JSON envelope.
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
    // mid-stream: cut at the closing quote so trailing fields ("comment", ...)
    // never leak into the preview; escaped quotes inside the command are kept
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
    // mid-stream: drop the JSON braces and unescape so it reads as text and wraps
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
  // the preview grows in place: no scroll event fires, so re-pin explicitly
  // while latched or the live write_file args drift out of view
  autoScroll();
}

// Remove any stream previews left by an aborted turn (a tool call that streamed
// but never got its final tool_call event).
function clearStreamPreviews() {
  for (const id of Object.keys(streamRows)) {
    if (streamRows[id]) streamRows[id].row.remove();
    delete streamRows[id];
  }
}

// Build one collapsible read row (toggle + summary + hidden code panel).
// Shared by the tool-group path and the standalone renderEvent path.
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
  // lazy wire shape: {offset, event} wrappers (open NDJSON stream + SSE replay of
  // a lazily-opened project) carry each durable event's byte offset (relative to
  // the event region) so the UI can page the earlier records. The oldest loaded
  // offset seeds the pill; the raw task is paged like any other older record.
  if (ev && typeof ev === "object" && ev.event && typeof ev.offset === "number") {
    if (ev.offset > 0) oldestOffset = oldestOffset === null ? ev.offset : Math.min(oldestOffset, ev.offset);
    ev = ev.event;
  }
  // SSE replay of a lazy project opens with a history line: restore the pill's
  // honest on-disk older count (a reconnect may have lost server-side pages)
  if (ev && ev.type === "history") {
    setOlderPill(ev.older || 0);
    return;
  }
  // history replay: stale live-control events (status, permission) must not
  // drive the current UI — the badge/busy state belongs to the live run
  if (stream.classList.contains("loading") &&
      (ev.type === "state_update" || ev.type === "permission_request")) {
    return;
  }
  // finalize a coalesced streaming text block before any non-text event (tool
  // call, next turn, final): the block must be fully rendered before it is
  // superseded or collapsed
  if (ev && ev.type !== "text_delta") flushTextRender();
  // events that break a tool group: new user turn, agent text, thinking, final.
  // assistant_message is just a record (not shown) and does NOT break the group,
  // because results follow the tool_calls they belong to.
  if (["user_message", "text_delta", "reasoning_delta", "final", "step_start"].includes(ev.type)) {
    toolGroupEl = null;
  }
  if (ev.type === "compaction_delta") {
    // live progress of an in-flight compaction (transient, not stored): a
    // counter that updates as the summary streams in, so a long compression
    // never looks frozen. done=True means the compaction aborted/failed.
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
    // During a live stream the text was already rendered by text_delta; a stored
    // session (no deltas) must render the final message once — opencode loads
    // final parts, not the streaming tape.
    if (lastTextEl && lastTextEl.isConnected) {
      lastTextEl = null;
      lastTextContent = "";
      return;
    }
    // thinking renders above the agent text, matching the live stream (reasoning
    // deltas arrive before text deltas). Skip the stored record when a live
    // reasoning_delta stream already rendered this turn's thinking — otherwise
    // the replay block would duplicate it.
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
    // the run is over: any open permission prompt is stale — dismiss it so a
    // late approve can't flip the UI back into a stuck "running" state
    if (pendingPerm) closePerm();
    clearStreamPreviews(); // an aborted turn may have left half-streamed calls
    // diagrams skipped mid-stream (their fence was still open at the last
    // delta) are complete now — force one final render pass
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
      // the call finished: swap the live preview for the final row IN THE SAME
      // group, so the 'tools' header stays put and no second group appears
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

  // read tool results merge into the group block; other results render independently.
  // Look the group up by call id (not the current collector): interleaved thinking
  // or a later call may have moved toolGroupEl to another group, and the result
  // must still land next to its own call row.
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

  // streaming text: accumulate plain text and schedule ONE render per animation
  // frame. Rendering the whole accumulated block per token re-parses markdown,
  // re-highlights every code block and re-typesets all math on each one — an
  // O(n²) main-thread stall that surfaced as "freeze, then a burst of output".
  // Coalescing per frame bounds the work and lets the browser paint between
  // frames; the next non-text event flushes whatever is still pending.
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
    // keep the block's own copy in sync; if the full text is open, update it live
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
    // user tasks render markdown too: highlight code and draw mermaid diagrams
    // (replay also hits this path — highlightCode is synchronous and layout-free)
    if (el.classList.contains("event.user")) highlightCode(el);
    // user tasks can carry LaTeX too; typeset on the live path only (replay
    // batches it after insertion in openProject — MathJax needs real layout)
    if (el.classList.contains("event.user") && !pageSink) typesetMath(el);
    autoScroll();
  }
}

function createAgentTextBlock() {
  const wrap = document.createElement("div");
  wrap.className = "event text";
  wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
  return wrap;
}

// Coalesced streaming render (see the text_delta branch above): at most one
// full-block render per animation frame, flushed synchronously by the next
// non-text event so a superseded block is always complete.
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

// Height animation shared by the diff expand (partial collapse to 140px): animates
// an explicit height via WAAPI; overflow-y is suppressed so no scrollbar shifts.
const FOLD_EASE = "cubic-bezier(.23, 1, .32, 1)";

// One fold/diff animation per element; cancel any in-flight one before starting
// a new one (shared by animateFold, foldExpand, foldCollapse and the settle pass).
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
    // the fold's height just settled (or was cancelled): re-pin the tail if
    // the user is latched, so the view never ends up hovering off the bottom
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

// Diff expand: grow from its collapsed 140px to the content height.
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

// Grid-rows accordion wrapper: the container height animates 0fr<->1fr while the
// inner content is clipped — large text never reflows per frame and scrollbars
// never shift (unlike animating height on the content itself).
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

// While a fold/diff expands, its height grows every frame; keep the view pinned
// to the live tail each frame if the user is latched — a single post-animation
// scroll would leave the view hovering mid-air for the whole 200ms.
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

// One collapsible thinking row (event container + toggle + label + fold panel),
// shared by the stored-replay path (appendThinkingRow) and the live
// reasoning_delta stream. The live path updates label and _content incrementally;
// the fold's expand callback renders _content so an open panel never goes stale.
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

// A collapsed thinking row rebuilt once from a stored assistant_message.reasoning
// (used when a stored session replays without reasoning_delta stream).
function appendThinkingRow(reasoning) {
  const block = buildThinkingBlock("thinking", reasoning);
  (pageSink || eventsEl).appendChild(block.el);
}

// Render LaTeX ($...$, $$...$$) inside a freshly-inserted markdown block.
// MathJax scans text nodes; pre/code are skipped via skipHtmlTags so code stays
// literal. Content is already DOMPurify-sanitized before this runs.
const MATH_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/;

function typesetMath(el) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  if (!el || !MATH_RE.test(el.textContent)) return;
  // MathJax typesets asynchronously and can change the block's height after
  // the delta that triggered it; re-pin the tail when it settles so a latched
  // view never drifts off the bottom mid-render
  MathJax.typesetPromise([el]).then(() => autoScroll()).catch(() => {});
}

// Strict gate for the replay pass: a block only needs MathJax when a $…$ or
// $$…$$ pair survives in its non-code text — lone $ signs in shell/code/currency
// (e.g. `$ echo`, `$PATH`, `$5`) never trigger a scan.
function hasMathText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("pre, code").forEach((n) => n.remove());
  return MATH_RE.test(clone.textContent);
}

// Typeset replayed math block-by-block so the progress bar tracks the work.
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

// Syntax-highlight every <pre><code> inside a freshly rendered block.
// Marked only emits a fenced <pre> once the closing ``` has arrived, so
// streaming renders stay clean (no half-block flicker). streaming=true tells
// renderMermaid to skip a diagram that is still the LAST element of its body —
// its fence may not be closed yet (marked runs an unclosed fence to the end of
// the text), and drawing it would show a half-finished diagram.
function highlightCode(root, streaming = false) {
  if (typeof hljs === "undefined" || !root) return;
  root.querySelectorAll("pre code").forEach((el) => {
    try { hljs.highlightElement(el); } catch (e) {}
  });
  renderMermaid(root, streaming).catch((e) => console.warn("[mermaid]", e));
}

let mermaidInitialized = false;
// Rendered SVGs are cached by source text: streaming re-renders the whole body
// on every delta (a fresh DOM replaces every pre), so a finished diagram must
// be restored synchronously from the cache instead of redrawn — no flash, no
// duplicate async renders. The cache is bounded; on overflow it resets and the
// next pass simply re-renders.
const mermaidCache = new Map();

// Is `pre` the last meaningful child of its parent (ignoring whitespace-only
// text nodes)? During streaming an unclosed mermaid fence is the last thing in
// the body; a diagram only renders once content follows it (fence closed) or
// the final event forces a pass.
function isLastElement(pre) {
  let n = pre.nextSibling;
  while (n) {
    if (n.nodeType === 1) return false;
    if (n.nodeType === 3 && n.textContent.trim()) return false;
    n = n.nextSibling;
  }
  return true;
}

// Render mermaid diagrams: every <pre><code class="language-mermaid"> becomes a
// rendered SVG. Two gates keep half-finished or broken diagrams off screen:
// 1) streaming: a block still at the END of its body may lack its closing
//    fence (marked runs an unclosed fence to the end of the text) — wait for
//    the final event instead of drawing a half-finished diagram;
// 2) parse: mermaid.render resolves a huge error diagram on parse errors
//    instead of rejecting; mermaid.parse (v10+) is ASYNC and rejects on bad
//    syntax, so a broken source stays literal and is not re-parsed while
//    identical. (The old synchronous parse contract throws — the same
//    try/await/catch handles both shapes.)
async function renderMermaid(root, streaming = false) {
  if (typeof mermaid === "undefined" || !root) return;
  if (!mermaidInitialized) {
    mermaidInitialized = true;
    try {
      // Palette follows the UI (near-monochrome + red accent): every diagram
      // type has its own themeVariables keys, so all of them are overridden.
      //   strokes/lines -> accent red; fills/labels -> neutral dark greys
      //   (mermaid dark defaults to blue-grey #6b7b8f borders, a yellow note
      //   fill, and multicolour pie/git palettes — none fit the theme)
      const accent =
        (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "").trim() || "#EF4444";
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        themeVariables: {
          // --- strokes & lines: accent red ---
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
          // gantt — three states stay distinguishable within the theme:
          //   active (running) = red fill + dark text, most prominent
          //   normal (planned) = dark grey + red border
          //   done (archived)  = darker grey + grey border, least prominent
          // mermaid 10 reads the *BkgColor keys for fills (mermaid 9's plain
          // *Bkg names are ignored: active would default to blue #81B1DB, done
          // to lightgrey); borders keep no Color suffix; text is shared via
          // taskTextColor/taskTextLightColor (default white)
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
          // state diagrams (stateDiagram-v2): state nodes read stateBorder, but
          // the diagram's outer container (.stateGroup rect) is hard-coded to
          // the legacy border1 key (dark default #81B1DB blue) — override it
          // too; stateGroup label text also carries border1 but a later #ccc
          // rule wins, so text stays grey
          stateBorder: accent,
          border1: accent,
          // --- fills & labels: neutral dark greys (no yellow/blue/light) ---
          noteBkgColor: "#1c1c1f",
          noteTextColor: "#d4d4d8",
          edgeLabelBackground: "#1c1c1f",
          clusterBkg: "#1c1c1f",
          taskTextOutsideColor: "#a1a1aa",
          activationBkgColor: "#27272a",
          // --- pie: first slice gets the red accent, rest a grayscale ramp
          // (pie0 is an unused definition — pie rendering starts at pie1) ---
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
          // --- git graphs: grayscale + red (git0-git7) ---
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
      // Never let the parser's default error path paint its giant
      // "Syntax error in text" diagram: route parse errors to the console and
      // let showMermaidError present a small inline notice instead.
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
    // gate 2 — syntax check before the async render (render() would resolve an
    // error diagram instead of rejecting); broken source stays literal.
    // mermaid.parse is ASYNC in the bundled v10+: a bare try/catch could never
    // see its rejection, so the parse gate silently passed every broken source
    // and the error diagram reached the DOM. Await inside a plain for...of
    // (forEach callbacks can't await); a sync throw is caught the same way.
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
        // a later streaming delta may have rebuilt the DOM: re-locate a block
        // with this exact source before swapping, so the SVG never lands orphaned
        let target = null;
        for (const el of root.querySelectorAll("pre code.language-mermaid")) {
          if (el.textContent === src) { target = el.parentElement; break; }
        }
        if (!target) return;
        // gate 3 — mermaid.render can resolve a giant error diagram instead of
        // rejecting; never let that hit the DOM. The bundled v10+ jison parser
        // emits "Parse error on line N: Unexpected ..." (syntax) and "Lexical
        // error on line N. Unrecognized text." (lexer), older builds said
        // "Syntax error in text" — match every phrasing (the previous
        // exact-string check never matched v10 errors and let them through).
        // Keep the literal source with a small inline notice.
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
        // defensive: keep the literal source with a small notice; drop the
        // marker so a later identical source can retry once its text changes
        if (pre.isConnected) {
          showMermaidError(pre, e);
          delete pre.dataset.mermaidSrc;
        }
      });
  }
}

// A broken diagram must never paint mermaid's giant error SVG: mark the block
// as failed and attach one small inline notice while keeping the literal
// source readable/copyable. The parser's message (if any) goes into the tip's
// hover title so the on-screen text stays a short plain sentence.
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

// Map a file extension to a highlight.js language id and highlight a bare
// <pre> (read results). Unknown extensions fall back to the code child path.
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
  // completed summaries duplicate the streamed agent text; abort/error reasons
  // are the only place the termination cause is shown
  if (status !== "completed" && summary) {
    const note = document.createElement("div");
    note.className = "completion-note";
    note.textContent = summary;
    (pageSink || eventsEl).appendChild(note);
  }
  // live runs re-pin to the completion divider; during replay the end-scroll
  // at openProject already lands on the last record, so skip the pass.
  // If the user has scrolled up, don't yank them — the ↓ button is already shown.
  // Instant pin, not smooth: the completion divider often lands in the same
  // burst as trailing tool results, and a glide animation would fight them.
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
      // hard-wrapped markdown (breaks: true): the task is WYSIWYG — every line
      // break shows, LaTeX renders via typesetMath (gated by MATH_RE after the
      // block is in the DOM; the replay pass batches it separately)
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
        // show the file change as a unified diff (# Wrote <path> + coloured lines)
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

// Render markdown with marked + DOMPurify. LLM output is untrusted: DOMPurify
// strips any raw HTML/script before it reaches the DOM. Falls back to plain
// text if the vendor libs are unavailable (e.g. offline without the vendor
// files). breaks=true turns single newlines into <br> (hard wrap) — used for
// user tasks so the input is WYSIWYG; assistant output keeps soft wrap.
function renderMarkdown(text, breaks = false) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  try {
    const src = String(text);
    // Protect math ($...$, $$...$$) from marked's backslash escapes before
    // parsing: marked treats `\` + ASCII punctuation as markdown escapes and
    // would strip the backslash from LaTeX sequences like \! or \_ (turning
    // `\text{softmax}\!\left(` into a literal "!" and `\text{seq\_len}` into a
    // bare `_` that breaks \text). ⟦MATHn⟧ is plain Unicode: marked leaves it
    // alone and DOMPurify keeps it, so we can restore the exact math after.
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

// Render a unified diff string as a <pre> with per-line +/- colouring.
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
  // sending a message means "back to the live tail": commit to the tail
  // unconditionally — a dropped latch or an in-flight glide (reading history)
  // must not leave the fresh message below the fold
  followTail = true;
  autoScroll(true);
  // runs append to the active project's conversation; the mode travels with the
  // request so a switch only affects this run. project pins the target .clc so
  // the server never appends to another window's project.
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
  // the input box resize resizes the stream viewport; a shrink can clamp
  // scrollTop. The clamp fires a trusted scroll event that the listener above
  // ignores (via the shrunken-viewport fingerprint AND the armed time window),
  // so the latch stays latched — re-pin right here while the user is still
  // typing, otherwise the view would hover just off the tail until the next
  // content arrives.
  if (was !== els.task.style.height) {
    suppressLatchUntil = performance.now() + 120;
    if (followTail && !nearBottom()) autoScroll();
  }
}
els.task.addEventListener("input", autoGrowTask);

// ---- API settings modal ----
// The modal carries the LLM endpoint (base_url/model/reasoning_effort — what the
// agent talks to), persisted on the backend (~/.clutch/settings.json via
// /api/settings) and, through the preload bridge, in the client-side settings
// file the LLM reverse proxy reads (so SSH-mode upstream changes apply without
// restarting the app). There is no manual "Backend URL" field: the window's
// backend is always a supervisor session (local or tunnel), chosen by the main
// process.
//
// Named LLM profiles work like the saved SSH connections: stored in
// localStorage, picked from a dropdown, applied to the backend on selection.
// A profile stores the full form (base_url/model/api_key/reasoning_effort), so
// switching providers is one click instead of retyping the key.
// ---- custom dropdown ----
// Native <select> popups can't be themed or animated (Linux renders them as an
// HTML-default list), so the three pickers use this component: a button that
// opens a themed popup with a fade/slide-in. It mimics just enough of the
// <select> DOM API (innerHTML / appendChild / value / disabled /
// addEventListener("change")) that the existing render functions (renderLlmProfiles,
// renderConnSelector) work unchanged.
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
// reasoning-effort options (was a static <select> in the markup)
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
  // no "— profiles —" placeholder: an empty list means no profiles — disable
  // the picker (＋ New still works to create the first one)
  profileSelect.disabled = names.length === 0;
  profileSelect.value = names.includes(activeName) ? activeName : (names[0] || "");
  // Delete/Edit act on the SELECTED profile: grey them out when nothing is
  // selected so their purpose is obvious from the start.
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
// The settings modal is a profile manager: pick one to apply, ＋ New to create
// a BLANK profile (never prefilled), Edit to change the selected one, Delete to
// remove it. The url/key/model/reasoning fields live HERE.
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
  // a name is only a conflict when it belongs to a DIFFERENT profile (editing
  // the same profile under its own name is fine, and rename is allowed)
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
  // the settings modal is now a profile manager: the url/key/model fields live
  // in the profile editor (llm-profile-modal), so there is nothing to prefill
  renderLlmProfiles(localStorage.getItem("clutch_llm_active") || "");
}
function closeSettings() {
  closeModal(modal);
}
// Push the CURRENT profile-editor form values to the backend (the LLM endpoint,
// the proxy's local settings file). No modal close — callers decide.
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
    // Keep the client-side LLM reverse proxy in sync (SSH mode: the backend
    // above may be remote, but the proxy reads the LOCAL settings file).
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

// Close a modal only when the press STARTS on the overlay itself. The click
// event fires on the overlay even for a drag that begins inside the box and is
// released outside (mouse slips off the modal while typing) — mousedown targets
// the actual element under the button, so that slip can no longer close it.
function dismissOnOverlayPress(overlayEl, onClose) {
  overlayEl.addEventListener("mousedown", (e) => {
    if (e.target === overlayEl) onClose();
  });
}

const MODAL_CLOSE_MS = 180;

// Animated modal close: add .closing (fade the overlay, slide the box down),
// then land the .hidden display:none when the animation finishes. Opening
// functions remove .closing alongside .hidden, so a reopen mid-animation is
// clean (the pending close timer then becomes a no-op). Reduced motion closes
// instantly; re-entrant calls are no-ops.
function closeModal(overlayEl, onDone) {
  if (!overlayEl || overlayEl.classList.contains("hidden") || overlayEl.classList.contains("closing")) return;
  const finish = () => {
    // the modal was reopened before the animation finished: the open removed
    // .closing, so this stale timer must not hide it
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
  // select the actual host entry we're connected to (marked ✓) instead of adding a
  // synthetic URL option — picking qianli must leave qianli selected
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
      // connected via a path that didn't save the host (rare: e.g. manual URL):
      // still show the host we're on (user@host:port), not the raw tunnel URL
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

// Switch the active backend in place (SSH connect / disconnect / reset) without a
// full page reload: repoint API_BASE + the SSE stream. No picker side effects —
// callers refresh the picker explicitly (refreshPicker) when it's relevant.
function switchBackend(url) {
  API_BASE = url.replace(/\/+$/, "");
  localStorage.setItem("clutch_api_url", API_BASE);
  reconnectSSE();
}

// Ask the main process for the current backend URL (it owns the per-window
// session: local supervisor session, tunnel session, or direct) and switch to
// it. The renderer never guesses session ports — a guessed port dies with the
// session. A previously active SSH-degradation mode is re-applied to the new
// session (the degrade state lives in the old session process and dies with it).
async function switchBackendResolved() {
  if (!window.clutchApi) return false;
  const url = await window.clutchApi.baseUrl();
  if (url) {
    switchBackend(url);
    await reapplyDegradeIfNeeded();
  }
  return Boolean(url);
}

// SSH-degradation mode ("local agent, remote exec bridge") is a per-process
// setting on the agent server, so it dies with the session process. The marker
// is persisted in localStorage; whenever the session is (re)claimed — the main
// process falls back to a fresh local session when the tunnel has no
// supervisor, and that fresh session must be told about the bridge again —
// re-apply the mode to the CURRENT backend. Callers that intentionally exit
// degrade mode (disconnect/reset/tunnel end) MUST clear the marker first, or
// the next switchBackendResolved would resurrect it.
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
// A host with no Python and no matching bundle is still fully usable through the
// exec bridge: the local server runs the agent, and every file/command operation
// goes over the SSH tunnel. These two helpers toggle that mode on the local
// server's /api/backend. Both are best-effort against the local backend.
//
// Returns:
//   true     — degraded, ssh mode is active
//   false    — the tunnel itself is dead (a genuine connection failure; the
//              caller should show the SSH error, not a degrade message)
//   string   — the tunnel is up but the local backend is not: the reason the
//              SSH-tools fallback failed (this is the real failure to report)

async function tryDegradeToSshTools() {
  if (!window.clutchTunnel) return false;
  const s = await window.clutchTunnel.status();
  // degradable only while the tunnel itself is still alive: a dead tunnel has no
  // bridge to exec through (this also filters out genuine connection failures)
  if (!s.active || !s.execBridge) return false;
  // Resolve the current backend first: the tunnel may be live WITHOUT a
  // supervisor on the far end (that is exactly this host's situation), so the
  // main process falls back to a fresh local session — that session is the one
  // we must put into ssh mode (DEFAULT_BASE may be a dead URL from an earlier
  // session).
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
  // persist the mode: the session process may be re-created later (see
  // reapplyDegradeIfNeeded), taking the setting down with it
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

// Bring the file picker back to its normal browsing state after a connect or
// disconnect: show the body, load the (possibly new) backend's files, re-render
// the connection selector.
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
  // resolve immediately (the connect flow is waiting on it); only the visual
  // close is animated
  closeModal(passModal);
  if (passResolve) passResolve(null);
  passResolve = null;
}

let connBusy = false; // a connect is in flight: ignore re-clicks
let lastConn = null;  // { host, user, port, statusEl } of the last attempt (Retry)

// Collapse the whole picker body (path bar, file list, new-project area, action
// buttons) during an SSH connect or after a failure — only the conn bar with its
// single status line + progress bar remains, no duplicate message, no dead space.
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

// Connection progress bar: the tunnel reports coarse stages over IPC.
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
      // the tunnel's own URL is the SUPERVISOR control channel; the window's
      // API base is its per-window remote session, decided by the main process
      await switchBackendResolved();
      refreshPicker();
      return true;
    } else {
      // hard bootstrap reject (host alive, but no Python/bundle to install):
      // degrade to SSH-tools — local server runs the agent, tools go over the bridge
      const degraded = await tryDegradeToSshTools();
      if (degraded === true) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        await switchBackendResolved(); // the local server is now remote-backed
        refreshPicker();
        return true;
      }
      // false: the tunnel never came up — report the real SSH error.
      // string: the tunnel is up but the local backend is down — that is the
      // real failure here, not the device's bootstrap message.
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

// New-connection popup (only shown when the user asks to add an SSH host)
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

// Reconcile the renderer's stored backend URL with the tunnel's real state and
// return the URL it should point at (or null if already correct). No UI side
// effects — the caller switches and refreshes. A live tunnel is authoritative; a
// dead-tunnel leftover (the connected flag is set) falls back to the local
// backend instead of pointing every fetch at a dead port ("Failed to fetch").
// Degraded mode counts as connected too: the tunnel has no forward URL, but its
// exec bridge is live, so the local server is the right target.
//
// Note: URL shape can no longer distinguish "tunnel leftover" from "local
// session" — since the machine-supervisor architecture, local sessions also
// listen on 127.0.0.1:<random port>. The connected flag is the only
// authoritative marker.
async function reconciledBackendUrl() {
  if (!window.clutchTunnel) return null;
  const s = await window.clutchTunnel.status();
  const override = localStorage.getItem("clutch_api_url");
  const flag = localStorage.getItem("clutch_ssh_connected");
  if (s.active) {
    // a live tunnel is authoritative: the main process owns this window's
    // session URL (tunnel session) — ask it instead of guessing
    const target = await window.clutchApi.baseUrl();
    if (target && override !== target) {
      localStorage.setItem("clutch_ssh_connected", "1");
      return target;
    }
    return null;
  }
  if (flag) {
    // stale SSH leftover: fall back to the local backend — resolved via the
    // main process (it owns the per-window session; DEFAULT_BASE may be a dead
    // URL after a tunnel session was claimed over it)
    localStorage.removeItem("clutch_ssh_connected");
    await switchBackendResolved();
    return null; // switchBackendResolved already switched
  }
  return null;
}

// When a live tunnel dies mid-session (not an intentional disconnect), fall back to
// the local backend in place so the UI stops failing; refresh the picker only when
// it is open (a closed picker must not fire background directory fetches).
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

// The main process re-established this window's session (it died on the remote
// or locally): point the app at the new URL. SSE reconnects through
// switchBackend; a null URL means no backend is possible right now.
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
  // the response must fire immediately (the agent is blocked on it); only the
  // visual close is animated — pendingPerm clears here to guard double-clicks
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

// Hidden files (dotfiles) are hidden everywhere — picker (open/new) and workspace
// tree — until the shared toggle turns them on.
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

// File changes only happen through tool results (write_file / run_command, or any
// future FS tool): schedule a debounced refresh instead of polling. Change
// detection skips re-rendering when nothing changed, preserving expansion state.
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
    // the payload depends on expansion state too: include it so a toggle always
    // re-renders (e.g. expanding an empty dir changes nothing in the payload)
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
        // clear the container first: rapid expand/collapse toggles reuse this
        // element (the debounced refresh hasn't rebuilt it), so appending without
        // clearing stacks another copy of the children on every expand
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
  // ?project= scopes the stream to this window's .clc: the server replays that
  // project's history and filters live events to its runs, so multiple windows
  // on different projects never see each other. replay=0 is used right after
  // openProject/createProject, which already rendered the history themselves.
  const qs = new URLSearchParams();
  if (currentProject) qs.set("project", currentProject);
  qs.set("replay", replay ? "1" : "0");
  es = new EventSource(API_BASE + "/api/events?" + qs.toString());
  es.onmessage = (e) => {
    try { addEvent(JSON.parse(e.data)); } catch (err) {}
  };
  // On (re)connect the server replays the stored history as durable final events;
  // reset the streaming state so each replayed assistant_message renders once.
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

// Point the SSE stream at the (possibly new) API_BASE. Only re-create an existing
// stream; when es is still null (startup reconcile runs before the first connect)
// the caller's connectSSE() will create the single stream against the fixed URL.
function reconnectSSE(replay = true) {
  if (!es) return;
  es.close();
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
// A lazy .clc loads only the model window (since the newest compaction line); the
// pill at the top pages the earlier records from /api/history. olderRemaining
// mirrors the server-side count of event-region BYTES still on disk before the
// oldest loaded one — the server's own number, so a dropped page never makes the
// pill lie (a page the server dropped stays rendered in the DOM; only a reconnect
// re-fetches it).
let olderRemaining = 0;
let oldestOffset = null; // byte offset of the oldest loaded (rendered) non-task event
let paging = false;   // one history fetch at a time
// when non-null, addEvent appends into this off-DOM sink instead of #events:
// loadOlder renders a history page through the full replay pipeline (agent text,
// thinking, tool groups, completions), then prepends the sink in one pass.
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
    // Render the page chronologically through addEvent into an off-DOM sink so
    // agent text, thinking, tool groups and completions build exactly as during
    // the open replay — then prepend the sink in one pass. Live-stream state is
    // saved/restored around the build: the page must not merge into (or clobber)
    // an in-progress live turn, and the sink's own state dies with the sink.
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
    // typeset AFTER insertion: MathJax needs real layout, and any height it adds
    // must be accounted for before the anchor re-adjusts the scroll position
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
          // lazy open: "older" is the count of durable records still on disk
          // before the loaded tail — the pill's starting value
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
        // yield periodically so the browser can paint the progress bar and
        // stream events progressively instead of one blocking burst
        if (++processed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    // phase C: typeset replayed math as the remaining 90-100%, so the bar stays
    // alive through typesetting and there is no blank gap before reveal
    await typesetProgressively(eventsEl, (f) => setPct(90 + 10 * f));
    if (started) setPct(100);
    prog.classList.add("hidden");
    stream.classList.remove("loading"); // instant reveal — no fade, no replay
    stream.scrollTop = stream.scrollHeight; // jump straight to the end of the record
    // re-scope the live stream to the newly opened project; replay=0 because
    // the NDJSON stream above just rendered the history
    reconnectSSE(false);
    refreshTree();
  } catch (e) {
    prog.classList.add("hidden");
    stream.classList.remove("loading");
    // the same project is open (for write) in another window: offer read-only
    // instead of failing — reads are fully functional, runs are rejected by
    // the server with a clear reason
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
    // the tunnel log (main process) is the place to look: a network-level
    // "Failed to fetch" here usually means the remote session forward died —
    // check ~/.clutch/tunnel.log for "[session] forwardOut failed" / the
    // remote supervisor log for a reaped/crashed session child
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
  // settle the stored URL against the tunnel's real state first, then list + draw
  // the selector once against the correct backend (no double loadDir)
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

async function loadDir(path, remember = true) {
  const listEl = $("#fs-list");
  listEl.innerHTML = '<div class="fs-row plain">loading…</div>';
  try {
    const r = await fetch(
      API_BASE + "/api/fs/list?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "")
    );
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || r.status);
    fsPath = data.path;
    fsParent = data.parent;
    // remember the last browsed directory so the browser reopens there next time
    // (the picker's own re-lists pass remember=false and must not overwrite it)
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
    // a remembered last directory may be gone (backend switch, deleted dir):
    // forget it and retry from the home directory once — only show the error
    // UI for the retry (a retry that fails again has path=="" and no record)
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

// settle the stored URL against the tunnel's real state before connecting SSE, so
// the stream targets the right backend; reconnectSSE() no-ops while es is null, so
// a switch here leaves connectSSE() below to create the single stream
(async () => {
  await resolveApiBase(); // learn this window's session port (IPC) first
  const url = await reconciledBackendUrl();
  if (url) switchBackend(url);
  connectSSE();
})();
