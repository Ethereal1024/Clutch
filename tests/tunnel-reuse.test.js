// A live tunnel is asked before it is thrown away.
//
// The field report: while ssh itself was fine, switching to a remote tab raised
// "Connection lost" in one window and "connection failed" in the one that had
// just switched — and the retry a moment later worked. Both came from one line:
// connectTunnel's reuse probe allowed 2 s per request inside a 3 s budget, so a
// hop whose health answer took one lost retransmission read as a dead tunnel,
// was stopTunnel()'d (every other window's forward with it), and forced a fresh
// dial that could miss.
//
// The rule these pin: an unanswered probe is a QUESTION. The far host is asked
// about ITSELF over the exec channel (a path the failed forward does not share),
// and a far side that still serves gets a new forward on the same port and the
// same hop — the tunnel is reset only when the far side is not serving.
//
// Run: node tests/tunnel-reuse.test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const { check, summary } = require("./harness");

// tunnelLog appends synchronously to $HOME/.clutch/tunnel.log, and a few checks
// below read it back. HOME is redirected to a scratch dir FIRST so the runner
// never scribbles on the developer's own log (it is field evidence).
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-reuse-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const TUNNEL_LOG = path.join(os.homedir(), ".clutch", "tunnel.log");
function tunnelLogText() {
  try {
    return fs.readFileSync(TUNNEL_LOG, "utf-8");
  } catch {
    return "";
  }
}

const UI_DIR = path.join(__dirname, "..", "ui");
const CONNECT_JS = path.join(UI_DIR, "tunnel-connect.js");
const CONNECT_SRC = fs.readFileSync(path.join(UI_DIR, "src", "host", "tunnel-connect.ts"), "utf8");

// ---- the stubs ----
//
// The hop and its forwards are not what is under test: the QUESTION the connect
// asks about them is. So the two modules it asks through are swapped at the seam
// and everything else (probeServer, the branch's own shape) is production code.
//
//   stopTunnel()  must be the LAST resort, so its stub aborts the attempt with a
//                 sentinel: anything that keeps dialling after it is a bug this
//                 runner would rather not have to wait for.
//   reopenForward(ask)  the healer's own forward bounce, answering what a case
//                 says a slow wire/far side would answer.
const STOPPED = new Error("__stopTunnel__");
const local = {
  stopped: 0,
  reopened: 0,
  reopenAnswer: true,
  reopenAsks: [],
  reset() {
    this.stopped = 0;
    this.reopened = 0;
    this.reopenAnswer = true;
    this.reopenAsks = [];
  },
};
const fakeLifecycle = {
  stopTunnel: () => {
    local.stopped++;
    throw STOPPED;
  },
  reopenForward: async (ask) => {
    local.reopened++;
    local.reopenAsks.push(ask);
    return local.reopenAnswer;
  },
  notifyEnd: () => {},
  startHealing: () => {},
  stopHealing: () => {},
};

// The far host's answer about ITSELF, over exec. `bound`/`serving` are the two
// different questions (a wedged survivor keeps the socket bound with nothing
// behind it), the way tests/tunnel-reconnect.test.js models the same box.
const wire = {
  bound: true,
  serving: true,
  selfAsks: 0,
  reset({ bound = true, serving = true } = {}) {
    this.bound = bound;
    this.serving = serving;
    this.selfAsks = 0;
  },
};
function fakeRemoteExec(cmd) {
  if (cmd.includes("socket") && cmd.includes("connect")) {
    wire.selfAsks++;
    return Promise.resolve({ code: 0, stdout: wire.bound ? "UP\n" : "DOWN\n", stderr: "" });
  }
  if (cmd.includes("/api/health")) {
    return Promise.resolve({ code: 0, stdout: wire.serving ? "200\n" : "DOWN\n", stderr: "" });
  }
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
}

const BOOTSTRAP_JS = path.join(UI_DIR, "tunnel-bootstrap.js");
const fakeRemote = { remoteExec: fakeRemoteExec, uploadFile: () => Promise.resolve() };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === CONNECT_JS) {
    if (request === "./tunnel-lifecycle") return fakeLifecycle;
    if (request === "./tunnel-remote") return fakeRemote;
  }
  // the far-side verdict (remoteServingState) is asked over exec, so it needs the
  // same fake wire — otherwise it fails on a hop this runner never dialled
  if (parent && parent.filename === BOOTSTRAP_JS && request === "./tunnel-remote") return fakeRemote;
  return origLoad.apply(this, arguments);
};

