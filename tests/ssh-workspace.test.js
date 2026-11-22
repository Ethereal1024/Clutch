// The ssh workspace plugin (0.2.0): the four file tools computed HERE, spoken to
// the far side as plain POSIX sh over the client's exec bridge.
//
// What is faked and what is real: the far side is a real `/bin/sh` in a temp
// directory (the one thing a stock sshd guarantees), reached through a real
// loopback HTTP server that speaks `ui/exec-bridge.js`'s contract
// (`POST /exec {command, timeout}` -> `{code, stdout, stderr}`). The plugin, its
// quoting, its chunking, its parsers and its envelope are the real files from
// `clutch-ssh-workspace/`. Nothing here needs ssh, a network or a far machine.
//
// What this file pins that `tests/conform.test.js` does not: conform pins the
// OUTPUT CONTRACT against the Python component's (39 frozen cases). This one
// pins the transport-side promises of the rewrite — nothing has to be installed
// on the far side (`sh`, `cat`, `ls`, `grep`, `find`, `mkdir`, `printf` only), a
// path or a pattern given by the model cannot expand into a command, a payload
// never rides the argv of a tool call and is split to fit the channel, and a
// failure of the channel is a sentence about the tunnel rather than a tool
// failure of the file.
//
// Run: node tests/ssh-workspace.test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");

const { check, summary } = require("./harness");
const PLUGIN = require(path.join(__dirname, "..", "clutch-ssh-workspace", "index.js"));

// ---- the far side --------------------------------------------------------
//
// One bridge, one shell, one directory: `sh -c <command>` with the workspace
// root as its cwd answers exactly like the app's own bridge does on the other
// end of a tunnel (`{code, stdout, stderr}`), except that the bytes it reads and
// writes are a temp directory this file can inspect.

function farSide() {
  return new Promise((resolve) => {
    const api = {
      url: "",
      seen: [],
      root: fs.mkdtempSync(path.join(os.tmpdir(), "ssh-ws-")),
      reply: null,
      reset() {
        api.seen.length = 0;
      },
    };
    const server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch (e) {
          body = {};
        }
        const command = String(body.command || "");
        api.seen.push(command);
        const answer = api.reply ? api.reply(command, api.seen.length - 1) : null;
        if (answer) {
          response.writeHead(answer.status || 200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(answer.body || {}));
          return;
        }
        execFile(
          "/bin/sh",
          ["-c", command],
          { cwd: api.root, env: { PATH: process.env.PATH, HOME: api.root }, timeout: 10000 },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ code, stdout, stderr }));
          }
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      api.url = `http://127.0.0.1:${server.address().port}`;
      api.close = () => {
        server.close();
        fs.rmSync(api.root, { recursive: true, force: true });
      };
      resolve(api);
    });
  });
}

// The environment a call sees. Every case states it whole, because the plugin
// reads the host's variables at call time on purpose (settings.js).
function configure(url, extra = {}) {
  for (const name of [
    "CLUTCH_EXEC_BRIDGE",
    "CLUTCH_EXEC_CHUNK_BYTES",
    "CLUTCH_EXEC_MAX_COMMAND_BYTES",
    "CLUTCH_WORKSPACE_ROOT",
    "CLUTCH_WORKSPACE_FENCE",
    "CLUTCH_SSH_WORKSPACE",
    "CLUTCH_SSH_TIMEOUT_MS",
  ]) {
    delete process.env[name];
  }
  if (url) process.env.CLUTCH_EXEC_BRIDGE = url;
  Object.assign(process.env, extra);
}

