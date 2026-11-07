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

const { tunnelLog, remoteLlmBase, servedLlmBase } = require("./tunnel-core");
const { remoteExec, uploadFileViaExec } = require("./tunnel-remote");
const { chooseStrategy } = require("./tunnel-bootstrap");
const { connectTunnel, startModelPath, awaitModelPath } = require("./tunnel-connect");
const {
  stopTunnel,
  onTunnelEnd,
  tunnelStatus,
  openSessionForward,
  restartRemoteServer,
} = require("./tunnel-lifecycle");

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
};
