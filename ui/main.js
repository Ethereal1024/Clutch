// Electron shell for the decoupled Clutch UI.
//
// The shell holds no agent logic and does NOT spawn the backend itself: every
// machine — local or remote — runs ONE supervisor (agent/supervisor.py), and
// each window gets its own SESSION child (an agent.server on a random port)
// from it. The shell's only job is: pull the supervisor up when it is down
// (first window), ask it for this window's session, and stop the session when
// the window closes (last window's exit ends the supervisor: it self-exits at
// zero sessions). Two ways to reach a backend:
//   - local: supervisor on http://127.0.0.1:8890, session child direct
//   - remote over SSH (ssh2, see ssh-tunnel.js): programmatic bidirectional
//     tunnel with in-app password/key auth, no terminal prompt. The tunnel
//     forwards to the REMOTE supervisor; each window then claims its own
//     remote session and gets a per-window forward to it (the same isolation
//     as local, so .clc flock semantics hold across windows and machines).
//
// The window's backend URL is decided HERE, in the main process, and served
// to the renderer through the api:base IPC. Sessions are claimed lazily
// (first api:base call) and self-heal: a dead session (remote restart, stale
// reap, tunnel hiccup) is re-established and the window is pointed at the new
// URL via the backend:base-changed event.

const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tunnel = require("./ssh-tunnel");
const {
  SUPERVISOR_PORT,
  startLocalSession,
  supervisorSessionStart,
  supervisorSessionStop,
  startSupervisorHeartbeat,
} = require("./server-bootstrap");

function tunnelLog(...args) {
  tunnel.tunnelLog(...args);
}

// Remote session children get --base-url http://127.0.0.1:8892/v1 so they
// reach the client-side LLM proxy over the tunnel's reverse forward. Must
// match LLM_PROXY_REMOTE_PORT in ssh-tunnel.js. Local sessions omit it and use
// the ambient CLUTCH_API_KEY / configured LLM instead.
const REMOTE_LLM_BASE = "http://127.0.0.1:8892/v1";

// Failure-path placeholder only: a healthy session always overrides this with
// the window's real session URL. 8890 is the machine supervisor (lifecycle
// API only), so pointing a renderer at it yields "cannot reach backend" —
// which is exactly the right symptom when no session could be started.
const DEFAULT_API_BASE = "http://127.0.0.1:8890";

// Per-window backend state: webContentsId -> { kind: "local"|"tunnel",
// sessionId, url, stop() }. A window owns exactly one live session at a time;
// switching (local -> tunnel, or re-establishing after a death) releases the
// old one before claiming the new.
const windowBackends = new Map();

async function releaseWindowBackend(winId) {
  const wb = windowBackends.get(winId);
  if (!wb) return;
  windowBackends.delete(winId);
  try {
    wb.stop();
  } catch (e) {
    /* best effort */
  }
}

async function registerTunnelBackend(wc, supBase, res) {
  const fwd = await tunnel.openSessionForward(res.port);
  const hb = startSupervisorHeartbeat(supBase, res.sessionId, () => {
    tunnelLog(`[backend] window ${wc.id} session heartbeat failed; re-establishing`);
    (async () => {
      const cur = windowBackends.get(wc.id);
      if (!cur || cur.sessionId !== res.sessionId) return; // superseded / closed
      await releaseWindowBackend(wc.id);
      const url = await ensureWindowBackend(wc);
      if (!wc.isDestroyed()) wc.send("backend:base-changed", url);
    })();
  });
  const wb = {
    kind: "tunnel",
    sessionId: res.sessionId,
    url: `http://127.0.0.1:${fwd.localPort}`,
    stop: () => {
      hb.stop();
      fwd.close();
      supervisorSessionStop(supBase, res.sessionId);
    },
  };
  windowBackends.set(wc.id, wb);
  return wb.url;
}

