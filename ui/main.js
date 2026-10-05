// Electron main process: claims/releases each window's backend session
// (local or tunneled) and re-establishes it on death via backend:base-changed.
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("path");
const tunnel = require("./ssh-tunnel");
const { SUPERVISOR_PORT, ensureSupervisor, startLocalSession } = require("./server-bootstrap");
const { createHostCore } = require("./host-core");
const { createComponentsView } = require("./components-view");
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

// no base placeholder: the machine-wide supervisor port (8890) answers the
// session lifecycle, not a window API, so handing it to the renderer as a
// "fallback" would only point it at a port that fails every request. A window
// with no session gets null and shows "not running".

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

// The plugin tab's backend: which machine is the target, what it holds, what
// this client could give it, and one install. Facts only — the renderer neither
// reads a manifest nor uploads bytes itself (ui/components-view.js).
//
// `ensureSupervisor` is this machine's wake: the supervisor exits when it is
// idle, so an install onto THIS machine starts it again instead of failing with
// "did not answer" (八 G1). The far side of a tunnel starts its own.
const componentsView = createComponentsView({
  supervisorBase: () => `http://127.0.0.1:${SUPERVISOR_PORT}`,
  tunnelStatus: () => tunnel.tunnelStatus(),
  windowKind: (wc) => hostCore.backendKind(wc.id),
  ensureSupervisor,
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
    // file:// cache can serve stale renderer scripts after a bundle update: clear it on launch
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
        // null = this window has no session (no tunnel, and no local one
        // either): the renderer stays on "not running" and waits for
        // backend:base-changed. Never the supervisor's port as a stand-in.
        return (await hostCore.ensureWindowBackend(e.sender)) || null;
      } catch (err) {
        tunnelLog(`[backend] api:base failed: ${err && err.message}`);
        return null;
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

    // the plugin tab: what the target machine holds and what this client knows.
    // Reads, so a failure comes back inside the answer (the page draws the
    // reason) instead of rejecting the invoke.
    ipcMain.handle("components:list", async (e) => componentsView.list(e.sender));
    ipcMain.handle("components:market", async (_e, opts) => componentsView.market(opts || {}));
    // the reverse verbs, named the way the host names them: `versions` asks what
    // one machine holds, `remove` asks it to let one go (the host may refuse —
    // something is running it — and that arrives as the error inside the answer).
    ipcMain.handle("components:versions", async (e, name) =>
      componentsView.versions(String(name || ""), e.sender)
    );
    ipcMain.handle("components:remove", async (e, name, opts) =>
      componentsView.remove(String(name || ""), opts || {}, e.sender)
    );
    // the switch: the one write here that is reversible, so the state is sent
    // rather than a verb translated (ui/components-view.js setDisabled)
    ipcMain.handle("components:set-disabled", async (e, name, disabled) =>
      componentsView.setDisabled(String(name || ""), Boolean(disabled), e.sender)
    );
    ipcMain.handle("components:install", async (e, name) =>
      componentsView.install(String(name || ""), e.sender, {
        // one line at a time to the window that asked; a closed window is not an
        // error, it is a page that stopped caring
        progress: (stage) => {
          if (!e.sender.isDestroyed()) e.sender.send("components:progress", stage);
        },
      })
    );

    ipcMain.handle("tunnel:connect", async (e, cfg) =>
      tunnel.connectTunnel(cfg, (stage) => e.sender.send("tunnel:progress", stage))
    );

    ipcMain.handle("tunnel:status", async () => tunnel.tunnelStatus());
    ipcMain.handle("tunnel:disconnect", async () => {
      // THE MACHINE-WIDE act: the picker's own Disconnect, i.e. the user leaving
      // this machine. Every window's claim goes, because every window was on the
      // tunnel the user just dropped.
      await hostCore.releaseAllBackends();
      await tunnel.stopTunnel();
      return { ok: true };
    });

    // ONE window leaving its session (the conn-lost dialog's Cancel): release
    // what THIS renderer holds — the main process knows which window asked, so a
    // renderer cannot name another one — and stop the tunnel only when nobody is
    // left on it. Stopping it unconditionally is what made one window's Cancel
    // tear the other windows' claims down with it.
    ipcMain.handle("session:release", async (e) => {
      await hostCore.releaseWindowBackend(e.sender.id);
      if (!hostCore.anyTunnelWindow()) await tunnel.stopTunnel();
      return { ok: true };
    });

    // tell every renderer the moment a tunnel dies, so it can drop a stale API
    // URL — each one told for ITSELF: `lost` is this window's answer, computed
    // from the windows the hop actually owned. A window on its own local session
    // hears about the hop (it still drops what the hop implied, e.g. degrade
    // mode), but it is not told it lost a session it never had: that answer is
    // what used to raise the reconnect dialog — and re-dial a stranger's host —
    // in windows that were working perfectly well.
    tunnel.onTunnelEnd(async () => {
      // the session forwards this window's URL named died with the tunnel:
      // drop them first, so a re-claim that races this notification opens a
      // FRESH forward instead of handing the window a port nobody serves
      const affected = await hostCore.releaseTunnelBackends();
      const lost = new Set(affected);
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("tunnel:ended", { lost: lost.has(w.webContents.id) });
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
