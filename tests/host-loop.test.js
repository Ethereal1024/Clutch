"use strict";

// The run loop (`ui/host/loop.js`): derive, call, execute, compact, terminate.
//
// The module is a port of five Python files — `agent/loop.py` and the four core
// modules it drives (`core/context.py`, `core/terminate.py`, `core/parse.py`,
// `core/compaction.py`) — so what this file pins is the SHAPE of a run rather
// than any wire format:
//
//   * the events one turn appends, in order, and which of them are durable. The
//     order is the replay contract: a stored session must read as
//     text -> tools -> results, and the assistant turn is written BEFORE the
//     tool_call records it announces.
//   * the two numbers that must be the SAME number: the offset the log stamps on
//     the task event and the offset the workspace opens its rollback checkpoint
//     at. A mismatch would make "roll back to this message" address a different
//     point of the log.
//   * the model's context is DERIVED from the log every turn, never accumulated:
//     this test drives a real `LazyEventLog` and reads the messages the client
//     was handed, so a second copy of the conversation would show up.
//   * error-as-data: a parse failure or a permission refusal is a tool RESULT the
//     model can act on, never an exception out of the loop; only a fatal
//     AgentError ends a run, and only with `final(status="error")`.
//   * the guards: turn budget, doom loop (name + arguments + RESULT), max-tokens
//     truncation, an empty reply, and Stop — each with its own terminating text.
//
// The prompts are the real ones: `render` here is `string.Template`'s
// safe_substitute over the files the loop actually loads — the loop's own prose
// in `ui/prompts/*.md` (system, the modes, the task, the terminating notes) and
// the machine text the tool layer still keeps in `agent/prompts/`
// (`unknown_tool.md`; see TODO.md P3-2). A renamed variable in a template — or a
// wrong variable in this module — shows up as a literal `$name` in a system
// prompt instead of passing quietly.
//
// Run: node tests/host-loop.test.js

const fs = require("fs");
const path = require("path");

const { check, summary } = require("./harness");

const HOST = path.resolve(__dirname, "..", "ui", "host");
const PROMPTS = path.resolve(__dirname, "..", "ui", "prompts");
const MACHINE_PROMPTS = path.resolve(__dirname, "..", "agent", "prompts");

const clc = require(path.join(HOST, "clc.js"));
const loop = require(path.join(HOST, "loop.js"));

// ---- the prompt renderer (agent/prompts/__init__.py) ---------------------
//
// `string.Template.safe_substitute`: `$$` is a literal dollar, `$name` and
// `${name}` substitute when known and are left VERBATIM when not, and a `$`
// that starts no identifier is left alone. Left-verbatim is the property worth
// having: a placeholder this file gets wrong survives into the prompt text where
// the assertion below can see it.
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
  const own = path.join(PROMPTS, name);
  const text = fs.readFileSync(fs.existsSync(own) ? own : path.join(MACHINE_PROMPTS, name), "utf8");
  return substitute(text, vars);
}

// The one `$name` a template carries as SHELL TEXT rather than as a placeholder:
// `env_windows_cmd.md` tells the model that `$HOME` does not exist on that host.
const LITERAL_DOLLARS = new Set(["HOME"]);

