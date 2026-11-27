// N hops in one process: what a second endpoint may touch, and what it may not.
//
// `ab9b45f` gave the tunnel one bound instance per id, so the desktop can hold a
// hop for every machine its tabs are on. Handing out those instances is a
// different question, and the answers have to agree with each other:
//
//   * an id is a machine, and two machines are two states — two clients, two
//     forward URLs, two exec-bridge ports. Nothing is shared that a session would
//     notice;
//   * a PINNED instance is the hop its id names. A connect for another endpoint
//     there is refused by name, because the old single tunnel's MOVE is exactly
//     the behaviour that took every other tab's forward with it;
//   * a non-pinned (the window's own) dial to a host somebody already serves
//     REUSES that live hop — one host, one ssh client, one supervisor — and it
//     reuses it BEFORE naming itself, so the registry key still answers for the
//     instance that is really on the wire;
//   * listTunnels() names each host once, so the picker cannot offer one machine
//     twice;
//   * an end is announced ONCE, for the hop it belongs to, carrying that hop's id
//     and URL: the other endpoint's client and forward are untouched.
//
// Every hop here is installed by hand (a fake ssh2 client, a real local health
// server, the shared states the modules read), so this runner is about the
// instances and their bookkeeping, not about the handshake behind them.
//
// Run: node tests/tunnel-multi-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const { EventEmitter } = require("events");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-tunnel-multi-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");

// ---- the fake ssh2 ----------------------------------------------------------
// Nothing this runner does is expected to dial (every hop is installed), so the
// client exists to be INSTALLED and ENDED, and to count how many of it there are.
class FakeClient extends EventEmitter {
  constructor() {
    super();
    FakeClient.built.push(this);
    this.ended = false;
  }
  connect() {
    throw new Error("tunnel-multi: no hop in this runner dials");
  }
  exec(_cmd, cb) {
    process.nextTick(() => cb(new Error("mock exec unavailable")));
  }
  end() {
    this.ended = true;
  }
}
FakeClient.built = [];

const ssh2Path = require.resolve("ssh2", { paths: [path.join(__dirname, "..", "ui")] });
const fakeMod = new Module(ssh2Path);
fakeMod.filename = ssh2Path;
fakeMod.loaded = true;
FakeClient._clutchFake = true;
fakeMod.exports = { Client: FakeClient };
require.cache[ssh2Path] = fakeMod;

const tunnel = require("../ui/ssh-tunnel");
const core = require("../ui/tunnel-core");

const target = (m) => ({ host: m.host, user: m.user, port: Number(m.port) || 22 });
const label = (t) => (t ? `${t.user}@${t.host}:${t.port}` : "nothing");

// a forward that answers /api/health: the only question a reuse asks of a live hop
function healthServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// A hop this process believes is live, on the instance bound to `id`: a client,
// the host it is FOR, a forward that answers, and the latch a successful connect
// clears. Exactly the shape the reuse gate and the end notification look for.
function installLiveHop(id, m, url) {
  const inst = tunnel.tunnelFor(id);
  const client = new FakeClient();
  inst.st.sshClient = client;
  inst.st.target = target(m);
  inst.st.currentUrl = url;
  inst.st.wasDisconnected = false; // what a landed connect sets
  return inst;
}

const A = { host: "a.example", user: "alice", port: 22 };
const B = { host: "b.example", user: "bob", port: 2222 };
const C = { host: "c.example", user: "carol", port: 2200 };
const idA = core.tunnelId(A.host, A.user, A.port);
const idB = core.tunnelId(B.host, B.user, B.port);
const idC = core.tunnelId(C.host, C.user, C.port);

