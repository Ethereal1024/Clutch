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
//
// The THIRD release of that report — 0.1.46, "still stuck on Starting tunnel…" —
// is the one the ladder above could not reach, because the ladder is not where it
// parks. ssh2 answers forwardIn only when the FAR side replies to the global
// request (SSH_MSG_GLOBAL_REQUEST: node_modules/ssh2/lib/client.js invokes the
// callback from the reply handler, and from nowhere else), so an attempt whose
// answer never arrives leaves this await pending for as long as the client object
// lives. The keepalive does eventually notice a wire that died without a FIN and
// tears the CLIENT down (15s × 3), but nothing rejects a promise that is already
// in flight: the phase stayed on "Starting tunnel…" — the label progress("forward")
// prints right before this — for good. Every other await in the phase is bounded
// (CONNECT_TIMEOUT_MS on the health probe, 3s on the supervisor probe, the exec
// budget in tunnel-remote), so the bind gets a clock of its own, and it also
// settles the moment the client says it is gone.
//
// The FOURTH release of that report — 0.1.47, still "Starting tunnel…", still
// deterministic on a good network — is why a clock was never the answer. The
// clock made the wait up to 4 seconds instead of forever, but it did not remove
// the wait: this hop's outcome still DEPENDED on the far side answering, and a
// far side that says nothing about global requests (a middlebox, a hardened or
// non-OpenSSH sshd, a session whose request channel is wedged) was still the
// thing the user's reconnect hung on. The structural change is not a shorter
// clock: the model path stops being part of the connect's verdict at all. The
// connect's own gates stay the ones that describe the hop it is actually
// building — a local forward, a live supervisor behind it, and that supervisor's
// shape — and the far side's model path is installed BESIDE them (startModelPath),
// with a session claim (host-core) waiting for it at the one moment it can be
// waited for without parking a connect: right before a session is told to use it.
//
// So: silent is not refused (the ladder stops and the port-0 ask is skipped — one
// clock, one question), a failure here is not a failure of the hop, and nothing a
// far side does or does not say can hold "Starting tunnel…" open.
const REVERSE_FORWARD_TRIES = 6;
const REVERSE_FORWARD_RETRY_MS = 500; // first step of the ladder
const REVERSE_FORWARD_MAX_WAIT_MS = 2000; // a port freeing up, not a network: cap it here
// How long ONE attempt may stay unanswered before it counts as "no reply is
// coming". sshd answers as soon as it has tried the bind, so this is not a speed
// limit on a slow link: it is the difference between "the far side said no" and
// "nobody is going to say anything".
const REVERSE_FORWARD_BIND_TIMEOUT_MS = 4000;

