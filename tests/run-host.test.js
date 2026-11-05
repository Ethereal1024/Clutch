// ui/run-host.js is the composition root: the one place that decides which log,
// which model and which tool executor a turn runs against, and the one place the
// two event vocabularies meet (the client's wire deltas and the page's own).
//
// These checks drive the REAL host over a fake byte-addressed log, a fake client
// and a fake registry, with nothing stubbed in between: the derive, the
// compactor and the prompts are the shipped ones. What they look at is the
// boundary — what the model was asked, what the page was told, and what the log
// holds — because those three are all a later reader has.
// Run: node tests/run-host.test.js
const { check, summary } = require("./harness.js");
const { createRunHost } = require("../ui/run-host.js");
const { DURABLE_TYPES } = require("../ui/run-state.js");
const { say } = require("../ui/prompt.js");

// The display-only vocabulary: what /events carries and the .clc never does
// (agent/events.py's non-durable types; `permission_request` is the execution
// layer's, so the host is not expected to emit it).
const DISPLAY_TYPES = new Set([
  "step_start",
  "text_delta",
  "reasoning_delta",
  "tool_call_delta",
  "compaction_delta",
  "llm_retry",
  "state_update",
]);

// ---- the .clc as the log layer will hand it over (P2) ----
//
// Byte-addressed on purpose: the compactor compares `offset >= cprStart` and
// slides the window to an append's `log_offset`, so an offset that is only an
// array index would let a broken window go unnoticed. `items` deliberately keeps
// the events before `cprStart`: the read contract is the window PLUS the open
// turn's head (the fold answers the task from it), and the compactor filters by
// offset itself.
function byteLog(events = []) {
  const items = []; // {offset, event, bytes}
  const slides = [];
  let end = 0;
  let cprStart = 0;
  let lastCompaction = null;

  function push(ev) {
    const bytes = Buffer.byteLength(JSON.stringify(ev), "utf8") + 1;
    const offset = end;
    items.push({ offset, event: ev, bytes });
    end += bytes;
    if (ev.type === "compaction") lastCompaction = ev;
    return { ...ev, log_offset: offset };
  }
  for (const ev of events) push(ev);

  return {
    items,
    slides,
    read: async () => ({
      items: items.map((it) => ({ offset: it.offset, event: it.event })),
      windowBytes: end - cprStart,
      cprStart,
      lastCompaction,
    }),
    append: async (ev) => push(ev),
    slideWindow: async (off) => {
      slides.push(off);
      if (typeof off === "number" && off >= 0 && off <= end) cprStart = off;
    },
    // for the checks, not for the host
    types: () => items.map((it) => it.event.type),
    events: () => items.map((it) => it.event),
    windowStart: () => cprStart,
    line: (off) => items.find((it) => it.offset === off),
  };
}

// ---- the client (ui/llm-client.js's answer shape) ----
//
// One scripted answer per ask; an answer may emit the wire deltas first, which is
// exactly the order the real client produces them in.
function fakeLlm(script = []) {
  const asks = [];
  const llm = {
    asks,
    ask: async ({ messages, tools, signal, onEvent, onRetry }) => {
      asks.push({ messages, tools, signal });
      const step = script[asks.length - 1] || {};
      if (typeof step.emit === "function") step.emit({ onEvent: onEvent || (() => {}), onRetry: onRetry || (() => {}) });
      if (step.error) throw step.error;
      return {
        content: typeof step.content === "string" ? step.content : "",
        toolCalls: step.toolCalls || [],
        finishReason: step.finishReason || "stop",
        reasoning: step.reasoning || "",
      };
    },
    // the compactor's summarizer: a stream of the same events
    stream: async function* ({ messages, tools, signal }) {
      const text = typeof llm.summaryText === "string" ? llm.summaryText : "the earlier conversation, summarized";
      for (const chunk of text.match(/.{1,8}/gs) || []) yield { type: "text", delta: chunk };
      yield { type: "finish" };
    },
    summaryText: "the earlier conversation, summarized",
  };
  return llm;
}

