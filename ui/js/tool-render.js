// the component `ui` protocol — how a tool CALL and its RESULT are drawn
//
// The host renders tool events it did not design, so NO TOOL NAME appears here:
// every event carries the declaration its own component made, and the vocabulary
// below IS the abstraction of the forms this UI has always drawn. The normative
// description of that protocol is the header of agent/tools/catalog.py.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

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

