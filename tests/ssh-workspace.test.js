// The ssh-workspace plugin: argv translation, the payload that has to survive a
// channel with no stdin, and the envelope that comes back.
//
// What is faked and what is real: the ONLY thing stubbed is the app's exec bridge
// (a loopback HTTP server that records the command it was handed and answers with
// a canned {"code","stdout","stderr"} — exactly ui/exec-bridge.js's shape). The
// plugin, its planning, its quoting and its envelope handling are the real files
// from clutch-ssh-workspace/. Nothing here needs ssh, a network or the far side;
// the far side's own component is verified by tests/rendezvous_test.py and by the
// live check in tests/ssh-workspace-e2e.js.
//
// Run: node tests/ssh-workspace.test.js

"use strict";

const http = require("http");
const path = require("path");

const { check, summary } = require("./harness");
const PLUGIN = require(path.join(__dirname, "..", "clutch-ssh-workspace", "index.js"));

const ENVELOPE = (fields) => JSON.stringify({ content: "", error: false, diff: "", ...fields });

// One bridge: records every command, answers with whatever `reply` says.
// `reply(command, index)` -> { status?, body } ; the default is a clean run whose
// stdout is `stdout`.
function bridge() {
  return new Promise((resolve) => {
    const api = {
      url: "",
      seen: [],
      // each case states its own answer; a case that does not care gets "ran fine"
      reply: null,
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
        const answer = (api.reply ? api.reply(command, api.seen.length - 1) : null) || {
          body: { code: 0, stdout: "", stderr: "" },
        };
        response.writeHead(answer.status || 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(answer.body || {}));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      api.url = `http://127.0.0.1:${server.address().port}`;
      api.reset = () => {
        api.seen.length = 0;
      };
      api.close = () => server.close();
      resolve(api);
    });
  });
}

// The environment a call sees. Every case states it whole, because the plugin
// reads the host's variables at call time on purpose.
function configure(url, extra = {}) {
  for (const name of [
    "CLUTCH_EXEC_BRIDGE",
    "CLUTCH_EXEC_CHUNK_BYTES",
    "CLUTCH_EXEC_MAX_COMMAND_BYTES",
    "CLUTCH_SSH_WORKSPACE",
    "CLUTCH_SSH_PYTHON",
  ]) {
    delete process.env[name];
  }
  process.env.CLUTCH_EXEC_BRIDGE = url;
  process.env.CLUTCH_SSH_WORKSPACE = "/srv/app";
  Object.assign(process.env, extra);
}

