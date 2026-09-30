// the run controls and the event dispatcher
//
// Run/Stop, the completion line, markdown/diff rendering and `renderEvent` — the
// switch that turns a host event into the row the renderers above draw.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

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
      const call = toolCalls[ev.tool_call_id] || { name: "", args: {}, ui: {} };
      const ui = uiOfResult(ev);
      // a call that may change the tree asks for a fresh one (the declaration
      // says whether it can — the host derives it when it declares nothing)
      if (ui.mutates) scheduleTreeRefresh();
      if (ui.form === "row") return buildResultRowBlock(ui, call, ev);
      return buildResultBlock(ui, call.name || "", call.args || {}, ev);
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
    const data = await apiFetch("/api/run", { method: "POST", body: payload });
    if (data.workspace) els.workspace.textContent = data.workspace;
    refreshTree();
  } catch (e) {
    addEvent({ type: "final", status: "error", summary: "run failed: " + e.message });
  }
}

async function stop() {
  try {
    // bounded so a wedged request cannot outlive the patience of the user —
    // and never swallowed: the click must do SOMETHING either way. `busy` is
    // refreshed by the SSE stream, not by this response, so when the cancel
    // cannot be delivered the window must stop pretending that it was.
    await apiFetch("/api/stop", { method: "POST", timeout: 8000 }); // bodyless
  } catch (e) {
    notice("could not reach the backend to stop (" + ((e && e.message) || e) + ") — the task may still be running");
    setStatus("idle"); // the button belongs to the user again: retry Stop, or Run
    // the link itself may be recoverable: re-resolve the session of this
    // window (the tunnel or the supervisor may have re-claimed one under us)
    await switchBackendResolved();
  }
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

