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
    nodeType: 1,
    _fragment: false,
  };
  // the real DOM names the parent link parentNode; the stub keeps it in `parent`
  Object.defineProperty(n, "parentNode", { get: () => n.parent });
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
let scrollCalls = 0;
const streamNode = makeNode("div");
streamNode.classList.add("loading"); // the page starts on the project-open path

const ctx = {
  console,
  pageSink: null,
  paging: false, // the pager's flag (js/project.js loadOlder); false: nobody is paging
  busy: false, // the view's own "a run is in flight" (js/stream-view.js setStatus)
  catchUp: false, // a reconnect replaying the log over the pane (js/stream-view.js)
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
  // a live row moving into the block re-pins a latched view (js/stream-view.js
  // autoScroll). The stub has no scroll box; the count is what a test can see.
  autoScroll: () => {
    scrollCalls++;
  },
  // the pinned head's repaint (js/stream-text.js paintStuck): a rAF, and this stub
  // has no frames
  queueStuck: () => {},
};
vm.createContext(ctx);
const selfSrc = fs.readFileSync(path.join(__dirname, "..", "ui", "js", "auto-fold.js"), "utf8");
vm.runInContext(selfSrc, ctx);

const foldOf = (p) => p.children.find((c) => c.matches(".turn-fold"));
// the rows inside a fold: wrapper → fold → .fold-inner (the clip) → .fold-body (the
// element the close slides) → the rows
const bodyOf = (w) => w.children[1].children[0].children[0];
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
const body = inner.children[0];
check(head.tagName === "BUTTON" && head.className === "turn-fold-head", "the fold's head is a real button");
check(inner.className === "fold-inner" && body.className === "fold-body" &&
      body.children.length === 2 && body.children[0] === tool && body.children[1] === think,
      "the middle moved into the fold, in order, and the task row did not — one level deeper "
      + "than the clipping inner, in the .fold-body the close slides");
check(head.children[0].textContent === "▶" && head.children[1].textContent === "process · 2 steps",
      "the head counts what it hides (" + JSON.stringify(head.children[1].textContent) + ")");
check(head.attrs["aria-expanded"] === "false", "a collapsed fold says so to assistive tech");
check(fold.classList.contains("hidden") && !fold.classList.contains("open"), "the fold ends up closed");
check(collapseCalls === 1, "a live turn animates its close (foldCollapse called once)");
check(user.dataset.turnFolded === "1", "the turn is marked folded on its own task row");

head.onclick();
check(toggleCalls === 1 && head.attrs["aria-expanded"] === "true" && head.children[0].textContent === "▶",
      "clicking the head re-opens the process, and the caret says so by turning: one glyph, " +
      "the state on the head's aria-expanded");