// Decide (and, if needed, re-create) this window's backend URL. Returns null
// when no backend is possible; the renderer then shows "cannot reach backend".
async function ensureWindowBackend(wc, notify = false) {
  const ts = tunnel.tunnelStatus();
  if (ts.active && ts.url) {
    const existing = windowBackends.get(wc.id);
    if (existing && existing.kind === "tunnel") return existing.url;
    await releaseWindowBackend(wc.id); // drop any local session first
    let res = await supervisorSessionStart(ts.url, REMOTE_LLM_BASE);
    if (res.error) {
      // the remote supervisor may have idle-exited (nobody claimed a session
      // within the grace): restart it through the tunnel and retry once
      tunnelLog(`[backend] tunnel session start failed (${res.error}); restarting remote supervisor`);
      const ok = await tunnel.restartRemoteServer();
      if (ok) {
        res = await supervisorSessionStart(ts.url, REMOTE_LLM_BASE);
        if (res.error) tunnelLog(`[backend] tunnel session retry failed: ${res.error}`);
      }
    }
    if (!res.error) {
      const url = await registerTunnelBackend(wc, ts.url, res);
      if (notify && !wc.isDestroyed()) wc.send("backend:base-changed", url);
      return url;
    }
    // The tunnel is alive but has no supervisor (a bootstrap-rejected host in
    // SSH-degradation mode, or the remote died mid-session): fall back to a
    // local session — the exec bridge keeps the local agent usable against
    // the remote. Never leave the window pointing at the 8890 control port
    // (it only speaks the lifecycle API, so the UI would read "cannot reach
    // backend" even though the tunnel is fine).
    tunnelLog("[backend] no tunnel session; falling back to a local session");
  }

  const existing = windowBackends.get(wc.id);
  if (existing && existing.kind === "local") return existing.url;
  await releaseWindowBackend(wc.id);
  let s = await startLocalSession();
  if (s.mode === "failed") {
    // a window booting while the supervisor is mid-spawn (or the port is
    // momentarily contended) can transiently fail; retry once before giving up
    tunnelLog(`[backend] local session retry: ${s.reason}`);
    await new Promise((r) => setTimeout(r, 600));
    s = await startLocalSession();
  }
  if (s.mode === "failed") {
    tunnelLog(`[backend] local session failed: ${s.reason}`);
    return null;
  }
  const wb = { kind: "local", sessionId: s.sessionId, url: s.url, stop: s.stop };
  windowBackends.set(wc.id, wb);
  return wb.url;
}

async function stopAllBackends() {
  const ids = [...windowBackends.keys()];
  for (const id of ids) await releaseWindowBackend(id);
  // Normal close: tell every supervisor (local + any tunnel) to exit once their
  // sessions are gone — no orphan lingers. The shutdown flag only fires when
  // n==0, so an in-use supervisor is never killed; abnormal death relies on the
  // heartbeat stale-reap instead. Fire-and-forget: if the request races the app
  // exit, the idle grace still cleans up.
  requestSupervisorShutdown();
}

function requestSupervisorShutdown() {
  const local = `http://127.0.0.1:${SUPERVISOR_PORT}/api/shutdown`;
  const remote = (() => {
    const ts = tunnel.tunnelStatus();
    return ts.active && ts.url ? ts.url + "/api/shutdown" : null;
  })();
  for (const url of [local, remote]) {
    if (!url) continue;
    try {
      fetch(url, { method: "POST" }).catch(() => {});
    } catch (e) {
      /* best effort */
    }
  }
}

// Dev-only: surface any main-process JS error into the tunnel log instead of the
// opaque "A JavaScript error occurred" dialog, so remote failures are diagnosable.
process.on("uncaughtException", (e) => {
  tunnelLog("[fatal] uncaughtException: " + ((e && e.stack) || e));
});
process.on("unhandledRejection", (e) => {
  tunnelLog("[fatal] unhandledRejection: " + ((e && e.stack) || e));
});

