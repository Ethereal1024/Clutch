"use strict";

// Session API base: 8890 is the supervisor's lifecycle port, never a real backend.
let DEFAULT_BASE = "http://127.0.0.1:8890";
let API_BASE = null; // resolved in resolveApiBase() before the app starts

async function resolveApiBase() {
  if (window.clutchApi && window.clutchApi.baseUrl) {
    // null/8890 = session not claimed yet (supervisor mid-spawn); retry
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const b = await window.clutchApi.baseUrl(); // IPC: this window's session port
        const clean = b ? String(b).replace(/\/+$/, "") : "";
        if (clean && clean !== "http://127.0.0.1:8890") {
          API_BASE = clean;
          DEFAULT_BASE = clean;
          return clean;
        }
      } catch {
        /* preload unavailable — plain-browser debugging */
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  // Still unresolved: leave null. 8890 is the supervisor's port (no session
  // API); the main process announces the real URL via backend:base-changed.
  return API_BASE; // null
}

const $ = (s) => document.querySelector(s);

// A request needs a resolved base. Until the supervisor hands this window its
// session port API_BASE is null, and `null + "/api/host"` is not an error — it
// is the relative URL "null/api/host", which resolves against whatever origin
// served the UI and comes back a stray 404 (or, over file://, a network error
// nobody can act on). Refuse before the request instead; the error is shaped
// like an unreachable backend (`.code`, no `.status`), the path every caller
// already has for "could not talk to it".
function noBackend() {
  const e = new Error("no backend URL yet — the session is still starting");
  e.code = "no_backend";
  return e;
}

// single JSON request path: base URL, Content-Type header and error unwrapping
// live here instead of being re-written at every call site. Errors are thrown
// as `Error` with `.status` (HTTP status, absent for network failures — callers
// use it to tell "backend said no" from "backend unreachable") and `.code`
// (server error code, e.g. project_open_conflict). Throws on non-2xx and on a
// 200 body that carries an error (only /api/fs/list does that).
async function apiFetch(path, { method = "GET", body, base = API_BASE, timeout = 30000 } = {}) {
  if (!base) throw noBackend();
  // bounded: a hung backend must surface as a failed button, not a forever-
  // pending one (AbortError carries no .status -> callers treat it as
  // "backend unreachable", the same path as a refused connection)
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(base + path, body === undefined ? { method, signal: ctl.signal } : {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = new Error(data.error || r.status);
    e.code = data.code || null;
    e.status = r.status;
    throw e;
  }
  return data;
}

const els = {
  task: $("#task-input"),
  run: $("#run-btn"),
  mode: $("#mode-btn"),
  trust: $("#trust-btn"),
  status: $("#status"),
  stream: $("#stream"),
  tree: $("#tree"),
  workspace: $("#workspace-path"),
  projectLabel: $("#project-label"),
};

// agent mode for the next run: "work" (full tools) | "chat" (read-only); sticky per session
let agentMode = localStorage.getItem("clutch_mode") || "work";

// Android shell (user report #2): the phone has no local backend of its own —
// the agent runs behind the SSH tunnel, so every "Local" affordance is dead
// weight there. UA sniff, no bridge plumbing: the WebView UA always carries
// the Android token, Electron/desktop UAs never do.
const IS_ANDROID = /\bAndroid\b/.test(navigator.userAgent || "");

function setMode(mode) {
  agentMode = mode === "chat" ? "chat" : "work";
  localStorage.setItem("clutch_mode", agentMode);
  els.mode.textContent = agentMode;
  els.mode.classList.toggle("chat-mode", agentMode === "chat");
  els.mode.title = agentMode === "chat"
    ? "chat: read-only analysis · click for work mode (full access). Applies to the next run."
    : "work: full access · click for chat mode (read-only analysis). Applies to the next run.";
}

let busy = false;
const stream = $("#stream");
const eventsEl = document.getElementById("events");
const jumpBottom = $("#jump-bottom");

// how far from the bottom the view counts as "following the stream"
const JUMP_BOTTOM_GAP = 80;

function nearBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < JUMP_BOTTOM_GAP;
}

// ↓ button visibility mirrors the latch; all latch paths report through here
function setJumpVisible(visible) {
  jumpBottom.classList.toggle("hidden", !visible);
}

// Latched tail-follow: reaching the bottom (or ↓) pins the view; only a user's
// upward scroll breaks the latch (the ↓ button returns to the tail).
let followTail = true;
let lastScrollTop = 0;

let gliding = false;
let glideRaf = 0;

function autoScroll(force) {
  if (stream.classList.contains("loading")) return;
  if (force) {
    // User-initiated jump (message send, ↓, Cmd/Ctrl+Down): tracked = instant pin,
    // untracked = the one smooth glide that re-latches on arrival.
    if (followTail) {
      if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
      gliding = false;
      stream.scrollTop = stream.scrollHeight;
      setJumpVisible(false);
    } else {
      glideToBottom();
    }
    return;
  }
  if (followTail) {
    // tracked: instant pin — never during a user jump-glide (untracked ↓)
    if (gliding) return;
    stream.scrollTop = stream.scrollHeight;
    setJumpVisible(false);
  } else {
    // untracked: content growth never moves the view; only the ↓ glide may
    setJumpVisible(true);
  }
}

// ---- jump-to-bottom glide (user-initiated only) ----
// scrollTo glides to the tail captured at call time; a rAF poll detects the
// landing and re-pins to absorb growth that arrived mid-glide.
function glideToBottom() {
  if (stream.classList.contains("loading")) return;
  cancelAnimationFrame(glideRaf);
  const target = stream.scrollHeight;
  if (stream.scrollTop >= target - 1) {
    // already at the tail: land straight into the latch
    gliding = false;
    followTail = true;
    setJumpVisible(false);
    return;
  }
  gliding = true;
  if (reducedMotion()) {
    stream.scrollTop = stream.scrollHeight;
    gliding = false;
    followTail = true;
    setJumpVisible(false);
    return;
  }
  stream.scrollTo({ top: target, behavior: "smooth" });
  const finish = () => {
    const bottom = stream.scrollHeight - stream.clientHeight;
    if (!gliding || Math.abs(stream.scrollTop - target) < 2 || Math.abs(stream.scrollTop - bottom) < 2) {
      gliding = false;
      // landed (or clamped to a new bottom): re-latch
      followTail = true;
      setJumpVisible(false);
      if (!stream.classList.contains("loading")) {
        stream.scrollTop = stream.scrollHeight; // absorb growth that arrived mid-glide
      }
      return;
    }
    glideRaf = requestAnimationFrame(finish);
  };
  glideRaf = requestAnimationFrame(finish);
}

// Async layout growth (fonts, images, math) can land after autoScroll: watch the
// CONTENT's height (never the viewport) and re-pin while latched.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (followTail && !stream.classList.contains("loading")) autoScroll();
  }).observe(eventsEl);
}

jumpBottom.addEventListener("click", () => {
  // autoScroll(force) decides: instant pin when tracked, smooth glide when untracked
  autoScroll(true);
});
// Cmd/Ctrl+Down anywhere: same jump-to-tail as the ↓ button
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
    autoScroll(true);
  }
});
let prevClientH = stream.clientHeight;
let prevScrollH = stream.scrollHeight;
// ignore latch changes ~120ms after the input box resizes: the clamp scroll
// event can fire before the shrunken viewport is observable
let suppressLatchUntil = 0;
stream.addEventListener("scroll", (e) => {
  // Only the user's own gestures update the latch. Programmatic scrolls fire
  // isTrusted=false and never touch it; a passive clamp (viewport or content
  // shrink) fires a TRUSTED scroll — ignore it via the fingerprints above.
  const cur = stream.scrollTop;
  if (!e.isTrusted) {
    lastScrollTop = cur;
    // refresh baselines on programmatic pins so clamp fingerprints never compare
    // against a stale baseline
    prevClientH = stream.clientHeight;
    prevScrollH = stream.scrollHeight;
    return;
  }
  // viewport resize / content shrink clamps fire trusted scrolls; none is a user
  // gesture, so they must neither cancel a glide nor drop the latch
  const viewportChanged = stream.clientHeight !== prevClientH;
  prevClientH = stream.clientHeight;
  const scrollShrank = stream.scrollHeight < prevScrollH;
  prevScrollH = stream.scrollHeight;
  if (viewportChanged || scrollShrank || performance.now() < suppressLatchUntil) {
    lastScrollTop = cur;
    return;
  }
  // a real user gesture takes over from any in-flight jump glide
  if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
  gliding = false;
  // only a scroll away from the bottom is a user intent to leave the latch
  const up = cur < lastScrollTop && !nearBottom();
  if (up) {
    followTail = false;
  } else if (nearBottom()) followTail = true;
  lastScrollTop = cur;
  // the button is visible exactly when NOT latched
  setJumpVisible(!followTail);
}, { passive: true });

function setStatus(state) {
  els.status.className = "badge " + (state || "idle");
  els.status.textContent = state || "idle";
  busy = state === "running" || state === "waiting";
  // the run button doubles as Stop while a run is in progress
  els.run.textContent = busy ? "■ Stop" : "▶ Run";
  els.run.classList.toggle("stop-mode", busy);
  els.run.disabled = busy ? false : !currentProject;
  // the mode applies to the next run only: lock the toggle while busy
  els.mode.disabled = busy;
  els.mode.title = busy
    ? "A run is in progress; the mode applies to the next run."
    : "chat: read-only analysis · work: full access (write/edit/any command). Applies to the next run.";
}

// tracks the most recent agent text block (created by streaming text_delta)
let lastTextEl = null;
let lastTextContent = "";
// thinking (reasoning) block
let thinkingEl = null;
let thinkingContent = "";
let compactionEl = null; // live "compressing context" block (compaction_delta)
let retryNoteEl = null; // live "reconnecting…" chip (llm_retry), removed once the stream resumes

// map tool_call_id -> {name, args, ui} so a tool_result knows which tool
// produced it and how its component said it looks
const toolCalls = {};
// the block currently collecting consecutive tool_calls (for merging)
let toolGroupEl = null;
// tool_call_id -> owning block: results land next to their own call row
const toolCallGroups = new Map();

// ---- the component UI protocol (agent/tools/catalog.py) ---------------------
// The host renders tool events it did not design, so NO TOOL NAME appears in
// this file: every tool event carries the declaration its component made about
// how a call and its result are presented, and everything below reads that
// declaration. The vocabulary IS the abstraction of the forms this UI has
// always drawn — a declaration composes them; it may not remove one.
//
// The CALL ROW: the tool's own name as the chip (the row's title), the raw
// arguments one click away, and while the args stream the declaration's live
// preview body.
//   chip      "name" the row leads with the tool's own name; "none" it does
//             not (a row whose preview already says what the call is).
//   preview   the live body while the call is generated: "args" the raw
//             payload; "command" a `mark`ed shell line (default "$ "), which
//             is also what the args panel unwraps a command payload with;
//             "content" prints argument VALUES (`keys` in order, a leading
//             "-", "+" or "✎" printed as a mark before the value); "none" the
//             chip alone — a body too large to preview.
//
// The RESULT: `form` picks the shape — the one routing the renderer does, on
// a structural word, never on a tool's purpose; both shapes compose the same
// parts (label template, body, fold, highlight).
//   "row"     the result is a one-line collapsible row: `summary` filled from
//             the call ({argname} from the arguments, {lines} the result's
//             line count (… until the result lands), {name} the tool's own
//             name) as the label, the body folding under it. It lands beside
//             its call inside the block the calls collect in; a call that
//             collected nowhere (an older log page) shows the same row in a
//             quiet block of its own.
//   "block"   the default: a "result" block ("result ⚠" when the call failed —
//             the one verdict the host owns) — `header` as the label, the
//             body under it.
//   body      "text" the content, "code" a code panel, "diff" the unified
//             diff (the host's expand control past the fold threshold, and
//             the host's ↶ undo when it holds a snapshot), "none" nothing but
//             the status line.
//   highlight decoration on a code body: "path" highlights it by the call's
//             `path` argument.
//   chrome    extra block chrome: "accent" the header as the accent chip.
//
//   group     calls naming the same group collect into ONE dense block; a
//             row-form result lands there beside its call. A call that
//             declares no group is its own row and its result its own block
//             (a landing change must never be swallowed by the read-only
//             calls around it). The value is an opaque namespace: grouped by
//             equality, never interpreted.
//   collapse  "always" folded, "long" folded past RESULT_FOLD_LINES, "never"
//             whole (a block body's rest state).
//   mutates   the call may change the file tree (host-derived when undeclared).
//   undo      the host holds an undo record for this call (host-derived).
// The HOST's own default `ui` block (GET /api/host), fetched once at boot: the
// host's document (host.json) may override any constant below, and every event
// that carries no `ui` of its own then renders with what the host says, not
// what was compiled in. The constants stay as the fallback -- a host that
// predates the endpoint, or a fetch that fails -- so the renderer never waits
// on the network to draw a row.
let hostUiDefaults = null;
function uiDefaults() {
  return hostUiDefaults ? Object.assign({}, UI_DEFAULTS, hostUiDefaults) : UI_DEFAULTS;
}
const UI_DEFAULTS = {
  group: null,
  chip: "name",
  summary: "",
  preview: "args",
  header: "",
  form: "block",
  body: "text",
  collapse: "never",
  highlight: "",
  chrome: "",
  mutates: true,
  undo: false,
};
const CALL_BLOCK = "__calls__"; // the block calls that declared no group share
const RESULT_FOLD_LINES = 60; // "long": fold a body past this many lines

function uiOf(ev) {
  return Object.assign({}, uiDefaults(), (ev && ev.ui) || {});
}

// the declaration of the call a result belongs to: the tool_call event that
// produced it carries it, and a tool_result whose call is not in memory (an
// older log page) renders from its own copy
function uiOfResult(ev) {
  const call = toolCalls[ev.tool_call_id];
  if (call && call.ui) return Object.assign({}, uiDefaults(), call.ui);
  return uiOf(ev);
}