// One bind attempt. port === 0 is the wire's own way of saying "you pick": sshd
// binds whatever it has and ssh2 hands the chosen number back as the callback's
// second argument.
function bindReverseForward(client, port, timeoutMs = REVERSE_FORWARD_BIND_TIMEOUT_MS) {
  // `silent` marks the two ways an attempt ends without the far side having SAID
  // anything: the clock ran out, and the client died under it. They are the same
  // fact — no reply is coming — and they are told apart from a refusal on
  // purpose: a refusal is an ANSWER (try again, ask for another port), while
  // silence means asking this far side again can only spend another clock.
  const failed = (e, silent) => ({ ok: false, silent: Boolean(silent), error: (e && e.message) || String(e) });
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    // Two ways out that ssh2 does not give us (see the comment above): the
    // client's own death notice, and a clock. Both are removed on settle, so a
    // long ladder leaves no listeners behind and a late reply is a no-op.
    const gone = () =>
      done(failed("the connection closed before the far side answered the reverse-forward request", true));
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof client.removeListener === "function") {
        client.removeListener("close", gone);
        client.removeListener("error", gone);
      }
      resolve(v);
    };
    if (typeof client.once === "function") {
      client.once("close", gone);
      client.once("error", gone);
    }
    if (timeoutMs > 0) {
      timer = setTimeout(
        () =>
          done(
            failed(`the far side did not answer the reverse-forward request within ${timeoutMs}ms`, true)
          ),
        timeoutMs
      );
    }
    try {
      client.forwardIn("127.0.0.1", port, (err, assigned) => {
        // forwardIn throws — it does not call back — on a socket that is already
        // gone, and that throw would escape past this promise into the connect
        if (err) return done(failed(err)); // an ANSWER, however unwelcome: not silence
        done({ ok: true, port: Number(assigned) || port });
      });
    } catch (e) {
      // forwardIn only throws when the socket is already gone ("Not connected"),
      // which is the client's death, not the far side's verdict
      done(failed(e, true));
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
  const bindTimeoutMs = opts.bindTimeoutMs || REVERSE_FORWARD_BIND_TIMEOUT_MS;
  let last = "no attempt was made";
  for (let attempt = 1; attempt <= tries; attempt++) {
    // a newer connect owns the session now: this forward belongs to a dead one
    if (!client || state.sshClient !== client) return { ok: false, abandoned: true };
    const got = await bindReverseForward(client, port, bindTimeoutMs);
    if (got.ok) return { ok: true, port: got.port, attempt };
    if (state.sshClient !== client) return { ok: false, abandoned: true }; // tunnel died under us
    last = got.error;
    // Nothing answered, and nothing is going to: the far side either never
    // receives global requests on this session or is not there at all. Asking
    // again is the same question on the same wire, so it costs another clock and
    // teaches nothing; the answers a retry CAN be for are the far side's own
    // (a bind it refused while sshd released a dead hop's listener).
    if (got.silent) return { ok: false, silent: true, error: last };
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
  if (first.silent) {
    // the far side never answered — asking it for a port of its own is the SAME
    // question with a different number, and it would be silent about that too
    tunnelLog(`[phase] reverse forward unanswered (${first.error}); not asking for a port of its own`);
    return false;
  }
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
  if (!second.abandoned && !second.silent) {
    tunnelLog(
      `[phase] reverse forward failed: the far side would not forward to us at all (${second.error})`
    );
  }
  return false;
}

// ---- the far side's model path, installed beside the hop ----
//
// The reverse forward is how a remote session reaches a model, so it still has to
// land — but it is not what the connect is. Two facts forced them apart:
//
//   * the far side can be SILENT about a global request. ssh2 calls forwardIn's
//     callback from the reply handler and from nowhere else, so a session that
//     never answers leaves an attempt with no way to settle; the 4s clock ends
//     that attempt, but the connect then still waited on the answer's ARRIVAL to
//     decide (and, before the clock, parked on "Starting tunnel…" forever). A
//     middlebox, a non-OpenSSH sshd or a wedged request channel is enough, and it
//     is deterministic — which is exactly what the field reported.
//   * the port is only needed LATER. A session's --base-url is built when the
//     session is spawned (host-core's claim), not while the hop is coming up.
//
// So the install runs on its own promise, state.modelPath says where it got to,
// and the one caller that must not hand out a base without a listener behind it
// joins it (awaitModelPath, from host-core's claim). Every asker joins the SAME
// in-flight promise: one question, one clock, however many windows ask.
//
// A model path that does not land is retried, because it is the difference
// between a run that works and one that "thinks" until its own read budget
// expires — but gently, doubling from 15s to 60s, unref'd so a pending retry
// never keeps a host alive, and only for the client it was started for.
const MODEL_PATH_REPAIR_MS = 15000; // first retry after a model path that did not land
const MODEL_PATH_REPAIR_CAP_MS = 60000; // a far side that will not forward is asked this often at most

function clearModelPathRepair() {
  if (state.modelPathRepairTimer) {
    clearTimeout(state.modelPathRepairTimer);
    state.modelPathRepairTimer = null;
  }
}

function scheduleModelPathRepair(client) {
  clearModelPathRepair();
  const wait = state.modelPathRepairDelay || MODEL_PATH_REPAIR_MS;
  state.modelPathRepairTimer = setTimeout(() => {
    state.modelPathRepairTimer = null;
    // the hop this was about is gone: the next connect installs its own path, and
    // a retry into a dead client could only be a write to a null wire
    if (state.sshClient !== client) return;
    startModelPath(client);
  }, wait);
  if (state.modelPathRepairTimer.unref) state.modelPathRepairTimer.unref();
  // the next wait is longer: a far side that refuses once usually refuses again,
  // and a repair loop at 15s forever is noise in the log and a bind storm on it
  state.modelPathRepairDelay = Math.min(wait * 2, MODEL_PATH_REPAIR_CAP_MS);
}

// The install settled. Whatever it learned is about the client it was started
// for: a hop that has been replaced since must not have its model path spoken for
// by the dead one's verdict.
function finishModelPath(client, ok) {
  if (state.modelPathClient !== client) return state.modelPath || "none";
  state.modelPathInstall = null;
  if (state.sshClient !== client) return state.modelPath || "none";
  if (ok) {
    state.modelPath = "listening";
    state.modelPathRepairDelay = null;
    clearModelPathRepair();
    tunnelLog(
      `[phase] model path listening 127.0.0.1:${state.llmProxyRemotePort || remoteLlmPort()} on the far side ` +
        `-> client proxy :${state.llmProxyPort}`
    );
    return state.modelPath;
  }
  state.modelPath = "unavailable";
  const wait = state.modelPathRepairDelay || MODEL_PATH_REPAIR_MS;
  tunnelLog(`[phase] model path unavailable (127.0.0.1:${remoteLlmPort()} was not given to us); asking again in ${wait}ms`);
  scheduleModelPathRepair(client);
  return state.modelPath;
}

// Kick off (or join) the install of the far side's model path. Never awaited by
// the connect; the returned promise resolves to state.modelPath, so a repair and
// a claim can share it.
function startModelPath(client) {
  if (!client || state.sshClient !== client) return Promise.resolve(state.modelPath || "none");
  if (state.modelPathClient === client) {
    if (state.modelPathInstall) return state.modelPathInstall;
    if (state.modelPath === "listening") return Promise.resolve("listening");
  }
  state.modelPathClient = client;
  state.modelPath = "installing";
  clearModelPathRepair(); // this attempt IS the repair
  const install = installReverseForward(client).then(
    (ok) => finishModelPath(client, ok),
    // installReverseForward answers false rather than rejecting, but a rejection
    // here must still settle the promise a claim is waiting on
    (e) => {
      tunnelLog("[phase] model path install failed: " + ((e && e.message) || e));
      return finishModelPath(client, false);
    }
  );
  state.modelPathInstall = install;
  return install;
}

// Where the far side's model path is, joining the install in flight if there is
// one. This is the claim's view: "listening" is the only answer that means a
// session's --base-url points at something that will answer. With nothing in
// flight and no path (a failed install, or a hop that has not started one), it
// asks once NOW rather than waiting for the repair clock: a claim is the moment
// the answer is needed, and the ask is bounded by the installer's own clocks
// (4s on silence, the ladder on a refusal).
async function awaitModelPath() {
  if (state.modelPath === "listening") return "listening";
  if (state.modelPathInstall) return state.modelPathInstall;
  if (!state.sshClient) return "none";
  return startModelPath(state.sshClient);
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
  // Started, NOT awaited. The far side's model path is a promise this hop makes
  // to the sessions that will be spawned over it, not a gate the user's connect
  // passes through: the connect is the thing on screen, and a far side that never
  // answers a global request used to park it here forever (0.1.46's report) — or,
  // with the 4s clock, for as long as it took for the clock to say the far side
  // was silent. Neither is necessary: the port is only needed at SPAWN time, and
  // host-core's claim awaits awaitModelPath() before it points a session's
  // --base-url anywhere. The gates below describe the hop itself and stay as they
  // were: a local forward, a live supervisor behind it, that supervisor's shape.
  startModelPath(client);
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
  startModelPath,
  awaitModelPath,
};
