// The model-facing tool surface, derived HERE (host side), from declarations.
//
// What the model may call, what each call looks like in the page, and which
// argument of it named a file are three readings of ONE thing: the declaration a
// component ships in its own component.json (plus the seven the host declares for
// itself, agent/tools/host.py). This module is that reading — the host's, on the
// user's own machine — so the session machine is not asked what a tool is, only
// to run a call (POST /api/exec) and to keep the log (P2).
//
// It is the same reading the Python half still makes (agent/tools/catalog.py,
// agent/tools/registry.py) while both exist: P4 deletes that copy, and until then
// tests/tool-decl.test.js pins the two answers to each other over the real
// manifests. Nothing here decides whether a call may RUN — that is the execution
// layer's, once, in agent/core/permission.py (D3); `access` is only carried
// through so the frontend knows which argument a declaration named.
//
// The inputs are data and nothing else, so a test can wire it to a literal:
//
//   createTools({
//     declarations,          every raw manifest this machine holds, in merge
//                            order (lowest precedence first) — the files
//                            themselves, never a pre-parsed tool
//     available,             {name: true} — this machine can drive that component
//                            (rendezvous.available: its code is here and its
//                            `requires` hold). A fact about the machine, so it is
//                            the one thing a declaration cannot say itself
//     config,                this machine's values, for `$config.<field>`
//     backends,              the configured search-backend chain, for `$backends`
//     facts,                 published host facts already answered, for `$<fact>`
//     project,               whether a project log is open (the `project` gate)
//     mode,                  "work" / "chat"
//     host,                  {ui, access, gates} — the machine's own tables
//                            (~/.clutch/host.json merged over the built-ins)
//     prose(name, mode),     the host's own model-facing text for one of its tools
//     warn(message),         one line per refused declaration, once each
//   }) -> {schemas, ui, pathArg, names, diagnostics}
//
// `schemas()` is asked on every model call and `ui()` / `pathArg()` on every
// chosen call: enabling or disabling a component between two steps of one turn is
// then really in force, because nothing here is memoized.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- vocabulary --
//
// The host's own words. A declaration may use these and nothing else; a word the
// host does not know is REFUSED rather than guessed at, because the alternative
// is a tool that runs unguarded (`access`), is offered when it cannot run
// (`gate`), or looks like nothing its author meant (`ui`).

// What the UI does with a tool that declares no `ui` block. The machine's own
// document may override any of these (host.json, agent/tools/hostconfig.py); the
// table is only the built-in answer.
const DEFAULT_UI = {
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
};

// `mutates` is not a default: the HOST derives it when the declaration leaves it
// out (a write, or one of the host's own tools), which is why it is a key the
// renderer knows but the table does not hold.
const UI_KEYS = [...Object.keys(DEFAULT_UI), "mutates"];

// `access` -> the argument that policy judges when the declaration does not name
// one (`access_arg`). The POLICY itself is the execution layer's (D3); here only
// the argument name is read, because `path_arg` — the argument in which a call
// NAMED a file — is what the context reader after a compaction re-reads
// (ui/context.js).
const DEFAULT_ACCESS = {
  read: { arg: "path" },
  sweep: { arg: "path" },
  write: { arg: "path" },
  command: { arg: "command" },
};
const WATCHED_ACCESS = new Set(["read", "write"]);

// `gate` -> the condition behind it. "" and "always" are structural (no
// condition) and are therefore never in a table.
const DEFAULT_GATES = { project: "project" };
const MODES = ["work", "chat"];
const FACILITIES = ["python", "posix-shell", "curl"];

// The words a declaration used before "where a statement runs" became a
// DERIVATION from what it contributes. Nothing reads them for meaning; a manifest
// that still carries one is refused by name, because reading it whichever way
// this host can guess would run a statement on a machine its author did not mean.
const RETIRED_WORDS = ["interface", "runs_on"];

