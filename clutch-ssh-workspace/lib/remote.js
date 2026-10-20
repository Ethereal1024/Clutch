// One tool call -> the far side's command line(s).
//
// This file is the whole of the plugin's own logic, and it is deliberately thin:
// it does NOT read, search or write anything. The machine that holds the files
// runs its own `clutch-workspace` component (`python3 -m clutch_workspace --json
// <tool> ...`), so line numbers, continuation hints, unified diffs, "(no
// matches)" and the sysexits codes are that component's — one implementation of
// the filesystem, on the machine that owns it. What is here is argv, quoting, and
// getting a payload past the one limit an ssh exec channel has: it takes a
// COMMAND STRING and no stdin.
//
// Two consequences shape everything below:
//
// - paths are relative to the FAR SIDE's workspace root, because that is the
//   directory this command line stands in. Absolute paths pass through as given.
// - a payload (write_file's content, edit_file's old/new string) never rides in
//   argv: it is base64'd here and decoded there (`python -m base64 -d`, and the
//   interpreter is already required), so a body with quotes, backticks, `$`, CRLF
//   or a missing trailing newline is byte-exact — a heredoc would append the
//   newline it is missing. Past the command budget the base64 is written in
//   chunks, exactly like agent/tools/workspace.py's RemoteWorkspace.write.

"use strict";

const crypto = require("crypto");

const { CHUNK_ENV, MAX_ENV, PYTHON_ENV, ROOT_ENV } = require("./settings");

// A host that states nothing (an older client, a hand-run test) gets these. Both
// are conservative: a minimal sshd drops a single exec over ~8 KB
// (ui/tunnel-remote.js notes the same limit).
const FALLBACK_MAX_BYTES = 4000;
const FALLBACK_CHUNK_BYTES = 2000;
// below this the chunk arithmetic stops making sense; never split finer than it
const MIN_CHUNK = 64;

// Where staged payloads land on the far side. One directory per user, files
// named by a per-call token, always removed by the same command that used them.
const SCRATCH = '"$HOME/.clutch-ssh-workspace"';

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function limits(env = process.env) {
  const max = positive(env[MAX_ENV], FALLBACK_MAX_BYTES);
  return { max, chunk: Math.min(max, positive(env[CHUNK_ENV], FALLBACK_CHUNK_BYTES)) };
}

function bytes(text) {
  return Buffer.byteLength(String(text), "utf8");
}

// POSIX single-quoting: ' -> '\'' , which is the one substitution every sh
// agrees on.
function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function textOf(value) {
  return String(value === undefined || value === null ? "" : value);
}

function wholeOf(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : "";
}

// Everything a run needs to be a self-contained command: it must not depend on
// the shell's cwd or environment, because every call is a fresh `ssh exec` in a
// fresh shell (and a chunked payload is several of them).
function preamble(python, root, hint) {
  return [
    `PY=${shq(python)}`,
    `cd ${root} || { echo ${shq(`ssh-workspace: cannot enter the far side's workspace root (${hint})`)} >&2; exit 66; }`,
    'CL=""',
    // a checkout wins over an installed copy: it is the version the user is
    // working on (scripts/ws-stopgap makes the same choice from this side)
    'if [ -d "$PWD/clutch-workspace/clutch_workspace" ]; then CL="$PWD/clutch-workspace"; else CL=$(ls -d "$HOME"/.clutch/components/clutch-workspace/*/ 2>/dev/null | tail -n 1); CL=${CL%/}; fi',
    `if [ -z "$CL" ] || [ ! -d "$CL/clutch_workspace" ]; then echo ${shq(
      "ssh-workspace: no clutch-workspace component on the far side (looked in $PWD/clutch-workspace and $HOME/.clutch/components/clutch-workspace)"
    )} >&2; exit 74; fi`,
  ].join("\n");
}

