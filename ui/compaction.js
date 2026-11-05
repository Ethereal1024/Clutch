// Context-window compaction: roll the older conversation into a summary.
//
// Compaction is pure context management — window sizing, serialization, the
// summary call — so it belongs beside the context it shortens (ui/context.js),
// not inside the run loop. The loop asks `shouldCompact()` / `compact()`;
// everything about when to fire and what to summarize is this module's business.
//
// Byte arithmetic throughout: the window and the window-usage comparison are
// exact BYTES, never a token estimate. The window is [cprStart, file_end):
// everything since the newest compaction line. `compact()` summarizes the WHOLE
// current window (already resident — zero disk reads), appends the new
// `compaction` event, and slides the window start to that line's offset. The
// window collapses to just the new summary, so summarized history can never
// re-enter the context (ui/context.js reads the head from it).
//
// The .clc side is a PORT, not this module's knowledge:
//
//   read()                    -> {items, windowBytes, cprStart, lastCompaction}
//                                items: [{offset, event}] resident, file order;
//                                windowBytes: [cprStart, end) in bytes;
//                                lastCompaction: the newest compaction event,
//                                the head the summary already carries
//   append(event)             -> the event AS PERSISTED (it carries log_offset,
//                                the offset the window slides to)
//   slideWindow(offset)       -> persist the new window start (header write)
//   stream({messages, tools, signal})
//                             -> async iterable of the model's events, exactly
//                                what ui/llm-client.js's stream() yields
//   contextWindowBytes        -> the model window, in bytes
//
// The first three answer promises: the log is not in this process (desktop: the
// supervisor's HTTP; phone: the loopback bridge), so neither the size question
// nor the write can be synchronous (TODO.md P1-4).
//
// P2 owns the first three (the byte-addressed log); P1-2 owns the fourth. This
// module owns the decision and the transcript.
//
// A compaction that cannot happen is NOT fatal: `compact()` answers false and
// the turn continues with the context it has (the loop never spins on a no-op).
// That is the Python half's behaviour and it is a deliberate one — the failure
// is surfaced (warn + a done delta so the display never hangs), not swallowed
// into a silent second strategy.

const { render } = require("./prompt");
const { eventText } = require("./event-text");

// The events a summarizer reads: the conversation itself. A compaction line is
// the head it already carries and a final is a run's verdict, not something
// said.
const TRANSCRIPT = new Set(["user_message", "assistant_message", "tool_call", "tool_result"]);

// One tool result is trimmed so a single huge read cannot drown the rest of the
// window. Nothing else is capped and nothing else is elided.
const TOOL_RESULT_LIMIT = 500;

// Throttle the live counter: ~every 200 characters is plenty.
const PROGRESS_EVERY = 200;

function requiredPort(ports, name) {
  const fn = ports && ports[name];
  if (typeof fn !== "function") {
    throw new TypeError(`compaction: the "${name}" port is required`);
  }
  return fn;
}

function requiredBytes(ports) {
  const n = ports && ports.contextWindowBytes;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new TypeError('compaction: "contextWindowBytes" must be a positive number of bytes');
  }
  return n;
}

function cancelled(signal) {
  return Boolean(signal && signal.aborted);
}

