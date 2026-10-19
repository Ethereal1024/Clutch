// The far side's model path, when the port it was promised is taken.
//
// A remote session's --base-url is fixed when it is spawned and points at
// 127.0.0.1:<port> on the FAR host, forwarded back here to this window's LLM
// proxy. 8892 is that port by contract (tunnel-core's LLM_PROXY_REMOTE_PORT),
// and it is the one the reverse forward asks for first — but the port belongs to
// the far machine, and a listener left there by a session this window no longer
// owns cannot be reached, cannot be killed and, with sshd's keepalive off by
// default, need not go away for hours. Asking for 8892 until the ladder is
// exhausted and then declaring the connect failed is what a field report saw as
// "stuck on Starting tunnel…": the redial ladder retried a decision that could
// only repeat, while the far host was perfectly able to forward on another port.
//
// This runner drives the REAL connectTunnel over a fake ssh2 wire whose sshd
// refuses 8892 and grants a port of its own choosing, and pins the whole chain:
//   * the preferred port is tried first, and the ask for a port of the far
//     side's own only happens after that ladder is exhausted;
//   * the connect is called GOOD, and the port that landed is what every later
//     hop re-binds and what a session spawned now is pointed at (remoteLlmBase);
//   * an inbound forward naming the granted port reaches this window's LLM proxy
//     (the proxy answers 404 on a non-LLM path — an answer is the proof), while
//     one naming 8892 is refused rather than answered by nobody.
//   * the routing rule is a TABLE (tunnel-core's channels), not a model special
//     case: a port no row names is refused, a row with no listener behind it is
//     refused, and a second row sends its own port to its own listener and
//     remembers the port the far side granted it. That is the shape stage 4's
//     frontend plugin channel is added in — one row, no change to the tunnel.
//
// The wire is faked (ssh2 module seam, as in tunnel-concurrent-dial-test.js) but
// nothing else is: the real llm-proxy is started, the real local forward serves
// the gate's health check, and only the far-side bootstrap (probe/install/tar)
// is stubbed, because it is not what this test is about.
//
// Run: node tests/tunnel-reverse-port-test.js

"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const { EventEmitter } = require("events");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-rport-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");

// The port the fake far side hands over when it is asked to pick one.
const GRANTED = 46123;

// ---- the far-side bootstrap, stubbed at its module seam --------------------
//
// connectTunnel asks this file who is on the far end and whether the server is
// installed. Both answers are "yes, a modern host, already running" so the
// runner reaches the forwards — the part under test — without a remote shell.
const bootPath = require.resolve("../ui/tunnel-bootstrap");
const bootMod = new Module(bootPath);
bootMod.filename = bootPath;
bootMod.loaded = true;
bootMod.exports = {
  PROBE_CMD: "clutch-probe",
  parseProbe: () => ({ os: "linux", home: "/home/far", version: "0.0.0-test" }),
  installServer: async () => ({ ok: true }),
  installComponents: () => {},
};
require.cache[bootPath] = bootMod;

// ---- the fake ssh2 wire ----------------------------------------------------

class FakeClient extends EventEmitter {
  constructor(opts) {
    super();
    FakeClient.last = this;
    this.opts = opts;
    this.forwards = []; // every (port) the reverse forward asked for
    this.forwardedTo = null; // where the local forward dialed through us
    this.ended = false;
  }
  connect() {
    process.nextTick(() => this.emit("ready"));
  }
  // remoteExec's shape: a stream with a stderr stream and a close code
  exec(_cmd, cb) {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    process.nextTick(() => {
      cb(null, stream);
      stream.emit("close", 0);
    });
  }
  // the far sshd: it holds 8892 (the listener this window cannot reach), and
  // when asked for a port of its own choosing it binds one and reports it.
  // With FakeClient.silent set it is the far side of the 0.1.47 report: it takes
  // the request and says NOTHING — no error, no port, no disconnection.
  forwardIn(_host, port, cb) {
    this.forwards.push(port);
    if (FakeClient.silent) return;
    if (port === 0 || !FakeClient.holds.has(port)) {
      return process.nextTick(() => cb(null, port === 0 ? GRANTED : port));
    }
    process.nextTick(() => cb(new Error("bind: Address already in use")));
  }
  // the local forward dials the far supervisor through us
  forwardOut(_host, _port, _dstHost, dstPort, cb) {
    this.forwardedTo = dstPort;
    const s = net.connect(far.address().port, "127.0.0.1");
    s.once("connect", () => cb(null, s));
    s.once("error", (e) => cb(e));
  }
  sftp(cb) {
    process.nextTick(() => cb(new Error("no sftp subsystem")));
  }
  end() {
    this.ended = true;
  }
}

