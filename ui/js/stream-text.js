// streamed prose — text blocks, the fold animation, thinking blocks
//
// Renders the agent's text as it streams (batched through one rAF), the fold
// open/close animation every collapsible shares, and the reasoning blocks.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

function createAgentTextBlock() {
  const wrap = document.createElement("div");
  wrap.className = "event text";
  wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
  return wrap;
}

// coalesced streaming render: one full-block render per frame, flushed by the
// next non-text event so a superseded block is always complete.
//
// THROTTLED to ~8fps: each render is a FULL marked+DOMPurify re-parse of the
// whole accumulated block plus a DOM rebuild — at 60fps on a long answer that
// is O(n²) work that starves the main thread, and a starved renderer is the
// whole-window freeze (clicks queue, Stop included). Math is deferred to the
// flush render: typesetting the whole block per frame for a stray "$…$" pair
// was the single most expensive frame cost.
let textRenderRaf = 0;
let textRenderLast = 0;
const TEXT_RENDER_MIN_MS = 120;
function renderTextBlock(force = false) {
  textRenderRaf = 0;
  const now = performance.now();
  if (!force && now - textRenderLast < TEXT_RENDER_MIN_MS) {
    // too soon since the last full render: skip this frame (cheap no-op), a
    // later frame renders once with every delta that arrived in between
    textRenderRaf = requestAnimationFrame(() => renderTextBlock(false));
    return;
  }
  textRenderLast = now;
  if (!lastTextEl) return;
  const bodyEl = lastTextEl.querySelector(".body");
  bodyEl.innerHTML = renderMarkdown(lastTextContent);
  lastTextEl._mathDone = false; // fresh content: the flush owes a math pass
  highlightCode(lastTextEl, true);
  if (force && !stream.classList.contains("loading")) {
    typesetMath(lastTextEl);
    lastTextEl._mathDone = true;
  }
  autoScroll();
}
function scheduleTextRender() {
  if (textRenderRaf) return;
  textRenderRaf = requestAnimationFrame(() => renderTextBlock(false));
}
function flushTextRender() {
  if (textRenderRaf) {
    cancelAnimationFrame(textRenderRaf);
    renderTextBlock(true);
  } else if (lastTextEl && !lastTextEl._mathDone && !stream.classList.contains("loading")) {
    // content is current (a render landed within the throttle window) but the
    // math pass was deferred while streaming: run it exactly once here — the
    // _mathDone flag keeps bursty non-text events (tool_call_delta chunks)
    // from re-typesetting an unchanged block over and over
    typesetMath(lastTextEl);
    lastTextEl._mathDone = true;
  }
}

// The reasoning block gets the same treatment as the text block above, for the
// same reason and one of its own.
//
// A reasoning stream is the densest this window ever sees — a delta per token,
// and a model that thinks for a minute sends thousands of them. The old shape
// wrote the label ("thinking… N chars"), the block's own copy, and a pin to the
// tail ON EVERY DELTA, and each of those writes forces a layout: the label's own
// width, then autoScroll's `scrollHeight` read over a transcript that grows for
// the whole turn. Thousands of forced layouts is a saturated main thread, and a
// saturated renderer is exactly the freeze that was reported — the counter stops
// moving, clicking the fold does nothing (the click is queued behind the layout
// queue), and every queued change lands in one burst when the deltas finally go
// quiet. One render per frame (throttled, like the text block) keeps the counter
// live without making the frame pay for every token.
//
// The open fold is the second reason: rewriting a 50k-char <pre> per frame is
// the same O(n²) the text block was fixed for, so an open block APPENDS what
// arrived since the last render instead (_drawn); expanding the fold re-syncs
// that mark, because the <pre> it rewrites whole is fully drawn again.
let thinkingRenderRaf = 0;
let thinkingRenderLast = 0;
const THINKING_RENDER_MIN_MS = 120;
function renderThinkingBlock(force = false) {
  thinkingRenderRaf = 0;
  if (!thinkingEl) return;
  const now = performance.now();
  if (!force && now - thinkingRenderLast < THINKING_RENDER_MIN_MS) {
    // too soon since the last render: one more frame, which then carries every
    // delta that arrived in between
    thinkingRenderRaf = requestAnimationFrame(() => renderThinkingBlock(false));
    return;
  }
  thinkingRenderLast = now;
  const label = thinkingEl.querySelector(".thinking-label");
  if (label) label.textContent = "thinking… " + thinkingContent.length + " chars";
  const full = thinkingEl.querySelector(".thinking-full");
  if (!full) return;
  full._content = thinkingContent; // the block's own copy; survives step_start resets
  const fold = thinkingEl.querySelector(".fold");
  if (fold && !fold.classList.contains("hidden")) {
    // open: the text a reader is watching grows by what was not drawn yet
    const drawn = full._drawn;
    if (typeof drawn === "number" && drawn > 0 && drawn <= thinkingContent.length) {
      // only the part past the mark is new; an empty slice (nothing arrived since
      // the last frame) must not append an empty text node per frame either
      const add = thinkingContent.slice(drawn);
      if (add) full.appendChild(document.createTextNode(add));
    } else {
      full.textContent = thinkingContent;
    }
    full._drawn = thinkingContent.length;
  }
  autoScroll();
}
function scheduleThinkingRender() {
  if (thinkingRenderRaf) return;
  thinkingRenderRaf = requestAnimationFrame(() => renderThinkingBlock(false));
}
// A non-reasoning event ends the block's stream: render it once, complete, before
// the next block takes the tail (the same flush the text block gets).
function flushThinkingRender() {
  if (!thinkingRenderRaf) return;
  cancelAnimationFrame(thinkingRenderRaf);
  renderThinkingBlock(true);
}

