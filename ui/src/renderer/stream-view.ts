// the event pane's view state — scroll latch, jump-to-bottom, run status
//
// Latched tail-follow (only a user's own upward scroll breaks it), the glide to
// the bottom, the ↓ pill, the run status line, and the live-block handles the
// streaming renderers append into.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { els, eventsEl, stream } from "./els";
import { $ } from "./dom";
import { currentProject } from "./project";
import { state } from "./state";
import { foldHoldsScroll, reducedMotion } from "./stream-text";

export let busy = false;
export const jumpBottom = $("#jump-bottom");

// how far from the bottom the view counts as "following the stream"
export const JUMP_BOTTOM_GAP = 80;

export function nearBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < JUMP_BOTTOM_GAP;
}

// ↓ button visibility mirrors the latch; all latch paths report through here
export function setJumpVisible(visible) {
  jumpBottom.classList.toggle("hidden", !visible);
}

// Latched tail-follow: reaching the bottom (or ↓) pins the view; only a user's
// upward scroll breaks the latch (the ↓ button returns to the tail).
export let lastScrollTop = 0;

// A catch-up (the records a (re)connect is owed, ui/src/renderer/sse-stream.ts `?since=`)
// lands as one block between the server's `history` and `replayed` frames. While
// it is arriving the view does not follow: painting N records one by one would
// scroll N times (a phone returning from the background drags a whole window's
// worth), and it would drag a user who had scrolled up down with it. So the
// block paints in one pass and the view moves once, at the end — and then only
// through autoScroll(), which respects the latch. beginCatchUp/endCatchUp are
// bracket calls (ui/src/renderer/stream-events.ts), not a counter: the frames nest nowhere.
export let catchUp = false;

export let gliding = false;
export let glideRaf = 0;

export function beginCatchUp() {
  catchUp = true;
}

export function endCatchUp() {
  if (!catchUp) return;
  catchUp = false;
  autoScroll(); // once, at the block's end: a latched view lands on the tail
}

export function autoScroll(force = false) {
  if (stream.classList.contains("loading")) return;
  // A region fold that is handing the pane's scroll back (stream-text.ts,
  // giveBack) already has the pane where it wants it: re-pinning the tail under it
  // would carry the head it is holding at the top edge off with the shrinking box.
  // The engine loads after this file, so the typeof is only there for a
  // ResizeObserver callback delivered between the two scripts — there is no fold to
  // give anything back before it exists.
  if (typeof foldHoldsScroll === "function" && foldHoldsScroll() && !force) return;
  if (catchUp && !force) return; // one scroll per catch-up, not one per record
  if (force) {
    // User-initiated jump (message send, ↓, Cmd/Ctrl+Down): tracked = instant pin,
    // untracked = the one smooth glide that re-latches on arrival.
    if (state.followTail) {
      if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
      gliding = false;
      stream.scrollTop = stream.scrollHeight;
      setJumpVisible(false);
    } else {
      glideToBottom();
    }
    return;
  }
  if (state.followTail) {
    // tracked: instant pin — never during a user jump-glide (untracked ↓)
    if (gliding) return;
    stream.scrollTop = stream.scrollHeight;
    setJumpVisible(false);
  } else {
    // untracked: content growth never moves the view; only the ↓ glide may
    setJumpVisible(true);
  }
}

// ---- jump-to-bottom glide (user-initiated only) ----
// scrollTo glides to the tail captured at call time; a rAF poll detects the
// landing and re-pins to absorb growth that arrived mid-glide.
export function glideToBottom() {
  if (stream.classList.contains("loading")) return;
  cancelAnimationFrame(glideRaf);
  const target = stream.scrollHeight;
  if (stream.scrollTop >= target - 1) {
    // already at the tail: land straight into the latch
    gliding = false;
    state.followTail = true;
    setJumpVisible(false);
    return;
  }
  gliding = true;
  if (reducedMotion()) {
    stream.scrollTop = stream.scrollHeight;
    gliding = false;
    state.followTail = true;
    setJumpVisible(false);
    return;
  }
  stream.scrollTo({ top: target, behavior: "smooth" });
  const finish = () => {
    const bottom = stream.scrollHeight - stream.clientHeight;
    if (!gliding || Math.abs(stream.scrollTop - target) < 2 || Math.abs(stream.scrollTop - bottom) < 2) {
      gliding = false;
      // landed (or clamped to a new bottom): re-latch
      state.followTail = true;
      setJumpVisible(false);
      if (!stream.classList.contains("loading")) {
        stream.scrollTop = stream.scrollHeight; // absorb growth that arrived mid-glide
      }
      return;
    }
    glideRaf = requestAnimationFrame(finish);
  };
  glideRaf = requestAnimationFrame(finish);
}

// Async layout growth (fonts, images, math) can land after autoScroll: watch the
// CONTENT's height (never the viewport) and re-pin while latched.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (state.followTail && !stream.classList.contains("loading")) autoScroll();
  }).observe(eventsEl);
}

