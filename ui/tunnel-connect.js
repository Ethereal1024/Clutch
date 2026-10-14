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
const { state, tunnelLog, REMOTE_API_PORT, CONNECT_TIMEOUT_MS, remoteLlmPort } = require("./tunnel-core");
const { freePort, listen, waitForServer, probeSupervisorShape } = require("./tunnel-net");
const { remoteExec } = require("./tunnel-remote");
const { PROBE_CMD, parseProbe, installServer, installComponents } = require("./tunnel-bootstrap");
const { stopTunnel, notifyEnd, startHealing, stopHealing } = require("./tunnel-lifecycle");
const { startLlmProxy, stopLlmProxy } = require("./llm-proxy");
const { startExecBridge, stopExecBridge } = require("./exec-bridge");
const { getSshSecret, saveSshSecret, forgetSshSecret } = require("./settings-mirror");

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
  // an encrypted key and no agent: ssh2 refuses to parse it without its
  // passphrase. Auth-class on purpose, so the prompt (and the ssh_secrets
  // cache) covers a key passphrase exactly like a password.
  if (/Cannot parse privateKey|bad passphrase|Encrypted (private )?OpenSSH key/i.test(m)) {
    return "authentication failed (the SSH key needs its passphrase)";
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
  // the auth secret, resolved the way llm-proxy resolves the API key: an
  // explicit value from the caller first, then the ssh_secrets cache in the
  // settings mirror (typed once per host, reused on reconnect/restart)
  const cached = password ? "" : getSshSecret(host, user, port);
  const secret = password || cached;
  state.sftpUnavailable = false; // SFTP capability is per connection/host
  // never log the secret itself — only whether one is being offered
  tunnelLog(
    `[connect] attempt host=${host} user=${user} port=${port || 22} secret=${secret ? "yes" : "no"}${cached ? " (cached)" : ""}`
  );
  // The client THIS attempt installed, held outside the try so the failure path
  // can tell whether it is still the dial that owns the wire (see the catch).
  let dialling = null;
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
      // The keepalive is this side's only witness that the far side is gone: a
      // phone's radio can be dropped without a FIN, so no 'end' ever arrives and
      // nothing else reports it. 30s x 3 meant up to two minutes of a window
      // posting into a forward nobody served; 5s x 2 turned the other way and
      // declared the hop dead before a phone that had only lost its radio for a
      // moment could come back. 15s x 3 gives ~45s of tolerance — two missed
      // pings, the same shape as before — which is long enough that a handover,
      // a lift shaft or a backgrounded app is survivable and short enough that a
      // window is not left talking into a dead forward.
      //
      // This is deliberately NOT the far host's own window any more: the session
      // there outlives every hop (agent/procmgr/supervise.py STALE_S = 300s), so
      // a hop that dies is a CLAIM to re-bind, not a session to replace
      // (ui/host-core.js rebindTunnelBackend). Both ends can hold their own
      // number without having to agree.
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      agent: process.env.SSH_AUTH_SOCK,
      debug: (m) => tunnelLog("ssh2: " + m),
    };
    // the same value covers both password auth and an encrypted-key passphrase
    if (secret) {
      opts.password = secret;
      opts.passphrase = secret;
    }
    const key = defaultKey();
    if (key) opts.privateKey = key;

    let client;
    if (progress) progress("auth");
    await new Promise((resolve, reject) => {
      client = new Client();
      dialling = client;
      state.sshClient = client;
      client.on("ready", resolve);
      client.on("error", reject);
      client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish(secret ? [secret] : []));
      client.connect(opts);
    });
    tunnelLog("[phase] ssh ready");
    // the secret that authenticated is what the next connect reuses
    if (password) saveSshSecret(host, user, port, password);
    if (progress) progress("probe");

    // The connection is over, however it ended. `end` is a FIN and ONLY a FIN:
    // ssh2 emits it from the socket's own 'end' (node_modules/ssh2/lib/client.js
    // :806-819), so a dropped radio, a reset, or a keepalive timeout emits
    // `close` alone. Listening for `end` only is why a dead tunnel kept being
    // handed out as this window's backend: the teardown never ran, `active`
    // stayed true, and the renderer had no way to learn the remote was gone
    // until its next request came back "Failed to fetch".
    let gone = false;
    const tunnelGone = (why) => {
      if (gone) return; // end and close both fire on a clean close
      gone = true;
      tunnelLog("[disconnect] tunnel " + why);
      stopHealing();
      // only the CURRENT client may tear down shared state
      if (state.sshClient !== client) return;
      state.sshClient = null;
      state.currentUrl = null;
      if (state.localSrv) {
        state.localSrv.close();
        state.localSrv = null;
      }
      stopLlmProxy();
      stopExecBridge();
      notifyEnd();
    };
    // runtime handlers (once per connection). Guard mutations of state.sshClient: a
    // stale tunnel's 'end' may fire after a reconnect and must not clobber it.
    client.on("tcp connection", (info, accept, reject) => {
      // no live proxy port (it failed to start, or the tunnel is being torn
      // down): refuse the forward instead of calling net.connect(null), which
      // throws synchronously inside this handler — an uncaught throw in the main
      // process takes the whole window down
      if (info.destPort !== remoteLlmPort() || !state.llmProxyPort) {
        reject();
        return;
      }
      const stream = accept();
      const proxy = net.connect(state.llmProxyPort, "127.0.0.1");
      // An error on either half must end BOTH halves. A socket left hanging here
      // is the worst shape there is: the far side's connection has been ACCEPTED,
      // so it looks alive to whoever is reading it, and nothing will ever answer
      // it — the agent then parks in its read until its own budget expires. Fail
      // the pair, so the far side sees a dead connection it can retry.
      const kill = () => {
        stream.destroy();
        proxy.destroy();
      };
      stream.on("error", kill);
      proxy.on("error", kill);
      stream.on("close", () => proxy.destroy());
      proxy.on("close", () => stream.destroy());
      stream.pipe(proxy).pipe(stream);
    });
    client.on("end", () => tunnelGone("ended"));
    client.on("close", () => tunnelGone("closed"));
    client.on("error", (e) => {
      tunnelLog("[error] runtime: " + e.message);
      console.error("[tunnel]", e.message);
      // A keepalive timeout (and a socket error) is ssh2 saying the wire is
      // gone before any 'close' is guaranteed to arrive: this is the only event
      // that carries the CAUSE, so it tears down here too instead of only being
      // written to a log nobody reads.
      if (e && (e.level === "client-timeout" || e.level === "client-socket")) tunnelGone("lost the socket");
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

    return await establishForwardAndHealth(localPort, client);
  } catch (e) {
    const raw = (e && e.message) || String(e);
    const friendly = friendlyError(e);
    tunnelLog(`[error] connect failed: ${raw} -> ${friendly}`);
    // a cached secret that no longer authenticates is worse than none: drop it
    // so this path prompts again (and a typed one can take its place)
    if (cached && /authentication/i.test(friendly)) forgetSshSecret(host, user, port);
    // Only a dial that still owns the wire may tear the shared state down. A
    // SECOND dial started on top of this one (the page's own redial landing next
    // to the engine ladder's attempt, a second window, the picker's retry)
    // resets this client in its "existing tunnel is dead or still starting"
    // branch; this attempt then fails BECAUSE of that reset, and an unguarded
    // teardown here would close the very tunnel that just won the race — the
    // loser killing the winner. Same identity rule as tunnelGone's, and for the
    // same reason: a stale attempt must not clobber a newer client.
    if (dialling === null || state.sshClient === dialling) {
      stopTunnel();
    } else {
      tunnelLog("[error] a newer dial owns the tunnel now; leaving it alone");
    }
    return { ok: false, error: friendly };
  }
}

