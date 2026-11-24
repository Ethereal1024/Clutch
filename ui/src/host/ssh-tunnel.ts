// SSH tunnel (ssh2) to a remote clutch-server, embedded in the Electron main
// process: local forward to the remote supervisor API, plus the reverse
// channels the far side dials back through (see tunnel-core's registry). Debug
// logging appends to ~/.clutch/tunnel.log (the auth secret itself is never
// written there — only whether one is offered).
//
// This file is the module's public face and nothing else. The tunnel itself is
// six modules over one state object: tunnel-core.js owns the state and the log,
// and the five below it (net -> remote -> bootstrap -> lifecycle -> connect) are
// required in dependency order. The names exported here are the module's
// contract — ui/main.js, ui/exec-bridge.js (a lazy require, which is what keeps
// its cycle with this file from closing) and android/host/android-host.js.

const { tunnelLog } = require("./tunnel-core");
const { remoteExec, uploadFileViaExec } = require("./tunnel-remote");
const { chooseStrategy } = require("./tunnel-bootstrap");
const { connectTunnel } = require("./tunnel-connect");
const {
  stopTunnel,
  onTunnelEnd,
  tunnelStatus,
  openSessionForward,
  restartRemoteServer,
} = require("./tunnel-lifecycle");

// List all active tunnels: currently just the primary tunnel. In a multi-tunnel
// future this would return instances from the registry.
function listTunnels() {
  const list = [];
  const primary = tunnelStatus();
  // Only include tunnels with a target (i.e., connected or once connected)
  if (primary.target) {
    const tunnelId = `${primary.target.host}:${primary.target.user}:${primary.target.port}`;
    list.push({
      tunnelId,
      active: primary.active,
      url: primary.url,
      target: primary.target,
    });
  }
  return list;
}

module.exports = {
  connectTunnel,
  stopTunnel,
  remoteExec,
  tunnelLog,
  onTunnelEnd,
  tunnelStatus,
  uploadFileViaExec,
  openSessionForward,
  restartRemoteServer,
  chooseStrategy,
  listTunnels,
};
