// One tunnel, one host: what connectTunnel may REUSE, and what it must not.
//
// The report: this window was on host A, the user added host B in the picker's
// new-connection popup, B was unreachable — and the picker said B was connected,
// browsing A's file system. The tunnel was the lie: connectTunnel found a live
// hop, asked it /api/health, got an answer, and handed the request {ok: true} with
// the OLD hop's URL. Health says "a hop is up", never "a hop to the host you
// asked for is up", so every byte the renderer then sent went to A while it
// believed it was on B.
//
// The rule this runner pins: a live hop is reused only when the request names the
// same host, user and port it was dialled for; anything else is a MOVE, and the
// old hop is spent before the new one is dialled (one tunnel, one host — there is
// no second hop to be on). The failure of that move is then the move's own: no
// `ok: true`, and no URL left over from the hop it left.
//
// The hop is installed by hand (a fake ssh2 client, a real local health server, and
// the shared tunnel state the module reads), so the gate is exercised on its own
// terms and this is not a test of the bootstrap behind it.
//
// Run: node tests/tunnel-target-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const { EventEmitter } = require("events");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-tunnel-target-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");

// ---- the fake ssh2 ----------------------------------------------------------
//
// "auth-fail" is a dial that cannot get past the handshake (the unreachable host
// of the report); "hang" is a handshake still in progress, which is what the
// runner needs to look at the state WHILE a dial owns it. `opts` is what the dial
// actually asked the wire for, and `end()` is the teardown.
class FakeClient extends EventEmitter {
  constructor() {
    super();
    FakeClient.last = this;
    this.ended = false;
  }
  connect(opts) {
    this.opts = opts;
    if (FakeClient.behavior === "auth-fail") {
      process.nextTick(() =>
        this.emit("error", new Error("All configured authentication methods failed"))
      );
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
FakeClient.behavior = "auth-fail";
FakeClient.last = null;

const ssh2Path = require.resolve("ssh2", { paths: [path.join(__dirname, "..", "ui")] });
const fakeMod = new Module(ssh2Path);
fakeMod.filename = ssh2Path;
fakeMod.loaded = true;
fakeMod.exports = { Client: FakeClient };
require.cache[ssh2Path] = fakeMod;

const { connectTunnel, stopTunnel } = require("../ui/ssh-tunnel");
const { state } = require("../ui/tunnel-core");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (host, user, port) => ({ host, user, port });
const label = (t) => (t ? `${t.user}@${t.host}:${t.port}` : "nothing");

// a forward that answers /api/health, for as long as the runner needs one: the
// gate's only question about a live hop is whether that URL answers
function healthServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const srv = await healthServer();
  const healthUrl = "http://127.0.0.1:" + srv.address().port;

  // a hop this process believes is live: a client, the host it is FOR, and a
  // forward that answers. Exactly the shape a reuse finds.
  const installLiveHop = (host, user, port) => {
    const client = new FakeClient();
    state.sshClient = client;
    state.target = target(host, user, port);
    state.currentUrl = healthUrl;
    FakeClient.closed.length = 0;
    return client;
  };

  // ---- 1) control: the SAME host is still reused ----
  // The gate is a narrowing of reuse, not its removal: a redial of the host this
  // tunnel is already for is the reconnect path, and it must still answer with the
  // live hop instead of paying for a second handshake.
  const sameHop = installLiveHop("a.example", "alice", 22);
  const reuse = await connectTunnel({ host: "a.example", user: "alice", port: 22 });
  check(reuse && reuse.ok === true, "control: a request for the hop's OWN host is still answered by it");
  check(reuse.url === healthUrl, "...with that hop's URL, as it always was");
  check(sameHop.ended === false && FakeClient.last === sameHop,
    "...and nothing was dialled for it: the live tunnel is the answer");

  // ---- 2) the report: a request for B is NEVER answered by a live hop to A ----
  const hopA = installLiveHop("a.example", "alice", 22);
  const toB = await connectTunnel({ host: "b.example", user: "alice", port: 22 });
  check(toB.ok === false,
    `a move to a host that cannot be reached reports the failure, not the hop it left (got ${JSON.stringify(toB)})`);
  check(toB.url === undefined && toB.url !== healthUrl,
    "and it carries no URL of A's: the false success was the whole bug");
  check(hopA.ended === true, "the hop to A was spent before the new dial, not borrowed for it (one tunnel, one host)");
  check(FakeClient.last && FakeClient.last !== hopA && FakeClient.last.opts.host === "b.example",
    `the wire that was dialled is B's (got ${FakeClient.last && FakeClient.last.opts && FakeClient.last.opts.host})`);
  check(state.sshClient === null && state.target === null,
    "and the failed move left no hop and no host behind it");

  // ---- 3) the same host on another port is another host ----
  const port22 = installLiveHop("a.example", "alice", 22);
  const movedPort = await connectTunnel({ host: "a.example", user: "alice", port: 2222 });
  check(movedPort.ok === false, "a different port on the same name is a move, not a reuse");
  check(port22.ended === true && FakeClient.last.opts.port === 2222,
    "...so the old hop is spent and the new port is what is dialled");

  // ---- 4) another user is another host too ----
  const alice = installLiveHop("a.example", "alice", 22);
  const asBob = await connectTunnel({ host: "a.example", user: "bob", port: 22 });
  check(asBob.ok === false, "the same name under another user is a move as well");
  check(alice.ended === true && FakeClient.last.opts.username === "bob",
    "...so the old hop is spent and the new user is what is dialled");

  // ---- 5) a hop with no host attached is not reused either ----
  // A tunnel from a build that did not record its target (or one whose target was
  // cleared): nothing says it is the host being asked for, so it cannot answer for
  // it. Not knowing is not a match.
  const unknown = installLiveHop("a.example", "alice", 22);
  state.target = null;
  const noTarget = await connectTunnel({ host: "a.example", user: "alice", port: 22 });
  check(noTarget.ok === false, "a live hop with no host recorded is not reused for any host");
  check(unknown.ended === true, "it is reset like any other hop that cannot answer for the request");

  // ---- 6) the host travels WITH the client, from the moment it is installed ----
  // The gate reads state.sshClient and state.target together, so a second request
  // must never see one request's client with another's host. The dial installs both
  // in the same step (before the handshake), so the state is already named while the
  // dial is in flight — and a request arriving then reads THIS host, not a stale one.
  FakeClient.behavior = "hang";
  FakeClient.closed.length = 0; // only the dials below: a hand-installed hop has no listeners
  const pending = connectTunnel({ host: "c.example", user: "carol", port: 2200 });
  pending.catch(() => {});
  let waited = 0;
  while (!state.sshClient && waited < 2000) {
    await sleep(5);
    waited += 5;
  }
  const inFlight = state.sshClient;
  check(Boolean(inFlight), "a dial installs its client before the handshake answers");
  check(label(state.target) === "carol@c.example:2200",
    `and the host it is for is installed with it (got ${label(state.target)})`);
  // and it is a real pairing, not an earlier request's leftover: a request for a
  // DIFFERENT host arriving now must not be answered by this in-flight dial
  const other = connectTunnel({ host: "d.example", user: "carol", port: 2200 });
  other.catch(() => {});
  await sleep(20);
  check(inFlight.ended === true, "so a request for another host resets it rather than waiting on it or reusing it");
  // settle both dials so the runner leaves nothing in flight
  for (const c of FakeClient.closed.splice(0)) c.emit("error", new Error("closed by the runner"));
  await Promise.race([pending, sleep(500)]);
  await Promise.race([other, sleep(500)]);
  FakeClient.behavior = "auth-fail";

  await stopTunnel();
  srv.close();
  check(state.sshClient === null && state.target === null, "the runner ends with no tunnel and no host recorded");

  summary("tunnel-target", "a live tunnel answers only for the host it was dialled for");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
