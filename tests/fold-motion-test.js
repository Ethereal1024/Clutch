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
const ARRIVE = curveOf("ARRIVE_EASE");
const LEAVE = curveOf("LEAVE_EASE");
const FOLD_MS = msOf("FOLD_MS");
const FOLD_SIZE_MS = msOf("FOLD_SIZE_MS");

// ---- the stub: state and motion are both readable off it ----
let reduced = false;
let autoScrollCalls = 0;
let rafStarted = 0;
let followTail = true;
const rafSlots = new Map();
let rafSeq = 0;
const loading = false;
// the pane (js/stream-view.js's #stream): its top edge in viewport coordinates and
// its scroll offset, both of which the give-back writes and reads
let paneTop = 0;
// where the block that holds the fold starts, relative to the pane's top edge — the
// lag a close has to hand back to the pane's scroll
let blockTop = 0;
// the heads paintStuck() walks (`.turn-fold-head` in the pane)
let stuckHeads = [];

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
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
        node.log.push((on ? "+" : "-") + c);
        return on;
      },
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
  window: { matchMedia: () => ({ matches: reduced }), addEventListener: () => {} },
  document: { createElement: (t) => ({ tagName: String(t).toUpperCase(), appendChild() {} }) },
  stream: {
    classList: { contains: (c) => c === "loading" && loading },
    clientTop: 0,
    clientHeight: 600,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: paneTop }),
    querySelectorAll: () => stuckHeads,
    // the pane's own scroll listener (js/stream-text.js paintStuck): the engine
    // subscribes at load, and this runner drives paintStuck directly instead
    addEventListener: () => {},
  },
  get followTail() { return followTail; },
  autoScroll: () => { autoScrollCalls++; },
  requestAnimationFrame: (cb) => { rafStarted++; rafSlots.set(++rafSeq, cb); return rafSeq; },
  cancelAnimationFrame: (id) => { rafSlots.delete(id); },
};
vm.createContext(ctx);
vm.runInContext(region("const ARRIVE_EASE", "buildThinkingBlock"), ctx);

// one frame of the tail-pinning loop (js/stream-text.js followTailDuring)
function frame() {
  const slots = [...rafSlots.values()];
  rafSlots.clear();
  for (const cb of slots) cb();
}
// drain whatever the moves above left scheduled. queueStuck() keeps at most ONE
// frame in flight (that is the point of it), so a repaint still pending from an
// earlier move would swallow the next one and make a count of rAF requests read
// as "nothing was scheduled". Pay it first, then reset the two counters.
function flush() {
  frame();
  rafStarted = 0;
  autoScrollCalls = 0;
}
const keyframes = (anim) => anim.frames.map((f) => f.height).join(" -> ");
const fade = (anim) => anim.frames.map((f) => f.opacity).join(" -> ");
const slideFrames = (anim) => anim.frames.map((f) => f.transform).join(" -> ");

// a fold whose inner has a measured height — the fold's own log/class stub plus the
// one child the move is paced by and the px track is measured from. 400px is under
// two thirds of a screenful, so its duration is still the sheet's --move and the
// px numbers below read as whole values.
function makeSizedFold(px, classes) {
  const node = makeFold(classes || ["fold", "hidden"]);
  node.firstElementChild = { scrollHeight: px };
  return node;
}
const SIZED = 400; // the stub content the motion cases below animate

// a region fold (js/auto-fold.js): its inner holds a `.fold-body` wrapper — the rows
// a close slides — and its block holds the `.turn-fold-head` the fold hangs from.
// Neither exists on a thinking or diff fold, which is exactly why the two take
// different legs of the move.
function makeBody() {
  const body = {
    _animations: [],
    classList: { contains: (c) => c === "fold-body" },
    animate: (frames, options) => {
      const anim = makeAnim(frames, options);
      body._animations.push(anim);
      return anim;
    },
  };
  return body;
}

