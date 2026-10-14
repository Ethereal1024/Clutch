"use strict";

// Trust mode: the perm dialog auto-allows itself after TRUST_COUNTDOWN_S
// seconds unless the user denies (or closes) first. The armed flag is
// localStorage ("clutch_trust_all") and it is MIRRORED to the far side
// (POST /api/permission/trust) because the countdown that decides runs in the
// gate that owns the ask (agent/core/permission.py): a backgrounded page is
// FROZEN, and a countdown kept only in the renderer paused with it. The label
// on the Allow button is a wall-clock deadline. Expiry — either side's — takes
// the same respondPerm(true) path as clicking Allow, so the backend sees an
// ordinary allow.
//
// Like stream-render-test.js this extracts the REAL functions from the renderer
// (the whole trust block, openPerm/closePerm hooks asserted on source) and
// drives them against stubs with fake timers AND a fake wall clock, so a silent
// change that breaks the countdown fails here.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = uiSource(); // the renderer, every module in page load order
const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");

const { fnBody, region } = slicer(src);

// ---- stub environment ----
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

// the countdown reads the WALL CLOCK, not a tick counter (a frozen page must
// not relive the seconds it was away): a frozen clock here proves the tick
// arithmetic, and moving it forward stands in for the background gap.
let nowMs = 1_700_000_000_000;
Date.now = () => nowMs;

// the trust block mirrors the armed flag to the backend; both names live in
// app.js (loaded before js/permissions.js), so the stubs are globals too
let trustPushes = [];
global.API_BASE = null; // no session yet: pushTrustArmed() is a no-op
global.apiFetch = async (p, opts) => { trustPushes.push({ path: p, body: opts && opts.body }); return {}; };

// the wake hooks read document.hidden
global.document = { hidden: false, addEventListener: () => {} };

// fake timers: every setTimeout lands in a list; advance() fires pending
// timers pass by pass until the chain drains (bounded, so a runaway reschedule
// loop fails the test instead of hanging it). Each pass stands for the second
// the tick asked for, so a wall-clock countdown sees time move.
let timers = [];
global.setTimeout = (fn) => { timers.push({ fn, cleared: false }); return timers.length; };
global.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
function advance(passes = 100) {
  for (let pass = 0; pass < passes && timers.some((t) => !t.cleared); pass++) {
    const due = timers;
    timers = []; // a fired tick may re-schedule into the fresh list
    nowMs += 1000; // the timer that just fired was due a second later
    for (const t of due) if (!t.cleared) t.fn();
  }
  const left = timers.filter((t) => !t.cleared).length;
  timers = [];
  return left; // non-zero means the chain never drained
}

function fakeBtn() {
  const b = {
    textContent: "",
    title: "",
    classes: new Set(),
    handlers: {},
    classList: {
      toggle: (c, force) => { if (force) b.classes.add(c); else b.classes.delete(c); },
      contains: (c) => b.classes.has(c),
    },
    addEventListener(type, fn) { b.handlers[type] = fn; },
    click() { if (b.handlers.click) b.handlers.click(); },
  };
  return b;
}

const trustBtn = fakeBtn();
const allowBtn = fakeBtn();
global.els = { trust: trustBtn };
global.$ = (sel) => (sel === "#perm-allow" ? allowBtn : null);

// perm state + respond capture. The real respondPerm() consumes pendingPerm via
// closePerm(), which also resets the Allow label — mirror both here.
let respondCalls = [];
global.pendingPerm = null;
global.respondPerm = async (allow) => {
  if (!global.pendingPerm) return;
  respondCalls.push(allow);
  global.pendingPerm = null;
  allowBtn.textContent = "Allow";
};

// ---- load the real code (consts + functions share one eval scope) ----
(0, eval)(region("const TRUST_COUNTDOWN_S", "stopTrustCountdown"));

const openPermSrc = fnBody("openPerm");
const closePermSrc = fnBody("closePerm");

