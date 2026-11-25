// GENERATED FILE — do not edit; edit src/host/ssh-tunnel.ts and run `npm run build:host`.
// source sha256: 6ffc280c13f68a807316dd0f24ac34861cd49474f1631c7942da6f67c6d974be

"use strict";
// SSH tunnel (ssh2) to a remote clutch-server, embedded in the Electron main
// process: local forward to the remote supervisor API, plus the reverse
// channels the far side dials back through (see tunnel-core's registry). Debug
// logging appends to ~/.clutch/tunnel.log (the auth secret itself is never
// written there — only whether one is offered).
//
// This file is the module's public face and its binding point. The tunnel itself
// is six modules over one state object: tunnel-core.js owns the state and the
// log, and the five below it (net -> remote -> bootstrap -> lifecycle -> connect)
// are required in dependency order and ATTACHED to an instance — each exports
// attach(ctx) and works only through what ctx carries. bind() makes one such
// instance for one tunnel id; the names exported here are the primary instance's,
// which is what ui/main.js and android/host/android-host.js require — plus the
// three by-name calls a shell holding more than one remote needs
// (connectTunnelOn/statusOf/stopTunnelOn) and the aggregate onTunnelEnd, which
// hears every bound tunnel and says which one ended.
Object.defineProperty(exports, "__esModule", { value: true });
const { tunnelLog, stateFor, tunnels, PRIMARY_KEY } = require("./tunnel-core");
const remote = require("./tunnel-remote");
const bootstrap = require("./tunnel-bootstrap");
const lifecycle = require("./tunnel-lifecycle");
const connect = require("./tunnel-connect");
const { execBridgeFor } = require("./exec-bridge");
// ---- binding ----
// One instance per STATE, made once and reused. attach() closes over the hop's
// own counters and its exec bridge, so a second instance over one state would be
// a second bridge on a second port for the same host. The cache is keyed by the
// state object rather than by the id it was asked for, because an id is not what
// distinguishes two instances: `tunnelFor("u@h:22")` and the primary tunnel the
// picker drives are the SAME tunnel once a dial named the primary — same state,
// so they must be the same instance (and the same bridge).
//
// `parts` supplies a part that is ALREADY built (a runner's fake wire, a fake
// lifecycle) instead of attaching the real one. That is the composition seam the
// hop modules used to expose as a require: what a test swaps is the part, not the
// module. An instance bound this way is not cached — it stands over the same
// state as its id, but with somebody else's parts.
const bound = new Map();
// ---- who hears that a tunnel ended ----
// Every bound state forwards its own end here with its id and the URL it was
// serving, and ONE set of callbacks hears all of them: a caller asks "tell me
// when a tunnel dies", not "tell me about this instance". Attached once per
// state (a rebound instance over the same state is the same hop), so a doubling
// would double every notification and make one outage look like two.
const endWatchers = new Set();
const watching = new WeakSet();
function watchEnd(st) {
    if (watching.has(st))
        return;
    watching.add(st);
    st.endListeners.add((id, url) => {
        for (const cb of endWatchers) {
            try {
                cb(id, url);
            }
            catch (e) {
                /* a watcher may not break the teardown under it */
            }
        }
    });
}
// (cb(id, url)) => unsubscribe. `id` is the tunnel's key (null for the window's
// own, un-named tunnel) and `url` the forward that died — the two facts a shell
// needs to release only the claims that hop was carrying.
function onTunnelEnd(cb) {
    if (typeof cb !== "function")
        return () => { };
    // the window's own tunnel is bound here even if this process never dialled with
    // an id: its end has to be heard before anybody waits for one
    primaryTunnel();
    endWatchers.add(cb);
    return () => endWatchers.delete(cb);
}
function bind({ id = null, parts = null } = {}) {
    const key = id == null ? null : String(id);
    const st = stateFor(id);
    const existing = bound.get(st);
    if (existing && !parts)
        return existing;
    const supplied = parts || {};
    const ctx = { id: key, st };
    // the DAG's order: each attach may read the parts before it, never after
    ctx.remote = supplied.remote || remote.attach(ctx);
    ctx.bootstrap = supplied.bootstrap || bootstrap.attach(ctx);
    // the bridge is keyed per INSTANCE, and an instance is one state
    ctx.bridge = supplied.bridge || execBridgeFor(key == null ? PRIMARY_KEY : key, ctx.remote.remoteExec);
    ctx.lifecycle = supplied.lifecycle || lifecycle.attach(ctx);
    ctx.connect = supplied.connect || connect.attach(ctx);
    watchEnd(st);
    if (!parts)
        bound.set(st, ctx);
    return ctx;
}
// The tunnel the window's own picker drives: the one no id has named yet, and
// the one a dial names (see tunnel-connect's state.id).
function primaryTunnel() {
    return bind({});
}
// The instance for a tunnel id — a durable key (user@host:port), never parsed,
// only held and compared.
function tunnelFor(id) {
    return bind({ id });
}
// List the tunnels this process holds a state for. Used by the backend picker to
// let the user choose which device a tab's session should run on.
function listTunnels() {
    const seen = new Map();
    for (const st of tunnels()) {
        const row = {
            tunnelId: st.id,
            active: Boolean(st.sshClient),
            url: st.currentUrl,
            target: st.target,
        };
        // One host is one row. Two states can carry the same key for a moment (the
        // window's own tunnel named for a host another instance already served), and
        // the picker must not offer the same machine twice: the live one wins.
        const previous = seen.get(row.tunnelId);
        if (!previous || (!previous.active && row.active))
            seen.set(row.tunnelId, row);
    }
    return [...seen.values()];
}
// ---- one endpoint at a time, by name ----
// The three calls a shell makes about a tunnel that is NOT the window's own: dial
// it, read it, drop it. The id is the key tunnel-core builds (user@host:port);
// `tunnelFor(id)` is the instance bound to it, so a dial cannot land on another
// endpoint's state, bridge or bridge port.
function connectTunnelOn(id, cfg, progress) {
    return tunnelFor(id).connect.connectTunnel(cfg, progress);
}
function statusOf(id) {
    return tunnelFor(id).lifecycle.tunnelStatus();
}
function stopTunnelOn(id, notify = false) {
    return tunnelFor(id).lifecycle.stopTunnel(notify);
}
module.exports = {
    bind,
    primaryTunnel,
    tunnelFor,
    tunnelLog,
    listTunnels,
    connectTunnelOn,
    statusOf,
    stopTunnelOn,
    // The old contract, on the primary instance. Arrow functions on purpose: they
    // read the primary at CALL time, so an instance bound later (or a rebind) is
    // not a load-order question.
    connectTunnel: (...a) => primaryTunnel().connect.connectTunnel(...a),
    stopTunnel: (...a) => primaryTunnel().lifecycle.stopTunnel(...a),
    remoteExec: (...a) => primaryTunnel().remote.remoteExec(...a),
    // the AGGREGATE (see above), not the primary's own listener: every bound
    // tunnel's end reaches this one callback with its id and URL
    onTunnelEnd,
    tunnelStatus: (...a) => primaryTunnel().lifecycle.tunnelStatus(...a),
    uploadFileViaExec: (...a) => primaryTunnel().remote.uploadFileViaExec(...a),
    openSessionForward: (...a) => primaryTunnel().lifecycle.openSessionForward(...a),
    restartRemoteServer: (...a) => primaryTunnel().lifecycle.restartRemoteServer(...a),
    chooseStrategy: (...a) => primaryTunnel().bootstrap.chooseStrategy(...a),
};
