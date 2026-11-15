"use strict";

// The dispatch layer (`ui/host/orient.js`) against the Python it ports:
// `registry.ExtensionTool.execute` / `_run_statement`, `prompt.module_blocked_reason`
// and `registry._file_before`.
//
// What this replay pins, in the order the fixture was captured:
//
//   * EVERY CALL through a real `tools.js` tool — 21 of them, each recording the
//     trace of what the workspace, the transport and the channel saw AND the
//     envelope the model reads: a per-call statement behind its launch, the
//     declaration's host fact in the line, a non-zero exit, a timeout, a Stop, an
//     unreachable transport, an uninstalled component, a missing argument, the
//     blocked reasons (the component's, and a name no declaration answers to), a
//     service's loopback call, the client's answer and its refusal, and six
//     shapes of the undo record (replaced, created, failed run, escaping path,
//     renamed argument, and a CLIENT's write — which keeps its record);
//   * `moduleBlockedReason` — the one question this host asks where the Python
//     asks three, and why the two it drops are the same verdict (plan §1: this
//     host serves a FAR root only, so a component with a process here could never
//     have its artifact and a local root never arrives);
//   * `fileBefore` — the undo record: resolved, content read, `existed` false for
//     a missing file, null for a path that escapes the root and for one that
//     cannot be read at all, and null for an EMPTY argument without a resolve;
//   * `channelOf` — `plugin-host.refuse`/`call` wired into the two answers a
//     client statement asks for, with every rejection mapped to `ChannelError`
//     and no words of its own.
//
// The workspace/transport/channel here are stubs that RECORD what they were
// asked, exactly as `tests/statement_capture.py`'s are, so the trace is
// comparable call for call. The tool is the shipping one (`tools.extensionTool`),
// with `access: ""` so the permission guard stays out of the way: this file is
// about the ORDER of a call, not about the policy words around it.
//
// Run: node tests/host-orient.test.js

const fs = require("fs");
const path = require("path");

const { check, summary } = require("./harness");

const HOST = path.join(__dirname, "..", "ui", "host");
const PROMPTS = path.join(__dirname, "..", "agent", "prompts");
const FIXTURE = path.join(__dirname, "fixtures", "statement", "expected.json");

const { TransportError } = require(path.join(HOST, "exec.js"));
const { FileNotFoundError, OSError, ValueError } = require(path.join(HOST, "fs.js"));
const orient = require(path.join(HOST, "orient.js"));
const statement = require(path.join(HOST, "statement.js"));
const tools = require(path.join(HOST, "tools.js"));

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const ROOT = "/home/u/proj";
const LOG_PATH = `${ROOT}/demo.clc`;
const CONFIG = { port: fixture.config.port, commandTimeout: fixture.config.command_timeout };

function same(want, have) {
  return JSON.stringify(want) === JSON.stringify(have);
}

// `$name` in one of the host's own prompt files. `string.Template.safe_substitute`
// is the Python renderer's contract: `$$` is one literal dollar, `$name`/`${name}`
// substitute when known and are left VERBATIM when not.
function substitute(text, vars) {
  return text.replace(
    /\$(?:(\$)|([A-Za-z_][A-Za-z_0-9]*)|{([A-Za-z_][A-Za-z_0-9]*)})|\$/g,
    (match, escaped, named, braced) => {
      if (escaped) return "$";
      const key = named || braced;
      if (key === undefined) return match;
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
    }
  );
}

function render(name, vars = {}) {
  return substitute(fs.readFileSync(path.join(PROMPTS, name), "utf8"), vars);
}