(async () => {
  // ---- 1) default state: disarmed, painted as such, key normalized ----
  setTrustArmed(trustArmed()); // what the renderer runs at startup
  check(trustArmed() === false, "default: not armed");
  check(store.clutch_trust_all === "0", "startup normalizes the stored flag to '0'");
  check(trustBtn.textContent === "🛡 Trust", "button paints the disarmed label");
  check(/OFF/.test(trustBtn.title), "disarmed title says OFF");
  check(!trustBtn.classes.has("trust-on"), "no accent class while disarmed");

  // ---- 2) arming paints + persists; disarming unpaints + unpersists ----
  setTrustArmed(true);
  check(store.clutch_trust_all === "1", "arming persists '1'");
  check(trustBtn.textContent === "🛡 Trusted", "armed label paints");
  check(trustBtn.classes.has("trust-on"), "armed gets the accent class");
  check(/ON/.test(trustBtn.title) && /10s/.test(trustBtn.title), "armed title says ON with the countdown length");
  setTrustArmed(false);
  check(trustBtn.textContent === "🛡 Trust" && store.clutch_trust_all === "0", "disarm reverts paint + flag");

  // ---- 3) disarmed: an open prompt never arms itself ----
  global.pendingPerm = { request_id: "r1" };
  startTrustCountdown();
  check(allowBtn.textContent === "Allow", "no countdown label while disarmed");
  check(advance() === 0, "no timer scheduled while disarmed");
  check(respondCalls.length === 0, "nothing auto-responds while disarmed");

  // ---- 4) armed + open prompt: label counts down, expiry allows ----
  setTrustArmed(true);
  global.pendingPerm = { request_id: "r2" };
  startTrustCountdown();
  check(allowBtn.textContent === "Allow (10s)", "first tick shows the full countdown");
  advance(); // drain the whole chain
  check(respondCalls.length === 1 && respondCalls[0] === true, "expiry auto-allows exactly once");
  check(global.pendingPerm === null, "expiry consumed the pending prompt");
  check(allowBtn.textContent === "Allow", "Allow label reset after the auto-allow");

  // ---- 5) deny/close cancels the clock: no late auto-allow ----
  global.pendingPerm = { request_id: "r3" };
  startTrustCountdown();
  stopTrustCountdown(); // what closePerm() does on allow/deny/stale final
  check(advance() === 0, "cancelled chain leaves no timers");
  check(respondCalls.length === 1, "cancelled clock never responds");
  check(allowBtn.textContent === "Allow", "cancelled clock resets the label");

  // ---- 6) disarm mid-countdown cancels too ----
  setTrustArmed(true);
  global.pendingPerm = { request_id: "r4" };
  startTrustCountdown();
  setTrustArmed(false);
  check(advance() === 0, "disarm kills the pending timers");
  check(respondCalls.length === 1, "disarm cancels the auto-allow");

  // ---- 7) arming while a prompt is already open starts the clock now ----
  global.pendingPerm = { request_id: "r5" };
  setTrustArmed(true); // no explicit startTrustCountdown() call here
  advance();
  check(respondCalls.length === 2 && respondCalls[1] === true, "arming mid-prompt starts the countdown immediately");

  // ---- 8) prompt closed under a pending tick: the guard holds ----
  global.pendingPerm = { request_id: "r6" };
  startTrustCountdown();
  global.pendingPerm = null; // closed without stopTrustCountdown (defensive path)
  advance();
  check(respondCalls.length === 2, "a tick that lands after the prompt closed responds nothing");

  // ---- 9) the real openPerm/closePerm are wired (source-level) ----
  check(/if \(trustArmed\(\)\) startTrustCountdown\(\);/.test(openPermSrc), "openPerm starts the countdown when armed");
  check(/stopTrustCountdown\(\);/.test(closePermSrc), "closePerm stops the countdown first");
  check(/els\.trust\.addEventListener\("click", \(\) => setTrustArmed\(!trustArmed\(\)\)\)/.test(src), "toggle wired to the button click");
  check(/setTrustArmed\(trustArmed\(\)\)/.test(src), "stored state painted on startup");

  // ---- 10) the host page carries the button + the armed style ----
  // device report #5: trust governs the NEXT run exactly like the work/chat
  // toggle does, so it sits beside it in .run-actions — not up in the topbar
  // next to Open/New (where it used to live)
  const trustAt = html.indexOf('id="trust-btn"');
  const modeAt = html.indexOf('id="mode-btn"');
  check(trustAt > 0, "index.html carries the trust button");
  check(trustAt > html.indexOf("</header>"), "trust button is out of the topbar");
  check(modeAt > 0 && modeAt < trustAt, "trust button follows the work/chat mode toggle");
  check(
    html.slice(modeAt, trustAt).indexOf("</div>") < 0,
    "trust button shares the run-actions group with the mode toggle"
  );
  check(/#trust-btn\.trust-on/.test(css), "style.css highlights the armed state");

  // ---- 11) wall clock: a prompt whose deadline passed while the page was away
  // closes at once on the first tick after the thaw, instead of reliving the
  // seconds the WebView was frozen for ----
  setTrustArmed(true);
  global.pendingPerm = { request_id: "r7" };
  startTrustCountdown();
  check(allowBtn.textContent === "Allow (10s)", "an armed prompt starts at the full countdown");
  nowMs += 3 * 60 * 1000; // three minutes in the background: NO timer ran
  global.document.hidden = true;
  trustResumeTick();
  check(respondCalls.length === 2, "a page that is still hidden keeps its prompt (nothing runs while away)");
  global.document.hidden = false;
  trustResumeTick();
  check(respondCalls.length === 3 && respondCalls[2] === true, "a thawed page answers the prompt its freeze outlived");
  check(allowBtn.textContent === "Allow", "the stale countdown label is reset");

  // ---- 12) arming is MIRRORED to the far side, which owns the countdown ----
  global.API_BASE = "http://127.0.0.1:8890"; // a session exists now
  trustPushes = [];
  setTrustArmed(false);
  await null;
  check(
    trustPushes.length === 1 && trustPushes[0].path === "/api/permission/trust" && trustPushes[0].body.armed === false,
    "disarming pushes the flag to the backend"
  );
  setTrustArmed(true);
  await null;
  check(trustPushes.length === 2 && trustPushes[1].body.armed === true, "arming pushes the flag to the backend");
  global.API_BASE = null;
  trustPushes = [];
  pushTrustArmed();
  await null;
  check(trustPushes.length === 0, "no backend: the push is a silent no-op (the next connect re-sends it)");

  // ---- 13) the far-side clock is re-armed on every (re)connect, and the two
  // countdowns are the same number ----
  const permPy = fs.readFileSync(path.join(ROOT, "agent", "core", "permission.py"), "utf8");
  check(/TRUST_COUNTDOWN_S = 10\.0/.test(permPy), "the far side counts down the same 10s the button shows");
  check(/document\.addEventListener\("visibilitychange", trustResumeTick\)/.test(src), "the renderer listens for the platform's resume");
  check(/window\.addEventListener\("pageshow", trustResumeTick\)/.test(src), "pageshow re-ticks too");
  check(
    /if \(typeof pushTrustArmed === "function"\) pushTrustArmed\(\);/.test(src),
    "a (re)connect re-pushes the flag: a replaced session starts disarmed"
  );
  check(/apiFetch\("\/api\/permission\/trust"/.test(fnBody("pushTrustArmed")), "the push is a POST to the permission trust endpoint");

  summary("trust-countdown-test");
})().catch((e) => {
  console.error("FAIL: unhandled error:", e);
  process.exit(1);
});
