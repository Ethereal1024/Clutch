"use strict";

// Regression test for the reported dead end: after a network blip the window
// kept claiming "Connected: http://127.0.0.1:4xxxx" while nothing answered it,
// the task badge slid to idle by itself, and the only way back was
// open/new -> "+ New SSH connection" — re-entering the very host parameters the
// window had never actually left (an old host introduced as a new one).
//
// The contract under test (ui/js/conn-lost.js):
//   * every detected disconnect funnels into connectionLost(), one idempotent
//     announcement named by the cause that got there first;
//   * the dialog it raises IS the reconnect entry, and it has exactly TWO exits,
//     both deliberate: proof of life (a session that answered — a stream that
//     opened — which is also what restores the window in place), and the user's
//     own Cancel. There is still no backdrop press, no Escape and no ×: a stray
//     key or a missed tap must not abandon a reconnect.
//   * Cancel is the picker's Disconnect in the dialog's dress: it drops the
//     standing intent (so the teardown it causes is not read back as a loss),
//     disarms the redial, settles the badge honestly and leaves the window
//     session-less with the picker's Connect as the way back in;
//   * recovery re-dials the SAME host BY NAME from the standing intent — it
//     never substitutes another one, and an OUTAGE never clears what the user
//     asked for (only the user's own Cancel does). The host's own session is
//     reached behind an ALIVE hop (a re-claim), not as a way out of a remote
//     that will not answer.
//
// Source-level checks pin the markup and the wiring; the behavioral section
// pulls the REAL functions out of the renderer and drives them against stubs
// (same trick as android-resume-test.js / no-local-fallback-test.js).
//
// Run: node tests/conn-lost-modal-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const APP = uiSource(); // the renderer, every module in page load order
const HTML = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
const CONN_LOST = fs.readFileSync(path.join(ROOT, "ui", "js", "conn-lost.js"), "utf8");
const { fnBody } = slicer(APP);
const { fnBody: connFn } = slicer(CONN_LOST);

// ---- 1. the dialog has no accidental exit ----
const modalMarkup = HTML.slice(
  HTML.indexOf('id="conn-lost-modal"'),
  HTML.indexOf("</div>", HTML.indexOf('id="conn-lost-retry"'))
);
check(/class="modal hidden"/.test(modalMarkup),
  "the dialog is in the page, hidden until a loss is detected");
check((modalMarkup.match(/<button/g) || []).length === 2 &&
  /id="conn-lost-cancel"/.test(modalMarkup) && /id="conn-lost-retry"/.test(modalMarkup),
  "its two controls are Reconnect and Cancel — still no ×, nothing else to press");
