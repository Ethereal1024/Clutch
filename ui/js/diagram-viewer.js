// the fullscreen diagram viewer, the language map, path highlighting
//
// Zoom/pan over a rendered diagram with its own history entry (Android back),
// plus the language-by-extension table a code panel highlights with.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// ---- diagram viewer (device report #6) ----------------------------------
// A flowchart in a phone column is unreadable at fit-width, and even on the PC
// a 900px-wide diagram is a squint. Clicking a rendered diagram opens it
// full-screen with the phone image-viewer gestures: drag to pan, wheel/pinch to
// zoom, double-tap/double-click for 1:1, ✕ / Esc / Android back / tap outside to
// leave. Built on first use; nothing is added to the page until then, and the
// click is delegated (diagrams are re-rendered on every stream delta, so a
// per-diagram listener would be re-attached hundreds of times).

let dvOverlay = null;
let dvStage = null;
let dvInner = null;
let dvZoom = 1;
let dvX = 0;
let dvY = 0;
let dvFitZoom = 1;
let dvHistoryEntry = false; // this viewer pushed a history entry (Android back)

const DV_MIN_ZOOM = 0.05;
const DV_MAX_ZOOM = 16;
const clampZoom = (z) => Math.max(DV_MIN_ZOOM, Math.min(DV_MAX_ZOOM, z));

function dvApply() {
  dvInner.style.transform = "translate(" + dvX + "px," + dvY + "px) scale(" + dvZoom + ")";
}

// centre the diagram at its natural size in the stage
function dvFit() {
  const svg = dvInner.firstElementChild;
  if (!svg || !dvStage) return;
  const w = Number(svg.getAttribute("width")) || svg.clientWidth || 800;
  const h = Number(svg.getAttribute("height")) || svg.clientHeight || 600;
  const r = dvStage.getBoundingClientRect();
  dvFitZoom = Math.min((r.width * 0.94) / w, (r.height * 0.94) / h) || 1;
  dvZoom = dvFitZoom;
  dvX = (r.width - w * dvZoom) / 2;
  dvY = (r.height - h * dvZoom) / 2;
  dvApply();
}

// scale by `factor`, keeping the point (cx,cy) — stage-local pixels — in place
function dvZoomAt(factor, cx, cy) {
  const z = clampZoom(dvZoom * factor);
  const k = z / dvZoom;
  dvX = cx - (cx - dvX) * k;
  dvY = cy - (cy - dvY) * k;
  dvZoom = z;
  dvApply();
}

function dvCenterZoom(z) {
  if (!dvStage) return;
  const r = dvStage.getBoundingClientRect();
  dvZoomAt(z / dvZoom, r.width / 2, r.height / 2);
}

function ensureDiagramViewer() {
  if (dvOverlay) return;
  dvOverlay = document.createElement("div");
  dvOverlay.className = "diagram-viewer";
  dvOverlay.innerHTML =
    '<div class="dv-hint">drag to pan · pinch or wheel to zoom · double-tap for 1:1 · tap outside to close</div>' +
    '<div class="dv-stage"><div class="dv-inner"></div></div>' +
    '<div class="dv-bar">' +
    '<button class="dv-zoom-out" title="zoom out">−</button>' +
    '<button class="dv-one" title="actual size">1:1</button>' +
    '<button class="dv-fit" title="fit to screen">fit</button>' +
    '<button class="dv-zoom-in" title="zoom in">＋</button>' +
    "</div>" +
    '<button class="dv-close" title="close (Esc)">✕</button>';
  document.body.appendChild(dvOverlay);
  dvStage = dvOverlay.querySelector(".dv-stage");
  dvInner = dvOverlay.querySelector(".dv-inner");

  const localOf = (e) => {
    const r = dvStage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  dvOverlay.querySelector(".dv-close").addEventListener("click", closeDiagramViewer);
  dvOverlay.querySelector(".dv-fit").addEventListener("click", dvFit);
  dvOverlay.querySelector(".dv-one").addEventListener("click", () => dvCenterZoom(1));
  dvOverlay.querySelector(".dv-zoom-in").addEventListener("click", () => dvCenterZoom(dvZoom * 1.5));
  dvOverlay.querySelector(".dv-zoom-out").addEventListener("click", () => dvCenterZoom(dvZoom / 1.5));

  // desktop: the wheel zooms around the cursor (a bare wheel must not scroll
  // the page under the overlay)
  dvStage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = localOf(e);
      dvZoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
    },
    { passive: false }
  );

  // one pointer pans, two pointers pinch; a tap that never moved, landing
  // outside the diagram, leaves (the diagram itself stays tappable so the
  // double-tap gesture below still works)
  const pts = new Map();
  let pinch = null;
  let moved = 0;
  const startPinch = () => {
    const [a, b] = [...pts.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom: dvZoom,
      x: dvX,
      y: dvY,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  dvStage.addEventListener("pointerdown", (e) => {
    if (dvStage.setPointerCapture) dvStage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, localOf(e));
    moved = 0;
    if (pts.size === 2) pinch = startPinch();
  });
  dvStage.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const q = localOf(e);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    moved += Math.abs(dx) + Math.abs(dy);
    pts.set(e.pointerId, q);
    if (pts.size === 1) {
      dvX += dx;
      dvY += dy;
      dvApply();
      return;
    }
    if (!pinch) pinch = startPinch();
    const [a, b] = [...pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = clampZoom(pinch.zoom * (dist / pinch.dist));
    // the content point under the original midpoint stays under the new one
    const cx = (pinch.mid.x - pinch.x) / pinch.zoom;
    const cy = (pinch.mid.y - pinch.y) / pinch.zoom;
    dvZoom = z;
    dvX = mid.x - cx * z;
    dvY = mid.y - cy * z;
    dvApply();
  });
  const endPointer = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size || moved >= 8) return;
    // the diagram as drawn, in the same stage-local pixels as localOf()
    const sr = dvStage.getBoundingClientRect();
    const r = dvInner.getBoundingClientRect();
    const p = localOf(e);
    const inside =
      p.x >= r.left - sr.left && p.x <= r.right - sr.left &&
      p.y >= r.top - sr.top && p.y <= r.bottom - sr.top;
    if (!inside) closeDiagramViewer();
  };
  dvStage.addEventListener("pointerup", endPointer);
  dvStage.addEventListener("pointercancel", endPointer);
  dvStage.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (Math.abs(dvZoom - dvFitZoom) > 0.01) dvFit();
    else dvCenterZoom(1);
  });
}

