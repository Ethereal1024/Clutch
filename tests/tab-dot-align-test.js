"use strict";

// The tab strip's status mark — is it ONE dot, and is it on the centre line?
//
// Two reports, one fix each:
//
//   1. "两个圆点的功能本来就是互斥的，其实可以合并为一个圆点" — the strip drew a red
//      dot for a run in flight and a green one for a tab waiting for the user, and
//      a tab could wear both, because "waiting" IS a running execution
//      (slots.ts maps execution_status "waiting" to running). One dot has to
//      carry the one state that matters: tabMarkState (tab-bar.ts) — waiting
//      outranks busy, and the switcher's glyph reads the same function.
//   2. "两个圆点的对齐方式不统一，不在同一条水平线上" — the two dots sat on different
//      rows. Headless Chromium and Electron measured the same `top` for both, at
//      every device-pixel-ratio tried, so this runner locks the INVARIANT that
//      makes the report impossible instead of a screenshot: one box, one rule,
//      one centre line, on a whole pixel (an odd band puts a 6px dot at x.5,
//      where the edge rows go half-alpha and a pulsing dot reads a row off a
//      still one).
//
// Plus the colour: amber for "this is waiting for you", which is what --warn is
// for; red stays "in flight", and the diff green is not a status colour at all.
//
// Source contracts only — no browser, so it runs everywhere.
//
// Run: node tests/tab-dot-align-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, runnableSnippet } = require("./harness");

const ROOT = path.join(__dirname, "..");
const UI = path.join(ROOT, "ui");

const css = fs.readFileSync(path.join(UI, "style.css"), "utf8");
const tabBar = fs.readFileSync(path.join(UI, "src", "renderer", "tab-bar.ts"), "utf8");
const titlebar = fs.readFileSync(path.join(UI, "src", "renderer", "titlebar.ts"), "utf8");
const state = fs.readFileSync(path.join(UI, "src", "renderer", "state.ts"), "utf8");
const slots = fs.readFileSync(path.join(UI, "src", "renderer", "slots.ts"), "utf8");
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");

const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

// TOP-LEVEL selector -> body, the LAST rule winning like the cascade does. At-rule
// blocks (@media, @supports, @font-face) are skipped whole: a media override is
// not the base declaration, and it is asserted separately below.
function topLevelRules(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const sel = src.slice(i, open).trim();
    if (sel.startsWith("@")) {
      let depth = 0, j = open;
      for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    const close = src.indexOf("}", open);
    if (close < 0) break;
    for (const s of sel.split(",")) {
      const key = s.trim().replace(/\s+/g, " ");
      if (key) out.push({ sel: key, body: src.slice(open + 1, close) });
    }
    i = close + 1;
  }
  return out;
}
const rules = topLevelRules(code);
function bodyOf(sel) {
  const hit = rules.filter((r) => r.sel === sel);
  return hit.length ? hit[hit.length - 1].body : null;
}