function placeholders(text) {
  return [...text.matchAll(/\$(?:{)?([A-Za-z_][A-Za-z_0-9]*)/g)]
    .map((m) => m[1])
    .filter((name) => !LITERAL_DOLLARS.has(name));
}

// ---- doubles -------------------------------------------------------------

// A scripted model connection: each call consumes one script. A script is an
// array of stream events, or an Error — thrown from INSIDE the iterator, where
// the real client (`ui/host/llm.js: runStreaming`) throws, not from `stream()`.
function scriptedLLM(scripts) {
  const calls = [];
  return {
    calls,
    stream(messages, options = {}) {
      const script = scripts.length ? scripts.shift() : [];
      calls.push({ messages, options });
      return (async function* run() {
        if (script instanceof Error) throw script;
        for (const ev of script) yield ev;
      })();
    },
  };
}

const text = (delta) => ({ type: "text", delta });
const reasoning = (delta) => ({ type: "reasoning", delta });
const toolStart = (index, id, name) => ({ type: "tool_call_start", index, id, name });
const toolArgs = (index, delta) => ({ type: "tool_call_delta", index, delta });
const finish = (reason = "stop") => ({ type: "finish", reason });

// One whole turn that asks for one tool call with `args`.
function callTurn(name, args, id = "call-1", reason = "tool_calls") {
  return [toolStart(0, id, name), toolArgs(0, args), finish(reason)];
}

// The tool's own declarations. Nothing in loop.js may name a tool; every one of
// these five answers is asked for by the registry seam.
function fakeRegistry(options = {}) {
  const executed = [];
  return {
    executed,
    schemas: () => [{ type: "function", function: { name: "read_file", parameters: {} } }],
    ui: (name) => ({ body: name === "write_file" ? "diff" : "code", title: name }),
    pathArg: (name) => (name === "read_file" || name === "write_file" ? "path" : ""),
    access: (name) => (name === "read_file" ? "read" : "write"),
    accessArg: () => "path",
    async execute(workspace, config, name, args, opts) {
      executed.push({ workspace, config, name, args, opts });
      const answer = options.answer
        ? options.answer(name, args)
        : { content: `${name} ok`, error: false, diff: "" };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

// The workspace seam, as much of it as the loop touches.
function fakeWorkspace(options = {}) {
  const turns = [];
  const cleared = [];
  const workspace = {
    turns,
    cleared,
    beginTurn(offset) {
      turns.push(offset);
    },
    clearAllowed() {
      cleared.push(cleared.length + 1);
    },
  };
  if (options.shell) workspace.execShell = () => ({ name: options.shell });
  return workspace;
}

function stopFlag() {
  const flag = {
    set: false,
    isSet() {
      return flag.set;
    },
  };
  return flag;
}

function llmError(code, message) {
  const error = new Error(message);
  error.name = "LlmError";
  error.code = code;
  return error;
}

// A whole run, wired up, with everything the caller might want to look at after.
function makeRun(options = {}) {
  const log = options.log || clc.LazyEventLog.memory();
  const llm = options.llm || scriptedLLM([]);
  const registry = options.registry || fakeRegistry(options.registryOptions);
  const workspace = options.workspace || fakeWorkspace(options.workspaceOptions);
  const sink = [];
  const agent = loop.createAgent({
    llm,
    registry,
    workspace,
    config: options.config || { mode: "work" },
    log,
    render,
    sink: (ev) => sink.push(Object.assign({}, ev)),
    cancel: options.cancel || null,
    gate: options.gate || null,
    components: options.components || "",
  });
  return { agent, log, llm, registry, workspace, sink };
}

function durable(log) {
  return log.events().filter((ev) => clc.DURABLE_TYPES.has(ev.type));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- prompts: the variable contract -------------------------------------

function promptContract() {
  const cases = [
    ["system.md", {}],
    ["mode_chat.md", {}],
    ["mode_work.md", {}],
    ["task.md", { task: "fix the bug" }],
    ["cancelled.md", {}],
    ["empty_response.md", {}],
    ["max_tokens.md", {}],
    ["unknown_tool.md", { tool: "grep", available: "read_file, write_file" }],
    ["env_windows_bash.md", {}],
    ["env_windows_cmd.md", {}],
    ["compaction_head.md", { summary: "the summary" }],
    ["compaction_files.md", { files: "a.py, b.py" }],
    ["recall.md", { name: "proj.clc", size: "12 KB" }],
    ["budget_exceeded.md", { max_turns: 7 }],
    ["doom_loop.md", { tool: "read_file" }],
    ["compaction.md", { history: "the history", previous_summary: "(none)" }],
  ];
  const unresolved = [];
  for (const [name, vars] of cases) {
    const body = render(name, vars);
    if (placeholders(body).length) unresolved.push(`${name}: ${placeholders(body).join(", ")}`);
  }
  check(unresolved.length === 0, `every prompt renders without a leftover placeholder (${unresolved.join("; ") || "none"})`);

  // the substitutions land where the template says they do
  check(render("task.md", { task: "fix the bug" }).trim() === "Task: fix the bug", "task.md substitutes the task verbatim");
  check(render("budget_exceeded.md", { max_turns: 3 }).includes("maximum of 3 turns"), "budget_exceeded.md states the budget");
  check(render("doom_loop.md", { tool: "grep" }).includes("`grep`"), "doom_loop.md names the tool");
  check(render("recall.md", { name: "a.clc", size: "4 KB" }).includes("a.clc"), "recall.md names the log file");
  check(render("recall.md", { name: "a.clc", size: "4 KB" }).includes("4 KB"), "recall.md states the log size");
  // a template value is NOT re-scanned for placeholders (Template substitutes once)
  check(render("task.md", { task: "$task" }).trim() === "Task: $task", "a substituted value is not re-scanned");
  check(render("task.md", { task: "a $$ b" }).trim() === "Task: a $$ b", "a dollar in the value stays literal");
  check(substitute("$$3", {}) === "$3", "`$$` is an escaped dollar, not a placeholder");
}

// ---- the log as text, and the messages derived from it -------------------

function sizesAndText() {
  // values captured from `agent/core/context.py: _size` (the Python host is the
  // reference for these strings): the MB branch is Python's `.1f`, and 1310720
  // bytes is EXACTLY 1.25 MB — a half-to-EVEN tie, which `toFixed` gets wrong.
  const cases = [
    [0, "1 KB"],
    [1, "1 KB"],
    [1023, "1 KB"],
    [1024, "1 KB"],
    [2047, "1 KB"],
    [1048575, "1023 KB"],
    [1048576, "1.0 MB"],
    [1310720, "1.2 MB"],
    [1572864, "1.5 MB"],
    [786432, "768 KB"],
    [123456789, "117.7 MB"],
    [999999999, "953.7 MB"],
    [1073741824, "1024.0 MB"],
    [1610612736, "1536.0 MB"],
    [1000000000000, "953674.3 MB"],
  ];
  const wrong = cases.filter(([n, want]) => loop.sizeText(n) !== want).map(([n]) => `${n} -> ${loop.sizeText(n)}`);
  check(wrong.length === 0, `sizeText matches Python for KB, the MB boundary and the half-even tie (${wrong.join(", ") || "15 values"})`);
  check(loop.sizeText(1.25 * 1048576) === "1.2 MB", "a half-to-even tie rounds to the EVEN tenth, like Python");
  check(loop.sizeText(undefined) === "1 KB", "a missing byte count reads as the floor, not NaN");
}

function eventTextCases() {
  const ev = (data) => clc.eventFromDict(data);
  check(loop.eventText(ev({ type: "user_message", content: "hi" })) === "[User]: hi", "event_text renders a user message");
  check(
    loop.eventText(ev({ type: "assistant_message", content: "a", reasoning: "r" })) ===
      "[Assistant]: a\n[Assistant reasoning]: r",
    "event_text renders the assistant's text and its reasoning"
  );
  check(
    loop.eventText(ev({ type: "tool_call", name: "read_file", arguments: '{"path":"a"}' })) ===
      '[Assistant tool call]: read_file({"path":"a"})',
    "event_text renders a tool call as name(arguments)"
  );
  check(loop.eventText(ev({ type: "tool_result", content: "out" })) === "[Tool result]: out", "event_text renders a tool result");
  check(
    loop.eventText(ev({ type: "compaction", summary: "s" })) === "[Compaction summary]: s",
    "event_text renders a compaction summary"
  );
  check(loop.eventText(ev({ type: "final", status: "completed", summary: "done" })) === "[Final]: done", "event_text renders a final's summary");
  check(
    loop.eventText(ev({ type: "final", status: "aborted", summary: "" })) === "[Final]: aborted",
    "an empty summary falls back to the status"
  );
  check(loop.eventText(ev({ type: "step_start" })) === "", "a transient/unknown event renders nothing");
  check(loop.eventText(null) === "", "a missing event renders nothing");
  // the limit caps the BODY: the prefix is not part of what `_clip` counts
  check(loop.eventText(ev({ type: "user_message", content: "abcdef" }), 3) === "[User]: abc\n[truncated]", "a limit cuts with a visible marker");
  check(loop.eventText(ev({ type: "user_message", content: "abc" }), 3) === "[User]: abc", "a body at the limit is not cut");
  check(
    loop.eventText(ev({ type: "assistant_message", content: "", reasoning: "why" })) === "[Assistant reasoning]: why",
    "reasoning alone is still rendered"
  );
  check(
    loop.eventText(ev({ type: "assistant_message", content: "", reasoning: "" })) === "",
    "an empty assistant message renders nothing (the caller skips the line)"
  );
}

function messageProjection() {
  const ev = (data) => clc.eventFromDict(data);

  const paired = loop.toMessages([
    ev({ type: "user_message", content: "go" }),
    ev({
      type: "assistant_message",
      content: "reading",
      reasoning: "hmm",
      tool_calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }],
    }),
    ev({ type: "tool_call", name: "read_file", arguments: '{"path":"a"}', tool_call_id: "c1", path_arg: "path" }),
    ev({ type: "tool_result", tool_call_id: "c1", content: "body" }),
    ev({ type: "assistant_message", content: "done" }),
  ]);
  check(deepEqual(paired, [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "reading",
      reasoning_content: "hmm",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "body" },
    { role: "assistant", content: "done" },
  ]), "a healthy log projects to user / assistant(+reasoning, tool_calls) / tool");
  check(paired[1].tool_calls[0].type === "function", "a tool call is announced with type=function");
  check(!("tool_calls" in loop.toMessages([ev({ type: "assistant_message", content: "x" })])[0]), "an assistant message without calls has no tool_calls key");
  check(!("reasoning_content" in loop.toMessages([ev({ type: "assistant_message", content: "x" })])[0]), "no reasoning key when the model said nothing to itself");
  const bare = loop.toMessages([
    ev({ type: "assistant_message", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: "{}" }] }),
    ev({ type: "tool_result", tool_call_id: "c1", content: "body" }),
  ])[0];
  check(!("content" in bare) && bare.tool_calls.length === 1, "an empty content key is omitted, not sent as \"\"");

  // the pairing contract, on a log that ends mid-batch
  const dangling = loop.toMessages([
    ev({ type: "user_message", content: "go" }),
    ev({
      type: "assistant_message",
      content: "checks two files",
      tool_calls: [
        { id: "c1", name: "read_file", arguments: "{}" },
        { id: "c2", name: "read_file", arguments: "{}" },
      ],
    }),
    ev({ type: "tool_result", tool_call_id: "c1", content: "one" }),
    ev({ type: "tool_result", tool_call_id: "cX", content: "orphan" }),
  ]);
  check(deepEqual(dangling, [
    { role: "user", content: "go" },
    { role: "assistant", content: "checks two files" },
  ]), "an interrupted tool batch drops its tool_calls and its orphan results, keeping the text");
  check(loop.toMessages([ev({ type: "tool_result", tool_call_id: "x", content: "lonely" })]).length === 0, "an orphan tool result with no assistant block is dropped");
  check(loop.toMessages([ev({ type: "assistant_message", content: "" })]).length === 0, "an assistant message with neither text nor calls is dropped");
  check(loop.toMessages([ev({ type: "user_message", content: "" })])[0].role === "user", "an empty user message is still a message (the task.md injection)");
}

