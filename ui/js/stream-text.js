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

// height animation via WAAPI with overflow hidden (no scrollbar shift)
const FOLD_EASE = "cubic-bezier(.23, 1, .32, 1)";

// one fold/diff animation per element; cancel any in-flight one
function cancelFoldAnim(el) {
  if (el._foldAnim) { try { el._foldAnim.cancel(); } catch (e) {} }
  el._foldAnim = null;
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
  const anim = el.animate(
    [{ height: from + "px" }, { height: to + "px" }],
    { duration: 200, easing: FOLD_EASE, fill: "forwards" }
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

function foldExpand(fold) {
  cancelFoldAnim(fold);
  fold.classList.remove("hidden");
  if (reducedMotion()) { fold.classList.add("open"); autoScroll(); return; }
  const anim = fold.animate(
    [{ gridTemplateRows: "0fr" }, { gridTemplateRows: "1fr" }],
    { duration: 200, easing: FOLD_EASE }
  );
  fold._foldAnim = anim;
  anim.onfinish = () => { fold._foldAnim = null; fold.classList.add("open"); };
  followTailDuring(anim);
}

function foldCollapse(fold, onDone) {
  cancelFoldAnim(fold);
  fold.classList.remove("open");
  if (reducedMotion()) { fold.classList.add("hidden"); if (onDone) onDone(); return; }
  const anim = fold.animate(
    [{ gridTemplateRows: "1fr" }, { gridTemplateRows: "0fr" }],
    { duration: 200, easing: FOLD_EASE }
  );
  fold._foldAnim = anim;
  anim.onfinish = () => {
    fold._foldAnim = null;
    fold.classList.add("hidden");
    if (onDone) onDone();
  };
}

function toggleFold(fold, onExpand) {
  const wasHidden = fold.classList.contains("hidden");
  if (wasHidden) {
    if (onExpand) onExpand(); // fill content before the wrapper sizes itself
    foldExpand(fold);
  } else {
    foldCollapse(fold);
  }
  return wasHidden;
}

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

