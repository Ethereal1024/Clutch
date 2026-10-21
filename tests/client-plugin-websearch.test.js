// The first real client plugin, installed and called the way a user's would be.
//
// clutch-websearch/plugin is the JavaScript port of `web_search`/`web_fetch`: two
// tools whose subject is the network, implemented on the machine the user is
// looking at, declared to a session over the channel. Three files meet here and
// none of them is faked:
//
//   * ui/plugin-host.js installs the directory the way a checkout/dev install
//     does (copy, declaration merge, a row in the client's own table) and forks
//     the entry once per call;
//   * ui/plugin-server.js holds the ONE door the target's channel has;
//   * ui/plugin-server.js#declarations() is what travels — the assertion that
//     matters most, because a field that leaks here (an `entry`, a `location`)
//     would describe this machine's files to another one.
//
// The search stub is a real loopback socket and the legs are pointed at it with
// the `CLUTCH_*_URL` seams (a fork has no monkeypatch seam); the submodule's own
// suite covers the parsers and the coverage guard in more detail.
//
// Skipped, loudly, when the submodule is not checked out: CI never fetches
// submodules, and "the plugin is not here" is not a regression.
//
// Run: node tests/client-plugin-websearch.test.js

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// The client plugin domain and the tunnel log both live under HOME; point them at
// a throwaway directory before anything that reads them is required.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-plugin-websearch-"));
process.env.HOME = SCRATCH;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH;
const ROOT = path.join(SCRATCH, ".clutch", "client");
process.env.CLUTCH_CLIENT_COMPONENTS_DIR = ROOT;

const PLUGIN = path.join(__dirname, "..", "clutch-websearch", "plugin");
if (!fs.existsSync(path.join(PLUGIN, "component.json"))) {
  console.log("skipped: clutch-websearch/plugin is not checked out (the submodule is absent)");
  process.exit(0);
}

const { check, summary } = require("./harness");
const pluginHost = require("../ui/plugin-host");
const pluginServer = require("../ui/plugin-server");

const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN, "component.json"), "utf8"));
const NAME = MANIFEST.name;
const TOKEN = "websearch-plugin-channel-token-01"; // >= MIN_TOKEN, no whitespace

// A searxng-shaped stub, and two keyless endpoints that answer "blocked": tier 0
// answering means tier 1 is never contacted, so this is the whole network.
function stub() {
  const hits = Object.create(null);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub.invalid");
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    const send = (status, type, body) => {
      const buffer = Buffer.from(String(body), "utf8");
      res.writeHead(status, { "Content-Type": type, "Content-Length": buffer.length });
      res.end(buffer);
    };
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      return send(
        200,
        "application/json",
        JSON.stringify({
          results: [
            { title: `About ${q}`, url: "https://example.com/first", content: `a snippet mentioning ${q}` },
            { title: `More on ${q}`, url: "https://example.com/second", content: `another snippet about ${q}` },
          ],
        })
      );
    }
    return send(404, "text/plain", "blocked");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, port: server.address().port }));
  });
}

