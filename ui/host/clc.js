// The .clc byte format and the window-based lazy log, on the far-root host.
//
// Ported from `agent/core/lazy.py` (the window) and `agent/project/format.py`
// (the bytes). Nothing here rewrites the format: a .clc written by deployment
// A/C must open here, and one written here must open there, so every offset in
// this file is a BYTE offset and every line is LF-terminated.
//
// Three things the format guarantees, and why this file is written the way it is:
//
//   1. The header's `cpr_start=0000000000` line is FIXED-WIDTH (20 bytes + LF).
//      Its absolute offset is therefore the same in every file for that meta,
//      and a compaction slides the model window with ONE in-place write
//      (`setCprStart`) instead of rewriting the file — which is what keeps every
//      event's stored offset valid forever.
//   2. The model's context is the WINDOW `[cpr_start, file_end)`: the newest
//      compaction line's start to the end, and only that. Opening materializes
//      it with one range read; earlier history stays on disk and is paged by the
//      UI (`readPage`), which never touches the resident log.
//   3. Every read is positioned (`readRange`), never a full scan: opening a big
//      .clc over SSH moves the header plus the window, nothing else.
//
// DELIBERATE DIVERGENCES from the Python source, all of them narrow:
//
//   - a line whose `type` is not one of the fourteen event types is SKIPPED here,
//     where `events.event_from_dict` raises and breaks the open. A host must not
//     be crashed by a line it does not know; the window then holds the events it
//     does know, which is the same answer the string parser (`parse_durable`)
//     already gives.
//   - a `timestamp` is written as Python's repr of a float (`1700000000.0`); a
//     non-integral float that Python would print with an exponent (`1e-07`) is
//     printed by JavaScript's shortest round-trip instead (`1e-7`). Timestamps
//     are epoch seconds, so this is unreachable for the field that exists.
//   - `parseDurable` splits text on LF only; Python's `str.splitlines()` also
//     splits on CR / U+2028 / VT / FF. The file is LF-terminated by contract
//     (see `appendLine` in fs.js), so those separators cannot appear.
//
// What this file does NOT do: open a .clc on the host's OWN filesystem. The
// workspace seam is the only way in (plan §7, ban X1) — there is no local-root
// capability here for the third implementation to grow into. `createProject` and
// `openProject` both refuse to run without a workspace.

"use strict";

// The lexical POSIX dirname and the two error classes are fs.js's own: the API
// layer catches `error instanceof ValueError` against THAT class, so a second
// copy here would make an escape or a bad event look like a crash.
const { dirname, ValueError, OSError, FileNotFoundError } = require("./fs");

// The field order of every event (agent/events.py), and its defaults. Order is
// contract: `json.dumps(asdict(event))` writes the dataclass's field order, so
// this table is what makes a re-appended event byte-identical to the Python one.
const EVENT_DEFAULTS = {
  user_message: { content: "" },
  step_start: {},
  text_delta: { content: "" },
  reasoning_delta: { content: "" },
  assistant_message: { content: "", tool_calls: [], reasoning: "" },
  tool_call: { name: "", arguments: "", tool_call_id: "", ui: {}, path_arg: "" },
  tool_call_delta: { tool_call_id: "", name: "", delta: "", ui: {} },
  tool_result: { tool_call_id: "", content: "", is_error: false, diff: "" },
  state_update: { key: "execution_status", value: "" },
  final: { status: "", summary: "" },
  permission_request: { request_id: "", tool: "", args_repr: "", reason: "" },
  compaction: { summary: "" },
  compaction_delta: { chars: 0, done: false, note: "" },
  llm_retry: { attempt: 0, max_retries: 0, discard: false, message: "" },
};

// `agent/events.py: DURABLE_TYPES` — the six that persist to .clc. Streaming
// deltas never touch disk, and a transient line found in a file is not an event.
const DURABLE_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "final",
  "compaction",
]);

const HEADER_PREFIX = "# clutch project v1";
const SEPARATOR = "---"; // the .clc header separator
// The marker the retired project-memory store wrote above its lines. Nothing
// writes it any more, but an older .clc still carries it, and such a line would
// otherwise be read as an event if it happened to parse as JSON.
const SECTION = "[memories]";