// The host's own four execution tools (agent/tools/host.py) — the ones this
// machine's execution layer performs. They are declarations like a
// component's — same shape, same parser, same diagnostics — and they are here
// because they are the host's, not a component's; their model-facing text is the
// host's own prose file. `host: true` is the one field a component's declaration
// never has: the implementation is host code, not a statement, which is what the
// two derived UI facts below are read from.
const HOST_DECLARATIONS: any[] = [
  {
    name: "run_command",
    parameters: {
      properties: { command: { type: "string", description: "shell command string to run" } },
      required: ["command"],
    },
    access: "command",
    ui: { preview: "command" },
    host: true,
  },
  {
    // The same command text, waited on: `host: true` like run_command, because
    // the execution layer is what runs it (agent/tools/shell.py:run_trigger) —
    // it is host code with a longer clock, not a client-side tool.
    name: "trigger",
    parameters: {
      properties: {
        command: {
          type: "string",
          description:
            "shell command string to run; the loop waits for it to finish (up to six hours) " +
            "instead of the command tool's short budget",
        },
      },
      required: ["command"],
    },
    access: "command",
    ui: { preview: "command", summary: "trigger {command}" },
    host: true,
  },
  {
    name: "grep_memory",
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
    access: "",
    gate: "project",
    ui: {
      group: "memory",
      form: "row",
      summary: "grep memory /{pattern}/",
      preview: { mode: "content", keys: ["pattern"] },
      collapse: "long",
    },
    host: true,
  },
  {
    name: "read_memory",
    parameters: {
      properties: {
        offset: { type: "integer", description: "1-based line to start at (omit for the newest lines)" },
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
    host: true,
  },
];
// The three tools the CLIENT answers (agent/tools/host.py
// `_CLIENT_NATIVE_DECLARATIONS`, same data). They are declared here, on the
// client, because that is where they run: the loop dispatches them itself
// (ui/src/host/client-tools.ts) and never asks the execution layer, so this is
// the only place their schema can come from. They are offered exactly like the
// host's own above — same parser, same diagnostics, same prose convention — and
// their names are reserved the same way (HOST_TOOL_NAMES below), because a
// component publishing `sleep` would be two implementations of one promise.
//
// They carry no `host: true`: that flag says "the implementation is host code,
// not a statement", and the two derived UI facts read from it (a mutating call)
// would then call `sleep` a write. The implementation is the client's, and it
// mutates nothing.
const CLIENT_NATIVE_DECLARATIONS: any[] = [
  {
    name: "sleep",
    parameters: {
      properties: {
        seconds: {
          type: "number",
          description:
            "how long to suspend the loop, in seconds (at most 3600; 0 is refused — use start_tick for a heartbeat)",
        },
      },
      required: ["seconds"],
    },
    access: "",
    ui: { group: "time", form: "row", summary: "sleep {seconds}s", collapse: "never", chrome: "quiet" },
  },
  {
    name: "start_tick",
    parameters: {
      properties: { seconds: { type: "number", description: "seconds between ticks (at least 1)" } },
      required: ["seconds"],
    },
    access: "",
    ui: {
      group: "time",
      form: "row",
      summary: "start tick every {seconds}s",
      collapse: "never",
      chrome: "quiet",
    },
  },
  {
    name: "end_tick",
    parameters: { properties: {}, required: [] },
    access: "",
    ui: { group: "time", form: "row", summary: "end tick", collapse: "never", chrome: "quiet" },
  },
];

// The host's whole own surface, in the order the model sees it: the four
// bootstrap tools, then the three the client answers. A session always has all
// seven (the log readers' `project` gate is the only filter).
const HOST_DECLARATIONS_ALL = HOST_DECLARATIONS.concat(CLIENT_NATIVE_DECLARATIONS);
const HOST_TOOL_NAMES = HOST_DECLARATIONS_ALL.map((d) => d.name);
const CLIENT_NATIVE_TOOL_NAMES = CLIENT_NATIVE_DECLARATIONS.map((d) => d.name);

// The host's own prose for one of its tools: `tools/<name>.md`, or the `_chat`
// file when the session is in chat mode (agent/tools/host.py:_prose). The files
// are staged beside this module exactly as the loop's own prompts are, and
// tests/prompt.test.js keeps them byte-identical to agent/prompts/tools/ until P4.
//
// The client's three say the same thing in both modes (they are not conditional
// on the session's mode), so they are one file each.
function hostProse(name, mode) {
  const single = CLIENT_NATIVE_TOOL_NAMES.includes(name);
  const file = mode === "chat" && !single ? `${name}_chat.md` : `${name}.md`;
  if (file !== path.basename(file)) throw new TypeError(`tool-decl: "${file}" is not a prose file name`);
  return fs.readFileSync(path.join(__dirname, "prompts", "tools", file), "utf8");
}

// --------------------------------------------------------------- declaration --

// One raw `tools` entry -> a tool, or null when it names no usable one. A
// declaration the host cannot read as written is absent, never garbled: a
// description is the model-facing string, and one that is not text would be a
// sentence the model reads and cannot trust.
function toolOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = String(raw.name === undefined ? "" : raw.name);
  const description = raw.description === undefined ? "" : raw.description;
  if (!name || typeof description !== "string") return null;
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  return {
    name,
    description,
    parameters: obj(raw.parameters) || {},
    command: raw.command || null,
    defaults: obj(raw.defaults) || {},
    access: String(raw.access || ""),
    access_arg: String(raw.access_arg || ""),
    snapshot: Boolean(raw.snapshot),
    snapshot_arg: String(raw.snapshot_arg || ""),
    modes: Array.isArray(raw.modes) ? raw.modes.map((m) => String(m)) : raw.modes === undefined ? MODES : [],
    gate: String(raw.gate || ""),
    ui: obj(raw.ui) || {},
    host: Boolean(raw.host),
  };
}

// One declaration dict -> a component, or null when it is not one (no name).
//
// What a component CONTRIBUTES is the whole answer to where its statements run,
// and it is read out of the declaration, not out of a word: a `service` = a
// process that STAYS here, a `launch` alone = a process this host starts per
// call, neither = no process here at all (so any statement is the client's).
function componentOf(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const name = String(data.name === undefined ? "" : data.name);
  if (!name) return null;
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  const rawTools = Array.isArray(data.tools) ? data.tools : [];
  const tools = [];
  for (const raw of rawTools) {
    const spec = toolOf(raw);
    if (spec) tools.push(spec);
  }
  const launch = obj(data.launch) || {};
  const declared = {
    name,
    retired: RETIRED_WORDS.filter((w) => Object.prototype.hasOwnProperty.call(data, w)),
    subject: String(data.subject === undefined ? "workspace-fs" : data.subject),
    launch: {
      argv: Array.isArray(launch.argv) ? launch.argv.map((w) => String(w)) : [],
      entry: String(launch.entry || ""),
      binary: String(launch.binary || ""),
      importable: Boolean(launch.importable),
    },
    // `service: {}` is a declaration too — its three fields have defaults, so the
    // PRESENCE of the key decides, never its truthiness.
    service: serviceOf(data),
    entry: String(data.entry || ""),
    requires: (Array.isArray(data.requires) ? data.requires : []).map((r) => String(r)),
    vars: Object.entries(obj(data.vars) || {}).map(([k, v]) => [String(k), String(v)]),
    facts: {},
    tools,
  };
  const facts = obj(data.facts) || {};
  for (const [k, v] of Object.entries(facts)) {
    const statement = String(v || "").trim();
    if (statement) declared.facts[String(k)] = statement; // a blank line is not an answer
  }
  return declared;
}

// The legacy spelling of `service`: the same three keys at the top level, still
// read because a release published before this host learned the block is still on
// someone's machine and keeps driving exactly as it did.
const LEGACY_SERVICE_KEYS = ["discovery_env", "app_dir", "prefix"];

function serviceOf(data) {
  let raw = data.service;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (!LEGACY_SERVICE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(data, k))) return null;
    raw = data;
  }
  return {
    discovery_env: String(raw.discovery_env || ""),
    app_dir: String(raw.app_dir || ""),
    prefix: String(raw.prefix || ""),
  };
}

