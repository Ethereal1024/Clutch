"use strict";

const $ = (s) => document.querySelector(s);

const els = {
  task: $("#task-input"),
  run: $("#run-btn"),
  stop: $("#stop-btn"),
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
  busy = state === "running";
  els.run.disabled = busy || !currentProject;
  els.stop.disabled = !busy;
}

// tracks the most recent agent text block (created by streaming text_delta)
let lastTextEl = null;
let lastTextContent = "";
// thinking (reasoning) block
let thinkingEl = null;
let thinkingContent = "";

// map tool_call_id -> {name, args} so a tool_result knows which tool produced it
const toolCalls = {};

function addEvent(ev) {
  if (ev.type === "assistant_message") {
    // Body is already streamed via text_delta; nothing to render here.
    // lastTextEl still points at the streamed text block, so final's status
    // badge lands on that block.
    return;
  }
  if (ev.type === "final") {
    // merge the completion badge onto the last agent text line instead of a new block
    if (lastTextEl) {
      appendStatusBadge(lastTextEl, ev.status);
    }
    refreshTree(); // a run finished; reflect any new files in the tree
    return;
  }
  if (ev.type === "tool_call" && ev.tool_call_id) {
    let args = {};
    try { args = JSON.parse(ev.arguments || "{}"); } catch (e) {}
    toolCalls[ev.tool_call_id] = { name: ev.name, args };
  }

  // streaming text: accumulate into the existing agent block and re-render
  if (ev.type === "text_delta" && ev.content) {
    if (!lastTextEl) {
      lastTextEl = createAgentTextBlock();
      stream.appendChild(lastTextEl);
    }
    lastTextContent += ev.content;
    lastTextEl.querySelector(".body").innerHTML = renderMarkdown(lastTextContent);
    typesetMath(lastTextEl);
    stream.scrollTop = stream.scrollHeight;
    return;
  }

  // streaming reasoning: accumulate into a distinct thinking block
  if (ev.type === "reasoning_delta" && ev.content) {
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "event thinking";
      thinkingEl.innerHTML = '<div class="hdr">thinking</div><div class="body thinking-body"></div>';
      stream.appendChild(thinkingEl);
    }
    thinkingContent += ev.content;
    thinkingEl.querySelector(".body").textContent = thinkingContent;
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
    if (ev.type === "final") {
      typesetMath(el);
    }
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

function appendStatusBadge(blockEl, status) {
  const badge = document.createElement("span");
  badge.className = "status-badge " + (status === "completed" ? "done" : "fail");
  badge.textContent = status === "completed" ? "✓ completed" : `✗ ${status}`;
  blockEl.appendChild(badge);
  stream.scrollTop = stream.scrollHeight;
}

function renderEvent(ev) {
  const wrap = document.createElement("div");
  const body = document.createElement("div");
  body.className = "body";

  switch (ev.type) {
    case "user_message": {
      wrap.className = "event user";
      wrap.innerHTML = '<div class="hdr">task</div>';
      body.className = "body md-plain";
      body.textContent = ev.content;
      break;
    }
    case "step_start": {
      // internal loop step; reset state but don't show a divider line
      return null;
    }
    case "text_delta": {
      if (!ev.content) return null;
      wrap.className = "event text";
      wrap.innerHTML = '<div class="hdr">agent</div>';
      body.innerHTML = renderMarkdown(ev.content);
      break;
    }
    case "assistant_message": {
      // The body is streamed via text_delta; assistant_message carries the full
      // text only as the authoritative record (for context/logging), never for
      // display — rendering it here would duplicate the streamed output.
      return null;
    }
    case "tool_call": {
      wrap.className = "event tool_call";
      wrap.innerHTML = `<div class="hdr">tool · ${escapeHtml(ev.name)}</div>`;
      let argsTxt = ev.arguments;
      try { argsTxt = JSON.stringify(JSON.parse(ev.arguments), null, 1); } catch (e) {}
      const args = document.createElement("div");
      args.className = "args";
      args.textContent = "args ▸";
      args.onclick = () => {
        if (args.innerHTML.includes("<pre>")) args.innerHTML = "args ▸";
        else args.innerHTML = "args ▾<pre>" + escapeHtml(argsTxt) + "</pre>";
      };
      wrap.appendChild(args);
      break;
    }
    case "tool_result": {
      const call = toolCalls[ev.tool_call_id] || { name: "", args: {} };
      const toolName = call.name || "";
      const isRead = toolName === "read_file" || toolName === "list_dir";
      const isWrite = toolName === "write_file";

      wrap.className = "event tool_result" + (ev.is_error ? " error" : "")
        + (isRead ? " read" : "") + (isWrite ? " write" : "");
      const hdr = isWrite ? "✓ wrote" : (ev.is_error ? "result ⚠" : "result");
      wrap.innerHTML = `<div class="hdr">${hdr}</div>`;
      body.className = "body md-plain";

      if (isRead) {
        // exploration reads: a summary row with a ▸/▾ toggle; click to expand/collapse
        const path = call.args.path || "";
        const lines = ev.content ? ev.content.split("\n").length : 0;
        const summary = toolName === "list_dir"
          ? `${ev.content ? ev.content.split("\n").length : 0} entries`
          : `read ${path || "file"} (${lines} lines)`;
        const toggle = document.createElement("span");
        toggle.className = "read-toggle";
        toggle.textContent = "▸";
        const row = document.createElement("div");
        row.className = "read-row";
        row.appendChild(toggle);
        const lbl = document.createElement("span");
        lbl.textContent = summary;
        row.appendChild(lbl);
        wrap.appendChild(row);
        const full = document.createElement("pre");
        full.className = "read-detail hidden";
        full.textContent = ev.content;
        wrap.appendChild(full);
        row.onclick = () => {
          const expanded = full.classList.toggle("hidden");
          toggle.textContent = expanded ? "▸" : "▾";
        };
        break;
      }

      if (isWrite && ev.diff) {
        // show the file change as a unified diff (# Wrote <path> + coloured lines)
        const path = call.args.path || "";
        wrap.innerHTML = `<div class="hdr">✓ wrote <span class="diff-file">${escapeHtml(path)}</span></div>`;
        body.textContent = ev.content; // summary line (e.g. OK: wrote /x (+5 -2 lines))
        wrap.appendChild(body);
        const pre = renderDiff(ev.diff);
        wrap.appendChild(pre);
        if (ev.diff.split("\n").length > 60) {
          pre.classList.add("diff-collapsed");
          const expand = document.createElement("button");
          expand.className = "diff-expand";
          expand.textContent = "Show full diff";
          expand.onclick = () => {
            pre.classList.remove("diff-collapsed");
            expand.remove();
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
    case "final": {
      wrap.className = "event final" + (ev.status !== "completed" ? " aborted" : "");
      wrap.innerHTML = `<div class="hdr">${escapeHtml(ev.status)}</div>`;
      body.innerHTML = renderMarkdown(ev.summary);
      break;
    }
    default:
      return null;
  }
  wrap.appendChild(body);
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

els.run.addEventListener("click", run);
els.stop.addEventListener("click", stop);
els.task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
});

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
  $("#perm-args").textContent = ev.args_repr || "";
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
  const el = document.createElement("div");
  el.className = "tree-node " + (node.dir ? "dir" : "file");
  el.style.paddingLeft = (6 + depth * 14) + "px";
  el.innerHTML = `<span class="icon">${node.dir ? "▸" : "·"}</span>${escapeHtml(node.name)}`;
  if (node.dir) {
    const children = document.createElement("div");
    children.className = "tree-children";
    let open = false;
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // don't bubble to ancestor dirs (would collapse them)
      open = !open;
      el.querySelector(".icon").textContent = open ? "▾" : "▸";
      if (open) {
        children.innerHTML = "";
        for (const c of node.children || []) children.appendChild(renderNode(c, depth + 1));
      }
      children.style.display = open ? "" : "none";
    });
    children.style.display = "none";
    el.appendChild(children);
  } else {
    // files have no action, but still stop propagation so clicking a file
    // inside a nested dir never bubbles to collapse its parent
    el.addEventListener("click", (e) => e.stopPropagation());
  }
  return el;
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
  markCurrentProject();
}

function markCurrentProject() {
  // no dropdown; the label already shows the project name
}

function showWelcome() {
  document.getElementById("welcome").classList.remove("hidden");
  els.run.disabled = true;
}
function hideWelcome() {
  document.getElementById("welcome").classList.add("hidden");
  els.run.disabled = busy || !currentProject;
}

async function openProject(path) {
  if (busy) return;
  try {
    const r = await fetch("/api/project/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    clearStream();
    setProjectInfo(data);
    hideWelcome();
    for (const ev of data.events || []) addEvent(ev);
    refreshTree();
  } catch (e) {
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
