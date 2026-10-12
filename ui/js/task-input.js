// the task box's own conveniences — undo, sent-message history, clear
//
// The composer behaves like the ones people arrived from (DeepSeek, Doubao):
// Ctrl/Cmd+Z takes back what you typed, ArrowUp/ArrowDown walk the messages you
// already sent, Escape empties the box. `fillTaskInput` is the one programmatic
// entry, used by the roll-back action (js/task-rollback.js) to put a message
// back in the box.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// ---- undo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y) ----
//
// The platform's own undo stack for a <textarea> dies the moment the app writes
// .value itself, and run() does exactly that after every send (els.task.value =
// "") — so the box keeps its own history instead of depending on a stack a
// programmatic write resets. Entries are coalesced into typing BURSTS (a pause,
// or a moment of silence, closes one): one entry per keystroke would make Ctrl+Z
// a per-character rewind, which is not what the shortcut means anywhere.
const TASK_UNDO_MAX = 200;
const TASK_UNDO_BURST_MS = 500;
let taskUndoStack = [];
let taskRedoStack = [];
let taskUndoAt = 0; // when the last entry was pushed (burst grouping)

// What the box held when the LAST change was recorded. Kept in sync with every
// write (so a redundant `input` event — the one fillTaskInput dispatches itself
// — cannot push a duplicate entry).
let taskLastValue = els.task.value;

function taskPushUndo(value, forced) {
  const now = performance.now();
  if (!forced && now - taskUndoAt < TASK_UNDO_BURST_MS && taskUndoStack.length) return;
  taskUndoAt = now;
  if (taskUndoStack[taskUndoStack.length - 1] === value) return;
  taskUndoStack.push(value);
  if (taskUndoStack.length > TASK_UNDO_MAX) taskUndoStack.shift();
  taskRedoStack = []; // a new edit is the end of the redo branch, as everywhere
}

// write the box and let its other listeners see a normal edit: the auto-grow
// (js/settings.js) and the history-browsing reset below both hang off `input`,
// so dispatching one keeps every path in agreement with a keystroke.
function taskSetValue(value) {
  els.task.value = value;
  taskLastValue = value;
  els.task.dispatchEvent(new Event("input"));
}

function taskUndo() {
  if (!taskUndoStack.length) return false;
  taskRedoStack.push(els.task.value);
  taskSetValue(taskUndoStack.pop());
  return true;
}

function taskRedo() {
  if (!taskRedoStack.length) return false;
  taskUndoStack.push(els.task.value);
  taskSetValue(taskRedoStack.pop());
  return true;
}

// ---- sent-message history (ArrowUp / ArrowDown) ----
//
// Only what the user actually SENT is history (recordSentTask, called by run()).
// A message recalled from history and edited does not join it: the history is the
// record of the conversation, not of the box. The draft the user was typing when
// they started browsing is kept aside and restored by walking back down past the
// newest entry — so ArrowUp, ArrowUp, ArrowDown, ArrowDown lands exactly where
// the user was, which is the shape every composer with this feature has.
const TASK_HISTORY_MAX = 200;
let taskHistory = []; // sent tasks, oldest first
let taskHistoryPos = -1; // -1 = not browsing; else an index into taskHistory
let taskDraft = ""; // what the box held before browsing started

function recordSentTask(task) {
  const text = String(task == null ? "" : task);
  if (text.trim() && taskHistory[taskHistory.length - 1] !== text) taskHistory.push(text);
  if (taskHistory.length > TASK_HISTORY_MAX) taskHistory.shift();
  taskHistoryPos = -1;
  taskDraft = "";
  // The sent text is NOT pushed onto the undo stack: undo takes back an EDIT,
  // and re-reading what was just sent is what ArrowUp is for. Recording the
  // box's new (empty) content keeps the next keystroke from pushing the stale
  // pre-send text as its own burst.
  taskLastValue = els.task.value;
}

function taskHistoryOlder() {
  if (!taskHistory.length) return false;
  if (taskHistoryPos < 0) {
    taskDraft = els.task.value;
    taskHistoryPos = taskHistory.length - 1;
  } else if (taskHistoryPos > 0) {
    taskHistoryPos--;
  } else {
    return false; // already on the oldest: leave the box alone
  }
  taskSetValue(taskHistory[taskHistoryPos]);
  taskCaretToEnd();
  return true;
}

function taskHistoryNewer() {
  if (taskHistoryPos < 0) return false; // not browsing: ArrowDown keeps its own meaning
  if (taskHistoryPos < taskHistory.length - 1) {
    taskHistoryPos++;
    taskSetValue(taskHistory[taskHistoryPos]);
  } else {
    taskHistoryPos = -1;
    taskSetValue(taskDraft); // past the newest entry: the draft comes back
  }
  taskCaretToEnd();
  return true;
}

function taskCaretToEnd() {
  const n = els.task.value.length;
  try { els.task.setSelectionRange(n, n); } catch (e) { /* not a text field (stub/browser dev) */ }
}

// The one programmatic entry (the task roll-back puts the message back here).
// The value it REPLACES goes on the undo stack, so Ctrl+Z takes the box back to
// whatever the user was composing.
function fillTaskInput(text) {
  taskPushUndo(els.task.value, true);
  taskSetValue(String(text == null ? "" : text));
  taskHistoryPos = -1;
  taskDraft = "";
  els.task.focus();
  taskCaretToEnd();
}

// ---- the box's own events ----

els.task.addEventListener("input", () => {
  if (els.task.value === taskLastValue) return; // a write we already recorded
  taskPushUndo(taskLastValue, false);
  taskLastValue = els.task.value;
  // Editing leaves the browsing session: the next ArrowUp starts from the newest
  // sent message again (the same rule the draft restore above assumes).
  taskHistoryPos = -1;
  taskDraft = "";
});

// Is the caret on the first/last line, with nothing selected? Arrow keys mean
// "move the caret" inside the text and "walk the history" only from the edge —
// otherwise a multi-line task could never be navigated with the keyboard.
function taskCaretOnFirstLine() {
  const s = els.task.selectionStart, e = els.task.selectionEnd;
  if (s !== e) return false;
  return els.task.value.lastIndexOf("\n", s - 1) < 0;
}

function taskCaretOnLastLine() {
  const s = els.task.selectionStart, e = els.task.selectionEnd;
  if (s !== e) return false;
  return els.task.value.indexOf("\n", s) < 0;
}

els.task.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = (e.key || "").toLowerCase();
  if (mod && e.shiftKey && key === "z") {
    if (taskRedo()) e.preventDefault();
    return;
  }
  if (mod && !e.shiftKey && key === "z") {
    if (taskUndo()) e.preventDefault();
    return;
  }
  if (mod && !e.shiftKey && key === "y") {
    if (taskRedo()) e.preventDefault();
    return;
  }
  if (key === "escape" && els.task.value) {
    taskPushUndo(els.task.value, true); // Escape clears; Ctrl+Z brings it back
    taskSetValue("");
    e.preventDefault();
    return;
  }
  if (mod || e.shiftKey || e.altKey) return;
  if (e.key === "ArrowUp" && taskCaretOnFirstLine()) {
    if (taskHistoryOlder()) e.preventDefault();
  } else if (e.key === "ArrowDown" && taskCaretOnLastLine()) {
    if (taskHistoryNewer()) e.preventDefault();
  }
});
