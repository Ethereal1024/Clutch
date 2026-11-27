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
// Like stream-render-test.js this extracts the REAL functions from the renderer
// and asserts on the real sources, so silent regressions fail here.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = uiSource(); // the renderer, every module in page load order
const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");
const permPy = fs.readFileSync(path.join(ROOT, "agent", "core", "permission.py"), "utf8");

const { fnBody } = slicer(src);

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

// ---- 2b. otherArgs / argsDetail: a command payload is not only its command ----
// The args panel is the payload one click away, and the permission dialog is
// what the user is asked about: unwrapping the command must not swallow the
// arguments the call set beside it (a deadline, a workdir). The real functions
// are composed here the way the renderer composes them.
const otherArgs = new Function("return (" + fnBody("otherArgs") + ");")();
const argsDetail = new Function(
  "extractCommand",
  "otherArgs",
  "return (" + fnBody("argsDetail") + ");",
)(extractCommand, otherArgs);

check(
  otherArgs('{"command": "npm test", "timeout": 3600}') === '{"timeout":3600}',
  "the arguments beside the command survive the unwrap",
);
check(otherArgs('{"command": "ls"}') === "", "a payload that is only its command has nothing beside it");
check(
  otherArgs('{"command": "ls", "workdir": "sub"}') === '{"workdir":"sub"}',
  "any argument beside the command is kept, not just a deadline",
);
check(otherArgs('{"command": "ls", "timeout": 60') === "", "mid-stream JSON has nothing to show yet");
check(otherArgs('"ls -la"') === "", "a bare JSON string has nothing beside it");
check(otherArgs("42") === "", "a scalar payload has nothing beside it");
check(otherArgs('{"timeout": 60}') === '{"timeout":60}', "a non-command payload keeps every key it has");
check(otherArgs({ command: "ls", timeout: 5 }) === '{"timeout":5}', "a parsed payload works the same");

const CMD_UI = { preview: "command" };
check(
  argsDetail(CMD_UI, '{"command": "npm test", "timeout": 3600}') === '$ npm test\n{"timeout":3600}',
  "the args panel shows the command AND the deadline it was given",
);
check(argsDetail(CMD_UI, '{"command": "ls"}') === "$ ls", "a command-only payload reads exactly as before");
check(
  argsDetail({ preview: { mode: "command", mark: "> " } }, '{"command": "ls", "timeout": 5}') === '> ls\n{"timeout":5}',
  "a declared mark styles the command line, not the arguments beside it",
);
check(
  argsDetail({ preview: "args" }, '{"a": 1}') === '{\n "a": 1\n}',
  "anything not command-shaped stays pretty JSON, whole",
);

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
check(
  /const rest = otherArgs\(txt\);\s*\n\s*txt = "\$ " \+ cmd/.test(src),
  "permissions.ts: the prompt appends the arguments the call set beside its command",
);


summary("perm-args-test");
