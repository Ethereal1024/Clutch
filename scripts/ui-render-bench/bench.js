// Benchmark driver for bench.html — drives verbatim copies of ui/app.js's
// streaming render path and reports timings as JSON back to run.py.
/* global marked, DOMPurify, hljs, mermaid, MathJax */

const stream = document.getElementById("stream");
const eventsEl = document.getElementById("events");
const RESULTS = [];
function post(exp, data) {
  const payload = { exp, ...data };
  RESULTS.push(payload);
  return fetch("/__bench", { method: "POST", body: JSON.stringify(payload) }).catch(() => {});
}

// ---------------------------------------------------------------- app copies
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// verbatim from ui/app.js renderMarkdown
function renderMarkdown(text, breaks = false) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  try {
    const src = String(text);
    const math = [];
    const protectedSrc = src.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => {
      math.push(m);
      return `⟦MATH${math.length - 1}⟧`;
    });
    const html = breaks ? marked.parse(protectedSrc, { breaks: true }) : marked.parse(protectedSrc);
    const restored = html.replace(/⟦MATH(\d+)⟧/g, (_, i) => math[+i]);
    return DOMPurify.sanitize(restored);
  } catch (e) {
    return escapeHtml(text);
  }
}

// verbatim constants + hljs half of highlightCode from ui/app.js
const hlCache = new Map();
const HL_CACHE_MAX = 64;
const HL_STREAM_MAX = 16384;
const HL_CACHE_MAX_SRC = 131072;

