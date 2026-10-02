"use strict";

// Regression test for the EMPTY "result ⚠" BLOCK: a diff-shaped declaration
// (`ui.body: "diff"` — clutch-workspace's write_file/edit_file) whose result
// returned no diff rendered as a bare "result ⚠" header with nothing under it
// and nothing to unfold, because the body was gated on `result.diff`.
//
// Every FAILURE leaves `diff` empty by the host's envelope contract
// (tools/envelope.py: "diff stays a plain string, '' = nothing to show"), and the
// reason lives in `content` alone — 29 such events sit in this repo's own logs
// (see scripts/_scan_diff_errors.py). The one line that says WHY the edit was
// rejected was therefore swallowed exactly when it was needed.
//
// The real functions are extracted from the renderer (slicer) and driven against a
// stub DOM, so a silent edit that re-gates the pane on the diff fails here.
//
// The source is the page's own script list (harness.uiSource), not one file: the
// result builders used to sit in ui/app.js, which is now only the entry module —
// reading a fixed path made this runner fail on a move that broke nothing.

const { check, summary, slicer, uiSource } = require("./harness.js");

const src = uiSource(); // every module, in page load order
const { fnBody, region } = slicer(src);

// ---- stub DOM: just enough shape for the block/row builders ----
function node(tag) {
  const n = {
    tag,
    children: [],
    className: "",
    _text: "",
    classList: {
      add(...cls) { const set = new Set(n.className.split(" ").filter(Boolean)); cls.forEach((c) => set.add(c)); n.className = [...set].join(" "); },
      remove(...cls) { const set = new Set(n.className.split(" ").filter(Boolean)); cls.forEach((c) => set.delete(c)); n.className = [...set].join(" "); },
      contains: (c) => n.className.split(" ").includes(c),
    },
    appendChild(ch) { n.children.push(ch); return ch; },
    remove() {},
    get textContent() { return n._text; },
    set textContent(v) { n._text = String(v); },
  };
  return n;
}
global.document = { createElement: (tag) => node(tag) };
global.autoScroll = () => {};
global.eventsEl = node("div");
global.pageSink = null;
// the fold system is its own tested code; here the body is what matters
global.wrapFold = (el) => { const w = node("div"); w.className = "fold"; w._body = el; w._hidden = true; return w; };
global.toggleFold = (fold) => { const was = fold._hidden; fold._hidden = !was; return was; };
global.foldExpand = () => {};
global.foldCollapse = () => {};
global.highlightPreByPath = () => {};
global.renderDiff = (d) => { const n = node("div"); n.className = "diff"; n._diff = d; n.textContent = d; return n; };

// ---- load the real code: the constants, the label template, the parts ----
// (the fold threshold is read out of the source: the functions below close over
// it, and a sloppy indirect eval is what makes them globals)
global.RESULT_FOLD_LINES = Number(src.match(/const RESULT_FOLD_LINES = (\d+);/)[1]);
(0, eval)(fnBody("templateText"));
(0, eval)(region("function buildResultBody", "plainBody")); // body + its plain-body fallback
(0, eval)(fnBody("foldAtRest"));
(0, eval)(region("function buildResultBlock(", "buildResultBlock"));
(0, eval)(region("function buildResultRow", "appendResultRow"));
(0, eval)(region("function buildResultRowBlock", "buildResultRowBlock"));

// the write_file/edit_file declaration, exactly as clutch-workspace states it
const EDIT_UI = {
  chrome: "accent",
  header: "✎ edited {path}",
  body: "diff",
  collapse: "long",
  preview: { mode: "content", keys: ["✎path", "-old_string", "+new_string"] },
};
// and the read_file row-form declaration
const READ_UI = {
  group: "read",
  form: "row",
  body: "code",
  collapse: "always",
  highlight: "path",
  preview: "none",
  summary: "read {path} ({lines} lines)",
};

const text = (n) => n.textContent || "";
const bodyish = (n) => n.className.split(" ").includes("body") || n.tag === "pre";

// ---- 1) THE BUG: a failed diff-shaped call shows its reason ----
// the exact shape of the 29 real failures found in the logs
const FAIL = { content: "ERROR: old_string not found in ui/app.js", is_error: true, diff: "" };
let wrap = buildResultBlock(EDIT_UI, "edit_file", { path: "ui/app.js" }, FAIL);
check(wrap.children[0].textContent === "result ⚠", "the header is still the host's one verdict");
check(
  wrap.children.length === 2 && bodyish(wrap.children[1]) && text(wrap.children[1]).includes("old_string not found"),
  "the failure reason is drawn under the verdict (was: an empty block)",
);