// `json.dumps(obj, sort_keys=True, ensure_ascii=False)`, spaces and all — the
// spelling the Python capture recorded when it noted what the channel was sent.
function pyJson(value) {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${pyJson(value[key])}`)
      .join(", ")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// the capture's `canned()`: the fixture's answer, or the transport verdict it
// raised
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

// ---- the stubs ------------------------------------------------------------

// The capture's `FarWorkspace`: a far root in the only sense this layer asks for
// — a root, a protected set, and file operations that RECORD what they were
// asked. `files` maps a root-relative path to its content; anything else does not
// exist, and a path that names nothing inside the root is a `ValueError`.
function workspaceOf(entry, trace, runs) {
  const files = entry.files || {};
  return {
    root: ROOT,
    protectedSet: () => [LOG_PATH],
    async resolve(target) {
      const text = String(target);
      trace.push(`resolve ${text}`);
      if (text.startsWith("/") || text.split("/").includes("..")) {
        throw new ValueError(`path escapes workspace: ${text}`);
      }
      return text === "" || text === "." ? ROOT : `${ROOT}/${text}`;
    },
    async read(target) {
      const text = String(target);
      trace.push(`read ${text}`);
      const key = text === ROOT ? "" : text.slice(ROOT.length + 1);
      if (!Object.prototype.hasOwnProperty.call(files, key)) throw new FileNotFoundError(text);
      return files[key];
    },
    snapshot(target, content) {
      trace.push(`snapshot ${target} ${content}`);
    },
    recordMutation(target, existed, previous) {
      trace.push(`record ${target} ${existed ? 1 : 0} ${previous}`);
    },
    async run(command) {
      trace.push(`run ${command}`);
      return canned(runs.answer);
    },
  };
}

function transportOf(runs, trace) {
  return {
    async run(command) {
      trace.push(`run ${command}`);
      return canned(runs.answer);
    },
  };
}

// ---- one call, end to end -------------------------------------------------

// A blocker sentence the Python reaches and this host cannot (§ `moduleBlockedReason`):
// "a process here cannot serve another machine's root". A far-root-only host has
// no artifact for a `service`/`launch` component in the first place, so the
// artifact question answers it FIRST and with one sentence instead of two.
const PROCESS_HERE_BLOCKED =
  "clutch-probe serves the filesystem of the machine this workspace root lives on, and this root is another machine's";

// `catalog.Run`'s three JS spellings, by the fixture's `kind` word.
const RUN_TYPES = {
  resident: statement.residentRun,
  perCall: statement.perCallRun,
  clientRun: statement.clientRun,
};

async function runExecuteCase(entry) {
  const collapsed = entry.blocked === PROCESS_HERE_BLOCKED;
  const unavailable = collapsed ? "clutch-probe is not installed on this host" : entry.unavailable;
  const trace = [];
  const transportTrace = [];
  const sends = [];
  const runs = { answer: entry.answer };

  const workspace = workspaceOf(entry, trace, runs);

  // The declaration the fixture recorded, rebuilt with the SHIPPING run types:
  // `statement.js`'s own three, so the dispatch under test is the one the
  // declaration's type makes and not a branch this file could get wrong.
  const components = () => {
    if (entry.blocked.startsWith("unknown component:")) return null;
    return { name: entry.component, run: RUN_TYPES[entry.kind](), vars: entry.vars || {} };
  };

  const host = {
    resolve: () => (entry.resolved ? { ...entry.resolved } : null),
    unavailable: () => unavailable,
    service: () => ({ vars: () => ({ ...(entry.service_vars || {}) }) }),
    transport: () => transportOf(runs, transportTrace),
  };

  const client = {
    reasonFor: () => entry.channel_reason,
    async send(module, template, args) {
      sends.push(`send ${module} ${template} ${pyJson(args)}`);
      const reply = entry.reply || {};
      if (reply.channel_error) throw new statement.ChannelError(reply.channel_error);
      return { content: reply.content === undefined ? "" : reply.content, error: Boolean(reply.error) };
    },
  };

  const engine = orient.createOrient({ render, components, host, client });
  const spec = {
    name: entry.tool === undefined ? "read_file" : entry.tool,
    description: "",
    parameters: { properties: {}, required: [] },
    access: "",
    access_arg: "",
    snapshot: entry.snapshot,
    snapshot_arg: entry.snapshot_arg,
    command: entry.template,
    defaults: entry.defaults,
  };
  const tool = tools.extensionTool({ owner: entry.component }, spec, tools.createGuards(render), engine.runStatement);
  const envelope = await tool.run({ workspace, config: CONFIG, args: { ...entry.args }, cancel: null, log: null });

  const got = { content: envelope.content, error: envelope.error };
  const saw = [...trace, ...transportTrace, ...sends];
  const want = collapsed ? { content: `ERROR: ${unavailable}`, error: true } : entry.expect;
  check(same(got, want), `execute: ${entry.name}`);
  if (!same(got, want)) console.log(`  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  check(same(saw, entry.trace), `execute: ${entry.name} (what the workspace/transport/channel saw)`);
  if (!same(saw, entry.trace)) console.log(`  want ${JSON.stringify(entry.trace)}\n  got  ${JSON.stringify(saw)}`);
  return { got, saw, tool };
}

