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
  localSrv: null,
  llmProxyPort: null,
  execBridgePort: null,
  sftpHandle: null,
  sftpUnavailable: false, // the current host has no SFTP subsystem: use exec uploads
  currentUrl: null,
  wasDisconnected: true,
  lastStrategy: null,
  lastHome: null,
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
  state,
  tunnelLog,
};
