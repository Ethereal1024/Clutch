// Electron main process: claims/releases each window's backend session
// (local or tunneled) and re-establishes it on death via backend:base-changed.
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
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

// remote sessions: LLM via the tunnel's reverse forward (matches LLM_PROXY_REMOTE_PORT)
const REMOTE_LLM_BASE = "http://127.0.0.1:8892/v1";

// failure placeholder only; a healthy session overrides this with the window's real URL
const DEFAULT_API_BASE = "http://127.0.0.1:8890";

// per-window backend state: webContentsId -> {kind, sessionId, url, stop()}
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

// Decide (and, if needed, re-create) this window's backend URL.
async function claimWindowBackend(wc, notify = false) {
  const ts = tunnel.tunnelStatus();
  if (ts.active && ts.url) {
    const existing = windowBackends.get(wc.id);
    if (existing && existing.kind === "tunnel") return existing.url;
    await releaseWindowBackend(wc.id); // drop any local session first
    let res = await supervisorSessionStart(ts.url, REMOTE_LLM_BASE);
    if (res.error) {
      // the remote supervisor may have idle-exited: restart it through the tunnel and retry once
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
    // tunnel alive but supervisorless (degraded host or remote died): fall back to a local session
    tunnelLog("[backend] no tunnel session; falling back to a local session");
  }

  const existing = windowBackends.get(wc.id);
  if (existing && existing.kind === "local") return existing.url;
  await releaseWindowBackend(wc.id);
  let s = await startLocalSession(() => {
    // self-heal: the local supervisor died (idle exit, crash, stale reap);
    // re-claim and point the renderer at the new URL — same as the tunnel path
    tunnelLog(`[backend] window ${wc.id} local session heartbeat failed; re-establishing`);
    (async () => {
      const cur = windowBackends.get(wc.id);
      if (!cur || cur.sessionId !== s.sessionId) return; // superseded / closed
      await releaseWindowBackend(wc.id);
      await ensureWindowBackend(wc, true);
    })();
  });
  if (s.mode === "failed") {
    // a window booting mid-spawn can transiently fail; retry once
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
  if (notify && !wc.isDestroyed()) wc.send("backend:base-changed", wb.url);
  return wb.url;
}

// one in-flight claim per window: overlapping api:base calls (renderer boot,
// retries) must share a single session claim, not spawn two session children
const backendClaims = new Map(); // webContentsId -> Promise<url|null>
function ensureWindowBackend(wc, notify = false) {
  const inflight = backendClaims.get(wc.id);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      return await claimWindowBackend(wc, notify);
    } finally {
      backendClaims.delete(wc.id);
    }
  })();
  backendClaims.set(wc.id, p);
  return p;
}

async function stopAllBackends() {
  const ids = [...windowBackends.keys()];
  for (const id of ids) await releaseWindowBackend(id);
  // Normal close: tell every supervisor to exit once their sessions are gone
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

// surface main-process errors in the tunnel log instead of the opaque error dialog
process.on("uncaughtException", (e) => {
  tunnelLog("[fatal] uncaughtException: " + ((e && e.stack) || e));
});
process.on("unhandledRejection", (e) => {
  tunnelLog("[fatal] unhandledRejection: " + ((e && e.stack) || e));
});

// One Electron process per machine: a second `npm start` opens a NEW WINDOW in
// the running instance. Two processes would race the supervisor AND (fatally
// for saved state) the loser cannot open the profile's LevelDB lock, so its
// localStorage — saved SSH connections, last dir, mode — reads EMPTY and every
// write is silently lost (the "device list only shows localhost" bug).
// external URLs (model-provided links etc.) must open in the SYSTEM browser;
// an in-window navigation would replace the whole app UI with the target page
// and leave no way back (no back button), forcing the user to restart the session
function openExternally(url) {
  if (url && (url.startsWith("http:") || url.startsWith("https:"))) {
    shell.openExternal(url);
  }
}

function createWindow() {
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
  // window.open() / target=_blank: never create a new app window, hand off to the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  // plain link clicks (no target) would navigate THIS window: the app itself
  // lives on file://, so anything that leaves the current URL is an external
  // link — web URLs go to the system browser, everything else is blocked
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (url.startsWith("http:") || url.startsWith("https:")) {
      event.preventDefault();
      openExternally(url);
    } else if (url !== current) {
      // file: (relative links to project files), javascript:, … — never let a
      // link swap the app UI out (no way back) nor hand untrusted file: to the OS
      event.preventDefault();
    }
  });
  // release the session as soon as the window closes/crashes so its lock frees
  const winId = win.webContents.id;
  win.on("closed", () => releaseWindowBackend(winId));
  win.webContents.on("destroyed", () => releaseWindowBackend(winId));
  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running instance opens the new window
} else {
  app.on("second-instance", () => createWindow());

  app.whenReady().then(async () => {
    // file:// cache can serve a stale app.js after a bundle update: clear it on launch
    try {
      await session.defaultSession.clearCache();
    } catch (e) {
      /* best effort */
    }
    // IPC handlers registered ONCE, before the first window loads; they address
    // windows via e.sender / BrowserWindow.getAllWindows(), so every window
    // (first and second-instance ones) shares them
    ipcMain.handle("api:base", async (e) => {
      try {
        const url = await ensureWindowBackend(e.sender);
        return url || DEFAULT_API_BASE;
      } catch (err) {
        tunnelLog(`[backend] api:base failed: ${err && err.message}`);
        return DEFAULT_API_BASE;
      }
    });

    // Mirror UI LLM settings into the proxy's flat ~/.clutch/settings.json
    // (legacy {profiles, active} maps collapse to their active profile).
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
      // stop window backends first, while the tunnel/bridge is still alive
      for (const id of [...windowBackends.keys()]) {
        await releaseWindowBackend(id);
      }
      await tunnel.stopTunnel();
      return { ok: true };
    });

    // tell every renderer the moment a tunnel dies, so it can drop a stale API URL
    tunnel.onTunnelEnd(() => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("tunnel:ended");
      }
    });

    createWindow();
  });

  app.on("window-all-closed", async () => {
    // stop sessions + ask the supervisors to exit while the tunnel is still up
    await stopAllBackends();
    tunnel.stopTunnel();
    app.quit();
  });

  // final safety net: a session child must never outlive the app
  app.on("before-quit", () => stopAllBackends());
}