const ssh2Path = require.resolve("ssh2", { paths: [path.join(__dirname, "..", "ui")] });
const ssh2Mod = new Module(ssh2Path);
ssh2Mod.filename = ssh2Path;
ssh2Mod.loaded = true;
ssh2Mod.exports = { Client: FakeClient };
require.cache[ssh2Path] = ssh2Mod;

const { connectTunnel, stopTunnel, awaitModelPath, tunnelStatus } = require("../ui/ssh-tunnel");
const {
  state,
  remoteLlmBase,
  remoteLlmPort,
  LLM_PROXY_REMOTE_PORT,
  registerChannel,
  channelFor,
} = require("../ui/tunnel-core");
// the install itself, per channel (used by section 5 to drive a row of its own)
const { installReverseForward } = require("../ui/tunnel-connect");

// the ports the fake far side holds: 8892, and only until the far side releases
// it (step 3 re-dials after that, which is the ordinary reconnect case)
FakeClient.holds = new Set([LLM_PROXY_REMOTE_PORT]);
// step 4's far side: it never answers a reverse-forward request at all
FakeClient.silent = false;

// ---- the far host's supervisor: what the gate's health check reaches --------
// It answers like a Clutch supervisor (the shape probe wants a "status" field).
const far = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"status":"ok","version":"0.0.0-test"}');
});

// ---- the "inbound connection from the far host" peer -----------------------
// accept() hands the dispatch a stream; the far side of it is this server, so a
// write into the peer's socket travels the real pipe to the real LLM proxy.
const peer = net.createServer();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function armInbound(client, destPort) {
  let accepted = 0;
  let rejected = 0;
  let inbound = null;
  peer.once("connection", (s) => (inbound = s));
  client.emit("tcp connection", { destPort }, () => (accepted++, net.connect(peer.address().port, "127.0.0.1")), () => rejected++);
  // let the pipes land: accept() is synchronous, the socket it returns is not
  for (let i = 0; i < 100 && !inbound && rejected === 0; i++) await sleep(5);
  return { accepted, rejected, inbound };
}

// write into the far side's end of a forwarded connection and read whatever
// comes back: the answer is the proof that a route reached a real listener
function readFrom(sock, text) {
  return new Promise((resolve) => {
    let body = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => (body += d));
    sock.on("end", () => resolve(body));
    sock.on("error", () => resolve(body));
    sock.write(text);
    setTimeout(() => resolve(body), 3000);
  });
}

