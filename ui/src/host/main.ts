// Electron main process: claims/releases each window's backend session
// (local or tunneled) and re-establishes it on death via backend:base-changed.
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("path");
const tunnel = require("./ssh-tunnel");
const { SUPERVISOR_PORT, ensureSupervisor, startLocalSession } = require("./server-bootstrap");
const { createHostCore } = require("./host-core");
// the same pure supervisor client host-core uses; the lock panel asks the host
// that HOLDS a lock (local, or the far side of the tunnel) and never touches a
// lock file itself
const sessions = require("./supervisor-client");
const { createComponentsView } = require("./components-view");
const { writeSettingsMirror, ensureSettingsMirror, readSettings, getSshSecret } = require("./settings-mirror");
const { createTunnelLadder } = require("./tunnel-ladder");
// the About pane's update button: the check/download half (shared with the
// Android host) and the desktop installer that replaces this build
const { createUpdateService } = require("./update-service");
const { createDesktopInstaller, macBundle } = require("./update-install");
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
// the composition root for one session's run loop (P1-4): fetches the session's
// declarations + session facts and wires all five ports into createRunHost.
const { createSessionRun, llmSettingsRev } = require("./run-session");
// the renderer trusts the OS certificate store and Node does not, by default:
// this adopts it for the main process at startup (see system-ca.ts)
const { installSystemTrust, describeTrust } = require("./system-ca");

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

// A slot is ONE TAB's session; an empty slotId is the window's default slot, so
// call sites that predate tabs (and the first tab of every window) keep working.
const slotKey = (winId, slotId = "") => (slotId ? `${winId}::${slotId}` : String(winId));

// run:start / run:state take a slotId AND the page's payload. Keep the old
// one-argument spelling working: `run:start(payload)` means the default slot.
function slotArgs(first, second) {
  return typeof first === "string"
    ? { slotId: first, payload: second }
    : { slotId: "", payload: first };
}

