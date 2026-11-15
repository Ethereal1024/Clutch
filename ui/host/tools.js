// The host's own tool face on the far-root host: the envelope every result takes,
// the three tools the HOST declares for itself, and the registry the run loop calls.
//
// Ported from:
//
//   * `agent/tools/envelope.py`   — `Envelope(content, error, diff)`;
//   * `agent/tools/host.py`       — the three declarations (`run_command`,
//     `grep_memory`, `read_memory`) as DATA, in the same shape a component's
//     manifest speaks, and the prose file each one's description comes from;
//   * `agent/tools/registry.py`   — `Call`, `Tool`, `SystemTool`, `ExtensionTool`,
//     `_bootstrap`, `ToolRegistry.{schemas,names,access,access_arg,path_arg,ui,
//     tool,execute,_coerce_types}` (the COMPONENT half of a call is
//     `runStatement`: statement.js or the client channel, attached to an
//     `extensionTool` when it is built);
//   * `agent/tools/gates.py`      — the access vocabulary (`Access`, `ACCESS`,
//     `WATCHED_ACCESS`) and the gate words (`_gate_ok`);
//   * `agent/tools/catalog.py`    — the vocabulary this module must not restate:
//     `DEFAULT_UI`/`UI_KEYS`, `ACCESS_ARGS`, `GATE_WORDS`, `HOST_TOOL_NAMES`;
//   * `agent/tools/filesystem.py` — `guard_read`/`guard_write`/`guard_grep`
//     (the protected-path refusal);
//   * `agent/tools/shell.py`      — the chat-mode read-only classifier, the
//     blocked-command list, the path-escape/protected-token scan, truncation and
//     the `run_command` envelope;
//   * `agent/tools/recall.py`     — `grep_memory` / `read_memory` over the
//     session's own log, streaming it in chunks;
//   * `agent/tools/transport.py:56` — `failure_envelope` (the one rendering of a
//     transport verdict), shared with the statement layer (`statement.js`);
//   * `agent/tools/localshell.py` — `split_command` in its POSIX form; the JS host
//     is always POSIX, so `permission.js`'s verified `splitCommand` IS that
//     function (one parser, not two).
//
// What is INJECTED rather than ported, and why:
//
//   * `render(name, vars)` — the prompt templates in `agent/prompts/*.md`. Where
//     those files live on a host without Python is not this file's question.
//   * `runStatement(tool, {workspace, config, args, cancel})` — a component's
//     statement (statement.js + the client channel). It is what an
//     `extensionTool` carries as its `run`; without one, building such a tool is
//     a TypeError rather than a tool that answers "no implementation".
//   * `entries(kind, config)` — the host's answer to the `$skills` fact
//     (`answers.py::_entries`). The skill library lives on the root's machine, so
//     the scan belongs to the caller that can reach it (`orient.js`); the gate
//     fails CLOSED when no answer is supplied.
//
// Deliberate divergences (all documented at their call site, none silent):
//
//   1. `python3 x.py` is NOT syntax-checked before it runs (`shell.py:286`
//      compiles the file in-process — `compile()` does not exist here). The
//      poka-yoke is lost on deployment B rather than faked by a second round trip
//      whose answer would come from a different interpreter than the one that
//      runs the file. A caller that wants it can inject `syntaxCheck`.
//   2. `grep_memory`'s regex ENGINE is JavaScript's: a pattern Python's `re`
//      rejects may compile here and vice versa, and an invalid pattern's detail
//      is the engine's sentence. The sentence AROUND it is unchanged, and a
//      leading `(?i)`/`(?m)`/`(?s)` prefix is translated to the JS flags so the
//      one spelling the tool's own prose teaches still works.
//   3. `_coerce_types`'s number spellings follow Python's `int()`/`float()`
//      (whitespace trim, sign, `_` separators for int), because that is the
//      contract the goldens were captured from — not `Number()`.
//   4. A NON-STRING argument to a string parameter (`command: 5`,
//      `pattern: 5`) is stringified where Python stops with `TypeError` (for
//      `len`, `truncate`) or `AttributeError` (for `.strip()`). The model-facing
//      transcript then reads as if the call had been made with the text, which is
//      the same shape `_coerce_types` already gives a number spelled as a string
//      and never worse than refusing a call the far side could have run.
//
// Like every file in `ui/host/`, this one touches NO local filesystem (plan §7
// ban X1): every read and write goes through the injected workspace, which is one
// exec on the far side.

"use strict";

const { DURABLE_TYPES, SECTION, eventFromDict } = require("./clc");
const { eventText } = require("./events");
const { TransportError } = require("./exec");
const { ValueError, OSError, repr } = require("./fs");
const { splitCommand } = require("./permission");

// ----------------------------------------------------------------- envelope --

// One finished tool call: what the model reads back, whether it failed, what
// changed (`agent/tools/envelope.py`). A plain frozen object because that is what
// the loop's own `envelope()` accepts, and because all three keys are always
// present — the point of the dataclass with defaults is that a consumer indexing
// `error` never sees a hole.
function envelope(content, options = {}) {
  return Object.freeze({
    content: String(content === undefined || content === null ? "" : content),
    error: Boolean(options && options.error),
    diff: String((options && options.diff) || ""),
  });
}

// ------------------------------------------------------------- the vocabulary --
//
// `catalog.py`'s built-in tables, kept as data so `orient.js` can read the same
// words a manifest is validated against. The host's own document
// (`tools/hostconfig.py`) has no JS counterpart yet: the session's config is the
// only thing that reaches this process, and nothing in it renames a policy word.

// What the UI does with a tool that declares no `ui` block (`catalog.DEFAULT_UI`).
const DEFAULT_UI = Object.freeze({
  group: null,
  chip: "name",
  summary: "",
  preview: "args",
  header: "",
  form: "block",
  body: "text",
  collapse: "never",
  highlight: "",
  chrome: "",
});
const UI_KEYS = [...Object.keys(DEFAULT_UI), "mutates"];

// The host POLICY a declaration may put a tool under (`catalog.DEFAULT_ACCESS`):
// the guard that enforces it (`filesystem.py`) and the argument that guard reads
// when the declaration does not rename it. `command` has no guard — the
// permission engine judges it — which is why its guard is null.
const DEFAULT_ACCESS = Object.freeze({
  read: Object.freeze({ guard: "guard_read", arg: "path" }),
  sweep: Object.freeze({ guard: "guard_grep", arg: "path" }),
  write: Object.freeze({ guard: "guard_write", arg: "path" }),
  command: Object.freeze({ guard: "", arg: "command" }),
});
const ACCESS_WORDS = DEFAULT_ACCESS;
const ACCESS_ARGS = Object.freeze(
  Object.fromEntries(Object.entries(ACCESS_WORDS).map(([word, rec]) => [word, rec.arg]))
);

// The NAMED gate conditions this host has (`catalog.DEFAULT_GATES`); ""/"always"
// are structural and are handled in `gateOk`.
const GATE_WORDS = Object.freeze({ project: "project", skills: "skills" });
const GATES = Object.freeze(["", "always", ...Object.keys(GATE_WORDS)]);

// The policies under which a call is "working ON a file" rather than sweeping
// for one (`gates.WATCHED_ACCESS`): the ones `pathArg` answers for.
const WATCHED_ACCESS = new Set(["read", "write"]);

