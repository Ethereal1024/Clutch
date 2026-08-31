// Local exec bridge for the SSH degradation layer, embedded in the Electron
// main process.
//
// The remote runs no Python at all, so the local Python agent talks to it
// through a single sh command. This bridge exposes that as a tiny HTTP endpoint
// on 127.0.0.1: it forwards POST /exec to the live ssh2 tunnel's remoteExec.
// Python side: SshTransport -> POST http://127.0.0.1:<port>/exec.
//
// Lazy-require of ssh-tunnel breaks the require cycle (ssh-tunnel starts this
// bridge inside connectTunnel/stopTunnel). The bridge is only reachable on the
// loopback interface; the tunnel's own SSH session is the only thing it can exec.

const http = require("http");

let server = null;

function startExecBridge() {
  server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/exec") {
      res.writeHead(404).end("not found");
      return;
    }
    const respond = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        const command = String(body.command || "");
        if (!command) {
          respond(400, { error: "command is required" });
          return;
        }
        const timeoutMs = Number(body.timeout) || 60000;
        const binary = !!body.binary;
        const { remoteExec } = require("./ssh-tunnel");
        const r = await remoteExec(command, timeoutMs, binary);
        if (binary) {
          // raw-byte read: return base64 (encoded CLIENT-side) so the remote
          // never needs its own base64 — only an sshd shell
          respond(200, { code: r.code, stdout_b64: r.stdout_b64 || "", stderr: r.stderr || "" });
        } else {
          respond(200, { code: r.code, stdout: r.stdout || "", stderr: r.stderr || "" });
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        respond(msg === "not connected" ? 503 : 500, { error: msg });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function stopExecBridge() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { startExecBridge, stopExecBridge };
