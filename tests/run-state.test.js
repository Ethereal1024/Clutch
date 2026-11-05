// ui/run-state.js is the loop's whole memory: a turn is a stretch of .clc lines
// and its next step is read off the tail, never carried in a variable. These
// checks drive the real fold over logs in the order agent/loop.py writes them,
// including the shapes a process death leaves behind — an assistant turn with
// calls and no results, all results and no model turn, a model answer whose
// final never landed — because those are the only states a resume ever sees.
// Run: node tests/run-state.test.js
const { check, summary } = require("./harness.js");
const { DURABLE_TYPES, durableEvents, foldRun } = require("../ui/run-state.js");

// one durable event as the log writes it (agent/events.py); only the fields this
// fold reads are spelled out, and `id`/`timestamp` are dropped because nothing
// here may depend on them
const user = (content) => ({ type: "user_message", content });
const said = (content, tool_calls = [], reasoning = "") => ({ type: "assistant_message", content, tool_calls, reasoning });
const call = (id, name, args = "{}") => ({ type: "tool_call", name, arguments: args, tool_call_id: id, ui: {}, path_arg: "" });
const result = (id, content = "ok") => ({ type: "tool_result", tool_call_id: id, content, is_error: false, diff: "" });
const final = (status = "completed", summary = "") => ({ type: "final", status, summary });
const compaction = (s = "…") => ({ type: "compaction", summary: s });
// display-only events: they are NEVER on disk, so a fold that read them would be
// reading a line the file cannot contain
const noise = [
  { type: "step_start" },
  { type: "text_delta", content: "a" },
  { type: "reasoning_delta", content: "b" },
  { type: "tool_call_delta", tool_call_id: "t1", name: "run", delta: "{" },
  { type: "state_update", key: "execution_status", value: "running" },
  { type: "llm_retry", attempt: 1, max_retries: 3, discard: true, message: "timed out" },
  { type: "permission_request", request_id: "p1", tool: "run", args_repr: "{}", reason: "write" },
  { type: "compaction_delta", chars: 10, done: false, note: "" },
];

