"use strict";

const fs = require("fs");
const path = require("path");

// Shared assertion harness for the standalone node runners (no test framework:
// each is `node tests/<name>.test.js`). check() prints one line per assertion and
// counts failures; summary() prints the verdict and exits non-zero when anything
// failed. Python's counterpart lives in tests/testsupport.py (check / collecting_check).

let failures = 0;

function check(cond, label) {
  console.log((cond ? "ok:   " : "FAIL: ") + label);
  if (!cond) failures++;
}

function summary(name, okMsg) {
  if (failures) {
    console.log(`\n${name}: ${failures} FAILED`);
    process.exit(1);
  }
  console.log(`\n${name}: ${okMsg || "all checks passed"}`);
}

// ---- slicing real code out of a source file ----
//
// Some runners (stream-render / perm-args) deliberately do NOT
// re-implement what they test: they pull the REAL functions out of the renderer
// and drive them against stubs, so a silent edit cannot regress them unnoticed. Locating a function's body inside a text is the one piece of that
// trick — and a copy of it in every runner is exactly the sort of helper that
// drifts (they were identical, with one of them quietly missing the async case).
//
// slicer(src) returns offsets into `src`:
//   bodyEnd(open)        index just past the `{...}` block starting at `open`
//   sigBodyOpen(start)   the body brace of the signature at `start`, skipping the
//                        parameter list (a destructured param holds braces too)
//   fnBody(name)         the whole `[async] function <name>(...) {...}` text
//   region(startMark, name)  from `startMark` to the end of function `name`
function slicer(src) {
  function bodyEnd(open) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    throw new Error("unbalanced braces after offset " + open);
  }

  function sigBodyOpen(start) {
    let paren = 0, seen = false;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "(") { paren++; seen = true; }
      else if (src[i] === ")") paren--;
      else if (seen && paren === 0 && src[i] === ":") return typeEnd(i); // an annotated return type
      else if (seen && paren === 0 && src[i] === "{") return i;
    }
    throw new Error("no function body found at offset " + start);
  }

  // The body brace of a signature that carries a TypeScript return type
  // (`: Promise<{ active: boolean }> {`): the type may hold braces of its own, so
  // the body is the first `{` that no `<`, `(`, `[` or `{` is still open over. A
  // type that IS a literal (`: { ok: boolean } {`) is one balanced block, and the
  // body is the brace after it.
  function typeEnd(colon) {
    let angle = 0, brace = 0, bracket = 0, paren = 0, i = colon + 1;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "{") i = bodyEnd(i); // a type that IS a literal: skip the block, the body follows
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "<") angle++;
      else if (c === ">") angle--;
      else if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (c === "[") bracket++;
      else if (c === "]") bracket--;
      else if (c === "{") {
        if (angle === 0 && brace === 0 && bracket === 0 && paren === 0) return i;
        brace++;
      } else if (c === "}") brace--;
    }
    throw new Error("no function body found after return type at offset " + colon);
  }

  function fnBody(name) {
    let start = src.indexOf("function " + name + "(");
    if (start < 0) throw new Error("missing function: " + name);
    if (src.slice(Math.max(0, start - 6), start) === "async ") start -= 6; // keep the async keyword
    return src.slice(start, bodyEnd(sigBodyOpen(start)));
  }

  function region(startMark, endName) {
    const a = src.indexOf(startMark);
    if (a < 0) throw new Error("missing marker: " + startMark);
    return src.slice(a, bodyEnd(sigBodyOpen(src.indexOf("function " + endName + "("))));
  }

  return { bodyEnd, sigBodyOpen, fnBody, region };
}

// ---- the renderer's sources, in the order they run ----
//
// The renderer used to be one file (ui/app.js), then a stack of classic scripts
// that ui/index.html listed in the only order that works (they shared one global
// scope, so each could use names declared above it and nothing below). The
// sources are ES modules now (ui/src/renderer/*.ts) and the page loads one
// bundle (ui/renderer.js, built by ui/build-renderer.js); boot.ts is the entry,
// and its side-effect imports ARE that old page order. Reading the order from
// boot.ts is what keeps this harness and the page on one list: a module dropped
// from the imports is simply absent here (the runner fails loudly instead of
// passing against dead code). The runners read SOURCE text on purpose: they test
// the code that ships, not the re-printed bundle.
const UI_DIR = path.join(__dirname, "..", "ui");
const RENDERER_SRC = path.join(UI_DIR, "src", "renderer");

const sourcePath = (name) => path.join(RENDERER_SRC, name.endsWith(".ts") ? name : name + ".ts");

// [{ file, code }] — the renderer's own modules, in the order they run:
// boot.ts's side-effect imports, then boot.ts itself, which starts the app once
// every module above it exists.
function uiModules() {
  const boot = fs.readFileSync(sourcePath("boot"), "utf8");
  const order = [...boot.matchAll(/^import\s+"\.\/([\w-]+)";$/gm)].map((m) => m[1] + ".ts");
  if (!order.length) throw new Error("boot.ts lists no side-effect imports — the load order is gone");
  order.push("boot.ts");
  return order.map((file) => ({ file, code: fs.readFileSync(sourcePath(file), "utf8") }));
}