const CPR_START_PREFIX = "cpr_start=";
const CPR_START_FIELD_W = 10; // ~10 GB of event region
const CPR_START_LINE_W = CPR_START_PREFIX.length + CPR_START_FIELD_W; // 20 bytes, no LF
const CPR_START_LINE_BYTES = CPR_START_LINE_W + 1; // 21 with its newline

// The exact prefix a compaction line starts with: `json.dumps` writes
// `{"type": "compaction", ...` (default separators), and a migrated file's
// cpr_start must point at such a line (format.py: _last_compaction_rel).
const COMPACTION_PREFIX = '{"type": "compaction"';

// How far back a history page may be widened to open on a turn boundary
// (lazy.py: ALIGN_REACH). A turn bigger than this is left split: one page must
// never become the whole history.
const ALIGN_REACH = 4 * 1024 * 1024;

const NL = 0x0a;

// ---- Python's json.dumps, byte for byte ----------------------------------
//
// `event_to_json` is `json.dumps(asdict(event), ensure_ascii=False)`: default
// separators (", " and ": "), key order = the dataclass's field order, and a
// float printed by repr (so an integral epoch gets its ".0"). JSON.stringify
// differs in all three, and the result is a .clc offset, so this is spelled out
// rather than approximated.
//
// `ascii` is json.dumps' `ensure_ascii=True` (the default the SSE encoder uses
// for a WRAPPED payload and for a raw announcement — see ui/host/events.js): a
// code point above "~" is escaped, an astral one as its surrogate pair, exactly
// as CPython's ESCAPE_ASCII does; 0x7f included. The .clc writer never sets it.

function quoteString(text, ascii = false) {
  let out = '"';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (ascii && code > 0x7e) {
      if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
      else {
        const pair = code - 0x10000;
        out += `\\u${(0xd800 + (pair >> 10)).toString(16)}`;
        out += `\\u${(0xdc00 + (pair & 0x3ff)).toString(16)}`;
      }
    } else out += ch;
  }
  return `${out}"`;
}

// Python repr of a float for integral values is "1700000000.0"; every other
// number in an event is an int (counts, flags) and prints as digits.
function numberText(value, asFloat) {
  if (!Number.isFinite(value)) return "null";
  if (asFloat && Number.isInteger(value)) return value.toFixed(1);
  return String(value);
}

