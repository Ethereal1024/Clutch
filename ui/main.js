// Electron main process: claims/releases each window's backend session
// (local or tunneled) and re-establishes it on death via backend:base-changed.
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("path");
const tunnel = require("./ssh-tunnel");
const { SUPERVISOR_PORT, ensureSupervisor, startLocalSession } = require("./server-bootstrap");
const { createHostCore } = require("./host-core");
const { createComponentsView } = require("./components-view");
const { writeSettingsMirror, ensureSettingsMirror, readSettings, getSshSecret } = require("./settings-mirror");
const { createTunnelLadder } = require("./tunnel-ladder");
// the client's plugin path: the /call listener, the reverse row it answers on, and
// the push that tells a session what this client runs (ui/plugin-link.js)
const pluginLink = require("./plugin-link");
// this client plugin domain: the table the plugin page installs into and the one
// the /call listener declares from. ONE object, because two would be two truths
const { createPluginHost } = require("./plugin-host");
// the one place the exec budget is written down (ui/transport_defaults.json is a
// copy of agent/transport_defaults.json); main.js reads it so the host can hand it
// to plugins instead of each plugin inventing its own number
const {
  exec_max_command_bytes: EXEC_MAX_COMMAND_BYTES,
  exec_chunk_bytes: EXEC_CHUNK_BYTES,
} = require("./transport_defaults.json");

function tunnelLog(...args) {
  tunnel.tunnelLog(...args);
}

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
//
// remote sessions get their LLM through the tunnel's reverse forward, and NOT on
// a frozen port: 8892 is what the far side is asked for first, but when a
// listener the far host will not release holds it, the reverse forward lands on
// a port the far side picks instead (ui/tunnel-connect.js) — so the base is read
// here, at claim time, from the state that remembers where it landed.
const hostCore = createHostCore({
  supervisorBase: () => `http://127.0.0.1:${SUPERVISOR_PORT}`,
  remoteLlmBase: () => tunnel.remoteLlmBase(),
  // what a session's heartbeat carries so its LLM endpoint can FOLLOW the model
  // path when a hop lands the reverse forward on another port: only a path that
  // is actually listening is a target (tunnel-core servedLlmBase), because a
  // port nobody serves is exactly the failure this is here to end
  remoteLlmTarget: () => {
    const base = tunnel.servedLlmBase();
    return base ? { base_url: base, model: remoteLlmModel() } : null;
  },
  remoteLlmModel,
  remoteLlmKnobs,
  tunnelStatus: () => tunnel.tunnelStatus(),
  // the far side's model path is installed beside the connect, not inside it: the
  // claim waits for it here, so a session is never spawned with its --base-url
  // pointed at a port nobody serves (ui/tunnel-connect.js startModelPath)
  awaitModelPath: () => tunnel.awaitModelPath(),
  restartRemoteServer: () => tunnel.restartRemoteServer(),
  openSessionForward: (port) => tunnel.openSessionForward(port),
  startLocalSession,
  log: tunnelLog,
});

// Tell the session a window is on what THIS client runs (ui/plugin-link.js).
//
// Only a session that runs on ANOTHER machine is told. A plugin runs where the
// user is sitting — that is the whole point of that domain — and it only means
// something when the session is somewhere else: in a local session the two are
// the same machine, so a client plugin would be an ordinary local component and
// this channel would only duplicate a surface the component tab already has.
//
// Never awaited: the base is the renderer's the moment it is answered, and a
// declaration landing a heartbeat later is a plugin appearing in a session that
// is already running — not a reason to make the window wait on a push. A failure
// is a sentence in the tunnel log; the session reads "this host has no channel".
// A write that changed THIS CLIENT plugins changed what every session is offered,
// so the declarations are re-pushed before the answer reaches the page: a plugin
// installed in one window is a tool the session can call in the next breath, and
// the answer about a client write is the only place that knows a write happened.
// A session-domain write changes nothing here (its host declares nothing to
// itself), and a failed write changed nothing at all.
function redeclare(res) {
  if (res && res.ok && res.place === "client") {
    pluginLink.refresh().catch((e) => tunnelLog(`[plugin] re-declaring failed: ${(e && e.message) || e}`));
  }
  return res;
}