// The names no component may publish: with nothing installed they ARE the whole
// surface (`catalog.HOST_TOOL_NAMES`, `tools/host.py`).
const HOST_NAME = "clutch-host";
const HOST_TOOL_NAMES = Object.freeze(["run_command", "grep_memory", "read_memory"]);

// `agent/config.py`'s tool-execution fields, as this host spells them (camelCase,
// like `loop.js`'s DEFAULTS). A session passes a `config`; these only fill holes.
const CONFIG_DEFAULTS = Object.freeze({
  mode: "work",
  commandTimeout: 30.0,
  outputLimit: 6000,
  outputHead: 2500,
  outputTail: 2500,
  blockedPrefixes: Object.freeze([
    "vim",
    "vi",
    "emacs",
    "nano",
    "less",
    "more",
    "tail -f",
    "top",
    "htop",
    "make",
  ]),
});

function setting(config, name) {
  const value = config && config[name];
  return value === undefined || value === null ? CONFIG_DEFAULTS[name] : value;
}

// `Config.truncate`: head/tail trim, the middle replaced by an omitted count.
function truncate(text, config) {
  const value = String(text === undefined || text === null ? "" : text);
  const limit = Number(setting(config, "outputLimit"));
  if (pyLen(value) <= limit) return value;
  const head = Number(setting(config, "outputHead"));
  const tail = Number(setting(config, "outputTail"));
  const omitted = pyLen(value) - head - tail;
  return `${pySlice(value, 0, head)}\n... [${omitted} chars omitted] ...\n${pySlice(value, pyLen(value) - tail, null)}`;
}

// Python's `len(str)` counts code points, not UTF-16 units. Every budget in
// `recall.py` and `config.py` is a character budget, so the two helpers below are
// the only places JS's own notion of length/indexing is not enough.
function pyLen(text) {
  return [...String(text)].length;
}

function pySlice(text, start, end) {
  const chars = [...String(text)];
  const from = start < 0 ? Math.max(0, chars.length + start) : start;
  const to = end === null || end === undefined ? chars.length : end < 0 ? chars.length + end : end;
  return chars.slice(from, to).join("");
}

// ------------------------------------------------------------------- the UI --

// `catalog.ui_of`: the declaration's presentation with the defaults filled in, so
// the renderer can never see a half-specified block.
function uiOf(spec) {
  const out = { ...DEFAULT_UI };
  for (const key of Object.keys(spec || {})) {
    if (UI_KEYS.includes(key)) out[key] = spec[key];
  }
  return out;
}

// ------------------------------------------------------------- the host tools --
//
// `tools/host.py`: the three declarations, as DATA in the same vocabulary a
// component's manifest speaks. `implementation` is the one field a component's
// declaration never has.

function hostDeclarations(config, render) {
  if (typeof render !== "function") throw new TypeError("hostDeclarations needs render(name, vars)");
  const chat = setting(config, "mode") === "chat";
  const prose = (name) => render(`tools/${name}${chat ? "_chat" : ""}.md`);
  return [
    {
      name: "run_command",
      declaration: {
        name: "run_command",
        description: prose("run_command"),
        parameters: {
          properties: { command: { type: "string", description: "shell command string to run" } },
          required: ["command"],
        },
        access: "command",
        ui: { preview: "command" },
      },
      implementation: runCommand,
      needsLog: false,
    },
    {
      name: "grep_memory",
      declaration: {
        name: "grep_memory",
        description: prose("grep_memory"),
        parameters: {
          properties: {
            pattern: { type: "string", description: "regular expression, matched per line" },
            include: {
              type: "string",
              description: "only lines of this event type (a glob: user_message, tool_*, note, ...)",
            },
            max_hits: {
              type: "integer",
              description: "stop after this many matching lines (default 20, at most 200)",
            },
          },
          required: ["pattern"],
        },
        // No host-side path policy: the tool has no path argument at all, and the
        // one file it reads is the one the workspace's fence exists to protect.
        access: "",
        // Only a session with a project open has a log to read (`gates.gate_project`).
        gate: "project",
        ui: {
          group: "memory",
          form: "row",
          summary: "grep memory /{pattern}/",
          preview: { mode: "content", keys: ["pattern"] },
          collapse: "long",
        },
      },
      implementation: grepMemory,
      needsLog: true,
    },
    {
      name: "read_memory",
      declaration: {
        name: "read_memory",
        description: prose("read_memory"),
        parameters: {
          properties: {
            offset: {
              type: "integer",
              description: "1-based line to start at (omit for the newest lines)",
            },
            limit: { type: "integer", description: "how many lines to read (default 40, at most 200)" },
          },
          required: [],
        },
        access: "",
        gate: "project",
        ui: {
          group: "memory",
          form: "row",
          summary: "read memory",
          preview: { mode: "content", keys: ["offset", "limit"] },
          collapse: "long",
        },
      },
      implementation: readMemory,
      needsLog: true,
    },
  ];
}

// ------------------------------------------------------------------ the gates --
//
// `gates.py`: the host-side condition a NAMED gate word stands behind.

// `project`: this session has a project log to read. `log` null (or the in-memory
// scratch log, whose path is "") means there is no file behind the session.
function gateProject(_config, log) {
  return Boolean(log && String(log.path || ""));
}

// `skills`: the library the `skills` fact publishes has something in it. The
// scan is the caller's (`entries`); no answer means an empty library, and an
// empty library offers the model nothing to pick, so the gate is SHUT.
function gateSkills(config, _log, entries) {
  if (typeof entries !== "function") return false;
  const found = entries("skills", config);
  return Boolean(found && found.length);
}

// `_gate_ok`: a tool whose gate is shut is not offered — not offered-with-an-error,
// because the model would only learn to stop trying.
function gateOk(gate, config, log, entries) {
  const word = gate === undefined || gate === null ? "" : String(gate);
  if (word === "" || word === "always") return true;
  switch (GATE_WORDS[word]) {
    case "project":
      return gateProject(config, log);
    case "skills":
      return gateSkills(config, log, entries);
    default:
      return false; // an unreadable condition is not "always true"
  }
}

// ---------------------------------------------------------------- the guards --
//
// `filesystem.py`: the one thing the component does NOT carry — the host's own
// refusal to read or write a path the workspace protects (the project's .clc).
// The component's fence serves a path named explicitly; this is exactly that gap.

function createGuards(render) {
  if (typeof render !== "function") throw new TypeError("createGuards needs render(name, vars)");

  async function refuseProtected(workspace, path, write) {
    let resolved;
    try {
      resolved = await workspace.resolve(path);
    } catch (error) {
      if (error instanceof ValueError || error instanceof OSError) return null; // not a containment question
      throw error;
    }
    if (!workspace.isProtected(resolved)) return null;
    const template = write ? "errors/protected_write.md" : "errors/protected_read.md";
    return envelope(render(template, { path }), { error: true });
  }

  // `arg` is the argument the tool's own declaration says holds the path
  // (`Tool.accessArg`) — a component that calls it `file` is guarded the same.
  async function guardRead(workspace, _config, args, arg = "path") {
    return refuseProtected(workspace, String(args && args[arg] !== undefined ? args[arg] : ""), false);
  }

  async function guardWrite(workspace, _config, args, arg = "path") {
    return refuseProtected(workspace, String(args && args[arg] !== undefined ? args[arg] : ""), true);
  }

  // grep never searches a protected file: a walk skips it, and naming it
  // explicitly yields the same empty result the walk produces.
  async function guardGrep(workspace, _config, args, arg = "path") {
    const path = String((args && args[arg]) || ".");
    let resolved;
    try {
      resolved = await workspace.resolve(path);
    } catch (error) {
      if (error instanceof ValueError || error instanceof OSError) return null;
      throw error;
    }
    if (workspace.isProtected(resolved)) return envelope("(no matches)");
    return null;
  }

  // Keyed by the word a declaration's `access` names (`catalog.DEFAULT_ACCESS`),
  // which is what `wireTool` looks a guard up by — not by these functions' names.
  return { guard_read: guardRead, guard_write: guardWrite, guard_grep: guardGrep };
}

