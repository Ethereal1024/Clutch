// The run loop on the far-root host: derive, call, execute, compact, terminate.
//
// Ported from `agent/loop.py` (Agent), plus the four small modules it drives:
// `agent/core/context.py` (derive_messages / _to_messages / _repair_dangling),
// `agent/core/terminate.py` (Terminator), `agent/core/parse.py` (parse_arguments)
// and `agent/core/compaction.py` (Compactor). They come along because the loop
// is the only caller of all four, and because they are pure functions of (log,
// config, events) — no Python, no process, nothing to host.
//
// Events stay the single source of truth: a turn is appended to the log, the
// model's context is DERIVED from the log, and the UI sees the same records the
// context is built from. Nothing here keeps a second copy of the conversation.
//
// What is INJECTED rather than ported, and why:
//
//   * `render(name, vars)` — the prompt templates (`agent/prompts/*.md`, read by
//     `string.Template`). Where those files live on a host that has no Python is
//     not this file's question, so the loop asks for a function. A caller that
//     passes a strict renderer (one that throws on an unknown placeholder) turns
//     a renamed prompt variable into a loud failure instead of a literal `$name`
//     in the system prompt.
//   * `components` — `tools.registry.prompt_section(config)`, the fragments the
//     installed components carry about their own tools. It is the tool face's
//     business (milestone M3), and the loop only has to place it.
//   * `gate` — the permission gate. `core/permission.py` stays the one semantic
//     source (plan §8 D2); a JS gate would be a second policy engine, so the
//     loop calls the same `require(name, argsRepr, workspace, access, accessArg)`
//     and the *enforcement* on the plugin side is M3's. Its refusal contract is
//     spelled out at the call site.
//   * `registry`, `workspace`, `llm`, `log` — the seams that already exist in
//     this host (`ui/host/llm.js`, `ui/host/clc.js`, `ui/host/fs.js`,
//     `ui/host/journal.js`). No local root is assumed: the workspace is the only
//     way to a file, exactly as in the rest of `ui/host/` (plan §7 ban X1).
//
// DELIBERATE DIVERGENCE, the only one:
//
//   - `parseArguments` reports a JSON syntax error with JavaScript's parser
//     detail (`Unexpected token } in JSON at position 5`) where CPython says
//     `Expecting ',' delimiter: line 1 column 12 (char 11)`. The SENTENCE around
//     it — the part the model is meant to act on — is unchanged, and the detail
//     is quoted verbatim from whichever parser read the arguments. Reproducing
//     CPython's message table would mean re-implementing its parser, and the
//     text is fed back to the model as an error, never persisted.

"use strict";

const { eventFromDict, LazyEventLog } = require("./clc");
const { eventText } = require("./events");

// `agent/config.py` defaults, in one place so the caller (and the tests) can
// assert against the same numbers instead of restating them. A run's config is
// built from the session's settings; these only fill a field that was not set.
const DEFAULTS = {
  maxTurns: 0, // 0 = no limit: compaction keeps a long run going
  doomLoopLimit: 4,
  abortOnDoomLoop: true,
  contextWindowBytes: 500_000,
};

// The events a summarizer reads: the conversation itself. A compaction line is
// the head it already carries and a final is a run's verdict, not something said.
// (`agent/core/compaction.py: _TRANSCRIPT`.)
const TRANSCRIPT = new Set(["user_message", "assistant_message", "tool_call", "tool_result"]);

// ---- small helpers -------------------------------------------------------

// The run's Stop, in the three shapes a caller may hand us. Same reading as
// `ui/host/llm.js: isCancelled`, so one flag means one thing down the whole
// stack: a thread Event (`is_set`), the host's own set (`isSet`), or the
// AbortController the renderer already owns.
function isSet(cancel) {
  if (!cancel) return false;
  if (typeof cancel.isSet === "function") return Boolean(cancel.isSet());
  if (typeof cancel.is_set === "function") return Boolean(cancel.is_set());
  return Boolean(cancel.aborted);
}

