"use strict";

// Regression test for the streaming-render freeze: the renderer's rAF path
// re-rendered the whole accumulating block at 60fps — full marked re-parse,
// hljs over EVERY completed fence, MathJax over the whole block on any stray
// $..$ pair — which pegged the renderer main thread and froze the whole window
// (clicks queue, Stop included). The fix throttles renders to ~8fps, caches
// hljs output by code source, defers math to the flush, and bounds apiFetch.
//
// Unlike most runners here this one does NOT re-implement the logic: it
// extracts the real functions from ui/app.js and drives them against stubs, so
// a silent edit to app.js that regresses the fix fails this test.

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness.js");

const APP = path.join(__dirname, "..", "ui", "app.js");
const src = fs.readFileSync(APP, "utf8");

// ---- extraction helpers (parameter-list aware: find the body brace AFTER the
// signature's closing paren, so destructured params don't fool the scan) ----
function bodyEnd(open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error("unbalanced braces after offset " + open);
}
function sigBodyOpen(start) {
  let paren = 0, seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") { paren++; seen = true; }
    else if (src[i] === ")") paren--;
    else if (seen && paren === 0 && src[i] === "{") return i;
  }
  throw new Error("no function body found at offset " + start);
}
function fnBody(name) {
  let start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing function: " + name);
  if (src.slice(Math.max(0, start - 6), start) === "async ") start -= 6; // keep the async keyword
  return src.slice(start, bodyEnd(sigBodyOpen(start)));
}
function region(startMark, endName) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error("missing marker: " + startMark);
  const b = src.indexOf("function " + endName + "(");
  return src.slice(a, bodyEnd(sigBodyOpen(b)));
}

// ---- stub environment ----
let rafQ = [];
global.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
global.cancelAnimationFrame = (id) => { rafQ[id - 1] = null; };
const flushRaf = async () => { const q = rafQ; rafQ = []; for (const cb of q) if (cb) await cb(); };

let markdownCalls = 0, mathCalls = 0;
global.lastTextEl = null;
global.lastTextContent = "";
global.renderMarkdown = (t) => { markdownCalls++; return "<p>" + t + "</p>"; };
global.typesetMath = () => { mathCalls++; };
global.autoScroll = () => {};
global.stream = { classList: { contains: () => false } };
global.highlightCode = () => {}; // replaced by the real one below
function makeBlock() {
  return { querySelector: () => ({ set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ""; } }) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- load the real code ----
(0, eval)(region("let textRenderRaf = 0;", "flushTextRender"));
(0, eval)(region("const hlCache = new Map();", "highlightCode"));
(0, eval)(fnBody("apiFetch"));

(async () => {
  // ---- 1) throttle: 60fps rAF stream must collapse to <=8 renders/sec ----
  global.lastTextEl = makeBlock();
  scheduleTextRender(); await flushRaf(); await sleep(130); await flushRaf(); // warm-up primes textRenderLast
  await sleep(130);
  markdownCalls = 0; mathCalls = 0;

  // 12 delta frames at ~0ms apart: the old code rendered 12 times
  for (let i = 0; i < 12; i++) { global.lastTextContent += "x"; scheduleTextRender(); await flushRaf(); }
  check(markdownCalls <= 3, `throttle: 12 rapid deltas render <=3 times, not 12 (got ${markdownCalls})`);

  scheduleTextRender(); flushTextRender();
  check(markdownCalls >= 1, "flush forces a render even inside the throttle window");
  check(mathCalls === 1, "flush typesets math exactly once");
  mathCalls = 0; global.lastTextEl._mathDone = false; flushTextRender();
  check(mathCalls === 1, "flush without a pending render runs the owed math pass");
  mathCalls = 0; flushTextRender();
  check(mathCalls === 0, "_mathDone guard: bursty non-text events never re-typeset");

  // the streaming render itself never pays for math
  mathCalls = 0; global.lastTextEl._mathDone = false;
  scheduleTextRender(); await flushRaf(); await sleep(130); await flushRaf();
  check(mathCalls === 0, "streaming renders defer math to the flush");

  // ---- 2) hljs cache: completed fences highlight ONCE, not once per frame ----
  let hlCalls = 0;
  global.hljs = { highlightElement: (el) => { hlCalls++; el.innerHTML = "HL:" + el.textContent; } };
  global.renderMermaid = async () => {};
  const mkCode = (t) => ({ textContent: t, innerHTML: "" });
  const f1 = mkCode("const a = 1;"), f2 = mkCode("def f(): pass"), big = mkCode("y".repeat(20000));
  const root = { querySelectorAll: () => [f1, f2, big] };
  hlCalls = 0;
  highlightCode(root, true);
  check(hlCalls === 2, "streaming render: small fences highlight, oversized one defers (got " + hlCalls + ")");
  const afterFirst = hlCalls;
  highlightCode(root, true);
  highlightCode(root, true);
  check(hlCalls === afterFirst, "cached fences never re-highlight on later streaming frames");
  highlightCode(root, false);
  check(hlCalls === afterFirst + 1, "flush render picks up the deferred oversized fence");
  check(big.innerHTML === "HL:" + "y".repeat(20000), "deferred fence is highlighted after the flush");

  // ---- 3) apiFetch: bounded, and callers can tell abort from HTTP errors ----
  global.API_BASE = "http://unit.test";
  global.fetch = (url, opts) => new Promise((_, rej) => {
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError"; rej(e);
    });
  });
  const t0 = Date.now();
  let aborted = false;
  try { await apiFetch("/api/slow", { timeout: 60 }); } catch (e) { aborted = e.name === "AbortError"; }
  check(aborted && Date.now() - t0 < 1000, `apiFetch aborts at its timeout (60ms -> ${Date.now() - t0}ms)`);
  let sawSignal = false, sawBody = false, sawCt = false;
  global.fetch = async (url, opts) => {
    sawSignal = !!(opts && opts.signal);
    sawBody = opts && opts.body === JSON.stringify({ a: 1 });
    sawCt = !!(opts && opts.headers && opts.headers["Content-Type"] === "application/json");
    return { ok: true, json: async () => ({ fine: true }) };
  };
  const r = await apiFetch("/api/run", { method: "POST", body: { a: 1 } });
  check(r.fine && sawSignal && sawBody && sawCt, "apiFetch keeps method/body/headers and passes the signal");

  // ---- 4) source-level guards: the constants that make the fix what it is ----
  check(/TEXT_RENDER_MIN_MS = \d+/.test(src), "throttle window constant present in app.js");
  check(Number(src.match(/TEXT_RENDER_MIN_MS = (\d+)/)[1]) >= 100, "throttle window is at least ~100ms");
  check(/HL_STREAM_MAX = \d+/.test(src), "streaming fence size cap present");
  check(/_mathDone/.test(src), "math idempotence guard present");
  check(/timeout = \d+/.test(fnBody("apiFetch").slice(0, 200)), "apiFetch has a default timeout");

  summary("stream-render-test");
})().catch((e) => { console.error(e); process.exit(1); });
