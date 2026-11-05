// ui/run.js is the loop: the fold's next step, done. These checks drive the real
// module through its ports against an in-memory log — no model, no tools, no
// disk — and look only at what landed in the log, because that is the only thing
// that survives the process. They cover the shapes a turn takes (text → tools →
// results, an empty reply, a truncated turn), the shapes a death leaves behind
// (a call with no result, an answer whose final never landed) and the one intent
// the loop keeps in memory (Stop).
// Run: node tests/run.test.js
const { check, summary } = require("./harness.js");
const { createRun } = require("../ui/run.js");
const { foldRun } = require("../ui/run-state.js");

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
  };
}

// Every port wired to the least that does the job; a test overrides the one it
// is about. `text` answers a marked string so a written note is identifiable.
function ports(s, over = {}) {
  return {
    read: s.read,
    append: s.append,
    derive: () => [{ role: "user", content: "task" }],
    model: async () => ({ content: "done", toolCalls: [], finishReason: "stop" }),
    runTool: async () => ({ content: "ok", isError: false, diff: "" }),
    text: (key) => `note:${key}`,
    shouldCompact: async () => false,
    compact: async () => false,
    ...over,
  };
}

const user = (content) => ({ type: "user_message", content });
const said = (content, tool_calls = []) => ({ type: "assistant_message", content, tool_calls, reasoning: "" });
const call = (id, name = "run_command", args = "{}") => ({
  type: "tool_call",
  name,
  arguments: args,
  tool_call_id: id,
  ui: {},
  path_arg: "",
});
const result = (id, content = "ok") => ({
  type: "tool_result",
  tool_call_id: id,
  content,
  is_error: false,
  diff: "",
});
const final = (status, summary) => ({ type: "final", status, summary });