// Read one of several spellings of a config field (a settings object built by the
// renderer's code may use either). `undefined`/`null` fall through; a real 0 or
// `false` is a value and stops the search.
function pick(object, ...names) {
  for (const name of names) {
    const value = object ? object[name] : undefined;
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function number(object, names, fallback) {
  const value = pick(object, ...names);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(object, names, fallback) {
  const value = pick(object, ...names);
  return typeof value === "boolean" ? value : fallback;
}

// `type(value).__name__`, for the parser's error text. The reachable values are
// the ones a JSON document can produce at the top level.
function pyTypeName(value) {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "string":
      return "str";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    default:
      return "object";
  }
}

// `posixpath.basename`, spelled out: the far-root host does not load `path`
// (it would be a local-filesystem module, ban X1), and this is eight characters
// of string arithmetic on a path the workspace already resolved.
function basename(text) {
  const value = String(text);
  const slash = value.lastIndexOf("/");
  return slash < 0 ? value : value.slice(slash + 1);
}

// Python's `f"{x:.1f}"`: round-half-to-EVEN on the exact value. `toFixed` rounds
// halves away from zero, and the difference is reachable here: a log of
// 1 310 720 bytes is exactly 1.25 MB, which Python prints "1.2" and toFixed
// would print "1.3". (Any binary fraction that lands on a decimal tie is a
// quarter, so the tie rule is exactly the half-even one.)
function fixed1(x) {
  const scaled = x * 10;
  const low = Math.floor(scaled);
  const frac = scaled - low;
  let tenths;
  if (frac > 0.5) tenths = low + 1;
  else if (frac < 0.5) tenths = low;
  else tenths = low % 2 === 0 ? low : low + 1; // exact tie: to even
  const whole = Math.floor(tenths / 10);
  return `${whole}.${tenths - whole * 10}`;
}

// `agent/core/context.py: _size` — how big the log is, in the units a model
// reads at a glance. Spelled here rather than taken from a formatting helper
// elsewhere: it is the only number the prompt needs, and the prompt is built in
// this file.
function sizeText(n) {
  const bytes = Number(n);
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0;
  if (value >= 1024 * 1024) return `${fixed1(value / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.floor(value / 1024))} KB`;
}

// ---- errors --------------------------------------------------------------

// `agent/core/errors.py: AgentError` — fatal, terminates the loop. `str(e)` is
// `"[code] message"`, which is what a run's failing `final` carries, so the code
// reaches the UI without a second field.
class AgentError extends Error {
  constructor(code = "agent_error", message = "", detail = null) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.detail = detail;
  }

  toString() {
    return `[${this.code}] ${this.message}`;
  }
}

// `errors.context_window_error`: the model's own message becomes the DIAGNOSTIC;
// what the user reads is the fixed sentence telling them to restart focused.
function contextWindowError(detail) {
  return new AgentError(
    "context_window_exceeded",
    "Context window is full; cannot continue. Restart with a more focused task.",
    detail
  );
}

// `agent/core/parse.py: ParseError` — a parse failure whose message is safe to
// feed back to the model (error-as-data, never a crash).
class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseError";
  }
}

