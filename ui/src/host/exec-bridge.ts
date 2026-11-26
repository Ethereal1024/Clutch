// Loopback HTTP bridge exposing one tunnel's remoteExec to the CLIENT's plugins
// (plugin-host.ts): a POST /exec runs one command on the far side of THAT tunnel
// and answers with its exit code and output. It is a capability of the window
// that holds the hop, not a second way to reach a workspace.
//
// One bridge per tunnel, keyed by the tunnel's id. The port a session posts to
// has to run its commands on the machine the session belongs to — with one
// shared bridge, a window pinned to A would reach whichever hop happened to be
// installed last. The bridge is handed the exec function it must call (its own
// instance's remoteExec) instead of reaching back into the tunnel module, which
// also removes the lazy require that used to exist only to break that cycle.
const http = require("http");

// key -> { server, port, exec }. A key's row exists only while its server does;
// stop removes it, so "is there a bridge" is one Map lookup.
const bridges = new Map();

function closeServer(entry) {
  if (!entry || !entry.server) return;
  const srv = entry.server;
  entry.server = null;
  entry.port = null;
  try {
    srv.close();
  } catch (e) {
    /* already closed */
  }
}

function startExecBridge(key, exec) {
  closeServer(bridges.get(key));
  const entry = { server: null, port: null, exec };
  bridges.set(key, entry);
  entry.server = http.createServer((req, res) => {
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
        const r = await entry.exec(command, timeoutMs, binary);
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
    entry.server.listen(0, "127.0.0.1", () => {
      entry.port = entry.server.address().port;
      resolve(entry.port);
    });
  });
}

function stopExecBridge(key) {
  const entry = bridges.get(key);
  if (!entry) return;
  bridges.delete(key);
  closeServer(entry);
}

// The bridge surface one bound tunnel works through, so a hop module calls
// start()/stop() without knowing the key or the exec function.
function execBridgeFor(key, exec) {
  return {
    start: () => startExecBridge(key, exec),
    stop: () => stopExecBridge(key),
    port: () => {
      const entry = bridges.get(key);
      return entry && entry.port != null ? entry.port : null;
    },
  };
}

module.exports = { startExecBridge, stopExecBridge, execBridgeFor };
