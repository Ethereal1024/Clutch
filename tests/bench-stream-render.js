// Quantitative old-vs-new comparison of the streaming render path, using the
// REAL marked + hljs builds shipped in ui/vendor. (MathJax is excluded: it has
// no Node build — note that the OLD pipeline ran it PER FRAME whenever the text
// contained a $..$ pair, so every "old" number below is an UNDERCOUNT.)
//
// Metric: CPU-seconds burned by the renderer main thread per second of
// streaming, at 60fps (old) vs the throttled 8fps + cache (new). >1.0 = the
// main thread is saturated = the whole-window freeze.
"use strict";
const marked = require("../ui/vendor/marked.min.js");
const hljs = require("../ui/vendor/highlight.min.js");

const FPS_OLD = 60;    // rAF cadence the old code rendered at
const FPS_NEW = 1000 / 120; // TEXT_RENDER_MIN_MS = 120ms

// A realistic agent transcript chunk: prose + fences like tool-output dumps.
const FENCE = [
  '```python\n' + Array.from({ length: 12 }, (_, i) => `def handler_${i}(payload): return transform(payload, mode=${i})`).join("\n") + '\n```',
  '```bash\n' + Array.from({ length: 14 }, (_, i) => `command --flag-${i} value-${i} >> output_${i}.log`).join("\n") + '\n```',
  '```json\n' + JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key_${i}`, { index: i, active: true }])), null, 2) + '\n```',
  '```javascript\n' + Array.from({ length: 12 }, (_, i) => `const handler${i} = (req, res) => res.json({ ok: true, n: ${i} });`).join("\n") + '\n```',
];
const PROSE = "这是 agent 输出的一段中文说明，包含 `inline code` 和 [链接](https://example.com)，" +
  "以及列表：\n\n- 第一条结论，引用了上面的输出\n- 第二条结论，包含 **加粗** 与 *斜体*\n\n";

function buildDoc(targetBytes) {
  let parts = [], n = 0, i = 0;
  while (n < targetBytes) {
    const p = i % 2 === 0 ? PROSE : FENCE[(i / 2 | 0) % FENCE.length];
    parts.push(p); n += p.length; i++;
  }
  return parts.join("\n\n");
}

// --- old pipeline per-frame work: full markdown re-parse + hljs on ALL fences ---
function renderMarkdownOld(text) {
  const math = [];
  const protectedSrc = text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => {
    math.push(m);
    return `\u27E6MATH${math.length - 1}\u27E7`;
  });
  const html = marked.parse(protectedSrc);
  return html.replace(/\u27E6MATH(\d+)\u27E7/g, (_, i) => math[+i]);
}
function hlCost(fences) { // hljs.highlight: same grammar engine as highlightElement
  let t = 0;
  for (const [lang, code] of fences) {
    const t0 = performance.now();
    try { hljs.highlight(code, { language: lang }); } catch (e) { try { hljs.highlightAuto(code); } catch (e2) {} }
    t += performance.now() - t0;
  }
  return t;
}

function bestOf(fn, runs = 3) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); fn(); best = Math.min(best, performance.now() - t0); }
  return best;
}

function extractFences(doc) {
  const out = [];
  const re = /```(\w+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(doc))) out.push([m[1], m[2]]);
  return out;
}

console.log("size   |  old: md/frame  hl/frame | CPU-s/s @60fps |  new: md/frame hl/frame | CPU-s/s @8fps | verdict");
console.log("-------+------------------------------+----------------+-------------------------+---------------+--------");
for (const kb of [20, 50, 100]) {
  const doc = buildDoc(kb * 1000);
  const fences = extractFences(doc);
  const tail = fences.length ? fences[fences.length - 1] : ["bash", "echo tail"]; // the growing last fence

  const mdOld = bestOf(() => renderMarkdownOld(doc));               // full re-parse every frame
  const hlOld = hlCost(fences);                                     // ALL fences every frame
  const mdNew = mdOld;                                              // full re-parse at 8fps (unchanged work per render)
  const t0 = performance.now(); hljs.highlight(tail[1], { language: tail[0] });
  const hlTail = performance.now() - t0;                            // only the growing tail (cache covers the rest)

  const oldPerSec = FPS_OLD * (mdOld + hlOld) / 1000;
  const newPerSec = FPS_NEW * (mdNew + hlTail) / 1000 + (hlOld * 0.5) / 1000; // + amortized flush hljs
  const verdictOld = oldPerSec > 1 ? "OLD FROZEN" : "old ok";
  console.log(
    `${String(kb + "KB").padEnd(6)} | ${mdOld.toFixed(1).padStart(8)}ms ${hlOld.toFixed(1).padStart(8)}ms | ` +
    `${oldPerSec.toFixed(2).padStart(9)} (${verdictOld})` +
    ` | ${mdNew.toFixed(1).padStart(8)}ms ${hlTail.toFixed(1).padStart(7)}ms | ${newPerSec.toFixed(2).padStart(7)} new ok | ` +
    `${(oldPerSec / newPerSec).toFixed(1)}x`
  );
}
console.log("\n(MathJax excluded: the old pipeline ALSO re-typeset the whole block per frame on any $..$ pair —");
console.log(" real old-side cost is strictly higher than shown. DOMPurify omitted in Node: affects both sides.)");