// One call to the client's listener, exactly as agent/tools/channel.py sends it.
function call(port, payload, { token = TOKEN, raw = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(raw === undefined ? JSON.stringify(payload) : raw, "utf8");
    const headers = { "Content-Type": "application/json", "Content-Length": body.length };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = http.request({ host: "127.0.0.1", port, path: "/call", method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let data = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (e) {
          data = null;
        }
        resolve({ status: res.statusCode, data });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

// A write attempt that carries the token: the point is that the door is not there,
// not that the token was missing.
function put(url, payload) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    const request = http.request(url, { method: "PUT", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    request.on("error", reject);
    request.end(payload || "");
  });
}

async function main() {
  const net = await stub();
  const BASE = `http://127.0.0.1:${net.port}`;
  process.env.CLUTCH_SEARXNG_URL = BASE;
  process.env.CLUTCH_BING_URL = `${BASE}/bing`;
  process.env.CLUTCH_DDG_URL = `${BASE}/ddg`;
  for (const name of ["CLUTCH_TAVILY_API_KEY", "TAVILY_API_KEY", "CLUTCH_MARGINALIA_KEY", "MARGINALIA_API_KEY"]) {
    delete process.env[name];
  }
  delete process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS; // the fence must be on

  const host = pluginHost.createPluginHost({ root: ROOT });
  const record = host.install({ manifest: MANIFEST, artifact: PLUGIN, version: MANIFEST.version });
  check(record.name === NAME, "the plugin installs into the client's own root");
  check(record.interface === "plugin", "as a plugin");
  // A checkout install has no digest to measure, so the version is the one the
  // component declares; the digest-suffixed form arrives with an artifact file.
  check(record.version === MANIFEST.version, "under the version it declares");
  check(host.list().length === 1, "one row in the client's table");

  // What the target actually reads: the projection, not the manifest.
  const declared = pluginServer.declarations(host);
  check(declared.length === 1, "one declaration to push");
  const out = declared[0] || {};
  check(out.name === NAME && out.version === record.version, "named, with the installed version");
  check(out.interface === "plugin" && out.runs_on === "other", "in the two words that say whose process it is");
  check(out.subject === "network", "and what its subject is");
  check(!("entry" in out) && !("location" in out) && !("digest" in out), "no byte about this machine travels");
  const tools = out.tools || [];
  check(
    tools.map((tool) => tool.name).join(",") === "web_search,web_fetch",
    "the two tools the session may offer"
  );
  check(
    tools.every((tool) => typeof tool.description === "string" && tool.description.length > 40),
    "each with the model-facing description the host's parser requires"
  );
  check(
    tools.every((tool) => tool.command === `${tool.name} {*}`),
    "and the statement it runs — the template the session sends back verbatim"
  );
  check(
    tools.every((tool) => !("defaults" in tool)),
    "…while `defaults` stays here: no host renders a plugin's arguments"
  );

  const listener = pluginServer.createPluginServer({ host, token: TOKEN });
  const port = await listener.listen(0);

  const searched = await call(port, { component: NAME, command: "web_search {*}", args: { query: "alpha beta" } });
  check(searched.status === 200 && searched.data && searched.data.error === false, "a search through /call answers");
  check(
    searched.data && /results for "alpha beta" \(via searxng\)/.test(searched.data.content || ""),
    "with the fused answer, through the forked entry"
  );
  check((net.hits["/search"] || 0) >= 1, "the call really reached the stub (the forked child saw the seams)");
  check((net.hits["/bing"] || 0) === 0, "and never contacted the keyless tier");

  const fetched = await call(port, { component: NAME, command: "web_fetch {*}", args: { url: `http://127.0.0.1:${net.port}/` } });
  check(
    fetched.status === 200 && fetched.data && fetched.data.error === true,
    "a model-supplied loopback URL is a 200 carrying a failure, not a refusal of the call"
  );
  check(
    /^ERROR: non-public host refused: 127\.0\.0\.1/.test((fetched.data && fetched.data.content) || ""),
    "and the sentence names the host"
  );

  const unknown = await call(port, { component: NAME, command: "delete_everything {*}", args: {} });
  check(
    unknown.status === 200 && unknown.data && unknown.data.error === true,
    "an unpublished tool is the same kind of answer"
  );
  check(
    /declares no tool with the statement/.test(unknown.data.content || ""),
    "and says what it declares instead"
  );

  const unauthorised = await call(port, { component: NAME, command: "web_search {*}", args: { query: "x" } }, { token: "wrong-token-wrong-token" });
  check(unauthorised.status === 401, "a wrong token is a 401 at the door");
  check(/bad or missing token/.test((unauthorised.data && unauthorised.data.error) || ""), "with a sentence, not the token");

  const malformed = await call(port, null, { raw: "{" });
  check(malformed.status === 400, "a body that is not JSON is a 400");

  // The domain's PUT is not "sync": a client's table is written by its own
  // installs, so a remote write is refused rather than merged.
  const refused = await put(`http://127.0.0.1:${port}/api/plugins`, "{}");
  check(refused === 404 || refused === 501, "there is no remote install door on this listener");

  await listener.stop();
  const removed = host.remove(NAME);
  check(removed.status === "removed", "the plugin can be taken off this client");
  check(pluginServer.declarations(host).length === 0, "and the next push declares nothing");
  check(!fs.existsSync(path.join(ROOT, NAME)), "the bytes go with it");

  net.server.close();
}

main()
  .then(() => summary("client-plugin-websearch", "the websearch client plugin works end to end"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
