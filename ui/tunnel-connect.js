// GENERATED FILE — do not edit; edit src/host/tunnel-connect.ts and run `npm run build:host`.
// source sha256: 5f4d137e66c4a2bace132fa902319a79b9a468efe2817353cc3f6242f6bfdece

"use strict";
// one connect attempt — auth, the forwards, the health gate
//
// connectTunnel is the whole attempt: reuse a live tunnel, start the
// client-side exec bridge, authenticate, probe, install, then set up the
// forwards and gate on the health check through them. The gate has the last word: the
// forward must answer, and it must answer as a Clutch supervisor — a legacy
// shared server on the same port is refused by name.
Object.defineProperty(exports, "__esModule", { value: true });
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { Client } = require("ssh2");
const { tunnelLog, tunnelId, held, name, adoptPrimary, REMOTE_API_PORT, CONNECT_TIMEOUT_MS, channelFor } = require("./tunnel-core");
const { freePort, listen, waitForServer, probeServer, probeSupervisorShape } = require("./tunnel-net");
const { getSshSecret, saveSshSecret, forgetSshSecret } = require("./settings-mirror");
// ---- the instance ----
// One bound tunnel's dial. Everything that is per-hop is read from `ctx` at
// attach time — the state, the wire helpers, the bootstrap it installs through,
// the lifecycle it tears down with, and its own exec bridge — so connecting B
// cannot see, reuse or kill A's client. (The MOVE is a decision made on top of
// this, not by it: a caller that holds two bound tunnels keeps two hops.)
function attach(ctx) {
    // (the body below keeps the module's own indentation: this move lifted it whole,
    // and re-indenting 300-800 lines would have rewritten a diff whose point is that
    // nothing in them changed)
    const state = ctx.st;
    const { remoteExec } = ctx.remote;
    const { PROBE_CMD, parseProbe, installServer, installComponents, remoteServingState, } = ctx.bootstrap;
    const { stopTunnel, reopenForward, notifyEnd, startHealing, stopHealing } = ctx.lifecycle;
    const startExecBridge = () => ctx.bridge.start();
    const stopExecBridge = () => ctx.bridge.stop();
    // How long a dial that was reset before the handshake waits before its one more
    // ask. Short on purpose: the reset is either a moment that has already passed (a
    // rate limiter's answer, an sshd restarting) or something no wait will fix.
    const DIAL_RETRY_MS = 900;
    // How long a tunnel that is ALREADY up is given to answer before it is treated
    // as gone. The old probe allowed 2 s per request inside a 3 s budget: on a link
    // where one lost retransmission costs more than that, a healthy hop read as a
    // dead one and was torn down — which killed every other window's forward with it
    // (their "Connection lost" dialog) and made the tab switch that triggered it
    // report "connection failed" until the user retried. So the probe is patient,
    // and "no answer" is only a question: the far host is asked about itself over the
    // exec channel (a path the failed forward does not share) before anything is
    // replaced, exactly as the healer does.
    const REUSE_PROBE_MS = 6000;
    const REUSE_REQUEST_MS = 5000;
    // the far side's own verdict, bounded: an exec with no clock of its own can sit
    // on a dead wire for a minute
    const REUSE_EXEC_MS = 12000;
    // The shape probe's own retry (see the gate): long enough for a retransmission,
    // short enough that a port which really is silent still fails promptly.
    const SHAPE_RETRY_MS = 700;
    // How long the far side gets to say what is on ITS port when the health gate
    // failed. Bounded, because remoteExec's default is a minute and this question is
    // asked on a wire that just failed to carry an answer (the healer's rule).
    const HEALTH_EXEC_MS = 12000;
    // How many dials have begun in this process. An attempt compares its own number
    // with this one when it fails: a bigger number means somebody started a NEWER
    // connection while this one was still connecting, and that is the difference
    // between "the host reset us" and "a newer attempt took the wire from under us".
    // The shared tunnel state cannot answer it — a newer attempt nulls the client it
    // is replacing before it installs its own, so the loser would find an empty state
    // and read its own replacement as a teardown.
    let dialSeq = 0;
    function defaultKey() {
        for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
            const p = path.join(os.homedir(), ".ssh", name);
            try {
                if (fs.existsSync(p))
                    return fs.readFileSync(p);
            }
            catch (e) {
                /* keep trying */
            }
        }
        return undefined;
    }
    // A dial the wire reset before ssh2 ever reported a session. Nothing was
    // authenticated and nothing was asked of the far side, so this is a fact about
    // the PATH to the host (or the host's door), not about the credential — which is
    // what makes it worth one more ask and what the message has to say out loud.
    // Field report: "connecting to other hosts immediately says connection failed:
    // read ECONNRESET" — a peer or a middlebox sending RST at the TCP connect (a
    // firewall, a fail2ban ban's tail, sshd at MaxStartups, a VPN or proxy rule that
    // will not carry the port), and every one of those looks exactly like this.
    function resetBeforeHandshake(e) {
        const code = String((e && (e.code || e.errno)) || "");
        if (/^(ECONNRESET|ECONNABORTED|EPIPE)$/.test(code))
            return true;
        return /read ECONNRESET|ECONNABORTED|socket hang up|Connection lost before handshake/i.test(String((e && e.message) || e || ""));
    }
    // `target` is the host this attempt was FOR, and `tries` how many times the dial
    // was asked (a reset before the handshake is asked twice): a failure the user
    // reports has to name the host it happened on, because the same sentence arriving
    // for "other hosts" is the only way to tell a banned address from a broken path.
    function friendlyError(e, target, tries, answered) {
        const m = String((e && e.message) || e);
        const at = target ? `${target.host}:${target.port}` : "the SSH host";
        const port = (target && target.port) || 22;
        const asked = tries > 1 ? ` (asked ${tries} times)` : "";
        if (resetBeforeHandshake(e)) {
            // The same socket words are two different jobs, and the debug stream already
            // knows which: sshd's banner is the first thing it sends, so if one arrived
            // the far side DID answer and the cut came during key exchange (its own load,
            // or something that inspects the traffic), while no banner at all means the
            // reset came from the path. One is "ask the host", the other is "look at the
            // network" — and a verdict that cannot say which sends the user at both.
            const evidence = answered
                ? "sshd answered with its banner and the reset came after it, during key exchange"
                : "no byte of sshd's own banner arrived, so the reset came from the path, not from sshd";
            return (`${at} reset the TCP connection before the SSH handshake${asked} (${m}) — ${evidence}; ` +
                "nothing was authenticated, so the credential is not the problem: a firewall or " +
                `login ban, sshd at its connection limit, or a VPN/proxy in the way. Retry in a ` +
                `moment; if only port ${port} fails, and only from this network, ask the host for ` +
                "another SSH port (many carriers and offices reset port 22).");
        }
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
            return `SSH handshake timed out (${at})`;
        }
        if (m.includes("ECONNREFUSED") || m.includes("ENETUNREACH") || m.includes("EHOSTUNREACH")) {
            return `cannot reach the SSH host ${at} (nothing is listening there, or the route is blocked)`;
        }
        if (m.includes("Unable to exec")) {
            return "remote shell failed to run a command — the connection dropped or the device's SSH channel limit was hit";
        }
        return m;
    }
    async function connectTunnel({ host, user, port, password }, progress) {
        // The host this request is FOR. One tunnel belongs to one host, and the reuse
        // below is a reuse of THIS target or it is a lie: a live hop to A answering a
        // request for B reported success for B while every byte still went to A — the
        // picker then ticked B as connected over A's file system. A request for a
        // different host is a MOVE: the old hop is spent first, exactly as the
        // renderer's own switch does, and its failure cannot be papered over with the
        // tunnel it left behind.
        const target = { host, user, port: Number(port) || 22 };
        // The hop's KEY: `user@host:port`, and the name stateFor/tunnelFor answer for.
        // Nothing parses it — it is a name.
        const wantId = tunnelId(target.host, target.user, target.port);
        // A PINNED instance is the hop to the endpoint it was made for. Naming another
        // endpoint from here is not a move: the old single tunnel moved, and that took
        // every other tab's forward with it. A caller that needs another host dials
        // that endpoint as its OWN tunnel (main.js derives the id; ui/ssh-tunnel bind).
        if (state.pinned && state.id !== wantId) {
            const error = `this tunnel is the hop to ${state.id}; ${target.user}@${target.host}:${target.port} ` +
                "is a different endpoint — dial it as its own tunnel";
            tunnelLog("[connect] refused: " + error);
            return { ok: false, error };
        }
        // Somebody else may already hold this host: a tab dialled it as its own
        // endpoint, and that instance's client is the one the executor table hands
        // sessions to (tunnelFor(id) → that state). A second client to one host is a
        // second exec bridge and a second supervisor for one machine, so a live hop
        // that answers is reused as it is. One that does not is left alone — its own
        // healing owns it — and this dial opens the wire this request needs. Asked
        // BEFORE the name below, which is what makes the key name this state.
        if (!state.pinned && !state.sshClient) {
            const other = held(wantId);
            if (other && other !== state && other.sshClient && other.currentUrl) {
                const ask = await probeServer(other.currentUrl + "/api/health", REUSE_PROBE_MS, REUSE_REQUEST_MS);
                if (ask.up) {
                    tunnelLog(`[connect] reusing the hop another bound tunnel already holds for ${wantId}`);
                    // …and the window's own tunnel IS that hop from here on. A window that
                    // connects to a host a tab already opened must claim its own sessions
                    // THERE: left unnamed, the primary would answer "no hop" and the window's
                    // default slot would resolve to this machine (the picker showing ✓ over a
                    // file browser on the wrong one, before this hop was ever kept across a
                    // move and now for every tab-first dial).
                    if (adoptPrimary(wantId, state)) {
                        tunnelLog(`[connect] the window's own tunnel is now ${wantId}: the host this window is on`);
                    }
                    return { ok: true, url: other.currentUrl };
                }
                tunnelLog(`[connect] the hop another bound tunnel holds for ${wantId} did not answer (${ask.kind}); opening this request's own`);
            }
        }
        // The window's own tunnel is NAMED by this dial (the picker has one host), and
        // a key it held before goes with it: tunnelFor() must answer with the state
        // that really serves that host. A pinned instance was already named by
        // stateFor(id) and is refused above if the id differs.
        if (!state.pinned)
            name(state, wantId);
        if (state.sshClient) {
            const current = state.target;
            const same = current &&
                current.host === target.host &&
                current.user === target.user &&
                current.port === target.port;
            if (!same) {
                tunnelLog(`[connect] the live tunnel belongs to ${current ? `${current.user}@${current.host}:${current.port}` : "an unknown host"}; resetting it for ${user}@${host}:${target.port}`);
                await stopTunnel();
            }
            else {
                // Reuse a live tunnel — after asking it, patiently (REUSE_PROBE_MS). A hop
                // that cannot answer within one request timeout is a suspect, not a corpse:
                // the far host is asked about ITSELF before the tunnel is torn down, because
                // tearing it down is what took every other window's forward with it.
                const ask = state.currentUrl
                    ? await probeServer(state.currentUrl + "/api/health", REUSE_PROBE_MS, REUSE_REQUEST_MS)
                    : { up: false, kind: "no-url" };
                if (ask.up) {
                    tunnelLog("[connect] reusing live tunnel");
                    return { ok: true, url: state.currentUrl };
                }
                // Which side is dead? Over the exec channel, never over the forward that
                // just failed. SERVING (or UNMEASURABLE — a far host whose answer we cannot
                // hear is not a dead one) means the casualty is this client's own forward,
                // and re-opening it on the SAME local port is enough: the far host keeps
                // running, its sessions and their runs included.
                let verdict = null;
                try {
                    verdict = await remoteServingState(state.lastProbe || {}, REUSE_EXEC_MS);
                    tunnelLog(`[connect] live tunnel did not answer (${ask.kind}); far side reports ${verdict}`);
                }
                catch (e) {
                    tunnelLog("[connect] the far side could not be asked: " + ((e && e.message) || e));
                }
                if (verdict === "SERVING" || verdict === "UNMEASURABLE") {
                    if (await reopenForward(ask)) {
                        tunnelLog("[connect] forward rebound; reusing live tunnel");
                        return { ok: true, url: state.currentUrl };
                    }
                    tunnelLog("[connect] the forward could not be rebound for a far side that is still serving");
                }
                tunnelLog("[connect] existing tunnel is dead or still starting; resetting");
                await stopTunnel();
            }
        }
        // from here on the hop being built is this request's, and state.target says so
        // from the same step that installs the client (see the executor below): a second
        // dial reads the two together, so it can never see this request's client wearing
        // another request's host
        // the auth secret, resolved the way llm-proxy resolves the API key: an
        // explicit value from the caller first, then the ssh_secrets cache in the
        // settings mirror (typed once per host, reused on reconnect/restart)
        const cached = password ? "" : getSshSecret(host, user, port);
        const secret = password || cached;
        state.sftpUnavailable = false; // SFTP capability is per connection/host
        state.wireLost = null; // this attempt's wire, not the last one's
        // never log the secret itself — only whether one is being offered
        tunnelLog(`[connect] attempt host=${host} user=${user} port=${port || 22} secret=${secret ? "yes" : "no"}${cached ? " (cached)" : ""}`);
        // The client THIS attempt installed, held outside the try so the failure path
        // can tell whether it is still the dial that owns the wire (see the catch).
        let dialling = null;
        // how many times the dial was asked (outside the try for the same reason: the
        // verdict says "asked twice" when a reset earned the one more ask)
        let tries = 0;
        // whether sshd ever spoke on the CURRENT dial: its ident is the first thing it
        // sends (RFC 4253 §4.2), and ssh2 reports the reset as its own socket error
        // and nothing else, so this is the only witness there is to where the cut
        // happened. Reset per dial: "asked twice" must still name which ask answered.
        let banner = false;
        // this attempt's place in the queue of attempts (see dialSeq)
        const myDial = ++dialSeq;
        try {
            const localPort = await freePort();
            await startExecBridge(); // this instance's bridge; tunnelStatus asks it for its port
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
                // ...and because that count only ever counts PINGS, it is not the last
                // word on a transfer: ssh2 kills the wire when its pings go unanswered,
                // and a far side busy writing a 71 MB file can leave its sshd too busy to
                // answer one for a while. On 2026-11-21 07:45 that killed an upload 100 ms
                // after three of its SFTP acks arrived. The budget stays 45 s (a dead hop
                // must still be called out no later than the stream that rides it — see
                // tests/session-heartbeat-test.js, which reads this number), so the fix is
                // the other side of the coin: every SFTP ack an upload gets pokes the
                // counter back to zero (pokeKeepalive in tunnel-remote). A wire that is
                // really gone stops acking, and 45 s later this says so.
                keepaliveInterval: 15000,
                keepaliveCountMax: 3,
                agent: process.env.SSH_AUTH_SOCK,
                debug: (m) => {
                    if (/Remote ident:/.test(m))
                        banner = true;
                    tunnelLog("ssh2: " + m);
                },
            };
            // the same value covers both password auth and an encrypted-key passphrase
            if (secret) {
                opts.password = secret;
                opts.passphrase = secret;
            }
            const key = defaultKey();
            if (key)
                opts.privateKey = key;
            let client = null;
            const dialOnce = () => new Promise((resolve, reject) => {
                const c = new Client();
                tries += 1;
                banner = false; // this ask's own answer, not the previous one's
                client = c;
                dialling = c;
                state.sshClient = c;
                // the host this client is for: installed with the client, so the reuse gate
                // reads the two facts together (a client with no target is not reused)
                state.target = target;
                c.on("ready", resolve);
                c.on("error", reject);
                c.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish(secret ? [secret] : []));
                c.connect(opts);
            });
            if (progress)
                progress("auth");
            try {
                await dialOnce();
            }
            catch (e) {
                // Who owns the wire now decides everything: a client that is not this
                // attempt's is a NEWER dial (a second window, the picker's retry, the
                // outage redial on the other side of the move) that reset this one on its
                // way in — or no client at all, a teardown (the user's Disconnect, another
                // request's move to a different host) that stopped the tunnel under it.
                // Either way the reset was not the far side talking, so this attempt must
                // not ask again: that would be a third client over a wire somebody else is
                // using. It stops, and the verdict says whose reset it was — the raw socket
                // words ("read ECONNRESET") belong to that, not to a host that refused us.
                if (dialSeq !== myDial || state.sshClient !== dialling) {
                    const lost = new Error((e && e.message) || String(e));
                    lost.superseded = true;
                    lost.supersededBy = dialSeq !== myDial ? "newer" : state.wireLost ? "wire" : "stopped";
                    throw lost;
                }
                if (!resetBeforeHandshake(e) || tries > 1)
                    throw e;
                // One more ask, and only for a reset before the handshake: an RST at the
                // TCP connect is a rate limit, a ban finally expiring, a middlebox or an
                // sshd that has just been restarted — none of which is the far side's
                // verdict on this credential, and all of which usually clear in a second.
                // It is deliberately NOT retried once a session was up: a wrong secret on a
                // timer is how an address earns the ban it is complaining about (the same
                // rule ui/tunnel-ladder.js states for its backoff).
                tunnelLog(`[connect] ${host}:${target.port} reset the connection before the handshake (${(e && e.message) || e}); ` +
                    `${banner ? "sshd's banner had already arrived" : "no banner from sshd"}; asking once more`);
                if (state.sshClient === dialling)
                    state.sshClient = null; // a dead dial owns nothing
                dialling = null;
                await new Promise((r) => setTimeout(r, DIAL_RETRY_MS));
                await dialOnce();
            }
            tunnelLog("[phase] ssh ready");
            // the secret that authenticated is what the next connect reuses. Caching is
            // the side effect, not the connection: an unreadable settings.json is said
            // here and the hop stays up — the next connect simply asks again.
            if (password) {
                try {
                    saveSshSecret(host, user, port, password);
                }
                catch (e) {
                    tunnelLog(`[connect] connected, but the settings mirror could not cache the secret: ${(e && e.message) || e}`);
                }
            }
            if (progress)
                progress("probe");
            // The connection is over, however it ended. `end` is a FIN and ONLY a FIN:
            // ssh2 emits it from the socket's own 'end' (node_modules/ssh2/lib/client.js
            // :806-819), so a dropped radio, a reset, or a keepalive timeout emits
            // `close` alone. Listening for `end` only is why a dead tunnel kept being
            // handed out as this window's backend: the teardown never ran, `active`
            // stayed true, and the renderer had no way to learn the remote was gone
            // until its next request came back "Failed to fetch".
            let gone = false;
            const tunnelGone = (why, cause) => {
                if (gone)
                    return; // end and close both fire on a clean close
                gone = true;
                tunnelLog("[disconnect] tunnel " + why);
                stopHealing();
                // only the CURRENT client may tear down shared state
                if (state.sshClient !== client)
                    return;
                // the wire died on its own: a dial still building on it must say so rather
                // than report a stop (see this file's catch, and the upload's watchdog)
                state.wireLost = cause ? `${why} (${cause})` : why;
                // which tunnel and which URL this is, captured BEFORE the teardown clears
                // them: with more than one tunnel bound, an end notification that cannot
                // name its own hop makes every other hop's windows drop their claims
                const endedId = state.id;
                const endedUrl = state.currentUrl;
                state.sshClient = null;
                state.target = null; // the host this hop belonged to went with it
                state.currentUrl = null;
                if (state.localSrv) {
                    state.localSrv.close();
                    state.localSrv = null;
                }
                stopExecBridge();
                notifyEnd(endedId, endedUrl);
            };
            // runtime handlers (once per connection). Guard mutations of state.sshClient: a
            // stale tunnel's 'end' may fire after a reconnect and must not clobber it.
            client.on("tcp connection", (info, accept, reject) => {
                // Which channel is this? Only the ports this process asked the far side for
                // are reachable (tunnel-core's channel table); a port nobody asked for is
                // refused here rather than dialled blind. A row with no listener behind it
                // right now (the client module failed to start, or the tunnel is being torn
                // down) has nothing to route to either: refuse the forward instead of
                // calling net.connect(null), which throws synchronously inside this handler
                // — an uncaught throw in the main process takes the whole window down.
                const chan = channelFor(info.destPort);
                const local = chan && chan.local();
                if (!local) {
                    reject();
                    return;
                }
                const stream = accept();
                const proxy = net.connect(local, "127.0.0.1");
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
                if (e && (e.level === "client-timeout" || e.level === "client-socket"))
                    tunnelGone("lost the socket", e.message);
            });
            // bootstrap: make sure the server exists and is running on the remote
            const probeOut = await remoteExec(PROBE_CMD);
            const probe = parseProbe(probeOut.stdout);
            // An exec that timed out (code -1) or came back without the probe's own
            // markers is NOT "nothing is installed there". Reading it that way sent a
            // flaky reconnect into a full reinstall it did not need — and, with the old
            // stop patterns, into a loop it could not leave. Say what actually
            // happened.
            if (!probe.os || !probe.home) {
                const why = probeOut.code === -1
                    ? "the remote shell did not answer the capability probe in time"
                    : `the capability probe came back unreadable (exit ${probeOut.code})`;
                tunnelLog("[bootstrap] probe unusable: " + why + " :: " + (probeOut.stdout || "").slice(0, 200));
                state.wasDisconnected = false;
                return failConnect(client, "[bootstrap] probe unusable: " + why, why + " — the remote server was left untouched; reconnect.");
            }
            // "check", not "install": the gate below decides, and installServer
            // announces the install itself when there really is one to do
            if (progress)
                progress("check");
            const boot = await installServer(probe, { progress });
            if (boot && boot.ok === false) {
                // hard reject: nothing of this hop can serve the window, so the wire goes
                // with the verdict instead of being left open to nobody
                tunnelLog("[bootstrap] rejected: " + boot.error);
                state.wasDisconnected = false;
                return failConnect(client, "[bootstrap] rejected: " + boot.error, boot.error);
            }
            if (progress)
                progress("forward");
            return await establishForwardAndHealth(localPort, client, secret);
        }
        catch (e) {
            const raw = (e && e.message) || String(e);
            // A wire that died BY ITSELF below the handshake — during the bootstrap, or
            // under a 78 MB upload — throws whatever the failing call was doing ("not
            // connected", "the SSH connection dropped while the file was still
            // uploading"), and nothing marks it: the socket event is not this attempt's
            // to see. So the marker is read from the state, and the verdict then names
            // the link instead of the chore it was on.
            const verdict = state.wireLost && !(e && e.superseded)
                ? Object.assign(new Error(raw), { superseded: true, supersededBy: "wire" })
                : e;
            // "this attempt was replaced, not refused": its own socket error is the
            // reset another dial (or a teardown) caused, so reporting those words would
            // put a host's name next to a failure the host had nothing to do with
            const friendly = verdict && verdict.superseded
                ? verdict.supersededBy === "wire"
                    ? // the far side (or the path to it) cut us off mid-attempt: nothing here
                        // is about the user stopping anything, and nothing was installed
                        `${target.host}:${target.port} dropped the connection while this attempt was still connecting ` +
                            `(${raw}; the wire: ${state.wireLost}) — nothing on the far side was replaced; reconnect`
                    : verdict.supersededBy === "stopped"
                        ? `the tunnel was stopped while this attempt was still connecting (${raw})`
                        : `a newer connection attempt took the tunnel over while this one was still connecting; this one was stopped (${raw})`
                : friendlyError(e, target, tries || 1, banner);
            tunnelLog(`[error] connect failed: ${raw} -> ${friendly}`);
            // a cached secret that no longer authenticates is worse than none: drop it
            // so this path prompts again (and a typed one can take its place). Like the
            // save above, dropping it is a side effect of the attempt: a settings file
            // that cannot be written is said in the log, not raised over the real error.
            if (cached && /authentication/i.test(friendly)) {
                try {
                    forgetSshSecret(host, user, port);
                }
                catch (e) {
                    tunnelLog(`[connect] the stale cached secret could not be dropped: ${(e && e.message) || e}`);
                }
            }
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
            }
            else {
                tunnelLog("[error] a newer dial owns the tunnel now; leaving it alone");
            }
            return { ok: false, error: friendly };
        }
    }
    // The reverse forward: asking the far side to listen on a loopback port and
    // forward what arrives back here. It is one channel today — the client's plugin
    // endpoint (plugin-link), installed at CLAIM time, not at connect — and this is
    // the ladder every channel is installed by.
    //
    // It is a ladder, not a single ask, because a reconnect reaches this line
    // seconds after the previous hop died and the far sshd is still holding the old
    // listener: the bind comes back refused, and a moment later the port is free.
    // Retrying the SAME port is what lets a session that was already told a port keep
    // reaching this machine.
    //
    // Silence is a different answer from refusal. ssh2 answers forwardIn only when
    // the FAR side replies to the global request (SSH_MSG_GLOBAL_REQUEST:
    // node_modules/ssh2/lib/client.js invokes the callback from the reply handler,
    // and from nowhere else), so a middlebox, a hardened or non-OpenSSH sshd, or a
    // wedged request channel can leave the promise pending for as long as the client
    // object lives. The bind therefore gets a clock of its own (bindTimeoutMs) and
    // settles the moment the client says it is gone; a silent far side ends the
    // ladder there, without the port-0 ask, because asking twice into silence buys
    // nothing.
    //
    // A refusal on the preferred port, by contrast, is not proof the far side cannot
    // forward — only that it cannot forward on THAT port. When a channel has a
    // preferred port and the ladder exhausts it, the far side is asked to pick one
    // (port 0: RFC 4254 has sshd bind what it can and report the number) and the row
    // remembers the answer for every later hop.
    //
    // Nothing installed by this function is on the connect's critical path: the
    // connect's gates are the hop's own (a local forward, a live supervisor behind
    // it, that supervisor's shape), and the plugin channel is installed by the first
    // claim that could use it.
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
            const gone = () => done(failed("the connection closed before the far side answered the reverse-forward request", true));
            const done = (v) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
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
                timer = setTimeout(() => done(failed(`the far side did not answer the reverse-forward request within ${timeoutMs}ms`, true)), timeoutMs);
            }
            try {
                client.forwardIn("127.0.0.1", port, (err, assigned) => {
                    // forwardIn throws — it does not call back — on a socket that is already
                    // gone, and that throw would escape past this promise into the connect
                    if (err)
                        return done(failed(err)); // an ANSWER, however unwelcome: not silence
                    done({ ok: true, port: Number(assigned) || port });
                });
            }
            catch (e) {
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
    // It knows nothing about channels: the port IS the channel here, and the row
    // (and the memory of what landed) belongs to installReverseForward.
    async function bindReverseForwardWithLadder(client, port, opts = {}) {
        const tries = opts.tries || REVERSE_FORWARD_TRIES;
        const first = opts.retryMs || REVERSE_FORWARD_RETRY_MS;
        const cap = opts.maxWaitMs || REVERSE_FORWARD_MAX_WAIT_MS;
        const bindTimeoutMs = opts.bindTimeoutMs || REVERSE_FORWARD_BIND_TIMEOUT_MS;
        let last = "no attempt was made";
        for (let attempt = 1; attempt <= tries; attempt++) {
            // a newer connect owns the session now: this forward belongs to a dead one
            if (!client || state.sshClient !== client)
                return { ok: false, abandoned: true };
            const got = await bindReverseForward(client, port, bindTimeoutMs);
            if (got.ok)
                return { ok: true, port: got.port, attempt };
            if (state.sshClient !== client)
                return { ok: false, abandoned: true }; // tunnel died under us
            last = got.error;
            // Nothing answered, and nothing is going to: the far side either never
            // receives global requests on this session or is not there at all. Asking
            // again is the same question on the same wire, so it costs another clock and
            // teaches nothing; the answers a retry CAN be for are the far side's own
            // (a bind it refused while sshd released a dead hop's listener).
            if (got.silent)
                return { ok: false, silent: true, error: last };
            if (attempt >= tries)
                break;
            const wait = Math.min(first * Math.pow(2, attempt - 1), cap);
            tunnelLog(`[phase] reverse forward failed (try ${attempt}/${tries}, retry in ${wait}ms): ${last}`);
            await new Promise((r) => setTimeout(r, wait));
        }
        return { ok: false, error: last };
    }
    // Install ONE reverse channel: the port it prefers is asked for with the ladder,
    // and if the far side refuses that port rather than falling silent, it is asked to
    // pick a port for itself (port 0) — a port held by a hop it has not reaped yet
    // costs the channel a different port, not the connect. The port that really landed
    // is written to the row, so every later hop re-binds THAT port and the far side is
    // told where the channel went.
    //
    // `chan` is a row from tunnel-core's table, and nothing here knows which one it is:
    // the ladder, the silence rule, the port-0 fallback and the memory are the same
    // question for every channel the far side may reach this machine through.
    async function installReverseForward(client, chan, opts = {}) {
        if (!chan) {
            tunnelLog("[phase] reverse forward asked for a channel this process never registered; refused");
            return false;
        }
        // a channel granted a port earlier is re-bound on THAT port first: the far side
        // was told that number, so the same port costs a re-connect nothing. A channel
        // with no contract port has nothing to prefer and goes straight to the far
        // side's pick.
        const preferred = chan.remote() || chan.preferred;
        if (preferred != null) {
            const first = await bindReverseForwardWithLadder(client, preferred, opts);
            if (first.ok) {
                chan.setRemote(first.port);
                tunnelLog(`[phase] reverse forward listening 127.0.0.1:${first.port} -> ${chan.what} :${chan.local()}` +
                    (first.attempt > 1 ? ` (try ${first.attempt})` : ""));
                return true;
            }
            if (first.abandoned)
                return false;
            if (first.silent) {
                // the far side never answered — asking it for a port of its own is the SAME
                // question with a different number, and it would be silent about that too
                tunnelLog(`[phase] reverse forward unanswered (${first.error}); not asking for a port of its own (${chan.name})`);
                return false;
            }
            // the contract port is a contract, not a right: a listener we cannot reach and
            // cannot kill costs us a different port, not the connect.
            tunnelLog(`[phase] reverse forward on ${preferred} refused (${first.error}); asking the far side for a port of its own` +
                ` (${chan.name})`);
        }
        const second = await bindReverseForwardWithLadder(client, 0, { ...opts, tries: 1 });
        if (second.ok) {
            chan.setRemote(second.port);
            tunnelLog(`[phase] reverse forward listening 127.0.0.1:${second.port} (` +
                (preferred != null ? `chosen by the far side: ${preferred} is held` : "chosen by the far side") +
                `) -> ${chan.what} :${chan.local()}`);
            return true;
        }
        if (!second.abandoned && !second.silent) {
            tunnelLog(`[phase] reverse forward failed: the far side would not forward to us at all (${second.error}) (${chan.name})`);
        }
        return false;
    }
    // The one channel installed over a hop is the plugin path, and it is installed at
    // CLAIM time, not at connect (ui/plugin-link.js: a window's api:base -> offer),
    // because a claim is the first moment a session could call one: asking the far
    // side for a loopback port on every hop would be a listener held on that machine
    // for a facility nobody had used. What this file owes that channel is the routing
    // rule and the ladder, both generic — a row in `channels`, not a special case.
    // Failing a gate is not a reason to close a wire a NEWER dial may already own:
    // an attempt that lost the race fails BECAUSE of the reset the winner performed,
    // so an unguarded teardown here closes the very tunnel that just won. Same
    // identity rule as connectTunnel's catch and tunnelGone's, and for the same
    // reason — a stale attempt must not clobber a newer client.
    function failConnect(client, why, error) {
        tunnelLog(why);
        if (state.sshClient === client) {
            stopTunnel();
        }
        else {
            tunnelLog("[error] a newer dial owns the tunnel now; leaving it alone");
        }
        return { ok: false, error };
    }
    // Set up the bidirectional forwards and gate on the health check through the tunnel.
    async function establishForwardAndHealth(localPort, client, secret = "") {
        state.localSrv = net.createServer((sock) => {
            // a request racing the teardown must fail the socket, not the main
            // process: forwardOut on a null client throws before it can answer
            if (!state.sshClient)
                return sock.destroy();
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
            }
            catch (e) {
                tunnelLog("[error] forwardOut threw: " + ((e && e.message) || e));
                sock.destroy();
            }
        });
        await listen(state.localSrv, localPort);
        tunnelLog(`[phase] local forward listening 127.0.0.1:${localPort} -> remote 127.0.0.1:${REMOTE_API_PORT}`);
        // Nothing for the plugin path here: it is installed by the first claim of a
        // session on this hop (ui/plugin-link.js offer, from main.js's api:base).
        const up = await waitForServer("http://127.0.0.1:" + localPort + "/api/health", CONNECT_TIMEOUT_MS);
        if (!up) {
            // TWO machines can be the reason this gate failed, and the verdict used to
            // name neither: the far side may have nothing listening (nothing to answer
            // with), or it may be serving while THIS hop's forward is the casualty (a
            // channel its sshd refused, a local port whose listener died under it). So
            // ask the far side about its own port over exec — the path the failed forward
            // does not share, exactly as the healer asks it — and put the answer in the
            // sentence the user sees. Best-effort by construction: the gate has already
            // failed, and a far side that cannot be asked must not change that verdict or
            // hold it open (the ask has its own clock; ssh2's exec throws on a dead wire).
            let far = "";
            try {
                far = await remoteServingState(state.lastProbe || {}, HEALTH_EXEC_MS);
            }
            catch (e) {
                far = "could not be asked: " + ((e && e.message) || e);
            }
            tunnelLog(`[health] the far side reports ${far || "nothing at all"} on 127.0.0.1:${REMOTE_API_PORT}`);
            const why = far === "SERVING"
                ? `the far side serves 127.0.0.1:${REMOTE_API_PORT}, but this hop's forwarded port never answered — the wire, not the server; reconnect`
                : far === "DOWN"
                    ? `nothing is listening on the far side's 127.0.0.1:${REMOTE_API_PORT} (its server is not running) — reconnect`
                    : "backend not reachable on the remote host";
            return failConnect(client, "[health] FAIL: " + why, why);
        }
        // "the port answers" and "it is OUR supervisor" are two questions, and this one
        // used to get a single 3 s clock right after a gate that may have spent 15: a
        // stalled retransmission there reported a supervisor that was running fine as
        // "a non-supervisor server", which on a tab switch is one more way to be told
        // the connection failed over a wire that was merely slow. Silence gets one more
        // ask; a "foreign" body is a real answer and is not retried.
        const base = "http://127.0.0.1:" + localPort;
        let shape = await probeSupervisorShape(base);
        if (shape === "down") {
            tunnelLog("[connect] the supervisor shape probe went unanswered; asking again");
            await new Promise((r) => setTimeout(r, SHAPE_RETRY_MS));
            shape = await probeSupervisorShape(base);
        }
        if (shape !== "up") {
            return failConnect(client, "[health] FAIL: remote 8890 is not a Clutch supervisor (legacy shared server?)", "remote 8890 runs a non-supervisor server (a legacy shared clutch-server?). " +
                "Restart it (pkill -f agent-server) and reconnect, or close the old app.");
        }
        tunnelLog(`[connect] OK url=http://127.0.0.1:${localPort}`);
        state.currentUrl = "http://127.0.0.1:" + localPort;
        state.wasDisconnected = false;
        startHealing();
        // the pass is not awaited (see ui/src/host/tunnel-bootstrap.ts): what it did
        // goes to the tunnel log, and the plugin tab reads what a place HOLDS from that
        // place's own inventory instead of from an older report of a pass. `exec` and
        // `secret` are the same wire and the same secret this connect authenticated
        // with: the pass installs a component's own facilities (curl) on the machine
        // that runs it, and sudo -S is fed over stdin so the secret never joins a
        // remote command line.
        installComponents(state.currentUrl, { exec: remoteExec, secret });
        return { ok: true, url: state.currentUrl };
    }
    return {
        connectTunnel,
        installReverseForward,
    };
}
// The old direct-require names resolve against the primary tunnel; `attach` is
// this module's own export (see tunnel-core's compatSurface).
module.exports = require("./tunnel-core").compatSurface("connect", ["connectTunnel", "installReverseForward"], {
    attach,
});
