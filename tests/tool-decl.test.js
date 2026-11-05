// ui/tool-decl.js is the frontend's reading of a tool declaration. While the
// Python half still exists (P4 deletes it), both readings must answer the same
// thing over the real manifests this repo ships — that is the first half of this
// runner, driven by tests/tool_decl_dump.py, which builds the surface through the
// REAL pipeline (catalog table -> build_tools -> ToolRegistry) and prints it.
//
// The second half is JS-only: the refusals (a word this host does not know is
// never guessed at), the gates, the merge of two registrations of one component,
// and the derivation the host owns (`mutates`/`undo`, `pathArg`).
//
// Run: node tests/tool-decl.test.js
const { execFileSync } = require("child_process");
const path = require("path");
const { check, summary } = require("./harness.js");
const {
  createTools,
  toolOf,
  tableOf,
  resolve,
  HOST_TOOL_NAMES,
  DEFAULT_UI,
  UI_KEYS,
} = require("../ui/tool-decl.js");

const ROOT = path.join(__dirname, "..");
const PY = path.join(
  ROOT,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);

// ---------------------------------------------------------------- comparing --

// Order-insensitive equality: two readings of one declaration must agree on
// every value, not on the order JSON happened to serialize the keys in.
function eq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && eq(a[k], b[k]));
}

const show = (v) => JSON.stringify(v);

// -------------------------------------------------------- the Python oracle --

