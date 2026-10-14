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
  // when asked for a port of its own choosing it binds one and reports it
  forwardIn(_host, port, cb) {
    this.forwards.push(port);
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

const { connectTunnel, stopTunnel } = require("../ui/ssh-tunnel");
const { state, remoteLlmBase, remoteLlmPort, LLM_PROXY_REMOTE_PORT } = require("../ui/tunnel-core");

// the ports the fake far side holds: 8892, and only until the far side releases
// it (step 3 re-dials after that, which is the ordinary reconnect case)
FakeClient.holds = new Set([LLM_PROXY_REMOTE_PORT]);

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

(async () => {
  await new Promise((r) => far.listen(0, "127.0.0.1", r));
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));

  // 1. the connect: 8892 refused, the far side asked to choose
  const first = await connectTunnel({ host: "far.example", user: "alice", port: 22 });
  const client = FakeClient.last;
  check(first && first.ok === true, "a far side that will not release 8892 still connects");
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

  await stopTunnel();
  peer.close();
  await new Promise((r) => far.close(r));
  summary("tunnel-reverse-port");
})().catch((e) => {
  console.error("runner crashed:", (e && e.stack) || e);
  process.exit(1);
});
