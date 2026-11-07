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
//   1. the PAGE asks (ui/js/render-events.js resumeTurn): state({mode, project})
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
  const src = read("ui/js/render-events.js");
  const body = slicer(src).fnBody("resumeTurn");

  check(/^async function resumeTurn\(\)/.test(body), "resumeTurn is the page's one entry into a turn it did not open");
  check(
    /if \(!currentProject \|\| busy\) return;/.test(body),
    "it asks only when there is a log to look at and no turn is already this page's"
  );
  check(
    /host\.state\(\{ mode: agentMode, project: currentProject \}\)/.test(body),
    "it asks the host with run:start's own {mode, project}: resume uses the same claim, not a second one"
  );
  check(
    /answer\.result\.phase !== "open"\) return;/.test(body),
    "an idle fold does nothing at all — a turn is continued, never invented"
  );
  check(/host\.drive\(\)/.test(body), "an open fold is driven by the host: the SAME call the Run button makes");
  check(!/fetch\(|apiFetch\(/.test(body), "the page reads no log of its own: the fold is the host's answer");
  check(!/type: *"final"/.test(body), "and it writes nothing: the turn's ending is the loop's own line");
  check(
    /e\.code === "run_active"/.test(body) && /another window/.test(body),
    "another window's driver is reported as such, not as a dead session"
  );
}

// ---- 2. the two doors that know a project (boot.js, project.js) ----
{
  const boot = read("ui/js/boot.js");
  check(
    count(boot, /resumeTurn\(\)/g) === 1,
    "a boot asks once (a page that already knows a project can continue before the first row)"
  );

  const project = read("ui/js/project.js");
  check(count(project, /resumeTurn\(\)/g) === 1, "opening a project asks once — and not on create: there is nothing to resume");
  const open = project.slice(project.indexOf("async function openProject("));
  const atReplay = open.indexOf("refreshRollbackAnchors()");
  const atResume = open.indexOf("resumeTurn()");
  check(atReplay > 0 && atResume > atReplay, "asked AFTER the log was replayed: the rows are on screen before the turn moves");

  // and no third door invented its own: the only callers are these two. The
  // declaring file is stripped first — `function resumeTurn()` is not a call.
  const uiFiles = fs.readdirSync(path.join(ROOT, "ui", "js")).filter((f) => f.endsWith(".js"));
  const callsResume = (f) =>
    /resumeTurn\(\)/.test(read("ui/js/" + f).replace(/async\s+function\s+resumeTurn/, "function"));
  const callers = uiFiles.filter(callsResume);
  check(
    callers.sort().join(",") === "boot.js,project.js",
    `exactly two callers, one function (got ${callers.sort().join(",")})`
  );
}

// ---- 3. the host can be asked before any start (desktop) ----
{
  const src = read("ui/main.js");
  const start = handlerBody(src, "run:start");
  const state = handlerBody(src, "run:state");

  check(/ensureRunInstance\(e\.sender, payload\)/.test(start), "run:start builds through the shared ensure path");
  check(/ensureRunInstance\(e\.sender, payload\)/.test(state), "run:state builds through the SAME path");
  check(
    count(src, /createSessionRun\(/g) === 1,
    `one construction site in ui/main.js (got ${count(src, /createSessionRun\(/g)}) — a second one is a second loop`
  );
  check(!/phase: *"idle"/.test(state), "run:state never answers a invented idle: absence of an instance was the wrong answer");
  check(
    /code: \(err && err\.code\) \|\| null/.test(state),
    "its refusal carries the code (run_active, no_session) the page decides on"
  );
}

// ---- 4. ...and on the phone's wire ----
{
  const src = read("android/host/android-host.js");
  check(count(src, /createSessionRun\(/g) === 1, "one construction site on the phone too");
  const ensure = slicer(src).fnBody("ensureRun");
  check(/createSessionRun\(/.test(ensure), "the ensure path is where the instance is built");
  check(/runInst\.base === base/.test(ensure) && /runInst\.mode === mode/.test(ensure) && /runInst\.project === project/.test(ensure),
    "rebuilt when the base, the mode or the project changed — the same three facts as the desktop");
  check(/state: async \(payload\)[^]*ensureRun\(payload \|\| \{\}\)/.test(src), "the phone's state() builds on demand and takes the payload");
  check(!/result: \{ phase: "idle" \}/.test(src), "and it no longer answers idle for a missing instance");
}

// ---- 5. the payload crosses both bridges (a dropped one asks with no claim) ----
{
  const preload = read("ui/preload.js");
  const shim = read("ui/bridge-shim.js");
  check(/state: \(payload\) => ipcRenderer\.invoke\("run:state", payload\)/.test(preload), "preload passes the payload to run:state");
  check(/state: \(payload\) => call\("clutchRun", "state", \[payload\]\)/.test(shim), "the phone's shim passes it in the args array");
}

summary("resume-turn-test.js");