function decls(body) {
  const out = new Map();
  for (const part of (body || "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim().replace(/\s+/g, " ");
    if (prop) out.set(prop, val);
  }
  return out;
}

// ---- 1. one dot, one state --------------------------------------------------

console.log("-- one dot, not two");

// the real derivation, executed (not re-implemented): a tab that needs the user
// must not also be drawn as busy
const { fnBody } = slicer(tabBar);
(0, eval)(runnableSnippet(fnBody("tabMarkState")));

check(typeof tabMarkState === "function", "tab-bar.ts exports tabMarkState");
check(tabMarkState({}) === null, "a quiet tab has no mark");
check(tabMarkState({ running: true }) === "run", "a working tab is 'run'");
check(tabMarkState({ needsInput: true }) === "ask", "a tab waiting on the user is 'ask'");
check(tabMarkState({ running: true, needsInput: true }) === "ask",
  "waiting outranks busy — an asking tab is a running one too (execution_status 'waiting')");
check(!/doc-tab-(run|ask)\b/.test(css + tabBar), "the old two-class names are gone");

// one build path, one append: a second one is how the pair came back last time
check((tabBar.match(/doc-tab-dot-doc-tab-dot-|doc-tab-dot doc-tab-dot-/g) || []).length === 1,
  "renderTabBar builds the dot's class in exactly one place");
check(/if \(mark\) \{\n\s*const dot = document\.createElement\("span"\);/.test(tabBar),
  "the dot is created only when tabMarkState returned a state");

// the switcher's glyph is the same one state, so the two surfaces cannot disagree
check(/const tabState = tabMarkState\(tab\)/.test(titlebar),
  "the tab switcher reads tabMarkState, not the two flags");
check(!/tab\.needsInput \?/.test(titlebar), "…and no longer branches on needsInput itself");

// ---- 2. one box, one centre line --------------------------------------------

console.log("-- the dot is one box in one rule");

const dot = decls(bodyOf(".doc-tab-dot"));
const run = decls(bodyOf(".doc-tab-dot-run"));
const ask = decls(bodyOf(".doc-tab-dot-ask"));

check(dot.get("width") === "6px" && dot.get("height") === "6px",
  `the box is 6x6 (${dot.get("width")}x${dot.get("height")})`);
check(dot.get("border-radius") === "50%", "the box is round");
check(dot.get("align-self") === "center", "the box centres itself in the tab's band");
check(dot.get("flex") === "none", "the box neither grows nor shrinks");

// the state classes may only paint: colour and motion, never geometry
const GEOMETRY = ["width", "height", "border-radius", "box-sizing", "display", "position",
  "flex", "flex-shrink", "flex-grow", "flex-basis", "align-self", "align-items",
  "margin", "padding", "border", "top", "bottom", "left", "right", "transform", "vertical-align"];
for (const [name, d] of [["run", run], ["ask", ask]]) {
  const geometry = GEOMETRY.filter((p) => d.has(p));
  check(geometry.length === 0, `the ${name} class adds no geometry (found: ${geometry.join(", ") || "none"})`);
}
check(ask.get("background") === "var(--warn)", `the waiting dot is amber (${ask.get("background")})`);
check(run.get("background") === "var(--accent)", `the working dot is the accent (${run.get("background")})`);

// nothing else may reach the dot: three rules for it (box + two colours), and the
// reduced-motion opt-out, which must only cancel the pulse
const touching = rules.filter((r) => /^\.doc-tab-dot|^\.doc-tab-dot-(run|ask)$/.test(r.sel));
check(touching.length === 3, `exactly three rules name the dot (found ${touching.length}: ${touching.map((r) => r.sel).join(", ")})`);
const motionBlock = [...code.matchAll(/@media\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)]
  .map((m) => m[1])
  .find((b) => /\.doc-tab-dot-run\s*\{/.test(b));
const motionBody = motionBlock ? /\.doc-tab-dot-run\s*\{([^}]*)\}/.exec(motionBlock) : null;
check(!!motionBody && /animation:\s*none/.test(motionBody[1]), "reduced motion cancels the pulse");
check(motionBody ? [...decls(motionBody[1]).keys()].every((p) => p === "animation" || p === "opacity") : false,
  "reduced motion changes nothing but the animation");

// ---- 3. the centre line is a whole pixel ------------------------------------

console.log("-- the tab band centres the 6px dot on a whole pixel");

// a length written as a literal px — including a shorthand's first value
// (`1px solid var(--border)` is a 1px bottom border)
function px(d, prop, label) {
  const v = d.get(prop);
  const m = /^(\d+(?:\.\d+)?)px\b/.exec(v || "");
  check(!!m, `${label} ${prop} is a literal px value (got ${JSON.stringify(v)})`);
  return m ? parseFloat(m[1]) : NaN;
}

const barD = decls(bodyOf(".tab-bar"));
const tabD = decls(bodyOf(".doc-tab"));

const barH = px(barD, "height", ".tab-bar");
const barBorder = barD.has("border-bottom") ? px(barD, "border-bottom", ".tab-bar") : 0;
const tabBorder = px(tabD, "border-bottom", ".doc-tab");
const dotH = px(dot, "height", ".doc-tab-dot");

check((barH - barBorder) % 1 === 0 && barH - barBorder > 0,
  `.tab-bar's band is a whole number of px: ${barH} - ${barBorder} = ${barH - barBorder}`);
check(tabD.get("height") === "100%",
  `the tab fills that band (height: ${tabD.get("height")})`);
check(tabD.get("align-items") === "center", "the tab centres its contents");

const band = barH - barBorder - tabBorder;
check(band % 2 === 0,
  `the band the dot centres in is even: ${barH} - ${barBorder} - ${tabBorder} = ${band}`);
check((band - dotH) % 2 === 0,
  `a ${dotH}px dot centres on a whole pixel in a ${band}px band (offset ${(band - dotH) / 2})`);

// ---- 4. the amber is a colour the reader can see ----------------------------

console.log("-- the waiting colour reads on the strip");

// the palette is declared across more than one `:root` block — cascade them
const root = new Map();
for (const r of rules.filter((r) => r.sel === ":root")) {
  for (const [k, v] of decls(r.body)) root.set(k, v);
}
function hex(name) {
  const m = /^#([0-9a-f]{6})$/i.exec(root.get(name) || "");
  return m ? m[1] : null;
}
function luminance(h) {
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const warn = hex("--warn");
const accent = hex("--accent");
const green = hex("--green");
check(!!warn, `--warn is a hex colour (${root.get("--warn")})`);
check(warn !== accent && warn !== green, "--warn is its own colour, not the accent or the diff green");
for (const bg of ["--bg", "--bg2"]) {
  const surface = hex(bg);
  const ratio = warn && surface ? contrast(warn, surface) : NaN;
  check(ratio >= 3,
    `--warn clears 3:1 on ${bg} for a non-text indicator: ${ratio.toFixed(2)}:1`);
}

// ---- 5. no dead dirty mark, no dead state class ----------------------------

console.log("-- no dead mark");

check(!/doc-tab-dirty/.test(css), "style.css has no .doc-tab-dirty");
check(!/doc-tab-dirty/.test(html), "index.html has no dirty mark");
check(!/doc-tab-dirty/.test(tabBar), "tab-bar.ts has no dirty mark");
check(!/\bdirty\b/.test(state), "the Tab type carries no dirty field");
check(!/\bdirty\b/.test(slots), "tab creation sets no dirty field");
check(!/\bdirty\b/i.test(tabBar), "tab-bar.ts persists and renders no dirty state");

const classNameSrc = /el\.className =[^]*?;\n/.exec(tabBar);
check(!!classNameSrc, "renderTabBar states the tab's classes in one expression");
const worn = classNameSrc ? [...classNameSrc[0].matchAll(/" ([\w-]+)"/g)].map((m) => m[1]) : [];
check(worn.length > 0, `the tab wears state classes: ${worn.join(", ") || "none"}`);
check(worn.every((c) => rules.some((r) => r.sel === `.doc-tab.${c}`)),
  "every class the tab wears has a .doc-tab.<class> rule (a class no rule reads is dead markup)");

summary("tab-dot-align-test", "one status dot, one box, one centre line on a whole pixel");
