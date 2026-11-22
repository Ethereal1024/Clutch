"use strict";

// The statement layer (`ui/host/statement.js`) against the Python it ports:
// `agent/tools/statement.py` (+ `rendezvous.fence_globs`, `launch_prefix`,
// `host_vars`).
//
// A call has one form — render(template, the model's arguments ∪ the host's
// facts) → a runner → an envelope — and this replay pins each piece of it in the
// order the fixture was captured:
//
//   * `host_vars` — the facts a declaration may name (`{base}` ← `host.port_url`),
//     keyed by the name the DECLARATION chose, with a fact the host has no value
//     for LEFT OUT rather than rendered as an empty word;
//   * `launch_prefix` — the artifact's shape as a line prefix: "" for a service,
//     interpreter + entry point for a checkout, `-m` with its directory on
//     PYTHONPATH for a package, a bare executable for an installed onefile, the
//     rendezvous sentence when there is no artifact at all;
//   * `fence_globs` — the protected paths in the three spellings a client's glob
//     is matched against, sorted, with ""/"."/"/" dropped;
//   * `line` — one statement rendered: the prefix in front, the host's values over
//     the model's, `defaults` underneath, and a missing value as a sentence;
//   * `run` — one statement carried: the runner sees the rendered line, an
//     envelope passes through, a non-zero exit is framed, and a transport verdict
//     (timeout / Stop / unreachable) is RAISED for the caller to word;
//   * `resident` / `per_call` / `client` — what `statement.prepare` dispatches on:
//     which facts each shape reads (`rendezvous.service` for a service, the
//     artifact for a one-process component, the live channel for a client's), and
//     that a client with no channel has NO statement — refused in the channel's
//     own words. A client statement is the component's name and nothing else: the
//     root and the fence that this JS builder hands the client WITH the call are
//     deployment B's own protocol (the client's plugin cannot derive them on its
//     side of the wire), so they are checked against the case's INPUTS and not
//     against the golden, which the Python no longer carries;
//   * `client_run` — the template sent VERBATIM (never rendered, `defaults`
//     ignored) with the model's arguments, and `ChannelError` → `ERROR: …`.
//
// The artifact lookup, the service table and the channel are the `host` bundle
// this module takes as an argument, so the replay supplies them directly — no
// filesystem, no process, no socket. `tests/statement_capture.py` wrote the
// fixture and `--check` reproduces it.
//
// Run: node tests/host-statement.test.js

const fs = require("fs");
const path = require("path");

const { check, summary } = require("./harness");

const HOST = path.join(__dirname, "..", "ui", "host");
const FIXTURE = path.join(__dirname, "fixtures", "statement", "expected.json");

const statement = require(path.join(HOST, "statement.js"));
const { TransportError } = require(path.join(HOST, "exec.js"));
const { InstError } = require(path.join(HOST, "inst.js"));

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const CONFIG = { port: fixture.config.port, commandTimeout: fixture.config.command_timeout };

// Structural equality for the JSON-shaped values the fixture holds (keys in the
// order the capture wrote them, numbers as numbers).
function same(want, have) {
  return JSON.stringify(want) === JSON.stringify(have);
}

// What a stubbed runner answers: the fixture's canned result, or the transport
// verdict it raised (the Python capture's `canned()`).
function canned(answer) {
  if (!answer) throw new Error("the replay has no canned answer for that call");
  if (answer.error) {
    throw new TransportError(answer.error.message, {
      timeout: Boolean(answer.error.timeout),
      aborted: Boolean(answer.error.aborted),
    });
  }
  return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr };
}

function runnerOf(answer, trace) {
  return {
    async run(command) {
      trace.push(`run ${command}`);
      return canned(answer);
    },
  };
}

function componentOf(entry) {
  // The fixture names the DECLARATION's shape (`service`: it publishes a process
  // that stays, or it does not); this host's `run.kind` is deployment B's own word
  // for the same thing, so the translation is written here rather than in the
  // golden.
  return { name: "clutch-probe", run: { kind: entry.service ? "resident" : "perCall" } };
}

// ---- host facts -----------------------------------------------------------

