"use strict";

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

module.exports = { check, summary, get failures() { return failures; } };
