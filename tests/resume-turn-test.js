// Resume (P2-3): a turn continues after a cold start because the LOG says one
// is open — not because a process remembered anything.
//
// "Resume" is not a feature with its own code path: ui/run.js re-reads the log
// and re-folds it on every step, so continuing is `state()` and then `drive()`
// when the fold answers `{phase:"open"}`. What P2-3 had to add is WHO asks that
// question after the page that opened the turn is gone, and what makes the
// question answerable in the host at all. Both are wiring, so both are pinned
// here as source facts:
//
//   1. the PAGE asks (ui/src/renderer/render-events.ts resumeTurn): state({mode, project})
//      — the same payload run:start takes, so `project` stays the claim the host
//      checks and never a destination — and drive() only for an open fold.
//   2. it is asked from the two doors that know a project (js/boot.js, and the
//      project open in js/project.js), through that ONE function.
//   3. the HOST can answer before any start: run:state builds the loop through
//      the same ensure-instance path run:start uses, on both wires (ui/main.js
//      and android/host/android-host.js). "There is no instance" is not an
//      answer to "is a turn open?" — it used to be answered `{phase:"idle"}`,
//      the one wrong answer, because it means "nothing to do".
//
// Run: node tests/resume-turn-test.js

"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const count = (src, re) => (src.match(re) || []).length;

// A handler's text: from its `ipcMain.handle("<name>"` up to the next handler
// (or the end of the block), so the check is about THIS handler's body.
function handlerBody(src, name) {
  const at = src.indexOf(`ipcMain.handle("${name}"`);
  if (at < 0) throw new Error(`missing ipcMain handler: ${name}`);
  const next = src.indexOf("ipcMain.handle(", at + 1);
  return src.slice(at, next < 0 ? src.length : next);
}

