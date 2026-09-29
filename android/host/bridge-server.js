// Android bridge server (M1): the loopback HTTP+SSE endpoint ui/bridge-shim.js
// speaks. The wire protocol is documented at the top of that file — this
// server is its host-side reference implementation, and the per-method
// semantics are ui/main.js's ipcMain handlers (both shells feed the same
// host-core / ssh-tunnel / settings-mirror underneath).
//
//   POST /api/<ns>/<method>   body: JSON array of args
//       -> { ok: true, result } | { ok: false, error }   (application errors
//          keep HTTP 200; the shim rejects on ok:false, matching how
//          ipcRenderer.invoke rejects when a main handler throws)
//   GET  /events              text/event-stream; every message data is
//          JSON {event, args} carrying the IPC channel names
//
// Loopback-only by construction (binds 127.0.0.1). CORS is wide open — same
// posture as agent/server.py — because the WebView origin
// (https://appassets.androidplatform.net) is cross-origin to this endpoint.
const http = require("http");

const MAX_BODY_BYTES = 2 * 1024 * 1024; // settings payloads, tunnel configs; way past any real one
const SSE_PING_MS = 15000;

function createBridgeServer({ port = 8899, portTries = 20, handlers, log = () => {} } = {}) {
  const sseClients = new Set();
  let pingTimer = null;

  function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  function sendJson(res, status, obj) {
    cors(res);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  async function route(req, res) {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "GET" && req.url === "/events") {
      cors(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n: connected\n\n");
      sseClients.add(res);
      if (!pingTimer) {
        // loopback has no middleboxes to appease; the ping keeps the WebView's
        // socket timers honest and makes liveness observable in logs
        pingTimer = setInterval(() => {
          for (const client of sseClients) client.write(": ping\n\n");
        }, SSE_PING_MS);
        pingTimer.unref();
      }
      req.on("close", () => {
        sseClients.delete(res);
        if (sseClients.size === 0 && pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      });
      return;
    }

    const m = req.method === "POST" && req.url.match(/^\/api\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/);
    if (!m) return sendJson(res, 404, { ok: false, error: `no such bridge route: ${req.method} ${req.url}` });
    const [, ns, method] = m;
    const fn = handlers[ns] && handlers[ns][method];
    if (typeof fn !== "function") {
      return sendJson(res, 404, { ok: false, error: `no such bridge method: ${ns}.${method}` });
    }

    let raw = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooBig = true;
        req.destroy(); // nothing sensible to answer a body this size with
      }
    });
    req.on("end", async () => {
      if (tooBig) return;
      let args;
      try {
        args = JSON.parse(raw || "[]");
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: "bridge call body is not valid JSON" });
      }
      if (!Array.isArray(args)) {
        return sendJson(res, 200, { ok: false, error: "bridge call body must be a JSON array of args" });
      }
      try {
        const result = await fn(...args);
        sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // one channel name -> one SSE frame to every open event stream
  function broadcast(channel, ...args) {
    if (sseClients.size === 0) return;
    const frame = `data: ${JSON.stringify({ event: channel, args })}\n\n`;
    for (const client of sseClients) client.write(frame);
  }

  async function close() {
    for (const client of sseClients) client.end();
    sseClients.clear();
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    await new Promise((r) => server.close(r));
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      log(`[bridge] handler crash: ${(e && e.stack) || e}`);
      try {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      } catch (_e) {
        /* response already gone */
      }
    });
  });

  // bind 127.0.0.1, walking up from the fixed port if a stale process holds it
  return new Promise((resolve, reject) => {
    let attempt = 0;
    server.on("error", (e) => {
      if (e && e.code === "EADDRINUSE" && attempt < portTries) {
        attempt += 1;
        server.listen(port + attempt, "127.0.0.1");
      } else {
        reject(e);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port;
      log(`[bridge] listening on http://127.0.0.1:${bound}`);
      resolve({ port: bound, url: `http://127.0.0.1:${bound}/`, broadcast, close });
    });
  });
}

module.exports = { createBridgeServer };