function deriveCases() {
  const ev = (i, data) => clc.eventFromDict(Object.assign({ timestamp: 1700000000 + i, id: `e${i}` }, data));

  // a memory log has no path: the prompt must not promise a log file reader
  const scratch = clc.LazyEventLog.memory();
  const scratchMsgs = loop.deriveMessages(scratch, { mode: "work" }, "do it", { render });
  check(scratchMsgs[0].role === "system", "the system prompt comes first");
  check(scratchMsgs[1].content.trim() === "Task: do it", "task.md is the second message, re-injected every run");
  check(!scratchMsgs[0].content.includes("This project's memory"), "an in-memory session gets no log anchor");
  check(scratchMsgs[0].content.endsWith(render("mode_work.md")), "work mode appends its contract to the system prompt");
  const chatMsgs = loop.deriveMessages(scratch, { mode: "chat" }, "do it", { render });
  check(chatMsgs[0].content.includes(render("mode_chat.md")), "chat mode appends its own contract");
  check(!chatMsgs[0].content.includes(render("mode_work.md")), "chat mode does not also claim full access");
  const plainMsgs = loop.deriveMessages(scratch, {}, "do it", { render });
  check(plainMsgs[0].content === render("system.md"), "an unset mode adds nothing to the system prompt");

  // components land after the mode block, before the shell hint and the anchor
  const withParts = loop.deriveMessages(scratch, { mode: "work" }, "do it", {
    render,
    components: "## components\n\n- shell",
  });
  check(withParts[0].content.includes("## components"), "the components' own words are placed in the system prompt");
  check(
    withParts[0].content.indexOf(render("mode_work.md")) < withParts[0].content.indexOf("## components"),
    "components come after the mode contract"
  );

  // the shell hint: a POSIX far side adds nothing, a Windows one speaks up
  const posix = loop.deriveMessages(scratch, { mode: "work" }, "x", { render, workspace: fakeWorkspace({ shell: "posix" }) });
  check(posix[0].content === withParts[0].content.replace("\n\n## components\n\n- shell", ""), "a POSIX shell adds no environment hint");
  const bash = loop.deriveMessages(scratch, { mode: "work" }, "x", { render, workspace: fakeWorkspace({ shell: "bash" }) });
  check(bash[0].content.includes(render("env_windows_bash.md")), "a bash-on-Windows host announces its dialect (bash)");
  const cmd = loop.deriveMessages(scratch, { mode: "work" }, "x", { render, workspace: fakeWorkspace({ shell: "cmd" }) });
  check(cmd[0].content.includes(render("env_windows_cmd.md")), "a cmd host announces its dialect (cmd)");
  const bare = loop.deriveMessages(scratch, { mode: "work" }, "x", { render, workspace: { beginTurn() {}, clearAllowed() {} } });
  check(bare[0].content === posix[0].content, "a workspace with no execShell() reads as the POSIX far root");

  // the task is dropped only when it IS the log's first user message
  const first = clc.LazyEventLog.memory();
  first.append(ev(1, { type: "user_message", content: "same" }));
  const dropped = loop.deriveMessages(first, {}, "same", { render });
  check(!dropped.some((m) => m.role === "user" && m.content === "same"), "the current task is not duplicated when it opened the log");
  const kept = loop.deriveMessages(first, {}, "a follow-up", { render });
  check(kept.some((m) => m.role === "user" && m.content === "same"), "a continued session keeps the project's FIRST ask");
  check(kept[1].content.trim() === "Task: a follow-up", "and re-injects the new task");

  // compaction: the summary is the head, and the files worked on after it are listed
  const compactedLog = clc.LazyEventLog.memory();
  compactedLog.append(ev(1, { type: "user_message", content: "old" }));
  compactedLog.append(ev(2, { type: "assistant_message", content: "old answer" }));
  compactedLog.append(ev(3, { type: "tool_call", name: "read_file", arguments: '{"path":"gone.py"}', tool_call_id: "z", path_arg: "path" }));
  compactedLog.append(ev(4, { type: "compaction", summary: "THE HEAD" }));
  for (let i = 0; i < 7; i += 1) {
    compactedLog.append(ev(10 + i, {
      type: "tool_call",
      name: "write_file",
      arguments: JSON.stringify({ path: `f${i}.py` }),
      tool_call_id: `w${i}`,
      path_arg: "path",
    }));
  }
  compactedLog.append(ev(30, { type: "tool_call", name: "read_file", arguments: '{"path":"f6.py"}', tool_call_id: "r", path_arg: "path" }));
  compactedLog.append(ev(31, { type: "tool_call", name: "read_file", arguments: "not json", tool_call_id: "bad", path_arg: "path" }));
  const withHead = loop.deriveMessages(compactedLog, {}, "next", { render });
  check(withHead[2].content === render("compaction_head.md", { summary: "THE HEAD" }), "the newest summary becomes a head message");
  const filesMsg = withHead[3].content;
  check(filesMsg.startsWith("(Conversation compacted."), "the head is followed by the re-read reminder");
  check(filesMsg.includes("f6.py") && filesMsg.includes("f5.py"), "the working files are listed most-recent first");
  check(!filesMsg.includes("gone.py"), "a file named BEFORE the compaction is not in the window's list");
  check(!filesMsg.includes("f0.py"), "the list is capped at six files");
  check((filesMsg.match(/f\d\.py/g) || []).length === 6, "exactly six distinct files are named");
  check(!withHead.some((m) => m.content === "[User]: old"), "summarized history never re-enters the context");

  // a tool call whose arguments are not JSON is not a file it was working on
  const noFiles = clc.LazyEventLog.memory();
  noFiles.append(ev(1, { type: "compaction", summary: "S" }));
  noFiles.append(ev(2, { type: "user_message", content: "x" }));
  noFiles.append(ev(3, { type: "tool_call", name: "read_file", arguments: "not json", tool_call_id: "b", path_arg: "path" }));
  const noFilesMsgs = loop.deriveMessages(noFiles, {}, "x", { render });
  check(!noFilesMsgs.some((m) => m.content.startsWith("(Conversation compacted.")), "no reminder when no file was named");

  // a call that names no file (path_arg empty) is never listed
  const noPathArg = clc.LazyEventLog.memory();
  noPathArg.append(ev(1, { type: "compaction", summary: "S" }));
  noPathArg.append(ev(2, { type: "tool_call", name: "list", arguments: '{"path":"a.py"}', tool_call_id: "l", path_arg: "" }));
  check(
    !loop.deriveMessages(noPathArg, {}, "x", { render }).some((m) => m.content.startsWith("(Conversation")),
    "a tool the declaration says names no file is not a working file"
  );

  // the log anchor: this project's own file, by name and size
  const projectLog = clc.LazyEventLog.memory();
  projectLog.path = "/home/far/projects/demo.clc";
  projectLog._bytes = 1310720;
  const anchored = loop.deriveMessages(projectLog, {}, "x", { render });
  check(anchored[0].content.endsWith(render("recall.md", { name: "demo.clc", size: "1.2 MB" })), "a project log anchors the prompt to its own file and size");
  check(anchored[0].content.includes("demo.clc"), "the anchor names the file, not the whole path");
}

