"use strict";

// Regression test for the reported "the task went idle by itself" after a blip.
//
// The window's session lives on a supervisor that reaps it once STALE_S (300s,
// agent/procmgr/supervise.py) has passed since its LAST heartbeat. The client
// beat every 8s and handed the FIRST failed beat to onFail(), which releases the
// session — i.e. it stopped (killed) a session whose task was still running and
// then re-claimed an empty one: the window's run vanished and the new session's
// status frame honestly said idle. The phone saw exactly that, silently.
//
// The client now treats a failed beat as a blip: it beats again on a short
// cadence, and only reports the failure once the silence has outlived the
// supervisor's own window — at which point the host has reaped the session
// anyway, so the re-claim costs nothing that was still alive.
//
// The runner drives the REAL startSupervisorHeartbeat against a fake fetch and a
// fake clock, so a silent edit that publishes the first hiccup fails here. It
// also pins the constants against the python side they mirror: a client that
// gives up sooner than the supervisor reaps kills runs the host was still
// holding, and one that gives up later carries a session that is already gone.
//
// Run: node tests/session-heartbeat-test.js

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "ui", "supervisor-client.js"), "utf8");
const PY = fs.readFileSync(path.join(ROOT, "agent", "procmgr", "supervise.py"), "utf8");

// ---- the wire contract with the supervisor (agent/procmgr/supervise.py) ----
const num = (re, text, what) => {
  const m = re.exec(text);
  check(!!m, `the ${what} is declared where the other side can be read against it`);
  return m ? Number(m[1]) : NaN;
};
const staleS = num(/^STALE_S = ([\d.]+)/m, PY, "supervisor stale window (STALE_S)");
const beatMs = num(/const HEARTBEAT_INTERVAL_MS = (\d+);/, SRC, "client beat interval");
const retryMs = num(/const HEARTBEAT_RETRY_MS = (\d+);/, SRC, "client retry cadence");
const giveUpMs = num(/const HEARTBEAT_STALE_MS = (\d+);/, SRC, "client give-up window");
const timeoutMs = num(/const HEALTH_REQUEST_TIMEOUT_MS = (\d+);/, SRC, "request timeout");

check(giveUpMs / 1000 === staleS,
  `the client gives up exactly when the host reaps (${giveUpMs}ms vs STALE_S ${staleS}s)`);
check(beatMs / 1000 < staleS,
  `a beat lands inside the stale window (${beatMs}ms vs ${staleS}s)`);
check(retryMs / 1000 < staleS - timeoutMs / 1000,
  "a retry can still get a beat in before the window closes (even after a 2s timeout)");
check(/const SESSION_START_TIMEOUT_MS = [\d_]+;/.test(SRC), "sanity: the module loaded");
check(!/failed = true;/.test(SRC),
  "a beat failure is no longer an immediate verdict on the session");

// ---- the ladder: every "the wire is dead" claim is made from the outside in --
// Being told "the connection is lost" is a claim about the WIRE, and three
// independent timers decide when to make it, in three different files:
//
//   ssh keepalive   tunnel-connect.js  15s x 3  -> the far end of the tunnel is gone
//   SSE stale       ui/js/sse-stream.js  45s    -> this window's event stream is dead
//   supervisor reaps                      300s  -> the host takes the session down
//
// They must be stair-stepped, not stacked: an inner timer that outlived the
// outer one would let a window keep painting a live frame off a socket that is
// already known to be dead, and the operator gets the original complaint back —
// a task that "went idle by itself". The tunnel is also the shortest deliberately
// (see the comment at the keepalive above) so a hop that dies is a CLAIM to
// re-bind, well inside the session's life on the host.
const TUN = fs.readFileSync(path.join(ROOT, "ui", "tunnel-connect.js"), "utf8");
const SSE = fs.readFileSync(path.join(ROOT, "ui", "js", "sse-stream.js"), "utf8");
const SRV = fs.readFileSync(path.join(ROOT, "agent", "server.py"), "utf8");

const kaMs = num(/keepaliveInterval: (\d+),/, TUN, "ssh keepalive interval");
const kaCount = num(/keepaliveCountMax: (\d+),/, TUN, "ssh keepalive miss budget");
const sseBeatMs = num(/const SSE_KEEPALIVE_MS = (\d+);/, SSE, "server keepalive cadence");
// SSE_STALE_MS is WRITTEN as a multiple of the keepalive: read the multiplier, so
// a bare relabelling cannot silently decouple the two.
const sseStaleMul = num(/const SSE_STALE_MS = SSE_KEEPALIVE_MS \* (\d+);/, SSE,
  "the multiple of missed keepalives that counts as dead");
const sseStaleMs = sseBeatMs * sseStaleMul;
const srvBeatS = num(/^SSE_KEEPALIVE_SEC = ([\d.]+)$/m, SRV, "host's own keepalive cadence");

