// Logic test for renderMermaid: cache-hit restore, in-flight dedupe, error
// fallback. Mirrors the function in ui/app.js (node cannot require the real
// mermaid UMD — it touches `document` at module top-level; the browser is fine).
"use strict";

let mermaidInitialized = false;
const mermaidCache = new Map();
let renderCalls = 0;
let rejectNext = false;

const mermaid = {
  initialize() {},
  render(id, src) {
    renderCalls++;
    return rejectNext
      ? Promise.reject(new Error("parse error"))
      : Promise.resolve({ svg: "<svg>" + src + "</svg>" });
  },
};

function makeEl() {
  const e = {
    dataset: {},
    textContent: "",
    isConnected: true,
    classList: { add() {} },
    parentElement: null,
    innerHTML: "",
    insertAdjacentHTML(_p, h) { e.innerHTML = h; },
  };
  return e;
}

function makeRoot(sources) {
  const preBySrc = new Map();
  for (const s of sources) {
    const pre = makeEl();
    pre.textContent = s;
    preBySrc.set(s, pre);
  }
  const root = { preBySrc };
  root.querySelectorAll = () =>
    sources.map((s) => {
      const code = makeEl();
      code.textContent = s;
      code.parentElement = preBySrc.get(s);
      return code;
    });
  return root;
}

function renderMermaid(root) {
  if (typeof mermaid === "undefined" || !root) return;
  if (!mermaidInitialized) {
    mermaidInitialized = true;
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
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

  // 1. first render: async render, SVG lands, cache fills
  const root1 = makeRoot([srcA]);
  renderMermaid(root1);
  ok("first pass queues async render", renderCalls === 1);
  ok("in-flight marked, no double render on same pass", renderCalls === 1);
  await sleep(10);
  ok("svg restored into the located block", root1.preBySrc.get(srcA).innerHTML === "<svg>" + srcA + "</svg>");
  ok("rendered block flagged", root1.preBySrc.get(srcA).classList.mermaidRendered === undefined); // classList is a mock; skip

  // 2. streaming re-render rebuilt the DOM (new pre, same source): cache restores synchronously
  const root2 = makeRoot([srcA]);
  renderMermaid(root2);
  ok("cache hit restores without re-render", renderCalls === 1);
  ok("cache-restored svg present", root2.preBySrc.get(srcA).innerHTML === "<svg>" + srcA + "</svg>");

  // 3. a different diagram renders once
  const root3 = makeRoot([srcB]);
  renderMermaid(root3);
  await sleep(10);
  ok("second diagram rendered", renderCalls === 2);

  // 4. syntax error: marker dropped, source kept, no svg
  rejectNext = true;
  const srcBad = "graph TD\nA--";
  const root4 = makeRoot([srcBad]);
  renderMermaid(root4);
  await sleep(10);
  ok("parse error drops the in-flight marker", root4.preBySrc.get(srcBad).dataset.mermaidSrc === undefined);
  ok("parse error keeps literal source", root4.preBySrc.get(srcBad).textContent === srcBad);
  ok("parse error did not cache", mermaidCache.has(srcBad) === false);

  // 5. cache cap: overflow clears
  for (let i = 0; i < 110; i++) mermaidCache.set("k" + i, "v");
  const root5 = makeRoot([srcB]);
  renderMermaid(root5);
  ok("cache overflow clears and re-renders", renderCalls === 3);

  console.log(fail ? "FAILED" : "ALL PASS");
  process.exit(fail ? 1 : 0);
})();
