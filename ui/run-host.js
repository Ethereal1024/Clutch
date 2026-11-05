// The host's run: every piece the loop talks to, wired once.
//
// ui/run.js is the loop and knows nothing but its ports. ui/context.js derives
// the messages, ui/compaction.js decides when the window is full, ui/llm-client.js
// speaks the wire, ui/prompt.js holds the loop's own prose. Something has to hand
// those to each other, and that something is this file — the only place the host
// half of the app decides WHICH log, WHICH model and WHICH tool executor a turn
// runs against. It has no I/O of its own: every one of those is injected, so the
// desktop (ui/main.js over the supervisor) and the phone (android/host over the
// loopback bridge) wire the same loop to different transports, and a test can
// wire it to none at all.
//
//   createRunHost({
//     log: {read, append, slideWindow},   the .clc as a byte-addressed log (P2)
//     llm: {ask, stream},                 ui/llm-client.js's client (P1-2)
//     tools: {schemas, ui, pathArg, run}, the registry + the execution endpoint (P3)
//     session: {mode, components, shell, memory},
//                                         the facts a turn is asked with (P1-3)
//     contextWindowBytes,                 the model window, in bytes
//     onEvent?(event),                    the page's live feed (/events)
//     warn?(message),
//   }) -> {start, stop, step, drive, state}
//
// `log.read()` answers the window snapshot `{items, windowBytes, cprStart,
// lastCompaction}` (ui/compaction.js's port, agent/core/lazy.py's shape): the
// resident `{offset, event}` pairs in file order, the window size in bytes, its
// start, and the newest compaction. The loop, though, is asked for events
// (ui/run.js's port), so this file is where the two shapes meet: `readEvents`
// below is the adapter, and the ONE requirement it puts on `log.read()` is that
// `items` reach back to at least `min(cprStart, the open turn's first line)`.
// The window alone is not enough, for two different reasons: the compactor
// filters `items` by `offset >= cprStart` itself, so extra head costs it
// nothing; and the fold answers the turn's `task` from the user_message that
// opened it (ui/run-state.js), which a mid-turn compaction pushes out of the
// window. A turn whose task line is behind `cprStart` would be driven on an
// empty task — so P2's read endpoint owns the turn head, not just the window.
//
// `onEvent` sees DISPLAY events only — deltas, compaction progress, retries and
// the `state_update` frames. The six durable types go to the log and nowhere
// else (D2): the page replays them from the log, so a page that is closed when a
// turn ends still sees the ending when it comes back.
//
// The returned object is the loop itself, not a facade over it: `start`/`stop`/
// `step`/`drive`/`state` are ui/run.js's own answers, so there is one state
// machine and no second vocabulary. The host's only addition is the two guards
// around a failing step — the page is told "error" before the failure is handed
// to the caller, because a frozen spinner is not an error message.

const { createRun } = require("./run");
const { createDerive } = require("./context");
const { createCompactor } = require("./compaction");
const { say } = require("./prompt");

function requiredFn(holder, owner, name) {
  const fn = holder && holder[name];
  if (typeof fn !== "function") {
    throw new TypeError(`run-host: ${owner}.${name} is required`);
  }
  return fn;
}

