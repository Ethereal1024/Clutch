"use strict";

// The permission engine's spec: `ui/host/permission.js` against
// `agent/core/permission.py`.
//
// This is M3's fence, so what is pinned here is not "the port runs" but the
// contract three other things already depend on:
//
//   * the VERDICT. `tests/permission_capture.py` ran the Python engine over 43
//     calls — the five rules, the escape walk, `cd` tracking, `~`, the scratch
//     dirs, renamed arguments, payloads that are not JSON — and wrote each
//     verdict and each sorted escape list to `fixtures/permission/`. The replay
//     below drives the same 43 calls through the JS evaluator on the same far
//     root, so a dropped rule, a reordered ruleset or a re-tokenized command
//     fails here instead of asking a user the wrong question.
//   * the SENTENCES. A refusal is what the model reads (`reason`) and what the
//     dialog shows, so every one of them is compared literally — including the
//     three the auto-allow/unattended replay produces, which is why the capture
//     recorded those modes as well as the plain evaluation.
//   * the TOKENIZER, compared directly: shlex.split's answer for 19 command
//     strings (nested quotes, kept backslashes, unbalanced quotes, a `\`-newline)
//     is the escape verdict's whole input.
//
// Then the states only the JS gate has, because it cannot block a thread: an
// approval grants the escape set for the pending call, a denial does not, an
// answered id leaves `pending` at once, an id is unique for the life of the
// process (two gates never collide), a prompt is re-announced while it waits,
// trust mode answers itself, a detached UI is denied after the grace — but a
// SHORT gap is not a denial — and `deny` never reaches the UI at all.
//
// The workspace is built from the real M1 code (`ui/host/fs.js`), with the exec
// seam answering one `echo $HOME`: the far root is `/home/u/proj`, a path that
// does not exist on this machine, and `fs.js` resolves it LEXICALLY. Nothing
// here reads the local filesystem except the fixture and the Python sources.
//
// Run: node tests/host-permission.test.js

const fs = require("fs");
const path = require("path");

const { check, summary } = require("./harness");

const HOST = path.join(__dirname, "..", "ui", "host");
const permission = require(path.join(HOST, "permission.js"));
const hostFs = require(path.join(HOST, "fs.js"));

const FIXTURE = path.join(__dirname, "fixtures", "permission", "expected.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const ROOT = fixture.workspace.root;
const HOME = fixture.workspace.home;

// A far workspace with NO local filesystem: the one fact `fs.js` needs from the
// far side is the user's home (`~` expansion), and one `echo $HOME` supplies it.
// Same root and same scratch trio the Python capture used, so the escape lists
// are comparable token for token.
function farWorkspace() {
  const shell = {
    calls: 0,
    async run() {
      shell.calls += 1;
      return { code: 0, stdout: `${HOME}\n`, stderr: "", bytes: Buffer.alloc(0) };
    },
  };
  return hostFs.createWorkspace({ root: ROOT, exec: shell });
}

const workspace = farWorkspace();
const evaluator = permission.createEvaluator();

// Poll a predicate instead of sleeping a fixed time: every wait below is
// "the gate reached state X", and a fixed sleep either flakes or slows the suite.
async function waitFor(predicate, tries = 500) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return false;
}

function reasonOf(error) {
  return error && error.reason !== undefined ? error.reason : null;
}

// ---- the fixture: verdicts, escape lists, split answers --------------------

async function replayEvaluate() {
  for (const c of fixture.evaluate) {
    const action = await evaluator.evaluate(c.args, workspace, c.access, c.arg);
    check(action === c.action, `evaluate "${c.name}": ${c.action} (got ${action})`);
    const escapes = [...(await evaluator.escapedPaths(c.args, workspace, c.access, c.arg))].sort();
    const want = c.escapes;
    check(
      JSON.stringify(escapes) === JSON.stringify(want),
      `escapes "${c.name}": ${want.length ? want.join(", ") : "none"} (got ${escapes.length ? escapes.join(", ") : "none"})`
    );
  }
}