// A declaration's template filled from the call's arguments plus the two facts
// the renderer has: the tool's own name and how many lines came back (… while
// the result is still on its way — the row must not claim "0 lines" it does not
// know yet). `content === null` is "no result yet", "" is an empty one.
function templateText(tpl, name, args, content) {
  const lines = content === null || content === undefined ? "…" : String(content).split("\n").length;
  // a call that is still streaming has only its JSON text: parse it here, so a
  // caller may pass either the payload or what the model has sent so far
  if (typeof args === "string") {
    try { args = JSON.parse(args || "{}"); } catch (e) { args = {}; }
  }
  return String(tpl || "").replace(/\{([A-Za-z_]+)\}/g, (match, key) => {
    if (key === "name") return name;
    if (key === "lines") return String(lines);
    const v = args ? args[key] : undefined;
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

// the row's one-line label, and (through it) a result block's default header
// one argument out of a JSON payload that may still be arriving (hence invalid)
function partialArg(raw, key) {
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object" && p[key] !== undefined) {
      return typeof p[key] === "string" ? p[key] : JSON.stringify(p[key]);
    }
  } catch (e) {
    /* mid-stream: fall through to the tolerant scan */
  }
  const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(raw || "");
  if (!m) return null;
  return m[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// the live preview the declaration asks for, from arguments that may still be
// arriving. "content" prints argument VALUES: `keys` names which ones, in order,
// and a leading "-", "+" or "✎" on a key is a mark printed before its value.
// "command" prints the unwrapped command under its `mark` ("$ " by default) —
// the component's choice, not this file's.
function previewText(ui, name, raw) {
  const spec = ui.preview && typeof ui.preview === "object" ? ui.preview : { mode: ui.preview };
  const mode = spec.mode || "args";
  if (mode === "none") return "";
  if (mode === "command") {
    const cmd = extractCommand(raw);
    return cmd !== null ? (spec.mark || "$ ") + cmd : raw || "";
  }
  if (mode === "content" && spec.keys && spec.keys.length) {
    const parts = [];
    for (const key of spec.keys) {
      const mark = /^[-+✎]/.test(key) ? key[0] + " " : "";
      const value = partialArg(raw, mark ? key.slice(1) : key);
      if (value !== null) parts.push(mark + value);
    }
    if (parts.length) return parts.join("\n");
  }
  if (mode === "content") {
    // mid-stream before the first key landed: strip the JSON scaffolding so the
    // text still reads as what the model is writing
    return String(raw || "").replace(/^\{/, "").replace(/\}$/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return raw || ""; // "args"
}

// ensure the collection block for one group key exists
function ensureToolGroup(key) {
  if (!toolGroupEl || toolGroupEl.closed || toolGroupEl.key !== key) {
    toolGroupEl = {
      el: document.createElement("div"),
      ids: new Set(),
      key,
      closed: false,
    };
    toolGroupEl.el.className = "event tool_group";
    toolGroupEl.el.innerHTML = '<div class="hdr">tools</div>';
    (pageSink || eventsEl).appendChild(toolGroupEl.el);
  }
  return toolGroupEl;
}

// reserve a call row in its block: the declaration's group, or the generic call
// block when it declared none. Shared by the finished and streaming paths.
function toolGroupFor(id, ui) {
  const group = ensureToolGroup(ui.group || CALL_BLOCK);
  group.ids.add(id);
  toolCallGroups.set(id, group);
  return group;
}

// shared tool-row skeleton: the declaration's own part — the tool's own name
// as the row's chip (its title), unless the declaration asked for none — plus
// the caller's tail (the live preview body, then the args expander)
function makeToolRowBase(ui, name) {
  const row = document.createElement("div");
  row.className = "tool-row";
  if (ui.chip !== "none") {
    const chip = document.createElement("span");
    chip.className = "tool-name";
    chip.textContent = name;
    row.appendChild(chip);
  }
  return row;
}

// the raw arguments, one click away: the declaration decides how a call LOOKS,
// never what it is — a summary is not a substitute for the payload
function argsButton(raw, ui) {
  const btn = document.createElement("span");
  btn.className = "tool-args-btn";
  btn.textContent = "args ▸";
  btn.onclick = () => {
    const row = btn.parentElement;
    const existing = row.querySelector(".fold.args-fold");
    if (existing) {
      foldCollapse(existing, () => existing.remove());
      btn.textContent = "args ▸";
    } else {
      btn.textContent = "args ▾";
      const pre = document.createElement("pre");
      pre.className = "tool-args-detail";
      pre.textContent = argsDetail(ui, raw);
      const fold = wrapFold(pre);
      fold.classList.add("args-fold");
      row.appendChild(fold);
      foldExpand(fold);
    }
  };
  return btn;
}

// the payload as the args panel shows it: a command-shaped declaration gets its
// command unwrapped under its own prompt mark, everything else is pretty JSON
function argsDetail(ui, raw) {
  const spec = ui.preview && typeof ui.preview === "object" ? ui.preview : { mode: ui.preview };
  if (spec.mode === "command") {
    const cmd = extractCommand(raw);
    if (cmd !== null) return (spec.mark || "$ ") + cmd;
  }
  try { return JSON.stringify(JSON.parse(raw || "{}"), null, 1); } catch (e) { return raw || ""; }
}

// Pull a shell command out of a command-shaped args payload. The schema is
// {command: "..."} but models in the wild also double-encode the envelope
// ({"command": "{\"command\": \"ls\"}"}), nest it ({"command": {"command": "…"}})
// or send a bare JSON string ("ls -la"). Unwrap every such layer and return the
// plain command; null means "this payload is not a command" (caller shows JSON).
// Which tools are command-shaped is the declaration's business (preview:
// "command"), never this file's: no tool name appears here.
function extractCommand(txt) {
  let s = txt;
  for (let depth = 0; depth < 3; depth++) {
    let parsed;
    try { parsed = JSON.parse(s); }
    catch (e) { return typeof s === "string" && s !== txt ? s : null; }
    if (typeof parsed === "string") { s = parsed; continue; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.command === "string") { s = parsed.command; continue; }
      if (parsed.command && typeof parsed.command === "object" && !Array.isArray(parsed.command)) {
        s = JSON.stringify(parsed.command); continue; // re-stringify: the next pass unwraps it
      }
      return null; // JSON object without a usable command field
    }
    return null; // array / number / bool payload
  }
  return typeof s === "string" ? s : null;
}

// ask reasons must stay a reason: the args box below the header shows args_repr,
// so strip the legacy "... with args {...}" dump older backends still send
function permReason(reason) {
  return String(reason || "").replace(/\s+with args\b[\s\S]*$/, "");
}

// one tool_call row: the declaration's chip — the tool's own name leading the
// row — and the raw payload one click away; the call says what it is, its
// result speaks for the outcome
function makeToolRow(ev) {
  const row = makeToolRowBase(uiOf(ev), ev.name);
  row.appendChild(argsButton(ev.arguments, uiOf(ev)));
  return row;
}

// render one tool_call row; consecutive calls append to the same block
function addToolCallRow(ev) {
  const group = toolGroupFor(ev.tool_call_id, uiOf(ev));
  group.el.appendChild(makeToolRow(ev));
  autoScroll();
}

// one collapsible result row (toggle + label + hidden body): the declaration's
// summary as the label, whatever body it declares folding under it — the
// "row" form, composed entirely from the declaration
function buildResultRow(ui, call, result) {
  const summary = templateText(ui.summary, call.name, call.args || {}, result.content);
  const row = document.createElement("div");
  row.className = "result-row";
  const body = buildResultBody(ui, result, call.args || {});
  const full = body ? wrapFold(body) : null;
  // the toggle exists only when there is something to fold: a body the
  // declaration rendered empty must not leave a "▸" that opens nothing
  if (full) {
    const toggle = document.createElement("span");
    toggle.className = "fold-toggle";
    toggle.textContent = "▸";
    row.appendChild(toggle);
    row.onclick = () => {
      const wasHidden = toggleFold(full);
      toggle.textContent = wasHidden ? "▾" : "▸";
    };
  }
  const lbl = document.createElement("span");
  // same anti-overflow contract as the call chip's name rule (style.css): a
  // summary that embeds a deep path must break in place, never widen the stream
  lbl.className = "result-label";
  lbl.textContent = summary;
  row.appendChild(lbl);
  return { row, full };
}

// the row lands beside its call, in the block their calls collect in
function appendResultRow(group, ui, call, ev) {
  const { row, full } = buildResultRow(ui, call, ev);
  group.el.appendChild(row);
  if (full) group.el.appendChild(full);
  autoScroll();
}

// a row whose call row is gone (an older log page) shows the same collapsible
// row inside its own durable block
function buildResultRowBlock(ui, call, ev) {
  const wrap = document.createElement("div");
  wrap.className = "event tool_result" + (ev.is_error ? " error" : "") + " form-row";
  const hdr = document.createElement("div");
  hdr.className = "hdr";
  hdr.textContent = ev.is_error ? "result ⚠" : "result"; // the host's verdict
  wrap.appendChild(hdr);
  const { row, full } = buildResultRow(ui, call, ev);
  wrap.appendChild(row);
  if (full) wrap.appendChild(full);
  return wrap;
}

// A result that is its own block: the header is the declaration's own label
// (falling back to the summary it would wear in a group, then to the plain
// "result" the host shows for anything that says nothing), and the body is what
// the declaration says it is, chromed by the declaration's style.
function buildResultBlock(ui, name, args, result) {
  const wrap = document.createElement("div");
  wrap.className = "event tool_result" + (result.is_error ? " error" : "")
    + (ui.chrome ? " " + ui.chrome : "");
  const tpl = ui.header || ui.summary;
  const hdr = result.is_error ? "result ⚠" // the one verdict the host owns
    : tpl ? templateText(tpl, name, args, result.content) : "result";
  const head = document.createElement("div");
  head.className = "hdr";
  head.textContent = hdr; // a header is a label, never markup
  wrap.appendChild(head);
  const body = buildResultBody(ui, result, args);
  if (body) {
    if (ui.body === "diff" && result.diff) {
      // the diff pane: the component's one-line verdict over the diff it
      // returned. Only a REAL diff wears the note above it — when the diff is
      // what failed to arrive the verdict IS the body (drawn once, below)
      const note = document.createElement("div");
      note.className = "body md-plain";
      note.textContent = result.content; // the component's one-line verdict
      if ((result.content || "").trim()) wrap.appendChild(note);
      wrap.appendChild(body);
    } else if (foldAtRest(ui, result)) {
      const fold = wrapFold(body);
      const toggle = document.createElement("span");
      toggle.className = "fold-toggle";
      toggle.textContent = "▸";
      toggle.onclick = () => { toggle.textContent = toggleFold(fold) ? "▾" : "▸"; };
      wrap.appendChild(toggle);
      wrap.appendChild(fold);
    } else {
      wrap.appendChild(body);
    }
  }
  // a diff past the threshold gets the host's expand control; a diff is the one
  // body the host folds itself (its own CSS cap), not the declaration's fold
  if (ui.body === "diff" && body && (result.diff || "").split("\n").length > RESULT_FOLD_LINES) {
    body.classList.add("diff-collapsed");
    const expand = document.createElement("button");
    expand.className = "diff-expand";
    const setLabel = () => {
      expand.textContent = body.classList.contains("diff-collapsed") ? "Show full diff" : "Hide diff";
    };
    setLabel();
    expand.onclick = () => {
      if (body.classList.contains("diff-collapsed")) expandDiff(body);
      else collapseDiff(body);
      setLabel();
    };
    wrap.appendChild(expand);
  }
  // the host's per-file undo: offered exactly when it holds a record for this
  // call (the declaration that overwrote a path reached the host's snapshot)
  if (ui.undo && !result.is_error) {
    const undoBtn = document.createElement("button");
    undoBtn.className = "diff-expand undo-btn";
    undoBtn.textContent = "↶ undo";
    undoBtn.onclick = async () => {
      try {
        const data = await apiFetch("/api/workspace/revert", {
          method: "POST",
          body: { path: (args && args.path) || "" },
        });
        if (data && data.status === "ok") {
          undoBtn.textContent = "↶ undone";
          undoBtn.disabled = true;
          refreshTree();
        } else {
          undoBtn.textContent = "↶ no snapshot";
          undoBtn.disabled = true;
        }
      } catch (e) {
        // an HTTP rejection means the backend answered: no snapshot exists
        undoBtn.textContent = e.status ? "↶ no snapshot" : "↶ failed";
        undoBtn.disabled = true;
      }
    };
    wrap.appendChild(undoBtn);
  }
  return wrap;
}

// the result body node per the declaration: "text" the component's own content,
// "code" a code panel, "diff" the unified diff it returned, "none" nothing but
// the status line. A code panel takes the declared decoration ("path":
// highlighted by the call's path argument).
function buildResultBody(ui, result, args) {
  if (ui.body === "none") return null;
  if (ui.body === "diff") {
    // no diff to draw: the result's own message is the body. Every failure
    // returns diff "" with its reason in content, so returning null here left a
    // bare "result ⚠" — the reason gone, and nothing to unfold
    if (!result.diff) return (result.content || "").trim() ? plainBody(result.content) : null;
    return renderDiff(result.diff);
  }
  if (ui.body === "code") {
    const pre = document.createElement("pre");
    pre.className = "result-detail";
    pre.textContent = result.content || "";
    if (ui.highlight === "path") highlightPreByPath(pre, (args && args.path) || "");
    return pre;
  }
  return plainBody(result.content);
}

// the plain text body a "text" declaration draws (and the one a diff-shaped
// result falls back to when it returned no diff)
function plainBody(text) {
  const plain = document.createElement("div");
  plain.className = "body md-plain";
  plain.textContent = text || "";
  return plain;
}

// whether the declaration wants this body folded at rest
function foldAtRest(ui, result) {
  if (ui.collapse === "always") return true;
  if (ui.collapse !== "long") return false;
  // the text the body actually draws: a diff pane with a diff draws that, and a
  // diff pane without one (a failure) draws the result's own message
  const text = ui.body === "diff" ? result.diff || result.content || "" : result.content || "";
  return String(text).split("\n").length > RESULT_FOLD_LINES;
}

// live tool-call previews: callId -> {name, ui, text, row, body, group}; the
// declaration decides what the row shows while the call is generated
const streamRows = {};

function handleToolCallDelta(ev) {
  let st = streamRows[ev.tool_call_id];
  if (!st) {
    if (!ev.name) return; // the start delta carries the name
    const ui = uiOf(ev);
    const group = toolGroupFor(ev.tool_call_id, ui);
    st = streamRows[ev.tool_call_id] = { name: ev.name, ui, text: "", row: null, body: null, group };
    st.row = makeToolRowBase(ui, ev.name);
    st.row.classList.add("stream");
    if (ui.preview === "none" || (ui.preview && ui.preview.mode === "none")) {
      // nothing to stream: the row stays just its name (a body too large to
      // preview), its result speaks when it lands
      const dots = document.createElement("span");
      dots.className = "muted";
      dots.textContent = "…";
      st.row.appendChild(dots);
    } else {
      st.body = document.createElement("pre");
      st.body.className = "tool-args-detail stream-pre";
      st.row.appendChild(st.body);
    }
    group.el.appendChild(st.row);
    autoScroll();
  }
  st.text += ev.delta;
  if (st.body) st.body.textContent = previewText(st.ui, st.name, st.text);
  // the preview grows in place (no scroll event): re-pin while latched
  autoScroll();
}

// remove previews left by an aborted turn (a tool call that streamed but never finished)
function clearStreamPreviews() {
  for (const id of Object.keys(streamRows)) {
    if (streamRows[id]) streamRows[id].row.remove();
    delete streamRows[id];
  }
}

// a mid-stream retry (the attempt died after streaming part of the turn): the
// client restarts the request from scratch, so everything THIS attempt drew —
// the partial text, the reasoning block, the half-streamed tool rows — has to
// go, or it would sit above the retried answer as a stale copy. The retry
// notice announces it (discard=true); none of that partial output is durable
// (stream deltas are never stored), so nothing is lost by dropping it here.
function discardLivePartial() {
  if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
  if (lastTextEl) { lastTextEl.remove(); lastTextEl = null; }
  lastTextContent = "";
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  thinkingContent = "";
  clearStreamPreviews();
}

// transient "connection lost — retrying…" chip. Shown when an LLM stream
// attempt fails (network drop / read timeout) and the client reconnects with
// backoff; removed as soon as new tokens arrive, the compaction clears, or the
// run ends — so the UI never looks frozen.
function setRetryNote(ev) {
  if (retryNoteEl) retryNoteEl.remove();
  retryNoteEl = document.createElement("div");
  retryNoteEl.className = "event llm-note live";
  const p = document.createElement("p");
  p.className = "body";
  const fallback = `connection lost — retrying (${ev.attempt}/${ev.max_retries || "…"})`;
  p.textContent = "⚠ " + (ev.message || fallback);
  retryNoteEl.appendChild(p);
  (pageSink || eventsEl).appendChild(retryNoteEl);
  autoScroll();
}

function clearRetryNote() {
  if (retryNoteEl) {
    retryNoteEl.remove();
    retryNoteEl = null;
  }
}

function addEvent(ev) {
  // lazy wire shape: {offset, event} carries each durable event's byte offset
  // so the UI can page the earlier records
  if (ev && typeof ev === "object" && ev.event && typeof ev.offset === "number") {
    if (ev.offset > 0) oldestOffset = oldestOffset === null ? ev.offset : Math.min(oldestOffset, ev.offset);
    ev = ev.event;
  }
  // reconnect history line: restore the honest on-disk older count
  if (ev && ev.type === "history") {
    setOlderPill(ev.older || 0);
    return;
  }
  // replayed status/permission events must not drive the live UI
  if (stream.classList.contains("loading") &&
      (ev.type === "state_update" || ev.type === "permission_request")) {
    return;
  }
  // finalize the coalesced text block before any non-text event
  if (ev && ev.type !== "text_delta") flushTextRender();
  // events that break a tool group; results follow their own tool_calls
  if (["user_message", "text_delta", "reasoning_delta", "final", "step_start"].includes(ev.type)) {
    toolGroupEl = null;
  }
  if (applyStreamEvent(ev)) return;

  const el = renderEvent(ev);
  if (el) {
    (pageSink || eventsEl).appendChild(el);
    // user tasks render markdown too; replay hits this path as well.
    // NOTE: className is "event user" (two tokens) — classList.contains("event.user")
    // would be a single-token lookup and ALWAYS false (live math never typeset);
    // use CSS selector semantics like the replay path's ".event.user .body".
    if (el.matches(".event.user")) highlightCode(el);
    // user tasks may carry LaTeX; live path only (replay batches it after insertion)
    if (el.matches(".event.user") && !pageSink) typesetMath(el);
    autoScroll();
  }
}

// the live event layer: every event type whose handling depends on streaming
// state — coalesced text/thinking buffers, the live compaction block, retry
// chips, tool-call grouping, plus the durable renders that coordinate that
// state (compaction, assistant_message, final). Returns true when the event is
// fully handled; false means "plain durable render" and addEvent falls through
// to renderEvent() (user_message, tool_result, state_update, permission_request,
// step_start — which only resets the stream blocks above — and unknown types).
function applyStreamEvent(ev) {
  if (ev.type === "compaction_delta") {
    // live progress of an in-flight compaction (transient, not stored)
    if (ev.done) {
      if (compactionEl) { compactionEl.remove(); compactionEl = null; }
      clearRetryNote();
      return true;
    }
    if (!compactionEl) {
      compactionEl = document.createElement("div");
      compactionEl.className = "event compaction live";
      compactionEl.innerHTML = '<div class="hdr">compressing context</div>';
      const p = document.createElement("p");
      p.className = "body muted";
      compactionEl.appendChild(p);
      (pageSink || eventsEl).appendChild(compactionEl);
    }
    // a note (e.g. the summary stream dropped and is retrying) overrides the counter
    compactionEl.querySelector("p").textContent = ev.note
      ? ev.note
      : ev.chars > 0
        ? `summarizing earlier turns… ${ev.chars} chars streamed`
        : "compressing context — rolling earlier turns into a summary…";
    autoScroll();
    return true;
  }
  if (ev.type === "llm_retry") {
    // transient: an LLM stream attempt failed; the client is reconnecting with
    // backoff (never stored; the next delta removes the chip). discard=true
    // means the dead attempt had already streamed part of this turn: drop the
    // live partial before the retried answer starts drawing
    if (ev.discard) discardLivePartial();
    setRetryNote(ev);
    return true;
  }
  if (ev.type === "compaction") {
    // the durable compaction record: replace the live block with the final notice
    if (compactionEl) { compactionEl.remove(); compactionEl = null; }
    const el = document.createElement("div");
    el.className = "event compaction";
    el.innerHTML = '<div class="hdr">context compressed</div>';
    const p = document.createElement("p");
    p.className = "body muted";
    const summary = (ev.summary || "").trim();
    p.textContent = summary
      ? "Earlier turns were rolled into a " + summary.length + "-char summary to fit the context window."
      : "The conversation was compacted to fit the context window.";
    el.appendChild(p);
    (pageSink || eventsEl).appendChild(el);
    autoScroll();
    return true;
  }
  if (ev.type === "assistant_message") {
    toolGroupEl = null;
    // stored sessions render the final message once (no delta stream)
    if (lastTextEl && lastTextEl.isConnected) {
      lastTextEl = null;
      lastTextContent = "";
      return true;
    }
    // thinking renders above the agent text; skip if a live reasoning stream already
    // rendered this turn
    if (ev.reasoning && !(thinkingEl && thinkingEl.isConnected)) appendThinkingRow(ev.reasoning);
    if (ev.content) {
      const wrap = createAgentTextBlock();
      wrap.querySelector(".body").innerHTML = renderMarkdown(ev.content);
      highlightCode(wrap);
      (pageSink || eventsEl).appendChild(wrap);
    }
    return true;
  }
  if (ev.type === "final") {
    // the run is over: dismiss any stale permission prompt
    if (pendingPerm) closePerm();
    clearStreamPreviews(); // an aborted turn may have left half-streamed calls
    clearRetryNote(); // a lost stream that never recovered leaves no chip behind
    // fences may have closed since the last delta: one final render pass
    if (lastTextEl && lastTextEl.isConnected) highlightCode(lastTextEl);
    // completion divider; for non-completed runs the summary carries the reason
    appendCompletion(ev.status, ev.summary);
    refreshTree(); // a run finished; reflect any new files in the tree
    return true;
  }
  if (ev.type === "tool_call" && ev.tool_call_id) {
    let args = {};
    // the server forwards the model's raw argument string: if it is not JSON, the
    // call must not silently render with no arguments at all
    try { args = JSON.parse(ev.arguments || "{}"); } catch (e) { console.warn("[tool] arguments are not JSON", e); }
    toolCalls[ev.tool_call_id] = { name: ev.name, args, ui: ev.ui || {} };
    const st = streamRows[ev.tool_call_id];
    if (st) {
      // the call finished: the live row settles to its final form in place —
      // chip and args expander, the preview body gone
      st.row.classList.remove("stream");
      const preview = st.row.querySelector(".stream-pre");
      if (preview) preview.remove();
      const dots = st.row.querySelector(".muted");
      if (dots) dots.remove();
      st.row.appendChild(argsButton(ev.arguments, uiOf(ev)));
      st.body = null;
      streamRows[ev.tool_call_id] = undefined;
      autoScroll();
    } else {
      addToolCallRow(ev); // replay (no deltas) renders the final row directly
    }
    return true;
  }
  if (ev.type === "tool_call_delta" && ev.tool_call_id) {
    clearRetryNote(); // args are flowing again: the reconnect landed
    handleToolCallDelta(ev);
    return true;
  }

  // a row-form result lands beside its call, in the block their calls collect
  // in; every other result is its own block after the calls (renderEvent)
  if (ev.type === "tool_result" && toolCalls[ev.tool_call_id]) {
    const call = toolCalls[ev.tool_call_id];
    const ui = uiOfResult(ev);
    const group = ui.group ? toolCallGroups.get(ev.tool_call_id) : null;
    if (group && ui.form === "row") {
      appendResultRow(group, ui, call, ev);
      group.closed = true; // this group's calls have completed
      return true;
    }
  }

  // accumulate text and render once per frame (a full re-parse per token is O(n²))
  if (ev.type === "text_delta" && ev.content) {
    clearRetryNote(); // text is flowing again: the reconnect landed
    if (!lastTextEl) {
      lastTextEl = createAgentTextBlock();
      (pageSink || eventsEl).appendChild(lastTextEl);
    }
    lastTextContent += ev.content;
    scheduleTextRender();
    return true;
  }

  // streaming reasoning: compact row while streaming, expandable on click
  if (ev.type === "reasoning_delta" && ev.content) {
    clearRetryNote(); // thinking is flowing again: the reconnect landed
    thinkingContent += ev.content;
    if (!thinkingEl) {
      const block = buildThinkingBlock("", "");
      thinkingEl = block.el;
      (pageSink || eventsEl).appendChild(thinkingEl);
    }
    thinkingEl.querySelector(".thinking-label").textContent =
      "thinking… " + thinkingContent.length + " chars";
    // keep the block's own copy in sync; update it live if the full text is open
    const full = thinkingEl.querySelector(".thinking-full");
    full._content = thinkingContent;
    const fold = thinkingEl.querySelector(".fold");
    if (fold && !fold.classList.contains("hidden")) full.textContent = full._content;
    autoScroll();
    return true;
  }

  if (ev.type === "step_start") {
    // a new LLM turn begins: reset the streaming blocks (and any stale chip);
    // nothing to draw itself — step_start falls through to renderEvent (no case,
    // so no node) after the reset
    lastTextEl = null;
    lastTextContent = "";
    thinkingEl = null;
    thinkingContent = "";
    clearRetryNote();
  }

  return false;
}

function createAgentTextBlock() {
  const wrap = document.createElement("div");
  wrap.className = "event text";
  wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
  return wrap;
}

// coalesced streaming render: one full-block render per frame, flushed by the
// next non-text event so a superseded block is always complete.
//
// THROTTLED to ~8fps: each render is a FULL marked+DOMPurify re-parse of the
// whole accumulated block plus a DOM rebuild — at 60fps on a long answer that
// is O(n²) work that starves the main thread, and a starved renderer is the
// whole-window freeze (clicks queue, Stop included). Math is deferred to the
// flush render: typesetting the whole block per frame for a stray "$…$" pair
// was the single most expensive frame cost.
let textRenderRaf = 0;
let textRenderLast = 0;
const TEXT_RENDER_MIN_MS = 120;
function renderTextBlock(force = false) {
  textRenderRaf = 0;
  const now = performance.now();
  if (!force && now - textRenderLast < TEXT_RENDER_MIN_MS) {
    // too soon since the last full render: skip this frame (cheap no-op), a
    // later frame renders once with every delta that arrived in between
    textRenderRaf = requestAnimationFrame(() => renderTextBlock(false));
    return;
  }
  textRenderLast = now;
  if (!lastTextEl) return;
  const bodyEl = lastTextEl.querySelector(".body");
  bodyEl.innerHTML = renderMarkdown(lastTextContent);
  lastTextEl._mathDone = false; // fresh content: the flush owes a math pass
  highlightCode(lastTextEl, true);
  if (force && !stream.classList.contains("loading")) {
    typesetMath(lastTextEl);
    lastTextEl._mathDone = true;
  }
  autoScroll();
}
function scheduleTextRender() {
  if (textRenderRaf) return;
  textRenderRaf = requestAnimationFrame(() => renderTextBlock(false));
}
function flushTextRender() {
  if (textRenderRaf) {
    cancelAnimationFrame(textRenderRaf);
    renderTextBlock(true);
  } else if (lastTextEl && !lastTextEl._mathDone && !stream.classList.contains("loading")) {
    // content is current (a render landed within the throttle window) but the
    // math pass was deferred while streaming: run it exactly once here — the
    // _mathDone flag keeps bursty non-text events (tool_call_delta chunks)
    // from re-typesetting an unchanged block over and over
    typesetMath(lastTextEl);
    lastTextEl._mathDone = true;
  }
}

// height animation via WAAPI with overflow hidden (no scrollbar shift)
const FOLD_EASE = "cubic-bezier(.23, 1, .32, 1)";

// one fold/diff animation per element; cancel any in-flight one
function cancelFoldAnim(el) {
  if (el._foldAnim) { try { el._foldAnim.cancel(); } catch (e) {} }
  el._foldAnim = null;
}

function animateFold(el, from, to, onDone) {
  cancelFoldAnim(el);
  el.style.overflowY = "hidden";
  el.style.height = from + "px";
  const settle = () => {
    cancelFoldAnim(el);
    onDone();
    // the fold's height settled (or was cancelled): re-pin the tail if latched
    if (followTail && !stream.classList.contains("loading")) autoScroll();
  };
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.style.height = to + "px";
    settle();
    return;
  }
  const anim = el.animate(
    [{ height: from + "px" }, { height: to + "px" }],
    { duration: 200, easing: FOLD_EASE, fill: "forwards" }
  );
  el._foldAnim = anim;
  anim.onfinish = settle;
  followTailDuring(anim);
}

function resetFold(el) {
  el.style.height = "";
  el.style.overflowY = "";
}

// diff expand: grow from its collapsed 140px to the content height
function expandDiff(pre) {
  const start = pre.offsetHeight; // 140 while .diff-collapsed
  pre.classList.remove("diff-collapsed");
  const target = Math.min(pre.scrollHeight, 320);
  animateFold(pre, start, target, () => resetFold(pre));
}

function collapseDiff(pre) {
  animateFold(pre, pre.offsetHeight, 140, () => {
    pre.classList.add("diff-collapsed");
    resetFold(pre);
  });
}

// grid-rows accordion: animate 0fr<->1fr so large text never reflows per frame
function wrapFold(contentEl) {
  const inner = document.createElement("div");
  inner.className = "fold-inner";
  inner.appendChild(contentEl);
  const fold = document.createElement("div");
  fold.className = "fold hidden";
  fold.appendChild(inner);
  return fold;
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// keep the view pinned to the tail each frame while a fold/diff expands
function followTailDuring(anim) {
  let raf = requestAnimationFrame(function tick() {
    if (followTail && !stream.classList.contains("loading")) autoScroll();
    raf = requestAnimationFrame(tick);
  });
  const stop = () => cancelAnimationFrame(raf);
  anim.addEventListener("finish", stop, { once: true });
  anim.addEventListener("cancel", stop, { once: true });
}

function foldExpand(fold) {
  cancelFoldAnim(fold);
  fold.classList.remove("hidden");
  if (reducedMotion()) { fold.classList.add("open"); autoScroll(); return; }
  const anim = fold.animate(
    [{ gridTemplateRows: "0fr" }, { gridTemplateRows: "1fr" }],
    { duration: 200, easing: FOLD_EASE }
  );
  fold._foldAnim = anim;
  anim.onfinish = () => { fold._foldAnim = null; fold.classList.add("open"); };
  followTailDuring(anim);
}

function foldCollapse(fold, onDone) {
  cancelFoldAnim(fold);
  fold.classList.remove("open");
  if (reducedMotion()) { fold.classList.add("hidden"); if (onDone) onDone(); return; }
  const anim = fold.animate(
    [{ gridTemplateRows: "1fr" }, { gridTemplateRows: "0fr" }],
    { duration: 200, easing: FOLD_EASE }
  );
  fold._foldAnim = anim;
  anim.onfinish = () => {
    fold._foldAnim = null;
    fold.classList.add("hidden");
    if (onDone) onDone();
  };
}

function toggleFold(fold, onExpand) {
  const wasHidden = fold.classList.contains("hidden");
  if (wasHidden) {
    if (onExpand) onExpand(); // fill content before the wrapper sizes itself
    foldExpand(fold);
  } else {
    foldCollapse(fold);
  }
  return wasHidden;
}

// collapsible thinking row; shared by the stored-replay and live streaming paths
function buildThinkingBlock(initialLabel, initialContent) {
  const el = document.createElement("div");
  el.className = "event thinking";
  el.innerHTML = '<div class="hdr">thinking</div>';
  const row = document.createElement("div");
  row.className = "thinking-row";
  const toggle = document.createElement("span");
  toggle.className = "fold-toggle";
  toggle.textContent = "▸";
  const lbl = document.createElement("span");
  lbl.className = "thinking-label";
  lbl.textContent = initialLabel;
  row.appendChild(toggle);
  row.appendChild(lbl);
  el.appendChild(row);
  const full = document.createElement("pre");
  full.className = "thinking-full";
  full.textContent = initialContent;
  full._content = initialContent; // per-block copy; survives step_start resets
  const fold = wrapFold(full);
  el.appendChild(fold);
  // click toggles between the compact row and the full reasoning text
  row.onclick = () => {
    const wasHidden = toggleFold(fold, () => { full.textContent = full._content; });
    toggle.textContent = wasHidden ? "▾" : "▸";
  };
  return { el, full, fold };
}

// thinking row rebuilt from a stored assistant_message.reasoning
function appendThinkingRow(reasoning) {
  const block = buildThinkingBlock("thinking", reasoning);
  (pageSink || eventsEl).appendChild(block.el);
}

// typeset LaTeX; pre/code are skipped so code stays literal
const MATH_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/;

function typesetMath(el) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  if (!el || !MATH_RE.test(el.textContent)) return;
  // typesetting changes height asynchronously: re-pin the tail when it settles
  MathJax.typesetPromise([el]).then(() => autoScroll()).catch(() => {});
}

// gate: only scan when a $…$ pair survives in non-code text
function hasMathText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("pre, code").forEach((n) => n.remove());
  return MATH_RE.test(clone.textContent);
}

// typeset replayed math block-by-block so the progress bar tracks the work
async function typesetProgressively(root, onPct) {
  if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
  const blocks = Array.from(root.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
  if (!blocks.length) return;
  for (let i = 0; i < blocks.length; i++) {
    try { await MathJax.typesetPromise([blocks[i]]); } catch (e) {}
    onPct((i + 1) / blocks.length);
    await new Promise((r) => setTimeout(r, 0)); // let the bar repaint between blocks
  }
}

// syntax-highlight a freshly rendered block; streaming skips a last-element
// diagram (its fence may still be open)
//
// CACHED by code source: the streaming render rebuilds the block's DOM every
// frame, so re-running hljs over every COMPLETED fence each frame is O(n²)
// (this is what pegged the renderer and froze the window mid-answer).
// textContent is invariant under highlighting, so the source string is a
// stable key; cached fences just get their HTML re-assigned.
const hlCache = new Map();
const HL_CACHE_MAX = 64; // bounded LRU (insertion-ordered FIFO is fine here)
const HL_STREAM_MAX = 16384; // while streaming, fences bigger than this wait for the flush render
const HL_CACHE_MAX_SRC = 131072; // never cache giants; they re-highlight on flush only

function highlightCode(root, streaming = false) {
  if (typeof hljs === "undefined" || !root) return;
  root.querySelectorAll("pre code").forEach((el) => {
    const src = el.textContent;
    const cached = hlCache.get(src);
    if (cached !== undefined) {
      if (el.innerHTML !== cached) el.innerHTML = cached; // compare: skip needless DOM rebuilds
      return;
    }
    if (streaming && src.length > HL_STREAM_MAX) return; // the flush render highlights it
    try {
      hljs.highlightElement(el);
      if (src.length <= HL_CACHE_MAX_SRC) {
        if (hlCache.size >= HL_CACHE_MAX) hlCache.delete(hlCache.keys().next().value);
        hlCache.set(src, el.innerHTML);
      }
    } catch (e) {}
  });
  renderMermaid(root, streaming).catch((e) => console.warn("[mermaid]", e));
}

let mermaidInitialized = false;
// rendered SVGs cached by source: restore synchronously on streaming re-renders
const mermaidCache = new Map();

// is this pre the last meaningful child? streaming skips it (fence may be open)
function isLastElement(pre) {
  let n = pre.nextSibling;
  while (n) {
    if (n.nodeType === 1) return false;
    if (n.nodeType === 3 && n.textContent.trim()) return false;
    n = n.nextSibling;
  }
  return true;
}

// one-time mermaid initialization: bridge the :root custom properties (accent
// palette, --font-display stack) into mermaid's themeVariables. Returns false
// when initialize() threw — the caller keeps mermaidInitialized set anyway so a
// broken environment is not retried on every frame.
function initMermaidTheme() {
  try {
    // :root custom properties are handed over verbatim, and --font-display is
    // written with inline /* comments */ and newlines for readability. A
    // comment is legal inside a CSS font list but not something to hand to
    // mermaid (it re-emits the value into a <style> block and into inline
    // style attributes), so flatten every value the same way.
    const cssValue = (name) =>
      (getComputedStyle(document.documentElement).getPropertyValue(name) || "")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\s+/g, " ")
        .trim();
    // palette follows the UI: accent red strokes/lines, neutral dark fills
    const accent = cssValue("--accent") || "#EF4444";
    // diagram labels must not fall back to mermaid's own default font ("Arial"
    // in the bundle), which each OS resolves with a different face — the same
    // cross-platform drift the CSS stacks fix for the rest of the UI. Read the
    // computed stack so the diagrams follow it instead of duplicating it here.
    const diagramFont = cssValue("--font-display") || "sans-serif";
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      themeVariables: {
        fontFamily: diagramFont,
        // strokes & lines: accent red
        lineColor: accent,
        primaryBorderColor: accent,
        secondaryBorderColor: accent,
        tertiaryBorderColor: accent,
        // sequence diagram
        actorBorder: accent,
        actorLineColor: accent,
        signalColor: accent,
        labelBoxBorderColor: accent,
        noteBorderColor: accent,
        activationBorderColor: accent,
        // gantt: active = red fill, planned = grey, done = darker grey
        taskBorderColor: accent,
        taskBkgColor: "#2d2d33",
        taskBkg: "#2d2d33", // harmless alias for any theme that reads it
        taskTextColor: "#d4d4d8",
        taskTextLightColor: "#d4d4d8",
        activeTaskBorderColor: accent,
        activeTaskBkgColor: accent,
        activeTaskBkg: accent,
        activeTaskTextColor: "#0F0F10",
        doneTaskBorderColor: "#52525b",
        doneTaskBkgColor: "#1c1c1f",
        doneTaskBkg: "#1c1c1f",
        doneTaskTextColor: "#a1a1aa",
        todayLineColor: accent,
        // clusters / subgraphs
        clusterBorder: accent,
        // state diagrams: also override the outer container's legacy border1
        stateBorder: accent,
        border1: accent,
        // fills & labels: neutral dark greys
        noteBkgColor: "#1c1c1f",
        noteTextColor: "#d4d4d8",
        edgeLabelBackground: "#1c1c1f",
        clusterBkg: "#1c1c1f",
        taskTextOutsideColor: "#a1a1aa",
        activationBkgColor: "#27272a",
        // pie: first slice red, rest grayscale (pie0 unused)
        pie1: accent,
        pie2: "#27272a",
        pie3: "#3f3f46",
        pie4: "#52525b",
        pie5: "#71717a",
        pie6: "#8b8b94",
        pie7: "#a1a1aa",
        pie8: "#b8b8c0",
        pie9: "#c9c9d0",
        pie10: "#d4d4d8",
        pie11: "#e0e0e4",
        pie12: "#ededf0",
        // git graphs: grayscale + red (git0-git7)
        git0: accent,
        git1: "#71717a",
        git2: "#d4d4d8",
        git3: "#3f3f46",
        git4: "#a1a1aa",
        git5: "#27272a",
        git6: "#b8b8c0",
        git7: "#52525b",
      },
    });
    // never let the parser's error path paint its giant error diagram
    mermaid.parseError = (err) => console.warn("[mermaid]", err);
    return true;
  } catch (e) {
    return false;
  }
}