(async () => {
  await new Promise((r) => far.listen(0, "127.0.0.1", r));
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));

  // 1. the connect: 8892 refused, the far side asked to choose
  const first = await connectTunnel({ host: "far.example", user: "alice", port: 22 });
  const client = FakeClient.last;
  check(first && first.ok === true, "a far side that will not release 8892 still connects");
  // The connect no longer waits for the model path (0.1.47: a far side that never
  // answers must not be able to hold "Starting tunnel…" open), so the port the far
  // side chose is only known once the install has landed — which is the moment
  // host-core's claim asks for it, before it tells a session where the model is.
  const path = await awaitModelPath();
  check(path === "listening", `the far side's model path lands after the connect has said yes (${path})`);
  check(
    client.forwards.length > 1 &&
      client.forwards.slice(0, -1).every((p) => p === LLM_PROXY_REMOTE_PORT) &&
      client.forwards[client.forwards.length - 1] === 0,
    `the promised port is tried first and the far side is asked to pick only after it (${client.forwards.join(",")})`
  );
  check(state.llmProxyRemotePort === GRANTED, "the port the far side chose is what this process remembers");
  check(remoteLlmPort() === GRANTED, "…and it is the port the forwards are keyed on from here on");
  check(
    remoteLlmBase() === `http://127.0.0.1:${GRANTED}/v1`,
    `a session spawned now points at the port that actually landed (${remoteLlmBase()})`
  );
  check(client.forwardedTo === 8890, "the window's own forward still dials the far supervisor's port");

  // 2. what the far side may connect to: the granted port, never the dead 8892
  const good = await armInbound(client, GRANTED);
  check(good.accepted === 1 && good.rejected === 0, "an inbound forward naming the granted port is accepted");
  const answered = await new Promise((resolve) => {
    let body = "";
    good.inbound.setEncoding("utf8");
    good.inbound.on("data", (d) => (body += d));
    good.inbound.on("end", () => resolve(body));
    good.inbound.on("error", () => resolve(body));
    good.inbound.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    setTimeout(() => resolve(body), 3000);
  });
  check(
    /^HTTP\/1\.1 404/.test(answered),
    "and what it carries really reaches this window's LLM proxy (404 = its non-LLM path answer)"
  );

  peer.removeAllListeners("connection");
  const dead = await armInbound(client, LLM_PROXY_REMOTE_PORT);
  check(
    dead.accepted === 0 && dead.rejected === 1,
    "an inbound forward naming the abandoned port is refused, not accepted and left hanging"
  );

  // 3. the memory is per PROCESS, not per hop: the next hop re-binds the granted
  //    port instead of walking the whole ladder on 8892 again — the far side's
  //    already-running sessions are pointed at it and cannot be re-pointed
  await stopTunnel();
  FakeClient.last = null;
  FakeClient.holds = new Set(); // the far side has released its listener by now
  const again = await connectTunnel({ host: "far.example", user: "alice", port: 22 });
  const second = FakeClient.last;
  check(again && again.ok === true, "a later hop on the same process connects too");
  check(
    second.forwards.length === 1 && second.forwards[0] === GRANTED,
    `it re-binds the remembered port on the first try (${second.forwards.join(",")})`
  );
  check(state.llmProxyRemotePort === GRANTED && remoteLlmBase() === `http://127.0.0.1:${GRANTED}/v1`,
    "…and a session spawned after that hop is pointed at the same place");

  // 4. the report this fix is about (0.1.47: "still stuck on Starting tunnel…",
  //    deterministic on a good network). This far side takes the reverse-forward
  //    request and never answers it: no refusal, no port, no disconnection. ssh2
  //    calls forwardIn's callback from the reply handler and from NOWHERE else, so
  //    an in-flight attempt with no reply in it was a promise nothing could
  //    settle — the connect parked on it for as long as the ssh client lived.
  //    A hop is not a model path: the connect is its own verdict (the local
  //    forward, a live supervisor behind it, that supervisor's shape), and the
  //    model path is reported honestly — not listening — instead of assumed.
  await stopTunnel();
  state.llmProxyRemotePort = null; // ask the contract port: the ask count then has one plain meaning
  FakeClient.last = null;
  FakeClient.holds = new Set();
  FakeClient.silent = true;
  const quietAt = Date.now();
  const quiet = await connectTunnel({ host: "far.example", user: "alice", port: 22 });
  const quietMs = Date.now() - quietAt;
  const quietClient = FakeClient.last;
  check(quiet && quiet.ok === true, "a far side that never answers the reverse-forward request still connects");
  check(quietMs < 10000, `…on the hop's own gates, not on the far side's silence (${quietMs}ms)`);
  check(
    quietClient.forwards.length === 1 && quietClient.forwards[0] === LLM_PROXY_REMOTE_PORT,
    `…asking the promised port exactly once (${quietClient.forwards.join(",")})`
  );
  check(
    tunnelStatus().modelPath === "installing" || tunnelStatus().modelPath === "unavailable",
    `…and the model path is not called listening just because the hop came up (${tunnelStatus().modelPath})`
  );
  const quietPath = await awaitModelPath();
  check(
    quietPath === "unavailable",
    `the silent ask ends on its own clock and is reported as such (${quietPath}, ${Date.now() - quietAt}ms)`
  );
  check(state.llmProxyRemotePort === null, "nothing is remembered from a bind the far side never answered");
  FakeClient.silent = false;

  // 5. the routing rule is the channel TABLE, not a model special case.
  //
  // Everything a second channel needs is a row: which port the far side asks for,
  // which local listener answers it, and where the port that landed is remembered.
  // Nothing in the accept handler, the ladder or the install knows the difference —
  // which is exactly the claim this section makes, with a listener that is not the
  // model proxy standing in for the plugin endpoint stage 4 adds.
  peer.removeAllListeners("connection");
  const nobodyAsked = await armInbound(quietClient, 8899);
  check(
    nobodyAsked.accepted === 0 && nobodyAsked.rejected === 1,
    "an inbound forward naming a port no channel asked for is refused, not dialled blind"
  );

  // the second channel's service: it answers with its own word, so an answer is
  // proof of WHICH listener the far side's connection reached
  const pluginSrv = net.createServer((s) => {
    s.setEncoding("utf8");
    s.on("data", () => s.end("plugin-ok"));
  });
  await new Promise((r) => pluginSrv.listen(0, "127.0.0.1", r));

  const probe = registerChannel("probe-test", {
    preferred: 8899,
    local: () => pluginSrv.address().port,
    what: "a test listener",
  });
  check(channelFor(8899) === probe, "a registered row makes its contract port routable");
  const probeOk = await installReverseForward(quietClient, probe);
  check(
    probeOk === true && probe.remote() === 8899 && channelFor(8899) === probe,
    `…and installing it asks for that port and remembers what landed (${probe.remote()})`
  );

  peer.removeAllListeners("connection");
  const toProbe = await armInbound(quietClient, 8899);
  check(toProbe.accepted === 1, "an inbound forward naming the row's port is accepted");
  const probeAnswer = await readFrom(toProbe.inbound, "hello");
  check(
    /^plugin-ok/.test(probeAnswer),
    `…and lands on the row's own listener, not the model proxy (${probeAnswer})`
  );

  // a channel that only ever lives where the far side puts it: no contract port,
  // so the FIRST thing asked for is port 0 — never 8892, which is the model's port
  let pickPort = null;
  const pick = registerChannel("pick-test", {
    local: () => pluginSrv.address().port,
    remote: () => pickPort,
    setRemote: (p) => (pickPort = p),
  });
  const askedBefore = quietClient.forwards.length;
  await installReverseForward(quietClient, pick);
  const asked = quietClient.forwards.slice(askedBefore);
  check(
    asked.length === 1 && asked[0] === 0,
    `a channel with no contract port is never asked for on 8892 (${asked.join(",")})`
  );
  check(
    pickPort === GRANTED && channelFor(GRANTED) === pick,
    `…and the port the far side picked routes back to that row, not the model's (${pickPort})`
  );

  // a row whose listener is not up (the plugin endpoint before it is started, or
  // after its client module gave up): refused, because accepting it would leave
  // the far side talking into a connection nobody answers
  registerChannel("dead-test", { preferred: 8897, local: () => null });
  check(channelFor(8897) !== null, "a row with no listener behind it is still a known port");
  check(channelFor(null) === null && channelFor("nothing") === null, "a port that is not a port routes nowhere");
  let halfPair = null;
  try {
    registerChannel("half-test", { local: () => 1, remote: () => 1 });
  } catch (e) {
    halfPair = e.message;
  }
  check(
    /both remote\(\) and setRemote\(\)/.test(halfPair || ""),
    "a row that can read its port but never write it is refused at registration"
  );
  peer.removeAllListeners("connection");
  const toDead = await armInbound(quietClient, 8897);
  check(
    toDead.accepted === 0 && toDead.rejected === 1,
    "…and a connection naming it is refused, never accepted into nothing"
  );

  await new Promise((r) => pluginSrv.close(r));
  await stopTunnel();
  peer.close();
  await new Promise((r) => far.close(r));
  summary("tunnel-reverse-port");
})().catch((e) => {
  console.error("runner crashed:", (e && e.stack) || e);
  process.exit(1);
});
