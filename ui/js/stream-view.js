// the event pane's view state — scroll latch, jump-to-bottom, run status
//
// Latched tail-follow (only a user's own upward scroll breaks it), the glide to
// the bottom, the ↓ pill, the run status line, and the live-block handles the
// streaming renderers append into.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

let busy = false;
const stream = $("#stream");
const eventsEl = document.getElementById("events");
const jumpBottom = $("#jump-bottom");

// how far from the bottom the view counts as "following the stream"
const JUMP_BOTTOM_GAP = 80;

function nearBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < JUMP_BOTTOM_GAP;
}

// ↓ button visibility mirrors the latch; all latch paths report through here
function setJumpVisible(visible) {
  jumpBottom.classList.toggle("hidden", !visible);
}

// Latched tail-follow: reaching the bottom (or ↓) pins the view; only a user's
// upward scroll breaks the latch (the ↓ button returns to the tail).
let followTail = true;
let lastScrollTop = 0;

// A catch-up (the records a (re)connect is owed, ui/js/sse-stream.js `?since=`)
// lands as one block between the server's `history` and `replayed` frames. While
// it is arriving the view does not follow: painting N records one by one would
// scroll N times (a phone returning from the background drags a whole window's
// worth), and it would drag a user who had scrolled up down with it. So the
// block paints in one pass and the view moves once, at the end — and then only
// through autoScroll(), which respects the latch. beginCatchUp/endCatchUp are
// bracket calls (ui/js/stream-events.js), not a counter: the frames nest nowhere.
let catchUp = false;

let gliding = false;
let glideRaf = 0;

function beginCatchUp() {
  catchUp = true;
}

function endCatchUp() {
  if (!catchUp) return;
  catchUp = false;
  autoScroll(); // once, at the block's end: a latched view lands on the tail
}

function autoScroll(force) {
  if (stream.classList.contains("loading")) return;
  if (catchUp && !force) return; // one scroll per catch-up, not one per record
  if (force) {
    // User-initiated jump (message send, ↓, Cmd/Ctrl+Down): tracked = instant pin,
    // untracked = the one smooth glide that re-latches on arrival.
    if (followTail) {
      if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
      gliding = false;
      stream.scrollTop = stream.scrollHeight;
      setJumpVisible(false);
    } else {
      glideToBottom();
    }
    return;
  }
  if (followTail) {
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
function glideToBottom() {
  if (stream.classList.contains("loading")) return;
  cancelAnimationFrame(glideRaf);
  const target = stream.scrollHeight;
  if (stream.scrollTop >= target - 1) {
    // already at the tail: land straight into the latch
    gliding = false;
    followTail = true;
    setJumpVisible(false);
    return;
  }
  gliding = true;
  if (reducedMotion()) {
    stream.scrollTop = stream.scrollHeight;
    gliding = false;
    followTail = true;
    setJumpVisible(false);
    return;
  }
  stream.scrollTo({ top: target, behavior: "smooth" });
  const finish = () => {
    const bottom = stream.scrollHeight - stream.clientHeight;
    if (!gliding || Math.abs(stream.scrollTop - target) < 2 || Math.abs(stream.scrollTop - bottom) < 2) {
      gliding = false;
      // landed (or clamped to a new bottom): re-latch
      followTail = true;
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
    if (followTail && !stream.classList.contains("loading")) autoScroll();
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
let prevClientH = stream.clientHeight;
let prevScrollH = stream.scrollHeight;
// ignore latch changes ~120ms after the input box resizes: the clamp scroll
// event can fire before the shrunken viewport is observable
let suppressLatchUntil = 0;
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
  if (viewportChanged || scrollShrank || performance.now() < suppressLatchUntil) {
    lastScrollTop = cur;
    return;
  }
  // a real user gesture takes over from any in-flight jump glide
  if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
  gliding = false;
  // only a scroll away from the bottom is a user intent to leave the latch
  const up = cur < lastScrollTop && !nearBottom();
  if (up) {
    followTail = false;
  } else if (nearBottom()) followTail = true;
  lastScrollTop = cur;
  // the button is visible exactly when NOT latched
  setJumpVisible(!followTail);
}, { passive: true });

function setStatus(state) {
  els.status.className = "badge " + (state || "idle");
  els.status.textContent = state || "idle";
  busy = state === "running" || state === "waiting";
  // the run button doubles as Stop while a run is in progress
  els.run.textContent = busy ? "■ Stop" : "▶ Run";
  els.run.title = busy
    ? "stop the running task"
    : "run the task — Cmd/Ctrl+Enter in the box";
  els.run.classList.toggle("stop-mode", busy);
  els.run.disabled = busy ? false : !currentProject;
  // the mode applies to the next run only: lock the toggle while busy
  els.mode.disabled = busy;
  els.mode.title = busy
    ? "A run is in progress; the mode applies to the next run."
    : "chat: read-only analysis · work: full access (write/edit/any command). Applies to the next run.";
}

// tracks the most recent agent text block (created by streaming text_delta)
let lastTextEl = null;
let lastTextContent = "";
// thinking (reasoning) block
let thinkingEl = null;
let thinkingContent = "";
let compactionEl = null; // live "compressing context" block (compaction_delta)
let retryNoteEl = null; // live "reconnecting…" chip (llm_retry), removed once the stream resumes

// map tool_call_id -> {name, args, ui} so a tool_result knows which tool
// produced it and how its component said it looks
const toolCalls = {};
// the block currently collecting consecutive tool_calls (for merging)
let toolGroupEl = null;
// tool_call_id -> owning block: results land next to their own call row
const toolCallGroups = new Map();