async function replayExecute() {
  for (const entry of fixture.execute) await runExecuteCase(entry);
}

// ---- the blocked reason ---------------------------------------------------

function replayModuleBlockedReason() {
  const far = {
    resolve: () => null,
    unavailable: (name) => `${name} is not installed on this host`,
  };
  const client = { reasonFor: (name) => (name === "clutch-ws" ? "" : `${name} is stopped on this client`), send: async () => ({}) };
  // The verdict reads ONE field of the declaration's type (`run.kind`), so these
  // declarations carry the word and nothing else — no statement is ever prepared
  // from them here.
  const engine = orient.createOrient({
    render,
    components: (name) =>
      name === "ghost" ? null : { name, run: { kind: name === "clutch-ws" ? "clientRun" : "perCall" } },
    host: far,
    client,
  });
  check(engine.moduleBlockedReason("ghost") === "unknown component: ghost", "module_blocked: a name no declaration answers to");
  check(engine.moduleBlockedReason("clutch-ws") === "", "module_blocked: a client component with a live channel");
  check(
    engine.moduleBlockedReason("clutch-probe") === "clutch-probe is not installed on this host",
    "module_blocked: a component with no artifact here is answered by the artifact question"
  );

  // The collapse, stated as the fixture's own case: Python's second clause needs
  // a workspace that is NOT local and a component that serves THIS machine's
  // filesystem. On a host that only serves a far root the component has no
  // artifact at all, so both clauses are the same verdict and one sentence says
  // it — never two spellings of one refusal.
  const exitEntry = fixture.execute.find((entry) => entry.blocked === PROCESS_HERE_BLOCKED);
  check(exitEntry !== undefined, "module_blocked: the fixture holds the two-clause case");
  // The fixture's own case records what the PYTHON said (that clause, with no
  // artifact question in it); on this host the same call is refused one sentence
  // earlier, and that sentence is the whole refusal.
  check(exitEntry !== undefined && exitEntry.unavailable === "", "module_blocked: the fixture's case has an artifact");
  const collapsed = orient.createOrient({
    render,
    components: () => ({ name: "clutch-probe", run: { kind: "resident" } }),
    host: far,
    client,
  });
  check(
    collapsed.moduleBlockedReason("clutch-probe") === "clutch-probe is not installed on this host",
    "module_blocked: a process-here component is refused by the artifact question alone"
  );
  // and a sentence is never invented for a component that is fine
  const fine = orient.createOrient({
    render,
    components: () => ({ name: "clutch-probe", run: { kind: "perCall" } }),
    host: { resolve: () => ({ argv: ["/bin/true"], importable: false }), unavailable: () => "" },
    client,
  });
  check(fine.moduleBlockedReason("clutch-probe") === "", "module_blocked: a drivable component has no reason to give");
}

// ---- the undo record ------------------------------------------------------

