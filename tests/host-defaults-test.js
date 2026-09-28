"use strict";

// Regression test for the renderer's UI-DEFAULTS precedence. Where a tool's
// look comes from, oldest first:
//
//   the compiled-in constants (UI_DEFAULTS in ui/app.js) are the fallback;
//   the HOST's own table (GET /api/host -- the host.json document merged over
//   those constants server-side) is fetched once at boot and speaks for every
//   event that carries no `ui` of its own;
//   a call's own declaration (`ui` on the event / on the call row) wins over
//   both.
//
// The real functions are extracted from ui/app.js (slicer) and driven against
// globals, so a silent edit that lets a constant outrank the host's table, or a
// call's block lose to either, fails here.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const APP = path.join(__dirname, "..", "ui", "app.js");
const src = fs.readFileSync(APP, "utf8");
const { fnBody, region } = slicer(src);

// the precedence lives in the slice from `function uiDefaults` through
// `uiOfResult` (uiDefaults + UI_DEFAULTS + uiOf + uiOfResult). The two pieces
// of state it reads are deliberately NOT in the slice: they are supplied as
// globals, the way the app itself supplies them (loadHostDefaults assigns
// hostUiDefaults; the call-row machinery owns toolCalls).
global.hostUiDefaults = null;
global.toolCalls = {};
(0, eval)(region("function uiDefaults", "uiOfResult"));

(async () => {
  // ---- 1) nothing fetched: the compiled-in constants are the fallback ----
  const plain = uiDefaults();
  check(plain.chip === "name" && plain.group === null && plain.form === "block",
        "with no host table, uiDefaults() is the compiled-in constants");

  // ---- 2) the host's table speaks over the constants ----
  global.hostUiDefaults = { chip: "none", group: "host" };
  const hosted = uiDefaults();
  check(hosted.chip === "none" && hosted.group === "host", "the host's table overrides the constants it names");
  check(hosted.form === "block" && hosted.body === "text", "keys the host does not name keep the constants");
  check(uiOf({}).chip === "none", "an event with no ui block renders with what the host says");
  uiDefaults().chip = "mutated";
  check(uiDefaults().chip === "none", "a caller mutating its copy does not corrupt the host's table");

  // ---- 3) an event's own block wins over the host's table ----
  const ev = uiOf({ ui: { chip: "path" } });
  check(ev.chip === "path", "an event's own ui block wins over the host's table");
  check(ev.group === "host", "and fills the keys it leaves unnamed from the host's table");

  // ---- 4) uiOfResult: the call's declaration outranks everything ----
  global.toolCalls.c1 = { name: "t", ui: { form: "row", body: "code" } };
  const own = uiOfResult({ tool_call_id: "c1", ui: { form: "block" } });
  check(own.form === "row", "a call's own declaration wins over the event's and the host's");
  check(own.chip === "none", "and fills the rest from the host's table");
  global.toolCalls.c3 = { name: "t" }; // a call that declared nothing
  check(uiOfResult({ tool_call_id: "c3" }).chip === "none",
        "a call that declared no ui inherits the host's table");
  check(uiOfResult({ tool_call_id: "missing", ui: { chip: "path" } }).chip === "path",
        "a result whose call is not in memory renders from its own copy");

  // ---- 5) source guards: the wiring, and who reads the constants ----
  const boot = fnBody("loadHostDefaults");
  check(/apiFetch\("\/api\/host"\)/.test(boot), "boot fetches the host's table from GET /api/host");
  check(/try \{/.test(boot) && /catch/.test(boot), "a failed or absent endpoint leaves the constants standing");
  check(/let hostUiDefaults = null;/.test(src), "the host table starts null: the constants stand until it arrives");
  check(/await loadHostDefaults\(\);/.test(src), "boot awaits the host's table before the stream opens");
  check(!/UI_DEFAULTS/.test(fnBody("uiOf") + fnBody("uiOfResult")),
        "the row renderers read uiDefaults(), never the bare constants");

  summary("host-defaults-test");
})().catch((e) => { console.error(e); process.exit(1); });