function dumps(value, asFloat = false, ascii = false) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return numberText(value, asFloat);
  if (typeof value === "string") return quoteString(value, ascii);
  if (Array.isArray(value)) return `[${value.map((item) => dumps(item, false, ascii)).join(", ")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return `{${keys.map((key) => `${quoteString(key, ascii)}: ${dumps(value[key], false, ascii)}`).join(", ")}}`;
  }
  return "null";
}

// ---- events --------------------------------------------------------------

function newId() {
  return require("crypto").randomBytes(6).toString("hex");
}

// `events.event_from_dict`: unknown keys DROPPED, missing ones defaulted, and
// the key order reset to the declaration's. Both matter: the normalized object
// is what `eventToJson` writes, so a re-appended event always serializes to the
// same bytes the Python host would have written.
function eventFromDict(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ValueError("event is not an object");
  const type = String(data.type || "");
  const spec = EVENT_DEFAULTS[type];
  if (!spec) throw new ValueError(`unknown event type: ${data.type}`);
  const out = {
    type,
    timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now() / 1000,
    id: data.id == null ? newId() : String(data.id),
  };
  for (const field of Object.keys(spec)) {
    const value = data[field];
    if (value !== undefined) {
      out[field] = value;
      continue;
    }
    const fallback = spec[field];
    out[field] = Array.isArray(fallback) ? [] : fallback && typeof fallback === "object" ? {} : fallback;
  }
  return out;
}

// `events.event_to_json`. `options.ascii` is json.dumps' default
// `ensure_ascii=True`, which the SSE encoder uses for a wrapped payload (see
// ui/host/events.js); the .clc writer never sets it, because the line's bytes
// are the offset contract.
function eventToJson(event, options = {}) {
  const ascii = Boolean(options && options.ascii);
  const normal = eventFromDict(event);
  const parts = [
    `${quoteString("type", ascii)}: ${quoteString(normal.type, ascii)}`,
    `${quoteString("timestamp", ascii)}: ${numberText(normal.timestamp, true)}`,
    `${quoteString("id", ascii)}: ${quoteString(normal.id, ascii)}`,
  ];
  for (const field of Object.keys(EVENT_DEFAULTS[normal.type])) {
    parts.push(`${quoteString(field, ascii)}: ${dumps(normal[field], false, ascii)}`);
  }
  return `{${parts.join(", ")}}`;
}

// `events._line_bytes`: the unit the durable offsets are accumulated in.
function lineBytes(event) {
  return Buffer.byteLength(`${eventToJson(event)}\n`, "utf8");
}

// ---- byte helpers --------------------------------------------------------

function startsWithAscii(buffer, text) {
  const bytes = Buffer.from(text, "utf8");
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buffer[i] !== bytes[i]) return false;
  return true;
}

function stripBytes(buffer) {
  let start = 0;
  let end = buffer.length;
  const space = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
  while (start < end && space.has(buffer[start])) start += 1;
  while (end > start && space.has(buffer[end - 1])) end -= 1;
  return buffer.subarray(start, end);
}

function stripLeftBytes(buffer) {
  let start = 0;
  while (start < buffer.length && [0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d].includes(buffer[start])) start += 1;
  return buffer.subarray(start);
}

function lastIndexOfAscii(buffer, text) {
  const bytes = Buffer.from(text, "utf8");
  return buffer.lastIndexOf(bytes);
}

// Iterate the LF-separated segments of `data` as [segment, byteOffset].
function segments(data, visit) {
  let pos = 0;
  let start = 0;
  for (let at = 0; at <= data.length; at += 1) {
    if (at < data.length && data[at] !== NL) continue;
    const seg = data.subarray(start, at);
    visit(seg, pos);
    pos += seg.length + 1; // BYTES, exact — this is what makes offsets exact
    start = at + 1;
  }
}

// ---- parsing -------------------------------------------------------------

// `core.lazy.parse_durable`: raw .clc TEXT -> durable events, robust to the
// file's formatting quirks (BOMs, blank lines, separator lines).
function parseDurable(text) {
  const out = [];
  for (let line of String(text).split("\n")) {
    line = line.trim().replace(/^\ufeff+/, "");
    if (!line || line.startsWith(SEPARATOR) || line.startsWith(SECTION)) continue;
    let data;
    try {
      data = JSON.parse(line);
    } catch (error) {
      continue; // a corrupt/mangled line is not an event
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || !("type" in data)) continue;
    let event;
    try {
      event = eventFromDict(data);
    } catch (error) {
      continue;
    }
    if (DURABLE_TYPES.has(event.type)) out.push(event);
  }
  return out;
}

// `core.lazy._parse_with_offsets`: a byte RANGE -> [relative_offset, event]
// pairs. A range cut mid-line yields a mangled first/last line, which is dropped
// (JSON fails). Splitting on raw BYTES keeps offsets exact across multibyte
// characters, which is why this never goes through a decoded string first.
function parseWithOffsets(raw, baseRel = 0) {
  let data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || "");
  if (data.length && data[data.length - 1] !== NL) {
    // drop the trailing line the range cut (Python: raw.rsplit(b"\n", 1)[0] — a
    // range with no newline at all is left whole and dropped by the JSON parse)
    const cut = data.lastIndexOf(NL);
    data = cut < 0 ? data : data.subarray(0, cut);
  }
  const out = [];
  segments(data, (seg, pos) => {
    if (!seg.length) return;
    if (startsWithAscii(seg, SEPARATOR) || startsWithAscii(seg, SECTION)) return;
    const line = seg.toString("utf8");
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return; // mangled first line (range start mid-line) or a corrupt line
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("type" in parsed)) return;
    let event;
    try {
      event = eventFromDict(parsed);
    } catch (error) {
      return;
    }
    if (!DURABLE_TYPES.has(event.type)) return;
    out.push([baseRel + pos, event]);
  });
  return out;
}

// ---- the header (project/format.py) --------------------------------------

function cprStartLine(offset) {
  return `${CPR_START_PREFIX}${String(Math.trunc(offset)).padStart(CPR_START_FIELD_W, "0")}`;
}

function headerText(meta = {}, cprStart = 0) {
  return (
    [
      HEADER_PREFIX,
      `name: ${meta.name || ""}`,
      `model: ${meta.model || ""}`,
      cprStartLine(cprStart),
      SEPARATOR,
    ].join("\n") + "\n"
  );
}

// Absolute offset of the fixed-width cpr_start line — the compaction's in-place
// write target. Derived from the meta, so it is stable for the file's lifetime.
function cprLineOffset(meta = {}) {
  return (
    Buffer.byteLength(`${HEADER_PREFIX}\n`, "utf8") +
    Buffer.byteLength(`name: ${meta.name || ""}\n`, "utf8") +
    Buffer.byteLength(`model: ${meta.model || ""}\n`, "utf8")
  );
}

// `format._event_region_start`: absolute byte offset of the first durable event
// line, or — for a header-only file — the byte right after the separator. Every
// other header line is passed over: a legacy `memory_index=`, a `[memories]`
// marker, the separator itself.
function eventRegionStart(head) {
  const data = Buffer.isBuffer(head) ? head : Buffer.from(head || "");
  let pos = 0;
  let found = -1;
  segments(data, (seg, at) => {
    if (found >= 0) return;
    const stripped = stripBytes(seg);
    if (stripped.length && !startsWithAscii(stripped, SEPARATOR)) {
      let parsed = null;
      try {
        parsed = JSON.parse(seg.toString("utf8"));
      } catch (error) {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && DURABLE_TYPES.has(parsed.type)) {
        found = at;
        return;
      }
    }
    pos = at + seg.length + 1;
  });
  if (found >= 0) return found;
  const sep = lastIndexOfAscii(data, SEPARATOR);
  if (sep >= 0) return sep + SEPARATOR.length + 1;
  return pos;
}

// `format._find_cpr_line`: absolute offset of the header's cpr_start line, or
// null for a file without one (a legacy .clc, whose window is then derived from
// its newest compaction line).
function findCprLine(head) {
  const data = Buffer.isBuffer(head) ? head : Buffer.from(head || "");
  let found = null;
  segments(data, (seg, at) => {
    if (found !== null) return;
    if (startsWithAscii(seg, CPR_START_PREFIX)) found = at;
  });
  return found;
}

function parseCprStart(line) {
  const text = String(line == null ? "" : line);
  if (!text.startsWith(CPR_START_PREFIX)) return 0;
  const value = text.slice(CPR_START_PREFIX.length).trim();
  if (!/^[+-]?\d+$/.test(value)) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

// `format._last_compaction_rel`: relative offset of the LAST compaction line in
// the event region (0 = never compacted) — the boundary a legacy file's window
// start must point at.
function lastCompactionRel(raw, base = 0) {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || "");
  let last = 0;
  segments(data, (seg, pos) => {
    if (!startsWithAscii(stripLeftBytes(seg), COMPACTION_PREFIX)) return;
    const offset = pos - base;
    if (offset >= 0) last = offset;
  });
  return last;
}

// `format._read_line_at`: the single line starting at byte `offset` (a
// fixed-width header line: at most `width` bytes, never past the file end).
async function readLineAt(read, offset, total, width) {
  const raw = await read(offset, Math.min(offset + width + 4, total));
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || "");
  const cut = data.indexOf(NL);
  return (cut < 0 ? data : data.subarray(0, cut)).toString("utf8");
}

function applyMeta(meta, line) {
  if (!line.startsWith("#") && line.includes(":")) {
    const at = line.indexOf(":");
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === "name") meta.name = value;
    else if (key === "model") meta.model = value;
  }
}

function parseMetaLines(lines) {
  const meta = { name: "", model: "" };
  for (const raw of lines || []) {
    const line = String(raw).trim();
    if (line === SEPARATOR) break;
    applyMeta(meta, line);
  }
  return meta;
}

// ---- the lazy log (core/lazy.py) -----------------------------------------

class LazyEventLog {
  constructor(options = {}) {
    this.path = String(options.path || "");
    this.base = Number(options.base || 0); // absolute: the event region's start
    this.writer = options.writer || null; // (path, line) -> void
    this.writeAt = options.writeAt || null; // in-place header write; null = read-only
    this.cprLineOff = Number(options.cprLineOff || 0); // absolute offset of the cpr_start line
    this._read = options.read || (async () => Buffer.alloc(0));
    this._bytes = Number(options.total || 0); // grows as events append
    this._events = [];
    this._offsets = []; // parallel: relative byte offsets (unique)
    this._cprStart = 0; // window start (relative): the newest compaction line's start
  }

  // One open = the header (already read by the caller) plus ONE range read (the
  // window). Everything earlier than cpr_start stays on disk.
  static async open(options = {}) {
    const log = new LazyEventLog(options);
    await log.materialise(options.cprStart == null ? 0 : options.cprStart);
    return log;
  }

  // An in-memory log: no file, no persistence. The Agent's default when no
  // project is open, and the scratch log for tests.
  static memory() {
    return new LazyEventLog({ path: "", read: async () => Buffer.alloc(0), total: 0, base: 0 });
  }

  async materialise(storedCprStart = 0) {
    const regionLen = this._bytes - this.base;
    // clamp a stale/out-of-range cpr_start to 0 — never lose a compaction summary
    const stored = Number.isInteger(storedCprStart) ? storedCprStart : 0;
    this._cprStart = stored >= 0 && stored <= regionLen ? stored : 0;
    // legacy file (no cpr_start line): derive the boundary from the newest
    // compaction line, else every open would re-summarize the whole history
    if (!this.cprLineOff && regionLen > 0) {
      const whole = await this._read(this.base, this._bytes);
      this._cprStart = lastCompactionRel(whole, 0);
    }
    const window = await this._read(this.base + this._cprStart, this._bytes);
    for (const [offset, event] of parseWithOffsets(window, this._cprStart)) {
      this._events.push(event);
      this._offsets.push(offset);
    }
  }

  // Append one durable event: its offset is stamped on the event (so a LIVE SSE
  // frame carries the same {offset, event} shape a replay does) and the line goes
  // to disk through the workspace. A transient event is never appended.
  async append(event) {
    if (!DURABLE_TYPES.has(event && event.type)) return event;
    const offset = this._bytes - this.base;
    this._events.push(event);
    this._offsets.push(offset);
    event.logOffset = offset;
    this._bytes += lineBytes(event);
    if (this.path) {
      if (!this.writer) throw new OSError(`no writer for ${this.path}`);
      await this.writer(this.path, eventToJson(event));
    }
    return event;
  }

  events() {
    return this._events.slice(); // the materialized window, in file order
  }

  items() {
    return this._offsets.map((offset, at) => [offset, this._events[at]]);
  }

  get cprStart() {
    return this._cprStart;
  }

  get windowBytes() {
    return this._bytes - this.base - this._cprStart;
  }

  lastCompaction() {
    for (let at = this._events.length - 1; at >= 0; at -= 1) {
      if (this._events[at].type === "compaction") return this._events[at];
    }
    return null;
  }

  // Slide the window start and persist it in the header's FIXED-WIDTH line. The
  // in-place write keeps every other offset in the file stable; a read-only or
  // headerless file keeps the boundary in memory only.
  async setCprStart(offset) {
    const regionLen = this._bytes - this.base;
    if (!(offset >= 0 && offset <= regionLen)) return; // never record a boundary outside the region
    if (this.path && this.writeAt && this.cprLineOff) {
      await this.writeAt(this.cprLineOff, Buffer.from(cprStartLine(offset), "ascii"));
    }
    this._cprStart = offset;
  }

  get eventStart() {
    return this.base; // absolute: where the event region begins (the whole-file reader starts here)
  }

  // Swap the byte reader. `openProject` instruments the reader so an open reports
  // progress; runtime paging must not re-fire those one-shot callbacks, so the
  // open hands the plain reader back once it has finished reporting.
  useReader(read) {
    if (typeof read === "function") this._read = read;
  }

  get fileBytes() {
    return this._bytes; // the whole log on disk, not just the window
  }

  // Pure disk read of [lo, hi) of the WHOLE file — header included. Nothing here
  // materializes events or touches cpr_start, so a scan of a 30 MB log costs the
  // bytes it reads and nothing else.
  async readRaw(lo, hi) {
    const from = Math.max(0, Math.trunc(lo));
    const to = Math.min(Math.trunc(hi), this._bytes);
    return from < to ? this._read(from, to) : Buffer.alloc(0);
  }

  // Pure disk read of [lo, hi) (RELATIVE to the event region): parse durable
  // events without touching the resident log — the UI's scroll-up history.
  async readPage(lo, hi) {
    const from = Math.max(0, Math.trunc(lo));
    const to = Math.min(Math.trunc(hi), this._bytes - this.base);
    if (from >= to) return [];
    return parseWithOffsets(await this._read(this.base + from, this.base + to), from);
  }

  // The offset a history page should START at so that its first record opens a
  // turn: `lo` walked back to the nearest preceding `user_message`. A page is a
  // byte window, and any byte window splits turns — starting a page on a task row
  // makes "a page of history" and "whole turns" the same unit. Returns `lo`
  // unchanged when the window already opens on a task row, and when no task row
  // is within `reach` bytes (a turn larger than the budget).
  async alignedStart(lo, reach = ALIGN_REACH) {
    const regionLen = this._bytes - this.base;
    const at = Math.min(Math.max(0, Math.trunc(lo)), regionLen);
    // A window that already STARTS on a task row is aligned — and it usually
    // does: `lo` is the oldest rendered record's offset, so every page after the
    // first begins exactly on a record. Walking back from there would hand the
    // reader the turn BEFORE the one they asked for, on every page.
    const head = parseWithOffsets(await this._read(this.base + at, this.base + Math.min(at + 4096, regionLen)), at);
    if (head.length && head[0][0] === at && head[0][1].type === "user_message") return at;
    const floor = Math.max(0, at - reach);
    let end = at;
    let step = 64 * 1024;
    while (end > floor) {
      const start = Math.max(floor, end - step);
      const window = parseWithOffsets(await this._read(this.base + start, this.base + end), start);
      for (let index = window.length - 1; index >= 0; index -= 1) {
        if (window[index][1].type === "user_message") return window[index][0];
      }
      end = start;
      step *= 2;
    }
    return at;
  }
}

// ---- the project lifecycle (project/__init__.py) -------------------------

// A workspace is not optional: the far-root host has no other way to a file, and
// a second, local way in is the third implementation the plan forbids (X1).
function requireWorkspace(workspace) {
  if (!workspace || typeof workspace.readRange !== "function" || typeof workspace.size !== "function") {
    throw new TypeError("clc: a workspace is required (deployment B has no local root)");
  }
  return workspace;
}

// pathlib's `with_suffix(".clc")`: a project file is always a .clc, whichever
// name the caller passed.
function withSuffix(path, suffix) {
  const text = String(path);
  const slash = text.lastIndexOf("/");
  const name = slash < 0 ? text : text.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${text}${suffix}`;
  return text.slice(0, slash + 1 + dot) + suffix;
}