check(!/dismissOnOverlayPress\(connLostModal/.test(APP),
  "no backdrop press answers for the user");
check(!/popstate/.test(CONN_LOST),
  "no history hook either: the Android back key cannot cancel it");
check(/tabindex="-1"/.test(modalMarkup),
  "the dialog itself can hold the keys: its buttons are off screen while an attempt runs");

// ---- 1b. it says state, not advice ----
// The reported dialog was three lines of prose around one line of state. What is
// left is the title and the lines the window writes as it goes: the cause, the host
// it is going back to, the attempt's own progress, and the flow's verdict when there
// is one. A paragraph explaining that it reconnects on its own (in a dialog whose
// whole content is a reconnect in progress) is the part that went.
const dialogLines = [...modalMarkup.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
check(dialogLines.length === 4 && dialogLines.every((t) => t.trim() === ""),
  "its only static text is the title: the four lines under it are state, and every one starts empty");
check(!/reconnects on its own|keeps this|The dialog closes with/.test(modalMarkup),
  "the paragraph explaining the reconnect is gone: the dialog is doing it, not describing it");
check(/id="conn-lost-progress" class="conn-progress hidden">\s*<div class="conn-progress-track"><div id="conn-lost-progress-fill" class="conn-progress-fill"/.test(modalMarkup),
  "the reconnect has the picker's own progress bar markup, classes and all: nothing new to style");
check(/id="conn-lost-actions" class="modal-actions hidden">\s*<button id="conn-lost-cancel"[\s\S]{0,240}<button id="conn-lost-retry" class="primary"/.test(modalMarkup),
  "both doors sit in the shared actions row, which is up for the whole outage (only the modal starts hidden)");
check(!/id="conn-lost-cancel"[^>]*hidden/.test(modalMarkup) &&
  !/connLostCancelBtn\./.test(CONN_LOST),
  "and Cancel is never taken off screen by anyone: it belongs to the outage, not to the gap between two attempts");
check(/id="conn-lost-cancel" title="[^"]*welcome page[^"]*"/.test(modalMarkup) &&
  /<button id="conn-lost-cancel"[^>]*>Cancel<\/button>/.test(modalMarkup),
  "the label still says what the press does, and the title says where it lands: a window that starts fresh, as quitting and reopening would");

const closeCalls = CONN_LOST.match(/closeModal\(connLostModal\)/g) || [];
check(closeCalls.length === 2 &&
  /closeModal\(connLostModal\)/.test(connFn("resolveConnectionLost")) &&
  /closeModal\(connLostModal\)/.test(connFn("connLostCancel")),
  "the dialog comes down in exactly two places: a session that answered, and the user's own Cancel");
check(/connLostModal\.addEventListener\("keydown"/.test(CONN_LOST) &&
  /e\.key !== "Escape"/.test(CONN_LOST) &&
  /e\.preventDefault\(\)/.test(CONN_LOST),
  "Escape is swallowed instead of dismissing it");
check(!/Escape[\s\S]{0,120}closeModal/.test(CONN_LOST) &&
  !/addEventListener\("click"/.test(connFn("resolveConnectionLost")),
  "and no key or press handler reaches a close");

// one of the two exits is proof of life: the dialog resolves itself in exactly
// one place, and that place is the stream opening
const closerCalls = APP.match(/(?<!function )resolveConnectionLost\(\)/g) || [];
const SSESRC = fs.readFileSync(path.join(ROOT, "ui", "js", "sse-stream.js"), "utf8");
const onOpen = SSESRC.slice(SSESRC.indexOf("es.onopen = ()"), SSESRC.indexOf("es.onerror = "));
check(closerCalls.length === 1 && /resolveConnectionLost\(\)/.test(onOpen),
  "a stream that OPENED is what resolves the outage (an adopted URL is not a session)");
check(!/sseDegrade|reconnectSSE/.test(onOpen),
  "and an open stream does not announce anything: it is the answer, not a question");
// ...and the other exit is the user's own act, never a silent one: the standing
// intent (the one thing that would have every detector re-raise this dialog for
// an outage that is over) goes in exactly one place, and it is connLostCancel
check((CONN_LOST.match(/removeItem\("clutch_ssh_connected"\)/g) || []).length === 1 &&
  /removeItem\("clutch_ssh_connected"\)/.test(connFn("connLostCancel")),
  "the standing intent goes in exactly ONE place, and it is the user's own Cancel");

// ---- 2. one funnel: every detector announces through the same door ----
check(/connectionLost\("lost the live stream/.test(fnBody("sseDegrade")),
  "a dead stream announces itself there");
check(/connectionLost\("lost the remote connection"\)/.test(APP),
  "a tunnel end announces itself there");
check(/else connectionLost\("the host has no session for this window"\)/.test(APP),
  "and the host's own 'no session for this window' answer does too");
check(/connectionLost\(/.test(fnBody("run")) && /connectionLost\(/.test(fnBody("stop")),
  "an undeliverable run/stop is a lost session, not a toast");
check(!/notice\(/.test(connFn("connectionLost")),
  "the dialog is not a toast: nothing here dismisses itself");

// ---- behavioral harness: the real conn-lost.js against stubs ----
const store = new Map();
store.set("clutch_ssh_host", "box.example");
store.set("clutch_ssh_user", "dev");
store.set("clutch_ssh_port", "2222");
store.set("clutch_ssh_connected", "1");
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let clock = 1000000;
Date.now = () => clock;
let timers = [];
global.setTimeout = (fn, ms) => {
  const t = { fn, ms: ms || 0 };
  timers.push(t);
  return t;
};
global.clearTimeout = () => {};

const focuses = [];
function fakeEl(id) {
  const cls = new Set(["hidden"]);
  const el = {
    id,
    textContent: "",
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => {
        if (id === "conn-lost-modal" && c.includes("hidden")) opens++;
        c.forEach((x) => cls.delete(x));
      },
      contains: (c) => cls.has(c),
      toggle: (c, on) => {
        if (on === undefined ? !cls.has(c) : on) cls.add(c);
        else cls.delete(c);
      },
    },
    focus: () => focuses.push(id),
    addEventListener: () => {},
  };
  // the bar's fill (connBarWaiting / updateConnProgress reach for it): one per bar
  const fill = { style: {}, classList: { add() {}, remove() {}, contains: () => false } };
  el.querySelector = () => fill;
  return el;
}
let opens = 0;
const els = new Map();
global.$ = (sel) => {
  const id = String(sel).replace(/^#/, "");
  if (!els.has(id)) els.set(id, fakeEl(id));
  return els.get(id);
};
const connLostModal = (global.connLostModal = $("#conn-lost-modal"));
const connLostReasonEl = (global.connLostReasonEl = $("#conn-lost-reason"));
const connLostTargetEl = (global.connLostTargetEl = $("#conn-lost-target"));
const connLostStatusEl = (global.connLostStatusEl = $("#conn-lost-status"));
const connLostWhyEl = (global.connLostWhyEl = $("#conn-lost-why"));
// the dialog's own chrome: the bar an attempt in flight animates, and the two
// buttons that are the user's once it is over
const connLostProgressEl = (global.connLostProgressEl = $("#conn-lost-progress"));
const connLostActionsEl = (global.connLostActionsEl = $("#conn-lost-actions"));
const connLostRetryEl = (global.connLostRetryBtn = $("#conn-lost-retry"));
const connLostCancelEl = (global.connLostCancelBtn = $("#conn-lost-cancel"));

let drops = 0;
let selects = 0;
let closes = 0;
let statuses = [];
global.dropStaleBackend = () => {
  drops++;
};
global.renderConnSelector = () => {
  selects++;
};
// the badge (js/stream-view.js): Cancel settles it, because a window with no
// session has no run to show and none to stop
global.setStatus = (s) => {
  statuses.push(s);
  global.busy = s === "running" || s === "waiting";
};
global.closeModal = (el) => {
  closes++;
  el.classList.add("hidden");
};
global.connBusy = false;
global.IS_ANDROID = false;
// the window itself: the user's exit tears the main process's tunnel down and
// reloads the page (connLostQuit), and both halves are counted here
let reloads = 0;
let disconnects = 0;
global.window = {
  location: { reload: () => { reloads++; } },
  clutchTunnel: {
    disconnect: async () => { disconnects++; },
    status: async () => ({ active: false }),
  },
};
global.switchBackendResolved = async () => global.switchAnswer;
global.switchAnswer = false;
let handleCalls = [];
global.handleSshConnect = async (...args) => {
  handleCalls.push(args);
  return global.handleAnswer;
};
global.handleAnswer = false;

// the module state of the real file: its let-declarations are not visible to an
// indirect eval of one function at a time, so the runner owns the storage here
// (the source checks above assert the wiring; §10 asserts the declarations)
global.connLost = false;
global.connLostTries = 0;
global.connLostAttempting = false;
global.connLostTimer = null;
global.connLostManualOnly = false;
global.CONN_LOST_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];
global.CONN_LOST_NOTICE_MS = 8000;
global.CONN_LOST_WAITING = "Waiting for you";
global.CONN_LOST_EXIT_MS = 2000;
// the bar helper lives in js/conn-flow.js (above this file in the page); the one
// thing the dialog asks of it is "animate this bar until a stage arrives"
let barWaits = 0;
global.connBarWaiting = (bar) => {
  barWaits++;
  bar.classList.remove("hidden");
};

for (const name of [
  "connLostTargetText", "connLostPaint", "connLostChrome", "connectionLost",
  "resolveConnectionLost", "connLostCancel", "connLostNeedsUser", "connLostArm",
  "connLostAttempt", "connLostRecover", "connLostAskHost", "connLostRemoteIntent",
  "connLostTunnelUp", "connLostRedial", "connLostAwaitAnswer", "connLostQuit",
]) {
  (0, eval)(fnBody(name));
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
// put the REAL function back after a section stubbed it out (the eval trick
// defines globals, so a stub is one assignment away from shadowing the source)
const reload = (name) => (0, eval)(fnBody(name));
function runNextTimer() {
  const t = timers.shift();
  if (!t) return false;
  clock += t.ms;
  t.fn();
  return true;
}
async function drainTimers(max = 20) {
  let n = 0;
  while (timers.length && n++ < max) {
    runNextTimer();
    await flush();
  }
}

async function main() {
  // ---- 3. the announcement: one dialog, the first cause names it ----
  global.connLostRecover = async () => false;
  connectionLost("lost the remote connection");
  check(global.connLost === true, "a detected disconnect raises the dialog");
  check(!connLostModal.classList.contains("hidden"), "and shows it");
  check(opens === 1, "one dialog, opened in place");
  check(connLostReasonEl.textContent === "lost the remote connection",
    "named by the cause that got there first");
  check(connLostTargetEl.textContent === "Host: dev@box.example:2222",
    "and it names the host it is going back to: the user re-enters nothing");
  check(connLostWhyEl.textContent === "", "with no stale verdict from an earlier outage");
  check(drops === 1 && selects === 1,
    "the dead base is dropped and the picker stops claiming a connection");
  check(focuses.includes("conn-lost-modal") && !focuses.includes("conn-lost-retry"),
    "the dialog takes the keys itself: the first attempt starts in this same task, and the button is not on screen for it");
  check(!connLostActionsEl.classList.contains("hidden") &&
    connLostRetryEl.classList.contains("hidden") && !connLostProgressEl.classList.contains("hidden"),
    "what it shows instead is the attempt's own progress bar, with Reconnect off the row — and the labelled exit still on it");
  check(barWaits === 1, "animating from the first frame: an attempt with no stage yet is not a still bar");
  await flush();
  check(global.connLostTries === 1 && timers.length === 1,
    "the first recovery attempt is already under way");

  connectionLost("a second detector, same outage");
  connectionLost("the dead stream, same outage");
  check(connLostReasonEl.textContent === "lost the remote connection",
    "a second detector does not re-name the outage");
  check(drops === 1 && selects === 1 && opens === 1,
    "and nothing is announced twice: one dialog for one outage");

  // ---- 4. the connect flow owns its own outcome ----
  resolveConnectionLost();
  timers.length = 0;
  check(global.connLost === false && closes === 1,
    "a session that answered is what closes it");
  check(global.connLostTimer === null && global.connLostManualOnly === false,
    "and the retry machinery is disarmed with it");

  global.connBusy = true;
  connectionLost("the teardown of the tunnel the connect flow just stopped");
  check(global.connLost === false,
    "a connect attempt in flight owns the outcome: its own teardown is not a loss");
  check(opens === 1 && drops === 1,
    "so no dialog and no second drop of the base");
  global.connBusy = false;
  connectionLost("the remote went away");
  await flush();
  check(global.connLost === true && opens === 2,
    "once the flow is done, the next detector raises it");
  timers.length = 0;
  resolveConnectionLost();

  // ---- 5. the growing backoff: a host that is down is not hammered ----
  // (it no longer stops at a small number of tries: the ladder doubles to a held
  // 128s and the dialog keeps trying, because a phone that comes back into signal
  // must reconnect with nobody touching anything. The user's labelled way out is
  // Cancel, below — not exhaustion.)
  global.connLostRecover = async () => false;
  connectionLost("lost the remote connection");
  connLostWhyEl.textContent = "Installing remote server…"; // the flow's line, mid-attempt
  await flush();
  check(global.connLostTries === 1 && timers.length === 1 && timers[0].ms === 1000,
    "the first retry waits the first backoff step");
  check(/^Not back yet/.test(connLostStatusEl.textContent),
    "and says so, instead of claiming the window is back");
  check(!/Installing/.test(connLostStatusEl.textContent) &&
    /Installing/.test(connLostWhyEl.textContent),
    "nor is the flow's own line: it has a line of its own, and the two do not say the same thing twice");
  await drainTimers(1);
  await flush();
  check(global.connLostTries === 2 && timers.length === 1 && timers[0].ms === 2000,
    "the gap doubles while the host stays down");
  check(!/Reconnecting…\)/.test(connLostStatusEl.textContent),
    "the verdict is not quoted back at the user as the reason");
  // the attempt counter is what the user watches WHILE a retry is in flight
  let releaseRecover = null;
  global.connLostRecover = () => new Promise((r) => { releaseRecover = r; });
  timers.length = 0;
  const inflight = connLostAttempt();
  await flush();
  check(/attempt 3/.test(connLostStatusEl.textContent), "and the dialog counts the attempts");
  check(!connLostProgressEl.classList.contains("hidden") &&
    connLostRetryEl.classList.contains("hidden"),
    "an attempt in flight shows the bar and takes Reconnect away with it: there is no second reconnect to start");
  check(connLostWhyEl.textContent === "",
    "and the last attempt's verdict is not carried into this one");
  releaseRecover(false);
  await inflight;
  await flush();
  check(connLostProgressEl.classList.contains("hidden") &&
    !connLostRetryEl.classList.contains("hidden") &&
    focuses[focuses.length - 1] === "conn-lost-retry",
  "the moment it is over the bar goes down, the button comes back, and the keys go with it");
  timers.length = 0;
  global.connLostTries = 6;
  connLostArm();
  check(timers.length === 1 && timers[0].ms === 32000,
    "and the ladder is the same one the LLM client and the ssh hop redial on");
  timers.length = 0;
  global.connLostTries = 40;
  connLostArm();
  check(timers.length === 1 && timers[0].ms === 128000,
    "it stops growing at the top instead of running away: a remote that stays down settles at the longest gap");
  timers.length = 0;
  resolveConnectionLost();

  // ---- 6. recovery order: the remote first, the host only after it ----
  const calls = [];
  let intent = { host: "box.example", user: "dev", port: "2222" };
  let tunnelUp = false;
  let redialOk = true;
  reload("connLostRecover"); // §5 stubbed it; the real decision is under test here
  global.connLostRemoteIntent = () => {
    calls.push("intent");
    return intent;
  };
  global.connLostTunnelUp = async () => {
    calls.push("tunnelUp");
    return tunnelUp;
  };
  global.connLostRedial = async () => {
    calls.push("redial");
    return redialOk;
  };
  global.connLostAskHost = async () => {
    calls.push("askHost");
    return true;
  };

  calls.length = 0;
  check((await connLostRecover()) === true &&
    calls.join(",") === "intent,tunnelUp,redial",
  "a named remote whose hop is down is re-dialled by name, before the host is asked");
  calls.length = 0;
  tunnelUp = true;
  check((await connLostRecover()) === true && calls.join(",") === "intent,tunnelUp,askHost",
  "a working tunnel is not lifted: the dead part behind it is the host's to re-claim");
  calls.length = 0;
  tunnelUp = false;
  intent = null;
  check((await connLostRecover()) === true && calls.join(",") === "intent,askHost",
  "with nothing to re-attempt by name, the host is asked (its heal, a re-claim, a local session)");

  // ---- 7. one door: the host this window was on, however many tries it takes ----
  // (a try-counted branch used to clear the standing intent on the desktop and
  // take the host's own local session: the user was moved to another machine
  // without a word, and the picker stopped claiming the host they had asked for.
  // The remote keeps its tries instead -- on the phone AND on the desktop.)
  intent = { host: "box.example", user: "dev", port: "2222" };
  redialOk = false;
  store.set("clutch_ssh_connected", "1");
  store.set("clutch_degrade", "{}");
  global.connLostTries = 1;
  global.IS_ANDROID = false;
  calls.length = 0;
  check((await connLostRecover()) === false && calls.join(",") === "intent,tunnelUp,redial",
  "a remote that just failed is retried by name, not abandoned for another host");
  global.connLostTries = 99;
  calls.length = 0;
  check((await connLostRecover()) === false && calls.join(",") === "intent,tunnelUp,redial",
  "and it keeps those tries: there is no try-counted door to a second host");
  check(store.get("clutch_ssh_connected") === "1" && store.get("clutch_degrade") === "{}",
  "the dialog clears nothing behind the user's back: the intent is theirs to drop");

  global.IS_ANDROID = true;
  calls.length = 0;
  check((await connLostRecover()) === false && calls.join(",") === "intent,tunnelUp,redial",
  "the phone takes the same single path (it has no local session to reach for at all)");
  global.IS_ANDROID = false;
  global.connLostTries = 0;
  store.delete("clutch_degrade");

  // ---- 8. the door itself: the same host, by name, through the picker's path ----
  reload("connLostRemoteIntent"); // §6 stubbed the decision, this section tests the door
  reload("connLostRedial");
  check(JSON.stringify(connLostRemoteIntent()) ===
    JSON.stringify({ host: "box.example", user: "dev", port: "2222" }),
  "the intent is the host the picker is on, port and all");
  store.delete("clutch_ssh_connected");
  check(connLostRemoteIntent() === null,
  "no standing intent = nothing to re-attempt by name (the user left the picker disconnected)");
  store.set("clutch_ssh_connected", "1");
  const host = store.get("clutch_ssh_host");
  store.delete("clutch_ssh_host");
  check(connLostRemoteIntent() === null, "and no remembered host is nothing to re-attempt either");
  store.set("clutch_ssh_host", host);

  handleCalls = [];
  global.handleAnswer = true;
  global.connLostAwaitAnswer = async () => true;
  check((await connLostRedial({ host: "box.example", user: "dev", port: "2222" })) === true,
  "a successful redial is only a door, not the verdict");
  check(handleCalls.length === 1 && handleCalls[0][0] === "box.example" &&
    handleCalls[0][1] === "dev" && handleCalls[0][2] === "2222",
  "it runs the picker's own connect path with the remembered parameters");
  check(handleCalls[0][3] === connLostWhyEl,
  "and the flow's verdict lands in its own line, not over the dialog's progress");
  global.handleAnswer = false;
  check((await connLostRedial({ host: "h", user: "u", port: "22" })) === false,
  "a redial that never produced a session is not a recovery");

  // ---- 9. the wait for a real answer is bounded ----
  reload("connLostAwaitAnswer"); // §8 stubbed it
  global.connLost = true;
  const answered = connLostAwaitAnswer(5000);
  global.connLost = false; // the dialog came down: a stream opened (es.onopen)
  await drainTimers();
  check((await answered) === true,
  "the attempt resolves the moment the dialog's cause is gone, not when a door said ok");
  global.connLost = true;
  const never = connLostAwaitAnswer(500);
  await drainTimers();
  check((await never) === false,
  "a door that never produces a session does not hang the attempt: the wait is bounded");
  global.connLost = false;

  // ---- 10. a declined password stops the retrying ----
  global.connLost = true;
  global.connLostTries = 0;
  global.connLostRecover = async () => false;
  connLostNeedsUser();
  check(global.connLostManualOnly === true && /Waiting for you/.test(connLostStatusEl.textContent),
  "a declined password is not 'keep trying': the dialog says it waits for the user");
  connLostArm();
  check(timers.length === 0, "and nothing is armed behind their back");
  await connLostAttempt();
  check(/Waiting for you/.test(connLostStatusEl.textContent) &&
    !/retrying/.test(connLostStatusEl.textContent),
  "an attempt that fails afterwards does not claim it is retrying");
  check(!connLostRetryEl.classList.contains("hidden") &&
    connLostProgressEl.classList.contains("hidden"),
  "and Reconnect is on screen for them: the dialog is not trying anything of its own");
  global.connLost = false;
  global.connLostManualOnly = false;

  // ---- 11. the button is the user's own door back ----
  check(/\$\("#conn-lost-retry"\)\.addEventListener\("click"/.test(CONN_LOST),
  "Reconnect is wired");
  const btnHandler = CONN_LOST.slice(CONN_LOST.lastIndexOf('$("#conn-lost-retry").addEventListener("click"'));
  check(/connLostTries = 0;/.test(btnHandler) && /connLostManualOnly = false;/.test(btnHandler),
  "and it forgets the backoff and the declined prompt: the user asked");
  check(/connLostAttempt\(\);/.test(btnHandler), "then it tries");
  check(/if \(!connLost \|\| connLostAttempting\) return;/.test(btnHandler),
  "and a press cannot land on an attempt already in flight: the button is off screen then, and this is why that is safe");

  // ---- 12. the module state is real, not a per-call local ----
  check(/^let connLost = false;/m.test(CONN_LOST) &&
    /^let connLostTries = 0;/m.test(CONN_LOST) &&
    /^let connLostAttempting = false;/m.test(CONN_LOST) &&
    /^let connLostManualOnly = false;/m.test(CONN_LOST),
  "the outage is module state: several detectors share one dialog");
  check(/const CONN_LOST_BACKOFF_MS = \[1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000\];/.test(CONN_LOST) &&
    /const CONN_LOST_NOTICE_MS = 8000;/.test(CONN_LOST) &&
    !/CONN_LOST_HOST_FALLBACK_AFTER|CONN_LOST_PROOF_MS/.test(CONN_LOST),
  "and its constants are the ones this runner pins (one door, no try-counted second host, no upper bound on the tries)");
  const chromeFn = connFn("connLostChrome");
  check(/connLostRetryBtn\.classList\.toggle\("hidden", connLostAttempting\)/.test(chromeFn) &&
    /connBarWaiting\(connLostProgressEl\)/.test(chromeFn),
  "the dialog's chrome is drawn in one place, from the one fact that decides it: an attempt in flight");
  check(/connLostActionsEl\.classList\.remove\("hidden"\)/.test(chromeFn),
  "and the actions row is on screen for the whole outage, not just in the gaps: the exit is not something the user has to wait for");
  check((connFn("connLostAttempt").match(/connLostChrome\(\);/g) || []).length === 2,
  "and the attempt itself is what raises it and takes it down again");
  check(!/connLostWhy\(\)/.test(CONN_LOST),
  "nothing quotes the flow's line back into the dialog's own line");

  // ---- 13. the user's own exit: Cancel ends the outage ----
  // The redial has no end of its own any more, so the labelled exit is what keeps
  // the dialog from holding the window hostage. It is not "stop this attempt": it
  // leaves the outage for good, and it lands where a fresh start lands — the
  // welcome page, with no session, no dialog and nothing dialled. Three orders are
  // load-bearing: the standing intent goes before anything else (the teardown it
  // causes is announced as "tunnel:ended", and the renderer reads that as a LOST
  // session only while the intent is still there, js/backend-lifecycle.js), the
  // dialog goes down before the page does, and the teardown goes before the reload
  // (a reload that left the main process's tunnel up would be handed the very
  // session the user just left).
  check(/^function connLostCancel\(\) \{\n  if \(!connLost\) return;\n  localStorage\.removeItem\("clutch_ssh_connected"\);/m.test(CONN_LOST),
  "Cancel is a no-op with no outage up, and its FIRST act is to drop the standing intent");
  check(!/switchBackendResolved/.test(connFn("connLostCancel")),
  "and it asks the host for nothing: an adopted URL would arrive as a new base and raise this very dialog straight back up");

  const quitFn = connFn("connLostQuit");
  check(!/window\.clutchTunnel/.test(connFn("connLostCancel")) &&
    /window\.clutchTunnel && window\.clutchTunnel\.disconnect/.test(quitFn),
  "the teardown has exactly one owner, and it is the exit: Cancel ends the outage in place, connLostQuit is what leaves");
  check(quitFn.indexOf("clutchTunnel.disconnect") < quitFn.indexOf("location.reload()"),
  "and the exit tears the tunnel down BEFORE it reloads: a page that reloaded over a live tunnel would be handed its old session back (claimWindowBackend) and raise this dialog again within seconds");
  check(/const CONN_LOST_EXIT_MS = 2000;/.test(CONN_LOST) &&
    /Promise\.race\(/.test(quitFn) && /CONN_LOST_EXIT_MS/.test(quitFn),
  "the wait for it is bounded: a teardown that never answers is not a reason the user cannot leave");
  check(/closeModal\(connLostModal\);\n  connLostQuit\(\);/.test(connFn("connLostCancel")),
  "and leaving is the LAST thing Cancel does: nothing of this dialog is still painting while the page goes");

  const lifecycle = fs.readFileSync(path.join(ROOT, "ui", "js", "backend-lifecycle.js"), "utf8");
  check(/if \(!localStorage\.getItem\("clutch_ssh_connected"\)\) return;/.test(lifecycle),
  "which is exactly why the intent goes first: the renderer's own detector ignores a teardown with no intent behind it");

  // and it holds, driven: a live outage, a redial already armed, then the Cancel
  store.set("clutch_ssh_connected", "1");
  store.set("clutch_degrade", "{}");
  let switchCalls = 0;
  global.switchBackendResolved = async () => {
    switchCalls++;
    return true;
  };
  global.connLostRecover = async () => false; // a host that stays down
  const dropsBefore = drops;
  const selectsBefore = selects;
  const closesBefore = closes;
  timers.length = 0;
  connectionLost("lost the remote connection");
  await flush();
  check(global.connLost === true && timers.length === 1,
  "an outage is up and a redial is already armed — that is the state the user gets out of");
  check(drops === dropsBefore + 1,
  "and the dead base was dropped on the way in, so nothing keeps posting into a port nobody serves");
  const reloadsBefore = reloads;
  const disconnectsBefore = disconnects;
  connLostCancel();
  check(global.connLost === false && global.connLostTimer === null,
  "Cancel ends the outage and disarms the attempt behind it");
  check(!store.has("clutch_ssh_connected") && !store.has("clutch_degrade"),
  "the intent and the degrade mode it implied are both dropped, in that order");
  check(statuses[statuses.length - 1] === "idle",
  "the badge is settled honestly: no session means nothing to show and nothing to stop");
  check(global.busy === false,
  "and the picker's own Connect is reachable again: openFsBrowser refuses while a run is active");
  check(closes === closesBefore + 1 && connLostModal.classList.contains("hidden"),
  "and the dialog comes down — this is the second and last place that closes it");
  check(connLostStatusEl.textContent === "" && connLostWhyEl.textContent === "",
  "with nothing left over to greet the next outage");
  check(selects === selectsBefore + 2, "the picker claims no connection: there is none to claim");
  check(drops === dropsBefore + 1, "and nothing is dropped twice: the Cancel has no base left to retire");
  check(switchCalls === 0 && connLostRemoteIntent() === null,
  "and nothing goes looking for a session: with the intent gone there is no host left to re-dial by name");
  check(store.get("clutch_ssh_host") === "box.example",
  "the Cancel ends this window's outage; it does not forget the host it was on");

  // ...and then the window itself goes: tunnel down, page reloaded. That is what
  // makes the exit equal to quitting and reopening — and the page that comes back
  // must dial nothing, or it would boot straight back into an outage.
  await flush();
  check(disconnects === disconnectsBefore + 1 && reloads === reloadsBefore + 1,
  "and the window leaves the outage the way a fresh start arrives: the tunnel is torn down and the page reloaded");
  check(timers.filter((t) => t.ms === CONN_LOST_EXIT_MS).length === 1,
  "the reload waited on nothing but its own bound: a host that never answers cannot keep the user in the dialog");

  // the page that comes back: boot asks reconciledBackendUrl (js/boot.js), and with
  // the tunnel down and the intent gone there is nothing for it to dial
  (0, eval)(fnBody("reconciledBackendUrl"));
  check(!store.has("clutch_ssh_connected"),
  "the standing intent — the one thing that would re-dial the remote — is gone by the time the page reloads");
  check((await reconciledBackendUrl()) === null,
  "so the new page resolves no base and opens on the welcome page: a window with no session, which is what a fresh start looks like");
  const hideCalls = APP.match(/(?<!function )hideWelcome\(\)/g) || [];
  check(/id="welcome" class="welcome">/.test(HTML) && hideCalls.length === 2,
  "and the welcome page is what that is: it ships visible in the markup, and the only two calls that hide it are the two ways a project gets opened (js/project.js)");
  check(/function hideWelcome\(\) \{\n  document\.getElementById\("welcome"\)\.classList\.add\("hidden"\);/.test(APP),
  "no boot path, no reload path and no restore hides it: the window the user lands on is the fresh one");

  // the window is now honestly session-less: nothing raises the dialog again on
  // its own account, and the detector the teardown feeds decides by the intent
  check(global.connLost === false, "no detector re-raises it for the outage the user just ended");

  // ---- 13b. the exit is usable WHILE an attempt is in flight ----
  // The press the old handler dropped on the floor ("an attempt is running, wait
  // for the gap"). It is the same act either way, so the user must not have to
  // wait out an attempt — let alone a 128s ladder — to leave; and the attempt that
  // comes back to a window that has left has nothing to say.
  const cancelHandler = CONN_LOST.slice(
    CONN_LOST.lastIndexOf('$("#conn-lost-cancel").addEventListener("click"')
  );
  check(!/connLostAttempting/.test(cancelHandler) && /connLostCancel\(\);/.test(cancelHandler),
  "the Cancel button is wired to the exit and to nothing else: no 'an attempt is running' guard, in the handler or on the row");

  store.set("clutch_ssh_connected", "1");
  let releaseAttempt = null;
  global.connLostRecover = () => new Promise((r) => { releaseAttempt = r; });
  timers.length = 0;
  const reloadsBefore2 = reloads;
  const closesBefore2 = closes;
  connectionLost("lost the remote connection");
  await flush();
  check(global.connLostAttempting === true && connLostRetryEl.classList.contains("hidden") &&
    !connLostActionsEl.classList.contains("hidden"),
  "an attempt in flight is exactly when Reconnect is off the row — and the exit is still on it");
  check(!focuses.includes("conn-lost-cancel"),
  "and nothing puts the keys on the way out: a stray tap must not quit the window, so nothing focuses it");
  connLostCancel(); // the press the old handler swallowed
  await flush();
  check(global.connLost === false && closes === closesBefore2 + 1 && reloads === reloadsBefore2 + 1,
  "the press lands mid-attempt: the outage ends and the page reloads, with no gap to wait for");
  const timersAfterExit = timers.length;
  releaseAttempt(false); // the attempt's own door answers at last: too late
  await flush();
  check(global.connLostAttempting === false && timers.length === timersAfterExit,
  "and the attempt that comes back late arms no redial behind the exit");
  check(connLostStatusEl.textContent === "" && connLostModal.classList.contains("hidden"),
  "nor writes its verdict into a dialog that is gone: the user left, and this attempt has nothing to say");
  check(reloads === reloadsBefore2 + 1 && !store.has("clutch_ssh_connected"),
  "one exit, one reload — and the new page still finds no intent to re-dial");

  check(/if \(!connLost\) return;/.test(connFn("connLostChrome")),
  "and the chrome is not painted for a dialog that is already out of the user's way");

  summary("conn-lost-modal");
}

main().catch((e) => {
  console.error("FAIL:", (e && (e.stack || e.message)) || e);
  process.exit(1);
});
