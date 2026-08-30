// Machine-supervisor bootstrap check (phase 4 architecture).
// Runs the REAL spawn path and verifies, with two window instances:
//   - window 1: supervisor down -> first window spawns it (127.0.0.1:8890),
//     then gets a session child on a random port, healthy
//   - window 2: supervisor already up -> NOT re-spawned; a second session
//     child on a DIFFERENT port
//   - cross-process lock: both session children are independent processes, so
//     opening the same .clc from window 2 gets a kernel-level 409; when
//     window 1 closes (session killed), the lock is freed without TTL
//   - last window closes -> supervisor self-exits (idle); the next window
//     pulls it up again ("first window starts it, last window ends it")
// Run: node ui/server-bootstrap.test.js
const assert = require("assert");
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
// child/released state), like a separate app/window would.
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { isPackaged: false } };
  return origLoad.call(this, request, ...rest);
};

function fresh() {
  delete require.cache[require.resolve("./server-bootstrap")];
  return require("./server-bootstrap");
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

const windows = [];

async function cleanup() {
  for (const w of windows) {
    try {
      w.stop();
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  // start clean: a previous run's supervisor must be gone before we test
  // "first window spawns it"
  if (await supervisorUp()) {
    // politely ask it to exit: stop any sessions, then wait for idle-exit
    await post(`http://127.0.0.1:${SUPERVISOR_PORT}/api/session/stop`, {}); // unknown sid: safe no-op
    await waitFor("previous supervisor exits", async () => !(await supervisorUp()), 8000);
  }

  // ---- window 1: first window spawns the supervisor + gets a session ----
  const s1 = await fresh().startLocalSession();
  windows.push(s1);
  const res1 = s1;
  assert(res1.mode === "spawned", `window 1 gets a session (got ${res1.mode})`);
  assert(res1.sessionId && res1.sessionId.length > 0, "session id returned");
  const p1 = res1.url;
  assert(p1 && !p1.includes(String(SUPERVISOR_PORT)), `session on a random port (got ${p1})`);
  assert(await healthy(p1), "session child healthy");
  assert(await supervisorUp(), "supervisor is up after window 1");

  // ---- window 2: supervisor already up -> not re-spawned, second session ----
  const s2 = await fresh().startLocalSession();
  windows.push(s2);
  const res2 = s2;
  assert(res2.mode === "spawned", `window 2 gets its own session (got ${res2.mode})`);
  assert(res2.url !== p1, `two windows get different ports (${p1} vs ${res2.url})`);
  assert(await healthy(res2.url), "window 2's session healthy");
  assert(await healthy(p1), "window 1's session still healthy");
  assert(await supervisorUp(), "supervisor still up (single instance)");

  // ---- cross-process lock: same .clc from two session children ----
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-sup-"));
  const p2 = res2.url;
  const st1 = await post(`${p1}/api/project/new`, { dir: workDir, name: "demo" });
  assert(st1.status === 200, "window 1 creates a project");
  const clc = JSON.parse(st1.body).project;
  const stOpen1 = await post(`${p1}/api/project/open`, { path: clc });
  assert(stOpen1.status === 200, "window 1 opens it (holds flock)");
  const stOpen2 = await post(`${p2}/api/project/open`, { path: clc });
  assert(stOpen2.status === 409, `window 2 gets kernel 409 on the same .clc (got ${stOpen2.status})`);
  assert(stOpen2.body.includes("project_open_conflict"), "409 carries the conflict code");

  // ---- window 1 closes: session killed, lock freed WITHOUT any TTL ----
  s1.stop();
  await sleep(700);
  assert(!(await healthy(p1)), "window 1's session died with its window");
  assert(await healthy(p2), "window 2's session survives window 1's close");
  const stReopen = await post(`${p2}/api/project/open`, { path: clc });
  assert(stReopen.status === 200, "lock freed on process exit, no TTL needed");

  // ---- last window closes -> supervisor self-exits (idle) ----
  s2.stop();
  await sleep(700);
  assert(!(await healthy(p2)), "window 2's session died with its window");
  await waitFor("supervisor idle-exit after last window", async () => !(await supervisorUp()), 20000);

  // ---- next window pulls the supervisor up again ----
  const s3 = await fresh().startLocalSession();
  windows.push(s3);
  const res3 = s3;
  assert(res3.mode === "spawned", "window 3 re-spawns the supervisor + session");
  assert(await healthy(res3.url), "window 3's session healthy");
  s3.stop();
  await waitFor("supervisor exits after cleanup", async () => !(await supervisorUp()), 20000);

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
