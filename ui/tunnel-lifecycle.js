// teardown, the per-window session forwards, and self-healing
//
// stopTunnel is the one door the connection is closed through, and the
// session forwards each window opens die with it. Healing exists because the
// far side can die while the ssh hop stays up — and, just as often, because
// THIS end's forward can die while the far side is fine (a phone that froze
// in the background comes back with stale local ports and a far host that
// never noticed). The two must not be confused: restarting the far server is
// a `pkill` of every session child with it, which ends runs in flight. So a
// failed poll is answered by asking the far host itself first (over exec, a
// second path the forward does not share), and a still-serving far host is
// never touched — its forward is rebound instead. If even that fails, announce
// the end: the renderer must never keep posting into a port nobody serves.

const net = require("net");
const { state, tunnelLog, HEAL_INTERVAL_MS, REMOTE_API_PORT } = require("./tunnel-core");
const { freePort, listen, waitForServer } = require("./tunnel-net");
const { remoteExec } = require("./tunnel-remote");
const { startCommand, stopServer, remoteServingState } = require("./tunnel-bootstrap");
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

// A local listener whose connections are piped through the live ssh client to
// ONE port on the far host. Both forwards this module owns are built from it:
// the supervisor's API (establishForwardAndHealth, reopenForward) and each
// window's session (below) — so "the forward died" and "the far side died"
// are the same plumbing in both directions of the story.
function forwardServer(remotePort) {
  return net.createServer((sock) => {
    if (!state.sshClient) return sock.destroy();
    // ssh2 throws synchronously on a client whose socket is already gone
    // ("Not connected"); a request racing the teardown must fail its own
    // socket, not escape this handler and hang until the browser gives up
    try {
      state.sshClient.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (err, stream) => {
        if (err) {
          tunnelLog("[forward] forwardOut failed: " + (err && err.message));
          sock.destroy();
          return;
        }
        sock.pipe(stream).pipe(sock);
      });
    } catch (e) {
      tunnelLog("[forward] forwardOut threw: " + ((e && e.message) || e));
      sock.destroy();
    }
  });
}

