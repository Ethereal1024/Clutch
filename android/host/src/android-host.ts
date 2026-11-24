// Android host (M1): the same session-claim state machine, tunnel, settings
// mirror and supervisor client the Electron shell (ui/main.js) runs, fed
// Android-shaped inputs. Everything below that is not in this file is shared
// code — the Android-specific surface is exactly:
//   N1  the renderer reaches the host through android/host/bridge-server.js
//   N2  HOME/TMPDIR are set by the Kotlin shell before Node boots, so
//       os.homedir()-based paths (~/.clutch/...) land in the app sandbox
//   N3  pylibs artifacts come from CI prebuilts (artifact-provider-android)
//   N4  no local python: supervisorBase()=null, startLocalSession absent
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBridgeServer } = require("./bridge-server");
const { createAndroidArtifactProvider } = require("./artifact-provider-android");

// Resolve a shared ui/ module: prefers the copy synced next to this file (the
// nodejs-project layout on the phone, see scripts/sync-android-host.sh), falls
// back to the repo layout (Linux dev + tests run android-host.js straight from
// the checkout). One resolver so both layouts load the SAME module instances —
// e.g. the artifact provider must land on the server-bundle instance that
// ui/ssh-tunnel.js already required.
function useUI(name) {
  const local = path.join(__dirname, "ui", name);
  return require(fs.existsSync(local) ? local : path.join(__dirname, "..", "..", "ui", name));
}

// shared with the desktop shell — these are THE implementations, not copies
const { createHostCore } = useUI("host-core.js");
const {
  writeSettingsMirror,
  ensureSettingsMirror,
  readSettings,
  getSshSecret,
} = useUI("settings-mirror.js");
const { createComponentsView } = useUI("components-view.js");
const { createTunnelLadder } = useUI("tunnel-ladder.js");
// the About pane's update button: the same check/download the desktop runs, over
// the same release — only the install step differs (the page's WebView shell owns
// it here; this process cannot start an Intent)
const { createUpdateService } = useUI("update-service.js");
// This client's own plugin domain, one for one with the desktop shell's (P1-6):
// the table the plugin page installs into (ui/plugin-host.js), the listener and
// the reverse forward that declare it to a session (ui/plugin-link.js). One
// object each, because two would be two truths — the same rule ui/main.js states.
const { createPluginHost } = useUI("plugin-host.js");
const pluginLink = useUI("plugin-link.js");
// how a plugin is STARTED here: the desktop forks a process, the phone cannot
// (`process.execPath` is the app itself — libnode is loaded INTO it, see
// native-lib.cpp), so the runtime is a worker thread with the same containment.
// ui/plugin-worker.js states the one difference (a worker cannot chdir).
const { spawnInWorker } = useUI("plugin-worker.js");
// the one place the exec budget is written down (ui/transport_defaults.json, the
// same numbers agent/transport_defaults.json carries): a plugin is handed the
// budget its far-side command obeys instead of inventing one
const {
  exec_max_command_bytes: EXEC_MAX_COMMAND_BYTES,
  exec_chunk_bytes: EXEC_CHUNK_BYTES,
} = useUI("transport_defaults.json");
// the composition root for one session's run loop (P1-4) is resolved lazily
// so it is only loaded when the renderer calls clutchRun.start for the first
// time. This keeps UI_NODE in sync-android-host.sh minimal: the run loop's
// module tree (run.js / run-host.js / log-client.js / …) is added there when
// the phone is ready to drive the loop (P1-6). Until then, a call to start()
// before the modules are present returns {ok:false} with a clear message.
//
// NOTE: intentionally NOT called through useUI() so tests/android-assets.test.js
// does not demand run-session.js be in UI_NODE before the phone is ready for it.
function loadSessionModule() {
  try {
    const local = path.join(__dirname, "ui", "run-session.js");
    const fallback = path.join(__dirname, "..", "..", "ui", "run-session.js");
    const resolved = require("fs").existsSync(local) ? local : fallback;
    return require(resolved);
  } catch (e) {
    return null;
  }
}