const launchDeclared = (c) => Boolean(c.launch.argv.length || c.launch.entry || c.launch.binary || c.launch.importable);
const resident = (c) => c.service !== null;
const runsHere = (c) => resident(c) || launchDeclared(c);
const clientSide = (c) => !runsHere(c);

// The fields a registration may NAME, and therefore override, when a later
// source refines the same component. Every one of them carries when it is left
// out; naming an empty list is a declaration saying "none", which is why the
// merge is judged on the raw JSON ("named means override") rather than on the
// parsed values.
const COMPONENT_FIELDS = ["retired", "subject", "launch", "service", "entry", "requires", "vars", "facts", "tools"];
const LAUNCH_FIELDS = ["argv", "entry", "binary", "importable"];

function namedKeys(data, names: string[]): Set<string> {
  return new Set(names.filter((k) => Object.prototype.hasOwnProperty.call(data, k)));
}

// One later registration merged over the component it refines. `launch` is merged
// at ITS field level for the same reason one level up: a thin manifest naming only
// `binary` keeps the earlier `argv` and `entry` instead of restating them.
//
// `retired` accumulates rather than being overridden: a retired word is a fact
// about the SOURCE it was written in, so a checkout that still spells `interface`
// stays refused even after an installed manifest refines it.
function refine(known, declared, data) {
  const named = namedKeys(data, COMPONENT_FIELDS);
  const out = { ...known };
  for (const field of named) {
    if (field === "name" || field === "retired") continue;
    if (field === "launch") {
      const raw = data.launch && typeof data.launch === "object" && !Array.isArray(data.launch) ? data.launch : {};
      const inner = namedKeys(raw, LAUNCH_FIELDS);
      const launch = { ...known.launch };
      for (const k of inner) launch[k] = declared.launch[k];
      out.launch = launch;
      continue;
    }
    out[field] = declared[field];
  }
  if (!named.has("service") && LEGACY_SERVICE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(data, k))) {
    out.service = declared.service;
  }
  out.retired = [...new Set([...known.retired, ...declared.retired])];
  return out;
}