// height animation via WAAPI with overflow hidden (no scrollbar shift). The two
// curves are the sheet's own pair, used the way the sheet uses them: a fold that
// ARRIVES decelerates into place on --arrival, one that LEAVES accelerates out
// on --departure. Nothing in either language can see the other, so
// tests/ui_css_check.py pins all three numbers to ui/style.css's tokens.
const ARRIVE_EASE = "cubic-bezier(.23, 1, .32, 1)"; // --arrival
const LEAVE_EASE = "cubic-bezier(.4, 0, 1, 1)"; // --departure
const FOLD_MS = 200; // --move: a fold the size of a row
const FOLD_SIZE_MS = 420; // --size: the same move once it has a screenful to cover
const FOLD_PX = 1000; // the screenful --size is written for

// The fold's own content height in pixels: the inner's scrollHeight — the whole
// content, because the inner clips its overflow but still reports its extent, and
// it is readable even while the fold is closed (the measurement is the track the
// move travels AND the distance its duration is paced by). A fold with nothing
// measured (a test double, a box with no layout) is 0, so both callers stay on the
// sheet's own numbers instead of a NaN.
function foldContentPx(fold) {
  const inner = fold.firstElementChild;
  return inner && typeof inner.scrollHeight === "number" ? inner.scrollHeight : 0;
}

// How long THIS fold's move runs. The region fold swallows a turn of a hundred
// rows (js/auto-fold.js) and a flat 200ms closed those at a speed the eye reads as
// a jump — the same gesture, given the time the distance it covers deserves. The
// two ends are the sheet's own: under half a screenful rides --move, a screenful
// leaves on --size, and the move walks between them on the distance.
function foldMoveMs(fold) {
  const px = foldContentPx(fold);
  return Math.max(FOLD_MS, Math.min(FOLD_SIZE_MS, Math.round(px * FOLD_SIZE_MS / FOLD_PX)));
}

// The timeline's own progress, read with the curve already applied: it IS the
// fraction of the distance on screen, which is what the body's slide and the
// pane's give-back have to travel on. With nothing in flight the move is over, so
// the answer is 1 — that is how a landing call after a stop reads the destination
// instead of 0.
function foldProgress(el) {
  const anim = el && el._foldAnim;
  const timing = anim && anim.effect && anim.effect.getComputedTiming ? anim.effect.getComputedTiming() : null;
  return timing && typeof timing.progress === "number" ? timing.progress : 1;
}

// The wrapper a close SLIDES: the region fold's rows inside the clipping inner
// (`.fold-body`, js/auto-fold.js). A thinking or diff fold holds its content
// directly, with no body, and takes the opacity leg of the move instead.
function foldBody(fold) {
  const inner = fold.firstElementChild;
  const body = inner ? inner.firstElementChild : null;
  return body && body.classList && body.classList.contains("fold-body") ? body : null;
}