function makeRegionFold(px, classes) {
  const node = makeSizedFold(px, classes);
  const body = makeBody();
  node.firstElementChild.firstElementChild = body;
  node._body = body;
  const head = makeFold(["turn-fold-head"]);
  const block = { getBoundingClientRect: () => ({ top: blockTop }) };
  head.parentElement = block;
  node.parentElement = block;
  node.previousElementSibling = head;
  return node;
}

// a `.turn-fold-head` with the two rects paintStuck() reads: where its block starts
// (relative to the pane's top edge) and where that block's fold ends
function makeStuckHead(top, bottom) {
  const head = makeFold(["turn-fold-head"]);
  const geo = { top, bottom };
  head.geo = geo;
  head.parentElement = { getBoundingClientRect: () => ({ top: geo.top }) };
  head.nextElementSibling = { getBoundingClientRect: () => ({ bottom: geo.bottom }) };
  return head;
}

// ---- 1) a fresh open: the destination is set first, the curve is the arrival ----
let fold = makeSizedFold(SIZED);
ctx.foldExpand(fold);
const opening = fold._foldAnim;
check(fold.has("open") && !fold.has("hidden") &&
      fold.log.indexOf("+open") < fold.log.indexOf("animate"),
      "opening sets the OPEN destination on the fold BEFORE the animation starts, so a cancel "
      + "can only land there (it cannot snap back to the state it started from)");
check(keyframes(opening) === "0px -> " + SIZED + "px",
      "a fresh open runs the whole distance: " + keyframes(opening));
check(opening.frames[1].height === SIZED + "px" &&
      opening.frames[0].height === "0px",
      "and the box moves by its own HEIGHT in pixels, the inner's measured content: a fractional "
      + "`fr` is resolved against an auto-height container twice by Blink, so the track landed on "
      + "f*f x content while the box landed on f x content and the frame closed on an empty band");
// The property carrying the move is not interchangeable. `grid-template-rows` became
// interpolable in Chromium 107 (mdn/browser-compat-data, css/properties/grid-template-rows
// .json, the `animation` entry) and the phone renders this page in the SYSTEM WebView,
// whose version ships with the device: on an older one the keyframes were not
// animatable, the box sat at 0px for the whole duration and then appeared at full
// height in one frame — the report ("the process block opens instantly on the phone").
// So the frames carry `height`, and the fold's one track is held OPEN while the box
// moves (its own `.fold` rule is 0fr closed, which would otherwise pinch the inner to
// zero on a close and shrink the box around nothing).
check(Object.keys(opening.frames[0]).every((k) => k === "height" || k === "opacity") &&
      opening.frames.every((f) => f.gridTemplateRows === undefined),
      "and grid tracks are nowhere in the keyframes: " + Object.keys(opening.frames[0]).join(", ")
      + " is what every engine this pane runs in can interpolate");
check(fold.style.height === "0px" && fold.style.gridTemplateRows === "1fr",
      "with the track held open inline for the length of the move (" + fold.style.height + ", "
      + fold.style.gridTemplateRows + "): the resting 0fr would clip the rows away mid-travel");
check(opening.options.easing === ARRIVE && opening.options.duration === FOLD_MS,
      "and it arrives on ARRIVE_EASE (" + ARRIVE + ") at FOLD_MS (" + FOLD_MS + "ms)");
check(fade(opening) === "1 -> 1",
      "an OPEN pins its rows opaque the whole way (" + fade(opening) + "): they arrive on their "
      + "own animation once the box is displayed again, so the fold does not fade them too");

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
fold = makeSizedFold(SIZED);
ctx.foldExpand(fold);
const oldOpen = fold._foldAnim;
oldOpen.progress = 0.42; // 42% of the height is painted right now
fold.log.length = 0;
let done = 0;
flush();
ctx.foldCollapse(fold, () => { done++; });
const closing = fold._foldAnim;
check(oldOpen.cancelled && closing !== oldOpen,
      "the in-flight expansion is cancelled, not left running underneath the new one");
check(keyframes(closing) === "168px -> 0px",
      "the close starts at the fraction that was on screen (42% of " + SIZED + "px) and only "
      + "covers the rest: " + keyframes(closing));
