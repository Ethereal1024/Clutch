"use strict";

// Where the agent API lives. Resolution order: in-app setting (localStorage) >
// Electron preload env (window.clutchApi.baseUrl) > default localhost. API_BASE is
// reassigned in place by switchBackend() when the backend changes (SSH connect /
// disconnect), so the UI never needs a full reload.
const DEFAULT_BASE =
  (window.clutchApi && window.clutchApi.baseUrl) ||
  "http://127.0.0.1:8890";
let API_BASE = (localStorage.getItem("clutch_api_url") || DEFAULT_BASE).replace(/\/+$/, "");

const $ = (s) => document.querySelector(s);

const els = {
  task: $("#task-input"),
  run: $("#run-btn"),
  status: $("#status"),
  stream: $("#stream"),
  tree: $("#tree"),
  workspace: $("#workspace-path"),
  projectLabel: $("#project-label"),
};

let busy = false;
const stream = $("#stream");
const eventsEl = document.getElementById("events");

// Follow the tail of the stream, but never during project-load: the content is
// hidden then, so scrolling would only chase invisible events and drag the
// pinned progress bar out of view.
function autoScroll() {
  if (!stream.classList.contains("loading")) stream.scrollTop = stream.scrollHeight;
}

function setStatus(state) {
  els.status.className = "badge " + (state || "idle");
  els.status.textContent = state || "idle";
  busy = state === "running" || state === "waiting";
  // the run button doubles as Stop while a run is in progress
  els.run.textContent = busy ? "■ Stop" : "▶ Run";
  els.run.classList.toggle("stop-mode", busy);
  els.run.disabled = busy ? false : !currentProject;
}

// tracks the most recent agent text block (created by streaming text_delta)
let lastTextEl = null;
let lastTextContent = "";
// thinking (reasoning) block
let thinkingEl = null;
let thinkingContent = "";

// map tool_call_id -> {name, args} so a tool_result knows which tool produced it
const toolCalls = {};
// the group block currently collecting consecutive tool_calls (for merging)
let toolGroupEl = null;

function isReadTool(name) {
  return name === "read_file" || name === "list_dir";
}

