// The loop's own termination (P4-3): the turn budget and the doom-loop guard.
//
// Both used to be the backend loop's checks (agent/core/terminate.py, deleted
// with this port): the Python half counted `turn` in its run loop and kept a
// window of the last calls' (name, arguments, result). The loop is the client's
// now, so this is where the rules live — and these checks drive the REAL module
// through its ports against an in-memory log, looking only at what landed in the
// log, because that is the only thing that survives the process.
//
// What is pinned:
//
//  1. No `limits` port means no budget and no guard: exactly the behaviour the
//     loop had before the guard moved here.
//  2. `limits` that could not have come from agent/config.py is refused by name
//     at construction.
//  3. The budget counts the model turns the LOG holds, so a turn resumed in a
//     new process is counted the same, and an over-budget turn is closed as
//     aborted BEFORE the model is asked again.
//  4. A doom loop is N identical calls — same name, same arguments AND the same
//     result. The first detection keeps the real result and appends the warning.
//  5. Repeating the exact warned call does not run it: the turn is aborted by
//     default, or told why not when abort_on_doom_loop is off.
//  6. Identical calls whose results change are progress, not a loop.
//  7. A different call forgives the warning, so a later legitimate use of the
//     same tool starts a fresh cycle instead of aborting an old one.
//  8. A new task starts a fresh cycle, as the Python window did (it lived on an
//     Agent built per run).
//
// Run: node tests/run-limits-test.js
"use strict";

const { check, summary } = require("./harness.js");
const { createRun } = require("../ui/run.js");

// ---- the log as the loop sees it: one array, appended to, read back ----
function store(events = []) {
  const log = events.slice();
  return {
    log,
    read: async () => log.slice(),
    append: async (ev) => {
      log.push(ev);
      return { ...ev, log_offset: log.length - 1 };
    },
    types: () => log.map((e) => e.type),
    results: () => log.filter((e) => e.type === "tool_result").map((e) => e.content),
  };
}

// The loop's prose, recorded: a final's slots are then visible in the assertion
// instead of hidden inside a template (the templates themselves are pinned by
// tests/prompt.test.js).
function prosePort() {
  const asked = [];
  const text = (key, vars) => {
    asked.push({ key, vars });
    const slots = [];
    if (vars && vars.tool !== undefined) slots.push(String(vars.tool));
    if (vars && vars.max_turns !== undefined) slots.push(String(vars.max_turns));
    return `note:${key}${slots.length ? ":" + slots.join(":") : ""}`;
  };
  return { text, asked };
}

// A model that answers from a script: an array (the last answer repeats) or a
// function of the turn number. `count()` is how many times it was asked.
function scriptedModel(answers) {
  let n = 0;
  const model = async () => {
    n += 1;
    if (typeof answers === "function") return answers(n);
    return answers[Math.min(n - 1, answers.length - 1)];
  };
  model.count = () => n;
  return model;
}

// A tool whose result a test scripts; `ran` is the calls it actually executed.
function scriptedTool(results) {
  const ran = [];
  const runTool = async ({ call }) => {
    ran.push(call);
    const content = typeof results === "function" ? results(ran.length, call) : results;
    return { content, isError: false, diff: "" };
  };
  runTool.ran = ran;
  return runTool;
}

// The model asks for one call. `args` is the raw JSON string the registry would
// have produced — the guard compares it byte for byte, like terminate.py did.
function callsOne(id, args = "{}", name = "run_command") {
  return {
    content: "",
    toolCalls: [{ id, name, arguments: args, ui: {}, pathArg: "" }],
    finishReason: "stop",
  };
}

const answersText = (content) => ({ content, toolCalls: [], finishReason: "stop" });

async function harness({ limits, answers, results, events } = {}) {
  const s = store(events);
  const prose = prosePort();
  const model = scriptedModel(answers);
  const tool = scriptedTool(results);
  const ports = {
    read: s.read,
    append: s.append,
    derive: () => [{ role: "user", content: "task" }],
    model,
    runTool: tool,
    text: prose.text,
    shouldCompact: async () => false,
    compact: async () => false,
  };
  const run = createRun(limits === undefined ? ports : { ...ports, limits });
  return { run, s, model, tool, prose };
}

