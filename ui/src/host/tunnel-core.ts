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

// ---- the state factory ----
// Create an independent tunnel state object. Multiple tunnels (to different hosts)
// each have their own state. The global `state` below is created once for
// backward compatibility with existing code.
function createTunnelState() {
  return {
    sshClient: null,
    // The host THIS hop belongs to: { host, user, port }, or null with no hop.
    // One tunnel carries one host, and connectTunnel may only ever hand it back
    // for that host — a request for another one is a MOVE and has to dial its own
    // wire (see the reuse gate in tunnel-connect). Keeping the target here (and
    // not in the renderer) is what lets the engine ladder, the page's redial and
    // a picker switch share the one answer.
    target: null,
    localSrv: null,
    execBridgePort: null,
    sftpHandle: null,
    sftpUnavailable: false, // the current host has no SFTP subsystem: use exec uploads
    currentUrl: null,
    wasDisconnected: true,
    lastStrategy: null,
    lastHome: null,
    lastProbe: null, // the target's last probe: what a restart has to match
    healTimer: null,
    // The heal round asking RIGHT NOW — the round's own object, or null. A round
    // is several questions over a wire that is already suspect (a patient poll,
    // an exec about the far side's own port), so it routinely outlives the 15 s
    // interval and the timer ticks into a round that has not answered yet. Two
    // rounds in flight both find the forward bad, both rebound it, and the second
    // teardown lands on a window whose streams were fine: that is the field's
    // "Connection lost" over a link that never died. The field holds the
    // IDENTITY of the round (not a boolean) so a round from a hop that is already
    // gone can neither block the next hop's healing nor clear another round's
    // title.
    healing: null as any,
    // How the CURRENT hop's wire died BY ITSELF ("lost the socket", "closed"),
    // null while it lives and reset at the start of every dial. It exists so a
    // connect that was still building when the far side cut the link can say
    // that, instead of borrowing the verdict for a tunnel the USER stopped:
    // both leave the client null, and they are not the same event.
    wireLost: null,
    sessionForwards: new Set(),
    endListeners: new Set(),
  };
}

// ---- the global state (backward compatibility) ----
// One object, not thirteen module-level lets: the field a function assigns is
// visible to every other module on the next call, with no export to keep in step.
const state = createTunnelState();

// ---- multi-tunnel registry ----
// Maps tunnelId (e.g., "host:user:port") to its state object.
// The default/primary tunnel is keyed as "__primary__".
const tunnelRegistry = new Map();
tunnelRegistry.set("__primary__", state);

// ---- the wire contract ----
const LOG_FILE = path.join(os.homedir(), ".clutch", "tunnel.log");
const REMOTE_API_PORT = 8890;
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
// the contract port, when a row has one — while it is still in flight.
const channels = new Map();

// preferred is optional on purpose: a channel that only ever lives on a port the
// far side picks has no contract port, and null says so.
function registerChannel(name, { preferred, local, remote, setRemote, what }) {
  if (typeof name !== "string" || !name) throw new Error("a reverse channel needs a name");
  if (typeof local !== "function") throw new Error(`reverse channel "${name}" has no local listener to route to`);
  // Where the granted port is remembered: the row's own field, unless the caller
  // brings its own getter/setter pair. Half a pair is a channel that can read
  // where it listens and never write it, which cannot be what anyone meant.
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
    // "listening 127.0.0.1:<port> -> plugin endpoint :<port>" reads better than
    // a name
    what: what || name,
  };
  channels.set(name, row);
  return row;
}

// The row a connection naming `port` belongs to, or null for a port this process
// never asked the far side for. Order matters and is deliberate: a port some row
// HAS been granted wins over one another row merely prefers, so a channel that
// moved does not answer on its contract port any more — that listener belongs to
// a session that is gone, and answering it would be answering as somebody else.
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

// ---- the log is bounded ------------------------------------------------------
//
// tunnelLog writes every ssh2 debug line of every attempt, unconditionally
// (tunnel-connect.ts), and nothing ever rotated the file: one install's log
// reached 258 MB. It stays this verbose — that is what makes a tunnel failure
// diagnosable — but a runaway file fills a disk and makes every append slower, so
// the file rolls at LOG_CAP into ONE older file, and that older file keeps only
// its tail (the newest lines are the ones that explain the failure). 32 MB is the
// ceiling for the whole archive, whatever the log rate.
const LOG_CAP = 16 * 1024 * 1024;
let logBytes = -1; // -1 = not measured in this process yet

function logSize(): number {
  try {
    return fs.statSync(LOG_FILE).size;
  } catch (e) {
    return 0;
  }
}

// Keep the last `cap` bytes of a file. Reads only that window, so an oversized
// file left by an older build never has to be loaded whole.
function trimTail(file: string, cap: number) {
  const size = fs.statSync(file).size;
  if (size <= cap) return;
  const buf = Buffer.alloc(cap);
  const fd = fs.openSync(file, "r");
  let got = 0;
  try {
    while (got < cap) {
      const n = fs.readSync(fd, buf, got, cap - got, size - cap + got);
      if (!n) break;
      got += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(file, buf.subarray(0, got), { mode: 0o600 });
}

// tunnel.log -> tunnel.log.1, replacing the previous archive.
function rollLog() {
  const prev = LOG_FILE + ".1";
  try {
    fs.rmSync(prev, { force: true });
  } catch (e) {
    /* nothing to drop */
  }
  try {
    fs.renameSync(LOG_FILE, prev);
  } catch (e) {
    return; // could not move it: the current file stays, and stays bounded by the caller
  }
  try {
    trimTail(prev, LOG_CAP);
  } catch (e) {
    /* a log too big to trim is still not the tunnel's problem */
  }
}

// The log is created 0600, never by the first append: it holds whatever the
// caller passed in, and that includes an SSH password in plaintext.
function ensureLog() {
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "", { mode: 0o600 });
}

function tunnelLog(...args) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    ensureLog();
    if (logBytes < 0) {
      // the first line of this process measures the file: a log an older build
      // left huge is rolled ONCE here instead of growing forever
      logBytes = logSize();
      if (logBytes > LOG_CAP) {
        rollLog();
        logBytes = 0;
        ensureLog(); // the roll took the file away; this keeps it 0600
      }
    }
    const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
    fs.appendFileSync(LOG_FILE, line, "utf-8");
    logBytes += Buffer.byteLength(line);
    if (logBytes > LOG_CAP) {
      rollLog();
      logBytes = 0;
    }
  } catch (e) {
    /* logging must never break the tunnel */
  }
}

// ---- the channels this process serves ----
//
// The frontend plugin endpoint (the channel the far side calls a component that
// runs HERE through) is the only row, and it is registered by the module that
// owns its listener (plugin-link, one registerChannel call at the moment the
// listener starts) — the accept handler routes it with no change here or in
// tunnel-connect. There is no model row: the run's model calls happen on this
// machine (ui/llm-client), so no far-side session reaches a model through the
// tunnel.

module.exports = {
  REMOTE_API_PORT,
  CONNECT_TIMEOUT_MS,
  HEAL_INTERVAL_MS,
  channels,
  registerChannel,
  channelFor,
  state,
  tunnelLog,
};