const { connectTunnel } = require("../ui/tunnel-connect");
const { state } = require("../ui/tunnel-core");

const HOST = { host: "fanshu", user: "fanshu", port: 6001, password: "x" };
const PROBE = {
  os: "Linux",
  arch: "x86_64",
  home: "/home/u",
  libc: "glibc",
  python: "3.12",
  installedVersion: "aaaaaaaaaaaaaaaa",
};

// A forward that answers LATE — the whole defect in one server. 2.5 s is past the
// per-request clock the reuse probe used to have (2 s) and well inside the one it
// has now, so this is exactly the wire that used to read as dead.
function slowForward(delayMs) {
  const srv = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }, delayMs);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}

// A local port with nothing behind it: the forward is gone, the hop may be fine.
function deadPort() {
  const srv = http.createServer(() => {});
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    })
  );
}

function reuseState(port, probe) {
  // a live hop to the host this connect is FOR: the branch under test
  state.sshClient = { marker: "hop" };
  state.target = { host: HOST.host, user: HOST.user, port: HOST.port };
  state.currentUrl = "http://127.0.0.1:" + port;
  state.lastProbe = probe || PROBE;
}

async function attempt() {
  try {
    return { result: await connectTunnel({ ...HOST }, () => {}) };
  } catch (e) {
    return { error: e };
  }
}

function logSince(mark) {
  return tunnelLogText().slice(mark);
}

