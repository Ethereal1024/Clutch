// A tab on the SAME machine as the window's own tunnel: the picker's move must
// hand the hop over, not close it.
//
// The field report: "with fix-train focused I pressed + (new tab) and switched the
// file browser's executor from the remote host to local — the moment it switched,
// fix-train failed with 'fetch failed'."
//
// The mechanism, in three facts this runner pins:
//
//   1. ONE STATE, ONE HOP. A dial names the window's own tunnel (tunnel-core
//      `name`), so `tunnelFor("me@far:22")` IS the primary state from then on. A
//      tab whose file is on that same machine therefore has no hop of its own: its
//      session forward and the window's default slot's ride the same wire.
//   2. THE MOVE USED TO CLOSE THAT WIRE. tunnel:disconnect released every claim on
//      the hop and stopped it, and the ladder was told the user left, so nothing
//      redialled. The tab's session survived on the far side, but its local forward
//      was gone, no hop existed to re-bind over, and the run posting to it got
//      "run state not reported (fetch failed)".
//   3. SO THE HOP IS HANDED OVER (tunnel-core keepPrimaryHop): the wire stays, the
//      state answers for the host's id from here on, and a fresh empty state takes
//      the primary's place — the move really landed (the window's default slot
//      resolves to this machine again), while the tab keeps the same forward, the
//      same URL and the run in flight on it.
//
// The other direction has to hold too: connecting the window back to a host a tab
// already holds must make the window's own tunnel BE that hop (adoptPrimary), or
// the picker would show ✓ while the default slot claimed a session on this machine.
//
// Run: node tests/shared-hop-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const { EventEmitter } = require("events");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-shared-hop-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");
const { createHostCore } = require("../ui/host-core");
const { createExecutors, LOCAL_ID } = require("../ui/executors");

