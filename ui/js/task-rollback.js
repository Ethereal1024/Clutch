// roll the workspace back to a sent message — right-click, or long-press
//
// The gesture is on the task row itself: right-click on a desktop, a long press
// on a phone. It offers the one thing a reader of a finished task wants when the
// task went the wrong way — "put the files back the way they were before I asked
// this, and give me the message to edit" — without hunting for a per-file undo
// (which is what the change rows' ↶ reverts, one file at a time).
//
// The server owns the set: every file a tool overwrote or created is journaled
// under the log offset of the task that was running (agent/tools/workspace.py
// begin_turn / record_mutation), and POST /api/workspace/rollback {offset} undoes
// all of them at or after that offset, newest first. /api/workspace/checkpoints
// says which offsets have anything recorded, so a row whose task changed nothing
// is answered without a confirmation that leads nowhere.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// how long a finger must rest on a message before it counts as a long press.
// The platform's own long-press (selection, the context callout) starts around
// this time and is suppressed below, so the two do not fight.
const LONG_PRESS_MS = 500;
// a finger that wanders further than this is scrolling, not pressing
const LONG_PRESS_SLOP_PX = 12;
// Right-click and long-press can both fire for ONE gesture (Chrome on Android
// fires `contextmenu` for a long press as well): the second within this window
// is the same gesture, not a new one.
const ROLLBACK_GESTURE_DEDUPE_MS = 800;

// log offsets the server has recorded changes for; null = not asked yet. A row
// whose offset is missing from the set cannot be rolled back (the task changed
// no file), which is answered honestly instead of with a question the server
// would refuse.
let rollbackAnchors = null;
let rollbackBusy = false;
let lastRollbackGestureAt = 0;

function resetRollbackAnchors() {
  rollbackAnchors = null;
}

async function refreshRollbackAnchors() {
  try {
    const data = await apiFetch("/api/workspace/checkpoints");
    rollbackAnchors = new Set((data.anchors || []).map(Number));
  } catch (e) {
    // Not an error the user can act on, and the gesture still works: an unknown
    // set only means the confirm dialog is offered and the server answers. Say
    // nothing here — a notice on every project switch would be noise.
    rollbackAnchors = null;
  }
}

// the message text a row carries: renderEvent stores the task's raw content on
// the row (js/render-events.js), because the rendered DOM is markdown and cannot
// be turned back into what the user typed.
function rowTaskText(el) {
  return el && typeof el._taskText === "string" ? el._taskText : "";
}

function openRollbackMenu(el) {
  const now = performance.now();
  if (now - lastRollbackGestureAt < ROLLBACK_GESTURE_DEDUPE_MS) return;
  lastRollbackGestureAt = now;
  if (rollbackBusy) return;
  const offset = Number(el.dataset.offset);
  if (!Number.isFinite(offset)) return; // a row with no byte offset (should not happen)
  if (busy) {
    notice("a run is active — stop it before rolling the workspace back");
    return;
  }
  if (rollbackAnchors && !rollbackAnchors.has(offset)) {
    notice("that message left no file changes to roll back", "info");
    return;
  }
  rollbackTo(el, offset);
}

async function rollbackTo(el, offset) {
  const ok = await askConfirm({
    title: "Roll back to this message",
    text:
      "Every file change made after this message is undone — files it created are\n" +
      "deleted, files it overwrote are restored to what they held before.\n" +
      "The message goes back into the input box; the transcript is kept.\n" +
      "Changes made by shell commands (sed, mv, rm) are not tracked.",
    ok: "Roll back",
  });
  if (!ok) return;
  rollbackBusy = true;
  try {
    const data = await apiFetch("/api/workspace/rollback", { method: "POST", body: { offset } });
    const n = data.count || 0;
    notice(
      `rolled back ${n} file${n === 1 ? "" : "s"}` +
        (data.deleted && data.deleted.length ? ` (${data.deleted.length} deleted)` : ""),
      "info"
    );
    fillTaskInput(rowTaskText(el));
    refreshTree();
    await refreshRollbackAnchors(); // these entries are gone from the journal now
  } catch (e) {
    notice("roll back failed: " + ((e && e.message) || e));
    // a refusal can mean the anchors moved under us (another window ran a task):
    // re-read them so the next press is answered from the server's truth
    refreshRollbackAnchors();
  } finally {
    rollbackBusy = false;
  }
}

// ---- the gestures ----
// contextmenu covers the desktop's right-click AND (on Android) the long press;
// the touch timer below covers the WebViews that never send it.

eventsEl.addEventListener("contextmenu", (e) => {
  const el = e.target && e.target.closest ? e.target.closest(".event.user") : null;
  if (!el) return;
  e.preventDefault(); // no OS menu: this row's menu is ours
  openRollbackMenu(el);
});

let pressTimer = 0;
let pressEl = null;
let pressFrom = null;

function cancelPress() {
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = 0;
  pressEl = null;
  pressFrom = null;
}

eventsEl.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length !== 1) return cancelPress(); // a pinch is not a press
    const el = e.target && e.target.closest ? e.target.closest(".event.user") : null;
    if (!el) return;
    const t = e.touches[0];
    cancelPress();
    pressEl = el;
    pressFrom = { x: t.clientX, y: t.clientY };
    pressTimer = setTimeout(() => {
      const target = pressEl;
      pressTimer = 0;
      pressEl = null;
      pressFrom = null;
      if (target) openRollbackMenu(target);
    }, LONG_PRESS_MS);
  },
  { passive: true }
);

eventsEl.addEventListener(
  "touchmove",
  (e) => {
    if (!pressFrom || !e.touches.length) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - pressFrom.x, t.clientY - pressFrom.y) > LONG_PRESS_SLOP_PX) cancelPress();
  },
  { passive: true }
);
eventsEl.addEventListener("touchend", cancelPress, { passive: true });
eventsEl.addEventListener("touchcancel", cancelPress, { passive: true });
