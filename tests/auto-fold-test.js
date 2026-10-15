"use strict";

// The finished task's fold (ui/js/auto-fold.js): when a run ends, everything
// between the task that opened it and the answer it ended on must leave the
// transcript, behind one row that says how much of it there is — and the reader
// must be able to open it again.
//
// This runner loads the REAL file against a DOM stub and drives it over the
// shapes a transcript really takes, because the two ways to get it wrong are
// structural: folding the turn's own task row (the message the reader is
// looking for), and anchoring on the WRONG user row — a run emits user_message
// events of its own (the max-tokens / empty-response notices), so "the newest
// user row" is a notice, and the turn it belongs to would never fold at all.
//
// Run: node tests/auto-fold-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary } = require("./harness.js");

// ---- a DOM stub with the three things this file touches: classes, children,
// moves (insertBefore/appendChild, fragments included) and the click handler ----
function makeNode(tag) {
  const classes = new Set();
  const n = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    attrs: {},
    textContent: "",
    parent: null,
    _fragment: false,
  };
  Object.defineProperty(n, "className", {
    get: () => [...classes].join(" "),
    set: (v) => {
      classes.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
    },
  });
  n.classList = {
    add: (...cs) => cs.forEach((c) => classes.add(c)),
    remove: (...cs) => cs.forEach((c) => classes.delete(c)),
    contains: (c) => classes.has(c),
  };
  n.matches = (sel) => sel.split(".").filter(Boolean).every((c) => classes.has(c));
  n.setAttribute = (k, v) => {
    n.attrs[k] = String(v);
  };
  n.getAttribute = (k) => (k in n.attrs ? n.attrs[k] : null);
  // a move, not a copy: the real DOM takes the node out of its old parent, and
  // the whole point of this file is where the rows END UP
  n._detach = (ch) => {
    if (ch && ch.parent) {
      const i = ch.parent.children.indexOf(ch);
      if (i >= 0) ch.parent.children.splice(i, 1);
      ch.parent = null;
    }
  };
  n.appendChild = (ch) => {
    if (ch && ch._fragment) {
      for (const c of [...ch.children]) n.appendChild(c);
      ch.children.length = 0;
      return n;
    }
    n._detach(ch);
    ch.parent = n;
    n.children.push(ch);
    return ch;
  };
  n.insertBefore = (child, ref) => {
    n._detach(child);
    const i = ref === null || ref === undefined ? n.children.length : n.children.indexOf(ref);
    if (i < 0) throw new Error("insertBefore: the reference node is not a child here");
    child.parent = n;
    n.children.splice(i, 0, child);
    return child;
  };
  return n;
}

function row(cls, text) {
  const n = makeNode("div");
  n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function pane(rows) {
  const el = makeNode("div");
  el.className = "events";
  for (const r of rows) el.appendChild(r);
  return el;
}

// ---- the real file, against the stub ----
let collapseCalls = 0;
let toggleCalls = 0;
const streamNode = makeNode("div");
streamNode.classList.add("loading"); // the page starts on the project-open path

const ctx = {
  console,
  pageSink: null,
  eventsEl: null,
  stream: streamNode,
  document: {
    createElement: (t) => makeNode(t),
    createDocumentFragment: () => {
      const f = makeNode("#fragment");
      f._fragment = true;
      return f;
    },
  },
  // the real helpers (js/stream-text.js), reduced to the state a test can see:
  // an animated collapse lands as "no .open, .hidden set" the moment it finishes
  foldCollapse: (fold) => {
    collapseCalls++;
    fold.classList.remove("open");
    fold.classList.add("hidden");
  },
  toggleFold: (fold) => {
    toggleCalls++;
    const wasHidden = fold.classList.contains("hidden");
    if (wasHidden) {
      fold.classList.remove("hidden");
      fold.classList.add("open");
    } else {
      fold.classList.remove("open");
      fold.classList.add("hidden");
    }
    return wasHidden;
  },
  reducedMotion: () => false,
};
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "ui", "js", "auto-fold.js"), "utf8"),
  ctx
);