// Every source's text — "what does the renderer say", which is what the slicers
// need (uiModules() answers "what runs, in what order"). The leaf modules lead:
// state.ts declares the bindings more than one module writes, dom.ts the one
// shorthand every module calls at load time, and neither is a load-order step —
// they are imported, not sequenced.
function uiSource() {
  const mods = uiModules();
  const listed = new Set(mods.map((m) => m.file));
  const leaves = fs.readdirSync(RENDERER_SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !listed.has(f))
    .sort();
  return [...leaves, ...mods.map((m) => m.file)]
    .map((f) => fs.readFileSync(sourcePath(f), "utf8"))
    .join("\n");
}

// A module's source with the module syntax taken out, so a runner can execute a
// whole file in a vm context the way the page used to load it: `import`/`export`
// are syntax errors in a classic script. Imports are dropped (they can span
// lines), `export ` prefixes are stripped, and `export {};` — a file that exports
// nothing — becomes an empty block, which is inert.
function stripModuleSyntax(code) {
  return code
    .replace(/^import\s+\{[^}]*\}\s+from\s+"[^"]+";\s*$/gm, "")
    .replace(/^import\s+"[^"]+";\s*$/gm, "")
    .replace(/^export\s+/gm, "");
}

// Source text as a runnable classic script: module syntax stripped as text (see
// above) and the TypeScript stripped by esbuild — node cannot read types, and the
// tsconfig says the same thing the bundle does. No `format` on purpose: the wrap
// an IIFE adds is exactly what a classic script must NOT do here — the file's
// top-level functions have to land on the shared global scope, which is what the
// page's old <script> tags gave them and what these runners assert on. esbuild is
// loaded lazily: only the runners that execute source text need it.
//
// Takes a whole file OR a slice of one: the runners that drive a handful of real
// functions (slicer/region) hand the slice here, because the sources are
// TypeScript modules now and both `export` and `as Node` are syntax errors in the
// vm/indirect-eval they run in.
function runnableSnippet(code) {
  const esbuild = require(require.resolve("esbuild", { paths: [UI_DIR] }));
  return esbuild.transformSync(stripModuleSyntax(code), { loader: "ts", target: "es2020" }).code;
}

function rendererScript(name) {
  return runnableSnippet(fs.readFileSync(sourcePath(name), "utf8"));
}

// The renderer's shared mutable state (ui/src/renderer/state.ts) as a fresh
// object holding its declared defaults. A runner that executes a slice which
// touches `state.*` gets the real shape — every field present, at the value the
// page starts with — instead of a hand-written stub that drifts the first time a
// field is added. Fresh per call: a runner's scenario cannot leak into the next.
function stateStub() {
  const vm = require("vm");
  const ctx = vm.createContext({});
  vm.runInContext(runnableSnippet(fs.readFileSync(sourcePath("state"), "utf8")), ctx);
  return vm.runInContext("state", ctx);
}

// Execute one renderer module in THIS context, the way `require` used to run a
// classic script: the host-bridge runners want its side effects on globalThis and
// nothing else of the app.
function loadRendererModule(name) {
  require("vm").runInThisContext(rendererScript(name), { filename: "ui/src/renderer/" + name.replace(/\.ts$/, "") + ".ts" });
}

// The closed-block ledger (stream-events.ts): `awaiting` is the list of blocks a
// cut closed that the log still owes text to. It is module-level state, so a
// runner that evals only the functions it drives has to give those functions the
// name. This installs the REAL ledger — not a stub — because the behaviour it
// encodes is exactly what a reconnect regression looks like: the block stays on
// the page, its continuation is dropped instead of appended, and the step's own
// record (or the run's final) writes it whole.
function installRecordLedger() {
  const src = fs.readFileSync(sourcePath("stream-events"), "utf8");
  const text = fs.readFileSync(sourcePath("stream-text"), "utf8");
  const { fnBody } = slicer(src);
  globalThis.awaiting = [];
  // a block's text is painted by stream-text.ts, shared with the streaming pass
  (0, eval)(runnableSnippet(slicer(text).fnBody("paintTextBlock")));
  for (const fn of ["awaitRecord", "unawait", "awaitingFor", "completeRecord"]) {
    (0, eval)(runnableSnippet(fnBody(fn)));
  }
}

// The countdown meter (countdown.ts): stream-events.ts routes the host's live
// `tool_started` frame to it and settles it on the result/final, and slots.ts
// repaints from it when a cached tab comes back. A runner that slices those
// functions therefore needs the meter's names, and this installs the REAL module
// — the meter's own runner drives its arithmetic, so a stub here would only let
// the routing rot unnoticed. Pass a vm context to install it on that page; with
// no argument it goes on globalThis. A runner whose page draws no meter only
// needs its document to answer "none", so a missing querySelectorAll is filled
// with the truthful empty list instead of a fake meter.
function installCountdown(ctx) {
  const vm = require("vm");
  const snippet = rendererScript("countdown");
  const doc = ctx ? ctx.document : globalThis.document;
  if (doc && typeof doc.querySelectorAll !== "function") doc.querySelectorAll = () => [];
  if (ctx) {
    vm.runInContext(snippet, ctx);
    return ctx;
  }
  vm.runInThisContext(snippet, { filename: "ui/src/renderer/countdown.ts" });
}

module.exports = {
  check, summary, slicer, uiSource, uiModules,
  rendererScript, loadRendererModule, stripModuleSyntax, runnableSnippet, stateStub,
  installRecordLedger, installCountdown,
  get failures() { return failures; },
};