(async () => {
  const srv = await healthServer();
  const healthUrl = "http://127.0.0.1:" + srv.address().port;

  const a = installLiveHop(idA, A, healthUrl);
  const b = installLiveHop(idB, B, healthUrl);

  // ---- 1) one id is one machine, and two machines are two states ----
  check(a.st !== b.st && core.held(idA) === a.st && core.held(idB) === b.st,
    "each endpoint has its own state: the registry answers by id, with the instance bound to it");
  check(a.st.id === idA && b.st.id === idB && a.st.pinned === true && b.st.pinned === true,
    "and a state made for an id knows it IS that endpoint (pinned), so it can never be renamed");
  const stA = tunnel.statusOf(idA);
  const stB = tunnel.statusOf(idB);
  check(stA.active && label(stA.target) === label(A) && stA.url === healthUrl,
    `the status of ${idA} is that hop: active, for ${label(A)}, on its own URL (got ${label(stA.target)})`);
  check(stB.active && label(stB.target) === label(B) && stB.url === healthUrl,
    `and the status of ${idB} is the other one (got ${label(stB.target)})`);

  // ---- 2) a pinned hop refuses another endpoint instead of moving ----
  const builtBefore = FakeClient.built.length;
  const refused = await tunnel.connectTunnelOn(idA, target(B));
  check(refused && refused.ok === false && /different endpoint/.test(refused.error || ""),
    `a pinned hop refuses a connect for another endpoint (got ${JSON.stringify(refused)})`);
  check(/this tunnel is the hop to /.test(refused.error || "") && refused.error.includes(idA),
    "…and names the endpoint it IS, so the caller knows which hop it would have moved");
  check(FakeClient.built.length === builtBefore,
    "nothing was dialled for it: a refusal is not a second wire");
  check(label(a.st.target) === label(A) && a.st.sshClient instanceof FakeClient && label(b.st.target) === label(B),
    "and both hops are exactly where they were");

  // ---- 3) the window's own dial reuses a live hop — and the window is ON it ----
  // The gate runs first on purpose: naming would overwrite the registry key that
  // the lookup needs, and then the window's own tunnel would hold a second client
  // for a host that is already served. What the gate finds is the HOP itself, so
  // the window's own tunnel BEcomes that state (tunnel-core adoptPrimary): the
  // picker's ✓ and the default slot's claim then name one endpoint, not two.
  const replaced = tunnel.primaryTunnel();
  const reuse = await tunnel.connectTunnel(target(A));
  check(reuse && reuse.ok === true && reuse.url === healthUrl,
    `a dial for a host another instance already serves reuses that hop (got ${JSON.stringify(reuse)})`);
  check(FakeClient.built.length === builtBefore,
    "…without opening a second ssh client for one machine");
  check(core.held(idA) === a.st,
    "…and the registry still answers with the instance that is really on the wire");
  check(core.primary() === a.st && tunnel.primaryTunnel() === a,
    "…and the window's own tunnel IS that hop now: one state answers for the host and for the window (adoptPrimary)");
  check(a.st.pinned === false,
    "…and it may still MOVE: the endpoint the window itself is on is not a tab's fixed hop");
  check(replaced.st !== a.st && replaced.st.id === null && replaced.st.sshClient === null,
    "the empty primary it replaced is left as it was: no wire, no host, nothing claimed");

  // ---- 4) the picker is offered each host once ----
  const rows = tunnel.listTunnels();
  const keys = rows.map((r) => r.tunnelId);
  check(keys.filter((k) => k === idA).length === 1 && keys.filter((k) => k === idB).length === 1,
    "listTunnels() names each host once (" + keys.join(", ") + ")");
  check(rows.every((r) => r.tunnelId), "and every row is a named endpoint — an unnamed state is not a device to pick");

  // ---- 5) the exec bridge is one per instance ----
  // The port a session posts to has to run its commands on the machine the session
  // belongs to: one shared bridge would let a window pinned to A reach whichever
  // hop was installed last.
  await a.bridge.start();
  await b.bridge.start();
  const portA = a.bridge.port();
  const portB = b.bridge.port();
  check(portA && portB && portA !== portB,
    `each instance listens on its own bridge port (${portA} vs ${portB})`);
  check(tunnel.statusOf(idA).execBridge === "http://127.0.0.1:" + portA &&
        tunnel.statusOf(idB).execBridge === "http://127.0.0.1:" + portB,
    "and each status names ITS bridge, which is what the executor table hands a session");
  a.bridge.stop();
  check(tunnel.statusOf(idA).execBridge === null &&
        tunnel.statusOf(idB).execBridge === "http://127.0.0.1:" + portB,
    "stopping one bridge leaves the other serving its own machine");

  // ---- 6) an end is announced for the hop it belongs to ----
  const heard = [];
  const off = tunnel.onTunnelEnd((id, url) => heard.push([id, url]));
  await a.lifecycle.stopTunnel(true);
  check(heard.length === 1 && heard[0][0] === idA && heard[0][1] === healthUrl,
    `one end, carrying the hop that ended and the URL it served (got ${JSON.stringify(heard)})`);
  check(a.st.sshClient === null && a.st.target === null,
    "the ended hop left no client and no host behind it");
  check(b.st.sshClient !== null && label(b.st.target) === label(B) && b.st.currentUrl === healthUrl,
    "and the other endpoint — its client, its host, its forward — is untouched");
  await b.lifecycle.stopTunnel(true);
  check(heard.length === 2 && heard[1][0] === idB,
    "the same one listener hears the second hop's end too, named as itself");
  off();

  // ---- 7) a host is named once, even after a placeholder ----
  // Something asks about a machine this process is not on (a tab being restored
  // asks about a host nothing has dialled): that question must not put a hop in
  // the picker, and when a dial does land for that host the placeholder goes.
  const placeholder = core.stateFor(idC);
  check(placeholder !== replaced.st && placeholder !== a.st,
    "stateFor() makes an instance for an id nobody serves — a state, not a hop");
  check(tunnel.statusOf(idC).active === false,
    "and that instance is honestly inactive: nothing is claimed about a machine nobody is on");
  const empty = replaced.st; // a state that answers for no host (the one the hand-over emptied)
  core.name(empty, idC); // what a landed dial does with the tunnel it names
  check(core.held(idC) === empty && tunnel.listTunnels().filter((r) => r.tunnelId === idC).length === 1,
    "naming an unnamed state for that host takes the key over, drops the placeholder, and listTunnels() still shows one row");
  check(core.held(idA) === a.st && core.held(idB) === b.st,
    "and the named endpoints' keys are still theirs: naming one host never moves another");

  b.bridge.stop();
  srv.close();
  summary("tunnel-multi", "one process, N hops: each endpoint has its own state, its own wire and its own end");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