// Render one tool_call row; consecutive calls append to the same group block.
// Read tools (read_file/list_dir) keep their results in the same block too.
function addToolCallRow(ev) {
  const readGroup = isReadTool(ev.name);
  if (!toolGroupEl || toolGroupEl.closed || toolGroupEl.readGroup !== readGroup) {
    toolGroupEl = {
      el: document.createElement("div"),
      ids: new Set(),
      readGroup,
      closed: false,
    };
    toolGroupEl.el.className = "event tool_group";
    toolGroupEl.el.innerHTML = '<div class="hdr">tools</div>';
    eventsEl.appendChild(toolGroupEl.el);
  }
  toolGroupEl.ids.add(ev.tool_call_id);
  const row = document.createElement("div");
  row.className = "tool-row";
  row.innerHTML = `<span class="tool-name">${escapeHtml(ev.name)}</span>`;
  // args expandable per row
  let argsTxt = ev.arguments;
  try { argsTxt = JSON.stringify(JSON.parse(ev.arguments), null, 1); } catch (e) {}
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
  toolGroupEl.el.appendChild(row);
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

// Build one collapsible read row (toggle + summary + hidden code panel).
// Shared by the tool-group path and the standalone renderEvent path.
function buildReadRow(call, content) {
  const toolName = call.name || "";
  const path = (call.args && call.args.path) || "";
  const summary = toolName === "list_dir"
    ? `${content ? content.split("\n").length : 0} entries`
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
  // history replay: stale live-control events (status, permission) must not
  // drive the current UI — the badge/busy state belongs to the live run
  if (stream.classList.contains("loading") &&
      (ev.type === "state_update" || ev.type === "permission_request")) {
    return;
  }
  // events that break a tool group: new user turn, agent text, thinking, final.
  // assistant_message is just a record (not shown) and does NOT break the group,
  // because results follow the tool_calls they belong to.
  if (["user_message", "text_delta", "reasoning_delta", "final", "step_start"].includes(ev.type)) {
    toolGroupEl = null;
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
    // deltas arrive before text deltas)
    if (ev.reasoning) appendThinkingRow(ev.reasoning);
    if (ev.content) {
      const wrap = createAgentTextBlock();
      wrap.querySelector(".body").innerHTML = renderMarkdown(ev.content);
      highlightCode(wrap);
      eventsEl.appendChild(wrap);
    }
    return;
  }
  if (ev.type === "final") {
    // completion divider; for non-completed runs the summary carries the reason
    appendCompletion(ev.status, ev.summary);
    refreshTree(); // a run finished; reflect any new files in the tree
    return;
  }
  if (ev.type === "tool_call" && ev.tool_call_id) {
    let args = {};
    try { args = JSON.parse(ev.arguments || "{}"); } catch (e) {}
    toolCalls[ev.tool_call_id] = { name: ev.name, args };
    addToolCallRow(ev);
    return;
  }

  // read tool results merge into the group block; other results render independently
  if (ev.type === "tool_result" && toolGroupEl && toolGroupEl.ids.has(ev.tool_call_id)) {
    const call = toolCalls[ev.tool_call_id] || { name: "" };
    if (isReadTool(call.name)) {
      addReadResultRow(ev);
      toolGroupEl.closed = true; // this group's calls have completed
      return;
    }
  }

  // streaming text: accumulate into the existing agent block and re-render
  if (ev.type === "text_delta" && ev.content) {
    if (!lastTextEl) {
      lastTextEl = createAgentTextBlock();
      eventsEl.appendChild(lastTextEl);
    }
    lastTextContent += ev.content;
    lastTextEl.querySelector(".body").innerHTML = renderMarkdown(lastTextContent);
    highlightCode(lastTextEl);
    if (!stream.classList.contains("loading")) typesetMath(lastTextEl); // deferred during load
    autoScroll();
    return;
  }

  // streaming reasoning: compact row while streaming, expandable on click
  if (ev.type === "reasoning_delta" && ev.content) {
    thinkingContent += ev.content;
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "event thinking";
      thinkingEl.innerHTML = '<div class="hdr">thinking</div>';
      const row = document.createElement("div");
      row.className = "thinking-row";
      const toggle = document.createElement("span");
      toggle.className = "read-toggle";
      toggle.textContent = "▸";
      const lbl = document.createElement("span");
      lbl.className = "thinking-label";
      row.appendChild(toggle);
      row.appendChild(lbl);
      thinkingEl.appendChild(row);
      const full = document.createElement("pre");
      full.className = "thinking-full";
      full._content = ""; // per-block copy; survives step_start resetting the globals
      const fold = wrapFold(full);
      thinkingEl.appendChild(fold);
      // click toggles between the compact row and the full reasoning text
      row.onclick = () => {
        const wasHidden = toggleFold(fold, () => { full.textContent = full._content; });
        toggle.textContent = wasHidden ? "▾" : "▸";
      };
      eventsEl.appendChild(thinkingEl);
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
    eventsEl.appendChild(el);
    autoScroll();
  }
}

function createAgentTextBlock() {
  const wrap = document.createElement("div");
  wrap.className = "event text";
  wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
  return wrap;
}

// Height animation shared by the diff expand (partial collapse to 140px): animates
// an explicit height via WAAPI; overflow-y is suppressed so no scrollbar shifts.
const FOLD_EASE = "cubic-bezier(.23, 1, .32, 1)";

function animateFold(el, from, to, onDone) {
  if (el._foldAnim) { try { el._foldAnim.cancel(); } catch (e) {} }
  el._foldAnim = null;
  el.style.overflowY = "hidden";
  el.style.height = from + "px";
  const settle = () => {
    if (el._foldAnim) { try { el._foldAnim.cancel(); } catch (e) {} }
    el._foldAnim = null;
    onDone();
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

function foldExpand(fold) {
  if (fold._foldAnim) { try { fold._foldAnim.cancel(); } catch (e) {} }
  fold._foldAnim = null;
  fold.classList.remove("hidden");
  if (reducedMotion()) { fold.classList.add("open"); return; }
  const anim = fold.animate(
    [{ gridTemplateRows: "0fr" }, { gridTemplateRows: "1fr" }],
    { duration: 200, easing: FOLD_EASE }
  );
  fold._foldAnim = anim;
  anim.onfinish = () => { fold._foldAnim = null; fold.classList.add("open"); };
}

function foldCollapse(fold, onDone) {
  if (fold._foldAnim) { try { fold._foldAnim.cancel(); } catch (e) {} }
  fold._foldAnim = null;
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

// A collapsed thinking row rebuilt once from a stored assistant_message.reasoning
// (used when a stored session replays without reasoning_delta stream).
function appendThinkingRow(reasoning) {
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
  lbl.textContent = "thinking";
  row.appendChild(toggle);
  row.appendChild(lbl);
  el.appendChild(row);
  const full = document.createElement("pre");
  full.className = "thinking-full";
  full.textContent = reasoning;
  const fold = wrapFold(full);
  el.appendChild(fold);
  row.onclick = () => {
    const wasHidden = toggleFold(fold);
    toggle.textContent = wasHidden ? "▾" : "▸";
  };
  eventsEl.appendChild(el);
}

// Render LaTeX ($...$, $$...$$) inside a freshly-inserted markdown block.
// MathJax scans text nodes; pre/code are skipped via skipHtmlTags so code stays
// literal. Content is already DOMPurify-sanitized before this runs.
const MATH_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/;

function typesetMath(el) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  if (!el || !MATH_RE.test(el.textContent)) return;
  MathJax.typesetPromise([el]).catch(() => {});
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
  const blocks = Array.from(root.querySelectorAll(".event.text .body")).filter(hasMathText);
  if (!blocks.length) return;
  for (let i = 0; i < blocks.length; i++) {
    try { await MathJax.typesetPromise([blocks[i]]); } catch (e) {}
    onPct((i + 1) / blocks.length);
    await new Promise((r) => setTimeout(r, 0)); // let the bar repaint between blocks
  }
}

// Syntax-highlight every <pre><code> inside a freshly rendered block.
// Marked only emits a fenced <pre> once the closing ``` has arrived, so
// streaming renders stay clean (no half-block flicker).
function highlightCode(root) {
  if (typeof hljs === "undefined" || !root) return;
  root.querySelectorAll("pre code").forEach((el) => {
    try { hljs.highlightElement(el); } catch (e) {}
  });
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
  eventsEl.appendChild(div);
  // completed summaries duplicate the streamed agent text; abort/error reasons
  // are the only place the termination cause is shown
  if (status !== "completed" && summary) {
    const note = document.createElement("div");
    note.className = "completion-note";
    note.textContent = summary;
    eventsEl.appendChild(note);
  }
  // live runs glide to the completion divider; during replay the end-scroll
  // at openProject already lands on the last record, so skip the smooth pass
  if (!stream.classList.contains("loading")) {
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
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
      body.className = "body md-plain";
      body.textContent = ev.content;
      break;
    }
    case "tool_result": {
      const call = toolCalls[ev.tool_call_id] || { name: "", args: {} };
      const toolName = call.name || "";
      const isRead = isReadTool(toolName);
      const isWrite = toolName === "write_file";
      // any tool that could change the filesystem (blacklist of read-only tools)
      if (toolName && !isRead && toolName !== "load_skill") scheduleTreeRefresh();

      wrap.className = "event tool_result" + (ev.is_error ? " error" : "")
        + (isRead ? " read" : "") + (isWrite ? " write" : "");
      const hdr = isWrite ? "✓ wrote" : (ev.is_error ? "result ⚠" : "result");
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

// Render LLM output as markdown. LLM output is untrusted: DOMPurify strips any
// raw HTML/script before it reaches the DOM. Falls back to plain text if the
// vendor libs are unavailable (e.g. offline without the vendor files).
function renderMarkdown(text) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  try {
    return DOMPurify.sanitize(marked.parse(String(text)));
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
  // runs append to the active project's conversation
  const payload = { task };
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
els.task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
});

// ---- task input auto-grow (grows as you type, shrinks back after sending) ----
const TASK_BASE_H = els.task.offsetHeight; // default 3-row height
function autoGrowTask() {
  if (!els.task.value.trim()) {
    els.task.style.height = TASK_BASE_H + "px";
    return;
  }
  els.task.style.height = "auto";
  els.task.style.height = Math.min(els.task.scrollHeight, Math.round(window.innerHeight * 0.3)) + "px";
}
els.task.addEventListener("input", autoGrowTask);

// ---- API settings modal ----
const modal = $("#settings-modal");
const keyInput = $("#api-key-input");
const urlInput = $("#backend-url-input");

function openSettings() {
  modal.classList.remove("hidden");
  keyInput.value = localStorage.getItem("clutch_api_key") || "";
  urlInput.value = localStorage.getItem("clutch_api_url") || "";
  keyInput.focus();
}
function closeSettings() {
  modal.classList.add("hidden");
}
async function saveSettings() {
  const key = keyInput.value.trim();
  const url = urlInput.value.trim();
  if (url) localStorage.setItem("clutch_api_url", url);
  else localStorage.removeItem("clutch_api_url");
  if (!key) {
    closeSettings();
    return;
  }
  try {
    const r = await fetch(API_BASE + "/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    localStorage.setItem("clutch_api_key", key);
    closeSettings();
  } catch (e) {
    closeSettings();
    addEvent({ type: "final", status: "error", summary: "save settings failed: " + e.message });
  }
}
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-save").addEventListener("click", saveSettings);
$("#settings-close").addEventListener("click", closeSettings);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeSettings();
});

// ---- SSH connection (in the project picker) ----
const connSelect = $("#conn-select");
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
  localOpt.textContent = "Local backend (127.0.0.1:8890)";
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
// full page reload: repoint API_BASE + the SSE stream, then re-load the picker.
function switchBackend(url) {
  API_BASE = url.replace(/\/+$/, "");
  localStorage.setItem("clutch_api_url", API_BASE);
  showPickerBody(); // a connect is over: bring the path bar + file list back
  reconnectSSE();
  loadDir(""); // show the new backend's files right in the picker
  renderConnSelector();
}

function showPasswordPrompt(label) {
  return new Promise((resolve) => {
    passLabel.textContent = label;
    passInput.value = "";
    passResolve = resolve;
    passModal.classList.remove("hidden");
    passInput.focus();
  });
}

function closePasswordPrompt() {
  passModal.classList.add("hidden");
  if (passResolve) passResolve(null);
  passResolve = null;
}

let connBusy = false; // a connect is in flight: ignore re-clicks

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
  $("#conn-hint").classList.add("hidden");
  $("#conn-reset").classList.add("hidden");
}

// Connection progress bar: the tunnel reports coarse stages over IPC.
const CONN_STAGES = {
  auth: { pct: 10, label: "Connecting…" },
  probe: { pct: 22, label: "Inspecting remote…" },
  install: { pct: 35, label: "Installing remote server…" },
  "install:upload": { pct: 45, label: "Uploading server…" },
  "install:start": { pct: 70, label: "Starting server…" },
  assist: { pct: 45, label: "Guided install in progress…" },
  forward: { pct: 90, label: "Starting tunnel…" },
};
function updateConnProgress(stage) {
  const s = CONN_STAGES[stage];
  if (!s) return;
  connStatus.textContent = s.label;
  for (const bar of [$("#conn-progress"), $("#conn-new-progress")]) {
    if (bar.classList.contains("hidden")) continue;
    const fill = bar.querySelector(".conn-progress-fill");
    fill.classList.remove("indeterminate");
    fill.style.width = s.pct + "%";
  }
}

function setFsConnecting(host, statusEl) {
  connStatus.textContent = "Connecting to " + host + "…";
  hidePickerBody();
  $("#conn-reset").classList.add("hidden");
  $("#conn-hint").classList.remove("hidden"); // what the collapsed area is for
  // animate the bar under the active modal (the new-connection popup has its own)
  const bar = statusEl && statusEl.id === "conn-new-status" ? $("#conn-new-progress") : $("#conn-progress");
  bar.classList.remove("hidden");
  const fill = bar.querySelector(".conn-progress-fill");
  fill.classList.add("indeterminate");
  fill.style.width = "";
}

function setFsConnectError(msg) {
  connStatus.textContent = "Connection failed: " + msg;
  hidePickerBody();
  $("#conn-hint").classList.add("hidden");
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-reset").classList.remove("hidden"); // in-place recovery back to local
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
  connBusy = true;
  statusEl.textContent = "connecting…";
  setFsConnecting(host, statusEl);
  try {
    // try keys/agent first; only prompt for a password if auth fails
    let res = await window.clutchTunnel.connect({ host, user, port: Number(port) });
    if (!res.ok && res.error && /authentication/i.test(res.error) && !res.needsAssist) {
      const pw = await showPasswordPrompt("Password for " + user + "@" + host);
      if (!pw) {
        statusEl.textContent = "connection cancelled";
        setFsConnectError("connection cancelled");
        return;
      }
      res = await window.clutchTunnel.connect({ host, user, port: Number(port), password: pw });
    }
    if (res.needsAssist) {
      statusEl.textContent =
        "Remote environment not recognized (" + (res.error || "?") + "). Running LLM-guided install…";
      const a = await window.clutchTunnel.assist();
      if (a.ok) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        switchBackend(a.url); // stay in the picker, now against the remote
        return true;
      } else {
        statusEl.textContent = "auto-install failed: " + (a.error || "unknown");
        setFsConnectError("auto-install failed: " + (a.error || "unknown"));
      }
      return;
    }
    if (res.ok) {
      upsertConn(host, user, port);
      localStorage.setItem("clutch_ssh_connected", "1");
      switchBackend(res.url); // stay in the picker, now against the remote
      return true;
    } else {
      statusEl.textContent = "connection failed: " + (res.error || "unknown");
      setFsConnectError(res.error || "unknown");
    }
  } catch (e) {
    statusEl.textContent = "connection failed: " + e.message;
    setFsConnectError(e.message);
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
      switchBackend(DEFAULT_BASE); // stay in the picker, back to the local backend
    }
    return;
  }
  if (v.startsWith("ssh:") && !v.includes("__connected__")) {
    // switching: drop any current tunnel first, then connect to the new host
    if (localStorage.getItem("clutch_ssh_connected")) {
      await window.clutchTunnel.disconnect();
      localStorage.removeItem("clutch_ssh_connected");
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
  connNewModal.classList.remove("hidden");
  connNewHost.focus();
}
function closeConnNew() {
  connNewModal.classList.add("hidden");
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
connNewModal.addEventListener("click", (e) => {
  if (e.target === connNewModal) closeConnNew();
});
connNewHost.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#conn-new-connect").click();
});
$("#conn-reset").addEventListener("click", () => {
  localStorage.removeItem("clutch_ssh_connected");
  switchBackend(DEFAULT_BASE); // in-place fallback to the local backend
});
if (window.clutchTunnel && window.clutchTunnel.onProgress) {
  window.clutchTunnel.onProgress(updateConnProgress); // drive the connect progress bar
}
$("#ssh-pass-ok").addEventListener("click", () => {
  const pw = passInput.value;
  passModal.classList.add("hidden");
  if (passResolve) passResolve(pw);
  passResolve = null;
});
$("#ssh-pass-cancel").addEventListener("click", closePasswordPrompt);
passModal.addEventListener("click", (e) => {
  if (e.target === passModal) closePasswordPrompt();
});
passInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#ssh-pass-ok").click();
});

