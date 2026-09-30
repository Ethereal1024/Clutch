// Electron main process: claims/releases each window's backend session
// (local or tunneled) and re-establishes it on death via backend:base-changed.
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("path");
const tunnel = require("./ssh-tunnel");
const { SUPERVISOR_PORT, startLocalSession } = require("./server-bootstrap");
const { createHostCore } = require("./host-core");
const { writeSettingsMirror, ensureSettingsMirror, readSettings } = require("./settings-mirror");

function tunnelLog(...args) {
  tunnel.tunnelLog(...args);
}

// remote sessions: LLM via the tunnel's reverse forward (matches LLM_PROXY_REMOTE_PORT)
const REMOTE_LLM_BASE = "http://127.0.0.1:8892/v1";

// The remote host carries no LLM settings of its own (the settings mirror is
// local), so the model must ride along with the session claim; without it the
// remote server dies at LLM init with "missing LLM argument: model".
const remoteLlmModel = () => readSettings().model || "";

// reasoning_effort / api_protocol ride along with the model, for the same
// reason: the remote host settings file has neither, and the session would
// run with provider defaults instead of this client settings.
const remoteLlmKnobs = () => {
  const s = readSettings();
  return { reasoning_effort: s.reasoning_effort || "", api_protocol: s.api_protocol || "" };
};

// failure placeholder only; a healthy session overrides this with the window's real URL
const DEFAULT_API_BASE = "http://127.0.0.1:8890";

// the session-claim state machine lives in host-core.js, shared with the
// Android host; this shell only feeds it its desktop inputs. Electron
// webContents already satisfies host-core's window-handle contract
// ({id, isDestroyed(), send}).
const hostCore = createHostCore({
  supervisorBase: () => `http://127.0.0.1:${SUPERVISOR_PORT}`,
  remoteLlmBase: () => REMOTE_LLM_BASE,
  remoteLlmModel,
  remoteLlmKnobs,
  tunnelStatus: () => tunnel.tunnelStatus(),
  restartRemoteServer: () => tunnel.restartRemoteServer(),
  openSessionForward: (port) => tunnel.openSessionForward(port),
  startLocalSession,
  log: tunnelLog,
});

// surface main-process errors in the tunnel log instead of the opaque error dialog
process.on("uncaughtException", (e) => {
  tunnelLog("[fatal] uncaughtException: " + ((e && e.stack) || e));
});
process.on("unhandledRejection", (e) => {
  tunnelLog("[fatal] unhandledRejection: " + ((e && e.stack) || e));
});

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
  win.on("closed", () => hostCore.releaseWindowBackend(winId));
  win.webContents.on("destroyed", () => hostCore.releaseWindowBackend(winId));
  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

// One Electron process per machine: a second `npm start` opens a NEW WINDOW in
// the running instance. Two processes would race the supervisor AND (fatally
// for saved state) the loser cannot open the profile's LevelDB lock, so its
// localStorage — saved SSH connections, last dir, mode — reads EMPTY and every
// write is silently lost (the "device list only shows localhost" bug).
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
        const url = await hostCore.ensureWindowBackend(e.sender);
        return url || DEFAULT_API_BASE;
      } catch (err) {
        tunnelLog(`[backend] api:base failed: ${err && err.message}`);
        return DEFAULT_API_BASE;
      }
    });

    // settings.json mirror logic lives in ui/settings-mirror.js — shared with
    // the Android host's bridge handlers (single implementation, both shells).
    ipcMain.handle("settings:save", async (_e, data) => {
      try {
        writeSettingsMirror(data);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });

    ipcMain.handle("settings:ensure", async (_e, data) => {
      try {
        return ensureSettingsMirror(data, tunnelLog);
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
      await hostCore.releaseAllBackends();
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
    await hostCore.stopAllBackends();
    tunnel.stopTunnel();
    app.quit();
  });

  // final safety net: a session child must never outlive the app
  app.on("before-quit", () => hostCore.stopAllBackends());
}
