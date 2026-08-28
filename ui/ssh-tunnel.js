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
//
// Bootstrap: if the remote has no clutch-server yet, the client installs it
// adaptively (VSCode-style):
//   - python3 + internet  -> venv + pip from a source copy (arch-agnostic)
//   - python3, no internet, same arch/minor as client -> portable site-packages
//   - no python3, same arch as client                 -> self-contained binary
//   - otherwise                                       -> needsAssist (client-side
//     LLM-driven installer, remote-install-assist.js)

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
const { getVersion, platformTag, clientPythonMinor, ensureBundle, ensurePyLibsTar } = require("./server-bundle");

const LOG_FILE = path.join(os.homedir(), ".clutch", "tunnel.log");
const REMOTE_API_PORT = 8890;
const LLM_PROXY_REMOTE_PORT = 8892;
const CONNECT_TIMEOUT_MS = 15000;

let sshClient = null;
let localSrv = null;
let llmProxyPort = null;
let sftpHandle = null;
let lastProbe = null;

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

// ---- remote command/file helpers (used by bootstrap and the LLM assist) ----

function remoteExec(command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!sshClient) return reject(new Error("not connected"));
    sshClient.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      };
      const timer = setTimeout(() => {
        stream.close();
        finish(-1);
      }, timeoutMs);
      stream.on("data", (d) => (stdout += d));
      stream.stderr.on("data", (d) => (stderr += d));
      stream.on("close", (code) => finish(code));
      stream.on("error", (e) => {
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  });
}

function getSftp() {
  // one sftp subsystem reused across uploads: opening one per file blows past
  // sshd's MaxSessions and the channel open gets refused
  if (sftpHandle) return Promise.resolve(sftpHandle);
  return new Promise((resolve, reject) => {
    sshClient.sftp((err, sftp) => {
      if (err) return reject(err);
      sftpHandle = sftp;
      resolve(sftp);
    });
  });
}

function uploadFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    getSftp().then(
      (sftp) => sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve())),
      reject
    );
  });
}

// ---- bootstrap ----

const PROBE_CMD = [
  'echo "__OS__"; uname -s',
  'echo "__ARCH__"; uname -m',
  'echo "__HOME__"; echo "$HOME"',
  'echo "__OSREL__"; (grep -E "^(NAME|VERSION)=" /etc/os-release 2>/dev/null || true) | head -2',
  'echo "__PY__"; (command -v python3 >/dev/null && python3 -c "import sys;print(\'%d.%d\'%sys.version_info[:2])") || echo NONE',
  'echo "__VER__"; (cat "$HOME/.clutch-server/VERSION" 2>/dev/null) || echo NONE',
  'echo "__STRATEGY__"; (cat "$HOME/.clutch-server/STRATEGY" 2>/dev/null) || echo NONE',
  'echo "__ART__"; (test -x "$HOME/.clutch-server/agent-server" && echo bundle || true); (test -x "$HOME/.clutch-server/venv/bin/python" && echo pip || true); (test -d "$HOME/.clutch-server/site-packages" && echo pylibs || true)',
  'echo "__NET__"; (python3 -c "import urllib.request;urllib.request.urlopen(\'https://pypi.org\',timeout=3);print(\'OK\')" 2>/dev/null) || echo NO',
  'echo "__TMP__"; (test -w /tmp && echo YES) || echo NO',
].join("; ");

function parseProbe(out) {
  const section = (marker) => {
    const parts = out.split(marker);
    return parts.length > 1 ? parts[1].split("__")[0].trim() : "";
  };
  const arts = out.split("__ART__").pop().split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    os: section("__OS__"),
    arch: section("__ARCH__"),
    home: section("__HOME__"),
    osrel: section("__OSREL__"),
    python: section("__PY__") === "NONE" ? "" : section("__PY__"),
    installedVersion: section("__VER__"),
    installedStrategy: section("__STRATEGY__"),
    artifacts: arts,
    internet: section("__NET__") === "OK",
    tmpWritable: section("__TMP__") === "YES",
  };
}

