"use strict";

// Regression test for the reported "Failed to fetch" + "the file-browse popup
// says 127.0.0.1:8890" after a network blip.
//
// A dropped remote used to be answered with a "fall back to the local backend":
// the Android host handed the renderer the supervisor's LIFECYCLE port (8890) as
// an api:base placeholder, and on a tunnel end the renderer adopted it — while
// clearing the standing SSH intent, so no reconnect was ever attempted. On the
// phone there is no local supervisor at all (N4), so every request after that
// could only fail ("Failed to fetch") while the picker claimed a local backend
// that cannot exist.
//
// The fix: the sentinel is refused on BOTH sides (the host never hands it out,
// the renderer never adopts it), the stale session URL is dropped on a tunnel
// end, and the phone re-attempts the REMOTE it lost instead of pretending a
// local one exists.
//
// Like android-resume-test.js, the renderer part pulls the REAL functions out of
// the renderer and drives them against stubs; the host part drives the REAL
// android-host.js handlers against a fake tunnel.
//
// Run: node tests/no-local-fallback-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const APP = uiSource(); // the renderer, every module in page load order
const MAIN = fs.readFileSync(path.join(ROOT, "ui", "main.js"), "utf8");
const HOST = fs.readFileSync(path.join(ROOT, "android", "host", "android-host.js"), "utf8");
const { fnBody } = slicer(APP);

// ---- 1. the renderer refuses the supervisor's lifecycle port ----
// (real switchBackend / switchBackendResolved, stubbed storage + stream)
const store = new Map();
global.SUPERVISOR_BASE = "http://127.0.0.1:8890";
global.API_BASE = "http://127.0.0.1:31001";
global.busy = false; // the run state switchBackend reads (see silent-idle-test.js)
global.sseRunAtRisk = false;
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let reconnects = 0;
global.reconnectSSE = () => {
  reconnects++;
};
let degradeReapplies = 0;
global.reapplyDegradeIfNeeded = async () => {
  degradeReapplies++;
};
global.window = {};

for (const name of ["switchBackend", "switchBackendResolved", "dropStaleBackend"]) {
  (0, eval)(fnBody(name));
}

check(global.switchBackend("http://127.0.0.1:8890") === false,
  "the supervisor's lifecycle port is refused as a base");
check(global.API_BASE === "http://127.0.0.1:31001",
  "a refused URL leaves the live session base untouched");
check(store.get("clutch_api_url") !== "http://127.0.0.1:8890",
  "and it is not persisted as this window's backend");
check(reconnects === 0, "no stream is opened against the lifecycle port");

check(global.switchBackend("") === false && global.switchBackend(null) === false,
  "an empty answer is refused too (the host may have nothing to offer)");

check(global.switchBackend("http://127.0.0.1:31002/") === true,
  "a real session URL still switches (trailing slash trimmed)");
check(global.API_BASE === "http://127.0.0.1:31002" && reconnects === 1,
  "the live stream is re-scoped to it");

// dropStaleBackend: the dead forwarded port stops being talked to
store.set("clutch_api_url", "http://127.0.0.1:31002");
global.dropStaleBackend();
check(global.API_BASE === null, "a dropped remote leaves no base behind");
check(store.get("clutch_api_url") === undefined, "the stale URL is forgotten");
check(reconnects === 2, "the dead stream is closed (connect bails on a null base)");

// a move under a live run is remembered, so the replaced session's idle frame
// cannot quietly repaint the badge (the whole journey is in silent-idle-test.js)
global.busy = true;
global.switchBackend("http://127.0.0.1:31005");
check(global.sseRunAtRisk === true,
  "a base move while a run is in flight is remembered for the status frame");
global.busy = false;
global.sseRunAtRisk = false;

// ---- 2. the host answers null, never a local placeholder ----
check(!/DEFAULT_API_BASE/.test(HOST),
  "the Android host has no placeholder base to hand out");
check(/return \(await hostCore\.ensureWindowBackend\(window\)\) \|\| null;/.test(HOST),
  "it returns this window's real session URL, or null");
check(!/DEFAULT_API_BASE/.test(MAIN),
  "the desktop shell has no placeholder base either");
check(/return \(await hostCore\.ensureWindowBackend\(e\.sender\)\) \|\| null;/.test(MAIN),
  "it returns this window's real session URL, or null");

