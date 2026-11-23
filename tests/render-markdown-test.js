"use strict";

// Regression test for the unexplained strikethrough in model prose.
//
// marked 12's inline `del` rule is /^(~~?)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/:
// a SINGLE tilde opens strikethrough, and the body may span newlines. Prose that
// writes ranges with `~` — "1~2 周", "p95 1.7~2.3cm", "80~150ms" — therefore
// pairs the first tilde with the next one and marks everything in between as
// deleted text (`<del>`, which the UA stylesheet draws with line-through).
//
// That is what a report looked like: "报告 §7 给了三个 1~2 周内能做完的实验 … （几
// 小时生成数据 + 1~2 天训练）" came back with one strike span running from the
// first range to the second, hundreds of characters later, so the readable
// fragments either side read as "2 周内…" and "12 天训练" — content that looked
// corrupted for no reason a reader could see.
//
// Like stream-render-test.js this runner does NOT restate the rule: it pulls
// `tuneMarked` out of ui/src/renderer/render-events.ts, runs it against the
// vendored marked the page itself loads, and asserts on the HTML that comes out.
//
// Run: node tests/render-markdown-test.js

const path = require("path");
const { check, summary, slicer, uiSource, runnableSnippet } = require("./harness.js");

const src = uiSource(); // the renderer, every module in page load order
const { region } = slicer(src);

// the page's marked: the same file ui/index.html loads, as a global
global.marked = require(path.join(__dirname, "..", "ui", "vendor", "marked.min.js"));

// ---- the rule the renderer installs, taken from the source ----

const tuneSrc = region("let markedTuned", "tuneMarked");
check(tuneSrc.includes("(~~)"), "the override asks for TWO tildes, not marked's `~~?`");
check(/del\(this: any, src: string\)/.test(tuneSrc) || /del\(/.test(tuneSrc),
  "the override is marked's inline `del` tokenizer");

// `marked` is a parameter so `typeof marked` sees the page's instance
const tuneMarked = new Function("marked", runnableSnippet(tuneSrc) + "\nreturn tuneMarked;")(
  global.marked
);
tuneMarked();

// ---- the reported paragraph ----

const TENNIS =
  "报告 §7 给了三个 1~2 周内能做完的实验：V1 贴 3×3 的 5cm 胶带格 + 100 次抛球对比真值" +
  "（p95 ≤3cm 通过）；V2 投影干扰误检率 <1%；V3 端到端时间戳 ≤150ms。V1 不过就走" +
  "\"按新机位重生成合成数据微调\"的 P0.5 路线（几小时生成数据 + 1~2 天训练）。";

const html = global.marked.parse(TENNIS);
check(!html.includes("<del>"), "a paragraph of ranges renders unstruck");
check(!html.includes("line-through"), "…and nothing asks for a strike either");
check(html.split("1~2").length - 1 === 2, "both ranges survive as literal tildes");
check(html.includes("2 天训练"), "the tail keeps its own text instead of joining the struck head");
check(html.includes("≤3cm") && html.includes("≤150ms"), "the multi-byte characters around them are untouched");

// the body of the old rule could cross a blank line, so a range in one paragraph
// must not reach a range in the next one either
const TWO_PARAGRAPHS = "落点 p95 1.7~2.3cm。\n\n下一节：触台后 80~150ms 出反馈。";
check(!global.marked.parse(TWO_PARAGRAPHS).includes("<del>"),
  "two ranges in different paragraphs are two ranges, not one strike span");

// a lone tilde against punctuation is a character, whatever follows it
check(!global.marked.parse("~3cm / ~17% / 约 ~50ms").includes("<del>"),
  "a lone tilde with no partner stays a character");

// ---- deliberate strikethrough still works ----

const struck = global.marked.parse("a ~~b~~ c");
check(struck.includes("<del>b</del>"), "~~two tildes~~ is still strikethrough (GFM)");
check(global.marked.parse("x ~~multi word~~ y").includes("<del>multi word</del>"),
  "…including across spaces");
check(global.marked.parse("a ~~b~~ and ~~c~~ d").split("<del>").length - 1 === 2,
  "two deliberate strikethroughs are two elements, not one span");

// installing twice is a no-op: marked.use would otherwise stack the override
tuneMarked();
const again = global.marked.parse("a ~~b~~ c");
check(again === struck, "tuning is idempotent — the second call changes nothing");

summary("render-markdown");