// The head that HANGS over this fold — the `.turn-fold-head` it follows — or null
// for every other fold, which has no band pinned at the pane's top and so no
// scroll of its own to give back.
function foldHead(fold) {
  const head = fold.previousElementSibling;
  return head && head.classList && head.classList.contains("turn-fold-head") ? head : null;
}

// How far the block's head sits above the pane's top edge: the distance the pane's
// own scroll has to give back for a close to leave the head hanging at the top
// instead of being carried off with the box it belongs to. Read from the BLOCK,
// never from the head — a pinned head reports where sticky put it, not where it
// belongs.
function headLag(fold) {
  const block = fold.parentElement;
  if (!block) return 0;
  const pane = stream.getBoundingClientRect();
  return Math.max(0, pane.top + stream.clientTop - block.getBoundingClientRect().top);
}

/* ── the give-back: a close inside a pinned block moves the pane ───────────────
   A close that starts with the block's head already pinned (the reader is inside
   the rows it is about to swallow) shrinks a box whose top is ABOVE the pane's top
   edge. With the pane's scroll standing still, the last frames of the shrink carry
   the head up with the box it belongs to — exactly what the hanging head exists to
   prevent. So the pane's scroll runs on the same clock and hands back headLag():
   the scroll and the height share one curve (foldProgress is the timeline's own,
   eased — a second easing here would let the head drift off the pane's edge
   mid-move). The one extra call after the animation has been stopped is how the
   move lands exactly on the lag instead of on the last frame it managed to draw.
   While a give-back runs the pane belongs to it (foldHoldsScroll): js/stream-view.js
   does not re-pin the tail under it, and the ResizeObserver that watches the
   transcript's height does not either. */
let foldScrollHold = 0;

function foldHoldsScroll() { return foldScrollHold > 0; }

function giveBack(fold) {
  if (!fold._scrollLag) return;
  stream.scrollTop = fold._scrollFrom - fold._scrollLag * foldProgress(fold);
}

function stopGiveBack(fold) {
  if (fold._scrollRaf) cancelAnimationFrame(fold._scrollRaf);
  fold._scrollRaf = 0;
  if (fold._scrollHold) { foldScrollHold--; fold._scrollHold = false; }
}

// one fold/diff animation per element; cancel any in-flight one
function cancelFoldAnim(el) {
  if (el._foldAnim) { try { el._foldAnim.cancel(); } catch (e) {} }
  el._foldAnim = null;
  if (el._bodyAnim) { try { el._bodyAnim.cancel(); } catch (e) {} }
  el._bodyAnim = null;
  stopGiveBack(el);
}

function animateFold(el, from, to, onDone) {
  cancelFoldAnim(el);
  el.style.overflowY = "hidden";
  el.style.height = from + "px";
  const settle = () => {
    cancelFoldAnim(el);
    onDone();
    // the fold's height settled (or was cancelled): re-pin the tail if latched
    if (followTail && !stream.classList.contains("loading")) autoScroll();
  };
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.style.height = to + "px";
    settle();
    return;
  }
  // the direction of travel picks the curve: the same arrival/leave pair the grid
  // fold below uses, so a diff opening and a diff closing are one gesture each
  const anim = el.animate(
    [{ height: from + "px" }, { height: to + "px" }],
    { duration: FOLD_MS, easing: to >= from ? ARRIVE_EASE : LEAVE_EASE, fill: "forwards" }
  );
  el._foldAnim = anim;
  anim.onfinish = settle;
  followTailDuring(anim);
}

function resetFold(el) {
  el.style.height = "";
  el.style.overflowY = "";
}

// diff expand: grow from its collapsed 140px to the content height
function expandDiff(pre) {
  const start = pre.offsetHeight; // 140 while .diff-collapsed
  pre.classList.remove("diff-collapsed");
  const target = Math.min(pre.scrollHeight, 320);
  animateFold(pre, start, target, () => resetFold(pre));
}

function collapseDiff(pre) {
  animateFold(pre, pre.offsetHeight, 140, () => {
    pre.classList.add("diff-collapsed");
    resetFold(pre);
  });
}

