// One durable event, as the text a READER of the log sees.
//
// The one projection both readers of a stored session share: the compaction
// transcript (ui/compaction.js, whose summarizer reads the window as text) and
// the project-log reader a model drives (`grep_memory` / `read_memory`). A line
// of the .clc is rendered as ITSELF here — the tool calls an assistant turn made
// are their own `tool_call` records, so they are not repeated inside the
// assistant_message that precedes them.
//
// `limit` caps one event's BODY (a tool result of a thousand lines, a whole file
// read) and SAYS SO where the cut happened: the marker is part of the text,
// never a silent trim. An event the log cannot render as text (a display delta,
// a state update) renders "" and the caller decides whether an empty line is
// worth showing.
//
// Port of agent/events.py:event_text, unchanged — the Python half still renders
// history pages this way until P4 removes it.

function clip(text, limit) {
  if (limit === null || limit === undefined || text.length <= limit) return text;
  return text.slice(0, limit) + "\n[truncated]";
}

function eventText(ev, limit = null) {
  if (!ev || typeof ev !== "object") return "";
  const arg = limit === undefined ? null : limit;
  const text = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
  if (ev.type === "user_message") return `[User]: ${clip(text(ev.content), arg)}`;
  if (ev.type === "assistant_message") {
    const parts = [];
    if (ev.content) parts.push(`[Assistant]: ${clip(text(ev.content), arg)}`);
    if (ev.reasoning) parts.push(`[Assistant reasoning]: ${clip(text(ev.reasoning), arg)}`);
    return parts.join("\n");
  }
  if (ev.type === "tool_call") {
    return `[Assistant tool call]: ${clip(`${text(ev.name)}(${text(ev.arguments)})`, arg)}`;
  }
  if (ev.type === "tool_result") return `[Tool result]: ${clip(text(ev.content), arg)}`;
  if (ev.type === "compaction") return `[Compaction summary]: ${clip(text(ev.summary), arg)}`;
  if (ev.type === "final") {
    return `[Final]: ${clip(text(ev.summary) || text(ev.status), arg)}`;
  }
  return "";
}

module.exports = { eventText, clip };
