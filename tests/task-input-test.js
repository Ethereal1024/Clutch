"use strict";

// The composer's conveniences (ui/js/task-input.js): undo, sent-message history,
// clear. Written because the box's own undo stack is what the app's writers break
// — the platform's <textarea> undo dies the moment a script assigns .value, and
// run() assigns it after every send (js/render-events.js).
//
// This runner loads the REAL file into a vm context against a fake <textarea>
// and drives it the way the page does — `input` events for typing, `keydown` for
// the shortcuts — so the rules it claims (bursts close on a pause, only SENT
// tasks are history, the arrow keys navigate only from the text's edges) are the
// rules the code actually implements.
//
// Run: node tests/task-input-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary } = require("./harness.js");

// ---- the fake box ----
function makeTextarea() {
  const listeners = {};
  const t = {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    focused: false,
    style: {},
    offsetHeight: 36,
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of listeners[ev.type] || []) fn(ev);
      return true;
    },
    focus() {
      t.focused = true;
    },
    setSelectionRange(s, e) {
      t.selectionStart = s;
      t.selectionEnd = e;
    },
    fire(type, ev) {
      for (const fn of listeners[type] || []) fn(ev);
    },
  };
  return t;
}

const task = makeTextarea();
let clock = 0; // performance.now(), advanced by hand: bursts are measured in ms

const ctx = {
  els: { task },
  performance: { now: () => clock },
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "js", "task-input.js"), "utf8"), ctx);

// ---- drivers ----
// typing: the box's value changed by the user, then the `input` event the page
// listens to (auto-grow and this file both hang off it)
function type(text) {
  task.value = text;
  task.selectionStart = text.length;
  task.selectionEnd = text.length;
  task.dispatchEvent({ type: "input" });
}

function key(name, mods = {}) {
  const ev = {
    key: name,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
  };
  Object.assign(ev, mods);
  task.fire("keydown", ev);
  return ev;
}

const caret = () => `${task.selectionStart}-${task.selectionEnd}`;

// ---- 1) undo: bursts, and the box's words come back after every write ----
check(typeof ctx.taskUndo === "function" && typeof ctx.recordSentTask === "function",
      "the file's functions are on the shared global scope, as a classic script requires");

clock = 1000;
type("a");
clock += 10;
type("ab");
clock += 10;
type("abc");
check(task.value === "abc", "typing leaves the box holding what was typed");

const ctrlZ = () => key("z", { ctrlKey: true });
let ev = ctrlZ();
check(task.value === "" && ev.defaultPrevented,
      "one Ctrl+Z takes back a whole typing burst, not one character (got " + JSON.stringify(task.value) + ")");
ev = ctrlZ();
check(task.value === "" && !ev.defaultPrevented,
      "Ctrl+Z at the start of the box's history is left to the platform");

type("a");
clock += 10;
type("ab");
clock += 600; // a pause closes the burst
type("abc");
ev = ctrlZ();
check(task.value === "ab", "a pause closes a burst: the next Ctrl+Z lands on its start (got " + JSON.stringify(task.value) + ")");
ev = key("z", { ctrlKey: true, shiftKey: true });
check(task.value === "abc", "Ctrl+Shift+Z redoes the undone edit");
ev = key("y", { ctrlKey: true });
check(task.value === "abc" && !ev.defaultPrevented, "Ctrl+Y redoes nothing when the redo branch is spent");

// a deterministic undo/redo run (the file's stacks are its own bindings; a later
// script in the same page can reach them, which is what this line relies on)
vm.runInContext("taskUndoStack = []; taskRedoStack = [];", ctx);
clock += 1000;
type("one");
clock += 10;
type("one two");
clock += 1000; // a pause: this burst pushes the value the previous one ended on
type("one two three");
ev = ctrlZ();
check(task.value === "one two", "Ctrl+Z after a pause takes back the latest burst");
ev = key("y", { ctrlKey: true });
check(task.value === "one two three" && ev.defaultPrevented, "Ctrl+Y redoes what that Ctrl+Z took back");