async function replayFileBefore() {
  const trace = [];
  // the engine is only the carrier; the workspace below is the stub
  const orientEngine = orient.createOrient({
    render,
    components: () => ({ name: "clutch-probe", run: { kind: "perCall" } }),
    host: { resolve: () => ({ argv: ["/bin/true"], importable: false }), unavailable: () => "" },
    client: { reasonFor: () => "", send: async () => ({}) },
  });

  const files = { "a.txt": "old contents" };
  const workspace = {
    async resolve(target) {
      const text = String(target);
      trace.push(`resolve ${text}`);
      if (text.startsWith("/") || text.split("/").includes("..")) throw new ValueError(`path escapes workspace: ${text}`);
      return text === "" ? ROOT : `${ROOT}/${text}`;
    },
    async read(target) {
      const text = String(target);
      trace.push(`read ${text}`);
      const key = text.slice(ROOT.length + 1);
      if (!Object.prototype.hasOwnProperty.call(files, key)) throw new FileNotFoundError(text);
      return files[key];
    },
  };

  let got = await orientEngine.fileBefore(workspace, { path: "a.txt" }, "path");
  check(same(got, { path: `${ROOT}/a.txt`, existed: true, previous: "old contents" }), "file_before: a file it can read");
  got = await orientEngine.fileBefore(workspace, { path: "new.txt" }, "path");
  check(same(got, { path: `${ROOT}/new.txt`, existed: false, previous: "" }), "file_before: a file that is not there is a creation");
  got = await orientEngine.fileBefore(workspace, { path: "/etc/passwd" }, "path");
  check(got === null, "file_before: a path outside the root is never remembered");
  got = await orientEngine.fileBefore(workspace, {}, "path");
  check(got === null, "file_before: an argument the call did not pass is nothing to remember");

  // An EMPTY path argument names the root itself, a directory: the Python's
  // `Path("").read_text()` raises `IsADirectoryError` and remembers nothing, and
  // this answer is given BEFORE the read — `fs.js::read` is one `cat`, so it
  // could only report the same thing as a missing file.
  const before = trace.length;
  got = await orientEngine.fileBefore(workspace, { path: "" }, "path");
  check(got === null && trace.length === before, "file_before: an empty path argument is not read at all");

  // A read that fails for another reason is not a creation: `fs.js::read` reports
  // every failure as a missing file, so the ONLY other way in is an `OSError`
  // from resolve (a symlink loop, an unreadable directory entry).
  const blind = {
    async resolve() {
      throw new OSError("directory unreadable");
    },
    async read() {
      throw new Error("the replay must not read after a failed resolve");
    },
  };
  got = await orientEngine.fileBefore(blind, { path: "a.txt" }, "path");
  check(got === null, "file_before: a path that cannot be resolved is nothing to remember");

  // the argument name falls back to "path" when the TOOL names none — the same
  // fallback `tools.declarationOf` applies, so a hand-built tool and a declared
  // one agree
  got = await orientEngine.fileBefore(workspace, { path: "a.txt" }, "");
  check(
    same(got, { path: `${ROOT}/a.txt`, existed: true, previous: "old contents" }),
    "file_before: no named argument reads `path`"
  );
}

// ---- the channel ----------------------------------------------------------

async function replayChannel() {
  let threw = null;
  try {
    orient.channelOf({});
  } catch (error) {
    threw = error;
  }
  check(threw instanceof TypeError, "channel: needs the plugin host (refuse, call)");

  const calls = [];
  const pluginHost = {
    refuse: (name) => (name === "clutch-ws" ? "" : `${name} is not installed for this client`),
    async call(request) {
      calls.push(request);
      if (request.name === "clutch-bad") throw new Error("the fork died (exit 3)");
      return { content: "file contents", error: false };
    },
  };
  const channel = orient.channelOf(pluginHost);
  check(channel.reasonFor("clutch-ws") === "", "channel: a component this client holds has no reason");
  check(
    channel.reasonFor("clutch-x") === "clutch-x is not installed for this client",
    "channel: the refusal is `plugin-host.refuse`'s own sentence"
  );
  check(channelOfNonString(pluginHost) === "", "channel: a reason that is not a sentence is no reason");

  const reply = await channel.send("clutch-ws", "read_file {*}", { path: "a.txt" }, 30, {
    root: ROOT,
    fence: [LOG_PATH],
  });
  check(same(reply, { content: "file contents", error: false }), "channel: the client's answer is the reply");
  check(
    same(calls[0], { name: "clutch-ws", command: "read_file {*}", args: { path: "a.txt" }, root: ROOT, fence: [LOG_PATH] }),
    "channel: the request carries the root and the fence the client cannot derive"
  );

  // every rejection is a `ChannelError`, with the plugin host's words and none of
  // this file's — the only side that knows why a fork died
  threw = null;
  try {
    await channel.send("clutch-bad", "read_file {*}", {}, 30, { root: ROOT, fence: [] });
  } catch (error) {
    threw = error;
  }
  check(
    threw instanceof statement.ChannelError && threw.message === "the fork died (exit 3)",
    "channel: a rejection is a ChannelError in the plugin host's words"
  );

  // `fence` must be an Array: anything else is no fence, never a string iterated
  // character by character
  await channel.send("clutch-ws", "read_file {*}", {}, 30, { root: ROOT, fence: "demo.clc" });
  check(same(calls[calls.length - 1].fence, []), "channel: a fence that is not an Array is no fence");

  // the statement's own timeout is NOT forwarded: the fork's budget is the
  // deadline (`plugin-host.js` CALL_TIMEOUT_MS), and a second number derived here
  // would be a deadline this layer does not own
  check(calls[calls.length - 1].timeout === undefined, "channel: no second deadline is invented here");
}

