"use strict";

// The statement renderer (`ui/host/inst.js`) against the Python it ports:
// `agent/tools/inst.py` (+ `shq`, which lives in `exec.js` here).
//
// What this replay pins, in the order the fixture was captured:
//
//   * `render` — 54 cases: `{name}` as ONE shell word (including the hostile
//     values: quote breaks, `$(id)`, backticks, `${HOME}`, newlines, CJK, empty),
//     `{*}` as one shell-quoted JSON object with sorted keys, host vars shadowing
//     model args, defaults filling what the model omitted, optional groups
//     dropped WHOLE (flag included), `[[`/`]]` literal, `raw` verbatim — and every
//     fail-closed error SENTENCE, because those are what the model reads;
//   * `jarg` / `shq` — the two escapers, byte for byte;
//   * `unwrap` — 23 cases: a stdout JSON object carrying a string `content` IS
//     the envelope, anything else is framed by the exit code, and nothing parses
//     a status line out of the output.
//
// Half of that contract ("one word") is not a claim a parser can settle, so this
// runner also feeds the rendered lines to the REAL `/bin/sh`: `printf %s
// <rendered>` must reproduce the value byte for byte. The fixture's expected
// lines come from the Python renderer, so the two halves prove each other — a
// renderer that agreed with Python but not with a shell would fail here.
//
// Run: node tests/host-inst.test.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { check, summary } = require("./harness");

const HOST = path.join(__dirname, "..", "ui", "host");
const FIXTURE = path.join(__dirname, "fixtures", "inst", "expected.json");

const { shq } = require(path.join(HOST, "exec.js"));
const inst = require(path.join(HOST, "inst.js"));

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

// `sh -c <line>` with the bytes back, or null where this machine has no POSIX
// shell (the replay then says so instead of pretending).
function shell(line) {
  const run = spawnSync("/bin/sh", ["-c", line], { encoding: "utf8", timeout: 20000 });
  if (run.error) return null;
  return { stdout: run.stdout, code: run.status };
}

const SHELL = shell("printf %s ok");

// ---- render ---------------------------------------------------------------

function replayRender() {
  const failures = [];
  for (const entry of fixture.render) {
    let line;
    let message;
    try {
      line = inst.render(entry.template, entry.args, {
        vars: entry.vars,
        defaults: entry.defaults,
        raw: entry.raw,
      });
    } catch (error) {
      if (!(error instanceof inst.InstError)) throw error;
      message = error.message;
    }
    const want = Object.prototype.hasOwnProperty.call(entry, "error") ? entry.error : entry.line;
    const got = message === undefined ? line : message;
    check(got === want, `render: ${entry.name}`);
    if (got !== want) failures.push({ name: entry.name, want, got });
  }
  return failures;
}

// ---- the two escapers -----------------------------------------------------

function replayEscapers() {
  for (const entry of fixture.shq) {
    check(shq(entry.value) === entry.text, `shq: ${JSON.stringify(entry.value)}`);
  }
  for (let i = 0; i < fixture.jarg.length; i += 1) {
    const entry = fixture.jarg[i];
    check(inst.jarg(entry.value) === entry.text, `jarg: payload ${i}`);
  }
}

// ---- unwrap ---------------------------------------------------------------

function replayUnwrap() {
  for (const entry of fixture.unwrap) {
    const options = entry.service === null ? {} : { service: entry.service };
    const got = inst.unwrap({ code: entry.code, stdout: entry.stdout, stderr: entry.stderr }, options);
    const same =
      got.content === entry.expect.content &&
      got.error === entry.expect.error &&
      got.diff === entry.expect.diff &&
      Object.keys(got).length === 3;
    check(same, `unwrap: ${entry.name}`);
    if (!same) {
      console.log(`  want ${JSON.stringify(entry.expect)}`);
      console.log(`  got  ${JSON.stringify(got)}`);
    }
  }
}

// ---- the REAL shell -------------------------------------------------------

function replayThroughShell() {
  if (SHELL === null) {
    check(false, "this machine has a /bin/sh to prove `one word` with");
    return;
  }
  check(SHELL.stdout === "ok", "the real /bin/sh answers");
  for (const entry of fixture.render) {
    if (!entry.template.startsWith("printf %s {v}") || entry.vars && Object.keys(entry.vars).length) continue;
    const line = inst.render(entry.template, entry.args, { vars: entry.vars, raw: entry.raw });
    const run = shell(line);
    check(run !== null && run.stdout === entry.args.v, `the shell reproduces the value: ${JSON.stringify(entry.args.v)}`);
  }
  // `{*}` is ONE word: the shell must hand back exactly the sorted JSON the
  // renderer produced, with the model's values unescaped once.
  const args = { path: "数据.txt", note: "it's \"quoted\"\nand a newline" };
  const line = inst.render("printf %s {*}", args);
  const run = shell(line);
  const body = run === null ? null : run.stdout;
  check(body !== null && JSON.parse(body) && JSON.stringify(JSON.parse(body)) === JSON.stringify(
    Object.fromEntries(Object.keys(args).sort().map((key) => [key, args[key]]))
  ), "the shell hands {*} back as one JSON object with the model's own values");
}

// ---- the fixture's own shape ----------------------------------------------

function fixtureShape() {
  check(fixture.render.length === 54, `the fixture holds 54 renders (${fixture.render.length})`);
  check(fixture.unwrap.length === 23, `the fixture holds 23 unwraps (${fixture.unwrap.length})`);
  check(
    fixture.render.filter((entry) => Object.prototype.hasOwnProperty.call(entry, "error")).length === 11,
    "11 of the renders are fail-closed errors, sentence and all"
  );
  const hostile = fixture.render.find((entry) => entry.args.v === "'; rm -rf /; echo '");
  check(hostile !== undefined && hostile.line.startsWith("printf %s '"), "a quote break is a quoted word, not a second command");
  const nested = fixture.jarg.find((entry) => entry.value && entry.value.nested);
  check(nested !== undefined && nested.text.startsWith("'{\"nested\":{\"a\""), "jarg sorts keys at every level");
}

function main() {
  fixtureShape();
  replayEscapers();
  replayRender();
  replayUnwrap();
  replayThroughShell();
  summary("host-inst", "the statement renderer agrees with agent/tools/inst.py");
}

main();