// ------------------------------------------------------- the two kinds of tool --
//
// `registry.Tool` + `SystemTool` / `ExtensionTool`: one declaration -> the tool
// the model sees and the host runs. What every tool SHARES is exactly what the
// declaration says (its name and schema, the policy it is under, the undo record
// its writes need, how the UI renders it); what differs is WHO CARRIES THE CALL
// OUT, and that is the TYPE rather than a pair of fields that may be null:
//
//   * `systemTool`    — host code with no component behind it (`declarationOf`);
//   * `extensionTool` — the component's own statement, sent through the runner
//     the caller supplied (`runStatement`: statement.js or the client channel).
//
// Both carry `run(call)`, so a call has one shape to make and no branch to read:
// `{workspace, config, args, cancel, log}` in, an envelope out. The old triple
// (`inst`/`module`/`host`) could describe both kinds at once AND neither — a
// component tool wired without a statement arrived with all three null and the
// call then had to decide which one it was. There is no such tool here: the two
// constructors below are the only way one is made.

// The facts every tool has, straight off the declaration (catalog.Tool).
function declarationOf(spec, guards) {
  const accessWord = spec.access === undefined || spec.access === null ? "" : String(spec.access);
  if (accessWord && !Object.prototype.hasOwnProperty.call(ACCESS_WORDS, accessWord)) {
    throw new Error(`unknown access ${repr(accessWord)} (host knows ${Object.keys(ACCESS_WORDS).join(", ")})`);
  }
  const access = accessWord ? ACCESS_WORDS[accessWord] : null;
  const accessArg = spec.access_arg || (access ? access.arg : "");
  return {
    name: spec.name,
    description: String(spec.description || ""),
    parameters: JSON.parse(JSON.stringify(spec.parameters || {})),
    access: accessWord,
    accessArg,
    // host policy the component deliberately does not carry
    guard: access && access.guard ? guards[access.guard] || null : null,
    snapshot: Boolean(spec.snapshot),
    snapshotArg: spec.snapshot_arg || accessArg || "path",
    ui: uiOf(spec.ui),
    cancelable: true,
  };
}

// `registry.SystemTool`: the host's own code. `needsLog` marks the one tool that
// reads the session's own project log — a fact about the host, not an argument
// the model may point anywhere.
function systemTool(declaration, spec, guards, render) {
  const implementation = declaration.implementation;
  const needsLog = Boolean(declaration.needsLog);
  const tool = {
    ...declarationOf(spec, guards),
    kind: "system",
    needsLog,
    run(call) {
      // `render` rides the ctx because a host implementation is where the host
      // speaks (`run_command` renders the blocked/refused/failed wording); in
      // Python it is a module import, and this is the JS spelling of that import.
      const ctx = { cancel: call.cancel || null, render };
      if (needsLog) ctx.log = call.log;
      return implementation(call.workspace, call.config, call.args, ctx);
    },
  };
  return Object.freeze(tool);
}

// `registry.ExtensionTool`: a component's own statement. `template` is the
// component's part of the terminal line (the declaration's `command`), `defaults`
// ride UNDER the model's arguments, and `run` is the injected runner: this file
// owns the HOST's half of a call and nothing a component declares.
function extensionTool(declaration, spec, guards, runStatement) {
  const name = String(spec.name);
  if (spec.command === undefined || spec.command === null || spec.command === "") {
    // The declaration names nothing this host (or its client) could run. Python
    // refuses such a manifest when the catalog is parsed; a tool built here is
    // the same refusal at the same moment — never a tool that answers "no
    // implementation" after the model has already called it.
    throw new TypeError(`component declaration ${name} names no command: nothing could carry out its statement`);
  }
  if (typeof runStatement !== "function") {
    throw new TypeError(`tool ${name} is a component statement; buildTools needs runStatement`);
  }
  const tool = {
    ...declarationOf(spec, guards),
    kind: "extension",
    owner: String(declaration.owner || ""),
    template: spec.command,
    defaults: spec.defaults ? { ...spec.defaults } : {},
    run(call) {
      return runStatement(tool, {
        workspace: call.workspace,
        config: call.config,
        args: call.args,
        cancel: call.cancel || null,
      });
    },
  };
  return Object.freeze(tool);
}

function wireTool(declaration, ctx) {
  const spec = declaration.declaration;
  if (declaration.implementation) return systemTool(declaration, spec, ctx.guards, ctx.render);
  return extensionTool(declaration, spec, ctx.guards, ctx.runStatement || null);
}

// `registry._bootstrap`: the host's OWN declarations, wired like any other, and
// offered only when their gate holds. A word the host itself cannot honor is a
// host bug, so it throws instead of dropping the tool.
function buildTools(options = {}) {
  const config = options.config || {};
  const log = options.log || null;
  const render = options.render;
  const entries = options.entries;
  if (typeof render !== "function") throw new TypeError("buildTools needs render(name, vars)");
  const guards = createGuards(render);
  const out = [];
  for (const declared of hostDeclarations(config, render)) {
    const spec = declared.declaration;
    if (spec.access && !Object.prototype.hasOwnProperty.call(ACCESS_WORDS, spec.access)) {
      throw new Error(`the host's own ${declared.name} declaration names an unknown access word`);
    }
    if (spec.ui) {
      for (const key of Object.keys(spec.ui)) {
        if (!UI_KEYS.includes(key)) throw new Error(`the host's own ${declared.name} declares unknown ui ${repr(key)}`);
      }
    }
    if (!gateOk(spec.gate, config, log, entries)) continue;
    out.push(wireTool(declared, { guards, render, runStatement: options.runStatement || null }));
  }
  return out;
}

// -------------------------------------------------------------- the registry --

function openAiSchema(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: (tool.parameters && tool.parameters.properties) || {},
        required: (tool.parameters && tool.parameters.required) || [],
      },
    },
  };
}

