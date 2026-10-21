// ui/plugin-server.js is this client's half of the plugin channel: the loopback
// listener the far side's reverse forward dials. This runner drives the REAL
// server over a REAL socket against a throwaway root, so every claim it makes is
// about a request that crossed the wire — the same request agent/tools/channel.py
// makes (POST /call, Bearer token, {component, command, args} -> {content, error?}),
// where `command` is the statement the component declared for that tool.
//
// What it pins, in the order the file decides them: no token or a wrong one is
// 401 and never an answer; a path or verb the channel does not serve is 404; a
// body that is not a call is 400 with a reason; the token in the push is the only
// key; a call reaches the plugin with the model's arguments and comes back as the
// model-facing text; a plugin that fails gets `error:true` with ITS sentence (so
// the target does not prefix it as "the client refused"); a stopped plugin, an
// unknown tool and an uninstalled component are refusals in the same shape; a
// body larger than the cap is 413; the concurrent-call bound answers 429 instead
// of forking; and `declarations()` projects the installed table onto the words a
// session parses — no entry path, no digest, no launch, but the tool's `command`,
// because that template IS the call.
// Run: node tests/plugin-server.test.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { check, summary } = require("./harness");
const pluginHost = require("../ui/plugin-host");
const pluginServer = require("../ui/plugin-server");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-plugin-server-"));
const TOKEN = "0123456789abcdef0123456789abcdef";

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

