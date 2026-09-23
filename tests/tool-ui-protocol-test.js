"use strict";

// The frontend half of the component UI protocol (agent/tools/catalog.py).
//
// The renderer draws tool events it did not design: every event carries the
// declaration its component made (ev.ui), and ui/app.js reads ONLY that
// declaration — it holds no tool name at all. This extracts the real functions
// from ui/app.js and drives them against the declarations the shipped catalog
// makes, so a silent edit that starts special-casing a tool name, or drops a
// protocol key, fails here.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const APP = path.join(__dirname, "..", "ui", "app.js");
const src = fs.readFileSync(APP, "utf8");
const { bodyEnd, sigBodyOpen } = slicer(src);

// extract the protocol region: the defaults + the functions that read a call's
// declaration (from UI_DEFAULTS through the end of previewText)
const from = src.indexOf("const UI_DEFAULTS = {");
const toFn = src.indexOf("function previewText(");
if (from < 0 || toFn < 0) throw new Error("protocol region not found in ui/app.js");
const region = src.slice(from, bodyEnd(sigBodyOpen(toFn)));

const factory = new Function(
  "extractCommand",
  region + "\nreturn { UI_DEFAULTS, uiOf, summaryText, previewText, partialArg };"
);
const { UI_DEFAULTS, uiOf, summaryText, previewText } = factory((raw) => {
  try { return JSON.parse(raw).command; } catch (e) { return null; }
});

// ---- 1) a tool event's declaration, with the defaults filled in ----
check(uiOf({}).group === null && uiOf({}).body === "text", "a missing declaration is the protocol's defaults");
check(uiOf({}).preview === "args" && uiOf({}).collapse === "never", "and every default is a value the renderer knows");
check(
  uiOf({}).chip === "name" && uiOf({}).summary === "" && uiOf({}).header === "" && uiOf({}).style === "plain",
  "a plain row is the tool's own name with no label, plain block and no declared header"
);
const w = uiOf({ ui: { body: "diff", collapse: "long" } });
check(w.body === "diff" && w.collapse === "long", "a declaration overrides only the keys it names");
check(w.group === null && w.preview === "args", "the keys it leaves out stay the default");

// ---- 2) the summary template: {argname} from the call, {lines}/{name} computed ----
const args = JSON.stringify({ path: "src/app.py", pattern: "def " });
check(
  summaryText({ summary: "read {path} ({lines} lines)" }, "read_file", args, "a\nb\nc") === "read src/app.py (3 lines)",
  "the summary fills the argument and the result's line count"
);
check(
  summaryText({ summary: "grep {pattern} ({lines} lines)" }, "grep", args, "one") === "grep def  (1 lines)",
  "and reads each argument by name"
);
check(
  summaryText(uiOf({}), "web_search", args, "") === "",
  "the plain row carries no label: the chip on its left is the tool's own name"
);
check(
  summaryText({ summary: "{name}" }, "web_search", "{}", "") === "web_search",
  "a declaration that wants the tool's own name in a label still spells {name}"
);

// ---- 3) the live preview: the mode the declaration asks for ----
check(previewText(uiOf({}), "read_file", '{"path":"a.py"}') === '{"path":"a.py"}', 'the default preview is the raw arguments');
check(previewText({ preview: "none" }, "grep", '{"pattern":"x"}') === "", 'a declaration can ask for no preview');
check(previewText({ preview: "command" }, "run_command", '{"command":"ls -la"}') === "$ ls -la", '"command" previews the unwrapped command');
const writePreview = previewText(
  { preview: { mode: "content", keys: ["✎path", "content"] } },
  "write_file",
  JSON.stringify({ path: "a.txt", content: "hello" })
);
check(writePreview === "✎ a.txt\nhello", "a write previews the file it is writing, marked, with its content");
const editPreview = previewText(
  { preview: { mode: "content", keys: ["✎path", "-old_string", "+new_string"] } },
  "edit_file",
  JSON.stringify({ path: "a.txt", old_string: "one", new_string: "two" })
);
check(editPreview === "✎ a.txt\n- one\n+ two", "an edit previews old/new, marked");
check(
  previewText({ preview: { mode: "content" } }, "write_file", '{"path":"a.txt","content":"hi"}').includes("hi"),
  "content mode without keys still reads as the model's text mid-stream"
);

// ---- 4) the renderer knows NO tool name: it renders from the declaration alone ----
const toolNames = [
  "read_file", "write_file", "edit_file", "grep", "web_search", "web_fetch",
  "save_memory", "load_memory", "search_memory", "load_skill", "run_command",
];
const leaked = toolNames.filter((n) => src.includes(n));
check(leaked.length === 0, `ui/app.js contains no tool name (leaked: ${leaked.join(", ") || "none"})`);

// ---- 5) source-level guards: the protocol's wiring is what makes it work ----
check(/const CALL_BLOCK = /.test(src), "the block for ungrouped calls exists");
check(/function ensureToolGroup\(/.test(src), "calls collect into a group block");
check(/ui\.collapse === "always"/.test(src), "collapse is read from the declaration");
check(/ui\.mutates/.test(src), "mutates is read from the block (host-derived when undeclared)");
check(/uiOf\(ev\)/.test(src), "the call event's own ui block is the source of truth");

summary("tool-ui-protocol-test", "all checks passed");
