// the run controls and the event dispatcher
//
// Run/Stop, the completion line, markdown/diff rendering and `renderEvent` — the
// switch that turns a host event into the row the renderers above draw.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { agentMode, setMode } from "./env";
import { els } from "./els";
import { switchBackendActiveSlot, switchBackendResolved } from "./backend-lifecycle";
import { connectionLost } from "./conn-lost";
import { openPerm } from "./permissions";
import { currentProject, pageSink } from "./project";
import { TASK_BASE_H, notice } from "./settings";
import { state } from "./state";
import { addEvent } from "./stream-events";
import { eventsEl, stream } from "./els";
import {
  autoScroll, busy, gliding, sending, setJumpVisible, setStatus, toolCalls,
} from "./stream-view";
import { recordSentTask } from "./task-input";
import { activeSlotId, noteTabEvent, setTabRunning } from "./slots";
import { buildResultBlock, buildResultRowBlock, uiOfResult } from "./tool-render";
import { scheduleTreeRefresh } from "./workspace-panel";

// One drive at a time per slot. Switching away and back can call resumeTurn
// while the drive started before the switch is still in flight; the host runs
// ONE loop, so a second drive would race the first.
const driving = new Set<string>();

export function appendCompletion(status, summary) {
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
    if (state.followTail) stream.scrollTop = stream.scrollHeight;
    else setJumpVisible(true);
  }
}

// The host's write-claim changes are announced on the document, never called:
// project.ts (which owns the claim pill and the composer) loads after this file.
// A test harness may model the DOM without dispatchEvent/CustomEvent; then there
// is nothing to update and the announcement is skipped.
//
// Two announcements, because "not writable here" has two causes that end
// differently: `readOnly` is the file OPENED as a viewer (fixed until reopened),
// `claimed` is another window RUNNING it right now (over with that run).
function announce(name, detail) {
  if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
  const ev = typeof CustomEvent === "function"
    ? new CustomEvent(name, { detail })
    : { type: name, detail };
  document.dispatchEvent(ev as Event);
}

export function announceProjectReadOnly(readOnly) {
  announce("clutch:project-read-only", { readOnly: !!readOnly });
}

export function announceProjectClaim(claimed) {
  announce("clutch:project-claim", { claimed: !!claimed });
}