// No base placeholder exists. The desktop's 127.0.0.1:8890 is the supervisor's
// LIFECYCLE port (it answers /api/session/*, never a window API), and this host
// has no local supervisor at all (N4) — so a "failure placeholder" here could
// only ever point a window at a dead port that fails every request with
// "Failed to fetch". A host with nothing to offer returns null and the window
// stays on "not running" until the tunnel produces a real forwarded session.
// remote sessions: LLM via the tunnel's reverse forward. The port is NOT frozen
// here: 8892 is what the far side is asked for first, but when a listener the far
// host will not release holds it, the reverse forward lands on a port the far
// side picks instead (ui/tunnel-connect.js) — so the base comes from the tunnel
// (tunnel-core's remoteLlmBase) and is read at claim time, after that landing.

function createAndroidHost({ tunnel, sessions, log, bridgePort = 8899 }: any = {}) {
  tunnel = tunnel || useUI("ssh-tunnel.js");
  sessions = sessions || useUI("supervisor-client.js");
  log = log || tunnel.tunnelLog;

  // N3: register the artifact provider BEFORE any tunnel strategy decision —
  // the desktop default would otherwise try to run bash/uv on the phone
  useUI("server-bundle.js").setArtifactProvider(createAndroidArtifactProvider());

  const hostCore = createHostCore({
    supervisorBase: () => null, // N4: no local supervisor on Android
    remoteLlmBase: () => tunnel.remoteLlmBase(),
    // the same re-point target the desktop shell hands host-core: a session's
    // --base-url is frozen at spawn, so where this device serves the model has to
    // ride the heartbeat or a hop that moves the reverse forward strands the run
    remoteLlmTarget: () => {
      const base = tunnel.servedLlmBase();
      return base ? { base_url: base, model: readSettings().model || "" } : null;
    },
    // same reason as ui/main.js: the remote session cannot read this device's settings
    remoteLlmModel: () => readSettings().model || "",
    remoteLlmKnobs: () => {
      const s = readSettings();
      return { reasoning_effort: s.reasoning_effort || "", api_protocol: s.api_protocol || "" };
    },
    tunnelStatus: () => tunnel.tunnelStatus(),
    // the far side's model path is installed beside the connect, not inside it:
    // the claim waits for it here (host-core), so a session is never spawned with
    // its --base-url pointed at a port nobody serves (ui/tunnel-connect.js)
    awaitModelPath: () => tunnel.awaitModelPath(),
    restartRemoteServer: () => tunnel.restartRemoteServer(),
    openSessionForward: (port) => tunnel.openSessionForward(port),
    startLocalSession: null, // N4: no local mode; the renderer shows "not running"
    log,
    sessions,
  });

  // This client's plugin domain (P1-6): the app process owns the bytes (root
  // `~/.clutch/client`, which N2's HOME puts inside the app sandbox), the plugin
  // page installs into it, and ui/plugin-link.js declares what it holds to the
  // session. It is the SAME object the desktop builds, with one answer that has to
  // differ: how a plugin process is started (ui/plugin-worker.js).
  //
  // A host with no worker support still has the domain — list/install/remove all
  // work — and every call then fails with this sentence instead of a plugin that
  // "exited before answering" for a reason nobody can read (I3).
  const pluginHost = createPluginHost({
    log,
    // the far side of the tunnel, asked per call: the bridge port only lives while
    // a hop is up, so a captured string would go stale the moment it is rebuilt
    execBridge: () => {
      const ts = tunnel.tunnelStatus() || {};
      return typeof ts.execBridge === "string" ? ts.execBridge : "";
    },
    execLimits: {
      maxCommandBytes: EXEC_MAX_COMMAND_BYTES,
      chunkBytes: EXEC_CHUNK_BYTES,
    },
    spawn:
      typeof spawnInWorker === "function"
        ? spawnInWorker
        : () => {
            throw new Error(
              "this phone's engine cannot start a plugin: it has no node binary to fork and no worker support — " +
                "install the component on the session machine instead"
            );
          },
  });
  pluginLink.useHost(pluginHost);

  // The plugin tab's backend — the same object the desktop shell builds
  // (ui/main.js:55), fed this host's answers. N4 decides which machine a request
  // is about: this host has no local supervisor (`supervisorBase()` is null), and
  // the CLAIM is what names a machine (`components-view.ts` `target`), so a window
  // that holds no session has no machine to be about — the view answers with the
  // quiet wait rather than the page dying on a missing channel. A window whose
  // session sits on the tunnel targets the far supervisor's URL — components are
  // installed on the machine that will RUN them, so "install onto the phone" is
  // never the answer when the tools run on the far side.
  const componentsView = createComponentsView({
    supervisorBase: () => null, // N4: no local supervisor on Android
    tunnelStatus: () => tunnel.tunnelStatus(),
    windowKind: (w) => hostCore.backendKind(w.id),
    // …and the place a frontend plugin goes: THIS app process (ui/plugin-host.js).
    // Without it the page reads `client: false` and says a plugin has nowhere to go
    // here — which was true until this domain existed (ui/js/components-panel.js).
    plugins: () => pluginHost,
    log,
  });

  // This session's channel to that domain. A claim is the first moment a session
  // could call a plugin, so it is the first moment declaring one is worth doing
  // (ui/plugin-link.js offer). Never awaited: a declaration landing a heartbeat
  // later is a plugin appearing in a session that is already running, not a reason
  // to keep the window waiting on a push.
  function announcePlugins(base, slotId = "") {
    if (!base || hostCore.backendKind(window.id, slotId) !== "tunnel") return;
    pluginLink.offer(base).catch((e) => log(`[plugin] declaring to ${base} failed: ${(e && e.message) || e}`));
  }

  // An install, a removal or a stop changed what every session is offered, so the
  // declarations are re-pushed before the answer reaches the page — the same rule
  // as the desktop shell (ui/main.js redeclare). A session-domain write changes
  // nothing here, and a failed write changed nothing at all.
  function redeclare(res) {
    if (res && res.ok && res.place === "client") {
      pluginLink.refresh().catch((e) => log(`[plugin] re-declaring failed: ${(e && e.message) || e}`));
    }
    return res;
  }

  // The About pane's update button: the same check and download the desktop shell
  // runs (ui/update-service.js), over the same release, with one honest difference
  // — this process cannot start an Intent, so it cannot install what it fetched.
  // The page hands the downloaded path to its own WebView shell instead
  // (window.clutchShell.installApk, android/.../UpdateInstaller.kt), which is the
  // half of the update that lives on the Kotlin side. The bridge verb says so
  // rather than pretending a phone app can replace itself.
  const updates = createUpdateService({
    platform: "android",
    arch: process.arch, // nodejs-mobile reports the ABI it was built for: arm64-v8a -> "arm64"
    mobile: true,
    // HOME is filesDir (N2), so this is filesDir/updates: the ONE directory
    // res/xml/file_paths.xml publishes through the FileProvider, and the only one
    // UpdateInstaller will accept a path from
    updatesDir: path.join(os.homedir(), "updates"),
    install: () => ({
      ok: false,
      error: "the phone's shell installs an APK — the page calls window.clutchShell.installApk for that",
    }),
    log,
  });

  // N5's minimal window mapping: the whole app is ONE window. host-core sends
  // backend:base-changed through this handle; the bridge fans it out over SSE.
  const bus: { broadcast: (...args: any[]) => void } = { broadcast: () => {} };
  const window = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => bus.broadcast(channel, payload),
  };

  // The reconnect ladder, on the side that survives the freeze (ui/tunnel-ladder.js
  // explains the split it closes). On the phone it matters most: the renderer is
  // the part Android suspends while the app is in the background, and the engine
  // — this process, held by TunnelService's foreground service — is the part that
  // keeps running. The secret comes from the same cache connectTunnel itself
  // reads (ssh_secrets), so an attempt here never has to ask for anything.
  // The wake-lock marker (M4). TunnelService — the foreground service that holds
  // this engine — polls $HOME/tunnel.state and keeps the CPU awake only while it
  // says the user wants a tunnel. It has to be a file: NodeEngine exposes no
  // handle the Kotlin side could call into, and a marker under HOME is the idiom
  // this app already uses for bridge.port. `armed` is the whole answer: a connect
  // that succeeded set it, Disconnect and the outage's Cancel cleared it, and the
  // ladder's own stand-downs (nothing left to dial with, the hop came back on its
  // own) cleared it too — so a phone that can no longer redial does not hold the
  // processor awake for a tunnel it is not going to get.
  // Both markers are the same shape — decide the word, read, write only on a
  // change — so the writing lives once. A failed write is logged and swallowed:
  // a marker is a hint to a native service, never the engine's own work.
  function writeMarker(file, want) {
    let current = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (e) {
      /* absent on the first write */
    }
    if (current === want) return; // nothing changed: no write at all
    try {
      fs.writeFileSync(file, want);
    } catch (e) {
      log(`[wake] could not write ${file}: ${(e && e.message) || e}`);
    }
  }

  const wakeMarker = path.join(os.homedir(), "tunnel.state");
  function writeWakeMarker(state) {
    writeMarker(wakeMarker, state && state.armed ? "up" : "down");
  }

  // The second marker (P5-2): "a turn is being driven on this device RIGHT NOW".
  // That is not the standing intent above and not the run-slot lease either — the
  // lease also stays held between two page calls while a turn is merely OPEN, and
  // a phone must not keep its CPU awake for a turn nobody is stepping. So the word
  // is written from the loop's own busy edges (ui/run-session.js onBusy): "busy"
  // on entry of the first call, "idle" when the last one returns. Anything that is
  // not "busy" reads as idle. TunnelService holds the CPU while EITHER marker says
  // yes; see runBusy() there.
  const runMarker = path.join(os.homedir(), "run.state");
  function writeRunMarker(busy) {
    writeMarker(runMarker, busy ? "busy" : "idle");
  }

  let lostSlots = []; // the slots the last hop owned

  const ladder = createTunnelLadder({
    connect: (cfg, onProgress) => tunnel.connectTunnel(cfg, onProgress),
    status: () => tunnel.tunnelStatus(),
    secretFor: (host, user, port) => getSshSecret(host, user, port),
    // every change of the standing intent goes to the marker above — including
    // the disarmings that happen inside the ladder and reach no call site here
    onState: writeWakeMarker,
    // the hop is back: re-bind THIS window's claim through host-core's own
    // verdict (heartbeat first, then the forward to the SAME remote session),
    // which is also how the session's window contract is re-armed on the far
    // side while the phone is still in the background
    onUp: async () => {
      for (const slot of lostSlots) {
        const url = await hostCore.ensureSlotBackend(window, slot.slotId, true);
        // the same session claimed from a fresh hop: its channel moved with the hop
        announcePlugins(url, slot.slotId);
        log(
          `[ladder] slot ${slot.slotId || "(default)"} re-bound: ${url || "parked (the far session is not provably there yet)"}`
        );
      }
    },
    log,
  });

  // One run-loop instance per SLOT (tab). The phone is one window, but a window
  // can now hold several tabs, each with its own session — two turns run in
  // parallel exactly as two desktop windows did. Instances are replaced when the
  // base URL, the mode or the project changes, and cleared when the slot ends.
  const runInsts = new Map(); // slotId -> {run, base, mode, project}
  const busySlots = new Set(); // slots whose loop is busy right now

  function slotKey(slotId = "") {
    return slotId || "(default)";
  }

  function flushSlot(slotId = "") {
    const inst = runInsts.get(slotId);
    if (!inst) return;
    runInsts.delete(slotId);
    busySlots.delete(slotId);
    stopAndFlush(inst.run).catch(() => {});
  }

  function flushAllRuns() {
    for (const id of [...runInsts.keys()]) flushSlot(id);
    writeRunMarker(false);
  }

  // Stop flush: same logic as ui/main.js stopAndFlush — write the aborted final
  // before the loop is abandoned, so a cold restart sees a closed turn.
  async function stopAndFlush(run) {
    run.stop();
    try {
      await run.drive();
    } catch (e) {
      try {
        await run.step();
      } catch (_e) {
        /* aborted final write may fail if backend is gone: ignore */
      }
    }
  }

  // One instance-building path for start and state, exactly as ui/main.js's
  // ensureRunInstance: built when absent, rebuilt when the base, the mode or the
  // project changed. Answers {run} or {error, code}.
  async function ensureRun(slotId, payload) {
    const mode = payload && (payload.mode === "chat" || payload.mode === "work") ? payload.mode : "";
    const project = String((payload && payload.project) || "");
    const base = (await hostCore.ensureSlotBackend(window, slotId)) || null;
    if (!base) return { error: "no session — the backend is not running", code: "no_session" };
    const mod = loadSessionModule();
    const createSessionRun = mod && mod.createSessionRun;
    if (!createSessionRun) return { error: "the run loop is not available in this build" };
    const rev = typeof mod.llmSettingsRev === "function" ? mod.llmSettingsRev() : "";
    const inst = runInsts.get(slotId);
    // a settings save must reach the NEXT turn of an existing tab; never replace
    // an instance that is mid-drive (two loops on one turn)
    if (
      inst &&
      (inst.driving || (inst.base === base && inst.mode === mode && inst.project === project && inst.rev === rev))
    ) {
      return { run: inst.run };
    }
    const run = await createSessionRun({
      base,
      mode: mode || undefined,
      project: project || undefined,
      onEvent: (ev) => window.send("run:event", { slotId, event: ev }),
      // the CPU-awake marker is about the DEVICE, not one tab: any slot busy
      // keeps it, and it goes idle only when the last one returns
      onBusy: (b) => {
        if (b) busySlots.add(slotId);
        else busySlots.delete(slotId);
        writeRunMarker(busySlots.size > 0);
      },
      warn: (msg) => log(`[run] slot ${slotKey(slotId)}: ${msg}`),
    });
    runInsts.set(slotId, { run, base, mode, project, rev, driving: false });
    return { run };
  }

  // ONE wheel per turn, the same refusal the desktop host makes (ui/src/host/
  // main.ts refuseIfDriving): a start/step/drive/run for a slot whose instance is
  // already driving is answered before it can touch the loop. Two drivers of one
  // turn are not stopped by the session's lease — claim_run refuses only a
  // DIFFERENT project (agent/base.py) — and the `finally` of the second entry
  // clears the flag the REAL driver set, so the next state() rebuilds the
  // instance under a live turn and the rebuilt one takes the slot over. The page
  // treats `run_active` as a fact, not a failure (render-events.ts resumeTurn).
  const refuseIfDriving = (inst) =>
    inst && inst.driving
      ? { ok: false, error: "this window is already driving this turn", code: "run_active" }
      : null;

  // the bridge surface: ui/main.js's ipcMain handlers, one for one
  const handlers = {
    clutchApi: {
      baseUrl: async (slotId) => {
        const slot = typeof slotId === "string" ? slotId : "";
        try {
          // null = no session (no tunnel, and no local mode to fall back to):
          // the renderer shows "not running" and waits for backend:base-changed
          const base = (await hostCore.ensureSlotBackend(window, slot)) || null;
          // the claim is also the one moment this session may be told what this
          // client runs — a push, never a gate (announcePlugins)
          announcePlugins(base, slot);
          return base;
        } catch (err) {
          log(`[backend] api:base failed for slot ${slotKey(slot)}: ${err && err.message}`);
          return null;
        }
      },
      slotStatus: async (slotId) => {
        const slot = typeof slotId === "string" ? slotId : "";
        const status = hostCore.slotStatus(window.id, slot);
        return { ...status, running: runInsts.has(slot) };
      },
      // the renderer leaving a session (the conn-lost dialog's Cancel, or one
      // tab closing). A named slot releases only that tab; no slot releases
      // every claim this window holds. The tunnel goes only when nobody is left.
      releaseSession: async (slotId) => {
        if (typeof slotId === "string" && slotId) {
          flushSlot(slotId);
          await hostCore.releaseSlot(window.id, slotId);
        } else {
          flushAllRuns();
          await hostCore.releaseWindowBackends(window.id);
        }
        if (!hostCore.anyTunnelWindow()) {
          // the outage's Cancel: this window was the last one on the hop and the
          // user is done with it, so nothing may redial this host behind them
          ladder.noteUserLeft();
          await tunnel.stopTunnel();
        }
        return { ok: true };
      },
    },
    clutchSettings: {
      save: async (data) => {
        try {
          writeSettingsMirror(data);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      ensure: async (data) => {
        try {
          return ensureSettingsMirror(data, log);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    },
    // the project locks the session HOST can see, and the one action a user is
    // allowed: reclaim a project whose claiming window is PROVEN gone — the same
    // two verbs as the desktop's `locks:*` handlers (ui/main.js). The base comes
    // from THIS window's own claim, so a window working through a tunnel asks the
    // far supervisor, which is the machine that holds the lock. A claim this
    // device made cannot be checked over there (its kernel has never heard of the
    // pid), so the far side records it and waits for the claimant's own machine
    // to speak — this one. Hence the same split as the desktop: the list carries
    // this kernel's verdict per lock, and the reclaim relays it as a witness, so
    // a page cannot talk the host into freeing a live window's project.
    clutchLocks: {
      list: async (slotId) => {
        const base = hostCore.supervisorBaseFor(window.id, typeof slotId === "string" ? slotId : "");
        if (!base) return { error: "this window has no session host" };
        const listed = await sessions.supervisorLocks(base);
        if (!listed || !Array.isArray(listed.locks)) return listed;
        return { locks: listed.locks.map(sessions.annotateClaimLiveness) };
      },
      reclaim: async (project, slotId) => {
        const base = hostCore.supervisorBaseFor(window.id, typeof slotId === "string" ? slotId : "");
        if (!base) return { revoked: false, why: "this window has no session host" };
        const key = String(project || "");
        const listed = await sessions.supervisorLocks(base);
        const witness = sessions.claimWitness(listed && listed.locks, key);
        return sessions.supervisorLockReclaim(base, key, witness);
      },
    },
    clutchTunnel: {
      // every connect goes through the ladder: the user's own act owns the wire
      // (nothing dials behind it) and a connect that WINS is the standing intent
      // the ladder may redial on the next hop loss (ui/tunnel-ladder.js)
      connect: (cfg) =>
        ladder.userConnect(cfg, (stage) => bus.broadcast("tunnel:progress", stage)),
      status: async () => tunnel.tunnelStatus(),
      disconnect: async () => {
        // stop window backends first, while the tunnel/bridge is still alive
        ladder.noteUserLeft(); // the user leaving: the standing intent goes with them
        // the sessions this client served are told below, while the hop is still
        // up, so these DELETEs are a courtesy the far side may never read — not
        // awaited, or one quiet session would hold the disconnect for its own
        // timeout (ui/plugin-link.js)
        pluginLink.stop();
        flushAllRuns();
        await hostCore.releaseAllBackends();
        await tunnel.stopTunnel();
        return { ok: true };
      },
    },
    // the plugin tab, one for one with the desktop's `components:*` ipcMain
    // handlers (ui/main.js:178-211). The bridge route names no window — this app
    // IS one window (N5) — so every verb is asked about THIS window's session,
    // which is what makes "install onto the machine I am working on" resolve to
    // the tunnel's far side.
    clutchComponents: {
      list: async () => componentsView.list(window),
      market: async (opts) => componentsView.market(opts || {}),
      // the reverse verbs, named the way the host names them: `versions` asks what
      // one machine holds, `remove` asks it to let one go (the host may refuse —
      // something is running it — and that arrives as the error inside the answer).
      // Each write carries the PLACE the row it came from was read at, because the
      // page draws both ledgers in one list and a name alone does not say which
      // machine is being asked (ui/components-view.js whereFrom)
      versions: async (name, place) =>
        componentsView.versions(String(name || ""), String(place || ""), window),
      // the three writes go through `redeclare`: a client-domain change is a tool
      // appearing in every session this client serves (ui/plugin-link.js), and the
      // answer is the one place that knows a write happened
      remove: async (name, opts, place) =>
        redeclare(
          await componentsView.remove(String(name || ""), opts || {}, String(place || ""), window)
        ),
      // the switch: the state being ASKED FOR travels, not a verb translated
      setDisabled: async (name, disabled, place) =>
        redeclare(
          await componentsView.setDisabled(
            String(name || ""),
            Boolean(disabled),
            String(place || ""),
            window
          )
        ),
      install: async (name) =>
        redeclare(
          await componentsView.install(String(name || ""), window, {
            // one line at a time to the page that asked, on the channel the shim
            // subscribes to; the window handle fans it out over the bridge's SSE
            progress: (stage) => window.send("components:progress", stage),
          })
        ),
      // the knobs a component declares — the same two verbs the desktop's
      // `components:settings` pair serves, so a page on the bridge is not offered
      // a form whose submit has no route
      settings: async (name, place) =>
        componentsView.settings(String(name || ""), String(place || ""), window),
      setSetting: async (name, values, place) =>
        redeclare(
          await componentsView.setSetting(
            String(name || ""),
            values,
            String(place || ""),
            window
          )
        ),
      // the mirrors a failed fetch is retried through: a read, and the two writes
      // that move the user's half of the list (ui/mirrors.js). Each write answers
      // with the list as it now is, so the page draws what was written.
      mirrors: async () => componentsView.mirrors(),
      addMirror: async (url) => componentsView.addMirror(String(url || "")),
      removeMirror: async (url) => componentsView.removeMirror(String(url || "")),
    },
    // the About pane's update button, one for one with the desktop's `update:*`
    // ipcMain handlers. The version compared against comes from the PAGE: its
    // stamp (ui/version.js) is the number its About row is showing, and nothing on
    // this side knows it (the engine's package carries no version of its own).
    clutchUpdate: {
      check: async (current) => updates.check({ current: String(current || "") }),
      download: async () =>
        updates.download({
          // the bridge fans this out over its SSE stream, which ui/bridge-shim.js
          // turns back into the "update:progress" channel the page subscribed to
          onProgress: (stage) => window.send("update:progress", stage),
        }),
      install: async (file) => updates.install(String(file || "")),
    },
    // the host-side run loop (P1-4), one for one with the desktop's `run:*`
    // ipcMain handlers. The page calls start/drive/stop/step/state; live events
    // go out on the bridge's SSE stream (window.send → bus.broadcast). The
    // instance is rebuilt when the base URL, the mode or the project changes,
    // and `state` builds it too — that is the resume question the page asks
    // when it comes up with a project (P2-3).
    clutchRun: {
      start: async (first, second) => {
        const slotId = typeof first === "string" ? first : "";
        const payload = typeof first === "string" ? second : first;
        try {
          const task = String((payload && payload.task) || "");
          const got = await ensureRun(slotId, payload);
          if (got.error) return { ok: false, error: got.error, code: got.code || null };
          const inst = runInsts.get(slotId);
          const taken = refuseIfDriving(inst);
          if (taken) return taken;
          if (inst) inst.driving = true;
          try {
            await got.run.start(task);
            return { ok: true };
          } finally {
            if (inst) inst.driving = false;
          }
        } catch (err) {
          log(`[run] start failed: ${(err && err.message) || err}`);
          return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
        }
      },
      stop: async (slotId) => {
        const slot = typeof slotId === "string" ? slotId : "";
        const inst = runInsts.get(slot);
        if (!inst) return { ok: true };
        try {
          await stopAndFlush(inst.run);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) };
        }
      },
      step: async (slotId) => {
        const inst = runInsts.get(typeof slotId === "string" ? slotId : "");
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
      },
      drive: async (slotId) => {
        const inst = runInsts.get(typeof slotId === "string" ? slotId : "");
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
      },
      // run is the unified interface: start a new turn if idle, continue an
      // open one if the log has an interrupted turn. This is the ONE entry point
      // for user-initiated actions — when the user types "继续" and presses Run,
      // this handles both the "new task" and "resume" cases transparently.
      run: async (first, second) => {
        const slotId = typeof first === "string" ? first : "";
        const payload = typeof first === "string" ? second : first;
        try {
          const task = String((payload && payload.task) || "");
          const got = await ensureRun(slotId, payload);
          if (got.error) return { ok: false, error: got.error, code: got.code || null };
          const inst = runInsts.get(slotId);
          const taken = refuseIfDriving(inst);
          if (taken) return taken;
          if (inst) inst.driving = true;
          try {
            const result = await got.run.run(task);
            return { ok: true, result };
          } finally {
            if (inst) inst.driving = false;
          }
        } catch (err) {
          log(`[run] run failed: ${(err && err.message) || err}`);
          return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
        }
      },
      // the RESUME question (P2-3): takes the same {mode, project} payload start
      // does, and builds the instance when the page asks before any start —
      // "there is no instance" is not an answer to "is a turn open?".
      state: async (first, second) => {
        const slotId = typeof first === "string" ? first : "";
        const payload = typeof first === "string" ? second || {} : first || {};
        try {
          const got = await ensureRun(slotId, payload);
          if (got.error) return { ok: false, error: got.error, code: got.code || null };
          const result = await got.run.state();
          // `driven` is the half of the answer the fold cannot carry: a turn is
          // open, AND this window already has a wheel on it. The page resumes
          // only what nobody is driving (render-events.ts resumeTurn) — a
          // second drive of one turn is the "a step is already running" the
          // reader saw on every tab switch.
          const inst = runInsts.get(slotId);
          return { ok: true, result, driven: !!(inst && inst.driving) };
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
        }
      },
    },
  };

  // tell every renderer the moment a tunnel dies (drops its stale API URL) — and
  // drop the forwards that URL named first: they died with the tunnel, so a
  // re-claim racing this broadcast must open a fresh one. `lost` is the same
  // per-window answer the desktop shell sends (ui/main.js): here the app IS one
  // window (N5), so it is "was that window's claim one of the hop's?".
  tunnel.onTunnelEnd(async () => {
    const affected = await hostCore.releaseTunnelBackends();
    // the plugin port this hop carried died with it (ui/plugin-link.js hopLost):
    // the listener stays (a reconnect re-uses it) but the far-side port does not
    pluginLink.hopLost();
    // the page hears about it (whenever it is running again) and the ENGINE acts
    // on it: while the app is in the background the renderer is frozen — its
    // redial ladder is parked on purpose (ui/js/conn-lost.js connLostArm) — so
    // this notification alone used to leave the hop dead until the user came
    // back and looked at it
    ladder.hopLost();
    const slots = affected.filter((s) => s.winId === window.id);
    lostSlots = slots;
    bus.broadcast("tunnel:ended", { lost: slots.length > 0, slots });
  });

  async function start() {
    // kill a STALE ready marker BEFORE binding: the Kotlin shell polls this
    // file every 150ms, and a marker left by a previous process life would be
    // read instantly (asset re-copy takes seconds) pointing the WebView at a
    // dead port — the bind can even land on a different port (EADDRINUSE walk
    // below). A failed boot must leave NO marker at all.
    try {
      fs.unlinkSync(path.join(os.homedir(), "bridge.port"));
    } catch (e) {
      /* absent on first boot */
    }
    // the same for the wake marker the foreground service polls: a "up" left by
    // a previous process life would hold this device's CPU awake for a standing
    // intent that does not exist in THIS life (nothing dials before the user does)
    try {
      fs.unlinkSync(path.join(os.homedir(), "tunnel.state"));
    } catch (e) {
      /* absent on first boot */
    }
    // and for the busy marker (P5-2): a "busy" left by a previous process life —
    // killed mid-turn — would keep the CPU awake for a loop that no longer exists
    // in THIS life, and nothing is driving anything before the page asks
    try {
      fs.unlinkSync(path.join(os.homedir(), "run.state"));
    } catch (e) {
      /* absent on first boot */
    }
    const server = await createBridgeServer({ port: bridgePort, handlers, log });
    bus.broadcast = server.broadcast;
    // readiness marker for the Kotlin shell: it polls for this file, then
    // loads the WebView at <assets ui>/index.html?bridge=<server.url>
    try {
      fs.writeFileSync(path.join(os.homedir(), "bridge.port"), String(server.port));
    } catch (e) {
      log(`[bridge] could not write the ready marker: ${(e && e.message) || e}`);
    }
    return server;
  }

  return { handlers, window, hostCore, start };
}

// nodejs-mobile entry (android/host/index.js calls this). The desktop shell
// has the same guards — surface engine errors in the tunnel log, never die
// silently in the background.
function main() {
  // boot forensics: every step lands in $HOME/boot-trace.log with fs sync
  // writes that bypass tunnelLog's swallow-errors contract — a silent death
  // must still leave a trace (the "app dies at tap" bug hunt, M3.5)
  const trace = (m) => {
    try {
      fs.appendFileSync(path.join(os.homedir(), "boot-trace.log"), `[boot] ${m}\n`);
    } catch (e) {
      /* even tracing must not throw */
    }
  };
  trace("main entered, node " + process.version);
  const tunnel = useUI("ssh-tunnel.js");
  trace("ssh-tunnel loaded");
  process.on("uncaughtException", (e) => {
    tunnel.tunnelLog("[fatal] uncaughtException: " + ((e && (e as any).stack) || e));
    trace("uncaughtException: " + ((e && (e as any).stack) || e));
  });
  process.on("unhandledRejection", (e) => {
    tunnel.tunnelLog("[fatal] unhandledRejection: " + ((e && (e as any).stack) || e));
    trace("unhandledRejection: " + ((e && (e as any).stack) || e));
  });
  const host = createAndroidHost({ tunnel });
  trace("host created, starting bridge");
  return host.start().then(
    (server) => {
      trace("bridge listening on " + server.port);
      return server;
    },
    (e) => {
      trace("start() rejected: " + ((e && e.stack) || e));
      throw e;
    },
  );
}

module.exports = { createAndroidHost, main };