function startCommand(strategy, home) {
  const base = "--base-url http://127.0.0.1:8892/v1 --port " + REMOTE_API_PORT;
  const nohup = "nohup setsid ";
  if (strategy === "bundle") {
    return `${nohup}${home}/.clutch-server/agent-server ${base} >/tmp/clutch-server.log 2>&1 </dev/null &`;
  }
  if (strategy === "pip") {
    return `${nohup}${home}/.clutch-server/venv/bin/python -m agent.server ${base} >/tmp/clutch-server.log 2>&1 </dev/null &`;
  }
  // pylibs
  return `cd ${home}/.clutch-server && ${nohup}env PYTHONPATH=site-packages python3 -m agent.server ${base} >/tmp/clutch-server.log 2>&1 </dev/null &`;
}

function remoteRunningCmd(probe) {
  if (probe.python) {
    return `python3 -c "import socket;s=socket.socket();s.settimeout(1);s.connect(('127.0.0.1',${REMOTE_API_PORT}));print('UP')" 2>/dev/null || echo DOWN`;
  }
  return `(command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ':${REMOTE_API_PORT} ' && echo UP) || echo DOWN`;
}

// force is for tests; auto-decides when omitted.
async function installServer(probe, { force } = {}) {
  const version = getVersion();
  const sameArch = probe.arch === platformTag().split("-")[1];
  const samePy = probe.python === clientPythonMinor();
  tunnelLog(
    `[bootstrap] probe os=${probe.os} arch=${probe.arch} py=${probe.python || "none"} net=${probe.internet} sameArch=${sameArch} samePy=${samePy}`
  );

  let strategy;
  if (force) {
    strategy = force;
  } else if (process.env.CLUTCH_TUNNEL_FORCE) {
    strategy = process.env.CLUTCH_TUNNEL_FORCE;
  } else if (probe.python) {
    strategy = probe.internet ? "pip" : sameArch && samePy ? "pylibs" : "assist";
  } else {
    strategy = sameArch ? "bundle" : "assist";
  }
  if (strategy === "assist") {
    return {
      needsAssist: true,
      error: `unsupported remote environment (${probe.os}/${probe.arch}, python=${probe.python || "none"})`,
    };
  }
  const installed = probe.installedStrategy === strategy && probe.installedVersion === version && probe.artifacts.includes(strategy);
  tunnelLog(`[bootstrap] strategy=${strategy} installed=${installed}`);

  const home = probe.home || "~";
  const dir = `${home}/.clutch-server`;

  if (!installed) {
    await remoteExec(`mkdir -p ${dir}`);
    if (strategy === "bundle") {
      const artifact = ensureBundle(version);
      tunnelLog(`[bootstrap] uploading bundle ${path.basename(artifact)}`);
      await uploadFile(artifact, `${dir}/agent-server`);
      await remoteExec(`chmod +x ${dir}/agent-server`);
    } else if (strategy === "pylibs") {
      const artifact = ensurePyLibsTar(version);
      tunnelLog(`[bootstrap] uploading pylibs ${path.basename(artifact)}`);
      await uploadFile(artifact, `${dir}/pylibs.tar.gz`);
      await remoteExec(
        `python3 -c "import tarfile;tarfile.open('${dir}/pylibs.tar.gz').extractall('${dir}')" && rm -f ${dir}/pylibs.tar.gz`
      );
    } else {
      // pip: upload the source tree + pyproject, build a venv, pip install (needs internet)
      tunnelLog("[bootstrap] pip strategy: uploading source, installing into a venv");
      await remoteExec(`mkdir -p ${dir}/src`);
      await uploadDir(path.join(__dirname, "..", "agent"), `${dir}/src/agent`);
      await uploadFile(path.join(__dirname, "..", "pyproject.toml"), `${dir}/src/pyproject.toml`);
      const pi = await remoteExec(
        `cd ${dir} && python3 -m venv venv && venv/bin/pip install --quiet src 2>&1 | tail -3`,
        300000
      );
      if (pi.code !== 0) {
        const detail = (pi.stderr || pi.stdout || "exec timed out").trim().slice(0, 400);
        tunnelLog(`[bootstrap] pip install failed (exit ${pi.code}): ${detail}`);
        return { needsAssist: true, error: `remote pip install failed: ${detail}` };
      }
    }
    await remoteExec(`echo ${version} > ${dir}/VERSION && echo ${strategy} > ${dir}/STRATEGY`);
    tunnelLog("[bootstrap] installed");
  }

  // ensure it is running
  const run = await remoteExec(remoteRunningCmd(probe));
  if (!run.stdout.includes("UP")) {
    tunnelLog("[bootstrap] starting server");
    await remoteExec(startCommand(strategy, home));
    // give it a moment to bind
    for (let i = 0; i < 10; i++) {
      const chk = await remoteExec(remoteRunningCmd(probe));
      if (chk.stdout.includes("UP")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    tunnelLog("[bootstrap] server already running");
  }
  return { installed: true, strategy };
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
  if (sftpHandle) {
    sftpHandle = null;
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

    // runtime handlers (registered once per connection)
    sshClient.on("tcp connection", (info, accept, reject) => {
      if (info.destPort !== LLM_PROXY_REMOTE_PORT) {
        reject();
        return;
      }
      const stream = accept();
      const proxy = net.connect(llmProxyPort, "127.0.0.1");
      stream.pipe(proxy).pipe(stream);
    });
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

    // bootstrap: make sure the server exists and is running on the remote
    const probeOut = await remoteExec(PROBE_CMD);
    const probe = parseProbe(probeOut.stdout);
    const boot = await installServer(probe);
    if (boot.needsAssist) {
      // keep the connection open for the LLM-guided installer; stage the source
      tunnelLog("[bootstrap] needsAssist: " + boot.error);
      await stageSource(probe);
      lastProbe = probe;
      return { ok: false, needsAssist: true, error: boot.error };
    }

    return await establishForwardAndHealth(localPort);
  } catch (e) {
    const raw = (e && e.message) || String(e);
    tunnelLog(`[error] connect failed: ${raw} -> ${friendlyError(e)}`);
    stopTunnel();
    return { ok: false, error: friendlyError(e) };
  }
}

// Stage the agent source on the remote so the LLM installer can venv+pip it.
async function stageSource(probe) {
  const dir = `${probe.home || "~"}/.clutch-server/staged/src`;
  await remoteExec(`mkdir -p ${dir}`);
  await uploadDir(path.join(__dirname, "..", "agent"), `${dir}/agent`);
  await uploadFile(path.join(__dirname, "..", "pyproject.toml"), `${dir}/pyproject.toml`);
  tunnelLog("[assist] source staged at " + dir);
}

// Set up the bidirectional forwards and gate on the health check through the tunnel.
async function establishForwardAndHealth(localPort) {
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
  sshClient.forwardIn("127.0.0.1", LLM_PROXY_REMOTE_PORT, (err) => {
    if (err) {
      tunnelLog("[phase] reverse forward failed: " + err.message);
      console.error("[tunnel] reverse forward failed:", err.message);
    } else {
      tunnelLog(`[phase] reverse forward requested 127.0.0.1:${LLM_PROXY_REMOTE_PORT} -> client proxy :${llmProxyPort}`);
    }
  });
  const up = await waitForServer("http://127.0.0.1:" + localPort + "/api/health", CONNECT_TIMEOUT_MS);
  if (!up) {
    tunnelLog("[health] FAIL: backend not reachable on the remote host");
    stopTunnel();
    return { ok: false, error: "backend not reachable on the remote host" };
  }
  tunnelLog(`[connect] OK url=http://127.0.0.1:${localPort}`);
  return { ok: true, url: "http://127.0.0.1:" + localPort };
}

// LLM-guided install (remote-install-assist.js) on the still-open connection.
async function runAssist() {
  if (!sshClient || !lastProbe) return { ok: false, error: "no pending assist session" };
  const { runInstallAssist } = require("./remote-install-assist");
  tunnelLog("[assist] starting LLM-guided install");
  const r = await runInstallAssist({
    remoteExec,
    llmUrl: "http://127.0.0.1:" + llmProxyPort + "/v1",
    probe: lastProbe,
  });
  tunnelLog(`[assist] result ok=${r.ok}${r.error ? " " + r.error : ""}`);
  if (!r.ok) return r;
  try {
    lastProbe = null;
    const localPort = await freePort();
    return await establishForwardAndHealth(localPort);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Upload a local directory tree over SFTP (used for the pip strategy's source).
async function uploadDir(localDir, remoteDir) {
  await remoteExec(`mkdir -p ${remoteDir}`);
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const ent of entries) {
    const lp = path.join(localDir, ent.name);
    const rp = remoteDir + "/" + ent.name;
    if (ent.isDirectory()) {
      if (ent.name === "__pycache__") continue;
      await uploadDir(lp, rp);
    } else {
      await uploadFile(lp, rp);
    }
  }
}

module.exports = { connectTunnel, stopTunnel, remoteExec, runAssist, tunnelLog };
