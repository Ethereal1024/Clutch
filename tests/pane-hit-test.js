"use strict";

// Can the pane's own cards be CLICKED?
//
// The field report: "远程连接标签页连接失败时的确认窗口无法被点击" — a remote tab
// whose connect failed puts the pane's blocked card up (project.ts showBlocked:
// the reason, then Connect / Dismiss), and neither button answers a press.
//
// It is not the buttons and not the handlers: it is PAINT ORDER. pane.ts owns
// every view of the pane, but it only toggles `hidden` on the pane's [data-view]
// cards — #stream is never hidden, it stays a full-size POSITIONED box in
// .stream-wrap for every state, and in index.html it comes AFTER #tab-blocked.
// Two positioned boxes with no z-index paint in tree order, so the stream lay on
// top of the card: `#stream` has no background, so the card still read perfectly,
// while every press in that rectangle landed on the stream behind it. Reproduced
// in a real engine with document.elementFromPoint over the card's own buttons
// before the fix: "tab-blocked-connect => stream".
//
// Fix: the cards that REPLACE the pane are one layer above the stream
// (.tab-blocked and .tab-load, z-index: 1). Neither the buttons nor the markup
// changed — which is exactly why this runner exists: a CSS regression here has no
// other symptom than "the window does nothing when I press it".
//
// Part 1 are source contracts (they run everywhere). Part 2 loads the REAL
// index.html with the REAL sheets into headless Chromium and asks the engine
// where a click at each control's centre actually lands; it is skipped, loudly,
// on a machine with no browser — the browserless contracts above still run.
//
// Run: node tests/pane-hit-test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { check, summary } = require("./harness");

const ROOT = path.join(__dirname, "..");
const UI = path.join(ROOT, "ui");

const css = fs.readFileSync(path.join(UI, "style.css"), "utf8");
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
const pane = fs.readFileSync(path.join(UI, "src", "renderer", "pane.ts"), "utf8");

// ---- part 1: the facts the sheet has to keep, without a browser --------------

// a rule body by selector, comments stripped, the LAST rule winning like the
// cascade does (style.css restates a few selectors further down)
function bodiesOf(sheet) {
  const code = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map();
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1].split(",")) {
      const key = sel.trim().replace(/\s+/g, " ");
      if (key) out.set(key, m[2]);
    }
  }
  return out;
}

function zIndexOf(body) {
  const m = /(?:^|[;\s])z-index\s*:\s*(-?\d+|auto)\s*(?:;|$)/.exec(body || "");
  if (!m) return 0; // `auto` paints in tree order — the bug's precondition
  return m[1] === "auto" ? 0 : Number(m[1]);
}

const bodies = bodiesOf(css);
const streamBody = bodies.get("#stream") || "";
const blockedBody = bodies.get(".tab-blocked") || "";
const loadBody = bodies.get(".tab-load") || "";

check(/position\s*:\s*relative/.test(streamBody),
  "#stream is a POSITIONED box — so it is not merely in-flow content under the pane's cards");
check(!/(?:^|[;\s])z-index\s*:/.test(streamBody),
  "…and it declares no z-index of its own: with no layer on the cards, tree order would decide, and the stream is painted last");
check(/position\s*:\s*absolute/.test(blockedBody) && /inset\s*:\s*0/.test(blockedBody),
  ".tab-blocked covers the stream (absolute, inset 0) — it IS the pane while it stands");
check(/position\s*:\s*absolute/.test(loadBody) && /inset\s*:\s*0/.test(loadBody),
  ".tab-load covers the stream the same way");
check(zIndexOf(blockedBody) > zIndexOf(streamBody),
  `.tab-blocked is painted ABOVE #stream (z-index ${zIndexOf(blockedBody)} > ${zIndexOf(streamBody)}) — otherwise the card is readable through a transparent stream that swallows every press`);
check(zIndexOf(loadBody) > zIndexOf(streamBody),
  `.tab-load is above #stream too (z-index ${zIndexOf(loadBody)} > ${zIndexOf(streamBody)}) — it wins by tree order today, which is not a reason to depend on it`);
check(zIndexOf(blockedBody) === zIndexOf(loadBody),
  "and the two cards share one layer: they are alternatives of one state, never a priority between them");

// the markup the stacking has to hold for: the cards and the stream are siblings
// inside one .stream-wrap, so they overlap
const wrap = html.indexOf('class="stream-wrap"');
const iBlocked = html.indexOf('id="tab-blocked"');
const iStream = html.indexOf('id="stream"');
const iLoad = html.indexOf('id="tab-load"');
check(wrap > 0 && iBlocked > wrap && iStream > iBlocked && iLoad > iStream,
  "#tab-blocked, #stream and #tab-load are siblings in that order inside one .stream-wrap — the two cards overlap the stream");
check(/stream\.dataset\.pane = state\.view;/.test(pane),
  "pane.ts still publishes the pane's view on #stream");