// `project._writer_for`: a read-only open appends nothing (the no-op writer), so
// compaction rewrites can never touch the file either, while reads behave
// exactly like a normal open.
function makeWriter(workspace, readOnly) {
  if (readOnly) return async () => {};
  return (path, line) => workspace.appendLine(path, line);
}

// `project._wrap_progress`: report progress per PERCENT of bytes pulled. The
// window IS the whole file on a compaction-free project, so opening is not
// instant, and a fresh project reports exactly twice (the header read, then the
// completion call) — a deterministic, golden-frozen shape.
function wrapProgress(rawRead, total, onProgress) {
  let last = -1; // highest percent already reported
  return async (lo, hi) => {
    const data = await rawRead(lo, hi);
    const pulled = Math.min(hi, total);
    const pct = Math.floor((pulled * 100) / (total || 1));
    if (pct > last) {
      last = pct;
      onProgress(pulled, total);
    }
    return data;
  };
}

// `agent/project/__init__.py: ProjectExists` — a create refused because a file
// is already at the path. The create is the one write that must never happen
// over an existing .clc: the file it would land on is a whole conversation.
class ProjectExists extends Error {
  constructor(path) {
    super(String(path));
    this.name = "ProjectExists";
    this.path = String(path);
  }
}

// `_refuse_existing`: ask the backend that is about to be written to, in its own
// currency (`size` is `wc -c` far-side / a stat locally), and treat that
// backend's FileNotFoundError as "the name is free".
async function refuseExisting(path, workspace) {
  try {
    await workspace.size(path);
  } catch (e) {
    if (e instanceof FileNotFoundError) return;
    throw e;
  }
  throw new ProjectExists(path);
}