// `registry.ToolRegistry`. The seam the run loop calls:
//   schemas() / names() / access(name) / accessArg(name) / pathArg(name) /
//   ui(name) / tool(name) / execute(workspace, config, name, args, {cancel})
function createRegistry(options = {}) {
  const tools = options.tools || [];
  const log = options.log || null;
  const render = options.render;
  if (typeof render !== "function") throw new TypeError("createRegistry needs render(name, vars)");

  const table = new Map();
  for (const decl of tools) {
    // A tool WITHOUT a run is not a tool: the two constructors in this file are
    // the only ways one is made, and both attach it. A hand-built declaration
    // that reaches here is the one thing this seam cannot execute.
    if (typeof decl.run !== "function") {
      throw new TypeError(`tool ${decl.name} carries no run: wireTool is the only way to make one`);
    }
    table.set(decl.name, decl);
  }

  function names() {
    return [...table.keys()];
  }

  function tool(name) {
    return table.get(name) || null;
  }

  // The policy a tool's declaration put it under ("" = unguarded). The evaluator
  // never sees a tool name, so a component installed later is subject to the same
  // policy vocabulary as the ones this repo develops.
  function access(name) {
    const found = table.get(name);
    return found ? found.access : "";
  }

  function accessArg(name) {
    const found = table.get(name);
    return found ? found.accessArg : "";
  }

  // The argument in which this call NAMED a file ("" when it named none): only
  // read/write, never a sweep — a search has no single file to re-read.
  function pathArg(name) {
    const found = table.get(name);
    if (!found || !WATCHED_ACCESS.has(found.access)) return "";
    return found.accessArg;
  }

  // A tool's presentation block, plus the two facts only this process can answer:
  // whether the host holds an undo record, and whether the call may change the
  // tree the UI shows. A name no tool declares gets the defaults and nothing more
  // — never a `mutates` this process invented for a tool it cannot see.
  function ui(name) {
    const found = table.get(name);
    if (!found) return { ...DEFAULT_UI, undo: false };
    const block = { ...found.ui };
    if (!Object.prototype.hasOwnProperty.call(block, "mutates")) {
      block.mutates = Boolean(found.snapshot || found.kind === "system");
    } else {
      block.mutates = Boolean(block.mutates);
    }
    block.undo = Boolean(found.snapshot);
    return block;
  }

  function schemas() {
    return [...table.values()].map(openAiSchema);
  }

  // `registry._coerce_types`: models sometimes pass strings, so a value already of
  // the declared shape passes, a spelling of it is converted, and anything else is
  // an INVALID argument — raised here, where `execute` already answers with the
  // invalid-arguments envelope. `boolean` is the strictest: "yes" is not a guess
  // this host makes.
  function coerceTypes(found, rawArgs) {
    const args = { ...(rawArgs || {}) };
    const props = (found.parameters && found.parameters.properties) || {};
    for (const key of Object.keys(props)) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
      const kind = props[key] && props[key].type;
      const value = args[key];
      if (kind === "integer") {
        // `isinstance(value, int) and not isinstance(value, bool)` continues;
        // a bool then falls through CPython's `int(True)` -> 1, `int(False)` -> 0.
        if (typeof value === "boolean") {
          args[key] = value ? 1 : 0;
          continue;
        }
        if (typeof value === "number" && Number.isInteger(value)) continue;
        args[key] = pyInt(value, `argument ${pyRepr(key)} must be an integer, got ${pyRepr(value)}`);
      } else if (kind === "number") {
        if (typeof value === "boolean") {
          throw new TypeError(`argument ${pyRepr(key)} must be a number, got ${pyRepr(value)}`);
        }
        if (typeof value === "number") continue;
        args[key] = pyFloat(value, `argument ${pyRepr(key)} must be a number, got ${pyRepr(value)}`);
      } else if (kind === "boolean" && typeof value !== "boolean") {
        const word = typeof value === "string" ? pyStrip(value).toLowerCase() : "";
        if (word === "true" || word === "false") {
          args[key] = word === "true";
        } else if (typeof value === "number" && Number.isInteger(value) && (value === 0 || value === 1)) {
          args[key] = Boolean(value);
        } else {
          throw new TypeError(`argument ${pyRepr(key)} must be true or false, got ${pyRepr(value)}`);
        }
      }
    }
    return args;
  }

  // `registry.Tool.invoke`: the host's policy first, then the ONE implementation
  // of it — `run`, which the tool itself carries. There is no precedence to speak
  // of any more: a tool's kind is exactly one constructor in this file.
  async function invoke(workspace, config, found, args, cancel) {
    if (typeof found.guard === "function") {
      const refused = await found.guard(workspace, config, args, found.accessArg);
      if (refused) return refused;
    }
    return found.run({ workspace, config, args, cancel: cancel || null, log });
  }

  async function execute(workspace, config, name, args, execOptions = {}) {
    const found = table.get(name);
    if (!found) {
      return envelope(render("unknown_tool.md", { tool: name, available: names().join(", ") }), {
        error: true,
      });
    }
    const cancel = execOptions && execOptions.cancel;
    try {
      const ready = coerceTypes(found, args);
      return await invoke(workspace, config, found, ready, cancel);
    } catch (error) {
      if (error instanceof TypeError) {
        return envelope(render("errors/invalid_arguments.md", { error: error.message }), { error: true });
      }
      // A tool boundary: report to the model, never out of the loop.
      return envelope(render("errors/tool_exception.md", { error: errorTextOf(error) }), { error: true });
    }
  }

  return { schemas, names, access, accessArg, pathArg, ui, tool, execute, coerceTypes };
}

function errorTextOf(error) {
  return error && error.message !== undefined ? String(error.message) : String(error);
}

// ------------------------------------------------------------ Python spellings --
//
// The coercion contract and the messages the model reads are CPython's, so the
// few primitives `coerceTypes` needs are spelled the way CPython spells them
// rather than the way `Number()` does.

// Python truthiness for the `x or default` idiom `recall.py` uses.
function pyTruthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

const PY_SPACE = /^[\s\x1c-\x1f]$/u;

function pyStrip(text) {
  return String(text).replace(/^[\s\x1c-\x1f]+|[\s\x1c-\x1f]+$/gu, "");
}

// `str.split(maxsplit=1)`: one split at the first whitespace RUN, the leading run
// consumed and the remainder taken verbatim (its own trailing spaces included).
function splitMaxSplit(text, maxsplit = 1) {
  const source = String(text);
  const out = [];
  let index = 0;
  while (out.length < maxsplit) {
    while (index < source.length && PY_SPACE.test(source[index])) index += 1;
    if (index >= source.length) break;
    let end = index;
    while (end < source.length && !PY_SPACE.test(source[end])) end += 1;
    out.push(source.slice(index, end));
    index = end;
  }
  if (out.length < maxsplit) return out; // the split consumed everything
  while (index < source.length && PY_SPACE.test(source[index])) index += 1;
  if (index < source.length) out.push(source.slice(index));
  return out;
}

// `str.splitlines()`: Python's line boundaries are more than "\n" (and a trailing
// one does not produce an empty tail).
function splitLines(text) {
  const source = String(text);
  const out = [];
  let start = 0;
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    let width = 0;
    if (ch === "\r") width = source[index + 1] === "\n" ? 2 : 1;
    else if ("\n\v\f\x1c\x1d\x1e\x85\u2028\u2029".includes(ch)) width = 1;
    if (!width) {
      index += 1;
      continue;
    }
    out.push(source.slice(start, index));
    index += width;
    start = index;
  }
  if (start < source.length) out.push(source.slice(start));
  return out;
}