check(!/stream\.classList\.(?:add|toggle)\("hidden"/.test(pane),
  "…and never hides the stream itself: the cards alone are the views, which is why they must be painted over it");
check(/"blocked"/.test(pane) && /data-view/.test(pane),
  "the pane's views are still toggled through [data-view]");

// ---- part 2: ask a real engine where the press lands -------------------------

function findChrome() {
  const named = process.env.CHROME_BIN
    ? [process.env.CHROME_BIN]
    : [];
  const candidates = named.concat([
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "/opt/google/chrome/chrome",
  ]);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
    if (probe.status === 0 && /chrom/i.test(String(probe.stdout || ""))) {
      return { bin, version: String(probe.stdout).trim() };
    }
  }
  return null;
}

// The markup and the cascade, and NOTHING else: the page's own scripts are
// dropped, because a probe that needs the app to boot would be testing the app.
// It sets the two states the way pane.ts does (the card up, the welcome page
// gone) and asks document.elementFromPoint what a press at each control's centre
// would hit.
const PROBE = `\n<script>\n(function () {
  function hit(id) {
    var el = document.getElementById(id);
    if (!el) return id + " => MISSING";
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return id + " => NO BOX";
    var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    var name = h ? (h.id || h.className || h.tagName) : "null";
    return id + " => " + name;
  }
  var out = [];
  document.getElementById("welcome").classList.add("hidden");
  var blocked = document.getElementById("tab-blocked");
  document.getElementById("tab-blocked-text").textContent = "Could not open this tab";
  document.getElementById("tab-blocked-status").textContent = "connection failed: no route to host";
  document.getElementById("tab-blocked-connect").classList.remove("hidden");
  blocked.classList.remove("hidden");
  out.push(hit("tab-blocked-text"));
  out.push(hit("tab-blocked-connect"));
  out.push(hit("tab-blocked-dismiss"));
  blocked.classList.add("hidden");
  document.getElementById("tab-load-title").textContent = "Opening project…";
  document.getElementById("tab-load-where").textContent = "fanshu@124.220.181.209";
  document.getElementById("open-progress").classList.remove("hidden");
  document.getElementById("open-progress-note").textContent = "Uploading server · 13 KB/s";
  document.querySelector(".open-progress-label").id = "probe-percent";
  document.getElementById("tab-load").classList.remove("hidden");
  out.push(hit("tab-load-title"));
  out.push(hit("probe-percent"));
  out.push(hit("open-progress-note"));
  document.getElementById("tab-load").classList.add("hidden");
  var row = document.getElementById("events");
  row.innerHTML = '<div id="under-stream-row">a record of the tab underneath</div>';
  out.push(hit("under-stream-row"));
  document.body.setAttribute("data-probe", out.join(" | "));
})();\n</script>\n`;

function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// One run of the probe at a given window size, returning the engine's answers.
function probeAt(dir, size, tag) {
  const run = spawnSync(chrome.bin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + path.join(dir, "profile-" + tag),
    "--window-size=" + size,
    "--virtual-time-budget=5000",
    "--dump-dom",
    "file://" + path.join(dir, "index.html"),
  ], { encoding: "utf8", timeout: 90000 });
  const dom = String(run.stdout || "");
  const m = /data-probe="([^"]*)"/.exec(dom);
  return m ? decode(m[1]).split(" | ") : null;
}

const chrome = findChrome();
if (!chrome) {
  console.log("skipped: no chromium on this machine — the hit test below needs a real engine");
  console.log("ok:   the browserless contracts above still pin the cascade that made the card unclickable");
} else {
  console.log(`the pane's cards under ${chrome.version}:`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-pane-hit-"));
  try {
    fs.copyFileSync(path.join(UI, "style.css"), path.join(dir, "style.css"));
    const mobile = path.join(UI, "mobile.css");
    if (fs.existsSync(mobile)) fs.copyFileSync(mobile, path.join(dir, "mobile.css"));
    const page = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace("</body>", PROBE + "</body>");
    fs.writeFileSync(path.join(dir, "index.html"), page);
    // the desktop layout AND the phone's: mobile.css reflows #left (the drawer,
    // the stream's order), which is a different set of boxes over the same two
    // cards — and the phone is where a dialog that cannot be pressed has bitten
    // before (no WebChromeClient: a dialog that draws but answers nothing)
    for (const [tag, size] of [["desktop", "1280,900"], ["phone", "420,900"]]) {
      const hits = probeAt(dir, size, tag);
      check(!!hits, `${tag} (${size}): the probe ran in the engine and reported where presses land`);
      for (const hit of hits || []) {
        const [id, landed] = hit.split(" => ");
        check(!!id && !!landed && landed === id,
          `${tag}: ${id}: a press at its centre lands on it (landed on ${landed})`);
      }
      check((hits || []).length >= 7, `${tag}: every control was probed (${(hits || []).length} probed)`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

summary("pane-hit-test.js");