// ---- termination ---------------------------------------------------------

function terminator() {
  const budget = loop.createTerminator({ maxTurns: 2 });
  check(!budget.checkTurnBudget(1) && !budget.checkTurnBudget(2), "a budget of two allows two turns");
  check(budget.checkTurnBudget(3), "and refuses the third");
  check(!loop.createTerminator({}).checkTurnBudget(9999), "maxTurns 0 means no limit at all");
  check(loop.createTerminator({ max_turns: 1 }).checkTurnBudget(2), "the snake_case config spelling is honoured too");

  const doom = loop.createTerminator({ doomLoopLimit: 3 });
  check(doom.recordCall("read_file", "{}", "same") === "", "the first identical call is not a loop");
  check(doom.recordCall("read_file", "{}", "same") === "", "the second is not either");
  check(doom.recordCall("read_file", "{}", "same") === "warn", "the third identical call (same args AND same result) warns");
  check(doom.shouldEscalate("read_file", "{}"), "the warned call itself escalates next time");
  check(!doom.shouldEscalate("read_file", '{"x":1}'), "a different call does not escalate");
  check(doom.recordCall("read_file", '{"x":1}', "other") === "", "a different call is forgiven and starts afresh");
  check(!doom.shouldEscalate("read_file", "{}"), "so the old warning no longer escalates");
  check(doom.recordCall("read_file", '{"x":1}', "other") === "", "and the fresh window is still counting");

  const changing = loop.createTerminator({ doomLoopLimit: 2 });
  check(changing.recordCall("poll", "{}", "a") === "", "identical calls with different results are progress");
  check(changing.recordCall("poll", "{}", "b") === "", "and never trigger, however many there are");
  check(changing.recordCall("poll", "{}", "c") === "", "still no warning");

  const once = loop.createTerminator({ doomLoopLimit: 1 });
  check(once.recordCall("x", "", "r") === "warn", "a limit of one warns on the very first call");
  // …and the warned call escalates from then on: `(name, args) == _doom_call`
  check(once.shouldEscalate("x", ""), "…and escalates that same call next time");

  // the frozen quirk: a limit of ZERO warns immediately (all() of an empty window)
  const zero = loop.createTerminator({ doomLoopLimit: 0 });
  check(zero.recordCall("x", "", "r") === "warn", "a limit of zero warns on the first call (Python's all([]) is true)");
}

// ---- compaction ----------------------------------------------------------