function createCompactor(ports) {
  const read = requiredPort(ports, "read");
  const append = requiredPort(ports, "append");
  const slideWindow = requiredPort(ports, "slideWindow");
  const stream = requiredPort(ports, "stream");
  const contextWindowBytes = requiredBytes(ports);
  // progress sink: the page gets compaction_delta events instead of looking
  // frozen. A subscriber failure is non-fatal, like Python's.
  const sink = typeof ports.onProgress === "function" ? ports.onProgress : null;
  // where a failed compaction is reported: never silent, never fatal
  const warn =
    typeof ports.warn === "function"
      ? ports.warn
      : (msg) => console.error(`[clutch] ${msg}`);

  function reporter(fn) {
    if (typeof fn !== "function") return () => {};
    return (chars, { done = false, note = "" } = {}) => {
      try {
        // display-only: never appended (a delta is not a durable event)
        fn({ type: "compaction_delta", chars, done, note });
      } catch (e) {
        // a broken subscriber must not break the turn
      }
    };
  }

  const report = reporter(sink);

  // The log as it is now, validated once here so the rest can read it plainly.
  // `read()` is a round trip (the .clc lives on the session machine), so this is
  // the one asynchronous hop every question about the window starts with.
  async function snapshot() {
    const log = await read();
    if (!log || typeof log !== "object" || !Array.isArray(log.items)) {
      throw new TypeError("compaction: read() must answer {items, windowBytes, cprStart, lastCompaction}");
    }
    if (typeof log.windowBytes !== "number" || typeof log.cprStart !== "number") {
      throw new TypeError("compaction: read() must answer windowBytes and cprStart as numbers");
    }
    return log;
  }

  // True when the current window fills the model window: one byte comparison,
  // no token estimation, no per-event walk.
  async function shouldCompact() {
    return (await snapshot()).windowBytes >= contextWindowBytes;
  }

  // The summarizer's whole input: a compact transcript of the window. What tells
  // the summarizer this is someone else's session is the prompt's framing
  // (ui/prompts/compaction.md), not a rewrite of the events.
  function serialize(window) {
    const lines = [];
    for (const ev of window) {
      if (!ev || !TRANSCRIPT.has(ev.type)) continue; // a final/compaction line is not the conversation
      const text = eventText(ev, ev.type === "tool_result" ? TOOL_RESULT_LIMIT : null);
      if (text) lines.push(text);
    }
    return lines.join("\n");
  }

  async function summarize(history, previous, signal, progress) {
    const prompt = render("compaction.md", {
      history,
      previous_summary: previous || "(none)",
    });
    const parts = [];
    let chars = 0;
    let reported = 0;
    for await (const ev of stream({
      messages: [{ role: "user", content: prompt }],
      tools: null, // a summary asks for no tools
      signal,
    })) {
      // stop must interrupt the summary call, not just the main turn
      if (cancelled(signal)) return { summary: "", chars };
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "retry") {
        // transport hiccup: the client is reconnecting with backoff — mirror the
        // notice into the live block instead of letting it sit silently.
        // discard=true means the dead attempt had already streamed part of the
        // summary: no byte of that belongs to it, so it goes and the counter
        // restarts at 0.
        if (ev.discard) {
          parts.length = 0;
          chars = 0;
          reported = 0;
        }
        progress(chars, { note: typeof ev.message === "string" ? ev.message : "" });
        continue;
      }
      if (ev.type === "text") {
        const delta = typeof ev.delta === "string" ? ev.delta : "";
        parts.push(delta);
        chars += delta.length;
        if (chars - reported >= PROGRESS_EVERY) {
          reported = chars;
          progress(chars);
        }
        continue;
      }
      if (ev.type === "finish") break;
    }
    return { summary: parts.join("").trim(), chars };
  }

  // Roll the whole current window into one `compaction` event. Answers false when
  // nothing was compacted: nothing new since the last compaction, the summary
  // came back empty, Stop landed mid-summary, or the call failed (reported, not
  // raised). Never leaves the log half-written: the event lands only after a
  // summary exists.
  async function compact({ signal, onProgress } = {}) {
    const progress = onProgress ? reporter(onProgress) : report;
    try {
      if (cancelled(signal)) return false; // stop requested: no long summary
      const log = await snapshot();
      // the window: resident events at/after cprStart (before it is already summarized)
      const window = log.items
        .filter((item) => item && typeof item.offset === "number" && item.offset >= log.cprStart)
        .map((item) => item.event);
      // nothing new since the last compaction: never re-summarize the same head
      if (window.length <= 1) return false;
      progress(0); // announce the start before the first token lands
      const head = log.lastCompaction && typeof log.lastCompaction === "object" ? log.lastCompaction : null;
      const { summary, chars } = await summarize(
        serialize(window),
        head ? String(head.summary || "") : "",
        signal,
        progress
      );
      if (!summary) {
        progress(chars, { done: true });
        return false;
      }
      const written = await append({ type: "compaction", summary });
      if (!written || typeof written !== "object" || typeof written.log_offset !== "number") {
        throw new TypeError("compaction: append must answer the event as persisted, with log_offset");
      }
      // slide the window to the new summary line's start: history never re-enters
      await slideWindow(written.log_offset);
      return true;
    } catch (e) {
      // a Stop that landed mid-summary reads as a quiet bail, not a failure
      if (cancelled(signal)) {
        report(0, { done: true });
        return false;
      }
      warn(`compaction failed: ${(e && e.message) || e}`);
      report(0, { done: true });
      return false;
    }
  }

  return { shouldCompact, compact };
}

module.exports = { createCompactor, TRANSCRIPT, TOOL_RESULT_LIMIT, PROGRESS_EVERY };