// ---- the registry + the execution endpoint (P3) ----
function fakeTools(over = {}) {
  const state = { schemaCalls: 0, ran: [], uiCalls: [] };
  const tools = {
    state,
    schemas: () => {
      state.schemaCalls += 1;
      return [{ type: "function", function: { name: "run_command" } }];
    },
    ui: (name) => {
      state.uiCalls.push(name);
      return name === "run_command" ? { kind: "command" } : {};
    },
    pathArg: (name) => (name === "read_file" ? "path" : ""),
    run: async (arg) => {
      state.ran.push(arg);
      return { content: "exit 0\n", isError: false, diff: "" };
    },
    ...over,
  };
  return tools;
}

function session(over = {}) {
  return { mode: "work", components: "", shell: "posix-sh", memory: null, ...over };
}

// Everything wired; a check overrides the one piece it is about.
function hostWith(ports = {}) {
  const emitted = [];
  const log = ports.log || byteLog();
  const llm = ports.llm || fakeLlm();
  const tools = ports.tools || fakeTools();
  const host = createRunHost({
    log,
    llm,
    tools,
    session: ports.session || session(),
    contextWindowBytes: ports.contextWindowBytes || 1_000_000,
    onEvent: (ev) => emitted.push(ev),
    ...(ports.onEvent ? { onEvent: ports.onEvent } : {}),
  });
  return { host, log, llm, tools, emitted };
}

const TASK = "list the directory and tell me what is there";
const user = (content) => ({ type: "user_message", content });
const said = (content) => ({ type: "assistant_message", content, tool_calls: [], reasoning: "" });
const final = (status, summaryText) => ({ type: "final", status, summary: summaryText });
const typesOf = (events) => events.map((e) => e.type);
const delta = (ev) => ev.type === "text_delta" && ev.content === "let me look";