// render mermaid: skip a last-element block mid-stream (open fence), keep
// broken source literal (async parse gate)
async function renderMermaid(root, streaming = false) {
  if (typeof mermaid === "undefined" || !root) return;
  if (!mermaidInitialized) {
    mermaidInitialized = true;
    if (!initMermaidTheme()) return;
  }
  const pending = [];
  for (const code of root.querySelectorAll("pre code.language-mermaid")) {
    const pre = code.parentElement;
    if (!pre) continue;
    const src = code.textContent;
    if (pre.dataset.mermaidSrc === src) continue; // this exact source already drawn
    const cached = mermaidCache.get(src);
    if (cached) {
      // a streaming re-render rebuilt the DOM: restore the SVG synchronously
      pre.classList.add("mermaid-rendered");
      pre.textContent = "";
      pre.insertAdjacentHTML("beforeend", cached);
      pre.dataset.mermaidSrc = src;
      continue;
    }
    // gate 1 — possible unclosed fence mid-stream: don't draw half a diagram
    if (streaming && isLastElement(pre)) continue;
    // gate 2 — async syntax check before rendering; broken source stays literal
    let parsed = true;
    let parseErr = null;
    try {
      parsed = await mermaid.parse(src);
    } catch (e) {
      parsed = false;
      parseErr = e;
    }
    if (!parsed) {
      showMermaidError(pre, parseErr);
      pre.dataset.mermaidSrc = src; // identical broken source: no re-parse loop
      continue;
    }
    pre.dataset.mermaidSrc = src; // mark in-flight so deltas don't double-render
    pending.push({ pre, src });
  }
  for (const { pre, src } of pending) {
    mermaid
      .render("mmd-" + Math.random().toString(36).slice(2), src)
      .then(({ svg }) => {
        // a later delta may have rebuilt the DOM: re-locate the block by source
        let target = null;
        for (const el of root.querySelectorAll("pre code.language-mermaid")) {
          if (el.textContent === src) { target = el.parentElement; break; }
        }
        if (!target) return;
        // gate 3 — render can resolve a giant error diagram; never let it hit the DOM
        if (/Parse error on line|Lexical error on line|Syntax error in text|Parse error[:\s]/.test(svg)) {
          showMermaidError(target, null);
          delete target.dataset.mermaidSrc; // a corrected source can retry
          return;
        }
        if (mermaidCache.size > 100) mermaidCache.clear();
        mermaidCache.set(src, svg);
        // securityLevel "strict" already sanitizes the SVG; keep the block chrome
        target.classList.add("mermaid-rendered");
        target.textContent = "";
        target.insertAdjacentHTML("beforeend", svg);
        target.dataset.mermaidSrc = src;
        if (followTail) autoScroll(); // a diagram can be taller than its source
      })
      .catch((e) => {
        // keep the literal source; drop the marker so a corrected source can retry
        if (pre.isConnected) {
          showMermaidError(pre, e);
          delete pre.dataset.mermaidSrc;
        }
      });
  }
}