// (tool, args) -> the far-side argv. `stdin` rides the command's stdin through
// `--<flag> -` (the CLI reads exactly one payload flag from stdin; two would
// drain the same stream twice, clutch_workspace/cli.py).
function toolOf(tool, input) {
  if (tool === "read_file") {
    const path = textOf(input.path);
    if (!path) return { error: "read_file needs a path" };
    const argv = ["read_file", "--path", shq(path)];
    const offset = wholeOf(input.offset);
    const limit = wholeOf(input.limit);
    const maxChars = wholeOf(input.max_chars);
    if (offset) argv.push("--offset", offset);
    if (limit) argv.push("--limit", limit);
    if (maxChars) argv.push("--max-chars", maxChars);
    return { variants: [{ argv }] };
  }
  if (tool === "grep") {
    const pattern = textOf(input.pattern);
    if (!pattern) return { error: "grep needs a pattern" };
    const argv = ["grep", "--pattern", shq(pattern)];
    const path = textOf(input.path);
    if (path) argv.push("--path", shq(path));
    const include = textOf(input.include);
    if (include) argv.push("--include", shq(include));
    return { variants: [{ argv }] };
  }
  if (tool === "write_file") {
    const path = textOf(input.path);
    if (!path) return { error: "write_file needs a path" };
    if (typeof input.content !== "string") return { error: "write_file needs the content as a string" };
    return {
      variants: [
        { argv: ["write_file", "--path", shq(path), "--content", shq("-")], stdin: input.content },
      ],
    };
  }
  if (tool === "edit_file") {
    const path = textOf(input.path);
    if (!path) return { error: "edit_file needs a path" };
    if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
      return { error: "edit_file needs old_string and new_string as strings" };
    }
    const head = ["edit_file", "--path", shq(path)];
    // Tried in order, first that fits the command budget wins: both inline, the
    // old string on stdin, the new string on stdin. The third is the fallback for
    // a long replacement; when the OTHER string is the long one it wins earlier.
    return {
      variants: [
        { argv: [...head, "--old-string", shq(input.old_string), "--new-string", shq(input.new_string)] },
        { argv: [...head, "--old-string", shq("-"), "--new-string", shq(input.new_string)], stdin: input.old_string },
        { argv: [...head, "--old-string", shq(input.old_string), "--new-string", shq("-")], stdin: input.new_string },
      ],
    };
  }
  return { error: `unknown tool ${JSON.stringify(String(tool))}` };
}

// The command as it looks when the payload is small enough to ride along: the
// base64 is inlined, decoded to a scratch file, read back by the CLI, removed.
function stagedRun(head, argv, payload, python, token) {
  const file = `${SCRATCH}/p-${token}.payload`;
  const run = `PYTHONPATH="$CL" "$PY" -m clutch_workspace --json ${argv.join(" ")}`;
  const body = Buffer.from(payload, "utf8").toString("base64");
  return [
    `${head}`,
    `mkdir -p ${SCRATCH} && printf %s ${shq(body)} | "$PY" -m base64 -d > ${file} && ${run} < ${file}; rc=$?; rm -f ${file}; exit $rc`,
  ].join("\n");
}

// The same, in pieces: every step is its own `ssh exec`, so each one states its
// own interpreter and paths, and the last one still cleans up after itself.
function chunkedRun(head, argv, payload, python, token, limit) {
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  const b64File = `${SCRATCH}/p-${token}.b64`;
  const file = `${SCRATCH}/p-${token}.payload`;
  const run = `PYTHONPATH="$CL" "$PY" -m clutch_workspace --json ${argv.join(" ")}`;
  const size = Math.max(MIN_CHUNK, Math.floor((limit.chunk - 96) / 4) * 4);
  const steps = [`mkdir -p ${SCRATCH} && : > ${b64File}`];
  for (let at = 0; at < b64.length; at += size) {
    steps.push(`printf %s ${shq(b64.slice(at, at + size))} >> ${b64File}`);
  }
  steps.push(`${shq(python)} -m base64 -d < ${b64File} > ${file} && rm -f ${b64File}`);
  steps.push(`${head}\n${run} < ${file}; rc=$?; rm -f ${file}; exit $rc`);
  return steps;
}

// The plan: an ordered list of far-side commands, of which the LAST one answers
// with the JSON envelope (the others are silent, and a non-zero exit from any of
// them fails the call). One command in the ordinary case.
function plan(tool, args, env = process.env) {
  const limit = limits(env);
  const built = toolOf(tool, args && typeof args === "object" ? args : {});
  if (built.error) return { error: built.error };

  const python = String(env[PYTHON_ENV] || "").trim() || "python3";
  const root = String(env[ROOT_ENV] || "").trim();
  const head = preamble(python, root ? shq(root) : '"$HOME"', root || "the login home");
  const token = crypto.randomBytes(6).toString("hex");

  let refusal = "";
  for (const variant of built.variants) {
    const hasStdin = Object.prototype.hasOwnProperty.call(variant, "stdin");
    if (!hasStdin) {
      const one = `${head}\nPYTHONPATH="$CL" "$PY" -m clutch_workspace --json ${variant.argv.join(" ")}`;
      if (bytes(one) <= limit.max) return { steps: [one] };
      refusal = "this call's arguments do not fit in one ssh command (there is no stdin channel to use instead)";
      continue;
    }
    const inline = stagedRun(head, variant.argv, variant.stdin, python, token);
    if (bytes(inline) <= limit.max) return { steps: [inline] };
    const steps = chunkedRun(head, variant.argv, variant.stdin, python, token, limit);
    const oversized = steps.filter((step) => bytes(step) > limit.max);
    if (oversized.length) {
      refusal = `${variant.argv[0]}: this call cannot be split small enough for the ssh channel (a ${bytes(
        oversized[0]
      )}-byte step against a ${limit.max}-byte budget)`;
      continue;
    }
    return { steps };
  }
  return { error: refusal || `${tool}: nothing to run` };
}

module.exports = { plan, shq, limits, preamble, SCRATCH, FALLBACK_MAX_BYTES, FALLBACK_CHUNK_BYTES };