async function main() {
  // ---- 1. no limits port: no budget, no guard (the loop as it was) ----
  {
    const { run, s, tool } = await harness({
      answers: (n) => callsOne(`c${n}`, '{"cmd":"ls"}'),
      results: () => "same output",
    });
    await run.start("try forever");
    for (let i = 0; i < 8; i++) await run.step();
    check(tool.ran.length === 4, "without a limits port every call runs: four identical calls, four runs");
    check(
      s.results().every((content) => content === "same output"),
      "and no warning is ever appended: the guard is off"
    );
    check(!s.log.some((e) => e.type === "final"), "the turn is still open — nothing aborted it");
  }

  // ---- 2. a limit that could not have come from the config is refused ----
  {
    const refuses = (limits, label, re) => {
      const ports = {
        read: async () => [],
        append: async (ev) => ev,
        derive: () => [{ role: "user", content: "t" }],
        model: async () => answersText("x"),
        runTool: async () => ({ content: "", isError: false, diff: "" }),
        text: (key) => `note:${key}`,
        shouldCompact: async () => false,
        compact: async () => false,
        limits,
      };
      let threw = null;
      try {
        createRun(ports);
      } catch (e) {
        threw = e;
      }
      check(threw instanceof TypeError && re.test(threw.message), label);
    };
    refuses("on", "limits that are not an object are refused", /limits must be/);
    refuses({ maxTurns: -1 }, "a negative budget is refused", /limits\.maxTurns must be/);
    refuses({ maxTurns: 1.5 }, "half a turn is refused", /limits\.maxTurns must be/);
    refuses({ maxTurns: "3" }, "a budget given as a string is refused", /limits\.maxTurns must be/);
    refuses({ doomLoopLimit: -1 }, "a negative doom window is refused", /limits\.doomLoopLimit must be/);
    refuses({ doomLoopLimit: 2.5 }, "half a call is refused", /limits\.doomLoopLimit must be/);

    // ...and a limit the config could have served is accepted, with the rest off
    const { run } = await harness({ limits: { maxTurns: 4 } });
    check(typeof run.step === "function", "a bare maxTurns is a limit: the guard and the abort default to off");
  }

  // ---- 3. the budget: counted from the log, checked before the model ----
  {
    const { run, s, model, prose } = await harness({
      limits: { maxTurns: 2, doomLoopLimit: 0, abortOnDoomLoop: true },
      // a different call each turn, so the doom guard (off anyway) cannot be what
      // ends this turn
      answers: (n) => callsOne(`c${n}`, `{"cmd":"ls ${n}"}`),
      results: () => "ok",
    });
    await run.start("go until the budget stops you");
    const out = await run.drive();
    check(out.did === "final" && out.status === "aborted", "a turn over budget ends as aborted");
    check(out.summary === "note:budget_exceeded:2", "the final is the budget prose, carrying the configured limit");
    check(model.count() === 2, "the model was asked twice — the third turn never happened");
    check(
      s.log.filter((e) => e.type === "assistant_message").length === 2,
      "the log holds exactly two model turns, the same number the budget counted"
    );
    check(
      s.log[s.log.length - 1].type === "final",
      "and the aborted final is the last line: nothing was written after the budget was hit"
    );
    const asked = prose.asked.find((a) => a.key === "budget_exceeded");
    check(
      Boolean(asked) && asked.vars && asked.vars.max_turns === 2,
      "the prose is rendered with $max_turns as a number, never with the slot in it"
    );
  }

  // ---- 3b. the budget survives a restart: it counts the LOG, not this process ----
  {
    // A turn that died after two model turns, both empty replies, so the fold's
    // next step is "model" again. No `start()` — this is a resume, and the count
    // has to come from what is on disk.
    const died = [
      { type: "user_message", content: "the task" },
      { type: "assistant_message", content: "", tool_calls: [], reasoning: "" },
      { type: "user_message", content: "note:empty_response" },
      { type: "assistant_message", content: "", tool_calls: [], reasoning: "" },
      { type: "user_message", content: "note:empty_response" },
    ];
    const { run, model } = await harness({
      limits: { maxTurns: 2, doomLoopLimit: 0, abortOnDoomLoop: true },
      answers: (n) => callsOne(`c${n}`),
      results: () => "ok",
      events: died,
    });
    const out = await run.step();
    check(out.did === "final" && out.status === "aborted", "a resumed turn that is already over budget ends at once");
    check(model.count() === 0, "without asking the model a question it has no budget left to answer");
  }

  // ---- 4. the doom loop: N identical calls earn ONE warning ----
  {
    const { run, s, tool } = await harness({
      limits: { maxTurns: 0, doomLoopLimit: 3, abortOnDoomLoop: true },
      answers: (n) => callsOne(`c${n}`, '{"cmd":"ls"}'),
      results: () => "same output",
    });
    await run.start("loop");
    for (let i = 0; i < 6; i++) await run.step(); // model, run, model, run, model, run
    const results = s.results();
    check(results.length === 3, "three calls ran, so three results are on the log");
    check(results[0] === "same output" && results[1] === "same output", "the first two results are the tool's own words");
    check(
      results[2] === "same output\n\nnote:doom_loop:run_command",
      "the third keeps the real result and appends the warning"
    );
    check(
      s.log.filter((e) => e.type === "tool_result")[2].is_error === true,
      "and is recorded as an error, so the model reads it as a problem to fix"
    );
    check(tool.ran.length === 3, "the tool ran three times: the guard judges a call by the result it produced");
  }

  // ---- 5. repeating the warned call: aborted by default, never run again ----
  {
    const { run, s, tool, prose } = await harness({
      limits: { maxTurns: 0, doomLoopLimit: 3, abortOnDoomLoop: true },
      answers: (n) => callsOne(`c${n}`, '{"cmd":"ls"}'),
      results: () => "same output",
    });
    await run.start("loop");
    for (let i = 0; i < 6; i++) await run.step();
    await run.step(); // the model asks for the warned call again
    const out = await run.step(); // ...and the turn ends instead of running it
    check(out.did === "final" && out.status === "aborted", "the exact warned call ends the turn as aborted");
    check(out.summary === "note:doom_loop:run_command", "the final is the doom prose, naming the tool");
    check(tool.ran.length === 3, "the warned call is not run a fourth time — that is what the guard is for");
    check(
      s.log[s.log.length - 1].type === "final",
      "the aborted final closes the turn with no result for the call it refused to repeat"
    );
    const asked = prose.asked.filter((a) => a.key === "doom_loop").pop();
    check(
      Boolean(asked) && asked.vars && asked.vars.tool === "run_command",
      "the prose is rendered with $tool filled in"
    );
  }

  // ---- 5b. abort_on_doom_loop off: told why not, and the turn goes on ----
  {
    const { run, s, tool, prose } = await harness({
      limits: { maxTurns: 0, doomLoopLimit: 3, abortOnDoomLoop: false },
      // the warned call, then a model that takes the hint and answers — with the
      // abort off, that answer is the only thing that ends this turn
      answers: (n) => (n >= 8 ? answersText("I'll try something else") : callsOne(`c${n}`, '{"cmd":"ls"}')),
      results: () => "same output",
    });
    await run.start("loop");
    for (let i = 0; i < 6; i++) await run.step();
    await run.step(); // model asks for the warned call again
    const out = await run.step(); // ...which is answered with the warning, not run
    check(out.did === "tool" && out.calls.length === 1, "with the abort off the step still answers the call");
    const last = s.log.filter((e) => e.type === "tool_result").pop();
    check(
      last.content === "note:doom_loop:run_command" && last.is_error === true,
      "the result is the warning alone, as an error — the tool's real output is not invented"
    );
    check(tool.ran.length === 3, "and the tool is still not run again");
    check(prose.asked.some((a) => a.key === "doom_loop"), "the same prose, on the other path");

    // the turn keeps going: the model can change its approach and finish
    const done = await run.drive();
    check(done.did === "final", "the turn continues after the warning (a model answer, then a final)");
  }

  // ---- 6. identical calls whose results change are progress ----
  {
    const { run, s, tool } = await harness({
      limits: { maxTurns: 0, doomLoopLimit: 2, abortOnDoomLoop: true },
      answers: (n) => callsOne(`c${n}`, '{"cmd":"ls"}'),
      results: (n) => `output ${n}`,
    });
    await run.start("poll");
    for (let i = 0; i < 8; i++) await run.step();
    check(tool.ran.length === 4, "four identical calls all ran");
    check(
      s.results().every((content) => !content.includes("note:doom_loop")),
      "and none was called a loop: a result that changes is progress (polling, a flaky test)"
    );
  }

  // ---- 7. a different call forgives the warning ----
  {
    const { run, s, tool } = await harness({
      limits: { maxTurns: 0, doomLoopLimit: 2, abortOnDoomLoop: true },
      // a, a (warns), b (the model moved on), a (a NEW cycle starts: this must run)
      answers: (n) => callsOne(`c${n}`, n === 3 ? '{"cmd":"git status"}' : '{"cmd":"ls"}'),
      results: () => "same output",
    });
    await run.start("try a different command");
    for (let i = 0; i < 6; i++) await run.step(); // a, a, b and their results
    await run.step(); // the model goes back to the first call
    const out = await run.step(); // ...which must run, not escalate
    check(out.did === "tool" && tool.ran.length === 4, "the first call runs again after another call intervened");
    check(
      s.log.filter((e) => e.type === "tool_result").pop().content === "same output",
      "with no warning: the model moved on, so the old warning is forgiven"
    );
    check(!s.log.some((e) => e.type === "final"), "and the turn was not aborted for it");
  }

  // ---- 8. a new task is a fresh cycle ----
  {
    const { run, tool } = await harness({
      limits: { maxTurns: 0, doomLoopLimit: 1, abortOnDoomLoop: true },
      answers: (n) => callsOne(`c${n}`, '{"cmd":"ls"}'),
      results: () => "same output",
    });
    await run.start("first task");
    await run.step(); // model asks c1
    await run.step(); // c1 runs and — with a window of one — earns the warning
    await run.step(); // model asks c2, the exact warned call
    const ended = await run.step();
    check(ended.did === "final" && ended.status === "aborted", "the repeated call ends the first task");
    check(tool.ran.length === 1, "and is not run");

    await run.start("second task");
    await run.step(); // model asks c3
    const ran = await run.step();
    check(ran.did === "tool" && tool.ran.length === 2, "a new task starts a fresh cycle: the same call runs again");
  }

  summary("run-limits: the turn budget and the doom-loop guard, in the loop that enforces them");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
