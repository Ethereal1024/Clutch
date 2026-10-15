"use strict";

// The fold's motion and its state machine (ui/js/stream-text.js): a fold that
// OPENS arrives on the sheet's --arrival curve and one that CLOSES leaves on
// --departure, and a click that lands while a fold is still moving reverses it
// from the frame that is on screen instead of snapping back to the state its
// class list happens to hold — mid-flight the list holds neither `hidden` nor
// `open`, so the fold is asked where it is GOING, and the destination class is
// applied BEFORE the animation starts so a cancel can only land there.
//
// No other runner reaches this code: stream-render-test drives the same functions
// with prefers-reduced-motion on (the state path, never the animation), and the
// css-side pin in tests/ui_css_check.py only holds the numbers. So this runner
// pulls the REAL fold engine out of the module and drives it against a WAAPI stub
// that can be asked for its progress and finished on demand.
//
// Run: node tests/fold-motion-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer } = require("./harness.js");

const src = fs.readFileSync(path.join(__dirname, "..", "ui", "js", "stream-text.js"), "utf8");
const { region } = slicer(src);
const curveOf = (name) => src.match(new RegExp('const ' + name + ' = "([^"]*)";'))[1];
const msOf = (name) => Number(src.match(new RegExp("const " + name + " = (\\d+);"))[1]);
const OPEN_EASE = curveOf("FOLD_OPEN_EASE");
const CLOSE_EASE = curveOf("FOLD_CLOSE_EASE");
const FOLD_MS = msOf("FOLD_MS");

// ---- the stub: state and motion are both readable off it ----
let reduced = false;
let autoScrollCalls = 0;
let rafStarted = 0;
let followTail = true;
const rafSlots = new Map();
let rafSeq = 0;
const loading = false;

function makeAnim(frames, options) {
  const anim = {
    frames,
    options,
    progress: 0,
    cancelled: false,
    listeners: {},
    effect: { getComputedTiming: () => ({ progress: anim.progress }) },
    cancel() {
      anim.cancelled = true;
      for (const fn of anim.listeners.cancel || []) fn();
    },
    addEventListener(type, fn) {
      (anim.listeners[type] = anim.listeners[type] || []).push(fn);
    },
    finish() {
      anim.progress = 1;
      if (anim.onfinish) anim.onfinish();
      for (const fn of anim.listeners.finish || []) fn();
    },
  };
  return anim;
}

// a fold: a class set, a log of the order things happened in, and animate()
function makeFold(classes) {
  const set = new Set(classes || []);
  const node = {
    style: {},
    log: [],
    _animations: [],
    has: (c) => set.has(c),
    classList: {
      add: (...cs) => cs.forEach((c) => { set.add(c); node.log.push("+" + c); }),
      remove: (...cs) => cs.forEach((c) => { set.delete(c); node.log.push("-" + c); }),
      contains: (c) => set.has(c),
    },
    animate: (frames, options) => {
      const anim = makeAnim(frames, options);
      node._animations.push(anim);
      node.log.push("animate");
      return anim;
    },
  };
  return node;
}

const ctx = {
  console,
  window: { matchMedia: () => ({ matches: reduced }) },
  document: { createElement: (t) => ({ tagName: String(t).toUpperCase(), appendChild() {} }) },
  stream: { classList: { contains: (c) => c === "loading" && loading } },
  get followTail() { return followTail; },
  autoScroll: () => { autoScrollCalls++; },
  requestAnimationFrame: (cb) => { rafStarted++; rafSlots.set(++rafSeq, cb); return rafSeq; },
  cancelAnimationFrame: (id) => { rafSlots.delete(id); },
};
vm.createContext(ctx);
vm.runInContext(region("const FOLD_OPEN_EASE", "buildThinkingBlock"), ctx);

// one frame of the tail-pinning loop (js/stream-text.js followTailDuring)
function frame() {
  const slots = [...rafSlots.values()];
  rafSlots.clear();
  for (const cb of slots) cb();
}
const keyframes = (anim) => anim.frames.map((f) => f.gridTemplateRows).join(" -> ");

// ---- 1) a fresh open: the destination is set first, the curve is the arrival ----
let fold = makeFold(["fold", "hidden"]);
ctx.foldExpand(fold);
const opening = fold._foldAnim;
check(fold.has("open") && !fold.has("hidden") &&
      fold.log.indexOf("+open") < fold.log.indexOf("animate"),
      "opening sets the OPEN destination on the fold BEFORE the animation starts, so a cancel "
      + "can only land there (it cannot snap back to the state it started from)");
check(keyframes(opening) === "0fr -> 1fr",
      "a fresh open runs the whole distance: " + keyframes(opening));
check(opening.options.easing === OPEN_EASE && opening.options.duration === FOLD_MS,
      "and it arrives on FOLD_OPEN_EASE (" + OPEN_EASE + ") at FOLD_MS (" + FOLD_MS + "ms)");

// the tail is pinned every frame while an expansion moves a row in...
autoScrollCalls = 0;
rafStarted = 0;
ctx.foldExpand(fold);
check(rafStarted === 1, "an expansion pins the tail to the bottom, one frame at a time");
followTail = false; // the reader scrolled away in the middle of it
frame();
check(autoScrollCalls === 0, "a reader who scrolled away is not dragged back by an expansion");
followTail = true;
frame();
check(autoScrollCalls === 1, "and a reader who is at the bottom is kept there, frame by frame");

