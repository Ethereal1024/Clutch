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
// ...and one exception, which is a guard rather than a fact about the turn: the
// doom-loop window (a few last calls, below). It is the ONE thing the guard
// cannot re-derive cheaply — the warning it feeds the model is prose appended to
// a tool result, so "was this exact call already warned about" would have to be
// read back out of `tool_result.content`. It lives for one `createRun`, is
// cleared when a turn opens, and decides nothing the log would have to believe:
// every answer it produces is written as an ordinary result or final.
//
// Everything else is a PORT, and every port is required but two:
//
//   read()                        the log as it is now — parsed events, file order
//   append(event)                 append one line; answers it AS PERSISTED (the
//                                 log stamps a durable event with its offset)
//   derive({events, task})        the messages the model is asked with (P1-3)
//   model({messages, signal})     -> {content, toolCalls, finishReason} (P1-2)
//   runTool({call, signal})       -> {content, isError, diff} (P3)
//   text(key, vars)               the loop's own prose (P1-3): "cancelled",
//                                 "empty_response", "max_tokens", "budget_exceeded",
//                                 "doom_loop"
//   shouldCompact()               -> does the resident window fill the model's?
//   compact({signal})             -> did the log change (ui/compaction.js)?
//   limits?                       {maxTurns, doomLoopLimit, abortOnDoomLoop} —
//                                 when this turn must end (agent/api/session.py
//                                 serves it; P4-3)
//   observe?(result)              what the page is told after each step
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
// Missing one of the required ports throws at construction. There is no
// default, no in-memory log, no simpler loop to fall back to: a half-wired run
// would be a second way to run a turn, and the whole point of this phase is
// that there is only one.
//
// The two optional ports answer "this session said nothing about it" rather than
// "use something else": `observe` is the host broadcasting what a step did over
// /events so the page can paint "running" — called after each step, with the
// step's own answer, and a failure inside it is swallowed, because a page that
// cannot be painted has not changed the work. `limits` absent means this session
// imposes no budget and no doom-loop guard, which is exactly what the loop did
// before the guard moved here; a session that serves the numbers (it does, from
// its own config) is held to them.

const { foldRun } = require("./run-state");

// The one error a caller may see whose cause is not a failure: `stop()` closed
// the call that was in flight. It never escapes a step (the stop path turns it
// into the aborted final); it exists so a model/tool port can say "I was
// cancelled" instead of inventing a message.
class Stopped extends Error {
  code: string;
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

// What this session says about ending a turn (GET /api/session's `limits`,
// from agent/config.py). Absent is a real answer — a session built before the
// key existed imposes no budget and no doom-loop guard — so this normalizes to
// "both off" rather than inventing numbers the session never chose.
const NO_LIMITS = { maxTurns: 0, doomLoopLimit: 0, abortOnDoomLoop: false };

// A model that keeps returning no visible text is not a turn: the note the loop
// feeds back is a retry, not progress. Without a bound the two reinforce each
// other forever (a relay sending an unreadable shape, a reasoning-only reply),
// filling the log with retry rows the user never asked for. Three is enough to
// tell a hiccup from a format the client cannot read.
const EMPTY_REPLY_LIMIT = 3;

// How many EMPTY assistant turns the current turn already holds, counting back
// over the loop's own notes. Stops at the task that opened the turn, at a real
// answer, at a tool result, or at the final that would have closed it.
function consecutiveEmptyReplies(events, note) {
  const wanted = String(note || "").trim();
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "assistant_message") {
      if (!String(ev.content || "").trim()) {
        count += 1;
        continue;
      }
      break;
    }
    if (ev.type === "user_message") {
      if (String(ev.content || "").trim() === wanted) continue;
      break;
    }
    if (ev.type === "tool_call" || ev.type === "tool_result" || ev.type === "final") break;
    // compaction (and any display-only line) does not change the turn
  }
  return count;
}