app.whenReady().then(async () => {
  // The shell loads the UI from disk via file://; Chromium's file:// cache can
  // keep serving a stale app.js after the bundle is updated, which reads as
  // "I restarted the server and my fix is gone". Clear the session cache on
  // every launch so the window always boots the on-disk UI.
  try {
    await session.defaultSession.clearCache();
  } catch (e) {
    /* best effort */
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "Clutch",
    autoHideMenuBar: true,
    backgroundColor: "#0F0F10", // match the app theme: no white flash while booting
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // A window's backend session exists only while the window does: release it as
  // soon as the window closes (or its renderer crashes) so the session child
  // dies and its project lock is freed — otherwise a closed window's session
  // keeps heartbeating and holds the lock forever (a ghost process that blocks
  // the same project in every other window).
  const winId = win.webContents.id;
  win.on("closed", () => releaseWindowBackend(winId));
  win.webContents.on("destroyed", () => releaseWindowBackend(winId));

  // Load the UI immediately — a slow or hanging backend (e.g. an orphaned
  // supervisor squatting 8890 makes session/start block for tens of seconds)
  // must never leave the window blank. The renderer's api:base IPC resolves
  // the backend lazily; a missing/too-slow backend still shows the UI, which
  // reports "cannot reach backend" and reconnects SSE.
  win.loadFile(path.join(__dirname, "index.html"));

  ipcMain.handle("api:base", async (e) => {
    try {
      const url = await ensureWindowBackend(e.sender);
      return url || DEFAULT_API_BASE;
    } catch (err) {
      tunnelLog(`[backend] api:base failed: ${err && err.message}`);
      return DEFAULT_API_BASE;
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));

  // Mirror the UI's LLM settings into the CLIENT-side settings file the LLM
  // reverse proxy reads (~/.clutch/settings.json). The /api/settings POST above
  // lands on the backend, which is REMOTE in SSH mode; the proxy, however, runs
  // locally and injects the key/upstream itself, so its own file must be kept
  // in sync for endpoint changes to take effect without restarting the app.
  //
  // The file is flat: {"base_url", "model", "api_key", "reasoning_effort"}.
  // Legacy {profiles, active} maps are collapsed to their active profile.
  ipcMain.handle("settings:save", async (_e, data) => {
    try {
      const p = path.join(os.homedir(), ".clutch", "settings.json");
      let cur = {};
      try {
        cur = JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch (e) {
        /* first save: start from an empty file */
      }
      if (cur && cur.profiles) {
        cur = cur.profiles[cur.active] || {}; // legacy map: keep the active profile's values
      }
      const upd = {};
      for (const k of ["base_url", "model"]) {
        if (data && data[k]) upd[k] = data[k];
      }
      if (data && data.api_key) upd.api_key = data.api_key;
      // empty string clears the knob (provider default), undefined keeps it
      if (data && data.reasoning_effort !== undefined) upd.reasoning_effort = data.reasoning_effort;
      const flat = Object.assign({}, cur, upd);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(flat, null, 2), { mode: 0o600 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("tunnel:connect", async (e, cfg) =>
    tunnel.connectTunnel(cfg, (stage) => e.sender.send("tunnel:progress", stage))
  );
  ipcMain.handle("tunnel:status", async () => tunnel.tunnelStatus());
  ipcMain.handle("tunnel:disconnect", async () => {
    // stop every window backend FIRST (tunnel sessions AND degraded local
    // sessions) while the tunnel/bridge is still alive, so remote session/stop
    // and lock cleanup reach their targets; a degraded local session left
    // running after disconnect would be a ghost process against a dead bridge.
    for (const id of [...windowBackends.keys()]) {
      await releaseWindowBackend(id);
    }
    await tunnel.stopTunnel();
    return { ok: true };
  });

  // tell the renderer the moment a tunnel dies, so it can drop a stale API URL
  tunnel.onTunnelEnd(() => {
    if (!win.isDestroyed()) win.webContents.send("tunnel:ended");
  });
});

app.on("window-all-closed", async () => {
  // stop sessions + ask the supervisors to exit FIRST: the tunnel must still be
  // up so the remote supervisor's shutdown request can get through, and the
  // session/stop calls must land before the supervisor checks its session count
  await stopAllBackends();
  tunnel.stopTunnel();
  app.quit();
});

// final safety net: a session child must never outlive the app
app.on("before-quit", () => stopAllBackends());
