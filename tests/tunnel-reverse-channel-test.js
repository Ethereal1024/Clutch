// The reverse channels: what the far side may open a connection INTO this
// machine for, and what it is refused.
//
// Everything a channel needs is one row in tunnel-core's table: the port the far
// side asks for (if it has a contract port at all), the loopback listener on
// THIS machine that answers it, and where the port that actually landed is
// remembered. The accept handler routes by destPort through that table, so a
// port nobody asked for is refused instead of dialled blind, and a row with no
// listener behind it is refused instead of accepted into nothing.
//
// This runner drives the REAL connectTunnel over a fake ssh2 wire and then the
// REAL installReverseForward over rows of its own, with real loopback sockets:
//   * the hop asks for NO reverse forward at all — its job is the hop, and a
//     port is asked for at the moment something claims a session on the far side
//     (ui/plugin-link.js start, once per client);
//   * a row's contract port is asked for first, and the far side's own pick
//     (port 0) only after that port is REFUSED;
//   * a row with no contract port asks for port 0 immediately;
//   * the granted port is what later hops re-bind and what inbound connections
//     are routed on — and the port a row was refused never is;
//   * a far side that answers NOTHING ends the install on its own clock, is
//     reported as such, and leaves nothing remembered.
//
// The wire is faked (ssh2 module seam, as in tunnel-concurrent-dial-test.js) but
// nothing else is: the real local forward serves the gate's health check, and
// only the far-side bootstrap (probe/install/tar) is stubbed, because it is not
// what this test is about.
//
// Run: node tests/tunnel-reverse-channel-test.js

"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const { EventEmitter } = require("events");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-chan-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");

// The port the fake far side hands over when it is asked to pick one.
const GRANTED = 46123;
// …and the one it picks later on, when the row above already holds GRANTED (two
// rows may never share a granted port: the table routes a port to one row).
const PICKED = 46200;

// ---- the far-side bootstrap, stubbed at its module seam --------------------
//
// connectTunnel asks this file who is on the far end and whether the server is
// installed. Both answers are "yes, a modern host, already running" so the
// runner reaches the forwards — the part under test — without a remote shell.
const bootPath = require.resolve("../ui/tunnel-bootstrap");
const fakeBootstrap = {
  PROBE_CMD: "clutch-probe",
  parseProbe: () => ({ os: "linux", home: "/home/far", version: "0.0.0-test" }),
  installServer: async () => ({ ok: true }),
  installComponents: () => {},
};
// the part a bound instance is given (see ssh-tunnel's bind): the hop modules no
// longer reach each other by require, so the seam is the instance's part
fakeBootstrap.attach = () => fakeBootstrap;
const bootMod = new Module(bootPath);
bootMod.filename = bootPath;
bootMod.loaded = true;
bootMod.exports = fakeBootstrap;
require.cache[bootPath] = bootMod;

// ---- the fake ssh2 wire ----------------------------------------------------

