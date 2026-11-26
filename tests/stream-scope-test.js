"use strict";

// The live stream's SCOPE: WHICH log it reads, and the fact that only one act can
// decide it.
//
// The bug this structure removes: every automatic recovery (a base the host
// announces, a watchdog replace, a phone coming back from the background) is a
// reconnect, and a reconnect that re-derived the project could name a log the pane
// was NOT showing — one project's records landing in the other tab's transcript,
// which is the reported "two tabs, both showing the other project". The answer is
// not a guard in each of those paths: it is a scope the stream HOLDS
// (state.streamProject), adopted exactly once by the pane that takes a project
// (project.ts finishOpen -> connectSSE(project)). Every other path is a HEAL: it
// can re-open the log that is there, and it cannot name one.
//
// Three doors, one owner each (ui/src/renderer/sse-stream.ts):
//   connectSSE(project)  ADOPT   — the only entry that names a log
//   reconnectSSE()       HEAL    — same log, whatever base this window has now
//   closeSSE()           LET GO  — no pane owns a log any more
// and behind them the two private facts: closeSocket() is the one place a socket
// ends (settling the catch-up block first), openStream() the one place it starts.
//
// Like the other renderer runners this one drives the REAL functions against a
// fake EventSource, so the structure is executed, not described.
//
// Run: node tests/stream-scope-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, stateStub, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SSE = read("ui/src/renderer/sse-stream.ts");
const STATE = read("ui/src/renderer/state.ts");
const PROJECT = read("ui/src/renderer/project.ts");
const SLOTS = read("ui/src/renderer/slots.ts");
const sseFn = slicer(SSE).fnBody;
const slotsFn = slicer(SLOTS).fnBody;

// ---- stub environment ----
//
// The order of what a teardown does is part of the contract (settle, then close),
// so the fake socket and the settle stub write into ONE list.
const instances = [];
const order = [];

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    instances.push(this);
  }
  addEventListener(type, cb) {
    (this.listeners[type] = this.listeners[type] || []).push(cb);
  }
  close() {
    this.closed = true;
    order.push("close");
  }
}

global.EventSource = FakeEventSource;
global.state = stateStub();
global.state.apiBase = "http://127.0.0.1:43761";
global.es = null;
global.refreshTree = () => {};
global.addEvent = () => {};
global.dropOrphanLive = () => {};
global.resolveConnectionLost = () => {};
global.pushTrustArmed = () => {};
global.startSseWatchdog = () => {}; // the watchdog has its own runner (sse-liveness)
// settleCatchUp() is stream-events.ts's; what a drain paints is catch-up-paint's
// subject. Here it only has to prove WHERE in a teardown it happens.
global.settleCatchUp = () => {
  order.push("settle");
};

for (const name of ["sseFrame", "connectSSE", "reconnectSSE", "closeSSE", "closeSocket", "openStream"]) {
  (0, eval)(runnableSnippet(sseFn(name)));
}

const last = () => instances[instances.length - 1];
const qs = (url) => new URL(url).searchParams;
const BASE = "http://127.0.0.1:43761";
const OTHER = "http://10.0.0.2:5000";
const LOG = "/p/a.clc";

// ---- 1. adopting names the log, and the offset says how far ----
{
  connectSSE(LOG);
  check(instances.length === 1 && global.state.streamProject === LOG,
    "the open adopts its log: one stream, and it is the tab's own project");
  check(qs(last().url).get("project") === LOG,
    "…and the socket ASKS for that log: the URL is built from the scope, not from a global");
  check(qs(last().url).get("since") === null,
    "a pane that has painted nothing claims no offset: the log's own window answers");

  global.state.streamHighOffset = 4096;
  reconnectSSE();
  check(qs(last().url).get("project") === LOG && qs(last().url).get("since") === "4096",
    "a heal re-reads the same log from the watermark — one read, named once");

  connectSSE("");
  check(qs(last().url).get("project") === null && global.state.streamProject === "",
    "the session's resident window (\"\" — a boot with no tab) is an adoption too: no project parameter, not a guess");
}

// ---- 2. a heal cannot adopt ----
{
  const settled = global.state.streamHighOffset;
  closeSSE();
  check(global.state.streamProject === null && global.es === null,
    "letting go drops the log with the socket: the welcome page reads nothing");
  check(global.state.streamHighOffset === settled,
    "the watermark is the PANE's, not the stream's: it is the next open's to reset (clearStream)");
  const before = instances.length;
  reconnectSSE();
  check(instances.length === before && global.es === null,
    "a heal with no adopted log opens NOTHING: it has no log to name, so it cannot invent one");
}