function highlightPre(root, streaming = false) {
  root.querySelectorAll("pre code").forEach((el) => {
    const src = el.textContent;
    const cached = hlCache.get(src);
    if (cached !== undefined) {
      if (el.innerHTML !== cached) el.innerHTML = cached;
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
}

// verbatim from ui/app.js autoScroll, tail-latched branch only
function autoScroll() {
  stream.scrollTop = stream.scrollHeight;
}

// verbatim throttle + renderTextBlock from ui/app.js (mermaid/math hooks kept)
let textRenderRaf = 0;
let textRenderLast = 0;
const TEXT_RENDER_MIN_MS = 120;
let lastTextEl = null;
let lastTextContent = "";
let stats = { renders: 0, forced: 0, renderMs: 0, maxRenderMs: 0 };
let typesetDeferred = 0;

function renderTextBlock(force = false) {
  textRenderRaf = 0;
  const now = performance.now();
  if (!force && now - textRenderLast < TEXT_RENDER_MIN_MS) {
    textRenderRaf = requestAnimationFrame(() => renderTextBlock(false));
    return;
  }
  textRenderLast = now;
  if (!lastTextEl) return;
  const t0 = performance.now();
  const bodyEl = lastTextEl.querySelector(".body");
  bodyEl.innerHTML = renderMarkdown(lastTextContent);
  lastTextEl._mathDone = false;
  highlightPre(lastTextEl);
  typesetDeferred++;
  const dt = performance.now() - t0;
  stats.renders++;
  if (force) stats.forced++;
  stats.renderMs += dt;
  if (dt > stats.maxRenderMs) stats.maxRenderMs = dt;
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
  }
}

// ------------------------------------------------------------- content model
// A realistic coding-agent answer: CJK prose (the face this app actually
// renders), inline code, a python fence, a list, a table, one display formula.
function codeFence(lang, lines) {
  const body = [];
  for (let i = 0; i < lines; i++) {
    body.push(`    if self.${"x" + i} and cache.get("${"key" + i}") is not None:`);
    body.push(`        # 说明：第 ${i} 条规则，含中文注释与 ${i * 7} 个字符`);
    body.push(`        log.append({"step": ${i}, "ok": True})`);
  }
  return "```" + lang + "\n" + body.join("\n") + "\n```\n";
}
function para(seed) {
  return (
    `第 ${seed} 段说明：这里的处理链路是 \`applyStreamEvent\` → \`scheduleTextRender\` → ` +
    "`renderTextBlock`，每次渲染都会把整个累积文本重新交给 marked 解析、" +
    "再用 DOMPurify 清洗，然后整体重建 DOM。中文正文大约每段有一百二十个汉字左右，" +
    "夹杂 inline code 与英文术语（EventSource、SSE、chunked、RemoteProtocolError），" +
    "以及行内公式 $O(n^2)$ 和下标 $a_{" + seed + "}$。\n\n"
  );
}
function table(seed) {
  let s = `| 阶段 | 第 ${seed} 组 | 耗时 |\n| --- | --- | --- |\n`;
  for (let i = 0; i < 6; i++) s += `| stage-${i} | 说明文字 ${seed}-${i} | ${i * 12} ms |\n`;
  return s + "\n";
}
function makeAnswer(targetBytes, opts = {}) {
  const parts = [];
  let n = 0;
  const size = () => parts.join("").length;
  while (size() < targetBytes) {
    n++;
    parts.push(`## ${n}. 小结与改动说明\n\n`);
    parts.push(para(n));
    parts.push("- 第一条：缓存未命中时整体重建 DOM\n- 第二条：节流只能限制频率，不能限制单次成本\n\n");
    if (n % 2 === 0) parts.push(codeFence("python", opts.fenceLines || 12));
    if (n % 3 === 0) parts.push(table(n));
    if (n % 2 === 1) parts.push("$$\n\\sum_{i=1}^{n} \\frac{1}{i^2} = \\frac{\\pi^2}{6}\n$$\n\n");
  }
  return parts.join("").slice(0, targetBytes);
}

// ------------------------------------------------------------------- helpers
function bench(fn, reps = 3) {
  const out = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  out.sort((a, b) => a - b);
  return { med: out[(out.length - 1) >> 1], min: out[0], max: out[out.length - 1] };
}

// a fresh agent text block, like createAgentTextBlock()
function newBlock() {
  const wrap = document.createElement("div");
  wrap.className = "event text";
  wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
  eventsEl.appendChild(wrap);
  return wrap;
}

// event-loop lag probe: how long a pending timer (== a queued input event)
// waits before the main thread gets to it
let lagMax = 0;
let lagSamples = 0;
let lagTimer = 0;
function startLagProbe() {
  lagMax = 0;
  lagSamples = 0;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    lagSamples++;
    if (dt > lagMax) lagMax = dt;
    lagTimer = setTimeout(tick, 0);
  };
  lagTimer = setTimeout(tick, 0);
}
function stopLagProbe() {
  clearTimeout(lagTimer);
  return { lagMaxMs: +lagMax.toFixed(1), lagSamples };
}

// --------------------------------------------------------------- experiment 1
// per-stage cost of ONE full streaming re-render, by answer size
async function experimentStages(sizes) {
  for (const size of sizes) {
    const text = makeAnswer(size, { fenceLines: Math.max(6, Math.round(size / 6000)) });
    const rows = {};
    // fresh DOM for every measurement
    const rebuild = () => {
      eventsEl.innerHTML = "";
      const wrap = newBlock();
      wrap.querySelector(".body").innerHTML = renderMarkdown(text);
      return wrap;
    };
    let wrap = rebuild();

    rows.bytes = text.length;
    rows.fences = wrap.querySelectorAll("pre code").length;
    rows.fenceChars = Array.from(wrap.querySelectorAll("pre code")).reduce((a, e) => a + e.textContent.length, 0);

    // A. marked + DOMPurify (the string pipeline)
    rows.markdownMs = +bench(() => renderMarkdown(text), 3).med.toFixed(1);
    const html = renderMarkdown(text);

    // B. the DOM rebuild the streaming path does every render
    rows.innerHtmlMs = +bench(() => {
      wrap.querySelector(".body").innerHTML = html;
    }, 3).med.toFixed(1);

    // C. forced layout: the scrollTop/scrollHeight pair autoScroll() does
    rows.layoutMs = +bench(() => autoScroll(), 5).med.toFixed(1);

    // D. highlight.js, cold cache (fresh source text each time)
    hlCache.clear();
    rows.hlColdMs = +bench(() => {
      const b = rebuild();
      highlightPre(b);
    }, 2).med.toFixed(1);

    // E. highlight.js, warm cache (the steady state while streaming)
    rows.hlWarmMs = +bench(() => {
      wrap.querySelector(".body").innerHTML = html;
      highlightPre(wrap);
    }, 3).med.toFixed(1);

    // F. the whole renderTextBlock body, warm DOM (flush render: streaming=false)
    const bodyEl = wrap.querySelector(".body");
    rows.fullRenderMs = +bench(() => {
      bodyEl.innerHTML = renderMarkdown(text);
      highlightPre(wrap);
      autoScroll();
    }, 3).med.toFixed(1);

    // G. the same, as the STREAMING render calls it (highlightCode(root, true):
    // fences over 16 KB are left to the flush)
    rows.streamRenderMs = +bench(() => {
      bodyEl.innerHTML = renderMarkdown(text);
      highlightPre(wrap, true);
      autoScroll();
    }, 3).med.toFixed(1);

    rows.totalHtmlChars = html.length;
    await post("stages", rows);
    eventsEl.innerHTML = "";
  }
}

// --------------------------------------------------------------- experiment 2
// the transcript in front of the block: does an existing long transcript make
// every re-render more expensive?
async function experimentDomDepth(counts) {
  for (const n of counts) {
    eventsEl.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const el = document.createElement("div");
      el.className = i % 3 === 0 ? "event tool" : "event text";
      el.innerHTML =
        '<div class="hdr">agent</div><div class="body"><p>' +
        "历史事件占位文本，用来模拟一个已经滚了很多屏的会话。" +
        "</p><pre><code>const x = " + i + ";</code></pre></div>";
      eventsEl.appendChild(el);
    }
    const text = makeAnswer(16384, { fenceLines: 3 });
    const wrap = newBlock();
    const bodyEl = wrap.querySelector(".body");
    const cost = bench(() => {
      bodyEl.innerHTML = renderMarkdown(text);
      highlightPre(wrap);
      autoScroll();
    }, 3).med;
    await post("domDepth", {
      priorEvents: n,
      domNodes: eventsEl.querySelectorAll("*").length,
      renderMs: +cost.toFixed(1),
      layoutOnlyMs: +bench(() => autoScroll(), 5).med.toFixed(1),
      streamScrollHeight: stream.scrollHeight,
    });
  }
  eventsEl.innerHTML = "";
}