class FakeClient extends EventEmitter {
  constructor(opts) {
    super();
    FakeClient.last = this;
    this.opts = opts;
    this.forwards = []; // every port the reverse forwards asked for
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
  // the far sshd: a port it already holds is REFUSED, and when asked for a port
  // of its own choosing it binds one and reports it. With FakeClient.silent set
  // it is the far side of the 0.1.47 report: it takes the request and says
  // NOTHING — no error, no port, no disconnection.
  forwardIn(_host, port, cb) {
    this.forwards.push(port);
    if (FakeClient.silent) return;
    if (port === 0 || !FakeClient.holds.has(port)) {
      return process.nextTick(() => cb(null, port === 0 ? FakeClient.grant : port));
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
const { registerChannel, channelFor, channels, state } = require("../ui/tunnel-core");
// the install itself, per channel
const { installReverseForward } = require("../ui/tunnel-connect");

// the ports the fake far side holds (a listener this client cannot reach and,
// with sshd's keepalive off by default, need not let go of for hours)
FakeClient.holds = new Set();
// the port it reports when it is asked to pick one
FakeClient.grant = GRANTED;
// the far side that never answers a reverse-forward request at all
FakeClient.silent = false;

// ---- the far host's supervisor: what the gate's health check reaches --------
// It answers like a Clutch supervisor (the shape probe wants a "status" field).
const far = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"status":"ok","version":"0.0.0-test"}');
});

// ---- the "inbound connection from the far host" peer -----------------------
// accept() hands the dispatch a stream; the far side of it is this server, so a
// write into the peer's socket travels the real pipe to the real listener.
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

// one local listener, answering with its own word, so an answer is proof of
// WHICH listener a forwarded connection reached
function wordServer(word) {
  const srv = net.createServer((s) => {
    s.setEncoding("utf8");
    s.on("data", () => s.end(word));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

(async () => {
  await new Promise((r) => far.listen(0, "127.0.0.1", r));
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));

  // 1. the hop is the hop: a connect asks the far side for NO port.
  //
  // A loopback port on the far machine that nobody has claimed a session on is a
  // listener held there for a facility no one has used yet. The channel is
  // installed at claim time instead (ui/plugin-link.js), which is the first moment
  // a far-side session could possibly dial it.
  const first = await connectTunnel({ host: "far.example", user: "alice", port: 22 });
  const client = FakeClient.last;
  check(first && first.ok === true, "the hop comes up");
  check(
    client.forwards.length === 0,
    `the connect itself asks for no reverse forward (${client.forwards.join(",") || "none"})`
  );
  check(client.forwardedTo === 8890, "the window's own forward still dials the far supervisor's port");

  // 2. a connection naming a port no row names is refused, not dialled blind
  const nobodyAsked = await armInbound(client, 8899);
  check(
    nobodyAsked.accepted === 0 && nobodyAsked.rejected === 1,
    "an inbound forward naming a port no channel asked for is refused, not dialled blind"
  );

  // 3. a row with a contract port: that port is asked for, and what lands routes
  //    back to the row's own listener
  const service = await wordServer("service-ok");
  const row = registerChannel("test-contract", {
    preferred: 8899,
    local: () => service.address().port,
    what: "a test listener",
  });
  check(channelFor(8899) === row, "a registered row makes its contract port routable");
  const before = client.forwards.length;
  const okFirst = await installReverseForward(client, row);
  const askedFirst = client.forwards.slice(before);
  check(
    okFirst === true && row.remote() === 8899 && channelFor(8899) === row,
    `installing it lands on the contract port and remembers it (${row.remote()})`
  );
  check(
    askedFirst.length === 1 && askedFirst[0] === 8899,
    `…asking for exactly that port, once (${askedFirst.join(",")})`
  );

  peer.removeAllListeners("connection");
  const toRow = await armInbound(client, 8899);
  check(toRow.accepted === 1, "an inbound forward naming the row's port is accepted");
  const answer = await readFrom(toRow.inbound, "hello");
  check(/^service-ok/.test(answer), `…and lands on the row's own listener (${answer})`);

  // 4. the contract port is a contract, not a right: when the far side REFUSES it
  //    (a listener it has not reaped yet), the row is asked for a port of its own
  //    and the port that really landed is what gets remembered and routed
  await stopTunnel();
  FakeClient.last = null;
  FakeClient.holds = new Set([8899]); // the far side refuses the contract port now
  const again = await connectTunnel({ host: "far.example", user: "alice", port: 22 });
  const second = FakeClient.last;
  check(again && again.ok === true, "a later hop on the same process connects too");
  const beforeSecond = second.forwards.length;
  // the ladder retries the contract port (a port sshd is still releasing) before
  // it gives up on it; two tries at 1ms is the same ladder, just not a 7s wait
  const okHeld = await installReverseForward(second, row, { tries: 2, retryMs: 1, maxWaitMs: 1 });
  const askedHeld = second.forwards.slice(beforeSecond);
  check(okHeld === true, "a held contract port costs the row a different port, not the channel");
  check(
    askedHeld.length === 3 && askedHeld[0] === 8899 && askedHeld[1] === 8899 && askedHeld[2] === 0,
    `…the contract port is retried, then the far side's own pick (${askedHeld.join(",")})`
  );
  check(row.remote() === GRANTED, `the port that landed is the one remembered (${row.remote()})`);
  check(
    channelFor(GRANTED) === row && channelFor(8899) === null,
    "…and it routes to the row, while the refused port routes nowhere"
  );
  peer.removeAllListeners("connection");
  const toGranted = await armInbound(second, GRANTED);
  check(toGranted.accepted === 1, "an inbound forward naming the granted port is accepted");
  check(/^service-ok/.test(await readFrom(toGranted.inbound, "hi")), "…and reaches the row's listener again");

  // 5. a row that only ever lives where the far side puts it: no contract port, so
  //    the FIRST thing asked for is port 0 — never a number somebody else wanted
  let pickPort = null;
  const pick = registerChannel("test-pick", {
    local: () => service.address().port,
    remote: () => pickPort,
    setRemote: (p) => (pickPort = p),
  });
  // the far side is free to hand this one a different number than the row above
  FakeClient.grant = PICKED;
  const beforePick = second.forwards.length;
  await installReverseForward(second, pick);
  const askedPick = second.forwards.slice(beforePick);
  check(
    askedPick.length === 1 && askedPick[0] === 0,
    `a channel with no contract port goes straight to the far side's pick (${askedPick.join(",")})`
  );
  check(
    pickPort === PICKED && channelFor(PICKED) === pick,
    `…and the port it picked routes back to that row (${pickPort})`
  );

  // 6. a row whose listener is not up (the plugin endpoint before it is started,
  //    or after its client module gave up): refused, because accepting it would
  //    leave the far side talking into a connection nobody answers
  registerChannel("test-dead", { preferred: 8897, local: () => null });
  check(channelFor(8897) !== null, "a row with no listener behind it is still a known port");
  check(channelFor(null) === null && channelFor("nothing") === null, "a port that is not a port routes nowhere");
  let halfPair = null;
  try {
    registerChannel("test-half", { local: () => 1, remote: () => 1 });
  } catch (e) {
    halfPair = e.message;
  }
  check(
    /both remote\(\) and setRemote\(\)/.test(halfPair || ""),
    "a row that can read its port but never write it is refused at registration"
  );
  peer.removeAllListeners("connection");
  const toDead = await armInbound(second, 8897);
  check(
    toDead.accepted === 0 && toDead.rejected === 1,
    "…and a connection naming it is refused, never accepted into nothing"
  );
  check(channels.size >= 3, "every row this process registered is still there, by name");

  // 6b. a forward belongs to the hop that asked for it. A client the tunnel no
  //     longer owns gets nothing installed — a newer connect installs its own
  //     forward, and a late retry must not fight it — and a hop replaced in the
  //     middle of the ladder is left alone after the attempt in flight.
  let lateAsks = 0;
  const replacedClient = {
    forwardIn() {
      lateAsks++;
    },
  };
  const replacedOk = await installReverseForward(replacedClient, pick, { tries: 3, retryMs: 1, maxWaitMs: 1 });
  check(
    replacedOk === false && lateAsks === 0,
    "a forward for a client the tunnel no longer owns is never installed at all"
  );
  let fight = 0;
  const doomed = {
    forwardIn(_host, _port, cb) {
      fight++;
      state.sshClient = second; // the hop dies here: a newer connect owns the session now
      cb(new Error("bind: Address already in use"));
    },
  };
  state.sshClient = doomed;
  const doomedOk = await installReverseForward(doomed, pick, { tries: 4, retryMs: 1, maxWaitMs: 1 });
  check(
    doomedOk === false && fight === 1,
    `a hop replaced mid-ladder is left alone after the attempt in flight (${fight} ask)`
  );
  state.sshClient = second;

  // 7. the report this ladder exists for (0.1.47: "still stuck on Starting
  //    tunnel…"): a far side that takes the reverse-forward request and never
  //    answers it. ssh2 calls forwardIn's callback from the reply handler and from
  //    NOWHERE else, so an in-flight attempt with no reply in it is a promise
  //    nothing can settle. The install has to end on its own clock, say so, and
  //    remember nothing — and the hop itself is unaffected.
  await stopTunnel();
  FakeClient.last = null;
  FakeClient.holds = new Set();
  FakeClient.silent = true;
  const quietAt = Date.now();
  const quiet = await connectTunnel({ host: "far.example", user: "alice", port: 22 });
  const quietMs = Date.now() - quietAt;
  const quietClient = FakeClient.last;
  await new Promise((r) => service.close(r));
  const silentService = await wordServer("silent-ok");
  let silentPort = null;
  const silentRow = registerChannel("test-silent", {
    preferred: 8896,
    local: () => silentService.address().port,
    remote: () => silentPort,
    setRemote: (p) => (silentPort = p),
  });
  const silentOk = await installReverseForward(quietClient, silentRow);
  const askedSilent = quietClient.forwards.slice();
  check(quiet && quiet.ok === true, "a far side that never answers the reverse-forward request still connects");
  check(quietMs < 10000, `…on the hop's own gates, not on the far side's silence (${quietMs}ms)`);
  check(silentOk === false, "a silent far side does not produce a channel");
  check(
    askedSilent.length === 1 && askedSilent[0] === 8896,
    `…it asked the contract port exactly once and never re-asked (${askedSilent.join(",")})`
  );
  check(silentPort === null, "nothing is remembered from a bind the far side never answered");
  check(channelFor(8896) === silentRow, "…the row still prefers its contract port for the next attempt");
  FakeClient.silent = false;

  await new Promise((r) => silentService.close(r));
  await stopTunnel();
  peer.close();
  await new Promise((r) => far.close(r));
  summary("tunnel-reverse-channel");
})().catch((e) => {
  console.error("runner crashed:", (e && e.stack) || e);
  process.exit(1);
});
