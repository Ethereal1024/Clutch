"use strict";

// Switching back to a tab restores the END of its log — the tail paged backwards
// to where the tab's own painted range began — and not the range the tab was
// left on.
//
// The reported bug: a REMOTE tab, after its load card went, showed "a pile of
// messages loading itself in a burst", while a local tab just appeared at the
// bottom of the transcript. The restore used to repaint exactly the memento's
// painted range [oldest, high] — a snapshot of the moment the tab was left —
// and hand everything the project wrote since then to the reconnect
// (`/api/events?since=high`). That block arrives AFTER apply(paneTab) has
// dismissed the card, one SSE frame per record, unbounded
// (agent/api/events.py _owed_records). A tunnel delivers each frame in its own
// chunk, so the browser paints between records; loopback hands the same block
// over in one read, which is one paint — the local tab's "it just lands at the
// bottom". Anchoring the range at the log's tail puts those records inside the
// restore: behind the card, with progress, and nothing left to flood the pane.
//
// This runner drives the REAL restoreTabView against stubs — the offsets are
// data, so the walk can be exercised for real (the source-contract side is
// tests/tab-activation-race-test.js block 4).
//
// Run: node tests/tab-tail-restore-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const PROJECT = fs.readFileSync(path.join(ROOT, "ui", "src", "renderer", "project.ts"), "utf8");
const { region } = slicer(PROJECT);

// the real restore AND the real page budgets it walks with
(0, eval)(runnableSnippet(region("const RESTORE_MAX_PAGES", "restoreTabView")));

const MEMENTO = {
  scroll: 40, high: 100, oldest: 40, older: 0, workdir: "/p",
};

// The real restore is evaluated above (with the real budgets); the URL checks
// below compare against these, which are checked against the source first so a
// changed page size cannot quietly pass.
const RESTORE_PAGE_BYTES = 262144;
check(new RegExp(`const RESTORE_PAGE_BYTES = ${RESTORE_PAGE_BYTES / 1024} \\* 1024;`).test(PROJECT),
  "the runner pages with the budget the renderer ships (" + RESTORE_PAGE_BYTES + " bytes)");

let requests;
let painted;
let progress;
let pills;
let placed;
let opened;
let stale;

function world({ session, pages, staleAfter }) {
  requests = [];
  painted = [];
  progress = [];
  pills = [];
  placed = [];
  opened = 0;
  stale = false;
  let n = 0;
  global.mementoOf = () => MEMENTO;
  global.isStale = () => stale;
  global.apiFetch = async (url) => {
    requests.push(url);
    if (url === "/api/session") return session;
    const page = pages[(n = n + 1) - 1];
    if (staleAfter && n === staleAfter) stale = true;
    if (!page) throw new Error("no more pages");
    return page;
  };
  global.clearStream = () => { painted.push("clear"); };
  global.setProjectInfo = () => {};
  global.dirOf = () => "/p";
  global.addEvent = (item) => { painted.push(item.event ? item.offset : item); };
  global.paneReplayProgress = (phase, frac) => progress.push([phase, frac]);
  global.setOlderPill = (v) => pills.push(v);
  global.typesetProgressively = async () => {};
  // where the reader stands is the tab's own place, and it is put back by the
  // one helper both open paths share (tests/tab-position-test.js drives that one)
  global.placeRestored = (id) => { placed.push(id); };
  global.finishOpen = () => { opened++; };
  global.stream = { scrollTop: 0, scrollHeight: 1234 };
  global.eventsEl = {};
}

const tab = { id: "t", path: "/p/x.clc", projectKey: "/p/x.clc", name: "x" };

async function main() {
  // ---- 1. the range ends at the log's tail, not at the memento's high ----
  world({
    session: { memory: { path: "/p/x.clc", bytes: 9000 } },
    pages: [
      { events: [{ offset: 8000, event: 1 }, { offset: 8500, event: 2 }], older: 5000 },
      { events: [{ offset: 5100, event: 3 }], older: 0 },
    ],
  });
  const ok = await restoreTabView(tab, "http://host", 1);
  check(ok === true, "the tail restores");
  check(requests[0] === "/api/session",
    "one small session read first: it is what says whether the project is even open here");
  check(requests[1] === `/api/history?before=9000&limit=${RESTORE_PAGE_BYTES}&align=turn`,
    "the first page is asked for from the log's TAIL (memory.bytes), not from the offset the " +
    "tab was left on (" + requests[1] + ")");
  check(requests[2] === `/api/history?before=5000&limit=${RESTORE_PAGE_BYTES}&align=turn`,
    "and it walks back from the page's own `older` to where the memento's range began");
  check(requests.length === 3,
    "it stops there: nothing older than the range the tab had painted is re-fetched");
  check(painted.join(",") === "clear,5100,8000,8500",
    "the pane is cleared once and the pages paint oldest-first (" + painted.join(",") + ")");
  check(pills[pills.length - 1] === 0,
    "the older pill reports the page's own `older`: the whole log is behind this range");
  const parse = progress.filter((p) => p[0] === "parse").map((p) => p[1]);
  check(parse.length === 2 && parse[0] < parse[1] && parse[1] === 1,
    "the bar moves by bytes that actually arrived, and ends the parse phase full (" + parse.join(",") + ")");
  check(progress.some((p) => p[0] === "typeset" && p[1] === 1),
    "and it closes on the typeset phase, like every other open path");
  check(placed.join(",") === "t" && opened === 1,
    "then the tab's OWN place is put back (placeRestored) — not the log's tail, which is further " +
    "down than the reader left it — and the open is finished exactly once");

  // ---- 2. a host that cannot say how big the log is falls back to the memento ----
  world({
    session: { memory: { path: "/p/x.clc" } },
    pages: [{ events: [{ offset: 100, event: 1 }], older: 0 }],
  });
  await restoreTabView(tab, "http://host", 1);
  check(requests[1] === `/api/history?before=101&limit=${RESTORE_PAGE_BYTES}&align=turn`,
    "an older host (no memory.bytes) still gets the range it always got — the memento's high");

  // ---- 3. a newer activation stops the restore where it is ----
  world({
    session: { memory: { path: "/p/x.clc", bytes: 9000 } },
    pages: [{ events: [{ offset: 8000, event: 1 }], older: 0 }],
    staleAfter: 1,
  });
  await restoreTabView(tab, "http://host", 1);
  check(painted.indexOf("clear") < 0 && opened === 0 && placed.length === 0,
    "a tab that took the pane mid-walk leaves this one with nothing painted, no place put back and no open finished");

  // ---- 4. a session with another project open is never repainted from its log ----
  world({
    session: { memory: { path: "/other/y.clc", bytes: 9000 } },
    pages: [{ events: [{ offset: 8000, event: 1 }], older: 0 }],
  });
  const refused = await restoreTabView(tab, "http://host", 1);
  check(refused === false && requests.length === 1,
    "the replaced session sends the tab to the full open instead: no page is even asked for");

  summary("tab-tail-restore");
}

main();
