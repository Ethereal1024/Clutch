"use strict";

// Regression test for the tool UI protocol's read form: the host holds no prior
// about any tool — the form is whatever the component's declaration composes —
// and the read declaration must draw the form this UI has always drawn:
//
//   the CALL ROW leads with the tool's own name (the chip), its arguments one
//   click away, and while the args stream a "read" shows only the chip (too
//   large to preview);
//   the RESULT is a collapsible row of its own beside the call — the
//   declaration's summary as the label, the content folding under it,
//   highlighted by the path the call read.
//
// The real functions are extracted from ui/app.js (slicer) and driven against a
// stub DOM, so a silent edit that merges the result back into the call row,
// drops the chip, or hard-codes a tool name back in fails here.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const APP = path.join(__dirname, "..", "ui", "app.js");
const src = fs.readFileSync(APP, "utf8");
const { fnBody, region } = slicer(src);

// ---- stub DOM: just enough shape for the row builders ----
function node(tag) {
  const n = {
    tag,
    children: [],
    className: "",
    innerHTML: "",
    _text: "",
    classList: {
      add(...cls) { const set = new Set(n.className.split(" ").filter(Boolean)); cls.forEach((c) => set.add(c)); n.className = [...set].join(" "); },
      remove(...cls) { const set = new Set(n.className.split(" ").filter(Boolean)); cls.forEach((c) => set.delete(c)); n.className = [...set].join(" "); },
      contains: (c) => n.className.split(" ").includes(c),
    },
    appendChild(ch) { n.children.push(ch); return ch; },
    insertBefore(ch) { n.children.unshift(ch); return ch; },
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
// the fold system is its own tested code; here the form is what matters
global.wrapFold = (el) => { const w = node("div"); w.className = "fold"; w._body = el; w._hidden = true; return w; };
global.toggleFold = (fold) => { const was = fold._hidden; fold._hidden = !was; return was; };
global.foldExpand = () => {};
global.foldCollapse = () => {};
const highlightPaths = [];
global.highlightPreByPath = (pre, p) => { pre._highlightPath = p; highlightPaths.push(p); };

// ---- load the real code: state + row builders, then the read form ----
(0, eval)(region("const toolCalls = {};", "addToolCallRow"));
(0, eval)(region("function buildReadRow", "buildReadBlock"));
(0, eval)(region("const streamRows", "handleToolCallDelta"));

// the read_file declaration, exactly as the component states it
const READ_UI = {
  group: "read",
  style: "read",
  body: "text",
  collapse: "always",
  preview: "none",
  summary: "read {path} ({lines} lines)",
};

(async () => {
  // ---- 1) the call row: the tool's own name leads it, args one click away ----
  const ev = { name: "read_file", arguments: '{"path": "ui/app.js"}', tool_call_id: "r1", ui: READ_UI };
  const row = makeToolRow(ev);
  const chip = row.children.find((c) => c.className === "tool-name");
  check(chip && chip.textContent === "read_file", "the call row leads with the tool's own name");
  check(row.children.some((c) => c.className === "tool-args-btn"), "the raw payload stays one click away");
  check(!/summaryText|tool-label/.test(src), "no call-row label machinery is left behind");

  // ---- 2) live streaming: a read previews as the chip alone ----
  handleToolCallDelta({ type: "tool_call_delta", tool_call_id: "r1", name: "read_file", delta: "", ui: READ_UI });
  const groupEl = global.eventsEl.children[global.eventsEl.children.length - 1];
  const liveRow = groupEl.children[groupEl.children.length - 1];
  check(liveRow.className.split(" ").includes("stream"), "the streaming row is live");
  check(
    liveRow.children.some((c) => c.className === "muted" && c.textContent === "…"),
    "a read streams as the chip and an ellipsis",
  );
  check(!liveRow.children.some((c) => (c.className || "").includes("stream-pre")), "a read streams no argument text");

  // a command-shaped declaration still streams its body (the vocabulary is
  // shared; the form is the declaration's choice)
  handleToolCallDelta({ type: "tool_call_delta", tool_call_id: "c1", name: "x_tool", delta: "", ui: { preview: "args" } });

  // ---- 3) the result: a collapsible row of its own beside the call ----
  const call = { name: "read_file", args: { path: "ui/app.js" } };
  const block = { el: node("div") };
  appendReadRow(block, Object.assign({}, { chip: "name" }, READ_UI), call, { content: "a\nb\nc" });
  const readRow = block.el.children[0];
  const fold = block.el.children[1];
  check(readRow.className === "read-row", "the result is its own exploration row");
  const lbl = readRow.children.find((c) => c.className !== "read-toggle");
  check(lbl.textContent === "read ui/app.js (3 lines)", "the label is the declaration's summary, filled from the call");
  check(fold._body.textContent === "a\nb\nc", "the content folds under the row, whole");
  check(fold._body._highlightPath === "ui/app.js", "the panel is highlighted by the path the call read");
  check(typeof readRow.onclick === "function", "the row itself is the toggle");
  readRow.onclick();
  check(readRow.children[0].textContent === "▾", "the toggle flips when the row is clicked");

  // the summary is the declaration's, not the name's: another tool's wording
  // must come through verbatim
  const b2 = { el: node("div") };
  appendReadRow(b2, { summary: "grep {pattern} ({lines} lines)", style: "read" }, { name: "grep", args: { pattern: "foo" } }, { content: "1\n2" });
  const lbl2 = b2.el.children[0].children.find((c) => c.className !== "read-toggle");
  check(lbl2.textContent === "grep foo (2 lines)", "another declaration's summary renders the same form");

  // ---- 4) a replayed read (call row gone) keeps the same form in a block ----
  const wrap = buildReadBlock({ summary: "read {path} ({lines} lines)" }, call, { content: "x", is_error: false });
  check(wrap.className.includes("event tool_result") && wrap.className.includes("read"), "a replayed read gets the read block");
  check(wrap.children[0].textContent === "result", "a healthy replay reads 'result'");
  const wrapErr = buildReadBlock({ summary: "read {path} ({lines} lines)" }, call, { content: "boom", is_error: true });
  check(wrapErr.children[0].textContent === "result ⚠", "a failed read keeps the host's one verdict");

  // ---- 5) source guards: the wiring and the no-prior principle ----
  check(/appendReadRow\(group, ui, call, ev\)/.test(src), "the live result dispatch routes reads to their own row");
  check(/if \(ui\.style === "read"\) return buildReadBlock/.test(src), "the durable render routes reads to the same form");
  check(!/\bread_file\b/.test(src), "the renderer still knows no tool name");
  check(!/isReadTool/.test(src), "no tool-name predicate came back");

  summary("read-row-test");
})().catch((e) => { console.error(e); process.exit(1); });
