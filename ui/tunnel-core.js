// the tunnel's shared singleton — the state every phase works on, its wire
// constants, and the log they all write to
//
// The tunnel is one connection with one lifetime, and five modules work on it
// (net, remote, bootstrap, lifecycle, connect). This file is the sixth and the
// only one that declares mutable state: a phase that must remember something
// across calls puts the field here, so the question "who owns this" has
// exactly one answer, and a fresh module graph gets a fresh tunnel. The ports
// and timeouts are the wire contract with the remote host; tunnelLog appends to
// ~/.clutch/tunnel.log, which holds whatever the caller passed in — including
// an SSH password in plaintext (see the module header of ssh-tunnel.js).

const os = require("os");
const path = require("path");
const fs = require("fs");

// ---- the state ----
// One object, not thirteen module-level lets: the field a function assigns is
// visible to every other module on the next call, with no export to keep in step.
const state = {
  sshClient: null,
  // The host THIS hop belongs to: { host, user, port }, or null with no hop.
  // One tunnel carries one host, and connectTunnel may only ever hand it back
  // for that host — a request for another one is a MOVE and has to dial its own
  // wire (see the reuse gate in tunnel-connect). Keeping the target here (and
  // not in the renderer) is what lets the engine ladder, the page's redial and
  // a picker switch share the one answer.
  target: null,
  localSrv: null,
  llmProxyPort: null,
  // The far-side port this process's model path lives on — null until the
  // reverse forward is installed, and kept for the life of the process after
  // that (see remoteLlmPort). A fresh module graph starts it at null again.
  llmProxyRemotePort: null,
  // Where the far side's model path is: null with no hop, "installing" while the
  // reverse forward is being asked for, "listening" once it really is installed,
  // "unavailable" when the far side would not forward (or never answered). It is
  // tracked separately from the hop because the hop no longer waits for it
  // (tunnel-connect's startModelPath): the connect is the thing a user stares at,
  // and a far side that never answers a global request must not be able to hold
  // it open. The one place that DOES wait is the session claim (host-core), which
  // reads this to avoid pointing a session's --base-url at a port nobody serves.
  modelPath: null,
  modelPathClient: null, // the client this modelPath/modelPathInstall belongs to
  modelPathInstall: null, // the one in-flight install every asker joins
  modelPathRepairTimer: null,
  modelPathRepairDelay: null, // grows from MODEL_PATH_REPAIR_MS to its cap
  execBridgePort: null,
  sftpHandle: null,
  sftpUnavailable: false, // the current host has no SFTP subsystem: use exec uploads
  currentUrl: null,
  wasDisconnected: true,
  lastStrategy: null,
  lastHome: null,
  lastProbe: null, // the target's last probe: what a restart has to match
  healTimer: null,
  sessionForwards: new Set(),
  endListeners: new Set(),
};

// ---- the wire contract ----
const LOG_FILE = path.join(os.homedir(), ".clutch", "tunnel.log");
const REMOTE_API_PORT = 8890;
const LLM_PROXY_REMOTE_PORT = 8892;
const CONNECT_TIMEOUT_MS = 15000;
const HEAL_INTERVAL_MS = 15000;

// Where the far side's model requests arrive. 8892 is the contract — it is what
// a remote session's --base-url is built from, so it is always tried first — but
// the port belongs to the FAR host, and a listener an earlier hop left behind
// (a hop whose client is gone but whose sshd session has not noticed yet) holds
// it, refuses our bind and never lets go. That is not a reason to lose a whole
// connection, so the reverse forward falls back to a port the far side picks for
// itself (installReverseForward) and this process remembers it: every later hop
// re-binds THAT port, and every session this process starts is told to use it,
// so the far side's model path stays where its --base-url points.
//
// The limit of that: a session is told its base ONCE, at spawn (agent/supervisor.py
// --base-url, no re-point API), so a session already running under the old port
// talks into nothing until the far side reaps it (supervise.py STALE_S). That is
// the cost of moving the model path, and it is paid only when the port really
// cannot be had — never as a preference.
function remoteLlmPort() {
  return state.llmProxyRemotePort || LLM_PROXY_REMOTE_PORT;
}

// The LLM base a remote session is spawned with. It must be read at SPAWN time
// (host-core calls it per session), because the port is only known once the
// reverse forward has been installed.
function remoteLlmBase() {
  return `http://127.0.0.1:${remoteLlmPort()}/v1`;
}

function tunnelLog(...args) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "", { mode: 0o600 });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(" ")}\n`, "utf-8");
  } catch (e) {
    /* logging must never break the tunnel */
  }
}

module.exports = {
  REMOTE_API_PORT,
  LLM_PROXY_REMOTE_PORT,
  CONNECT_TIMEOUT_MS,
  HEAL_INTERVAL_MS,
  remoteLlmPort,
  remoteLlmBase,
  state,
  tunnelLog,
};