function announcePlugins(winId, base) {
  if (!base || hostCore.backendKind(winId) !== "tunnel") return;
  pluginLink
    .offer(base)
    .catch((e) => tunnelLog(`[plugin] declaring to ${base} failed: ${(e && e.message) || e}`));
}

// The reconnect ladder, on the side the platform does not freeze
// (ui/tunnel-ladder.js — the phone's report, which the desktop shares one layer
// down: a minimized/backgrounded window is throttled by Chromium exactly like a
// phone in another app, so the renderer's own redial ladder is parked while
// nobody is looking, and the main process keeps its timers). Exactly as on the
// phone, nothing here dials a host nobody was on: a connect the user WON arms it.
let lostWindowIds = new Set(); // the windows the last hop owned (webContents ids)

const ladder = createTunnelLadder({
  connect: (cfg, onProgress) => tunnel.connectTunnel(cfg, onProgress),
  status: () => tunnel.tunnelStatus(),
  // the same cache connectTunnel itself reads: a background attempt never asks
  secretFor: (host, user, port) => getSshSecret(host, user, port),
  // the hop is back: put each window the outage took back on the session it
  // still holds on the far side (host-core's heartbeat-first re-bind), so a
  // window nobody is looking at is working again when somebody does
  onUp: async () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || !lostWindowIds.has(w.webContents.id)) continue;
      const url = await hostCore.ensureWindowBackend(w.webContents, true);
      // the same session claimed from a fresh hop: its channel moved with the hop
      announcePlugins(w.webContents.id, url);
      tunnelLog(`[tunnel] hop back; window ${w.webContents.id} re-claimed ${url || "(parked)"}`);
    }
  },
  log: tunnelLog,
});

// The plugin tab's backend: which machine is the target, what it holds, what
// this client could give it, and one install. Facts only — the renderer neither
// reads a manifest nor uploads bytes itself (ui/components-view.js).
//
// `ensureSupervisor` is this machine's wake: the supervisor exits when it is
// idle, so an install onto THIS machine starts it again instead of failing with
// "did not answer" (八 G1). The far side of a tunnel starts its own.
// The client half of the same page: a plugin registered anywhere is held HERE,
// by this app process, and there is no supervisor in its path at all — which is
// why it works whatever machine the session is on (ui/components-view.js
// clientInstall, ui/plugin-host.js).
//
// `execBridge` is the one capability a client plugin needs that lives in THIS
// process: the loopback port that reaches the far side of the ssh tunnel. Asked
// per call, so a tunnel that comes up later is still handed to the plugin, and
// empty while no tunnel is up. `execLimits` is the
// other half of that same sentence: the bridge takes one command and no stdin, so
// it also carries the byte budget one such command obeys — the numbers are already
// written down once for the session's own exec path, and a plugin repeating them
// from memory is how two sides drift.
const pluginHost = createPluginHost({
  log: tunnelLog,
  execBridge: () => {
    const ts = tunnel.tunnelStatus() || {};
    return typeof ts.execBridge === "string" ? ts.execBridge : "";
  },
  execLimits: {
    maxCommandBytes: EXEC_MAX_COMMAND_BYTES,
    chunkBytes: EXEC_CHUNK_BYTES,
  },
});
pluginLink.useHost(pluginHost);