function parseArguments(raw) {
  let data;
  try {
    data = JSON.parse(String(raw === undefined || raw === null ? "" : raw));
  } catch (e) {
    // the frame is Python's; the parenthesised detail is this parser's
    throw new ParseError(
      `Argument parse failed: invalid JSON (${e && e.message ? e.message : e}). ` +
        "Regenerate the arguments as a valid JSON object."
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ParseError(
      `Argument parse failed: expected a JSON object, got ${pyTypeName(data)}.`
    );
  }
  return data;
}

// ---- the log as text (events.event_text) ---------------------------------

// The projection itself lives in `ui/host/events.js` (`agent/events.py:227`),
// because the project-log reader (`tools.js`) renders a stored line the same
// way the compaction transcript does; it is re-exported here for the callers
// that already reach the loop for it.

// ---- messages (core/context.py) ------------------------------------------

// Project events to OpenAI messages; assistant and tool results must stay paired.
function toMessages(events) {
  const msgs = [];
  for (const ev of events) {
    if (!ev) continue;
    if (ev.type === "user_message") {
      msgs.push({ role: "user", content: ev.content });
    } else if (ev.type === "assistant_message") {
      const msg = { role: "assistant" };
      if (ev.content) msg.content = ev.content;
      // some APIs require reasoning content to be passed back
      if (ev.reasoning) msg.reasoning_content = ev.reasoning;
      if (ev.tool_calls && ev.tool_calls.length) {
        msg.tool_calls = ev.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      msgs.push(msg);
    } else if (ev.type === "tool_result") {
      msgs.push({ role: "tool", tool_call_id: ev.tool_call_id, content: ev.content });
    }
  }
  return repairDangling(msgs);
}

// Enforce the OpenAI pairing contract when the log ends mid-batch: drop assistant
// tool_calls without their tool results, plus orphan tool messages. A healthy log
// is untouched.
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
      if (ids.every((tid) => responded.has(tid))) {
        out.push(...msgs.slice(i, j)); // complete block: keep as-is
      } else {
        // interrupted block: drop tool_calls; only real text can stand alone
        const cleaned = {};
        for (const key of Object.keys(m)) if (key !== "tool_calls") cleaned[key] = m[key];
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

// Distinct file paths the model was reading/writing in the window (most recent
// first), so a post-compaction context can tell it to re-read them. WHICH
// argument held the file is the tool's own declaration (`path_arg`), never a tool
// name known here.
function recentWorkingFiles(events, cap = 6) {
  const out = [];
  const seen = new Set();
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const ev = events[at];
    if (!ev || ev.type !== "tool_call" || !ev.path_arg) continue;
    let args;
    try {
      args = JSON.parse(ev.arguments || "{}");
    } catch (e) {
      continue;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    const path = args[ev.path_arg];
    if (typeof path === "string" && path && !seen.has(path)) {
      seen.add(path);
      out.push(path);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// The system prompt, in reading order: the base contract, the session's mode, the
// installed components' own words about their own tools, this host's shell
// dialect, and — last — where this project's memory lives. The order is the
// contract (the model reads the anchor after the rules), so every section is
// appended in one place.
function systemPrompt(log, config, options = {}) {
  const workspace = options.workspace || null;
  const components = options.components || "";
  const render = options.render;

  let system = render("system.md", {});
  if (config && config.mode === "chat") {
    // read-only contract: tell the model before it attempts a write
    system += `\n\n${render("mode_chat.md", {})}`;
  } else if (config && config.mode === "work") {
    // work contract: announce full access (mirror of chat mode)
    system += `\n\n${render("mode_work.md", {})}`;
  }
  if (components) {
    // the components' own words about their own tools — assembled by the tool
    // layer, which knows what is installed and drivable. Placing it here (and
    // naming no tool) is what keeps the prompt from describing tools that are gone.
    system += `\n\n${components}`;
  }
  if (workspace && typeof workspace.execShell === "function") {
    // the shell the model's commands will execute under: a POSIX far side (which
    // is what deployment B always is) adds nothing — zero prompt diff — while a
    // Windows host is announced up front so the first command already speaks the
    // right dialect.
    const shell = workspace.execShell();
    const name = shell && shell.name ? String(shell.name) : "posix";
    if (name === "bash") system += `\n\n${render("env_windows_bash.md", {})}`;
    else if (name === "cmd") system += `\n\n${render("env_windows_cmd.md", {})}`;
  }
  if (log && log.path) {
    // The project's memory, stated last: this project's whole log is one file,
    // the model only holds the part since the last compaction, and two host tools
    // read the rest of it. Only a REAL project file gets this: the in-memory
    // scratch log a test or a project-less session uses has no path, and a prompt
    // must not promise a reader with nothing behind it.
    const bytes = typeof log.fileBytes === "function" ? log.fileBytes() : log.fileBytes;
    system += `\n\n${render("recall.md", { name: basename(log.path), size: sizeText(bytes) })}`;
  }
  return system;
}

// Derive model messages from the event log, applying the compaction head.
//
// `log` is the session's own project log and contributes the anchor at the end of
// the system prompt: which file this project's memory lives in and how big it is
// (`recall.md`), so the model knows there IS an older log to search and where. The
// anchor comes from the log itself rather than a second store, because the log is
// the whole of it. `workspace` contributes the local-environment hint (which shell
// commands speak on this host); `components` contributes the fragments the
// installed components carry about their own tools, so no tool name in the prompt
// can drift from what is installed. Tool output is not folded here; it accumulates
// until compaction.
function deriveMessages(log, config, task, options = {}) {
  const workspace = options.workspace || null;
  const components = options.components || "";
  const render = options.render;
  if (typeof render !== "function") {
    throw new TypeError("deriveMessages: options.render(name, vars) is required");
  }

  const fullEvents = log.events();
  // index 0 may be the current run's task, which task.md re-injects. But in a
  // CONTINUED session (a new run on the same project log) index 0 is the
  // project's FIRST user message — a real requirement — so drop it only when it IS
  // the current task; otherwise every follow-up message would erase the original ask.
  const first = fullEvents.length ? fullEvents[0] : null;
  const rawTask = first && first.type === "user_message" ? first : null;
  let events = fullEvents;
  const headMsgs = [];

  // the newest compaction summary is the head; only events after it are the window
  let compactionAt = -1;
  for (let at = fullEvents.length - 1; at >= 0; at -= 1) {
    if (fullEvents[at].type === "compaction") {
      compactionAt = at;
      break;
    }
  }
  if (compactionAt >= 0) {
    const compaction = fullEvents[compactionAt];
    headMsgs.push({
      role: "user",
      content: render("compaction_head.md", { summary: compaction.summary }),
    });
    // slice to the last summary: summarized history never re-enters the context
    const tail = fullEvents.slice(compactionAt + 1);
    const files = recentWorkingFiles(tail);
    if (files.length) {
      // compacted-away files: the model must re-read them before editing
      headMsgs.push({
        role: "user",
        content: render("compaction_files.md", { files: files.join(", ") }),
      });
    }
    events = tail;
  }
  if (rawTask && events.length && events[0] === rawTask && rawTask.content === task) {
    events = events.slice(1);
  }

  const msgs = toMessages(events);

  return [
    { role: "system", content: systemPrompt(log, config, { workspace, components, render }) },
    { role: "user", content: render("task.md", { task }) },
    ...headMsgs,
    ...msgs,
  ];
}

// ---- termination (core/terminate.py) -------------------------------------

// Termination is natural — a reply with no tool call and some text is done. The
// two guards here are the safety nets: a turn budget, and a doom loop (N
// consecutive identical calls WITH identical results => warn once, then abort).

// Value equality for one recorded call: name, arguments AND result. Python's
// tuples compare by value; JS arrays compare by reference.
function sameCall(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function createTerminator(config) {
  const limit = Math.trunc(number(config, ["doomLoopLimit", "doom_loop_limit"], DEFAULTS.doomLoopLimit));
  const maxTurns = Math.trunc(number(config, ["maxTurns", "max_turns"], DEFAULTS.maxTurns));
  let lastCalls = []; // [name, argsRepr, resultContent]
  let warned = false;
  let doomCall = null; // [name, argsRepr] the warning is about

  // Pre-execution: true when this exact call repeats a WARNED doom call. Asked
  // before the tool runs, so an escalating call is never executed again.
  function shouldEscalate(name, argsRepr) {
    return Boolean(warned) && Boolean(doomCall) && doomCall[0] === name && doomCall[1] === argsRepr;
  }

  // Record a call and its result; return "warn" on the FIRST doom detection.
  //
  // A doom loop is N consecutive identical calls: same name, same arguments AND
  // the same result content. Identical calls whose results change (polling, a
  // flaky test) are progress, not a loop — they never trigger. The first
  // detection arms escalation for that exact call and the caller feeds the
  // warning back. A DIFFERENT call forgives the warning (the model moved on), so a
  // later legitimate use of the same tool starts a fresh cycle instead of
  // aborting an old one.
  function recordCall(name, argsRepr, resultContent) {
    if (shouldEscalate(name, argsRepr)) return "escalate";
    if (warned) {
      // the model moved on: forgive the warning, tracking resumes fresh
      warned = false;
      doomCall = null;
    }
    lastCalls.push([name, argsRepr, resultContent]);
    if (lastCalls.length > limit) lastCalls.shift();
    // `every` on an EMPTY window is true, which is Python's `all(...)` on an empty
    // list: a doom_loop_limit of 0 warns on the very first call. Frozen.
    // The comparison is element-wise: Python compares TUPLES by value, so a JS
    // array identity check (`call === lastCalls[0]`) would never fire above one.
    if (lastCalls.length === limit && lastCalls.every((call) => sameCall(call, lastCalls[0]))) {
      warned = true;
      doomCall = [name, argsRepr];
      lastCalls = []; // the warning resets the window
      return "warn";
    }
    return "";
  }

  // maxTurns 0 means no limit (compaction keeps long runs going)
  function checkTurnBudget(turn) {
    return maxTurns > 0 && turn > maxTurns;
  }

  return { shouldEscalate, recordCall, checkTurnBudget };
}

// ---- compaction (core/compaction.py) -------------------------------------

// Roll the current window into a summary. Best-effort: `compact()` resolves false
// when nothing was compacted (nothing new since the last compaction, or the
// summary call failed) so the loop never spins on a no-op.
//
// Byte arithmetic throughout: the window and the window-usage comparison are exact
// bytes — no token estimation anywhere. The window is [cprStart, fileEnd):
// compaction summarizes the WHOLE current window (already resident in the log —
// zero disk reads), appends the new compaction event, and slides cprStart to that
// line's start (one in-place header write). The window then collapses to the new
// summary, so summarized history can never re-enter the context.
function createCompactor(options = {}) {
  const config = options.config || {};
  const log = options.log;
  const llm = options.llm;
  const render = options.render;
  const sink = typeof options.sink === "function" ? options.sink : null;
  const cancel = options.cancel || null;
  if (!log || typeof log.append !== "function" || typeof log.items !== "function") {
    throw new TypeError("createCompactor needs the session log (items/append/cprStart/setCprStart)");
  }
  if (!llm || typeof llm.stream !== "function") {
    throw new TypeError("createCompactor needs llm.stream(messages, {tools, cancel})");
  }
  if (typeof render !== "function") {
    throw new TypeError("createCompactor: options.render(name, vars) is required");
  }
  const windowBytes = Math.max(
    0,
    number(config, ["contextWindowBytes", "llm_context_window_bytes"], DEFAULTS.contextWindowBytes)
  );

  // Broadcast in-flight compaction progress; never fatal. A `note` overrides the
  // live paragraph (e.g. the summary stream dropped and is being retried) so the
  // UI never shows a frozen block.
  function report(chars, extra = {}) {
    if (!sink) return;
    try {
      sink(
        eventFromDict({
          type: "compaction_delta",
          chars,
          done: Boolean(extra.done),
          note: extra.note || "",
        })
      );
    } catch (e) {
      // subscriber failure is non-fatal
    }
  }

  // True when the current window fills the model window: pure byte comparison,
  // O(1) — no token estimation, no per-event walk.
  function shouldCompact() {
    const bytes = typeof log.windowBytes === "function" ? log.windowBytes() : log.windowBytes;
    return Number(bytes) >= windowBytes;
  }

  function previousSummary() {
    const comp = typeof log.lastCompaction === "function" ? log.lastCompaction() : null;
    return comp && comp.summary ? comp.summary : "";
  }

  // Compact transcript of the window: the summarizer's whole input. There is no
  // length cap and nothing is elided; what tells the summarizer this is someone
  // else's session is the prompt's framing. The projection itself is `eventText` —
  // the same one a session's own reader shows the model — so what the summary is
  // made of and what a later session can look up are one rendering of one log. The
  // only cut is per event: one tool result is trimmed, so a single huge read cannot
  // drown the rest of the window.
  function serialize(events) {
    const lines = [];
    for (const ev of events) {
      if (!TRANSCRIPT.has(ev && ev.type)) continue; // a final/compaction line is not the conversation
      const text = eventText(ev, ev.type === "tool_result" ? 500 : null);
      if (text) lines.push(text);
    }
    return lines.join("\n");
  }

  async function summarize(history, previous) {
    const prompt = render("compaction.md", {
      history,
      previous_summary: previous || "(none)",
    });
    const parts = [];
    let chars = 0;
    let reported = 0;
    for await (const ev of llm.stream([{ role: "user", content: prompt }], { tools: null, cancel })) {
      // stop must interrupt the summary call, not just the main turn
      if (isSet(cancel)) return { summary: "", chars };
      if (ev.type === "retry") {
        // transport hiccup: the client is reconnecting with backoff — mirror the
        // notice into the live compaction block instead of letting it sit
        // silently. discard=true means the dead attempt had already streamed part
        // of the summary: no byte of that is part of the summary, so it goes and
        // the counter restarts at 0.
        if (ev.discard) {
          parts.length = 0;
          chars = 0;
          reported = 0;
        }
        report(chars, { note: ev.message || "" });
        continue;
      }
      if (ev.type === "text") {
        parts.push(ev.delta);
        chars += String(ev.delta).length;
        // throttle: ~every 200 chars is plenty for a live counter
        if (chars - reported >= 200) {
          reported = chars;
          report(chars);
        }
      } else if (ev.type === "finish") {
        break;
      }
    }
    return { summary: parts.join("").trim(), chars };
  }

  async function compact() {
    try {
      if (isSet(cancel)) return false; // stop requested: don't start a long summary
      const cprStart = Number(log.cprStart) || 0;
      // the window: resident events at/after cprStart (before it is already summed)
      const window = log
        .items()
        .filter((pair) => pair[0] >= cprStart)
        .map((pair) => pair[1]);
      // nothing new since the last compaction: never re-summarize the same head
      if (window.length <= 1) return false;
      report(0); // long call: announce start before the first token lands
      const summarized = await summarize(serialize(window), previousSummary());
      if (!summarized.summary) {
        report(summarized.chars, { done: true });
        return false;
      }
      await log.append(eventFromDict({ type: "compaction", summary: summarized.summary }));
      // slide the window to the new summary line's start (header write)
      const items = log.items();
      await log.setCprStart(items[items.length - 1][0]);
      return true;
    } catch (e) {
      // a Stop that landed mid-summary reads as a quiet bail, not a failure
      if (isSet(cancel)) {
        report(0, { done: true });
        return false;
      }
      // compaction must never kill the run; report it and let the loop continue
      // with the messages it already derived
      process.stderr.write(`[clutch] compaction failed: ${(e && e.message) || e}\n`);
      report(0, { done: true });
      return false;
    }
  }

  return { shouldCompact, compact };
}

// ---- the run loop (loop.py) ----------------------------------------------

// Shared by the loop and its test double: an LlmError is the client's own error
// (llm.js sets both the name and a code); anything else is a bug and must escape.
function isLlmError(error) {
  return Boolean(error) && (error.name === "LlmError" || (error.constructor && error.constructor.name === "LlmError"));
}

// One tool result in the one shape every producer answers with
// (`agent/tools/envelope.py`): what the model reads, whether it failed, what
// changed. A producer that forgot a field gets the default, never `undefined`.
function envelope(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("registry.execute must return an envelope {content, error, diff}");
  }
  return {
    content: String(result.content === undefined || result.content === null ? "" : result.content),
    error: Boolean(result.error),
    diff: String(result.diff === undefined || result.diff === null ? "" : result.diff),
  };
}

// A run: one task in, one final event out, and the whole turn-by-turn record in
// between. Everything it emits goes through `_emit`, which appends first and hands
// the SAME event back — that is how a caller reads what only the log's append
// knows (the durable offset), and why the user task's offset can open the
// workspace's rollback checkpoint at the number the UI is shown.
function createAgent(options = {}) {
  const llm = options.llm;
  const registry = options.registry;
  const workspace = options.workspace;
  const config = options.config || {};
  const render = options.render;
  const sink = typeof options.sink === "function" ? options.sink : null;
  const cancel = options.cancel || null;
  const gate = options.gate || null;
  const components = options.components ? String(options.components) : "";

  if (!llm || typeof llm.stream !== "function") {
    throw new TypeError("createAgent needs llm.stream(messages, {tools, cancel})");
  }
  if (typeof render !== "function") {
    throw new TypeError("createAgent: render(name, vars) is required");
  }
  if (!registry || typeof registry.schemas !== "function" || typeof registry.execute !== "function") {
    throw new TypeError("createAgent needs the tool registry (schemas/ui/pathArg/access/accessArg/execute)");
  }
  for (const method of ["ui", "pathArg", "access", "accessArg"]) {
    if (typeof registry[method] !== "function") {
      throw new TypeError(`createAgent: the registry must answer ${method}() — the loop names no tool itself`);
    }
  }
  if (!workspace || typeof workspace.beginTurn !== "function" || typeof workspace.clearAllowed !== "function") {
    throw new TypeError("createAgent needs the workspace (beginTurn/clearAllowed)");
  }

  // the log is optional: an in-memory one is the project-less session's default
  const log = options.log || LazyEventLog.memory();
  const terminator = createTerminator(config);
  const compactor = createCompactor({ config, log, llm, render, sink, cancel });

  const abortOnDoomLoop = bool(config, ["abortOnDoomLoop", "abort_on_doom_loop"], DEFAULTS.abortOnDoomLoop);
  const maxTurns = Math.trunc(number(config, ["maxTurns", "max_turns"], DEFAULTS.maxTurns));

  // Append one event and hand it back. The log stamps a durable event with its own
  // offset (clc.js), and the sink is isolated: a failing subscriber must not kill
  // the agent.
  async function emit(event) {
    const appended = await log.append(event);
    const record = appended || event;
    if (sink) {
      try {
        sink(record);
      } catch (e) {
        process.stderr.write(`[clutch] sink error: ${record.type}\n`);
      }
    }
    return record;
  }

  async function finish(status, summary) {
    await emit(eventFromDict({ type: "final", status, summary }));
    await emit(eventFromDict({ type: "state_update", value: status === "error" ? "error" : "finished" }));
    return status !== "completed" ? "ABORTED" : summary;
  }

  // Stream one LLM turn; emit incremental reasoning/text/tool-call events.
  // Resolves {content, toolCalls: [{id, name, arguments}], finishReason, reasoning}.
  async function llmCall(msgs) {
    const contentParts = [];
    const reasoningParts = [];
    const toolAccum = new Map(); // index -> {id, name, args}
    let finishReason = "stop";

    try {
      for await (const ev of llm.stream(msgs, { tools: registry.schemas(), cancel })) {
        // abort mid-stream: check the flag between chunks
        if (isSet(cancel)) break;
        if (ev.type === "reasoning") {
          reasoningParts.push(ev.delta);
          await emit(eventFromDict({ type: "reasoning_delta", content: ev.delta }));
        } else if (ev.type === "text") {
          contentParts.push(ev.delta);
          // incremental text: the UI accumulates + re-renders markdown
          await emit(eventFromDict({ type: "text_delta", content: ev.delta }));
        } else if (ev.type === "tool_call_start") {
          if (!toolAccum.has(ev.index)) {
            toolAccum.set(ev.index, { id: ev.id, name: ev.name, args: "" });
          }
          // live tool-call row: the name arrives first, the args stream after
          await emit(
            eventFromDict({
              type: "tool_call_delta",
              tool_call_id: ev.id,
              name: ev.name,
              delta: "",
              ui: registry.ui(ev.name),
            })
          );
        } else if (ev.type === "tool_call_delta") {
          if (!toolAccum.has(ev.index)) toolAccum.set(ev.index, { id: "", name: "", args: "" });
          const entry = toolAccum.get(ev.index);
          entry.args += ev.delta;
          // stream args so the UI shows the call as it is generated
          await emit(
            eventFromDict({ type: "tool_call_delta", tool_call_id: entry.id, name: "", delta: ev.delta })
          );
        } else if (ev.type === "retry") {
          // Transient notice: an attempt failed (network drop / read timeout) and
          // the client is reconnecting with backoff — live UI display only, never
          // durable. discard=true means the dead attempt had ALREADY streamed part
          // of this turn: those deltas live in the view, not in the log, so clearing
          // the accumulators here is what keeps the retried answer from being
          // appended to the dead attempt's half-sentence.
          if (ev.discard) {
            contentParts.length = 0;
            reasoningParts.length = 0;
            toolAccum.clear();
          }
          await emit(
            eventFromDict({
              type: "llm_retry",
              attempt: ev.attempt === undefined ? 0 : ev.attempt,
              max_retries: ev.max === undefined ? 0 : ev.max,
              discard: Boolean(ev.discard),
              message: ev.message === undefined ? "" : ev.message,
            })
          );
        } else if (ev.type === "finish") {
          finishReason = ev.reason;
          return {
            content: contentParts.join(""),
            toolCalls: [...toolAccum.values()].map((entry) => ({
              id: entry.id,
              name: entry.name,
              arguments: entry.args,
            })),
            finishReason,
            reasoning: reasoningParts.join(""),
          };
        }
      }
    } catch (e) {
      if (!isLlmError(e)) throw e; // a non-LlmError here is a genuine bug
      if (e.code === "cancelled") {
        // Stop closed the connection mid-read: fall through to the same partial
        // return a between-chunk break produces; run() turns it into the aborted
        // final at the top of the next iteration
      } else if (e.code === "context_window_exceeded") {
        throw contextWindowError(e.message);
      } else {
        throw new AgentError(e.code || "agent_error", e.message || String(e));
      }
    }
    return {
      content: contentParts.join(""),
      toolCalls: [],
      finishReason,
      reasoning: reasoningParts.join(""),
    };
  }

  // Parse args, check permission, then run the tool; denials feed an error back.
  async function executeTool(ev) {
    let args;
    try {
      args = parseArguments(ev.arguments);
    } catch (e) {
      if (e instanceof ParseError) return { content: `ERROR: ${e.message}`, error: true, diff: "" };
      throw e;
    }
    if (gate) {
      try {
        // the policy comes from the tool's own declaration: the loop only reports
        // what the registry says this tool is subject to — the access word and the
        // argument that word judges — and names no tool itself.
        //
        // A refusal is an error with `code: "permission_required"` and the sentence
        // for the model in `.reason` (`core/permission.py: PermissionRequired`).
        gate.require(ev.name, ev.arguments, workspace, registry.access(ev.name), registry.accessArg(ev.name));
      } catch (e) {
        if (e && e.code === "permission_required") {
          return { content: `ERROR: ${e.reason}`, error: true, diff: "" };
        }
        throw e;
      }
    }
    try {
      // Stop reaches the tool: run_command polls this flag while its command is in
      // flight and kills the tree the moment it is set
      return envelope(await registry.execute(workspace, config, ev.name, args, { cancel }));
    } finally {
      // a user-approved escape is scoped to the one call it was granted for
      workspace.clearAllowed();
    }
  }

  // One assistant turn that asked for tools: record the turn script, hand every
  // call to the tool face, and record each result. Returns null when the batch ran
  // out normally (the loop takes another turn), or `{abort: summary}` when the
  // doom guard ended the run.
  async function runToolBatch(content, reasoning, toolCalls) {
    const callEvents = toolCalls.map((call) =>
      eventFromDict({
        type: "tool_call",
        name: call.name,
        arguments: call.arguments,
        tool_call_id: call.id,
        ui: registry.ui(call.name),
        path_arg: registry.pathArg(call.name),
      })
    );
    // record the assistant turn BEFORE the tool-call events, so a stored
    // session replays as text -> tools -> results
    await emit(
      eventFromDict({
        type: "assistant_message",
        content,
        tool_calls: callEvents.map((ev) => ({
          id: ev.tool_call_id,
          name: ev.name,
          arguments: ev.arguments,
        })),
        reasoning,
      })
    );
    for (const ev of callEvents) await emit(ev);

    for (const ev of callEvents) {
      let result;
      // after a doom warning, repeating the exact same call escalates
      if (terminator.shouldEscalate(ev.name, ev.arguments)) {
        if (abortOnDoomLoop) return { abort: render("doom_loop.md", { tool: ev.name }) };
        result = { content: render("doom_loop.md", { tool: ev.name }), error: true, diff: "" };
      } else {
        result = await executeTool(ev);
        // result-aware doom check: identical call AND identical result; the tool
        // runs first so its output is known
        const status = terminator.recordCall(ev.name, ev.arguments, result.content);
        if (status === "warn") {
          // first detection: keep the real result, append the warning, and let
          // the model course-correct
          result = {
            content: `${result.content}\n\n${render("doom_loop.md", { tool: ev.name })}`,
            error: true,
            diff: result.diff,
          };
        }
      }
      await emit(
        eventFromDict({
          type: "tool_result",
          tool_call_id: ev.tool_call_id,
          content: result.content,
          is_error: result.error,
          diff: result.diff,
        })
      );
    }
    return null;
  }

  async function run(task) {
    await emit(eventFromDict({ type: "state_update", value: "running" }));
    // The task's own log offset opens the workspace's rollback checkpoint: every
    // file write from here until the next task is journaled under it, which is
    // what makes "roll back to this message" undoable. The offset is the one the
    // log stamped on the record just appended — the same number the SSE frame
    // carries — and the fallback keeps a bare 0 for a log that stamps nothing.
    const opened = await emit(eventFromDict({ type: "user_message", content: String(task) }));
    const offset = Number(opened && opened.logOffset);
    workspace.beginTurn(Number.isFinite(offset) ? Math.trunc(offset) : 0);

    let turn = 0;
    try {
      for (;;) {
        if (isSet(cancel)) return await finish("aborted", render("cancelled.md", {}));
        turn += 1;
        // optional safety net; off by default (maxTurns 0 means no limit)
        if (terminator.checkTurnBudget(turn)) {
          return await finish("aborted", render("budget_exceeded.md", { max_turns: maxTurns }));
        }
        // derive once per turn; the compaction check and the LLM call share it
        const msgs = deriveMessages(log, config, task, { workspace, components, render });
        // near the window: compact and continue instead of dropping/aborting
        if (compactor.shouldCompact()) {
          if (await compactor.compact()) continue; // log changed; re-derive next turn
          // failed compaction: the derived messages are still valid
        }
        await emit(eventFromDict({ type: "step_start" }));

        let turnResult;
        try {
          turnResult = await llmCall(msgs);
        } catch (e) {
          if (e instanceof AgentError && e.code === "context_window_exceeded") {
            // last resort: force a compaction and retry once
            if (await compactor.compact()) continue;
          }
          throw e;
        }
        const { content, toolCalls, finishReason, reasoning } = turnResult;
        // partial turn left by Stop: not a completed turn — abort
        if (isSet(cancel)) return await finish("aborted", render("cancelled.md", {}));

        // max-tokens truncation: drop incomplete tool calls, ask to be concise
        if (finishReason === "length") {
          await emit(eventFromDict({ type: "user_message", content: render("max_tokens.md", {}) }));
          continue;
        }

        if (toolCalls.length) {
          const halted = await runToolBatch(content, reasoning, toolCalls);
          if (halted) return await finish("aborted", halted.abort);
          continue;
        }

        // no tool call: natural finish (an empty reply is not one)
        await emit(eventFromDict({ type: "assistant_message", content, reasoning }));
        if (!String(content).trim()) {
          // empty reply is NOT a completion: feed it back as an error
          await emit(eventFromDict({ type: "user_message", content: render("empty_response.md", {}) }));
          continue;
        }
        return await finish("completed", content);
      }
    } catch (e) {
      // fatal LLM/context failures terminate gracefully; a non-AgentError is a bug
      if (e instanceof AgentError) return await finish("error", String(e));
      throw e;
    }
  }

  return { run, log, terminator, compactor, components };
}

module.exports = {
  // the errors a caller can act on
  AgentError,
  ParseError,
  // the pieces, exported because they are pure functions worth testing alone
  parseArguments,
  eventText,
  toMessages,
  repairDangling,
  deriveMessages,
  createTerminator,
  createCompactor,
  createAgent,
  // helpers the tests and the settings UI assert against
  sizeText,
  fixed1,
  TRANSCRIPT,
  DEFAULTS,
};