// --------------------------------------------------------------- experiment 3
// real-time stream simulation: 60 deltas/s (16 ms apart, 40 chars each) with
// the app's 120 ms throttle, optionally with an interloping non-text event
// (state_update / tool_call_delta) that hits flushTextRender() — the forced
// path that bypasses the throttle.
function streamSim(bytes, interloperMs) {
  return new Promise((resolve) => {
    eventsEl.innerHTML = "";
    hlCache.clear();
    lastTextEl = newBlock();
    lastTextContent = "";
    lastTextContent = "";
    stats = { renders: 0, forced: 0, renderMs: 0, maxRenderMs: 0 };
    const full = makeAnswer(bytes, { fenceLines: 6 });
    const CHUNK = 40;
    let i = 0;
    const t0 = performance.now();
    startLagProbe();
    let lastInterloper = performance.now();
    const delta = setInterval(() => {
      lastTextContent += full.slice(i, i + CHUNK);
      i += CHUNK;
      scheduleTextRender(); // ui/app.js does exactly this per text_delta
      if (i >= full.length) {
        clearInterval(delta);
        clearInterval(inter);
        setTimeout(() => {
          renderTextBlock(true);
          const lag = stopLagProbe();
          const wall = performance.now() - t0;
          resolve({
            bytes: full.length,
            deltaRatePerSec: 1000 / 16,
            interloperMs: interloperMs || 0,
            wallMs: +wall.toFixed(0),
            renders: stats.renders,
            forcedRenders: stats.forced,
            busyMs: +stats.renderMs.toFixed(0),
            busyPct: +((stats.renderMs / wall) * 100).toFixed(1),
            maxRenderMs: +stats.maxRenderMs.toFixed(1),
            avgRenderMs: +(stats.renderMs / Math.max(1, stats.renders)).toFixed(1),
            ...lag,
          });
        }, 300);
      }
    }, 16);
    const inter = interloperMs
      ? setInterval(() => {
          flushTextRender(); // exactly what addEvent() does for a non-text event
        }, interloperMs)
      : 0;
  });
}