// True for URLs that look like SSH-tunnel leftovers (127.0.0.1 on a non-default
// port); manual LAN/domain backend URLs are not affected.
function isTunnelLike(url) {
  try {
    const u = new URL(url);
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port !== "8890";
  } catch (e) {
    return false;
  }
}

// Drop a stale backend URL: a live tunnel is authoritative (a stale stored URL
// must not survive), and a dead-tunnel leftover (flag set, or a 127.0.0.1:<port>
// that isn't the default) is cleared so the UI falls back to the local backend
// instead of pointing every fetch at a dead port ("Failed to fetch").
// Reconcile the renderer's stored backend URL with the tunnel's real state. A
// live tunnel is authoritative (its URL wins, even if the stored one was cleared);
// with no tunnel, SSH leftovers are cleared so the UI falls back to local.
async function reconcileStaleTunnel() {
  if (!window.clutchTunnel) return;
  const s = await window.clutchTunnel.status();
  const override = localStorage.getItem("clutch_api_url");
  if (s.active && s.url) {
    if (override !== s.url) {
      localStorage.setItem("clutch_ssh_connected", "1");
      switchBackend(s.url); // a live tunnel is authoritative
    }
    return;
  }
  if (!s.active && (override || localStorage.getItem("clutch_ssh_connected"))) {
    if (isTunnelLike(override) || localStorage.getItem("clutch_ssh_connected")) {
      localStorage.removeItem("clutch_ssh_connected");
      switchBackend(DEFAULT_BASE); // stale tunnel leftover: fall back to local
    } else {
      localStorage.removeItem("clutch_ssh_connected"); // manual backend URL: keep it
    }
  }
}

