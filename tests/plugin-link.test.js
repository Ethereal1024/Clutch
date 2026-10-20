// ui/plugin-link.js is the one place the client's plugin PATH is kept in step:
// the /call listener (ui/plugin-server.js), the reverse channel row that routes
// the far side's connection to it (tunnel-core), and the push that tells a
// session where to dial and with what token (agent/api/channel.py's POST).
//
// Three things can change under it and each on its own: a hop (a new far-side
// port), a window claiming a session (a new base to declare to), and the user
// installing, stopping or removing a plugin (a different set). This runner drives
// the REAL modules through all three, so what it pins is behaviour, not a mock:
//
//   * nothing is pushed before a forward exists — a session told to dial a port
//     nobody serves would fail every call with "the channel is not answering",
//     which is a worse lie than "this host has no channel";
//   * one install per client, however many windows ask, and the far side picks
//     the port (a channel with no contract port must never be asked for 8892);
//   * the push is the WHOLE set, in the words the target's parser reads (port,
//     token, components), with the token the listener really checks and no byte
//     about where the plugin lives on this machine;
//   * the same set is not re-published, a changed set is, an empty set is a
//     DELETE (the session's refusal then describes the state instead of dialling
//     a dead port), and a base that FAILED is not remembered — the next sync
//     retries it;
//   * two sessions are two pushes, a failed one does not stop the other;
//   * a lost hop forgets the port it was granted, and the next hop is asked for a
//     new one and re-pushed — the old port routes nowhere;
//   * stop() is a DELETE per session, a closed listener and no row left behind.
//
// The ssh wire is faked (an EventEmitter with forwardIn, as in the tunnel
// runners) and the session is a real HTTP server that parses the push the way
// agent/tools/channel.py does — so a renamed field fails here, not in the field.
// Everything else is the product: a real plugin installed in a throwaway root,
// forked by the real host, answering on a real loopback socket.
//
// Run: node tests/plugin-link.test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { EventEmitter } = require("events");

// The tunnel log and this client's plugin domain both live under HOME; point both
// at a throwaway directory before anything is required.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-plugin-link-"));
process.env.HOME = SCRATCH;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH;
const ROOT = path.join(SCRATCH, ".clutch", "client");
process.env.CLUTCH_CLIENT_COMPONENTS_DIR = ROOT;

const { check, summary } = require("./harness");
const pluginHost = require("../ui/plugin-host");
const pluginLink = require("../ui/plugin-link");
const tunnelCore = require("../ui/tunnel-core");

const COMPONENT = "clutch-probe";
const TOOL = "probe_search";

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

// A real plugin, installed the way a user's would be: a directory with its
// declaration and its entry, laid down by the real host (so the digest gate and
// the table are the product's, not this runner's).
function pluginDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-link-plugin-"));
  write(
    path.join(dir, "component.json"),
    JSON.stringify(
      {
        name: COMPONENT,
        version: "0.1.0",
        interface: "plugin",
        subject: "network",
        entry: "plugin.js",
        tools: [{ name: TOOL, description: "probe the client's own network", parameters: { properties: {} } }],
      },
      null,
      2
    ) + "\n"
  );
  write(path.join(dir, "plugin.js"), `exports.call = async (tool, args) => ({content: tool + ' ok'});\n`);
  return dir;
}

// ---- the fake ssh wire -----------------------------------------------------
//
// forwardIn is the whole of what tunnel-connect asks a client for; the far side
// grants (or refuses) in a later tick, exactly as ssh2's callback arrives.
class FakeWire extends EventEmitter {
  constructor() {
    super();
    this.forwards = [];
    FakeWire.last = this;
  }
  forwardIn(host, port, cb) {
    this.forwards.push({ host, port });
    const grant = port === 0 ? FakeWire.grant : port;
    process.nextTick(() => cb(null, grant));
  }
  end() {
    this.ended = true;
  }
}
FakeWire.grant = 47011;

