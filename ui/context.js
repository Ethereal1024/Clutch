// The messages the model is asked with, derived from the event log.
//
// The log is the single source of truth; what the model sees is a projection of
// it, recomputed every turn. There is no separate transcript to keep in sync and
// nothing to rebuild on resume: a process that dies and comes back derives the
// same messages from the same lines (TODO.md I6). This is the port of
// agent/core/context.py, and the strategy is unchanged:
//
//   - window: only the events after the newest compaction are projected
//     ([cpr_start, file_end); the .clc side of that is P2's, which hands this
//     module the window it read)
//   - head: the newest compaction's summary, plus the files it rolled away, is
//     the beginning of the context
//   - truncation: oversized tool output is trimmed at the tools layer, not
//     folded here; output accumulates until compaction is the only budget guard
//
// What this module does NOT do: read the log, decide when to compact, or know
// where the project's memory is. Those are the caller's ports — it receives the
// events it should project, the current task, and the facts the prompt states.
//
// The prompt's own assembly lives here rather than in the loop because the
// system message is context, not orchestration: mode contract, the components'
// words about their own tools, the local shell hint, and the memory anchor all
// describe what this session can do, and all of them are the caller's facts.
// Every one is optional and none is invented: the mode sentences appear because
// a mode was named, the shell hint because a shell was named, the memory anchor
// only when there is a file behind it (a prompt must not promise a reader with
// nothing to read).

const path = require("path");
const { render } = require("./prompt");