// ---- 1. the page's question (js/render-events.js) ----
{
  const src = read("ui/src/renderer/render-events.ts");
  const body = slicer(src).fnBody("resumeTurn");

  check(/^async function resumeTurn\(\)/.test(body), "resumeTurn is the page's one entry into a turn it did not open");
  check(
    /if \(!currentProject \|\| busy\) return;/.test(body),
    "it asks only when there is a log to look at and no turn is already this page's"
  );
  check(
    /host\.state\(slotId, \{ mode: agentMode, project: currentProject \}\)/.test(body),
    "it asks the host with run:start's own {mode, project}: resume uses the same claim, not a second one"
  );
  check(
    /answer\.result\.phase !== "open"\) return;/.test(body),
    "an idle fold does nothing at all — a turn is continued, never invented"
  );
  check(/host\.drive\(slotId\)/.test(body), "an open fold is driven by the host: the SAME call the Run button makes");
  check(/if \(answer\.driven\) return;/.test(body),
    "a turn this window is ALREADY driving is not resumed: that second drive was the 'a step is already running' on every switch");
  const atRefusal = body.indexOf('e.code === "run_active"');
  const branch = body
    .slice(atRefusal, body.indexOf("return;", atRefusal) + 7)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check(
    atRefusal > 0 && /return;\s*$/.test(branch.trim()) && !/setStatus\(|setTabRunning\(/.test(branch),
    "a refused drive (somebody already has the wheel) leaves the badge alone: the old idle flip is what made a live tab look dead"
  );
  check(!/fetch\(|apiFetch\(/.test(body), "the page reads no log of its own: the fold is the host's answer");
  check(!/type: *"final"/.test(body), "and it writes nothing: the turn's ending is the loop's own line");
  check(
    /e\.code === "run_active"/.test(body) && /another window/.test(body),
    "another window's driver is reported as such, not as a dead session"
  );
  // A turn another window is running is not a resume this page failed at: the
  // claim pill is the account of it (render-events.ts announceProjectClaim), so a
  // toast here would be one window announcing another's work as a fault.
  const atForeign = body.indexOf('e.code === "run_elsewhere"');
  const foreign = body.slice(atForeign, body.indexOf("return;", atForeign) + 7);
  check(
    atForeign > atRefusal &&
      /setStatus\("idle"\)/.test(foreign) &&
      !/notice\(|connectionLost\(/.test(foreign),
    "another window's run is a fact, not a failure: no toast, and the optimistically painted badge goes back"
  );

  // the Run button's own door: a refusal is not a failed run
  const runBody = slicer(src).fnBody("run");
  const atActive = runBody.indexOf('e.code === "run_active"');
  const atFailed = runBody.indexOf('"run failed: "');
  check(
    atActive > 0 && atFailed > atActive && /return;/.test(runBody.slice(atActive, atFailed)),
    "a click that meets a drive already in flight stays on it instead of writing 'run failed' over a running turn"
  );
}

// ---- 2. the two doors that know a project (boot.js, project.js) ----
{
  const boot = read("ui/src/renderer/boot.ts");
  check(
    count(boot, /resumeTurn\(\)/g) === 1,
    "a boot asks once (a page that already knows a project can continue before the first row)"
  );

  const project = read("ui/src/renderer/project.ts");
  check(count(project, /resumeTurn\(\)/g) === 1, "opening a project asks once — and not on create: there is nothing to resume");
  const open = project.slice(project.indexOf("async function openInTab("));
  const atReplay = open.indexOf("refreshRollbackAnchors()");
  const atResume = open.indexOf("resumeTurn()");
  check(atReplay > 0 && atResume > atReplay, "asked AFTER the log was replayed: the rows are on screen before the turn moves");

  // and no third door invented its own: the only callers are these two. The
  // declaring file is stripped first — `function resumeTurn()` is not a call.
  const uiFiles = fs
    .readdirSync(path.join(ROOT, "ui", "src", "renderer"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  const callsResume = (f) =>
    /resumeTurn\(\)/.test(read("ui/src/renderer/" + f).replace(/async\s+function\s+resumeTurn/, "function"));
  const callers = uiFiles.filter(callsResume);
  check(
    callers.sort().join(",") === "boot.ts,project.ts",
    `exactly two callers, one function (got ${callers.sort().join(",")})`
  );
}

// ---- 3. the host can be asked before any start (desktop) ----
{
  const src = read("ui/main.js");
  const start = handlerBody(src, "run:start");
  const state = handlerBody(src, "run:state");

  check(/ensureRunInstance\(e\.sender, slotId, payload\)/.test(start), "run:start builds through the shared ensure path");
  check(/ensureRunInstance\(e\.sender, slotId, payload\)/.test(state), "run:state builds through the SAME path");
  check(
    count(src, /createSessionRun\(/g) === 1,
    `one construction site in ui/main.js (got ${count(src, /createSessionRun\(/g)}) — a second one is a second loop`
  );
  check(!/phase: *"idle"/.test(state), "run:state never answers a invented idle: absence of an instance was the wrong answer");
  check(
    /code: got\.code \|\| null, owner: got\.owner \|\| null/.test(state) &&
      /return runFailure\(err, \{ winId: e\.sender\.id, slotId \}\)/.test(state),
    "its refusal carries the code (run_active, no_session) the page decides on — the instance builder's code, or the one classifier's verdict for a send that never reached a session"
  );
  // ONE wheel per turn: a second start/drive on an instance that is already
  // driving is refused BEFORE it can step the loop — the session's own lease
  // cannot catch it (claim_run refuses only a different project).
  check(/const refuseIfDriving = \(inst\) =>/.test(src), "the host has one refusal for a turn it is already driving");
  for (const name of ["run:start", "run:run", "run:step", "run:drive"]) {
    const h = handlerBody(src, name);
    check(/refuseIfDriving\(/.test(h), `${name} refuses before it touches a loop that is already driving`);
  }
  check(!/refuseIfDriving\(/.test(handlerBody(src, "run:stop")),
    "run:stop stays allowed: it is how a drive is cancelled");
  check(/driven: !!got\.inst\.driving/.test(state),
    "run:state says whether THIS window is the one driving — the half of the answer the fold cannot carry");
}

// ---- 4. ...and on the phone's wire ----
{
  const src = read("android/host/src/android-host.ts");
  check(count(src, /createSessionRun\(/g) === 1, "one construction site on the phone too");
  const ensure = slicer(src).fnBody("ensureRun");
  check(/createSessionRun\(/.test(ensure), "the ensure path is where the instance is built");
  check(/inst\.base === base/.test(ensure) && /inst\.mode === mode/.test(ensure) && /inst\.project === project/.test(ensure),
    "rebuilt when the base, the mode or the project changed — the same three facts as the desktop");
  check(/state: async \(first, second\)[^]*ensureRun\(slotId, payload\)/.test(src), "the phone's state() builds on demand and takes the payload");
  check(!/result: \{ phase: "idle" \}/.test(src), "and it no longer answers idle for a missing instance");
  check(/const refuseIfDriving = \(inst\) =>/.test(src) &&
    (src.match(/refuseIfDriving\(/g) || []).length >= 4,
    "the phone refuses a second wheel too: start, run, step and drive all go through it");
  check(/driven: !!\(inst && inst\.driving\)/.test(src),
    "…and its state() carries the same `driven` the page skips on");
}

// ---- 5. the payload crosses both bridges (a dropped one asks with no claim) ----
{
  const preload = read("ui/preload.js");
  const shim = read("ui/src/renderer/bridge-shim.ts");
  check(/state: \(slotId, payload\) => ipcRenderer\.invoke\("run:state", \.\.\.runArgs\(slotId, payload\)\)/.test(preload), "preload passes the payload to run:state");
  check(/state: \(slotId, payload\) => call\("clutchRun", "state", runArgs\(slotId, payload\)\)/.test(shim), "the phone's shim passes it in the args array");
}

summary("resume-turn-test.js");