// Python `repr` for the values an argument can hold (the messages quote them).
function pyRepr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return String(value);
  }
  if (typeof value === "string") return repr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.keys(value).map((key) => `${pyRepr(key)}: ${pyRepr(value[key])}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

const PY_INT_RE = /^[+-]?\d(?:_?\d)*$/;

// `int(value)`: a number truncates toward zero (NaN/inf raise), a string is
// trimmed and must be a decimal integer literal (`3.0` and `0x10` do not convert).
function pyInt(value, message) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(message);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (!PY_INT_RE.test(text)) throw new TypeError(message);
    return Number(text.replace(/_/g, ""));
  }
  throw new TypeError(message);
}

const PY_FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?|nan|inf|infinity)$/i;

// `float(value)`: numbers pass, strings are trimmed and parsed as a decimal float
// (or nan/inf); anything else raises.
function pyFloat(value, message) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const text = pyStrip(value).replace(/_/g, "");
    if (!text || !PY_FLOAT_RE.test(text)) throw new TypeError(message);
    if (/^[+-]?(nan|inf|infinity)$/i.test(text)) {
      const sign = text.startsWith("-") ? -1 : 1;
      return /nan/i.test(text) ? NaN : sign * Infinity;
    }
    return Number(text);
  }
  throw new TypeError(message);
}

// ---------------------------------------------------------- the shell (chat) --
//
// `tools/shell.py`. The classifier is default-deny: static analysis can only ever
// PROVE a command read-only.

const READ_ONLY_CMDS = new Set([
  "ls", "cat", "grep", "find", "pwd", "cd", "whoami", "id", "uname", "date",
  "echo", "printf", "which", "type", "true", "false", "test", "[",
  "df", "du", "free", "uptime", "ps", "lsusb", "lspci", "lscpu", "dmesg",
  "nvidia-smi", "ip", "ss", "netstat", "ping", "hostname", "who", "w",
  "sort", "uniq", "head", "tail", "wc", "diff", "stat", "file",
  "basename", "dirname", "realpath", "readlink", "seq", "cut", "tr",
  "getent", "history", "git", "sed", "curl",
  // cmd.exe / Windows names (harmless where they don't exist)
  "dir", "tree", "where", "findstr", "ver", "systeminfo", "ipconfig",
  "tasklist", "fc",
]);

const WRITE_CMDS = new Set([
  "rm", "mv", "cp", "touch", "mkdir", "rmdir", "ln", "chmod", "chown",
  "chgrp", "tee", "dd", "mkfs", "mount", "umount", "truncate", "install",
  "unlink", "scp", "rsync", "wget", "make", "cmake", "ninja", "npm",
  "npx", "yarn", "pnpm", "pip", "pip2", "pip3", "pipx", "apt", "apt-get",
  "yum", "dnf", "brew", "gcc", "g++", "clang", "clang++", "go", "cargo",
  "rustc", "javac", "tar", "zip", "unzip", "gzip", "gunzip", "xz",
  "bzip2", "patch", "kill", "pkill", "killall", "systemctl", "service",
  "docker", "podman", "git", "sed", "curl", "find",
  // cmd.exe / Windows names
  "del", "erase", "rd", "copy", "xcopy", "robocopy", "move", "ren",
  "rename", "md", "taskkill", "setx", "reg", "netsh", "sc",
]);

const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "describe",
  "blame", "grep", "cat-file", "ls-tree", "count-objects", "help", "version",
]);

const GIT_WRITE = new Set([
  "add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset",
  "checkout", "switch", "restore", "clean", "init", "clone", "mv", "rm",
  "stash", "tag", "branch", "config", "remote", "submodule", "apply",
  "cherry-pick", "revert", "gc", "prune", "pack", "update-index",
  "update-ref", "symbolic-ref", "write-tree", "commit-tree", "notes",
  "am", "format-patch", "filter-branch", "reflog", "worktree", "archive",
]);

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&"]);

const PUNCTUATION = "|;&";

// `shlex.whitespace` is " \t\r\n" — NOT Python's `str.isspace()`. A form feed or
// a non-breaking space is an ordinary character inside a token to shlex, so the
// tokenizer must not treat it as a separator (`localshell.split_command` makes
// the same distinction).
const SHLEX_SPACE = " \t\r\n";

// `shell._tokenize`, POSIX branch: `shlex.shlex(..., punctuation_chars="|;&")`
// with `whitespace_split` — NOT `shlex.split`, because a separator must come out
// as its own token for the per-segment verdict. Consecutive punctuation chars are
// ONE token (`&&`, `|&`, `|;&`), quotes still group, and an unbalanced quote (or a
// trailing backslash) makes the command unparseable -> null, which callers read
// as the conservative verdict.
function tokenize(command) {
  const text = String(command === undefined || command === null ? "" : command);
  const out = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && SHLEX_SPACE.includes(text[index])) index += 1;
    if (index >= text.length) break;
    if (PUNCTUATION.includes(text[index])) {
      let end = index;
      while (end < text.length && PUNCTUATION.includes(text[end])) end += 1;
      out.push(text.slice(index, end));
      index = end;
      continue;
    }
    let token = "";
    let quote = "";
    let quoted = false; // a token that only a quote produced is still a token
    while (index < text.length) {
      const ch = text[index];
      if (quote === "'") {
        if (ch === "'") {
          quote = "";
          index += 1;
        } else {
          token += ch;
          index += 1;
        }
        continue;
      }
      if (quote === '"') {
        if (ch === '"') {
          quote = "";
          index += 1;
        } else if (ch === "\\") {
          const next = text[index + 1];
          if (next === undefined) return null;
          // inside double quotes only the quote and the backslash are escaped
          if (next !== '"' && next !== "\\") token += "\\";
          token += next;
          index += 2;
        } else {
          token += ch;
          index += 1;
        }
        continue;
      }
      if (SHLEX_SPACE.includes(ch) || PUNCTUATION.includes(ch)) break;
      // `shlex.commenters` is still "#" (punctuation_chars does not clear it):
      // outside quotes a "#" ends the LINE, mid-token too (`foo#bar` is `foo`),
      // and tokenizing resumes after the newline. Inside quotes it is literal.
      if (ch === "#") {
        while (index < text.length && text[index] !== "\n") index += 1;
        if (index < text.length) index += 1;
        break;
      }
      if (ch === "'") {
        quote = "'";
        quoted = true;
        index += 1;
      } else if (ch === '"') {
        quote = '"';
        quoted = true;
        index += 1;
      } else if (ch === "\\") {
        const next = text[index + 1];
        if (next === undefined) return null;
        token += next;
        index += 2;
      } else {
        token += ch;
        index += 1;
      }
    }
    if (quote) return null;
    // `""` and `''` ARE one empty argument; a bare comment is no token at all.
    if (token || quoted) out.push(token);
  }
  return out;
}

// `shell._segment`: the first command token, skipping VAR=value prefixes.
function segment(seg) {
  for (const tok of seg) {
    if (tok.includes("=") && !tok.startsWith("-")) continue;
    return tok;
  }
  return "";
}

// `shell._classify_segment`: read / write / unknown for one separator-less segment.
function classifySegment(seg) {
  if (!seg.length) return "read";
  // ">" = output redirect (quoted too, conservatively); "<" alone is read-only input
  for (const tok of seg) {
    if (tok.includes(">")) return "write";
  }
  const name = segment(seg);
  if (!name) return "read"; // pure VAR=val assignment: no side effects
  if (name.includes("/")) return "unknown"; // path-invoked binary: unprovable
  const rest = seg.slice(1);

  if (name === "git") {
    const subs = rest.filter((tok) => !tok.startsWith("-"));
    if (subs.some((sub) => GIT_WRITE.has(sub))) return "write";
    if (subs.some((sub) => GIT_READ.has(sub))) return "read";
    return "read"; // bare `git` / `git -C dir` -> default status
  }
  if (name === "sed") {
    if (rest.some((tok) => tok === "-i" || tok.startsWith("--in-place"))) return "write";
    return "read";
  }
  if (name === "curl") {
    // -o/--output write a file; combined short flags (-so) contain "o"
    if (rest.some((tok) => tok.startsWith("--output") || tok.startsWith("--remote-name"))) return "write";
    if (rest.some((tok) => tok.startsWith("-") && !tok.startsWith("--") && tok.includes("o"))) return "write";
    return "read";
  }
  if (name === "find") {
    if (
      rest.some(
        (tok) => tok === "-delete" || tok === "-exec" || tok === "-execdir" || tok === "-ok"
          || tok.startsWith("-fprint") || tok.startsWith("-fls")
      )
    ) {
      return "write";
    }
    return "read";
  }

  if (READ_ONLY_CMDS.has(name)) return "read";
  if (WRITE_CMDS.has(name)) return "write";
  return "unknown";
}