// mark a failed diagram with a small inline notice; the parser message goes
// into the hover title
function showMermaidError(pre, detail) {
  if (!pre || !pre.classList) return;
  pre.classList.add("mermaid-failed");
  if (!pre.querySelector(".mermaid-error")) {
    const tip = document.createElement("div");
    tip.className = "mermaid-error";
    tip.textContent = "Invalid diagram syntax; the original code was kept.";
    const msg = detail && (detail.message || String(detail));
    if (msg) tip.title = "mermaid: " + msg;
    pre.appendChild(tip);
  }
}

// ---- diagram viewer (device report #6) ----------------------------------
// A flowchart in a phone column is unreadable at fit-width, and even on the PC
// a 900px-wide diagram is a squint. Clicking a rendered diagram opens it
// full-screen with the phone image-viewer gestures: drag to pan, wheel/pinch to
// zoom, double-tap/double-click for 1:1, ✕ / Esc / Android back / tap outside to
// leave. Built on first use; nothing is added to the page until then, and the
// click is delegated (diagrams are re-rendered on every stream delta, so a
// per-diagram listener would be re-attached hundreds of times).

let dvOverlay = null;
let dvStage = null;
let dvInner = null;
let dvZoom = 1;
let dvX = 0;
let dvY = 0;
let dvFitZoom = 1;
let dvHistoryEntry = false; // this viewer pushed a history entry (Android back)

const DV_MIN_ZOOM = 0.05;
const DV_MAX_ZOOM = 16;
const clampZoom = (z) => Math.max(DV_MIN_ZOOM, Math.min(DV_MAX_ZOOM, z));

function dvApply() {
  dvInner.style.transform = "translate(" + dvX + "px," + dvY + "px) scale(" + dvZoom + ")";
}

// centre the diagram at its natural size in the stage
function dvFit() {
  const svg = dvInner.firstElementChild;
  if (!svg || !dvStage) return;
  const w = Number(svg.getAttribute("width")) || svg.clientWidth || 800;
  const h = Number(svg.getAttribute("height")) || svg.clientHeight || 600;
  const r = dvStage.getBoundingClientRect();
  dvFitZoom = Math.min((r.width * 0.94) / w, (r.height * 0.94) / h) || 1;
  dvZoom = dvFitZoom;
  dvX = (r.width - w * dvZoom) / 2;
  dvY = (r.height - h * dvZoom) / 2;
  dvApply();
}

// scale by `factor`, keeping the point (cx,cy) — stage-local pixels — in place
function dvZoomAt(factor, cx, cy) {
  const z = clampZoom(dvZoom * factor);
  const k = z / dvZoom;
  dvX = cx - (cx - dvX) * k;
  dvY = cy - (cy - dvY) * k;
  dvZoom = z;
  dvApply();
}

function dvCenterZoom(z) {
  if (!dvStage) return;
  const r = dvStage.getBoundingClientRect();
  dvZoomAt(z / dvZoom, r.width / 2, r.height / 2);
}

function ensureDiagramViewer() {
  if (dvOverlay) return;
  dvOverlay = document.createElement("div");
  dvOverlay.className = "diagram-viewer";
  dvOverlay.innerHTML =
    '<div class="dv-hint">drag to pan · pinch or wheel to zoom · double-tap for 1:1 · tap outside to close</div>' +
    '<div class="dv-stage"><div class="dv-inner"></div></div>' +
    '<div class="dv-bar">' +
    '<button class="dv-zoom-out" title="zoom out">−</button>' +
    '<button class="dv-one" title="actual size">1:1</button>' +
    '<button class="dv-fit" title="fit to screen">fit</button>' +
    '<button class="dv-zoom-in" title="zoom in">＋</button>' +
    "</div>" +
    '<button class="dv-close" title="close (Esc)">✕</button>';
  document.body.appendChild(dvOverlay);
  dvStage = dvOverlay.querySelector(".dv-stage");
  dvInner = dvOverlay.querySelector(".dv-inner");

  const localOf = (e) => {
    const r = dvStage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  dvOverlay.querySelector(".dv-close").addEventListener("click", closeDiagramViewer);
  dvOverlay.querySelector(".dv-fit").addEventListener("click", dvFit);
  dvOverlay.querySelector(".dv-one").addEventListener("click", () => dvCenterZoom(1));
  dvOverlay.querySelector(".dv-zoom-in").addEventListener("click", () => dvCenterZoom(dvZoom * 1.5));
  dvOverlay.querySelector(".dv-zoom-out").addEventListener("click", () => dvCenterZoom(dvZoom / 1.5));

  // desktop: the wheel zooms around the cursor (a bare wheel must not scroll
  // the page under the overlay)
  dvStage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = localOf(e);
      dvZoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
    },
    { passive: false }
  );

  // one pointer pans, two pointers pinch; a tap that never moved, landing
  // outside the diagram, leaves (the diagram itself stays tappable so the
  // double-tap gesture below still works)
  const pts = new Map();
  let pinch = null;
  let moved = 0;
  const startPinch = () => {
    const [a, b] = [...pts.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom: dvZoom,
      x: dvX,
      y: dvY,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  dvStage.addEventListener("pointerdown", (e) => {
    if (dvStage.setPointerCapture) dvStage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, localOf(e));
    moved = 0;
    if (pts.size === 2) pinch = startPinch();
  });
  dvStage.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const q = localOf(e);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    moved += Math.abs(dx) + Math.abs(dy);
    pts.set(e.pointerId, q);
    if (pts.size === 1) {
      dvX += dx;
      dvY += dy;
      dvApply();
      return;
    }
    if (!pinch) pinch = startPinch();
    const [a, b] = [...pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = clampZoom(pinch.zoom * (dist / pinch.dist));
    // the content point under the original midpoint stays under the new one
    const cx = (pinch.mid.x - pinch.x) / pinch.zoom;
    const cy = (pinch.mid.y - pinch.y) / pinch.zoom;
    dvZoom = z;
    dvX = mid.x - cx * z;
    dvY = mid.y - cy * z;
    dvApply();
  });
  const endPointer = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size || moved >= 8) return;
    // the diagram as drawn, in the same stage-local pixels as localOf()
    const sr = dvStage.getBoundingClientRect();
    const r = dvInner.getBoundingClientRect();
    const p = localOf(e);
    const inside =
      p.x >= r.left - sr.left && p.x <= r.right - sr.left &&
      p.y >= r.top - sr.top && p.y <= r.bottom - sr.top;
    if (!inside) closeDiagramViewer();
  };
  dvStage.addEventListener("pointerup", endPointer);
  dvStage.addEventListener("pointercancel", endPointer);
  dvStage.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (Math.abs(dvZoom - dvFitZoom) > 0.01) dvFit();
    else dvCenterZoom(1);
  });
}

function openDiagramViewer(source) {
  const svg = source.querySelector("svg");
  if (!svg) return;
  ensureDiagramViewer();
  // the clone gets its natural size back: the on-page svg is width-capped, and
  // a max-width:100% box cannot be zoomed into anything readable
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const box = svg.getBoundingClientRect();
  const w = vb.length === 4 && vb[2] > 0 ? vb[2] : Math.round(box.width) || 800;
  const h = vb.length === 4 && vb[3] > 0 ? vb[3] : Math.round(box.height) || 600;
  const clone = svg.cloneNode(true);
  clone.removeAttribute("style");
  clone.setAttribute("width", w);
  clone.setAttribute("height", h);
  clone.style.width = w + "px";
  clone.style.height = h + "px";
  clone.style.maxWidth = "none";
  while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
  dvInner.appendChild(clone);
  dvOverlay.classList.add("open");
  dvFit(); // the stage has a size only once the overlay is displayed
  if (!dvHistoryEntry) {
    // an entry of our own, so the phone's back button closes the overlay
    // instead of walking out of the app
    try {
      history.pushState({ clutchDiagram: 1 }, "");
      dvHistoryEntry = true;
    } catch (e) {
      dvHistoryEntry = false;
    }
  }
}

function closeDiagramViewer() {
  if (!dvOverlay || !dvOverlay.classList.contains("open")) return;
  dvOverlay.classList.remove("open");
  while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
  if (dvHistoryEntry) {
    dvHistoryEntry = false;
    try {
      history.back(); // consume our entry (the popstate listener below no-ops)
    } catch (e) {}
  }
}

window.addEventListener("popstate", () => {
  if (dvHistoryEntry && dvOverlay && dvOverlay.classList.contains("open")) {
    dvHistoryEntry = false;
    dvOverlay.classList.remove("open");
    while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
  }
  dvHistoryEntry = false;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDiagramViewer();
});

document.addEventListener("click", (e) => {
  const t = e.target;
  const pre = t && t.closest ? t.closest("pre.mermaid-rendered") : null;
  if (pre && pre.querySelector("svg")) openDiagramViewer(pre);
});

// map a file extension to a highlight.js language id for bare <pre> results
const CODE_LANGS = {
  py: "python", js: "javascript", mjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", html: "xml", htm: "xml", xml: "xml",
  css: "css", scss: "scss", json: "json", md: "markdown", sh: "bash",
  bash: "bash", yaml: "yaml", yml: "yaml", c: "c", h: "c", cpp: "cpp",
  hpp: "cpp", go: "go", rs: "rust", java: "java", sql: "sql", rb: "ruby",
  php: "php", r: "r", diff: "diff",
};
function highlightPreByPath(pre, path) {
  if (typeof hljs === "undefined") return;
  const ext = String(path || "").split(".").pop().toLowerCase();
  const lang = CODE_LANGS[ext] || "";
  if (lang) pre.classList.add("language-" + lang);
  try {
    if (pre.querySelector("code")) {
      hljs.highlightElement(pre.querySelector("code"));
    } else {
      const code = document.createElement("code");
      code.textContent = pre.textContent;
      pre.textContent = "";
      pre.appendChild(code);
      hljs.highlightElement(code);
    }
  } catch (e) {}
}

function appendCompletion(status, summary) {
  const div = document.createElement("div");
  div.className = "completion";
  div.textContent = status === "completed" ? "completed" : status;
  (pageSink || eventsEl).appendChild(div);
  // completed summaries duplicate the streamed text; only abort/error reasons are shown
  if (status !== "completed" && summary) {
    const note = document.createElement("div");
    note.className = "completion-note";
    note.textContent = summary;
    (pageSink || eventsEl).appendChild(note);
  }
  // live runs re-pin to the completion divider; never yank a user who scrolled up
  if (!stream.classList.contains("loading")) {
    // never yank mid-glide: the user's jump animation owns the scroll until it lands
    if (gliding) return;
    if (followTail) stream.scrollTop = stream.scrollHeight;
    else setJumpVisible(true);
  }
}

function renderEvent(ev) {
  const wrap = document.createElement("div");
  const body = document.createElement("div");
  body.className = "body";
  let appendedBody = false; // write+diff appends body itself; skip the trailing append

  switch (ev.type) {
    case "user_message": {
      wrap.className = "event user";
      wrap.innerHTML = '<div class="hdr">task</div>';
      body.className = "body";
      // hard-wrapped markdown (breaks: true): WYSIWYG line breaks
      body.innerHTML = renderMarkdown(ev.content, true);
      break;
    }
    case "tool_result": {
      const call = toolCalls[ev.tool_call_id] || { name: "", args: {}, ui: {} };
      const ui = uiOfResult(ev);
      // a call that may change the tree asks for a fresh one (the declaration
      // says whether it can — the host derives it when it declares nothing)
      if (ui.mutates) scheduleTreeRefresh();
      if (ui.form === "row") return buildResultRowBlock(ui, call, ev);
      return buildResultBlock(ui, call.name || "", call.args || {}, ev);
    }
    case "state_update": {
      if (ev.key === "execution_status" && ev.value) setStatus(ev.value);
      return null;
    }
    case "permission_request": {
      openPerm(ev);
      return null;
    }
    default:
      return null;
  }
  if (!appendedBody) wrap.appendChild(body);
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// markdown via marked + DOMPurify (LLM output is untrusted); breaks=true
// hard-wraps user tasks
function renderMarkdown(text, breaks = false) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return escapeHtml(text);
  }
  try {
    const src = String(text);
    // protect math from marked's backslash escapes via ⟦MATHn⟧ placeholders
    const math = [];
    const protectedSrc = src.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => {
      math.push(m);
      return `⟦MATH${math.length - 1}⟧`;
    });
    const html = breaks ? marked.parse(protectedSrc, { breaks: true }) : marked.parse(protectedSrc);
    const restored = html.replace(/⟦MATH(\d+)⟧/g, (_, i) => math[+i]);
    return DOMPurify.sanitize(restored);
  } catch (e) {
    return escapeHtml(text);
  }
}

