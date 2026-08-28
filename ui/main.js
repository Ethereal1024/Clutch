// Electron shell for the decoupled Clutch UI.
// The shell holds no agent logic and does NOT spawn the backend: it loads the
// local static frontend and talks to a separately-running clutch-server over
// HTTP. Set CLUTCH_API_URL to point at a backend on another host/device
// (default: the local server on port 8890).

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");

const API_BASE = process.env.CLUTCH_API_URL || "http://127.0.0.1:8890";

app.whenReady().then(async () => {
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

  // Native dialogs for creating / opening project files (local-backend mode).
  ipcMain.handle("dialog:pickDirectory", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Choose a folder for the new project",
      buttonLabel: "Choose folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle("dialog:pickProjectFile", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Open a Clutch project",
      buttonLabel: "Open project",
      properties: ["openFile"],
      filters: [{ name: "Clutch project", extensions: ["clc"] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