// `shell.classify_command`: ("read" | "write" | "unknown", detail). "read" means
// the command is provably free of workspace side effects; anything else must be
// rejected in chat mode.
function classifyCommand(command) {
  const text = String(command === undefined || command === null ? "" : command);
  if (!pyStrip(text)) return ["read", "empty command"];
  if (text.includes("\n")) {
    // newline-separated commands run sequentially: every line must be read-only
    let verdict = "read";
    let detail = "multi-line command";
    for (const line of splitLines(text)) {
      const pair = classifyCommand(line);
      if (pair[0] !== "read") return [pair[0], `${pair[1]} (line: ${repr(pyStrip(line))})`];
    }
    return [verdict, detail];
  }
  if (text.includes("$(") || text.includes("`")) {
    return ["unknown", "command substitution ($(...) or backticks) cannot be statically analyzed"];
  }
  const tokens = tokenize(text);
  if (tokens === null) return ["unknown", "command cannot be parsed (unbalanced quotes?)"];
  // command-separator segments: each one must be read-only
  let current = [];
  for (const tok of tokens) {
    if (SEPARATORS.has(tok)) {
      const verdict = classifySegment(current);
      if (verdict !== "read") {
        const name = segment(current);
        // NB: CPython's `f"segment {_segment(seg) or '?'!r} ..."` applies `!r`
        // to the '?' fallback only (precedence), so a NAMED command is unquoted
        // here. That is frozen, not tidied.
        return [verdict, `segment ${name || repr("?")} is a ${verdict} operation`];
      }
      current = [];
    } else {
      current.push(tok);
    }
  }
  const verdict = classifySegment(current);
  if (verdict === "read") return ["read", "read-only command"];
  const name = segment(current);
  if (verdict === "write") return ["write", `'${name}' is a write operation`];
  return ["unknown", `'${name}' cannot be proven read-only`];
}

// `shell._blocked_reason`: commands that hang in a non-TTY pipe. The host's own
// blocked list, plus bare `python`/`python3` (a REPL with no stdin would hang).
function blockedReason(config, command) {
  const stripped = pyStrip(String(command === undefined || command === null ? "" : command));
  const parts = splitMaxSplit(stripped, 1);
  const first = parts.length ? parts[0] : "";

  if (first === "python" || first === "python3") {
    let rest = parts.length > 1 ? splitCommand(parts[1]) : null;
    rest = rest || []; // unparseable -> conservative: looks interactive
    // safe non-interactive forms: `python3 file.py`, `python3 -m module`, `python3 -c code`
    const hasFile = rest.some((arg) => arg.endsWith(".py") && !arg.startsWith("-"));
    if (!(hasFile || rest.includes("-m") || rest.includes("-c"))) {
      return { template: "errors/interactive_hint.md", vars: {} };
    }
    return null;
  }

  for (const prefix of setting(config, "blockedPrefixes") || []) {
    if (stripped.startsWith(`${prefix} `)) return { template: "errors/interactive_hint.md", vars: {} };
  }
  return null;
}

// `transport.failure_envelope`: a transport verdict is not the command's — an
// abort is the user's Stop, a timeout is the budget, anything else means the
// command never ran. The statement layer asks the same function.
function failureEnvelope(error, options = {}) {
  const render = options.render;
  if (typeof render !== "function") throw new TypeError("failureEnvelope needs render");
  if (error && error.aborted) return envelope(render("errors/command_aborted.md"), { error: true });
  if (error && error.timeout) {
    const seconds = Number(options.timeoutSeconds === undefined ? 0 : options.timeoutSeconds);
    return envelope(
      render("errors/command_timeout.md", {
        seconds: `${seconds.toFixed(0)}s`,
        hint: render("errors/interactive_hint.md"),
      }),
      { error: true }
    );
  }
  return envelope(render("errors/execution_failed.md", { error: errorTextOf(error) }), { error: true });
}

// `shell.run_command`: the loop's escape hatch, inside the workspace, under the
// host's own decisions (chat-mode classifier, blocked list, the path-escape and
// protected-token scan, timeout, truncation, Stop).
async function runCommand(workspace, config, args, ctx = {}) {
  const render = ctx.render;
  if (typeof render !== "function") throw new TypeError("runCommand needs render in its ctx");
  const command = String((args && args.command) === undefined || (args && args.command) === null ? "" : args.command);

  const blocked = blockedReason(config, command);
  if (blocked) return envelope(`ERROR: ${render(blocked.template, blocked.vars)}`, { error: true });

  // chat mode: only provably read-only commands may run (default deny)
  if (setting(config, "mode") === "chat") {
    const [verdict, detail] = classifyCommand(command);
    if (verdict !== "read") {
      return envelope(
        render("errors/read_only_command.md", { verdict, detail, command: command.slice(0, 300) }),
        { error: true }
      );
    }
  }

  if (!pyStrip(command)) return envelope(render("errors/empty_command.md"), { error: true });

  // Path escape guard: reject tokens resolving outside the workspace. `splitCommand`
  // (not the punctuation tokenizer above): the two answer different questions —
  // this one asks what the shell will hand the program as arguments.
  const tokens = splitCommand(command);
  if (tokens === null) {
    return envelope("ERROR: command cannot be parsed (unbalanced quotes?)", { error: true });
  }
  for (const tok of tokens) {
    let resolved;
    try {
      // `Workspace.shell_path` is the identity here: the far side is always POSIX.
      resolved = await workspace.resolve(tok);
    } catch (error) {
      if (error instanceof ValueError || error instanceof OSError) {
        return envelope(render("errors/path_escape.md", { token: repr(tok) }), { error: true });
      }
      throw error;
    }
    // protected files (the .clc project file) are off-limits to commands too
    if (workspace.isProtected(resolved)) {
      return envelope(render("errors/protected_command.md", { token: repr(tok) }), { error: true });
    }
  }

  // DELIBERATE DIVERGENCE: `shell.py:286` compiles a `python3 file.py` target
  // before running it. There is no `compile()` on this host, so the poka-yoke is
  // gone rather than faked by a round trip to an interpreter that need not be the
  // one that runs the file. A caller that has a checker may supply `ctx.syntaxCheck`.
  if (typeof ctx.syntaxCheck === "function" && tokens.length && (tokens[0] === "python" || tokens[0] === "python3")) {
    const fileArg = tokens.slice(1).find((arg) => !arg.startsWith("-") && arg.endsWith(".py"));
    if (fileArg) {
      let resolved;
      try {
        resolved = await workspace.resolve(fileArg);
      } catch (error) {
        if (error instanceof ValueError || error instanceof OSError) {
          return envelope(`ERROR: ${errorTextOf(error)}`, { error: true });
        }
        throw error;
      }
      const problem = await ctx.syntaxCheck(resolved);
      if (problem) return envelope(`ERROR: ${problem}`, { error: true });
    }
  }

  let answer;
  try {
    answer = await workspace.run(command, Number(setting(config, "commandTimeout")), {
      cancel: ctx.cancel || null,
    });
  } catch (error) {
    if (error instanceof TransportError) {
      return failureEnvelope(error, {
        render,
        timeoutSeconds: Number(setting(config, "commandTimeout")),
      });
    }
    return envelope(render("errors/execution_failed.md", { error: errorTextOf(error) }), { error: true });
  }

  const parts = [];
  if (answer.stdout) parts.push(`stdout:\n${truncate(answer.stdout, config)}`);
  if (answer.stderr) parts.push(`stderr:\n${truncate(answer.stderr, config)}`);

  if (answer.code !== 0) {
    const body = parts.length ? parts.join("\n") : "(no output)";
    return envelope(render("errors/command_failed.md", { code: answer.code, body }), { error: true });
  }
  if (!parts.length) return envelope("OK: command succeeded, no output.");
  return envelope(`OK: command succeeded\n${parts.join("\n")}`);
}