function openDiagramViewer(source) {
  const svg = source.querySelector("svg");
  if (!svg) return;
  ensureDiagramViewer();
  // the clone gets its natural size back: the on-page svg is width-capped, and
  // a max-width:100% box cannot be zoomed into anything readable
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const box = svg.getBoundingClientRect();
  const w = vb.length === 4 && vb[2] > 0 ? vb[2] : Math.round(box.width) || 800;
  const h = vb.length === 4 && vb[3] > 0 ? vb[3] : Math.round(box.height) || 600;
  const clone = svg.cloneNode(true);
  clone.removeAttribute("style");
  clone.setAttribute("width", w);
  clone.setAttribute("height", h);
  clone.style.width = w + "px";
  clone.style.height = h + "px";
  clone.style.maxWidth = "none";
  while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
  dvInner.appendChild(clone);
  dvOverlay.classList.add("open");
  dvFit(); // the stage has a size only once the overlay is displayed
  if (!dvHistoryEntry) {
    // an entry of our own, so the phone's back button closes the overlay
    // instead of walking out of the app
    try {
      history.pushState({ clutchDiagram: 1 }, "");
      dvHistoryEntry = true;
    } catch (e) {
      dvHistoryEntry = false;
    }
  }
}

function closeDiagramViewer() {
  if (!dvOverlay || !dvOverlay.classList.contains("open")) return;
  dvOverlay.classList.remove("open");
  while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
  if (dvHistoryEntry) {
    dvHistoryEntry = false;
    try {
      history.back(); // consume our entry (the popstate listener below no-ops)
    } catch (e) {}
  }
}

window.addEventListener("popstate", () => {
  if (dvHistoryEntry && dvOverlay && dvOverlay.classList.contains("open")) {
    dvHistoryEntry = false;
    dvOverlay.classList.remove("open");
    while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
  }
  dvHistoryEntry = false;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDiagramViewer();
});

document.addEventListener("click", (e) => {
  const t = e.target;
  const pre = t && t.closest ? t.closest("pre.mermaid-rendered") : null;
  if (pre && pre.querySelector("svg")) openDiagramViewer(pre);
});

// map a file extension to a highlight.js language id for bare <pre> results
const CODE_LANGS = {
  py: "python", js: "javascript", mjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", html: "xml", htm: "xml", xml: "xml",
  css: "css", scss: "scss", json: "json", md: "markdown", sh: "bash",
  bash: "bash", yaml: "yaml", yml: "yaml", c: "c", h: "c", cpp: "cpp",
  hpp: "cpp", go: "go", rs: "rust", java: "java", sql: "sql", rb: "ruby",
  php: "php", r: "r", diff: "diff",
};
function highlightPreByPath(pre, path) {
  if (typeof hljs === "undefined") return;
  const ext = String(path || "").split(".").pop().toLowerCase();
  const lang = CODE_LANGS[ext] || "";
  if (lang) pre.classList.add("language-" + lang);
  try {
    if (pre.querySelector("code")) {
      hljs.highlightElement(pre.querySelector("code"));
    } else {
      const code = document.createElement("code");
      code.textContent = pre.textContent;
      pre.textContent = "";
      pre.appendChild(code);
      hljs.highlightElement(code);
    }
  } catch (e) {}
}