const tunnelDeadMs = kaMs * kaCount;
check(Number.isFinite(tunnelDeadMs) && tunnelDeadMs > 0,
  "the tunnel declares its far end dead on a real budget");
check(tunnelDeadMs <= sseStaleMs,
  `a dead tunnel is called out no later than the stream that rides it ` +
  `(ssh ${tunnelDeadMs}ms <= SSE stale ${sseStaleMs}ms)`);
check(sseStaleMs <= giveUpMs,
  `the stream goes stale well inside the window the host still holds the session ` +
  `(${sseStaleMs}ms <= ${giveUpMs}ms)`);
check(tunnelDeadMs < giveUpMs,
  `a hop that dies is a claim to re-bind, not a session to replace ` +
  `(${tunnelDeadMs}ms < ${giveUpMs}ms)`);
check(sseBeatMs / 1000 === srvBeatS,
  `the keepalive the window watches is the one the host sends ` +
  `(SSE_KEEPALIVE_MS ${sseBeatMs} vs SSE_KEEPALIVE_SEC ${srvBeatS})`);
check(sseStaleMul > 1,
  `one missed keepalive is a hiccup, not death (x${sseStaleMul})`);

// ---- the loop itself, on a fake clock and a fake network ----
const realNow = Date.now;
let clock = 1_000_000; // far from 0 so a zeroed timestamp cannot pass by accident
Date.now = () => clock;

let timers = []; // { at, fn }
let seq = 0;
global.setTimeout = (fn, ms) => {
  const t = { id: ++seq, at: clock + (ms || 0), fn };
  timers.push(t);
  return t.id;
};
global.clearTimeout = (id) => {
  timers = timers.filter((t) => t.id !== id);
};

async function drain() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); // let the awaited beat settle
}

async function advance(ms) {
  const target = clock + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    clock = due.at;
    due.fn();
    await drain();
  }
  clock = target;
}

let network = true;
let beats = 0;
let beatLog = [];
global.fetch = async () => {
  beats++;
  beatLog.push(clock);
  if (!network) throw new Error("Failed to fetch");
  return { ok: true };
};
global.AbortController = class {
  constructor() {
    this.signal = {};
  }
  abort() {}
};

const { startSupervisorHeartbeat } = require(path.join(ROOT, "ui", "supervisor-client.js"));

(async () => {
  let fails = 0;
  let lastOk = clock;
  const hb = startSupervisorHeartbeat("http://127.0.0.1:8891", "s1", () => {
    fails++;
  });

  // ---- 1) one missed beat is a blip, not a dead session ----
  network = false;
  await advance(beatMs); // the beat that happened to fall inside the blip
  check(beats === 1, "the beat was attempted");
  check(fails === 0, "one failed beat does NOT release the session (the run was killed here)");
  check(timers.length === 1 && timers[0].at - clock <= retryMs,
    "a retry is armed on the short cadence instead");

  // ---- 2) the network comes back: the retry lands INSIDE the stale window ----
  network = true;
  const silenceAtFailure = clock - lastOk;
  await advance(retryMs);
  check(beats === 2, "the retry beat reached the supervisor");
  check(fails === 0, "contact re-established: nothing was released, the run goes on");
  check(clock - lastOk >= silenceAtFailure && clock - lastOk < giveUpMs,
    `the gap stayed inside the host's window (${clock - lastOk}ms < ${giveUpMs}ms)`);
  lastOk = clock;
  check(timers.length === 1 && timers[0].at - clock === beatMs,
    "and the ordinary 8s cadence is back");

  // ---- 3) real silence: report it exactly once, when the host has reaped ----
  // (the window is 300s now, so the fake clock has to cover it: the point of the
  // check is that nothing is reported while the host still holds the session)
  network = false;
  await advance(giveUpMs + 60_000);
  check(fails === 1, "a session silent past the stale window is reported (once, not per beat)");
  check(clock - lastOk >= giveUpMs,
    "and only then — the host has reaped the session by now, so nothing alive was dropped");
  check(network === false && beats >= 3, "the failures were actually retried before the verdict");
  const beatsAtVerdict = beats;
  await advance(60_000);
  check(beats === beatsAtVerdict && fails === 1,
    "after the verdict the loop stops: no beating a session that is gone");

  // ---- 4) stop() disarms the loop (window closed / backend released) ----
  network = true;
  let more = 0;
  const hb2 = startSupervisorHeartbeat("http://127.0.0.1:8891", "s2", () => more++);
  hb2.stop();
  const beatsBefore = beats;
  await advance(120_000);
  check(beats === beatsBefore && more === 0, "a stopped heartbeat never beats again");

  Date.now = realNow;
  summary("session-heartbeat");
})();
