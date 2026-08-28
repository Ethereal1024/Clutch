// Client-side LLM reverse proxy, embedded in the Electron main process.
//
// Transparent: accepts OpenAI-compatible POST /chat/completions, injects the
// client's API key, forwards to the upstream provider, and streams the response
// (SSE, tools, reasoning_content) back byte-for-byte. The remote backend points
// --base-url at http://127.0.0.1:8892/v1 and the SSH -R reverse tunnel maps that
// port back here, so the remote server needs no internet and no API key.
//
// The upstream call honors the machine's HTTP proxy (env http_proxy/https_proxy/
// all_proxy, or the proxy in ~/.npmrc), has a timeout, and surfaces the real
// upstream error instead of a bare 502.

const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { ProxyAgent } = require("proxy-agent");

const UPSTREAM = process.env.CLUTCH_LLM_UPSTREAM || "https://api.deepseek.com";
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.CLUTCH_API_KEY || "";
const UPSTREAM_TIMEOUT_MS = 90000;

let server = null;
let agent = null;

function detectProxy() {
  const e = process.env;
  const fromEnv =
    e.https_proxy || e.HTTPS_PROXY || e.http_proxy || e.HTTP_PROXY || e.all_proxy || e.ALL_PROXY;
  if (fromEnv) return fromEnv;
  try {
    const npmrc = fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf-8");
    const m =
      npmrc.match(/^\s*https?-proxy\s*=\s*(\S+)/m) || npmrc.match(/^\s*proxy\s*=\s*(\S+)/m);
    if (m) return m[1];
  } catch (e) {
    /* no npmrc */
  }
  return undefined;
}

function getAgent(target) {
  const host = target.hostname;
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return undefined; // loopback upstream (local mock / tests): never proxy
  }
  if (!agent) {
    const proxy = detectProxy();
    if (proxy) agent = new ProxyAgent(proxy);
  }
  return agent;
}

function startLlmProxy() {
  server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const target = new URL(UPSTREAM + req.url);
        const transport = target.protocol === "http:" ? http : https;
        const preq = transport.request(
          target,
          {
            method: "POST",
            agent: getAgent(target),
            headers: {
              "Content-Type": req.headers["content-type"] || "application/json",
              Accept: req.headers["accept"] || "application/json",
              Authorization: "Bearer " + API_KEY,
              "Content-Length": body.length,
            },
          },
          (pres) => {
            res.writeHead(pres.statusCode, { "Content-Type": pres.headers["content-type"] || "application/json" });
            pres.pipe(res);
          }
        );
        preq.setTimeout(UPSTREAM_TIMEOUT_MS, () => preq.destroy(new Error("upstream timed out")));
        preq.on("error", (e) => {
          try {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("upstream LLM unreachable: " + (e && e.message));
          } catch (err) {
            /* response already started */
          }
        });
        preq.end(body);
      } catch (e) {
        // never let an upstream/parse failure become an uncaught main-process error
        try {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("proxy error: " + (e && e.message));
        } catch (err) {
          /* response already started */
        }
      }
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
