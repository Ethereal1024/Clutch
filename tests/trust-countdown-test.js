"use strict";

// Trust mode: a topbar toggle that arms the perm dialog — an open prompt
// auto-allows itself after TRUST_COUNTDOWN_S seconds unless the user denies
// (or closes) first. UI-side only: the armed flag is localStorage
// ("clutch_trust_all"), the countdown is a 1s setTimeout chain in app.js, and
// expiry takes the same respondPerm(true) path as clicking Allow, so the
// backend sees an ordinary allow.
//
// Like stream-render-test.js this extracts the REAL functions from ui/app.js
// (the whole trust block, openPerm/closePerm hooks asserted on source) and
// drives them against stubs with fake timers, so a silent edit to app.js that
// breaks the countdown fails here.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");

const { fnBody, region } = slicer(src);

// ---- stub environment ----
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

// fake timers: every setTimeout lands in a list; advance() fires pending
// timers pass by pass until the chain drains (bounded, so a runaway reschedule
// loop fails the test instead of hanging it).
let timers = [];
global.setTimeout = (fn) => { timers.push({ fn, cleared: false }); return timers.length; };
global.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
function advance() {
  for (let pass = 0; pass < 100 && timers.some((t) => !t.cleared); pass++) {
    const due = timers;
    timers = []; // a fired tick may re-schedule into the fresh list
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
  setTrustArmed(trustArmed()); // what app.js runs at startup
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
  stopTrustCountdown(); // what closePerm() does on allow/deny/overlay/stale final
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
  check(/id="trust-btn"/.test(html), "index.html has the topbar trust button");
  check(/id="topbar"/.test(html.slice(0, html.indexOf('id="trust-btn"'))), "trust button sits inside the topbar markup");
  check(/#trust-btn\.trust-on/.test(css), "style.css highlights the armed state");

  summary("trust-countdown-test");
})().catch((e) => {
  console.error("FAIL: unhandled error:", e);
  process.exit(1);
});