// grid-rows accordion: animate 0fr<->1fr so large text never reflows per frame
function wrapFold(contentEl) {
  const inner = document.createElement("div");
  inner.className = "fold-inner";
  inner.appendChild(contentEl);
  const fold = document.createElement("div");
  fold.className = "fold hidden";
  fold.appendChild(inner);
  return fold;
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// keep the view pinned to the tail each frame while a fold/diff expands
function followTailDuring(anim) {
  let raf = requestAnimationFrame(function tick() {
    if (followTail && !stream.classList.contains("loading")) autoScroll();
    raf = requestAnimationFrame(tick);
  });
  const stop = () => cancelAnimationFrame(raf);
  anim.addEventListener("finish", stop, { once: true });
  anim.addEventListener("cancel", stop, { once: true });
}

// How far the row has travelled right now. The timeline's progress comes with the
// curve already applied, so it IS the fraction of the height on screen (not how far
// the clock got); the fold's own record of the direction turns that into "fr". With
// nothing in flight, the settled class is the whole answer.
function foldFraction(fold) {
  // only a move this function started carries the two fractions; the diff body's
  // own height animation shares the same slot on its own element
  if (!fold._foldAnim || typeof fold._foldFrom !== "number") {
    return fold.classList.contains("hidden") ? 0 : 1;
  }
  return fold._foldFrom + (fold._foldTo - fold._foldFrom) * foldProgress(fold);
}

// Where the body's slide is right now, in px from its resting place: read before a
// move is cancelled so a reversal carries on from the frame on screen.
function foldBodyY(fold) {
  if (typeof fold._bodyFrom !== "number") return 0;
  return fold._bodyFrom + (fold._bodyTo - fold._bodyFrom) * foldProgress(fold);
}

// Where the fold is GOING. Mid-flight that is not what its class list says — the
// list holds neither `hidden` nor `open` while a fold moves — so a second click
// there used to re-run the move the reader had just asked to reverse.
function foldOpen(fold) {
  return fold._foldAnim ? !!fold._foldTarget : !fold.classList.contains("hidden");
}

// The one mover behind both directions. The destination is a CLASS and it is
// applied BEFORE the animation starts: a cancel — reduced motion, a teardown, the
// next click — then lands on the destination instead of snapping back to the
// state the fold started from. The move itself begins at the fraction that is on
// screen, so an interrupted fold carries on from its current frame rather than
// jumping to 0fr/1fr and replaying the whole distance.
function foldAnim(fold, open, onDone) {
  // where the move is RIGHT NOW, read before the cancel throws it away
  const from = foldFraction(fold);
  const fromY = foldBodyY(fold);
  const to = open ? 1 : 0;
  cancelFoldAnim(fold);
  // measurable pass: the fold is opened for the length of this synchronous block
  // only, and it is handed its start height INLINE before the destination class
  // goes on, so the document never lays out in a half-built state — a `display:
  // none` box has no height to measure, and a closed one shrinking the scrollport
  // for the instant between the class write and the first animation frame used to
  // clamp a pane scrolled deep into the block back to the top before the move had
  // started. That inline row is cleared again the moment the move settles; the
  // sheet's own 0fr/1fr (or `.hidden`) takes the box over.
  fold.classList.remove("hidden"); // a rendered box is what can be animated
  fold.classList.add("open");
  const size = foldContentPx(fold);
  // What the move travels on is the BOX's height in pixels, and its one grid track is
  // held OPEN (`1fr`, inline) for the length of the travel. It used to be the track
  // itself (`grid-template-rows` keyframes), which works only from Chromium 107 on —
  // mdn/browser-compat-data, css/properties/grid-template-rows.json, the `animation`
  // entry — and the phone renders this page in the SYSTEM WebView, whose version
  // belongs to the device and not to this app. Short of that engine the property is
  // not animatable: the box sat at its 0px start for the whole duration and then
  // appeared at full height in a single frame, which is the report ("the process block
  // opens instantly on the phone, with no transition"). `height` has been interpolable
  // in every engine this pane runs in, and it is the same number: the same pixels,
  // the same pacing (foldMoveMs measures the content), the same curves. The track has
  // to stay 1fr while it moves or the `.fold` rule's own 0fr would pinch the inner to
  // zero on a close and the box would shrink around nothing.
  const at = (f) => Math.round(size * f) + "px";
  fold.style.gridTemplateRows = "1fr";
  fold.style.height = at(from);
  const body = foldBody(fold);
  // A close that starts with the block's head already pinned hands the pane's
  // scroll back; the lag is read HERE, with the box at its start height and the
  // destination class not on yet, which is the geometry the move begins from.
  const lag = open || !foldHead(fold) ? 0 : headLag(fold);
  fold.classList.toggle("open", open); // the class carries the end state
  if (reducedMotion()) {
    fold.style.height = "";
    fold.style.gridTemplateRows = "";
    if (!open) fold.classList.add("hidden");
    if (lag) stream.scrollTop -= lag; // one step, not a track of them
    if (open) autoScroll();
    queueStuck();
    if (onDone) onDone();
    return;
  }
  // The travel is measured in PIXELS, not `fr`. The fraction would be resolved
  // against a container whose own height is auto — and Blink resolves that
  // fraction twice: the container lands on f×content while the track (and so the
  // clipped inner) lands on f²×content. Mid-move the box is then f(1-f)×content
  // taller than what it holds, which used to be invisible behind a transparent
  // head and reads as a bug inside a framed card: the frame closes on an empty
  // band. Pixels give the box and the clip one number by construction, and it is
  // the same measurement foldMoveMs paces the move by.
  //
  // ONE curve for a region fold, both directions: its move is a height being taken
  // away from, or given back to, a screenful of rows — always the box ARRIVING at
  // its new size, and the decelerating half of --arrival is what keeps the last of
  // it from snapping. (A fold with no body is the other case: it closes by fading
  // its content out, which IS a leave, so that direction keeps --departure.)
  const ms = foldMoveMs(fold); // one measurement, two animations on one clock
  const easing = open || body ? ARRIVE_EASE : LEAVE_EASE;
  const anim = fold.animate(
    [{ height: at(from), opacity: 1 },
     { height: at(to), opacity: open || body ? 1 : 0 }],
    { duration: ms, easing }
  );
  fold._foldAnim = anim;
  fold._foldFrom = from;
  fold._foldTo = to;
  fold._foldTarget = open;
  // the scroll the close has to give back, and where it started from: kept on the
  // fold rather than inside the track so the landing can be exact
  fold._scrollFrom = stream.scrollTop;
  fold._scrollLag = lag;
  if (lag > 1) {
    foldScrollHold++;
    fold._scrollHold = true;
    const trackScroll = () => {
      giveBack(fold);
      fold._scrollRaf = requestAnimationFrame(trackScroll);
    };
    fold._scrollRaf = requestAnimationFrame(trackScroll);
  }
  // The body's own track. A region fold's rows slide UP a full content height on a
  // close, so the LAST row stays glued to the shrinking box's bottom edge instead
  // of being sliced off at the crop line: the rows leave under the hanging head
  // instead of being cropped by an edge nobody can see. On an open they settle back
  // to 0 from wherever an interrupted move left them. A fold with no body (thinking,
  // diff) cannot slide, so its content fades instead — a block that is merely
  // cropped row by row reads as a jump, not as a leave. Never a transform on the
  // BOX: that would carry its own clip window with it and leave a gap where the
  // rows were.
  if (body) {
    fold._bodyFrom = fromY;
    fold._bodyTo = open ? 0 : -size;
    fold._bodyAnim = body.animate(
      [{ transform: "translateY(" + fromY + "px)" },
       { transform: "translateY(" + fold._bodyTo + "px)" }],
      { duration: ms, easing }
    );
  }
  anim.onfinish = () => {
    fold._foldAnim = null;
    giveBack(fold); // land it, don't stop a frame short
    fold._scrollLag = 0;
    stopGiveBack(fold); // …then hand the pane back
    fold.style.height = ""; // the sheet's 0fr/1fr and .hidden take the box over again
    fold.style.gridTemplateRows = "";
    fold._bodyAnim = null; // no fill: the body's own resting place takes over
    fold._bodyFrom = fold._bodyTo = 0;
    if (!open) fold.classList.add("hidden");
    if (onDone) onDone();
    queueStuck(); // the block moved, and with it its head's pin state
  };
  if (open) followTailDuring(anim); // only an expansion pushes the tail down
  queueStuck();
}

function foldExpand(fold) {
  foldAnim(fold, true);
}

function foldCollapse(fold, onDone) {
  foldAnim(fold, false, onDone);
}

function toggleFold(fold, onExpand) {
  const open = foldOpen(fold);
  if (open) {
    foldCollapse(fold);
  } else {
    if (onExpand) onExpand(); // fill content before the wrapper sizes itself
    foldExpand(fold);
  }
  return !open; // true: it is open, or on its way there
}

/* ── the pinned head's own state ───────────────────────────────────────────────
   `position: sticky` has no `:stuck`, and a hanging head's fill must not be there
   while it sits in its natural place — a band over a block nobody has scrolled past
   would read as the frame this sheet just deleted. So "stuck" is computed: the block
   starts above the pane's top edge and still has height below it — the condition
   UIKit uses to pin a section header, and it costs two rects per block per frame
   (already laid out: scrolling does not invalidate layout). The ecosystem's other
   answer is a 1px sentinel plus an IntersectionObserver (stickybits,
   react-sticky-box); rects need no extra element and every one of them is read in
   the scroll path the pane already runs. rAF-coalesced, because a scroll event can
   arrive several times a frame and this must not. */
let stuckRaf = 0;

function paintStuck() {
  stuckRaf = 0;
  const heads = stream.querySelectorAll(".turn-fold-head");
  if (!heads.length) return;
  const pane = stream.getBoundingClientRect().top;
  const state = [];
  // read, then write: a class write between two reads is what makes a loop of rects
  // force a style recalculation per block
  for (const head of heads) {
    const block = head.parentElement;
    const fold = head.nextElementSibling;
    state.push([head, !!(block && fold &&
      block.getBoundingClientRect().top < pane - 0.5 &&
      fold.getBoundingClientRect().bottom > pane + 1)]);
  }
  for (const [head, stuck] of state) head.classList.toggle("stuck", stuck);
}

function queueStuck() {
  if (stuckRaf) return;
  stuckRaf = requestAnimationFrame(paintStuck);
}

// The pane's own scroll is where this has to run, and it runs on its OWN listener:
// js/stream-view.js's listener returns early on every programmatic scroll (it must —
// the latch may only follow the reader's gestures), and the give-back above IS a
// programmatic scroll that has to repaint the heads. A resize moves the pane's top
// edge under the heads without any scroll at all, so it repaints too.
stream.addEventListener("scroll", queueStuck, { passive: true });
window.addEventListener("resize", queueStuck);

// collapsible thinking row; shared by the stored-replay and live streaming paths
function buildThinkingBlock(initialLabel, initialContent) {
  const el = document.createElement("div");
  el.className = "event thinking";
  el.innerHTML = '<div class="hdr">thinking</div>';
  const row = document.createElement("div");
  row.className = "thinking-row";
  const toggle = document.createElement("span");
  toggle.className = "fold-toggle";
  toggle.textContent = "▸";
  const lbl = document.createElement("span");
  lbl.className = "thinking-label";
  lbl.textContent = initialLabel;
  row.appendChild(toggle);
  row.appendChild(lbl);
  el.appendChild(row);
  const full = document.createElement("pre");
  full.className = "thinking-full";
  full.textContent = initialContent;
  full._content = initialContent; // per-block copy; survives step_start resets
  full._drawn = initialContent.length; // what the <pre> already shows (see above)
  const fold = wrapFold(full);
  el.appendChild(fold);
  // click toggles between the compact row and the full reasoning text
  row.onclick = () => {
    const wasHidden = toggleFold(fold, () => {
      full.textContent = full._content;
      full._drawn = full._content.length; // re-synced: the next render appends
    });
    toggle.textContent = wasHidden ? "▾" : "▸";
  };
  return { el, full, fold };
}

// thinking row rebuilt from a stored assistant_message.reasoning
function appendThinkingRow(reasoning) {
  const block = buildThinkingBlock("thinking", reasoning);
  (pageSink || eventsEl).appendChild(block.el);
}