function openSessionForward(remotePort) {
  return new Promise((resolve, reject) => {
    freePort().then(
      (localPort) => {
        const srv = forwardServer(remotePort);
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
  // stopServer proves the port came free: a restart that only *tries* to kill
  // the old process reports "recovered" against the survivor that made the
  // heal necessary, since the survivor is what answers the health poll.
  const stopped = await stopServer(state.lastProbe || {}, state.lastStrategy);
  if (!stopped.ok) {
    tunnelLog(`[heal] port ${REMOTE_API_PORT} still held after the stop:\n` + stopped.diag);
    return false;
  }
  await remoteExec(startCommand(state.lastStrategy, state.lastHome));
  const base = state.currentUrl;
  if (!base) return false;
  return waitForServer(base + "/api/health", 20000);
}

// The health poll failed, but the far host reports its server SERVING (or
// cannot be asked at all): the casualty is THIS client's own forward — a stale
// local port after the phone froze in the background, a half-dead channel —
// and the far host keeps running, its sessions' runs included. Bounce the
// forward, on the SAME local port (state.currentUrl names it, and every window
// claim names state.currentUrl), and never touch the far side: a restart there
// is a pkill of every session child with it, which ends runs in flight.
async function reopenForward() {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(state.currentUrl || "");
  const localPort = m ? Number(m[1]) : 0;
  if (!localPort || !state.sshClient) return false;
  const old = state.localSrv;
  state.localSrv = null;
  if (old) {
    try {
      old.close();
    } catch (e) {
      /* already closed */
    }
  }
  try {
    state.localSrv = forwardServer(REMOTE_API_PORT);
    await listen(state.localSrv, localPort);
  } catch (e) {
    tunnelLog("[heal] forward re-open failed: " + ((e && e.message) || e));
    state.localSrv = null;
    return false;
  }
  tunnelLog(`[phase] local forward rebound 127.0.0.1:${localPort} -> remote 127.0.0.1:${REMOTE_API_PORT}`);
  return waitForServer(state.currentUrl + "/api/health", 3000);
}

// One heal tick: a failed poll is a QUESTION, not a verdict. It travels this
// client's own forward to the far host, so "no answer" can mean three very
// different things: the far server died, this client's forward died (a phone
// that froze in the background comes back to stale local ports while the far
// host never noticed), or the wire died. Only the first is answered by
// restarting the far server — and that restart pkills every session child
// with it, which over a merely stale forward killed runs in flight and left
// the run's own record saying "the host released this session while the run
// was in flight". So the far host is asked about ITSELF first, over the exec
// channel (a second path the failed forward does not share), and a far host
// that answers is never touched.
//
// `healOnce` awaits work on a wire that may already be gone, so it can REJECT
// (ssh2's exec throws 'Not connected' inside remoteExec's promise). Under a
// bare `setInterval` that rejection went nowhere: no teardown, no notification,
// and the window kept the dead session URL right up to its next "Failed to
// fetch". Whatever happens in here, the renderer is told.
//
// What it is NOT is a verdict on one bad round. A round that never suspected the
// far host ("the forward is the dead thing", or the exec channel faltering under
// a radio that just went away) is asked once more before anything is announced:
// a blip that is over a second later must not cost the user a teardown, a dialog
// and a whole reconnect. The wait is the FIRST step of the ladder the rest of the
// client redials on (js/conn-lost.js CONN_LOST_BACKOFF_MS[0] = 1s, the LLM client,
// the ssh hop), so the ends agree on what a first retry means. The second round
// is the last: whatever it says, the renderer is told.
const HEAL_RETRY_MS = 1000;

async function healOnce() {
  if (!state.sshClient || !state.currentUrl) return;
  let round = await healRound();
  if (round.why && !round.remoteTouched) {
    tunnelLog(`[heal] ${round.why}; one more tick in ${HEAL_RETRY_MS}ms`);
    await new Promise((r) => setTimeout(r, HEAL_RETRY_MS));
    // the wait may have outlived the tunnel (a teardown, or a fresh connect that
    // took over): there is nothing left to heal and nothing to announce
    if (!state.sshClient || !state.currentUrl) return;
    round = await healRound();
  }
  if (!round.why) return;
  tunnelLog("[heal] " + round.why + "; collecting diagnostics + tearing down");
  await collectRemoteDiagnostics();
  // notify: this teardown is not the renderer's own. stopTunnel nulls
  // state.sshClient before end(), so the ssh 'end' handler is suppressed by its
  // currency guard and would never tell anyone: without the flag the
  // renderer keeps a dead session URL and its Stop button posts into it.
  await stopTunnel(true); // onEnd -> renderer raises the reconnect dialog
}

// One round of the question above, with its own verdict: `why` is null when the
// session answers again through a forward that is up, and the sentence that says
// what was wrong when it does not. `remoteTouched` says whether this round ran the
// far server's OWN restart — the one move here that ends runs in flight, and
// therefore the one that is not worth repeating on a hunch (see healOnce).
async function healRound() {
  let why = null;
  let remoteTouched = false;
  try {
    const up = await waitForServer(state.currentUrl + "/api/health", 3000);
    if (up) return { why: null, remoteTouched };
    tunnelLog("[heal] backend unreachable through the live tunnel");
    // the far host's own verdict about its port: DOWN (nobody), WEDGED (bound,
    // silent), SERVING (answers) or UNMEASURABLE (no way to look) — asked
    // over exec, never over the forward that just failed
    const verdict = await remoteServingState(state.lastProbe || {});
    tunnelLog(`[heal] far side reports ${verdict}`);
    if (verdict === "SERVING" || verdict === "UNMEASURABLE") {
      // answering (or unaskable — a far host whose answer we cannot hear is
      // not a dead one, and only a proven-dead one justifies replacing): the
      // forward is the dead thing
      const ok = await reopenForward();
      if (ok) {
        tunnelLog("[heal] forward rebound; backend recovered");
        return { why: null, remoteTouched };
      }
      // the hop can no longer reach a far side that keeps serving — end the
      // tunnel and let the re-connect re-claim the same remote sessions
      why = "the tunnel cannot reach a far side that is still serving";
    } else {
      // DOWN (nothing is listening) or WEDGED (bound, not answering): the far
      // server itself is broken, and replacing it is the only way back
      remoteTouched = true;
      const ok = await restartRemoteServer();
      if (ok) {
        tunnelLog("[heal] backend recovered");
        return { why: null, remoteTouched };
      }
      why = "the restart did not recover";
    }
  } catch (e) {
    why = "the tunnel could not be used (" + ((e && e.message) || e) + ")";
  }
  return { why, remoteTouched };
}

function startHealing() {
  stopHealing();
  state.healTimer = setInterval(() => {
    // the timer is the caller of last resort: a rejection here has no one else
    healOnce().catch((e) => tunnelLog("[heal] tick failed: " + ((e && e.message) || e)));
  }, HEAL_INTERVAL_MS);
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
  reopenForward,
  restartRemoteServer,
  healOnce,
  startHealing,
  stopHealing,
};
