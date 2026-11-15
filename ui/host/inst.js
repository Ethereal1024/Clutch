// Declarative tool statements: one Tool = one terminal command.
//
// Ported from `agent/tools/inst.py` (and the `shq` it shares with
// `agent/tools/localshell.py`, which this host keeps in `exec.js` because the
// transports need it too). This module owns the ONE translation out (the model's
// arguments -> the command line) and the ONE translation back (a finished
// command -> the `Envelope` the loop consumes), so every component call is a
// terminal command and the runner decides only where it runs.
//
// Placeholders, fail-closed by design:
//
//   {name}   one MODEL argument, POSIX-shell-quoted as a single word;
//   {*}      ALL model arguments as one shell-quoted JSON object (`jarg`);
//   {name}   a HOST value (a service's port/token, a resolved path) when the
//            name is among `vars`: host vars shadow model args of the same name,
//            so a model argument can never hijack a host placeholder;
//   [ ... ]  optional group: dropped whole — brackets, flag and value — when one
//            of the placeholders inside has no value (a CLI flag the model did
//            not ask for). `[[` / `]]` are a literal bracket.
//
// Quoting is the default, because a command line is a shell's INPUT, not string
// concatenation: `{query}` renders `shq(query)`, so a value like `; rm -rf /`
// stays one literal word instead of becoming a second command. The only verbatim
// insertion is a caller-listed `raw` name — `run_command`'s `{command}`, whose
// text IS a shell command; its safety boundary is the host's permission engine
// (`permission.js` / `agent/tools/shell.py`), never the renderer.
//
// Output contract: `unwrap` turns a finished command into an `Envelope`
// (`agent/tools/envelope.py`, spelled `envelope()` in `tools.js` — one
// definition). A stdout JSON object carrying a string `content` IS the envelope
// (it is what the standalone components print — the workspace daemon's verdict
// and transport-error bodies, the CLIs' `--json` output); anything else is framed
// by exit code, exactly the way the `run_command` engine has always framed it.
// Nothing else is consulted: in particular a statement's own trailing status line
// (curl's `-w '%{http_code}'`) is TEXT the host passes through — parsing it would
// make one client's syntax the host's vocabulary.
//
// Divergence from the Python, documented rather than silent: a JSON number is a
// JavaScript number, so an INTEGRAL float (`1.0`) is indistinguishable from `1`
// after the parse and renders `'1'` where Python renders `'1.0'`. Non-integral
// floats and integers agree. Values that are not numbers are spelled Python's way
// (`True`, `False`, `None`, `['a', 1]`) through `pyRepr`, because those spellings
// are part of the command line a component parses.

"use strict";

const { shq } = require("./exec");
const { envelope, pyRepr, pyStrip, pyTruthy } = require("./tools");

// A statement that cannot be rendered for these arguments (a spec/args mismatch —
// reported to the model as error-as-data, never as a crash). Python's `InstError`.
class InstError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstError";
  }
}

// `str(value)` for the placeholder's word: a string is itself, everything else is
// spelled the way Python's `str()` (== `repr()` for non-strings in py3) spells it.
function pyStr(value) {
  return typeof value === "string" ? value : pyRepr(value);
}

// `json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)`.
// Keys are SORTED at every level: the payload's byte order is the HOST's, never
// the declaration file's, so an installed and a checked-out spelling of one
// declaration send one body — and reordering two keys in `component.json` cannot
// silently move a byte of the wire contract.
function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null"; // json: NaN/Infinity are null
  return JSON.stringify(value);
}

// One shell-quoted JSON object: the request body of an HTTP/CLI service. Exactly
// ONE escaping pass per layer (json for the body, shq for the shell), so the
// service sees the model's values byte for byte.
function jarg(obj) {
  return shq(sortedJson(obj === undefined ? null : obj));
}

// `_PLACEHOLDER.match(template, i)` is anchored at `i`, which in JS is a sticky
// pattern with `lastIndex` set by the caller.
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*|\*)\}/y;

// Split a statement into ["text", s] / ["ph", name] / ["open"] / ["close"].
// Raises InstError on a malformed placeholder.
function tokens(template) {
  const source = String(template);
  const out = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") {
      PLACEHOLDER.lastIndex = i;
      const found = PLACEHOLDER.exec(source);
      if (found === null) {
        throw new InstError(`bad placeholder in tool statement: ${pyRepr(source.slice(i, i + 40))}`);
      }
      out.push(["ph", found[1]]);
      i += found[0].length;
    } else if (ch === "[") {
      if (source.startsWith("[[", i)) {
        out.push(["text", "["]);
        i += 2;
      } else {
        out.push(["open", null]);
        i += 1;
      }
    } else if (ch === "]") {
      if (source.startsWith("]]", i)) {
        out.push(["text", "]"]);
        i += 2;
      } else {
        out.push(["close", null]);
        i += 1;
      }
    } else {
      const stops = [source.indexOf("{", i), source.indexOf("[", i), source.indexOf("]", i)]
        .filter((at) => at !== -1);
      const end = stops.length ? Math.min(...stops) : source.length;
      out.push(["text", source.slice(i, end)]);
      i = end;
    }
  }
  return out;
}