function compactorCases() {
  const ev = (i, data) => clc.eventFromDict(Object.assign({ timestamp: 1700000000 + i, id: `c${i}` }, data));

  // should_compact is a pure byte comparison against the window
  const log = clc.LazyEventLog.memory();
  log.append(ev(1, { type: "user_message", content: "hello" }));
  const exact = loop.createCompactor({ config: { contextWindowBytes: log.windowBytes }, log, llm: scriptedLLM([]), render });
  check(exact.shouldCompact(), "the threshold fires AT the configured window size");
  const under = loop.createCompactor({ config: { contextWindowBytes: log.windowBytes + 1 }, log, llm: scriptedLLM([]), render });
  check(!under.shouldCompact(), "and not one byte under it");

  // nothing new since the last compaction: no summary call at all
  const one = clc.LazyEventLog.memory();
  one.append(ev(1, { type: "user_message", content: "only" }));
  const noopLLM = scriptedLLM([]);
  const noop = loop.createCompactor({ log: one, llm: noopLLM, render, config: {} });
  return (async () => {
    check((await noop.compact()) === false, "a window with nothing new is not re-summarized");
    check(noopLLM.calls.length === 0, "and the model is not even asked");

    // the happy path: summarize the window, append the head, slide the boundary
    const real = clc.LazyEventLog.memory();
    real.append(ev(1, { type: "user_message", content: "hi" }));
    real.append(ev(2, { type: "assistant_message", content: "hello" }));
    real.append(ev(3, { type: "tool_call", name: "read_file", arguments: '{"path":"a.py"}', tool_call_id: "t1", path_arg: "path" }));
    real.append(ev(4, { type: "tool_result", tool_call_id: "t1", content: "X".repeat(600) }));
    real.append(ev(5, { type: "final", status: "completed", summary: "not part of the transcript" }));
    const llm = scriptedLLM([[[text("A".repeat(250)), text("B"), finish()]].flat()]);
    const progress = [];
    const compactor = loop.createCompactor({
      log: real,
      llm,
      render,
      config: {},
      sink: (e) => progress.push({ chars: e.chars, done: e.done, note: e.note }),
    });
    const before = real.windowBytes;
    check(before > 0, "the window has bytes to measure");
    const compacted = await compactor.compact();
    check(compacted === true, "compaction reports success");
    check(real.lastCompaction() !== null && real.lastCompaction().summary === "A".repeat(250) + "B", "the summary is appended as a compaction event");
    const items = real.items();
    check(real.cprStart === items[items.length - 1][0], "the window slides to the new summary line's own offset");
    check(before > real.windowBytes, "and the window is now smaller than before");

    const prompt = llm.calls[0].messages[0].content;
    check(llm.calls[0].messages.length === 1 && llm.calls[0].messages[0].role === "user", "the summarizer is asked one user message, with no tools");
    check(llm.calls[0].options.tools === null, "the summary call passes tools=null");
    check(prompt.includes("[User]: hi") && prompt.includes("[Assistant]: hello"), "the transcript is event_text, the same rendering a reader sees");
    check(prompt.includes('read_file({"path":"a.py"})'), "tool calls are in the transcript as their own line");
    check(prompt.includes("[truncated]"), "one huge tool result is trimmed, with the marker");
    check(!prompt.includes("not part of the transcript"), "a final is not part of the conversation");
    check(prompt.includes("(none)"), "no previous summary reads as (none)");

    check(progress.length >= 2 && progress[0].chars === 0 && progress[0].done === false, "progress is announced before the first token");
    check(progress.some((p) => p.chars === 250), "the counter is reported once 200 characters have landed");
    check(!progress.some((p) => p.chars === 251), "and is throttled before the next 200");

    // on a no-op the live block is closed, never left hanging
    const closed = [];
    const blank = clc.LazyEventLog.memory();
    blank.append(ev(1, { type: "user_message", content: "first" }));
    blank.append(ev(2, { type: "assistant_message", content: "first answer" }));
    const failing = loop.createCompactor({
      log: blank,
      llm: scriptedLLM([[[text("   "), finish()]].flat()]),
      render,
      config: {},
      sink: (e) => closed.push(e),
    });
    check((await failing.compact()) === false, "a whitespace-only summary is a failure, not a compaction");
    check(closed.length && closed[closed.length - 1].done === true, "and the progress block is marked done");

    // the previous summary is fed back
    const again = clc.LazyEventLog.memory();
    again.append(ev(1, { type: "user_message", content: "first" }));
    again.append(ev(2, { type: "assistant_message", content: "first answer" }));
    again.append(ev(3, { type: "compaction", summary: "OLD HEAD" }));
    again.append(ev(4, { type: "user_message", content: "second" }));
    again.append(ev(5, { type: "assistant_message", content: "second answer" }));
    const againLLM = scriptedLLM([[[text("NEW HEAD"), finish()]].flat()]);
    await loop.createCompactor({ log: again, llm: againLLM, render, config: {} }).compact();
    check(againLLM.calls[0].messages[0].content.includes("OLD HEAD"), "the previous summary is handed to the summarizer");
    check(again.lastCompaction().summary === "NEW HEAD", "and the new one replaces it as the head");

    // a Stop while summarizing is a quiet bail
    const stop = stopFlag();
    stop.set = true;
    const stoppedLog = clc.LazyEventLog.memory();
    stoppedLog.append(ev(1, { type: "user_message", content: "a" }));
    stoppedLog.append(ev(2, { type: "user_message", content: "b" }));
    const stoppedLLM = scriptedLLM([]);
    check(
      (await loop.createCompactor({ log: stoppedLog, llm: stoppedLLM, render, cancel: stop, config: {} }).compact()) === false,
      "a Stop before the summary starts compacts nothing"
    );
    check(stoppedLLM.calls.length === 0, "and never opens a stream");

    // a Stop mid-stream drops the partial summary
    const midStop = stopFlag();
    const midLog = clc.LazyEventLog.memory();
    midLog.append(ev(1, { type: "user_message", content: "a" }));
    midLog.append(ev(2, { type: "user_message", content: "b" }));
    midLog.append(ev(3, { type: "user_message", content: "c" }));
    const midLLM = scriptedLLM([[[text("half"), { type: "finish", reason: "stop" }]].flat()]);
    const midCompactor = loop.createCompactor({
      log: midLog,
      llm: midLLM,
      render,
      cancel: midStop,
      config: {},
      sink: () => midStop.set = true, // the first progress report is the Stop landing
    });
    check((await midCompactor.compact()) === false, "a Stop that lands mid-summary compacts nothing");
    check(midLog.lastCompaction() === null, "and no summary is appended");

    // a retry notice with discard=true restarts the counter and the text
    const retryLog = clc.LazyEventLog.memory();
    retryLog.append(ev(1, { type: "user_message", content: "a" }));
    retryLog.append(ev(2, { type: "user_message", content: "b" }));
    const retryProgress = [];
    const retryLLM = scriptedLLM([[
      text("dead half"),
      { type: "retry", attempt: 1, max: 3, discard: true, message: "Connection interrupted: boom — retrying (1/3)" },
      text("only this"),
      finish(),
    ]]);
    await loop.createCompactor({
      log: retryLog,
      llm: retryLLM,
      render,
      config: {},
      sink: (e) => retryProgress.push(e),
    }).compact();
    check(retryLog.lastCompaction().summary === "only this", "a discarded attempt contributes no byte of the summary");
    check(retryProgress.some((e) => e.note.includes("retrying")), "the retry notice is mirrored into the live block");

    // a failing summary call never kills the run
    const boomLog = clc.LazyEventLog.memory();
    boomLog.append(ev(1, { type: "user_message", content: "a" }));
    boomLog.append(ev(2, { type: "user_message", content: "b" }));
    const stderr = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    let survived;
    try {
      survived = await loop.createCompactor({
        log: boomLog,
        llm: scriptedLLM([llmError("rate_limit", "slow down")]),
        render,
        config: {},
      }).compact();
    } finally {
      process.stderr.write = realWrite;
    }
    check(survived === false, "a failed summary call is a no-op, not a crash");
    check(stderr.join("").includes("[clutch] compaction failed"), "and says so on stderr");
    check(boomLog.lastCompaction() === null, "leaving the log untouched");
  })();
}

// ---- the loop ------------------------------------------------------------