// Asking the far side to listen on 8892 (and forward what arrives back here, to
// this window's LLM proxy) is the ONLY way a remote session reaches a model. It
// used to be fired once and forgotten: the reply was read for an error only to
// write it to a log, and the connect carried on regardless.
//
// That is one half of the field report. A reconnect reaches this line seconds
// after the previous hop died, and the remote sshd is still holding the old
// session's 8892 listener while it is released — so the bind comes back refused,
// nothing retries it, and every LLM request the agent then makes is ACCEPTED by
// that orphaned listener and answered by nobody. From the agent's side the model
// is simply not answering: the run sits in "thinking" (a parked read in its own
// 240s budget) however long the network has been back, and only a Stop — which
// breaks the read — gets it moving again. So: retry the bind until it really is
// bound, and let the gate below fail the connect loudly if it never is.
//
// The second release of the same report is why retrying is not the whole story.
// It read as "stuck on Starting tunnel…", and the listener holding 8892 need not
// be a dying one: sshd's keepalive is off in the stock config, so a session
// whose network vanished without a FIN (a phone that lost its radio, a laptop
// that slept) is held — and holds 8892 with it — for hours, and a listener left
// by a hop this window no longer owns is not ours to kill. A bind that never
// lands is not proof the far side cannot forward: it is proof it cannot forward
// on THAT port. So the ladder ends by asking the far side to pick a port for
// itself (port 0 — RFC 4254 has sshd bind what it can and report the number),
// and this process remembers the answer for every later hop (see remoteLlmPort).
const REVERSE_FORWARD_TRIES = 6;
const REVERSE_FORWARD_RETRY_MS = 500; // first step of the ladder
const REVERSE_FORWARD_MAX_WAIT_MS = 2000; // a port freeing up, not a network: cap it here