function base64Of(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

// Every `printf %s '<b64>' ...` step, in order, is the payload of a chunked call.
function chunkedPayload(commands) {
  const parts = [];
  for (const command of commands) {
    const match = command.match(/^printf %s '([A-Za-z0-9+/=]*)' >> "\$HOME\/\.clutch-ssh-workspace"\/p-[0-9a-f]+\.b64$/);
    if (match) parts.push(match[1]);
  }
  return Buffer.from(parts.join(""), "base64").toString("utf8");
}

async function main() {
  // ------------------------------------------------------------ no far side
  {
    configure("");
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true, "no bridge: the call is a failure, not an empty answer");
    check(/tunnel/i.test(answer.content), "no bridge: the sentence names the missing tunnel, so it can be acted on");
  }

  const far = await bridge();

  // -------------------------------------------------------------- read_file
  {
    configure(far.url);
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: ENVELOPE({ content: "1\tVERSION" }), stderr: "" } });
    const answer = await PLUGIN.call("read_file", { path: "VERSION", offset: 1, limit: 20 });
    check(far.seen.length === 1, "read_file: one ssh command for one call");
    const command = far.seen[0];
    check(command.includes("cd '/srv/app'"), "read_file: the command cd's into the far side's workspace root");
    check(command.includes("$PWD/clutch-workspace/clutch_workspace"), "read_file: a checkout on the far side wins over an installed copy");
    check(command.includes("$HOME/.clutch/components/clutch-workspace"), "read_file: an installed component is the fallback");
    check(
      command.trim().endsWith("read_file --path 'VERSION' --offset 1 --limit 20"),
      "read_file: the argv is the component's own, in the component's own order"
    );
    check(command.includes(`PY='python3'`), "read_file: the interpreter defaults to python3");
    check(answer.content === "1\tVERSION" && answer.error === false, "read_file: the envelope's content comes back as the answer");
  }

  // ------------------------------------------------------------------ grep
  {
    configure(far.url);
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: ENVELOPE({ content: "(no matches)" }), stderr: "" } });
    const answer = await PLUGIN.call("grep", { pattern: "def build_\\w+", include: "*.py" });
    const command = far.seen[0];
    check(command.trim().endsWith("grep --pattern 'def build_\\w+' --include '*.py'"),
      "grep: pattern and include are translated, and an omitted path stays omitted (the CLI defaults to the root)");
    check(answer.content === "(no matches)" && answer.error === false, "grep: no matches is an answer, not a failure");
  }

  // ---------------------------------------------------- payload quoting, small
  {
    configure(far.url);
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: ENVELOPE({ content: "OK: wrote a'b", diff: "" }), stderr: "" } });
    const body = "line 'one'\n$HOME `echo` \u00e9\u00e8\nno trailing newline";
    await PLUGIN.call("write_file", { path: "a'b.txt", content: body });
    check(far.seen.length === 1, "write_file: a small body still costs one command");
    const command = far.seen[0];
    check(command.includes("--path 'a'\\''b.txt'"), "write_file: a quote in the path is single-quoted the POSIX way");
    check(command.includes(`printf %s '${base64Of(body)}'`), "write_file: the body rides base64, so quotes/backticks/$ cannot expand");
    check(command.includes("--content '-'"), "write_file: the CLI reads the body from stdin, not argv");
    check(!command.includes(body.split("\n")[0]), "write_file: the raw body is nowhere on the command line");
    check(/rm -f "\$HOME\/\.clutch-ssh-workspace"\/p-[0-9a-f]+\.payload/.test(command),
      "write_file: the staged payload is removed by the same command that used it");
  }

  // ---------------------------------------------------- a body past the budget
  {
    configure(far.url, { CLUTCH_EXEC_MAX_COMMAND_BYTES: "2000", CLUTCH_EXEC_CHUNK_BYTES: "1200" });
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: ENVELOPE({ content: "OK: wrote big.txt" }), stderr: "" } });
    const body = "# a big file\n" + "0123456789abcdef\n".repeat(4096); // 64 KB, ends with a newline
    await PLUGIN.call("write_file", { path: "big.txt", content: body });
    const commands = far.seen.slice();
    check(commands.length > 3, "big write: the payload is split across several ssh commands");
    check(commands.every((c) => Buffer.byteLength(c, "utf8") <= 2000),
      "big write: not one command exceeds the budget the host stated");
    check(commands[0].includes(`: > "$HOME/.clutch-ssh-workspace"/`), "big write: the first step truncates the staging file");
    check(commands[commands.length - 2].includes("-m base64 -d <"), "big write: the chunks are decoded once, on the far side");
    check(commands[commands.length - 1].includes("--content '-'") && commands[commands.length - 1].includes('< "$HOME/.clutch-ssh-workspace"/p-'),
      "big write: the CLI reads the decoded payload from a file");
    check(chunkedPayload(commands) === body, "big write: the bytes that arrive are the bytes that were sent (64 KB, byte for byte)");
  }

  // -------------------------------------------------------------- edit_file
  {
    configure(far.url);
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: ENVELOPE({ content: "OK: edited x.py", diff: "--- a/x.py\n+++ b/x.py" }), stderr: "" } });
    const answer = await PLUGIN.call("edit_file", { path: "x.py", old_string: "a = 1", new_string: "a = 2" });
    const command = far.seen[0];
    check(command.includes("--old-string 'a = 1' --new-string 'a = 2'"),
      "edit_file: two short strings ride argv (the cheapest form)");
    check(answer.content === "OK: edited x.py\n\n--- a/x.py\n+++ b/x.py",
      "edit_file: the unified diff is appended to the answer, because a plugin's answer is one string");
  }

  {
    configure(far.url, { CLUTCH_EXEC_MAX_COMMAND_BYTES: "2000", CLUTCH_EXEC_CHUNK_BYTES: "1200" });
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: ENVELOPE({ content: "OK: edited y.py" }), stderr: "" } });
    const replacement = "replacement line\n".repeat(2000); // 34 KB
    await PLUGIN.call("edit_file", { path: "y.py", old_string: "needle", new_string: replacement });
    const commands = far.seen.slice();
    const last = commands[commands.length - 1];
    check(last.includes("--old-string 'needle' --new-string '-'"),
      "edit_file: the long side goes to stdin and the short side stays in argv");
    check((last.match(/'-'/g) || []).length === 1, "edit_file: only ONE flag may read stdin (a second would drain the same stream twice)");
    check((last.match(/--old-string/g) || []).length === 1 && (last.match(/--new-string/g) || []).length === 1,
      "edit_file: the flag is not duplicated when the string moves to stdin");
    check(chunkedPayload(commands) === replacement, "edit_file: the replacement arrives byte for byte");
  }

  // ------------------------------------------------------------- envelopes
  {
    configure(far.url);
    far.reset();
    far.reply = () => ({
      body: {
        code: 1,
        stdout: ENVELOPE({ content: "no such file: VERSION (the workspace root may have moved)", error: true }),
        stderr: "",
      },
    });
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true, "envelope: a far-side failure is a failure here, not text that happens to say so");
    check(answer.content.startsWith("ERROR: "), "envelope: the failure reads as an error the model can act on");
    check(answer.content.includes("no such file"), "envelope: and it keeps the far side's own words");
  }

  {
    configure(far.url);
    far.reset();
    far.reply = () => ({ body: { code: 74, stdout: "", stderr: "ssh-workspace: no clutch-workspace component on the far side" } });
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true && answer.content.includes("did not answer with a clutch-workspace envelope"),
      "no component on the far side: reported as such instead of falling back to this machine");
    check(answer.content.includes("no clutch-workspace component"), "no component: the far side's stderr is carried through");
  }

  {
    configure(far.url);
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: "Traceback (most recent call last):\n  File ...", stderr: "" } });
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true && answer.content.includes("did not answer with a clutch-workspace envelope"),
      "prose on stdout is not mistaken for the CLI's envelope");
    check(answer.content.includes("Traceback"), "and the far side's own output is carried through for whoever reads it");
  }

  {
    // the chunked form stages in SEVERAL commands, so a staging failure is its
    // own step and the tool must not run after it
    configure(far.url, { CLUTCH_EXEC_MAX_COMMAND_BYTES: "2000", CLUTCH_EXEC_CHUNK_BYTES: "1200" });
    far.reset();
    far.reply = (command) =>
      command.startsWith("printf %s")
        ? { body: { code: 1, stdout: "", stderr: "no space left on device" } }
        : { body: { code: 0, stdout: "", stderr: "" } };
    const answer = await PLUGIN.call("write_file", { path: "z.txt", content: "y".repeat(5000) });
    check(answer.error === true && answer.content.includes("staging the payload on the far side failed"),
      "a staging step that fails stops the call there, with the step named");
    check(answer.content.includes("no space left on device"), "a staging failure keeps the far side's reason");
    check(far.seen.length === 2, "a failed staging step does not go on to run the tool");
  }

  // --------------------------------------------------------------- transport
  {
    configure(far.url);
    far.reply = () => ({ status: 503, body: { error: "not connected" } });
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true && /tunnel is not connected/i.test(answer.content),
      "a bridge whose tunnel dropped says so, instead of reporting a tool failure");
  }

  {
    configure("http://example.com:80");
    const answer = await PLUGIN.call("read_file", { path: "VERSION" });
    check(answer.error === true && /loopback/i.test(answer.content),
      "a bridge address that is not loopback is refused (the value is a capability, not a hint)");
  }

  {
    configure(far.url);
    const answer = await PLUGIN.call("list_dir", { path: "." });
    check(answer.error === true && answer.content.includes("unknown tool"), "an unpublished tool is refused by name, without a command");
    const noPath = await PLUGIN.call("read_file", {});
    check(noPath.error === true && noPath.content.includes("needs a path"), "a missing path is answered here, not by the far side");
  }

  {
    configure(far.url);
    far.reset();
    far.reply = () => ({ body: { code: 0, stdout: ENVELOPE({ content: "ok" }), stderr: "" } });
    // an operator override: a different interpreter on that machine
    process.env.CLUTCH_SSH_PYTHON = "/opt/py310/bin/python3";
    await PLUGIN.call("read_file", { path: "VERSION" });
    check(far.seen[0].includes(`PY='/opt/py310/bin/python3'`), "CLUTCH_SSH_PYTHON picks the far side's interpreter");
    delete process.env.CLUTCH_SSH_PYTHON;
  }

  far.close();
  summary("ssh-workspace");
}

main().catch((e) => {
  check(false, `suite crashed: ${(e && e.stack) || e}`);
  summary("ssh-workspace");
});
