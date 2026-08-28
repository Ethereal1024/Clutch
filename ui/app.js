"use strict";

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
    stream.appendChild(toolGroupEl.el);
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
    if (argsBtn.textContent.includes("▾")) {
      argsBtn.textContent = "args ▸";
      row.querySelector(".tool-args-detail")?.remove();
    } else {
      argsBtn.textContent = "args ▾";
      const pre = document.createElement("pre");
      pre.className = "tool-args-detail";
      pre.textContent = argsTxt;
      row.appendChild(pre);
    }
  };
  row.appendChild(argsBtn);
  toolGroupEl.el.appendChild(row);
  stream.scrollTop = stream.scrollHeight;
}

// Append a read tool's result as a collapsible row inside the tool group.
function addReadResultRow(ev) {
  const call = toolCalls[ev.tool_call_id] || { name: "", args: {} };
  const { row, full } = buildReadRow(call, ev.content);
  toolGroupEl.el.appendChild(row);
  toolGroupEl.el.appendChild(full);
  stream.scrollTop = stream.scrollHeight;
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
  full.className = "read-detail hidden";
  full.textContent = content;
  highlightPreByPath(full, path);
  row.onclick = () => {
    const isHidden = full.classList.toggle("hidden");
    toggle.textContent = isHidden ? "▸" : "▾";
  };
  return { row, full };
}

function addEvent(ev) {
  // events that break a tool group: new user turn, agent text, thinking, final.
  // assistant_message is just a record (not shown) and does NOT break the group,
  // because results follow the tool_calls they belong to.
  if (["user_message", "text_delta", "reasoning_delta", "final", "step_start"].includes(ev.type)) {
    toolGroupEl = null;
  }
  if (ev.type === "assistant_message") {
    // Body is already streamed via text_delta; nothing to render here.
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
      stream.appendChild(lastTextEl);
    }
    lastTextContent += ev.content;
    lastTextEl.querySelector(".body").innerHTML = renderMarkdown(lastTextContent);
    highlightCode(lastTextEl);
    typesetMath(lastTextEl);
    stream.scrollTop = stream.scrollHeight;
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
      full.className = "thinking-full hidden";
      full._content = ""; // per-block copy; survives step_start resetting the globals
      thinkingEl.appendChild(full);
      // click toggles between the compact row and the full reasoning text
      row.onclick = () => {
        const isHidden = full.classList.toggle("hidden");
        toggle.textContent = isHidden ? "▸" : "▾";
        if (!isHidden) full.textContent = full._content;
      };
      stream.appendChild(thinkingEl);
    }
    thinkingEl.querySelector(".thinking-label").textContent =
      "thinking… " + thinkingContent.length + " chars";
    // keep the block's own copy in sync; if the full text is open, update it live
    const full = thinkingEl.querySelector(".thinking-full");
    full._content = thinkingContent;
    if (!full.classList.contains("hidden")) full.textContent = full._content;
    stream.scrollTop = stream.scrollHeight;
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
    stream.appendChild(el);
    stream.scrollTop = stream.scrollHeight;
  }
}

function createAgentTextBlock() {
  const wrap = document.createElement("div");
  wrap.className = "event text";
  wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
  return wrap;
}

// Render LaTeX ($...$, $$...$$) inside a freshly-inserted markdown block.
// MathJax scans text nodes; pre/code are skipped via skipHtmlTags so code stays
// literal. Content is already DOMPurify-sanitized before this runs.
function typesetMath(el) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  if (!el || !el.textContent || el.textContent.indexOf("$") === -1) return;
  MathJax.typesetPromise([el]).catch(() => {});
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
  stream.appendChild(div);
  // completed summaries duplicate the streamed agent text; abort/error reasons
  // are the only place the termination cause is shown
  if (status !== "completed" && summary) {
    const note = document.createElement("div");
    note.className = "completion-note";
    note.textContent = summary;
    stream.appendChild(note);
  }
  stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
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
            pre.classList.toggle("diff-collapsed");
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
    const r = await fetch("/api/run", {
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
  await fetch("/api/stop", { method: "POST" });
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

function openSettings() {
  modal.classList.remove("hidden");
  keyInput.value = localStorage.getItem("clutch_api_key") || "";
  keyInput.focus();
}
function closeSettings() {
  modal.classList.add("hidden");
}
async function saveSettings() {
  const key = keyInput.value.trim();
  if (!key) {
    closeSettings();
    return;
  }
  try {
    const r = await fetch("/api/settings", {
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
    await fetch("/api/permission/respond", {
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
    const r = await fetch("/api/workspace/tree");
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
  row.innerHTML =
    `<span class="icon">${node.dir ? "▸" : "·"}</span>` +
    `<span class="name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>`;
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
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try { addEvent(JSON.parse(e.data)); } catch (err) {}
  };
  es.onerror = () => { /* auto-reconnect */ };
}

let currentProject = ""; // path of the active .clc project file

function clearStream() {
  stream.innerHTML = "";
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
    const r = await fetch("/api/project/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || r.status);
    }
    clearStream();
    stream.classList.add("replaying"); // history reconstruction: no entrance motion
    prog.classList.remove("hidden");
    setPct(0);
    // /api/project/open streams NDJSON: meta, progress, event, done
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let started = false;
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
        } else if (msg.progress && msg.progress.total) {
          setPct(100 * msg.progress.done / msg.progress.total);
        } else if (msg.event) {
          addEvent(msg.event);
        }
      }
    }
    if (started) setPct(100);
    prog.classList.add("hidden");
    stream.classList.remove("replaying");
    refreshTree();
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
  } catch (e) {
    prog.classList.add("hidden");
    stream.classList.remove("replaying");
    alert("Failed to open project: " + e.message);
  }
}

async function createProject(dir, name) {
  if (busy) return;
  try {
    const r = await fetch("/api/project/new", {
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

// ---- new project modal ----
const projectModal = $("#project-modal");
let pickedDir = "";
async function startNewProject() {
  if (busy) return;
  if (window.clutchDialog && window.clutchDialog.pickDirectory) {
    pickedDir = await window.clutchDialog.pickDirectory();
    if (!pickedDir) return;
  } else {
    pickedDir = prompt("Directory to create the project in:");
    if (!pickedDir) return;
  }
  $("#project-dir-input").value = pickedDir;
  $("#project-name-input").value = "";
  projectModal.classList.remove("hidden");
  $("#project-name-input").focus();
}
function closeProjectModal() {
  projectModal.classList.add("hidden");
}
$("#project-create").addEventListener("click", () => {
  const name = $("#project-name-input").value.trim();
  if (!name) return;
  closeProjectModal();
  createProject(pickedDir, name);
});
$("#project-cancel").addEventListener("click", closeProjectModal);
projectModal.addEventListener("click", (e) => {
  if (e.target === projectModal) closeProjectModal();
});

// ---- open project ----
async function pickAndOpenProject() {
  if (busy) return;
  if (window.clutchDialog && window.clutchDialog.pickProjectFile) {
    const path = await window.clutchDialog.pickProjectFile();
    if (!path) return;
    await openProject(path);
  } else {
    const path = prompt("Path to the .clc project file:");
    if (!path) return;
    await openProject(path);
  }
}

$("#new-project-btn").addEventListener("click", startNewProject);
$("#open-project-btn").addEventListener("click", pickAndOpenProject);
$("#welcome-new").addEventListener("click", startNewProject);
$("#welcome-open").addEventListener("click", pickAndOpenProject);

connectSSE();