// Every registration, merged by name, in first-seen order — the components this
// host may drive at all. There is no base catalog: with nothing registered the
// table is empty and the host's own seven tools are its whole surface.
function tableOf(declarations) {
  const out = new Map();
  for (const data of declarations || []) {
    const declared = componentOf(data);
    if (!declared) continue;
    const known = out.get(declared.name);
    out.set(declared.name, known ? refine(known, declared, data) : declared);
  }
  return [...out.values()];
}

// --------------------------------------------------------- declaration checks --

// A host-defined word a declaration used that this host does not know. The
// direction is fail-CLOSED: the affected tools are not offered at all, because an
// unknown `access` would leave a tool unguarded and an unknown `gate`/`mode`
// leaves the host unable to answer the question the word asks. `fatal: false` is
// for a cosmetic word (a `ui` key no renderer knows): the tool works, it just
// looks plainer than its author meant.
function toolDiagnostics(component, spec, host) {
  const out = [];
  const declared =
    spec.parameters && typeof spec.parameters === "object" && spec.parameters.properties
      ? spec.parameters.properties
      : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(declared, k);
  if (spec.access && !Object.prototype.hasOwnProperty.call(host.access, spec.access)) {
    out.push(
      diagnostic(component, spec.name, `unknown access '${spec.access}' (host knows ${known(Object.keys(host.access))})`)
    );
  }
  if (!host.gates.has(spec.gate) && !host.facts.has(spec.gate)) {
    // "" is a valid gate (no gate) and never worth naming back at the tool. A
    // published fact is a gate too: "that fact has something in it" is a
    // condition the declaration defines and the host can answer.
    const words = known([...host.gates, ...host.facts].filter(Boolean));
    out.push(diagnostic(component, spec.name, `unknown gate '${spec.gate}' (host knows ${words})`));
  }
  for (const mode of spec.modes) {
    if (!MODES.includes(mode)) {
      out.push(diagnostic(component, spec.name, `unknown mode '${mode}' (host offers ${known(MODES)})`));
    }
  }
  for (const arg of [spec.access_arg, spec.snapshot_arg]) {
    if (arg && !has(arg)) {
      out.push(diagnostic(component, spec.name, `argument '${arg}' is not among the tool's declared parameters`));
    }
  }
  for (const key of Object.keys(spec.ui)) {
    if (!UI_KEYS.includes(key)) {
      out.push(diagnostic(component, spec.name, `unknown ui key '${key}' (renderer knows ${known(UI_KEYS)})`, false));
    }
  }
  return out;
}