function readLimits(ports) {
  const given = ports && ports.limits;
  if (given === undefined || given === null) return NO_LIMITS;
  if (typeof given !== "object") {
    throw new TypeError("run: limits must be {maxTurns, doomLoopLimit, abortOnDoomLoop}");
  }
  const maxTurns = given.maxTurns === undefined ? 0 : given.maxTurns;
  const doomLoopLimit = given.doomLoopLimit === undefined ? 0 : given.doomLoopLimit;
  if (!Number.isInteger(maxTurns) || maxTurns < 0) {
    throw new TypeError("run: limits.maxTurns must be a whole number of turns (0 = no budget)");
  }
  if (!Number.isInteger(doomLoopLimit) || doomLoopLimit < 0) {
    throw new TypeError("run: limits.doomLoopLimit must be a whole number of calls (0 = no guard)");
  }
  return { maxTurns, doomLoopLimit, abortOnDoomLoop: Boolean(given.abortOnDoomLoop) };
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
  // The other optional port: when this turn must end, as the session chose it.
  const limits = readLimits(ports);

  // The stop intent, and the call it is currently aimed at. Neither describes
  // the turn: the log does that.
  let stopped = false;
  let inflight = null;
  let busy = false;

  // The doom-loop window: the last `doomLoopLimit` calls with the result each
  // produced, whether a warning is outstanding, and the exact call it is about.
  // Cleared by start(), because the Python half's window lived on an Agent that
  // was built per run (agent/loop.py): a new task is a fresh cycle, never a
  // stale warning about a call the previous turn made.
  let doomCalls = []; // {name, args, result}
  let doomWarned = false;
  let doomCall = null; // {name, args} the warning is about

  function forgetDoom() {
    doomCalls = [];
    doomWarned = false;
    doomCall = null;
  }

  function prose(key, vars?) {
    const said = text(key, vars);
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

  // Write the final that ends the open turn, and say so. `vars` are the
  // template's slots, if the prose has any ("$max_turns", "$tool").
  async function finish(status, summaryKey, vars?) {
    const summary = prose(summaryKey, vars);
    await put({ type: "final", status, summary });
    return { did: "final", status, summary };
  }

  // ---- the doom-loop guard (agent/core/terminate.py's Terminator, P4-3) ----
  //
  // A doom loop is N consecutive identical calls: same name, same arguments AND
  // the same result content. Identical calls whose results change (polling, a
  // flaky test) are progress, not a loop, and never trigger — which is why the
  // result is part of what is compared and why the tool has to run once more
  // before the guard can speak.

  // Before the tool runs: is this the exact call the warning was about? If so it
  // must NOT run again — that is the whole point of the guard.
  function shouldEscalate(call) {
    return doomWarned && doomCall !== null && doomCall.name === call.name && doomCall.args === call.arguments;
  }

  // After the tool ran with `content`: record the call, and answer "warn" on the
  // first detection. The caller feeds the warning back and keeps going; if the
  // model moves on, the warning is forgiven here (a later legitimate use of the
  // same tool starts a fresh cycle instead of aborting an old one), and the
  // window is cleared after a warning so the model gets a full cycle to change.
  function recordCall(call, content) {
    const limit = limits.doomLoopLimit;
    if (limit <= 0) return ""; // the guard is off: no window, no warning
    if (doomWarned) {
      doomWarned = false;
      doomCall = null;
    }
    doomCalls.push({ name: call.name, args: call.arguments, result: content });
    if (doomCalls.length > limit) doomCalls.shift();
    const same = doomCalls.every(
      (c) => c.name === doomCalls[0].name && c.args === doomCalls[0].args && c.result === doomCalls[0].result
    );
    if (doomCalls.length !== limit || !same) return "";
    doomWarned = true;
    doomCall = { name: call.name, args: call.arguments };
    doomCalls = []; // the warning resets the window (terminate.py)
    return "warn";
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

    if (!content.trim()) {
      // An empty reply is NOT a completion: the assistant line stays durable
      // (the log says it said nothing), the model is asked again with a note —
      // but only while the run is not repeating itself.
      const note = prose("empty_response");
      const prior = consecutiveEmptyReplies(events, note);
      await put({ type: "assistant_message", content, tool_calls: [], reasoning });
      if (prior + 1 >= EMPTY_REPLY_LIMIT) {
        return await finish("error", "empty_reply_limit", { count: String(EMPTY_REPLY_LIMIT) });
      }
      await put({ type: "user_message", content: note });
      return { did: "model", emptyReply: true };
    }
    await put({ type: "assistant_message", content, tool_calls: [], reasoning });
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
      // The warned call, asked a second time. It is not run again: the turn is
      // either ended here (the default) or told why not and allowed to continue
      // with a changed approach (abort_on_doom_loop = false). Either way a
      // result is recorded, so the fold does not hand this call back forever.
      if (shouldEscalate(call)) {
        if (limits.abortOnDoomLoop) return await finish("aborted", "doom_loop", { tool: call.name });
        const note = prose("doom_loop", { tool: call.name });
        await put({ type: "tool_result", tool_call_id: call.id, content: note, is_error: true, diff: "" });
        ran.push({ id: call.id, isError: true });
        continue;
      }
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
      // The guard judges the call by its OWN work, so it reads the raw result —
      // and only then may the warning be appended to what the model is told.
      let content = res.content;
      let isError = Boolean(res.isError);
      if (recordCall(call, res.content) === "warn") {
        // first detection: keep the real result, append the warning, and let the
        // model course-correct (agent/loop.py)
        content = `${res.content}\n\n${prose("doom_loop", { tool: call.name })}`;
        isError = true;
      }
      await put({
        type: "tool_result",
        tool_call_id: call.id,
        content,
        is_error: isError,
        diff: typeof res.diff === "string" ? res.diff : "",
      });
      ran.push({ id: call.id, isError });
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
    forgetDoom(); // ...and a new task is a fresh doom cycle (one Agent per run)
    await put({ type: "user_message", content: task.trim() });
    return await state();
  }

  // Unified run interface: start a new turn if idle, continue an open one.
  // This is the ONE entry point for user-initiated actions — no distinction
  // between "new task" and "resume after interruption" at the caller's level.
  // The fold answers what to do; this function does it.
  async function run(task) {
    const current = await state();
    if (current.phase === "idle") {
      // No turn open: validate and open one, then fall through to drive.
      if (typeof task !== "string" || !task.trim()) {
        throw new TypeError("run.run: a task is required when no turn is open");
      }
      await start(task);
    }
    // Drive to completion: covers both "just opened" and "already open" cases.
    return await drive();
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
    // The turn budget, before anything is asked: `steps` counts the model turns
    // the LOG holds for this turn, so a process that died mid-turn resumes at the
    // same count it left. The Python loop aborted when `turn > max_turns`, i.e.
    // before starting turn max_turns + 1; a turn that is over budget therefore
    // never reaches the model again. 0 means no budget (compaction keeps long
    // runs going). A truncated turn records no assistant line, so it does not
    // spend budget — the model is being told to be concise, not repeating itself.
    if (limits.maxTurns > 0 && answer.steps >= limits.maxTurns) {
      return await finish("aborted", "budget_exceeded", { max_turns: limits.maxTurns });
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
    if (busy) {
      // Two wheels on one turn is the one thing this loop must refuse, and the
      // session's lease cannot catch it: claim_run only refuses a DIFFERENT
      // project (agent/base.py), so a second driver of the same project would
      // be let in and both would write the turn. The refusal therefore has to
      // carry a code the page can act on — "run_active" means "somebody is
      // already driving this", which is a fact, not a failure.
      const err = new Error("run.step: a step is already running") as Error & { code?: string };
      err.code = "run_active";
      throw err;
    }
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

  return { start, run, stop, step, drive, state };
}

module.exports = { createRun, Stopped };
