"use strict";

const $ = (s) => document.querySelector(s);

const els = {
  task: $("#task-input"),
  run: $("#run-btn"),
  stop: $("#stop-btn"),
  status: $("#status"),
  stream: $("#stream"),
  tree: $("#tree"),
  sandbox: $("#sandbox-path"),
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

function addEvent(ev) {
  const el = renderEvent(ev);
  if (el) {
    stream.appendChild(el);
    stream.scrollTop = stream.scrollHeight;
  }
}

function renderEvent(ev) {
  const wrap = document.createElement("div");
  const body = document.createElement("div");
  body.className = "body";

  switch (ev.type) {
    case "user_message": {
      wrap.className = "event user";
      wrap.innerHTML = '<div class="hdr">task</div>';
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
      body.textContent = ev.content;
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
      body.textContent = ev.content;
      break;
    }
    case "state_update": {
      if (ev.key === "execution_status" && ev.value) setStatus(ev.value);
      return null;
    }
    case "final": {
      wrap.className = "event final" + (ev.status !== "completed" ? " aborted" : "");
      wrap.innerHTML = `<div class="hdr">${escapeHtml(ev.status)}</div>`;
      body.textContent = ev.summary;
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

// ---- run / stop ----
async function run() {
  const task = els.task.value.trim();
  if (!task || busy) return;
  stream.innerHTML = "";
  try {
    const r = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    if (data.sandbox) els.sandbox.textContent = data.sandbox;
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

// ---- sandbox tree ----
async function refreshTree() {
  try {
    const r = await fetch("/api/sandbox/tree");
    const data = await r.json();
    if (data.root) els.sandbox.textContent = data.root;
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
    const r = await fetch("/api/sandbox/file?path=" + encodeURIComponent(path));
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
    for (const ev of ld.events || []) addEvent(ev);
  } catch (e) {}
});

setInterval(refreshTree, 4000);
loadSessions();
connectSSE();