// render a unified diff string as a <pre> with per-line +/- colouring
function renderDiff(diff) {
  const pre = document.createElement("pre");
  pre.className = "diff-view";
  const lines = diff.split("\n");
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    if (line.startsWith("+++") || line.startsWith("---")) {
      div.className = "diff-hunk";
    } else if (line.startsWith("+")) {
      div.className = "diff-add";
    } else if (line.startsWith("-")) {
      div.className = "diff-del";
    } else if (line.startsWith("@")) {
      div.className = "diff-meta";
    }
    pre.appendChild(div);
  }
  return pre;
}

// ---- run / stop ----
async function run() {
  const task = els.task.value.trim();
  if (!task || busy) return;
  if (!currentProject) return;
  els.task.value = ""; // the task is now "in the stream"; keep the input clear
  els.task.style.height = TASK_BASE_H + "px"; // animate the input back to its default size
  // sending a message returns to the live tail unconditionally
  followTail = true;
  autoScroll(true);
  // runs append to the active project; the mode travels with the request
  const payload = { task, mode: agentMode, project: currentProject };
  try {
    const data = await apiFetch("/api/run", { method: "POST", body: payload });
    if (data.workspace) els.workspace.textContent = data.workspace;
    refreshTree();
  } catch (e) {
    addEvent({ type: "final", status: "error", summary: "run failed: " + e.message });
  }
}

async function stop() {
  try {
    // bounded so a wedged request cannot outlive the patience of the user —
    // and never swallowed: the click must do SOMETHING either way. `busy` is
    // refreshed by the SSE stream, not by this response, so when the cancel
    // cannot be delivered the window must stop pretending that it was.
    await apiFetch("/api/stop", { method: "POST", timeout: 8000 }); // bodyless
  } catch (e) {
    notice("could not reach the backend to stop (" + ((e && e.message) || e) + ") — the task may still be running");
    setStatus("idle"); // the button belongs to the user again: retry Stop, or Run
    // the link itself may be recoverable: re-resolve the session of this
    // window (the tunnel or the supervisor may have re-claimed one under us)
    await switchBackendResolved();
  }
}

els.run.addEventListener("click", () => (busy ? stop() : run()));
els.mode.addEventListener("click", () => {
  if (busy) return; // disabled + guard: the active run's mode is already fixed
  setMode(agentMode === "chat" ? "work" : "chat");
});
setMode(agentMode); // paint the stored mode on startup
els.task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
});

// ---- task input auto-grow (grows as you type, shrinks back after sending) ----
const TASK_BASE_H = els.task.offsetHeight; // default 3-row height
function autoGrowTask() {
  const was = els.task.style.height;
  if (!els.task.value.trim()) {
    els.task.style.height = TASK_BASE_H + "px";
  } else {
    els.task.style.height = "auto";
    els.task.style.height = Math.min(els.task.scrollHeight, Math.round(window.innerHeight * 0.3)) + "px";
  }
  // the input resize clamps scrollTop; the listener ignores it, so re-pin while
  // typing to stay on the tail
  if (was !== els.task.style.height) {
    suppressLatchUntil = performance.now() + 120;
    if (followTail && !nearBottom()) autoScroll();
  }
}
els.task.addEventListener("input", autoGrowTask);

// ---- API settings modal ----
// endpoint persisted on the backend + client proxy; profiles pick the backend
function customSelect(root) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cselect-btn";
  if (root.getAttribute("title")) btn.title = root.getAttribute("title");
  const valueEl = document.createElement("span");
  valueEl.className = "cselect-value";
  const arrow = document.createElement("span");
  arrow.className = "cselect-arrow";
  btn.appendChild(valueEl);
  btn.appendChild(arrow);
  const pop = document.createElement("div");
  pop.className = "cselect-pop";
  root.classList.add("cselect");
  root.appendChild(btn);
  root.appendChild(pop);

  const opts = []; // {value, text}
  let selected = null;
  const listeners = [];

  function render() {
    const o = opts.find((x) => x.value === selected);
    valueEl.textContent = o ? o.text : "";
    pop.innerHTML = "";
    for (const opt of opts) {
      const row = document.createElement("div");
      row.className = "cselect-opt" + (opt.value === selected ? " active" : "");
      row.textContent = opt.text;
      row.addEventListener("click", () => {
        const changed = opt.value !== selected;
        selected = opt.value;
        render();
        root.classList.remove("open");
        if (changed) for (const fn of listeners) fn();
      });
      pop.appendChild(row);
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    root.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) root.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") root.classList.remove("open");
  });

  return {
    set innerHTML(_v) { opts.length = 0; selected = null; render(); }, // only ever cleared
    appendChild(opt) { opts.push({ value: opt.value, text: opt.textContent }); render(); },
    get value() { return selected || ""; },
    set value(v) { selected = v; render(); },
    get disabled() { return root.classList.contains("disabled"); },
    set disabled(b) { root.classList.toggle("disabled", !!b); },
    addEventListener(_ev, fn) { listeners.push(fn); },
    focus() { btn.focus(); },
  };
}

const modal = $("#settings-modal");
const keyInput = $("#api-key-input");
const modelInput = $("#model-input");
const reasoningEffortInput = customSelect($("#reasoning-effort-input"));
// reasoning-effort options
for (const [v, t] of [["", "default"], ["low", "low"], ["medium", "medium"], ["max", "max"]]) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = t;
  reasoningEffortInput.appendChild(o);
}
reasoningEffortInput.value = "";
// wire protocol: empty = the endpoint's default (chat completions); providers
// serving the Responses API on the same base URL need the explicit choice
const apiProtocolInput = customSelect($("#api-protocol-input"));
for (const [v, t] of [["", "chat completions (default)"], ["responses", "responses API"]]) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = t;
  apiProtocolInput.appendChild(o);
}
apiProtocolInput.value = "";
// "chat" in the settings file IS the default choice, so show it as such
function setApiProtocol(v) {
  apiProtocolInput.value = v === "chat" ? "" : v || "";
}
const llmUrlInput = $("#llm-url-input");
const profileSelect = customSelect($("#llm-profile-select"));

function llmProfiles() {
  try {
    return JSON.parse(localStorage.getItem("clutch_llm_profiles") || "{}");
  } catch (e) {
    return {};
  }
}

function saveLlmProfiles(profiles) {
  localStorage.setItem("clutch_llm_profiles", JSON.stringify(profiles));
}

function renderLlmProfiles(activeName) {
  const profiles = llmProfiles();
  profileSelect.innerHTML = "";
  const names = Object.keys(profiles).sort();
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name === activeName ? name + " ✓" : name;
    profileSelect.appendChild(opt);
  }
  // empty list = no profiles: disable the picker
  profileSelect.disabled = names.length === 0;
  profileSelect.value = names.includes(activeName) ? activeName : (names[0] || "");
  // Delete/Edit act on the selected profile: grey them out when none is selected
  $("#llm-profile-del").disabled = !profileSelect.value;
  $("#llm-profile-edit").disabled = !profileSelect.value;
}

// apply a saved profile: fill the form and push it to the backend immediately
async function applyLlmProfile(name) {
  const p = llmProfiles()[name];
  if (!p) return;
  keyInput.value = p.api_key || "";
  llmUrlInput.value = p.base_url || "";
  modelInput.value = p.model || "";
  reasoningEffortInput.value = p.reasoning_effort || "";
  setApiProtocol(p.api_protocol);
  localStorage.setItem("clutch_llm_active", name);
  renderLlmProfiles(name);
  await pushSettings();
}

profileSelect.addEventListener("change", async () => {
  const name = profileSelect.value;
  if (name) await applyLlmProfile(name);
  else renderLlmProfiles("");
});

const profileNameInput = $("#llm-profile-name");

function saveProfileAs(name, oldName) {
  const profiles = llmProfiles();
  if (oldName && oldName !== name) delete profiles[oldName]; // rename: drop the old key
  profiles[name] = {
    base_url: llmUrlInput.value.trim(),
    model: modelInput.value.trim(),
    api_key: keyInput.value.trim(),
    reasoning_effort: reasoningEffortInput.value.trim(),
    api_protocol: apiProtocolInput.value.trim(),
  };
  saveLlmProfiles(profiles);
  localStorage.setItem("clutch_llm_active", name);
  renderLlmProfiles(name);
}

// ---- LLM profile editor (mirrors the SSH connection modal) ----
// pick to apply, ＋ New (blank), Edit, Delete; url/key/model fields live here
const llmProfileModal = $("#llm-profile-modal");
const llmProfileTitle = $("#llm-profile-title");
const llmProfileError = $("#llm-profile-error");
let editingProfile = null; // the profile being edited, or null for a new one

function showLlmProfileError(msg) {
  llmProfileError.textContent = msg;
  llmProfileError.classList.remove("hidden");
  profileNameInput.classList.add("profile-name-error");
}
function clearLlmProfileError() {
  llmProfileError.classList.add("hidden");
  llmProfileError.textContent = "";
  profileNameInput.classList.remove("profile-name-error");
}

function openLlmProfileEditor(name) {
  // ＋ New (no name) opens a BLANK form; Edit prefills the selected profile
  const p = name ? llmProfiles()[name] : null;
  editingProfile = name && p ? name : null;
  llmProfileTitle.textContent = editingProfile ? "Edit profile: " + editingProfile : "New LLM profile";
  profileNameInput.value = editingProfile || "";
  llmUrlInput.value = (p && p.base_url) || "";
  keyInput.value = (p && p.api_key) || "";
  modelInput.value = (p && p.model) || "";
  reasoningEffortInput.value = (p && p.reasoning_effort) || "";
  setApiProtocol(p && p.api_protocol);
  clearLlmProfileError();
  llmProfileModal.classList.remove("hidden", "closing");
  profileNameInput.focus();
}
function closeLlmProfileEditor() {
  editingProfile = null;
  closeModal(llmProfileModal);
}

$("#llm-profile-new").addEventListener("click", () => openLlmProfileEditor());
$("#llm-profile-edit").addEventListener("click", () => openLlmProfileEditor(profileSelect.value));
$("#llm-profile-cancel").addEventListener("click", closeLlmProfileEditor);
dismissOnOverlayPress(llmProfileModal, closeLlmProfileEditor);

$("#llm-profile-save").addEventListener("click", async () => {
  const name = profileNameInput.value.trim();
  if (!name) {
    clearLlmProfileError();
    showLlmProfileError("Give this profile a name.");
    profileNameInput.focus();
    return;
  }
  // a name conflicts only when it belongs to a DIFFERENT profile
  const taken = llmProfiles()[name];
  if (taken && name !== editingProfile) {
    showLlmProfileError("A profile named \"" + name + "\" already exists — pick a different name.");
    profileNameInput.focus();
    return;
  }
  const oldName = editingProfile;
  editingProfile = null;
  saveProfileAs(name, oldName);
  closeModal(llmProfileModal);
  await pushSettings(); // apply the new/edited profile to the backend
});

profileNameInput.addEventListener("input", clearLlmProfileError);

profileNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("#llm-profile-save").click();
  }
});

$("#llm-profile-del").addEventListener("click", async () => {
  const name = profileSelect.value;
  if (!name) return; // nothing selected: nothing to delete
  const yes = await askConfirm({
    title: "Delete LLM profile",
    text: 'Delete profile "' + name + '"?',
    ok: "Delete",
  });
  if (!yes) return;
  const profiles = llmProfiles();
  delete profiles[name];
  saveLlmProfiles(profiles);
  if (localStorage.getItem("clutch_llm_active") === name) localStorage.removeItem("clutch_llm_active");
  renderLlmProfiles("");
});

async function openSettings() {
  modal.classList.remove("hidden", "closing");
  // url/key/model fields live in the profile editor; nothing to prefill here
  renderLlmProfiles(localStorage.getItem("clutch_llm_active") || "");
}
function closeSettings() {
  closeModal(modal);
}
// push the profile-editor form values to the backend
async function pushSettings() {
  const key = keyInput.value.trim();
  const llmUrl = llmUrlInput.value.trim();
  const model = modelInput.value.trim();
  const payload = {
    base_url: llmUrl,
    model,
    // always sent: empty values clear the knobs on the backend
    reasoning_effort: reasoningEffortInput.value.trim(),
    api_protocol: apiProtocolInput.value.trim(),
  };
  if (key) payload.api_key = key;
  try {
    await apiFetch("/api/settings", { method: "POST", body: payload });
    if (key) localStorage.setItem("clutch_api_key", key);
    localStorage.setItem("clutch_llm", JSON.stringify({ model, base_url: llmUrl }));
    // keep the client-side LLM proxy in sync (it reads the local settings file).
    // The knobs ride along with the model here too: this mirror is what a
    // session claim reads back (host-core remoteLlmKnobs), and an omitted knob
    // means "keep the stored one", so a save without them would leave a remote
    // claim forwarding nothing.
    if (window.clutchSettings && window.clutchSettings.save) {
      await window.clutchSettings.save({
        api_key: key,
        model,
        base_url: llmUrl,
        reasoning_effort: payload.reasoning_effort,
        api_protocol: payload.api_protocol,
      });
    }
    return true;
  } catch (e) {
    addEvent({ type: "final", status: "error", summary: "save settings failed: " + e.message });
    return false;
  }
}
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-close").addEventListener("click", closeSettings);
$("#older-pill").addEventListener("click", loadOlder);
dismissOnOverlayPress(modal, closeSettings);

// close only when the press STARTS on the overlay (a drag released outside
// must not close it)
function dismissOnOverlayPress(overlayEl, onClose) {
  overlayEl.addEventListener("mousedown", (e) => {
    if (e.target === overlayEl) onClose();
  });
}

const MODAL_CLOSE_MS = 180;

// animated close: fade the overlay, then land display:none when done
function closeModal(overlayEl, onDone) {
  if (!overlayEl || overlayEl.classList.contains("hidden") || overlayEl.classList.contains("closing")) return;
  const finish = () => {
    // reopened before the animation finished: this stale timer must not hide it
    if (!overlayEl.classList.contains("closing")) return;
    overlayEl.classList.remove("closing");
    overlayEl.classList.add("hidden");
    if (onDone) onDone();
  };
  overlayEl.classList.add("closing");
  if (reducedMotion()) finish();
  else setTimeout(finish, MODAL_CLOSE_MS);
}

// ---- in-page feedback: notice + confirm -------------------------------
// The phone's WebView has no WebChromeClient, so the renderer's own dialogs are
// dead there: alert() is a no-op and confirm() returns false without drawing
// anything. A failure reported only through alert() therefore reads as "my tap
// did nothing" (device report: opening another project from the phone's picker),
// and a question asked through confirm() is always answered "no" (the read-only
// offer, deleting an LLM profile). Both have a real surface here.

// one self-dismissing line at the bottom of the viewport; never intercepts a
// tap, never covers a dialog (z-index below .modal)
let noticeTimer = null;
function notice(message, kind = "error") {
  const el = document.getElementById("notice");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  el.classList.toggle("error", kind === "error");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 8000 : 4000);
}

const confirmModal = $("#confirm-modal");
let confirmResolve = null;
// promise-based: `if (await askConfirm({...})) ...` replaces `if (!confirm(...))`
function askConfirm({ title, text, ok = "OK", cancel = "Cancel" }) {
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = ok;
  $("#confirm-cancel").textContent = cancel;
  confirmModal.classList.remove("hidden", "closing");
  $("#confirm-ok").focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
function closeConfirm(answer) {
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = null; // settle before the close animation: a re-press cannot double-answer
  closeModal(confirmModal);
  resolve(answer);
}
$("#confirm-ok").addEventListener("click", () => closeConfirm(true));
$("#confirm-cancel").addEventListener("click", () => closeConfirm(false));
dismissOnOverlayPress(confirmModal, () => closeConfirm(false));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || confirmModal.classList.contains("hidden")) return;
  closeConfirm(false);
});

// ---- SSH connection (in the project picker) ----
const connSelect = customSelect($("#conn-select"));
const connStatus = $("#conn-status");
// report #2: the tooltip's "go back to the local backend" reads wrong on the
// phone, where no local backend exists to go back to
if (IS_ANDROID) $("#conn-cancel").title = "abort the connection attempt";
const connNewHost = $("#conn-new-host");
const connNewUser = $("#conn-new-user");
const connNewPort = $("#conn-new-port");

const passModal = $("#ssh-pass-modal");
const passInput = $("#ssh-pass-input");
const passLabel = $("#ssh-pass-label");
let passResolve = null;

function sshConns() {
  try {
    return JSON.parse(localStorage.getItem("clutch_ssh_connections") || "[]");
  } catch (e) {
    return [];
  }
}

function upsertConn(host, user, port) {
  const list = sshConns().filter((c) => !(c.host === host && c.user === user && String(c.port) === String(port)));
  list.unshift({ host, user, port: String(port) });
  localStorage.setItem("clutch_ssh_connections", JSON.stringify(list));
  localStorage.setItem("clutch_ssh_host", host);
  localStorage.setItem("clutch_ssh_user", user);
  localStorage.setItem("clutch_ssh_port", String(port));
}

function connLabel(c) {
  return `${c.user}@${c.host}:${c.port}`;
}

