// rich content — math typesetting, code highlighting, mermaid rendering
//
// The three decorations a finished block gets: MathJax for the TeX, the bounded
// highlight cache for fenced code, and mermaid for diagrams (its theme is read off
// the live CSS, never hardcoded).
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// typeset LaTeX; pre/code are skipped so code stays literal
const MATH_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/;

function typesetMath(el) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  if (!el || !MATH_RE.test(el.textContent)) return;
  // typesetting changes height asynchronously: re-pin the tail when it settles
  MathJax.typesetPromise([el]).then(() => autoScroll()).catch(() => {});
}

// gate: only scan when a $…$ pair survives in non-code text
function hasMathText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("pre, code").forEach((n) => n.remove());
  return MATH_RE.test(clone.textContent);
}

// typeset replayed math block-by-block so the progress bar tracks the work
async function typesetProgressively(root, onPct) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  const blocks = Array.from(root.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
  if (!blocks.length) return;
  for (let i = 0; i < blocks.length; i++) {
    try { await MathJax.typesetPromise([blocks[i]]); } catch (e) {}
    onPct((i + 1) / blocks.length);
    await new Promise((r) => setTimeout(r, 0)); // let the bar repaint between blocks
  }
}

// syntax-highlight a freshly rendered block; streaming skips a last-element
// diagram (its fence may still be open)
//
// CACHED by code source: the streaming render rebuilds the block's DOM every
// frame, so re-running hljs over every COMPLETED fence each frame is O(n²)
// (this is what pegged the renderer and froze the window mid-answer).
// textContent is invariant under highlighting, so the source string is a
// stable key; cached fences just get their HTML re-assigned.
const hlCache = new Map();
const HL_CACHE_MAX = 64; // bounded LRU (insertion-ordered FIFO is fine here)
const HL_STREAM_MAX = 16384; // while streaming, fences bigger than this wait for the flush render
const HL_CACHE_MAX_SRC = 131072; // never cache giants; they re-highlight on flush only

function highlightCode(root, streaming = false) {
  if (typeof hljs === "undefined" || !root) return;
  root.querySelectorAll("pre code").forEach((el) => {
    const src = el.textContent;
    const cached = hlCache.get(src);
    if (cached !== undefined) {
      if (el.innerHTML !== cached) el.innerHTML = cached; // compare: skip needless DOM rebuilds
      return;
    }
    if (streaming && src.length > HL_STREAM_MAX) return; // the flush render highlights it
    try {
      hljs.highlightElement(el);
      if (src.length <= HL_CACHE_MAX_SRC) {
        if (hlCache.size >= HL_CACHE_MAX) hlCache.delete(hlCache.keys().next().value);
        hlCache.set(src, el.innerHTML);
      }
    } catch (e) {}
  });
  renderMermaid(root, streaming).catch((e) => console.warn("[mermaid]", e));
}

let mermaidInitialized = false;
// rendered SVGs cached by source: restore synchronously on streaming re-renders
const mermaidCache = new Map();

// is this pre the last meaningful child? streaming skips it (fence may be open)
function isLastElement(pre) {
  let n = pre.nextSibling;
  while (n) {
    if (n.nodeType === 1) return false;
    if (n.nodeType === 3 && n.textContent.trim()) return false;
    n = n.nextSibling;
  }
  return true;
}

// one-time mermaid initialization: bridge the :root custom properties (accent
// palette, --font-display stack) into mermaid's themeVariables. Returns false
// when initialize() threw — the caller keeps mermaidInitialized set anyway so a
// broken environment is not retried on every frame.
function initMermaidTheme() {
  try {
    // :root custom properties are handed over verbatim, and --font-display is
    // written with inline /* comments */ and newlines for readability. A
    // comment is legal inside a CSS font list but not something to hand to
    // mermaid (it re-emits the value into a <style> block and into inline
    // style attributes), so flatten every value the same way.
    const cssValue = (name) =>
      (getComputedStyle(document.documentElement).getPropertyValue(name) || "")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\s+/g, " ")
        .trim();
    // palette follows the UI: accent red strokes/lines, neutral dark fills
    const accent = cssValue("--accent") || "#EF4444";
    // diagram labels must not fall back to mermaid's own default font ("Arial"
    // in the bundle), which each OS resolves with a different face — the same
    // cross-platform drift the CSS stacks fix for the rest of the UI. Read the
    // computed stack so the diagrams follow it instead of duplicating it here.
    const diagramFont = cssValue("--font-display") || "sans-serif";
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      themeVariables: {
        fontFamily: diagramFont,
        // strokes & lines: accent red
        lineColor: accent,
        primaryBorderColor: accent,
        secondaryBorderColor: accent,
        tertiaryBorderColor: accent,
        // sequence diagram
        actorBorder: accent,
        actorLineColor: accent,
        signalColor: accent,
        labelBoxBorderColor: accent,
        noteBorderColor: accent,
        activationBorderColor: accent,
        // gantt: active = red fill, planned = grey, done = darker grey
        taskBorderColor: accent,
        taskBkgColor: "#2d2d33",
        taskBkg: "#2d2d33", // harmless alias for any theme that reads it
        taskTextColor: "#d4d4d8",
        taskTextLightColor: "#d4d4d8",
        activeTaskBorderColor: accent,
        activeTaskBkgColor: accent,
        activeTaskBkg: accent,
        activeTaskTextColor: "#0F0F10",
        doneTaskBorderColor: "#52525b",
        doneTaskBkgColor: "#1c1c1f",
        doneTaskBkg: "#1c1c1f",
        doneTaskTextColor: "#a1a1aa",
        todayLineColor: accent,
        // clusters / subgraphs
        clusterBorder: accent,
        // state diagrams: also override the outer container's legacy border1
        stateBorder: accent,
        border1: accent,
        // fills & labels: neutral dark greys
        noteBkgColor: "#1c1c1f",
        noteTextColor: "#d4d4d8",
        edgeLabelBackground: "#1c1c1f",
        clusterBkg: "#1c1c1f",
        taskTextOutsideColor: "#a1a1aa",
        activationBkgColor: "#27272a",
        // pie: first slice red, rest grayscale (pie0 unused)
        pie1: accent,
        pie2: "#27272a",
        pie3: "#3f3f46",
        pie4: "#52525b",
        pie5: "#71717a",
        pie6: "#8b8b94",
        pie7: "#a1a1aa",
        pie8: "#b8b8c0",
        pie9: "#c9c9d0",
        pie10: "#d4d4d8",
        pie11: "#e0e0e4",
        pie12: "#ededf0",
        // git graphs: grayscale + red (git0-git7)
        git0: accent,
        git1: "#71717a",
        git2: "#d4d4d8",
        git3: "#3f3f46",
        git4: "#a1a1aa",
        git5: "#27272a",
        git6: "#b8b8c0",
        git7: "#52525b",
      },
    });
    // never let the parser's error path paint its giant error diagram
    mermaid.parseError = (err) => console.warn("[mermaid]", err);
    return true;
  } catch (e) {
    return false;
  }
}