// ---- 2) an interrupted open: the close starts from the frame on screen ----
fold = makeFold(["fold", "hidden"]);
ctx.foldExpand(fold);
const oldOpen = fold._foldAnim;
oldOpen.progress = 0.42; // 42% of the height is painted right now
fold.log.length = 0;
let done = 0;
autoScrollCalls = 0;
rafStarted = 0;
ctx.foldCollapse(fold, () => { done++; });
const closing = fold._foldAnim;
check(oldOpen.cancelled && closing !== oldOpen,
      "the in-flight expansion is cancelled, not left running underneath the new one");
check(keyframes(closing) === "0.42fr -> 0fr",
      "the close starts at the fraction that was on screen and only covers the rest: "
      + keyframes(closing));
check(closing.options.easing === CLOSE_EASE && closing.options.duration === FOLD_MS,
      "a close leaves on FOLD_CLOSE_EASE (" + CLOSE_EASE + ") at FOLD_MS, not on the arrival curve");
check(!fold.has("open") &&
      fold.log.indexOf("-open") < fold.log.indexOf("animate"),
      "the CLOSED destination is applied before the animation starts too (.fold is 0fr)");
check(rafStarted === 0, "a collapse never pins the tail: the box only ever gets shorter");
check(autoScrollCalls === 0, "and it never scrolls the reader");

closing.finish();
check(fold.has("hidden") && !fold.has("open") && fold._foldAnim === null && done === 1,
      "a finished close lands the fold in its .hidden end state, and its callback runs once");

// ---- 3) a click DURING a move reverses it (the class list cannot answer this) ----
fold = makeFold(["fold", "hidden"]);
ctx.foldExpand(fold);
fold._foldAnim.progress = 0.5;
check(ctx.toggleFold(fold) === false && keyframes(fold._foldAnim) === "0.5fr -> 0fr",
      "a click mid-open closes it: mid-flight the fold answers with where it is GOING, not with "
      + "the classes it is passing through");

const midClose = fold._foldAnim;
// that close is interrupted in turn: its OWN span is 0.5fr -> 0fr, so 40% of its
// clock is 0.3fr of height on screen, and the open that reverses it starts there
midClose.progress = 0.4;
check(ctx.toggleFold(fold) === true && keyframes(fold._foldAnim) === "0.3fr -> 1fr",
      "a click mid-close opens it again FROM the 0.3fr on screen, instead of re-running the close "
      + "from either end (" + keyframes(fold._foldAnim) + ")");

// a fresh close, interrupted 40% of the way out: 60% of the height is still there
const leaving = makeFold(["fold", "open"]);
ctx.foldCollapse(leaving);
leaving._foldAnim.progress = 0.4;
check(ctx.toggleFold(leaving) === true && keyframes(leaving._foldAnim) === "0.6fr -> 1fr",
      "an interrupted close carries the 60% that is still on screen back up to 1fr");

// and the settled fold answers the same question off its class list
check(ctx.foldFraction(makeFold(["fold"])) === 1 && ctx.foldFraction(makeFold(["fold", "hidden"])) === 0,
      "with nothing in flight the class list IS the fraction (open is 1fr, hidden is 0fr)");

// `_foldAnim` is the same slot the diff body's own height animation uses: an
// animation that carries no fold fractions is not this move, and reading its
// progress would put "NaNfr" in the keyframes
const borrowed = makeFold(["fold", "hidden"]);
borrowed._foldAnim = makeAnim([], {});
check(ctx.foldFraction(borrowed) === 0,
      "an animation in that slot that is not a fold move leaves the class list as the answer");

// ---- 4) reduced motion: a state, never an animation ----
reduced = true;
fold = makeFold(["fold", "hidden"]);
autoScrollCalls = 0;
rafStarted = 0;
ctx.foldExpand(fold);
check(fold._animations.length === 0 && fold.has("open") && !fold.has("hidden"),
      "with reduced motion an open is the end state, with no animation object at all");
check(autoScrollCalls === 1 && rafStarted === 0,
      "it still pins the tail once — and only once: no per-frame loop runs");
done = 0;
autoScrollCalls = 0;
ctx.foldCollapse(fold, () => { done++; });
check(fold._animations.length === 0 && fold.has("hidden") && !fold.has("open") && done === 1,
      "and a reduced-motion close lands `.hidden` and runs its callback");
check(autoScrollCalls === 0, "without scrolling a reader who is reading the history");
reduced = false;

// ---- 5) the diff path takes its curve from the direction of travel as well ----
const pre = makeFold([]);
ctx.animateFold(pre, 140, 320, () => {});
check(pre._foldAnim.options.easing === OPEN_EASE && pre._foldAnim.options.duration === FOLD_MS,
      "a diff that grows arrives on the arrival curve, at FOLD_MS");
check(pre._foldAnim.options.fill === "forwards",
      "it keeps `fill: forwards`: its height is an inline style the animation has to hold");
ctx.animateFold(pre, 320, 140, () => {});
check(pre._foldAnim.options.easing === CLOSE_EASE,
      "a diff that shrinks leaves on the departure curve");
ctx.animateFold(pre, 140, 140, () => {});
check(pre._foldAnim.options.easing === OPEN_EASE,
      "a diff that does not move at all is not a leave");

summary("fold-motion");