async function createProject(options = {}) {
  const path = withSuffix(String(options.path), ".clc");
  const workspace = requireWorkspace(options.workspace);
  await refuseExisting(path, workspace);
  const meta = { name: String(options.name || ""), model: String(options.model || "") };
  await workspace.write(path, headerText(meta));
  const read = (lo, hi) => workspace.readRange(path, lo, hi);
  const total = await workspace.size(path);
  const log = await LazyEventLog.open({
    path,
    read,
    total,
    // a fresh file's event region is empty and starts right after the separator
    base: eventRegionStart(Buffer.from(headerText(meta), "utf8")),
    cprStart: 0,
    cprLineOff: cprLineOffset(meta),
    writer: makeWriter(workspace, false),
    writeAt: (offset, data) => workspace.writeAt(path, offset, data),
  });
  return { path, meta, log, readOnly: false };
}

// Open a .clc lazily: read the header and the model WINDOW, nothing else.
// A file with no cpr_start line (legacy) behaves as cpr_start 0 and lets the log
// derive the boundary from its newest compaction line.
async function openProject(options = {}) {
  const path = withSuffix(String(options.path), ".clc");
  const workspace = requireWorkspace(options.workspace);
  const readOnly = Boolean(options.readOnly);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const rawRead = (lo, hi) => workspace.readRange(path, lo, hi);
  const total = await workspace.size(path);
  // one reader covers the header + the log; nothing below rewrites the file
  const read = onProgress ? wrapProgress(rawRead, total, onProgress) : rawRead;
  const head = await read(0, Math.min(total, 1 << 16)); // the header is tiny
  const meta = parseMetaLines(head.toString("utf8").split("\n"));
  const base = eventRegionStart(head);
  const cprLineOff = findCprLine(head);
  const cprStart = cprLineOff === null ? 0 : parseCprStart(await readLineAt(read, cprLineOff, total, CPR_START_LINE_W));
  const log = await LazyEventLog.open({
    path,
    read,
    total,
    base,
    cprStart,
    cprLineOff: cprLineOff === null ? 0 : cprLineOff,
    writer: makeWriter(workspace, readOnly),
    writeAt: readOnly ? null : (offset, data) => workspace.writeAt(path, offset, data),
  });
  if (onProgress) {
    onProgress(total, total);
    // runtime paging reads must not fire the open-progress callbacks
    log.useReader(rawRead);
  }
  return { path, meta, log, readOnly };
}