function oracle() {
  const out = execFileSync(PY, [path.join("tests", "tool_decl_dump.py")], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(String(out));
}

function identity() {
  const dump = oracle();
  const available = {};
  for (const declaration of dump.declarations) available[declaration.name] = true;
  const tools = createTools({
    declarations: dump.declarations,
    available,
    config: dump.config,
    backends: dump.backends,
    facts: dump.facts,
    project: dump.project,
    mode: dump.mode,
    host: dump.host,
    warn: (m) => console.log(`  (host warned: ${m})`),
  });

  check(
    eq(tools.names(), dump.tools.map((t) => t.name)),
    `identity: the same tools in the same order (${tools.names().length} vs ${dump.tools.length})`
  );
  if (!eq(tools.names(), dump.tools.map((t) => t.name))) {
    console.log(`    js:   ${show(tools.names())}`);
    console.log(`    py:   ${show(dump.tools.map((t) => t.name))}`);
  }
  check(
    eq(tools.schemas(), dump.tools.map((t) => t.schema)),
    "identity: every openai schema identical (name, description, parameters)"
  );

  for (const expected of dump.tools) {
    const name = expected.name;
    const schema = tools.schemas().find((s) => s.function.name === name);
    const actual = schema && schema.function;
    if (!actual) {
      check(false, `identity: ${name} is offered by the frontend`);
      continue;
    }
    check(eq(actual.description, expected.description), `identity: ${name} description`);
    check(eq(actual.parameters.properties, expected.parameters.properties), `identity: ${name} parameters.properties`);
    check(eq(actual.parameters.required, expected.parameters.required), `identity: ${name} parameters.required`);
    check(eq(tools.ui(name), expected.ui), `identity: ${name} ui`);
    check(tools.pathArg(name) === expected.path_arg, `identity: ${name} path_arg (${show(expected.path_arg)})`);
  }

  // The refusals are part of the answer: a component naming a word this host
  // cannot read contributes nothing on either side, for the same stated reason.
  const refusedInJs = {};
  for (const d of tools.diagnostics()) {
    if (!d.fatal) continue;
    (refusedInJs[d.component] = refusedInJs[d.component] || []).push(d.message);
  }
  check(
    eq(Object.keys(refusedInJs).sort(), Object.keys(dump.refused).sort()),
    `identity: the same components are refused (${Object.keys(dump.refused).join(", ") || "none"})`
  );
  for (const name of Object.keys(dump.refused)) {
    check(
      eq((refusedInJs[name] || []).sort(), [...dump.refused[name]].sort()),
      `identity: ${name} is refused for the same reasons`
    );
  }

  // The table the host is told is not assumed to be the built-in one: the dump
  // hands over the machine's own (host.json merged over the built-ins per
  // agent/tools/hostconfig.py), and the reading above used it. Two host values
  // that differ from the built-ins must reach the derived answers.
  const moved = createTools({
    declarations: dump.declarations,
    available,
    config: dump.config,
    backends: dump.backends,
    facts: dump.facts,
    project: dump.project,
    mode: dump.mode,
    host: {
      ...dump.host,
      ui: { ...dump.host.ui, form: "inline" },
      access: { ...dump.host.access, write: { arg: "target" } },
    },
  });
  const writeUi = moved.ui("write_file");
  check(writeUi.form === "inline", "identity: the machine's ui default is what fills a declaration's blanks");
  check(writeUi.chip === "name", "identity: the machine's ui table keeps the keys it did not move");

  return dump;
}

// -------------------------------------------------------------- JS-only cases --

// A manifest that is valid unless a case changes one word: a process on this
// host (so its tools need no command) and one tool.
function manifest(name, tool, extra) {
  return {
    name,
    launch: { argv: [name] },
    tools: [{ name: `${name}_tool`, description: name, ...tool }],
    ...(extra || {}),
  };
}

function surfaceOf(declarations, more) {
  const available = {};
  for (const d of declarations) available[d.name] = true;
  return createTools({ declarations, available, mode: "work", ...(more || {}) });
}

const names = (tools) => tools.names();

function behavior() {
  // ---- the host's own three tools, and the gate that holds two of them back --
  const empty = createTools({ mode: "work" });
  check(
    eq(names(empty), ["run_command"]),
    "host: with no project open the host offers only run_command"
  );
  const open = createTools({ mode: "work", project: true });
  check(eq(names(open), HOST_TOOL_NAMES), "host: an open project offers the host's three tools, host tools first");
  check(
    eq(open.names(), HOST_TOOL_NAMES) && HOST_TOOL_NAMES[0] === "run_command",
    "host: the host's own tools lead the surface"
  );

  // ---- a component's tool is offered only when this machine can drive it -----
  const one = [manifest("c-avail", {})];
  check(
    eq(names(surfaceOf(one, { available: { "c-avail": false } })), ["run_command"]),
    "available: a component whose code is not here contributes nothing"
  );
  check(
    eq(names(surfaceOf(one)), ["run_command", "c-avail_tool"]),
    "available: a drivable component's tool is offered after the host's"
  );

  // ---- mode ---------------------------------------------------------------
  const moded = [
    manifest("c-mode", { modes: ["chat"] }),
    {
      name: "c-mode2",
      launch: { argv: ["x"] },
      tools: [
        { name: "c_mode_work", description: "", modes: ["work"] },
        { name: "c_mode_chat", description: "", modes: ["chat"] },
        { name: "c_mode_any", description: "" },
      ],
    },
  ];
  check(eq(names(surfaceOf(moded)), ["run_command", "c_mode_work", "c_mode_any"]), "mode: work keeps work and mode-less tools");
  check(
    eq(names(surfaceOf(moded, { mode: "chat" })), ["run_command", "c-mode_tool", "c_mode_chat", "c_mode_any"]),
    "mode: chat keeps chat and mode-less tools"
  );

  // ---- gates --------------------------------------------------------------
  const gated = [
    manifest("c-gated", { gate: "skills" }),
    {
      name: "c-gated2",
      launch: { argv: ["x"] },
      tools: [{ name: "c_project_tool", description: "", gate: "project" }],
    },
  ];
  check(
    eq(names(surfaceOf(gated)), ["run_command"]),
    "gate: a skills-gated tool waits for an answered fact, and a project-gated one for a log"
  );
  check(
    eq(names(surfaceOf(gated, { facts: { skills: ["alpha"] } })), ["run_command", "c-gated_tool"]),
    "gate: an answered skills fact opens the skills gate"
  );
  check(
    eq(names(surfaceOf(gated, { project: true })), ["run_command", "grep_memory", "read_memory", "c_project_tool"]),
    "gate: an open project opens the project gate"
  );
  check(
    eq(names(surfaceOf(gated, { facts: { skills: [] } })), ["run_command"]),
    "gate: an empty skill list is fail-CLOSED (nothing to pick from, never a guess)"
  );

  // ---- a word the host does not know is refused, never guessed at ----------
  const badAccess = [manifest("c-bad-access", { access: "telepathy" })];
  let warned = [];
  const badAccessTools = surfaceOf(badAccess, { warn: (m) => warned.push(m) });
  check(eq(names(badAccessTools), ["run_command"]), "refuse: an unknown access word withholds the component's tools");
  check(
    badAccessTools.diagnostics().some((d) => d.fatal && d.message.includes("unknown access 'telepathy'")),
    "refuse: the diagnostic names the unknown access word"
  );
  check(
    warned.length === 1 && warned[0].startsWith("refusing c-bad-access/c-bad-access_tool: "),
    "refuse: the warning says which component and tool were refused"
  );

  // said once per process: building the surface again does not repeat it
  warned = [];
  surfaceOf(badAccess, { warn: (m) => warned.push(m) });
  check(warned.length === 0, "refuse: a refusal already said is not said again on the next turn");

  // One shape for every refusal: the tool is not offered, and a fatal diagnostic
  // names the word that caused it.
  function refused(label, declaration, reason) {
    const tools = surfaceOf([declaration]);
    check(eq(names(tools), ["run_command"]), `${label}: withheld`);
    check(
      tools.diagnostics().some((d) => d.fatal && reason.test(d.message)),
      `${label}: the reason names the word`
    );
    return tools;
  }

  refused("refuse: an unknown gate", manifest("c-bad-gate", { gate: "someday" }), /unknown gate 'someday'/);
  refused("refuse: an unknown mode", manifest("c-bad-mode", { modes: ["work", "party"] }), /unknown mode 'party'/);
  refused("refuse: a retired word", manifest("c-legacy", {}, { interface: "stdin" }), /`interface`/);
  refused("refuse: entry beside launch", manifest("c-entry", {}, { entry: "index.js" }), /declares `entry` and `launch`/);
  refused(
    "refuse: an unknown facility in requires",
    manifest("c-facility", {}, { requires: ["telepathy"] }),
    /unknown facility in requires: 'telepathy'/
  );
  refused(
    "refuse: a vars key that is also an argument",
    {
      name: "c-shadow",
      launch: { argv: ["x"] },
      vars: { pattern: "host value" },
      tools: [{ name: "c_shadow_tool", description: "", parameters: { properties: { pattern: { type: "string" } } } }],
    },
    /vars key 'pattern' is also an argument/
  );
  refused(
    "refuse: a component publishing the host's own name",
    manifest("c-steal", { name: "run_command" }),
    /is the host's own/
  );
  refused(
    "refuse: a client-side tool without a command",
    { name: "c-client", entry: "index.js", tools: [{ name: "c_client_tool", description: "" }] },
    /must carry a command/
  );

  const clientFact = surfaceOf([
    { name: "c-client-fact", entry: "index.js", facts: { skills: "list them" }, tools: [] },
  ]);
  check(
    clientFact.diagnostics().some((d) => d.message.includes("cannot publish the host fact 'skills'")),
    "refuse: a client-side component cannot answer a host fact"
  );

  const serviceFact = surfaceOf([
    { name: "c-service-fact", service: {}, facts: { skills: "list them" }, tools: [] },
  ]);
  check(
    serviceFact.diagnostics().some((d) => d.message.includes("a service's statement belongs to one workspace")),
    "refuse: a service cannot answer a host fact either"
  );

  // ---- a cosmetic word is not fatal: the tool works, it looks plainer ------
  const cosmetic = surfaceOf([manifest("c-cosmetic", { ui: { sparkle: true, chip: "summary" } })]);
  check(
    eq(names(cosmetic), ["run_command", "c-cosmetic_tool"]),
    "cosmetic: an unknown ui key does not withhold the tool"
  );
  const cosmeticUi = cosmetic.ui("c-cosmetic_tool");
  check(!("sparkle" in cosmeticUi), "cosmetic: the unknown ui key is dropped, not handed to a renderer");
  check(cosmeticUi.chip === "summary", "cosmetic: the declared keys that ARE known still apply");
  check(
    cosmetic.diagnostics().some((d) => !d.fatal && d.message.includes("unknown ui key 'sparkle'")),
    "cosmetic: it is reported as a non-fatal diagnostic"
  );

  // ---- the host's own declaration is checked too --------------------------
  let threw = "";
  try {
    createTools({ host: { access: { read: { arg: "path" } } } });
  } catch (e) {
    threw = e.message;
  }
  check(
    threw.startsWith("tool-decl: the host's own run_command declaration is invalid: ") &&
      threw.includes("unknown access 'command'"),
    "host: a machine table that cannot honor the host's own declaration throws instead of shipping a blind command tool"
  );

  // ---- two registrations of one component: names override, blanks carry ----
  const merged = tableOf([
    { name: "c-merge", launch: { argv: ["run"], binary: "old" }, requires: ["python"], vars: { a: "1" } },
    { name: "c-merge", launch: { binary: "new" } },
    { name: "c-merge", requires: [] },
  ])[0];
  check(merged.launch.argv[0] === "run", "merge: a later manifest naming only `binary` keeps the earlier `argv`");
  check(merged.launch.binary === "new", "merge: the named field is overridden");
  check(eq(merged.requires, []), "merge: naming an empty list is the declaration saying none");
  check(eq(merged.vars, [["a", "1"]]), "merge: an unnamed field carries");

  const retired = tableOf([
    { name: "c-retired", launch: { argv: ["x"] } },
    { name: "c-retired", interface: "stdin" },
  ])[0];
  check(retired.retired.includes("interface"), "merge: a retired word accumulates from the source it was written in");

  // ---- this machine's answers inside a declaration -------------------------
  const answers = { config: { read_max_chars: 4321 }, backends: ["bing", "ddg"], facts: { skills: ["alpha", "beta"] } };
  check(
    resolve("max $config.read_max_chars via $backends, skills: $skills", answers) ===
      "max 4321 via bing or ddg, skills: alpha, beta",
    "resolve: the tokens inside a sentence are spelled out"
  );
  check(
    resolve("skills: $skills", { ...answers, facts: {} }) === "skills: none",
    "resolve: an unanswered fact says 'none' rather than a guess"
  );
  check(
    resolve("$backends", { ...answers, backends: [] }) === "none",
    "resolve: no configured backend says 'none'"
  );
  check(resolve("$skills", answers).join(",") === "alpha,beta", "resolve: a whole token keeps the list's own shape");
  check(resolve("$config.read_max_chars", answers) === 4321, "resolve: a whole config token keeps its type");
  check(resolve("$config.not_a_field", answers) === "", "resolve: a config field this machine does not have answers ''");
  check(
    eq(resolve({ enum: "$skills", nested: { deep: "$backends" } }, answers), {
      enum: ["alpha", "beta"],
      nested: { deep: "bing or ddg" },
    }),
    "resolve: the answers reach nested values (a fact keeps its list, a chain is spelled out)"
  );

  const resolvedTool = surfaceOf(
    [
      manifest("c-answers", {
        parameters: { properties: { skill: { type: "string", enum: "$skills" } }, required: [] },
      }),
    ],
    { config: answers.config, backends: answers.backends, facts: answers.facts }
  );
  const resolvedSchema = resolvedTool.schemas().find((s) => s.function.name === "c-answers_tool");
  check(
    eq(resolvedSchema.function.parameters.properties.skill.enum, ["alpha", "beta"]),
    "resolve: the schema the model reads carries this machine's fact"
  );

  // ---- the derivation only the host can answer -----------------------------
  const derived = surfaceOf([
    {
      name: "c-derived",
      launch: { argv: ["x"] },
      tools: [
        { name: "c_read", description: "", access: "read" },
        { name: "c_write", description: "", access: "write", snapshot: true },
        { name: "c_sweep", description: "", access: "sweep" },
        { name: "c_command", description: "", access: "command" },
        { name: "c_none", description: "" },
        { name: "c_undo_off", description: "", snapshot: true, ui: { mutates: false } },
      ],
    },
  ]);
  const derivedUi = (n) => derived.ui(n);
  check(eq(derivedUi("c_none"), { ...DEFAULT_UI, mutates: false, undo: false }), "derive: a plain tool gets the defaults, does not mutate, cannot undo");
  check(derivedUi("c_read").mutates === false, "derive: a read does not mutate the tree");
  check(derivedUi("c_write").mutates === true, "derive: a write mutates the tree");
  check(derivedUi("c_write").undo === true, "derive: a snapshot is an undo record");
  check(derivedUi("c_write").mutates === true && !("mutates" in DEFAULT_UI), "derive: mutates is derived, never a default");
  check(UI_KEYS.includes("mutates"), "derive: the renderer knows `mutates` as a key");
  check(derivedUi("c_undo_off").mutates === false, "derive: a declaration that knows better can say so itself");
  check(derivedUi("c_undo_off").undo === true, "derive: `undo` follows the snapshot, not the declaration's word");
  check(derived.pathArg("c_read") === "path", "derive: a read names its file in the access word's argument");
  check(derived.pathArg("c_write") === "path", "derive: so does a write");
  check(derived.pathArg("c_sweep") === "", "derive: a sweep is not working on one file");
  check(derived.pathArg("c_command") === "", "derive: a command names no file");
  check(derived.pathArg("no_such_tool") === "", "derive: a tool this host does not hold names no file");

  const movedAccess = surfaceOf(
    [{ name: "c-moved", launch: { argv: ["x"] }, tools: [{ name: "c_moved_read", description: "", access: "read" }] }],
    { host: { access: { read: { arg: "target" }, sweep: { arg: "path" }, write: { arg: "path" }, command: { arg: "command" } } } }
  );
  check(movedAccess.pathArg("c_moved_read") === "target", "derive: the machine's access table decides which argument named the file");

  // ---- a name this host does not hold is rendered from what the renderer
  //      already assumes, never from an invented `mutates` -------------------
  const strange = derivedUi("a-verb-typed-by-hand");
  check(eq(strange, { ...DEFAULT_UI, undo: false }), "derive: an unknown tool gets the defaults and no `mutates`");
  check(!("mutates" in strange), "derive: the host does not invent a mutation for a tool it cannot see");

  // ---- one raw entry the host cannot read as written is absent, not garbled --
  check(toolOf(null) === null && toolOf([]) === null && toolOf({}) === null, "toolOf: a non-object or nameless entry is not a tool");
  check(toolOf({ name: "x", description: 5 }) === null, "toolOf: a description that is not text is not a model-facing sentence");
  const bare = toolOf({ name: "x" });
  check(bare.description === "" && bare.access === "" && bare.gate === "", "toolOf: the blank reading of a thin entry");
  check(eq(bare.modes, ["work", "chat"]), "toolOf: a tool that names no mode runs in both");
  check(eq(toolOf({ name: "x", modes: [] }).modes, []), "toolOf: naming no mode at all is a tool that runs nowhere");
}

// ---------------------------------------------------------------------- run --

let haveOracle = true;
if (process.env.CLUTCH_SKIP_PY_ORACLE === "1" || !require("fs").existsSync(PY)) {
  haveOracle = false;
  console.log("SKIP: no .venv python — the Python half's answer cannot be asked; running the JS checks only");
}
if (haveOracle) identity();
behavior();
summary("tool-decl");