function channelOfNonString(pluginHost) {
  const channel = orient.channelOf({ ...pluginHost, refuse: () => undefined });
  return channel.reasonFor("clutch-ws");
}

// ---- the wiring -----------------------------------------------------------

async function replayConstruction() {
  const renderFn = render;
  const cases = [
    [{ components: () => null, host: { resolve: () => null, unavailable: () => "" }, client: { reasonFor: () => "", send: async () => ({}) } }, /render/],
    [{ render: renderFn, host: { resolve: () => null, unavailable: () => "" }, client: { reasonFor: () => "", send: async () => ({}) } }, /components/],
    [{ render: renderFn, components: () => null, client: { reasonFor: () => "", send: async () => ({}) } }, /resolve/],
    [{ render: renderFn, components: () => null, host: { resolve: () => null, unavailable: () => "" } }, /reasonFor/],
  ];
  for (const [options, pattern] of cases) {
    let threw = null;
    try {
      orient.createOrient(options);
    } catch (error) {
      threw = error;
    }
    check(threw instanceof TypeError && pattern.test(threw.message), `orient: a missing ${pattern.source} is a wiring bug`);
  }

  // The tool's own facts ride into the runner: `runStatement` reads `tool.owner`
  // (which component answers), `tool.template` (the declaration's statement),
  // `tool.defaults` (what the model may leave out) and `tool.snapshot` /
  // `tool.snapshotArg` (the undo record). Nothing else is asked of the tool.
  const seen = [];
  const tool = tools.extensionTool(
    { owner: "clutch-probe" },
    {
      name: "write_file",
      description: "",
      parameters: { properties: {}, required: [] },
      access: "",
      command: "write {path}",
      defaults: { mode: "0644" },
      snapshot: true,
      snapshot_arg: "path",
    },
    tools.createGuards(render),
    async (self, call) => {
      seen.push([self.owner, self.template, self.defaults, self.snapshot, self.snapshotArg, typeof call.workspace]);
      return tools.envelope("ok", {});
    }
  );
  await tool.run({ workspace: {}, config: CONFIG, args: { path: "a.txt" }, cancel: null, log: null });
  check(
    same(seen, [["clutch-probe", "write {path}", { mode: "0644" }, true, "path", "object"]]),
    "orient: the tool hands its owner, template, defaults and undo record to the runner"
  );

  // A statement that cannot be PREPARED (a name this host cannot resolve) is the
  // rendezvous sentence, not a crash — the caller's `prepare` is in the same
  // words as the refused call.
  let threw = null;
  try {
    orient
      .createOrient({
        render,
        components: () => null,
        host: { resolve: () => null, unavailable: () => "" },
        client: { reasonFor: () => "", send: async () => ({}) },
      })
      .prepare("ghost", {}, CONFIG);
  } catch (error) {
    threw = error;
  }
  check(
    threw instanceof statement.RendezvousError && threw.message === orient.unknownComponent("ghost"),
    "orient: a name no declaration answers to has no statement"
  );
}

async function main() {
  replayModuleBlockedReason();
  await replayFileBefore();
  await replayChannel();
  await replayConstruction();
  await replayExecute();
  check(
    fixture.execute.length === 21,
    `the fixture holds 21 whole calls (${fixture.execute.length})`
  );
  check(
    fixture.execute.filter((entry) => entry.snapshot).length === 6,
    "six of the calls keep an undo record"
  );
  summary("host-orient", "the dispatch layer agrees with registry.ExtensionTool.execute");
}

main();