async function replayAutoAllow() {
  for (const c of fixture.auto_allow) {
    const gate = permission.createGate({ evaluator, autoAllow: true });
    let error = null;
    try {
      await gate.require("some_tool", c.args, workspace, c.access, c.arg);
    } catch (e) {
      error = e;
    }
    check(reasonOf(error) === c.error, `auto-allow "${c.name}": ${c.error === null ? "runs" : c.error} (got ${reasonOf(error) === null ? "runs" : reasonOf(error)})`);
  }
}

async function replayUnattended() {
  const c = fixture.unattended;
  const gate = permission.createGate({ evaluator, onAsk: () => false });
  let error = null;
  try {
    await gate.require("run_command", c.args, workspace, c.access);
  } catch (e) {
    error = e;
  }
  check(reasonOf(error) === c.reason, `no UI attached (no probe): "${c.reason}" (got "${reasonOf(error)}")`);
  check(error instanceof permission.PermissionRequired, "no UI attached: the refusal is a PermissionRequired");
  check(error && error.code === "permission_required", "no UI attached: code is permission_required (the loop's sentinel)");
  check(gate.pendingIds().length === 0, "no UI attached: nothing is left pending");
}

function replaySplit() {
  for (const c of fixture.split) {
    const tokens = permission.splitCommand(c.command);
    const label = JSON.stringify(c.command);
    check(
      JSON.stringify(tokens) === JSON.stringify(c.tokens),
      `split ${label}: ${c.tokens === null ? "null (unparseable)" : JSON.stringify(c.tokens)} (got ${tokens === null ? "null (unparseable)" : JSON.stringify(tokens)})`
    );
  }
}

// ---- the gate: the states a promise-based wait owns ------------------------

// Start a require() the policy ASKS about, and hand back its waiting id. The
// caller settles it with `gate.resolve`; `promise` is the awaiting side.
async function startAskFor(gate, live, args = '{"command": "cat /etc/hostname"}', access = "command") {
  const promise = gate.require("run_command", args, live, access);
  const pending = await waitFor(() => gate.pendingIds().length === 1);
  check(pending, "the ask is pending while the user decides");
  return { promise, id: gate.pendingIds()[0] };
}

async function approvalGrantsTheEscape() {
  const live = farWorkspace();
  const published = [];
  const gate = permission.createGate({
    evaluator,
    onAsk: (id, tool, argsRepr, reason) => {
      published.push([id, tool, argsRepr, reason]);
    },
  });
  const args = '{"command": "cat /etc/hostname"}';
  const promise = gate.require("run_command", args, live, "command");
  const pending = await waitFor(() => gate.pendingIds().length === 1);
  check(pending, "approval: the prompt is pending");

  const [id, tool, argsRepr, reason] = gate.pendingAsks()[0];
  check(/^perm-[0-9a-f]{8}-\d+$/.test(id), `approval: the id is perm-<8 hex>-<counter> (${id})`);
  check(tool === "run_command", "approval: the prompt names the tool the loop passed");
  check(argsRepr === args, "approval: the prompt carries the model's raw args, unabridged");
  check(reason === "access outside the workspace: /etc/hostname", `approval: the reason names the escape (${reason})`);
  check(published.length === 1 && published[0][0] === id, "approval: onAsk ran once, with the same id pendingAsks reports");

  // the escape is refused until the answer arrives
  let before = null;
  try {
    await live.resolve("/etc/hostname");
  } catch (e) {
    before = e;
  }
  check(before && before.name === "ValueError", "approval: the escaped path is refused BEFORE the answer");

  check(gate.resolve(id, true) === true, "approval: resolve() answers the waiting ask");
  await promise;
  check(true, "approval: require() resolves once the user allows");
  check(gate.pendingIds().length === 0 && gate.pendingAsks().length === 0, "approval: an answered ask leaves pending at once");
  check((await live.resolve("/etc/hostname")) === "/etc/hostname", "approval: the granted path resolves for this call");
  let other = null;
  try {
    await live.resolve("/etc/shadow");
  } catch (e) {
    other = e;
  }
  check(other && other.name === "ValueError", "approval: the grant is the escape set, not the whole outside world");

  // an answered id is gone: a second answer is a no-op, not a second verdict
  check(gate.resolve(id, true) === false, "approval: the id is forgotten once answered");
  check(gate.resolve("perm-00000000-1", true) === false, "resolve: an unknown id answers nothing");
}