async function runCases() {
  // ---- a complete run: one tool call, then an answer
  const run1 = makeRun({
    llm: scriptedLLM([
      [reasoning("thinking"), text("Reading "), text("a.py"), toolStart(0, "c1", "read_file"), toolArgs(0, '{"path":'), toolArgs(0, ' "a.py"}'), finish("tool_calls")],
      [text("All done."), finish()],
    ]),
  });
  const answer = await run1.agent.run("fix the failing test");
  check(answer === "All done.", "a completed run returns the model's last text");
  const types = run1.log.events().map((e) => e.type);
  check(
    deepEqual(types, ["user_message", "assistant_message", "tool_call", "tool_result", "assistant_message", "final"]),
    `only the six durable kinds reach the log (${types.join(", ")})`
  );
  check(
    deepEqual(run1.sink.map((e) => e.type), [
      "state_update", "user_message", "step_start", "reasoning_delta", "text_delta", "text_delta",
      "tool_call_delta", "tool_call_delta", "tool_call_delta", "assistant_message", "tool_call",
      "tool_result", "step_start", "text_delta", "assistant_message", "final", "state_update",
    ]),
    "the live stream is: state, task, then text -> tools -> results -> text -> final"
  );
  check(run1.sink[0].value === "running" && run1.sink[run1.sink.length - 1].value === "finished", "the run opens as running and closes as finished");
  check(run1.sink.filter((e) => e.type === "tool_call_delta")[0].name === "read_file", "the first tool-call delta names the tool");
  check(run1.sink.filter((e) => e.type === "tool_call_delta")[1].delta === '{"path":', "later deltas carry only argument text");
  check(
    deepEqual(run1.sink.find((e) => e.type === "tool_call").ui, { body: "code", title: "read_file" }),
    "the tool_call event carries the declaration's presentation block"
  );
  check(run1.sink.find((e) => e.type === "tool_call").path_arg === "path", "and the argument its declaration says holds a file");

  const taskEvent = run1.log.events()[0];
  check(run1.workspace.turns.length === 1, "the run opens exactly one rollback checkpoint");
  check(run1.workspace.turns[0] === taskEvent.logOffset, "the checkpoint offset IS the task event's log offset");
  check(taskEvent.logOffset === 0, "a fresh log starts the task at offset 0");

  check(run1.registry.executed.length === 1, "the tool ran once");
  check(deepEqual(run1.registry.executed[0].args, { path: "a.py" }), "with the arguments parsed from the streamed JSON");
  check(run1.registry.executed[0].opts.cancel === null, "and the run's Stop flag (none here) handed through");
  check(run1.workspace.cleared.length === 1, "an executed call clears any one-shot permission afterwards");

  const assistant = run1.log.events()[1];
  check(deepEqual(assistant.tool_calls, [{ id: "c1", name: "read_file", arguments: '{"path": "a.py"}' }]), "the assistant turn is stored with its finished tool calls");
  check(assistant.content === "Reading a.py" && assistant.reasoning === "thinking", "and with the text and reasoning that produced them");
  check(run1.log.events()[2].arguments === '{"path": "a.py"}', "the tool_call record carries the raw arguments verbatim");

  const secondCall = run1.llm.calls[1].messages;
  check(deepEqual(secondCall.map((m) => m.role), ["system", "user", "assistant", "tool"]), "the next turn re-derives: system, task, assistant, tool result");
  check(secondCall[1].content.trim() === "Task: fix the failing test", "the task is re-injected from task.md, not replayed from the log");
  check(secondCall[3].content === "read_file ok", "the tool's answer is the result message");
  check(secondCall[0].content.includes(render("mode_work.md")), "the system prompt carries the run's mode");
  check(deepEqual(run1.llm.calls[0].options.tools, run1.registry.schemas()), "the model is given the registry's schemas, not a hand-written list");

  // ---- a retry notice: discard=true drops the dead attempt's half-sentence
  const retried = makeRun({
    llm: scriptedLLM([[
      text("half an answ"),
      { type: "retry", attempt: 1, max: 3, discard: true, message: "Connection interrupted: boom — retrying (1/3)" },
      text("Real answer."),
      finish(),
    ]]),
  });
  const retriedAnswer = await retried.agent.run("go");
  check(retriedAnswer === "Real answer.", "the retried answer is the one kept");
  const retryEvent = retried.sink.find((e) => e.type === "llm_retry");
  check(retryEvent && retryEvent.attempt === 1 && retryEvent.max_retries === 3, "the retry notice carries the attempt counter the client reported");
  check(retryEvent.discard === true && retryEvent.message.includes("retrying (1/3)"), "and the discard flag with the client's own wording");
  check(retried.log.events().find((e) => e.type === "assistant_message").content === "Real answer.", "the dead attempt's text never reaches the log");
  check(!retried.sink.some((e) => e.type === "assistant_message" && e.content.includes("half")), "and never reaches the view");

  const kept = makeRun({
    llm: scriptedLLM([[
      text("first "),
      { type: "retry", attempt: 1, max: 3, discard: false, message: "Read timed out — retrying (1/3)" },
      text("second"),
      finish(),
    ]]),
  });
  check((await kept.agent.run("go")) === "first second", "a retry that streamed nothing yet keeps what already arrived");

  // ---- error-as-data: a permission refusal is a tool RESULT
  const denyingGate = {
    asked: [],
    require(name, argsRepr, workspace, access, accessArg) {
      denyingGate.asked.push([name, argsRepr, workspace, access, accessArg]);
      const error = new Error("denied");
      error.code = "permission_required";
      error.reason = "write outside the workspace is not allowed";
      throw error;
    },
  };
  const denied = makeRun({
    gate: denyingGate,
    llm: scriptedLLM([callTurn("write_file", '{"path":"/etc/passwd","content":"x"}', "w1"), [text("I will ask first."), finish()]]),
  });
  const deniedAnswer = await denied.agent.run("write outside");
  check(deniedAnswer === "I will ask first.", "a refusal does not end the run: the model reads it and answers");
  const deniedResult = denied.log.events().find((e) => e.type === "tool_result");
  check(deniedResult.is_error === true && deniedResult.content === "ERROR: write outside the workspace is not allowed", "the refusal is fed back as an error result");
  check(denied.registry.executed.length === 0, "and the tool never runs");
  check(denied.workspace.cleared.length === 0, "a refused call clears nothing (it was never allowed)");
  check(deepEqual(denyingGate.asked[0].slice(0, 2), ["write_file", '{"path":"/etc/passwd","content":"x"}']), "the gate is asked with the tool and its raw arguments");
  check(denyingGate.asked[0][3] === "write" && denyingGate.asked[0][4] === "path", "and with the policy the tool's own declaration put it under");

  // ---- a parse failure never reaches the registry
  const parseFail = makeRun({
    llm: scriptedLLM([callTurn("read_file", "{not json"), [text("sorry, retrying"), finish()]]),
  });
  const parseAnswer = await parseFail.agent.run("read it");
  check(parseAnswer === "sorry, retrying", "a parse failure is survivable");
  const parseResult = parseFail.log.events().find((e) => e.type === "tool_result");
  check(parseResult.content.startsWith("ERROR: Argument parse failed: invalid JSON ("), "the model is told the JSON did not parse");
  check(parseResult.content.includes("Regenerate the arguments as a valid JSON object."), "and what to do about it");
  check(parseFail.registry.executed.length === 0, "the tool is not called with arguments that did not parse");
  check(parseFail.workspace.cleared.length === 0, "and nothing is cleared");

  const notObject = makeRun({ llm: scriptedLLM([callTurn("read_file", "[1,2]"), [text("ok"), finish()]]) });
  await notObject.agent.run("x");
  check(
    notObject.log.events().find((e) => e.type === "tool_result").content ===
      "ERROR: Argument parse failed: expected a JSON object, got list.",
    "a JSON array is refused with Python's type name"
  );

  // ---- doom loop: warn once with the real result, then abort
  const doom = makeRun({
    config: { mode: "work", doomLoopLimit: 2 },
    llm: scriptedLLM([
      callTurn("read_file", '{"path":"a.py"}', "d1"),
      callTurn("read_file", '{"path":"a.py"}', "d2"),
      callTurn("read_file", '{"path":"a.py"}', "d3"),
      [text("never reached"), finish()],
    ]),
    registryOptions: { answer: () => ({ content: "same output", error: false, diff: "" }) },
  });
  const doomAnswer = await doom.agent.run("loop forever");
  check(doomAnswer === "ABORTED", "an escalating doom loop aborts the run");
  const results = doom.log.events().filter((e) => e.type === "tool_result");
  check(results.length === 2, "the escalating call is never executed again");
  check(results[1].content.startsWith("same output\n\nERROR: Dead loop detected"), "the first detection keeps the REAL result and appends the warning");
  check(results[1].is_error === true, "and marks the result an error so the model course-corrects");
  const doomFinal = doom.log.events().find((e) => e.type === "final");
  check(doomFinal.status === "aborted" && doomFinal.summary.includes("`read_file`"), "the final names the tool it looped on");
  check(doom.log.events().filter((e) => e.type === "tool_call").length === 3, "the third call is recorded before the abort (a dangling call pair)");
  check(
    loop.toMessages(doom.log.events()).filter((m) => m.role === "tool").length === 2,
    "and the dangling pair is dropped from a replayed context"
  );

  const doomContinue = makeRun({
    config: { mode: "work", doomLoopLimit: 2, abortOnDoomLoop: false },
    llm: scriptedLLM([
      callTurn("read_file", '{"path":"a.py"}', "d1"),
      callTurn("read_file", '{"path":"a.py"}', "d2"),
      callTurn("read_file", '{"path":"a.py"}', "d3"),
      [text("ok, I stopped"), finish()],
    ]),
    registryOptions: { answer: () => ({ content: "same output", error: false, diff: "" }) },
  });
  check((await doomContinue.agent.run("loop")) === "ok, I stopped", "with abortOnDoomLoop off the warning is fed back instead");
  const third = doomContinue.log.events().filter((e) => e.type === "tool_result")[2];
  check(third.content.startsWith("ERROR: Dead loop detected"), "the repeated call is answered with the warning alone");
  check(doomContinue.registry.executed.length === 2, "and the tool is not run a third time");

  // ---- turn budget
  const budget = makeRun({
    config: { mode: "work", maxTurns: 2 },
    llm: scriptedLLM([
      callTurn("read_file", '{"path":"a"}', "b1"),
      callTurn("read_file", '{"path":"b"}', "b2"),
      callTurn("read_file", '{"path":"c"}', "b3"),
    ]),
  });
  check((await budget.agent.run("forever")) === "ABORTED", "the turn budget aborts a run that never finishes");
  check(budget.llm.calls.length === 2, "exactly the allowed number of model calls are made");
  check(
    budget.log.events().find((e) => e.type === "final").summary.includes("maximum of 2 turns"),
    "and the final says which budget was hit"
  );

  // ---- Stop
  const stopped = stopFlag();
  stopped.set = true;
  const never = makeRun({ cancel: stopped, llm: scriptedLLM([[text("x"), finish()]]) });
  check((await never.agent.run("do not start")) === "ABORTED", "a Stop before the first turn aborts the run");
  check(never.llm.calls.length === 0, "without asking the model anything");
  check(never.log.events().find((e) => e.type === "final").summary === render("cancelled.md"), "the final carries the cancelled text");
  check(never.log.events()[0].type === "user_message", "the task is still recorded: the log says what was asked");

  const midStop = stopFlag();
  const cutting = makeRun({
    cancel: midStop,
    registry: fakeRegistry(),
    llm: {
      calls: [],
      stream(messages) {
        this.calls.push(messages);
        return (async function* run() {
          yield text("partial");
          midStop.set = true; // the user hit Stop mid-answer
          yield text(" more");
          yield finish();
        })();
      },
    },
  });
  check((await cutting.agent.run("stop me")) === "ABORTED", "a Stop mid-answer aborts instead of finishing");
  check(!cutting.log.events().some((e) => e.type === "assistant_message"), "the partial turn is not recorded as an assistant message");
  check(cutting.sink.some((e) => e.type === "text_delta" && e.content === "partial"), "though the view saw what had arrived");
  check(cutting.log.events().find((e) => e.type === "final").status === "aborted", "and the final says aborted");

  // ---- max_tokens truncation: ask again, concisely
  const truncated = makeRun({
    llm: scriptedLLM([[text("a very long answer that got cut"), finish("length")], [text("short"), finish()]]),
  });
  check((await truncated.agent.run("explain")) === "short", "a length-truncated turn is not a finished run");
  const retryTask = truncated.log.events().filter((e) => e.type === "user_message")[1];
  check(retryTask.content === render("max_tokens.md"), "the model is told to be concise and the turn repeats");

  // ---- an empty reply is not a completion
  const empty = makeRun({ llm: scriptedLLM([[text("   "), finish()], [text("real"), finish()]]) });
  check((await empty.agent.run("say something")) === "real", "an empty reply does not end the run");
  check(empty.log.events().filter((e) => e.type === "user_message")[1].content === render("empty_response.md"), "it is fed back as an error");

  // ---- a fatal LLM error terminates gracefully, in the code's own words
  const fatal = makeRun({ llm: scriptedLLM([llmError("rate_limit", "slow down, please")]) });
  check((await fatal.agent.run("hi")) === "ABORTED", "a fatal LLM error aborts the run");
  const fatalFinal = fatal.log.events().find((e) => e.type === "final");
  check(fatalFinal.status === "error", "with status error, not aborted");
  check(fatalFinal.summary === "[rate_limit] slow down, please", "and the code in the text (AgentError.__str__)");
  check(fatal.sink[fatal.sink.length - 1].value === "error", "the state machine ends in error");

  // ---- anything that is not an LlmError is a bug: it escapes
  let escaped = null;
  try {
    await makeRun({
      llm: {
        stream() {
          return (async function* run() {
            throw new TypeError("a genuine bug");
          })();
        },
      },
    }).agent.run("x");
  } catch (e) {
    escaped = e;
  }
  check(escaped instanceof TypeError && escaped.message === "a genuine bug", "a non-LlmError is not swallowed by the loop");

  // ---- context overflow: compact once, then continue
  const overflowLog = clc.LazyEventLog.memory();
  overflowLog.append(clc.eventFromDict({ timestamp: 1700000000, id: "p1", type: "user_message", content: "older ask" }));
  overflowLog.append(clc.eventFromDict({ timestamp: 1700000001, id: "p2", type: "assistant_message", content: "older answer" }));
  const overflow = makeRun({
    log: overflowLog,
    // a huge window: the SIZE check never fires, so the provider's refusal is what
    // forces the compaction
    config: { mode: "work", contextWindowBytes: 1e12 },
    llm: scriptedLLM([llmError("context_window_exceeded", "maximum context length is 8192 tokens"), [text("A SUMMARY"), finish()], [text("recovered"), finish()]]),
  });
  check((await overflow.agent.run("new task")) === "recovered", "a context-window refusal compacts and retries instead of dying");
  check(overflowLog.lastCompaction() !== null, "which leaves a compaction event in the log");
  check(overflow.llm.calls.length === 3, "one refused call, one summary call, one successful call");
  check(overflow.llm.calls[1].messages[0].content.includes("[User]: older ask"), "the summary reads the whole window");
  check(overflow.llm.calls[2].messages.some((m) => m.content === render("compaction_head.md", { summary: "A SUMMARY" })), "and the next turn's context is headed by the new summary");

  // ---- the size check compacts before the call
  const sizeLog = clc.LazyEventLog.memory();
  sizeLog.append(clc.eventFromDict({ timestamp: 1700000000, id: "s1", type: "user_message", content: "older ask" }));
  sizeLog.append(clc.eventFromDict({ timestamp: 1700000001, id: "s2", type: "assistant_message", content: "older answer" }));
  const sized = makeRun({
    log: sizeLog,
    config: { mode: "work", contextWindowBytes: 10 },
    llm: scriptedLLM([[text("A SUMMARY"), finish()], [text("answered"), finish()]]),
  });
  check((await sized.agent.run("go")) === "answered", "a full window compacts before the turn instead of failing");
  check(sizeLog.lastCompaction() !== null, "leaving the summary in the log");
  check(sized.llm.calls.length === 2, "one summary call, one turn");

  // ---- a failing subscriber cannot kill the run
  const sinkLog = clc.LazyEventLog.memory();
  const stderr = [];
  const realWrite = process.stderr.write;
  const loud = loop.createAgent({
    llm: scriptedLLM([[text("all good"), finish()]]),
    registry: fakeRegistry(),
    workspace: fakeWorkspace(),
    config: { mode: "work" },
    log: sinkLog,
    render,
    sink: () => {
      throw new Error("subscriber exploded");
    },
  });
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  let loudAnswer;
  try {
    loudAnswer = await loud.run("go");
  } finally {
    process.stderr.write = realWrite;
  }
  check(loudAnswer === "all good", "a throwing sink does not kill the run");
  check(stderr.join("").includes("[clutch] sink error: text_delta"), "it is reported on stderr, by event type");

  // ---- what is stored is what a later session reads back
  const stored = [];
  const storage = clc.LazyEventLog.memory();
  storage.path = "/home/far/p.clc";
  storage.writer = async (file, line) => {
    stored.push(line);
  };
  const written = loop.createAgent({
    llm: scriptedLLM([callTurn("read_file", '{"path":"a.py"}', "c1"), [text("done"), finish()]]),
    registry: fakeRegistry(),
    workspace: fakeWorkspace(),
    config: { mode: "work" },
    log: storage,
    render,
  });
  await written.run("read a.py");
  check(stored.length === 6, `six durable lines are written (${stored.length})`);
  check(stored.every((line) => !line.includes("\n")), "each line is one event, one LF-terminated record");
  const body = Buffer.from(`${stored.join("\n")}\n`, "utf8");
  // reopen the file as the event region it is: `cprLineOff` is non-zero because
  // this fixture has no header — the legacy branch would otherwise derive the
  // window from a compaction line that is not there
  const reopened = await clc.LazyEventLog.open({
    path: "/home/far/p.clc",
    read: async (lo, hi) => body.subarray(lo, hi),
    total: body.length,
    base: 0,
    cprStart: 0,
    cprLineOff: 1,
  });
  check(deepEqual(reopened.events().map((e) => e.type), durable(storage).map((e) => e.type)), "the stored session reopens with the same records");
  check(deepEqual(loop.toMessages(reopened.events()), loop.toMessages(durable(storage))), "and re-derives the same model messages (text -> tools -> results)");
  // the offsets a replay frames the window with: `items()` pairs them, and a
  // reopened log only knows them there — `append` is the one place that stamps
  // the event itself (`agent/core/lazy.py` does the same)
  check(
    deepEqual(reopened.items().map((pair) => pair[0]), storage.items().map((pair) => pair[0])),
    "with the same byte offsets"
  );
}

