"use strict";

// Permission prompt keys / dismissal.
//
// The agent BLOCKS on a permission verdict and the prompt is the only way to
// answer it, so an accidental answer is an accidental denial of the model's
// permission request. Two accidental paths existed:
//
//   1. a click on the backdrop (dismissOnOverlayPress(permModal, ...)) answered
//      DENY — the most destructive possible default for a stray click;
//   2. a keyboard user had no key for the answer they usually want (Allow).
//
// The fix: the prompt opts out of backdrop dismissal (every OTHER modal keeps
// it) and Enter answers Allow. Enter is handled by a real named function
// (permKey) so this runner can drive the REAL implementation out of the renderer
// (ui/js/permissions.js) instead of re-implementing it.

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const src = uiSource(); // the renderer, every module in page load order
const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");

// ---- the real permKey, driven against stubs ----
const permKey = new Function("return (" + slicer(src).fnBody("permKey") + ");")();

let calls = [];
global.pendingPerm = null; // read by permKey at call time (free identifier)
global.respondPerm = (allow) => {
  if (!global.pendingPerm) return;
  calls.push(allow);
  global.pendingPerm = null; // respondPerm -> closePerm consumes the prompt
};

function key(k, opts) {
  return Object.assign(
    { key: k, isComposing: false, prevented: false, preventDefault() { this.prevented = true; } },
    opts || {},
  );
}

// ---- 1) Enter on an open prompt answers Allow, once ----
global.pendingPerm = { request_id: "r1" };
let e = key("Enter");
check(permKey(e) === true, "Enter is consumed while the prompt is open");
check(calls.length === 1 && calls[0] === true, "Enter answers ALLOW");
check(e.prevented, "Enter's default action is cancelled (a focused Deny cannot also fire)");
check(global.pendingPerm === null, "Enter consumed the pending prompt");

// ---- 2) Enter twice cannot answer a second time (no double verdict) ----
check(permKey(key("Enter")) === false, "a second Enter finds no prompt");
check(calls.length === 1, "no second verdict is sent");

// ---- 3) every other key leaves the prompt open ----
for (const k of ["Escape", "a", " ", "n", "Tab"]) {
  global.pendingPerm = { request_id: "r-" + k };
  e = key(k);
  check(permKey(e) === false && calls.length === 1 && !e.prevented, `"${k}" neither answers nor is swallowed`);
}
check(global.pendingPerm !== null, "a non-Enter key leaves the prompt waiting");

// ---- 3b) a modified Enter is not the reflex key ----
// Ctrl/Cmd+Enter already means "run" in the task box: the prompt must not
// shadow that shortcut (and Alt/Shift combinations are not the plain answer).
for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
  global.pendingPerm = { request_id: "r-" + mod };
  e = key("Enter", { [mod]: true });
  check(permKey(e) === false && calls.length === 1 && !e.prevented, `${mod}+Enter leaves the prompt alone`);
}
check(global.pendingPerm !== null, "a modified Enter leaves the prompt waiting");
global.pendingPerm = null;

// ---- 4) an IME composition Enter is not an answer ----
// typing CJK behind the prompt, Enter confirms a candidate: that keystroke
// belongs to the input method, not to the permission verdict
global.pendingPerm = { request_id: "r-ime" };
e = key("Enter", { isComposing: true });
check(permKey(e) === false && calls.length === 1 && !e.prevented, "a composing Enter is ignored");
check(global.pendingPerm !== null, "a composing Enter leaves the prompt waiting");
global.pendingPerm = null;

// ---- 5) the prompt is no longer dismissible by a backdrop click ----
check(
  !/dismissOnOverlayPress\(\s*permModal/.test(src),
  "the renderer registers no backdrop dismiss for the permission prompt",
);
check(
  (src.match(/respondPerm\(false\)/g) || []).length === 1,
  "DENY has exactly one path left: the Deny button",
);
check(
  /#perm-deny"\)\.addEventListener\("click", \(\) => respondPerm\(false\)\)/.test(src),
  "the Deny button is still the explicit deny path",
);
check(
  /document\.addEventListener\("keydown", permKey\)/.test(src),
  "the Enter handler is installed on the document (focus may sit anywhere)",
);

// ---- 6) opting out is the prompt's alone: the helper and the other modals stay ----
check(/function dismissOnOverlayPress\(/.test(src), "the shared dismiss helper is untouched");
const otherModals = (src.match(/dismissOnOverlayPress\((?!\s*permModal)/g) || []).length;
check(otherModals >= 5, "every other modal keeps its backdrop dismiss");

// ---- 7) the host page still offers the keyboard hint and both answers ----
check(/id="perm-allow"[^>]*title="[^"]*Enter/.test(html), "index.html advertises Enter on Allow");
check(html.indexOf('id="perm-allow"') > 0 && html.indexOf('id="perm-deny"') > 0, "both answers are in the prompt");

summary("perm-key-test");
