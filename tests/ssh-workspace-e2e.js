// The ssh-workspace plugin end to end, short of ssh itself: the REAL component,
// installed through the REAL host installer and called through the REAL plugin
// server's /call, over a bridge that speaks ui/exec-bridge.js's POST /exec
// contract but runs the command on this machine.
//
// Why this exists beside tests/ssh-workspace.test.js: that one stubs the bridge
// and asserts argv/quoting/envelopes. It cannot tell you that the four tools
// still answer what the component answers, because its far side is a canned
// string. Here the far side is the actual `python -m clutch_workspace --json`,
// so the answer is compared with the component's own — and that comparison is
// the whole promise of this plugin (see COMPONENTS.md §三: no second
// definition of what "read" means). The ssh hop in between is what
// tests/tunnel*.test.js pins; nothing here needs a network or a key.
//
// The oracle is the COMPONENT, not a shell CLI that prints. A printing wrapper's
// stdout gains a trailing newline the tool's content does not have (the VERSION
// file carries no trailing newline) and it has no separate diff field, so
// comparing against one would have "found" two bugs that are not there — that is
// exactly what the retired scripts/ws-stopgap taught, and why it is gone.
//
// Not named *.test.js on purpose: it needs a Python interpreter (and the
// clutch-workspace checkout), so it stays out of the offline `tests/*test*.js`
// manifest — the same reason tests/remote-bootstrap-e2e.js is not in it.
//
// Run: node tests/ssh-workspace-e2e.js
//      CLUTCH_SSH_PYTHON=/path/to/python node tests/ssh-workspace-e2e.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");

const harness = require("./harness");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN = path.join(ROOT, "clutch-ssh-workspace");
const COMPONENT = path.join(ROOT, "clutch-workspace", "clutch_workspace");
const pluginHost = require(path.join(ROOT, "ui", "plugin-host"));
const pluginServer = require(path.join(ROOT, "ui", "plugin-server"));
const { modelText } = require(path.join(PLUGIN, "index.js"));

// The interpreter the plugin will use on the far side (CLUTCH_SSH_PYTHON wins,
// exactly like clutch-ssh-workspace/lib/settings.js). The venv is the dev default;
// a bare python3 is enough for the component.
function interpreter() {
  const stated = String(process.env.CLUTCH_SSH_PYTHON || "").trim();
  if (stated) return stated;
  const venv = path.join(ROOT, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

function skip(reason) {
  console.log(`ssh-workspace e2e: skipped (${reason})`);
  process.exit(0);
}

// The workspace root the plugin enters is this checkout, because that is where
// the payload files have to land for the assertions to see them — and because the
// plugin's preamble prefers a checkout over an installed copy, which is what makes
// the far side here the code in the working tree.
process.env.CLUTCH_SSH_WORKSPACE = ROOT;
process.env.CLUTCH_SSH_PYTHON = interpreter();

function check(ok, label, detail) {
  harness.check(ok, label);
  if (!ok && detail) console.log("      " + String(detail).replace(/\n/g, "\n      "));
}

// POST /exec, run locally: {command} -> {code, stdout, stderr}.
function startBridge() {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/exec") {
      response.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch (e) {
        response.writeHead(400).end("bad json");
        return;
      }
      const command = String(body.command || "");
      const timeout = Number(body.timeout) || 60000;
      execFile(
        "sh",
        ["-c", command],
        { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ code, stdout: stdout || "", stderr: stderr || "" }));
        }
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  );
}

function call(port, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/call",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Authorization: "Bearer e2e-token-0123456789abcdef",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (e) {
            data = null;
          }
          resolve({ status: response.statusCode, data });
        });
      }
    );
    request.on("error", reject);
    request.end(payload);
  });
}