// `agent/api/project.py: _open_stream_start` without the HTTP: the NDJSON body
// of an open, one object per call. The shapes are frozen from the Python host
// (tests/fixtures/clc/expected.json, "open") and M4's route replays them.
async function streamOpen(options = {}) {
  const emit = typeof options.emit === "function" ? options.emit : () => {};
  const project = await openProject({
    ...options,
    onProgress: (done, total) => emit({ progress: { done, total } }),
  });
  emit({
    meta: {
      project: project.path,
      name: project.meta.name,
      workdir: dirname(project.path),
      read_only: project.readOnly,
    },
  });
  const pairs = project.log.items();
  emit({ count: pairs.length, older: Math.max(0, project.log.cprStart) });
  for (const [offset, event] of pairs) emit({ offset, event: JSON.parse(eventToJson(event)) });
  emit({ done: true });
  return project;
}

module.exports = {
  LazyEventLog,
  // the lifecycle
  createProject,
  ProjectExists,
  openProject,
  streamOpen,
  withSuffix,
  // the format
  headerText,
  cprLineOffset,
  cprStartLine,
  eventRegionStart,
  findCprLine,
  parseCprStart,
  lastCompactionRel,
  readLineAt,
  parseMetaLines,
  // events
  eventFromDict,
  eventToJson,
  dumps,
  lineBytes,
  parseDurable,
  parseWithOffsets,
  // constants the tests assert against
  DURABLE_TYPES,
  HEADER_PREFIX,
  SEPARATOR,
  SECTION,
  CPR_START_LINE_W,
  CPR_START_LINE_BYTES,
  ALIGN_REACH,
  ValueError,
  OSError,
};
