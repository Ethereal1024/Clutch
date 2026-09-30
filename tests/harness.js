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
      else if (seen && paren === 0 && src[i] === "{") return i;
    }
    throw new Error("no function body found at offset " + start);
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

// ---- the renderer's source, in page load order ----
//
// The renderer used to be one file (ui/app.js); it is now several classic
// scripts that ui/index.html lists in the only order that works (they share one
// global scope, so each may use names declared above it and nothing below). The
// runners care about the code, not the file layout, so they read the page's own
// script list rather than a private copy of it: a function that moves between
// modules keeps working, and a module the page forgets to load is simply absent
// (the runner fails loudly instead of passing against dead code).
const UI_DIR = path.join(__dirname, "..", "ui");

// [{ file, code }] — the renderer's own scripts, in page order. The load-order
// test needs them separately (each file is a classic script with its own
// directive prologue and its own declarations); everything else wants uiSource().
function uiModules() {
  const html = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith("vendor/") && s !== "bridge-shim.js"); // third-party + host shim
  return srcs.map((file) => ({ file, code: fs.readFileSync(path.join(UI_DIR, file), "utf8") }));
}

function uiSource() {
  return uiModules().map((m) => m.code).join("\n");
}

module.exports = { check, summary, slicer, uiSource, uiModules, get failures() { return failures; } };