// a fresh envelope with no message at all must NOT grow an empty body node
wrap = buildResultBlock(EDIT_UI, "edit_file", {}, { content: "", is_error: true, diff: "" });
check(wrap.children.length === 1, "a genuinely empty failure still draws the header alone");

// ---- 2) the long failure folds, and the fold opens ----
const long = { content: "ERROR: boom\n" + "x\n".repeat(80), is_error: true, diff: "" };
wrap = buildResultBlock(EDIT_UI, "edit_file", {}, long);
check(wrap.children[1] && wrap.children[1].className === "fold-toggle", "a long failure gets a fold toggle");
check(wrap.children[1].textContent === "▸", "the fold starts closed");
check(wrap.children[2] && wrap.children[2].className === "fold", "…and there is a fold to open");
check(text(wrap.children[2]._body).startsWith("ERROR: boom"), "the folded body carries the message, whole");
wrap.children[1].onclick();
check(wrap.children[1].textContent === "▾" && wrap.children[2]._hidden === false, "clicking the toggle opens it");

// ---- 3) a real diff keeps its pane: one note, then the diff ----
const okDiff = { content: "OK: edited ui/app.js (+1 -1 lines)", is_error: false, diff: "--- a\n+++ b\n-1\n+2" };
wrap = buildResultBlock(EDIT_UI, "edit_file", { path: "ui/app.js" }, okDiff);
check(wrap.children[0].textContent === "✎ edited ui/app.js", "a healthy call still wears the declaration's header");
check(wrap.children.length === 3, "the diff pane is the note plus the diff");
check(text(wrap.children[1]) === "OK: edited ui/app.js (+1 -1 lines)", "the verdict sits above the diff");
check(wrap.children[2].className === "diff" && wrap.children[2]._diff === okDiff.diff, "the diff follows it");
check(
  wrap.children.filter((c) => text(c).includes("OK: edited")).length === 1,
  "the verdict is drawn once, never duplicated by the fallback",
);

// a diff-less SUCCESS (the log's "+0 -0 lines" edits) keeps its line too
const okEmpty = { content: "OK: edited tests/remote_path_test.py (+0 -0 lines)", is_error: false, diff: "" };
wrap = buildResultBlock(EDIT_UI, "edit_file", { path: "tests/remote_path_test.py" }, okEmpty);
check(
  wrap.children.length === 2 && text(wrap.children[1]) === okEmpty.content,
  "a success with an empty diff keeps its verdict line",
);

// ---- 4) the row form: no dead "▸", and a fallback body folds ----
let built = buildResultRow(READ_UI, { name: "read_file", args: { path: "x" } }, { content: "a\nb", is_error: false });
check(built.row.children[0].className === "fold-toggle", "a row with a body keeps its toggle first");
built = buildResultRow(Object.assign({}, READ_UI, { body: "none" }), { name: "read_file", args: {} }, { content: "", is_error: true });
check(built.full === null && !built.row.children.some((c) => c.className === "fold-toggle"),
  "a row whose declared body rendered empty draws no toggle that opens nothing");
check(text(built.row.children[0]) === "read read_file (1 lines)" || text(built.row.children[0]).includes("read "),
  "the label is still the declaration's summary");

// a diff-shaped declaration in row form falls back to its message the same way
built = buildResultRow(Object.assign({}, EDIT_UI, { summary: "edit {path}" }),
  { name: "edit_file", args: { path: "p" } }, FAIL);
check(built.full !== null && text(built.full._body).includes("old_string not found"),
  "the row form never swallows the message either");

// the replayed row block (call row gone) keeps the message under its verdict
wrap = buildResultRowBlock(READ_UI, { name: "read_file", args: { path: "package.json" } },
  { content: "file not found: package.json", is_error: true });
check(wrap.children[0].textContent === "result ⚠", "a replayed failure keeps the verdict");
check(wrap.children[2] && wrap.children[2].className === "fold", "its row-form fold is drawn under the row");
check(/file not found/.test(text(wrap.children[2]._body)), "…and the component's message with it");

// ---- 5) source guards: the pane is gated on what it can DRAW, not on the diff ----
check(/if \(!result\.diff\) return \(result\.content \|\| ""\)\.trim\(\) \? plainBody/.test(src),
  "the diff body falls back to the message when there is no diff");
check(/ui\.body === "diff" && result\.diff/.test(src), "the verdict note is drawn only over a real diff");
check(/ui\.body === "diff" \? result\.diff \|\| result\.content/.test(src), "the fold rule counts the drawn body");
check(!/\b(edit_file|write_file)\b/.test(src), "the renderer still knows no tool name");

summary("diff-body-test");
