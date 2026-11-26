"use strict";

// A run that could not REACH its session is not a run that failed (the field
// report: connect to another device, then Run on the tab that was left behind —
// "run failed: fetch failed" over a session that was not there, with nothing the
// user could do about it).
//
// The failure was classified in the wrong place. node's fetch says only "fetch
// failed" (no status, no code — the socket's own words are in `cause`), the main
// process passed `code: null` through, ui/bridge-shim.js turned that null into
// "host_error", and the page drew it as a transcript line instead of raising the
// connection-lost dialog it already had. And the claim kept handing the same dead
// local port back, so every later Run and every Reconnect said the same thing.
//
// ui/main.ts now answers every run:* send through ONE classifier:
//   * no status, no code, network-shaped message (or a socket code that arrived as
//     the error's own code) → `no_session`, and the claim's dead forward is
//     dropped so the next claim re-binds the SAME session through the live hop;
//   * anything else — a status, or a code the loop set (project_mismatch,
//     run_elsewhere, run_active) — is the session's own verdict, kept word for
//     word, and nothing is dropped for it.
//
// The classifier is driven here from the REAL source, not re-implemented: both
// functions and the real `slotOf` are sliced out of ui/src/host/main.ts and run
// against stubs for the three things they touch (hostCore, tunnelLog, and the
// real looksLikeNetwork from ui/mirrors.js).
//
// Run: node tests/run-unreachable-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const MAIN = fs.readFileSync(path.join(ROOT, "ui", "main.js"), "utf8"); // what runs
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "ui", "src", "host", "main.ts"), "utf8");
const EVENTS = fs.readFileSync(path.join(ROOT, "ui", "src", "renderer", "render-events.ts"), "utf8");
const { looksLikeNetwork } = require(path.join(ROOT, "ui", "mirrors.js"));

// ---- 1. every run:* entry point answers through the one classifier ----
const sites = (MAIN.match(/return runFailure\(err, \{ winId: e\.sender\.id, slotId \}\)/g) || []).length;
check(sites === 5,
  "all five run:* sends (start, step, drive, run, and the guarded stop path) answer a failed send through runFailure — no entry point keeps its own spelling of the code");
check((MAIN.match(/code: \(err && err\.code\) \|\| null/g) || []).length === 1,
  "…and the one place that still names an error's code is the classifier's own fallback: nothing else can decide that a failure has no code");

// the repair, in the instance builder: a base whose forward carries no bytes is
// dropped and asked for once more through the live hop
check(/if \(!unreachableSession\(err\)\)\s*throw err;/.test(MAIN) &&
  /hostCore\.dropSlotForward\(winId, slotId\)/.test(MAIN) &&
  /const again = await hostCore\.ensureSlotBackend\(wc, slotId\);/.test(MAIN) &&
  /if \(!again \|\| again === base\)\s*throw err;/.test(MAIN),
  "the instance builder drops the forward that carried no bytes and re-claims once, so the run the user pressed for happens over the session that was there all along");

