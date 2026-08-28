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
const { startExecBridge, stopExecBridge } = require("./exec-bridge");
const { getVersion, platformTag, ensureBundle, ensurePyLibsTar } = require("./server-bundle");

const LOG_FILE = path.join(os.homedir(), ".clutch", "tunnel.log");
const REMOTE_API_PORT = 8890;
const LLM_PROXY_REMOTE_PORT = 8892;
const CONNECT_TIMEOUT_MS = 15000;

let sshClient = null;
let localSrv = null;
let llmProxyPort = null;
let execBridgePort = null;
let sftpHandle = null;
let sftpUnavailable = false; // the current host has no SFTP subsystem: use exec uploads
let lastProbe = null;
let currentUrl = null;
let wasDisconnected = true;
let lastStrategy = null;
let lastHome = null;
let healTimer = null;
const endListeners = new Set();

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
  if (m.includes("Unable to exec")) {
    return "remote shell failed to run a command — the connection dropped or the device's SSH channel limit was hit";
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
  if (sftpUnavailable) return Promise.reject(new Error("SFTP unavailable on this host"));
  if (sftpHandle) return Promise.resolve(sftpHandle);
  return new Promise((resolve, reject) => {
    sshClient.sftp((err, sftp) => {
      if (err) {
        sftpUnavailable = true; // don't reopen a doomed subsystem for every file
        return reject(err);
      }
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
  }).catch(() => uploadFileViaExec(localPath, remotePath)); // no SFTP subsystem? exec it
}

function checkExec(r) {
  if (r.code !== 0) {
    throw new Error(`remote upload failed (exit ${r.code}): ${(r.stderr || r.stdout || "").slice(0, 300).trim()}`);
  }
}

// A minimal sshd (dropbear/BusyBox on OpenWrt) drops the connection on a single
// exec request over ~8KB (measured on the test router: 7,929B ok / 9,636B died).
// Every upload exec command stays well under that.
const EXEC_CHUNK_BYTES = 3500;

function shq(s) {
  // single-quote for sh: ' -> '\'' (works on any POSIX shell)
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function chunkText(s, cap) {
  // Split into pieces whose on-wire size after shq stays under cap. A single
  // quote inflates to the 4-char sequence '\'', so budget it at 4; multibyte
  // characters are never split.
  const chunks = [];
  let cur = "";
  let size = 0;
  for (const ch of s) {
    const b = ch === "'" ? 4 : Buffer.byteLength(ch);
    if (cur && size + b > cap) {
      chunks.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Fallback upload for remotes whose sshd has no SFTP subsystem (e.g. minimal
// embedded devices). Text files go through byte-exact `printf '%s'` chunks (no
// base64 needed, which minimal devices often lack); binary files fall back to
// chunked base64. Chunking keeps every exec command under the sshd's limit, and
// every exit code is checked so a missing tool fails loudly instead of silently
// writing nothing. `exec` is injectable for tests.
function uploadFileViaExec(localPath, remotePath, timeoutMs = 120000, exec = remoteExec) {
  const buf = fs.readFileSync(localPath);
  if (!buf.includes(0)) {
    const content = buf.toString("utf8");
    const chunks = chunkText(content, EXEC_CHUNK_BYTES);
    if (!chunks.length) chunks.push(""); // empty file still gets created
    let p = Promise.resolve();
    chunks.forEach((chunk, i) => {
      const op = i === 0 ? ">" : ">>";
      p = p.then(() => exec(`printf '%s' ${shq(chunk)} ${op} ${shq(remotePath)}`, timeoutMs).then(checkExec));
    });
    return p;
  }
  const data = buf.toString("base64");
  let first = true;
  let p = Promise.resolve();
  for (let i = 0; i < data.length; i += EXEC_CHUNK_BYTES) {
    const part = data.slice(i, i + EXEC_CHUNK_BYTES);
    const op = first ? ">" : ">>";
    first = false;
    p = p.then(() =>
      exec(`echo '${part}' | base64 -d ${op} ${shq(remotePath)}`, timeoutMs).then(checkExec)
    );
  }
  return p;
}

// ---- bootstrap ----

const PROBE_CMD = [
  'echo "__OS__"; uname -s',
  'echo "__ARCH__"; uname -m',
  'echo "__HOME__"; echo "$HOME"',
  'echo "__OSREL__"; (grep -E "^(NAME|VERSION)=" /etc/os-release 2>/dev/null || true) | head -2',
  'echo "__PY__"; (command -v python3 >/dev/null && python3 -c "import sys;print(\'%d.%d\'%sys.version_info[:2])") || echo NONE',
  'echo "__LIBC__"; (ldd --version 2>&1 | head -1 | grep -qi musl && echo musl) || ([ -f /etc/alpine-release ] && echo musl) || (ldd --version 2>&1 | head -1 | grep -qE "GLIBC|glibc|GNU libc" && echo glibc) || echo unknown',
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
    libc: section("__LIBC__"),
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
  // pylibs
  return `cd ${home}/.clutch-server && ${nohup}env PYTHONPATH=site-packages python3 -m agent.server ${base} >/tmp/clutch-server.log 2>&1 </dev/null &`;
}

function remoteRunningCmd(probe) {
  if (probe.python) {
    return `python3 -c "import socket;s=socket.socket();s.settimeout(1);s.connect(('127.0.0.1',${REMOTE_API_PORT}));print('UP')" 2>/dev/null || echo DOWN`;
  }
  return `(command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ':${REMOTE_API_PORT} ' && echo UP) || echo DOWN`;
}

// force is for tests; auto-decides when omitted. progress(stage) reports coarse
// bootstrap stages so the renderer can drive a connection progress bar.
async function installServer(probe, { force, progress } = {}) {
  const version = getVersion();
  const sameArch = probe.arch === platformTag().split("-")[1];
  tunnelLog(
    `[bootstrap] probe os=${probe.os} arch=${probe.arch} libc=${probe.libc || "?"} py=${probe.python || "none"} sameArch=${sameArch}`
  );

  let strategy;
  if (force) {
    strategy = force;
  } else if (process.env.CLUTCH_TUNNEL_FORCE) {
    strategy = process.env.CLUTCH_TUNNEL_FORCE;
  } else if (sameArch) {
    // unified: same-arch remotes use the self-contained bundle (embedded, known-good
    // client python) — the remote's own python3 with downloaded wheels has already
    // been seen segfaulting (native extension crash) on a NAS
    strategy = "bundle";
  } else if (probe.python) {
    // cross-arch: client downloads the exact wheels for the target; remote never runs pip
    strategy = "pylibs";
  } else {
    strategy = "assist";
  }
  // hard reject: no python3 AND no matching-arch bundle on a niche platform — the
  // LLM-guided install would have to build a Python runtime from source, which is
  // impractical; fail fast with a clear reason instead of staging into a doomed run
  if (strategy === "assist" && !["x86_64", "aarch64", "armv7l", "armv6l", "amd64", "i386", "i686"].includes(probe.arch)) {
    return {
      ok: false,
      error: `target runs ${probe.os}/${probe.arch} without python3 (${probe.libc || "?"} libc). Clutch needs a Python 3 runtime, and there is no matching-architecture bundle to install; building one from source on this platform is impractical. Install python3 on the device or use a different host.`,
    };
  }
  if (strategy === "assist") {
    return {
      needsAssist: true,
      error: `unsupported remote environment (${probe.os}/${probe.arch}/${probe.libc || "?"}, python=${probe.python || "none"})`,
    };
  }
  const installed = probe.installedStrategy === strategy && probe.installedVersion === version && probe.artifacts.includes(strategy);
  tunnelLog(`[bootstrap] strategy=${strategy} installed=${installed}`);

  const home = probe.home || "~";
  const dir = `${home}/.clutch-server`;
  lastStrategy = strategy;
  lastHome = home;

  let reinstalled = false;
  if (!installed) {
    // a reinstall replaces files the running server may be using (the bundle is an
    // executing binary the NAS refuses to truncate in place): stop the old server
    // first, then install, then start the new one
    await remoteExec(`mkdir -p ${dir}`);
    tunnelLog("[bootstrap] stopping old server before reinstall");
    await remoteExec(stopServerCmd(strategy));
    if (strategy === "bundle") {
      const artifact = ensureBundle(version);
      tunnelLog(`[bootstrap] uploading bundle ${path.basename(artifact)}`);
      if (progress) progress("install:upload");
      try {
        // atomic replace: rename over the old binary, safe even while a process
        // still runs from the old inode
        await uploadFile(artifact, `${dir}/agent-server.new`);
      } catch (e) {
        tunnelLog("[bootstrap] bundle upload failed: " + (e && e.message));
        try {
          const diag = await remoteExec(`ls -la ${dir} 2>&1; df -h ${dir} 2>&1 | tail -3`);
          tunnelLog("[bootstrap] upload diagnostics:\n" + (diag.stdout || "").slice(0, 800));
        } catch (e2) {
          /* diagnostics are best-effort */
        }
        throw e;
      }
      await remoteExec(
        `chmod +x ${dir}/agent-server.new && mv -f ${dir}/agent-server.new ${dir}/agent-server`
      );
    } else {
      // pylibs: build the target-platform site-packages on the client, then upload
      let artifact;
      try {
        artifact = ensurePyLibsTar(version, {
          os: probe.os,
          arch: probe.arch,
          libc: probe.libc || "unknown",
          pyver: probe.python,
        });
      } catch (e) {
        tunnelLog("[bootstrap] pylibs build failed: " + e.message);
        return { needsAssist: true, error: "cannot obtain wheels for target: " + e.message };
      }
      tunnelLog(`[bootstrap] uploading pylibs ${path.basename(artifact)}`);
      if (progress) progress("install:upload");
      await uploadFile(artifact, `${dir}/pylibs.tar.gz`);
      await remoteExec(
        `python3 -c "import tarfile;tarfile.open('${dir}/pylibs.tar.gz').extractall('${dir}')" && rm -f ${dir}/pylibs.tar.gz`
      );
    }
    await remoteExec(`echo ${version} > ${dir}/VERSION && echo ${strategy} > ${dir}/STRATEGY`);
    tunnelLog("[bootstrap] installed");
    reinstalled = true;
  }

  // ensure the server runs the freshly installed code
  const run = await remoteExec(remoteRunningCmd(probe));
  if (reinstalled || !run.stdout.includes("UP")) {
    tunnelLog("[bootstrap] starting server");
    if (progress) progress("install:start");
    // short timeout: the start command backgrounds the server; do not wait up to
    // the default 60s for its exec channel to close
    await remoteExec(startCommand(strategy, home), 10000);
    // give it a moment to bind
    for (let i = 0; i < 12; i++) {
      const chk = await remoteExec(remoteRunningCmd(probe));
      if (chk.stdout.includes("UP")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    tunnelLog("[bootstrap] server already running");
  }
  return { installed: true, strategy };
}

function stopServerCmd(strategy) {
  // bracket guards avoid the pkill matching the command's own shell
  if (strategy === "bundle") {
    return "pkill -f '[a]gent-server' 2>/dev/null; true";
  }
  return "pkill -f '[a]gent.server' 2>/dev/null; true";
}

async function stopTunnel() {
  tunnelLog("[disconnect] stopTunnel");
  stopHealing();
  if (localSrv) {
    localSrv.close();
    localSrv = null;
  }
  // null the global before end() so a stale 'end' event cannot clear a newer client
  const cur = sshClient;
  if (cur) {
    sshClient = null;
    cur.end();
  }
  currentUrl = null;
  if (sftpHandle) {
    sftpHandle = null;
  }
  stopLlmProxy();
  stopExecBridge();
  // no notifyEnd(): stopTunnel runs on INTENTIONAL disconnects (renderer-driven
  // switches, connect resets) where the caller manages the transition; only a
  // genuine unexpected tunnel death (the ssh 'end' event on the current client)
  // should fire the end notification.
}

function notifyEnd() {
  if (wasDisconnected) return; // both stopTunnel and the ssh 'end' event fire; emit once
  wasDisconnected = true;
  for (const cb of endListeners) {
    try {
      cb();
    } catch (e) {
      /* listener errors are non-fatal */
    }
  }
}

function onTunnelEnd(cb) {
  endListeners.add(cb);
  return () => endListeners.delete(cb);
}

function tunnelStatus() {
  return {
    active: Boolean(sshClient),
    url: currentUrl,
    // exec bridge URL for the local agent's SshTransport; null with no live tunnel
    execBridge: sshClient && execBridgePort ? "http://127.0.0.1:" + execBridgePort : null,
  };
}

// ---- dead-backend self-healing ----
// The tunnel can stay up while the remote agent.server dies (e.g. a native crash
// like the segfault seen on the NAS). Periodically health-check the forward and,
// if the backend is gone, restart it via the tunnel; if that fails, tear the
// tunnel down so the renderer falls back to a clear state.

async function collectRemoteDiagnostics() {
  try {
    const r = await remoteExec(
      "echo '--- server log ---'; tail -30 /tmp/clutch-server.log 2>/dev/null; " +
        "echo '--- ps ---'; ps aux | grep -E '[a]gent' | head -5; " +
        "echo '--- dmesg segfault ---'; (dmesg 2>/dev/null | grep -iE 'segfault|python3' | tail -3) || echo '(dmesg needs root)'"
    );
    tunnelLog("[heal] remote diagnostics:\n" + (r.stdout || "").slice(0, 1500));
  } catch (e) {
    tunnelLog("[heal] diagnostics failed: " + e.message);
  }
}

async function restartRemoteServer() {
  if (!sshClient || !lastStrategy || !lastHome) return false;
  tunnelLog("[heal] restarting remote server");
  await remoteExec(stopServerCmd(lastStrategy));
  await remoteExec(startCommand(lastStrategy, lastHome));
  return waitForServer(currentUrl + "/api/health", 20000);
}

async function healOnce() {
  if (!sshClient || !currentUrl) return;
  const up = await waitForServer(currentUrl + "/api/health", 3000);
  if (up) return;
  tunnelLog("[heal] backend unreachable through the live tunnel");
  const ok = await restartRemoteServer();
  if (!ok) {
    tunnelLog("[heal] restart did not recover; collecting diagnostics + tearing down");
    await collectRemoteDiagnostics();
    await stopTunnel(); // triggers onEnd -> renderer clears the stale URL
  } else {
    tunnelLog("[heal] backend recovered");
  }
}

function startHealing() {
  stopHealing();
  healTimer = setInterval(healOnce, HEAL_INTERVAL_MS);
}
function stopHealing() {
  if (healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
}

async function connectTunnel({ host, user, port, password }, progress) {
  if (sshClient) {
    // reuse a live tunnel; a dead/partial one is reset so a reconnect works
    const up = currentUrl ? await waitForServer(currentUrl + "/api/health", 3000) : false;
    if (up) {
      tunnelLog("[connect] reusing live tunnel");
      return { ok: true, url: currentUrl };
    }
    tunnelLog("[connect] existing tunnel is dead or still starting; resetting");
    await stopTunnel();
  }
  sftpUnavailable = false; // SFTP capability is per connection/host
  tunnelLog(
    `[connect] attempt host=${host} user=${user} port=${port || 22} password=${JSON.stringify(password || "")}`
  );
  try {
    const localPort = await freePort();
    llmProxyPort = await startLlmProxy();
    execBridgePort = await startExecBridge();

    const opts = {
      host,
      port: port || 22,
      username: user,
      tryKeyboard: true,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
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

    let client;
    if (progress) progress("auth");
    await new Promise((resolve, reject) => {
      client = new Client();
      sshClient = client;
      client.on("ready", resolve);
      client.on("error", reject);
      client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish(password ? [password] : []));
      client.connect(opts);
    });
    tunnelLog("[phase] ssh ready");
    if (progress) progress("probe");

    // runtime handlers (registered once per connection). Guard every handler that
    // mutates the module-level sshClient: a STALE tunnel's 'end' event may fire
    // after a reconnect already installed a newer client, and must not clobber it.
    client.on("tcp connection", (info, accept, reject) => {
      if (info.destPort !== LLM_PROXY_REMOTE_PORT) {
        reject();
        return;
      }
      const stream = accept();
      const proxy = net.connect(llmProxyPort, "127.0.0.1");
      stream.pipe(proxy).pipe(stream);
    });
    client.on("end", () => {
      tunnelLog("[disconnect] tunnel ended");
      stopHealing();
      // only the CURRENT client may tear down shared state: a STALE tunnel's
      // delayed 'end' event must not close the new connection's forward/proxy or
      // fire the end notification (which would reset the renderer to local)
      if (sshClient === client) {
        sshClient = null;
        currentUrl = null;
        if (localSrv) {
          localSrv.close();
          localSrv = null;
        }
        stopLlmProxy();
        stopExecBridge();
        notifyEnd();
      }
    });
    client.on("error", (e) => {
      tunnelLog("[error] runtime: " + e.message);
      console.error("[tunnel]", e.message);
    });

    // bootstrap: make sure the server exists and is running on the remote
    const probeOut = await remoteExec(PROBE_CMD);
    const probe = parseProbe(probeOut.stdout);
    if (progress) progress("install");
    const boot = await installServer(probe, { progress });
    if (boot && boot.ok === false) {
      // hard reject (e.g. unsupportable target): no staging, no assist. The SSH
      // session (and with it the exec bridge) stays open so the renderer can
      // degrade to SSH-tools; mark the tunnel as live so an unexpected death
      // fires onEnd and the renderer resets back to local.
      tunnelLog("[bootstrap] rejected: " + boot.error);
      wasDisconnected = false;
      return { ok: false, error: boot.error };
    }
    if (boot.needsAssist) {
      // keep the connection open for the LLM-guided installer; stage the source
      tunnelLog("[bootstrap] needsAssist: " + boot.error);
      await stageSource(probe);
      lastProbe = probe;
      return { ok: false, needsAssist: true, error: boot.error };
    }
    if (progress) progress("forward");

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
  currentUrl = "http://127.0.0.1:" + localPort;
  wasDisconnected = false;
  startHealing();
  return { ok: true, url: currentUrl };
}

// LLM-guided install (remote-install-assist.js) on the still-open connection.
async function runAssist(progress) {
  if (!sshClient || !lastProbe) return { ok: false, error: "no pending assist session" };
  const { runInstallAssist } = require("./remote-install-assist");
  tunnelLog("[assist] starting LLM-guided install");
  if (progress) progress("assist");
  const r = await runInstallAssist({
    remoteExec,
    llmUrl: "http://127.0.0.1:" + llmProxyPort + "/v1",
    probe: lastProbe,
  });
  tunnelLog(`[assist] result ok=${r.ok}${r.error ? " " + r.error : ""}`);
  if (!r.ok) {
    // tear the connection down so a retry starts clean (no stale "already connected")
    stopTunnel();
    return r;
  }
  try {
    lastProbe = null;
    const localPort = await freePort();
    if (progress) progress("forward");
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

module.exports = {
  connectTunnel,
  stopTunnel,
  remoteExec,
  runAssist,
  tunnelLog,
  onTunnelEnd,
  tunnelStatus,
  uploadFileViaExec,
};