const componentsView = createComponentsView({
  supervisorBase: () => `http://127.0.0.1:${SUPERVISOR_PORT}`,
  tunnelStatus: () => tunnel.tunnelStatus(),
  windowKind: (wc) => hostCore.backendKind(wc.id),
  plugins: () => pluginHost,
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
        const base = (await hostCore.ensureWindowBackend(e.sender)) || null;
        // the claim is also the one moment this session may be told what this
        // client runs — a push, never a gate (see announcePlugins)
        announcePlugins(e.sender.id, base);
        return base;
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

    // the plugin tab: what each of the two places holds and what this client knows.
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
      redeclare(await componentsView.remove(String(name || ""), opts || {}, e.sender))
    );
    // the switch: the one write here that is reversible, so the state is sent
    // rather than a verb translated (ui/components-view.js setDisabled)
    ipcMain.handle("components:set-disabled", async (e, name, disabled) =>
      redeclare(await componentsView.setDisabled(String(name || ""), Boolean(disabled), e.sender))
    );
    ipcMain.handle("components:install", async (e, name) =>
      redeclare(await componentsView.install(String(name || ""), e.sender, {
        // one line at a time to the window that asked; a closed window is not an
        // error, it is a page that stopped caring
        progress: (stage) => {
          if (!e.sender.isDestroyed()) e.sender.send("components:progress", stage);
        },
      }))
    );

    // the mirrors a failed fetch is retried through: a read of the list this
    // build ships plus the user's own, and the two writes that move the user's
    // half of it. Each write answers with the list as it now is, so the page
    // draws what was written rather than asking again (ui/components-view.js).
    ipcMain.handle("components:mirrors", async () => componentsView.mirrors());
    ipcMain.handle("components:mirror-add", async (_e, url) => componentsView.addMirror(String(url || "")));
    ipcMain.handle("components:mirror-remove", async (_e, url) =>
      componentsView.removeMirror(String(url || ""))
    );

    ipcMain.handle("tunnel:connect", async (e, cfg) =>
      // every connect goes through the ladder: the user's own dial owns the wire,
      // and a connect that WINS is the standing intent it may redial on the next
      // hop loss (ui/tunnel-ladder.js)
      ladder.userConnect(cfg, (stage) => e.sender.send("tunnel:progress", stage))
    );

    ipcMain.handle("tunnel:status", async () => tunnel.tunnelStatus());
    ipcMain.handle("tunnel:disconnect", async () => {
      // THE MACHINE-WIDE act: the picker's own Disconnect, i.e. the user leaving
      // this machine. Every window's claim goes, because every window was on the
      // tunnel the user just dropped — and the standing intent goes with them.
      ladder.noteUserLeft();
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
      if (!hostCore.anyTunnelWindow()) {
        // the outage's Cancel: this was the last window on the hop and the user
        // is done with it, so nothing may redial this host behind them
        ladder.noteUserLeft();
        await tunnel.stopTunnel();
      }
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
      // the plugin port this hop carried died with it (plugin-link.js hopLost)
      pluginLink.hopLost();
      // remember whose session the hop was carrying, for the ladder's re-claim
      lostWindowIds = new Set(affected);
      // and the ENGINE acts on it: a window that is minimized/backgrounded is
      // throttled by the platform, so its own renderer-side redial ladder is
      // parked (ui/js/conn-lost.js connLostArm) — this notification alone used to
      // leave the hop dead until somebody looked at the window
      ladder.hopLost();
      const lost = new Set(affected);
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("tunnel:ended", { lost: lost.has(w.webContents.id) });
      }
    });

    createWindow();
  });

  app.on("window-all-closed", async () => {
    // the app is going away: the standing intent goes with it
    ladder.stop();
    // the sessions this client served are stopped on the next line, so these
    // DELETEs are a courtesy the far side may never read — not awaited, or one
    // quiet session would hold the quit for its own timeout (ui/plugin-link.js)
    pluginLink.stop();
    // stop sessions + ask the supervisors to exit while the tunnel is still up
    await hostCore.stopAllBackends();
    tunnel.stopTunnel();
    app.quit();
  });

  // final safety net: a session child must never outlive the app
  app.on("before-quit", () => hostCore.stopAllBackends());
}