export function renderEvent(ev) {
  const wrap = document.createElement("div");
  const body = document.createElement("div");
  body.className = "body";
  let appendedBody = false; // write+diff appends body itself; skip the trailing append

  switch (ev.type) {
    case "user_message": {
      const said = String(ev.content == null ? "" : ev.content);
      // The loop's own retry notes are durable user_messages (the fold needs
      // them), but they are not tasks the user typed. Painting them as task
      // rows is the reported "a paragraph I never wrote shows up in my task
      // list" — show the fact, quietly, and keep it out of the rollback path.
      if (/^Your previous reply contained no visible text/.test(said)) {
        wrap.className = "event internal-note";
        wrap.innerHTML = '<div class="hdr">retry</div>';
        body.className = "body";
        body.textContent = "the model returned no visible text — asking again";
        break;
      }
      if (/^ERROR: The previous response hit the max_tokens limit/.test(said)) {
        wrap.className = "event internal-note";
        wrap.innerHTML = '<div class="hdr">retry</div>';
        body.className = "body";
        body.textContent = "the response hit max_tokens — asking again, more concisely";
        break;
      }
      wrap.className = "event user";
      // what the user actually typed, verbatim, kept on the row: the rendered
      // DOM is markdown and cannot be turned back into the message, and the
      // roll-back gesture has to put the message back in the box (task-rollback.ts)
      wrap._taskText = said;
      wrap.innerHTML = '<div class="hdr">task</div>';
      body.className = "body";
      // hard-wrapped markdown (breaks: true): WYSIWYG line breaks
      body.innerHTML = renderMarkdown(said, true);
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
      // status frame carries both answers (opened as a viewer / another window
      // runs it now), and a live change arrives as its own `running_elsewhere`
      // frame. Announced, not called — project.ts owns the pill and the
      // composer and loads after this file (tests/ui-load-order-test.js).
      if (typeof ev.read_only === "boolean") announceProjectReadOnly(ev.read_only);
      if (typeof ev.running_elsewhere === "boolean") announceProjectClaim(ev.running_elsewhere);
      if (ev.key === "running_elsewhere") announceProjectClaim(!!ev.value);
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
        // record the new session replays answers it (stream-events.ts).
        if (ev.value === "idle" && state.sseRunAtRisk) {
          state.sseRunAtRisk = false;
          state.sseRunLostPending = true;
        } else if (ev.value !== "idle") {
          state.sseRunAtRisk = false; // the run is still there: nothing was lost after all
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

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// marked 12's own inline `del` rule is `/^(~~?)(?=[^\s~])…/` — a SINGLE tilde
// opens strikethrough, and its body may span newlines. Prose that writes ranges
// with `~` ("1~2 周", "p95 1.7~2.3cm", "80~150ms") therefore pairs the first
// tilde with the second and marks everything in between as deleted text: a whole
// paragraph of a report came back struck through, and the readable fragments
// either side of the strike read as different numbers than the writer typed
// ("1~2 周 … + 1~2 天训练" showed as "2 周 … 12 天训练"). The model writes those
// ranges constantly, so this is not a rare shape, and nothing in the prose says
// why a line appeared crossed out. So strikethrough means what GFM means: two
// tildes. A lone `~` is a character. (A tokenizer override is tried before
// marked's own rules; returning undefined falls through to them, so `~~x~~`
// still works.)
let markedTuned = false;
function tuneMarked() {
  if (markedTuned || typeof marked === "undefined" || typeof marked.use !== "function") return;
  markedTuned = true;
  try {
    marked.use({
      tokenizer: {
        del(this: any, src: string) {
          const m = /^(~~)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/.exec(src);
          if (!m) return undefined;
          return { type: "del", raw: m[0], text: m[2], tokens: this.lexer.inlineTokens(m[2]) };
        },
      },
    });
  } catch (e) {
    // a marked that cannot take the override is still a marked worth using
  }
}

// markdown via marked + DOMPurify (LLM output is untrusted); breaks=true
// hard-wraps user tasks
export function renderMarkdown(text, breaks = false) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  tuneMarked();
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
export function renderDiff(diff) {
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
// ui/src/renderer/bridge-shim.ts rejects it (an unreachable bridge IS a dead IPC channel) —
// and that difference is not this file's business: hostCall() turns both into
// one Error carrying the host's own code (no_session, project_mismatch, …).
export async function hostCall(promise) {
  const answer = await promise;
  if (answer && answer.ok === false) {
    const err = new Error(answer.error || "the host refused the call");
    err.code = answer.code || "host_error";
    // a refusal that names somebody (another window's run) keeps their word
    if (answer.owner) err.owner = answer.owner;
    throw err;
  }
  return answer;
}

// ---- the outbox: the task in the box until the log has it --------------------
//
// A message leaves the composer when the transcript HAS it, never on the click.
// The click used to empty the box before anything was sent, and over a tunnel —
// where the round trip that appends the record and the round trip that paints it
// ARE the visible delay — that left the message in neither place for a moment:
// the reported "按下发送，消息从消息框消失，可显示区还没出现，就像发丢了". Now the
// box holds it (locked, with the run button turned into a spinner: the wait is
// the session's, not a lost click) and empties in the same paint that draws its
// own row. That row is the log's `user_message` record — the append the host
// makes BEFORE the run answers (ui/run.js start) — so one fact is both the
// send's acknowledgement and the row's arrival, and there is no window in which
// the message is nowhere.
//
// The wait itself is the "sending" status (stream-view.ts), so a page that moves
// on — a tab switch, the host's own running frames — ends it without this file
// enumerating the ways a send can stop being a send. `pendingTask` is the memo
// that outlives the wait: if the row lands later (a stream that reconnected
// first, a tab that let go of the send), the box still empties when it does.
let pendingTask = "";

// The box is now holding a message that is not in the log yet.
export function beginSend(task) {
  pendingTask = task;
  setStatus("sending");
}

// The log has this task's own row, and the pane has drawn it: the message is the
// transcript's now, so it may leave the box. `content` is the record's text (the
// loop appends task.trim(), and run() sent the task trimmed).
export function noteUserMessage(content) {
  if (!pendingTask || String(content == null ? "" : content).trim() !== pendingTask) return;
  const task = pendingTask;
  pendingTask = "";
  // Clear the box only while it still holds what was sent. Escape and undo are
  // the box's own keys and they write it even read-only (task-input.ts), so the
  // box may hold something else by now — and taking back a message the reader
  // has since replaced would be this file deleting text nobody asked it to.
  if (els.task.value.trim() === task) {
    els.task.value = "";
    els.task.style.height = TASK_BASE_H + "px"; // the auto-grow gives the box back
  }
  // ...and it joins the box's sent-message history: ArrowUp walks it back
  // (task-input.ts), which is how the reader re-reads or re-asks what they sent
  recordSentTask(task);
  // The row IS the turn opening: what the session is working on from here is the
  // log's task, which is the claim the click used to make on its own behalf.
  setStatus("running");
  const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
  if (typeof setTabRunning === "function") setTabRunning(slotId, true);
}

// The wait is over for a reason that is not the row — a tab switch takes away the
// one stream that could have confirmed it. The TEXT STAYS (losing it is the one
// thing this state exists to prevent), and the memo keeps watching: a message
// that did land still leaves the box when its tab is back and the log is replayed.
export function endSend() {
  if (sending) setStatus("idle");
}

export async function run() {
  const task = els.task.value.trim();
  if (busy || sending) return;
  if (!currentProject) return;
  const host = window.clutchRun;
  if (!host || typeof host.run !== "function") {
    // an honest absence, not a fallback: a build without a host loop cannot run
    // a turn, and pretending otherwise is how two loops came to exist
    notice("this build has no host run loop — it cannot run a task");
    return;
  }
  // If there's a task, it stays in the box until the log has it (the outbox,
  // above) and the wait is painted beside it. If resuming an interrupted turn,
  // there's no new task — the log holds what opened it. Either way, the unified
  // host.run() interface handles it: new task if idle, continue if open.
  if (task) beginSend(task);
  // sending a message returns to the live tail unconditionally
  state.followTail = true;
  autoScroll(true);
  // The unified payload: task (new), mode, and project (claim the host verifies).
  // If there is no task, the host interprets this as a continuation of an open turn.
  const payload = { task: task || "", mode: agentMode, project: currentProject };
  // The slot helpers are read defensively: unit tests pull one function body
  // out of this module and run it with only the globals they stub.
  const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
  if (!task) {
    // Nothing is being sent, so there is nothing to wait for: the click is the
    // user's claim on the turn the log already holds, and the host's own frames
    // confirm it (a continuation writes no `user_message` for the outbox to see).
    setStatus("running");
    if (typeof setTabRunning === "function") setTabRunning(slotId, true);
  }
  try {
    // The unified run() interface: automatically distinguishes new turn (idle)
    // from continuation (open). The caller does not have to know which.
    driving.add(slotId);
    try {
      await hostCall(host.run(slotId, payload));
    } finally {
      driving.delete(slotId);
    }
  } catch (e) {
    const msg = (e && e.message) || e;
    // The call refused: no row for this task is coming, and the message stays in
    // the box — which is the whole point of it being there.
    pendingTask = "";
    if (e && e.code === "run_active") {
      // A drive of this turn is already in flight in this window (a resume that
      // beat the click, or a second click on a button the host had not yet
      // answered with `running`). Not a failure — the run the user asked for IS
      // the one running — so no "run failed" line: just stay on it.
      console.info("[run] already driving this turn:", msg);
      setStatus("running");
      if (typeof setTabRunning === "function") setTabRunning(slotId, true);
      return;
    }
    // No code: the call never reached a host at all (a dead IPC channel, an
    // unreachable bridge). no_session: the host answered that this window has
    // no session. Both are the lost session the dialog owns, not a one-line
    // transcript error nobody can act on. A project_mismatch is the opposite —
    // the session answered and refused, and its message says why — so it stays
    // inline with the attempt's record below.
    if (!e || !e.code || e.code === "no_session") {
      connectionLost("could not reach the session to run the task (" + msg + ")");
    } else {
      addEvent({ type: "final", status: "error", summary: "run failed: " + msg });
    }
    setStatus("idle");
    if (typeof setTabRunning === "function") setTabRunning(slotId, false);
  } finally {
    // The call answered. A row that has not arrived by now is not coming into
    // this pane (a turn that was CONTINUED writes none at all): the wait ends
    // here, with the message still in the box, where the reader can see it, edit
    // it, or ask again — rather than a box that emptied itself into nothing.
    endSend();
  }
}

export async function stop() {
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
    const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
    await hostCall(host.stop(slotId));
    if (typeof setTabRunning === "function") setTabRunning(slotId, false);
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
    // the link itself may be recoverable: re-resolve the session behind the
    // visible tab (the host re-binds it after a hop), or the window's own when
    // there is no tab. The guard is for unit harnesses that drive one function
    // body with only the globals they stub.
    if (typeof switchBackendActiveSlot === "function") await switchBackendActiveSlot();
    else await switchBackendResolved();
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
// (boot.ts) can continue a turn before the first row is drawn, and a boot
// that does not — today the page has no project until the user opens one —
// asks the moment the log it is looking at exists (project.ts). An idle
// answer does nothing at all; an open turn is driven exactly as the Run button
// drives it, same host call, same frames. Nothing is written here.
export async function resumeTurn() {
  const host = window.clutchRun;
  if (!host || typeof host.state !== "function" || typeof host.drive !== "function") return;
  const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
  if (!currentProject || busy) return; // no log to resume, or a turn already ours
  if (driving.has(slotId)) return; // its own drive is still in flight
  let answer;
  try {
    // the payload run:start takes; `project` is the CLAIM the host checks, so a
    // page looking at another file cannot continue somebody else's turn
    answer = await hostCall(host.state(slotId, { mode: agentMode, project: currentProject }));
  } catch (e) {
    // no fold to read: a host with no session, or a log that refused. Neither is
    // a turn this page may invent — stay on what the log stream replayed, and
    // leave the user's own Run exactly as it was.
    console.warn("[resume] no fold to resume from:", (e && e.message) || e);
    return;
  }
  if (!answer || !answer.result || answer.result.phase !== "open") return;
  // `driven` is the host's answer to the half of the question the fold cannot
  // answer: the turn is open AND this window already has a wheel on it (a
  // run:start or run:drive of ours still in flight — the reason the page comes
  // back here at all is a tab switch, which re-runs finishOpen()). Driving it
  // again is what produced "a step is already running" on every switch, and the
  // catch below then marked the RUNNING tab idle.
  //
  // Nothing to drive: the wheel in flight paints its own frames. What the switch
  // DOES have to restore is the truth about the tab — a turn this window is
  // driving is a running tab, and saying nothing here left the reader looking at
  // an idle badge and a ▶ Run button on work that was still going.
  setStatus("running");
  if (typeof setTabRunning === "function") setTabRunning(slotId, true);
  if (answer.driven) return;
  try {
    driving.add(slotId);
    try {
      await hostCall(host.drive(slotId));
    } finally {
      driving.delete(slotId);
    }
  } catch (e) {
    const msg = (e && e.message) || e;
    if (e && e.code === "run_active") {
      // Refused before it could touch the loop: somebody is already driving this
      // turn (another window, the phone, or this window's own start between the
      // state and this call). That is a fact about the turn, not a failure of
      // this window: no toast — the notice here is the "a step is already
      // running" the reader saw on every switch — and no `setStatus("idle")` /
      // `setTabRunning(slotId, false)`, which is what marked a RUNNING tab idle
      // and made a remote turn look like it had died when the reader came back
      // to it. The turn is open and being written; the session's own
      // execution_status frames are what end it, here and in the tab strip.
      console.info("[resume] somebody is already driving this turn:", msg);
      return;
    }
    if (e && e.code === "run_elsewhere") {
      // The open turn is ANOTHER window's run. The page has a better account of
      // that than this refusal does — the claim pill and the session's own
      // `running_elsewhere` frames (render-events.ts announceProjectClaim) — so it
      // is not a failure to report, and it is not a wheel this window holds: the
      // optimistic "running" above was a guess at a turn this window may not
      // drive, and the badge goes back to where the session says it is.
      console.info("[resume] another window is running this turn:", msg);
      setStatus("idle");
      if (typeof setTabRunning === "function") setTabRunning(slotId, false);
      return;
    }
    if (!e || !e.code || e.code === "no_session") {
      connectionLost("could not reach the session to resume the turn (" + msg + ")");
    } else {
      notice("could not resume the turn (" + msg + ")");
    }
    setStatus("idle");
    if (typeof setTabRunning === "function") setTabRunning(slotId, false);
  }
}

// The host loop's display feed (P1-4): deltas, the execution_status frames,
// retry notices, compaction progress. Durable records do NOT come here — they
// arrive on the log stream, announced by the append that wrote them — which is
// what lets a window that was closed for the whole turn still replay it.
// addEvent takes both shapes, so a live frame lands exactly as the stream's own
// would (and a status frame is a status frame whichever door it came through).
if (window.clutchRun && typeof window.clutchRun.onEvent === "function") {
  window.clutchRun.onEvent((payload) => {
    // main/bridge tag live frames with the slot (tab) they belong to. A frame
    // from a background tab updates its badge only: its transcript is replayed
    // when the reader returns, and painting it here would draw one tab's run
    // into another tab's stream.
    const wrapped =
      payload && typeof payload === "object" && typeof payload.slotId === "string" && "event" in payload;
    const slotId = wrapped ? payload.slotId : activeSlotId();
    const ev = wrapped ? payload.event : payload;
    if (!ev || typeof ev !== "object") return;
    if (slotId && slotId !== activeSlotId()) {
      noteTabEvent(slotId, ev);
      return;
    }
    addEvent(ev);
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

