// Programmatic SSH tunnel (ssh2) to a remote clutch-server, embedded in the
// Electron main process.
//
// Bidirectional:
//   - local forward: 127.0.0.1:<localPort> -> remote 127.0.0.1:8890 (the API)
//   - reverse forward: remote 127.0.0.1:<LLM_PROXY_REMOTE_PORT> -> the client-side
//     LLM proxy (llm-proxy.js), so the remote backend needs no internet and no key.
//
// Auth is in-app: password (also used as an encrypted-key passphrase), SSH agent,
// or a default private key (~/.ssh/id_*). No terminal prompt is involved.

// ---- debug logging (dev-only; remove before shipping) ----
// Every connect attempt (host/user/port/password), the ssh2 protocol trace, phase
// transitions and errors are appended to ~/.clutch/tunnel.log so a failed
// connection can be reproduced. NOTE: the password is written in plaintext.

const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { Client } = require("ssh2");
const { startLlmProxy, stopLlmProxy } = require("./llm-proxy");

const LOG_FILE = path.join(os.homedir(), ".clutch", "tunnel.log");

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

const REMOTE_API_PORT = 8890;
const LLM_PROXY_REMOTE_PORT = 8892;
const CONNECT_TIMEOUT_MS = 15000;

let sshClient = null;
let localSrv = null;
let llmProxyPort = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function listen(srv, port) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      srv.removeListener("error", reject);
      resolve();
    });
  });
}

function waitForServer(url, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 500);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

function defaultKey() {
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const p = path.join(os.homedir(), ".ssh", name);
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p);
    } catch (e) {
      /* keep trying */
    }
  }
  return undefined;
}

function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (m.includes("All configured authentication methods failed")) {
    return "authentication failed (wrong password or no matching SSH key)";
  }
  if (m.includes("Timed out while waiting for handshake")) {
    return "SSH handshake timed out";
  }
  if (m.includes("ECONNREFUSED") || m.includes("ENETUNREACH")) {
    return "cannot reach the SSH host";
  }
  return m;
}

async function stopTunnel() {
  tunnelLog("[disconnect] stopTunnel");
  if (localSrv) {
    localSrv.close();
    localSrv = null;
  }
  if (sshClient) {
    sshClient.end();
    sshClient = null;
  }
  stopLlmProxy();
}

async function connectTunnel({ host, user, port, password }) {
  if (sshClient) {
    tunnelLog("[connect] skipped: already connected");
    return { ok: false, error: "already connected" };
  }
  tunnelLog(
    `[connect] attempt host=${host} user=${user} port=${port || 22} password=${JSON.stringify(password || "")}`
  );
  try {
    const localPort = await freePort();
    llmProxyPort = await startLlmProxy();

    const opts = {
      host,
      port: port || 22,
      username: user,
      tryKeyboard: true,
      readyTimeout: CONNECT_TIMEOUT_MS,
      agent: process.env.SSH_AUTH_SOCK,
      debug: (m) => tunnelLog("ssh2: " + m),
    };
    // the same value covers both password auth and an encrypted-key passphrase
    if (password) {
      opts.password = password;
      opts.passphrase = password;
    }
    const key = defaultKey();
    if (key) opts.privateKey = key;

    await new Promise((resolve, reject) => {
      const client = new Client();
      sshClient = client;
      client.on("ready", resolve);
      client.on("error", reject);
      client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish(password ? [password] : []));
      client.connect(opts);
    });
    tunnelLog("[phase] ssh ready");

    // local forward: 127.0.0.1:<localPort> -> remote 127.0.0.1:8890 (the API)
    localSrv = net.createServer((sock) => {
      sshClient.forwardOut("127.0.0.1", 0, "127.0.0.1", REMOTE_API_PORT, (err, stream) => {
        if (err) {
          tunnelLog("[error] forwardOut failed: " + (err && err.message));
          sock.destroy();
          return;
        }
        sock.pipe(stream).pipe(sock);
      });
    });
    await listen(localSrv, localPort);
    tunnelLog(`[phase] local forward listening 127.0.0.1:${localPort} -> remote 127.0.0.1:${REMOTE_API_PORT}`);

    // reverse forward: remote 127.0.0.1:<LLM_PROXY_REMOTE_PORT> -> client LLM proxy
    sshClient.forwardIn("127.0.0.1", LLM_PROXY_REMOTE_PORT, (err) => {
      if (err) {
        tunnelLog("[phase] reverse forward failed: " + err.message);
        console.error("[tunnel] reverse forward failed:", err.message);
      } else {
        tunnelLog(`[phase] reverse forward requested 127.0.0.1:${LLM_PROXY_REMOTE_PORT} -> client proxy :${llmProxyPort}`);
      }
    });
    sshClient.on("tcp connection", (info, accept, reject) => {
      if (info.destPort !== LLM_PROXY_REMOTE_PORT) {
        reject();
        return;
      }
      const stream = accept();
      const proxy = net.connect(llmProxyPort, "127.0.0.1");
      stream.pipe(proxy).pipe(stream);
    });
    // runtime cleanup if the tunnel drops
    sshClient.on("end", () => {
      tunnelLog("[disconnect] tunnel ended");
      sshClient = null;
      if (localSrv) {
        localSrv.close();
        localSrv = null;
      }
      stopLlmProxy();
    });
    sshClient.on("error", (e) => {
      tunnelLog("[error] runtime: " + e.message);
      console.error("[tunnel]", e.message);
    });

    const up = await waitForServer("http://127.0.0.1:" + localPort + "/api/health", CONNECT_TIMEOUT_MS);
    if (!up) {
      tunnelLog("[health] FAIL: backend not reachable on the remote host");
      stopTunnel();
      return { ok: false, error: "backend not reachable on the remote host" };
    }
    tunnelLog(`[connect] OK url=http://127.0.0.1:${localPort}`);
    return { ok: true, url: "http://127.0.0.1:" + localPort };
  } catch (e) {
    const raw = (e && e.message) || String(e);
    tunnelLog(`[error] connect failed: ${raw} -> ${friendlyError(e)}`);
    stopTunnel();
    return { ok: false, error: friendlyError(e) };
  }
}

module.exports = { connectTunnel, stopTunnel };
