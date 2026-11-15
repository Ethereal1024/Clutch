// The far-root host's one primitive: run ONE command on the far side.
//
// Everything the host does to the far machine — read a file, list a directory,
// append a line, run the agent's shell — reduces to this call. The transport
// below is the ssh exec channel (`ui/tunnel-remote.js: remoteExec`), which is
// already a byte channel: it answers `{code, stdout|stdout_b64, stderr}`. This
// file adds the three things every caller would otherwise repeat:
//
//   - ONE result shape: `{code, stdout, stderr, bytes}`, where `bytes` is the
//     raw Buffer for a binary read (a `read_range` may cut a multibyte character
//     in half, so text is not the answer to every question);
//   - the timeout verdict: the channel reports a deadline as `code === -1`,
//     which is the CLIENT's deadline, not the command's exit code — surfacing it
//     as a code would make a half-finished write look like a failed `grep`;
//   - the two wire limits from `ui/transport_defaults.json` (shared with
//     `ui/ssh-tunnel.js`), so a caller building a command can size it instead of
//     discovering the drop after the fact.
//
// Ported from `agent/tools/transport.py:303-367` (SshTransport); the semantics
// are the same, the reason it lives here is that on deployment B there is no
// process on either end that could host it.

"use strict";

const DEFAULTS = require("../transport_defaults.json");

// A minimal sshd drops a single exec over ~8 KB; these are the client's own
// (smaller, safe) numbers, and they are the same file the tunnel reads.
const EXEC_CHUNK_BYTES = Number(DEFAULTS.exec_chunk_bytes) || 3500;
const EXEC_MAX_COMMAND_BYTES = Number(DEFAULTS.exec_max_command_bytes) || 6000;

// how much of a failed command's output is quoted back
const SNIPPET = 300;

class TransportError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TransportError";
    this.timeout = Boolean(options.timeout);
    this.aborted = Boolean(options.aborted);
  }
}

function snippet(value) {
  const text = String(value == null ? "" : value).trim();
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
}

function utf8(text) {
  return Buffer.byteLength(String(text), "utf8");
}

// POSIX single-quoting: ' -> '\'' , the one substitution every sh agrees on.
function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// A relative path that starts with "-" would be read as a flag by cat/ls/grep;
// "./" in front of it costs nothing and makes it an operand.
function guard(path) {
  const text = String(path);
  return text.startsWith("-") ? `./${text}` : text;
}

// The text of an answer, whichever way the transport handed the bytes over.
function stdoutText(answer) {
  if (typeof answer.stdout_b64 === "string") return Buffer.from(answer.stdout_b64, "base64").toString("latin1");
  return String(answer.stdout == null ? "" : answer.stdout);
}

function stdoutBytes(answer) {
  if (typeof answer.stdout_b64 === "string") return Buffer.from(answer.stdout_b64, "base64");
  if (Buffer.isBuffer(answer.bytes)) return answer.bytes;
  return Buffer.from(String(answer.stdout == null ? "" : answer.stdout), "utf8");
}

// createExec(transport | run, options) -> {run, limits, timeoutMs}
//
// `transport` is anything with `run(command, {timeout, binary, cancel}) ->
// Promise<{code, stdout, stdout_b64, stderr}>`: `ui/tunnel-remote.js` in
// production, a scripted double in the tests. Passing a bare function is the
// same thing spelled shorter.
function createExec(transport, options = {}) {
  const run = typeof transport === "function" ? transport : transport && transport.run;
  if (typeof run !== "function") {
    throw new TypeError("createExec needs a transport with run(command, {timeout, binary, cancel})");
  }
  const max = Number(options.maxCommandBytes) > 0 ? Math.trunc(options.maxCommandBytes) : EXEC_MAX_COMMAND_BYTES;
  const chunk = Math.min(max, Number(options.chunkBytes) > 0 ? Math.trunc(options.chunkBytes) : EXEC_CHUNK_BYTES);

  // One command, one answer. Throws only for the channel's own trouble; a
  // command that ran and failed is a result, not an exception (the caller
  // decides what exit 66 means for its call).
  async function exec(command, { timeout = 60, binary = false, cancel = null } = {}) {
    const text = String(command);
    const size = utf8(text);
    if (size > max) {
      // oversized commands drop a minimal sshd: fail cleanly up front
      throw new TransportError(
        `command too long to send over the remote transport (${size} bytes, the limit is ${max}); ` +
          "write large content with a file tool and run it"
      );
    }
    let answer;
    try {
      answer = await run(text, { timeout, binary, cancel });
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError(`bridge unreachable: ${error && error.message ? error.message : error}`, {
        aborted: Boolean(error && error.aborted),
      });
    }
    if (!answer || typeof answer !== "object" || typeof answer.code !== "number") {
      throw new TransportError("the far side answered without an exit code");
    }
    if (answer.code === -1) {
      // the bridge's own deadline: the command may have half-run, so no caller
      // may read this as the command's verdict
      throw new TransportError(`command timed out (${timeout}s)`, { timeout: true });
    }
    return {
      code: answer.code,
      stdout: stdoutText(answer),
      stderr: String(answer.stderr == null ? "" : answer.stderr),
      bytes: binary ? stdoutBytes(answer) : null,
    };
  }

  return { run: exec, limits: { max, chunk } };
}

// The sentence a failed command is reported with, in the caller's words plus
// whatever the far side said ("permission denied" is the far side's to say).
function failure(answer, what) {
  const code = answer && typeof answer.code === "number" ? answer.code : "?";
  const said = snippet(answer && (answer.stderr || answer.stdout));
  return said ? `${what} (exit ${code}): ${said}` : `${what} (exit ${code})`;
}

module.exports = {
  createExec,
  failure,
  shq,
  guard,
  snippet,
  utf8,
  TransportError,
  EXEC_CHUNK_BYTES,
  EXEC_MAX_COMMAND_BYTES,
  SNIPPET,
};
