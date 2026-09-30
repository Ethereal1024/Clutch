// teardown, the per-window session forwards, and self-healing
//
// stopTunnel is the one door the connection is closed through, and the
// session forwards each window opens die with it. Healing exists because the
// far side can die while the ssh hop stays up: poll the forward, restart the
// remote server through the tunnel, and if even that fails, announce the end
// — the renderer must never keep posting into a port nobody serves.

const net = require("net");
const { state, tunnelLog, HEAL_INTERVAL_MS } = require("./tunnel-core");
const { freePort, listen, waitForServer } = require("./tunnel-net");
const { remoteExec } = require("./tunnel-remote");
const { startCommand, stopServerCmd } = require("./tunnel-bootstrap");
const { stopLlmProxy } = require("./llm-proxy");
const { stopExecBridge } = require("./exec-bridge");

// `notify` is for teardowns the RENDERER did not ask for. Its own disconnect
// (the SSH picker, window close) is caller-managed: the renderer clears its
// flag and re-claims a local session itself, in the same turn. A teardown it
// does NOT know about must be announced, because until then it keeps talking
// to a port nobody serves: the SSE stream ends silently (the window shows a
// run that is not there) and Stop posts the cancel into nothing while the
// remote session keeps running -- unreachable, and unable to be stopped.
async function stopTunnel(notify = false) {
  tunnelLog("[disconnect] stopTunnel");
  stopHealing();
  if (state.localSrv) {
    state.localSrv.close();
    state.localSrv = null;
  }
  for (const srv of state.sessionForwards) {
    try {
      srv.close();
    } catch (e) {
      /* already closed */
    }
  }
  state.sessionForwards = new Set();
  // null the global before end() so a stale 'end' cannot clear a newer client
  const cur = state.sshClient;
  if (cur) {
    state.sshClient = null;
    cur.end();
  }
  state.currentUrl = null;
  if (state.sftpHandle) {
    state.sftpHandle = null;
  }
  stopLlmProxy();
  stopExecBridge();
  // intentional disconnects are caller-managed; an unexpected death (the ssh
  // 'end' event) and a teardown the caller flags both notify
  if (notify) notifyEnd();
}

function notifyEnd() {
  if (state.wasDisconnected) return; // both stopTunnel and the ssh 'end' event fire; emit once
  state.wasDisconnected = true;
  for (const cb of state.endListeners) {
    try {
      cb();
    } catch (e) {
      /* listener errors are non-fatal */
    }
  }
}

function onTunnelEnd(cb) {
  state.endListeners.add(cb);
  return () => state.endListeners.delete(cb);
}

function tunnelStatus() {
  return {
    active: Boolean(state.sshClient),
    url: state.currentUrl,
    // exec bridge URL for the local agent's SshTransport; null with no live tunnel
    execBridge: state.sshClient && state.execBridgePort ? "http://127.0.0.1:" + state.execBridgePort : null,
  };
}

// ---- per-window session forwards ----
// Each window gets its own forward to its session child's port; all die with the tunnel.

function openSessionForward(remotePort) {
  return new Promise((resolve, reject) => {
    freePort().then(
      (localPort) => {
        const srv = net.createServer((sock) => {
          if (!state.sshClient) return sock.destroy();
          state.sshClient.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (err, stream) => {
            if (err) {
              tunnelLog("[session] forwardOut failed: " + (err && err.message));
              sock.destroy();
              return;
            }
            sock.pipe(stream).pipe(sock);
          });
        });
        listen(srv, localPort).then(
          () => {
            state.sessionForwards.add(srv);
            tunnelLog(`[session] forward 127.0.0.1:${localPort} -> remote :${remotePort}`);
            resolve({
              localPort,
              close: () => {
                state.sessionForwards.delete(srv);
                try {
                  srv.close();
                } catch (e) {
                  /* already closed */
                }
              },
            });
          },
          reject
        );
      },
      reject
    );
  });
}

// ---- dead-backend self-healing ----
// Health-check the forward, restart the backend via the tunnel, else tear down.
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
  if (!state.sshClient || !state.lastStrategy || !state.lastHome) return false;
  tunnelLog("[heal] restarting remote server");
  await remoteExec(stopServerCmd(state.lastStrategy));
  await remoteExec(startCommand(state.lastStrategy, state.lastHome));
  return waitForServer(state.currentUrl + "/api/health", 20000);
}

async function healOnce() {
  if (!state.sshClient || !state.currentUrl) return;
  const up = await waitForServer(state.currentUrl + "/api/health", 3000);
  if (up) return;
  tunnelLog("[heal] backend unreachable through the live tunnel");
  const ok = await restartRemoteServer();
  if (!ok) {
    tunnelLog("[heal] restart did not recover; collecting diagnostics + tearing down");
    await collectRemoteDiagnostics();
    // notify: this teardown is not the renderer's own. stopTunnel nulls
    // state.sshClient before end(), so the ssh 'end' handler is suppressed by its
    // currency guard and would never tell anyone: without the flag the
    // renderer keeps a dead session URL and its Stop button posts into it.
    await stopTunnel(true); // onEnd -> renderer drops the stale URL + re-claims
  } else {
    tunnelLog("[heal] backend recovered");
  }
}

function startHealing() {
  stopHealing();
  state.healTimer = setInterval(healOnce, HEAL_INTERVAL_MS);
}
function stopHealing() {
  if (state.healTimer) {
    clearInterval(state.healTimer);
    state.healTimer = null;
  }
}

module.exports = {
  stopTunnel,
  notifyEnd,
  onTunnelEnd,
  tunnelStatus,
  openSessionForward,
  restartRemoteServer,
  startHealing,
  stopHealing,
};