// ---- the session's /api/channel, parsed as the target parses it -------------
//
// The body is held to agent/tools/channel.py's rules (a whole-number port, a
// 16+ character token with no whitespace, a non-empty list of plugin
// declarations that run elsewhere). A wrong field name is therefore a 400 the
// caller can see, not a pass that only looks like one.
function refusePush(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "a channel push must be a JSON object";
  const port = body.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `the channel's port must be a whole number between 1 and 65535, got ${JSON.stringify(port)}`;
  }
  if (body.host !== undefined && !["", "127.0.0.1", "localhost", "::1"].includes(body.host)) {
    return `the channel may only name a loopback address, got ${JSON.stringify(body.host)}`;
  }
  if (typeof body.token !== "string" || body.token.length < 16) return "the channel's token must be at least 16 characters";
  if (/\s/.test(body.token)) return "the channel's token may not contain spaces or control characters";
  const raw = body.components;
  if (!Array.isArray(raw) || !raw.length) return "a channel push must name at least one component";
  if (raw.length > 64) return "a channel push may name at most 64 components";
  const seen = new Set();
  for (const one of raw) {
    if (!one || typeof one !== "object") return "a declaration must be an object";
    if (typeof one.name !== "string" || !one.name) return "a declaration must name a component";
    if (seen.has(one.name)) return `the channel push names ${one.name} twice`;
    seen.add(one.name);
    if (one.interface !== "plugin") return `${one.name} is declared interface ${JSON.stringify(one.interface)}; a pushed component is a plugin`;
    if (one.runs_on !== "other") return `${one.name} is declared runs_on ${JSON.stringify(one.runs_on)}; a pushed component runs on the client`;
    if (!Array.isArray(one.tools) || !one.tools.length) return `${one.name} publishes no tool`;
    for (const tool of one.tools) if (!tool || typeof tool.name !== "string" || !tool.name) return "a tool must have a name";
  }
  return "";
}

function makeSession(label) {
  const api = { label, requests: [], mode: "ok", port: null, base: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (e) {
        body = undefined; // "was not JSON"
      }
      const url = String(req.url || "").split("?")[0];
      const answer = (status, payload) => {
        const buf = Buffer.from(JSON.stringify(payload), "utf8");
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length });
        res.end(buf);
      };
      api.requests.push({ method: req.method, url, body: body === undefined ? text : body });
      if (url !== "/api/channel") return answer(404, { error: `no ${url}` });
      if (api.mode === "fail") return answer(500, { error: "the session is not answering" });
      if (req.method === "POST") {
        if (body === undefined) return answer(400, { error: "bad json body" });
        const why = refusePush(body);
        if (why) return answer(400, { error: why });
        return answer(200, {
          status: "ok",
          live: true,
          port: body.port,
          components: body.components.map((c) => ({
            name: c.name,
            interface: c.interface,
            runs_on: c.runs_on,
            tools: c.tools.map((t) => t.name),
          })),
        });
      }
      if (req.method === "DELETE") return answer(200, { status: "ok", live: false, port: 0, components: [] });
      return answer(404, { error: "nothing here" });
    });
  });
  api.listen = () =>
    new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        api.port = server.address().port;
        api.base = `http://127.0.0.1:${api.port}`;
        resolve(api);
      });
    });
  api.close = () => new Promise((resolve) => server.close(resolve));
  api.writes = () => api.requests.filter((r) => r.method !== "GET");
  api.of = (method) => api.requests.filter((r) => r.method === method);
  return api;
}

function statusOf(results, base) {
  const hit = results.find((r) => r.base === base);
  return hit ? hit.status : "absent";
}

