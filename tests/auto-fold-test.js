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
  paging: false, // the pager's flag (js/project.js loadOlder); false: nobody is paging
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
check(f9e2 === f9e && p.children.length === 4 && p.children[1] === f9e &&
      p.children[2] === a9e && p.children[3] === d9e,
      "the turn that finally completes is the SAME fold, ended directly above its answer");
check(f9e2 !== undefined && bodyOf(f9e).children.length === 5 &&
      bodyOf(f9e).children[0] === w9e &&
      bodyOf(f9e).children[2] === part9e &&
      bodyOf(f9e).children[3] === u9e &&
      bodyOf(f9e).children[4] === w9e2,
      "and the prose it stopped on is process now, inside the block, where it belongs");

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
check(/addEventListener\("clutch:turn-interrupted", \(\) => foldOpenTurn\(\)\)/.test(selfSrc),
      "and auto-fold listens for it, for the same load-order reason the prepend is announced: " +
      "js/backend-lifecycle.js loads before this file and may not name it");
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