jumpBottom.addEventListener("click", () => {
  // autoScroll(force) decides: instant pin when tracked, smooth glide when untracked
  autoScroll(true);
});
// Cmd/Ctrl+Down anywhere: same jump-to-tail as the ↓ button
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
    autoScroll(true);
  }
});
export let prevClientH = stream.clientHeight;
export let prevScrollH = stream.scrollHeight;
// ignore latch changes ~120ms after the input box resizes: the clamp scroll
// event can fire before the shrunken viewport is observable
stream.addEventListener("scroll", (e) => {
  // Only the user's own gestures update the latch. Programmatic scrolls fire
  // isTrusted=false and never touch it; a passive clamp (viewport or content
  // shrink) fires a TRUSTED scroll — ignore it via the fingerprints above.
  const cur = stream.scrollTop;
  if (!e.isTrusted) {
    lastScrollTop = cur;
    // refresh baselines on programmatic pins so clamp fingerprints never compare
    // against a stale baseline
    prevClientH = stream.clientHeight;
    prevScrollH = stream.scrollHeight;
    return;
  }
  // viewport resize / content shrink clamps fire trusted scrolls; none is a user
  // gesture, so they must neither cancel a glide nor drop the latch
  const viewportChanged = stream.clientHeight !== prevClientH;
  prevClientH = stream.clientHeight;
  const scrollShrank = stream.scrollHeight < prevScrollH;
  prevScrollH = stream.scrollHeight;
  if (viewportChanged || scrollShrank || performance.now() < state.suppressLatchUntil) {
    lastScrollTop = cur;
    return;
  }
  // a real user gesture takes over from any in-flight jump glide
  if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
  gliding = false;
  // only a scroll away from the bottom is a user intent to leave the latch
  const up = cur < lastScrollTop && !nearBottom();
  if (up) {
    state.followTail = false;
  } else if (nearBottom()) state.followTail = true;
  lastScrollTop = cur;
  // the button is visible exactly when NOT latched
  setJumpVisible(!state.followTail);
}, { passive: true });

// The composer's own wait (render-events.ts beginSend): the task is in the box
// and on its way, and the log has not confirmed it yet. It is a STATUS and not a
// flag beside one, because that is exactly what it is — a state the page is in —
// and every other way a send can stop being a send already comes through here:
// the host's own running frames, a failure (render-events.ts run), a tab switch
// (project.ts activateTab, which ends the wait and KEEPS the message).
export let sending = false;

// The TWO reasons this view may not write to the project it is watching, kept
// apart because they end differently. `readOnly`: the file was OPENED as a
// viewer here (fixed until it is reopened). `claimed`: another window is
// RUNNING this project right now — a live fact, announced by the session
// (render-events.ts `running_elsewhere`), over the moment that run ends, after
// which this window may send again with no reload and no retry. Neither is a
// lock on the FILE: an idle project is nobody's, which is why a run can start
// anywhere the moment the last one ends.
export let readOnly = false;
export let claimed = false;

export function setReadOnly(on) {
  const next = !!on;
  if (next === readOnly) return;
  readOnly = next;
  paintControls();
}

export function setClaimed(on) {
  const next = !!on;
  if (next === claimed) return;
  claimed = next;
  paintControls();
}

export function setStatus(state) {
  const now = state || "idle";
  sending = now === "sending";
  els.status.className = "badge " + now;
  els.status.textContent = now;
  busy = now === "running" || now === "waiting";
  // notify status-bar.ts without creating a circular import
  document.dispatchEvent(new CustomEvent("clutch:status-changed", { detail: now }));
  paintControls();
}

// The box and the three controls beside it, painted from one state: the run
// button is Run, the wait of a send, or Stop; the box is locked exactly while it
// holds a message the log has not taken yet.
function paintControls() {
  // the run button doubles as the send's own wait, and as Stop while a run is in
  // progress (the spinner is `#run-btn.sending::before`, style.css)
  els.run.textContent = sending ? "Sending" : busy ? "■ Stop" : "▶ Run";
  // why the button cannot be pressed is part of the button: an unexplained dead
  // Run is the shape of bug this page has no room for
  els.run.title = sending
    ? "the message is on its way — it leaves the box when the session has it"
    : busy
      ? "stop the running task"
      : claimed
        ? "another window is running this project — the composer is yours again when that run ends"
        : readOnly
          ? "this project is open read-only here — a run needs a writable open"
          : "run the task — Cmd/Ctrl+Enter in the box";
  els.run.classList.toggle("stop-mode", busy);
  els.run.classList.toggle("sending", sending);
  // a wait is not a dead control: it cannot be pressed twice, but it keeps the
  // primary look (style.css restores the full strength `button:disabled` takes)
  els.run.disabled = sending ? true : busy ? false : (!currentProject || readOnly || claimed);
  // the message in the box IS the one being sent, and a box you can type over it
  // says the opposite. Read-only, not disabled, so the message stays selectable
  // and copyable while the round trip is in the reader's way. Neither a viewer
  // open nor another window's run is a place to type into, either: a composer
  // that accepts a message it can never send is the one lie this page must not
  // tell.
  els.task.readOnly = sending || readOnly || claimed;
  if (sending) els.task.setAttribute("aria-busy", "true");
  else els.task.removeAttribute("aria-busy");
  // the mode applies to the next run only: lock the toggle while busy
  els.mode.disabled = busy || sending || readOnly || claimed;
  els.mode.title = busy || sending
    ? "A run is in progress; the mode applies to the next run."
    : readOnly || claimed
      ? "This stream is read-only; the mode applies to a later run."
      : "chat: read-only analysis · work: full access (write/edit/any command). Applies to the next run.";
  // the pill is the whole announcement of a foreign run: it sits beside the
  // controls it disables, and its own click is the reload
  if (els.claim) els.claim.classList.toggle("hidden", !claimed);
}

// tracks the most recent agent text block (created by streaming text_delta)
// thinking (reasoning) block

// map tool_call_id -> {name, args, ui} so a tool_result knows which tool
// produced it and how its component said it looks
export const toolCalls = {};
// the block currently collecting consecutive tool_calls (for merging)
// tool_call_id -> owning block: results land next to their own call row
export const toolCallGroups = new Map();

