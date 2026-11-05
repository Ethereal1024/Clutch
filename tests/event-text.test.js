// ui/event-text.js is the one projection of a durable event as text: what a
// compaction summarizer reads, and what a later session's memory reader shows a
// model. These checks pin every event type's rendering, the "say nothing" cases
// (a body that is not a string, an event the log cannot render), and the clip
// marker — a cut must be visible in the text, never a silent trim.
// Run: node tests/event-text.test.js
const { check, summary } = require("./harness.js");
const { eventText, clip } = require("../ui/event-text.js");

function main() {
  // ---- 1. the conversation, event by event ----
  {
    check(eventText({ type: "user_message", content: "hi" }) === "[User]: hi", "a user message is what the user said");
    check(
      eventText({ type: "assistant_message", content: "hello" }) === "[Assistant]: hello",
      "an assistant message is what the assistant said"
    );
    check(
      eventText({ type: "assistant_message", content: "hello", reasoning: "because" }) ===
        "[Assistant]: hello\n[Assistant reasoning]: because",
      "reasoning follows the visible text on its own line"
    );
    check(
      eventText({ type: "assistant_message", content: "", reasoning: "thinking" }) ===
        "[Assistant reasoning]: thinking",
      "a reasoning-only turn does not print an empty [Assistant]: line"
    );
    check(
      eventText({ type: "assistant_message", content: "hello", reasoning: "" }) === "[Assistant]: hello",
      "and a turn with no reasoning does not print an empty reasoning line"
    );
    check(
      eventText({ type: "assistant_message", content: "", reasoning: "" }) === "",
      "a message with neither renders nothing, so the caller can skip the line"
    );
    check(
      eventText({ type: "tool_call", name: "run_command", arguments: '{"cmd":"ls"}' }) ===
        '[Assistant tool call]: run_command({"cmd":"ls"})',
      "a tool call is name(args), the form a reader can copy"
    );
    check(
      eventText({ type: "tool_result", content: "file.txt" }) === "[Tool result]: file.txt",
      "a tool result is the result"
    );
    check(
      eventText({ type: "compaction", summary: "earlier work" }) === "[Compaction summary]: earlier work",
      "a compaction line is the summary it carries"
    );
    check(
      eventText({ type: "final", status: "completed", summary: "shipped" }) === "[Final]: shipped",
      "a final's summary is its text when it has one"
    );
    check(
      eventText({ type: "final", status: "aborted", summary: "" }) === "[Final]: aborted",
      "and the status stands in when it does not"
    );
    check(
      eventText({ type: "final", status: "error" }) === "[Final]: error",
      "a final without a summary at all still says how the run ended"
    );
  }

  // ---- 2. bodies that are absent, and events with nothing to say ----
  {
    check(eventText({ type: "user_message", content: "" }) === "[User]: ", "an empty body is an empty body, not a skip");
    check(eventText({ type: "user_message" }) === "[User]: ", "a missing body is empty, not the word undefined");
    check(eventText({ type: "user_message", content: null }) === "[User]: ", "null is empty too");
    check(eventText({ type: "tool_result", content: 42 }) === "[Tool result]: 42", "a non-string body is printed, not dropped");
    check(eventText({ type: "tool_call", name: "x" }) === "[Assistant tool call]: x()", "a call with no arguments still names the tool");
    check(eventText({ type: "compaction" }) === "[Compaction summary]: ", "a summary that is not there is not the word undefined");

    for (const type of ["step_start", "text_delta", "reasoning_delta", "tool_call_delta", "compaction_delta", "state_update", "permission_request", "llm_retry", "nonsense"]) {
      check(eventText({ type }) === "", `a ${type} event is display-only and renders nothing`);
    }
    check(eventText(null) === "", "no event, no text");
    check(eventText(undefined) === "", "undefined is no event either");
    check(eventText("user_message") === "", "a bare string is not an event");
  }

  // ---- 3. the clip is visible ----
  {
    check(clip("abc", null) === "abc", "no limit, no cut");
    check(clip("abc", undefined) === "abc", "an absent limit is no limit either");
    check(clip("abc", 3) === "abc", "text exactly at the limit is not marked truncated");
    check(clip("abcdef", 3) === "abc\n[truncated]", "text past the limit keeps the head and SAYS it was cut");
    check(clip("abc", 0) === "\n[truncated]", "a zero limit leaves only the marker");

    const long = "y".repeat(600);
    const text = eventText({ type: "tool_result", content: long }, 500);
    check(text === `[Tool result]: ${"y".repeat(500)}\n[truncated]`, "the clip applies to the body, and only the body, of a real event");
    check(!text.includes("y".repeat(501)), "not one byte past the limit survives");

    check(
      eventText({ type: "user_message", content: "abcdef" }, 3) === "[User]: abc\n[truncated]",
      "the prefix is never counted against the limit"
    );
    check(
      eventText({ type: "assistant_message", content: "abcdef", reasoning: "abcdef" }, 3) ===
        "[Assistant]: abc\n[truncated]\n[Assistant reasoning]: abc\n[truncated]",
      "each part of an assistant message is clipped on its own"
    );
    const args = '{"a":"' + "z".repeat(600) + '"}';
    const called = `run_command(${args})`;
    check(
      eventText({ type: "tool_call", name: "run_command", arguments: args }, 500) ===
        `[Assistant tool call]: ${called.slice(0, 500)}\n[truncated]`,
      "a huge argument list is clipped like any other body"
    );
    check(eventText({ type: "tool_result", content: "abc" }, null) === "[Tool result]: abc", "an explicit null limit cuts nothing");
  }

  summary("event-text: one durable event as the text a reader sees");
}

main();