async function main() {
  // ---- the client's own domain: one real plugin, installed for real --------
  const host = pluginHost.createPluginHost({ root: ROOT });
  host.install({
    manifest: { name: COMPONENT, version: "0.1.0", interface: "plugin", subject: "network" },
    artifact: pluginDir(),
    version: "0.1.0",
  });
  check(host.list().length === 1, "the client holds one plugin before anything is linked");

  const apiA = await makeSession("A").listen();
  const apiB = await makeSession("B").listen();

  // ---- 1. nothing is pushed before a forward exists ------------------------
  //
  // A window claims a session before the tunnel has finished (or after the far
  // side refused the first ask). The base is remembered, and NOTHING is said:
  // a session told to dial a port that answers nothing fails every call with
  // "the channel is not answering", which is a worse lie than not being declared.
  const early = await pluginLink.offer(apiA.base);
  check(statusOf(early, apiA.base) === "no-forward", "a base claimed before any forward is recorded, not pushed to");
  check(apiA.requests.length === 0, "…and the session heard nothing at all");
  check(pluginLink.state.bases.has(apiA.base), "…while the base is kept, so the first push reaches it");

  // ---- 2. the CLAIM is what installs the far-side port --------------------
  //
  // A hop is not a reason to ask the far side for a loopback port: this path is
  // installed when a session is CLAIMED (main.js's api:base -> offer), which is
  // the first moment a session could call a plugin. apiA was claimed in section 1
  // while there was no hop; this claim has one.
  const wire = new FakeWire();
  tunnelCore.state.sshClient = wire; // what connectTunnel sets for the hop
  const claimed = await pluginLink.offer(apiA.base);
  check(
    wire.forwards.length === 1 && wire.forwards[0].port === 0 && wire.forwards[0].host === "127.0.0.1",
    `the claim asks the far side to pick a loopback port, never a contract port of ours (${JSON.stringify(wire.forwards)})`
  );
  check(apiA.of("POST").length === 1, "…and the session that claimed is told through it, in the same call");
  check(statusOf(claimed, apiA.base) === "unchanged", "…so the pass after the install has nothing left to say");

  // one install, however many windows are waiting on the same path
  const reasked = await Promise.all([pluginLink.offer(apiA.base), pluginLink.offer(apiA.base)]);
  check(wire.forwards.length === 1, `…and a later claim joins it instead of asking again (${wire.forwards.length})`);
  check(
    reasked.every((r) => statusOf(r, apiA.base) === "unchanged"),
    "…with nothing new to say to a session that already heard it"
  );
  const chan = pluginLink.state.chan;
  check(chan && chan.name === "plugin", "the row the tunnel routes by is registered under its own name");
  check(chan.remote() === FakeWire.grant, "the port the far side granted is what this client remembers");
  check(tunnelCore.channels.get("plugin") === chan && tunnelCore.channelFor(FakeWire.grant) === chan,
    "…so an inbound connection naming it reaches this row, not the model's");
  const listener = pluginLink.state.server;
  check(listener && listener.port() > 0, "the /call listener is up on a loopback port");
  check(listener.host.root === ROOT, "behind this client's OWN plugin root, not the session machine's");
  check(chan.local() === listener.port(), "and the row dials that listener and nothing else");

  // the base claimed before the forward landed was picked up by the install
  check(apiA.of("POST").length === 1, "the claim that predated the forward is pushed the moment the forward lands");

  // ---- 3. the push is the whole set, in the target's words ----------------
  const pushed = apiA.of("POST")[0];
  check(pushed.url === "/api/channel", `the push goes to the target's channel endpoint (${pushed.url})`);
  const body = pushed.body;
  check(body.port === FakeWire.grant, "it names the far-side port the session should dial");
  check(body.token === listener.token, "and the token this listener really checks");
  check(/^[0-9a-f]{48}$/.test(body.token), `a token that is a secret and not a spelling (${String(body.token).length} chars)`);
  check(body.components.length === 1, "one declaration for one installed plugin");
  const declared = body.components[0];
  check(declared.name === COMPONENT && declared.version === "0.1.0", "the declaration names the component and its version");
  check(declared.interface === "plugin" && declared.runs_on === "other", "as a plugin that runs on the client");
  check((declared.tools || []).length === 1 && declared.tools[0].name === TOOL, "its tools travel, so the session can offer them");
  check(
    declared.entry === undefined && declared.digest === undefined && declared.launch === undefined &&
      declared.command === undefined && declared.location === undefined,
    "and nothing about where its bytes live on THIS machine does"
  );
  // the fake session parsed it the way the target does, which is the proof that
  // the words line up — and the literals are pinned against the Python file, so a
  // rename on either side fails here instead of leaving both suites green.
  const channelPy = fs.readFileSync(path.join(__dirname, "..", "agent", "tools", "channel.py"), "utf8");
  check(channelPy.includes('payload.get("port")') && "port" in body, "the target reads the port this push writes");
  check(channelPy.includes('payload.get("token")') && "token" in body, "…and the token");
  check(channelPy.includes('payload.get("components")') && Array.isArray(body.components), "…and the declarations");
  check(channelPy.includes('payload.get("host", "")'), "…with an optional loopback host this push leaves alone");

  // ---- 4. the same set is not re-published --------------------------------
  //
  // A push is a replacement, so "the same set" has to mean the same bytes: a
  // window that re-claims the same session, or a refresh nobody asked for, must
  // not bump the session's generation and re-parse an unchanged table.
  const sameAgain = await pluginLink.refresh();
  check(statusOf(sameAgain, apiA.base) === "unchanged", "re-declaring an unchanged set is not a push");
  check(apiA.writes().length === 1, `…and the session heard it once, not twice (${apiA.writes().length})`);
  await pluginLink.offer(apiA.base);
  check(apiA.writes().length === 1, "a window re-claiming the same session changes nothing either");

  // ---- 5. a stopped plugin leaves the set, which is a DELETE --------------
  listener.host.setDisabled(COMPONENT, true);
  const stopped = await pluginLink.refresh();
  check(statusOf(stopped, apiA.base) === "cleared", "a set that became empty is a DELETE, not a push with nothing in it");
  check(apiA.of("DELETE").length === 1 && apiA.of("DELETE")[0].url === "/api/channel", "…which is the target's own verb for it");
  check(apiA.of("POST").length === 1, "…and no push is spent saying nothing");
  check(statusOf(await pluginLink.refresh(), apiA.base) === "unchanged", "the cleared set is remembered as the current one");
  check(apiA.writes().length === 2, "so a further refresh does not repeat the DELETE");

  listener.host.setDisabled(COMPONENT, false);
  const back = await pluginLink.refresh();
  check(statusOf(back, apiA.base) === "pushed" && apiA.of("POST").length === 2, "re-enabling it is a new push, because the set changed back");

  // ---- 6. two sessions are two pushes -------------------------------------
  const both = await pluginLink.offer(apiB.base);
  check(statusOf(both, apiA.base) === "unchanged", "a second session is told what it needs");
  check(statusOf(both, apiB.base) === "pushed", "…and the first session is not told again");
  check(apiB.of("POST").length === 1 && apiB.of("POST")[0].body.port === FakeWire.grant, "the second push names the same far-side port");
  check(pluginLink.state.bases.size === 2, "both bases are served from here on");

  // ---- 7. a failed push is not remembered, and does not stop the others ----
  //
  // A push happens only when the SET changes, so a failure is only reachable that
  // way: the plugin is stopped (an empty set, a DELETE) while session A is
  // answering with an error. A must be retried on the next sync — because a
  // failure that were remembered would mean the session keeps a declaration this
  // client no longer holds — while B, which is fine, is served in the same pass.
  apiA.mode = "fail";
  listener.host.setDisabled(COMPONENT, true);
  const failed = await pluginLink.refresh();
  check(statusOf(failed, apiA.base) === "failed", "a session that answers with an error is a failed push, not a silent one");
  check(/not answering/.test(String((failed.find((r) => r.base === apiA.base) || {}).error)), "…and the sentence it answered is what is reported");
  check(statusOf(failed, apiB.base) === "cleared", "while the session that is fine is served in the same pass");
  apiA.mode = "ok";
  const retried = await pluginLink.refresh();
  check(statusOf(retried, apiA.base) === "cleared", "the next sync retries the base that failed (the failure was not recorded)");
  check(statusOf(retried, apiB.base) === "unchanged", "…and still does not re-tell the one that worked");

  listener.host.setDisabled(COMPONENT, false);
  const restored = await pluginLink.refresh();
  check(statusOf(restored, apiA.base) === "pushed" && statusOf(restored, apiB.base) === "pushed",
    "the plugin coming back is a change both sessions are told about");

  // the token must never be sent anywhere but this machine's loopback: a base
  // that is not a loopback session is a refused push, not a dialled one
  const writesA = apiA.writes().length;
  const writesB = apiB.writes().length;
  const elsewhere = await pluginLink.offer("http://example.invalid:9999");
  check(statusOf(elsewhere, "http://example.invalid:9999") === "failed", "a base that is not a loopback session is refused");
  check(/loopback/.test(String((elsewhere.find((r) => r.base === "http://example.invalid:9999") || {}).error)),
    "…with a sentence that says so");
  check(apiA.writes().length === writesA && apiB.writes().length === writesB, "and nothing was written because of it");
  await pluginLink.forget("http://example.invalid:9999");

  // ---- 8. a lost hop forgets the port it was granted ----------------------
  //
  // The forward dies with the hop. The port the last hop was granted belongs to a
  // listener on the far side that is gone, so a push naming it would have every
  // call dial into nothing — the row must forget it, the sessions that hop
  // carried must be forgotten with it (a window re-claims when the ladder puts it
  // back), and the old port must stop routing.
  const postsBeforeHopLoss = apiA.of("POST").length;
  pluginLink.hopLost();
  check(chan.remote() === null, "a lost hop forgets the port it was granted");
  check(pluginLink.state.client === null, "…and the client the forward belonged to");
  check(pluginLink.state.bases.size === 0, "…and the sessions that hop was carrying");
  check(tunnelCore.channelFor(FakeWire.grant) === null, "…so the dead port routes nowhere");
  const nopush = await pluginLink.refresh();
  check(nopush.length === 0 && apiA.of("POST").length === postsBeforeHopLoss,
    "nothing is pushed into a session nobody has re-established");

  FakeWire.grant = 47022;
  const wire2 = new FakeWire();
  tunnelCore.state.sshClient = wire2;
  const relanded = await pluginLink.start(wire2);
  check(relanded === true && wire2.forwards.length === 1 && wire2.forwards[0].port === 0,
    "the next hop is asked to pick a port again (there is no contract port to re-bind)");
  check(chan.remote() === 47022, "…and the port it grants is the one remembered now");
  check(tunnelCore.channelFor(FakeWire.grant) === chan, "…which routes to this row");

  // the window re-claims its session on the new hop (main.js's api:base): that is
  // the moment the session learns where the channel moved, and it is a PUSH —
  // the port changed, so "the same set" is not the same declaration any more.
  const reoffered = await pluginLink.offer(apiA.base);
  check(statusOf(reoffered, apiA.base) === "pushed", "the session is re-declared on the new hop");
  const repushed = apiA.of("POST").filter((r) => r.body && r.body.port === 47022);
  check(repushed.length === 1, `…once, naming the port the new hop granted (${repushed.length})`);
  check(statusOf(await pluginLink.refresh(), apiA.base) === "unchanged", "…and not again until something changes");

  // ---- 9. a session going away is a DELETE -------------------------------
  const deletesBefore = apiB.of("DELETE").length;
  await pluginLink.forget(apiB.base);
  check(apiB.of("DELETE").length === deletesBefore + 1, "forgetting a session clears its channel");
  check(!pluginLink.state.bases.has(apiB.base), "…and stops serving it");
  check(statusOf(await pluginLink.refresh(), apiB.base) === "absent", "a forgotten base is not pushed to again");

  // ---- 10. stop() is the whole of it -------------------------------------
  const deadPort = listener.port();
  await pluginLink.stop();
  check(apiA.of("DELETE").length >= 1, "stopping the client clears the sessions it served");
  check(pluginLink.state.server === null && pluginLink.state.chan === null, "the listener and the row are gone");
  check(!tunnelCore.channels.has("plugin"), "…and nothing in the tunnel still routes to them");
  const after = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: deadPort, path: "/call", method: "POST" }, () => resolve("answered"));
    req.on("error", () => resolve("refused"));
    req.end();
  });
  check(after === "refused", "the port the far side knew answers nothing any more");
  await pluginLink.stop();
  check(pluginLink.state.bases.size === 0, "stopping twice is a no-op, not a second round of DELETEs");

  // ---- 11. a declaration about ANOTHER machine only travels with a live hop --
  //
  // `subject: foreign-fs` (clutch-ssh-workspace) says "the filesystem over there",
  // so its tools are only meaningful while a hop reaches there. Declared without
  // one, it would shadow the session's own `workspace-fs` component — whose
  // `read_file` works on this machine — with one that can only answer "no tunnel".
  // The gate is the hop's client, which this file already knows: set by start(),
  // cleared by stop() and by the tunnel's own hopLost().
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-link-foreign-"));
  write(
    path.join(foreign, "component.json"),
    JSON.stringify(
      {
        name: "clutch-ssh-workspace",
        version: "0.1.0",
        interface: "plugin",
        subject: "foreign-fs",
        entry: "plugin.js",
        tools: [{ name: "read_file", description: "read a file on the far side", parameters: { properties: {} } }],
      },
      null,
      2
    ) + "\n"
  );
  write(path.join(foreign, "plugin.js"), `exports.call = async () => ({content: 'far'});\n`);
  host.install({
    manifest: { name: "clutch-ssh-workspace", version: "0.1.0", interface: "plugin", subject: "foreign-fs" },
    artifact: foreign,
    version: "0.1.0",
  });
  check(pluginLink.state.client === null, "no hop is live right after stop()");
  check(pluginLink.snapshot().length === 0, "…and with no listener there is nothing to declare, far side or not");

  const wire3 = new FakeWire();
  FakeWire.grant = 47033;
  tunnelCore.state.sshClient = wire3;
  await pluginLink.start(wire3);
  const warm = pluginLink.snapshot();
  check(pluginLink.state.client === wire3, "a live hop's client is remembered, and that is what the snapshot reads");
  check(warm.some((c) => c.subject === "foreign-fs"), "on a live hop the far side's declaration travels");
  check(warm.some((c) => c.tools.some((t) => t.name === "read_file")), "…carrying the names the session offers");

  pluginLink.hopLost(); // what the tunnel does when the hop dies
  const cold = pluginLink.snapshot();
  check(
    !cold.some((c) => c.subject === "foreign-fs"),
    `and a hop that dies takes it back out of the set (${cold.map((c) => c.name).join(", ")})`
  );
  check(
    cold.some((c) => c.name === COMPONENT),
    "…while the client-local plugin stays: the rule is the subject, not the plugin"
  );
  await pluginLink.stop();

  await apiA.close();
  await apiB.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  summary("plugin-link");
}

main().catch((e) => {
  console.log("FAIL: " + ((e && e.stack) || e));
  process.exit(1);
});
