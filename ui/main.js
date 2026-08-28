// Electron shell for the decoupled Clutch UI.
//
// The shell holds no agent logic and does NOT spawn the backend: it loads the
// local static frontend and talks to a separately-running clutch-server over
// HTTP. Two ways to reach a backend:
//   - local / direct: CLUTCH_API_URL or the default http://127.0.0.1:8890
//   - remote over SSH (ssh2, see ssh-tunnel.js): programmatic bidirectional
//     tunnel with in-app password/key auth, no terminal prompt.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { connectTunnel, stopTunnel, runAssist, tunnelLog, tunnelStatus, onTunnelEnd } = require("./ssh-tunnel");

const API_BASE = process.env.CLUTCH_API_URL || "http://127.0.0.1:8890";

// Dev-only: surface any main-process JS error into the tunnel log instead of the
// opaque "A JavaScript error occurred" dialog, so remote failures are diagnosable.
process.on("uncaughtException", (e) => {
  tunnelLog("[fatal] uncaughtException: " + ((e && e.stack) || e));
});
process.on("unhandledRejection", (e) => {
  tunnelLog("[fatal] unhandledRejection: " + ((e && e.stack) || e));
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "Clutch",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

  ipcMain.handle("tunnel:connect", async (e, cfg) =>
    connectTunnel(cfg, (stage) => e.sender.send("tunnel:progress", stage))
  );
  ipcMain.handle("tunnel:assist", async (e) =>
    runAssist((stage) => e.sender.send("tunnel:progress", stage))
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
  app.quit();
});
