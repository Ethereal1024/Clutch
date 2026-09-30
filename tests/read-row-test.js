"use strict";

// Regression test for the tool UI protocol's ROW FORM: the host holds no prior
// about any tool — not its name, and not its purpose either. There is no
// "read" the renderer recognizes; there is a structural word, `form: "row"`,
// and a declaration that composes parts the UI provides (label template, code
// body, fold, path highlight). The row this UI has always drawn for a file
// read is just one composition of those parts:
//
//   the CALL ROW leads with the tool's own name (the chip), its arguments one
//   click away, and while the args stream a preview:"none" shows only the chip;
//   the RESULT is a collapsible row of its own beside the call — the
//   declaration's summary as the label, the declared body folding under it,
//   decorated as the declaration asks (highlight: "path").
//
// The real functions are extracted from the renderer (slicer) and driven against a
// stub DOM, so a silent edit that merges the result back into the call row,
// drops the chip, or routes on a tool name or a purpose word fails here.

const { check, summary, slicer, uiSource } = require("./harness.js");

const src = uiSource(); // the renderer, every module in page load order
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
global.renderDiff = () => node("div");

// ---- load the real code: state + row builders, the body parts, the stream ----
(0, eval)(region("const toolCalls = {};", "addToolCallRow"));
(0, eval)(region("function buildResultRow", "appendResultRow"));
(0, eval)(region("function buildResultRowBlock", "buildResultRowBlock"));
(0, eval)(region("function buildResultBody", "buildResultBody"));
(0, eval)(region("const streamRows", "handleToolCallDelta"));

// the read_file declaration, exactly as the component states it — a
// composition of parts, no purpose word anywhere in it
const READ_UI = {
  group: "read",
  form: "row",
  body: "code",
  collapse: "always",
  highlight: "path",
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

  // ---- 2) live streaming: preview "none" shows the chip alone ----
  handleToolCallDelta({ type: "tool_call_delta", tool_call_id: "r1", name: "read_file", delta: "", ui: READ_UI });
  const groupEl = global.eventsEl.children[global.eventsEl.children.length - 1];
  const liveRow = groupEl.children[groupEl.children.length - 1];
  check(liveRow.className.split(" ").includes("stream"), "the streaming row is live");
  check(
    liveRow.children.some((c) => c.className === "muted" && c.textContent === "…"),
    "preview none streams as the chip and an ellipsis",
  );
  check(!liveRow.children.some((c) => (c.className || "").includes("stream-pre")), "preview none streams no argument text");

  // a command-shaped declaration still streams its body (the vocabulary is
  // shared; the composition is the declaration's choice)
  handleToolCallDelta({ type: "tool_call_delta", tool_call_id: "c1", name: "x_tool", delta: "", ui: { preview: "args" } });

  // ---- 3) the result: a collapsible row of its own beside the call ----
  const call = { name: "read_file", args: { path: "ui/app.js" } };
  const block = { el: node("div") };
  appendResultRow(block, Object.assign({}, { chip: "name" }, READ_UI), call, { content: "a\nb\nc" });
  const resultRow = block.el.children[0];
  const fold = block.el.children[1];
  check(resultRow.className === "result-row", "the result is its own collapsible row");
  const lbl = resultRow.children.find((c) => c.className !== "fold-toggle");
  check(lbl.textContent === "read ui/app.js (3 lines)", "the label is the declaration's summary, filled from the call");
  check(fold._body.className === "result-detail", "the declared code body folds under the row");
  check(fold._body.textContent === "a\nb\nc", "the content folds under the row, whole");
  check(fold._body._highlightPath === "ui/app.js", "the code body is highlighted as the declaration asks (path)");
  check(typeof resultRow.onclick === "function", "the row itself is the toggle");
  resultRow.onclick();
  check(resultRow.children[0].textContent === "▾", "the toggle flips when the row is clicked");

  // ---- 4) genericity: a tool nobody has heard of, same composition ----
  // The renderer routed on `form`, not on the name: a stranger that declares
  // the same parts must draw the identical shape.
  const ZZZ_UI = {
    group: "zzz",
    form: "row",
    body: "code",
    collapse: "always",
    highlight: "path",
    preview: "none",
    summary: "zzz {q} over {path} ({lines} lines)",
  };
  const b2 = { el: node("div") };
  appendResultRow(b2, ZZZ_UI, { name: "zzz_tool", args: { q: "hay", path: "zz/zz.js" } }, { content: "1\n2" });
  const zzzRow = b2.el.children[0];
  check(zzzRow.className === "result-row", "a stranger's row-form result draws the same row");
  const zzzLbl = zzzRow.children.find((c) => c.className !== "fold-toggle");
  check(zzzLbl.textContent === "zzz hay over zz/zz.js (2 lines)", "the stranger's own summary template fills the label");
  check(b2.el.children[1]._body._highlightPath === "zz/zz.js", "the stranger's declared highlight applies the same way");

  // another summary wording must come through verbatim (the label is the
  // declaration's, not the name's)
  const b3 = { el: node("div") };
  appendResultRow(b3, { form: "row", body: "code", summary: "grep {pattern} ({lines} lines)" }, { name: "grep", args: { pattern: "foo" } }, { content: "1\n2" });
  check(
    b3.el.children[0].children.find((c) => c.className !== "fold-toggle").textContent === "grep foo (2 lines)",
    "another declaration's summary renders the same form",
  );

  // ---- 5) a replayed row (call row gone) keeps the same form in a block ----
  const wrap = buildResultRowBlock(READ_UI, call, { content: "x", is_error: false });
  check(wrap.className.includes("event tool_result") && wrap.className.includes("form-row"), "a replayed row-form result gets the form-row block");
  check(wrap.children[0].textContent === "result", "a healthy replay reads 'result'");
  const wrapErr = buildResultRowBlock(READ_UI, call, { content: "boom", is_error: true });
  check(wrapErr.children[0].textContent === "result ⚠", "a failed result keeps the host's one verdict");

  // ---- 6) source guards: the wiring and the no-prior principle ----
  check(/group && ui\.form === "row"/.test(src), "the live result dispatch routes on the declared form");
  check(/if \(ui\.form === "row"\) return buildResultRowBlock/.test(src), "the durable render routes on the same declared form");
  check(!/ui\.style\b/.test(src), "no purpose-word style key is read anywhere");
  check(!/===\s*"(read|write|plain)"/.test(src), "the renderer routes on structure, never on a purpose word");
  check(!/read-row|read-detail|read-toggle/.test(src), "no semantic css class is left behind");
  check(!/\bread_file\b/.test(src), "the renderer still knows no tool name");
  check(!/isReadTool/.test(src), "no tool-name predicate came back");

  summary("read-row-test");
})().catch((e) => { console.error(e); process.exit(1); });