const foldOf = (p) => p.children.find((c) => c.matches(".turn-fold"));
const setLoading = (on) => (on ? streamNode.classList.add("loading") : streamNode.classList.remove("loading"));

// ---- 1) a live, finished turn ----
streamNode.classList.remove("loading");
const user = row("event user", "fix the failing test");
const tool = row("event tool_group", "read_file …");
const think = row("event thinking", "the test reads the fixture …");
const answer = row("event text", "Fixed: the fixture path was wrong.");
const divider = row("completion", "completed");
let p = pane([user, tool, think, answer, divider]);
ctx.eventsEl = p;
collapseCalls = 0;

ctx.autoFoldTurn();

check(p.children.length === 4 && p.children[0] === user && p.children[2] === answer && p.children[3] === divider,
      "the task row, the closing answer and the completion divider stay in the pane");
const wrap = foldOf(p);
check(wrap !== undefined && p.children[1] === wrap, "the fold takes the place of the rows it hides");
const head = wrap.children[0], fold = wrap.children[1], inner = fold.children[0];
check(head.tagName === "BUTTON" && head.className === "turn-fold-head", "the fold's head is a real button");
check(inner.className === "fold-inner" && inner.children.length === 2 &&
      inner.children[0] === tool && inner.children[1] === think,
      "the middle moved into the fold, in order, and the task row did not");
check(head.children[0].textContent === "▸" && head.children[1].textContent === "process · 2 steps",
      "the head counts what it hides (" + JSON.stringify(head.children[1].textContent) + ")");
check(head.attrs["aria-expanded"] === "false", "a collapsed fold says so to assistive tech");
check(fold.classList.contains("hidden") && !fold.classList.contains("open"), "the fold ends up closed");
check(collapseCalls === 1, "a live turn animates its close (foldCollapse called once)");
check(user.dataset.turnFolded === "1", "the turn is marked folded on its own task row");

head.onclick();
check(toggleCalls === 1 && head.attrs["aria-expanded"] === "true" && head.children[0].textContent === "▸",
      "clicking the head re-opens the process, and the caret says so by turning: one glyph, " +
      "the state on the head's aria-expanded");
head.onclick();
check(head.attrs["aria-expanded"] === "false" && head.children[0].textContent === "▸",
      "and clicking again closes it, with the same glyph going back");

// ---- 2) a second `final` for the same turn must not fold the fold ----
const before = p.children.slice();
ctx.autoFoldTurn();
check(p.children.length === before.length && p.children.every((c, i) => c === before[i]),
      "the same turn is never folded twice (a replayed final)");

// ---- 3) a replayed project open collapses without animating ----
const ru = row("event user", "old task");
const rt = row("event tool_result", "…");
const ra = row("event text", "old answer");
const rd = row("completion", "completed");
p = pane([ru, rt, ra, rd]);
ctx.eventsEl = p;
streamNode.classList.add("loading");
collapseCalls = 0;
ctx.autoFoldTurn();
const rfold = foldOf(p).children[1];
check(collapseCalls === 0 && rfold.classList.contains("hidden") && !rfold.classList.contains("open"),
      "a replayed turn lands closed at once: no animation per turn of history");