async function main() {
  // ---------------------------------------------------------------- 1. ports
  {
    const base = () => ({ log: byteLog(), llm: fakeLlm(), tools: fakeTools(), session: session(), contextWindowBytes: 1000 });
    const refuses = (mutate, label, re = /run-host/) => {
      const ports = base();
      mutate(ports);
      let threw = null;
      try {
        createRunHost(ports);
      } catch (e) {
        threw = e;
      }
      check(threw instanceof TypeError && re.test(threw.message), label);
    };

    refuses((p) => (p.log = null), "no log is refused");
    refuses((p) => (p.llm = null), "no llm is refused");
    refuses((p) => (p.tools = null), "no tools registry is refused");
    refuses((p) => (p.session = null), "no session is refused");
    refuses((p) => delete p.log.read, "log.read is required", /run-host: log\.read is required/);
    refuses((p) => delete p.log.append, "log.append is required", /run-host: log\.append is required/);
    refuses((p) => delete p.log.slideWindow, "log.slideWindow is required", /run-host: log\.slideWindow is required/);
    refuses((p) => delete p.llm.ask, "llm.ask is required", /run-host: llm\.ask is required/);
    refuses((p) => delete p.llm.stream, "llm.stream is required", /run-host: llm\.stream is required/);
    refuses((p) => delete p.tools.schemas, "tools.schemas is required", /run-host: tools\.schemas is required/);
    refuses((p) => delete p.tools.ui, "tools.ui is required", /run-host: tools\.ui is required/);
    refuses((p) => delete p.tools.pathArg, "tools.pathArg is required", /run-host: tools\.pathArg is required/);
    refuses((p) => delete p.tools.run, "tools.run is required", /run-host: tools\.run is required/);
    refuses((p) => (p.contextWindowBytes = 0), "a zero window is refused", /positive number of bytes/);
    refuses((p) => (p.contextWindowBytes = -5), "a negative window is refused", /positive number of bytes/);
    refuses((p) => (p.contextWindowBytes = NaN), "a NaN window is refused", /positive number of bytes/);
    refuses((p) => (p.contextWindowBytes = "1000"), "a window given as a string is refused", /positive number of bytes/);
    refuses((p) => delete p.contextWindowBytes, "a missing window is refused", /positive number of bytes/);

    const { host } = hostWith();
    check(
      typeof host.start === "function" &&
        typeof host.stop === "function" &&
        typeof host.step === "function" &&
        typeof host.drive === "function" &&
        typeof host.state === "function",
      "a fully wired host answers the loop's own five entry points"
    );
    // a broken page feed changes nothing: the emission is fire and forget
    const loud = createRunHost({
      log: byteLog(),
      llm: fakeLlm(),
      tools: fakeTools(),
      session: session(),
      contextWindowBytes: 1000,
      onEvent: () => {
        throw new Error("the page is gone");
      },
    });
    const idle = await loud.drive();
    check(idle.did === "idle", "a throwing onEvent does not break a step");
  }

  // ------------------------------------------------------- 2. one whole turn
  {
    const llm = fakeLlm([
      {
        emit: ({ onEvent }) => {
          onEvent({ type: "reasoning", delta: "the user wants a listing" });
          onEvent({ type: "text", delta: "let me look" });
          onEvent({ type: "tool_call_start", index: 0, id: "c1", name: "run_command" });
          onEvent({ type: "tool_call_delta", index: 0, delta: '{"command":"ls"}' });
          onEvent({ type: "finish" });
        },
        content: "let me look",
        toolCalls: [{ id: "c1", name: "run_command", arguments: '{"command":"ls"}' }],
        finishReason: "tool_calls",
      },
      {
        emit: ({ onEvent }) => onEvent({ type: "text", delta: "all done" }),
        content: "all done",
        finishReason: "stop",
      },
    ]);
    const { host, log, tools, emitted } = hostWith({ llm });

    await host.start(TASK);
    const opened = await host.state();
    check(opened.phase === "open" && opened.task === TASK, "state() reads the turn back off the log, task and all");

    const out = await host.drive();
    check(out.did === "final" && out.status === "completed" && out.taken === 4, "a turn is model → tool → model → final");
    check(llm.asks.length === 2, "the model was asked exactly twice");
    check(tools.state.schemaCalls === 2, "the registry's schemas are asked once per model call");
    check(tools.state.ran.length === 1, "the call the model asked for is handed to the execution endpoint");
    const ran = tools.state.ran[0];
    check(
      ran && ran.call && ran.call.id === "c1" && ran.call.name === "run_command" && ran.call.arguments === '{"command":"ls"}',
      "runTool receives {call, signal} with the call the log recorded"
    );
    check(ran && ran.signal && typeof ran.signal.aborted === "boolean", "and a signal the stop intent can abort");

    // the log: six durable types, and the tool's own declaration stamped on
    // every call (the loop writes what the registry said, never a guess)
    const durable = log.events();
    check(durable.every((ev) => DURABLE_TYPES.has(ev.type)), "nothing but the six durable types reaches the log");
    check(
      JSON.stringify(typesOf(durable)) ===
        JSON.stringify([
          "user_message",
          "assistant_message",
          "tool_call",
          "tool_result",
          "assistant_message",
          "final",
        ]),
      "the log reads text → tools → results → answer → final"
    );
    const call = durable.find((ev) => ev.type === "tool_call");
    check(call && JSON.stringify(call.ui) === '{"kind":"command"}', "the call carries the registry's ui, because it renders it");
    check(call && call.path_arg === "", "and the registry's path_arg, empty for a call that names no file");
    check(
      tools.state.uiCalls.includes("run_command"),
      "the declaration is asked for by name, so a disabled component is honest between two steps"
    );

    // the page: display events only, in the vocabulary it already paints
    check(emitted.every((ev) => DISPLAY_TYPES.has(ev.type)), "the page is told display events only");
    check(emitted.some((ev) => ev.type === "step_start"), "each model call opens with step_start");
    check(emitted.filter((ev) => ev.type === "step_start").length === 2, "one step_start per model call, no more");
    check(emitted.some(delta), "the wire's `text` is the page's text_delta content");
    check(
      emitted.some((ev) => ev.type === "reasoning_delta" && ev.content === "the user wants a listing"),
      "the wire's `reasoning` is the page's reasoning_delta"
    );
    const opened_ = emitted.find((ev) => ev.type === "tool_call_delta" && ev.delta === "" && ev.tool_call_id === "c1");
    check(
      opened_ && opened_.name === "run_command" && opened_.ui && opened_.ui.kind === "command",
      "a call opens with its id, name and ui"
    );
    const chunk = emitted.find((ev) => ev.type === "tool_call_delta" && ev.delta !== "");
    check(
      chunk && chunk.tool_call_id === "c1" && chunk.delta === '{"command":"ls"}',
      "each argument chunk is labelled with the id of the call it belongs to"
    );
    const states = emitted.filter((ev) => ev.type === "state_update").map((ev) => ev.value);
    check(
      JSON.stringify(states) === JSON.stringify(["running", "running", "running", "finished"]),
      "the page sees running while the turn works and finished when it ends"
    );
    check(
      emitted.filter((ev) => ev.type === "state_update").every((ev) => ev.key === "execution_status"),
      "the status frame is the one key the page reads"
    );

    // what the model was asked
    const first = llm.asks[0].messages;
    check(first[0] && first[0].role === "system", "the model is asked with a system message, not a bare task");
    check(
      first[0].content.includes("Current mode: work (full access)."),
      "the session's mode reached the prompt through the real templates"
    );
    check(
      first.some((m) => m.role === "user" && m.content.includes(TASK)),
      "and the task is stated as the derived task line"
    );
    check(Array.isArray(llm.asks[0].tools) && llm.asks[0].tools.length === 1, "the model is offered the registry's schemas");
    const second = llm.asks[1].messages;
    check(
      second.some((m) => m.role === "tool" && m.content === "exit 0\n"),
      "the tool's result is in the context of the next call"
    );
    check(
      second.some((m) => m.role === "user" && m.content.includes(TASK)),
      "and the task still is: the log, not a variable, is what it is derived from"
    );
  }

  // ------------------------------------------------- 3. the window, compacted
  {
    // a finished turn before this one, big enough that the window overflows a
    // small model window; the summary is small enough to fit afterwards
    const before = [user("an earlier task"), said("x".repeat(400)), final("completed", "x".repeat(400))];
    const log = byteLog(before);
    const llm = fakeLlm([{ emit: ({ onEvent }) => onEvent({ type: "text", delta: "done" }), content: "done" }]);
    llm.summaryText = "the earlier task, summarized";
    const { host, emitted } = hostWith({ log, llm, contextWindowBytes: 300 });

    await host.start(TASK);
    const out = await host.drive();
    check(out.did === "final", "a turn over a full window still ends");
    check(log.types().includes("compaction"), "the window was rolled into a compaction line");
    const compaction = log.events().find((ev) => ev.type === "compaction");
    check(compaction && compaction.summary === "the earlier task, summarized", "the line holds the summary the model gave");
    const written = log.items.find((it) => it.event.type === "compaction");
    check(
      log.slides[0] === written.offset && log.windowStart() === written.offset,
      "the window slid to the compaction line's own offset"
    );
    check(
      log.items.find((it) => it.event.type === "user_message").offset < log.windowStart(),
      "history stays on the log, behind the window"
    );
    check(
      emitted.some((ev) => ev.type === "compaction_delta"),
      "the page watched the summary happen instead of a frozen spinner"
    );
    check(llm.asks.length === 1, "the model was asked once — after the window was shortened");
    const msgs = llm.asks[0].messages;
    check(
      msgs.some((m) => m.role === "user" && m.content.includes("the earlier task, summarized")),
      "the new context opens with the summary as its head"
    );
    check(
      msgs.some((m) => m.role === "user" && m.content.includes(TASK)),
      "the turn's task survived a compaction that pushed its line out of the window"
    );
    check(
      !msgs.some((m) => m.role === "assistant" && m.content === "x".repeat(400)),
      "summarized history never re-enters the context"
    );
  }

  // ------------------------------------------------------------ 4. the notice
  {
    const llm = fakeLlm([
      {
        emit: ({ onEvent, onRetry }) => {
          onRetry({ attempt: 2, max: 0, discard: true, message: "connection reset — retrying (2/…)" });
          onEvent({ type: "text", delta: "after the reset" });
        },
        content: "after the reset",
      },
    ]);
    const { host, log, emitted } = hostWith({ llm });
    await host.start(TASK);
    await host.drive();

    const retry = emitted.find((ev) => ev.type === "llm_retry");
    check(retry !== undefined, "a transport retry reaches the page");
    check(
      retry && retry.attempt === 2 && retry.max_retries === 0 && retry.discard === true && retry.message.includes("retrying"),
      "the client's `retry` is the page's llm_retry, field for field (max_retries, not max)"
    );
    check(!log.types().includes("llm_retry"), "a retry is a notice: it is not a durable line while P2 has no append for it");
  }

  // -------------------------------------------------------- 5. a failed step
  {
    const boom = new Error("the execution endpoint is unreachable");
    // the endpoint fails once, then answers: the captured port is called again
    // by the resumed step, so the failure has to be state of the fake, not a
    // swapped-out function (the host holds the port it was built with)
    let unreachable = true;
    const tools = fakeTools({
      run: async ({ call }) => {
        if (unreachable) throw boom;
        return { content: `ran ${call.id}`, isError: false, diff: "" };
      },
    });
    const llm = fakeLlm([
      { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: "{}" }], finishReason: "tool_calls" },
      { content: "recovered", finishReason: "stop" },
    ]);
    const { host, log, emitted } = hostWith({ tools, llm });
    await host.start(TASK);
    let caught = null;
    try {
      await host.drive();
    } catch (e) {
      caught = e;
    }
    check(caught === boom, "a failing tool rejects the drive with the failure itself, not a summary of it");
    const states = emitted.filter((ev) => ev.type === "state_update").map((ev) => ev.value);
    check(states[states.length - 1] === "error", "the page is told error before the failure is handed upwards");
    check(states.includes("running"), "and it had been told running while the step was in flight");
    check(log.types().includes("tool_call"), "the call the model asked for is on the log");
    check(!log.types().includes("tool_result"), "the call that never ran recorded no result");
    check(!log.types().includes("final"), "and no final was invented: the turn stays open for the next process");
    // and the next step picks the same call up again
    unreachable = false;
    const resumed = await host.drive();
    check(resumed.did === "final", "the turn is still drivable after the failure");
    check(log.types().filter((t) => t === "tool_result").length === 1, "the retried call landed exactly one result");
  }

  // --------------------------------------------------------------- 6. stop
  {
    const { host, log, emitted } = hostWith();
    await host.start(TASK);
    host.stop();
    const out = await host.drive();
    check(out.did === "final" && out.status === "aborted", "a stop on an open turn ends it as aborted");
    const last = log.events()[log.events().length - 1];
    check(
      last.type === "final" && last.status === "aborted" && last.summary === say("cancelled"),
      "the words are the loop's own, from the shipped prompt — not a string of this module's"
    );
    const states = emitted.filter((ev) => ev.type === "state_update").map((ev) => ev.value);
    check(states[states.length - 1] === "finished", "an aborted turn is a finished turn to the page, not an error");
  }

  // --------------------------------------------------------------- 7. idle
  {
    const { host, log, emitted } = hostWith();
    const out = await host.drive();
    check(out.did === "idle" && out.taken === 1, "an empty log has nothing to drive");
    check(log.events().length === 0, "and driving it wrote nothing");
    const states = emitted.filter((ev) => ev.type === "state_update").map((ev) => ev.value);
    check(JSON.stringify(states) === JSON.stringify(["idle"]), "the page is told idle, which is not the same as running");
  }

  summary("run-host: one loop, one log, one page feed (ports / turn / window / failure)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