// behavioral: the REAL handler, with a tunnel that is down and one that is up
const { createAndroidHost } = require(path.join(ROOT, "android", "host", "android-host.js"));

function fakeTunnel(status) {
  const state = { status, forwards: [], connects: [] };
  return {
    state,
    tunnelStatus: () => state.status,
    restartRemoteServer: async () => true,
    openSessionForward: async (port) => {
      state.forwards.push(port);
      return { localPort: port + 1000, close: () => {} };
    },
    connectTunnel: async (cfg, onProgress) => {
      state.connects.push(cfg);
      state.progress = onProgress;
      return { ok: true, url: state.status.url };
    },
    stopTunnel: async () => {},
    onTunnelEnd: () => {},
    tunnelLog: () => {},
  };
}
function fakeSessions() {
  let seq = 0;
  return {
    supervisorSessionStart: async () => ({ sessionId: "s" + ++seq, port: 30000 + seq }),
    supervisorSessionStop: () => {},
    startSupervisorHeartbeat: () => ({ stop: () => {} }),
    supervisorShutdown: () => {},
  };
}

async function main() {
  // tunnel down: no session, and nothing to invent -> null (renderer: "not running")
  const down = createAndroidHost({
    tunnel: fakeTunnel({ active: false, url: null }),
    sessions: fakeSessions(),
    log: () => {},
  });
  check((await down.handlers.clutchApi.baseUrl()) === null,
    "no tunnel -> null, not a dead local port");
  check(!down.state, "no state leak");

  // tunnel up: the forwarded session port, never the supervisor's own port
  const up = createAndroidHost({
    tunnel: fakeTunnel({ active: true, url: "http://127.0.0.1:8891" }),
    sessions: fakeSessions(),
    log: () => {},
  });
  const url = await up.handlers.clutchApi.baseUrl();
  check(url === "http://127.0.0.1:31001", `tunnel up -> the forwarded session port (got ${url})`);
  check(url !== "http://127.0.0.1:8890", "and never the supervisor's lifecycle port");

  // ---- 3. a dropped tunnel re-attempts the REMOTE instead of going local ----
  check(/const SUPERVISOR_BASE = "http:\/\/127\.0\.0\.1:8890";/.test(APP),
    "the renderer names the lifecycle port once, as a sentinel");
  check(/sseSuspend/.test(APP) && /clean === SUPERVISOR_BASE/.test(fnBody("switchBackend")),
    "and refuses it in the one place a base is adopted");

  const at = APP.indexOf("window.clutchTunnel.onEnd");
  check(at > 0, "the tunnel-end handler exists");
  const onEnd = APP.slice(at, at + 1600);
  check(/dropStaleBackend\(\)/.test(onEnd),
    "a tunnel end drops the dead forwarded port (no posting into nothing)");

  const androidStart = onEnd.indexOf("if (IS_ANDROID)");
  const desktopFlagDrop = onEnd.indexOf('localStorage.removeItem("clutch_ssh_connected")');
  check(androidStart > 0 && desktopFlagDrop > androidStart,
    "the handler splits the phone from the desktop");
  const phoneBranch = onEnd.slice(androidStart, desktopFlagDrop);
  check(/reconnectRemote\(/.test(phoneBranch),
    "the phone re-attempts the REMOTE it lost");
  check(!/removeItem\("clutch_ssh_connected"\)/.test(phoneBranch),
    "and keeps the standing SSH intent (dropping it killed every retry)");
  check(!/resetBackendLocal/.test(phoneBranch),
    "and never resets a local backend that does not exist on the phone");
  check(!/switchBackendResolved/.test(phoneBranch),
    "and never re-routes the phone to the local backend");

  check(new RegExp("const REMOTE_RETRY_TRIES = \\d+;").test(APP) &&
    /await new Promise\(\(r\) => setTimeout\(r, REMOTE_RETRY_GAP_MS\)\)/.test(fnBody("reconnectRemote")),
    "a blip longer than one SSH keepalive is retried, spaced, and bounded");

  // the phone's picker never claims a backend it does not have
  check(/"Not connected — no backend"/.test(APP),
    "the picker says 'not connected' instead of 'Using <dead local port>'");

  summary("no-local-fallback");
}

main().catch((e) => {
  console.error("FAIL:", (e && (e.stack || e.message)) || e);
  process.exit(1);
});