function main() {
  // ---- 1. the vocabulary is the six durable types, and nothing else ----
  {
    check(DURABLE_TYPES.size === 6, "the fold knows exactly the six durable types the log writes");
    for (const t of ["user_message", "assistant_message", "tool_call", "tool_result", "final", "compaction"]) {
      check(DURABLE_TYPES.has(t), `${t} is durable`);
    }
    for (const t of ["step_start", "text_delta", "llm_retry", "state_update", "permission_request"]) {
      check(!DURABLE_TYPES.has(t), `${t} is a display fact, never a log line`);
    }
    check(durableEvents([...noise, user("hi")]).length === 1, "the filter strips the display layer and keeps the turn");
    check(durableEvents(null).length === 0, "no log is no durable events, not a crash");
  }

  // ---- 2. no turn open: the next line opens one ----
  {
    const empty = foldRun([]);
    check(empty.phase === "idle" && empty.next === "start", "an empty log is idle, and the next step is the one that starts a turn");
    check(empty.task === "" && empty.steps === 0 && empty.calls.length === 0, "with nothing read, nothing is claimed");

    const closed = foldRun([user("do it"), said("done"), final("completed", "done")]);
    check(closed.phase === "idle" && closed.next === "start", "a turn that ended with a final is over, whatever it said");
    check(closed.events === 0, "and it contributes no open turn to fold");

    const errored = foldRun([user("do it"), final("error", "boom")]);
    check(errored.phase === "idle", "an error final closes the turn the same way a completed one does");

    const trailing = foldRun([user("do it"), said("done"), final(), ...noise]);
    check(trailing.phase === "idle", "display events after the final do not reopen a turn");
  }

  // ---- 3. the task went in and the model has not spoken ----
  {
    const fresh = foldRun([user("what is in /tmp?")]);
    check(fresh.phase === "open" && fresh.next === "model", "a task with no answer asks the model");
    check(fresh.task === "what is in /tmp?" && fresh.steps === 0, "the turn's task is the user message that opened it");
    check(fresh.at === 0 && fresh.events === 1, "and the fold says where the turn sits in the array it was given");

    // the second turn is folded alone: everything before its final is context
    const twoTurns = [user("one"), said("a"), final(), ...noise, user("two")];
    const second = foldRun(twoTurns);
    check(second.task === "two" && second.at === twoTurns.length - 1, "a later turn is the one folded, at its own offset");
    check(second.steps === 0, "and the previous turn's answer is not counted as this one's");
  }

  // ---- 4. tool calls: what has an answer, and what has none ----
  {
    // the ordinary shape: assistant turn, one call record, one result, then the
    // model is due again
    const mid = foldRun([user("go"), said("", [{ id: "t1", name: "read", arguments: '{"p":"/tmp"}' }]), call("t1", "read", '{"p":"/tmp"}')]);
    check(mid.next === "tool" && mid.calls.length === 1, "a call with no result is the next step");
    check(mid.calls[0].id === "t1" && mid.calls[0].name === "read", "and it is named, with the id the result will answer");
    check(mid.calls[0].arguments === '{"p":"/tmp"}', "and carries the arguments the tool ran from");

    const fed = foldRun([user("go"), said("", [{ id: "t1", name: "read" }]), call("t1", "read"), result("t1")]);
    check(fed.next === "model" && fed.calls.length === 0, "a result answers its call, and the model is due again");
    check(fed.steps === 1, "one model turn has happened in this turn");

    // two calls issued together, one result landed before the process died: the
    // unanswered one is the step, and the answered one is not run twice
    const partial = foldRun([
      user("go"),
      said("", [{ id: "t1", name: "a" }, { id: "t2", name: "b" }]),
      call("t1", "a"),
      call("t2", "b"),
      result("t1"),
    ]);
    check(partial.next === "tool" && partial.calls.length === 1, "only the call without a result is pending");
    check(partial.calls[0].id === "t2", "and it is the one that had none — results are matched by id, not by position");

    // a result for a call this turn never issued (a leftover id) answers nothing
    const stray = foldRun([user("go"), said("", [{ id: "t1", name: "a" }]), call("t1", "a"), result("zz")]);
    check(stray.next === "tool" && stray.calls[0].id === "t1", "a result that answers some other call leaves this one pending");

    // the assistant turn is the earliest record of the call, so a crash between
    // the two lines still knows what to run
    const beforeRecord = foldRun([user("go"), said("", [{ id: "t1", name: "read", arguments: '{"p":"x"}' }])]);
    check(beforeRecord.next === "tool" && beforeRecord.calls[0].name === "read", "calls are read from the assistant turn when no call record landed yet");
    check(beforeRecord.calls[0].arguments === '{"p":"x"}', "with the arguments the assistant turn carried");

    // ...and the call record is the copy that wins, because it is what ran
    const both = foldRun([
      user("go"),
      said("", [{ id: "t1", name: "read", arguments: "{}" }]),
      call("t1", "read_file", '{"p":"x"}'),
    ]);
    check(both.calls.length === 1 && both.calls[0].name === "read_file", "one call is one entry, even when both records exist");
    check(both.calls[0].arguments === '{"p":"x"}', "and the record's own arguments are the ones kept");
  }

  // ---- 5. an answer that never got its final ----
  {
    const answered = foldRun([user("q"), said("42")]);
    check(answered.next === "final", "an assistant answer with no tool calls is the turn's answer");
    check(
      answered.final.status === "completed" && answered.final.summary === "42",
      "and the final it owes is the sentence already on the log, not a new question to the model"
    );

    const stopped = foldRun([user("q"), said("partial"), final("aborted", "cancelled")]);
    check(stopped.phase === "idle" && stopped.next === "start", "a cancelled turn stays cancelled: its final is the last word");

    const emptyReply = foldRun([user("q"), said("   ")]);
    check(emptyReply.next === "model" && emptyReply.emptyReply === true, "an empty reply is not a completion — the model is asked again");
    check(emptyReply.final === null, "and no final is invented for it");

    // a compaction is a boundary in the context, not a step: the model speaks next
    const compacted = foldRun([user("q"), compaction("so far")]);
    check(compacted.next === "model" && compacted.emptyReply === false, "a compaction leaves the turn open and due a model call");
  }

  // ---- 6. the loop's own notes are part of the same turn ----
  {
    const retried = foldRun([user("q"), said(""), user("[empty reply]"), said("answer")]);
    check(retried.task === "q", "the turn's task is its FIRST user message, not the loop's note to itself");
    check(retried.steps === 2, "and both model turns are counted, which is what a turn budget counts");
    check(retried.next === "final", "the answer that followed the note is the answer");
  }

  // ---- 7. a turn is the stretch after the newest final, and only that ----
  {
    const log = [
      user("one"), said("", [{ id: "a1", name: "x" }]), call("a1", "x"), result("a1"), said("done one"), final("completed", "done one"),
      user("two"), said("", [{ id: "b1", name: "y" }]), call("b1", "y"),
    ];
    const f = foldRun(log);
    check(f.task === "two" && f.steps === 1, "the open turn is the last one, and its own steps are all it counts");
    check(f.calls.length === 1 && f.calls[0].id === "b1", "the previous turn's answered call is not pending in this one");
    check(f.at === 6, "and it starts where its first line sits in the array that was passed");

    // the same log with the last turn's final landed is idle again
    const closed = foldRun([...log, result("b1"), said("done two"), final("completed", "done two")]);
    check(closed.phase === "idle", "closing the turn by its final is enough to leave nothing open");

    // a window that starts mid-turn is the same question, answered from fewer lines
    const windowed = foldRun(log.slice(6));
    check(windowed.task === "two" && windowed.at === 0, "a window starting at the turn reads that turn at its own offset");
  }

  // ---- 8. what a malformed log does: nothing, rather than a guess ----
  {
    check(foldRun(null).phase === "idle", "a missing log is an idle process");
    check(foldRun([null, {}, { type: "not_a_type" }]).phase === "idle", "unknown lines are not steps");
    const halfCall = foldRun([user("q"), { type: "tool_call", name: "x", arguments: "{}" }]);
    check(halfCall.next === "model", "a call record with no id cannot be answered by a result, so it is not handed out to run");
  }

  summary("run-state: the turn read off the log (open / next step / pending calls)");
}

main();
