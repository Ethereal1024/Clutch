// The run's state, READ from the log instead of remembered.
//
// A turn is not something this process holds in memory: it is a stretch of .clc
// lines that opens with a `user_message` and closes with a `final`. Everything
// the loop needs in order to take its next step is derivable from that stretch,
// which is what makes a turn survive the death of the process that was running
// it — a phone frozen under a lock screen, a laptop suspended, a session killed
// mid-tool. The next entry point re-reads the tail and does what the tail says.
// There is no "resume" feature and no checkpoint to restore, because there is no
// state to lose (TODO.md I6).
//
// This module is the fold and nothing else: no append, no model call, no tool
// run. It answers, for a list of events, "is a turn open, and what is its next
// step" — one answer, from the durable events alone. The doing belongs to the
// caller.
//
// The vocabulary is agent/events.py: only `DURABLE_TYPES` reach disk —
// `user_message`, `assistant_message`, `tool_call`, `tool_result`, `final`,
// `compaction`. Streamed deltas (`text_delta`, `reasoning_delta`,
// `tool_call_delta`, `compaction_delta`), `step_start`, `state_update`,
// `permission_request` and the `llm_retry` notice are display facts that are
// never written, so this fold skips any event that is not durable: a reader that
// trusted them would be trusting a line the file does not contain.
//
// What the log cannot say is what the process was DOING when it died, and this
// fold does not pretend to know. An open turn whose last line is a
// `tool_result` may have died on its way to the model, or while deriving
// context; both land on the same next step (`model`), because both mean "the
// model has not spoken since those results". The one place the ambiguity is real
// is a tool call that has no result: the tool may have run and died before its
// result was written. The fold still answers `tool` — rerunning a call is the
// honest reading of a log that never recorded its outcome, and a tool whose
// effect must not be repeated is a tool that has to make itself idempotent, not
// a loop that has to guess.

// The six types that reach the file. Kept here as a set of strings rather than
// imported from Python: the log is the contract between the two halves, and a
// name is cheaper to compare than a shared artifact (P2 keeps the format).
const DURABLE_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "final",
  "compaction",
]);

function isDurable(ev) {
  return Boolean(ev && typeof ev === "object" && DURABLE_TYPES.has(ev.type));
}

// Every durable event of `events`, in file order.
function durableEvents(events) {
  const list = Array.isArray(events) ? events : [];
  return list.filter(isDurable);
}

// A tool call the log records, in the one shape the caller needs to run it.
// `assistant_message.tool_calls` and the `tool_call` records carry the same call
// twice — the assistant turn first (so a stored session replays as text → tools
// → results), then one record per call. The record wins where both exist: it is
// the line the tool actually ran from, and it carries what the assistant turn
// does not (`ui`, `path_arg`).
function callOf(tc) {
  return {
    id: String((tc && tc.id) || (tc && tc.tool_call_id) || ""),
    name: String((tc && tc.name) || ""),
    arguments: String((tc && tc.arguments) || ""),
  };
}

// The fold. `events` is one project's event log — parsed lines, in file order —
// or a window of it; the answer only depends on the stretch after the last
// `final`, so passing the whole file and passing its tail are the same question.
//
// Answers:
//
//   {phase: "idle", next: "start"}              no turn open: the next line a
//                                               task writes opens one
//   {phase: "open", next: "model", ...}         the model speaks next
//   {phase: "open", next: "tool", calls, ...}   these calls have no result yet
//   {phase: "open", next: "final", final, ...}  the turn's answer is on the log
//                                               and its final never landed
//
// and, beside the step: `task` (the turn's first user message), `steps` (how
// many model turns it has taken), `emptyReply` (the last assistant turn said
// nothing, which is not a completion — the loop has to ask again), `at` (where
// this turn starts in the array that was passed, so a caller can re-derive from
// the same window) and `events` (how many durable events the turn is made of).
function foldRun(events) {
  const list = Array.isArray(events) ? events : [];
  // The open turn starts just past the newest final. Everything before it is
  // context (and the compactor's business), never a step.
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].type === "final") {
      start = i + 1;
      break;
    }
  }
  // ...and `at` is in the caller's own coordinates: a caller that sliced a
  // window has to be able to ask the same question of the same bytes.
  let at = list.length;
  const region = [];
  for (let i = start; i < list.length; i++) {
    if (!isDurable(list[i])) continue;
    if (at === list.length) at = i;
    region.push(list[i]);
  }

  const idle = {
    phase: "idle",
    next: "start",
    task: "",
    steps: 0,
    calls: [],
    emptyReply: false,
    final: null,
    at,
    events: 0,
  };
  if (!region.length) return idle;

  let task = "";
  let taskSet = false;
  let steps = 0;
  let lastAssistant = null;
  const issued = []; // calls in the order the turn issued them
  const index = new Map(); // id -> position in `issued`
  const resulted = new Set(); // the ids a tool_result already answered
  let tail = "";

  for (const ev of region) {
    tail = ev.type;
    if (ev.type === "user_message") {
      // the turn's first user message is the task; any later one is the loop
      // talking to itself (an empty reply, a truncation) and stays part of it
      if (!taskSet) {
        task = String(ev.content || "");
        taskSet = true;
      }
      continue;
    }
    if (ev.type === "assistant_message") {
      steps += 1;
      lastAssistant = ev;
      for (const tc of Array.isArray(ev.tool_calls) ? ev.tool_calls : []) {
        const call = callOf(tc);
        if (!call.id || index.has(call.id)) continue;
        index.set(call.id, issued.length);
        issued.push(call);
      }
      continue;
    }
    if (ev.type === "tool_call") {
      const call = callOf(ev);
      if (!call.id) continue;
      if (index.has(call.id)) issued[index.get(call.id)] = call;
      else {
        index.set(call.id, issued.length);
        issued.push(call);
      }
      continue;
    }
    if (ev.type === "tool_result") {
      if (ev.tool_call_id) resulted.add(String(ev.tool_call_id));
      continue;
    }
    // `final` cannot appear here (the region starts after the newest one) and
    // `compaction` is a boundary in the context, not a step: the next iteration
    // simply derives again and calls the model.
  }

  const base = { phase: "open", task, steps, at, events: region.length };
  const pending = issued.filter((c) => !resulted.has(c.id));
  if (pending.length) {
    return { ...base, next: "tool", calls: pending, emptyReply: false, final: null };
  }
  // A model turn whose text is the answer and whose `final` never landed: the
  // sentence is already durable, so the honest next step is to close the turn
  // with it rather than to ask the model the same question twice.
  if (tail === "assistant_message") {
    const content = lastAssistant ? String(lastAssistant.content || "") : "";
    if (content.trim()) {
      return {
        ...base,
        next: "final",
        calls: [],
        emptyReply: false,
        final: { status: "completed", summary: content },
      };
    }
    // an empty reply is NOT a completion (agent/loop.py): the next step is the
    // model again, with the loop's own note that it said nothing
    return { ...base, next: "model", calls: [], emptyReply: true, final: null };
  }
  return { ...base, next: "model", calls: [], emptyReply: false, final: null };
}

module.exports = { DURABLE_TYPES, durableEvents, foldRun };
