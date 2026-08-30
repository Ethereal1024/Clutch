// Logic test for renderMermaid: streaming gate (skip last unclosed block),
// parse gate (broken source stays literal), cache-hit restore, in-flight dedupe.
// Mirrors the function in ui/app.js (node cannot require the real mermaid UMD —
// it touches `document` at module top-level; the browser is fine).
"use strict";

let mermaidInitialized = false;
const mermaidCache = new Map();
let renderCalls = 0;
let parseFail = false;
const initOptions = [];

const mermaid = {
  initialize(opts) { initOptions.push(opts); },
  parse() {
    if (parseFail) throw new Error("parse error");
    return true;
  },
  render(id, src) {
    renderCalls++;
    return Promise.resolve({ svg: "<svg>" + src + "</svg>" });
  },
};

function makeEl() {
  const e = {
    nodeType: 1, // element node — real DOM nodes carry this, isLastElement depends on it
    dataset: {},
    textContent: "",
    isConnected: true,
    nextSibling: null,
    classList: { add() {} },
    parentElement: null,
    innerHTML: "",
    insertAdjacentHTML(_p, h) { e.innerHTML = h; },
  };
  return e;
}

// sources become pre elements chained via nextSibling (element nodes), so
// isLastElement sees them as "content after the block"
function makeRoot(sources) {
  const pres = sources.map(() => makeEl());
  pres.forEach((pre, i) => {
    pre.textContent = sources[i];
    if (i + 1 < pres.length) pre.nextSibling = pres[i + 1];
  });
  const root = { pres };
  root.querySelectorAll = () =>
    sources.map((s, i) => {
      const code = makeEl();
      code.textContent = s;
      code.parentElement = pres[i];
      return code;
    });
  return root;
}

function isLastElement(pre) {
  let n = pre.nextSibling;
  while (n) {
    if (n.nodeType === 1) return false;
    if (n.nodeType === 3 && n.textContent.trim()) return false;
    n = n.nextSibling;
  }
  return true;
}

