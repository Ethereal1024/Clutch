"use strict";

// Regression test for the streaming-render freeze: the renderer's rAF path
// re-rendered the whole accumulating block at 60fps — full marked re-parse,
// hljs over EVERY completed fence, MathJax over the whole block on any stray
// $..$ pair — which pegged the renderer main thread and froze the whole window
// (clicks queue, Stop included). The fix throttles renders to ~8fps, caches
// hljs output by code source, defers math to the flush, and bounds apiFetch.
//
// Unlike most runners here this one does NOT re-implement the logic: it
// extracts the real functions from the renderer and drives them against stubs, so
// a silent change that regresses the fix fails this test.

const { check, summary, slicer, uiSource } = require("./harness.js");

const src = uiSource(); // the renderer, every module in page load order
const { fnBody, region } = slicer(src);

// ---- stub environment ----
let rafQ = [];
global.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
global.cancelAnimationFrame = (id) => { rafQ[id - 1] = null; };
const flushRaf = async () => { const q = rafQ; rafQ = []; for (const cb of q) if (cb) await cb(); };

let markdownCalls = 0, mathCalls = 0, autoScrollCalls = 0;
global.lastTextEl = null;
global.lastTextContent = "";
global.renderMarkdown = (t) => { markdownCalls++; return "<p>" + t + "</p>"; };
global.typesetMath = () => { mathCalls++; };
// every autoScroll is a scrollHeight read over the whole transcript: a forced
// layout. Counted, because "per delta" vs "per frame" is exactly the bug.
global.autoScroll = () => { autoScrollCalls++; };
global.stream = { classList: { contains: () => false } };
global.highlightCode = () => {}; // replaced by the real one below
function makeBlock() {
  return { querySelector: () => ({ set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ""; } }) };
}
// A stub DOM node for the reasoning test. className and textContent are the two
// properties buildThinkingBlock/renderThinkingBlock actually touch, and
// classList answers from the same set as className so that
// `fold.classList.contains("hidden")` means what the block set. textContent
// reads back what a real <pre> would show (own text plus appended text nodes),
// so an "append, do not rewrite" fix is visible as appends/rewrites counts.
function makeNode() {
  const cls = new Set();
  const node = { innerHTML: "", _t: "", text: "", children: [], appends: 0, rewrites: 0 };
  Object.defineProperty(node, "className", {
    get: () => [...cls].join(" "),
    set: (v) => { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
  });
  Object.defineProperty(node, "textContent", {
    get() { return this._t + this.children.map((c) => c.textContent || "").join(""); },
    set(v) { this.rewrites++; this._t = String(v); this.children = []; },
  });
  node.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
  node.appendChild = function (n) {
    this.children.push(n);
    this.appends++;
    if (n && n.nodeType === 3) this.text += n.textContent; // what a text node adds
    return n;
  };
  return node;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- load the real code ----
(0, eval)(region("let textRenderRaf = 0;", "flushTextRender"));
(0, eval)(region("let thinkingRenderRaf = 0;", "flushThinkingRender"));
(0, eval)(region("const FOLD_EASE", "buildThinkingBlock"));
(0, eval)(region("const hlCache = new Map();", "highlightCode"));
(0, eval)(fnBody("noBackend"));
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

  // a null base (supervisor mid-spawn) is NOT an error the app can catch at the
  // fetch layer: `null + "/api/host"` is the relative URL "null/api/host" and
  // resolves against whatever origin served the UI. The request must never
  // leave, and the failure must look like an unreachable backend.
  global.API_BASE = null;
  let sent = null;
  global.fetch = async (url) => { sent = url; return { ok: true, json: async () => ({}) }; };
  let noBase = null;
  try { await apiFetch("/api/host"); } catch (e) { noBase = e; }
  check(sent === null, `no request is sent without a base (saw ${JSON.stringify(sent)})`);
  check(noBase && noBase.code === "no_backend" && noBase.status === undefined,
        "apiFetch throws no_backend (no .status) so callers take their unreachable path");

  // ---- 4) source-level guards: the constants that make the fix what it is ----
  check(/TEXT_RENDER_MIN_MS = \d+/.test(src), "throttle window constant present in the renderer");
  check(Number(src.match(/TEXT_RENDER_MIN_MS = (\d+)/)[1]) >= 100, "throttle window is at least ~100ms");
  check(/HL_STREAM_MAX = \d+/.test(src), "streaming fence size cap present");
  check(/_mathDone/.test(src), "math idempotence guard present");
  check(/if \(!API_BASE\) throw noBackend\(\)/.test(src),
        "the raw NDJSON stream in openProject guards its base too");
  check(/timeout = \d+/.test(fnBody("apiFetch").slice(0, 200)), "apiFetch has a default timeout");

  // ---- 5) reasoning: one render per frame, and an open block APPENDS ----
  //
  // The second freeze, reported as "thinking stops counting, the block will not
  // open, then everything lands at once": the reasoning path wrote the label, the
  // block's own copy and a tail pin ON EVERY DELTA, and each of those writes
  // forces a layout (the label's width, then autoScroll's scrollHeight read over a
  // transcript that grows for the whole turn). Thousands of forced layouts saturate
  // the renderer: the counter stops, the click queues, the queue drains in one
  // burst. The reasoning path now renders the way the text path does — at most one
  // pass per frame, with an open <pre> receiving only what arrived since the last
  // pass.
  global.document = { createElement: makeNode, createTextNode: (t) => ({ nodeType: 3, textContent: t }) };
  global.window = { matchMedia: () => ({ matches: true }) }; // collapse folds instantly: no WAAPI here

  const label = makeNode(), full = makeNode(), fold = makeNode();
  fold.className = "fold"; // open: a reader is watching it grow
  full._drawn = 0; // what buildThinkingBlock("", "") leaves on a live block
  global.thinkingEl = { querySelector: (s) => (s === ".thinking-label" ? label : s === ".thinking-full" ? full : s === ".fold" ? fold : null) };
  global.thinkingContent = "a";
  renderThinkingBlock(true); // warm-up: primes the throttle clock, like the first frame
  check(label.textContent === "thinking… 1 chars", "the counter renders on the warm-up frame");
  check(full.textContent === "a" && full._drawn === 1, "the open <pre> is drawn and the append mark set");

  // 12 deltas, no frame in between: not one write may happen per delta
  label.rewrites = 0; full.rewrites = 0; full.appends = 0; autoScrollCalls = 0;
  for (let i = 0; i < 12; i++) { global.thinkingContent += "x"; scheduleThinkingRender(); }
  check(label.rewrites === 0 && full.rewrites === 0 && autoScrollCalls === 0,
        `12 reasoning deltas in one frame do no DOM work at all (label ${label.rewrites}, pre ${full.rewrites}, pins ${autoScrollCalls})`);
  flushThinkingRender(); // the next non-reasoning event is the end of this stream
  check(label.rewrites === 1 && autoScrollCalls === 1,
        "the flush renders the whole burst exactly once (one pass, one pin)");
  check(label.textContent === "thinking… 13 chars", "the flush lands the counter on the full length");
  check(full._content === global.thinkingContent, "the block's own copy is current, so a click expands to everything");

  // an open block appends the tail; rewriting the whole <pre> per frame is the
  // O(n²) the text block was already fixed for
  full.rewrites = 0; full.appends = 0; full.text = "";
  for (let i = 0; i < 5; i++) global.thinkingContent += "y";
  scheduleThinkingRender(); await sleep(130); await flushRaf();
  check(full.appends === 1 && full.rewrites === 0, "an open reasoning block APPENDS the new tail (1 append, 0 rewrites)");
  check(full.text === "yyyyy", "the appended tail is exactly what arrived since the last pass");
  check(full.textContent === global.thinkingContent && full._drawn === global.thinkingContent.length,
        "the block reads back as the whole reasoning text, and the mark follows it");
  scheduleThinkingRender(); await sleep(130); await flushRaf(); // a frame with nothing new
  check(full.appends === 1, "an idle frame appends nothing (no empty text node per frame)");

  // the replay and the click-expand carry the same mark, or the next live pass
  // would append onto text the <pre> already shows
  const live = buildThinkingBlock("", ""); // the block the live stream starts with
  check(live.full._drawn === 0, "a live reasoning block starts with the append mark at 0");
  const replay = buildThinkingBlock("thinking", "abc"); // stored assistant_message.reasoning
  check(replay.full._drawn === 3, "a replayed block marks its text as already drawn");
  replay.el.children[0].onclick(); // the fold-toggle row: expand
  check(replay.full.textContent === "abc" && replay.full._drawn === replay.full.textContent.length,
        "expanding re-syncs the append mark to what the <pre> shows");

  // ---- 6) source-level guards: the caller must stay on the coalesced path ----
  const rBranch = src.slice(src.indexOf('if (ev.type === "reasoning_delta"'), src.indexOf('if (ev.type === "step_start"'));
  const rCode = rBranch.replace(/\/\/[^\n]*/g, ""); // prose mentions the very writes it warns about
  check(/scheduleThinkingRender\(\)/.test(rCode), "reasoning deltas are handed to the coalesced render");
  check(!/querySelector|textContent|autoScroll/.test(rCode),
        "the reasoning branch writes no DOM of its own: no label write, no <pre> rewrite, no tail pin");
  check(/ev\.type !== "reasoning_delta"\) flushThinkingRender\(\)/.test(src),
        "every non-reasoning event flushes a pending reasoning render");
  check(/if \(thinkingRenderRaf\) \{ cancelAnimationFrame\(thinkingRenderRaf\)/.test(src),
        "a discarded live partial cancels its pending reasoning render too");
  check(Number((src.match(/THINKING_RENDER_MIN_MS = (\d+)/) || [])[1]) >= 100,
        "the reasoning path carries the same ~100ms+ throttle window as the text path");
  check(full._drawn !== undefined && /full\._drawn = thinkingContent\.length/.test(src),
        "the append mark is what the render pass maintains");

  summary("stream-render-test");
})().catch((e) => { console.error(e); process.exit(1); });
