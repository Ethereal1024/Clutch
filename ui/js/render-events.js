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

// The host's write-claim changes are announced on the document, never called:
// js/project.js (which owns #readonly-badge) loads after this file. A test
// harness may model the DOM without dispatchEvent/CustomEvent; then there is
// no badge to update and the announcement is skipped.
function announceProjectReadOnly(readOnly) {
  if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
  const detail = { readOnly: !!readOnly };
  const ev = typeof CustomEvent === "function"
    ? new CustomEvent("clutch:project-read-only", { detail })
    : { type: "clutch:project-read-only", detail };
  document.dispatchEvent(ev);
}

function renderEvent(ev) {
  const wrap = document.createElement("div");
  const body = document.createElement("div");
  body.className = "body";
  let appendedBody = false; // write+diff appends body itself; skip the trailing append

  switch (ev.type) {
    case "user_message": {
      wrap.className = "event user";
      // what the user actually typed, verbatim, kept on the row: the rendered
      // DOM is markdown and cannot be turned back into the message, and the
      // roll-back gesture has to put the message back in the box (js/task-rollback.js)
      wrap._taskText = String(ev.content == null ? "" : ev.content);
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
      // The write claim is HOST state, like the run state: every connect's
      // status frame carries it, and a live change (the watchdog took the
      // claim back once the other window was gone) arrives as its own frame.
      // Announced, not called — js/project.js owns the badge and loads after
      // this file (tests/ui-load-order-test.js).
      if (typeof ev.read_only === "boolean") announceProjectReadOnly(ev.read_only);
      if (ev.key === "project_read_only") announceProjectReadOnly(!!ev.value);
      if (ev.key === "execution_status" && ev.value) {
        // The first frame of every connect is the host's own status. If this
        // window was busy when its session was replaced (see sseRunAtRisk), that
        // frame reveals the outcome: the run does not come back — the host
        // released the session it ran in — so the honest paint is idle, and the
        // ONE thing that must not happen is painting it silently. That silence
        // is the reported "the task went idle by itself".
        //
        // The frame is not the announcement, though, and a toast that dismisses
        // itself is not one either (a phone that is not being looked at when it
        // fires has learned nothing). The run's ending belongs in the transcript
        // with everything else, so this frame records the question and the
        // record the new session replays answers it (js/stream-events.js).
        if (ev.value === "idle" && sseRunAtRisk) {
          sseRunAtRisk = false;
          sseRunLostPending = true;
        } else if (ev.value !== "idle") {
          sseRunAtRisk = false; // the run is still there: nothing was lost after all
        }
        setStatus(ev.value);
      }
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
//
// The loop is the HOST's (P1-4): this page is a view. It hands the task to
// window.clutchRun, drives the turn to its end, and paints what comes back —
// the durable records off the log stream (the append that wrote them announces
// them, agent/api/log.py) and the display frames off the run:event subscription
// below. There is NO second path: a page-side POST /api/run would open a turn
// nothing here can drive, and two ways to start a run is what this phase
// removes.
//
// The host's answers arrive in two shapes — ui/preload.js resolves {ok, error},
// ui/bridge-shim.js rejects it (an unreachable bridge IS a dead IPC channel) —
// and that difference is not this file's business: hostCall() turns both into
// one Error carrying the host's own code (no_session, project_mismatch, …).
async function hostCall(promise) {
  const answer = await promise;
  if (answer && answer.ok === false) {
    const err = new Error(answer.error || "the host refused the call");
    err.code = answer.code || "host_error";
    throw err;
  }
  return answer;
}

async function run() {
  const task = els.task.value.trim();
  if (!task || busy) return;
  if (!currentProject) return;
  const host = window.clutchRun;
  if (!host || typeof host.start !== "function" || typeof host.drive !== "function") {
    // an honest absence, not a fallback: a build without a host loop cannot run
    // a turn, and pretending otherwise is how two loops came to exist
    notice("this build has no host run loop — it cannot run a task");
    return;
  }
  els.task.value = ""; // the task is now "in the stream"; keep the input clear
  els.task.style.height = TASK_BASE_H + "px"; // animate the input back to its default size
  // ...and it joins the box's sent-message history: ArrowUp walks it back
  // (js/task-input.js), which is how the user re-reads or re-asks what they sent
  recordSentTask(task);
  // sending a message returns to the live tail unconditionally
  followTail = true;
  autoScroll(true);
  // The payload /api/run used to take, and the host still takes: the task, the
  // mode the loop is built for, and the .clc this page is showing. The project
  // is a CLAIM the host checks against its session's open project
  // (ui/run-session.js): a run that would land in another window's log is
  // refused, never written.
  const payload = { task, mode: agentMode, project: currentProject };
  let opened = false; // did a turn actually open on disk?
  setStatus("running"); // the click is the user's claim; the host's frames confirm it
  try {
    await hostCall(host.start(payload));
    opened = true;
    // Drive to the end. The turn's own ending is a durable `final` the loop
    // writes and the log stream paints, so nothing here fabricates one.
    await hostCall(host.drive());
  } catch (e) {
    const msg = (e && e.message) || e;
    // No code: the call never reached a host at all (a dead IPC channel, an
    // unreachable bridge). no_session: the host answered that this window has
    // no session. Both are the lost session the dialog owns, not a one-line
    // transcript error nobody can act on. A project_mismatch is the opposite —
    // the session answered and refused, and its message says why — so it stays
    // inline with the attempt's record below.
    if (!e || !e.code || e.code === "no_session") {
      connectionLost("could not reach the session to start the task (" + msg + ")");
    }
    addEvent({ type: "final", status: "error", summary: "run failed: " + msg });
    // A turn that never opened leaves nothing to drive: the button belongs to
    // the user again. A turn that opened stays the host's to describe — its
    // failure frame already said "error", and driving again continues it.
    if (!opened) setStatus("idle");
  }
}

async function stop() {
  const host = window.clutchRun;
  if (!host || typeof host.stop !== "function") {
    notice("this build has no host run loop — nothing to stop");
    return;
  }
  try {
    // The host stops the loop AND writes the aborted final (ui/main.js
    // stopAndFlush), so the ending is a durable line like any other: this page
    // never writes one it did not watch happen. `busy` is refreshed by the
    // host's status frames, not by this answer, so when the stop cannot be
    // delivered the window must stop pretending that it was.
    await hostCall(host.stop());
  } catch (e) {
    const msg = (e && e.message) || e;
    if (!e || !e.code || e.code === "no_session") {
      // the request never landed: this is the reported "Failed to fetch", and
      // the dialog (not an 8-second toast) is what owns "this window has no
      // session". The task may still be running on a host we cannot reach.
      connectionLost("could not reach the session to stop the task (" + msg + ")");
    } else {
      notice("the backend refused to stop the task (" + msg + ") — it may still be running");
    }
    setStatus("idle"); // the button belongs to the user again: retry Stop, or Run
    // the link itself may be recoverable: re-resolve the session of this
    // window (the tunnel or the supervisor may have re-claimed one under us)
    await switchBackendResolved();
  }
}

// ---- resume: the turn this page was not there for (P2-3) ------------------
//
// A turn lives in the log, not in a process (ui/run-state.js): it opens with a
// user_message and closes with a final, and the loop holds nothing between two
// steps. So "resume after a cold start or an unfreeze" is not a feature with its
// own code — it is the ONE question the loop already asks itself, `state()`,
// followed by `drive()` when the answer is `{phase:"open"}`. What was missing is
// who asks it after the page that opened the turn is gone.
//
// This page asks. The mode a turn is resumed in and the .clc it is resumed for
// are the page's own facts — a host resuming on its own would have to guess both
// — and a host that resumed unasked would start spending money in a session
// nobody is looking at.
//
// Asked from two doors, the same function: a boot that already knows a project
// (js/boot.js) can continue a turn before the first row is drawn, and a boot
// that does not — today the page has no project until the user opens one —
// asks the moment the log it is looking at exists (js/project.js). An idle
// answer does nothing at all; an open turn is driven exactly as the Run button
// drives it, same host call, same frames. Nothing is written here.
async function resumeTurn() {
  const host = window.clutchRun;
  if (!host || typeof host.state !== "function" || typeof host.drive !== "function") return;
  if (!currentProject || busy) return; // no log to resume, or a turn already ours
  let answer;
  try {
    // the payload run:start takes; `project` is the CLAIM the host checks, so a
    // page looking at another file cannot continue somebody else's turn
    answer = await hostCall(host.state({ mode: agentMode, project: currentProject }));
  } catch (e) {
    // no fold to read: a host with no session, or a log that refused. Neither is
    // a turn this page may invent — stay on what the log stream replayed, and
    // leave the user's own Run exactly as it was.
    console.warn("[resume] no fold to resume from:", (e && e.message) || e);
    return;
  }
  if (!answer || !answer.result || answer.result.phase !== "open") return;
  setStatus("running");
  try {
    await hostCall(host.drive());
  } catch (e) {
    const msg = (e && e.message) || e;
    if (e && e.code === "run_active") {
      // another window's host holds the run slot and is driving this very turn:
      // the honest answer is to leave it alone and say why nothing happens here
      notice("this turn is being driven by another window");
    } else if (!e || !e.code || e.code === "no_session") {
      connectionLost("could not reach the session to resume the turn (" + msg + ")");
    } else {
      notice("could not resume the turn (" + msg + ")");
    }
    setStatus("idle");
  }
}

// The host loop's display feed (P1-4): deltas, the execution_status frames,
// retry notices, compaction progress. Durable records do NOT come here — they
// arrive on the log stream, announced by the append that wrote them — which is
// what lets a window that was closed for the whole turn still replay it.
// addEvent takes both shapes, so a live frame lands exactly as the stream's own
// would (and a status frame is a status frame whichever door it came through).
if (window.clutchRun && typeof window.clutchRun.onEvent === "function") {
  window.clutchRun.onEvent((ev) => {
    if (ev && typeof ev === "object") addEvent(ev);
  });
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