function renderMermaid(root, streaming = false) {
  if (typeof mermaid === "undefined" || !root) return;
  if (!mermaidInitialized) {
    mermaidInitialized = true;
    const accent = "#EF4444";
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      themeVariables: {
        lineColor: accent,
        primaryBorderColor: accent,
        secondaryBorderColor: accent,
        tertiaryBorderColor: accent,
        actorBorder: accent,
        actorLineColor: accent,
        signalColor: accent,
        labelBoxBorderColor: accent,
        noteBorderColor: accent,
        activationBorderColor: accent,
        taskBorderColor: accent,
        taskBkg: "#2d2d33",
        activeTaskBorderColor: accent,
        activeTaskBkg: "#2d2d33",
        activeTaskTextColor: "#d4d4d8",
        doneTaskBorderColor: accent,
        doneTaskBkg: "#2d2d33",
        doneTaskTextColor: "#d4d4d8",
        todayLineColor: accent,
        clusterBorder: accent,
        noteBkgColor: "#1c1c1f",
        noteTextColor: "#d4d4d8",
        edgeLabelBackground: "#1c1c1f",
        clusterBkg: "#1c1c1f",
        taskBkg: "#2d2d33",
        taskTextOutsideColor: "#a1a1aa",
        activationBkgColor: "#27272a",
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
  }
  const pending = [];
  root.querySelectorAll("pre code.language-mermaid").forEach((code) => {
    const pre = code.parentElement;
    if (!pre) return;
    const src = code.textContent;
    if (pre.dataset.mermaidSrc === src) return;
    const cached = mermaidCache.get(src);
    if (cached) {
      pre.classList.add("mermaid-rendered");
      pre.textContent = "";
      pre.insertAdjacentHTML("beforeend", cached);
      pre.dataset.mermaidSrc = src;
      return;
    }
    if (streaming && isLastElement(pre)) return;
    let parsed = false;
    try { mermaid.parse(src); parsed = true; } catch (e) {}
    if (!parsed) {
      pre.dataset.mermaidSrc = src;
      return;
    }
    pre.dataset.mermaidSrc = src;
    pending.push({ pre, src });
  });
  for (const { pre, src } of pending) {
    mermaid.render("mmd-" + Math.random().toString(36).slice(2), src).then(
      ({ svg }) => {
        if (mermaidCache.size > 100) mermaidCache.clear();
        mermaidCache.set(src, svg);
        let target = null;
        for (const el of root.querySelectorAll("pre code.language-mermaid")) {
          if (el.textContent === src) { target = el.parentElement; break; }
        }
        if (target) {
          target.classList.add("mermaid-rendered");
          target.textContent = "";
          target.insertAdjacentHTML("beforeend", svg);
          target.dataset.mermaidSrc = src;
        }
      },
      () => {
        if (pre.isConnected) delete pre.dataset.mermaidSrc;
      }
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let fail = 0;
  const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + " " + name); if (!cond) fail++; };

  const srcA = "graph TD\nA-->B";
  const srcB = "sequenceDiagram\nA->>B: hi";

  // 1. streaming: single block is the LAST element — fence may be open, skip (no parse, no render)
  const root1 = makeRoot([srcA]);
  renderMermaid(root1, true);
  ok("streaming: last block skipped, nothing rendered", renderCalls === 0);
  ok("streaming: last block not marked done", root1.pres[0].dataset.mermaidSrc === undefined);

  // 2. streaming: first of two blocks has content after it -> render; last still skipped
  const root2 = makeRoot([srcA, srcB]);
  renderMermaid(root2, true);
  await sleep(10);
  ok("streaming: non-last block renders", renderCalls === 1);
  ok("streaming: non-last block svg restored", root2.pres[0].innerHTML === "<svg>" + srcA + "</svg>");
  ok("streaming: last of two still skipped", root2.pres[1].dataset.mermaidSrc === undefined);

  // 3. static pass (user message / replay / final): last block renders too
  const root3 = makeRoot([srcB]);
  renderMermaid(root3, false);
  await sleep(10);
  ok("static: last block renders", renderCalls === 2);
  ok("static: svg restored", root3.pres[0].innerHTML === "<svg>" + srcB + "</svg>");

  // 4. streaming rebuild (new DOM, same source): cache restores synchronously
  const root4 = makeRoot([srcA]);
  renderMermaid(root4, true);
  ok("cache hit restores without re-render", renderCalls === 2);
  ok("cache-restored svg present", root4.pres[0].innerHTML === "<svg>" + srcA + "</svg>");

  // 5. parse gate: broken source stays literal, marked done, not cached
  parseFail = true;
  const srcBad = "graph TD\nA--";
  const root5 = makeRoot([srcBad]);
  renderMermaid(root5, false);
  await sleep(10);
  ok("parse gate: broken source not rendered", renderCalls === 2);
  ok("parse gate: broken source marked done (no re-parse loop)", root5.pres[0].dataset.mermaidSrc === srcBad);
  ok("parse gate: literal source kept", root5.pres[0].textContent === srcBad);
  ok("parse gate: broken source not cached", mermaidCache.has(srcBad) === false);
  parseFail = false;

  // 6. different valid diagram after fix renders
  const srcFixed = "graph TD\nA-->B\nB-->C";
  const root6 = makeRoot([srcFixed]);
  renderMermaid(root6, false);
  await sleep(10);
  ok("valid source after fix renders", renderCalls === 3);

  // 7. theme init carries the accent colours across every diagram type
  ok("theme initialized once", initOptions.length === 1);
  const tv = initOptions[0].themeVariables;
  ok("theme uses accent for strokes", tv.lineColor === "#EF4444");
  ok("sequence actor border is accent", tv.actorBorder === "#EF4444");
  ok("gantt task border is accent", tv.taskBorderColor === "#EF4444");
  ok("gantt active task border is accent", tv.activeTaskBorderColor === "#EF4444" && tv.activeTaskBkg === "#2d2d33");
  ok("gantt done task border is accent", tv.doneTaskBorderColor === "#EF4444" && tv.doneTaskBkg === "#2d2d33");
  ok("note fill is neutral dark (no yellow)", tv.noteBkgColor === "#1c1c1f");
  ok("pie first slice is the red accent", tv.pie1 === "#EF4444" && tv.pie2 === "#27272a" && tv.pie12 === "#ededf0");
  ok("pie has no unused pie0", tv.pie0 === undefined);
  ok("git palette grayscale + red", tv.git0 === "#EF4444" && tv.git3 === "#3f3f46");

  // 8. cache cap: overflow clears and re-renders (use a fresh uncached source)
  for (let i = 0; i < 110; i++) mermaidCache.set("k" + i, "v");
  const srcNew = "graph LR\nX-->Y";
  const root7 = makeRoot([srcNew]);
  renderMermaid(root7, false);
  await sleep(10);
  ok("cache overflow clears and re-renders", renderCalls === 4);
  ok("overflow dropped stale entries, new one cached", mermaidCache.size === 1 && mermaidCache.has(srcNew));

  console.log(fail ? "FAILED" : "ALL PASS");
  process.exit(fail ? 1 : 0);
})();
