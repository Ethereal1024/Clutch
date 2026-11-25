"use strict";

// The run claim in the page: "not writable here" has two causes, and only one of
// them is about a file.
//
// A .clc is claimed by the session that RUNS it, not by the windows looking at
// it, so an idle project belongs to nobody and opens everywhere. What a reader
// must not do is WRITE while another window's run is in flight — and that is a
// fact about the moment, said by the session (the status frame at connect, then
// its own `running_elsewhere` frames, agent/server.py claim_watch_loop) and never
// guessed here.
//
// This runner drives the REAL functions: the two flags and their paint
// (stream-view.ts setReadOnly/setClaimed/paintControls), the announcements they
// arrive as (render-events.ts announce*), and the source wiring between the wire
// frames, the document events, the pill and its click.
//
// Run: node tests/claim-pill-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const view = read("ui/src/renderer/stream-view.ts");
const events = read("ui/src/renderer/render-events.ts");
const project = read("ui/src/renderer/project.ts");
const { fnBody: viewBody } = slicer(view); // stream-view.ts: what the reader sees
const { fnBody: evBody } = slicer(events); // render-events.ts: the wire frames

// ---- the composer, as stream-view.ts touches it ----
function control() {
  const cls = new Set();
  return {
    textContent: "",
    title: "",
    disabled: false,
    readOnly: false,
    attributes: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
    classList: {
      toggle(c, on) {
        const v = on === undefined ? !cls.has(c) : !!on;
        if (v) cls.add(c);
        else cls.delete(c);
        return v;
      },
      has: (c) => cls.has(c),
    },
  };
}
const els = { run: control(), task: control(), mode: control(), claim: control(), status: control() };

// ---- the globals those functions read (module-level on the page) ----
global.els = els;
global.sending = false;
global.busy = false;
global.currentProject = "proj.clc";
// the two flags the session answers: a viewer open, and another window's run
global.readOnly = false;
global.claimed = false;
const dispatched = [];
global.document = { dispatchEvent: (ev) => dispatched.push(ev) };
global.CustomEvent = class {
  constructor(type, init) {
    this.type = type;
    this.detail = (init && init.detail) || {};
  }
};

// ---- the real code ----
(0, eval)(runnableSnippet(viewBody("paintControls")));
(0, eval)(runnableSnippet(viewBody("setReadOnly")));
(0, eval)(runnableSnippet(viewBody("setClaimed")));
(0, eval)(runnableSnippet(viewBody("setStatus")));
(0, eval)(runnableSnippet(evBody("announce")));
(0, eval)(runnableSnippet(evBody("announceProjectReadOnly")));
(0, eval)(runnableSnippet(evBody("announceProjectClaim")));

const pillShown = () => !els.claim.classList.has("hidden");
const writable = () => !els.run.disabled && !els.task.readOnly && !els.mode.disabled;

// ---- 1) another window's run: the composer is not this window's, and says why ----
setStatus("idle");
check(writable() && !pillShown(), "idle with no foreign claim: the composer is the reader's");

setClaimed(true);
check(els.run.disabled === true, "a running window elsewhere takes the Run button");
check(els.task.readOnly === true, "and the box it would send from (read-only, so the text stays copyable)");
check(els.mode.disabled === true, "and the mode, which applies to a run this window cannot start");
check(/another window is running this project/.test(els.run.title),
  `the dead button explains itself (${els.run.title})`);
check(pillShown(), "the pill is up: it is the one thing the reader can do about it");

// ---- 2) the run ends, and nothing has to be retried ----
setClaimed(false);
check(writable(), "when that run ends the composer comes back by itself — no reload, no re-open");
check(!pillShown(), "and the pill goes with it");
check(!/another window/.test(els.run.title), "the button's explanation is gone too");

// ---- 3) a viewer open is the other cause, and it is NOT a foreign run ----
setReadOnly(true);
check(els.run.disabled === true && els.task.readOnly === true && els.mode.disabled === true,
  "a project opened as a viewer here cannot be written to either");
check(/read-only/.test(els.run.title), `and says which of the two it is (${els.run.title})`);
check(!pillShown(), "but the pill is about ANOTHER window, so a viewer open does not show it");
setReadOnly(false);
check(writable(), "the viewer flag is the session's; turning it off gives the composer back");

