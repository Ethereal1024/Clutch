// GENERATED FILE — do not edit; edit src/host/ssh-tunnel.ts and run `npm run build:host`.
// source sha256: 2a39a7ad37bb420982469d88d27c2b23dc7f85bcac459118db9c17827491456f

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
// which is what ui/main.js and android/host/android-host.js require.
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
    const list = [];
    for (const st of tunnels()) {
        list.push({
            tunnelId: st.id,
            active: Boolean(st.sshClient),
            url: st.currentUrl,
            target: st.target,
        });
    }
    return list;
}
module.exports = {
    bind,
    primaryTunnel,
    tunnelFor,
    tunnelLog,
    listTunnels,
    // The old contract, on the primary instance. Arrow functions on purpose: they
    // read the primary at CALL time, so an instance bound later (or a rebind) is
    // not a load-order question.
    connectTunnel: (...a) => primaryTunnel().connect.connectTunnel(...a),
    stopTunnel: (...a) => primaryTunnel().lifecycle.stopTunnel(...a),
    remoteExec: (...a) => primaryTunnel().remote.remoteExec(...a),
    onTunnelEnd: (...a) => primaryTunnel().lifecycle.onTunnelEnd(...a),
    tunnelStatus: (...a) => primaryTunnel().lifecycle.tunnelStatus(...a),
    uploadFileViaExec: (...a) => primaryTunnel().remote.uploadFileViaExec(...a),
    openSessionForward: (...a) => primaryTunnel().lifecycle.openSessionForward(...a),
    restartRemoteServer: (...a) => primaryTunnel().lifecycle.restartRemoteServer(...a),
    chooseStrategy: (...a) => primaryTunnel().bootstrap.chooseStrategy(...a),
};
