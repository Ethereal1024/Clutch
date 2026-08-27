"use strict";

const $ = (s) => document.querySelector(s);

const els = {
  task: $("#task-input"),
  workdir: $("#workdir-input"),
  run: $("#run-btn"),
  stop: $("#stop-btn"),
  status: $("#status"),
  stream: $("#stream"),
  tree: $("#tree"),
  workspace: $("#workspace-path"),
  session: $("#session-select"),
};

let busy = false;
const stream = $("#stream");

function setStatus(state) {
  els.status.className = "badge " + (state || "idle");
  els.status.textContent = state || "idle";
  busy = state === "running";
  els.run.disabled = busy;
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
      return;
    }
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
      wrap.className = "event step";
      wrap.innerHTML = '<div class="hdr">—— step ——</div>';
      break;
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
        // exploration reads are collapsed to a one-line summary; click to expand
        const path = call.args.path || "";
        const lines = ev.content ? ev.content.split("\n").length : 0;
        const summary = toolName === "list_dir"
          ? `↳ ${ev.content ? ev.content.split("\n").length : 0} entries`
          : `↳ read ${path || "file"} (${lines} lines)`;
        body.textContent = summary;
        body.title = "click to expand";
        const full = document.createElement("pre");
        full.className = "read-detail hidden";
        full.textContent = ev.content;
        wrap.appendChild(body);
        wrap.appendChild(full);
        body.onclick = () => {
          full.classList.toggle("hidden");
          body.textContent = full.classList.contains("hidden") ? summary : "";
          stream.scrollTop = stream.scrollHeight;
        };
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

// ---- run / stop ----
async function run() {
  const task = els.task.value.trim();
  if (!task || busy) return;
  // keep the existing conversation on screen; runs append to the current session
  const payload = { task, session_id: currentSession };
  const wd = els.workdir.value.trim();
  if (wd) payload.workdir = wd;
  try {
    const r = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    if (data.workspace) els.workspace.textContent = data.workspace;
    if (data.session_id) {
      currentSession = data.session_id;
      markCurrentSession();
    }
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
    el.onclick = () => {
      open = !open;
      el.querySelector(".icon").textContent = open ? "▾" : "▸";
      if (open) {
        children.innerHTML = "";
        for (const c of node.children || []) children.appendChild(renderNode(c, depth + 1));
      }
      children.style.display = open ? "" : "none";
    };
    children.style.display = "none";
    el.appendChild(children);
  } else {
    el.onclick = () => previewFile(node.path);
  }
  return el;
}

async function previewFile(path) {
  try {
    const r = await fetch("/api/workspace/file?path=" + encodeURIComponent(path));
    const data = await r.json();
    if (!r.ok) return;
    let prev = stream.parentElement.querySelector(".file-preview");
    if (prev) prev.remove();
    prev = document.createElement("div");
    prev.className = "file-preview";
    prev.innerHTML = `<div class="event"><div class="hdr">preview · ${escapeHtml(path)}</div></div>`;
    const pre = document.createElement("pre");
    pre.textContent = data.content;
    prev.appendChild(pre);
    stream.parentElement.appendChild(prev);
  } catch (e) {}
}

// ---- SSE live stream + session list ----
function connectSSE() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try { addEvent(JSON.parse(e.data)); } catch (err) {}
  };
  es.onerror = () => { /* auto-reconnect */ };
}

let currentSession = "";

function clearStream() {
  stream.innerHTML = "";
  lastTextEl = null;
  lastTextContent = "";
  thinkingEl = null;
  thinkingContent = "";
}

function markCurrentSession() {
  els.session.value = currentSession;
}

async function loadSessions() {
  try {
    const r = await fetch("/api/sessions");
    const data = await r.json();
    els.session.innerHTML = '<option value="">— select conversation —</option>';
    for (const s of data.sessions || []) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = (s.summary ? s.summary + " — " : "") + s.name;
      els.session.appendChild(opt);
    }
    if (currentSession) {
      els.session.value = currentSession;
    } else if ((data.sessions || []).length > 0) {
      // resume the most recent session on load
      currentSession = data.sessions[data.sessions.length - 1].id;
      await switchSession(currentSession);
    }
  } catch (e) {}
}

async function switchSession(id) {
  try {
    const r = await fetch("/api/sessions");
    const data = await r.json();
    const s = data.sessions.find((x) => x.id === id);
    if (!s) return;
    const lr = await fetch("/api/sessions/replay?path=" + encodeURIComponent(s.path));
    const ld = await lr.json();
    clearStream();
    currentSession = id;
    setStatus("idle"); // reset busy so Run/taskbar work after switching
    for (const ev of ld.events || []) addEvent(ev);
    markCurrentSession();
  } catch (e) {}
}

els.session.addEventListener("change", async () => {
  const id = els.session.value;
  if (!id) return;
  if (busy) { markCurrentSession(); return; }
  await switchSession(id);
});

// ---- confirmation dialog (replaces window.confirm, which is unreliable in Electron) ----
const confirmModal = $("#confirm-modal");
let pendingConfirm = null;
function askConfirm(msg, onOk) {
  $("#confirm-msg").textContent = msg;
  pendingConfirm = onOk;
  confirmModal.classList.remove("hidden");
}
function closeConfirm() {
  confirmModal.classList.add("hidden");
  pendingConfirm = null;
}
$("#confirm-ok").addEventListener("click", () => {
  const fn = pendingConfirm;
  closeConfirm();
  if (fn) fn();
});
$("#confirm-cancel").addEventListener("click", closeConfirm);
confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeConfirm();
});

async function newSession() {
  try {
    const r = await fetch("/api/session/new", { method: "POST" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    currentSession = data.session_id;
    clearStream();
    setStatus("idle"); // ensure busy is reset so Run/taskbar work again
    markCurrentSession();
  } catch (e) {}
}

$("#new-session-btn").addEventListener("click", () => {
  if (busy) return;
  askConfirm("Start a new conversation? The current one will still be saved.", newSession);
});

setInterval(refreshTree, 4000);
loadSessions();
connectSSE();
