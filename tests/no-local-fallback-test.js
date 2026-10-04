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
// That re-attempt is now the disconnect dialog's job (ui/js/conn-lost.js), not a
// private retry loop in the tunnel-end handler: every detected loss funnels into
// connectionLost(), which re-dials the same host BY NAME from the standing
// intent — the user re-enters nothing, and the one door back is the dialog.
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
// the session URL is THIS window's (js/backend-lifecycle.js): localStorage is
// shared by every window in the process, so it must not be written there
const session = new Map();
global.sessionStorage = {
  getItem: (k) => (session.has(k) ? session.get(k) : null),
  setItem: (k, v) => session.set(k, String(v)),
  removeItem: (k) => session.delete(k),
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

// the one ask (app.js hostSessionUrl) and the two stubs it reaches: switchBackendResolved
// is driven below, and it must go through that door — not around it
global.connLostExitPending = () => false;
let asked = 0;
global.window.clutchApi = {
  baseUrl: async () => {
    asked++;
    return "http://127.0.0.1:31003";
  },
};

for (const name of ["switchBackend", "switchBackendResolved", "dropStaleBackend", "hostSessionUrl"]) {
  (0, eval)(fnBody(name));
}

check(global.switchBackend("http://127.0.0.1:8890") === false,
  "the supervisor's lifecycle port is refused as a base");
check(global.API_BASE === "http://127.0.0.1:31001",
  "a refused URL leaves the live session base untouched");
check(session.get("clutch_api_url") !== "http://127.0.0.1:8890",
  "and it is not persisted as this window's backend");
check(reconnects === 0, "no stream is opened against the lifecycle port");

check(global.switchBackend("") === false && global.switchBackend(null) === false,
  "an empty answer is refused too (the host may have nothing to offer)");

check(global.switchBackend("http://127.0.0.1:31002/") === true,
  "a real session URL still switches (trailing slash trimmed)");
check(global.API_BASE === "http://127.0.0.1:31002" && reconnects === 1,
  "the live stream is re-scoped to it");
check(session.get("clutch_api_url") === "http://127.0.0.1:31002" && store.get("clutch_api_url") === undefined,
  "and the URL is remembered for THIS window's page life, never in the shared storage");

// dropStaleBackend: the dead forwarded port stops being talked to
session.set("clutch_api_url", "http://127.0.0.1:31002");
store.set("clutch_api_url", "http://127.0.0.1:31002"); // a stale global leftover: not this window's
global.dropStaleBackend();
check(global.API_BASE === null, "a dropped remote leaves no base behind");
check(session.get("clutch_api_url") === undefined, "the stale URL is forgotten");
check(store.get("clutch_api_url") === "http://127.0.0.1:31002",
  "and the shared storage is not this window's to write: another window's value is left alone");
check(reconnects === 2, "the dead stream is closed (connect bails on a null base)");
store.delete("clutch_api_url");

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
  // ---- 1b. the one ask: switchBackendResolved goes through app.js hostSessionUrl,
  // so the sentinel refusal and the read-the-note-before-you-ask rule exist once
  // instead of once per caller (the exit's note is what a re-claim must not win)
  global.API_BASE = "http://127.0.0.1:31001";
  asked = 0;
  check(await global.switchBackendResolved() === true && asked === 1 && global.API_BASE === "http://127.0.0.1:31003",
    "the host's answer is adopted through the one ask");
  global.connLostExitPending = () => true; // the conn-lost exit's note is up
  asked = 0;
  check(await global.switchBackendResolved() === false && asked === 0 && global.API_BASE === "http://127.0.0.1:31003",
    "and a boot behind that exit claims nothing: the note is read BEFORE the host is asked");
  global.connLostExitPending = () => false;
  global.window.clutchApi.baseUrl = async () => {
    asked++;
    return "http://127.0.0.1:8890"; // the lifecycle port: an answer that is not a session
  };
  check(await global.switchBackendResolved() === false && global.API_BASE === "http://127.0.0.1:31003",
    "the sentinel is refused at the ask itself, so no caller can adopt it");

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

  // ---- 3. a dropped tunnel reaches the dialog, which re-dials the REMOTE ----
  check(/const SUPERVISOR_BASE = "http:\/\/127\.0\.0\.1:8890";/.test(APP),
    "the renderer names the lifecycle port once, as a sentinel");
  check(/sseSuspend/.test(APP) && /clean === SUPERVISOR_BASE/.test(fnBody("switchBackend")),
    "and refuses it in the one place a base is adopted");

  const at = APP.indexOf("window.clutchTunnel.onEnd");
  const afterEnd = APP.indexOf("// the main process re-established", at);
  check(at > 0, "the tunnel-end handler exists");
  const onEnd = APP.slice(at, afterEnd > at ? afterEnd : at + 1200);
  check(/removeItem\("clutch_degrade"\)/.test(onEnd),
    "a tunnel end drops degrade mode: it died with the exec bridge");
  check(!/if \(IS_ANDROID\)/.test(onEnd),
    "the handler is ONE path for phone and desktop: no local fallback to split off");
  check(/if \(!localStorage\.getItem\("clutch_ssh_connected"\)\) return;/.test(onEnd),
    "a disconnect the user asked for is not a loss: no dialog for it");
  check(!/removeItem\("clutch_ssh_connected"\)/.test(onEnd),
    "and the standing SSH intent survives the loss (dropping it killed every retry)");
  check(/connectionLost\("lost the remote connection"\)/.test(onEnd),
    "the loss goes to the one dialog that owns the way back");
  check(!/notice\(|reconnectRemote|switchBackendResolved/.test(onEnd),
    "nothing else answers it behind the dialog's back");

  // the deleted route stays deleted: the retry loop with its own counters, and
  // the local reset that pointed the phone at a port nobody serves
  check(!/reconnectRemote/.test(APP), "the deleted local-fallback retry is not back");
  check(!/REMOTE_RETRY_TRIES|REMOTE_RETRY_GAP_MS/.test(APP),
    "nor its counters: the dialog's own bounded backoff replaced them");

  // the door the dialog opens is the SAME host, BY NAME (the user re-enters nothing)
  check(/if \(!host \|\| !user \|\| !localStorage\.getItem\("clutch_ssh_connected"\)\) return null;/.test(fnBody("connLostRemoteIntent")),
    "the dialog re-attempts the remote the window was on, from the standing intent");
  check(/await handleSshConnect\(intent\.host, intent\.user, intent\.port/.test(fnBody("connLostRedial")),
    "through the picker's own connect path (keys first, password prompt only if asked)");
  check(/if \(remote && !\(await connLostTunnelUp\(\)\)\)/.test(fnBody("connLostRecover")),
    "and the remote goes FIRST while its hop is down, before the host is asked");

  // the host is the ONLY other door, and it is not a try-counted fallback: a
  // window that was on a remote stays on it, and nothing clears the user's own
  // standing intent behind their back
  const recover = fnBody("connLostRecover");
  check(!/CONN_LOST_HOST_FALLBACK_AFTER/.test(APP) && !/CONN_LOST_PROOF_MS/.test(APP),
    "the try-counted second host is gone for good");
  check(!/removeItem\("clutch_ssh_connected"\)/.test(recover),
    "recovering never clears the user's own standing intent");
  check(!/IS_ANDROID/.test(recover),
    "and there is no phone/desktop split in the door: one window, one door");
  check(/return connLostRedial\(remote\);/.test(recover),
    "the remembered remote is the door, whenever its hop is down");
  check(/if \(!\(await switchBackendResolved\(\)\)\) return false;/.test(fnBody("connLostAskHost")),
    "a host that has nothing to offer is not a recovery (it said so)");

  // the phone's picker never claims a backend it does not have
  check(/"Not connected — no backend"/.test(APP),
    "the picker says 'not connected' instead of 'Using <dead local port>'");

  summary("no-local-fallback");
}

main().catch((e) => {
  console.error("FAIL:", (e && (e.stack || e.message)) || e);
  process.exit(1);
});