function put(far, rel, text) {
  const file = path.join(far.root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(far, rel) {
  return fs.readFileSync(path.join(far.root, rel), "utf8");
}

function exists(far, rel) {
  return fs.existsSync(path.join(far.root, rel));
}

async function main() {
  // ------------------------------------------------------------ no far side
  {
    configure("");
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true, "no bridge: the call is a failure, not an empty answer");
    check(/tunnel/i.test(answer.content), "no bridge: the sentence names the missing tunnel, so it can be acted on");
  }

  const far = await farSide();

  // -------------------------------------------------------------- read_file
  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    put(far, "VERSION", "1.2.3\n");
    far.reset();
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error !== true && answer.content === "1.2.3\n", "read_file: a file's bytes come back unchanged (no line numbers on a plain read)");
    check(far.seen.length === 1, "read_file: one far-side command for one call");
    const command = far.seen[0];
    check(command.includes(`cd '${far.root}'`), "read_file: the command enters the workspace root the call is about");
    check(command.includes("export LC_ALL=C"), "read_file: and states a locale, so `ls`/`grep` order bytes like the program the contract was frozen from");
    check(/if \[ -d "\$p" \]/.test(command) && /ls -1AF/.test(command), "read_file: a directory is listed with ls -1AF (the marker that matters is `/`)");
    check(/if \[ -f "\$p" \]/.test(command) && /cat "\$p"/.test(command), "read_file: a file is cat'ed, and only a file");
    check(!/\bpython/i.test(command), "the far side needs nothing installed: the command is sh, ls and cat, never an interpreter");
    check(!command.includes("--offset") && !command.includes("--limit"), "a line range is answered from the bytes that arrived, not by a flag on the far side");
  }

  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    put(far, "many.txt", "one\ntwo\nthree\nfour\n");
    const range = await PLUGIN.call("read_file", { path: "many.txt", offset: 2, limit: 2 });
    check(range.content === "2: two\n3: three\n... (showing lines 2-3 of 4; use offset=4 to continue)", "a line range is numbered, and says how to continue");
    const whole = await PLUGIN.call("read_file", { path: "many.txt" });
    check(whole.content === "one\ntwo\nthree\nfour\n", "the same file read whole is its own bytes, unnumbered");
    const narrow = await PLUGIN.call("read_file", { path: "many.txt", max_chars: 8 });
    check(/truncated, file is \d+ chars; use offset=/.test(narrow.content), "a file over the read budget is cut in the middle and says where to resume");
  }

  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    put(far, "folder/inner.txt", "x\n");
    const listing = await PLUGIN.call("read_file", { path: "folder" });
    check(listing.content === "inner.txt", "read_file: a directory answers its entries, sorted");
    put(far, "empty-dir/.keep", "");
    fs.rmSync(path.join(far.root, "empty-dir", ".keep"));
    const empty = await PLUGIN.call("read_file", { path: "empty-dir" });
    check(empty.content === "(empty directory)", "an empty directory is said out loud, not answered with nothing");
    const missing = await PLUGIN.call("read_file", { path: "nope.txt" });
    check(missing.error === true && missing.content.includes("file not found: nope.txt"), "a missing file is a sentence the model can act on");
    const noPath = await PLUGIN.call("read_file", {});
    check(noPath.error === true && noPath.content.includes("needs a path"), "a missing path is answered here, not by the far side");
  }

  // ------------------------------------------------------- quoting, one door
  //
  // The model names a path; the far side runs a shell. A path that carries a
  // quote, a `$( )`, a backtick or a `$` must stay a WORD in the command, which
  // is the whole job of the single-quoting in lib/fs.js.
  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    const hostile = "it's a $(touch pwned).txt";
    put(far, hostile, "safe\n");
    const answer = await PLUGIN.call("read_file", { path: hostile });
    check(answer.error !== true && answer.content === "safe\n", "a path with a quote and a command substitution is a path, not a command");
    check(!exists(far, "pwned"), "and nothing in the path was executed (no file was created by reading a file)");

    const pattern = "$(touch pwned2)";
    const searched = await PLUGIN.call("grep", { pattern });
    check(searched.content === "(no matches)", "a grep pattern that looks like a substitution is a pattern (and finds nothing)");
    check(!exists(far, "pwned2"), "and it is not executed either");
  }

  // ------------------------------------------------------------- write_file
  //
  // A write answers with a diff, so it reads the previous content first (the
  // same `cat` the edit path uses) and then writes. What these cases pin is the
  // WRITE half: the body rides `printf '%s'` in the command and never the argv
  // of the call, and one command carries it whenever it fits.
  const writes = () => far.seen.filter((command) => /printf '%s' /.test(command));
  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    far.reset();
    const body = 'he said "no"; $HOME and `date` stay literal\nsecond line\n';
    const answer = await PLUGIN.call("write_file", { path: "notes/a.txt", content: body });
    check(answer.error !== true, "write_file: a small body succeeds");
    check(answer.content.startsWith("OK: wrote notes/a.txt ("), "write_file: the summary names the path AS GIVEN and the size");
    check(answer.content.includes("\n\n@@") || answer.content.includes("\n\n---"), "write_file: the diff is appended, because a plugin's answer is one string");
    check(read(far, "notes/a.txt") === body, "write_file: the bytes that arrive are the bytes that were sent (quotes, $, backticks and newlines included)");
    const written = writes();
    check(written.length === 1 && far.seen[far.seen.length - 1] === written[0], "write_file: one command for a body that fits, and it is the write itself");
    check(written[0].includes("mkdir -p 'notes'"), "write_file: the parent directory is made by the same command that writes the file");
    check(/printf '%s' /.test(written[0]) && !written[0].includes("--content"), "write_file: the body rides printf, never the argv of a tool call");
  }

  {
    // the large write: several commands, each under the channel's agreed size,
    // the first truncating and the rest appending
    configure(far.url, {
      CLUTCH_SSH_WORKSPACE: far.root,
      CLUTCH_EXEC_MAX_COMMAND_BYTES: "3000",
      CLUTCH_EXEC_CHUNK_BYTES: "1500",
    });
    far.reset();
    const body = Array.from({ length: 2200 }, (_, at) => `line ${at}: it's $HOME \`x\` 中文\n`).join("");
    const answer = await PLUGIN.call("write_file", { path: "big.txt", content: body });
    check(answer.error !== true, "big write: a 60 KB body succeeds");
    const chunked = writes();
    check(chunked.length > 1, `big write: the body is split across commands (${chunked.length})`);
    const over = far.seen.filter((command) => Buffer.byteLength(command, "utf8") > 3000);
    check(over.length === 0, "big write: every command fits the channel's maximum, measured in bytes");
    check(/printf '%s' [\s\S]* > '/.test(chunked[0]), "big write: the first chunk TRUNCATES the file (a write, not an append)");
    const rest = chunked.slice(1).filter((command) => !/printf '%s' [\s\S]* >> '/.test(command));
    check(rest.length === 0, "big write: every later chunk appends");
    check(read(far, "big.txt") === body, "big write: the bytes that arrive are the bytes that were sent (64 KB, byte for byte)");
  }

  // -------------------------------------------------------------- edit_file
  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    put(far, "edit.txt", "alpha\nbeta\n");
    far.reset();
    const answer = await PLUGIN.call("edit_file", { path: "edit.txt", old_string: "beta", new_string: "gamma $& `now`" });
    check(answer.error !== true && answer.content.startsWith("OK: edited edit.txt (+1 -1 lines)"), "edit_file: the summary counts the change");
    check(read(far, "edit.txt") === "alpha\ngamma $& `now`\n", "edit_file: `$&` and backticks in the new text are literal (a replacement is text, not a pattern)");
    check(far.seen[0].includes("cat"), "edit_file: the previous content is read first, for the diff and for the count");
    check(!far.seen[0].includes("--old-string") && !far.seen[0].includes("--new-string"), "edit_file: the strings ride printf, not the argv of a tool call");

    const ambiguous = await PLUGIN.call("edit_file", { path: "edit.txt", old_string: "a", new_string: "b" });
    check(ambiguous.error === true && ambiguous.content.includes("appears"), "edit_file: an ambiguous old_string is refused, with the count");
    const missing = await PLUGIN.call("edit_file", { path: "gone.txt", old_string: "a", new_string: "b" });
    check(missing.error === true && missing.content.includes("use write_file"), "edit_file: a file that is not there points at write_file");
  }

  // ------------------------------------------------------------------ grep
  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    put(far, "src/a.js", "const needle = 1;\n");
    put(far, "src/b.js", "// needle\n");
    put(far, "src/c.py", "needle = 2\n");
    far.reset();
    const answer = await PLUGIN.call("grep", { pattern: "needle", path: "src", include: "*.js" });
    check(answer.error !== true, "grep: a sweep succeeds");
    check(answer.content.includes("src/a.js:\n  Line 1: const needle = 1;"), "grep: hits are grouped under the workspace-relative path");
    check(!answer.content.includes("c.py"), "grep: the include glob is applied here, to the paths that came back");
    check(far.seen.length === 1 && /grep -HnEI -e /.test(far.seen[0]), "grep: one POSIX grep -E command, with the pattern after -e");
    check(far.seen[0].includes("LC_ALL=C"), "grep: the same locale as the read, so the order matches the contract");
    const none = await PLUGIN.call("grep", { pattern: "absent-thing" });
    check(none.content === "(no matches)", "grep: no matches is an answer, not a failure");
  }

  // -------------------------------------------------------------- transport
  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    far.reply = () => ({ status: 503, body: { error: "not connected" } });
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true && /tunnel is not connected/i.test(answer.content), "a bridge whose tunnel dropped says so, instead of reporting a tool failure");
    far.reply = null;
  }

  {
    configure("http://example.com:80");
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true && /loopback/i.test(answer.content), "a bridge address that is not loopback is refused (the value is a capability, not a hint)");
  }

  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    const other = path.join(far.root, "from-the-session");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "only-here.txt"), "ok\n");
    far.reset();
    // the SESSION's root wins over the operator's standing default
    process.env.CLUTCH_WORKSPACE_ROOT = other;
    const answer = await PLUGIN.call("read_file", { path: "only-here.txt" });
    check(answer.error !== true && answer.content === "ok\n", "the root the session named is the root the call is about");
    check(far.seen[0].includes(`cd '${other}'`), "and it wins over the operator's CLUTCH_SSH_WORKSPACE default");
    delete process.env.CLUTCH_WORKSPACE_ROOT;
  }

  {
    configure(far.url, { CLUTCH_SSH_WORKSPACE: far.root });
    far.reset();
    const answer = await PLUGIN.call("list_dir", { path: "." });
    check(answer.error === true && answer.content.includes("unknown tool"), "an unpublished tool is refused by name, without a command");
    check(far.seen.length === 0, "and nothing was sent to the far side");
  }

  far.close();
  summary("ssh-workspace");
}

main().catch((e) => {
  check(false, `suite crashed: ${(e && e.stack) || e}`);
  summary("ssh-workspace");
});