function renderConnSelector() {
  const override = localStorage.getItem("clutch_api_url");
  const connected = override && localStorage.getItem("clutch_ssh_connected");
  const cHost = localStorage.getItem("clutch_ssh_host");
  const cUser = localStorage.getItem("clutch_ssh_user");
  const cPort = localStorage.getItem("clutch_ssh_port");
  connSelect.innerHTML = "";
  if (!IS_ANDROID) {
    // report #2: the phone has no local backend, so the desktop-only escape
    // hatch must not appear there at all
    const localOpt = document.createElement("option");
    localOpt.value = "local";
    localOpt.textContent = "Local (this machine)";
    connSelect.appendChild(localOpt);
  }
  // keep the connected host entry selected instead of adding a synthetic URL
  let connectedValue = null;
  for (const c of sshConns()) {
    const label = connLabel(c);
    const isConnected =
      connected && c.host === cHost && c.user === cUser && String(c.port) === String(cPort);
    const opt = document.createElement("option");
    opt.value = "ssh:" + label;
    opt.textContent = isConnected ? label + " ✓" : label;
    connSelect.appendChild(opt);
    if (isConnected) connectedValue = opt.value;
  }
  if (connected) {
    if (connectedValue) {
      connSelect.value = connectedValue;
    } else {
      // connected via a path that didn't save a host: still show user@host:port
      const opt = document.createElement("option");
      opt.value = "ssh:__connected__";
      opt.textContent = cHost
        ? cUser + "@" + cHost + (cPort ? ":" + cPort : "") + " ✓"
        : "SSH: " + override + " ✓";
      connSelect.appendChild(opt);
      connSelect.value = "ssh:__connected__";
    }
  } else if (IS_ANDROID) {
    // report #2: with no Local entry, land the picker on the most recent saved
    // host (display only — connecting still requires the user's change event);
    // nothing saved yet: a placeholder whose "" value the change handler skips
    const saved = sshConns();
    if (saved.length) {
      connSelect.value = "ssh:" + connLabel(saved[0]);
    } else {
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "— add an SSH connection —";
      connSelect.appendChild(ph);
      connSelect.value = "";
    }
  } else {
    connSelect.value = "local";
  }
  connStatus.textContent = connected ? "Connected: " + override : "Using " + API_BASE;
}

// switch the active backend in place without a full page reload
function switchBackend(url) {
  API_BASE = url.replace(/\/+$/, "");
  localStorage.setItem("clutch_api_url", API_BASE);
  reconnectSSE();
}

// ask the main process for the current backend URL; re-apply degrade mode
// to the new session
async function switchBackendResolved() {
  if (!window.clutchApi) return false;
  const url = await window.clutchApi.baseUrl();
  if (url) {
    switchBackend(url);
    await reapplyDegradeIfNeeded();
  }
  return Boolean(url);
}

// degrade mode is a per-process setting that dies with the session: re-apply
// it whenever the session is (re)claimed
async function reapplyDegradeIfNeeded() {
  const raw = localStorage.getItem("clutch_degrade");
  if (!raw || !window.clutchTunnel) return;
  const s = await window.clutchTunnel.status();
  if (!s.active || !s.execBridge) {
    // the tunnel is gone: degrade mode is meaningless, drop the marker
    localStorage.removeItem("clutch_degrade");
    return;
  }
  let bridge = null;
  try {
    bridge = JSON.parse(raw).bridge;
  } catch (e) {
    localStorage.removeItem("clutch_degrade");
    return;
  }
  try {
    await apiFetch("/api/backend", {
      method: "POST",
      body: { mode: "ssh", bridge, workspace: "~" },
    });
  } catch (e) {
    /* best effort: the next re-apply retries */
  }
}

// ---- SSH-tools degradation (host alive but unusable for bootstrap) ----
// local agent, remote exec bridge; true = degraded, false = tunnel dead

async function tryDegradeToSshTools() {
  if (!window.clutchTunnel) return false;
  const s = await window.clutchTunnel.status();
  // degradable only while the tunnel is alive (a dead tunnel has no bridge)
  if (!s.active || !s.execBridge) return false;
  // resolve the current backend first: the main process may have fallen back
  // to a fresh local session
  const url = await window.clutchApi.baseUrl();
  if (!url) return "not running";
  try {
    await apiFetch("/api/backend", {
      method: "POST",
      body: { mode: "ssh", bridge: s.execBridge, workspace: "~" },
      base: url,
    });
  } catch (e) {
    // .status = the backend answered but refused the mode (session gone);
    // no .status = the request itself failed (backend unreachable)
    return e.status ? "not running" : "unreachable";
  }
  // persist the mode: the session process may be re-created later
  localStorage.setItem("clutch_degrade", JSON.stringify({ bridge: s.execBridge }));
  return true;
}

async function resetBackendLocal() {
  try {
    // DEFAULT_BASE, not API_BASE: the local supervisor port answers even while
    // no session has claimed the renderer yet
    await apiFetch("/api/backend", { method: "POST", body: { mode: "local" }, base: DEFAULT_BASE });
  } catch (e) {
    /* the local server may be down; the renderer still falls back in place */
  }
}

// restore the picker's normal browsing state after a connect/disconnect
function refreshPicker() {
  showPickerBody();
  loadDir("", false); // re-list the (new) backend from home; keep the remembered dir
  renderConnSelector();
}

function showPasswordPrompt(label) {
  return new Promise((resolve) => {
    passLabel.textContent = label;
    passInput.value = "";
    passResolve = resolve;
    passModal.classList.remove("hidden", "closing");
    passInput.focus();
  });
}

function closePasswordPrompt() {
  // resolve immediately (the connect flow is waiting); only the visual close animates
  closeModal(passModal);
  if (passResolve) passResolve(null);
  passResolve = null;
}

let connBusy = false; // a connect is in flight: ignore re-clicks
let lastConn = null;  // { host, user, port, statusEl } of the last attempt (Retry)

// collapse the picker body during a connect/failure; only the conn bar remains
function hidePickerBody() {
  $("#fs-body").classList.add("collapsed");
}
function showPickerBody() {
  $("#fs-body").classList.remove("collapsed");
  $("#fs-new").classList.toggle("hidden", fsMode !== "new");
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.add("hidden");
}

let activeConnStatus = null; // status element of the modal currently connecting

// connection progress bar: the tunnel reports coarse stages over IPC
const CONN_STAGES = {
  auth: { pct: 10, label: "Connecting…" },
  probe: { pct: 22, label: "Inspecting remote…" },
  install: { pct: 35, label: "Installing remote server…" },
  "install:upload": { pct: 45, label: "Uploading server…" },
  "install:start": { pct: 70, label: "Starting server…" },
  forward: { pct: 90, label: "Starting tunnel…" },
};
function updateConnProgress(stage) {
  const s = CONN_STAGES[stage];
  if (activeConnStatus) activeConnStatus.textContent = s ? s.label : "Working…";
  for (const bar of [$("#conn-progress"), $("#conn-new-progress")]) {
    if (bar.classList.contains("hidden")) continue;
    const fill = bar.querySelector(".conn-progress-fill");
    if (s) {
      fill.classList.remove("indeterminate");
      fill.style.width = s.pct + "%";
    } else {
      fill.classList.add("indeterminate"); // unknown stage: keep the bar animating
      fill.style.width = "";
    }
  }
}

function setFsConnecting(host, statusEl) {
  activeConnStatus = statusEl;
  statusEl.textContent = "Connecting to " + host + "…";
  hidePickerBody();
  $("#conn-actions").classList.add("hidden");
  // animate the bar under the active modal (the new-connection popup has its own)
  const bar = statusEl && statusEl.id === "conn-new-status" ? $("#conn-new-progress") : $("#conn-progress");
  bar.classList.remove("hidden");
  const fill = bar.querySelector(".conn-progress-fill");
  fill.classList.add("indeterminate");
  fill.style.width = "";
}

function setFsConnectError(msg, statusEl) {
  activeConnStatus = statusEl;
  statusEl.textContent = msg;
  hidePickerBody();
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.remove("hidden"); // offer Retry / Cancel
}

async function handleSshConnect(host, user, port, statusEl) {
  if (!window.clutchTunnel) {
    statusEl.textContent = "SSH requires the desktop app (Electron).";
    return;
  }
  if (connBusy) {
    statusEl.textContent = "connecting…";
    return;
  }
  if (!host || !user) {
    statusEl.textContent = "host and user are required";
    return;
  }
  lastConn = { host, user, port, statusEl }; // Retry re-uses this on failure
  connBusy = true;
  setFsConnecting(host, statusEl); // sets the status text + shows the progress bar
  try {
    // try keys/agent first; only prompt for a password if auth fails
    let res = await window.clutchTunnel.connect({ host, user, port: Number(port) });
    if (!res.ok && res.error && /authentication/i.test(res.error)) {
      const pw = await showPasswordPrompt("Password for " + user + "@" + host);
      if (!pw) {
        setFsConnectError("connection cancelled", statusEl);
        return;
      }
      res = await window.clutchTunnel.connect({ host, user, port: Number(port), password: pw });
    }
    if (res.ok) {
      upsertConn(host, user, port);
      localStorage.setItem("clutch_ssh_connected", "1");
      // the tunnel URL is the supervisor control channel; the API base is the
      // per-window session, decided by the main process
      await switchBackendResolved();
      refreshPicker();
      return true;
    } else {
      // host alive but unbootstrappable: degrade to SSH-tools
      const degraded = await tryDegradeToSshTools();
      if (degraded === true) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        await switchBackendResolved(); // the local server is now remote-backed
        refreshPicker();
        return true;
      }
      // false = tunnel never came up; string = local backend down (the real failure).
      // res.error is the bootstrap verdict (e.g. the pylibs index 404) — never
      // drop it: the bare "unreachable" hid a whole class of supply-line
      // failures behind a symptom.
      setFsConnectError(
        degraded === false
          ? "connection failed: " + (res.error || "could not connect")
          : "SSH connected, but the local agent server is " + degraded +
            (res.error ? " (" + res.error + ")" : ""),
        statusEl
      );
    }
  } catch (e) {
    setFsConnectError("connection failed: " + e.message, statusEl);
  } finally {
    connBusy = false;
  }
}

connSelect.addEventListener("change", async () => {
  const v = connSelect.value;
  if (v === "local") {
    if (localStorage.getItem("clutch_ssh_connected")) {
      await window.clutchTunnel.disconnect();
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
      await resetBackendLocal(); // end any SSH degradation on the local server
      await switchBackendResolved(); // stay in the picker, back to the local backend
      refreshPicker();
    }
    return;
  }
  if (v.startsWith("ssh:") && !v.includes("__connected__")) {
    // switching: drop any current tunnel first, then connect to the new host
    if (localStorage.getItem("clutch_ssh_connected")) {
      await window.clutchTunnel.disconnect();
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade");
    }
    const [user, hostPort] = v.slice(4).split("@");
    const [host, port] = hostPort.split(":");
    await handleSshConnect(host, user, port || "22", connStatus);
  }
});

// new-connection popup (only shown when the user asks to add an SSH host)
const connNewModal = $("#conn-new-modal");
const connNewStatus = $("#conn-new-status");

function openConnNew() {
  connNewHost.value = localStorage.getItem("clutch_ssh_host") || "";
  connNewUser.value = localStorage.getItem("clutch_ssh_user") || "";
  connNewPort.value = localStorage.getItem("clutch_ssh_port") || "22";
  connNewStatus.textContent = "";
  connNewModal.classList.remove("hidden", "closing");
  connNewHost.focus();
}
function closeConnNew() {
  closeModal(connNewModal);
}
$("#conn-new").addEventListener("click", openConnNew);
$("#conn-new-cancel").addEventListener("click", closeConnNew);
$("#conn-new-connect").addEventListener("click", async () => {
  const host = connNewHost.value.trim();
  const user = connNewUser.value.trim();
  const port = connNewPort.value.trim() || "22";
  const ok = await handleSshConnect(host, user, port, connNewStatus);
  if (ok) closeConnNew(); // stay in the picker
});
dismissOnOverlayPress(connNewModal, closeConnNew);
connNewHost.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#conn-new-connect").click();
});
$("#conn-retry").addEventListener("click", () => {
  if (lastConn) handleSshConnect(lastConn.host, lastConn.user, lastConn.port, lastConn.statusEl);
});
$("#conn-cancel").addEventListener("click", async () => {
  localStorage.removeItem("clutch_ssh_connected");
  localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
  resetBackendLocal(); // end any SSH degradation on the local server
  closeConnNew(); // a new-connection attempt may have failed with its modal open
  await switchBackendResolved(); // in-place fallback to the local backend
  refreshPicker();
});
if (window.clutchTunnel && window.clutchTunnel.onProgress) {
  window.clutchTunnel.onProgress(updateConnProgress); // drive the connect progress bar
}
$("#ssh-pass-ok").addEventListener("click", () => {
  const pw = passInput.value;
  closeModal(passModal);
  if (passResolve) passResolve(pw);
  passResolve = null;
});
$("#ssh-pass-cancel").addEventListener("click", closePasswordPrompt);
dismissOnOverlayPress(passModal, closePasswordPrompt);
passInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#ssh-pass-ok").click();
});

// reconcile the stored URL with the tunnel's real state; a live tunnel is
// authoritative, a dead-tunnel leftover falls back to the local backend
async function reconciledBackendUrl() {
  if (!window.clutchTunnel) return null;
  const s = await window.clutchTunnel.status();
  const override = localStorage.getItem("clutch_api_url");
  const flag = localStorage.getItem("clutch_ssh_connected");
  if (s.active) {
    // live tunnel: the main process owns this window's session URL — ask it
    const target = await window.clutchApi.baseUrl();
    if (target && override !== target) {
      localStorage.setItem("clutch_ssh_connected", "1");
      return target;
    }
    return null;
  }
  if (flag) {
    if (IS_ANDROID) {
      // device report #2: "fall back to the local backend" is not a fallback on
      // the phone — there is no agent behind 127.0.0.1, so that branch pointed
      // the app at a dead port while the picker still showed the saved host
      // (the reported "selected SSH client but 127.0.0.1:8891 + connection
      // error"). Keep the flag: it is the user's standing intent, and
      // autoReconnectAndroid() re-establishes the host with it.
      return null;
    }
    // stale SSH leftover: fall back to the local backend via the main process
    localStorage.removeItem("clutch_ssh_connected");
    await switchBackendResolved();
    return null; // switchBackendResolved already switched
  }
  return null;
}

// device report #2: a phone that was on an SSH backend must come back to it.
// Re-entry runs the same path as the user's own connect (keys first, password
// prompt only if the host demands one) instead of leaving the UI pointed at a
// local backend that cannot exist there.
async function autoReconnectAndroid() {
  if (!IS_ANDROID || !window.clutchTunnel) return false;
  // no flag = the user left the picker disconnected on purpose
  if (!localStorage.getItem("clutch_ssh_connected")) return false;
  const host = localStorage.getItem("clutch_ssh_host");
  const user = localStorage.getItem("clutch_ssh_user");
  if (!host || !user) return false;
  const s = await window.clutchTunnel.status().catch(() => null);
  if (s && s.active) return true; // tunnel survived: already the active backend
  const ok = await handleSshConnect(host, user, localStorage.getItem("clutch_ssh_port") || "22", connStatus);
  if (!ok) {
    // never leave the picker claiming a host we are not on
    renderConnSelector();
    connStatus.textContent = "Not connected — " + user + "@" + host + " did not come back.";
  }
  return Boolean(ok);
}

// tunnel died mid-session: fall back to the local backend in place
if (window.clutchTunnel) {
  window.clutchTunnel.onEnd(async () => {
    // the tunnel (and its exec bridge) is gone: any degrade mode dies with it
    localStorage.removeItem("clutch_degrade");
    if (localStorage.getItem("clutch_ssh_connected")) {
      localStorage.removeItem("clutch_ssh_connected");
      resetBackendLocal(); // end any SSH degradation on the local server
      await switchBackendResolved(); // the main process re-claims a local session
      if (!fsModal.classList.contains("hidden")) refreshPicker();
    }
  });
}

// the main process re-established this window's session: point the app at the new URL
if (window.clutchApi && window.clutchApi.onBaseChanged) {
  window.clutchApi.onBaseChanged((url) => {
    if (url) switchBackend(url);
  });
}

// ---- permission confirm ----
const permModal = $("#perm-modal");
let pendingPerm = null;
function openPerm(ev) {
  pendingPerm = ev;
  const reason = permReason(ev.reason);
  $("#perm-tool").textContent = `Tool: ${ev.tool} — ${reason}`;
  const argsEl = $("#perm-args");
  let txt = ev.args_repr || "";
  let isJson = false;
  // the payload is unwrapped generically: a command-shaped one shows as the
  // command the user is being asked about, anything else as formatted JSON
  const cmd = extractCommand(txt);
  if (cmd !== null) txt = "$ " + cmd;
  else { try { txt = JSON.stringify(JSON.parse(txt), null, 2); isJson = true; } catch (e) {} }
  argsEl.textContent = "";
  if (typeof hljs !== "undefined" && isJson) {
    const code = document.createElement("code");
    code.className = "language-json";
    code.textContent = txt;
    argsEl.appendChild(code);
    try { hljs.highlightElement(code); } catch (e) {}
  } else {
    argsEl.textContent = txt;
  }
  permModal.classList.remove("hidden", "closing");
  setStatus("waiting");
  if (trustArmed()) startTrustCountdown(); // armed: the prompt answers itself in 10s
}
function closePerm() {
  // respond immediately (the agent is blocked); only the visual close animates
  stopTrustCountdown(); // any close (allow/deny/stale final) kills the clock
  closeModal(permModal);
  pendingPerm = null;
}
async function respondPerm(allow) {
  if (!pendingPerm) return;
  const ev = pendingPerm;
  closePerm();
  setStatus("running");
  try {
    await apiFetch("/api/permission/respond", {
      method: "POST",
      body: { request_id: ev.request_id, allow },
    });
  } catch (e) {
    // core/permission.py blocks the agent on this verdict and has NO timeout, so a
    // reply the backend never heard hangs the run for good with the prompt already
    // gone. An HTTP answer (e.status) means the backend DID hear about the request
    // — resolved, or no run waiting for it — and then there is nothing to answer;
    // a transport failure means the gate is still waiting: put the prompt back.
    console.error("[permission] verdict not delivered", e);
    if (e && e.status) return;
    openPerm(ev);
  }
}
$("#perm-allow").addEventListener("click", () => respondPerm(true));
$("#perm-deny").addEventListener("click", () => respondPerm(false));