function diagnostic(component, tool, message, fatal = true) {
  return { component, tool, message, fatal };
}

function known(words) {
  return words.map((w) => `'${w}'`).join(", ");
}

// A `facts` token is a word this host can carry: a bare name, and not one it
// already means — the two words a placeholder spends itself, and the gates this
// machine honors. Whether anyone ANSWERS it is a question about the table, not
// about the word, so a supplier may still be installed later.
const FACT_NAME = /^[a-z][a-z0-9_]*$/;
function reserved(host) {
  return ["backends", ...host.gates].filter(Boolean);
}
function publishable(token, host) {
  return FACT_NAME.test(token) && !reserved(host).includes(token);
}

// Every host word a component's declaration read wrongly, its tools' too.
function componentDiagnostics(c, host) {
  const out = [];
  for (const f of c.requires) {
    if (!FACILITIES.includes(f)) {
      out.push(diagnostic(c.name, "", `unknown facility in requires: '${f}' (host knows ${known(FACILITIES)})`));
    }
  }
  // `entry` is the module the CLIENT runs for a component with no process here;
  // naming it beside a process on this host is one declaration speaking two
  // languages — refused rather than half-read, because either reading would run a
  // statement on a machine its author did not mean.
  for (const word of c.retired) {
    out.push(
      diagnostic(
        c.name,
        "",
        `a component still declares \`${word}\`, a word this host no longer reads: where a statement runs is ` +
          `derived from what the declaration CONTRIBUTES (\`service\`/\`launch\` = a process on this host, ` +
          `\`entry\` = the client's own module), so drop the word and declare the contribution`
      )
    );
  }
  if (c.entry && runsHere(c)) {
    const which = resident(c) ? "`service`" : "`launch`";
    out.push(
      diagnostic(
        c.name,
        "",
        `a component declares \`entry\` and ${which}: \`entry\` is the module the CLIENT runs for a component ` +
          `with no process here, and ${which} starts one on this host`
      )
    );
  }
  const hostsFact = new Set();
  for (const token of Object.keys(c.facts)) {
    if (!publishable(token, host)) {
      out.push(
        diagnostic(
          c.name,
          "",
          `illegal fact '${token}': a published host fact is a bare name ([a-z][a-z0-9_]*) and not a word this ` +
            `host already means (${known(reserved(host))})`
        )
      );
      continue;
    }
    hostsFact.add(token);
    if (resident(c)) {
      out.push(
        diagnostic(
          c.name,
          "",
          `a component whose service answers cannot publish the host fact '${token}': a service's statement ` +
            `belongs to one workspace, and a host fact belongs to none`
        )
      );
    } else if (clientSide(c)) {
      out.push(
        diagnostic(
          c.name,
          "",
          `a component whose statement is the client's cannot publish the host fact '${token}': its statements ` +
            `run there, and a host fact is answered here`
        )
      );
    }
  }
  for (const spec of c.tools) {
    const declared =
      spec.parameters && typeof spec.parameters === "object" && spec.parameters.properties
        ? spec.parameters.properties
        : {};
    for (const [key] of c.vars) {
      if (Object.prototype.hasOwnProperty.call(declared, key)) {
        out.push(
          diagnostic(
            c.name,
            spec.name,
            `vars key '${key}' is also an argument of this tool: the host's value would shadow the model's, so ` +
              `rename one of them`
          )
        );
      }
    }
    if (HOST_TOOL_NAMES.includes(spec.name)) {
      out.push(
        diagnostic(
          c.name,
          spec.name,
          `tool name '${spec.name}' is the host's own (the host always offers it), so a component cannot publish ` +
            `it — rename this tool`
        )
      );
    }
    if (clientSide(c) && !spec.command) {
      out.push(
        diagnostic(
          c.name,
          spec.name,
          "a tool of a component whose statements are the client's must carry a command: it IS the statement the " +
            "client declared, and a tool without one names nothing this host could ask the client to run"
        )
      );
    }
    out.push(...toolDiagnostics(c.name, spec, host));
  }
  return out;
}

