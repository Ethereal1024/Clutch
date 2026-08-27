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

// tracks the most recent agent text block so assistant_message (a duplicate of a
// just-emitted text_delta) and final (status badge on the same line) can merge
let lastTextEl = null;
let lastTextContent = null;

function addEvent(ev) {
  if (ev.type === "assistant_message") {
    // the authoritative full message duplicates a text_delta already shown
    if (ev.content && lastTextContent === ev.content) return;
  }
  if (ev.type === "final") {
    // merge the completion badge onto the last agent text line instead of a new block
    if (lastTextEl) {
      appendStatusBadge(lastTextEl, ev.status);
      return;
    }
  }
  const el = renderEvent(ev);
  if (el) {
    stream.appendChild(el);
    stream.scrollTop = stream.scrollHeight;
    if (ev.type === "text_delta" || ev.type === "assistant_message") {
      lastTextEl = el;
      lastTextContent = ev.content || "";
    } else if (ev.type === "step_start") {
      lastTextEl = null;
      lastTextContent = null;
    }
  }
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
    case "text_delta":
    case "assistant_message": {
      if (!ev.content) return null;
      wrap.className = "event text";
      wrap.innerHTML = '<div class="hdr">agent</div>';
      body.innerHTML = renderMarkdown(ev.content);
      break;
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
      wrap.className = "event tool_result" + (ev.is_error ? " error" : "");
      wrap.innerHTML = `<div class="hdr">${ev.is_error ? "result ⚠" : "result"}</div>`;
      body.className = "body md-plain";
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
  stream.innerHTML = "";
  lastTextEl = null;
  lastTextContent = null;
  const payload = { task };
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

async function loadSessions() {
  try {
    const r = await fetch("/api/sessions");
    const data = await r.json();
    els.session.innerHTML = '<option value="">live session</option>';
    for (const s of data.sessions || []) {
      const opt = document.createElement("option");
      opt.value = s.path;
      opt.textContent = s.name;
      els.session.appendChild(opt);
    }
  } catch (e) {}
}

els.session.addEventListener("change", async () => {
  const path = els.session.value;
  if (!path) return;
  try {
    const r = await fetch("/api/sessions");
    const data = await r.json();
    const s = data.sessions.find((x) => x.path === path);
    if (!s) return;
    const lr = await fetch("/api/sessions/replay?path=" + encodeURIComponent(path));
    const ld = await lr.json();
    stream.innerHTML = "";
    lastTextEl = null;
    lastTextContent = null;
    for (const ev of ld.events || []) addEvent(ev);
  } catch (e) {}
});

setInterval(refreshTree, 4000);
loadSessions();
connectSSE();
