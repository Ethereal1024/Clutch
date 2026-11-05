// The run: the doing that the fold only describes.
//
// ui/run-state.js answers one question from the .clc lines — is a turn open, and
// what is its next step. This module takes that answer and does it: calls the
// model, records its turn, runs the calls it asked for, closes the turn with a
// final. It holds NOTHING between steps. Every step re-reads the log and asks
// the fold again, which is what makes a turn survive the death of the process
// running it: a phone frozen under a lock screen, a laptop suspended, a session
// killed mid-tool all cost at most the one call that was in flight, and the next
// `drive()` reads the tail and carries on (TODO.md I6, P2-3). There is no resume
// path because there is no state to resume from.
//
// The only thing this module remembers is the STOP INTENT — not part of the
// turn, not written to the log: a user can ask a turn to stop, and the loop is
// the next thing that notices. `stop()` sets the flag and aborts whatever call
// is in flight; the next `step()` closes the open turn with an `aborted` final.
// A turn that never gets another step stays open on disk, which is the honest
// picture: nothing happened after that line.
//
// Everything else is a PORT, and every port is required:
//
//   read()                        the log as it is now — parsed events, file order
//   append(event)                 append one line; answers it AS PERSISTED (the
//                                 log stamps a durable event with its offset)
//   derive({events, task})        the messages the model is asked with (P1-3)
//   model({messages, signal})     -> {content, toolCalls, finishReason} (P1-2)
//   runTool({call, signal})       -> {content, isError, diff} (P3)
//   text(key, vars)               the loop's own prose (P1-3): "cancelled",
//                                 "empty_response", "max_tokens"
//   shouldCompact()               -> does the resident window fill the model's?
//   compact({signal})             -> did the log change (ui/compaction.js)?
//
// `read` and `append` answer promises, and so do `state()` and `start()`. The
// log does not live in this process: it is the session machine's `.clc`, a
// round trip away over the supervisor's HTTP on a desktop and the loopback
// bridge on a phone (TODO.md P1-4). A synchronous port would force this module
// to keep a copy of the log to read from — a second source of truth whose tail
// a `kill -9` would lose, which is exactly what I6 forbids. So every step
// re-reads, even though the read is now awaited; nothing is cached between
// steps. `derive` and `text` stay synchronous: they are pure functions of
// events already read and templates on disk.
//
// The compaction pair is a port and not this module's business: WHEN the window
// is full and WHAT it says are ui/compaction.js's questions. The loop owns only
// the ordering — the window is checked before the model is asked, never after
// the call was already made over budget, and a compaction that changed the log
// re-derives instead of asking with the messages it had (agent/loop.py).
//
// Missing one throws at construction. There is no default, no in-memory log, no
// simpler loop to fall back to: a half-wired run would be a second way to run a
// turn, and the whole point of this phase is that there is only one.
//
// The single exception is `observe(result)`: the host broadcasts what a step did
// over /events so the page can paint "running". It is called after each step,
// with the step's own answer, and a failure inside it is swallowed — a page that
// cannot be painted has not changed the work. It never decides anything.

const { foldRun } = require("./run-state");

// The one error a caller may see whose cause is not a failure: `stop()` closed
// the call that was in flight. It never escapes a step (the stop path turns it
// into the aborted final); it exists so a model/tool port can say "I was
// cancelled" instead of inventing a message.
class Stopped extends Error {
  constructor() {
    super("stopped");
    this.name = "Stopped";
    this.code = "cancelled";
  }
}

function requiredPort(ports, name) {
  const fn = ports && ports[name];
  if (typeof fn !== "function") {
    throw new TypeError(`run: the "${name}" port is required`);
  }
  return fn;
}

