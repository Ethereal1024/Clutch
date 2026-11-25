// Machine-supervisor bootstrap check: runs the REAL spawn path with two
// windows — first spawns the supervisor + session, second reuses it with its
// own session child (independent processes, so the .clc lock is kernel-level);
// last window closes -> supervisor idle-exits.
//
// The spawn path has no entry of its own any more: `startLocalSession` is gone,
// this machine is one row of the endpoint table (ui/executors.ts) like any hop,
// and the ONE claim path starts the supervisor when it is that machine's turn
// (ui/host-core.ts claimSlotBackend -> server-bootstrap's ensureSupervisor). So
// this runner drives exactly that: a real host core over a real executors table, a
// hop module with no hops, and the real supervisor client — the three pieces the
// desktop main process itself wires.
// Run: node tests/server-bootstrap.test.js
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const origLoad = Module._load;

// test isolation: production always uses the fixed 8890, but the dev machine
// may have an old shared agent-server there — tests run on their own port
process.env.CLUTCH_SUPERVISOR_PORT = process.env.CLUTCH_SUPERVISOR_PORT || "8899";
process.env.CLUTCH_SUPERVISOR_IDLE_TIMEOUT = "1"; // fast idle-exit: tests wait for it
const SUPERVISOR_PORT = Number(process.env.CLUTCH_SUPERVISOR_PORT);

// server-bootstrap.js requires electron; satisfy it with a stub so the module
// loads in plain node. Each fresh() gets a fresh module instance (its own
// child/retire state), like a separate app process would.
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { isPackaged: false } };
  return origLoad.call(this, request, ...rest);
};

const { createHostCore } = require("../ui/host-core");
const { createExecutors } = require("../ui/executors");
const realSessions = require("../ui/supervisor-client");

function fresh() {
  delete require.cache[require.resolve("../ui/server-bootstrap")];
  return require("../ui/server-bootstrap");
}

// Every session the real client starts, so the plain-release case below can name
// the child that outlived its claim: a release that is not `leaving` drops the
// record and leaves the process to the supervisor, which is the quit gate's to end.
const started = [];
const sessions = {
  ...realSessions,
  supervisorSessionStart: async (base) => {
    const r = await realSessions.supervisorSessionStart(base);
    if (r && r.sessionId) started.push({ base, sessionId: r.sessionId, port: r.port });
    return r;
  },
};

// A hop module with no hops: this runner is about the machine the app runs on.
const noHop = { primaryTunnel: () => null, tunnelFor: () => null, listTunnels: () => [] };

