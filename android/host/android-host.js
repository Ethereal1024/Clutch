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
const { writeSettingsMirror, ensureSettingsMirror, readSettings } = useUI("settings-mirror.js");

// failure placeholder only; a healthy session overrides it with the forwarded
// session URL (same constant as ui/main.js — the machine-wide supervisor port,
// ui/server-bootstrap.js SUPERVISOR_PORT)
const DEFAULT_API_BASE = "http://127.0.0.1:8890";
// remote sessions: LLM via the tunnel's reverse forward (matches
// LLM_PROXY_REMOTE_PORT in ui/ssh-tunnel.js)
const REMOTE_LLM_BASE = "http://127.0.0.1:8892/v1";

function createAndroidHost({ tunnel, sessions, log, bridgePort = 8899 } = {}) {
  tunnel = tunnel || useUI("ssh-tunnel.js");
  sessions = sessions || useUI("supervisor-client.js");
  log = log || tunnel.tunnelLog;

  // N3: register the artifact provider BEFORE any tunnel strategy decision —
  // the desktop default would otherwise try to run bash/uv on the phone
  useUI("server-bundle.js").setArtifactProvider(createAndroidArtifactProvider());

  const hostCore = createHostCore({
    supervisorBase: () => null, // N4: no local supervisor on Android
    remoteLlmBase: () => REMOTE_LLM_BASE,
    // same reason as ui/main.js: the remote session cannot read this device's settings
    remoteLlmModel: () => readSettings().model || "",
    remoteLlmKnobs: () => {
      const s = readSettings();
      return { reasoning_effort: s.reasoning_effort || "", api_protocol: s.api_protocol || "" };
    },
    tunnelStatus: () => tunnel.tunnelStatus(),
    restartRemoteServer: () => tunnel.restartRemoteServer(),
    openSessionForward: (port) => tunnel.openSessionForward(port),
    startLocalSession: null, // N4: no local mode; the renderer shows "not running"
    log,
    sessions,
  });

  // N5's minimal window mapping: the whole app is ONE window. host-core sends
  // backend:base-changed through this handle; the bridge fans it out over SSE.
  const bus = { broadcast: () => {} };
  const window = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => bus.broadcast(channel, payload),
  };

  // the bridge surface: ui/main.js's ipcMain handlers, one for one
  const handlers = {
    clutchApi: {
      baseUrl: async () => {
        try {
          const url = await hostCore.ensureWindowBackend(window);
          return url || DEFAULT_API_BASE;
        } catch (err) {
          log(`[backend] api:base failed: ${err && err.message}`);
          return DEFAULT_API_BASE;
        }
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
    clutchTunnel: {
      connect: (cfg) => tunnel.connectTunnel(cfg, (stage) => bus.broadcast("tunnel:progress", stage)),
      status: async () => tunnel.tunnelStatus(),
      disconnect: async () => {
        // stop window backends first, while the tunnel/bridge is still alive
        await hostCore.releaseAllBackends();
        await tunnel.stopTunnel();
        return { ok: true };
      },
    },
  };

  // tell every renderer the moment a tunnel dies (drops its stale API URL)
  tunnel.onTunnelEnd(() => bus.broadcast("tunnel:ended"));

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
    tunnel.tunnelLog("[fatal] uncaughtException: " + ((e && e.stack) || e));
    trace("uncaughtException: " + ((e && e.stack) || e));
  });
  process.on("unhandledRejection", (e) => {
    tunnel.tunnelLog("[fatal] unhandledRejection: " + ((e && e.stack) || e));
    trace("unhandledRejection: " + ((e && e.stack) || e));
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

module.exports = { createAndroidHost, main, DEFAULT_API_BASE };