// The component's own answer to the same call: `--json`, same argv, same root.
function reference(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.env.CLUTCH_SSH_PYTHON,
      ["-m", "clutch_workspace", "--json"].concat(args),
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "clutch-workspace") }),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error("the component itself failed: " + error.message + "\n" + stderr));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error("the component did not print an envelope: " + stdout.slice(0, 300)));
        }
      }
    );
    if (typeof stdin === "string") child.stdin.end(stdin);
  });
}

async function main() {
  if (!fs.existsSync(COMPONENT)) skip("no clutch-workspace checkout (the far side's component)");
  if (!process.env.CLUTCH_SSH_PYTHON) skip("no interpreter");

  // Payload files live under the workspace root (that is the far side's cwd), in a
  // directory named for this run so a failure leaves its evidence and a pass leaves
  // nothing.
  const sandbox = path.join(ROOT, `.e2e-ssh-workspace-${process.pid}`);
  fs.mkdirSync(sandbox, { recursive: true });
  const scratch = path.relative(ROOT, sandbox); // the plugin speaks workspace-relative paths
  const at = (name) => path.join(sandbox, name);

  const { server, port } = await startBridge();
  const clientRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-e2e-client-"));
  const host = pluginHost.createPluginHost({
    root: clientRoot,
    execBridge: () => `http://127.0.0.1:${port}`,
    execLimits: { maxCommandBytes: 6000, chunkBytes: 3500 },
    log: () => {},
  });

  let listener = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, "component.json"), "utf8"));
    const record = host.install({ manifest, artifact: PLUGIN, version: manifest.version });
    console.log(`ssh-workspace e2e: installed ${record.name}@${record.version}, far side ${process.env.CLUTCH_SSH_PYTHON}`);

    listener = pluginServer.createPluginServer({ host, token: "e2e-token-0123456789abcdef" });
    const callPort = await listener.listen(0);
    // A call carries the tool's STATEMENT, read out of the declaration the way a
    // client reads it — never the tool's name (D3 落地③). `{*}` is what the tool
    // itself forwards, so the far side still receives `--json <tool> …`.
    const statementOf = (tool) => {
      const spec = (manifest.tools || []).find((entry) => entry.name === tool);
      if (!spec || !spec.command) throw new Error(`the declaration has no statement for ${tool}`);
      return spec.command;
    };
    const invoke = (tool, args) => call(callPort, { component: record.name, command: statementOf(tool), args });

    // 1. read_file: the component's own answer. VERSION has no trailing newline,
    //    so a transport that "tidies" stdout is caught right here.
    const wantVersion = await reference(["read_file", "--path", "VERSION"]);
    const gotVersion = await invoke("read_file", { path: "VERSION" });
    check(
      gotVersion.status === 200 && gotVersion.data && gotVersion.data.content === wantVersion.content,
      "read_file VERSION is the component's own answer",
      JSON.stringify({ got: gotVersion.data, want: wantVersion.content })
    );

    // 2. grep: same hits, same text (paths, formatting and the harness's own
    //    "(no matches)" included).
    const wantGrep = await reference(["grep", "--pattern", "ssh-workspace", "--include", "*.md"]);
    const gotGrep = await invoke("grep", { pattern: "ssh-workspace", include: "*.md" });
    check(
      gotGrep.status === 200 && gotGrep.data && gotGrep.data.content === wantGrep.content,
      "grep is the component's own answer",
      JSON.stringify({ got: String(gotGrep.data && gotGrep.data.content).slice(0, 400), want: String(wantGrep.content).slice(0, 400) })
    );

    // 3. write_file: a body with quotes, $, backticks, a backslash, an embedded
    //    CRLF and NO trailing newline. The bytes on disk decide — a heredoc would
    //    have added the newline it lacks.
    const payload = "q'uo\"te $HOME `cmd` \\ back\nline two\r\nno trailing newline";
    const wrote = await invoke("write_file", { path: `${scratch}/payload.txt`, content: payload });
    check(
      wrote.status === 200 && wrote.data && wrote.data.error === false,
      "write_file answers without error",
      JSON.stringify(wrote.data).slice(0, 400)
    );
    check(
      fs.readFileSync(at("payload.txt"), "utf8") === payload,
      "write_file landed the exact bytes (no heredoc newline)",
      JSON.stringify(fs.readFileSync(at("payload.txt"), "utf8"))
    );

    // 4. the same payload past the command budget: the staged/chunked path must
    //    land the same bytes, because the budget is about argv, not content.
    const big = "0123456789".repeat(2000) + "END\n"; // ~20 KB, far over 6000 bytes
    const wroteBig = await invoke("write_file", { path: `${scratch}/big.txt`, content: big });
    const bigOnDisk = fs.readFileSync(at("big.txt"), "utf8");
    check(
      wroteBig.status === 200 && wroteBig.data && wroteBig.data.error === false,
      "a 20 KB write_file answers without error (the chunked path)",
      JSON.stringify(wroteBig.data).slice(0, 400)
    );
    check(bigOnDisk === big, "the chunked write is byte-exact", `len ${bigOnDisk.length} vs ${big.length}`);

    // 5. edit_file against the component's own edit of the same bytes. CRLF
    //    normalizes on purpose (the component reads universal and writes
    //    newline="\n"), so the oracle decides what "right" is, not this file.
    fs.copyFileSync(at("payload.txt"), at("payload.ref.txt"));
    const wantEdit = await reference([
      "edit_file",
      "--path",
      `${scratch}/payload.ref.txt`,
      "--old-string",
      "line two",
      "--new-string",
      "LINE 2",
    ]);
    const referenceBytes = fs.readFileSync(at("payload.ref.txt"));
    const edited = await invoke("edit_file", {
      path: `${scratch}/payload.txt`,
      old_string: "line two",
      new_string: "LINE 2",
    });
    const editedBytes = fs.readFileSync(at("payload.txt"));
    check(
      edited.status === 200 && edited.data && edited.data.error === false,
      "edit_file answers without error",
      JSON.stringify(edited.data).slice(0, 400)
    );
    check(
      editedBytes.equals(referenceBytes),
      "edit_file lands the component's own bytes",
      JSON.stringify(editedBytes.toString("utf8")) + " vs " + JSON.stringify(referenceBytes.toString("utf8"))
    );
    // The envelope carries the diff beside the content; the plugin appends it (the
    // model must see what changed). Same concatenation, same bytes — with the probe
    // file's name folded back onto the file the plugin actually edited.
    const wantText = modelText(wantEdit).split("payload.ref.txt").join("payload.txt");
    check(
      String(edited.data && edited.data.content) === wantText,
      "edit_file reports the component's own message (content + diff)",
      JSON.stringify({ got: edited.data && edited.data.content, want: wantText })
    );

    const reread = await invoke("read_file", { path: `${scratch}/payload.txt` });
    check(
      reread.status === 200 && reread.data && reread.data.content === editedBytes.toString("utf8"),
      "read_file returns what write_file+edit_file put there",
      JSON.stringify(reread.data).slice(0, 400)
    );

    // 6. a missing file is the far side's own refusal (EX_NOINPUT, envelope error
    //    set), not a crash or an empty success on this side.
    const missing = await invoke("read_file", { path: `${scratch}/nope.txt` });
    check(
      missing.status === 200 &&
        missing.data &&
        (missing.data.error === true || /no such file|file not found/i.test(String(missing.data.content))),
      "a missing file comes back as the component's own answer",
      JSON.stringify(missing.data).slice(0, 400)
    );
  } finally {
    if (listener) await listener.stop();
    server.close();
    fs.rmSync(clientRoot, { recursive: true, force: true });
    if (harness.failures) console.log(`      (kept ${sandbox} for inspection)`);
    else fs.rmSync(sandbox, { recursive: true, force: true });
  }

  harness.summary("ssh-workspace e2e", "the component's four answers survive the round trip");
}

main().catch((error) => {
  console.error(error && error.stack);
  process.exit(2);
});