check(closing.options.easing === LEAVE && closing.options.duration === FOLD_MS,
      "a close of a fold with NO body (a thinking or diff row: nothing in there can slide) "
      + "leaves on LEAVE_EASE (" + LEAVE + ") at FOLD_MS");
check(fade(closing) === "1 -> 0",
      "and a CLOSE fades its rows out on that same clock (" + fade(closing) + "): the box is "
      + "clipping them as it shrinks, and a block that is only cropped row by row reads as a "
      + "jump rather than as a leave");
check(!fold.has("open") &&
      fold.log.indexOf("-open") < fold.log.indexOf("animate"),
      "the CLOSED destination is applied before the animation starts too (.fold is 0fr)");
check(rafStarted === 1 && autoScrollCalls === 0,
      "a collapse never pins the tail: the box only ever gets shorter, so the one frame it "
      + "schedules is the repaint of the heads' pin state, not a tail loop");

closing.finish();
check(fold.has("hidden") && !fold.has("open") && fold._foldAnim === null && done === 1,
      "a finished close lands the fold in its .hidden end state, and its callback runs once");
check(fold.style.height === "" && fold.style.gridTemplateRows === "",
      "and the inline height and the held-open track come off again, so the sheet's own 0fr/.hidden "
      + "pair owns the box from then on (a stale 0px would pin it shut for good)");

// ---- 3) a click DURING a move reverses it (the class list cannot answer this) ----
fold = makeSizedFold(SIZED);
ctx.foldExpand(fold);
fold._foldAnim.progress = 0.5;
check(ctx.toggleFold(fold) === false && keyframes(fold._foldAnim) === "200px -> 0px",
      "a click mid-open closes it: mid-flight the fold answers with where it is GOING, not with "
      + "the classes it is passing through");

const midClose = fold._foldAnim;
// that close is interrupted in turn: its OWN span is 50% -> 0% of the content, so 40%
// of its clock is 30% of the height on screen, and the open that reverses it starts there
midClose.progress = 0.4;
check(ctx.toggleFold(fold) === true && keyframes(fold._foldAnim) === "120px -> " + SIZED + "px",
      "a click mid-close opens it again FROM the 30% on screen, instead of re-running the close "
      + "from either end (" + keyframes(fold._foldAnim) + ")");

// a fresh close, interrupted 40% of the way out: 60% of the height is still there
const leaving = makeSizedFold(SIZED, ["fold", "open"]);
ctx.foldCollapse(leaving);
leaving._foldAnim.progress = 0.4;
check(ctx.toggleFold(leaving) === true && keyframes(leaving._foldAnim) === "240px -> " + SIZED + "px",
      "an interrupted close carries the 60% that is still on screen back up to the full height");

// and the settled fold answers the same question off its class list
check(ctx.foldFraction(makeFold(["fold"])) === 1 && ctx.foldFraction(makeFold(["fold", "hidden"])) === 0,
      "with nothing in flight the class list IS the fraction (open is 1fr, hidden is 0fr)");

// `_foldAnim` is the same slot the diff body's own height animation uses: an
// animation that carries no fold fractions is not this move, and reading its
// progress would put NaN in the keyframes
const borrowed = makeFold(["fold", "hidden"]);
borrowed._foldAnim = makeAnim([], {});
check(ctx.foldFraction(borrowed) === 0,
      "an animation in that slot that is not a fold move leaves the class list as the answer");

// ---- 4) the region fold's duration walks with the distance it covers ----
// A turn of a hundred rows (js/auto-fold.js) closed at a flat --move reads as a
// jump; the same gesture given the time the distance deserves does not. The ramp
// is bounded by the sheet's own two ends — --move under half a screenful, --size at
// a screenful — and a fold with nothing measured is the floor.
check(ctx.foldMoveMs(makeSizedFold(0)) === FOLD_MS &&
      ctx.foldMoveMs(makeSizedFold(476)) === FOLD_MS,
      "a fold shorter than half a screenful still rides the sheet's --move ("
      + FOLD_MS + "ms), not something faster");