// ---- 3. a heal cannot swap logs either ----
{
  connectSSE(LOG);
  const first = last();
  check(qs(first.url).get("project") === LOG, "adopted: the pane is showing a.clc");
  // the session moved under the window (a tunnel re-claim, a host self-heal): the
  // base is new, the log is the same one the reader is looking at
  global.state.apiBase = OTHER;
  reconnectSSE();
  const second = last();
  check(second !== first && first.closed === true,
    "the heal replaces the socket instead of leaving two live streams on one pane");
  check(second.url.startsWith(OTHER) && qs(second.url).get("project") === LOG,
    "on the base the host just announced, for the SAME log: a base move is not a project move");
  check(global.state.streamProject === LOG,
    "and adoption did not move: only an open decides what this window reads");
}

// ---- 4. no base is not "no log": the scope outlives the socket ----
{
  const live = last();
  global.state.apiBase = null;
  reconnectSSE();
  check(global.es === null && live.closed === true,
    "a session that is gone closes the dead socket (nothing keeps posting into a port nobody serves)");
  check(global.state.streamProject === LOG,
    "…and KEEPS the log: the base the host announces next heals this same read, instead of leaving the pane without one");
  global.state.apiBase = BASE;
  reconnectSSE();
  check(qs(last().url).get("project") === LOG && qs(last().url).get("since") === "4096",
    "the next base brings that read back at its watermark");
}

// ---- 5. letting go: settle first, then close, and both halves ----
{
  const live = last();
  order.length = 0;
  closeSSE();
  check(order.join(",") === "settle,close",
    "the block the stream was still delivering is settled BEFORE the socket closes (a queued row is never stranded)");
  check(global.es === null && live.closed === true && global.state.streamProject === null,
    "and it lets go of both: no socket, no log");
  const before = instances.length;
  reconnectSSE();
  check(instances.length === before,
    "so between two opens (a switch whose own load has not adopted yet) every automatic path is inert");
  connectSSE(LOG); // leave the runner with one live read
}

// ---- 6. the structure itself ----
{
  check(/^\s*streamProject: null as string \| null,$/m.test(STATE),
    "the scope is real state (state.ts), beside the watermark it pairs with: which log, and how far into it");
  check((SSE.match(/new EventSource\(/g) || []).length === 1 &&
    /new EventSource\(/.test(sseFn("openStream")),
    "one place starts a socket, and it is the function that reads the scope");
  check((SSE.match(/es\.close\(\)/g) || []).length === 1 &&
    /es\.close\(\)/.test(sseFn("closeSocket")),
    "one place ends one, so no door can forget the settle a close owes");
  // the one mention left in this file is the comment that says why it must not be
  // read; the CODE is what must stay free of it
  const sseCode = SSE.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check(!/currentProject/.test(sseCode) && !/from "\.\/project"/.test(SSE),
    "the stream's code never reads currentProject: the window's belief about the pane moves at another moment, so the log is adopted instead of inferred");
  check(/^export function connectSSE\(project: string\)/m.test(SSE),
    "the adopting door NAMES the log in its signature — a decision, and its input");
  check((SSE.match(/state\.streamProject = /g) || []).length === 2 &&
    /state\.streamProject = project;/.test(sseFn("connectSSE")) &&
    /state\.streamProject = null;/.test(sseFn("closeSSE")),
    "exactly two writers of the scope: the open that adopts it, and the pane that lets go");
  const open = sseFn("openStream");
  check(!/new EventSource/.test(sseFn("reconnectSSE")),
    "the healing door opens no socket of its own: it can only ask for the read the pane took");
  check(/const project = state\.streamProject;/.test(open) && /if \(project === null\) return;/.test(open) &&
    open.indexOf("state.streamProject") < open.indexOf("new EventSource"),
    "…and the one rule it relies on — no adopted log, no stream — is enforced where sockets start, before a URL exists");

  check(/function finishOpen\(project: string\)/.test(PROJECT) &&
    /connectSSE\(project\);/.test(PROJECT),
    "the pane adopts through ONE ending, and it takes the log from the open that produced it");
  check(!/finishOpen\(\);/.test(PROJECT),
    "no open finishes without saying which log it showed (every call site passes projectOf(tab))");
  check(/connectSSE\(""\);/.test(read("ui/src/renderer/boot.ts")),
    "a boot with no tab adopts the session's own resident window, explicitly");
}

// ---- 7. the badge stream is a different stream, and stays one ----
//
// A background RUNNING tab has a live-only stream of its own (slots.ts watchTab):
// it reads THAT tab's base and THAT tab's log, and it never touches the window's
// scope — switching tabs must not be able to point it at the visible pane.
{
  const watch = slotsFn("watchTab");
  check(/new EventSource\(tab\.base \+ "\/api\/events\?"/.test(watch),
    "the badge stream is built from the tab's own base, not the window's");
  check(/qs\.set\("project", tab\.projectKey \|\| tab\.path\)/.test(watch),
    "…and the tab's own log, which is the whole point of the watcher");
  check(/qs\.set\("replay", "0"\)/.test(watch),
    "…live-only: no history is poured into a pane that is not showing it");
  check(!/state\.streamProject|state\.apiBase/.test(watch),
    "and it reads neither the visible stream's scope nor its base: the two streams cannot borrow each other's subject");
}

summary("stream-scope");