// Enter answers Allow. The agent is BLOCKED on this verdict and this prompt is
// the only way to answer it, so the key a user presses by reflex must be the
// permissive one — and nothing else may answer for them: this modal takes no
// backdrop dismiss (a click outside the box used to mean DENY), so a stray
// press can only ever allow, never reject a permission request.
function permKey(e) {
  if (e.key !== "Enter" || e.isComposing || !pendingPerm) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false; // those are the task box's shortcuts
  e.preventDefault(); // a focused Deny button must not take the key too
  respondPerm(true);
  return true;
}
document.addEventListener("keydown", permKey);

// ---- trust mode: permission prompts auto-allow after a short countdown ----
// UI-side only: the armed flag lives in localStorage, the countdown lives here.
// Expiry takes the same respondPerm(true) path as clicking Allow, so the backend
// sees an ordinary allow; deny / any close / disarm cancels the clock. The clock
// is a plain setTimeout chain (1 tick per second) so a closed prompt is seen on
// the next tick at worst.
const TRUST_COUNTDOWN_S = 10;
let trustTimer = null;

function trustArmed() {
  return localStorage.getItem("clutch_trust_all") === "1";
}

function paintTrustBtn() {
  els.trust.textContent = trustArmed() ? "🛡 Trusted" : "🛡 Trust";
}

function setTrustArmed(on) {
  localStorage.setItem("clutch_trust_all", on ? "1" : "0");
  els.trust.classList.toggle("trust-on", on);
  els.trust.title = on
    ? `trust mode ON — prompts auto-allow after ${TRUST_COUNTDOWN_S}s unless denied. Click to disable.`
    : `trust mode OFF — every prompt waits. Click to auto-allow after ${TRUST_COUNTDOWN_S}s.`;
  paintTrustBtn();
  if (!on) stopTrustCountdown();
  else if (pendingPerm) startTrustCountdown(); // arming mid-prompt starts the clock now
}

function startTrustCountdown() {
  stopTrustCountdown();
  if (!trustArmed() || !pendingPerm) return;
  let left = TRUST_COUNTDOWN_S;
  const allowBtn = $("#perm-allow");
  const tick = () => {
    if (!pendingPerm) return; // prompt closed under a pending tick
    if (left <= 0) {
      respondPerm(true); // same path as clicking Allow (which also closes + resets)
      return;
    }
    allowBtn.textContent = `Allow (${left}s)`;
    left -= 1;
    trustTimer = setTimeout(tick, 1000);
  };
  tick();
}

function stopTrustCountdown() {
  if (trustTimer) {
    clearTimeout(trustTimer);
    trustTimer = null;
  }
  $("#perm-allow").textContent = "Allow";
}

els.trust.addEventListener("click", () => setTrustArmed(!trustArmed()));
setTrustArmed(trustArmed()); // paint the stored state on startup

// ---- workspace tree ----
let lastTreeSig = "";
let treeRefreshTimer = null;

// dotfiles hidden everywhere until the shared toggle turns them on
let showHidden = localStorage.getItem("clutch_show_hidden") === "1";

function updateHiddenToggles() {
  $("#fs-hidden-toggle").checked = showHidden;
  $("#tree-hidden-toggle").checked = showHidden;
}

function toggleHidden() {
  showHidden = !showHidden;
  localStorage.setItem("clutch_show_hidden", showHidden ? "1" : "0");
  updateHiddenToggles();
  // re-list the picker's current dir and the tree with the new visibility
  if (!fsModal.classList.contains("hidden")) loadDir(fsPath);
  refreshTree();
}

$("#fs-hidden-toggle").addEventListener("change", toggleHidden);
$("#tree-hidden-toggle").addEventListener("change", toggleHidden);
updateHiddenToggles();

// ---- phone shell (device reports #2/#3): ONE slide-over panel ----
// 主流 phone clients keep the conversation column clean and park the shell
// behind a single trigger. That panel is #right with a project section on top:
// the three project actions and the workspace tree stack in one drawer instead
// of the project actions sitting alone in a mostly-empty second one. The
// dismissal is a square ✕ at the panel's top edge, so it can never land in the
// middle of a row.
// The project buttons are NOT duplicated: they are MOVED between #topbar and
// #shell-project-actions, so there is exactly one node, one handler and one
// disabled state per action — and a rotation back to the desktop layout moves
// the same nodes home.
const shellBackdrop = $("#shell-backdrop");
const shellPanel = $("#right");
const shellActions = $("#shell-project-actions");
const SHELL_ACTIONS = ["#open-project-btn", "#new-project-btn", "#settings-btn"];
const NARROW_Q = window.matchMedia("(max-width: 640px)");

// paintShellPanel only moves the classes; setShellPanel also owns the history
// entry, so the two must not call each other (see the popstate listener).
function paintShellPanel(open) {
  shellPanel.classList.toggle("drawer-open", open);
  shellBackdrop.classList.toggle("open", open);
}

// The panel is a surface OVER the app, not a page: the phone's back button has
// to dismiss it instead of walking out of the app. The WebView can only see
// history, so opening pushes an entry of our own — exactly what the diagram
// viewer does (a CSS overlay is invisible to MainActivity.onKeyDown).
// A popstate's event.state describes the entry we LANDED on, not the one that
// was popped, so which pop belongs to us is tracked by two flags: the open
// panel owns an entry, and our own history.back() announces itself. Without the
// second flag a stale pop (tapping ✕ and reopening a frame later) would close
// the panel the user just reopened.
let panelHistoryEntry = false; // the open panel owns a history entry
let consumingEntry = false;    // our own history.back() is in flight
function setShellPanel(open) {
  const was = shellPanel.classList.contains("drawer-open");
  paintShellPanel(open);
  if (open === was) return;
  if (open) {
    try {
      history.pushState({ clutchShellPanel: 1 }, "");
      panelHistoryEntry = true;
    } catch (e) {
      panelHistoryEntry = false; // file:// (Electron) refuses pushState: nothing to consume
    }
  } else if (panelHistoryEntry) {
    panelHistoryEntry = false;
    consumingEntry = true;
    try {
      history.back(); // consume our own entry
    } catch (e) {
      consumingEntry = false;
    }
  }
}
function closeShellPanel() {
  setShellPanel(false);
}

window.addEventListener("popstate", () => {
  if (consumingEntry) {
    consumingEntry = false; // the pop we asked for, not the back button
    return;
  }
  if (!panelHistoryEntry) return;
  panelHistoryEntry = false;
  paintShellPanel(false); // the back button dismisses the panel
});

$("#shell-ws-btn").addEventListener("click", () =>
  setShellPanel(!shellPanel.classList.contains("drawer-open"))
);
$("#shell-close-btn").addEventListener("click", closeShellPanel);
shellBackdrop.addEventListener("click", closeShellPanel);
// a panel action opens a modal: step aside as soon as one is clicked (the
// button's own handler runs first, this bubbling listener right after)
shellActions.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("button")) closeShellPanel();
});

function layoutShell() {
  const narrow = NARROW_Q.matches;
  for (const sel of SHELL_ACTIONS) {
    const btn = $(sel);
    if (!btn) continue;
    // back into the topbar BEFORE the ▤ trigger, so the desktop order stays
    // exactly what index.html declares
    if (narrow) shellActions.appendChild(btn);
    else $("#topbar").insertBefore(btn, $("#shell-ws-btn"));
  }
  if (!narrow) closeShellPanel(); // a rotation to the desktop layout drops the panel
}
NARROW_Q.addEventListener("change", layoutShell);
layoutShell();

// file changes only arrive via tool results: debounced refresh, no polling
function scheduleTreeRefresh() {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(refreshTree, 300);
}

async function refreshTree() {
  try {
    const params = new URLSearchParams();
    if (showHidden) params.set("hidden", "1");
    for (const p of expandedDirs) params.append("expanded", p);
    const qs = params.toString() ? "?" + params : "";
    const data = await apiFetch("/api/workspace/tree" + qs);
    if (data.root) els.workspace.textContent = data.root;
    // include expansion state in the signature so a toggle always re-renders
    const sig = JSON.stringify([...expandedDirs]) + "|" + JSON.stringify(data.tree || []);
    if (sig === lastTreeSig) return; // unchanged: keep expansion state
    lastTreeSig = sig;
    els.tree.innerHTML = "";
    for (const node of data.tree || []) els.tree.appendChild(renderNode(node, 0));
  } catch (e) {
    // Never swallow: the view would silently diverge from the disk.
    console.warn("[tree] refresh failed", e);
  }
}

const expandedDirs = new Set();

