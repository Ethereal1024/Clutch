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

const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { Client } = require("ssh2");
const { startLlmProxy, stopLlmProxy } = require("./llm-proxy");

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
  if (sshClient) return { ok: false, error: "already connected" };
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

    // local forward: 127.0.0.1:<localPort> -> remote 127.0.0.1:8890 (the API)
    localSrv = net.createServer((sock) => {
      sshClient.forwardOut("127.0.0.1", 0, "127.0.0.1", REMOTE_API_PORT, (err, stream) => {
        if (err) {
          sock.destroy();
          return;
        }
        sock.pipe(stream).pipe(sock);
      });
    });
    await listen(localSrv, localPort);

    // reverse forward: remote 127.0.0.1:<LLM_PROXY_REMOTE_PORT> -> client LLM proxy
    sshClient.forwardIn("127.0.0.1", LLM_PROXY_REMOTE_PORT, (err) => {
      if (err) console.error("[tunnel] reverse forward failed:", err.message);
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
      sshClient = null;
      if (localSrv) {
        localSrv.close();
        localSrv = null;
      }
      stopLlmProxy();
    });
    sshClient.on("error", (e) => console.error("[tunnel]", e.message));

    const up = await waitForServer("http://127.0.0.1:" + localPort + "/api/health", CONNECT_TIMEOUT_MS);
    if (!up) {
      stopTunnel();
      return { ok: false, error: "backend not reachable on the remote host" };
    }
    return { ok: true, url: "http://127.0.0.1:" + localPort };
  } catch (e) {
    stopTunnel();
    return { ok: false, error: friendlyError(e) };
  }
}

module.exports = { connectTunnel, stopTunnel };