// ---- 4) task -> answer: there is no middle to hide ----
const u4 = row("event user", "why does it fail?");
const a4 = row("event text", "because of the fixture");
const d4 = row("completion", "completed");
p = pane([u4, a4, d4]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
check(p.children.length === 3 && foldOf(p) === undefined, "a turn with no process leaves the pane alone");

// ---- 5) a failed run: no closing prose, so the whole region folds and the
// reason under the divider stays where the reader can see it ----
const u5 = row("event user", "run it");
const t5 = row("event tool_group", "bash …");
const d5 = row("completion", "error");
const n5 = row("completion-note", "run failed: connection reset");
p = pane([u5, t5, d5, n5]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
check(p.children.length === 4 && p.children[0] === u5 && p.children[2] === d5 && p.children[3] === n5 &&
      foldOf(p).children[1].children[0].children[0] === t5,
      "with no answer the whole region folds; the divider and its reason stay visible");

// ---- 6) the regression: a user row the RUN emitted is not the turn's task ----
// The realistic transcript: the previous turn's divider is still in the pane
// above this turn, so "the region" is what separates the two.
const prev = row("completion", "completed");
const u6 = row("event user", "the real task");
const t6 = row("event tool_group", "read_file …");
const notice = row("event user", "response truncated: continuing");
const a6 = row("event text", "done");
const d6 = row("completion", "completed");
p = pane([prev, u6, t6, notice, a6, d6]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
const w6 = foldOf(p);
check(w6 !== undefined && w6.children[1].children[0].children[0] === t6,
      "the turn's task is the FIRST user row of the turn, not the newest");
check(w6 !== undefined && w6.children[1].children[0].children[1] === notice &&
      u6.parent === p && p.children.indexOf(u6) === 1,
      "the run's own notice folds into the middle; the turn's task row does not");
check(u6.dataset.turnFolded === "1" && notice.dataset.turnFolded === undefined,
      "the fold is marked on the task row, never on a notice");
check(p.children[0] === prev && p.children[3] === a6 && p.children[4] === d6,
      "the previous turn's divider and this turn's answer stay where they were");

// ---- 7) the two paths that must be left alone ----
const u7 = row("event user", "paged");
const t7 = row("event tool_group", "x");
const d7 = row("completion", "completed");
p = pane([u7, t7, d7]);
ctx.eventsEl = p;
ctx.pageSink = pane([]);
ctx.autoFoldTurn();
check(p.children.length === 3 && foldOf(p) === undefined,
      "the off-DOM history sink is never folded (the pane is about to be handed its rows)");
ctx.pageSink = null;

p = pane([t7, row("completion", "completed")]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
check(p.children.length === 2 && foldOf(p) === undefined,
      "a window that opens mid-turn (no task row) folds nothing rather than guessing");

// ---- 8) the wiring the page has to carry ----
const uiDir = path.join(__dirname, "..", "ui");
const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
const events = fs.readFileSync(path.join(uiDir, "js", "stream-events.js"), "utf8");
const css = fs.readFileSync(path.join(uiDir, "style.css"), "utf8");
check(/<script src="js\/auto-fold\.js"><\/script>/.test(html), "the page loads auto-fold.js");
check(/appendCompletion\(ev\.status, ev\.summary\);[\s\S]{0,400}autoFoldTurn\(\);/.test(events),
      "the run's final folds the turn it just closed (after the divider is placed)");
check(/\.turn-fold-head\s*{[^}]*padding:[^}]*22px/.test(css),
      "the fold's head sits in the stream's content column (.event's own 22px)");
check(/\.turn-fold-head\s*{[^}]*cursor:\s*pointer/.test(css), "the head reads as clickable");
check(/\.turn-fold-head\s*\{\s*animation:\s*fadeIn var\(--move\)\s*;/.test(css),
      "the head — inserted in the frame the middle collapses — fades in like the divider " +
      "beside it, on --move and with no curve, rather than painting");
check(/\.turn-fold \.fold:not\(\.open\) \.fold-inner > \* \{\s*animation: none/.test(css),
      "the rows moved into the fold do not replay their arrival animation in a fold that is " +
      "not open — and only there: opening it is when they arrive");
check(/\[aria-expanded="true"\] \.turn-fold-caret\s*\{[^}]*transform:\s*rotate\(90deg\)/.test(css),
      "the caret is turned by the head's own aria-expanded, not by a second glyph");
check(/\.turn-fold-caret\s*\{[^}]*transition:\s*transform var\(--move\)/.test(css),
      "the caret's turn runs at the fold's own --move, not on the CSS default");

summary("auto-fold");