// ------------------------------------------------------- the host's answers ---
//
// A declaration never carries this machine's own values: it NAMES what it wants to
// know (`$config.<field>`, `$backends`, and any fact a component publishes) and the
// host answers while the schema is built. Reading a placeholder is SYNTAX — a `$`
// and a name — and what the name means is settled where it is answered, so a fact
// published tomorrow needs no edit here. A value that IS a fact keeps its own shape
// (an enum stays a list, a knob keeps its type); the same token inside a sentence
// is spelled out.

const PLACEHOLDER = /\$([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)/g;
const WHOLE = /^\$([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)$/;

function resolve(value, answers) {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    // A whole `$<name>` names a published fact — except the host's own two words,
    // which answer with their own shape just below.
    if (whole && whole[1] !== "backends" && !whole[1].startsWith("config.")) {
      return factNames(whole[1], answers).slice();
    }
    if (value.startsWith("$config.")) {
      const key = value.slice("$config.".length);
      return Object.prototype.hasOwnProperty.call(answers.config, key) ? answers.config[key] : "";
    }
    return value.replace(PLACEHOLDER, (_m, token) => factText(token, answers));
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, answers));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, answers);
    return out;
  }
  return value;
}

// One placeholder read INSIDE a sentence: the fact as prose, never a list.
function factText(token, answers) {
  if (token.startsWith("config.")) {
    const key = token.slice("config.".length);
    return Object.prototype.hasOwnProperty.call(answers.config, key) ? String(answers.config[key]) : "";
  }
  if (token === "backends") return answers.backends.length ? answers.backends.join(" or ") : "none";
  // anything else names a published fact, or no value at all: a name nobody
  // publishes is never a guess, and never a `$` left standing in the text.
  const names = factNames(token, answers);
  return names.length ? names.join(", ") : "none";
}

// The names a published fact offers right now. No answer (a fact this machine
// could not read) is fail-CLOSED — nothing to pick from, never a guess — and the
// gate that depends on it shuts with it.
function factNames(token, answers) {
  const value = answers.facts[token];
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

// A tool's presentation, the machine's defaults filled in. This is the one place
// a declaration's UI keys are read, so a renderer can never see a half-specified
// block.
function uiOf(spec, defaults) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(spec.ui || {})) {
    if (UI_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

function schemaOf(tool) {
  const parameters = tool.parameters && typeof tool.parameters === "object" ? tool.parameters : {};
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: parameters.properties || {},
        required: parameters.required || [],
      },
    },
  };
}