// --------------------------------------------------------------- experiment 4
// analytic: a full answer streamed at a realistic pace with the app's throttle.
// cost(size) is interpolated from the measured stage table, so this is the
// main-thread budget the whole answer consumes.
function analytic(measurements, bytes, charsPerSec) {
  const step = 120; // TEXT_RENDER_MIN_MS
  const perRender = 1 / (charsPerSec / 1000 / step); // chars streamed per render
  let total = 0;
  let n = 0;
  for (let size = 0; size <= bytes; size += perRender) {
    total += interp(measurements, size);
    n++;
  }
  return { bytes, charsPerSec, renders: n, mainThreadMs: +total.toFixed(0) };
}
function interp(pts, size) {
  // pts: [{bytes, fullRenderMs}] sorted by bytes
  if (size <= pts[0].bytes) return (pts[0].fullRenderMs * size) / pts[0].bytes;
  for (let i = 1; i < pts.length; i++) {
    if (size <= pts[i].bytes) {
      const a = pts[i - 1], b = pts[i];
      const f = (size - a.bytes) / (b.bytes - a.bytes);
      return a.fullRenderMs + f * (b.fullRenderMs - a.fullRenderMs);
    }
  }
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const slope = (last.fullRenderMs - prev.fullRenderMs) / (last.bytes - prev.bytes);
  return last.fullRenderMs + slope * (size - last.bytes);
}

// --------------------------------------------------------------- experiment 7
// mermaid: mermaid.parse + mermaid.render both run on this thread
async function experimentMermaid() {
  const nodes = [];
  for (let i = 0; i < 24; i++) nodes.push(`    N${i}[节点 ${i} 说明文字] --> N${i + 1}[节点 ${i + 1}]`);
  const src = "flowchart TD\n" + nodes.join("\n");
  try {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    const t1 = performance.now();
    await mermaid.parse(src);
    const parseMs = performance.now() - t1;
    const t2 = performance.now();
    const { svg } = await mermaid.render("benchmmd", src);
    const renderMs = performance.now() - t2;
    await post("mermaid", {
      sourceChars: src.length,
      parseMs: +parseMs.toFixed(1),
      renderMs: +renderMs.toFixed(1),
      svgChars: svg.length,
    });
  } catch (e) {
    await post("mermaid", { error: String(e).slice(0, 200) });
  }
}

// --------------------------------------------------------------- experiment 8
// mermaid on the STREAMING path: renderMermaid() runs inside highlightCode(),
// i.e. on every streaming re-render. A diagram block that is not the last
// element is re-parsed with every delta (its source grows past dataset
// .mermaidSrc each time). Measure parse cost by diagram size and the resulting
// main-thread budget for one streamed diagram.
async function experimentMermaidStream() {
  const makeSrc = (nodes) => {
    const lines = [];
    for (let i = 0; i < nodes; i++) lines.push(`    N${i}[节点 ${i} 说明文字] --> N${i + 1}[节点 ${i + 1}]`);
    return "flowchart TD\n" + lines.join("\n");
  };
  const rows = [];
  for (const nodes of [5, 10, 20, 40, 80]) {
    const src = makeSrc(nodes);
    let parseMs = null;
    let renderMs = null;
    try {
      const t0 = performance.now();
      await mermaid.parse(src);
      parseMs = +(performance.now() - t0).toFixed(1);
    } catch (e) {
      parseMs = "err";
    }
    try {
      const t0 = performance.now();
      await mermaid.render("mmds" + nodes, src);
      renderMs = +(performance.now() - t0).toFixed(1);
    } catch (e) {
      renderMs = "err";
    }
    rows.push({ nodes, chars: src.length, parseMs, renderMs });
    await post("mermaidStream", { nodes, chars: src.length, parseMs, renderMs });
  }
  // the app's own re-render loop: the diagram grows by one line per render
  // (120 ms throttle), the block is NOT last, so every render re-parses it
  const src = makeSrc(60);
  const lines = src.split("\n");
  let total = 0;
  let calls = 0;
  for (let i = 10; i <= lines.length; i += 2) {
    const partial = lines.slice(0, i).join("\n");
    const t0 = performance.now();
    try {
      await mermaid.parse(partial);
    } catch (e) {}
    total += performance.now() - t0;
    calls++;
  }
  await post("mermaidStreamLoop", {
    calls,
    totalMs: +total.toFixed(0),
    avgMs: +(total / calls).toFixed(1),
    note: "60-node diagram streamed in 2-line steps, re-parsed every streaming render",
  });
}