function fakeWin(id) {
  return { id, isDestroyed: () => false, send: () => {} };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(url) {
  try {
    const r = await fetch(`${url}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.text() };
}

async function supervisorUp() {
  return healthy(`http://127.0.0.1:${SUPERVISOR_PORT}`);
}

async function waitFor(what, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(300);
  }
  assert(false, `timed out waiting for ${what}`);
  return false;
}

// One app process: its endpoint table (this machine — the shell's own supervisor —
// and no hops) and the claim machine over it.
const apps = []; // every app this run started, so cleanup can say it is leaving
function app() {
  const boot = fresh();
  const local = { base: () => boot.localBase, wake: () => boot.ensureSupervisor() };
  const executors = createExecutors({ tunnel: noHop, local });
  const core = createHostCore({ executors, sessions });
  const a = { core, boot };
  apps.push(a);
  return a;
}

let predecessor = null; // the fake old-build supervisor of the upgrade check

async function cleanup() {
  if (predecessor && predecessor.exitCode === null && predecessor.signalCode === null) {
    try {
      predecessor.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const a of apps) {
    try {
      // the app is leaving: say so, or a claim without a leaving note keeps its session
      await a.core.releaseAllBackends({ leaving: true });
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  // start clean: a previous run's supervisor must be gone before we test
  // "first window spawns it"
  if (await supervisorUp()) {
    // a previous run may have left sessions behind (its children postpone the
    // idle exit for the reaper's window). /api/shutdown is the door the app's
    // own quit gate uses: kill what still runs, then arm the exit.
    await post(`http://127.0.0.1:${SUPERVISOR_PORT}/api/shutdown`, {});
    await waitFor("previous supervisor exits", async () => !(await supervisorUp()), 8000);
  }

  // ---- window 1: the first claim spawns the supervisor + gets a session ----
  const a = app();
  const w1 = fakeWin(1);
  const p1 = await a.core.ensureSlotBackend(w1, "", true);
  assert(p1 && !p1.includes(String(SUPERVISOR_PORT)), `session on a random port (got ${p1})`);
  assert(await healthy(p1), "session child healthy");
  assert(await supervisorUp(), "supervisor is up after window 1");
  const s1 = started[started.length - 1];
  assert(s1 && s1.sessionId && s1.sessionId.length > 0, "session id returned");

  // the extracted pure-HTTP client sees the same live supervisor
  const { supervisorProbe } = require("../ui/supervisor-client");
  assert.strictEqual(
    await supervisorProbe(`http://127.0.0.1:${SUPERVISOR_PORT}`),
    "up",
    "supervisor-client probe recognizes the supervisor"
  );

  // ---- window 2: supervisor already up -> not re-spawned, second session ----
  const w2 = fakeWin(2);
  const p2 = await a.core.ensureSlotBackend(w2, "", true);
  assert(p2 !== p1, `two windows get different ports (${p1} vs ${p2})`);
  assert(await healthy(p2), "window 2's session healthy");
  assert(await healthy(p1), "window 1's session still healthy");
  assert(await supervisorUp(), "supervisor still up (single instance)");

  // ---- cross-process RUN claim: one running client per .clc ----
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-sup-"));
  const st1 = await post(`${p1}/api/project/new`, { dir: workDir, name: "demo" });
  assert(st1.status === 200, "window 1 creates a project");
  const clc = JSON.parse(st1.body).project;
  const stOpen1 = await post(`${p1}/api/project/open`, { path: clc });
  assert(stOpen1.status === 200, "window 1 opens it (an idle open claims nothing)");
  const stOpen2 = await post(`${p2}/api/project/open`, { path: clc });
  assert(stOpen2.status === 200, `an idle .clc opens in both windows (got ${stOpen2.status})`);

  // the exclusivity belongs to the TURN: window 1 starting a run takes the
  // kernel lock on the .clc, and window 2's ask is the 409 that says so
  const run1 = await post(`${p1}/api/run/state`, { busy: true, project: clc });
  assert(run1.status === 200, "window 1 starts a run (the .clc's write claim)");
  const run2 = await post(`${p2}/api/run/state`, { busy: true, project: clc });
  assert(
    run2.status === 409 && run2.body.includes("run_active"),
    `window 2 cannot run the same .clc (got ${run2.status}: ${run2.body})`
  );

  // ---- window 1 closes: {leaving:true} -> session killed, and the claim goes
  // with it WITHOUT any TTL. This is the quit gate's POST: the app says it is
  // going for good, so the supervisor stops the child through its SIGTERM ladder.
  await a.core.releaseSlot(w1.id, "", { leaving: true });
  await sleep(700);
  assert(!(await healthy(p1)), "window 1's session died with its window");
  assert(await healthy(p2), "window 2's session survives window 1's close");
  const stClaim = await post(`${p2}/api/run/state`, { busy: true, project: clc });
  assert(stClaim.status === 200, `claim freed on process exit, no TTL needed (got ${stClaim.status})`);

  // ---- a release WITHOUT `leaving` is not "the app is gone": with a run in
  // flight the child must survive it (a hop loss, a slot re-claim, one tab
  // closed). This session has no claim pid at all here, so the host cannot
  // prove its client is gone either — doubt must keep the child (and its lock)
  // for a re-bind, never start a second session over the same work
  const runState = await post(`${p2}/api/run/state`, { busy: true, project: clc });
  assert(runState.status === 200, "the client claims the run slot");
  await a.core.releaseSlot(w2.id, "", {});
  await sleep(700);
  assert(await healthy(p2), "a plain release keeps a session whose run is in flight");

  // ---- last window closes -> its session stops, supervisor self-exits (idle) ----
  // A plain release dropped the record with the claim (this machine's session is
  // the supervisor's child, not another machine's to park), so what is left is the
  // process: the quit gate's own POST is the door that stops it.
  const orphan = started.find((s) => `http://127.0.0.1:${s.port}` === p2);
  assert(orphan, "the session the plain release left running is the one this app started");
  await realSessions.supervisorSessionStop(orphan.base, orphan.sessionId, { leaving: true });
  await sleep(700);
  assert(!(await healthy(p2)), "window 2's session died with its app");
  await waitFor("supervisor idle-exit after last window", async () => !(await supervisorUp()), 20000);

  // ---- next app pulls the supervisor up again ----
  const b = app();
  const w3 = fakeWin(3);
  const p3 = await b.core.ensureSlotBackend(w3, "", true);
  assert(await healthy(p3), "window 3 re-spawns the supervisor + session");
  await b.core.releaseSlot(w3.id, "", { leaving: true });
  await waitFor("supervisor exits after cleanup", async () => !(await supervisorUp()), 20000);

  // ---- the plugin tab's wake: a write aimed at THIS machine starts its
  // supervisor when it has idle-exited instead of reporting "did not answer"
  // (ui/components-view.js injects this as its ensureSupervisor dep)
  const { ensureSupervisor } = fresh();
  assert(typeof ensureSupervisor === "function", "server-bootstrap exports the wake the plugin tab injects");
  assert(await ensureSupervisor(), "the wake brings an idle-exited supervisor back up");
  assert(await supervisorUp(), "and it answers after the wake");
  assert(await ensureSupervisor(), "a second wake on a running supervisor is a probe, not a spawn");
  await waitFor("supervisor idle-exits after the wake", async () => !(await supervisorUp()), 20000);

  // ---- the upgrade trap: a PREVIOUS build's supervisor holding this port ----
  // The old host outlives the app (its sessions postpone the idle-exit), so the
  // new app used to reuse it and every host-side call kept running the code the
  // update had just replaced — "I upgraded and it is still broken". The fake names
  // another build and its own pid, exactly like a real predecessor; ensureSupervisor
  // must end it and put THIS build on the port.
  const { supervisorIdentity } = require("../ui/supervisor-client");
  const ownVersion = fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  predecessor = spawn(
    process.execPath,
    [
      "-e",
      `const http = require("http");
       const s = http.createServer((q, r) => {
         if (q.url === "/api/health") {
           r.writeHead(200, { "Content-Type": "application/json" });
           r.end(JSON.stringify({ status: "ok", version: "0.0.0-predecessor", pid: process.pid }));
           return;
         }
         r.writeHead(404, { "Content-Type": "application/json" }).end("{}");
       });
       s.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));`,
    ],
    { env: { ...process.env, PORT: String(SUPERVISOR_PORT) }, stdio: ["ignore", "pipe", "inherit"] }
  );
  await waitFor("the predecessor takes the port", async () => supervisorUp(), 15000);
  const seen = await supervisorIdentity(`http://127.0.0.1:${SUPERVISOR_PORT}`);
  assert.strictEqual(seen.state, "up", "the predecessor answers like a supervisor");
  assert.strictEqual(seen.version, "0.0.0-predecessor", "and names a build that is not this app's");
  assert(await fresh().ensureSupervisor(), "ensureSupervisor retires it and takes the port");
  const taken = await supervisorIdentity(`http://127.0.0.1:${SUPERVISOR_PORT}`);
  assert.strictEqual(taken.state, "up", "a supervisor answers after the predecessor is gone");
  assert.strictEqual(taken.version, ownVersion, "and it is THIS build's supervisor");
  assert(taken.pid && taken.pid !== process.pid, "the replacement is its own process");
  await waitFor("the predecessor process is gone", async () => predecessor.exitCode !== null || predecessor.signalCode !== null, 12000);
  assert(await supervisorUp(), "the port is held by a live supervisor, not by silence");
  await post(`http://127.0.0.1:${SUPERVISOR_PORT}/api/shutdown`, {});
  await waitFor("supervisor idle-exits after the upgrade check", async () => !(await supervisorUp()), 20000);

  console.log("all passed (machine supervisor + per-window sessions)");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e.message);
    await cleanup();
    // let the supervisor idle-exit so the next run starts clean
    await sleep(10000);
    process.exit(1);
  });