function renderNode(node, depth) {
  const wrap = document.createElement("div");
  wrap.className = "tree-branch";
  const row = document.createElement("div");
  row.className = "tree-node " + (node.dir ? "dir" : "file");
  row.style.paddingLeft = (depth * 12) + "px";
  const label = node.link ? `${node.name} → ${node.link}` : node.name;
  row.innerHTML =
    `<span class="icon">${node.dir ? "▸" : "·"}</span>` +
    `<span class="name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
  wrap.appendChild(row);
  if (node.dir) {
    const isOpen = expandedDirs.has(node.path);
    const children = document.createElement("div");
    children.className = "tree-children";
    children.style.display = isOpen ? "" : "none";
    if (isOpen) row.querySelector(".icon").textContent = "▾";
    if (isOpen) {
      for (const c of node.children || []) children.appendChild(renderNode(c, depth + 1));
    }
    row.addEventListener("click", (e) => {
      e.stopPropagation(); // don't bubble to ancestor dirs (would collapse them)
      const open = children.style.display !== "none";
      if (open) {
        expandedDirs.delete(node.path);
        children.style.display = "none"; // instant collapse; refresh prunes deep data
        row.querySelector(".icon").textContent = "▸";
      } else {
        expandedDirs.add(node.path);
        row.querySelector(".icon").textContent = "▾";
        // clear first: rapid toggles reuse this element
        children.innerHTML = "";
        // reveal the pre-loaded lookahead level instantly, then fetch deeper
        if (node.children && node.children.length) {
          for (const c of node.children) children.appendChild(renderNode(c, depth + 1));
          children.style.display = "";
        }
      }
      // debounced: rapid toggles coalesce into one fetch; the re-render keeps expansion
      scheduleTreeRefresh();
    });
    // children are siblings of the row, so the row's hover box never covers the subtree
    wrap.appendChild(children);
  }
  return wrap;
}

// ---- SSE live stream + session list ----
let es = null;

// The live stream is the ONLY thing that refreshes `busy` (the running or
// waiting state of the run), so however it dies, the window must not keep
// rendering a cached "running" as if it were live: that is the window stuck on
// thinking with a Stop button that does nothing. The run is fine on the host,
// the pipe to it is not. Three causes, three local answers:
//   * a half-open TCP connection: writes vanish and EventSource NEVER fires
//     onerror. The keepalive of the server is a real named event (see
//     agent/server.py SSE_PING_FRAME), so silence past three of them is proof
//     of death, not a slow run;
//   * a base that is gone (tunnel torn down, session reaped): EventSource
//     retries forever in silence, so the failures are counted instead;
//   * a Stop click that could not be delivered (see stop()).
// Every recovery is announced: a silent one is indistinguishable from a freeze.
const SSE_KEEPALIVE_MS = 15000; // must match agent/server.py SSE_KEEPALIVE_SEC
const SSE_STALE_MS = SSE_KEEPALIVE_MS * 3; // one missed keepalive is not death
const SSE_MAX_ERRORS = 4; // EventSource retries ~3s apart: ~12s of a dead base
let sseLastFrameAt = 0; // last byte the stream actually delivered
let sseErrors = 0; // consecutive failed connects; reset by es.onopen
let sseDown = false; // told once per outage, not once per tick
let sseWatchdog = null;

// any frame (event or keepalive) proves the pipe still carries bytes
function sseFrame() {
  sseLastFrameAt = Date.now();
  sseDown = false;
}

// The stream can no longer be trusted: stop vetoing the buttons of the user,
// and say why. `busy` comes back on its own from the replayed status once a
// stream is live again — the run itself may still be alive on the host.
function sseDegrade(reason) {
  if (sseDown) return;
  sseDown = true;
  if (busy) setStatus("idle");
  notice("lost the live stream (" + reason + ") — reconnecting; the task may still be running");
}

function sseWatchdogTick() {
  if (!API_BASE || !es) return;
  if (Date.now() - sseLastFrameAt < SSE_STALE_MS) return;
  // re-arm first: one report + one reconnect per stale window, not per tick
  sseLastFrameAt = Date.now();
  sseDegrade("no keepalive for " + Math.round(SSE_STALE_MS / 1000) + "s");
  reconnectSSE(false); // the base may have been re-claimed under us
}

function startSseWatchdog() {
  if (sseWatchdog) return; // one timer per window, however many streams it had
  sseWatchdog = setInterval(sseWatchdogTick, 5000);
}

function connectSSE(replay = true) {
  // backend not claimed yet: the main process announces the real URL via
  // backend:base-changed -> switchBackend -> reconnectSSE
  if (!API_BASE) return;
  // INVARIANT: at most one live stream per window. es is module-level and its
  // callers are many (boot, switchBackend, open/new project, base-changed
  // heal); the owner enforces single-stream here, so any call order — e.g. the
  // boot IIFE switching backends before its trailing connect — replaces the
  // old stream instead of leaking a second one (two live streams deliver every
  // event twice: the per-token stutter).
  if (es) es.close();
  // ?project= scopes the stream to this window's .clc; replay=0 right after
  // open/create already rendered the history
  const qs = new URLSearchParams();
  if (currentProject) qs.set("project", currentProject);
  qs.set("replay", replay ? "1" : "0");
  es = new EventSource(API_BASE + "/api/events?" + qs.toString());
  sseFrame(); // the stream is starting: never stale before its first byte
  es.onmessage = (e) => {
    sseFrame();
    // a dropped event silently desyncs the view from the log: never swallow it
    try { addEvent(JSON.parse(e.data)); } catch (err) { console.warn("[sse] undecodable event", err); }
  };
  // the keepalive of the server is a NAMED event, so it arrives here and not
  // in onmessage: the only proof that an idle-but-open socket is still there
  es.addEventListener("ping", sseFrame);
  // on (re)connect the server replays stored history: reset the streaming state
  es.onopen = () => {
    sseErrors = 0;
    sseFrame();
    lastTextEl = null;
    lastTextContent = "";
    thinkingEl = null;
    thinkingContent = "";
    toolGroupEl = null;
    clearRetryNote(); // a reconnect may have skipped the event that would clear it
    if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
    // the backend (re)connected, possibly after a self-heal restart: resync the tree
    refreshTree();
  };
  es.onerror = () => {
    // the browser reconnects on its own, but a base that is GONE retries
    // forever without a word: past a few failures the cached "running" is a
    // claim we can no longer support, so it goes and the button reacts
    sseErrors++;
    if (sseErrors >= SSE_MAX_ERRORS) sseDegrade("the backend did not answer");
  };
  startSseWatchdog();
}

// point the SSE stream at the (possibly new) API_BASE; when es is null (boot
// before the backend resolved) this CREATES the stream — that is exactly the
// late-heal path
function reconnectSSE(replay = true) {
  if (es) es.close();
  connectSSE(replay);
}

let currentProject = ""; // path of the active .clc project file

function clearStream() {
  eventsEl.innerHTML = ""; // clear session content; the overlay/events wrapper stay mounted
  lastTextEl = null;
  lastTextContent = "";
  thinkingEl = null;
  thinkingContent = "";
  if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
  compactionEl = null;
  retryNoteEl = null;
  oldestOffset = null; // fresh project: no loaded events yet
  setOlderPill(0);
}

// ---- scroll-up paging (lazily-opened projects) ----
// olderRemaining mirrors the server's on-disk count, so a dropped page
// never makes the pill lie
let olderRemaining = 0;
let oldestOffset = null; // byte offset of the oldest loaded (rendered) non-task event
let paging = false;   // one history fetch at a time
// when non-null, addEvent appends into this off-DOM sink instead of #events
let pageSink = null;

function setOlderPill(n) {
  olderRemaining = Math.max(0, n | 0);
  const pill = document.getElementById("older-pill");
  if (olderRemaining > 0) {
    pill.classList.remove("hidden");
    const kb = Math.max(1, Math.ceil(olderRemaining / 1024));
    const label = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
    document.getElementById("older-label").textContent =
      `load earlier records (${label})`;
  } else {
    pill.classList.add("hidden");
  }
}

async function loadOlder() {
  if (paging || stream.classList.contains("loading") || !oldestOffset || olderRemaining <= 0) return;
  paging = true;
  try {
    const anchor = eventsEl.firstElementChild; // identity survives the prepend
    const data = await apiFetch(`/api/history?before=${oldestOffset}&limit=262144`, { timeout: 60000 });
    const page = data.events || [];
    if (!page.length) { setOlderPill(0); return; }
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    // render the page through the full replay pipeline into an off-DOM sink,
    // then prepend it in one pass; save/restore live-stream state
    const sink = document.createElement("div");
    sink.style.display = "contents"; // transparent wrapper: children lay out in #events
    const savedLastTextEl = lastTextEl, savedLastTextContent = lastTextContent;
    const savedThinkingEl = thinkingEl, savedThinkingContent = thinkingContent;
    const savedToolGroupEl = toolGroupEl;
    lastTextEl = null; lastTextContent = "";
    thinkingEl = null; thinkingContent = "";
    toolGroupEl = null;
    pageSink = sink;
    try {
      for (const item of page) addEvent(item); // unwrap tracks oldestOffset
    } finally {
      pageSink = null;
      lastTextEl = savedLastTextEl; lastTextContent = savedLastTextContent;
      thinkingEl = savedThinkingEl; thinkingContent = savedThinkingContent;
      toolGroupEl = savedToolGroupEl;
    }
    // typeset AFTER insertion: MathJax needs real layout
    const mathBlocks = Array.from(sink.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
    const frag = document.createDocumentFragment();
    while (sink.firstChild) frag.appendChild(sink.firstChild);
    eventsEl.insertBefore(frag, eventsEl.firstElementChild);
    if (typeof MathJax !== "undefined" && typeof MathJax.typesetPromise === "function") {
      for (const b of mathBlocks) {
        try { await MathJax.typesetPromise([b]); } catch (e) {}
        await new Promise((r) => setTimeout(r, 0)); // repaint between blocks
      }
    }
    // prepending (and typesetting) shifted the content down: re-anchor the view
    if (anchor && anchorTop !== null) {
      stream.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
    setOlderPill(data.older);
  } catch (e) {
    notice("Failed to load earlier records: " + e.message);
  } finally {
    paging = false;
  }
}

function setProjectInfo(info) {
  currentProject = info.project || "";
  els.projectLabel.textContent = info.name || "";
  els.projectLabel.title = currentProject;
  if (info.workdir) els.workspace.textContent = info.workdir;
  // read-only badge: visible only while the active project is read-only
  const badge = document.getElementById("readonly-badge");
  if (badge) badge.classList.toggle("hidden", !info.read_only);
  setStatus("idle");
}

function hideWelcome() {
  document.getElementById("welcome").classList.add("hidden");
  els.run.disabled = busy || !currentProject;
}

async function openProject(path, readOnly = false) {
  // a run keeps the write lock on the project it is appending to; say so out
  // loud instead of swallowing the tap
  if (busy) {
    notice("a run is active — stop it before opening another project");
    return;
  }
  const prog = document.getElementById("open-progress");
  const fill = prog.querySelector(".open-progress-fill");
  const label = prog.querySelector(".open-progress-label");
  const setPct = (pct) => {
    fill.style.width = pct + "%";
    label.textContent = Math.round(pct) + "%";
  };
  try {
    // NOT apiFetch: this endpoint streams NDJSON (meta/progress/event/done), so
    // the body must stay a stream; only the error unwrap below shares apiFetch's
    // contract (Error with .code/.status)
    if (!API_BASE) throw noBackend(); // never fetch "null/api/project/open"
    const r = await fetch(API_BASE + "/api/project/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...(readOnly ? { read_only: true } : {}) }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const e = new Error(err.error || r.status);
      e.code = err.code || null; // e.g. project_open_conflict (HTTP 409)
      throw e;
    }
    clearStream();
    stream.classList.add("loading"); // history reconstruction: no entrance motion
    prog.classList.remove("hidden");
    setPct(0);
    // /api/project/open streams NDJSON: meta, progress, event, done
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let started = false;
    let processed = 0;
    let totalEvents = 0;
    let rendered = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { console.warn("[openProject] undecodable line", e); continue; }
        if (msg.error) {
          const e = new Error(msg.error);
          e.code = msg.code || null;
          throw e;
        }
        if (msg.meta) {
          setProjectInfo({
            project: msg.meta.project,
            name: msg.meta.name,
            workdir: msg.meta.workdir,
            read_only: !!msg.meta.read_only,
          });
          hideWelcome();
          started = true;
        } else if (msg.count) {
          totalEvents = msg.count;
          // lazy open: "older" = durable records still on disk before the loaded tail
          if (typeof msg.older === "number") setOlderPill(msg.older);
        } else if (msg.progress && msg.progress.total) {
          // phase A: server file parse maps to the first 50% of the bar
          setPct(50 * msg.progress.done / msg.progress.total);
        } else if (msg.event) {
          // {offset, event}: addEvent unwraps and tracks the oldest loaded offset
          addEvent(msg);
          // phase B: client rendering of the events maps to 50-90%
          if (totalEvents) setPct(50 + 40 * (++rendered / totalEvents));
        }
        // yield periodically so the browser paints the bar and streams events progressively
        if (++processed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    // phase C: typeset replayed math as the remaining 90-100%
    await typesetProgressively(eventsEl, (f) => setPct(90 + 10 * f));
    if (started) setPct(100);
    prog.classList.add("hidden");
    stream.classList.remove("loading"); // instant reveal — no fade, no replay
    stream.scrollTop = stream.scrollHeight; // jump straight to the end of the record
    // re-scope the live stream to the new project; replay=0 (history already rendered)
    reconnectSSE(false);
    refreshTree();
  } catch (e) {
    prog.classList.add("hidden");
    stream.classList.remove("loading");
    // same project open for write in another window: offer read-only instead of failing
    if (e && e.code === "project_open_conflict") {
      const wantReadOnly = await askConfirm({
        title: "Already open elsewhere",
        text:
          "This project is already open in another window.\n" +
          "Open it read-only? Read-only mode cannot run tasks.",
        ok: "Open read-only",
      });
      if (wantReadOnly) {
        await openProject(path, true); // retry without the write lock
        return;
      }
      return; // cancelled: keep the previous project as-is
    }
    notice("Failed to open project: " + e.message);
    // a network "Failed to fetch" usually means the remote session forward died
    console.error("[openProject] failed:", { api: API_BASE, path, error: e && e.message });
  }
}

async function createProject(dir, name) {
  if (busy) {
    notice("a run is active — stop it before creating a project");
    return;
  }
  try {
    const data = await apiFetch("/api/project/new", { method: "POST", body: { dir, name } });
    clearStream();
    setProjectInfo(data);
    hideWelcome();
    reconnectSSE(false); // new empty project: nothing to replay, just live events
    refreshTree();
  } catch (e) {
    notice("Failed to create project: " + e.message);
  }
}

// ---- server file browser (unified open/new on the backend's filesystem) ----
const fsModal = $("#fs-modal");
let fsMode = "open";
let fsPath = "";
let fsParent = null;

function openFsBrowser(mode) {
  if (busy) {
    notice("a run is active — stop it before opening another project");
    return;
  }
  fsMode = mode;
  fsPath = "";
  fsParent = null;
  $("#fs-title").textContent = mode === "new" ? "New project" : "Open project";
  $("#fs-create").classList.toggle("hidden", mode !== "new");
  $("#fs-name-input").value = "";
  showPickerBody(); // normal browsing: path bar + file list + (new-project area)
  $("#fs-up").disabled = false;
  $("#fs-go").disabled = false;
  $("#fs-path-input").disabled = false;
  fsModal.classList.remove("hidden", "closing");
  // settle the stored URL against the tunnel's real state first, then list once
  reconciledBackendUrl()
    .catch((e) => {
      // an unreachable bridge must not leave the dialog empty with no word: say
      // so and fall through, so the local listing still has a chance to appear
      notice("could not reach the backend: " + (e && e.message ? e.message : e));
      return null;
    })
    .then(async (url) => {
      if (url) switchBackend(url);
      // reopen where the user last left the browser instead of the home directory
      loadDir(localStorage.getItem("clutch_fs_last_dir") || "");
      renderConnSelector();
      await autoReconnectAndroid(); // report #2: bring the remembered host back
    });
}

function closeFsBrowser() {
  closeModal(fsModal);
}

// Row activation is DELEGATED to #fs-list and keyed to pointerup, not to a
// per-row click listener. Why: a background re-list replaces every row (the
// phone's remembered SSH backend arriving a moment after the dialog opened
// re-fetches the directory), and a click whose mousedown target has been
// removed from the document is never dispatched at all — the tap does nothing
// at all, silently (device report: "opening another project on the phone does
// nothing"). pointerup still fires and still reaches the list, so the tap lands
// on whatever row is under the finger when it is released.
const fsRowActions = new WeakMap(); // row element -> its activation (no leak: keyed by the row)
const TAP_SLOP_PX = 10; // a press that travels farther than this is a scroll, not a tap
let fsPress = null;
let fsActivatedRow = null; // row already activated by the pointer path

function fsTappableRowAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const row = el && el.closest ? el.closest(".fs-row") : null;
  return row && fsRowActions.has(row) ? row : null;
}

function fsRow(label, cls, onClick) {
  const row = document.createElement("div");
  row.className = "fs-row " + cls;
  row.textContent = label;
  if (onClick) {
    fsRowActions.set(row, onClick);
    // The click listener is kept for what the pointer path cannot serve: a
    // synthetic click (assistive tech, a test, a WebView without Pointer Events)
    // has no pointerdown/up to pair with. A real tap produces both, in that
    // order, so the trailing click of an already-activated row is dropped —
    // without this the conflict offer would be asked twice for one tap.
    row.addEventListener("click", () => {
      if (fsActivatedRow === row) {
        fsActivatedRow = null; // this click IS the pointerup above: not a second tap
        return;
      }
      onClick();
    });
  }
  return row;
}
$("#fs-list").addEventListener("pointerdown", (e) => {
  fsPress = fsTappableRowAt(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
});
$("#fs-list").addEventListener("pointerup", (e) => {
  const press = fsPress;
  fsPress = null;
  if (!press) return;
  if (Math.abs(e.clientX - press.x) > TAP_SLOP_PX || Math.abs(e.clientY - press.y) > TAP_SLOP_PX) return;
  const row = fsTappableRowAt(e.clientX, e.clientY);
  if (!row) return;
  fsActivatedRow = row; // ...so the click that follows is ignored
  fsRowActions.get(row)();
});
// the browser cancels the pointer when the gesture turns into a scroll
$("#fs-list").addEventListener("pointercancel", () => {
  fsPress = null;
});

// wait for the backend to be claimed (cold start: supervisor spawn + session
// child boot take a few seconds) so a click during that window just works
// instead of telling the user to close and re-click
function waitBackend(ms = 20000) {
  if (API_BASE) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (API_BASE || Date.now() - t0 >= ms) {
        clearInterval(iv);
        resolve(Boolean(API_BASE));
      }
    }, 200);
  });
}

async function loadDir(path, remember = true) {
  const listEl = $("#fs-list");
  if (!API_BASE) {
    // backend not claimed yet (supervisor mid-spawn): show progress and pick
    // the listing up automatically the moment the session is up
    listEl.innerHTML = '<div class="fs-row plain">connecting to backend…</div>';
    if (!(await waitBackend())) {
      listEl.innerHTML = '<div class="fs-row error-row">backend did not come up — close this dialog and retry</div>';
      return;
    }
  }
  listEl.innerHTML = '<div class="fs-row plain">loading…</div>';
  try {
    const data = await apiFetch(
      "/api/fs/list?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "")
    );
    fsPath = data.path;
    fsParent = data.parent;
    // remember the last browsed directory (re-lists pass remember=false)
    if (remember) localStorage.setItem("clutch_fs_last_dir", fsPath);
    $("#fs-path-input").value = data.path;
    listEl.innerHTML = "";
    if (data.parent) {
      listEl.appendChild(fsRow(".. (up)", "dir", () => loadDir(data.parent)));
    }
    for (const e of data.entries) {
      const label = e.link ? e.name + " → " + e.link : e.name;
      if (e.dir) {
        listEl.appendChild(fsRow(label, "dir", () => loadDir(e.path)));
      } else if (e.name.endsWith(".clc") && fsMode === "open") {
        listEl.appendChild(
          fsRow(label, "file clc", () => {
            closeFsBrowser();
            openProject(e.path);
          })
        );
      } else {
        listEl.appendChild(fsRow(label, "file plain"));
      }
    }
    if (!listEl.children.length) listEl.appendChild(fsRow("(empty)", "plain"));
  } catch (e) {
    // a remembered last directory may be gone: forget it and retry from home once
    const remembered = localStorage.getItem("clutch_fs_last_dir");
    if (remembered && path === remembered) {
      localStorage.removeItem("clutch_fs_last_dir");
      loadDir("");
      return;
    }
    listEl.innerHTML = "";
    listEl.appendChild(
      fsRow(
        "Cannot reach backend at " + API_BASE + " (" + (e.message || e) + "). Reconnect SSH or check the backend URL.",
        "error-row"
      )
    );
    if (!IS_ANDROID) {
      // report #2: there is no local backend to reset to on the phone
      listEl.appendChild(
        fsRow("Reset to local backend", "action", async () => {
          localStorage.removeItem("clutch_ssh_connected");
          localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
          await switchBackendResolved();
          refreshPicker();
        })
      );
    }
  }
}

$("#fs-cancel").addEventListener("click", closeFsBrowser);
$("#fs-up").addEventListener("click", () => {
  if (fsParent) loadDir(fsParent);
});
$("#fs-go").addEventListener("click", () => loadDir($("#fs-path-input").value.trim()));
$("#fs-path-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadDir($("#fs-path-input").value.trim());
});
$("#fs-create").addEventListener("click", () => {
  const name = $("#fs-name-input").value.trim();
  if (!name || !fsPath) return;
  closeFsBrowser();
  createProject(fsPath, name);
});
dismissOnOverlayPress(fsModal, closeFsBrowser);

$("#new-project-btn").addEventListener("click", () => openFsBrowser("new"));
$("#open-project-btn").addEventListener("click", () => openFsBrowser("open"));
$("#welcome-new").addEventListener("click", () => openFsBrowser("new"));
$("#welcome-open").addEventListener("click", () => openFsBrowser("open"));

// the flat LLM config this UI would mirror to ~/.clutch/settings.json, read
// from localStorage (the UI's own source of truth); null when nothing stored.
// Active profile first, then the legacy clutch_llm + clutch_api_key pair.
function storedLlmConfig() {
  try {
    const active = localStorage.getItem("clutch_llm_active");
    const profiles = JSON.parse(localStorage.getItem("clutch_llm_profiles") || "{}");
    const p = active && profiles[active];
    if (p && (p.base_url || p.model || p.api_key)) {
      return {
        base_url: p.base_url || "",
        model: p.model || "",
        api_key: p.api_key || "",
        reasoning_effort: p.reasoning_effort || "",
        api_protocol: p.api_protocol || "",
      };
    }
  } catch (e) {}
  try {
    const legacy = JSON.parse(localStorage.getItem("clutch_llm") || "null");
    const key = localStorage.getItem("clutch_api_key") || "";
    if (legacy && (legacy.base_url || legacy.model || key)) {
      return {
        base_url: legacy.base_url || "",
        model: legacy.model || "",
        api_key: key,
        reasoning_effort: "",
        api_protocol: "",
      };
    }
  } catch (e) {}
  return null;
}

// rebuild the settings.json mirror if it went missing while the UI still has
// the config (fire-and-forget: the next session spawn / proxy request needs it)
function healSettingsMirror() {
  const cfg = storedLlmConfig();
  if (!cfg) return; // nothing stored: nothing to heal from
  if (window.clutchSettings && window.clutchSettings.ensure) {
    window.clutchSettings.ensure(cfg).catch(() => {});
  }
}

// the host's own default `ui` block: fetched once at boot, before the first
// row is drawn, so the host's document (host.json) speaks through every event
// that carries no `ui` of its own. Best effort in both directions: an older
// host without the endpoint, or any fetch failure, leaves the compiled-in
// constants standing -- the renderer never waits on the network to draw.
async function loadHostDefaults() {
  try {
    const data = await apiFetch("/api/host");
    if (data && data.ui) hostUiDefaults = data.ui;
  } catch (e) {} // constants remain the fallback
}

// settle the stored URL before connecting SSE; connectSSE is idempotent, so a
// switch inside reconciledBackendUrl (stale-SSH fallback, tunnel target) plus
// the trailing call still leaves exactly one live stream
(async () => {
  await resolveApiBase(); // learn this window's session port (IPC) first
  await loadHostDefaults(); // the host's own ui block, before any row is drawn
  healSettingsMirror();
  const url = await reconciledBackendUrl();
  if (url) switchBackend(url);
  connectSSE();
  // report #2: bring the phone's remembered SSH backend back in the background.
  // Fire-and-forget: the UI is live either way, and a successful reconnect
  // switches the base (and thus the SSE stream) in place.
  autoReconnectAndroid();
})();