function createRun(ports) {
  const read = requiredPort(ports, "read");
  const append = requiredPort(ports, "append");
  const derive = requiredPort(ports, "derive");
  const model = requiredPort(ports, "model");
  const runTool = requiredPort(ports, "runTool");
  const text = requiredPort(ports, "text");
  const shouldCompact = requiredPort(ports, "shouldCompact");
  const compact = requiredPort(ports, "compact");
  // The one OPTIONAL port: what the page is told after each step. It observes;
  // it never owns. See announce().
  const observe = typeof ports.observe === "function" ? ports.observe : null;

  // The stop intent, and the call it is currently aimed at. Neither describes
  // the turn: the log does that.
  let stopped = false;
  let inflight = null;
  let busy = false;

  function prose(key) {
    const said = text(key);
    if (typeof said !== "string" || !said) {
      throw new TypeError(`run: text("${key}") must answer the words to write`);
    }
    return said;
  }

  // Append one line and hand back what the log now holds. The append owns the
  // stamp (offset), so what it answers is the truth about that line, not the
  // object this module passed in.
  async function put(event) {
    const written = await append(event);
    if (!written || typeof written !== "object") {
      throw new TypeError("run: append must answer the event as persisted");
    }
    return written;
  }

  // The fold's answer for the log as it is right now. This is also what the host
  // broadcasts as "running / waiting" (P1-4): the page is a view of this, never
  // its owner.
  async function state() {
    return foldRun(await read());
  }

  // Write the final that ends the open turn, and say so.
  async function finish(status, summaryKey) {
    const summary = prose(summaryKey);
    await put({ type: "final", status, summary });
    return { did: "final", status, summary };
  }

  // Roll the window into a summary, with the stop intent wired into it the same
  // way it is wired into every other call: Stop aborts the summary, not just the
  // next step. Answers true when the log changed and the messages must be
  // derived again.
  async function compactTurn() {
    if (stopped) return false;
    inflight = new AbortController();
    try {
      return Boolean(await compact({ signal: inflight.signal }));
    } finally {
      inflight = null;
    }
  }

  // ---- the doing ----

  // One model turn. Records what the model said BEFORE the calls it asked for,
  // so a stored session replays as text → tools → results (agent/loop.py). A
  // truncated turn (finishReason "length") is not recorded as an answer at all:
  // its calls are dropped and the model is asked to be concise.
  async function speak(answer, events) {
    const messages = derive({ events, task: answer.task });
    if (!Array.isArray(messages) || !messages.length) {
      throw new TypeError("run: derive must answer the messages the model is asked with");
    }
    let out;
    inflight = new AbortController();
    try {
      out = await model({ messages, signal: inflight.signal });
    } catch (e) {
      // A dead call while stopping is the stop's doing, not a failure: the turn
      // closes as aborted. Anything else is the caller's to see — a transport
      // failure is not retried here (the client owns retries, D12) and is never
      // turned into a final the log would have to believe.
      if (stopped) return await finish("aborted", "cancelled");
      throw e;
    } finally {
      inflight = null;
    }
    if (stopped) return await finish("aborted", "cancelled");
    if (!out || typeof out !== "object" || typeof out.content !== "string") {
      throw new TypeError("run: the model must answer {content, toolCalls, finishReason}");
    }
    const content = out.content;
    const reasoning = typeof out.reasoning === "string" ? out.reasoning : "";
    const calls = Array.isArray(out.toolCalls) ? out.toolCalls : [];

    if (out.finishReason === "length") {
      // max-tokens truncation: no call from a cut-off turn is executed, and no
      // assistant turn is recorded — the model is told to be concise and speaks
      // again (loop.py's `finish_reason == "length"` branch)
      await put({ type: "user_message", content: prose("max_tokens") });
      return { did: "model", truncated: true };
    }

    if (calls.length) {
      const recorded = calls.map((tc) => {
        const id = String((tc && tc.id) || "");
        const name = String((tc && tc.name) || "");
        const args = String((tc && tc.arguments) || "");
        if (!id || !name) throw new TypeError("run: every tool call needs an id and a name");
        return { id, name, arguments: args, ui: tc.ui, pathArg: tc.pathArg };
      });
      await put({
        type: "assistant_message",
        content,
        tool_calls: recorded.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        reasoning,
      });
      for (const c of recorded) {
        // `ui` and `path_arg` are durable because a replayed session has to
        // render the call the same way and the context reader has to know which
        // argument held a path; both are the tool's own declaration, so the
        // model port (the registry's voice) supplies them. Absent, they take the
        // event's own default (agent/events.py), never a guess of this loop's.
        await put({
          type: "tool_call",
          name: c.name,
          arguments: c.arguments,
          tool_call_id: c.id,
          ui: c.ui && typeof c.ui === "object" ? c.ui : {},
          path_arg: typeof c.pathArg === "string" ? c.pathArg : "",
        });
      }
      return { did: "model", calls: recorded.length };
    }

    await put({ type: "assistant_message", content, tool_calls: [], reasoning });
    if (!content.trim()) {
      // An empty reply is NOT a completion: it is fed back as a note and the
      // model is asked again (agent/loop.py). The assistant line stays durable —
      // the log says it said nothing, which is a fact about the turn.
      await put({ type: "user_message", content: prose("empty_response") });
      return { did: "model", emptyReply: true };
    }
    // The sentence is now on the log. The next step reads a tail that already
    // answers the turn and closes it with that same sentence, rather than asking
    // the model the same question a second time.
    return { did: "model", answer: content };
  }

  // Every call the fold says is still unanswered, in the order the turn issued
  // them. A tool that cannot run records nothing: the call stays pending and the
  // next step asks again — a refusal is an envelope (a result), not a throw, and
  // an effect that must not be repeated is the tool's own idempotency problem
  // (ui/run-state.js).
  async function runCalls(answer) {
    const ran = [];
    for (const call of answer.calls) {
      inflight = new AbortController();
      let res;
      try {
        res = await runTool({ call, signal: inflight.signal });
      } finally {
        inflight = null;
      }
      if (!res || typeof res !== "object" || typeof res.content !== "string") {
        throw new TypeError("run: runTool must answer {content, isError, diff}");
      }
      await put({
        type: "tool_result",
        tool_call_id: call.id,
        content: res.content,
        is_error: Boolean(res.isError),
        diff: typeof res.diff === "string" ? res.diff : "",
      });
      ran.push({ id: call.id, isError: Boolean(res.isError) });
    }
    return { did: "tool", calls: ran };
  }

  // ---- the entry points ----

  // Open a turn. Only from idle: a second task would join a turn that is still
  // open, which is two runs in one turn. A process that crashed mid-turn resumes
  // by driving, never by starting something new (P2-3).
  async function start(task) {
    if (typeof task !== "string" || !task.trim()) {
      throw new TypeError("run.start: a task is required");
    }
    if ((await state()).phase !== "idle") {
      throw new Error("run.start: a turn is already open — drive() continues it");
    }
    stopped = false; // a new turn is a new intent; the old stop does not apply
    await put({ type: "user_message", content: task.trim() });
    return await state();
  }

  // Ask the open turn to stop. Only the intent is recorded here; the turn closes
  // at the next step, which is also the only place a final is written.
  function stop() {
    stopped = true;
    if (inflight) inflight.abort();
  }

  // One fold answer's worth of work: model turn, unanswered tools, or the final
  // the tail already implies.
  async function work() {
    const events = await read();
    const answer = foldRun(events);
    if (answer.phase === "idle") return { did: "idle", next: "start" };
    if (stopped) return await finish("aborted", "cancelled");
    if (answer.next === "tool") return await runCalls(answer);
    if (answer.next === "final") {
      await put({ type: "final", status: answer.final.status, summary: answer.final.summary });
      return { did: "final", status: answer.final.status, summary: answer.final.summary };
    }
    // About to ask the model: check the window first, never after. A
    // compaction that changed the log means these messages are stale — the
    // next step re-reads and derives them again from the shortened log.
    if (await shouldCompact()) {
      if (await compactTurn()) return { did: "compact" };
      // a compaction that could not happen is reported by the compactor and
      // is not fatal: the messages derived from what is on disk are still the
      // best this turn has (agent/loop.py)
      if (stopped) return await finish("aborted", "cancelled");
    }
    try {
      return await speak(answer, events);
    } catch (e) {
      // The provider says the window overflowed even though this side thought
      // it fit (its counting, not ours). Force one compaction and ask again;
      // if that changes nothing, the failure is real and the caller sees it.
      if (e && e.code === "context_window_exceeded" && !stopped) {
        if (await compactTurn()) return { did: "compact", forced: true };
      }
      throw e;
    }
  }

  // Tell the observer what just happened, in the words the page already paints.
  // This is the ONE port whose failure is not the turn's: a page that cannot be
  // painted has not changed the work, and an exception here would turn a display
  // bug into a failed run.
  function announce(result) {
    if (!observe) return;
    try {
      observe(result);
    } catch (e) {
      /* display only */
    }
  }

  async function step() {
    if (busy) throw new Error("run.step: a step is already running");
    busy = true;
    let result;
    try {
      result = await work();
    } finally {
      busy = false;
    }
    announce(result);
    return result;
  }

  // Steps until there is nothing left to do. Never gives up on its own: the loop
  // ends at a final, at an empty log, or at Stop — a failure inside a step is
  // raised to the caller (the bridge surfaces it, the turn stays open on disk).
  async function drive() {
    let last = null;
    let taken = 0;
    for (;;) {
      last = await step();
      taken += 1;
      if (last.did === "idle" || last.did === "final") return { ...last, taken };
    }
  }

  return { start, stop, step, drive, state };
}

module.exports = { createRun, Stopped };