async function main() {
  // ---- 1. every port is required: no default, no quieter loop ----
  {
    const s = store();
    const all = ports(s);
    for (const name of ["read", "append", "derive", "model", "runTool", "text", "shouldCompact", "compact"]) {
      const missing = { ...all };
      delete missing[name];
      let err = null;
      try {
        createRun(missing);
      } catch (e) {
        err = e;
      }
      check(err instanceof TypeError && err.message.includes(`"${name}"`), `a run without its ${name} port refuses to exist, and names it`);
    }
    let err = null;
    try {
      createRun({ ...all, model: "not a function" });
    } catch (e) {
      err = e;
    }
    check(err instanceof TypeError && err.message.includes("model"), "a port that is not a function is not a port");
  }

  // ---- 2. one whole turn: text → tools → results → text → final ----
  {
    const s = store();
    let asked = 0;
    const run = createRun(
      ports(s, {
        model: async ({ messages }) => {
          asked += 1;
          check(Array.isArray(messages) && messages.length > 0, "the model is asked with the derived messages");
          if (asked === 1) {
            return {
              content: "let me look",
              toolCalls: [{ id: "c1", name: "run_command", arguments: '{"cmd":"ls"}', ui: { kind: "command" }, pathArg: "" }],
              finishReason: "stop",
            };
          }
          return { content: "all done", toolCalls: [], finishReason: "stop" };
        },
      })
    );
    const before = await run.state();
    check(before.phase === "idle" && before.next === "start", "an empty log is idle before a task is given");
    const opened = await run.start("  do it  ");
    check(opened.phase === "open" && opened.task === "do it", "start opens the turn with the task, trimmed");
    const out = await run.drive();
    check(out.did === "final" && out.status === "completed", "the turn ends at a completed final");
    check(out.summary === "all done" && out.taken === 4, "four steps: model(tools), result, model(text), final");

    check(
      s.types().join(",") === "user_message,assistant_message,tool_call,tool_result,assistant_message,final",
      "the log reads text → tools → results → text → final, in the order agent/loop.py writes it"
    );
    check(
      s.log[1].content === "let me look" && s.log[1].tool_calls.length === 1 && s.log[1].tool_calls[0].id === "c1",
      "the assistant turn is recorded before the call it asked for, carrying that call"
    );
    check(s.log[2].ui && s.log[2].ui.kind === "command" && s.log[2].path_arg === "", "the call record carries the declaration's ui and path_arg");
    check(s.log[3].tool_call_id === "c1" && s.log[3].content === "ok" && s.log[3].is_error === false, "the result answers the call by id");
    check(s.log[5].status === "completed" && s.log[5].summary === "all done", "the final closes the turn with the sentence the model said");
    check(foldRun(s.log).phase === "idle", "and the fold agrees there is nothing left open");
  }

  // ---- 3. the log is the state: a new process picks a mid-turn log up ----
  {
    // killed after recording the call, before running it
    const s = store([user("do it"), said("looking", [{ id: "c1", name: "run_command", arguments: "{}" }]), call("c1")]);
    let toolRan = 0;
    let asked = 0;
    const run = createRun(
      ports(s, {
        runTool: async ({ call: c }) => {
          toolRan += 1;
          check(c.id === "c1" && c.name === "run_command", "the pending call is handed to the tool as the log recorded it");
          return { content: "listed", isError: false, diff: "" };
        },
        model: async () => {
          asked += 1;
          return { content: "finished", toolCalls: [], finishReason: "stop" };
        },
      })
    );
    const seen = await run.state();
    check(seen.task === "do it", "the task is read off the log, not remembered");
    check(seen.calls.length === 1 && seen.calls[0].id === "c1", "so is the call that has no result");
    const out = await run.drive();
    check(toolRan === 1 && asked === 1, "the tool runs once and the model is asked once");
    check(
      s.log.filter((e) => e.type === "user_message").length === 1,
      "drive() never opens a second turn: the user's task is already on the log"
    );
    check(out.status === "completed" && s.log[s.log.length - 1].summary === "finished", "the resumed turn closes normally");

    // an answer whose final never landed: the next step closes it, no re-ask
    const t = store([user("q"), said("the answer")]);
    let modelCalls = 0;
    const second = createRun(ports(t, { model: async () => ((modelCalls += 1), { content: "other", finishReason: "stop" }) }));
    const closed = await second.drive();
    check(modelCalls === 0, "a durable answer without its final is not asked again");
    check(closed.status === "completed" && closed.summary === "the answer", "the turn closes with the sentence already on the log");
    check(t.log.length === 3 && t.log[2].summary === "the answer", "and nothing but the final was written");
  }

  // ---- 4. an empty reply is not a completion ----
  {
    const s = store();
    let asked = 0;
    const run = createRun(
      ports(s, {
        model: async () => {
          asked += 1;
          return asked === 1 ? { content: "   ", toolCalls: [], finishReason: "stop" } : { content: "here it is", toolCalls: [], finishReason: "stop" };
        },
        text: (key) => (key === "empty_response" ? "you said nothing" : `note:${key}`),
      })
    );
    await run.start("q");
    const out = await run.drive();
    check(asked === 2, "the model is asked again after an empty reply");
    check(
      s.types().join(",") === "user_message,assistant_message,user_message,assistant_message,final",
      "the empty assistant turn is durable, followed by the loop's own note"
    );
    check(s.log[1].content.trim() === "" && s.log[2].content === "you said nothing", "the note is the loop's words, not the model's");
    check(out.status === "completed" && out.summary === "here it is", "the turn ends on the real answer");
  }

  // ---- 5. a truncated turn is not an answer and its calls do not run ----
  {
    const s = store();
    let toolRan = 0;
    let asked = 0;
    const run = createRun(
      ports(s, {
        model: async () => {
          asked += 1;
          if (asked === 1) {
            return {
              content: "half a sen",
              toolCalls: [{ id: "c1", name: "run_command", arguments: "{}" }],
              finishReason: "length",
            };
          }
          return { content: "concise", toolCalls: [], finishReason: "stop" };
        },
        runTool: async () => ((toolRan += 1), { content: "ok" }),
        text: (key) => (key === "max_tokens" ? "be concise" : `note:${key}`),
      })
    );
    await run.start("q");
    const out = await run.drive();
    check(toolRan === 0, "a call from a cut-off turn is never executed");
    check(
      s.types().join(",") === "user_message,user_message,assistant_message,final",
      "the half turn is dropped: only the note, then the next answer and its final"
    );
    check(s.log[1].content === "be concise", "the note is the max_tokens prompt");
    check(out.summary === "concise", "the turn ends on the untruncated answer");
  }

  // ---- 6. Stop is an intent, and the aborted final is the only thing it writes ----
  {
    // (a) stopping between steps closes the open turn as aborted
    const s = store([user("do it")]);
    const run = createRun(ports(s));
    run.stop();
    const out = await run.step();
    check(out.did === "final" && out.status === "aborted", "a stop on an open turn ends it as aborted");
    check(s.log.length === 2 && s.log[1].type === "final" && s.log[1].status === "aborted", "the log holds the task and one aborted final");
    check(s.log[1].summary === "note:cancelled", "the words are the loop's own (the cancelled prompt)");

    // (b) stopping with the model in flight aborts the call and writes the same final
    const t = store([user("do it")]);
    let sawAbort = false;
    let entered = null;
    const modelEntered = new Promise((resolve) => (entered = resolve));
    const slow = createRun(
      ports(t, {
        model: ({ signal }) =>
          new Promise((_, reject) => {
            entered();
            signal.addEventListener("abort", () => {
              sawAbort = true;
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      })
    );
    const flying = slow.step();
    await modelEntered;
    slow.stop();
    const after = await flying;
    check(sawAbort, "stop() aborts the call that is in flight, not just a flag");
    check(after.status === "aborted" && t.log[t.log.length - 1].status === "aborted", "the aborted call still closes the turn, and its rejection does not escape");

    // (b2) a stop that lands while the log is still being read costs no call at
    // all — the read is a round trip now, and the step re-checks the intent after
    // it. The turn still closes, because the log is the only state.
    {
      let asked = 0;
      let openRead = null;
      const slowRead = {
        log: [user("do it")],
        read: () =>
          new Promise((resolve) => {
            openRead = () => resolve(slowRead.log.slice());
          }),
        append: async (ev) => {
          slowRead.log.push(ev);
          return { ...ev, log_offset: slowRead.log.length - 1 };
        },
      };
      const run = createRun(
        ports(slowRead, {
          model: async () => {
            asked += 1;
            return { content: "too late", toolCalls: [], finishReason: "stop" };
          },
        })
      );
      const pending = run.step();
      run.stop();
      openRead();
      const out = await pending;
      check(asked === 0, "a stop during the read means the model is never asked");
      check(out.status === "aborted" && slowRead.log[slowRead.log.length - 1].status === "aborted", "and the open turn still closes as aborted");
    }

    // (c) stopping an idle run does nothing at all
    const u = store();
    const idle = createRun(ports(u));
    idle.stop();
    const nothing = await idle.drive();
    check(nothing.did === "idle" && u.log.length === 0, "stopping an idle run writes nothing — there is no turn to abort");

    // (d) the next task is not born stopped
    const v = store();
    const next = createRun(ports(v));
    next.stop();
    await next.start("fresh");
    const done = await next.drive();
    check(done.status === "completed" && v.log.length === 3, "a new turn clears the old stop: the intent belonged to the turn before it");
  }

  // ---- 7. a failure is raised, never written as a final the log would believe ----
  {
    const s = store([user("do it")]);
    const boom = createRun(
      ports(s, {
        model: async () => {
          throw new Error("connection reset");
        },
      })
    );
    let err = null;
    try {
      await boom.drive();
    } catch (e) {
      err = e;
    }
    check(err && err.message === "connection reset", "a model failure is the caller's to see");
    check(s.log.length === 1, "and it writes nothing: the turn stays open for the next process to pick up");

    const t = store([user("do it"), said("", [{ id: "c1", name: "run_command", arguments: "{}" }]), call("c1")]);
    let attempts = 0;
    const flaky = createRun(
      ports(t, {
        runTool: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("tool host unreachable");
          return { content: "ran", isError: false, diff: "" };
        },
      })
    );
    let toolErr = null;
    try {
      await flaky.step();
    } catch (e) {
      toolErr = e;
    }
    check(toolErr && toolErr.message === "tool host unreachable", "a tool that cannot run raises instead of inventing a result");
    check(t.log.filter((e) => e.type === "tool_result").length === 0, "nothing was recorded for the call that did not run");
    const retried = await flaky.step();
    check(retried.did === "tool" && retried.calls[0].id === "c1", "the next step retries the call the log still shows as unanswered");
    check(t.log[t.log.length - 1].content === "ran", "and its result is what lands");
  }

  // ---- 8. starting is an invariant, not a courtesy ----
  {
    const s = store([user("already going")]);
    const run = createRun(ports(s));
    let err = null;
    try {
      await run.start("again");
    } catch (e) {
      err = e;
    }
    check(err && /already open/.test(err.message), "a second start refuses while a turn is open");
    check(s.log.length === 1, "and writes nothing");

    const t = store();
    const other = createRun(ports(t));
    for (const bad of ["", "   ", undefined, 42]) {
      let refused = null;
      try {
        await other.start(bad);
      } catch (e) {
        refused = e;
      }
      check(refused instanceof TypeError, `start(${JSON.stringify(bad)}) is refused`);
    }
    check(t.log.length === 0, "a refused start leaves the log alone");
  }

  // ---- 9. one step at a time; the append is the log's word, not the loop's ----
  {
    const s = store();
    let release = null;
    let entered = null;
    const modelEntered = new Promise((resolve) => (entered = resolve));
    const run = createRun(
      ports(s, {
        model: () =>
          new Promise((resolve) => {
            entered();
            release = () => resolve({ content: "later", toolCalls: [], finishReason: "stop" });
          }),
      })
    );
    await run.start("q");
    const first = run.step();
    let err = null;
    try {
      await run.step();
    } catch (e) {
      err = e;
    }
    check(err && /already running/.test(err.message), "a step cannot race another step");
    await modelEntered;
    release();
    await first;
    check(s.log[s.log.length - 1].type === "assistant_message", "the first step finishes normally");

    // what append answers is what the loop treats as persisted (the stamped line)
    const t = store();
    let stamped = null;
    const seen = createRun(
      ports(t, {
        append: async (ev) => {
          stamped = { ...ev, log_offset: 99 };
          t.log.push(stamped);
          return stamped;
        },
      })
    );
    await seen.start("q");
    check(stamped && stamped.log_offset === 99, "the loop takes the line the append hands back");
  }

  // ---- 10. the window is checked before the model is asked, never after ----
  {
    // (a) a full window is compacted first, and the next step asks with messages
    // derived from the SHORTENED log, not the ones the last step had
    const s = store([user("do it")]);
    const order = [];
    let asks = 0;
    let compactions = 0;
    let derivedFrom = -1;
    const run = createRun(
      ports(s, {
        derive: ({ events }) => {
          derivedFrom = events.length;
          return [{ role: "user", content: `window:${events.length}` }];
        },
        shouldCompact: async () => true,
        compact: async ({ signal }) => {
          compactions += 1;
          order.push("compact");
          check(signal && typeof signal.aborted === "boolean", "the summary call can be stopped like every other call");
          if (compactions === 1) {
            s.log.push({ type: "compaction", summary: "so far" });
            return true;
          }
          return false;
        },
        model: async () => {
          asks += 1;
          order.push("model");
          return { content: "done", toolCalls: [], finishReason: "stop" };
        },
      })
    );
    const out = await run.drive();
    check(order.join(",") === "compact,compact,model", "the compaction is asked before the model, and re-asked after it changed the log");
    check(asks === 1 && compactions === 2, "the model is asked once — after the window was shortened");
    check(derivedFrom === 2, "the messages are derived after the compaction line landed, not before");
    check(out.status === "completed" && s.types().slice(-2).join(",") === "assistant_message,final", "the turn closes normally over the shorter window");

    // (b) a compaction that cannot happen is not fatal: the turn proceeds with
    // what it has instead of dropping the work or aborting
    const t = store([user("do it")]);
    let askedAnyway = 0;
    const soft = createRun(
      ports(t, {
        shouldCompact: async () => true,
        compact: async () => false,
        model: async () => {
          askedAnyway += 1;
          return { content: "still here", toolCalls: [], finishReason: "stop" };
        },
      })
    );
    const softOut = await soft.drive();
    check(askedAnyway === 1 && softOut.status === "completed", "a failed compaction leaves the derived messages valid and the turn running");

    // (c) the provider disagrees with our byte count: force one compaction and
    // ask again — and only then let the failure out
    const u = store([user("do it")]);
    let models = 0;
    let forced = 0;
    const overflow = () => {
      const e = new Error("too many tokens");
      e.code = "context_window_exceeded";
      return e;
    };
    const retried = createRun(
      ports(u, {
        shouldCompact: async () => false,
        compact: async () => {
          forced += 1;
          return true;
        },
        model: async () => {
          models += 1;
          if (models === 1) throw overflow();
          return { content: "fits now", toolCalls: [], finishReason: "stop" };
        },
      })
    );
    const fixed = await retried.drive();
    check(forced === 1 && models === 2, "one forced compaction, then the same question again");
    check(fixed.status === "completed" && fixed.summary === "fits now", "the retried ask closes the turn");

    const v = store([user("do it")]);
    const hopeless = createRun(
      ports(v, {
        shouldCompact: async () => false,
        compact: async () => false,
        model: async () => {
          throw overflow();
        },
      })
    );
    let overflowErr = null;
    try {
      await hopeless.drive();
    } catch (e) {
      overflowErr = e;
    }
    check(overflowErr && overflowErr.code === "context_window_exceeded", "a window that stays too full is the caller's problem, not a silent final");
    check(v.types().join(",") === "user_message", "and nothing was invented on the log to pretend the turn ended");

    // (d) Stop reaches the summary call, and the turn still closes as aborted
    const w = store([user("do it")]);
    let summaryStarted = null;
    const compacting = new Promise((resolve) => (summaryStarted = resolve));
    const stopping = createRun(
      ports(w, {
        shouldCompact: async () => true,
        compact: ({ signal }) =>
          new Promise((resolve) => {
            summaryStarted();
            signal.addEventListener("abort", () => resolve(false));
          }),
        model: async () => {
          throw new Error("the model must not be asked after a stop");
        },
      })
    );
    const pending = stopping.step();
    await compacting;
    stopping.stop();
    const stoppedOut = await pending;
    check(stoppedOut.status === "aborted" && w.log[w.log.length - 1].status === "aborted", "a stop during the summary aborts the turn, not the compaction alone");
  }

  summary("run: the fold's next step, done (ports / one turn / resume / stop)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
