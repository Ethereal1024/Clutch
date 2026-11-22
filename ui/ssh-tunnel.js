// GENERATED FILE — do not edit; edit src/host/ssh-tunnel.ts and run `npm run build:host`.
// source sha256: 6f308e2d7f68cd77cdd366de2690456c5d3ae70899aa33580bce41d42c42b771

"use strict";
// SSH tunnel (ssh2) to a remote clutch-server, embedded in the Electron main
// process: local forward to the remote supervisor API + reverse forward to the
// client-side LLM proxy. Debug logging appends to ~/.clutch/tunnel.log (the
// auth secret itself is never written there — only whether one is offered).
//
// This file is the module's public face and nothing else. The tunnel itself is
// six modules over one state object: tunnel-core.js owns the state and the log,
// and the five below it (net -> remote -> bootstrap -> lifecycle -> connect) are
// required in dependency order. The names exported here are the module's
// contract — ui/main.js, ui/exec-bridge.js (a lazy require, which is what keeps
// its cycle with this file from closing) and android/host/android-host.js.
Object.defineProperty(exports, "__esModule", { value: true });
const { tunnelLog, remoteLlmBase, servedLlmBase } = require("./tunnel-core");
const { remoteExec, uploadFileViaExec } = require("./tunnel-remote");
const { chooseStrategy } = require("./tunnel-bootstrap");
const { connectTunnel, startModelPath, awaitModelPath } = require("./tunnel-connect");
const { stopTunnel, onTunnelEnd, tunnelStatus, openSessionForward, restartRemoteServer, } = require("./tunnel-lifecycle");
// List all active tunnels: currently just the primary tunnel. In a multi-tunnel
// future this would return all instances in the registry.
function listTunnels() {
    const list = [];
    const primary = tunnelStatus();
    // Only include tunnels that have a target (i.e., are connected or have been connected)
    if (primary.target) {
        const tunnelId = `${primary.target.host}:${primary.target.user}:${primary.target.port}`;
        list.push({
            tunnelId,
            active: primary.active,
            url: primary.url,
            target: primary.target,
            modelPath: primary.modelPath,
        });
    }
    return list;
}
module.exports = {
    connectTunnel,
    stopTunnel,
    remoteExec,
    tunnelLog,
    remoteLlmBase,
    // the base this client is SERVING right now (null when it serves nothing): what
    // a session's heartbeat carries so its LLM endpoint can follow the model path
    // when a hop lands it on another port (ui/supervisor-client.js beatBody)
    servedLlmBase,
    // the far side's model path, installed beside the connect and awaited by the
    // session claim (host-core) rather than by the connect itself
    awaitModelPath,
    startModelPath,
    onTunnelEnd,
    tunnelStatus,
    uploadFileViaExec,
    openSessionForward,
    restartRemoteServer,
    chooseStrategy,
    listTunnels,
};