// render mermaid: skip a last-element block mid-stream (open fence), keep
// broken source literal (async parse gate)
async function renderMermaid(root, streaming = false) {
  if (typeof mermaid === "undefined" || !root) return;
  if (!mermaidInitialized) {
    mermaidInitialized = true;
    if (!initMermaidTheme()) return;
  }
  const pending = [];
  for (const code of root.querySelectorAll("pre code.language-mermaid")) {
    const pre = code.parentElement;
    if (!pre) continue;
    const src = code.textContent;
    if (pre.dataset.mermaidSrc === src) continue; // this exact source already drawn
    const cached = mermaidCache.get(src);
    if (cached) {
      // a streaming re-render rebuilt the DOM: restore the SVG synchronously
      pre.classList.add("mermaid-rendered");
      pre.textContent = "";
      pre.insertAdjacentHTML("beforeend", cached);
      pre.dataset.mermaidSrc = src;
      continue;
    }
    // gate 1 — possible unclosed fence mid-stream: don't draw half a diagram
    if (streaming && isLastElement(pre)) continue;
    // gate 2 — async syntax check before rendering; broken source stays literal
    let parsed = true;
    let parseErr = null;
    try {
      parsed = await mermaid.parse(src);
    } catch (e) {
      parsed = false;
      parseErr = e;
    }
    if (!parsed) {
      showMermaidError(pre, parseErr);
      pre.dataset.mermaidSrc = src; // identical broken source: no re-parse loop
      continue;
    }
    pre.dataset.mermaidSrc = src; // mark in-flight so deltas don't double-render
    pending.push({ pre, src });
  }
  for (const { pre, src } of pending) {
    mermaid
      .render("mmd-" + Math.random().toString(36).slice(2), src)
      .then(({ svg }) => {
        // a later delta may have rebuilt the DOM: re-locate the block by source
        let target = null;
        for (const el of root.querySelectorAll("pre code.language-mermaid")) {
          if (el.textContent === src) { target = el.parentElement; break; }
        }
        if (!target) return;
        // gate 3 — render can resolve a giant error diagram; never let it hit the DOM
        if (/Parse error on line|Lexical error on line|Syntax error in text|Parse error[:\s]/.test(svg)) {
          showMermaidError(target, null);
          delete target.dataset.mermaidSrc; // a corrected source can retry
          return;
        }
        if (mermaidCache.size > 100) mermaidCache.clear();
        mermaidCache.set(src, svg);
        // securityLevel "strict" already sanitizes the SVG; keep the block chrome
        target.classList.add("mermaid-rendered");
        target.textContent = "";
        target.insertAdjacentHTML("beforeend", svg);
        target.dataset.mermaidSrc = src;
        if (followTail) autoScroll(); // a diagram can be taller than its source
      })
      .catch((e) => {
        // keep the literal source; drop the marker so a corrected source can retry
        if (pre.isConnected) {
          showMermaidError(pre, e);
          delete pre.dataset.mermaidSrc;
        }
      });
  }
}

// mark a failed diagram with a small inline notice; the parser message goes
// into the hover title
function showMermaidError(pre, detail) {
  if (!pre || !pre.classList) return;
  pre.classList.add("mermaid-failed");
  if (!pre.querySelector(".mermaid-error")) {
    const tip = document.createElement("div");
    tip.className = "mermaid-error";
    tip.textContent = "Invalid diagram syntax; the original code was kept.";
    const msg = detail && (detail.message || String(detail));
    if (msg) tip.title = "mermaid: " + msg;
    pre.appendChild(tip);
  }
}