async function denialRefuses() {
  const live = farWorkspace();
  const gate = permission.createGate({ evaluator, onAsk: () => {} });
  const { promise, id } = await startAskFor(gate, live);
  check(gate.resolve(id, false) === true, "denial: resolve(false) answers the waiting ask");
  let error = null;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  check(reasonOf(error) === "denied by user", `denial: the model reads "denied by user" (got "${reasonOf(error)}")`);
  check(error instanceof permission.PermissionRequired && error instanceof Error, "denial: PermissionRequired is an Error");
  check(error && error.code === "permission_required", "denial: code is permission_required");
  check(error && error.requestId === id, "denial: the error carries the id the user answered");
  check(error && error.tool === "run_command" && error.argsRepr === '{"command": "cat /etc/hostname"}', "denial: the error carries the call it refused");
  check(error && error.message === error.reason, "denial: the message IS the reason (nothing to unwrap)");
  let refused = null;
  try {
    await live.resolve("/etc/hostname");
  } catch (e) {
    refused = e;
  }
  check(refused && refused.name === "ValueError", "denial: a denied escape is not granted");
  check(gate.pendingIds().length === 0, "denial: nothing is left pending");
}

// Two gates, one process: the id a window remembers must not be handed out again
// by the next run's gate (`_ASK_IDS`/`_PROCESS_TAG` in the Python).
async function idsAreProcessUnique() {
  const live = farWorkspace();
  const first = permission.createGate({ evaluator, onAsk: () => {} });
  const second = permission.createGate({ evaluator, onAsk: () => {} });
  const a = await startAskFor(first, live);
  const b = await startAskFor(second, live);
  check(a.id !== b.id, `ids: two gates never hand out the same id (${a.id} vs ${b.id})`);
  check(first.resolve(a.id, true) && !second.resolve(a.id, true), "ids: an answer reaches only the gate that asked");
  await a.promise;
  check(second.resolve(b.id, false), "ids: the second gate's own prompt is answered separately");
  let bError = null;
  try {
    await b.promise;
  } catch (e) {
    bError = e;
  }
  check(reasonOf(bError) === "denied by user", "ids: the untouched prompt is denied by user");
}

async function reannounceKeepsOffering() {
  const live = farWorkspace();
  const seen = [];
  const gate = permission.createGate({
    evaluator,
    attachPollS: 0.01,
    reannounceS: 0.02,
    onAsk: (id) => {
      seen.push(id);
    },
  });
  const promise = gate.require("run_command", '{"command": "cat /etc/hostname"}', live, "command");
  const repeated = await waitFor(() => seen.length >= 3);
  check(repeated, `reannounce: a waiting prompt is published again (${seen.length} publishes)`);
  check(new Set(seen).size === 1, "reannounce: every publish uses the SAME request id");
  check(gate.resolve(seen[0], true), "reannounce: the repeated prompt is still answerable");
  await promise;
}

async function trustModeAnswersItself() {
  const live = farWorkspace();
  let armed = false;
  const gate = permission.createGate({
    evaluator,
    attachPollS: 0.01,
    trustS: 0.02,
    trust: () => armed,
    onAsk: () => {},
  });
  const promise = gate.require("run_command", '{"command": "cat /etc/hostname"}', live, "command");
  check(await waitFor(() => gate.pendingIds().length === 1), "trust: the prompt is published");
  // disarmed, it waits: several polls go by with no auto-answer
  await new Promise((resolve) => setTimeout(resolve, 60));
  check(gate.pendingIds().length === 1, "trust: a disarmed prompt is NOT answered by the clock");
  armed = true; // arming mid-prompt starts the countdown, exactly like the button
  await promise;
  check(gate.pendingIds().length === 0, "trust: the armed countdown answered the prompt with allow");
  check((await live.resolve("/etc/hostname")) === "/etc/hostname", "trust: the allow granted the escape it was asked about");
}