// ------------------------------------------------------- the log readers ----
//
// `tools/recall.py`: `grep_memory` / `read_memory` over the session's own log.
// The file is the one the host writes, protects and holds open, so these are host
// tools and the log is handed in — never named by the model.

const CHUNK = 4 * 1024 * 1024; // one scan's byte window
const EVENT_CHARS = 1200; // one event's body in a page
const PAGE_CHARS = 16000; // a page's budget
const HIT_CHARS = 300; // one hit line's clip

function logStart(log) {
  return Number(typeof log.eventStart === "function" ? log.eventStart() : log.eventStart || 0);
}

function logBytes(log) {
  return Number(typeof log.fileBytes === "function" ? log.fileBytes() : log.fileBytes || 0);
}

function cancelled(cancel) {
  if (!cancel) return false;
  if (typeof cancel.isSet === "function") return Boolean(cancel.isSet());
  if (typeof cancel.isCancelled === "function") return Boolean(cancel.isCancelled());
  return Boolean(cancel.set === true);
}

const BYTE_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

function stripBytes(buffer) {
  let from = 0;
  let to = buffer.length;
  while (from < to && BYTE_SPACE.has(buffer[from])) from += 1;
  while (to > from && BYTE_SPACE.has(buffer[to - 1])) to -= 1;
  return buffer.subarray(from, to);
}

function startsWithBytes(buffer, prefix) {
  if (buffer.length < prefix.length) return false;
  return buffer.subarray(0, prefix.length).equals(prefix);
}

const SECTION_BYTES = Buffer.from(SECTION, "utf8");

// `recall._record`: one raw line of the .clc -> the line a reader sees, or null to
// skip it (the header separator, a blank line, a chunk cut mid-line, a JSON object
// that is not an event, a non-durable event — and a legacy memory line an older
// build wrote, kept and read as a note).
function recordAt(lineno, raw) {
  const line = stripBytes(raw);
  if (!line.length) return null;
  if (startsWithBytes(line, Buffer.from("---"))) return null;
  if (startsWithBytes(line, SECTION_BYTES)) return null;
  let data;
  try {
    data = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.prototype.hasOwnProperty.call(data, "type")) {
    let event;
    try {
      event = eventFromDict(data);
    } catch (error) {
      if (error instanceof ValueError || error instanceof TypeError) return null;
      throw error;
    }
    if (!DURABLE_TYPES.has(event.type)) return null;
    const text = eventText(event);
    if (!text) return null;
    return { line: lineno, type: event.type, stamp: stampOf(event.timestamp), text };
  }
  const title = data.title;
  if (typeof title === "string" && title) {
    const content = data.content;
    const body = typeof content === "string" ? content : "";
    return { line: lineno, type: "note", stamp: "", text: `[Note] ${title}: ${body}` };
  }
  return null;
}

// `time.strftime("%m-%d %H:%M", time.localtime(ev.timestamp or 0))` — LOCAL time,
// because that is what the Python host printed. A test that compares goldens pins
// `TZ` for both sides.
function stampOf(timestamp) {
  const seconds = timestamp === undefined || timestamp === null || timestamp === 0 ? 0 : Number(timestamp);
  const when = new Date(Math.trunc(seconds) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

// `recall._scan`: every readable line of the WHOLE log, in file order, streamed
// from disk chunk by chunk. Line numbers count what a reader SEES, which is what
// makes `grep_memory`'s line numbers and `read_memory`'s `offset` one numbering.
async function* scan(log, cancel) {
  let lo = logStart(log);
  const end = logBytes(log);
  let lineno = 0;
  let carry = Buffer.alloc(0);
  while (lo < end) {
    if (cancelled(cancel)) return;
    const chunk = await log.readRaw(lo, Math.min(lo + CHUNK, end));
    if (!chunk || !chunk.length) return; // the file shrank under us
    lo += chunk.length;
    const joined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const pieces = [];
    let from = 0;
    for (let at = 0; at < joined.length; at += 1) {
      if (joined[at] === 0x0a) {
        pieces.push(joined.subarray(from, at));
        from = at + 1;
      }
    }
    if (lo < end) carry = joined.subarray(from);
    else {
      if (from < joined.length) pieces.push(joined.subarray(from));
      carry = Buffer.alloc(0);
    }
    for (const raw of pieces) {
      const rec = recordAt(lineno + 1, raw);
      if (rec) {
        lineno = rec.line;
        yield rec;
      }
    }
  }
  if (carry.length) {
    const rec = recordAt(lineno + 1, carry);
    if (rec) yield rec;
  }
}

// `recall._name`: the log's own file name (a remote path is not this machine's).
function logName(log) {
  const path = String(log && log.path ? log.path : "").replace(/\\/g, "/");
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base || "project log";
}

function noLog() {
  return envelope("ERROR: this session has no project log to read — no project is open.", {
    error: true,
  });
}

// `fnmatch.fnmatchcase`: `*`, `?` and `[seq]` / `[!seq]`, matched against the whole
// name. Deliberately not `path.matchesGlob` (that is not on the far-root host's
// allowlist) and not a path matcher: an event TYPE has no separators.
function fnmatchCase(name, pattern) {
  const source = String(pattern);
  let re = "^";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "*") {
      re += "[\\s\\S]*";
      index += 1;
    } else if (ch === "?") {
      re += "[\\s\\S]";
      index += 1;
    } else if (ch === "[") {
      let at = index + 1;
      let negate = false;
      if (source[at] === "!") {
        negate = true;
        at += 1;
      }
      let inner = "";
      if (source[at] === "]") {
        inner += "\\]";
        at += 1;
      }
      let closed = -1;
      for (; at < source.length; at += 1) {
        if (source[at] === "]") {
          closed = at;
          break;
        }
        inner += source[at] === "\\" ? "\\\\" : source[at];
      }
      if (closed < 0) {
        re += "\\[";
        index += 1;
        continue;
      }
      re += `[${negate ? "^" : ""}${inner}]`;
      index = closed + 1;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
    }
  }
  re += "$";
  return new RegExp(re, "u").test(name);
}

// A `grep_memory` pattern: Python's `re` accepts a leading global flag group that
// JavaScript spells as constructor flags. `(?i)` is the one the tool's own prose
// teaches, so it must keep working; the others ride along. Every other difference
// between the two engines is the engine's (documented at the top of this file).
const INLINE_FLAGS = /^\(\?([aiLmsux]+)\)/;