head.onclick();
check(head.attrs["aria-expanded"] === "false" && head.children[0].textContent === "▶",
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
      bodyOf(foldOf(p)).children[0] === t5,
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
check(w6 !== undefined && bodyOf(w6).children[0] === t6,
      "the turn's task is the FIRST user row of the turn, not the newest");
check(w6 !== undefined && bodyOf(w6).children[1] === notice &&
      u6.parent === p && p.children.indexOf(u6) === 1,
      "the run's own notice folds into the middle; the turn's task row does not");
check(u6.dataset.turnFolded === "1" && notice.dataset.turnFolded === undefined,
      "the fold is marked on the task row, never on a notice");
check(p.children[0] === prev && p.children[3] === a6 && p.children[4] === d6,
      "the previous turn's divider and this turn's answer stay where they were");

// ---- 7) the off-DOM history sink: still left alone ----
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

// ---- 7b) the window's own first region, with nothing to hide ----
p = pane([t7, row("completion", "completed")]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
check(p.children.length === 2 && foldOf(p) === undefined,
      "the pane's first region with nothing between its head row and the divider leaves the pane alone");

// ---- 7c) the window's own first region, on a real turn: a compaction fired
// mid-run, so cpr_start cut the turn's task row off the top of the pane and it is
// above the window for good. The region is still a turn — the head is the row the
// pane starts on (here the compaction notice that explains why the window begins
// there), and the middle under it folds like any other. Before this, the top of
// every reopened project stayed unfolded beside a `completed` divider while the
// turn below it, task row intact, folded — the reported asymmetry. ----
const compaction7 = row("event compaction", "context compressed");
const t7c = row("event tool_group", "read_file …");
const a7c = row("event text", "old answer");
const d7c = row("completion", "completed");
p = pane([compaction7, t7c, a7c, d7c]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
const w7c = foldOf(p);
check(w7c !== undefined && p.children.length === 4 && p.children[0] === compaction7 &&
      p.children[1] === w7c && p.children[2] === a7c && p.children[3] === d7c,
      "the pane's first region folds without its task row: the head stays where the pane started, " +
      "the answer and the divider stay under the fold");
check(w7c !== undefined && bodyOf(w7c).children.length === 1 &&
      bodyOf(w7c).children[0] === t7c,
      "and the middle under that head is what moved in");
check(w7c !== undefined && w7c.children[0].children[1].textContent === "process · 1 step",
      "the head counts the middle it hides");
check(compaction7.dataset.turnFolded === "1",
      "the fold is marked on the head row, so a second final for the same region cannot fold the fold");

// ---- 7d) a region that is NOT the pane's first, with no task row: the shape this
// file does not recognize, and it still refuses to guess. The relaxed anchor above
// is scoped to the pane's own first region and nothing else. ----
p = pane([row("completion", "completed"), t7, row("completion", "completed")]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
check(p.children.length === 3 && foldOf(p) === undefined,
      "a region in the middle of the transcript with no task row is left alone");

// ---- 7e) the prepended history page: what the sink was not allowed to fold is
// folded on the pane, in one pass, and it lands closed instead of animating. The
// pager measures the fold it just made to re-anchor the view (js/project.js
// loadOlder), so an animation still in flight would carry the rows out from under
// that measurement. ----
ctx.paging = true;
streamNode.classList.remove("loading"); // a project that is not replaying: only the pager is at work
collapseCalls = 0;
const pt = row("event user", "an older task");
const pm = row("event tool_group", "bash …");
const pa = row("event text", "older answer");
const pdv = row("completion", "completed");
const openTask = row("event user", "the turn still running");
const openMid = row("event tool_group", "grep …");
p = pane([pt, pm, pa, pdv, openTask, openMid]);
ctx.eventsEl = p;
ctx.foldClosedRegions(p);
const pf = foldOf(p);
check(p.children.length === 6 && p.children[0] === pt && p.children[1] === pf &&
      p.children[2] === pa && p.children[3] === pdv,
      "the page's finished turn folds in place: its task row, its answer and its divider stay, " +
      "and the fold takes the middle's place");
check(pf !== undefined && pf.children[1].classList.contains("hidden") &&
      !pf.children[1].classList.contains("open") && collapseCalls === 0,
      "a paged-in fold lands closed at once — no animation per turn of history, and none to " +
      "measure around either");
check(p.children[4] === openTask && p.children[5] === openMid,
      "the turn the page left open (no final) is not folded");
ctx.paging = false;
collapseCalls = 0;
const liveTask = row("event user", "back to a live run");
const liveMid = row("event tool_group", "bash …");
const liveAns = row("event text", "done");
const liveDiv = row("completion", "completed");
p = pane([liveTask, liveMid, liveAns, liveDiv]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
check(collapseCalls === 1 && foldOf(p) !== undefined,
      "with the pager finished and the pane not replaying, the same fold animates again: the " +
      "pager's own flag is what made the paged-in fold instant");

// ---- 7f) the page boundary, which is the whole reason this runs after the
// prepend: the window opened in the middle of a turn, so the page carries that
// turn's task row while the window carries its divider. Only once both halves are
// in the same parent is the region visible as one — and every closed region of the
// pane folds in the same pass, each on its own divider. The dividers are the ends
// and the fold never moves them, so they are what the pass holds on to. ----
const cut = row("event user", "the turn the window cut in half");
const cutMid = row("event tool_group", "read_file …");
const cutDiv = row("completion", "completed"); // this divider was in the window all along
const whole = row("event user", "a turn wholly inside the page");
const wholeMid = row("event tool_call", "bash …");
const wholeDiv = row("completion", "completed");
p = pane([cut, cutMid, cutDiv, whole, wholeMid, wholeDiv]);
ctx.eventsEl = p;
ctx.foldClosedRegions(p);
const folds6 = p.children.filter((c) => c.matches(".turn-fold"));
check(folds6.length === 2 && p.children[0] === cut && p.children[1] === folds6[0] &&
      p.children[2] === cutDiv,
      "the turn the window cut in half folds across the seam, hanging off the task row the page " +
      "just brought in");
check(folds6[0].children[1].children[0].children[0].children[0] === cutMid && p.children[3] === whole &&
      p.children[4] === folds6[1] && p.children[5] === wholeDiv,
      "and the turn wholly inside the page folds beside it, each on its own divider");
ctx.foldClosedRegions(p); // a second announce must be a no-op, not a fold of a fold
check(p.children.filter((c) => c.matches(".turn-fold")).length === 2 &&
      bodyOf(p.children[1]).children[0] === cutMid,
      "folding the pane again changes nothing: the rows are marked folded on their own head row");

// ---- 7g) the page that COMPLETES a folded turn. The window opened inside this
// turn, so it was folded under the row the window happened to start on — a
// compaction notice — and the page brings the turn's own task row. The region is one
// middle with one head: the fold takes those rows in and moves up under the task row,
// it is never folded again. Keyed on the HEAD (which this page just replaced) the
// next pass misses the fold and builds a second one AROUND it — the reported fold
// inside a fold, its inner head unclickable inside the closed outer one, its count
// counting a whole fold as one step. The divider, which no fold ever moves, is what
// "this region is folded" is recorded on now.
const noticeG = row("event compaction", "context compressed (the window starts here)");
const oldMid = row("event tool_group", "bash …");
const ansG = row("event text", "old answer");
const divG = row("completion", "completed");
p = pane([noticeG, oldMid, ansG, divG]);
ctx.eventsEl = p;
streamNode.classList.add("loading"); // a reopened project folds this region on replay
ctx.autoFoldTurn();
streamNode.classList.remove("loading");
check(foldOf(p) !== undefined && divG.dataset.turnFolded === "1",
      "the window's first region folds on open, and the region is marked on its divider");

const taskG = row("event user", "the turn the window cut in half");
const earlyG = row("event tool_result", "…read_file (the earlier half)");
const moreG = row("event tool_group", "grep …");
// the page, prepended in file order (each insert lands above the pane's first row)
p.insertBefore(moreG, p.children[0]);
p.insertBefore(earlyG, p.children[0]);
p.insertBefore(taskG, p.children[0]);
ctx.paging = true;
ctx.foldClosedRegions(p);
ctx.paging = false;
const gFolds = p.children.filter((c) => c.matches(".turn-fold"));
check(gFolds.length === 1 && p.children[0] === taskG && p.children[1] === gFolds[0],
      "the page completes the folded turn instead of folding it again: one fold, hanging off " +
      "the task row the page brought");
check(bodyOf(gFolds[0]).children.length === 4 &&
      bodyOf(gFolds[0]).children[0] === earlyG &&
      bodyOf(gFolds[0]).children[1] === moreG &&
      bodyOf(gFolds[0]).children[2] === noticeG &&
      bodyOf(gFolds[0]).children[3] === oldMid,
      "the rows above the fold are the same middle: they go in at its top, in file order, and " +
      "the notice the fold used to hang on is one of them now");
check(taskG.dataset.turnFolded === "1" && noticeG.dataset.turnFolded === undefined,
      "the mark moves with the head, so a third pass still finds this region folded");
check(gFolds[0].children[0].children[1].textContent === "process · 4 steps",
      "and the head counts the middle it hides now (" +
      JSON.stringify(gFolds[0].children[0].children[1].textContent) + ")");
check(p.children[2] === ansG && p.children[3] === divG && divG.dataset.turnFolded === "1",
      "the answer and the divider stay in plain sight, and the region stays folded");
const before7g = p.children.slice();
ctx.foldClosedRegions(p);
check(p.children.length === before7g.length && p.children.every((c, i) => c === before7g[i]),
      "announcing the same page twice changes nothing (its rows are inside the fold by now)");

// ---- 7h) a page that brings no task row at all (a turn larger than the server's
// alignment budget): the fold keeps its head and takes nothing in — and above all,
// the rows above it are still not a second fold.
const looseG = row("event tool_result", "…a middle of a middle");
const pH = pane([looseG, taskG, gFolds[0], ansG, divG]);
ctx.eventsEl = pH;
ctx.foldClosedRegions(pH);
check(pH.children.filter((c) => c.matches(".turn-fold")).length === 1 && pH.children[1] === taskG,
      "rows that arrive above the head leave the fold where it is, and never fold it");

// ---- 9) the interrupted turn: the report. A session released mid-run writes its
// own ending — `error` — and nothing after it is a new task: the user's next
// message carries the SAME turn on. So the fold the interruption makes is left
// OPEN, and the ending the turn finally lands on joins it: one block, hanging off
// the instruction the turn started with and sitting directly above the answer,
// with the message that continued it inside rather than anchoring a second block.
//
// 9a) the interruption folds, and says it is unfinished
const p9 = row("completion", "completed"); // the turn before this one
const t9 = row("event user", "fix the failing test");
const w9 = row("event tool_group", "read_file …");
const e9 = row("completion", "error");
const n9 = row("completion-note", "the session running this task went away while it was in flight — nothing is running now");
p = pane([p9, t9, w9, e9, n9]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
const f9 = foldOf(p);
check(f9 !== undefined && p.children.length === 5 && p.children[1] === t9 &&
      p.children[2] === f9 && p.children[3] === e9 && p.children[4] === n9,
      "a run lost mid-flight folds what it drew, under the instruction that started it; the " +
      "divider it stopped on and its reason stay in plain sight");
check(f9 !== undefined && f9.dataset.turnOpen === "1",
      "the fold is marked OPEN: the turn it belongs to has no answer yet");

// 9b) the user carries the turn on
const u9 = row("event user", "carry on, the fixture path is wrong");
const w9b = row("event tool_group", "grep …");
const a9 = row("event text", "Fixed: the fixture path was wrong.");
const d9 = row("completion", "completed");
for (const el of [u9, w9b, a9, d9]) p.appendChild(el);
ctx.autoFoldTurn();
const f9b = foldOf(p);
const folds9 = p.children.filter((c) => c.matches(".turn-fold"));
check(folds9.length === 1 && f9b === f9,
      "the message that carries the turn on starts no turn of its own: the pane still has ONE fold");
check(p.children.length === 5 && p.children[0] === p9 && p.children[1] === t9 &&
      p.children[2] === f9 && p.children[3] === a9 && p.children[4] === d9,
      "…and that fold now starts at the ORIGINAL instruction and ends directly above the " +
      "answer, which the completed divider follows");
check(bodyOf(f9).children.length === 5 &&
      bodyOf(f9).children[0] === w9 &&
      bodyOf(f9).children[1] === e9 &&
      bodyOf(f9).children[2] === n9 &&
      bodyOf(f9).children[3] === u9 &&
      bodyOf(f9).children[4] === w9b,
      "the ending it stopped on, the message that continued it and the steps either drew are " +
      "all the same middle now, in file order");
check(u9.parent !== p && t9.dataset.turnFolded === "1" && u9.dataset.turnFolded === undefined,
      "the continuation row is inside the fold; the fold is still marked on the original " +
      "instruction, never on the row that continued it");
check(f9 !== undefined && f9.dataset.turnOpen === undefined && d9.dataset.turnFolded === "1",
      "the answered turn FINISHES the fold and marks its divider, so it can be neither " +
      "merged again nor folded twice");
check(f9 !== undefined && f9.children[0].children[1].textContent === "process · 5 steps",
      "the head counts everything it hides now (" +
      JSON.stringify(f9.children[0].children[1].textContent) + ")");

const shape9 = p.children.slice();
const body9 = bodyOf(f9).children.slice();
ctx.autoFoldTurn();
check(p.children.length === shape9.length && p.children.every((c, i) => c === shape9[i]) &&
      bodyOf(f9).children.length === body9.length &&
      bodyOf(f9).children.every((c, i) => c === body9[i]),
      "a replayed final for the finished turn changes nothing");

// 9c) a replay of the same records lands on the same shape, closed
const rp = pane([]);
ctx.eventsEl = rp;
streamNode.classList.add("loading");
const rT = row("event user", "fix the failing test");
const rW = row("event tool_group", "read_file …");
const rE = row("completion", "error");
const rN = row("completion-note", "…");
for (const el of [rT, rW, rE, rN]) rp.appendChild(el);
ctx.autoFoldTurn(); // the error final, folded the way a reopened project folds it
const rU = row("event user", "carry on, the fixture path is wrong");
const rWb = row("event tool_group", "grep …");
const rA = row("event text", "Fixed: the fixture path was wrong.");
const rD = row("completion", "completed");
for (const el of [rU, rWb, rA, rD]) rp.appendChild(el);
ctx.autoFoldTurn();
streamNode.classList.remove("loading");
const rf9 = foldOf(rp);
check(rp.children.length === 4 && rp.children[0] === rT && rp.children[1] === rf9 &&
      rp.children[2] === rA && rp.children[3] === rD &&
      bodyOf(rf9).children.length === 5 && bodyOf(rf9).children[1] === rE &&
      bodyOf(rf9).children[3] === rU,
      "a reopened project replays the same records into the same one fold — the turn is not " +
      "split at the release ending just because the window that saw it was closed");

// 9d) the user's own Stop is NOT an interruption: what they stopped is over, and
// the next message is a new task with a fold of its own
const t9d = row("event user", "stop that");
const w9d = row("event tool_group", "bash …");
const x9d = row("completion", "aborted");
p = pane([t9d, w9d, x9d]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
const f9d = foldOf(p);
check(f9d !== undefined && f9d.dataset.turnOpen === undefined,
      "an aborted turn folds and is FINISHED: the user ended it themselves");
const u9d = row("event user", "something else entirely");
const w9d2 = row("event tool_group", "read_file …");
const a9d = row("event text", "here you go");
const d9d = row("completion", "completed");
for (const el of [u9d, w9d2, a9d, d9d]) p.appendChild(el);
ctx.autoFoldTurn();
const folds9d = p.children.filter((c) => c.matches(".turn-fold"));
check(folds9d.length === 2 && p.children[0] === t9d && p.children[1] === f9d &&
      p.children[2] === x9d && p.children[3] === u9d && p.children[4] === folds9d[1] &&
      p.children[5] === a9d && p.children[6] === d9d,
      "the message after an aborted turn opens a NEW turn: two folds, the second hanging off " +
      "the new task, and nothing merged across the Stop");

// 9e) the session is gone and nothing has answered yet: the fold is made on the
// spot (js/backend-lifecycle.js announces it), and no ending is invented for it
const t9e = row("event user", "run the suite");
const w9e = row("event tool_group", "bash …");
const th9e = row("event thinking", "the suite needs a database …");
const part9e = row("event text", "Running the suite: 41 pa");
p = pane([t9e, w9e, th9e, part9e]);
ctx.eventsEl = p;
ctx.foldOpenTurn();
const f9e = foldOf(p);
check(f9e !== undefined && p.children.length === 3 && p.children[0] === t9e &&
      p.children[1] === f9e && p.children[2] === part9e,
      "the turn in flight folds where the session went away, and the prose it had reached " +
      "stays in plain sight — the reader is not left with the whole disconnected stretch open");
check(f9e !== undefined && f9e.dataset.turnOpen === "1" &&
      p.children.filter((c) => c.matches(".completion")).length === 0,
      "the fold is open and NO ending is invented: the departing session writes that record " +
      "and this window folds it in when it arrives (or never, if no session answers again)");
ctx.foldOpenTurn(); // a second detector for the same outage
check(p.children.length === 3 && foldOf(p) === f9e,
      "announcing the loss twice does not fold the fold");

const u9e = row("event user", "try again");
const w9e2 = row("event tool_group", "bash …");
const a9e = row("event text", "Suite green: 41 passed.");
const d9e = row("completion", "completed");
for (const el of [u9e, w9e2, a9e, d9e]) p.appendChild(el);
ctx.autoFoldTurn();
const f9e2 = foldOf(p);
const folds9e = p.children.filter((c) => c.matches(".turn-fold"));
check(f9e2 === f9e && folds9e.length === 2 && p.children.length === 6 &&
      p.children[0] === t9e && p.children[1] === f9e && p.children[2] === part9e &&
      p.children[3] === folds9e[1] && p.children[4] === a9e && p.children[5] === d9e,
      "the turn that finally completes keeps the SAME fold, and what the run drew after the prose " +
      "it stopped on folds into a block of its own — the prose splits the turn, so the block above " +
      "it stays where it was and the answer is still the row under the last block");
check(f9e2 !== undefined && bodyOf(f9e).children.length === 2 &&
      bodyOf(f9e).children[0] === w9e &&
      bodyOf(f9e).children[1] === th9e,
      "and the prose itself stays in plain sight: what it held is the rows the run drew BEFORE it, " +
      "in file order, and nothing is appended after the text it came after");
check(bodyOf(folds9e[1]).children.length === 2 &&
      bodyOf(folds9e[1]).children[0] === u9e &&
      bodyOf(folds9e[1]).children[1] === w9e2 &&
      folds9e[1].children[0].children[1].textContent === "process · 2 steps",
      "…the message that carried the turn on and the step it drew fold together under that prose, " +
      "counting themselves, directly above the answer");

// 9f) interrupted again while the turn is being carried on: still one fold, still
// open, and the ending that stopped it stays visible until an answer replaces it
const t9f = row("event user", "one more time");
const w9f = row("event tool_group", "bash …");
const x9f = row("completion", "error");
const n9f = row("completion-note", "run failed: connection reset");
p = pane([t9f, w9f, x9f, n9f]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
const f9f = foldOf(p);
const u9f = row("event user", "…and again");
const w9f2 = row("event tool_group", "bash …");
const x9f2 = row("completion", "error");
const n9f2 = row("completion-note", "run failed: connection reset");
for (const el of [u9f, w9f2, x9f2, n9f2]) p.appendChild(el);
ctx.autoFoldTurn();
check(p.children.filter((c) => c.matches(".turn-fold")).length === 1 && foldOf(p) === f9f &&
      p.children[2] === x9f2 && p.children[3] === n9f2 &&
      bodyOf(f9f).children.length === 5 &&
      bodyOf(f9f).children[1] === x9f &&
      bodyOf(f9f).children[2] === n9f &&
      bodyOf(f9f).children[4] === w9f2,
      "a second interruption is the same turn: the fold takes in the first ending, the message " +
      "that carried it on and the steps above the second, and stays open on the ending that " +
      "stopped it — which the reader can still see");
const a9f = row("event text", "done, finally");
const d9f = row("completion", "completed");
for (const el of [a9f, d9f]) p.appendChild(el);
ctx.autoFoldTurn();
check(foldOf(p) === f9f && p.children[2] === a9f && p.children[3] === d9f &&
      f9f.dataset.turnOpen === undefined,
      "and the answer that eventually lands closes it: one turn, one fold, whatever it took");

// 9g) an interrupted stretch with nothing in it: the instruction, the ending, and
// the message that carried the turn on. There is no fold to grow, so the fold is
// made from the original instruction — never from the continuation row
const t9g = row("event user", "the task");
const x9g = row("completion", "error");
const n9g = row("completion-note", "the session … went away");
const u9g = row("event user", "carry on");
const w9g = row("event tool_group", "bash …");
const a9g = row("event text", "done");
const d9g = row("completion", "completed");
p = pane([t9g, x9g, n9g, u9g, w9g, a9g, d9g]);
ctx.eventsEl = p;
ctx.autoFoldTurn();
const f9g = foldOf(p);
check(p.children.length === 4 && p.children[0] === t9g && p.children[1] === f9g &&
      p.children[2] === a9g && p.children[3] === d9g &&
      p.children.filter((c) => c.matches(".turn-fold")).length === 1,
      "the fold is anchored on the instruction even when the interrupted stretch held nothing: " +
      "the continuation row cannot be what a block hangs off");
check(f9g !== undefined && bodyOf(f9g).children.length === 4 &&
      bodyOf(f9g).children[0] === x9g &&
      bodyOf(f9g).children[1] === n9g &&
      bodyOf(f9g).children[2] === u9g &&
      bodyOf(f9g).children[3] === w9g,
      "and the old ending, its reason, the continuation and its step are the middle it took in");

// 9h) a page of history whose own stretch was interrupted, above a live turn that
// is then interrupted too: the pane never holds two open blocks. The drop joins
// the block the page left open — the same turn, seen in two halves — instead of
// hanging a second one off the continuation
const t9h = row("event user", "an old task");
const w9h = row("event tool_group", "bash …");
const x9h = row("completion", "error");
const n9h = row("completion-note", "the session … went away");
const t9h2 = row("event user", "the task that died");
const w9h2 = row("event tool_group", "bash …");
p = pane([t9h, w9h, x9h, n9h, t9h2, w9h2]);
ctx.eventsEl = p;
ctx.autoFoldTurn(); // the paged-in ending folds its stretch, and leaves it open
const f9h = foldOf(p);
ctx.foldOpenTurn(); // ...and then the live turn's session goes away too
const folds9h = () => p.children.filter((c) => c.matches(".turn-fold"));
check(folds9h().length === 1 && folds9h()[0] === f9h && f9h.dataset.turnOpen === "1",
      "two interrupted stretches in one pane are ONE open block, not two: an open block is " +
      "always the newest, because every ending reaches back through the interruptions above it");
const u9h = row("event user", "carry on");
const w9h3 = row("event tool_group", "bash …");
const a9h = row("event text", "done");
const d9h = row("completion", "completed");
for (const el of [u9h, w9h3, a9h, d9h]) p.appendChild(el);
ctx.autoFoldTurn();
check(folds9h().length === 1 && folds9h()[0] === f9h && f9h.dataset.turnOpen === undefined &&
      p.children[p.children.length - 2] === a9h && p.children[p.children.length - 1] === d9h,
      "and the answer that closes the turn closes that one block, directly above itself");

// ---- 10) the turn still running: foldable WHILE it runs, and the ring that says
// so on a block the reader folded ----
// The block is made by the run's first process row, and the rows go into it as they
// arrive. Prose and the reader's own message stay in the pane, in the order they
// were written: the ending's merge (mergeOpenFold) appends what stood outside the
// block in file order, so a step put in front of the text it came after could never
// be put back where it was.
ctx.busy = true;
const u10 = row("event user", "run the suite");
const t10 = row("event tool_group", "bash … pytest");
p = pane([u10]);
ctx.eventsEl = p;
p.appendChild(t10);
ctx.foldLiveRow(t10);
const live10 = foldOf(p);
check(p.children.length === 2 && p.children[0] === u10 && p.children[1] === live10 &&
      bodyOf(live10).children.length === 1 && bodyOf(live10).children[0] === t10,
      "a run in flight folds as it draws: the block is made by its first process row and that row "
      + "goes in, so the reader can put the process away in the middle of a task, not only at its end");
check(live10.dataset.turnLive === "1" && live10.dataset.turnOpen === "1" &&
      live10.children[1].classList.contains("hidden") &&
      !live10.children[1].classList.contains("open") &&
      live10.children[0].attrs["aria-expanded"] === "false" &&
      live10.attrs["aria-busy"] === "true",
      "it lands FOLDED and marked: a run's steps are process, and putting that middle out of the way "
      + "BY DEFAULT while it streams is the whole point of folding a long task on a phone — the head "
      + "says how many steps are in there, the ring says more are coming, one press opens it. "
      + "`turnOpen` is still what the ending's merge looks for — unmarked, the rest of the turn would "
      + "fold into a SECOND block above the message that carried it on");
check(live10.children[0].children.length === 3 &&
      live10.children[0].children[2].className === "turn-fold-spin" &&
      live10.children[0].children[2].attrs["aria-hidden"] === "true",
      "the head carries the mark of a run still filling it in — a span after the label, not a word "
      + "(ui/style.css draws it, and only on the closed state of a live block)");

const r10 = row("event tool_result", "12 passed");
p.appendChild(r10);
ctx.foldLiveRow(r10);
check(bodyOf(live10).children.length === 2 && bodyOf(live10).children[1] === r10 &&
      live10.children[0].children[1].textContent === "process · 2 steps",
      "every row the run draws after it joins the same block, in the order it was drawn, and the "
      + "head's count follows");
check(scrollCalls === 2,
      "each row that moved into the block re-pins the tail through autoScroll: the head took room "
      + "above it, and the append that drew the row scrolled before the head existed — a reader "
      + "watching the run would otherwise see the tail sit one head short of the edge until the "
      + "next row lands. It is the view's own latch (js/stream-view.js), so a reader who scrolled "
      + "up is not moved");

const x10 = row("event text", "the suite is green");
p.appendChild(x10);
ctx.foldLiveRow(x10);
check(p.children[p.children.length - 1] === x10 && bodyOf(live10).children.length === 2 &&
      live10.dataset.turnLive === undefined && live10.attrs["aria-busy"] === "false",
      "the run's prose is not process: it stays in the pane, under the block — and it SETTLES that " +
      "block exactly as the ending would, because the stretch of process it was counting is drawn " +
      "up to the run's own words: the ring stops");

const t10b = row("event tool_group", "read_file …");
p.appendChild(t10b);
ctx.foldLiveRow(t10b);
const seg10b = p.children[3];
check(p.children.length === 4 && p.children[0] === u10 && p.children[1] === live10 &&
      p.children[2] === x10 && p.children[3] === seg10b &&
      seg10b.matches(".turn-fold") && bodyOf(seg10b).children.length === 1 &&
      bodyOf(seg10b).children[0] === t10b &&
      seg10b.children[0].children[1].textContent === "process · 1 step" &&
      seg10b.dataset.turnOpen === "1" && live10.dataset.turnOpen === undefined,
      "and a step that follows the prose folds on its own: a second block, under the prose, holding " +
      "only the rows drawn after it — the segment is what a block is, so the rows on either side of " +
      "the run's own words never share one body (which is the only way both stay in file order)");

seg10b.children[0].onclick(); // the reader opens the live block
check(seg10b.children[0].attrs["aria-expanded"] === "true" &&
      seg10b.children[1].classList.contains("open") &&
      seg10b.dataset.turnLive === "1",
      "the reader can open it mid-run: one press on the head shows the process of a task that is " +
      "still working, and the block keeps saying the run is going");
seg10b.children[0].onclick(); // ...and fold it again, at will
check(seg10b.children[0].attrs["aria-expanded"] === "false" &&
      seg10b.children[1].classList.contains("hidden") &&
      seg10b.dataset.turnLive === "1",
      "and fold it again: the state is the reader's to set for as long as the run lasts, and a " +
      "block they closed keeps saying the run is going — the ring hangs off `data-turn-live` with " +
      "the closed `aria-expanded`, so no word has to say it");

const a10 = row("event text", "done: the fixture path was wrong");
p.appendChild(a10);
ctx.foldLiveRow(a10);
const d10 = row("completion", "completed");
p.appendChild(d10);
ctx.autoFoldTurn();
check(foldOf(p) === live10 && p.children.length === 6 &&
      p.children[0] === u10 && p.children[1] === live10 && p.children[2] === x10 &&
      p.children[3] === seg10b && p.children[4] === a10 && p.children[5] === d10,
      "the ending folds each stretch of process where it stands, under the prose that ends it: two " +
      "blocks and the prose between them, in the order the run drew them, directly above the answer");
check(bodyOf(live10).children.length === 2 && bodyOf(live10).children[0] === t10 &&
      bodyOf(live10).children[1] === r10 &&
      bodyOf(seg10b).children.length === 1 && bodyOf(seg10b).children[0] === t10b &&
      live10.dataset.turnLive === undefined && seg10b.dataset.turnLive === undefined &&
      live10.dataset.turnOpen === undefined && seg10b.dataset.turnOpen === undefined &&
      live10.attrs["aria-busy"] === "false" && seg10b.attrs["aria-busy"] === "false",
      "one body each, nothing moved across the prose, and every mark of a run in flight is gone " +
      "because it is over");

// 10b) a block nobody touched is closed where it landed, and the ending adds nothing
// to that state: it was folded while it was still filling in, so there is no move
// left to animate — the reader watched the head and the ring, not an open fold
ctx.busy = true;
const u10b = row("event user", "explain the failure");
const t10b2 = row("event tool_group", "read_file …");
p = pane([u10b]);
ctx.eventsEl = p;
p.appendChild(t10b2);
ctx.foldLiveRow(t10b2);
const live10b = foldOf(p);
const a10b = row("event text", "the fixture path");
const d10b = row("completion", "completed");
p.appendChild(a10b);
ctx.foldLiveRow(a10b);
p.appendChild(d10b);
ctx.busy = false;
collapseCalls = 0;
ctx.autoFoldTurn();
check(foldOf(p) === live10b && live10b.children[1].classList.contains("hidden") &&
      !live10b.children[1].classList.contains("open") &&
      live10b.children[0].attrs["aria-expanded"] === "false" &&
      live10b.children[0].children[1].textContent === "process · 1 step" &&
      collapseCalls === 0,
      "a block the reader never touched is still closed when the ending lands, and the ending does "
      + "not animate a fold that was never painted open — one block, saying what it counted, in the "
      + "same state the fold the ending would have made lands in");

// 10c) the states where rows still arrive but nothing is running: a block made in any
// of them would fold a transcript the reader is watching arrive from the log
ctx.busy = true;
setLoading(true);
const t10c = row("event tool_group", "x");
p = pane([t10c]);
ctx.eventsEl = p;
ctx.foldLiveRow(t10c);
check(foldOf(p) === undefined, "the project-open reconstruction is not folded as it renders");
setLoading(false);
ctx.catchUp = true;
const t10c2 = row("event tool_group", "y");
p = pane([t10c2]);
ctx.eventsEl = p;
ctx.foldLiveRow(t10c2);
check(foldOf(p) === undefined, "nor is a reconnect's catch-up block: those rows are history");
ctx.catchUp = false;
ctx.busy = false;
const t10c3 = row("event tool_group", "z");
p = pane([t10c3]);
ctx.eventsEl = p;
ctx.foldLiveRow(t10c3);
check(foldOf(p) === undefined && p.children[0] === t10c3,
      "and nothing folds when no run is in flight: a replayed transcript stays as the log wrote it");
// a straggler: the run's own `final` lands before the view's status does, so a row
// can still arrive with `busy` true behind a divider that really ended its turn
const d10c = row("completion", "completed");
const t10c4 = row("event tool_group", "late");
p = pane([row("event user", "a task"), d10c, t10c4]);
ctx.eventsEl = p;
ctx.foldLiveRow(t10c4);
check(foldOf(p) === undefined && p.children[2] === t10c4,
      "a row behind a divider that ENDED its turn folds over nothing: the turn is over, and a block "
      + "made there would hang off a divider the next ending has already closed");
ctx.busy = false;

// 10d) a turn a dropped session left with one open block: the run that carries the
// turn on adds to THAT block, and the reader's own next message is a hard boundary
ctx.busy = true;
const u10d = row("event user", "the task");
const t10d = row("event tool_group", "bash …");
p = pane([u10d, t10d]);
ctx.eventsEl = p;
ctx.foldLiveRow(t10d);
const live10d = foldOf(p);
ctx.busy = false;
ctx.clearRunLive(); // the session goes away mid-run (clutch:turn-interrupted)
check(live10d.dataset.turnLive === undefined && live10d.dataset.turnOpen === "1" &&
      live10d.attrs["aria-busy"] === "false",
      "a dropped session takes the ring with it and leaves the block where it is, still the turn's "
      + "own: no ending is coming to this window, and nothing is being filled in any more");
ctx.busy = true;
const w10d = row("event tool_group", "bash …");
p.appendChild(w10d);
ctx.foldLiveRow(w10d);
check(foldOf(p) === live10d && bodyOf(live10d).children.length === 2 &&
      bodyOf(live10d).children[1] === w10d,
      "the run that carries the turn on adds to the SAME block: an ending's merge would have done "
      + "no different, and a second block would end up one fold inside another");
const u10d2 = row("event user", "a different task");
const t10d2 = row("event tool_group", "read_file …");
p.appendChild(u10d2);
ctx.foldLiveRow(u10d2);
p.appendChild(t10d2);
ctx.foldLiveRow(t10d2);
check(foldOf(p) === live10d && p.children.length === 2 &&
      bodyOf(live10d).children.length === 4 &&
      bodyOf(live10d).children[2] === u10d2 && bodyOf(live10d).children[3] === t10d2 &&
      live10d.children[1].classList.contains("open") &&
      live10d.children[0].attrs["aria-expanded"] === "true" &&
      live10d.dataset.turnLive === "1",
      "the rows between the block and the new one are the SAME turn's middle, and they go in in file "
      + "order — the divider an interruption stopped on, its note, the message that carried the turn "
      + "on (absorbInto). At the ending mergeOpenFold appends exactly those, so a turn watched live "
      + "and the same turn replayed end in one shape; left outside, the body would receive them after "
      + "the steps that followed them. And one of them being the reader's OWN message opens the "
      + "block: what they just wrote is not hidden by this file's own initiative, and the head that "
      + "says where it went is right there to fold it again");

// 10g) the two shapes the report was about, both WHILE THE RUN IS STILL GOING: a task
// that starts in a pane which already holds a finished turn, and a run that carries an
// interrupted turn on. Both used to fold nothing until the ending landed — the stream
// had no head above it to press, which is the "there is no process button" report.
//
// A) a new task after a finished turn. Every turn but the pane's first has the
// previous turn's divider above its task row, and reading the NEAREST divider above an
// arriving row as "this row is a straggler" refused the fold for the whole run. Only a
// divider the row stands DIRECTLY under, with its own task above that, can say that.
ctx.busy = false;
const u10g = row("event user", "the first task");
const t10g = row("event tool_group", "bash …");
const a10g = row("event text", "done");
const d10g = row("completion", "completed");
p = pane([u10g, t10g, a10g, d10g]);
ctx.eventsEl = p;
ctx.autoFoldTurn(); // the turn before it: folded, and its divider left where it was
const done10g = foldOf(p);
ctx.busy = true;
const u10g2 = row("event user", "a second task");
const t10g2 = row("event tool_group", "bash … pytest");
p.appendChild(u10g2);
ctx.foldLiveRow(u10g2); // the task row is not process: it stays in the pane
p.appendChild(t10g2);
ctx.foldLiveRow(t10g2);
const folds10g = () => p.children.filter((c) => c.matches(".turn-fold"));
check(folds10g().length === 2 && folds10g()[0] === done10g &&
      p.children[p.children.length - 1] === folds10g()[1] &&
      p.children[p.children.length - 2] === u10g2 &&
      bodyOf(folds10g()[1]).children.length === 1 &&
      bodyOf(folds10g()[1]).children[0] === t10g2 &&
      folds10g()[1].dataset.turnLive === "1" &&
      folds10g()[1].children[1].classList.contains("hidden"),
      "a task that starts under a finished turn folds while it runs: the `completed` divider "
      + "above its task row is not the ending of THIS turn, so the run gets a head — folded, "
      + "counting one step, marked live — instead of a whole transcript that cannot be folded "
      + "until the answer lands");

// B) the run that carries an interrupted turn on. The divider the interruption stopped
// on stands between the block and the rows arriving now; a `.completion` used to be a
// hard boundary here, so those rows stayed in the pane until the ending merged them.
ctx.busy = true;
const u10h = row("event user", "the task that dies");
const t10h = row("event tool_group", "bash …");
p = pane([u10h, t10h]);
ctx.eventsEl = p;
ctx.foldLiveRow(t10h); // the run in flight, before the session goes away
const live10h = foldOf(p);
ctx.busy = false;
const x10h = row("completion", "error");
const n10h = row("completion-note", "the session … went away");
p.appendChild(x10h);
p.appendChild(n10h);
ctx.foldOpenTurn(); // clutch:turn-interrupted: the block keeps the turn, it is not locked
const t10h2 = row("event tool_group", "bash … again");
const r10h = row("event tool_result", "ok");
ctx.busy = true;
p.appendChild(t10h2);
ctx.foldLiveRow(t10h2);
p.appendChild(r10h);
ctx.foldLiveRow(r10h);
check(foldOf(p) === live10h && p.children.length === 2 &&
      bodyOf(live10h).children.length === 5 &&
      bodyOf(live10h).children[1] === x10h && bodyOf(live10h).children[2] === n10h &&
      bodyOf(live10h).children[3] === t10h2 && bodyOf(live10h).children[4] === r10h &&
      live10h.dataset.turnLive === "1" && live10h.dataset.turnOpen === "1",
      "and a continuation folds while it runs: the interruption's own divider and its note are the "
      + "same turn's middle, so they join the block in file order and the rows the run goes on to "
      + "draw land in it — the ending's merge does no different later, and no second block is made "
      + "above the continuation");

// 10e) the same turn drawn live and replayed: ONE shape at the end. The live block is
// not a new arrangement of the transcript, it is the ending's fold built early.
function liveRun(rows) {
  const paneEl = pane([rows[0]]);
  ctx.eventsEl = paneEl;
  ctx.busy = true;
  for (const r of rows.slice(1)) {
    paneEl.appendChild(r);
    if (!r.matches(".completion")) ctx.foldLiveRow(r);
  }
  ctx.busy = false;
  ctx.autoFoldTurn();
  return paneEl;
}
const replayRun = (rows) => {
  const paneEl = pane(rows);
  ctx.eventsEl = paneEl;
  ctx.busy = false;
  ctx.autoFoldTurn();
  return paneEl;
};
// what the reader ends up looking at: the pane's rows in order, and inside a block,
// the rows it holds in order
const shapeOf = (paneEl) => paneEl.children.map((c) => {
  if (!c.matches(".turn-fold")) return c.textContent || c.className;
  return "fold[" + bodyOf(c).children.map((x) => x.textContent || x.className).join(" / ") +
    "]=" + c.children[0].children[1].textContent;
}).join(" | ");
const records10 = () => [
  row("event user", "task"),
  row("event thinking", "where is the fixture …"),
  row("event tool_group", "bash …"),
  row("event text", "half way"),
  row("event tool_group", "read_file …"),
  row("event text", "done"),
  row("completion", "completed"),
];
check(shapeOf(liveRun(records10())) === shapeOf(replayRun(records10())),
      "a turn the reader watched stream and the same turn replayed from the log end in ONE shape — "
      + "same rows in the pane, same rows in the block, same order, same count (" +
      JSON.stringify(shapeOf(replayRun(records10()))) + ")");
// and that one shape is the turn's process cut at the prose the run spoke: the answer
// and the prose are rows of the pane, each stretch between them is a block
check(shapeOf(replayRun(records10())) ===
      "task | fold[where is the fixture … / bash …]=process · 2 steps | half way | " +
      "fold[read_file …]=process · 1 step | done | completed",
      "…and the shape is the prose's: a block for the process above it, a block for the process " +
      "below it, and the run's own words in between, in plain sight (" +
      JSON.stringify(shapeOf(replayRun(records10()))) + ")");
// The tail AFTER the last prose folds too: nothing says the turn is over until its
// ending does, and a run that keeps drawing steps after its last paragraph is the
// case the reader most wants folded while it works.
const tailAfterProse = () => [
  row("event user", "task"),
  row("event tool_group", "bash …"),
  row("event text", "half way"),
  row("event tool_group", "grep …"),
  row("event text", "done"),
  row("event tool_group", "git push …"),
  row("completion", "completed"),
];
check(shapeOf(liveRun(tailAfterProse())) === shapeOf(replayRun(tailAfterProse())) &&
      shapeOf(replayRun(tailAfterProse())) ===
      "task | fold[bash …]=process · 1 step | half way | fold[grep …]=process · 1 step | " +
      "done | fold[git push …]=process · 1 step | completed",
      "a step the run draws after it has spoken still folds, and each stretch keeps to its own " +
      "block: the prose above it is a boundary, not the end of the turn (" +
      JSON.stringify(shapeOf(replayRun(tailAfterProse()))) + ")");
// A reader's own message inside the turn (a turn carried on, a notice the run
// emitted) is not prose: it belongs to the segment, and the block it folds into opens
// — what the reader just wrote is not something this file hides on its own initiative.
const proseThenMessage = () => [
  row("event user", "task"),
  row("event tool_group", "bash …"),
  row("event text", "half way"),
  row("event user", "carry on"),
  row("event tool_group", "grep …"),
  row("event text", "done"),
  row("completion", "completed"),
];
check(shapeOf(liveRun(proseThenMessage())) === shapeOf(replayRun(proseThenMessage())) &&
      shapeOf(replayRun(proseThenMessage())) ===
      "task | fold[bash …]=process · 1 step | half way | " +
      "fold[carry on / grep …]=process · 2 steps | done | completed",
      "…and a user row the run drew is inside the segment, not a boundary: it folds with the steps " +
      "around it, under the prose the reader was reading (" +
      JSON.stringify(shapeOf(replayRun(proseThenMessage()))) + ")");
const interrupted10 = () => [
  row("event user", "task"),
  row("event tool_group", "bash …"),
  row("event thinking", "hmm"),
  row("completion", "error"),
  row("completion-note", "run failed: connection reset"),
];
check(shapeOf(liveRun(interrupted10())) === shapeOf(replayRun(interrupted10())),
      "and so does a turn that stopped without an answer — the rows the run drew stay in the block "
      + "and the reason it stopped stays under the divider");

// the turn the window watched DIE and then carry on, drawn live the way it happens: the
// block is made while the run is going, the session goes away (clutch:turn-interrupted,
// so the block is folded up to what arrived), and the run that continues the turn draws
// into it. The ending reaches back over the interruption (mergeOpenFold) either way, so
// both paths have to land on one shape.
const continuation10 = () => [
  row("event user", "task"),
  row("event tool_group", "bash …"),
  row("completion", "error"),
  row("completion-note", "the session … went away"),
  row("event user", "carry on"),
  row("event tool_group", "bash … again"),
  row("event text", "done"),
  row("completion", "completed"),
];
function liveContinuation() {
  const all = continuation10();
  const paneEl = pane([all[0]]);
  ctx.eventsEl = paneEl;
  ctx.busy = true;
  for (const r of all.slice(1, 4)) { // the rows of the run that died
    paneEl.appendChild(r);
    ctx.foldLiveRow(r);
  }
  ctx.busy = false;
  ctx.clearRunLive();
  ctx.foldOpenTurn();
  ctx.busy = true;
  for (const r of all.slice(4)) { // the message that carried it on, and the rest
    paneEl.appendChild(r);
    if (!r.matches(".completion")) ctx.foldLiveRow(r);
  }
  ctx.busy = false;
  ctx.autoFoldTurn();
  return paneEl;
}
check(shapeOf(liveContinuation()) === shapeOf(replayRun(continuation10())),
      "a turn the window watched die and carry on reads like the same turn replayed — one block off "
      + "the original instruction, holding the interruption, its reason, the message that carried it "
      + "on and every step either of them drew, in file order (" +
      JSON.stringify(shapeOf(replayRun(continuation10()))) + ")");

// 10f) the observer the page installs: the pane's own child list, elements only
let observed10 = null;
ctx.MutationObserver = function (cb) {
  this.observe = (target, opts) => { observed10 = { cb, target, opts }; };
};
ctx.busy = true;
const u10f = row("event user", "task");
const t10f = row("event tool_group", "bash …");
p = pane([u10f]);
ctx.eventsEl = p;
ctx.watchLiveRows();
check(observed10 && observed10.target === p && observed10.opts.childList === true &&
      !observed10.opts.subtree,
      "the pane's own child list is what is watched, not the whole subtree: a body or a tool group's "
      + "list filling in is not a row of the transcript");
p.appendChild(t10f);
const t10f2 = row("event tool_result", "…");
observed10.cb([
  { target: row("div"), addedNodes: [t10f] }, // a record from deeper in: not a pane row
  { target: p, addedNodes: [{ nodeType: 3 }] }, // a text node: has no class list to read
  { target: p, addedNodes: [t10f] },
]);
check(foldOf(p) !== undefined && bodyOf(foldOf(p)).children[0] === t10f,
      "a row the pane gains is folded as it arrives, and a record from anywhere else is ignored");
p.appendChild(t10f2);
observed10.cb([{ target: p, addedNodes: [t10f2] }]);
check(bodyOf(foldOf(p)).children.length === 2 && bodyOf(foldOf(p)).children[1] === t10f2,
      "and the next one joins the same block, through the same door");
delete ctx.MutationObserver;
ctx.busy = false;

// ---- 8) the wiring the page has to carry ----
const uiDir = path.join(__dirname, "..", "ui");
const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
const events = fs.readFileSync(path.join(uiDir, "js", "stream-events.js"), "utf8");
const project = fs.readFileSync(path.join(uiDir, "js", "project.js"), "utf8");
const lifecycle = fs.readFileSync(path.join(uiDir, "js", "backend-lifecycle.js"), "utf8");
const css = fs.readFileSync(path.join(uiDir, "style.css"), "utf8");
// the same sheet with its comments cut: this sheet's prose QUOTES the declarations
// it replaced ("deliberately NOT `position: relative` any more"), and a structural
// pin has to read the declarations, not the argument about them
const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");
check(/<script src="js\/auto-fold\.js"><\/script>/.test(html), "the page loads auto-fold.js");
check(/appendCompletion\(ev\.status, ev\.summary\);[\s\S]{0,400}autoFoldTurn\(\);/.test(events),
      "the run's final folds the turn it just closed (after the divider is placed)");
check(/\.turn-fold\s*\{[^}]*margin:\s*0 0 var\(--s4\)/.test(cssBare) &&
      !/\.turn-fold\s*\{[^}]*border:/.test(cssBare) &&
      !/\.turn-fold\s*\{[^}]*background:/.test(cssBare) &&
      !/\.turn-fold\s*\{[^}]*position:\s*relative/.test(cssBare),
      "the block is a ROW of the transcript, not a card in it: no border, no background, and "
      + "deliberately not a positioned box — sticky is positioned on its own, so the rail the "
      + "`.event::before` markers are threaded on runs THROUGH the block like through any row");
check(/\.turn-fold-head\s*{[^}]*position:\s*sticky;\s*top:\s*calc\(-1 \* var\(--s4\)\);\s*z-index:\s*3/.test(css),
      "the head HANGS: sticky inside its own block pins it at the pane's top and is pushed out by "
      + "that block's end, with no state and no per-frame position of its own. `top` is -s4, not 0 — "
      + "sticky resolves against the pane's CONTENT box and #stream carries 16px of padding, so at "
      + "`top: 0` the head pinned 16px low and a strip of the rows it covers kept scrolling through "
      + "the band above it");
check(/\.turn-fold-head\s*{[^}]*display:\s*flex[^}]*gap:\s*var\(--s1\)[^}]*padding:\s*var\(--s1\) 0/.test(css) &&
      /\.turn-fold-caret\s*{[^}]*width:\s*18px;\s*height:\s*18px/.test(css) &&
      /\.event\s*{[^}]*padding:\s*4px 0 4px 22px/.test(css),
      "and it stands on the row's own two columns: the 18px caret cell plus the --s1 gap is the "
      + "22px `.event` insets its rows by, so the label lands on the text column the rows under it "
      + "start on, and the padding is vertical only — there is no frame edge left to hold a gutter");
check(/\.turn-fold-head::before\s*{[^}]*inset:\s*0 0 calc\(-1 \* var\(--s2\)\)[^}]*background:\s*var\(--head-bg\)[^}]*mask-image:\s*linear-gradient\(to bottom, #000 55%, transparent\)[^}]*opacity:\s*0/.test(css) &&
      /\.turn-fold-head\.stuck::before\s*\{\s*opacity:\s*1/.test(css),
      "the hanging head gets a PAGE of its own, so rows pass under it instead of colliding with the "
      + "label — and it is a ::before that reaches below the head and fades out (a mask, so it works "
      + "on any --head-bg) while the head's own box keeps the height it always had: pinning must "
      + "never move the layout. Invisible at rest, because a band over a block nobody has scrolled "
      + "past would just read as the frame that was deleted");
check(/\.turn-fold-head\.stuck\s*\{\s*color:\s*var\(--text\)/.test(css),
      "and a pinned head reads at full strength: it is the live title of the rows under it now");
check(/\.turn-fold-caret\s*{[^}]*font-size:\s*16px/.test(css) &&
      !/\.turn-fold-caret\s*{[^}]*border:/.test(css) &&
      !/\.turn-fold-caret\s*{[^}]*background:/.test(css),
      "the caret is BARE and drawn at 16px — about 8.5x10.5px of ink, the footprint of the markers "
      + "it stands beside: with the frame gone, a 1px --border + --bg2 chip would be the only framed "
      + "thing left in a borderless block. This face draws `▸` 3x4px at 12px, a caret the size of a "
      + "full stop, which is what it read as");
check(/\.turn-fold-head:focus-visible\s*{[^}]*outline-offset:\s*-1px/.test(css),
      "the focus ring is drawn INSIDE the head (a negative offset): the head is a full-width band "
      + "other rows pass under, so a ring at the default offset would land on the rows above and "
      + "below it and the lit control would stop being the thing that is lit");
check(/\.turn-fold-head\s*{[^}]*cursor:\s*pointer/.test(css), "the head reads as clickable");
check(/\.turn-fold-head\s*\{\s*animation:\s*none;\s*\}/.test(css),
      "the head does NOT fade in: it is the lid the middle folds into, and an arrival fade holds "
      + "it at half strength for the first hundred ms of the move — long enough for the block to "
      + "read as folding away into nothing in particular, which is what this looked like");
check(/\.turn-fold-head::after\s*{[^}]*flex:\s*1[^}]*height:\s*1px[^}]*background:\s*var\(--border\)/.test(css),
      "the label runs out on a 1px rule to the pane's right edge: the length the fold swallows, "
      + "drawn — a label with a line running out of it is what the eye reads as a section, a thing "
      + "with an inside, rather than as a row");
check(/\.fold-body\s*\{\s*min-height:\s*0;\s*\}/.test(css) &&
      /\.fold-inner\s*\{\s*overflow:\s*hidden;\s*min-height:\s*0;\s*\}/.test(css),
      "the rows sit in a .fold-body one level inside the clipping .fold-inner: the inner only clips, "
      + "and the body is what the close SLIDES. `min-height: 0` is the same contract on both — inside "
      + "a 0fr track an item has to be allowed to shrink below its content or the track cannot close");
check(/\.turn-fold \.fold:not\(\.open\) \.fold-body > \* \{\s*animation: none/.test(css),
      "the rows moved into the fold do not replay their arrival animation in a fold that is " +
      "not open — and only there: opening it is when they arrive");
check(/\[aria-expanded="true"\] \.turn-fold-caret\s*\{[^}]*transform:\s*rotate\(90deg\)/.test(css),
      "the caret is turned by the head's own aria-expanded, not by a second glyph");
check(/\.turn-fold-spin\s*\{[^}]*display:\s*none[^}]*width:\s*10px;\s*height:\s*10px[^}]*border:\s*2px solid var\(--border\)[^}]*border-top-color:\s*var\(--accent\)/.test(cssBare) &&
      /\.turn-fold\[data-turn-live="1"\] \.turn-fold-head\[aria-expanded="false"\] \.turn-fold-spin\s*\{\s*display:\s*block;\s*animation:\s*older-spin \.7s linear infinite;/.test(cssBare) &&
      !/\.turn-fold[^{]*:has\(/.test(cssBare),
      "the run in flight is drawn by a RING in a folded head, and by the same ring the older-records "
      + "pill spins (10px, --border with an --accent top, one 700ms turn): this sheet has one "
      + "loading language and a second glyph would read as a second state. No `:has()` — the phone "
      + "renders this page in the system WebView, whose version belongs to the device");
check(/\.turn-fold\[data-turn-live="1"\][^{]*\[aria-expanded="false"\]/.test(cssBare),
      "and only for the CLOSED state of a live block: an open one has its rows arriving, which is "
      + "the same fact without a glyph, and a finished one has no reason to look busy");
check(/foldRegion\(eventsEl, turnEnd\);[\s\S]{0,220}settleRunBlocks\(\)/.test(selfSrc),
      "the ending settles the block the run was drawing into after it has taken the turn's rows: "
      + "the ring goes, and a block the reader never touched closes where it stands");
check(/if \(eventsEl\) watchLiveRows\(\);/.test(selfSrc),
      "and the pane's own child list is watched from the moment the page is open — the append sites "
      + "are in files this one loads after, so none of them may name the fold");
check(/\.turn-fold-caret\s*\{[^}]*transition:\s*transform var\(--move\)/.test(css),
      "the caret's turn runs at the fold's own --move, not on the CSS default");
check(!/fold-inner::after/.test(css),
      "no foot spacer inside the body: what is in there is process rows on the transcript's own "
      + "rhythm, and the head hanging at the pane's top is what says where the block is. A foot "
      + "child of the inner was how a transparent fold held the answer off its last row; behind a "
      + "drawn frame it was dead space the line closed on");
check(/eventsEl\.dispatchEvent\(new CustomEvent\("clutch:page-prepended"\)\)/.test(project),
      "the history pager announces the prepend: the page it just brought in can close a turn " +
      "the sink was refused the fold of");
check(/if \(busy\) sseRunAtRisk = true;[\s\S]{0,600}dispatchEvent\(new CustomEvent\("clutch:turn-interrupted"\)\)/.test(lifecycle),
      "dropping a dead session announces that the run in flight has no ending coming — where " +
      "sseRunAtRisk is set, so the same fact is stated once — and the fold of that turn happens " +
      "here, on the pane whose shape is known");
check(/addEventListener\("clutch:turn-interrupted", \(\) => \{\s*clearRunLive\(\);\s*foldOpenTurn\(\);\s*\}\)/.test(selfSrc),
      "and auto-fold listens for it, for the same load-order reason the prepend is announced: " +
      "js/backend-lifecycle.js loads before this file and may not name it. The liveness goes " +
      "first — a block the run was still filling in is not being filled in any more, so the ring " +
      "in its head stops before the block is folded");
check(/addEventListener\("clutch:page-prepended", \(\) => foldClosedRegions\(eventsEl\)\)/.test(selfSrc),
      "and the file that knows how to fold listens for it — it loads after the pager, so the " +
      "pager may not name it (load order is the contract)");
check(/const onTop = anchor\.getClientRects\(\)\.length \? anchor : anchor\.closest\("\.turn-fold"\)/.test(project),
      "the view is re-anchored on the fold when the row that was on top ended up inside one: " +
      "a hidden row has no box, so its own rect cannot be the anchor");
check(project.indexOf('new CustomEvent("clutch:page-prepended")') < project.indexOf("typesetPromise([b])"),
      "the folds land before the typesetting yields — a paged-in page must not paint its " +
      "process rows unfolded first");

summary("auto-fold");
