// "connection failed: read ECONNRESET" — what it is now made to say, and when
// this client may ask again.
//
// Field report: a phone that had just been pointed at other hosts answered every
// connect with the raw socket words "read ECONNRESET", immediately. Those words
// are two different events wearing one string:
//
//   1. the WIRE was reset before ssh2 ever reported a session. Nothing was
//      authenticated, so the far side has made no judgement about the credential:
//      a firewall, a login ban's tail, sshd at MaxStartups, a VPN or proxy rule.
//      All of those usually clear in a second, so the dial asks exactly once more
//      and the verdict names the host and says what happened;
//   2. ANOTHER dial reset this one (a second window, the picker's retry, the
//      outage redial, the user moving to a different host). The socket error is
//      the reset it was killed by, not a host's refusal — the verdict must not
//      put the host's name next to it, and this attempt must not ask again (that
//      would be a third client over a wire somebody else is using).
//
// The retry is bounded to the pre-handshake case on purpose: a wrong secret
// repeated on a timer is how an address earns the ban it is complaining about
// (the same rule ui/tunnel-ladder.js states for its backoff), so an auth failure
// is an answer and is never re-asked.
//
// Run: node tests/tunnel-dial-reset-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-dialreset-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");

// ---- the fake ssh2 ----------------------------------------------------------
//
//   "reset"      every dial is reset at the TCP connect (node's words for it)
//   "reset-once" the FIRST dial is reset, every later one brings an auth answer
//   "auth-fail"  the handshake answers with an auth failure
//   "hang"       installed, no answer — a dial something else can reset
class FakeClient extends EventEmitter {
  constructor() {
    super();
    FakeClient.last = this;
    FakeClient.instances.push(this);
    this.ended = false;
    this.index = FakeClient.instances.length;
  }
  connect(opts) {
    this.opts = opts;
    const behavior = FakeClient.behavior;
    if (behavior === "auth-fail" || (behavior === "reset-once" && this.index > 1)) {
      process.nextTick(() =>
        this.emit("error", new Error("All configured authentication methods failed"))
      );
      return;
    }
    if (behavior === "reset" || (behavior === "reset-once" && this.index === 1)) {
      process.nextTick(() => {
        const e = new Error("read ECONNRESET");
        e.code = "ECONNRESET";
        e.errno = "ECONNRESET";
        this.emit("error", e);
      });
    }
    if (behavior === "reset-after-banner") {
      // sshd spoke first (the ident ssh2 logs as "Remote ident: …"), and the cut
      // came after it: the same socket words, a different place to look.
      if (typeof opts.debug === "function") opts.debug("Remote ident: 'SSH-2.0-OpenSSH_9.6'");
      process.nextTick(() => {
        const e = new Error("read ECONNRESET");
        e.code = "ECONNRESET";
        this.emit("error", e);
      });
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

FakeClient.instances = [];
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

function resetCounters() {
  FakeClient.instances.length = 0;
  FakeClient.closed.length = 0;
  FakeClient.last = null;
}

(async () => {
  // 1. a wire reset before the handshake: asked twice, and the verdict reads as
  //    a sentence about the host and the path — never as "read ECONNRESET" alone.
  resetCounters();
  FakeClient.behavior = "reset";
  const once = await connectTunnel({ host: "other.example", user: "alice", port: 22 });
  check(once && once.ok === false, "a reset before the handshake still fails the connect");
  check(FakeClient.instances.length === 2, "…and it was asked exactly once more, not once and not in a loop");
  check(
    /other\.example:22/.test(once.error),
    "the verdict names the host and port the reset happened on: " + once.error
  );
  check(
    /reset the TCP connection before the SSH handshake/.test(once.error),
    "…says what happened, in words, not only the socket's"
  );
  check(/asked 2 times/.test(once.error), "…and says the one more ask was made");
  check(
    /nothing was authenticated/.test(once.error) && !/authentication/i.test(once.error),
    "…separates it from an auth failure, which it is not"
  );
  check(tunnelStatus().active === false, "a dial that never got a session leaves nothing installed");

  // 1b. the SAME socket words with sshd having spoken first: the verdict has to
  //     say so, because that is a different place to look (the host's side of the
  //     key exchange, not the path to it).
  resetCounters();
  FakeClient.behavior = "reset-after-banner";
  const bannered = await connectTunnel({ host: "banner.example", user: "alice", port: 22 });
  check(bannered && bannered.ok === false, "a reset after sshd's banner still fails the connect");
  check(FakeClient.instances.length === 2, "…and is asked once more like any pre-handshake reset");
  check(
    /sshd answered with its banner/.test(bannered.error),
    "the verdict says sshd answered before the cut: " + bannered.error
  );
  check(
    !/no byte of sshd's own banner arrived/.test(bannered.error),
    "…and does not claim the path swallowed every byte"
  );

  // 2. the retry is a real second dial, and it is the ONE it gets: an auth answer
  //    on the second ask is reported as the auth answer, not re-asked again.
  resetCounters();
  FakeClient.behavior = "reset-once";
  const second = await connectTunnel({ host: "other.example", user: "alice", port: 22 });
  check(second && second.ok === false, "second case: the connect still fails");
  check(FakeClient.instances.length === 2, "the retry dialled, and only once more");
  check(
    /authentication failed/.test(second.error),
    "an auth answer to the second ask is reported as one: " + second.error
  );

  // 3. an auth failure on the FIRST ask is never retried: a credential is an
  //    answer, and repeating it is what gets an address banned.
  resetCounters();
  FakeClient.behavior = "auth-fail";
  const auth = await connectTunnel({ host: "other.example", user: "alice", port: 22 });
  check(auth && auth.ok === false && /authentication failed/.test(auth.error), "auth failure is reported as one");
  check(FakeClient.instances.length === 1, "…and the wrong secret is not repeated on a timer");

  // 4. a reset caused by a TEARDOWN under this dial is not the far side talking:
  //    no second ask, and the verdict says the tunnel was stopped.
  resetCounters();
  FakeClient.behavior = "hang";
  const stopped = connectTunnel({ host: "solo.example", user: "alice", port: 22 });
  stopped.catch(() => {});
  let waited = 0;
  while (!tunnelStatus().active && waited < 2000) {
    await sleep(5);
    waited += 5;
  }
  const dialled = FakeClient.last;
  await stopTunnel(); // the user's Disconnect / another request's move
  dialled.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  const stoppedVerdict = await Promise.race([stopped, sleep(1000).then(() => "still pending")]);
  check(stoppedVerdict !== "still pending" && stoppedVerdict.ok === false, "the stopped dial reports its failure");
  check(
    /the tunnel was stopped while this attempt was still connecting/.test(stoppedVerdict.error),
    "the verdict says the tunnel was stopped, not that the host reset us: " + stoppedVerdict.error
  );
  check(FakeClient.instances.length === 1, "and no second ask was made over a wire somebody else stopped");

  // 5. the collision case, read for its WORDS this time: the loser was killed by
  //    a newer dial, so its verdict must not name the host as a refusal.
  resetCounters();
  FakeClient.behavior = "hang";
  const loser = connectTunnel({ host: "race.example", user: "alice", port: 22 });
  loser.catch(() => {});
  waited = 0;
  while (!tunnelStatus().active && waited < 2000) {
    await sleep(5);
    waited += 5;
  }
  const first = FakeClient.last;
  const winner = connectTunnel({ host: "race.example", user: "alice", port: 22 });
  winner.catch(() => {});
  first.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  const loserVerdict = await Promise.race([loser, sleep(1000).then(() => "still pending")]);
  check(loserVerdict !== "still pending" && loserVerdict.ok === false, "the replaced dial reports its failure");
  check(
    /a newer connection attempt took the tunnel over/.test(loserVerdict.error),
    "the loser says it was replaced, not that the host reset it: " + loserVerdict.error
  );
  check(!/^connection|reset the TCP connection/.test(loserVerdict.error), "…and does not blame the path or the host");

  // the winner is still a handshake nobody answered: let it fail too, so the
  // runner exits on its own (nothing is left holding the event loop open)
  FakeClient.last.emit("error", new Error("mock: the handshake was abandoned"));
  await Promise.race([winner, sleep(1000)]);
  await stopTunnel();
  summary("tunnel-dial-reset", "a pre-handshake reset is asked once more, a reset by a newer dial is not");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