function compilePattern(pattern) {
  let source = String(pattern);
  let flags = "m"; // recall.py compiles with re.MULTILINE
  const found = INLINE_FLAGS.exec(source);
  if (found) {
    const letters = found[1];
    if (letters.includes("x")) {
      throw new SyntaxError("the verbose flag (?x) is not available on this host");
    }
    if (letters.includes("i")) flags += "i";
    if (letters.includes("s")) flags += "s";
    if (letters.includes("m")) flags += "m";
    source = source.slice(found[0].length);
  }
  return new RegExp(source, flags);
}

// `recall._tag`: type and, when the file recorded one, a timestamp. A legacy note
// has no time of its own, so it carries the type only.
function tagOf(rec) {
  return rec.stamp ? `${rec.type} ${rec.stamp}` : rec.type;
}

// `recall._hit`: the line INSIDE an event that matched (or its first line when the
// match spans lines), clipped — a hit is a pointer to a line, not the transcript.
function hitOf(text, rx) {
  const lines = splitLines(text);
  let line = lines.find((candidate) => rx.test(candidate));
  if (line === undefined) line = lines.length ? lines[0] : text;
  line = pyStrip(line);
  return pyLen(line) <= HIT_CHARS ? line : `${pySlice(line, 0, HIT_CHARS)}…`;
}

// `recall.grep_memory`: find the lines of the project log that match a regular
// expression, projected through `events.event_text` so a hit is readable.
async function grepMemory(_workspace, _config, args = {}, ctx = {}) {
  const log = ctx.log;
  if (!log || !String(log.path || "")) return noLog();
  const pattern = String(args.pattern === undefined || args.pattern === null ? "" : args.pattern);
  let rx;
  try {
    rx = compilePattern(pattern);
  } catch (error) {
    return envelope(`ERROR: ${repr(pattern)} is not a valid regular expression: ${errorTextOf(error)}`, {
      error: true,
    });
  }
  const include = args.include === undefined || args.include === null ? "" : String(args.include);
  const wanted = pyTruthy(args.max_hits) ? args.max_hits : 20;
  const maxHits = Math.max(1, Math.min(pyInt(wanted, "max_hits must be an integer"), 200));

  const hits = [];
  let scanned = 0;
  let stopped = false;
  for await (const rec of scan(log, ctx.cancel)) {
    scanned = rec.line;
    if (include && !fnmatchCase(rec.type, include)) continue;
    if (!rx.test(rec.text)) continue;
    hits.push(`line ${rec.line}: [${tagOf(rec)}] ${hitOf(rec.text, rx)}`);
    if (hits.length >= maxHits) {
      stopped = true;
      break;
    }
  }
  let head = `${logName(log)}: /${pattern}/`;
  if (include) head += ` in ${include}`;
  if (!hits.length) return envelope(`${head} — no line matches (${scanned} lines scanned)`);
  const out = [head, "", ...hits, ""];
  if (stopped) {
    out.push(
      `(stopped at max_hits=${maxHits}; raise it or narrow the pattern — ${scanned}+ lines scanned)`
    );
  } else {
    out.push(`(${hits.length} hits, ${scanned} lines scanned)`);
  }
  return envelope(out.join("\n"));
}

// `recall._body`: one event's text, clipped for a page.
function bodyOf(text) {
  if (pyLen(text) <= EVENT_CHARS) return [text, false];
  return [pySlice(text, 0, EVENT_CHARS), true];
}

// `recall.read_memory`: a page of the project log by 1-based line number. With no
// `offset` the page is the TAIL (what a session resuming a long log needs first);
// with one it starts at any line `grep_memory` named.
async function readMemory(_workspace, _config, args = {}, ctx = {}) {
  const log = ctx.log;
  if (!log || !String(log.path || "")) return noLog();
  const wantedLimit = pyTruthy(args.limit) ? args.limit : 40;
  const limit = Math.max(1, Math.min(pyInt(wantedLimit, "limit must be an integer"), 200));
  if (args.offset !== undefined && args.offset !== null && pyInt(args.offset, "offset must be an integer") < 1) {
    return envelope("ERROR: offset is a 1-based line number (1 is the first line).", { error: true });
  }
  const start = args.offset === undefined || args.offset === null ? null : pyInt(args.offset, "offset must be an integer");
  // no offset: the newest `limit` lines, as they stream past
  const tail = [];
  // a named offset: the page from there on, within the same budget
  const page = [];
  let total = 0;
  for await (const rec of scan(log, ctx.cancel)) {
    total = rec.line;
    if (start === null) {
      tail.push(rec);
      if (tail.length > limit) tail.shift();
    } else if (rec.line >= start && page.length < limit) {
      page.push(rec);
    }
  }
  const records = start === null ? tail : page;
  if (start !== null && !records.length) {
    return envelope(
      `ERROR: offset ${start} is past the end of ${logName(log)} (the log has ${total} lines).`,
      { error: true }
    );
  }
  if (!records.length) return envelope(`${logName(log)}: the log has no readable lines yet.`);
  let first = records[0].line;
  let last = records[records.length - 1].line;
  const out = [`${logName(log)}: lines ${first}-${last} of ${total}`, ""];
  let used = 0;
  for (let at = 0; at < records.length; at += 1) {
    const rec = records[at];
    const [body, cut] = bodyOf(rec.text);
    if (at > 0 && used + pyLen(body) > PAGE_CHARS) {
      last = records[at - 1].line;
      break;
    }
    out.push(`line ${rec.line}  [${tagOf(rec)}]`);
    out.push(body + (cut ? `\n[cut at ${EVENT_CHARS} chars]` : ""));
    out.push("");
    used += pyLen(body);
  }
  const hints = [];
  if (last < total) hints.push(`offset=${last + 1} to continue`);
  if (first > 1) hints.push(`offset=${Math.max(1, first - limit)} for earlier lines`);
  out.push(
    `(showing lines ${first}-${last} of ${total}` +
      (hints.length ? `; ${hints.join(", ")}` : "; the whole log") +
      ")"
  );
  return envelope(out.join("\n"));
}

module.exports = {
  // the envelope and the Python spellings it needs
  envelope,
  pyStrip,
  pyLen,
  pySlice,
  pyRepr,
  pyTruthy,
  pyInt,
  pyFloat,
  splitLines,
  splitMaxSplit,
  truncate,
  // the vocabulary (catalog.py / gates.py)
  DEFAULT_UI,
  UI_KEYS,
  DEFAULT_ACCESS,
  ACCESS_WORDS,
  ACCESS_ARGS,
  GATE_WORDS,
  GATES,
  WATCHED_ACCESS,
  HOST_NAME,
  HOST_TOOL_NAMES,
  CONFIG_DEFAULTS,
  // `Config.<field>` or its default: the ONE place a config hole is filled, so a
  // caller that needs a host fact (`orient.js` asks for `commandTimeout`) reads it
  // the same way the tools in this file do rather than repeating the fallback.
  setting,
  // the host's own tools (host.py / shell.py / recall.py)
  hostDeclarations,
  runCommand,
  grepMemory,
  readMemory,
  classifyCommand,
  tokenize,
  blockedReason,
  failureEnvelope,
  // the wiring (registry.py / gates.py / filesystem.py)
  uiOf,
  createGuards,
  declarationOf,
  systemTool,
  extensionTool,
  wireTool,
  buildTools,
  createRegistry,
  gateOk,
  gateProject,
  gateSkills,
  // recall's pure pieces, asserted directly by the tests
  fnmatchCase,
  compilePattern,
  recordAt,
  scan,
  logName,
  tagOf,
  hitOf,
  CHUNK,
  EVENT_CHARS,
  PAGE_CHARS,
  HIT_CHARS,
};
