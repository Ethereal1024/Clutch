"use strict";

// Regression test for the permission UI's command display:
//
// 1. FONT — #perm-args (class .args) is a <pre>; with no font-family rule it
//    fell back to the browser's default fixed-width font, which on zh-CN
//    Windows is SimSun (宋体) — serif-looking commands in the dialog.
// 2. BRACE SOUP — the command unwrap only handled one layer ({command: str}).
//    Double-encoded envelopes ({"command": "{\"command\": \"ls\"}"}), nested
//    objects and bare JSON strings fell through, and the ask reason line even
//    embedded the raw args JSON ("... with args {\"command\": ...}"), so the
//    dialog showed brace-wrapped payload instead of the command.
//
// Like stream-render-test.js this extracts the REAL functions from ui/app.js
// and asserts on the real sources, so silent regressions fail here.

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");
const permPy = fs.readFileSync(path.join(ROOT, "agent", "core", "permission.py"), "utf8");

// ---- extraction helpers (same as stream-render-test.js) ----
function bodyEnd(open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return i + 1; }
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
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing function: " + name);
  return src.slice(start, bodyEnd(sigBodyOpen(start)));
}

const extractCommand = new Function(
  "return (" + fnBody("extractCommand") + ");",
)();
const permReason = new Function(
  "return (" + fnBody("permReason") + ");",
)();

// ---- 1. extractCommand: every payload shape seen in the wild ----
const cmd = (o) => extractCommand(JSON.stringify(o));
check(extractCommand('{"command": "ls -la"}') === "ls -la", "plain envelope -> command");
check(cmd({ command: "ls -la", comment: "listing" }) === "ls -la", "extra fields tolerated");
check(cmd({ command: { command: "ls -la" } }) === "ls -la", "nested envelope unwrapped");
check(
  cmd({ command: JSON.stringify({ command: "ls -la" }) }) === "ls -la",
  "double-encoded envelope unwrapped",
);
check(
  cmd({ command: JSON.stringify({ command: JSON.stringify({ command: "ls -la" }) }) }) === "ls -la",
  "triple-encoded envelope unwrapped",
);
check(extractCommand('"ls -la"') === "ls -la", "bare JSON string -> command");
check(cmd({ comment: "why" }) === null, "object without command -> JSON view, not braces");
check(cmd({ command: ["ls", "-la"] }) === null, "array command -> JSON view, not braces");
check(extractCommand("ls -la") === null, "non-JSON text -> JSON view fallback (rendered raw)");
check(extractCommand("42") === null, "number payload -> null");
check(extractCommand("") === null, "empty payload -> null");

// ---- 2. permReason: no args dump in the dialog header ----
check(
  permReason('permission ask: run_command with args {"command": "ls"}') === "permission ask: run_command",
  "legacy 'with args {...}' suffix stripped",
);
check(
  permReason("access outside the workspace: C:\\outside") === "access outside the workspace: C:\\outside",
  "escape reason passes through untouched",
);
check(permReason("") === "", "empty reason -> empty");
check(permReason(null) === "", "null reason -> empty string");

// ---- 3. sources: the CSS font rule and the backend reason format ----
check(
  /\.args\s*\{[^}]*font-family:\s*var\(--font-mono\)/.test(css),
  "style.css: .args uses the mono stack (else <pre> falls back to SimSun)",
);
check(
  !/with args/.test(permPy),
  "permission.py: ask reason no longer embeds the raw args JSON",
);
check(/reason = f"permission \{action\}"/.test(permPy), "permission.py: reason keeps the action form (tool lives in the header)");

summary("perm-args-test");
