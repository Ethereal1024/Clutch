// The loop's own words, loaded from files instead of embedded in code.
//
// A prompt is template text, not logic: the wording is tuned by editing a .md
// file, and the code that asks for it names the file and nothing else. That is
// how the Python half did it (agent/prompts/__init__.py: `load` + `render`) and
// this is the same pair, kept deliberately identical — the templates moved
// beside this module (ui/prompts/, TODO.md P1-3), the semantics did not move at
// all.
//
// The placeholder language is `string.Template`'s, because the templates were
// written for it and are shared with the half that is still Python:
//
//   $name / ${name}   substituted when the caller supplied `name`, and left
//                     VERBATIM when it did not (safe_substitute: a missing value
//                     is not an exception, and a prompt that says "$HOME" is a
//                     Windows environment variable, not an unfilled slot)
//   $$                one literal "$"
//   anything else     literal, dollar included ($1, ${}, a trailing $)
//
// Rendering reads the file every time, like Python does: a prompt edited on a
// dev machine takes effect on the next turn, with no build stamp to get stale.
// The files are small and a turn renders a handful of them.

const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.join(__dirname, "prompts");

// `$name` in Python's Template idpattern: `[_a-z][_a-z0-9]*`, matched
// IGNORECASE — so `$HOME` is a placeholder name too, and a template that never
// receives it keeps it as written.
function isNameStart(ch) {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isNameChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function isName(s) {
  return isNameStart(s[0]) && [...s].every(isNameChar);
}

// A value is supplied when the caller gave one that can be written into a
// prompt: `undefined`/`null` mean "I have nothing" and leave the placeholder
// verbatim (a prompt saying `$HOME` is a Windows variable, not an empty slot).
// Everything else is printed with String(), and never scanned again — a value
// containing "$" is text, not a second round of placeholders.
function has(vars, name) {
  return (
    Object.prototype.hasOwnProperty.call(vars, name) &&
    vars[name] !== undefined &&
    vars[name] !== null
  );
}

// string.Template.safe_substitute, spelled out. `vars` is a plain object.
function substitute(text, vars) {
  const values = vars && typeof vars === "object" ? vars : {};
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (next === "{") {
      const end = text.indexOf("}", i + 2);
      const name = end < 0 ? "" : text.slice(i + 2, end);
      if (end < 0 || !isName(name)) {
        // invalid placeholder: the "$" stands for itself, the rest is text
        out += "$";
        i += 1;
        continue;
      }
      out += has(values, name) ? String(values[name]) : text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (!isNameStart(next)) {
      out += "$";
      i += 1;
      continue;
    }
    let j = i + 2;
    while (j < text.length && isNameChar(text[j])) j += 1;
    const name = text.slice(i + 1, j);
    out += has(values, name) ? String(values[name]) : "$" + name;
    i = j;
  }
  return out;
}

// Which placeholders a template mentions, in first-appearance order, without
// duplicates. The counterpart of substitute(): it is what a caller can check its
// own variables against (and what a test checks the templates against), and it
// reads the same grammar rather than a second guess at it.
function names(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "$") {
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === "$") {
      i += 2;
      continue;
    }
    if (next === "{") {
      const end = text.indexOf("}", i + 2);
      const name = end < 0 ? "" : text.slice(i + 2, end);
      if (end >= 0 && isName(name)) {
        if (!out.includes(name)) out.push(name);
        i = end + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (!isNameStart(next)) {
      i += 1;
      continue;
    }
    let j = i + 2;
    while (j < text.length && isNameChar(text[j])) j += 1;
    const name = text.slice(i + 1, j);
    if (!out.includes(name)) out.push(name);
    i = j;
  }
  return out;
}

// The template file's text, as written. `name` is a file name inside
// ui/prompts/, never a path a caller composes: a template is not user input.
function load(name) {
  if (typeof name !== "string" || !name) {
    throw new TypeError("prompt.load: a template name is required");
  }
  if (name !== path.basename(name)) {
    throw new TypeError(`prompt.load: "${name}" is not a template file name`);
  }
  return fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
}

// Load a template and fill its placeholders. Unknown ones stay verbatim; no
// placeholder is ever an error.
function render(template, vars) {
  return substitute(load(template), vars);
}

// The loop's own prose that a turn writes to the log, by the name the loop knows
// it by (ui/run.js's `text` port). These three are notes to the model, not
// failures: a cancelled turn, an empty reply, a truncated one.
const SAY = {
  cancelled: "cancelled.md",
  empty_response: "empty_response.md",
  max_tokens: "max_tokens.md",
};

function say(key, vars) {
  const file = SAY[key];
  if (!file) {
    throw new Error(`prompt.say: "${key}" is not one of ${Object.keys(SAY).join(", ")}`);
  }
  return render(file, vars);
}

module.exports = { PROMPTS_DIR, SAY, isName, substitute, names, load, render, say };