// ---- 2) Escape clears, and Ctrl+Z brings the text back ----
type("a task worth keeping");
ev = key("Escape");
check(task.value === "" && ev.defaultPrevented, "Escape empties the box");
ev = ctrlZ();
check(task.value === "a task worth keeping", "Ctrl+Z restores what Escape cleared");
ev = key("Escape");
check(ev.defaultPrevented === true && task.value === "", "Escape on a filled box is consumed");
ev = key("Escape");
check(!ev.defaultPrevented && task.value === "", "Escape on an empty box is left alone");
ctrlZ();
task.value = "";
task.selectionStart = task.selectionEnd = 0;

// ---- 3) sent-message history (ArrowUp / ArrowDown) ----
ctx.recordSentTask("first message");
ctx.recordSentTask("second message");
ctx.recordSentTask("   "); // blank sends are not history
ctx.recordSentTask("second message"); // and a repeat is not a second entry

ev = key("ArrowUp");
check(task.value === "second message" && ev.defaultPrevented, "ArrowUp recalls the last sent message");
key("ArrowUp");
check(task.value === "first message", "ArrowUp again walks to the one before it");
ev = key("ArrowUp");
check(task.value === "first message" && !ev.defaultPrevented, "ArrowUp stops at the oldest sent message");
key("ArrowDown");
check(task.value === "second message", "ArrowDown walks back down the history");
key("ArrowDown");
check(task.value === "", "ArrowDown past the newest entry restores the empty draft");

type("a half-written draft");
key("ArrowUp");
check(task.value === "second message", "ArrowUp from a draft opens the history at the newest message");
key("ArrowDown");
check(task.value === "a half-written draft", "ArrowDown past the newest message restores the draft, not an empty box");

// the arrow keys stay caret movement inside the text: only the edges browse
task.value = "line one\nline two";
task.selectionStart = task.selectionEnd = task.value.length; // end of the LAST line
ev = key("ArrowUp");
check(task.value === "line one\nline two" && !ev.defaultPrevented,
      "ArrowUp inside the text moves the caret, it does not browse history");
task.selectionStart = task.selectionEnd = 3; // the FIRST line
ev = key("ArrowUp");
check(task.value === "second message" && ev.defaultPrevented, "ArrowUp from the first line browses history");
// ...and ArrowDown mirrors it: a mid-text caret goes down a line, not down the
// history, even while a browsing session is open
task.value = "line one\nline two";
task.selectionStart = task.selectionEnd = 5;
ev = key("ArrowDown");
check(task.value === "line one\nline two" && !ev.defaultPrevented, "ArrowDown mid-text is never history");
task.selectionStart = task.selectionEnd = task.value.length; // the LAST line
ev = key("ArrowDown");
check(task.value === "line one\nline two" && ev.defaultPrevented,
      "ArrowDown from the last line walks past the newest message back to the draft");
task.selectionStart = 0;
task.selectionEnd = 4; // a selection is not an edge
ev = key("ArrowUp");
check(!ev.defaultPrevented, "a selection makes ArrowUp caret movement, not history");
ctx.fillTaskInput(""); // leave the box empty for the next section

// ---- 4) fillTaskInput: the roll-back's own entry point ----
type("something else entirely");
ctx.fillTaskInput("rolled back message");
check(task.value === "rolled back message", "fillTaskInput writes the message into the box");
check(task.focused, "fillTaskInput focuses the box so the user can edit it");
check(caret() === task.value.length + "-" + task.value.length, "the caret lands at the end of the filled text");
ev = ctrlZ();
check(ev.defaultPrevented && task.value === "something else entirely",
      "Ctrl+Z takes the box back to what the user was composing before the fill");

// ---- 5) the source's own facts: the constants and the listener wiring ----
const src = fs.readFileSync(path.join(__dirname, "..", "ui", "js", "task-input.js"), "utf8");
check(/TASK_UNDO_BURST_MS\s*=\s*\d{2,4}/.test(src), "the burst window is a real interval, not 0");
check(/addEventListener\("keydown"/.test(src), "the box's keydown listener is wired by this file");
check(!/addEventListener\("change"/.test(src), "nothing here depends on a `change` event (textareas do not fire one per edit)");

summary("task-input");