// The plugin under test: a real component directory, installed the way a user's
// plugin would be, whose entry answers one tool and fails on demand.
function pluginDir(name, { delayMs = 0, tool = "probe_search", extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clutch-${name}-`));
  write(
    path.join(dir, "component.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        interface: "plugin",
        subject: "network",
        entry: "plugin.js",
        ui: { label: "probe" },
        tools: [
          {
            name: tool,
            description: "probe the client's own network",
            parameters: { properties: { q: { type: "string" } }, required: ["q"] },
            // the statement the client itself will render (D3 step ③): the
            // session sends it back verbatim and this side makes argv of it
            command: `${tool} {*}`,
            // a plugin tool may carry policy words: they travel, they do not run
            access: "read",
            access_arg: "q",
            modes: ["work"],
          },
        ],
        ...extra,
      },
      null,
      2
    )
  );
  write(
    path.join(dir, "plugin.js"),
    `"use strict";
const delay = ${delayMs};
exports.run = async (argv) => {
  const [tool, raw] = [argv[0], argv[1] || "{}"];
  const args = JSON.parse(raw);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (args && args.boom) throw new Error("the backend said no");
  return { content: tool + " saw " + JSON.stringify(args), error: false };
};
`
  );
  return dir;
}

function install(host, name, options) {
  const artifact = pluginDir(name, options);
  return host.install({
    manifest: { name, version: "0.1.0", interface: "plugin", subject: "network" },
    artifact,
    version: "0.1.0",
  });
}

// One request to the listener, answering {status, body, headers}.
function request(port, { method = "POST", url = "/call", token = TOKEN, body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
    const headers = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          parsed = null;
        }
        resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
      });
    });
    req.on("error", (e) => resolve({ status: 0, body: null, text: String(e && e.message), headers: {} }));
    if (payload) req.write(payload);
    req.end();
  });
}

// One call over the wire: a component and the STATEMENT it declared (never a tool
// name — the statement is the identity, and the client checks it against its own
// declaration byte for byte).
function call(port, component, command, args, token) {
  return request(port, { token, body: JSON.stringify({ component, command, args }) });
}

const STATEMENT = (tool) => `${tool} {*}`;

async function main() {
  const host = pluginHost.createPluginHost({ root: ROOT });
  install(host, "clutch-probe");
  install(host, "clutch-slow", { delayMs: 400 });

  // ---- the listener itself ----
  const server = pluginServer.createPluginServer({ host, token: TOKEN });
  check(server.port() === null, "a server that was never asked to listen has no port");
  const port = await server.listen();
  check(typeof port === "number" && port > 0, "listen() answers the loopback port it really bound");

  // A second listen() is the same listener, not a second one: the token and the
  // port a push names must not be able to disagree with the socket.
  check((await server.listen()) === port, "listening twice answers the same port");

  // ---- the token is the whole door ----
  let got = await call(port, "clutch-probe", STATEMENT("probe_search"), { q: "x" }, null);
  check(got.status === 401, "a call with no token is refused");
  check(!got.text.includes(TOKEN), "and the refusal never echoes the token");

  got = await call(port, "clutch-probe", STATEMENT("probe_search"), { q: "x" }, "not-the-token");
  check(got.status === 401, "a wrong token is refused");

  got = await call(port, "clutch-probe", STATEMENT("probe_search"), { q: "x" }, TOKEN.slice(0, -1));
  check(got.status === 401, "a token that is a prefix of the real one is refused");

  // ---- the surface is one path and one verb ----
  got = await request(port, { method: "GET", url: "/call" });
  check(got.status === 404, "GET /call is not a call");

  got = await request(port, { url: "/run", body: JSON.stringify({ component: "clutch-probe", command: STATEMENT("probe_search") }) });
  check(got.status === 404 && /POST \/call/.test(String(got.body && got.body.error)), "another path is not a call, and the answer says which one is");

  got = await request(port, { body: "{not json" });
  check(got.status === 400 && /JSON/.test(got.body.error), "a body that is not JSON is a 400 with a reason");

  got = await request(port, { body: JSON.stringify({ component: "clutch-probe" }) });
  check(got.status === 400 && /component and a statement/.test(got.body.error), "a call that names no statement is a 400 with a reason");

  got = await request(port, { body: JSON.stringify({ component: "clutch-probe", command: "probe_search {*}", tool: "probe_search" }) });
  check(got.status === 200, "…while a component and a statement is a call (the old `tool` word is simply not read)");

  // ---- a real call reaches the plugin and comes back as the model's text ----
  got = await call(port, "clutch-probe", STATEMENT("probe_search"), { q: "hello" });
  check(got.status === 200 && got.body.error === false, "a good call is a 200 with error:false");
  check(got.body.content === 'probe_search saw {"q":"hello"}', "the plugin saw the model's arguments");
  check(got.headers["cache-control"] === "no-store", "and nothing about it is cached");

  // ---- the two halves of one contract ----
  // The caller is agent/tools/channel.py, in another language, in another repo
  // tree, and a rename on either side would leave both suites green and the
  // product silent. So the literals the wire is made of are pinned against that
  // file: the path it dials, the header it sends, and the body it writes.
  const channelPy = fs.readFileSync(path.join(__dirname, "..", "agent", "tools", "channel.py"), "utf8");
  check(
    channelPy.includes('CALL_PATH = "/call"') && pluginServer.CALL_PATH === "/call",
    "the target dials the path this listener serves"
  );
  check(
    channelPy.includes('f"Bearer {held.token}"') &&
      channelPy.includes('"component": component, "command": command, "args": dict(args)'),
    "and asks with the bearer header and {component, command, args}"
  );
  check(
    channelPy.includes("answer.get(\"content\")") && got.body.content !== undefined,
    "and reads the {content, error?} this listener answers"
  );

  // ---- a plugin failure is an ANSWER with error:true ----
  // Distinct from a 4xx on purpose: the target renders a non-2xx as "the client
  // refused the call", which would be false — the plugin ran, and failed.
  got = await call(port, "clutch-probe", STATEMENT("probe_search"), { q: "x", boom: true });
  check(got.status === 200 && got.body.error === true, "a plugin that throws is a 200 with error:true");
  check(/the backend said no/.test(got.body.content), "and the model reads the plugin's own sentence");

  got = await call(port, "clutch-probe", "probe_search --force {*}", { q: "x" });
  check(got.status === 200 && got.body.error === true, "a statement the plugin never declared is an error answer");
  check(/declares no tool with the statement/.test(got.body.content), "and the sentence names the mistake, and what it does offer");

  got = await call(port, "clutch-absent", STATEMENT("probe_search"), {});
  check(got.status === 200 && got.body.error === true && /not installed/.test(got.body.content), "an uninstalled component is an error answer, not a 404");

  // ---- a stopped plugin must not run ----
  host.setDisabled("clutch-probe", true);
  got = await call(port, "clutch-probe", STATEMENT("probe_search"), { q: "x" });
  check(got.status === 200 && got.body.error === true && /stopped/.test(got.body.content), "a stopped plugin is refused, with the word for it");
  check(!pluginServer.declarations(host).some((c) => c.name === "clutch-probe"), "and it is not declared to any session");
  host.setDisabled("clutch-probe", false);

  // ---- the body cap ----
  const huge = JSON.stringify({ component: "clutch-probe", command: STATEMENT("probe_search"), args: { q: "x".repeat(pluginServer.MAX_CALL_BYTES) } });
  got = await request(port, { body: huge });
  check(got.status === 413, "a call body over the cap is refused before it is parsed");
  check(/larger than/.test(String(got.body && got.body.error)), "and says so");

  // ---- one session cannot make this machine fork without bound ----
  const bounded = pluginServer.createPluginServer({ host, token: TOKEN, maxConcurrent: 1 });
  const bport = await bounded.listen();
  const first = call(bport, "clutch-slow", STATEMENT("probe_search"), { q: "slow" });
  await new Promise((r) => setTimeout(r, 60)); // the fork is running, the slot is taken
  const second = await call(bport, "clutch-slow", STATEMENT("probe_search"), { q: "second" });
  check(second.status === 429 && /already running/.test(second.body.error), "a call over the concurrent bound is a 429 with a reason");
  const settled = await first;
  check(settled.status === 200 && settled.body.error === false, "while the call that held the slot still finishes");
  await bounded.stop();

  // ---- what a session is told ----
  const declared = pluginServer.declarations(host);
  const probe = declared.find((c) => c.name === "clutch-probe");
  check(!!probe, "an installed, enabled plugin is declared");
  check(probe.interface === "plugin" && probe.runs_on === "other", "as a plugin that runs on the client");
  check(probe.version === "0.1.0", "with the version it is installed as");
  check(probe.subject === "network", "and the subject it serves");
  const tool = (probe.tools || [])[0] || {};
  check(tool.name === "probe_search" && !!tool.description && !!tool.parameters, "its tool travels with description and schema");
  check(tool.access === "read" && tool.access_arg === "q" && tool.modes.join() === "work", "policy words travel: the host interprets them");
  check(tool.command === "probe_search {*}", "and the statement it runs, because that is what a call sends back");
  check(tool.defaults === undefined, "…while `defaults` does not: no host renders a plugin's arguments");
  check(probe.entry === undefined && probe.digest === undefined && probe.launch === undefined && probe.location === undefined, "and neither does where its bytes live on this machine");

  // ---- stop is the whole of it ----
  await server.stop();
  got = await call(port, "clutch-probe", STATEMENT("probe_search"), { q: "x" });
  check(got.status === 0, "after stop() nothing answers on that port any more");
  check(server.port() === null && server.stopped(), "and the server says it is stopped");

  fs.rmSync(ROOT, { recursive: true, force: true });
  summary("plugin-server");
}

main().catch((e) => {
  console.log("FAIL: " + ((e && e.stack) || e));
  process.exit(1);
});