function createRunHost(ports) {
  const log = ports && ports.log;
  const llm = ports && ports.llm;
  const tools = ports && ports.tools;
  const session = ports && ports.session;
  if (!log || typeof log !== "object") throw new TypeError("run-host: log is required");
  if (!llm || typeof llm !== "object") throw new TypeError("run-host: llm is required");
  if (!tools || typeof tools !== "object") throw new TypeError("run-host: tools is required");
  if (!session || typeof session !== "object") throw new TypeError("run-host: session is required");
  const read = requiredFn(log, "log", "read");
  const append = requiredFn(log, "log", "append");
  const slideWindow = requiredFn(log, "log", "slideWindow");
  const ask = requiredFn(llm, "llm", "ask");
  const stream = requiredFn(llm, "llm", "stream");
  const schemas = requiredFn(tools, "tools", "schemas");
  const toolUi = requiredFn(tools, "tools", "ui");
  const toolPathArg = requiredFn(tools, "tools", "pathArg");
  const runTool = requiredFn(tools, "tools", "run");
  const contextWindowBytes = ports.contextWindowBytes;
  if (typeof contextWindowBytes !== "number" || !Number.isFinite(contextWindowBytes) || contextWindowBytes <= 0) {
    throw new TypeError("run-host: contextWindowBytes must be a positive number of bytes");
  }

  // The page is a subscriber, never an owner: a feed that throws has changed
  // nothing about the turn, so every emission is fire-and-forget.
  const sink = typeof ports.onEvent === "function" ? ports.onEvent : null;
  function emit(event) {
    if (!sink) return;
    try {
      sink(event);
    } catch (e) {
      /* display only: a page that cannot be painted has not changed the work */
    }
  }

  // The one shape the page already paints for liveness (agent/events.py's
  // StateUpdateEvent). "finished"/"error" close a turn, "running" means work is
  // in flight, "idle" means there is nothing open to drive.
  function status(value) {
    emit({ type: "state_update", key: "execution_status", value });
  }

  const compactor = createCompactor({
    read,
    append,
    slideWindow,
    stream,
    contextWindowBytes,
    // the summary's own progress: the page draws it, the log never sees it
    onProgress: emit,
    warn: typeof ports.warn === "function" ? ports.warn : undefined,
  });

  const derive = createDerive(session);

  // The byte-addressed log is one port with one shape; the loop wants the events
  // of it. Dropping the offsets here is what keeps ui/run.js free of the log's
  // addressing — it has no use for a byte offset, and a second place that
  // remembers them would be a second window boundary to keep in sync.
  async function readEvents() {
    const logNow = await read();
    if (!logNow || typeof logNow !== "object" || !Array.isArray(logNow.items)) {
      throw new TypeError("run-host: log.read() must answer {items, windowBytes, cprStart, lastCompaction}");
    }
    return logNow.items.map((item) => item && item.event).filter(Boolean);
  }

  const run = createRun({
    read: readEvents,
    append,
    derive,
    // The registry is the model's voice about its own calls: the schemas it may
    // choose from, and the declaration (`ui`, `path_arg`) each chosen call
    // carries into the log. Asking per call keeps an enabled/disabled component
    // honest between two steps of the same turn.
    model: async ({ messages, signal }) => {
      // Deltas are the client's wire vocabulary; the page paints the loop's
      // (agent/events.py's TextDelta/ReasoningDelta/ToolCallDelta), so this is
      // where the two are matched up. Nothing translated here is written down.
      const started = new Map(); // tool-call index -> {id, name}, to label arg chunks
      emit({ type: "step_start" });
      const out = await ask({
        messages,
        tools: schemas(),
        signal,
        onEvent: (ev) => {
          if (!ev || typeof ev !== "object") return;
          if (ev.type === "text") return emit({ type: "text_delta", content: ev.delta || "" });
          if (ev.type === "reasoning") return emit({ type: "reasoning_delta", content: ev.delta || "" });
          if (ev.type === "tool_call_start") {
            started.set(ev.index, { id: ev.id || "", name: ev.name || "" });
            return emit({
              type: "tool_call_delta",
              tool_call_id: ev.id || "",
              name: ev.name || "",
              delta: "",
              ui: toolUi(ev.name),
            });
          }
          if (ev.type === "tool_call_delta") {
            const at = started.get(ev.index) || { id: "", name: "" };
            return emit({ type: "tool_call_delta", tool_call_id: at.id, name: "", delta: ev.delta || "" });
          }
          // `finish` is the answer, not a delta: the durable line is the loop's
          // to write, and `retry` has its own notice below
        },
        // A transport retry is a notice, not a log line (D12's durable form
        // waits for P2's append path). The page's own name for it is llm_retry.
        onRetry: (ev) =>
          emit({
            type: "llm_retry",
            attempt: ev.attempt || 0,
            max_retries: ev.max || 0,
            discard: Boolean(ev.discard),
            message: ev.message || "",
          }),
      });
      const calls = Array.isArray(out.toolCalls) ? out.toolCalls : [];
      return {
        ...out,
        toolCalls: calls.map((tc) => ({
          ...tc,
          ui: toolUi(tc.name),
          pathArg: toolPathArg(tc.name),
        })),
      };
    },
    // The execution layer runs the call and enforces every permission (P3): the
    // host asks for the effect, it never performs it.
    runTool: ({ call, signal }) => runTool({ call, signal }),
    // the loop's own prose, from the same templates the Python half used
    text: (key) => say(key),
    shouldCompact: () => compactor.shouldCompact(),
    compact: ({ signal }) => compactor.compact({ signal }),
    // what the page is told after each step, in the words it already paints
    observe: (result) => {
      if (result.did === "idle") return status("idle");
      if (result.did === "final") return status(result.status === "error" ? "error" : "finished");
      return status("running");
    },
  });

  // A step that fails is not a step that ended: the turn stays open on disk and
  // the failure is the caller's (run.js). The page is told the truth first.
  async function step() {
    try {
      return await run.step();
    } catch (e) {
      status("error");
      throw e;
    }
  }

  async function drive() {
    try {
      return await run.drive();
    } catch (e) {
      status("error");
      throw e;
    }
  }

  return {
    start: (task) => run.start(task),
    stop: () => run.stop(),
    step,
    drive,
    state: () => run.state(),
  };
}

module.exports = { createRunHost };
