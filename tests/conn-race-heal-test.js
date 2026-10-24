// "connection failed: read ECONNRESET" for a tunnel that is UP.
//
// A connect is not alone on the wire: the engine's own redial ladder
// (ui/tunnel-ladder.js), a second window and the outage redial all dial the same
// host, and the dial that loses is reset by the one that won. Its words are the
// socket's, so the page printed a failure over a hop that was already carrying
// the user's file list.
//
// hopLandedFor is the question that fixes it: before believing a failed connect,
// the page asks the shell WHICH host its hop is for — and only the host the user
// asked for counts, because a live tunnel to somewhere else answering here is the
// same lie tunnel-connect's move path refuses to tell.
//
// Run: node tests/conn-race-heal-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// the tunnel state + log live under HOME
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-race-"));
process.env.HOME = HOME;
if (process.platform === "win32") process.env.USERPROFILE = HOME;

const { check, summary, slicer, uiSource, uiModules } = require("./harness");

const APP = uiSource();
const { fnBody } = slicer(APP);
const CONN_FLOW = uiModules().find((m) => m.file === "js/conn-flow.js").code;

// the function under test, taken out of the page exactly as it ships
const SRC = fnBody("hopLandedFor");
const hopLandedFor = new Function("window", "return " + SRC)({ clutchTunnel: null });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 0. the remedy is wired into the door the user's failure comes out of
  check(
    /if \(!res\.ok && \(await hopLandedFor\(host, user, port\)\)\) res = \{ ok: true/.test(CONN_FLOW),
    "a failed connect asks hopLandedFor before it reports itself"
  );

  // 1. NOTHING on the wire: a plain failure is answered at once. A connect that
  //    genuinely could not get through must not spend the budget pretending
  //    somebody else might arrive — that would be a slower lie.
  let calls = 0;
  global.window = global.window || {};
  const nothing = { clutchTunnel: { status: async () => (calls++, { active: false, url: null, target: null }) } };
  const t0 = Date.now();
  const plain = await new Function("window", "return " + SRC)(nothing)("host.example", "alice", 22);
  const took = Date.now() - t0;
  check(plain === false, "with no hop at all, the failure stands");
  check(took < 250, `…and is answered at once (${took}ms, not the full budget)`);

  // 2. the winner landed: a live hop for THIS host is the success the user asked for
  const same = {
    clutchTunnel: {
      status: async () => ({ active: true, url: "http://127.0.0.1:9/", target: { host: "host.example", user: "alice", port: 22 } }),
    },
  };
  check(
    (await new Function("window", "return " + SRC)(same)("host.example", "alice", 22)) === true,
    "a live hop for the same host is a connect that succeeded"
  );
  // the port is part of the identity: 22 and 2222 on one address are two hosts
  check(
    (await new Function("window", "return " + SRC)(same)("host.example", "alice", "2222")) === false,
    "…the same address on another port is somebody else"
  );

  // 3. a hop to ANOTHER host is never read as this one's success — the lie the
  //    move path in tunnel-connect refuses to tell, told here instead
  const other = {
    clutchTunnel: {
      status: async () => ({ active: true, url: "http://127.0.0.1:9/", target: { host: "elsewhere.example", user: "alice", port: 22 } }),
    },
  };
  check(
    (await new Function("window", "return " + SRC)(other)("host.example", "alice", 22)) === false,
    "another host's live tunnel does not answer for this one"
  );

  // 4. the winner is still bootstrapping: a client on this host with no url yet is
  //    the attempt this one lost to, a few seconds behind its dial — wait for it
  //    rather than declare a failure it is about to disprove
  let ticks = 0;
  const soon = {
    clutchTunnel: {
      status: async () => {
        ticks += 1;
        const up = ticks >= 4;
        return { active: true, url: up ? "http://127.0.0.1:9/" : null, target: { host: "host.example", user: "alice", port: 22 } };
      },
    },
  };
  const started = Date.now();
  check(
    (await new Function("window", "return " + SRC)(soon)("host.example", "alice", 22)) === true,
    "a hop for this host that is still starting is waited for"
  );
  check(Date.now() - started >= 300, "…for as long as it takes, within the budget");
  check(ticks >= 4, "…asking again, not once");

  // 5. a hop that never comes up does not hold the verdict forever
  const never = {
    clutchTunnel: {
      status: async () => ({ active: true, url: null, target: { host: "host.example", user: "alice", port: 22 } }),
    },
  };
  const held = Date.now();
  check(
    (await new Function("window", "return " + SRC)(never)("host.example", "alice", 22, 400)) === false,
    "a hop that never finishes starting leaves the failure standing"
  );
  check(Date.now() - held < 1500, "…and gives up on its own budget");

  // 6. an unanswerable question is not a live hop (and not an exception)
  const broken = {
    clutchTunnel: {
      status: async () => {
        throw new Error("ipc gone");
      },
    },
  };
  check((await new Function("window", "return " + SRC)(broken)("host.example", "alice", 22)) === false, "a failing status is not a success");

  // 7. the shell has to be able to answer "which host?": tunnelStatus carries the
  //    target, which is also what keeps a window from being ticked as connected
  //    over somebody else's file system
  const { state } = require("../ui/tunnel-core");
  const { tunnelStatus } = require("../ui/tunnel-lifecycle");
  check(tunnelStatus().target === null, "no hop, no target");
  state.target = { host: "host.example", user: "alice", port: 22 };
  const live = tunnelStatus();
  check(
    live.target && live.target.host === "host.example" && live.target.port === 22,
    "tunnelStatus names the host the hop is for"
  );
  state.target = null;

  await sleep(1);
  summary("conn-race-heal", "a connect reset by the attempt that won reports the hop, not the socket's words");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