// --------------------------------------------------------------- experiment 6
// MathJax on the growing block (the flush render typesets it)
async function experimentMath() {
  const text = makeAnswer(8192, { fenceLines: 2 });
  const wrap = newBlock();
  wrap.querySelector(".body").innerHTML = renderMarkdown(text);
  const has = typeof MathJax !== "undefined" && typeof MathJax.typesetPromise === "function";
  let mathJaxMs = null;
  let err = null;
  if (has) {
    try {
      const t0 = performance.now();
      await MathJax.typesetPromise([wrap]);
      mathJaxMs = +(performance.now() - t0).toFixed(1);
    } catch (e) {
      err = String(e).slice(0, 200);
    }
  }
  await post("math", {
    mathjaxLoaded: has,
    typesetMs: mathJaxMs,
    error: err,
    formulaCount: wrap.querySelectorAll("mjx-container").length,
  });
}

// --------------------------------------------------------------- experiment 9
// pathological-but-plausible model output. A model that emits one very long
// line (minified JSON, a base64 blob, a wall of table pipes, a long run of
// emphasis markers) can send marked's inline regexes or highlight.js into
// catastrophic behaviour. Sizes escalate, and the case name is posted BEFORE
// each attempt so a hang is attributable.
async function experimentPathological() {
  const cases = [
    ["longLine", (n) => "a".repeat(n)],
    ["stars", (n) => "*".repeat(n)],
    ["underscores", (n) => "_".repeat(n)],
    ["brackets", (n) => "[".repeat(n)],
    ["bracketsPairs", (n) => "[x]".repeat(n / 3)],
    ["pipes", (n) => "|".repeat(n)],
    ["dashes", (n) => "-".repeat(n)],
    ["backticks", (n) => "`".repeat(n)],
    ["dollars", (n) => "$".repeat(n)],
    ["backslashes", (n) => "\\".repeat(n)],
    ["nestedEmph", (n) => "*a*".repeat(n / 3)],
    ["htmlTags", (n) => "<div>".repeat(n / 5)],
    ["longUrl", (n) => "https://example.com/(x)[y]{z}".repeat(n / 30)],
    ["jsonBlob", (n) => '{"k":[' + "[1,2],".repeat(n / 7) + "]}"]],
    ["anglePath", (n) => "<a/b/c/d/e/f/g/h>".repeat(n / 17)],
  ];
  for (const [name, gen] of cases) {
    for (const n of [16384, 131072]) {
      await post("pathStart", { name, n });
      const src = gen(n);
      const res = bench(() => renderMarkdown(src), 1);
      const ms = +res.med.toFixed(1);
      await post("pathological", { name, chars: src.length, markdownMs: ms });
      if (ms > 400) break; // already pathological at this size; don't escalate
    }
  }
}

// ------------------------------------------------------------------ main run
async function main() {
  await post("env", {
    ua: navigator.userAgent,
    dpr: devicePixelRatio,
    width: window.innerWidth,
    height: window.innerHeight,
    rAF: typeof requestAnimationFrame === "function",
  });
  let rafTicks = 0;
  const rafCount = requestAnimationFrame(function tick() {
    rafTicks++;
    requestAnimationFrame(tick);
  });
  await new Promise((r) => setTimeout(r, 500));
  cancelAnimationFrame(rafCount);
  await post("raf", { ticksIn500ms: rafTicks });

  const sizes = [8192, 32768, 65536, 131072, 262144];
  const measurements = [];
  for (const s of sizes) {
    const text = makeAnswer(s, { fenceLines: Math.max(6, Math.round(s / 6000)) });
    const wrap = newBlock();
    const bodyEl = wrap.querySelector(".body");
    const m = bench(() => {
      bodyEl.innerHTML = renderMarkdown(text);
      highlightPre(wrap);
      autoScroll();
    }, 3);
    measurements.push({ bytes: text.length, fullRenderMs: +m.med.toFixed(1) });
    eventsEl.innerHTML = "";
    lastTextEl = null;
  }
  await post("curve", { points: measurements });
  await post("analytic", {
    note: "main-thread ms a whole answer would consume, throttle honoured, no interlopers",
    rows: [8192, 32768, 65536, 131072].map((b) => analytic(measurements, b, 30)),
  });
  await experimentStages(sizes);
  await experimentDomDepth([0, 100, 300]);
  await post("stream1", await streamSim(16384, 0));
  await post("stream2", await streamSim(16384, 100));
  await experimentMermaidStream();
  await experimentMermaid();
  await experimentMath();
  await experimentPathological();
  await post("done", { ok: true });
}
main().catch((e) => post("fatal", { error: String(e), stack: String(e && e.stack).slice(0, 500) }));