check(ctx.foldMoveMs(makeSizedFold(800)) === 336,
      "and past that it walks: 800px of rows runs 336ms (800 x " + FOLD_SIZE_MS
      + " / 1000), between the two ends");
check(ctx.foldMoveMs(makeSizedFold(1000)) === FOLD_SIZE_MS &&
      ctx.foldMoveMs(makeSizedFold(4000)) === FOLD_SIZE_MS,
      "at a screenful it leaves on --size (" + FOLD_SIZE_MS + "ms) and stays there however much "
      + "more is folded away");
check(ctx.foldMoveMs(makeFold(["fold"])) === FOLD_MS,
      "a fold with no measured inner (a double, a box with no layout) is the floor, so the number "
      + "is the sheet's and never a NaN");
const sized = makeSizedFold(1000);
ctx.foldExpand(sized);
check(sized._foldAnim.options.duration === FOLD_SIZE_MS,
      "and that ramp is what the animation is actually started for: a screenful's fold runs "
      + sized._foldAnim.options.duration + "ms");

// ---- 5) reduced motion: a state, never an animation ----
reduced = true;
fold = makeFold(["fold", "hidden"]);
flush();
ctx.foldExpand(fold);
check(fold._animations.length === 0 && fold.has("open") && !fold.has("hidden"),
      "with reduced motion an open is the end state, with no animation object at all");
check(autoScrollCalls === 1 && rafStarted === 1,
      "it still pins the tail once — and only once (the one frame it schedules is the heads' "
      + "pin-state repaint, not a per-frame loop)");
done = 0;
autoScrollCalls = 0;
ctx.foldCollapse(fold, () => { done++; });
check(fold._animations.length === 0 && fold.has("hidden") && !fold.has("open") && done === 1,
      "and a reduced-motion close lands `.hidden` and runs its callback");
check(fold.style.height === "" && fold.style.gridTemplateRows === "",
      "with the same clean inline state: a reduced-motion reader gets the destination, never a "
      + "half-set box");
check(autoScrollCalls === 0, "without scrolling a reader who is reading the history");
reduced = false;

// ---- 6) the diff path takes its curve from the direction of travel as well ----
const pre = makeFold([]);
ctx.animateFold(pre, 140, 320, () => {});
check(pre._foldAnim.options.easing === ARRIVE && pre._foldAnim.options.duration === FOLD_MS,
      "a diff that grows arrives on the arrival curve, at FOLD_MS");
check(pre._foldAnim.options.fill === "forwards",
      "it keeps `fill: forwards`: its height is an inline style the animation has to hold");
ctx.animateFold(pre, 320, 140, () => {});
check(pre._foldAnim.options.easing === LEAVE,
      "a diff that shrinks leaves on the departure curve");
ctx.animateFold(pre, 140, 140, () => {});
check(pre._foldAnim.options.easing === ARRIVE,
      "a diff that does not move at all is not a leave");

// ---- 7) the region fold: one curve, a sliding body, and the pane's own scroll ----
// A turn fold (js/auto-fold.js) closes by taking a screenful of rows away under a
// head pinned at the pane's top edge. It differs from the row folds above twice
// over: the rows SLIDE up inside the shrinking box instead of fading, and the
// pane's scroll runs on the same clock so the head keeps hanging where it is.
paneTop = 0;
ctx.stream.clientTop = 0;
blockTop = -120; // the block starts 120px above the pane's top edge: that is the lag
const turnFold = makeRegionFold(SIZED, ["fold", "open"]);
flush();
ctx.stream.scrollTop = 500;
ctx.foldCollapse(turnFold);
const turnFoldClose = turnFold._foldAnim;
check(turnFoldClose.options.easing === ARRIVE,
      "a region fold closes on the ARRIVAL curve too (" + ARRIVE + "): its move is a box arriving "
      + "at its new size from either direction, and only the decelerating half keeps the last of "
      + "it from snapping (a fade-out fold is the leave, and it is the only one)");
