// one connect attempt — auth, the forwards, the health gate
//
// connectTunnel is the whole attempt: reuse a live tunnel, start the
// client-side proxies (the LLM proxy is reachable from the far side over the
// reverse forward), authenticate, probe, install, then set up the forwards
// and gate on the health check through them. The gate has the last word: the
// forward must answer, and it must answer as a Clutch supervisor — a legacy
// shared server on the same port is refused by name.

const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { Client } = require("ssh2");
const { state, tunnelLog, REMOTE_API_PORT, LLM_PROXY_REMOTE_PORT, CONNECT_TIMEOUT_MS } = require("./tunnel-core");
const { freePort, listen, waitForServer, probeSupervisorShape } = require("./tunnel-net");
const { remoteExec } = require("./tunnel-remote");
const { PROBE_CMD, parseProbe, installServer, installComponents } = require("./tunnel-bootstrap");
const { stopTunnel, notifyEnd, startHealing, stopHealing } = require("./tunnel-lifecycle");
const { startLlmProxy, stopLlmProxy } = require("./llm-proxy");
const { startExecBridge, stopExecBridge } = require("./exec-bridge");

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

async function connectTunnel({ host, user, port, password }, progress) {
  if (state.sshClient) {
    // reuse a live tunnel; a dead/partial one is reset so a reconnect works
    const up = state.currentUrl ? await waitForServer(state.currentUrl + "/api/health", 3000) : false;
    if (up) {
      tunnelLog("[connect] reusing live tunnel");
      return { ok: true, url: state.currentUrl };
    }
    tunnelLog("[connect] existing tunnel is dead or still starting; resetting");
    await stopTunnel();
  }
  state.sftpUnavailable = false; // SFTP capability is per connection/host
  tunnelLog(
    `[connect] attempt host=${host} user=${user} port=${port || 22} password=${JSON.stringify(password || "")}`
  );
  try {
    const localPort = await freePort();
    state.llmProxyPort = await startLlmProxy();
    state.execBridgePort = await startExecBridge();

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
      state.sshClient = client;
      client.on("ready", resolve);
      client.on("error", reject);
      client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish(password ? [password] : []));
      client.connect(opts);
    });
    tunnelLog("[phase] ssh ready");
    if (progress) progress("probe");

    // runtime handlers (once per connection). Guard mutations of state.sshClient: a
    // stale tunnel's 'end' may fire after a reconnect and must not clobber it.
    client.on("tcp connection", (info, accept, reject) => {
      if (info.destPort !== LLM_PROXY_REMOTE_PORT) {
        reject();
        return;
      }
      const stream = accept();
      const proxy = net.connect(state.llmProxyPort, "127.0.0.1");
      stream.pipe(proxy).pipe(stream);
    });
    client.on("end", () => {
      tunnelLog("[disconnect] tunnel ended");
      stopHealing();
      // only the CURRENT client may tear down shared state
      if (state.sshClient === client) {
        state.sshClient = null;
        state.currentUrl = null;
        if (state.localSrv) {
          state.localSrv.close();
          state.localSrv = null;
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
    // An exec that timed out (code -1) or came back without the probe's own
    // markers is NOT "nothing is installed there". Reading it that way sent a
    // flaky reconnect into a full reinstall it did not need — and, with the old
    // stop patterns, into a loop it could not leave. Say what actually
    // happened; the SSH session stays for SSH-tools.
    if (!probe.os || !probe.home) {
      const why =
        probeOut.code === -1
          ? "the remote shell did not answer the capability probe in time"
          : `the capability probe came back unreadable (exit ${probeOut.code})`;
      tunnelLog("[bootstrap] probe unusable: " + why + " :: " + (probeOut.stdout || "").slice(0, 200));
      state.wasDisconnected = false;
      return { ok: false, error: why + " — the remote server was left untouched; reconnect." };
    }
    // "check", not "install": the gate below decides, and installServer
    // announces the install itself when there really is one to do
    if (progress) progress("check");
    const boot = await installServer(probe, { progress });
    if (boot && boot.ok === false) {
      // hard reject: keep the SSH session for SSH-tools degradation; mark the
      // tunnel live so an unexpected death fires onEnd
      tunnelLog("[bootstrap] rejected: " + boot.error);
      state.wasDisconnected = false;
      return { ok: false, error: boot.error };
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

// Set up the bidirectional forwards and gate on the health check through the tunnel.
async function establishForwardAndHealth(localPort) {
  state.localSrv = net.createServer((sock) => {
    // a request racing the teardown must fail the socket, not the main
    // process: forwardOut on a null client throws before it can answer
    if (!state.sshClient) return sock.destroy();
    state.sshClient.forwardOut("127.0.0.1", 0, "127.0.0.1", REMOTE_API_PORT, (err, stream) => {
      if (err) {
        tunnelLog("[error] forwardOut failed: " + (err && err.message));
        sock.destroy();
        return;
      }
      sock.pipe(stream).pipe(sock);
    });
  });
  await listen(state.localSrv, localPort);
  tunnelLog(`[phase] local forward listening 127.0.0.1:${localPort} -> remote 127.0.0.1:${REMOTE_API_PORT}`);
  state.sshClient.forwardIn("127.0.0.1", LLM_PROXY_REMOTE_PORT, (err) => {
    if (err) {
      tunnelLog("[phase] reverse forward failed: " + err.message);
      console.error("[tunnel] reverse forward failed:", err.message);
    } else {
      tunnelLog(`[phase] reverse forward requested 127.0.0.1:${LLM_PROXY_REMOTE_PORT} -> client proxy :${state.llmProxyPort}`);
    }
  });
  const up = await waitForServer("http://127.0.0.1:" + localPort + "/api/health", CONNECT_TIMEOUT_MS);
  if (!up) {
    tunnelLog("[health] FAIL: backend not reachable on the remote host");
    stopTunnel();
    return { ok: false, error: "backend not reachable on the remote host" };
  }
  const shape = await probeSupervisorShape("http://127.0.0.1:" + localPort);
  if (shape !== "up") {
    tunnelLog("[health] FAIL: remote 8890 is not a Clutch supervisor (legacy shared server?)");
    stopTunnel();
    return {
      ok: false,
      error:
        "remote 8890 runs a non-supervisor server (a legacy shared clutch-server?). " +
        "Restart it (pkill -f agent-server) and reconnect, or close the old app.",
    };
  }
  tunnelLog(`[connect] OK url=http://127.0.0.1:${localPort}`);
  state.currentUrl = "http://127.0.0.1:" + localPort;
  state.wasDisconnected = false;
  startHealing();
  installComponents(state.currentUrl);
  return { ok: true, url: state.currentUrl };
}

module.exports = {
  connectTunnel,
};