function replayHostVars() {
  for (const entry of fixture.host_vars) {
    const got = statement.hostVars({ name: "clutch-probe", vars: entry.vars }, CONFIG);
    check(same(got, entry.expect), `host_vars: ${entry.name}`);
  }
  // A fact with no value is not a fact: this host has a port only when the
  // session supplied one (`agent/config.py` always has one, so the Python's
  // `config.port` branch has no counterpart here). `http://127.0.0.1:undefined`
  // would be a URL a component dials; an omitted key drops the optional group
  // that names it instead.
  const noPort = statement.hostVars({ name: "clutch-probe", vars: { base: "host.port_url" } }, {});
  check(same(noPort, {}), "host_vars: no port on this host is no fact at all");
}

// ---- the launch -----------------------------------------------------------

function replayLaunchPrefix() {
  for (const entry of fixture.launch_prefix) {
    const host = {
      resolve: () => (entry.resolved ? { ...entry.resolved } : null),
      unavailable: () => entry.unavailable,
    };
    let got;
    try {
      got = statement.launchPrefix(componentOf(entry), host);
    } catch (error) {
      check(error instanceof statement.RendezvousError, `launch_prefix: ${entry.name} raises the rendezvous sentence`);
      got = error.message;
    }
    const want = Object.prototype.hasOwnProperty.call(entry.expect, "error")
      ? entry.expect.error
      : entry.expect.prefix;
    check(got === want, `launch_prefix: ${entry.name}`);
    if (got !== want) console.log(`  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
  // A service's prefix is "" WITHOUT asking for an artifact: its launch starts a
  // process that stays, and the statement is the loopback call it answers.
  statement.launchPrefix({ name: "clutch-probe", run: { kind: "resident" } }, {
    resolve: () => {
      throw new Error("a service must not look its artifact up");
    },
    unavailable: () => "",
  });
  check(true, "launch_prefix: a service asks for no artifact");
}

// ---- the fence ------------------------------------------------------------

function replayFenceGlobs() {
  for (const entry of fixture.fence_globs) {
    check(same(statement.fenceGlobs(entry.protected, entry.root), entry.expect), `fence_globs: ${entry.name}`);
  }
}

// ---- the line -------------------------------------------------------------

function replayLine() {
  for (const entry of fixture.line) {
    const ready = statement.hostStatement({
      vars: entry.vars,
      runner: { async run() { return { code: 0, stdout: "", stderr: "" }; } },
      prefix: entry.prefix,
      module: entry.module,
    });
    let got;
    try {
      got = { line: ready.line(entry.template, entry.args, entry.defaults) };
    } catch (error) {
      if (!(error instanceof InstError)) throw error;
      got = { error: error.message };
    }
    check(same(got, entry.expect), `line: ${entry.name}`);
    if (!same(got, entry.expect)) console.log(`  want ${JSON.stringify(entry.expect)}\n  got  ${JSON.stringify(got)}`);
  }
}

// ---- the run --------------------------------------------------------------

async function replayRun() {
  for (const entry of fixture.run) {
    const trace = [];
    const ready = statement.hostStatement({
      vars: {},
      runner: runnerOf(entry.answer, trace),
      prefix: entry.prefix,
      module: entry.module,
    });
    let got;
    try {
      const env = await ready.run(entry.template, entry.args, {}, { timeout: entry.timeout });
      got = { content: env.content, error: env.error };
    } catch (error) {
      got = { raises: `${error.name}: ${error.message}` };
    }
    check(same(got, entry.expect), `run: ${entry.name}`);
    if (!same(got, entry.expect)) console.log(`  want ${JSON.stringify(entry.expect)}\n  got  ${JSON.stringify(got)}`);
    check(same(trace, entry.trace), `run: ${entry.name} (what the runner saw)`);
  }
  // The timeout is not optional: a statement carried with no budget would mean
  // the transport's own number silently decides how long a tool call may take.
  let threw = null;
  try {
    await statement
      .hostStatement({ vars: {}, runner: runnerOf({ code: 0, stdout: "", stderr: "" }, []), module: "clutch-probe" })
      .run("read {path}", { path: "a.txt" }, {}, {});
  } catch (error) {
    threw = error;
  }
  check(threw instanceof TypeError && /timeout/.test(threw.message), "run: a statement with no timeout is a wiring bug");
}

// ---- the three builders ---------------------------------------------------

function replayResident() {
  const entry = fixture.resident;
  const calls = [];
  const workspace = {
    root: "/home/u/proj",
    protectedSet: () => ["/home/u/proj/demo.clc"],
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const host = {
    service(root, name, protect) {
      calls.push([root, name, protect]);
      return { vars: () => ({ ...entry.vars }) };
    },
  };
  const ready = statement.resident({ name: "clutch-probe", run: { kind: "resident" } }, workspace, host);
  check(same(calls, entry.service_call), "resident: the service is asked for THIS root, with the fence");
  check(same(ready.vars, entry.vars), "resident: the statement names the service's own published values");
  check(ready.prefix === entry.prefix, "resident: a service contributes no prefix");
  check(ready.module === entry.module, "resident: a failure names the component");
  check(ready.runner === workspace, "resident: the workspace's own transport carries the loopback call");
  check(ready.local === true, "resident: a statement this host runs owns its undo record");
  check(ready.line(entry.template, entry.args, {}) === entry.line, "resident: prefix + rendered template");
}

function replayPerCall() {
  const entry = fixture.per_call;
  const transport = {
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const host = {
    resolve: () => ({ argv: ["python3", "-m", "clutch_probe"], directory: "/opt/clutch/components/probe", importable: true }),
    unavailable: () => "",
    transport: () => transport,
  };
  const ready = statement.perCall(
    { name: "clutch-probe", run: { kind: "perCall" }, vars: { base: "host.port_url" } },
    CONFIG,
    host
  );
  check(same(ready.vars, entry.vars), "per_call: the declaration's host fact, resolved for this host");
  check(ready.prefix === entry.prefix, "per_call: the artifact's own launch is the prefix");
  check(ready.module === entry.module, "per_call: a failure names the component");
  check(ready.runner === transport, "per_call: the app host's transport carries the line");
  check(ready.local === true, "per_call: a statement this host runs owns its undo record");
  check(ready.line(entry.template, entry.args, {}) === entry.line, "per_call: prefix + rendered template");
}

function replayClient() {
  for (const entry of fixture.client) {
    const workspace = { root: entry.root, protectedSet: () => entry.protected.slice() };
    const host = {
      reasonFor: () => entry.reason,
      send: async () => ({ content: "", error: false }),
    };
    let got;
    try {
      const ready = statement.client({ name: "clutch-probe", run: { kind: "clientRun" } }, workspace, host);
      got = { module: ready.module, local: ready.local };
      // The two facts the client's plugin cannot work out on its own side of the
      // wire, and the reason this builder still reads a workspace: the root the
      // call is about and the globs of what the host protects under it. They are
      // the case's own inputs — the Python's client statement carries neither, so
      // the golden pins none.
      check(ready.root === entry.root, `client: ${entry.name} names the root the call is about`);
      check(
        same(ready.fence, statement.fenceGlobs(entry.protected, entry.root)),
        `client: ${entry.name} carries the fence of what that workspace protects`
      );
    } catch (error) {
      check(error instanceof statement.RendezvousError, `client: ${entry.name} refuses with RendezvousError`);
      got = { error: error.message };
    }
    check(same(got, entry.expect), `client: ${entry.name}`);
    if (!same(got, entry.expect)) console.log(`  want ${JSON.stringify(entry.expect)}\n  got  ${JSON.stringify(got)}`);
  }
}

// ---- the client's own statement -------------------------------------------

async function replayClientRun() {
  for (const entry of fixture.client_run) {
    const calls = [];
    const send = async (module, template, args, timeout) => {
      calls.push([module, template, args, timeout]);
      if (entry.reply.channel_error) throw new statement.ChannelError(entry.reply.channel_error);
      return { content: entry.reply.content, error: entry.reply.error };
    };
    const ready = statement.clientStatement({ module: entry.module, send });
    check(ready.local === entry.local, `client_run: ${entry.name} (where the statement runs)`);
    const env = await ready.run(entry.template, entry.args, entry.defaults, { timeout: entry.timeout });
    check(same({ content: env.content, error: env.error }, entry.expect), `client_run: ${entry.name}`);
    check(same(calls, entry.calls), `client_run: ${entry.name} (what the channel saw)`);
  }
  // `defaults` are the HOST's rendering and this statement is the client's, so
  // they are accepted and ignored — the template goes as it was declared — and the
  // two facts the client cannot derive travel WITH it: the root and the fence.
  const sent = [];
  const ready = statement.clientStatement({
    module: "clutch-probe",
    root: "/home/u/proj",
    fence: ["/home/u/proj/demo.clc"],
    send: async (_module, template, args, _timeout, options) => {
      sent.push([template, args, options.root, options.fence]);
      return { content: "ok", error: false };
    },
  });
  await ready.run("read_file {*}", { path: "a.txt" }, { max_bytes: 100 }, { timeout: 30 });
  check(
    same(sent, [["read_file {*}", { path: "a.txt" }, "/home/u/proj", ["/home/u/proj/demo.clc"]]]),
    "client_run: the template is sent verbatim, defaults ignored, root/fence carried with it"
  );
}

// ---- the wiring refusals --------------------------------------------------

function replayRefusals() {
  let threw = null;
  try {
    statement.prepare({ name: "clutch-probe" }, {}, CONFIG, {});
  } catch (error) {
    threw = error;
  }
  check(
    threw instanceof TypeError && /declares no run/.test(threw.message),
    "prepare: a component without a run is a wiring bug, never a tool that answers late"
  );

  threw = null;
  try {
    statement.hostStatement({ module: "clutch-probe" });
  } catch (error) {
    threw = error;
  }
  check(threw instanceof TypeError && /runner/.test(threw.message), "hostStatement: no runner, no statement");

  threw = null;
  try {
    statement.clientStatement({ module: "clutch-probe" });
  } catch (error) {
    threw = error;
  }
  check(threw instanceof TypeError && /channel/.test(threw.message), "clientStatement: no channel, no statement");

  threw = null;
  try {
    statement.resident({ name: "clutch-probe" }, { root: "/" }, {});
  } catch (error) {
    threw = error;
  }
  check(threw instanceof TypeError && /service/.test(threw.message), "resident: needs host.service(root, name, protect)");

  threw = null;
  try {
    statement.perCall({ name: "clutch-probe" }, CONFIG, {});
  } catch (error) {
    threw = error;
  }
  check(threw instanceof TypeError && /transport/.test(threw.message), "perCall: needs host.transport()");

  threw = null;
  try {
    statement.client({ name: "clutch-probe" }, { root: "/" }, {});
  } catch (error) {
    threw = error;
  }
  check(threw instanceof TypeError && /reasonFor/.test(threw.message), "client: needs host.reasonFor / host.send");

  // The three builders and the three Run types answer the SAME question: which
  // statement a component needs is its `run`, and `prepare` is the one place
  // that dispatch happens.
  const seen = [];
  const host = {
    resolve: () => ({ argv: ["/bin/true"], directory: "/bin", importable: false }),
    unavailable: () => "",
    transport: () => ({
      async run() {
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    service: () => ({ vars: () => ({}) }),
    reasonFor: () => "",
    send: async () => ({ content: "", error: false }),
  };
  for (const run of [statement.residentRun(), statement.perCallRun(), statement.clientRun()]) {
    const workspace = {
      root: "/w",
      protectedSet: () => [],
      async run() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const ready = statement.prepare({ name: "clutch-probe", run }, workspace, CONFIG, host);
    seen.push([run.kind, ready.module]);
  }
  check(
    same(seen, [
      ["resident", "clutch-probe"],
      ["perCall", "clutch-probe"],
      ["clientRun", "clutch-probe"],
    ]),
    "prepare: the declaration's run type is the whole dispatch"
  );
}

async function main() {
  replayHostVars();
  replayLaunchPrefix();
  replayFenceGlobs();
  replayLine();
  await replayRun();
  replayResident();
  replayPerCall();
  replayClient();
  await replayClientRun();
  replayRefusals();
  check(fixture.host_vars.length === 5 && fixture.fence_globs.length === 7, "the fixture holds every captured group");
  summary("host-statement", "the statement layer agrees with agent/tools/statement.py");
}

main();
