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

// ---- the reverse channels ----
//
// Everything the far side may open a connection INTO this machine for is one row
// here: the port it asks sshd to listen on, and the loopback listener on THIS
// machine that answers it. The accept handler (tunnel-connect's "tcp
// connection") routes by destPort through this table, so a second channel is a
// row plus the module that starts its listener — the tunnel itself never learns
// another special case, and a port nobody asked for is refused instead of
// dialled blind.
//
// `remote` is where the far side actually listens: null until an install has
// landed (tunnel-connect's installReverseForward writes it), and `preferred` —
// the contract port — while it is still in flight. That fallback is not a
// guess: a remote session's --base-url is built from the contract port before
// anything has been asked, so a connection naming it is meant for this row.
const channels = new Map();

// preferred is optional on purpose: a channel that only ever lives on a port the
// far side picks has no contract port, and null says so.
function registerChannel(name, { preferred, local, remote, setRemote, what }) {
  if (typeof name !== "string" || !name) throw new Error("a reverse channel needs a name");
  if (typeof local !== "function") throw new Error(`reverse channel "${name}" has no local listener to route to`);
  // Where the granted port is remembered: the row's own field, unless the caller
  // brings its own getter/setter pair (the model path's lives in state, because
  // the rest of the tunnel — the session claim, the teardown — reads it by name).
  // Half a pair is a channel that can read where it listens and never write it,
  // which cannot be what anyone meant.
  const hasRemote = typeof remote === "function";
  const hasSetRemote = typeof setRemote === "function";
  if (hasRemote !== hasSetRemote) {
    throw new Error(`reverse channel "${name}" must give both remote() and setRemote(), or neither`);
  }
  const port = Number(preferred);
  const own = { port: null };
  const row = {
    name,
    preferred: Number.isFinite(port) && port > 0 ? port : null,
    local,
    remote: hasRemote ? remote : () => own.port,
    setRemote: hasSetRemote ? setRemote : (granted) => {
      own.port = granted;
    },
    // what the far side is reaching, for the one log line each install writes:
    // "listening 127.0.0.1:8892 -> client proxy :54123" reads better than a name
    what: what || name,
  };
  channels.set(name, row);
  return row;
}

function channel(name) {
  return channels.get(name) || null;
}

// The row a connection naming `port` belongs to, or null for a port this process
// never asked the far side for. Order matters and is deliberate: a port some row
// HAS been granted wins over one another row merely prefers, so a hop that moved
// its model path does not answer on the contract port any more — that listener
// belongs to a session that is gone, and answering it would be answering as
// somebody else.
function channelFor(port) {
  const n = Number(port);
  if (!Number.isFinite(n)) return null;
  for (const row of channels.values()) {
    const granted = row.remote();
    if (granted != null && Number(granted) === n) return row;
  }
  for (const row of channels.values()) {
    if (row.remote() == null && row.preferred === n) return row;
  }
  return null;
}

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
//
// The model path is the first reverse channel (the rows are declared below, once
// the constants are), and this is its port: the one it was granted if an install
// has landed, the contract port otherwise.
function remoteLlmPort() {
  const model = channel("model");
  return (model && model.remote()) || LLM_PROXY_REMOTE_PORT;
}

// The LLM base a remote session is spawned with. It must be read at SPAWN time
// (host-core calls it per session), because the port is only known once the
// reverse forward has been installed.
function remoteLlmBase() {
  return `http://127.0.0.1:${remoteLlmPort()}/v1`;
}

// The base this client is actually SERVING on the far side right now, or null
// when it is serving nothing.
//
// "listening" is the only state in which the remembered port names a listener a
// far-side session can reach. While an install is in flight (a new hop:
// "installing") the remembered port belongs to the hop that died with it, and a
// path that never landed ("unavailable") names a port nobody serves — pointing a
// LIVE session at either is strictly worse than leaving it where it is, so a
// heartbeat that asks this gets null and the beat stays a plain liveness beat.
// The session claim asks the same question before spawn (host-core, awaitModelPath).
function servedLlmBase() {
  return state.modelPath === "listening" ? remoteLlmBase() : null;
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

// ---- the channels this process serves ----
//
// The model path, declared with the rest of the wire contract: a remote session's
// --base-url points here, so the port is the contract first and whatever the far
// side granted after that (installReverseForward). state.llmProxyRemotePort stays
// the field it is remembered in, so a fresh module graph forgets it with the rest
// of the tunnel.
//
// The frontend plugin endpoint (the channel the far side calls a component that
// runs HERE through) is the second row, and it is deliberately absent: there is
// no listener behind it yet, so a row would route a connection into nothing.
// It registers itself when its listener is started — one registerChannel call,
// and the accept handler routes it with no change here or in tunnel-connect.
registerChannel("model", {
  preferred: LLM_PROXY_REMOTE_PORT,
  local: () => state.llmProxyPort,
  remote: () => state.llmProxyRemotePort,
  setRemote: (port) => {
    state.llmProxyRemotePort = port;
  },
  what: "client proxy",
});

module.exports = {
  REMOTE_API_PORT,
  LLM_PROXY_REMOTE_PORT,
  CONNECT_TIMEOUT_MS,
  HEAL_INTERVAL_MS,
  channels,
  registerChannel,
  channel,
  channelFor,
  remoteLlmPort,
  remoteLlmBase,
  servedLlmBase,
  state,
  tunnelLog,
};