function announcePlugins(winId, slotId, base) {
  if (!base || hostCore.backendKind(winId, slotId) !== "tunnel") return;
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
let lostSlots = []; // the {winId, slotId} claims the last hop owned

const ladder = createTunnelLadder({
  connect: (cfg, onProgress) => tunnel.connectTunnel(cfg, onProgress),
  status: () => tunnel.tunnelStatus(),
  // the same cache connectTunnel itself reads: a background attempt never asks
  secretFor: (host, user, port) => getSshSecret(host, user, port),
  // the hop is back: put each window the outage took back on the session it
  // still holds on the far side (host-core's heartbeat-first re-bind), so a
  // window nobody is looking at is working again when somebody does
  onUp: async () => {
    for (const slot of lostSlots) {
      const w = BrowserWindow.getAllWindows().find(
        (x) => !x.isDestroyed() && x.webContents.id === slot.winId
      );
      if (!w) continue;
      const url = await hostCore.ensureSlotBackend(w.webContents, slot.slotId, true);
      // the same session claimed from a fresh hop: its channel moved with the hop
      announcePlugins(slot.winId, slot.slotId, url);
      tunnelLog(
        `[tunnel] hop back; slot ${slot.winId}::${slot.slotId || "(default)"} re-claimed ${url || "(parked)"}`
      );
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
  componentsPass: () => tunnel.state.componentsPass,
  ensureSupervisor,
  log: tunnelLog,
});

// surface main-process errors in the tunnel log instead of the opaque error dialog
process.on("uncaughtException", (e) => {
  tunnelLog("[fatal] uncaughtException: " + ((e && e.stack) || e));
});
process.on("unhandledRejection", (e) => {
  tunnelLog("[fatal] unhandledRejection: " + (((e as any) && (e as any).stack) || e));
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
    frame: false,          // remove the native OS titlebar; we draw our own
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
  async function releaseWindow() {
    // stop every in-flight run loop this window owns and clear its instances;
    // the aborted final is written as a best-effort (stopAndFlush does not throw).
    // Awaited: the flush POSTs the aborted final to the Python server, and
    // releaseWindowBackends below stops that server — an un-awaited flush
    // races the stop and the server writes "released" instead of "aborted".
    await flushWindowRuns(winId);
    hostCore.releaseWindowBackends(winId);
  }
  win.on("closed", releaseWindow);
  win.webContents.on("destroyed", releaseWindow);
  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

// One run-loop instance per SLOT (one tab): two tabs drive two turns in
// parallel, and a window reload replaces the old instances cleanly (the old
// references die when nobody calls into them anymore). The map is populated
// lazily on the first run:start and cleared when the slot or window closes.
const runInstances = new Map(); // slotKey -> {run, base, mode, project, winId, slotId}

function flushSlotRun(winId, slotId = "") {
  const key = slotKey(winId, slotId);
  const inst = runInstances.get(key);
  if (!inst) return Promise.resolve();
  runInstances.delete(key);
  return stopAndFlush(inst.run).catch(() => {});
}

function flushWindowRuns(winId) {
  const work = [];
  for (const [key, inst] of [...runInstances]) {
    if (inst.winId !== winId) continue;
    runInstances.delete(key);
    work.push(stopAndFlush(inst.run).catch(() => {}));
  }
  return Promise.all(work);
}

// App shutdown: every slot's open turn gets its aborted final before the
// sessions are stopped (a quit is not proof the work was abandoned).
function flushAllRuns() {
  const work = [];
  for (const [key, inst] of [...runInstances]) {
    runInstances.delete(key);
    work.push(stopAndFlush(inst.run).catch(() => {}));
  }
  return Promise.all(work);
}

// Stop flush: when the caller asks run:stop and then drive() rejects because
// the loop was stopped, call step() once more so the loop can write the
// `aborted` final durable line. A missed final leaves the .clc open, and the
// next cold start would resume a turn that was deliberately cancelled.
async function stopAndFlush(run) {
  run.stop();
  try {
    await run.drive();
  } catch (e) {
    // drive() rejected because stopped — now let the loop write the aborted final
    try {
      await run.step();
    } catch (_e) {
      /* the aborted final write may itself fail (e.g. backend gone): ignore */
    }
  }
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
    // The window (Chromium) verifies against the OS certificate store; this
    // process (Node) verifies against the CA list bundled with the runtime, so
    // behind a proxy that inspects HTTPS the page worked and every model request
    // was refused ("self signed certificate"). Adopt the OS store once, here,
    // before the first session or update request can run — and say so in
    // tunnel.log, so a log answers "which roots is this run trusting?" instead
    // of leaving the next certificate error to be diagnosed from zero.
    tunnelLog(describeTrust(installSystemTrust()));
    // file:// cache can serve stale renderer scripts after a bundle update: clear it on launch
    try {
      await session.defaultSession.clearCache();
    } catch (e) {
      /* best effort */
    }
    // IPC handlers registered ONCE, before the first window loads; they address
    // windows via e.sender / BrowserWindow.getAllWindows(), so every window
    // (first and second-instance ones) shares them

    // ---- custom titlebar window controls ----
    ipcMain.on("win:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
    ipcMain.on("win:maximize", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w) return;
      w.isMaximized() ? w.unmaximize() : w.maximize();
    });
    ipcMain.on("win:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());

    ipcMain.handle("api:base", async (e, slotId) => {
      const slot = typeof slotId === "string" ? slotId : "";
      try {
        // null = this slot has no session (no tunnel, and no local one either):
        // the renderer stays on "not running" and waits for
        // backend:base-changed. Never the supervisor's port as a stand-in.
        const base = (await hostCore.ensureSlotBackend(e.sender, slot)) || null;
        // the claim is also the one moment this session may be told what this
        // client runs — a push, never a gate (see announcePlugins)
        announcePlugins(e.sender.id, slot, base);
        return base;
      } catch (err) {
        tunnelLog(`[backend] api:base failed for slot ${slotKey(e.sender.id, slot)}: ${err && err.message}`);
        return null;
      }
    });

    // What one tab's slot holds: claimed or not, which machine, and whether its
    // loop is running. A page reload asks this to re-attach instead of
    // spawning a second session for the same tab.
    ipcMain.handle("slot:status", async (e, slotId) => {
      const slot = typeof slotId === "string" ? slotId : "";
      const status = hostCore.slotStatus(e.sender.id, slot);
      const inst = runInstances.get(slotKey(e.sender.id, slot));
      return { ...status, running: !!inst };
    });

    // Pin a slot to a specific backend target:
    //   { kind: "local" }                       — always use local supervisor
    //   { kind: "tunnel", tunnelId: string }     — always route through this tunnel
    //   null                                     — clear: use global default
    // A new claim (api:base) is needed after changing this for the slot to actually
    // move; changing the target alone only affects the NEXT claim, not the current one.
    ipcMain.handle("slot:set-target", async (e, slotId, target) => {
      const slot = typeof slotId === "string" ? slotId : "";
      try {
        hostCore.setSlotTarget(e.sender.id, slot, target || null);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    });

    // Current pinned target for the slot, or null for the global default.
    ipcMain.handle("slot:get-target", async (e, slotId) => {
      const slot = typeof slotId === "string" ? slotId : "";
      return hostCore.getSlotTarget(e.sender.id, slot);
    });

    // Enumerate connected and recently-connected tunnels. Used by the backend
    // picker to let the user choose which device a tab's session should run on.
    ipcMain.handle("tunnel:list", async () => {
      return tunnel.listTunnels();
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
    // the knobs a component declares: the form is generated from THIS answer, so
    // the page knows no setting by name (ui/components-view.js settings)
    ipcMain.handle("components:settings", async (e, name) => componentsView.settings(String(name || ""), e.sender));
    ipcMain.handle("components:set-setting", async (e, name, values) =>
      redeclare(await componentsView.setSetting(String(name || ""), values, e.sender))
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

    // The update button on the About pane. One service for the whole app, because
    // the CHECK and the DOWNLOAD have to describe the same release — a release
    // published between the two would otherwise install a file the page never
    // named. The version being compared against is the PAGE's stamp
    // (ui/version.js): that is the number the About row is showing, and a check
    // against a different one would let the pane and the button disagree. It
    // travels with the call rather than being read here for exactly that reason,
    // and app.getVersion() only stands in for a window that has no stamp.
    const installer = createDesktopInstaller({
      // <bundle>.app, from the executable this process is running (a `npm start`
      // checkout has none, and the dmg path then says it cannot replace anything)
      appBundle: macBundle(app.getPath("exe")),
      quit: () => app.quit(),
      log: tunnelLog,
    });
    const updates = createUpdateService({
      // the one directory the service will hand to the installer; userData is this
      // app's own, and it survives the quit that installing causes
      updatesDir: path.join(app.getPath("userData"), "updates"),
      install: (file, info) => installer.install(file, info),
      log: tunnelLog,
    });

    ipcMain.handle("update:check", async (_e, current) =>
      updates.check({ current: String(current || "") || app.getVersion() })
    );
    ipcMain.handle("update:download", async (e) =>
      updates.download({
        // one stage at a time to the window that pressed the button; a window that
        // closed mid-download is a page that stopped caring, not an error
        onProgress: (stage) => {
          if (!e.sender.isDestroyed()) e.sender.send("update:progress", stage);
        },
      })
    );
    ipcMain.handle("update:install", async (_e, file) => updates.install(String(file || "")));

    ipcMain.handle("tunnel:connect", async (e, cfg) =>
      // every connect goes through the ladder: the user's own dial owns the wire,
      // and a connect that WINS is the standing intent it may redial on the next
      // hop loss (ui/tunnel-ladder.js). A stage that carries a fraction (the
      // upload's own bytes) is sent as an object — with the rate and the time
      // left when the transfer measured them, because a 78 MB upload on a
      // throttled host is the one stage where "how fast" is the difference
      // between waiting and giving up; a bare stage stays a string, so a window
      // that only knows stage names keeps working.
      ladder.userConnect(cfg, (stage, frac, info) =>
        e.sender.send(
          "tunnel:progress",
          typeof frac === "number"
            ? {
                stage,
                frac,
                bps: info && typeof info.bps === "number" ? info.bps : 0,
                eta: info && typeof info.eta === "number" ? info.eta : 0,
              }
            : stage
        )
      )
    );

    ipcMain.handle("tunnel:status", async () => tunnel.tunnelStatus());
    ipcMain.handle("tunnel:disconnect", async () => {
      // THE MACHINE-WIDE act: the picker's own Disconnect, i.e. the user leaving
      // this machine. Every window's claim goes, because every window was on the
      // tunnel the user just dropped — and the standing intent goes with them.
      ladder.noteUserLeft();
      // `leaving` here too: the user is leaving this MACHINE, not just losing a
      // hop — the supervisor is told so it stops these sessions through its
      // SIGTERM ladder (a `released` final) instead of keeping them for a claim
      // that will never come back. A tab closing, by contrast, releases without
      // it: the window is still here and may re-bind (session:release below).
      await hostCore.releaseAllBackends({ leaving: true });
      await tunnel.stopTunnel();
      return { ok: true };
    });

    // ONE window leaving its session (the conn-lost dialog's Cancel): release
    // what THIS renderer holds — the main process knows which window asked, so a
    // renderer cannot name another one — and stop the tunnel only when nobody is
    // left on it. Stopping it unconditionally is what made one window's Cancel
    // tear the other windows' claims down with it.
    ipcMain.handle("session:release", async (e, slotId) => {
      if (typeof slotId === "string" && slotId) {
        // one tab leaving: flush ITS turn, release ITS session, leave the
        // window's other tabs working
        flushSlotRun(e.sender.id, slotId);
        await hostCore.releaseSlot(e.sender.id, slotId);
      } else {
        flushWindowRuns(e.sender.id);
        await hostCore.releaseWindowBackends(e.sender.id);
      }
      if (!hostCore.anyTunnelWindow()) {
        // the outage's Cancel: this was the last window on the hop and the user
        // is done with it, so nothing may redial this host behind them
        ladder.noteUserLeft();
        await tunnel.stopTunnel();
      }
      return { ok: true };
    });

    // ---- locks:* — the machine that HOLDS a project lock answers -----------
    //
    // A .clc lock is held by a process on the machine the project lives on, so
    // only that machine's supervisor can see the kernel's answer and only it may
    // act (agent/core/lock_reconcile.py). The page asks through here, which
    // picks the supervisor from THIS window's own claim: the far side of a
    // tunnel when the window works there, this machine otherwise. Nothing here
    // ever unlinks a lock file, and reclaim refuses every state but a PROVEN
    // orphan — the host's verdict is returned verbatim so the page can say what
    // actually happened. A claim that names ANOTHER machine (a remote project
    // claimed from a window here) is one of those refusals, and it is the case
    // that left a reopened window staring at "open read-only" for five minutes:
    // the far kernel cannot check our pids, so it keeps the claim until the
    // claimant's own machine speaks. That is what these two do together — one
    // reads each lock's verdict on THIS kernel, the other relays it as a witness.
    //
    // `slotId` is load-bearing, not a convenience: it is the only thing that says
    // WHICH machine to ask, because a slot's claim is what holds the machine. An
    // empty one resolves to the window's default session and, with no such claim,
    // to this machine's supervisor — so a project on a far host came back as "no
    // lock of that name", and the page offered "open read-only?" for a project
    // nothing had open (the fix-train report). Both handlers below are therefore
    // always called with the tab's own slot (ui/src/renderer/project.ts).
    ipcMain.handle("locks:list", async (e, slotId) => {
      const base = hostCore.supervisorBaseFor(e.sender.id, typeof slotId === "string" ? slotId : "");
      if (!base) return { error: "this window has no session host" };
      const listed = await sessions.supervisorLocks(base);
      if (!listed || !Array.isArray(listed.locks)) return listed;
      // The host says who holds each lock; whether the WINDOW that claimed it
      // still exists is a question only the machine it runs on can answer, and
      // that is this one exactly when the record names this host. So each lock
      // carries this kernel's verdict as `claim_liveness` (absent when the claim
      // lives elsewhere: doubt is not painted as life).
      return { locks: listed.locks.map(sessions.annotateClaimLiveness) };
    });

    ipcMain.handle("locks:reclaim", async (e, project, slotId) => {
      const base = hostCore.supervisorBaseFor(e.sender.id, typeof slotId === "string" ? slotId : "");
      if (!base) return { revoked: false, why: "this window has no session host" };
      const key = String(project || "");
      // The page asks; whether anything is PROVABLE is decided here. A claim on
      // another machine cannot be checked by the host that holds the lock (its
      // kernel has never heard of that pid), so the host records the claim and
      // waits for the claimant's own machine to speak — this one, when the
      // record names it. Read the host's list again, take THIS kernel's verdict,
      // and relay a witness only when the claiming window is positively gone: a
      // page cannot talk this host into freeing a live window's project.
      const listed = await sessions.supervisorLocks(base);
      const witness = sessions.claimWitness(listed && listed.locks, key);
      return sessions.supervisorLockReclaim(base, key, witness);
    });

    // ---- run:* — the host-side run loop (P1-4) --------------------------------
    //
    // One createSessionRun instance per window. The renderer calls run:start to
    // open a turn, run:drive to drive it to completion, run:stop to cancel, and
    // run:state to read the fold. The page is a view only: it subscribes to
    // run:event pushes and never owns the loop.
    //
    // run:start creates the instance if one does not exist or if the base URL
    // changed (a reconnect, a new tunnel hop). Creating is async because
    // createSessionRun fetches /api/declarations and /api/session first.
    // run:state builds through the same path, because the page asks it before
    // any start exists: "is a turn open on this log?" is the resume question
    // (P2-3), and "there is no instance" is not an answer to it.
    //
    // The instance is cleared when the window closes (win.on("closed") below),
    // which also stops any in-flight drive so the aborted final is written.

    // run:start and run:state share ONE instance-building path: an instance is
    // created when there is none, and rebuilt when the base, the mode or the
    // project changed (a new hop, a reconnect, a mode toggle, another .clc open)
    // — all three are baked into the tools and the client it was built with.
    // Building is async (createSessionRun fetches /api/declarations and
    // /api/session first), so both callers await it.
    //
    // Answers `{inst}` or `{error, code}`. The code rides on the refusal so the
    // page can tell "another window is driving this turn" (run_active) from
    // "this window has no session" (no_session) — two very different next steps.
    async function ensureRunInstance(wc, slotId, payload) {
      const winId = wc.id;
      const key = slotKey(winId, slotId);
      const mode = payload && (payload.mode === "chat" || payload.mode === "work") ? payload.mode : "";
      const project = String((payload && payload.project) || "");
      // resolve the current session base for this SLOT — null if not claimed
      let currentBase;
      try {
        currentBase = await hostCore.ensureSlotBackend(wc, slotId);
      } catch (err) {
        tunnelLog(`[run] base lookup failed for slot ${key}: ${err && err.message}`);
        return { error: String((err && err.message) || err), code: (err && err.code) || null };
      }
      if (!currentBase) {
        // the one failure the page must treat as a lost session (it lands in
        // the outage dialog, not in the transcript): this slot has no host
        return { error: "no session — the backend is not running", code: "no_session" };
      }
      const inst = runInstances.get(key);
      const rev = typeof llmSettingsRev === "function" ? llmSettingsRev() : "";
      // A settings save changes the model/endpoint/protocol the loop is built
      // with. Reuse only an instance built from the CURRENT settings — never
      // replace one that is mid-drive (that would be two loops on one turn).
      if (
        inst &&
        (inst.driving ||
          (inst.base === currentBase && inst.mode === mode && inst.project === project && inst.rev === rev))
      ) {
        return { inst };
      }
      try {
        const run = await createSessionRun({
          base: currentBase,
          mode: mode || undefined,
          project: project || undefined,
          // live events go straight to the renderer, tagged with the slot they
          // belong to: a background tab's frames must not paint into the active
          // tab's stream
          onEvent: (ev) => {
            if (!wc.isDestroyed()) wc.send("run:event", { slotId, event: ev });
          },
          warn: (msg) => tunnelLog(`[run] slot ${key}: ${msg}`),
        });
        const fresh = { run, base: currentBase, mode, project, winId, slotId, rev, driving: false };
        runInstances.set(key, fresh);
        return { inst: fresh };
      } catch (err) {
        tunnelLog(`[run] createSessionRun failed for slot ${key}: ${err && err.message}`);
        return { error: String((err && err.message) || err), code: (err && err.code) || null };
      }
    }

    // ONE wheel per turn. A start/step/drive for a slot whose instance is
    // already driving is refused here, before it can touch the loop — and the
    // refusal is not a courtesy, it is the fix for two failures seen together:
    //
    //   * a second driver steps the same turn. The session's lease cannot stop
    //     it: claim_run refuses only a DIFFERENT project (agent/base.py), so two
    //     drivers of one project are both "allowed" and both write the log;
    //   * the `finally` below clears the flag the REAL driver set, while it is
    //     still working. The next run:state then sees `driving === false` and
    //     REBUILDS the instance under a live turn (ensureRunInstance's reuse
    //     test) — and the rebuilt one claims the slot, which is the
    //     "the run slot was no longer ours when the turn ended" in the log while
    //     a turn was in flight.
    //
    // `run_active` is the code the page treats as "somebody is driving this":
    // a fact, not a failure (render-events.ts resumeTurn).
    const refuseIfDriving = (inst) =>
      inst && inst.driving
        ? { ok: false, error: "this window is already driving this turn", code: "run_active" }
        : null;

    // run:start takes the page's payload {task, mode, project} — the same shape
    // /api/run took, because it is the same request: a task, the mode it runs
    // in, and the .clc the page believes it is showing. `project` is a CLAIM,
    // not a destination: the session has one open project and that is where the
    // loop appends, so a mismatch is refused (ui/run-session.js) instead of
    // writing this turn into another window's log.
    ipcMain.handle("run:start", async (e, first, second) => {
      const { slotId, payload } = slotArgs(first, second);
      const task = String((payload && payload.task) || "");
      const got = await ensureRunInstance(e.sender, slotId, payload);
      if (got.error) return { ok: false, error: got.error, code: got.code || null };
      const taken = refuseIfDriving(got.inst);
      if (taken) return taken;
      try {
        got.inst.driving = true;
        await got.inst.run.start(task);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
      } finally {
        got.inst.driving = false;
      }
    });

    ipcMain.handle("run:stop", async (e, slotId) => {
      const inst = runInstances.get(slotKey(e.sender.id, typeof slotId === "string" ? slotId : ""));
      if (!inst) return { ok: true }; // nothing running
      try {
        await stopAndFlush(inst.run);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    });

    ipcMain.handle("run:step", async (e, slotId) => {
      const inst = runInstances.get(slotKey(e.sender.id, typeof slotId === "string" ? slotId : ""));
      if (!inst) return { ok: false, error: "no run instance for this slot" };
      const taken = refuseIfDriving(inst);
      if (taken) return taken;
      try {
        inst.driving = true;
        const result = await inst.run.step();
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
      } finally {
        inst.driving = false;
      }
    });

    ipcMain.handle("run:drive", async (e, slotId) => {
      const inst = runInstances.get(slotKey(e.sender.id, typeof slotId === "string" ? slotId : ""));
      if (!inst) return { ok: false, error: "no run instance for this slot" };
      const taken = refuseIfDriving(inst);
      if (taken) return taken;
      try {
        inst.driving = true;
        const result = await inst.run.drive();
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
      } finally {
        inst.driving = false;
      }
    });

    // run:run is the unified interface: start a new turn if idle, continue an
    // open one if the log has an interrupted turn. This is the ONE entry point
    // for user-initiated actions — when the user types "继续" and presses Run,
    // this handles both the "new task" and "resume" cases transparently.
    //
    // The payload is the same as run:start: {task, mode, project}. If the turn
    // is open, the task is ignored and the log's own user_message is honored.
    ipcMain.handle("run:run", async (e, first, second) => {
      const { slotId, payload } = slotArgs(first, second);
      const task = String((payload && payload.task) || "");
      const got = await ensureRunInstance(e.sender, slotId, payload);
      if (got.error) return { ok: false, error: got.error, code: got.code || null };
      const taken = refuseIfDriving(got.inst);
      if (taken) return taken;
      try {
        got.inst.driving = true;
        const result = await got.inst.run.run(task);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
      } finally {
        got.inst.driving = false;
      }
    });

    // run:state takes the same {mode, project} payload run:start does, and that
    // is what makes it the RESUME question (P2-3): the page asks it when it
    // comes up with a project and when it opens one, and a turn is open if the
    // fold says so. Building the instance here is what makes the question
    // answerable at all — before the page's first run:start there was no
    // instance, and answering "idle" for that absence is the one wrong answer:
    // it means "nothing to do" about a turn that is still on the log.
    ipcMain.handle("run:state", async (e, first, second) => {
      const { slotId, payload } = slotArgs(first, second);
      const got = await ensureRunInstance(e.sender, slotId, payload);
      if (got.error) return { ok: false, error: got.error, code: got.code || null };
      try {
        const result = await got.inst.run.state();
        // `driven` is the other half of the answer, and the half the page
        // cannot get anywhere else: the fold says a turn is OPEN, and this
        // says whether THIS window is the one already driving it. They are
        // different facts — resuming a turn somebody is stepping is how a
        // second wheel got on it.
        return { ok: true, result, driven: !!got.inst.driving };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
      }
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
      // remember which slots the hop was carrying, for the ladder's re-claim
      lostSlots = affected;
      // and the ENGINE acts on it: a window that is minimized/backgrounded is
      // throttled by the platform, so its own renderer-side redial ladder is
      // parked (ui/js/conn-lost.js connLostArm) — this notification alone used to
      // leave the hop dead until somebody looked at the window
      ladder.hopLost();
      const lost = new Set(affected.map((s) => s.winId));
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        const id = w.webContents.id;
        const slots = affected.filter((s) => s.winId === id);
        w.webContents.send("tunnel:ended", { lost: lost.has(id), slots });
      }
    });

    createWindow();
  });

  // ---- the quit gate ----------------------------------------------------
  // Every close path ends up here — window-all-closed below, Cmd+Q, a menu
  // Quit, a logout — because Electron runs `before-quit` for all of them. This
  // is the only place the app may say "leaving" to its sessions: a session's
  // claim (this process's pid) is still ALIVE while this runs, so a supervisor
  // that was told nothing would keep the session — and its .clc write lock.
  //
  // preventDefault is what makes the awaits real: Electron does not wait for an
  // async `before-quit` handler, so the old code exited in the middle of the
  // release. The work is BOUNDED (a dying tunnel or a silent supervisor must
  // cost a timeout, never an un-quittable app), and the hard guarantee does not
  // depend on it: if this process is SIGKILLed mid-quit, every session's own
  // watchdog ends it within a second (agent/core/claim_watch.py).
  const FLUSH_DEADLINE_MS = 4000; // one open turn's aborted final, appended
  const RELEASE_DEADLINE_MS = 4000; // every session released + supervisors told
  let quitWork = null; // the cleanup, once started (a second Quit rides it out)
  let quitReady = false; // our own app.quit(): the one that may go through
  const withDeadline = (p, ms) =>
    Promise.race([
      Promise.resolve(p).catch(() => {}),
      new Promise((r) => setTimeout(r, ms)),
    ]);
  async function closeEverything() {
    // the app is going away: the standing intent goes with it
    ladder.stop();
    // the sessions this client served are stopped below, so these DELETEs are a
    // courtesy the far side may never read — not awaited, or one quiet session
    // would hold the quit for its own timeout (ui/plugin-link.js)
    pluginLink.stop();
    // every open turn gets its aborted final before its session goes away; must
    // be awaited so the HTTP append lands before stopAllBackends kills the
    // Python server — an un-awaited flush races the shutdown and the server
    // writes a spurious "released" final instead of "aborted"
    await withDeadline(flushAllRuns(), FLUSH_DEADLINE_MS);
    // release every claim with {leaving:true} and tell every supervisor to die
    // while the tunnel that reaches them is still up
    await withDeadline(hostCore.stopAllBackends({ leaving: true }), RELEASE_DEADLINE_MS);
    tunnel.stopTunnel();
  }

  app.on("before-quit", (e) => {
    if (quitReady) return;
    e.preventDefault(); // hold the quit for the bounded work below
    if (quitWork) return; // a second Cmd+Q must not race the cleanup
    quitWork = closeEverything().finally(() => {
      quitReady = true;
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    // the gate above does the work; quitting is how it starts (every platform:
    // this app has no stay-in-the-dock mode)
    app.quit();
  });
}
