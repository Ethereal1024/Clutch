// Electron shell for the decoupled Clutch UI.
//
// The shell holds no agent logic and does NOT spawn the backend: it loads the
// local static frontend and talks to a separately-running clutch-server over
// HTTP. Two ways to reach a backend:
//   - local / direct: CLUTCH_API_URL or the default http://127.0.0.1:8890
//   - remote over SSH (ssh2, see ssh-tunnel.js): programmatic bidirectional
//     tunnel with in-app password/key auth, no terminal prompt.

const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const { connectTunnel, stopTunnel, tunnelLog, tunnelStatus, onTunnelEnd } = require("./ssh-tunnel");
const { start: startLocalServer, stop: stopLocalServer } = require("./local-server");

const API_BASE = process.env.CLUTCH_API_URL || "http://127.0.0.1:8890";

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
  try { await session.defaultSession.clearCache(); } catch (e) { /* best effort */ }
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

  // Bring up the local backend (bundled agent-server in the packaged app, the
  // venv/uv server in dev) before loading the UI, so the renderer's first
  // requests don't race startup. A missing/too-slow backend still loads the UI:
  // the renderer reports "cannot reach backend" and its SSE stream reconnects.
  const srv = await startLocalServer();
  if (srv.mode === "failed") {
    tunnelLog(`[local-server] ${srv.reason}`);
  } else {
    tunnelLog(`[local-server] backend ${srv.mode} on port ${srv.port || 8890}`);
  }

  win.loadFile(path.join(__dirname, "index.html"));

  ipcMain.handle("tunnel:connect", async (e, cfg) =>
    connectTunnel(cfg, (stage) => e.sender.send("tunnel:progress", stage))
  );
  ipcMain.handle("tunnel:status", async () => tunnelStatus());
  ipcMain.handle("tunnel:disconnect", async () => {
    await stopTunnel();
    return { ok: true };
  });

  // tell the renderer the moment a tunnel dies, so it can drop a stale API URL
  onTunnelEnd(() => {
    if (!win.isDestroyed()) win.webContents.send("tunnel:ended");
  });
});

app.on("window-all-closed", () => {
  stopTunnel();
  stopLocalServer();
  app.quit();
});

// final safety net: the bundled backend must never outlive the app
app.on("before-quit", () => stopLocalServer());