const slide = turnFold._body._animations[0];
check(slideFrames(slide) === "translateY(0px) -> translateY(-" + SIZED + "px)",
      "the rows slide up a whole content height as the box closes (" + slideFrames(slide) + "), so "
      + "the LAST row stays glued to the shrinking bottom edge instead of being sliced off at the "
      + "crop line and vanishing row by row");
check(slide.options.duration === turnFoldClose.options.duration &&
      slide.options.easing === turnFoldClose.options.easing,
      "the slide and the box are one clock and one curve: two would let the rows drift off the "
      + "edge the box is drawing");
check(turnFold._scrollLag === 120 && turnFold._scrollFrom === 500 && ctx.foldHoldsScroll(),
      "a close that starts with its head already pinned takes the pane's scroll with it: headLag() "
      + "is what the scroll has to hand back, and while it runs the pane belongs to the fold "
      + "(lag " + turnFold._scrollLag + ")");
turnFoldClose.progress = 0.5; // the timeline's own progress, curve already applied
frame();
check(ctx.stream.scrollTop === 440,
      "the scroll runs on the fold's eased progress, so the head never drifts off the pane's edge "
      + "mid-move: half way is 500 - 120/2 = " + ctx.stream.scrollTop);
turnFoldClose.finish();
check(ctx.stream.scrollTop === 380 && !ctx.foldHoldsScroll(),
      "and the frame after the stop lands it EXACTLY on the lag instead of one frame short, then "
      + "hands the pane back (" + ctx.stream.scrollTop + "px, holds: "
      + ctx.foldHoldsScroll() + ")");

// an OPEN takes nothing back — it is the move that gives the tail its rows
const openedRegion = makeRegionFold(SIZED);
flush();
ctx.foldExpand(openedRegion);
check(openedRegion._scrollLag === 0 && !ctx.foldHoldsScroll(),
      "an open does not touch the pane's scroll: the rows are arriving, not leaving from under a "
      + "pinned head");
check(slideFrames(openedRegion._body._animations[0]) === "translateY(0px) -> translateY(0px)",
      "and its body starts from where it is, so a fold that was never away does not jump");

// a close interrupted half way carries the rows still on screen back up
blockTop = 0; // no lag: this case is about the body's own frame
ctx.stream.scrollTop = 0;
const reversed = makeRegionFold(SIZED, ["fold", "open"]);
flush();
ctx.foldCollapse(reversed);
reversed._foldAnim.progress = 0.5; // half the rows are already gone
check(ctx.toggleFold(reversed) === true &&
      slideFrames(reversed._body._animations[1]) === "translateY(-200px) -> translateY(0px)",
      "an interrupted close reopens from the frame the rows are on screen at (-200px of "
      + SIZED + "), not from the top or from the bottom");

// ---- 8) the pinned head's own state is computed, not styled ----
// `position: sticky` has no `:stuck`, and the fill must not be there while a head
// sits in its natural place — a band over a block nobody has scrolled past would be
// the frame this sheet just deleted. So the predicate is UIKit's section rule: the
// block starts above the pane's top edge AND still has height below it.
paneTop = 0;
const pinned = makeStuckHead(-40, 200); // scrolled past, rows still below the edge
const approaching = makeStuckHead(40, 300); // still below the edge: not pinned
const ended = makeStuckHead(-40, -10); // the block ends above the edge: not pinned
stuckHeads = [pinned, approaching, ended];
ctx.paintStuck();
check(pinned.has("stuck") && !approaching.has("stuck") && !ended.has("stuck"),
      "a head is stuck only while its block is above the pane's top edge and its fold still has "
      + "height below it (" + [pinned.has("stuck"), approaching.has("stuck"), ended.has("stuck")]
      .join(", ") + ")");
pinned.geo.top = 60; // the reader scrolled back up past it
ctx.paintStuck();
check(!pinned.has("stuck"),
      "and the fill comes off again the moment the block is back in its natural place");
flush();
ctx.queueStuck();
ctx.queueStuck();
check(rafStarted === 1,
      "queueStuck() coalesces: a scroll can arrive several times a frame, and two rects per block "
      + "per event would be a style recalculation per row (" + rafStarted + " frame for 2 asks)");

summary("fold-motion");
