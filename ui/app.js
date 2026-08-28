"use strict";

// Where the agent API lives. Resolution order: in-app setting (localStorage) >
// Electron preload env (window.clutchApi.baseUrl) > default localhost.
const API_BASE =
  ((localStorage.getItem("clutch_api_url") || "").replace(/\/+$/, "")) ||
  (window.clutchApi && window.clutchApi.baseUrl) ||
  "http://127.0.0.1:8890";

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
    if (ev.content) {
      const wrap = createAgentTextBlock();
      wrap.querySelector(".body").innerHTML = renderMarkdown(ev.content);
      highlightCode(wrap);
      eventsEl.appendChild(wrap);
    }
    if (ev.reasoning) appendThinkingRow(ev.reasoning);
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
  sshHost.value = localStorage.getItem("clutch_ssh_host") || "";
  sshUser.value = localStorage.getItem("clutch_ssh_user") || "";
  sshPort.value = localStorage.getItem("clutch_ssh_port") || "22";
  sshPassword.value = ""; // never persist the SSH password
  renderSshStatus();
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

// ---- SSH tunnel to a remote backend ----
const sshHost = $("#ssh-host-input");
const sshUser = $("#ssh-user-input");
const sshPort = $("#ssh-port-input");
const sshPassword = $("#ssh-password-input");
const sshStatus = $("#ssh-status");

function renderSshStatus() {
  if (!window.clutchTunnel) {
    sshStatus.textContent = "SSH requires the desktop app (Electron).";
    return;
  }
  const override = localStorage.getItem("clutch_api_url");
  sshStatus.textContent = override
    ? "Connected: " + override
    : "Not connected. Using " + API_BASE + ".";
}

async function connectSsh() {
  if (!window.clutchTunnel) return;
  const host = sshHost.value.trim();
  const user = sshUser.value.trim();
  const port = sshPort.value.trim() || "22";
  if (!host || !user) {
    sshStatus.textContent = "host and user are required";
    return;
  }
  sshStatus.textContent = "connecting…";
  try {
    const res = await window.clutchTunnel.connect({
      host,
      user,
      port: Number(port),
      password: sshPassword.value,
    });
    if (res.needsAssist) {
      // exotic remote: ask before spending LLM tokens on the guided installer
      sshStatus.textContent =
        "Remote environment not recognized (" + (res.error || "?") + "). Running LLM-guided install…";
      const a = await window.clutchTunnel.assist();
      if (a.ok) {
        localStorage.setItem("clutch_api_url", a.url);
        localStorage.setItem("clutch_ssh_connected", "1");
        location.reload();
      } else {
        sshStatus.textContent = "auto-install failed: " + (a.error || "unknown");
      }
      return;
    }
    if (res.ok) {
      localStorage.setItem("clutch_ssh_host", host);
      localStorage.setItem("clutch_ssh_user", user);
      localStorage.setItem("clutch_ssh_port", port);
      localStorage.setItem("clutch_api_url", res.url);
      localStorage.setItem("clutch_ssh_connected", "1");
      location.reload();
    } else {
      sshStatus.textContent = "connection failed: " + (res.error || "unknown");
    }
  } catch (e) {
    sshStatus.textContent = "connection failed: " + e.message;
  }
}

async function disconnectSsh() {
  localStorage.removeItem("clutch_api_url");
  localStorage.removeItem("clutch_ssh_connected");
  await window.clutchTunnel.disconnect();
  location.reload();
}

$("#ssh-connect").addEventListener("click", connectSsh);
$("#ssh-disconnect").addEventListener("click", disconnectSsh);

// Drop a stale tunnel URL: on startup, if we last connected over SSH but no tunnel
// is alive (restart / dropped), fall back to the default backend instead of
// pointing every fetch at a dead port ("Failed to fetch").
async function reconcileStaleTunnel() {
  if (!window.clutchTunnel) return;
  if (!localStorage.getItem("clutch_ssh_connected")) return;
  const s = await window.clutchTunnel.status();
  if (!s.active) {
    localStorage.removeItem("clutch_api_url");
    localStorage.removeItem("clutch_ssh_connected");
    location.reload();
  }
}

// When a live tunnel dies mid-session (not an intentional disconnect), clear the
// stored URL and reload to the default backend so the UI stops failing.
if (window.clutchTunnel) {
  window.clutchTunnel.onEnd(() => {
    if (localStorage.getItem("clutch_ssh_connected")) {
      localStorage.removeItem("clutch_api_url");
      localStorage.removeItem("clutch_ssh_connected");
      location.reload();
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
async function refreshTree() {
  try {
    const r = await fetch(API_BASE + "/api/workspace/tree");
    const data = await r.json();
    if (data.root) els.workspace.textContent = data.root;
    els.tree.innerHTML = "";
    for (const node of data.tree || []) els.tree.appendChild(renderNode(node, 0));
  } catch (e) {}
}

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
    const children = document.createElement("div");
    children.className = "tree-children";
    children.style.display = "none";
    row.addEventListener("click", (e) => {
      e.stopPropagation(); // don't bubble to ancestor dirs (would collapse them)
      const isOpen = children.style.display !== "none";
      row.querySelector(".icon").textContent = isOpen ? "▸" : "▾";
      if (!isOpen) {
        children.innerHTML = "";
        for (const c of node.children || []) children.appendChild(renderNode(c, depth + 1));
      }
      children.style.display = isOpen ? "none" : "";
    });
    // children are siblings of the row, so the row's hover box never covers the subtree
    wrap.appendChild(children);
  }
  return wrap;
}

// ---- SSE live stream + session list ----
function connectSSE() {
  const es = new EventSource(API_BASE + "/api/events");
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
  };
  es.onerror = () => { /* auto-reconnect */ };
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
  $("#fs-new").classList.toggle("hidden", mode !== "new");
  $("#fs-create").classList.toggle("hidden", mode !== "new");
  $("#fs-name-input").value = "";
  fsModal.classList.remove("hidden");
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
    const r = await fetch(API_BASE + "/api/fs/list?path=" + encodeURIComponent(path));
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
      fsRow("Cannot reach backend at " + API_BASE + " (" + (e.message || e) + "). Reconnect SSH or check the backend URL.", "error-row")
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

// clear a stale SSH tunnel URL before anything else fires a fetch
reconcileStaleTunnel();
connectSSE();
