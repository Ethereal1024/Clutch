// Loopback HTTP bridge exposing the ssh2 tunnel's remoteExec to the local
// Python agent (SshTransport). Lazy-require of ssh-tunnel breaks the cycle.
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
          // base64 encoded CLIENT-side so the remote only needs an sshd shell
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