// ---- the fake ssh2 ----------------------------------------------------------
// No hop in this runner dials: a client exists to be INSTALLED, asked for a
// forward, and ended.
class FakeClient extends EventEmitter {
  constructor() {
    super();
    FakeClient.built.push(this);
    this.ended = false;
  }
  connect() {
    throw new Error("shared-hop: no hop in this runner dials");
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

const ROOT = path.join(__dirname, "..");
const MAIN = fs.readFileSync(path.join(ROOT, "ui", "main.js"), "utf8");

const target = (m) => ({ host: m.host, user: m.user, port: Number(m.port) || 22 });
const label = (t) => (t ? `${t.user}@${t.host}:${t.port}` : "nothing");

const LOCAL_BASE = "http://127.0.0.1:8890";
const REMOTE = { host: "far.example", user: "me", port: 22 };
const REMOTE_ID = core.tunnelId(REMOTE.host, REMOTE.user, REMOTE.port);

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

// A forward this runner can watch: tunnel-lifecycle closes these on teardown, and
// "was it closed?" is the whole difference between a keep and a kill.
function fakeForward() {
  const fwd = { closed: false, close() { fwd.closed = true; } };
  return fwd;
}

// The window's own tunnel, on `m`, through a forward at `url` — the shape a
// landed connect leaves behind. Naming it is what a dial does (tunnel-connect),
// and it is why the tab's hop below IS this state.
function installPrimaryHop(m, url) {
  const inst = tunnel.primaryTunnel();
  inst.st.sshClient = new FakeClient();
  inst.st.target = target(m);
  inst.st.currentUrl = url;
  inst.st.wasDisconnected = false; // what a landed connect sets
  core.name(inst.st, core.tunnelId(m.host, m.user, m.port));
  return inst;
}

// ---- the claims, over the REAL executors table (Part B) ---------------------
// The state machine itself is host-core.test.js's subject; here it only has to
// answer "whose claims are on this hop?", which is the question the shell now asks
// before it may close one.
const tick = () => new Promise((r) => setImmediate(r));

function fakeSessions() {
  const calls = { started: [], stopped: [], forwards: [] };
  let seq = 0;
  return {
    calls,
    supervisorStart: async () => ({ sessionId: "s" + ++seq, port: 30000 + seq }),
    supervisorSessionStart: async (base) => {
      calls.started.push(base);
      return { sessionId: "s" + ++seq, port: 30000 + seq };
    },
    supervisorSessionStop: (base, sid) => {
      calls.stopped.push({ base, sid });
    },
    supervisorSessionHeartbeat: async () => true,
    startSupervisorHeartbeat: () => ({ stop: () => {} }),
  };
}

function fakeWin(id) {
  return {
    id,
    destroyed: false,
    sent: [],
    isDestroyed() {
      return this.destroyed;
    },
    send(ch, payload) {
      this.sent.push([ch, payload]);
    },
  };
}

// ONE hop serving two slots — exactly the reported state: `primaryTunnel()` and
// `tunnelFor(id)` are the same instance, so a slot with no pin (the window's
// default, "follow whatever is connected") and a tab on that machine land on it.
function sharedHopCore(sessions) {
  const FAR_BASE = "http://127.0.0.1:31901";
  const hop = {
    tunnelId: REMOTE_ID,
    lifecycle: {
      tunnelStatus: () => ({ active: true, url: FAR_BASE, target: REMOTE, execBridge: null }),
      openSessionForward: async (port) => {
        sessions.calls.forwards.push(port);
        return { localPort: port + 1000, close: () => {} };
      },
      restartRemoteServer: async () => true,
    },
  };
  const tunnelModule = {
    primaryTunnel: () => hop,
    tunnelFor: (id) => (id === REMOTE_ID ? hop : null),
    listTunnels: () => [hop],
  };
  const local = { base: () => LOCAL_BASE, wake: async () => true };
  const executors = createExecutors({ tunnel: tunnelModule, local, log: () => {} });
  const coreInstance = createHostCore({ executors, log: () => {}, sessions });
  return { core: coreInstance, executors, hop, FAR_BASE };
}

(async () => {
  const srv = await healthServer();
  const healthUrl = "http://127.0.0.1:" + srv.address().port;

  // ---- 1) the tab has no hop of its own: it IS the window's ----
  const primary = installPrimaryHop(REMOTE, healthUrl);
  const forward = fakeForward();
  primary.st.sessionForwards.add(forward);
  const tabHop = tunnel.tunnelFor(REMOTE_ID);
  check(tabHop === primary && tabHop.st === primary.st,
    "a tab on the machine the window's own tunnel is on gets THAT instance: one state, one wire, one bridge");
  check(tabHop.st.id === REMOTE_ID && tabHop.lifecycle.tunnelStatus().url === healthUrl,
    `and the tab's base is the hop's forward (${tabHop.lifecycle.tunnelStatus().url})`);

  // the bridge this hop started BEFORE the hand-over, and the port it named
  await primary.bridge.start();
  const keptBridgePort = primary.bridge.port();
  check(keptBridgePort,
    "the hop has an exec bridge of its own (the port a client plugin posts to)");

  // ---- 2) the hand-over: the wire stays, the primary role moves ----
  const keptId = tunnel.keepPrimaryHop();
  check(keptId === REMOTE_ID,
    `keepPrimaryHop() names the host it handed the hop to (got ${keptId})`);
  check(core.primary().id === null && core.primary().sshClient === null,
    "the window's own tunnel is a fresh empty state: the window really is off that machine");
  check(core.held(REMOTE_ID) === primary.st && primary.st.sshClient instanceof FakeClient,
    "and the host it left still has its wire and its id — the state the tab's bound instance was built over");
  check(primary.st.currentUrl === healthUrl && !forward.closed,
    "the tab's forward and URL are untouched by the move: nothing re-binds, nothing re-dials, no 'fetch failed'");
  check(!FakeClient.built.slice(1).length,
    "and no second client was opened for it (one machine, one wire)");
  check(tunnel.statusOf(REMOTE_ID).active && tunnel.statusOf(REMOTE_ID).url === healthUrl,
    "the endpoint answers by its id, exactly as before: the tab's next claim sees the same base");
  const rows = tunnel.listTunnels();
  check(rows.filter((r) => r.tunnelId === REMOTE_ID).length === 1 &&
    rows.every((r) => r.tunnelId),
    "the picker is offered the machine once, and the empty primary is not offered at all (" + rows.map((r) => r.tunnelId).join(", ") + ")");

  // ---- 3) two bridges, two machines ----
  const fresh = tunnel.primaryTunnel();
  await fresh.bridge.start();
  const freshPort = fresh.bridge.port();
  check(fresh.st !== primary.st && freshPort && freshPort !== keptBridgePort,
    `the new primary's bridge is its own port (${freshPort} vs the kept ${keptBridgePort})`);
  check(tunnel.statusOf(REMOTE_ID).execBridge === "http://127.0.0.1:" + keptBridgePort,
    "and the kept hop still names ITS bridge: the bridge belongs to the state, not to the name it had at bind time");
  fresh.bridge.stop();
  check(tunnel.statusOf(REMOTE_ID).execBridge === "http://127.0.0.1:" + keptBridgePort,
    "…so closing the new primary's bridge cannot take the far machine's plugin path with it");

  // ---- 4) nothing to hand over is not a hand-over ----
  check(tunnel.keepPrimaryHop() === null,
    "an empty primary hands over nothing (null), so the shell keeps its ordinary teardown for an unnamed hop");

  // ---- 5) the move landed: an unpinned slot follows THIS machine again ----
  const executors = createExecutors({ tunnel, local: { base: () => LOCAL_BASE, wake: async () => true } });
  check(executors.defaultId() === LOCAL_ID,
    `with the hop handed over, "the endpoint the window is on" is this machine again (got ${executors.defaultId()})`);

  // ---- 6) the way back: the window connects to the host the tab holds ----
  const reuse = await tunnel.connectTunnel(target(REMOTE));
  check(reuse && reuse.ok === true && reuse.url === healthUrl,
    `dialling that host again reuses the live hop (got ${JSON.stringify(reuse)})`);
  check(core.primary().id === REMOTE_ID,
    "and the window's own tunnel IS that hop now: the picker's ✓ and the default slot's claim agree");
  check(tunnel.primaryTunnel().st === core.primary() && core.held(REMOTE_ID) === core.primary(),
    "one state answers for the host and for the window (no second client, no second bridge)");
  check(executors.defaultId() === REMOTE_ID,
    `so the default slot claims on ${REMOTE_ID}, not on this machine (got ${executors.defaultId()})`);
  check(core.primary().pinned === false,
    "and it may still MOVE: the window's own tunnel is not a tab's fixed endpoint");

  // back to where the field report started: the hop can still be ended for real
  await tunnel.stopTunnelOn(REMOTE_ID);
  check(forward.closed && tunnel.statusOf(REMOTE_ID).active === false,
    "the hop the move kept can be ended later like any other (its forward closed, its status honest)");

  // ---- 7) who is riding a hop: the question the shell asks first ----
  {
    const sessions = fakeSessions();
    const { core: hc, FAR_BASE } = sharedHopCore(sessions);
    const w = fakeWin(1);
    const tabUrl = await hc.ensureSlotBackend(w, "tab-fix");
    const ownUrl = await hc.ensureSlotBackend(w, "");
    check(tabUrl && ownUrl && tabUrl !== ownUrl,
      "a tab's session and the window's default session are two claims, two forwards (" + tabUrl + ", " + ownUrl + ")");
    const both = hc.claimsOnTunnel(FAR_BASE);
    check(both.length === 2 && both.some((s) => s.slotId === "tab-fix") && both.some((s) => s.slotId === ""),
      "both ride the ONE hop, and the shell can name them (" + both.map((s) => s.slotId || "(default)").join(", ") + ")");

    // the move ends the window's own claim…
    await hc.releaseSlot(w.id, "", { leaving: true });
    const after = hc.claimsOnTunnel(FAR_BASE);
    check(after.length === 1 && after[0].slotId === "tab-fix" && after[0].winId === w.id,
      "after the window's own claim goes, exactly one rider is left — the tab — so the hop has a reason to live");
    check(hc.backendCount() === 1 && hc.slotStatus(w.id, "tab-fix").url === tabUrl,
      "and the tab still holds its session URL: unchanged, because nothing detached it");

    // a PARKED claim keeps nothing alive (its release could not be confirmed)
    sessions.supervisorSessionStop = async () => ({ ok: false });
    const w2 = fakeWin(2);
    const parkedUrl = await hc.ensureSlotBackend(w2, "tab-parked");
    check(!!parkedUrl, "a second tab claims (this one is about to be parked)");
    await hc.releaseSlot(w2.id, "tab-parked");
    // the claim is PARKED, not gone: its far-side session is still there for the
    // next hop to re-bind (host-core's rule), but nobody is watching it — so it
    // does not keep the hop alive, exactly as anyTunnelWindow decides
    const parked = hc.claimsOnTunnel(FAR_BASE).filter((s) => s.slotId === "tab-parked");
    check(parked.length === 0 && hc.slotStatus(w2.id, "tab-parked").claimed === true,
      "a claim whose release was not confirmed is PARKED: still named for the next hop, but not a reason to keep this one alive (anyTunnelWindow's rule)");
  }

  // ---- 8) the shell's handler: keep when ridden, tear down otherwise ----
  const at = MAIN.indexOf('ipcMain.handle("tunnel:disconnect"');
  const end = at < 0 ? -1 : MAIN.indexOf('ipcMain.handle("session:release"', at);
  const handler = at < 0 || end < at ? "" : MAIN.slice(at, end);
  check(/const onHop = url \? hostCore\.claimsOnTunnel\(url\) : \[\]/.test(handler) &&
    /const riders = onHop\.filter\(/.test(handler) &&
    /const keptId = riders\.length \? tunnel\.keepPrimaryHop\(\) : null/.test(handler),
    "the picker's move asks who is riding the hop before it may close it, and hands the hop over when somebody is");
  check(/if \(keptId\) \{[\s\S]{0,400}await hostCore\.releaseSlot\(s\.winId, s\.slotId, \{ leaving: true \}\);[\s\S]{0,600}return \{ ok: true, kept: keptId \}/.test(handler),
    "…releasing ONLY the asking window's own claim, and answering with the hop it kept");
  const keptAt = handler.indexOf("if (keptId) {");
  const stopAt = handler.indexOf("await tunnel.stopTunnel()");
  check(keptAt > 0 && stopAt > keptAt && !/await tunnel\.stopTunnel\(\)/.test(handler.slice(keptAt, handler.indexOf("return { ok: true, kept: keptId }"))),
    "…and nothing in that branch closes the wire: the hop the tab is working through outlives the move");
  check(/\[disconnect\] hop to \$\{keptId\} kept/.test(handler),
    "the log says which host's hop was kept and for whom — tunnel.log is the only record after the fact");

  srv.close();
  summary("shared-hop", "a picker's move hands a hop a tab is still working through over to its host, instead of closing it");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