// the page's door for this code is the connection-lost dialog, not a transcript
// line — the reason `no_session` is the right answer and `host_error` was not
check(/e\.code === "no_session"[\s\S]{0,200}connectionLost\(/.test(EVENTS),
  "the renderer routes `no_session` to the connection-lost dialog: the code this classifier returns is the door it was already built around");

// ---- 2. the classifier, driven from the real source ----
// `slotOf` is a one-line const arrow (not a function declaration), so it is lifted
// by its own line and the two functions by their bodies; they run together in one
// closure, which is how the file has them.
const SLOT_OF = (MAIN_SRC.match(/^const slotOf = .*$/m) || [""])[0];
check(/typeof slotId === "string"/.test(SLOT_OF),
  "the runner found the real slotOf — a slot id that is not a string is the window's default slot, and that rule is not restated here");
const CLASSIFIER = slicer(MAIN_SRC).region("const NET_CODES =", "runFailure");

let drops = [];
let logged = [];
const api = (0, eval)(
  runnableSnippet(
    "(function () {" +
      SLOT_OF +
      "\n" +
      CLASSIFIER +
      "\nreturn { unreachableSession, runFailure };\n})()"
  )
);
check(typeof api.unreachableSession === "function" && typeof api.runFailure === "function",
  "the classifier itself was sliced out of ui/src/host/main.ts and is what runs below — no paraphrase to drift from it");

global.hostCore = {
  dropSlotForward: (winId, slotId) => {
    drops.push([winId, slotId]);
    return true;
  },
};
global.tunnelLog = (line) => logged.push(String(line));
global.looksLikeNetwork = looksLikeNetwork; // the real one, shared with the mirror fallback

function reset() {
  drops = [];
  logged = [];
}

// the reported failure, exactly: undici's TypeError carries no status and no code
reset();
let r = api.runFailure(new TypeError("fetch failed"), { winId: 7, slotId: "tab-a" });
check(r.ok === false && r.code === "no_session" && r.error === "fetch failed" && r.owner === null,
  "undici's bare `fetch failed` is answered as no_session — the session could not be reached, and the page can act on that");
check(drops.length === 1 && drops[0][0] === 7 && drops[0][1] === "tab-a",
  "and the claim's dead forward is dropped for THAT slot, so the next claim does not hand the same port back");
check(logged.some((l) => /\[run\] the session could not be reached: fetch failed/.test(l)),
  "…and the tunnel log says which sentence arrived: a bare 'fetch failed' with no context is what made this take a session to find");

// the socket's other words, and a socket code that arrived as the error's own code
for (const err of [
  new Error("socket hang up"),
  new Error("read ECONNRESET"),
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:40563"), { code: "ECONNREFUSED" }),
]) {
  reset();
  r = api.runFailure(err, { winId: 7, slotId: "t" });
  check(r.code === "no_session" && drops.length === 1,
    `"${err.message}" is still 'could not reach it' (a socket code is not a verdict about this turn)`);
}

// no slot named: still no_session (the page must reconnect), nothing to drop
reset();
r = api.runFailure(new TypeError("fetch failed"));
check(r.code === "no_session" && drops.length === 0,
  "with no slot named there is no forward to drop, and the answer is still no_session — the base lookup that failed before any claim existed has nothing else to say");

// the session's own verdicts keep their word, and nothing is dropped for them
reset();
r = api.runFailure(
  Object.assign(new Error("this project is already open in another window"), {
    code: "project_mismatch",
  }),
  { winId: 7, slotId: "t" }
);
check(r.code === "project_mismatch" && drops.length === 0,
  "a project_mismatch is the session answering (offer the read-only choice) — never a dead forward, so nothing is dropped");
reset();
r = api.runFailure(
  Object.assign(new Error("another window is driving this turn"), {
    code: "run_elsewhere",
    owner: "win-3",
  }),
  { winId: 7, slotId: "t" }
);
check(r.code === "run_elsewhere" && r.owner === "win-3" && drops.length === 0,
  "run_elsewhere keeps its code and its owner: the page asks THAT window, and the claim it names is not touched");
reset();
r = api.runFailure(Object.assign(new Error("this window is already driving this turn"), { code: "run_active" }), {
  winId: 7,
  slotId: "t",
});
check(r.code === "run_active" && drops.length === 0,
  "run_active keeps its code too: a second wheel this window already has is not a lost session");

// a status is an answer about the request, not a dead socket
reset();
r = api.runFailure(Object.assign(new Error("conflict"), { status: 409 }), { winId: 7, slotId: "t" });
check(r.code === null && drops.length === 0,
  "an error carrying an HTTP STATUS is left exactly as it was: the session (or a gateway) answered, so no code is invented and no forward is dropped");

// an ordinary failure is an ordinary failure
reset();
r = api.runFailure(new Error("the task is empty"), { winId: 7, slotId: "t" });
check(r.code === null && r.error === "the task is empty" && drops.length === 0,
  "an ordinary failure keeps the page's inline path: no code, no dialog, no claim dropped");

check(api.runFailure(undefined).code === null && api.runFailure(null).code === null && !api.unreachableSession(undefined),
  "nothing threw at the classifier is never a lost session");

// the two answers a slot's default claim gets: "" and the tab's id both reach
// dropSlotForward through the file's own slotOf, never through a caller's spelling
reset();
api.runFailure(new TypeError("fetch failed"), { winId: 7 });
api.runFailure(new TypeError("fetch failed"), { winId: 7, slotId: 12 });
check(drops.length === 2 && drops[0][1] === "" && drops[1][1] === "",
  "a slot id that is not a string IS the window's default slot: one rule, in the one place that knows it");

summary("run-unreachable");