// When a live tunnel dies mid-session (not an intentional disconnect), fall back to
// the local backend in place so the UI stops failing.
if (window.clutchTunnel) {
  window.clutchTunnel.onEnd(() => {
    if (localStorage.getItem("clutch_ssh_connected")) {
      localStorage.removeItem("clutch_ssh_connected");
      switchBackend(DEFAULT_BASE);
    }
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
  try { txt = JSON.stringify(JSON.parse(txt), null, 2); isJson = true; } catch (e) {}
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
  permModal.classList.remove("hidden");
  setStatus("waiting");
}
function closePerm() {
  permModal.classList.add("hidden");
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
permModal.addEventListener("click", (e) => {
  if (e.target === permModal) respondPerm(false);
});

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
        // reveal the pre-loaded lookahead level instantly, then fetch deeper
        if (node.children && node.children.length) {
          row.querySelector(".icon").textContent = "▾";
          for (const c of node.children) children.appendChild(renderNode(c, depth + 1));
          children.style.display = "";
        }
      }
      refreshTree(); // payload depends on expandedDirs; the re-render keeps expansion
    });
    // children are siblings of the row, so the row's hover box never covers the subtree
    wrap.appendChild(children);
  }
  return wrap;
}

// ---- SSE live stream + session list ----
let es = null;

