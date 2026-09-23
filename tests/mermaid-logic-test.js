// Logic test for renderMermaid: streaming/parse gates, cache restore, dedupe.
//
// Like its siblings (stream-render / perm-args / tool-ui-protocol) this runner
// does NOT re-implement what it tests: it extracts the real isLastElement /
// initMermaidTheme / renderMermaid / showMermaidError out of ui/app.js and
// drives them against stubs. It used to carry a hand-copied mirror of that code,
// which had already drifted (no showMermaidError, no render-side parse-error
// gate, missing theme keys) — a green mirror said nothing about app.js.
"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const APP = path.join(__dirname, "..", "ui", "app.js");
const src = fs.readFileSync(APP, "utf8");
const { fnBody, region } = slicer(src);

// ---- stub environment ----
// app.js reads the theme off the live CSS (:root custom properties) instead of
// duplicating the palette and the font stack in JS; the stub shims the two
// globals it touches. The font stack is deliberately spelled the way
// ui/style.css spells it — multiline, with inline comments.
const CSS_VARS = {
  "--accent": "#EF4444",
  "--font-display": `"Clutch Icons",                                    /* bundled icon glyphs */
    "Archivo",
    "PingFang SC", "Microsoft YaHei",                                  /* mac + windows */
    "Noto Sans CJK SC",                                                /* linux */
    sans-serif`,
};
global.document = { documentElement: {}, createElement: () => makeEl() };
global.getComputedStyle = () => ({
  getPropertyValue: (name) => CSS_VARS[name] || "",
});
global.autoScroll = () => {};
global.followTail = false;

let renderCalls = 0;
let parseFail = false;
const initOptions = [];
global.mermaid = {
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

// a stub element good enough for showMermaidError (classList + querySelector +
// appendChild) and for the insertAdjacentHTML the render path uses
function makeEl() {
  const classes = new Set();
  const e = {
    nodeType: 1, // element node — real DOM nodes carry this, isLastElement depends on it
    dataset: {},
    textContent: "",
    isConnected: true,
    nextSibling: null,
    classList: { add: (c) => classes.add(c), has: (c) => classes.has(c) },
    classes,
    parentElement: null,
    innerHTML: "",
    child: null,
    appendChild(node) { e.child = node; },
    querySelector: () => e.child,
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

// ---- load the real code ----
// One eval: the module state (mermaidInitialized / mermaidCache) and the
// functions that close over it must land in the same scope. The two globals the
// test itself has to poke are re-exported through a handle.
(0, eval)(region("let mermaidInitialized = false;", "showMermaidError") + `
globalThis.__mermaid = {
  cache: mermaidCache,
  resetInit: () => { mermaidInitialized = false; },
};`);
const mermaidCache = globalThis.__mermaid.cache;
const resetMermaidInit = globalThis.__mermaid.resetInit;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // label-first ok(name, cond) reads better in this runner; the failure count and
  // the final verdict come from the shared harness
  const ok = (name, cond) => check(cond, name);

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
  ok("parse gate: the failure is reported to the user", root5.pres[0].classes.has("mermaid-failed")
    && root5.pres[0].child && /Invalid diagram syntax/.test(root5.pres[0].child.textContent));
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
  ok("gantt task fill uses mermaid10 BkgColor key", tv.taskBkgColor === "#2d2d33" && tv.taskBkg === "#2d2d33");
  ok("gantt active = red fill + dark text (running)", tv.activeTaskBkgColor === "#EF4444" && tv.activeTaskBkg === "#EF4444" && tv.activeTaskTextColor === "#0F0F10");
  ok("gantt done = dark fill + grey border (archived)", tv.doneTaskBkgColor === "#1c1c1f" && tv.doneTaskBorderColor === "#52525b" && tv.doneTaskTextColor === "#a1a1aa");
  ok("gantt text is light grey not white", tv.taskTextColor === "#d4d4d8" && tv.taskTextLightColor === "#d4d4d8");
  ok("note fill is neutral dark (no yellow)", tv.noteBkgColor === "#1c1c1f");
  ok("pie first slice is the red accent", tv.pie1 === "#EF4444" && tv.pie2 === "#27272a" && tv.pie12 === "#ededf0");
  ok("pie has no unused pie0", tv.pie0 === undefined);
  ok("git palette grayscale + red", tv.git0 === "#EF4444" && tv.git3 === "#3f3f46");
  // diagram labels are text: mermaid's own default is a bare "Arial", which each
  // OS resolves with a different face, so the charts drifted like the rest of the UI
  ok("diagram labels use the UI font stack (not mermaid's Arial default)",
    typeof tv.fontFamily === "string" && tv.fontFamily.includes("Clutch Icons") && tv.fontFamily.includes("Archivo"));
  // --font-display carries inline /* comments */ and newlines; mermaid re-emits
  // the raw string into a <style> block and inline styles, so it must be flat
  ok("diagram font starts with the bundled icon face (icons inside labels too)",
    typeof tv.fontFamily === "string" && tv.fontFamily.startsWith('"Clutch Icons"'));
  ok("diagram font handed to mermaid is flattened (no comment, no newline)",
    typeof tv.fontFamily === "string" && !tv.fontFamily.includes("/*") && !tv.fontFamily.includes("*")
      && !tv.fontFamily.includes("\n") && !tv.fontFamily.includes("  "));
  // the parser's own error path would paint its giant error diagram into the page
  ok("mermaid.parseError is overridden to a warning", typeof mermaid.parseError === "function");

  // 8. cache cap: overflow clears and re-renders (use a fresh uncached source)
  for (let i = 0; i < 110; i++) mermaidCache.set("k" + i, "v");
  const srcNew = "graph LR\nX-->Y";
  const root7 = makeRoot([srcNew]);
  renderMermaid(root7, false);
  await sleep(10);
  ok("cache overflow clears and re-renders", renderCalls === 4);
  ok("overflow dropped stale entries, new one cached", mermaidCache.size === 1 && mermaidCache.has(srcNew));

  // 9. a missing --font-display must fall back to a generic keyword, not to ""
  // (an empty font-family leaves mermaid's own Arial in charge of the diagram)
  delete CSS_VARS["--font-display"];
  resetMermaidInit();
  renderMermaid(makeRoot(["graph TD\nH-->I"]), false);
  await sleep(10);
  ok("missing --font-display falls back to sans-serif",
    initOptions[1] !== undefined && initOptions[1].themeVariables.fontFamily === "sans-serif");

  summary("mermaid-logic", "ALL PASS");
})().catch((e) => { console.error(e); process.exit(1); });