// How big the log is, in the units a model reads at a glance. Spelled here, in
// the context, rather than taken from a formatting helper in the tools layer:
// this is the only number the prompt needs.
function size(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.floor(bytes / 1024))} KB`;
}

function parseArguments(raw) {
  try {
    const args = JSON.parse(raw || "{}");
    return args && typeof args === "object" ? args : null;
  } catch (e) {
    return null;
  }
}

// Distinct file paths the model was reading/writing in the window (most recent
// first), so a post-compaction context can tell it to re-read them.
//
// Which calls count, and in which argument the file was named, is the tool's own
// declaration: the loop stamps every `tool_call` with `path_arg` (the argument a
// read/write policy judges, "" for a call that named no file). No tool name is
// known here — a component's read tool is remembered exactly like any other.
function recentWorkingFiles(tailEvents, cap = 6) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(tailEvents) ? tailEvents : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i];
    if (!ev || ev.type !== "tool_call" || !ev.path_arg) continue;
    const args = parseArguments(ev.arguments);
    if (!args) continue;
    const named = args[ev.path_arg];
    if (typeof named === "string" && named && !seen.has(named)) {
      seen.add(named);
      out.push(named);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// Project events to OpenAI messages; assistant turns and tool results must stay
// paired. A key is present only when there is something in it: an assistant turn
// that said nothing is `{role:"assistant"}` (or carries only reasoning), which is
// what the wire accepts and what the log says happened.
function toMessages(events) {
  const msgs = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "user_message") {
      msgs.push({ role: "user", content: String(ev.content || "") });
    } else if (ev.type === "assistant_message") {
      const msg = { role: "assistant" };
      const content = typeof ev.content === "string" ? ev.content : "";
      if (content) msg.content = content;
      if (ev.reasoning) msg.reasoning_content = String(ev.reasoning);
      const calls = Array.isArray(ev.tool_calls) ? ev.tool_calls : [];
      if (calls.length) {
        msg.tool_calls = calls.map((tc) => ({
          id: String((tc && tc.id) || ""),
          type: "function",
          function: {
            name: String((tc && tc.name) || ""),
            arguments: String((tc && tc.arguments) || ""),
          },
        }));
      }
      msgs.push(msg);
    } else if (ev.type === "tool_result") {
      msgs.push({
        role: "tool",
        tool_call_id: String(ev.tool_call_id || ""),
        content: String(ev.content || ""),
      });
    }
    // `tool_call`, `final`, `compaction` are not model-visible lines: the call is
    // already in its assistant turn, the final is what ends a turn, and a
    // compaction is a boundary the head replaces.
  }
  return repairDangling(msgs);
}

// Enforce the pairing contract when the log ends mid-batch: drop assistant
// tool_calls without their results, plus orphan tool messages. Healthy logs are
// untouched.
function repairDangling(msgs) {
  const out = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === "assistant" && m.tool_calls) {
      const ids = m.tool_calls.map((tc) => tc.id);
      let j = i + 1;
      const responded = new Set();
      while (j < msgs.length && msgs[j].role === "tool") {
        responded.add(msgs[j].tool_call_id);
        j += 1;
      }
      if (ids.every((id) => responded.has(id))) {
        for (let k = i; k < j; k++) out.push(msgs[k]); // complete block: keep as-is
      } else {
        // interrupted block: drop tool_calls; only real text can stand alone
        const cleaned = {};
        for (const k of Object.keys(m)) if (k !== "tool_calls") cleaned[k] = m[k];
        if (cleaned.content) out.push(cleaned);
      }
      i = j;
    } else if (m.role === "tool") {
      i += 1; // orphan tool message (no owning assistant block): drop
    } else if (m.role === "assistant") {
      // no tool_calls: only a message with real text can stand alone
      if (m.content) out.push(m);
      i += 1;
    } else {
      out.push(m);
      i += 1;
    }
  }
  return out;
}

// The system message, assembled from the facts the caller holds.
function systemMessage({ mode, components, shell, memory }) {
  let system = render("system.md");
  if (mode === "chat") {
    // read-only contract: tell the model before it attempts a write
    system += "\n\n" + render("mode_chat.md");
  } else if (mode === "work") {
    // work contract: announce full access (mirror of chat mode)
    system += "\n\n" + render("mode_work.md");
  }
  if (typeof components === "string" && components) {
    // the components' own words about their own tools, assembled by the side
    // that knows what is installed and drivable. This module places it and names
    // no tool itself, so the prompt cannot describe tools that are gone. The
    // skill catalog arrives this way too: the component that serves the library
    // publishes it.
    system += "\n\n" + components;
  }
  if (shell === "bash") {
    // the local shell the model's commands will execute under: say so up front
    // so the first command already speaks the right dialect. posix-sh (POSIX
    // hosts, and remote workspaces) adds nothing — zero prompt diff.
    system += "\n\n" + render("env_windows_bash.md");
  } else if (shell === "cmd") {
    system += "\n\n" + render("env_windows_cmd.md");
  }
  if (memory && memory.path) {
    // The project's memory, stated last: this project's whole log is one file,
    // the model only holds the part since the last compaction, and two host
    // tools read the rest of it. Only a real project file gets this: an
    // in-memory scratch log has no path, and a prompt must not promise a reader
    // with nothing behind it.
    system +=
      "\n\n" + render("recall.md", { name: path.basename(String(memory.path)), size: size(memory.bytes) });
  }
  return system;
}

// Derive the messages for one model turn.
//
//   events      the log (or the window P2 hands over), in file order
//   task        the turn's task, re-injected as its own user message
//   mode        "chat" | "work" ("" for neither: no contract sentence)
//   components  the installed components' prompt fragments
//   shell       the local shell run_command speaks: "bash" | "cmd"
//   memory      {path, bytes} — the project log the recall anchor names
//
// The task line is re-injected because it is the requirement, not a nicety: a
// summary can compress it, and a window can start after it. The log's own first
// user message is dropped only when it IS that task — in a continued session it
// is the project's FIRST user message, a real requirement that dropping would
// erase on every follow-up.
function deriveMessages(options) {
  const o = options || {};
  if (!Array.isArray(o.events)) {
    throw new TypeError("context.deriveMessages: events must be an array");
  }
  if (typeof o.task !== "string") {
    throw new TypeError("context.deriveMessages: task must be a string");
  }
  const task = o.task;
  const fullEvents = o.events;
  const rawTask =
    fullEvents.length && fullEvents[0] && fullEvents[0].type === "user_message" ? fullEvents[0] : null;

  let events = fullEvents;
  const head = [];
  // newest compaction summary is the head; only events after it are the window
  let lastCompaction = -1;
  for (let i = fullEvents.length - 1; i >= 0; i--) {
    if (fullEvents[i] && fullEvents[i].type === "compaction") {
      lastCompaction = i;
      break;
    }
  }
  if (lastCompaction >= 0) {
    head.push({
      role: "user",
      content: render("compaction_head.md", { summary: String(fullEvents[lastCompaction].summary || "") }),
    });
    // slice to the last summary: summarized history never re-enters the context
    const tail = fullEvents.slice(lastCompaction + 1);
    const files = recentWorkingFiles(tail);
    if (files.length) {
      // compacted-away files: the model must re-read them before editing
      head.push({ role: "user", content: render("compaction_files.md", { files: files.join(", ") }) });
    }
    events = tail;
  }
  if (rawTask !== null && events.length && events[0] === rawTask && rawTask.content === task) {
    events = events.slice(1);
  }

  return [
    { role: "system", content: systemMessage(o) },
    { role: "user", content: render("task.md", { task }) },
    ...head,
    ...toMessages(events),
  ];
}

// `deriveMessages` pinned to one session's facts, which is the shape the loop
// asks for (ui/run.js's `derive({events, task})` port): the caller wires the
// session once and the loop never has to know what a mode or a shell is.
function createDerive(facts) {
  const pinned = facts || {};
  return function derive({ events, task } = {}) {
    return deriveMessages({ ...pinned, events, task });
  };
}

module.exports = {
  size,
  recentWorkingFiles,
  toMessages,
  repairDangling,
  systemMessage,
  deriveMessages,
  createDerive,
};
