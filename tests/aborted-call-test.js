"use strict";

// Regression test for the call row that never came back:
//
//   A call row is drawn when the call is WRITTEN, and only its result closes it.
//   A run can end in between (Stop, a model that answers without waiting, a
//   process that went away), and the row then read like a call still in flight —
//   a chip, an args expander, maybe a meter counting a wait nothing was doing.
//   The transcript of a stopped run looked like a run that never finished.
//
// The mark is the UI's own state, claimed at the one moment the page KNOWS no
// result can still arrive (the `final`), and it is addressed per call row by the
// id the wire put on it. This runner drives the REAL functions out of the
// renderer against a stub page, and pins the wiring in the sources that call
// them — a silent edit that marks a settled row, marks a row twice, or reaches a
// row that is not on the page fails here.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = uiSource(); // the renderer, every module in page load order
const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");
const catalogPy = fs.readFileSync(path.join(ROOT, "agent", "tools", "catalog.py"), "utf8");

const { fnBody, region } = slicer(src);

// ---- a stub page: rows, their dataset, and the two selectors this code uses ----
function node(tag) {
  const n = {
    tag,
    className: "",
    dataset: {},
    children: [],
    _text: "",
    title: "",
    appendChild(ch) { ch._parent = n; n.children.push(ch); return ch; },
    remove() {
      const p = n._parent;
      if (!p) return;
      const i = p.children.indexOf(n);
      if (i >= 0) p.children.splice(i, 1);
      n._parent = null;
    },
    get textContent() { return n._text; },
    set textContent(v) { n._text = String(v); },
    querySelector(sel) { return descend(n, sel)[0] || null; },
    querySelectorAll(sel) { return descend(n, sel); },
  };
  return n;
}

function descend(root, sel) {
  const out = [];
  const walk = (el) => {
    for (const ch of el.children) {
      if (matches(ch, sel)) out.push(ch);
      walk(ch);
    }
  };
  walk(root);
  return out;
}

// only the selectors the real code builds — anything else is a typo, not a test
function matches(el, sel) {
  const cls = " " + el.className + " ";
  if (sel === ".tool-aborted") return cls.includes(" tool-aborted ");
  if (sel === ".tool-row[data-call-id]") {
    return cls.includes(" tool-row ") && el.dataset.callId !== undefined;
  }
  const m = /^\.tool-row\[data-call-id="([\s\S]*)"\]$/.exec(sel);
  if (m) {
    const id = m[1].replace(/\\([\\"])/g, "$1"); // the quoting the code applied, undone
    return cls.includes(" tool-row ") && el.dataset.callId === id;
  }
  throw new Error("stub DOM asked for a selector it does not implement: " + sel);
}

global.document = { createElement: (tag) => node(tag) };
global.pageSink = null;

// ---- the real functions, from callRowOf through markAbortedCalls ----
(0, eval)(runnableSnippet(region("function callRowOf", "markAbortedCalls")));

function page(...rows) {
  global.eventsEl = node("div");
  global.eventsEl.className = "events";
  for (const r of rows) global.eventsEl.appendChild(r);
  return global.eventsEl;
}

function callRow(id) {
  const row = node("div");
  row.className = "tool-row";
  noteCallRow(id, row);
  return row;
}

const marks = (row) => row.children.filter((c) => (" " + c.className + " ").includes(" tool-aborted "));

// ---- 1) a row carries the call it was drawn for ----
{
  const row = node("div");
  noteCallRow("call_abc", row);
  check(row.dataset.callId === "call_abc", "the row carries its call id (data-call-id)");
  const bare = node("div");
  noteCallRow("", bare);
  check(bare.dataset.callId === undefined, "no id, nothing written onto the row");
  noteCallRow(null, null);
  check(true, "an event with no row is not a crash");
}

// ---- 2) a run that ends closes every row it left open ----
{
  const open = callRow("call_open");
  const answered = callRow("call_answered");
  page(open, answered);
  settleCallRow("call_answered");
  check(answered.dataset.settled === "1", "a result settles its row");

  markAbortedCalls();
  const marked = marks(open);
  check(marked.length === 1, "the call with no result is marked once");
  check(marked[0].textContent === "no result", "the mark says what happened, in so many words");
  check(/never returned a result/.test(marked[0].title || ""), "the mark's tooltip says why");
  check(marks(answered).length === 0, "a settled row is never marked");

  // a second final (a replay over the live page) is the same fact, not a second mark
  markAbortedCalls();
  check(marks(open).length === 1, "marking is idempotent");
  check(open.dataset.settled === undefined, "a marked row is not claimed settled");
}

// ---- 3) a result later than the mark heals it ----
{
  const row = callRow("call_late");
  page(row);
  markAbortedCalls();
  check(marks(row).length === 1, "the row is marked when the run ends");
  // ...and then the result arrives anyway (a replay, another run's claim): the
  // result is the later fact, so the mark goes
  settleCallRow("call_late");
  check(marks(row).length === 0, "a result clears a mark the row should not wear");
  check(row.dataset.settled === "1", "...and settles it");
}

// ---- 4) the mark is about THIS page: a row away from it is not touched ----
{
  page();
  const detached = callRow("call_detached"); // a cached tab's row: not on the page
  markAbortedCalls();
  check(marks(detached).length === 0, "a row that is not on the page is left alone");
  check(settleCallRow("call_detached") === undefined, "settling a row that is not there is a no-op");
}

// ---- 5) a history page paints into the sink, and its rows settle there ----
{
  page();
  const sink = node("div");
  global.pageSink = sink;
  const paged = callRow("call_paged");
  sink.appendChild(paged);
  settleCallRow("call_paged");
  check(paged.dataset.settled === "1", "a result finds its row in the paging sink too");
  markAbortedCalls();
  check(marks(paged).length === 0, "...so a paged call that DID return is never marked");
  global.pageSink = null;
}

// ---- 6) the id is wire data, not a selector ----
{
  const odd = callRow('call_"odd\\id');
  const lookalike = callRow("call_");
  page(odd, lookalike);
  settleCallRow('call_"odd\\id');
  check(odd.dataset.settled === "1", "an id with a quote and a backslash still addresses its own row");
  check(lookalike.dataset.settled === undefined, "...and only its own row");
  markAbortedCalls();
  check(marks(lookalike).length === 1, "the other row is marked on its own merits");
}

// ---- 7) the sources that wire it ----
check(
  /settleAllCountdowns\(\);[\s\S]{0,600}if \(!pageSink\) markAbortedCalls\(\);/.test(src),
  "the final claims the abandoned calls — and a history PAGE's final claims nothing about the pane",
);
check(
  /settleCountdown\(ev\.tool_call_id\);[\s\S]{0,300}settleCallRow\(ev\.tool_call_id\);/.test(src),
  "every tool_result settles its call row",
);
check(
  /noteCallRow\(ev\.tool_call_id, st\.row\);/.test(src),
  "a call whose row was already streaming is registered when it settles into its final form",
);
check(
  /noteCallRow\(ev\.tool_call_id, row\);/.test(fnBody("makeToolRow")),
  "a row rendered from the record registers itself",
);
check(
  /\.tool-aborted \{[^}]*var\(--muted\)/.test(css),
  "the mark has its own quiet style (ui/style.css)",
);
check(
  /never answered/.test(catalogPy),
  "the protocol doc states the one call-row fact no declaration sets (agent/tools/catalog.py)",
);
check(
  !/trigger|read_file|run_command|shell\./.test(fnBody("markAbortedCalls")),
  "the mark knows no tool name",
);

summary("aborted-call-test");