async function detachGraceDenies() {
  const live = farWorkspace();
  const gate = permission.createGate({
    evaluator,
    attachPollS: 0.01,
    detachGraceS: 0.05,
    isAttached: () => false,
    onAsk: () => {},
  });
  const started = Date.now();
  let error = null;
  try {
    await gate.require("run_command", '{"command": "cat /etc/hostname"}', live, "command");
  } catch (e) {
    error = e;
  }
  const waited = Date.now() - started;
  check(reasonOf(error) === "no user interface connected to confirm this action", `detach: a UI gone past the grace is denied with the no-UI sentence (got "${reasonOf(error)}")`);
  check(waited >= 45, `detach: the grace is honoured before denying (${waited} ms)`);
  check(gate.pendingIds().length === 0, "detach: the abandoned prompt is cleaned up (the run is not wedged)");
  let refused = null;
  try {
    await live.resolve("/etc/hostname");
  } catch (e) {
    refused = e;
  }
  check(refused && refused.name === "ValueError", "detach: nobody approved, so nothing was granted");
}

async function aShortGapIsNotADenial() {
  // The point of DETACH_GRACE_S: an EventSource between reconnects reads
  // "nobody attached" for a second while the dialog is still on screen. That
  // zero must not deny a prompt the user is about to answer.
  const live = farWorkspace();
  let attached = false;
  const gate = permission.createGate({
    evaluator,
    attachPollS: 0.01,
    detachGraceS: 0.5,
    isAttached: () => attached,
    onAsk: () => {
      setTimeout(() => {
        attached = true;
      }, 40);
      return false; // the instant this prompt is handed over, nobody reads as attached
    },
  });
  const promise = gate.require("run_command", '{"command": "cat /etc/hostname"}', live, "command");
  check(await waitFor(() => gate.pendingIds().length === 1), "gap: a detached hand-over still publishes the prompt");
  check(gate.pendingIds().length === 1, "gap: the prompt survives the zero-subscriber instant");
  check(await waitFor(() => attached), "gap: the window came back");
  check(gate.resolve(gate.pendingIds()[0], true), "gap: the prompt is still answerable after the gap");
  await promise;
  check((await live.resolve("/etc/hostname")) === "/etc/hostname", "gap: the approval counts (a transient gap is not a denial)");
}

async function denyNeverAsks() {
  const live = farWorkspace();
  let asked = 0;
  // A ruleset with a deny: the shipped five never deny, but deny is part of the
  // contract the loop reads, so it is exercised rather than assumed.
  const strict = permission.createEvaluator([permission.Rule("deny", "command", "\\bsudo\\b")]);
  const gate = permission.createGate({ evaluator: strict, onAsk: () => { asked += 1; } });
  let error = null;
  try {
    await gate.require("run_command", '{"command": "sudo id"}', live, "command");
  } catch (e) {
    error = e;
  }
  check(reasonOf(error) === "denied by permission rules", `deny: the model reads "denied by permission rules" (got "${reasonOf(error)}")`);
  check(asked === 0, "deny: the UI is never asked");
  check(error && error.requestId === "", "deny: no request id, because no request was made");
  check(gate.pendingIds().length === 0, "deny: nothing is pending");
}

async function autoAllowSkipsTheAsk() {
  const live = farWorkspace();
  let asked = 0;
  const gate = permission.createGate({ evaluator, autoAllow: true, onAsk: () => { asked += 1; } });
  check(gate.autoAllow === true, "autoAllow: the mode is exposed on the gate");
  await gate.require("run_command", '{"command": "rm notes.txt"}', live, "command");
  check(asked === 0, "autoAllow: a rule's ask runs without a prompt");
  let error = null;
  try {
    await gate.require("run_command", '{"command": "cat /etc/hostname"}', live, "command");
  } catch (e) {
    error = e;
  }
  check(reasonOf(error) === "sandbox escape requires user approval", `autoAllow: an escape still refuses (got "${reasonOf(error)}")`);
  check(asked === 0, "autoAllow: and it refuses without asking either");
}