// ------------------------------------------------------------------- the port --

// One refusal said once per process, like registry._report: a typo in a manifest
// is a fact about that file, not something to repeat on every turn. Module-level
// on purpose — `createTools` is built afresh each time the surface changes, and a
// per-instance memory would say the same thing again on the next turn.
const REPORTED = new Set();

function createTools(input) {
  const opts = input || {};
  const declarations = opts.declarations || [];
  const available = opts.available || {};
  const answers = {
    config: opts.config && typeof opts.config === "object" ? opts.config : {},
    backends: Array.isArray(opts.backends) ? opts.backends.map((b) => String(b)) : [],
    facts: opts.facts && typeof opts.facts === "object" ? opts.facts : {},
  };
  const machine = opts.host && typeof opts.host === "object" ? opts.host : {};
  // The table once: what the gate vocabulary is read from below is the same table
  // the surface is built out of, so the two can never disagree about a fact.
  const table = tableOf(declarations);
  const published = new Set();
  for (const component of table) for (const token of Object.keys(component.facts)) published.add(token);
  const host = {
    ui: machine.ui && typeof machine.ui === "object" ? machine.ui : DEFAULT_UI,
    access: machine.access && typeof machine.access === "object" ? machine.access : DEFAULT_ACCESS,
    gates: new Set(["", "always", ...(machine.gates === undefined ? Object.keys(DEFAULT_GATES) : Object.keys(machine.gates))]),
    // A published fact is a condition a declaration defines: "that fact has
    // something in it". The host knows one condition of its own and inherits
    // every other one from the table.
    facts: published,
  };
  const mode = opts.mode === undefined ? "work" : String(opts.mode);
  const project = Boolean(opts.project);
  const prose = typeof opts.prose === "function" ? opts.prose : hostProse;
  const warn = typeof opts.warn === "function" ? opts.warn : null;

  // One refusal said once per process, like registry._report (REPORTED above).
  function say(diags) {
    if (!warn) return;
    for (const d of diags) {
      const key = `${d.component}\u0000${d.tool}\u0000${d.message}`;
      if (REPORTED.has(key)) continue;
      REPORTED.add(key);
      const where = d.tool ? `${d.component}/${d.tool}` : d.component || "the catalog";
      // A cosmetic word is not a refusal: the tool works, it just looks plainer
      // than its author meant — said as a warning, once, and not withheld.
      warn(`${d.fatal ? "refusing" : "ignoring"} ${where}: ${d.message}`);
    }
  }

  // A word this machine does not honor shuts the gate: an unreadable condition is
  // not "always true". A word that is not one of the machine's own gates but IS a
  // published fact is answered by that fact — open while it offers a name, shut
  // when it is empty, which is how a component's own off switch reaches the tools
  // and the prompt it carries.
  function gateOk(word) {
    if (word === "" || word === "always") return true;
    if (host.gates.has(word)) return word === "project" ? project : false;
    return host.facts.has(word) && factNames(word, answers).length > 0;
  }

  // Wire one declaration: the model-facing text and schema with this machine's
  // facts filled in, the policy word carried, and the presentation completed with
  // the two facts a declaration does not have to say (see ui()).
  function wire(spec) {
    const rule = Object.prototype.hasOwnProperty.call(host.access, spec.access) ? host.access[spec.access] : null;
    return {
      name: spec.name,
      description: resolve(spec.description, answers),
      parameters: resolve(spec.parameters, answers),
      access: spec.access,
      access_arg: spec.access_arg || (rule && rule.arg) || "",
      snapshot: spec.snapshot,
      modes: spec.modes,
      gate: spec.gate,
      ui: uiOf(spec, host.ui),
      host: Boolean(spec.host),
    };
  }

  const tools = new Map(); // insertion order is the schema order
  const diagnostics = [];

  // The host's own tools come first, and are always here: a word the host itself
  // cannot honor is a host bug (its own declaration is data, so it is checked like
  // any other), and there is nothing for the model to fall back on if it is wrong.
  // The client's three are in the same group for the same reason — the loop answers
  // them itself, so no component and no execution layer is involved in offering
  // them.
  for (const declared of HOST_DECLARATIONS_ALL) {
    const spec = toolOf({ ...declared, description: prose(declared.name, mode) });
    const fatal = toolDiagnostics("clutch-host", spec, host).filter((d) => d.fatal);
    if (fatal.length) {
      throw new Error(`tool-decl: the host's own ${declared.name} declaration is invalid: ${fatal.map((d) => d.message).join("; ")}`);
    }
    // A host declaration carries `modes` like a component's, and a name it does
    // not offer in this mode is not offered at all.
    if (!spec.modes.includes(mode)) continue;
    if (!gateOk(spec.gate)) continue;
    const wired = wire(spec);
    tools.set(wired.name, wired);
  }

  // Then every component this machine can drive. One filter for the whole surface:
  // a declaration with ANY fatal word contributes nothing, and neither does a
  // component whose code is not here. Every diagnostic is kept — fatal ones for
  // what is withheld, cosmetic ones so a manifest that targets a newer renderer
  // is a sentence someone can read rather than a tool that quietly looks plainer.
  for (const component of table) {
    const diags = componentDiagnostics(component, host);
    diagnostics.push(...diags);
    say(diags);
    if (diags.some((d) => d.fatal)) continue;
    if (available[component.name] !== true) continue;
    // No machine filter here any more: the session's root is this machine's, so a
    // component whose process serves its workspace filesystem is exactly the one
    // that can answer the model's reads. The four file tools are that component's
    // alone — the host declares no copy — so a root where no component can serve
    // them has `run_command` and no file tools.
    for (const spec of component.tools) {
      if (!spec.modes.includes(mode)) continue;
      if (!gateOk(spec.gate)) continue;
      const wired = wire(spec);
      tools.set(wired.name, wired);
    }
  }

  return {
    schemas: () => [...tools.values()].map(schemaOf),
    names: () => [...tools.keys()],
    // One tool's presentation block, for the call events the page renders from.
    // A name no tool declares gets the defaults and nothing more: a call event for
    // a tool this host does not hold (a stale session, a verb typed by hand) is
    // rendered from what the renderer already assumes, never from a `mutates` this
    // host invented for a tool it cannot see.
    ui: (name) => {
      const tool = tools.get(name);
      if (!tool) return { ...host.ui, undo: false };
      return {
        ...tool.ui,
        mutates: tool.ui.mutates === undefined ? Boolean(tool.snapshot || tool.host) : Boolean(tool.ui.mutates),
        undo: Boolean(tool.snapshot),
      };
    },
    // The argument in which this call NAMED A FILE ("" when it named none). The
    // two policies under which a call is "working on a file" rather than sweeping
    // for one: read and write.
    pathArg: (name) => {
      const tool = tools.get(name);
      if (!tool || !WATCHED_ACCESS.has(tool.access)) return "";
      return tool.access_arg;
    },
    diagnostics: () => diagnostics.slice(),
  };
}

module.exports = {
  createTools,
  toolOf,
  componentOf,
  tableOf,
  schemaOf,
  resolve,
  HOST_DECLARATIONS,
  HOST_DECLARATIONS_ALL,
  HOST_TOOL_NAMES,
  CLIENT_NATIVE_DECLARATIONS,
  CLIENT_NATIVE_TOOL_NAMES,
  HOST_PROSE_DIR: path.join(__dirname, "prompts", "tools"),
  DEFAULT_UI,
  DEFAULT_ACCESS,
  DEFAULT_GATES,
  UI_KEYS,
  MODES,
  FACILITIES,
  RETIRED_WORDS,
  WATCHED_ACCESS,
};
