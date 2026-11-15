"use strict";

// The host's tool face (`ui/host/tools.js`) against the Python it ports:
// `agent/tools/{envelope,host,registry,gates,filesystem,shell,recall,transport}.py`.
//
// What this replay pins, in the order the fixture was captured:
//
//   * the DECLARATIONS — the three tools the host declares for itself, their
//     prose (rendered from the real `agent/prompts/tools/*.md`) and the words
//     (`access`, `gate`, `ui`) a component manifest also speaks;
//   * the REGISTRY the run loop calls — names, OpenAI schemas, policy words,
//     the derived `mutates`/`undo`, and every wired fact of a `Tool` (including
//     the two names no tool declares: defaults, and NO invented `mutates`);
//   * the SHELL half byte for byte: the chat-mode classifier's 42 verdicts with
//     their details, `_tokenize`'s 29 answers, and the 24 blocked-command
//     sentences;
//   * EVERY CALL through `ToolRegistry.execute` — 46 of them, each recording
//     the command that actually reached the workspace (`ran`) and the envelope
//     the model reads. Success, empty output, both truncations, non-zero exit,
//     timeout, Stop, an unreachable bridge, an exec that raised, the blocked
//     list, the parse/escape/protected refusals, and chat's default deny;
//   * COERCION: Python's `int()` spellings (`"3"`, `" 4 "`, `2.9`, `True`,
//     `1.0`) and its refusals (`"3.0"`, `"0x10"`, `""`, `None`, `[]`);
//   * the GUARDS (`filesystem.py`) and the GATES (`gates.py`), including the
//     unknown gate word that must stay shut;
//   * the two LOG READERS over the same bytes the capture used — 16 greps and
//     12 pages through the real registry (so the project gate, the coercion and
//     the log handed in are all exercised), plus the no-log session.
//
// The workspace is the real M1 code (`ui/host/fs.js`): a far root that does not
// exist on this machine, resolved LEXICALLY, with one stub shell that strips the
// `cd '<root>' && ` prefix `fs.js` states and answers from the fixture's canned
// `run_results`. A transport verdict is raised as the same `TransportError` the
// real exec raises; an exec that failed for another reason raises a plain Error,
// exactly as the Python capture's `FarWorkspace` did. The log is a real
// `LazyEventLog` over the fixture's own bytes, so the readers' chunking, line
// numbering and skip rules are the shipping ones.
//
// `TZ` is pinned to UTC on both sides: `recall._record` stamps a line with
// `time.localtime`, so the fixture's timestamps only reproduce under one zone.
//
// One sentence is deliberately shorter here: `grep_memory`'s invalid-regex
// DETAIL is the JavaScript engine's (documented at the top of tools.js), so that
// one case is compared by the sentence AROUND it and not by its tail.
//
// Run: node tests/host-tools.test.js

process.env.TZ = "UTC";

const fs = require("fs");
const path = require("path");

const { check, summary } = require("./harness");

const HOST = path.join(__dirname, "..", "ui", "host");
const PROMPTS = path.join(__dirname, "..", "agent", "prompts");

const clc = require(path.join(HOST, "clc.js"));
const hostFs = require(path.join(HOST, "fs.js"));
const { TransportError } = require(path.join(HOST, "exec.js"));
const tools = require(path.join(HOST, "tools.js"));