function connectSSE() {
  es = new EventSource(API_BASE + "/api/events");
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
    // the backend (re)connected, possibly after a self-heal restart: resync the tree
    refreshTree();
  };
  es.onerror = () => { /* auto-reconnect */ };
}

// Point the SSE stream at the (possibly new) API_BASE.
function reconnectSSE() {
  if (es) es.close();
  connectSSE();
}

let currentProject = ""; // path of the active .clc project file

function clearStream() {
  eventsEl.innerHTML = ""; // clear session content; the overlay/events wrapper stay mounted
  lastTextEl = null;
  lastTextContent = "";
  thinkingEl = null;
  thinkingContent = "";
}

function setProjectInfo(info) {
  currentProject = info.project || "";
  els.projectLabel.textContent = info.name || "";
  els.projectLabel.title = currentProject;
  if (info.workdir) els.workspace.textContent = info.workdir;
  setStatus("idle");
}

function hideWelcome() {
  document.getElementById("welcome").classList.add("hidden");
  els.run.disabled = busy || !currentProject;
}

async function openProject(path) {
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
      body: JSON.stringify({ path }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || r.status);
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
        if (msg.error) throw new Error(msg.error);
        if (msg.meta) {
          setProjectInfo({
            project: msg.meta.project,
            name: msg.meta.name,
            workdir: msg.meta.workdir,
          });
          hideWelcome();
          started = true;
        } else if (msg.count) {
          totalEvents = msg.count;
        } else if (msg.progress && msg.progress.total) {
          // phase A: server file parse maps to the first 50% of the bar
          setPct(50 * msg.progress.done / msg.progress.total);
        } else if (msg.event) {
          addEvent(msg.event);
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
    refreshTree();
  } catch (e) {
    prog.classList.add("hidden");
    stream.classList.remove("loading");
    alert("Failed to open project: " + e.message);
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
  renderConnSelector();
  fsModal.classList.remove("hidden");
  reconcileStaleTunnel(); // sync the picker to the tunnel's real state, then load
  loadDir("");
}

function closeFsBrowser() {
  fsModal.classList.add("hidden");
}

function fsRow(label, cls, onClick) {
  const row = document.createElement("div");
  row.className = "fs-row " + cls;
  row.textContent = label;
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

async function loadDir(path) {
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
    listEl.innerHTML = "";
    listEl.appendChild(
      fsRow(
        "Cannot reach backend at " + API_BASE + " (" + (e.message || e) + "). Reconnect SSH or check the backend URL.",
        "error-row"
      )
    );
    listEl.appendChild(
      fsRow("Reset to local backend", "action", () => {
        localStorage.removeItem("clutch_ssh_connected");
        switchBackend(DEFAULT_BASE);
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
fsModal.addEventListener("click", (e) => {
  if (e.target === fsModal) closeFsBrowser();
});

$("#new-project-btn").addEventListener("click", () => openFsBrowser("new"));
$("#open-project-btn").addEventListener("click", () => openFsBrowser("open"));
$("#welcome-new").addEventListener("click", () => openFsBrowser("new"));
$("#welcome-open").addEventListener("click", () => openFsBrowser("open"));

// connect SSE first, then reconcile: switchBackend() (used by the reconcile) needs
// an existing stream to close/recreate against the corrected URL
connectSSE();
reconcileStaleTunnel();
