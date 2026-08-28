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
const { connectTunnel, stopTunnel, runAssist } = require("./ssh-tunnel");

const API_BASE = process.env.CLUTCH_API_URL || "http://127.0.0.1:8890";

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

  ipcMain.handle("tunnel:connect", async (_e, cfg) => connectTunnel(cfg));
  ipcMain.handle("tunnel:assist", async () => runAssist());
  ipcMain.handle("tunnel:disconnect", async () => {
    await stopTunnel();
    return { ok: true };
  });
});

app.on("window-all-closed", () => {
  stopTunnel();
  app.quit();
});