const FIXTURE = path.join(__dirname, "fixtures", "tools", "expected.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const ROOT = fixture.workspace.root;
const HOME = fixture.workspace.home;
const LOG_PATH = fixture.recall.path;

// ---- the prompt renderer (agent/prompts/__init__.py) ---------------------
//
// `string.Template.safe_substitute`, the Python renderer's contract: `$$` is one
// literal dollar, `$name`/`${name}` substitute when known and are left VERBATIM
// when not. A wrong variable survives into the prose where the replay sees it.
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

// ---- the fixture's config, in the session's own spelling -----------------

function configOf(captured) {
  return {
    mode: captured.mode,
    commandTimeout: captured.command_timeout,
    outputLimit: captured.output_limit,
    outputHead: captured.output_head,
    outputTail: captured.output_tail,
    blockedPrefixes: captured.blocked_prefixes,
  };
}

const WORK = configOf(fixture.config);
const CHAT = configOf(fixture.chat_config);

// ---- the far workspace ----------------------------------------------------
//
// `fs.js` states the cwd itself (`cd '<root>' && ...`); the capture recorded the
// command WITHOUT it, because the Python `FarWorkspace` overrode `run()`. Strip
// the prefix, record what is left, and answer from the canned map — so `ran` is
// comparable token for token.
const PREFIX = `cd '${ROOT}' && `;

function shellFor(ran) {
  return {
    async run(command) {
      const text = String(command);
      const plain = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
      ran.push(plain);
      const canned = fixture.run_results[plain];
      if (!canned) throw new Error(`the replay has no canned result for ${JSON.stringify(plain)}`);
      if (canned.error) {
        if (canned.error.type === "transport") {
          throw new TransportError(canned.error.message, {
            timeout: Boolean(canned.error.timeout),
            aborted: Boolean(canned.error.aborted),
          });
        }
        throw new Error(canned.error.message);
      }
      return { code: canned.code, stdout: canned.stdout, stderr: canned.stderr, bytes: null };
    },
  };
}

function makeWorkspace() {
  const ran = [];
  const workspace = hostFs.createWorkspace({ root: ROOT, exec: shellFor(ran) });
  workspace.protect(LOG_PATH);
  return { workspace, ran };
}

// ---- the log --------------------------------------------------------------
//
// The capture's bytes, read through the shipping reader: `base` is the end of
// the header, `total` the whole file, and `read` is the far side's byte range.
const HEADER = Buffer.from(fixture.recall.header_b64, "base64");
const REGION = Buffer.from(fixture.recall.region_b64, "base64");
const WHOLE = Buffer.concat([HEADER, REGION]);

function makeLog() {
  return new clc.LazyEventLog({
    path: LOG_PATH,
    base: HEADER.length,
    total: WHOLE.length,
    read: async (lo, hi) => WHOLE.subarray(Math.max(0, lo), Math.min(WHOLE.length, hi)),
  });
}

// ---- comparing ------------------------------------------------------------
//
// Object key ORDER is not a fact either side promises (a Python dict and a JS
// object both preserve insertion order, but the two languages build these
// structures in different places), so compare structurally and report the first
// real difference with its path.
function clip(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function firstDiff(actual, expected, at = "$") {
  if (actual === expected) return null;
  if (typeof actual !== typeof expected) {
    return `${at}: ${typeof actual} vs ${typeof expected} (${clip(actual)} vs ${clip(expected)})`;
  }
  if (actual === null || expected === null || typeof actual !== "object") {
    return `${at}: ${clip(actual)} vs ${clip(expected)}`;
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) return `${at}: array vs object`;
  if (Array.isArray(actual)) {
    if (actual.length !== expected.length) {
      return `${at}: ${actual.length} items vs ${expected.length}`;
    }
    for (let i = 0; i < actual.length; i += 1) {
      const found = firstDiff(actual[i], expected[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  const keys = Object.keys(actual);
  const want = Object.keys(expected);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(expected, key)) return `${at}.${key}: extra key`;
  }
  for (const key of want) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return `${at}.${key}: missing key`;
    const found = firstDiff(actual[key], expected[key], `${at}.${key}`);
    if (found) return found;
  }
  return null;
}

function checkSame(actual, expected, what) {
  const found = firstDiff(actual, expected);
  check(found === null, found === null ? what : `${what} — ${found}`);
}

// ---- the declarations -----------------------------------------------------

console.log("-- the host's own declarations (tools/host.py)");

for (const [mode, cfg] of [["work", WORK], ["chat", CHAT]]) {
  const declared = tools.hostDeclarations(cfg, render).map((entry) => ({
    name: entry.name,
    declaration: entry.declaration,
    needs_log: entry.needsLog,
  }));
  checkSame(declared, fixture.declarations[mode], `declarations.${mode}`);
}

// ---- the registry seam ----------------------------------------------------

console.log("-- the registry (registry.py)");

function registryOf(cfg, log) {
  const wired = tools.buildTools({ config: cfg, log, render, entries: () => ["one"] });
  return tools.createRegistry({ tools: wired, log, render });
}

// Python's `Tool` reports a callable's `__name__`; the port's spelling is the
// language's, so map one to the other rather than pretending they match.
function snake(name) {
  return String(name).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// What a tool is, in one shape for both kinds: the kind decides who carries the
// call out, so it is reported once, and the fields a kind does not own are null
// rather than absent (Python's `_tool_facts` does the same).
function toolFacts(tool) {
  const system = tool.kind === "system";
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    access: tool.access,
    access_arg: tool.accessArg,
    cancelable: tool.cancelable,
    snapshot: tool.snapshot,
    snapshot_arg: tool.snapshotArg,
    guard: tool.guard ? snake(tool.guard.name) : null,
    kind: tool.kind,
    needs_log: system ? tool.needsLog : null,
    owner: system ? null : tool.owner,
    template: system ? null : tool.template,
    defaults: system ? null : tool.defaults,
    ui: tool.ui,
  };
}

function registryFacts(cfg, log) {
  const registry = registryOf(cfg, log);
  const names = registry.names();
  const per = (ask) => Object.fromEntries(names.map((name) => [name, ask(name)]));
  return {
    names,
    schemas: registry.schemas(),
    access: per((name) => registry.access(name)),
    access_arg: per((name) => registry.accessArg(name)),
    path_arg: per((name) => registry.pathArg(name)),
    ui: per((name) => registry.ui(name)),
    tools: per((name) => toolFacts(registry.tool(name))),
    // a name no tool declares: the defaults, and no invented `mutates`
    unknown: {
      access: registry.access("not_a_tool"),
      access_arg: registry.accessArg("not_a_tool"),
      path_arg: registry.pathArg("not_a_tool"),
      ui: registry.ui("not_a_tool"),
      tool: registry.tool("not_a_tool"),
    },
  };
}

checkSame(registryFacts(WORK, null), fixture.registry.work_no_log, "registry.work_no_log");
checkSame(registryFacts(WORK, makeLog()), fixture.registry.work, "registry.work");
checkSame(registryFacts(CHAT, makeLog()), fixture.registry.chat, "registry.chat");

// ---- the shell classifier and tokenizer -----------------------------------

console.log("-- the shell (shell.py: classify / tokenize / blocked)");

const verdicts = fixture.classify.map((entry) => {
  const [verdict, detail] = tools.classifyCommand(entry.command);
  return { command: entry.command, verdict, detail };
});
checkSame(verdicts, fixture.classify, "classify: 42 verdicts and their details");

const tokenized = fixture.tokenize.map((entry) => ({
  command: entry.command,
  tokens: tools.tokenize(entry.command),
}));
checkSame(tokenized, fixture.tokenize, "tokenize: 29 shlex answers");

const blocked = fixture.blocked.map((entry) => {
  const reason = tools.blockedReason(WORK, entry.command);
  return { command: entry.command, reason: reason === null ? null : render(reason.template, reason.vars) };
});
checkSame(blocked, fixture.blocked, "blocked: 24 commands and their sentences");

// ---- every call through the seam the loop uses ----------------------------

console.log(`-- execute (${fixture.execute.length} calls)`);

async function replayExecute() {
  const actual = [];
  for (const entry of fixture.execute) {
    const cfg = entry.mode === "work" ? WORK : CHAT;
    const { workspace, ran } = makeWorkspace();
    const registry = registryOf(cfg, null);
    const result = await registry.execute(workspace, cfg, entry.tool, { ...entry.args }, null);
    actual.push({
      name: entry.name,
      mode: entry.mode,
      tool: entry.tool,
      args: entry.args,
      ran,
      result,
    });
  }
  checkSame(actual, fixture.execute, "execute: every call, its command and its envelope");
}

// ---- coercion -------------------------------------------------------------

console.log("-- coercion (registry._coerce_types)");

function coerceCases() {
  const runRegistry = registryOf(WORK, null);
  const runTool = runRegistry.tool("run_command");
  const out = [];
  for (const args of [{ command: "ls" }, { command: 5 }, { command: null }, { command: ["ls"] }]) {
    try {
      out.push({ args, out: runRegistry.coerceTypes(runTool, { ...args }) });
    } catch (error) {
      out.push({ args, error: error.constructor.name });
    }
  }
  const memory = registryOf(WORK, makeLog()).tool("read_memory");
  const memoryRegistry = registryOf(WORK, makeLog());
  for (const value of [2, 2.9, true, false, "3", " 4 ", "3.0", "0x10", "", null, [], 1.0, -1]) {
    const args = { limit: value, offset: value };
    try {
      out.push({ tool: "read_memory", args, out: memoryRegistry.coerceTypes(memory, { ...args }) });
    } catch (error) {
      out.push({ tool: "read_memory", args, error: error.constructor.name });
    }
  }
  return out;
}

checkSame(coerceCases(), fixture.coerce, "coerce: int() spellings and its refusals");

// ---- the guards and the gates ---------------------------------------------

console.log("-- the guards (filesystem.py) and the gates (gates.py)");

async function guardCases() {
  const guards = tools.createGuards(render);
  const byWord = { read: guards.guard_read, write: guards.guard_write, sweep: guards.guard_grep };
  const { workspace } = makeWorkspace();
  const out = [];
  for (const entry of fixture.guards) {
    const result = await byWord[entry.access](workspace, WORK, { ...entry.args }, entry.arg);
    out.push({
      access: entry.access,
      arg: entry.arg,
      args: entry.args,
      result: result === null ? null : result,
    });
  }
  return out;
}

function gateCases() {
  const entries = () => ["one"];
  const log = { path: LOG_PATH };
  const out = [];
  for (const word of ["", "always", "project", "skills", "nonsense"]) {
    out.push({ gate: word, log: null, ok: tools.gateOk(word, WORK, null, entries) });
  }
  for (const word of ["", "always", "project", "nonsense"]) {
    out.push({ gate: word, log: "path", ok: tools.gateOk(word, WORK, log, entries) });
  }
  return out;
}

// ---- the two log readers --------------------------------------------------

console.log("-- recall (recall.py: grep_memory / read_memory)");

// The one case whose DETAIL is the engine's: compare the sentence around it.
const ENGINE_DETAIL = "is not a valid regular expression: ";
function compareGrep(actual, expected, what) {
  if (!expected.args.pattern.includes("(") || !expected.result.error) {
    checkSame(actual, expected, what);
    return;
  }
  const head = actual.result.content.slice(0, actual.result.content.indexOf(ENGINE_DETAIL) + ENGINE_DETAIL.length);
  const want = expected.result.content.slice(0, expected.result.content.indexOf(ENGINE_DETAIL) + ENGINE_DETAIL.length);
  check(
    head === want &&
      actual.result.error === expected.result.error &&
      actual.result.content.length > head.length &&
      Object.keys(actual.result).length === 3,
    `${what} (the engine's own detail; the sentence around it is unchanged)`
  );
}

async function replayRecall() {
  const registry = registryOf(WORK, makeLog());
  const { workspace } = makeWorkspace();

  const grep = [];
  for (const entry of fixture.recall.grep) {
    const result = await registry.execute(workspace, WORK, "grep_memory", { ...entry.args }, null);
    grep.push({ name: entry.name, args: entry.args, result });
  }
  for (let i = 0; i < grep.length; i += 1) {
    compareGrep(grep[i], fixture.recall.grep[i], `grep_memory "${grep[i].name}"`);
  }

  const read = [];
  for (const entry of fixture.recall.read) {
    const result = await registry.execute(workspace, WORK, "read_memory", { ...entry.args }, null);
    read.push({ name: entry.name, args: entry.args, result });
  }
  checkSame(read, fixture.recall.read, `read_memory: ${read.length} pages`);

  const noLogRegistry = registryOf(WORK, null);
  const noLog = {
    names: noLogRegistry.names(),
    grep: await noLogRegistry.execute(workspace, WORK, "grep_memory", { pattern: "x" }, null),
    read: await noLogRegistry.execute(workspace, WORK, "read_memory", {}, null),
  };
  checkSame(noLog, fixture.recall.no_log, "no log open: the readers are not offered, and say so if called");
}

// ---- the fixture's own shape ----------------------------------------------

function fixtureShape() {
  check(
    new Date(0).getTimezoneOffset() === 0,
    "TZ is UTC on this side too (recall stamps with localtime)"
  );
  const { workspace } = makeWorkspace();
  check(workspace.root === ROOT, `the far root is ${ROOT}`);
  check(workspace.isProtected(`${ROOT}/demo.clc`), "the project log is protected");
  check(clc.DURABLE_TYPES.size > 0, "the real DURABLE_TYPES is the reader's filter");
  check(
    fixture.recall.lines === REGION.toString("utf8").split("\n").filter((line) => line).length,
    `the fixture's event region has ${fixture.recall.lines} non-empty lines`
  );
  check(HOME.length > 0, "the capture recorded a home");
}

async function main() {
  fixtureShape();
  await replayExecute();
  const guards = await guardCases();
  checkSame(guards, fixture.guards, "guards: 24 protected-path verdicts");
  checkSame(gateCases(), fixture.gates, "gates: 9 answers, unknown word shut");
  await replayRecall();

  summary("host-tools", "the tool face agrees with agent/tools/*.py");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
