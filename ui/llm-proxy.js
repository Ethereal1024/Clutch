// Client-side LLM reverse proxy, embedded in the Electron main process.
//
// Transparent: accepts OpenAI-compatible POST /chat/completions, injects the
// client's API key, forwards to the upstream provider, and streams the response
// (SSE, tools, reasoning_content) back byte-for-byte. The remote backend points
// --base-url at http://127.0.0.1:8892/v1 and the SSH -R reverse tunnel maps that
// port back here, so the remote server needs no internet and no API key.

const http = require("http");
const https = require("https");

const UPSTREAM = process.env.CLUTCH_LLM_UPSTREAM || "https://api.deepseek.com";
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.CLUTCH_API_KEY || "";

let server = null;

function startLlmProxy() {
  server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const target = new URL(UPSTREAM + req.url);
      const transport = target.protocol === "http:" ? http : https;
      const preq = transport.request(
        target,
        {
          method: "POST",
          headers: {
            "Content-Type": req.headers["content-type"] || "application/json",
            Accept: req.headers["accept"] || "application/json",
            Authorization: "Bearer " + API_KEY,
            "Content-Length": body.length,
          },
        },
        (pres) => {
          res.writeHead(pres.statusCode, { "Content-Type": pres.headers["content-type"] });
          pres.pipe(res);
        }
      );
      preq.on("error", () => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("upstream LLM unreachable");
      });
      preq.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function stopLlmProxy() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { startLlmProxy, stopLlmProxy };