// ---- 4) the two flags reach the page as announcements, from the wire frames ----
const wire = evBody("renderEvent");
check(/if \(typeof ev\.read_only === "boolean"\) announceProjectReadOnly\(ev\.read_only\);/.test(wire),
  "the status frame's `read_only` is announced (every connect re-answers the mode)");
check(/if \(typeof ev\.running_elsewhere === "boolean"\)[\s\S]{0,120}announceProjectClaim\(ev\.running_elsewhere, ev\.claim_owner\);/.test(wire),
  "so is `running_elsewhere` — the same status frame carries whether another window holds the run");
check(/if \(ev\.key === "running_elsewhere"\) announceProjectClaim\(!!ev\.value, ev\.claim_owner\);/.test(wire),
  "and the live change arrives as its own frame (the claim watch loop sends transitions only)");
check(/export function announceProjectClaim\(claimed, owner\?\)[\s\S]{0,120}owner: owner \|\| null/.test(events),
  "the announcement carries the owner record: the window behind a claim is the one thing that can be proven gone");

announceProjectClaim(true);
const claim = dispatched.at(-1);
check(claim && claim.type === "clutch:project-claim" && claim.detail.claimed === true,
  "the announcement is a document event carrying the fact, not a call into the view");
announceProjectClaim(false);
check(dispatched.at(-1).detail.claimed === false, "both directions travel: the end of a run is an announcement too");
announceProjectReadOnly(true);
check(dispatched.at(-1).type === "clutch:project-read-only" && dispatched.at(-1).detail.readOnly === true,
  "the viewer open has its own announcement, because it ends differently");

// ---- 5) the page hands them to the view, and the pill reloads the project ----
check(/addEventListener\("clutch:project-read-only"[\s\S]{0,160}setReadOnly\(!!d\.readOnly\)/.test(project),
  "project.ts wires the viewer announcement to the flag");
check(/addEventListener\("clutch:project-claim"[\s\S]{0,160}setClaimed\(!!d\.claimed\)/.test(project),
  "and the claim announcement to its own");
check(/claimPill\.addEventListener\("click", \(\) => \{ void reloadActiveProject\(\); \}\)/.test(project),
  "the pill's click is the reload the pill promises");
check(
  /addEventListener\("clutch:project-claim"[\s\S]{0,300}setClaimed\(!!d\.claimed\)[\s\S]{0,300}void settleAnnouncedClaim\(pendingClaim\)/.test(project),
  "a claim that names a window is settled unasked, from the frame (this is what frees a dead window's claim)"
);

const settle = fnBodyOf("settleAnnouncedClaim");
check(/settledClaims\.has\(key\)/.test(settle) && /settlingClaim/.test(settle),
  "asking is once per claim and one at a time — a reclaim is not a poll");
check(/typeof api\.settleClaim !== "function"\) return;/.test(settle) &&
  /api\.settleClaim\(tab\.id, project, owner\)/.test(settle),
  "the host is asked for the owner this page was told about, through its slot");
check(/if \(answer && \(answer\.verdict === "reclaimed" \|\| answer\.verdict === "free"\)\) \{[\s\S]{0,200}await reloadActiveProject\(tab\)/.test(settle),
  "a reclaimed (or already free) claim re-reads the pane: the transcript is not left at the dead window's last line");
check(/catch \(e\) \{[\s\S]{0,300}settledClaims\.delete\(key\);/.test(settle),
  "a settle that never reached the host is forgotten, not remembered as answered: a transient failure must not park the pill for the life of the page");

const reload = fnBodyOf("reloadActiveProject");
check(/saveMemento\(here\.id, \{ older: olderRemaining, workdir: els\.workspace\.textContent \|\| "" \}\);/.test(reload) &&
  /forgetDomCache\(here\.id\)/.test(reload) && /currentProject = "";/.test(reload) &&
  /await activateTab\(here\)/.test(reload),
  "reloadActiveProject re-reads the log FROM DISK (memento + no DOM cache + a real open), not a reconnect at the same watermark");

const info = fnBodyOf("setProjectInfo");
check(!/setReadOnly|setClaimed/.test(info),
  "setProjectInfo leaves both flags alone: the session's frame is the one authority on them");

function fnBodyOf(name) {
  const start = project.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing function in project.ts: " + name);
  return slicer(project).fnBody(name);
}

summary("claim-pill");