async function main() {
  // ---- 1. the shape of the branch (source pins) ----
  const reuseAt = CONNECT_SRC.indexOf("const ask = state.currentUrl");
  const farAskAt = CONNECT_SRC.indexOf("remoteServingState(state.lastProbe", reuseAt);
  const resetAt = CONNECT_SRC.indexOf("existing tunnel is dead or still starting; resetting", reuseAt);
  check(reuseAt > 0, "the reuse branch asks the live tunnel through probeServer");
  check(
    CONNECT_SRC.includes("probeServer(state.currentUrl") && !CONNECT_SRC.includes("waitForServer(state.currentUrl"),
    "the live-tunnel probe is probeServer (with a kind), not the old bare waitForServer"
  );
  check(farAskAt > reuseAt, "an unanswered probe asks the far host about itself before anything is replaced");
  check(resetAt > farAskAt, "the tunnel is reset only after that answer");
  check(
    CONNECT_SRC.indexOf("reopenForward(ask)", reuseAt) > reuseAt &&
      CONNECT_SRC.indexOf("reopenForward(ask)", reuseAt) < resetAt,
    "a far side that still serves gets its forward re-opened instead of a teardown"
  );
  const probeBudget = Number((/const REUSE_PROBE_MS = (\d+);/.exec(CONNECT_SRC) || [])[1]);
  const requestBudget = Number((/const REUSE_REQUEST_MS = (\d+);/.exec(CONNECT_SRC) || [])[1]);
  check(
    probeBudget >= 6000 && requestBudget >= 4000 && requestBudget <= probeBudget,
    `the probe is patient: ${probeBudget} ms total, ${requestBudget} ms per request (${
      requestBudget > 2000 ? "a slow answer is not a dead hop" : "STILL the old 2 s clock"
    })`
  );
  // the same impatience sat at the second gate: one 3 s GET decided whether the port
  // runs OUR supervisor, right after a health gate that may have spent 15 s
  const shapeAsk = CONNECT_SRC.indexOf("probeSupervisorShape(base)");
  const shapeRetry = CONNECT_SRC.indexOf("the supervisor shape probe went unanswered; asking again");
  check(
    shapeAsk > 0 && shapeRetry > shapeAsk,
    "the supervisor-shape probe is asked again when it goes unanswered (silence is not 'a non-supervisor server')"
  );

  // ---- 2. a slow-but-alive forward is REUSED, untouched ----
  // (the field case: the answer took longer than the old per-request clock)
  const slow = await slowForward(2500);
  reuseState(slow.port);
  local.reset();
  wire.reset();
  let mark = tunnelLogText().length;
  let run = await attempt();
  check(!!run.result && run.result.ok === true, "a forward that answers late still counts as up (connect succeeds)");
  check(run.result && run.result.url === "http://127.0.0.1:" + slow.port, "the same tunnel is reused, same port");
  check(local.stopped === 0, "the healthy hop was NOT torn down");
  check(local.reopened === 0, "and its forward was not bounced either: an answer needs no repair");
  check(wire.selfAsks === 0, "the far host is not even asked on the happy path (no exec round trip per switch)");
  check(logSince(mark).includes("[connect] reusing live tunnel"), "the reuse is logged as one");
  slow.srv.close();

  // ---- 3. nothing answering, far side still SERVING: rebind, keep the hop ----
  const dead = await deadPort();
  reuseState(dead);
  local.reset();
  wire.reset({ bound: true, serving: true });
  mark = tunnelLogText().length;
  run = await attempt();
  check(!!run.result && run.result.ok === true, "a dead forward over a serving far side still connects");
  check(local.stopped === 0, "the tunnel is NOT reset: the far side still serves, its runs are still alive");
  check(local.reopened === 1, "the forward was re-opened instead (once)");
  check(
    local.reopenAsks.length === 1 && local.reopenAsks[0] && local.reopenAsks[0].kind === "refused",
    "the probe's KIND reaches the rebind (a refused listener has nothing to preserve)"
  );
  check(wire.selfAsks === 1, "the far side was asked about itself exactly once");
  const log3 = logSince(mark);
  check(log3.includes("far side reports SERVING"), "the far side's verdict is on the record");
  check(log3.includes("forward rebound; reusing live tunnel"), "the rebind is logged, and the hop is reused");
  check(!log3.includes("resetting"), "nothing was reset");

  // ---- 4. the same, but the forward cannot be re-opened ----
  reuseState(dead);
  local.reset();
  wire.reset({ bound: true, serving: true });
  local.reopenAnswer = false;
  mark = tunnelLogText().length;
  run = await attempt();
  check(!!run.error && run.error === STOPPED, "a far side that serves but cannot be reached ends in a reset");
  check(local.stopped === 1, "stopTunnel is the answer there: the hop cannot carry it any more");
  const log4 = logSince(mark);
  check(
    log4.includes("the forward could not be rebound for a far side that is still serving"),
    "and it says which of the two sides failed"
  );
  check(log4.includes("existing tunnel is dead or still starting; resetting"), "the reset still logs its sentence");

  // ---- 5. the far side is NOT serving: a real reset ----
  reuseState(dead);
  local.reset();
  wire.reset({ bound: false, serving: false });
  mark = tunnelLogText().length;
  run = await attempt();
  check(!!run.error && run.error === STOPPED, "a far side with nothing listening is a fresh dial");
  check(local.stopped === 1, "the dead tunnel is reset");
  check(local.reopened === 0, "no point re-opening a forward to nobody");
  const log5 = logSince(mark);
  check(log5.includes("far side reports DOWN"), "the far side's answer is on the record");
  check(log5.includes("existing tunnel is dead or still starting; resetting"), "and the reset logs its sentence");
  check(wire.selfAsks === 1, "the far side is asked once, not per probe retry");

  // ---- 6. a different host is a MOVE, never a reuse ----
  // (the guard above this branch: reuse of A for a request for B reported success
  // while every byte still went to A)
  reuseState(dead);
  // ... but the live hop is to someone else
  state.target = { host: "other", user: "someone", port: 22 };
  local.reset();
  wire.reset();
  mark = tunnelLogText().length;
  run = await attempt();
  check(!!run.error && run.error === STOPPED, "a request for another host spends the old hop");
  check(local.stopped === 1, "stopTunnel for the move");
  check(local.reopened === 0 && wire.selfAsks === 0, "and it asks nothing of a hop it is leaving");

  summary("tunnel-reuse", "a live tunnel is asked before it is replaced");
}

main().catch((e) => {
  console.error("tunnel-reuse: CRASH", e);
  process.exit(1);
});
