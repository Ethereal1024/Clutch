// Two dials on one tunnel: who owns the wire when they collide.
//
// The engine's reconnect ladder (ui/tunnel-ladder.js) dials from the process the
// foreground service protects, and the page's own ladder still dials while the
// page is visible (ui/js/conn-lost.js) — both start their first attempt one
// backoff step (1000ms) after the same `tunnel:ended`, so a hop that dies with
// the app in the foreground can be asked for twice at once. connectTunnel has
// always handled the second arrival by RESETTING the first ("existing tunnel is
// dead or still starting" — state.sshClient is installed before the handshake
// answers, so an in-flight dial looks exactly like a dead one), and that is
// fine: the newer request is the one somebody is waiting for.
//
// What was NOT fine: the reset makes the first dial reject, and its failure path
// called stopTunnel() unconditionally — which ends whichever client the state
// holds NOW, i.e. the newer dial's, mid-handshake. The loser killed the winner,
// and the tunnel paid a second backoff step for it.
//
// This runner pins both halves of the rule that fixes it:
//   1. control — a dial that still owns the wire still cleans up after itself
//      (the guard must not turn a real failure into a leak);
//   2. the loser of a collision leaves the winner's tunnel standing.
//
// The fake ssh2 is driven by hand (as in ssh-secret-cache-test.js), and the
// reset-induced close is released by the runner rather than by a timer, so the
// ordering under test is fixed and this is not a timing test.
//
// Run: node tests/tunnel-concurrent-dial-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-dialrace-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");

// ---- the fake ssh2 ----------------------------------------------------------
//
// Two behaviours, both standing in for a dial that never gets as far as its
// probe: "hang" (connected initiator, no answer — the shape a second dial finds
// and resets) and "auth-fail" (the handshake rejects outright). `end()` is the
// reset, and it is deferred until the runner releases it: a real socket close is
// reported a moment after the .end() that caused it, and that moment is exactly
// the window this rule lives in.

class FakeClient extends EventEmitter {
  constructor() {
    super();
    FakeClient.last = this;
    this.ended = false;
  }
  connect(opts) {
    this.opts = opts;
    if (FakeClient.behavior === "auth-fail") {
      process.nextTick(() => this.emit("error", new Error("All configured authentication methods failed")));
    }
    // "hang": no ready, no error — a handshake still in progress
  }
  exec(cmd, cb) {
    process.nextTick(() => cb(new Error("mock exec unavailable")));
  }
  end() {
    this.ended = true;
    FakeClient.closed.push(this);
  }
}

FakeClient.closed = [];
FakeClient.behavior = "hang";

// what the runner can observe without reaching into module state
const ssh2Path = require.resolve("ssh2", { paths: [path.join(__dirname, "..", "ui")] });
const fakeMod = new Module(ssh2Path);
fakeMod.filename = ssh2Path;
fakeMod.loaded = true;
fakeMod.exports = { Client: FakeClient };
require.cache[ssh2Path] = fakeMod;

const { connectTunnel, stopTunnel, tunnelStatus } = require("../ui/ssh-tunnel");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the reset's close, delivered on the loser
async function releaseResets() {
  const closed = FakeClient.closed.splice(0);
  for (const c of closed) c.emit("error", new Error("Connection closed by the reset"));
  await sleep(10); // let the rejections run their catch blocks
}

(async () => {
  // 1. control: one dial, on its own, that fails. The guard must not have turned
  //    a real failure into a leak — nothing is left installed, and the teardown
  //    still ran (its proxies closed, its client ended).
  FakeClient.behavior = "auth-fail";
  const solo = await connectTunnel({ host: "solo.example", user: "alice", port: 22 });
  check(solo && solo.ok === false, "control: a lone dial that fails reports the failure");
  check(tunnelStatus().active === false, "control: and it tears its own client down, as it always did");
  check(FakeClient.closed.length === 1, "control: the client it installed is the one it ended");
  FakeClient.closed.length = 0;

  // 2. the collision: A — the engine ladder's attempt — is installed and still
  //    in its handshake when B, the page's redial, arrives and resets it.
  FakeClient.behavior = "hang";
  const a = connectTunnel({ host: "race.example", user: "alice", port: 22 });
  a.catch(() => {});
  let waited = 0;
  while (!tunnelStatus().active && waited < 2000) {
    await sleep(5);
    waited += 5;
  }
  const clientA = FakeClient.last;
  check(tunnelStatus().active === true, "the first dial is installed (and not yet up: exactly what a reset finds)");

  const b = connectTunnel({ host: "race.example", user: "alice", port: 22 });
  b.catch(() => {});
  waited = 0;
  while (tunnelStatus().active === false && waited < 2000) {
    await sleep(5);
    waited += 5;
  }
  check(clientA.ended === true, "the second dial resets the first: the in-flight client is ended");
  check(FakeClient.last !== clientA, "and installs its own client in its place");

  // now the reset's close reaches the loser — the moment the bug lived in
  await releaseResets();
  const verdict = await Promise.race([a, sleep(300).then(() => "still pending")]);
  check(verdict !== "still pending" && verdict.ok === false, "the first dial reports its failure (the reset took it down)");
  check(
    tunnelStatus().active === true,
    "the loser does NOT tear down the winner: the newer dial's tunnel is still installed"
  );
  check(FakeClient.last.ended === false, "…and its client was never ended by the dial that lost");

  // 3. the same failure WITHOUT a newer dial in the way is still a teardown —
  //    the rule is identity, not "never clean up after a lost dial"
  FakeClient.behavior = "hang";
  const c = connectTunnel({ host: "solo2.example", user: "alice", port: 22 });
  c.catch(() => {});
  waited = 0;
  while (!tunnelStatus().active && waited < 2000) {
    await sleep(5);
    waited += 5;
  }
  const clientC = FakeClient.last;
  clientC.emit("error", new Error("connection lost while this dial still owned the wire"));
  await sleep(10);
  const lost = await Promise.race([c, sleep(300).then(() => "still pending")]);
  check(lost !== "still pending" && lost.ok === false, "a dial that fails while it still owns the wire still reports it");
  check(tunnelStatus().active === false, "…and still tears its own tunnel down");

  await stopTunnel();
  summary("tunnel-concurrent-dial", "a loser of the double dial never kills the winner");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