// The command line for one tool call.
//
// `args` are the model's arguments (quoted), `vars` the host's resolved values
// (quoted, shadowing `args`), `defaults` the host's per-tool payload defaults
// (merged UNDER the model's arguments — an argument the model left out gets the
// host's default instead of a hole in the request), `raw` the placeholder names
// inserted verbatim.
function render(template, args, options = {}) {
  const model = args && typeof args === "object" ? { ...args } : {};
  const host = {};
  for (const [key, resolved] of Object.entries(options.vars || {})) host[key] = pyStr(resolved);
  const merged = { ...(options.defaults || {}), ...model };
  const raws = new Set(options.raw || []);

  // The rendered word for a placeholder, or null when nobody provided it.
  function value(name) {
    if (name === "*") return jarg(merged);
    if (Object.prototype.hasOwnProperty.call(host, name)) {
      return raws.has(name) ? host[name] : shq(host[name]);
    }
    if (Object.prototype.hasOwnProperty.call(merged, name)) {
      const text = pyStr(merged[name]);
      return raws.has(name) ? text : shq(text);
    }
    return null;
  }

  const parts = tokens(template);
  // Which tokens an optional group drops: a group whose placeholders cannot all
  // be filled is dropped whole, flag included — a half-filled flag is worse.
  const drop = new Array(parts.length).fill(false);
  const dropped = [];
  const openAt = []; // [index, missing] — one frame, because nesting is refused
  for (let idx = 0; idx < parts.length; idx += 1) {
    const [kind, name] = parts[idx];
    if (kind === "open") {
      if (openAt.length) {
        throw new InstError("nested optional groups are not supported in a tool statement");
      }
      openAt.push([idx, false]);
    } else if (kind === "close") {
      if (!openAt.length) {
        throw new InstError(`unmatched ']' in tool statement: ${pyRepr(String(template))}`);
      }
      const [start, missing] = openAt.pop();
      if (missing) {
        dropped.push(start);
        for (let k = start; k <= idx; k += 1) drop[k] = true;
      }
    } else if (kind === "ph" && value(name) === null) {
      if (openAt.length) openAt[openAt.length - 1][1] = true;
      else throw new InstError(`missing value for {${name}} (tool arguments: ${pyRepr(Object.keys(model).sort())})`);
    }
  }
  if (openAt.length) {
    throw new InstError(`unclosed '[' in tool statement: ${pyRepr(String(template))}`);
  }
  // A dropped group takes the whitespace that separated it from the word before
  // it: `cmd a [--flag {x}]` must come out as `cmd a`, not `cmd a `.
  for (const start of dropped) {
    const prev = parts[start - 1];
    if (prev && prev[0] === "text" && prev[1] !== prev[1].replace(/[\s\x1c-\x1f]+$/u, "")) {
      prev[1] = prev[1].replace(/[\s\x1c-\x1f]+$/u, "");
    }
  }

  const out = [];
  for (let idx = 0; idx < parts.length; idx += 1) {
    const [kind, text] = parts[idx];
    if (drop[idx] || kind === "open" || kind === "close") continue;
    out.push(kind === "ph" ? value(text) || "" : text);
  }
  return out.join("");
}

// The envelope-shaped JSON object a component printed, or null when the output is
// not one (a plain command's stdout, a crash, empty output).
function envelopeOf(text) {
  let obj;
  try {
    const body = pyStrip(text === undefined || text === null ? "" : text);
    obj = JSON.parse(body || "null");
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  return typeof obj.content === "string" ? obj : null;
}

// The loop's envelope for a finished command (see the header).
function unwrap(result, options = {}) {
  const service = options.service === undefined ? "the tool service" : options.service;
  const stdout = result && result.stdout !== undefined && result.stdout !== null ? String(result.stdout) : "";
  const stderr = result && result.stderr !== undefined && result.stderr !== null ? String(result.stderr) : "";
  const code = result && typeof result.code === "number" ? result.code : 0;

  const env = envelopeOf(stdout);
  if (env !== null) {
    // "code" is the transports' verdict (sysexits); error/diff are the module
    // envelope's own fields. Either one saying "failed" is enough — and so is a
    // non-zero exit, so a component bug cannot hide behind an optimistic envelope.
    const failed = pyTruthy(env.error) || pyTruthy(env.code) || code !== 0;
    return envelope(env.content, { error: failed, diff: pyTruthy(env.diff) ? pyStr(env.diff) : "" });
  }
  const out = pyStrip(stdout);
  if (code !== 0) {
    const tail = pyStrip(stderr) || out;
    const message = `ERROR: ${service} failed (exit ${code})`;
    return envelope(tail ? `${message}: ${tail.slice(-500)}` : message, { error: true });
  }
  return envelope(out || `OK: ${service} succeeded, no output.`);
}

module.exports = {
  InstError,
  pyStr,
  sortedJson,
  jarg,
  tokens,
  render,
  envelopeOf,
  unwrap,
};
