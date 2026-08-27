// Electron shell: spawns the local Python server and opens the product UI in a window.
// The shell holds no app logic — everything lives in the Python server + static frontend.

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = process.env.CLUTCH_PORT || 8890;
const ROOT = path.resolve(__dirname, "..");
const PY = path.join(ROOT, ".venv", "bin", "python");

let serverProc = null;

function waitForServer(url, tries = 60) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        n += 1;
        if (n > tries) return reject(new Error("server not ready"));
        setTimeout(tick, 500);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

app.whenReady().then(async () => {
  serverProc = spawn(PY, ["-m", "agent.server", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/health`);
  } catch (e) {
    console.error("[electron] server failed to start:", e.message);
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "clutch",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Native dialogs for creating / opening project files.
  ipcMain.handle("dialog:pickDirectory", async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle("dialog:pickProjectFile", async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Clutch project", extensions: ["clc"] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  win.loadURL(`http://127.0.0.1:${PORT}/`);
});

app.on("window-all-closed", () => {
  if (serverProc) serverProc.kill();
  app.quit();
});

app.on("quit", () => {
  if (serverProc) serverProc.kill();
});