// ---- the wiring contract -------------------------------------------------

function wiring() {
  const needs = (label, fn) => {
    let threw = null;
    try {
      fn();
    } catch (e) {
      threw = e;
    }
    check(threw instanceof TypeError && threw.message.includes(label), `createAgent refuses a run without ${label}`);
  };
  const base = {
    llm: scriptedLLM([]),
    registry: fakeRegistry(),
    workspace: fakeWorkspace(),
    config: {},
    render,
  };
  needs("llm.stream", () => loop.createAgent(Object.assign({}, base, { llm: {} })));
  needs("render", () => loop.createAgent(Object.assign({}, base, { render: null })));
  needs("the tool registry", () => loop.createAgent(Object.assign({}, base, { registry: {} })));
  needs("pathArg()", () => loop.createAgent(Object.assign({}, base, { registry: Object.assign(fakeRegistry(), { pathArg: undefined }) })));
  needs("the workspace", () => loop.createAgent(Object.assign({}, base, { workspace: { beginTurn() {} } })));

  // a log is optional: a project-less session gets an in-memory one
  const lonely = loop.createAgent(base);
  check(lonely.log && lonely.log.events().length === 0, "a run without a log gets a scratch in-memory one");
  check(typeof lonely.run === "function", "and is runnable");

  // the compactor is reachable for a caller that wants to drive it
  check(typeof lonely.compactor.compact === "function" && typeof lonely.terminator.recordCall === "function", "the run exposes its compactor and its terminator");

  // the registry must never be bypassed: the loop names no tool, it ASKS
  const registry = fakeRegistry();
  const asked = [];
  for (const key of ["ui", "pathArg", "access", "accessArg"]) {
    const original = registry[key];
    registry[key] = (name) => {
      asked.push(`${key}:${name}`);
      return original(name);
    };
  }
  return (async () => {
    const run = loop.createAgent(Object.assign({}, base, { registry, llm: scriptedLLM([[text("ok"), finish()]]) }));
    await run.run("x"); // a plain answer: no tool call, natural finish
    check(asked.includes("ui:x") === false, "a turn with no tool call never asks the registry about a tool");
    const withTool = loop.createAgent(Object.assign({}, base, {
      registry,
      // the policy words are only asked for by a GATED run (agent/loop.py: an
      // ungated one never calls access/access_arg)
      gate: { require: () => {} },
      llm: scriptedLLM([callTurn("write_file", '{"path":"a.py","content":"x"}', "c1"), [text("ok"), finish()]]),
    }));
    await withTool.run("x");
    check(asked.includes("ui:write_file") && asked.includes("pathArg:write_file"), "a call asks the registry how it LOOKS and which argument names a file");
    check(asked.includes("access:write_file") && asked.includes("accessArg:write_file"), "a gated run asks which policy the call is under");
  })();
}

// ---- main ----------------------------------------------------------------

async function main() {
  promptContract();
  sizesAndText();
  eventTextCases();
  messageProjection();
  deriveCases();
  terminator();
  await compactorCases();
  await runCases();
  await wiring();
  summary("host-loop", "all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