// ---- the port's own facts: the numbers and rules it shares with Python -----

function sourceParity() {
  const py = fs.readFileSync(path.join(__dirname, "..", "agent", "core", "permission.py"), "utf8");
  for (const name of ["ATTACH_POLL_S", "DETACH_GRACE_S", "REANNOUNCE_S", "TRUST_COUNTDOWN_S"]) {
    const found = py.match(new RegExp(`^${name} = ([0-9.]+)$`, "m"));
    check(
      found !== null && Number(found[1]) === permission[name],
      `${name} is agent/core/permission.py's ${found ? found[1] : "?"} (got ${permission[name]})`
    );
  }

  // The ruleset, text and order and escape flag: a reworded regex is a silently
  // different policy, so the JS table is read back out of the Python source.
  const block = py.slice(py.indexOf("DEFAULT_RULES: list[Rule] = ["), py.indexOf("\n]", py.indexOf("DEFAULT_RULES")));
  const wanted = [...block.matchAll(/Rule\("([^"]*)",\s*"([^"]*)",\s*r"((?:[^"\\]|\\.)*)"(,\s*escape=True)?\)/g)]
    .map((m) => ({ action: m[1], access: m[2], pattern: m[3], escape: Boolean(m[4]) }));
  check(wanted.length === permission.DEFAULT_RULES.length, `rules: ${wanted.length} rules on both sides (got ${permission.DEFAULT_RULES.length})`);
  for (let i = 0; i < Math.min(wanted.length, permission.DEFAULT_RULES.length); i += 1) {
    const a = wanted[i];
    const b = permission.DEFAULT_RULES[i];
    check(
      a.action === b.action && a.access === b.access && a.pattern === b.pattern && a.escape === b.escape,
      `rule ${i + 1}: ${a.action}/${a.access}/${JSON.stringify(a.pattern)}${a.escape ? " escape" : ""} (got ${b.action}/${b.access}/${JSON.stringify(b.pattern)}${b.escape ? " escape" : ""})`
    );
  }

  // GUARDED_ARG is catalog.ACCESS_ARGS: the policy words and the argument each
  // judges by default. It lives here so a vocabulary change has to be made twice.
  const catalog = fs.readFileSync(path.join(__dirname, "..", "agent", "tools", "catalog.py"), "utf8");
  const words = {};
  for (const m of catalog.matchAll(/"(\w+)": hostconfig\.AccessWord\("([^"]*)",\s*"([^"]*)"\)/g)) words[m[1]] = m[3];
  const got = permission.GUARDED_ARG;
  check(
    JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(words).sort()),
    `GUARDED_ARG: the same access words as catalog.ACCESS_ARGS (${Object.keys(got).join(", ")})`
  );
  for (const word of Object.keys(words)) {
    check(got[word] === words[word], `GUARDED_ARG[${word}]: catalog's ${words[word]} (got ${got[word]})`);
  }
}

async function main() {
  // The host's timers are unref'd by design (a pending ask must not keep the
  // host alive), so the TEST process has to hold its own loop open while it
  // awaits a gate.
  const keepAlive = setInterval(() => {}, 1000);

  console.log(`-- fixture replay (${fixture.evaluate.length} evaluate, ${fixture.auto_allow.length} auto-allow, ${fixture.split.length} split)`);
  await replayEvaluate();
  await replayAutoAllow();
  await replayUnattended();
  replaySplit();

  console.log("-- the gate's own states");
  await approvalGrantsTheEscape();
  await denialRefuses();
  await idsAreProcessUnique();
  await reannounceKeepsOffering();
  await trustModeAnswersItself();
  await detachGraceDenies();
  await aShortGapIsNotADenial();
  await denyNeverAsks();
  await autoAllowSkipsTheAsk();

  console.log("-- the words shared with agent/core/permission.py");
  sourceParity();

  clearInterval(keepAlive);
  summary("host-permission", "the engine agrees with agent/core/permission.py");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
