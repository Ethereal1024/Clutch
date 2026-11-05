// ui/compaction.js rolls the current window into one summary line, and is the
// loop's only way to shorten a context. These checks drive it against a fake
// log and a scripted stream: the byte threshold, what the summarizer is shown,
// the live counter, and the promise that a compaction which cannot happen
// answers false instead of killing the turn.
// Run: node tests/compaction.test.js
const { check, summary } = require("./harness.js");
const { render } = require("../ui/prompt.js");
const {
  createCompactor,
  TRANSCRIPT,
  TOOL_RESULT_LIMIT,
  PROGRESS_EVERY,
} = require("../ui/compaction.js");

const user = (content) => ({ type: "user_message", content });
const said = (content, tool_calls = [], reasoning = "") => ({
  type: "assistant_message",
  content,
  tool_calls,
  reasoning,
});
const call = (id, args = "{}") => ({
  type: "tool_call",
  name: "run_command",
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

// A log as read() hands it over: offsets 100 apart, a byte count the caller
// owns, and the newest compaction (the head a summary already carries).
function makeLog(events, { cprStart = 0, previous = null, windowBytes = 0 } = {}) {
  let offset = 0;
  const items = events.map((event) => {
    const item = { offset, event };
    offset += 100;
    return item;
  });
  return {
    items,
    windowBytes,
    cprStart,
    lastCompaction: previous === null ? null : { type: "compaction", summary: previous },
  };
}

// A stream that yields a script; `{ throw }` throws at that point instead.
function scripted(chunks) {
  const stream = async function* (args) {
    stream.calls.push(args);
    for (const c of chunks) {
      if (c && c.throw) throw c.throw;
      yield c;
    }
  };
  stream.calls = [];
  return stream;
}

function build({ log, stream, bytes = 1000, extra = {} }) {
  const appended = [];
  const slid = [];
  const deltas = [];
  const warned = [];
  const ports = {
    read: () => log,
    append: (ev) => {
      appended.push(ev);
      return { ...ev, log_offset: 900 };
    },
    slideWindow: (o) => slid.push(o),
    stream,
    contextWindowBytes: bytes,
    onProgress: (d) => deltas.push(d),
    warn: (m) => warned.push(m),
    ...extra,
  };
  return { compactor: createCompactor(ports), ports, appended, slid, deltas, warned };
}

const text = (delta) => ({ type: "text", delta });
const finish = { type: "finish" };
const shape = (d) => JSON.stringify(d);

function main() {
  // ---- 1. the ports are required, and they are checked at construction ----
  {
    const base = {
      read: () => makeLog([]),
      append: () => ({}),
      slideWindow: () => {},
      stream: async function* () {},
      contextWindowBytes: 1000,
    };
    for (const name of ["read", "append", "slideWindow", "stream"]) {
      let err = null;
      try {
        createCompactor({ ...base, [name]: undefined });
      } catch (e) {
        err = e;
      }
      check(err instanceof TypeError && err.message.includes(`"${name}"`), `a compactor without a ${name} port is refused`);
    }
    for (const bad of [undefined, 0, -1, NaN, Infinity, "1000", null]) {
      let err = null;
      try {
        createCompactor({ ...base, contextWindowBytes: bad });
      } catch (e) {
        err = e;
      }
      check(err instanceof TypeError && err.message.includes("contextWindowBytes"), `contextWindowBytes ${String(bad)} is refused`);
    }
    let err = null;
    try {
      createCompactor();
    } catch (e) {
      err = e;
    }
    check(err instanceof TypeError, "no ports at all is refused, not a crash later");
    check(TRANSCRIPT.has("user_message") && TRANSCRIPT.has("assistant_message") && TRANSCRIPT.has("tool_call") && TRANSCRIPT.has("tool_result"), "the transcript is the conversation");
    check(!TRANSCRIPT.has("final") && !TRANSCRIPT.has("compaction"), "a verdict and a summary are not things said");
    check(TOOL_RESULT_LIMIT === 500, "one tool result is trimmed at 500 characters");
    check(PROGRESS_EVERY === 200, "the live counter reports about every 200 characters");
  }

  // ---- 2. when to compact: one byte comparison, no token estimate ----
  {
    (async () => {
      let reads = 0;
      const log = makeLog([user("hi")], { windowBytes: 999 });
      const { compactor } = build({ log, stream: scripted([]), extra: { read: async () => (reads++, log) } });
      check((await compactor.shouldCompact()) === false, "a window under the model's is not compacted");
      check((await compactor.shouldCompact()) === false && reads === 2, "the question is asked of the log every time, never cached");
      log.windowBytes = 1000;
      check((await compactor.shouldCompact()) === true, "a window exactly the model's size compacts");
      log.windowBytes = 5000;
      check((await compactor.shouldCompact()) === true, "and one past it certainly does");
    })();
  }

  // ---- 3. a read() that does not answer the contract is a loud bug ----
  {
    (async () => {
      for (const [bad, label] of [
        [null, "null"],
        [{}, "an object with no items"],
        [{ items: "nope", windowBytes: 1, cprStart: 0 }, "a non-array items"],
        [{ items: [], windowBytes: "1", cprStart: 0 }, "a string windowBytes"],
        [{ items: [], windowBytes: 1, cprStart: null }, "a missing cprStart"],
      ]) {
        const { compactor } = build({ log: makeLog([]), stream: scripted([]), extra: { read: async () => bad } });
        let err = null;
        try {
          await compactor.shouldCompact();
        } catch (e) {
          err = e;
        }
        check(err instanceof TypeError, `read() answering ${label} fails the size question loudly`);
      }
    })();
  }

  // ---- 4. nothing new since the last compaction: no second summary ----
  {
    const log = makeLog([user("old"), user("new")], { cprStart: 100 });
    const stream = scripted([text("never asked")]);
    const { compactor, appended } = build({ log, stream });
    return (async () => {
      check((await compactor.compact({})) === false, "a window holding one event compacts nothing");
      check(stream.calls.length === 0, "and the summarizer is never called");
      check(appended.length === 0, "and nothing is written");
      check((await build({ log: makeLog([]), stream: scripted([]) }).compactor.compact({})) === false, "an empty window compacts nothing");
      check((await build({ log: makeLog([user("a"), user("b")]), stream: scripted([text("s"), finish]) }).compactor.compact({})) === true, "two events are enough to summarize");

      // ---- 5. what the summarizer is shown ----
      {
        const events = [
          user("first"),
          said("thinking", [call("c1")], "why"),
          call("c1", '{"cmd":"ls"}'),
          result("c1", "out"),
          { type: "final", status: "completed", summary: "done" },
          { type: "compaction", summary: "older" },
        ];
        const stream = scripted([text("summary"), finish]);
        const { compactor } = build({ log: makeLog(events), stream });
        check((await compactor.compact({})) === true, "the window is summarized");
        const history = [
          "[User]: first",
          "[Assistant]: thinking",
          "[Assistant reasoning]: why",
          '[Assistant tool call]: run_command({"cmd":"ls"})',
          "[Tool result]: out",
        ].join("\n");
        check(
          stream.calls[0].messages[0].content === render("compaction.md", { history, previous_summary: "(none)" }),
          "the prompt is the compaction template, filled with the window as text and no prior summary"
        );
        check(stream.calls[0].tools === null, "a summary asks for no tools");
        check(!stream.calls[0].messages[0].content.includes("[Final]"), "a run's verdict is not something said");
        check(!stream.calls[0].messages[0].content.includes("[Compaction summary]"), "nor is the head it already carries");
      }

      // ---- 6. a huge tool result is trimmed, visibly ----
      {
        const huge = "x".repeat(600) + "TAIL";
        const stream = scripted([text("s"), finish]);
        const { compactor } = build({ log: makeLog([user("go"), result("c1", huge)]), stream });
        await compactor.compact({});
        const prompt = stream.calls[0].messages[0].content;
        check(prompt.includes(`[Tool result]: ${"x".repeat(500)}\n[truncated]`), "one tool result is cut at 500 characters with the marker");
        check(!prompt.includes("TAIL"), "and the rest of it is not shown");
        check(prompt.includes("[User]: go"), "while the user's own words are not capped");
      }

      // ---- 7. the prior summary is the head, or says there is none ----
      {
        const history = "[User]: a\n[User]: b";
        const withHead = scripted([text("s"), finish]);
        const a = build({ log: makeLog([user("a"), user("b")], { previous: "the old story" }), stream: withHead });
        await a.compactor.compact({});
        check(
          withHead.calls[0].messages[0].content === render("compaction.md", { history, previous_summary: "the old story" }),
          "the newest compaction is handed to the summarizer, in the prior-summary slot"
        );
        const noHead = scripted([text("s"), finish]);
        const b = build({ log: makeLog([user("a"), user("b")]), stream: noHead });
        await b.compactor.compact({});
        check(
          noHead.calls[0].messages[0].content === render("compaction.md", { history, previous_summary: "(none)" }),
          "a session with no compaction says \"(none)\" rather than nothing"
        );
      }

      // ---- 8. a summary that lands becomes the new window start ----
      {
        const log = makeLog([user("a"), said("b")]);
        const stream = scripted([text("  the summary  "), finish]);
        const { compactor, appended, slid, deltas } = build({ log, stream });
        check((await compactor.compact({})) === true, "a summary comes back");
        check(appended.length === 1 && appended[0].type === "compaction" && appended[0].summary === "the summary", "one compaction event is appended, trimmed");
        check(slid.length === 1 && slid[0] === 900, "the window slides to the appended line's offset");
        check(deltas.length > 0 && shape(deltas[0]) === shape({ type: "compaction_delta", chars: 0, done: false, note: "" }), "the live block is announced before the first token");
        check(deltas.every((d) => d.done === false), "a compaction that succeeded never sends a done delta of its own");
      }

      // ---- 9. the live counter is throttled ----
      {
        const stream = scripted([text("a".repeat(100)), text("b".repeat(100)), text("c".repeat(300)), finish]);
        const { compactor, deltas } = build({ log: makeLog([user("x"), user("y")]), stream });
        await compactor.compact({});
        check(JSON.stringify(deltas.map((d) => d.chars)) === "[0,200,500]", "progress is reported at the start and about every 200 characters");
        check(deltas.every((d) => d.type === "compaction_delta"), "every progress report is a compaction_delta, never a durable event");
      }

      // ---- 10. a retry in the summary call is shown, and a discard resets ----
      {
        const stream = scripted([
          text("keep"),
          { type: "retry", message: "reconnecting", discard: false },
          text(" more"),
          finish,
        ]);
        const { compactor, deltas } = build({ log: makeLog([user("x"), user("y")]), stream });
        await compactor.compact({});
        const noted = deltas.find((d) => d.note);
        check(noted && noted.note === "reconnecting", "a transport hiccup reaches the live block as a note");
        check(noted && noted.chars === 4, "and it does not throw the partial summary away");
      }
      {
        const stream = scripted([
          text("z".repeat(250)),
          { type: "retry", message: "reconnecting", discard: true },
          text("final words"),
          finish,
        ]);
        const { compactor, appended, deltas } = build({ log: makeLog([user("x"), user("y")]), stream });
        check((await compactor.compact({})) === true, "the retried summary still lands");
        check(appended[0].summary === "final words", "no byte of the discarded attempt is part of the summary");
        const after = deltas.slice(deltas.findIndex((d) => d.note));
        check(after[0].chars === 0 && after[0].done === false, "a discard restarts the counter at zero");
      }

      // ---- 11. finish ends the call ----
      {
        const stream = scripted([text("a"), finish, text("b")]);
        const { compactor, appended } = build({ log: makeLog([user("x"), user("y")]), stream });
        await compactor.compact({});
        check(appended[0].summary === "a", "anything after finish is not part of the summary");
      }

      // ---- 12. junk from the stream is skipped, not fatal ----
      {
        const stream = scripted([null, "nonsense", { type: "reasoning", delta: "hm" }, text("real"), finish]);
        const { compactor, appended, warned } = build({ log: makeLog([user("x"), user("y")]), stream });
        check((await compactor.compact({})) === true, "an event the summarizer does not know does not end the call");
        check(appended[0].summary === "real" && warned.length === 0, "and only real text is summarized");
      }

      // ---- 13. an empty summary is a no-op, announced as done ----
      {
        for (const chunks of [[], [text("   "), finish]]) {
          const { compactor, appended, deltas } = build({ log: makeLog([user("x"), user("y")]), stream: scripted(chunks) });
          check((await compactor.compact({})) === false, "a summary with no text does not land");
          check(appended.length === 0, "and no compaction line is written");
          const last = deltas[deltas.length - 1];
          check(last && last.done === true && last.chars === (chunks.length ? 3 : 0), "and the display is told the block is over");
        }
      }

      // ---- 14. a failure is reported, never fatal ----
      {
        const boom = [];
        const { compactor, appended, warned, deltas } = build({
          log: makeLog([user("x"), user("y")]),
          stream: scripted([text("partial"), { throw: new Error("socket reset") }]),
        });
        check((await compactor.compact({})) === false, "a failed summary answers false, it does not raise");
        check(warned.length === 1 && warned[0] === "compaction failed: socket reset", "and the failure is said out loud");
        check(appended.length === 0, "with nothing half-written");
        check(deltas[deltas.length - 1].done === true, "and the live block is closed");
        check(boom.length === 0, "no strategy is tried behind the failure");
      }
      {
        const { compactor, slid, warned } = build({
          log: makeLog([user("x"), user("y")]),
          stream: scripted([text("s"), finish]),
          extra: { append: () => ({ type: "compaction", summary: "s" }) },
        });
        check((await compactor.compact({})) === false, "an append that does not answer the persisted line is a failure");
        check(warned.some((m) => m.includes("append must answer")) && slid.length === 0, "reported, and the window does not move");
      }
      {
        const { compactor, warned } = build({ log: makeLog([]), stream: scripted([]), extra: { read: () => null } });
        check((await compactor.compact({})) === false, "a broken log is reported, not thrown at the turn");
        check(warned.length === 1 && warned[0].startsWith("compaction failed:"), "with the reason");
      }
      {
        const { compactor, appended } = build({
          log: makeLog([user("x"), user("y")]),
          stream: scripted([text("s"), finish]),
          extra: { append: () => { throw new Error("disk full"); } },
        });
        check((await compactor.compact({})) === false && appended.length === 0, "a log that cannot be written is a reported failure");
      }

      // ---- 15. stop is a quiet bail ----
      {
        const stream = scripted([text("never")]);
        const { compactor, warned, deltas } = build({ log: makeLog([user("x"), user("y")]), stream });
        check((await compactor.compact({ signal: { aborted: true } })) === false, "a stop already requested starts no summary");
        check(stream.calls.length === 0 && warned.length === 0, "no call, no warning");
        check(deltas.length === 0, "and nothing to close");
      }
      {
        const signal = { aborted: false };
        const stream = async function* (args) {
          stream.calls.push(args);
          yield text("abc");
          signal.aborted = true;
          yield text("def");
        };
        stream.calls = [];
        const { compactor, appended, warned, deltas } = build({ log: makeLog([user("x"), user("y")]), stream });
        check((await compactor.compact({ signal })) === false, "a stop mid-summary lands nothing");
        check(stream.calls[0].signal === signal, "the summary call is cancelled through the same signal");
        check(appended.length === 0 && warned.length === 0, "a bail is not a failure");
        const last = deltas[deltas.length - 1];
        check(last.done === true && last.chars === 3, "and the block closes on what it had");
      }

      // ---- 16. the progress sink is a subscriber, not a dependency ----
      {
        const mine = [];
        const { compactor, deltas } = build({ log: makeLog([user("x"), user("y")]), stream: scripted([text("s"), finish]) });
        await compactor.compact({ onProgress: (d) => mine.push(d) });
        check(mine.length > 0 && deltas.length === 0, "a per-call sink is used instead of the constructor's");
      }
      {
        const { compactor } = build({
          log: makeLog([user("x"), user("y")]),
          stream: scripted([text("s"), finish]),
          extra: { onProgress: () => { throw new Error("page gone"); } },
        });
        check((await compactor.compact({})) === true, "a broken subscriber does not break the turn");
      }

      summary("compaction: the window rolled into one summary line");
    })();
  }
}

main();