// One bind attempt. port === 0 is the wire's own way of saying "you pick": sshd
// binds whatever it has and ssh2 hands the chosen number back as the callback's
// second argument.
function bindReverseForward(client, port) {
  const failed = (e) => ({ ok: false, error: (e && e.message) || String(e) });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      client.forwardIn("127.0.0.1", port, (err, assigned) => {
        // forwardIn throws — it does not call back — on a socket that is already
        // gone, and that throw would escape past this promise into the connect
        if (err) return done(failed(err));
        done({ ok: true, port: Number(assigned) || port });
      });
    } catch (e) {
      done(failed(e));
    }
  });
}

// The ladder: the SAME port, asked for again, because "address already in use"
// is usually an sshd releasing a dead hop's listener and it is gone a moment
// later. abandoned is not failure — it means a newer connect owns the session
// now, so this forward belongs to a dead connect and must not be installed.
async function bindReverseForwardWithLadder(client, port, opts = {}) {
  const tries = opts.tries || REVERSE_FORWARD_TRIES;
  const first = opts.retryMs || REVERSE_FORWARD_RETRY_MS;
  const cap = opts.maxWaitMs || REVERSE_FORWARD_MAX_WAIT_MS;
  let last = "no attempt was made";
  for (let attempt = 1; attempt <= tries; attempt++) {
    // a newer connect owns the session now: this forward belongs to a dead one
    if (!client || state.sshClient !== client) return { ok: false, abandoned: true };
    const got = await bindReverseForward(client, port);
    if (got.ok) return { ok: true, port: got.port, attempt };
    if (state.sshClient !== client) return { ok: false, abandoned: true }; // tunnel died under us
    last = got.error;
    if (attempt >= tries) break;
    const wait = Math.min(first * Math.pow(2, attempt - 1), cap);
    tunnelLog(`[phase] reverse forward failed (try ${attempt}/${tries}, retry in ${wait}ms): ${last}`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return { ok: false, error: last };
}

// true only when the far side really has a listener that forwards back here.
async function installReverseForward(client, opts = {}) {
  const preferred = remoteLlmPort();
  const first = await bindReverseForwardWithLadder(client, preferred, opts);
  if (first.ok) {
    state.llmProxyRemotePort = first.port;
    tunnelLog(
      `[phase] reverse forward listening 127.0.0.1:${first.port} -> client proxy :${state.llmProxyPort}` +
        (first.attempt > 1 ? ` (try ${first.attempt})` : "")
    );
    return true;
  }
  if (first.abandoned) return false;
  // 8892 is the contract with the far side's --base-url, not a right: a listener
  // we cannot reach and cannot kill costs us a different port, not the connect.
  tunnelLog(
    `[phase] reverse forward on ${preferred} refused (${first.error}); asking the far side for a port of its own`
  );
  const second = await bindReverseForwardWithLadder(client, 0, { ...opts, tries: 1 });
  if (second.ok) {
    state.llmProxyRemotePort = second.port;
    tunnelLog(
      `[phase] reverse forward listening 127.0.0.1:${second.port} (chosen by the far side: ${preferred} is held) ` +
        `-> client proxy :${state.llmProxyPort}`
    );
    return true;
  }
  if (!second.abandoned) {
    tunnelLog(
      `[phase] reverse forward failed: the far side would not forward to us at all (${second.error})`
    );
  }
  return false;
}

// Failing a gate is not a reason to close a wire a NEWER dial may already own:
// an attempt that lost the race fails BECAUSE of the reset the winner performed,
// so an unguarded teardown here closes the very tunnel that just won. Same
// identity rule as connectTunnel's catch and tunnelGone's, and for the same
// reason — a stale attempt must not clobber a newer client.
function failConnect(client, why, error) {
  tunnelLog(why);
  if (state.sshClient === client) {
    stopTunnel();
  } else {
    tunnelLog("[error] a newer dial owns the tunnel now; leaving it alone");
  }
  return { ok: false, error };
}

// Set up the bidirectional forwards and gate on the health check through the tunnel.
async function establishForwardAndHealth(localPort, client) {
  state.localSrv = net.createServer((sock) => {
    // a request racing the teardown must fail the socket, not the main
    // process: forwardOut on a null client throws before it can answer
    if (!state.sshClient) return sock.destroy();
    // ...and a client whose socket is already destroyed but whose teardown has
    // not run yet throws the same way ("Not connected"), which used to escape
    // the connection handler and hang the request until the browser called it
    // "Failed to fetch". Fail THIS socket instead.
    try {
      state.sshClient.forwardOut("127.0.0.1", 0, "127.0.0.1", REMOTE_API_PORT, (err, stream) => {
        if (err) {
          tunnelLog("[error] forwardOut failed: " + (err && err.message));
          sock.destroy();
          return;
        }
        sock.pipe(stream).pipe(sock);
      });
    } catch (e) {
      tunnelLog("[error] forwardOut threw: " + ((e && e.message) || e));
      sock.destroy();
    }
  });
  await listen(state.localSrv, localPort);
  tunnelLog(`[phase] local forward listening 127.0.0.1:${localPort} -> remote 127.0.0.1:${REMOTE_API_PORT}`);
  // awaited, and retried: without this bind the far side has no way to reach a
  // model at all (see installReverseForward)
  const reverse = await installReverseForward(client);
  if (!reverse) {
    const port = remoteLlmPort();
    return failConnect(
      client,
      `[health] FAIL: the far side could not be given a listener (tried 127.0.0.1:${port}, then a port of its own)`,
      `the remote host would not let us listen on 127.0.0.1:${port} or on a port of its own choosing, so its model ` +
        "requests have nowhere to go — check that the host allows TCP forwarding (AllowTcpForwarding) and reconnect."
    );
  }
  const up = await waitForServer("http://127.0.0.1:" + localPort + "/api/health", CONNECT_TIMEOUT_MS);
  if (!up) {
    return failConnect(
      client,
      "[health] FAIL: backend not reachable on the remote host",
      "backend not reachable on the remote host"
    );
  }
  const shape = await probeSupervisorShape("http://127.0.0.1:" + localPort);
  if (shape !== "up") {
    return failConnect(
      client,
      "[health] FAIL: remote 8890 is not a Clutch supervisor (legacy shared server?)",
      "remote 8890 runs a non-supervisor server (a legacy shared clutch-server?). " +
        "Restart it (pkill -f agent-server) and reconnect, or close the old app."
    );
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
  installReverseForward,
};
