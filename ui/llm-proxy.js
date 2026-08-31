// Client-side LLM reverse proxy (Electron main process): accepts
// OpenAI-compatible /chat/completions, injects the client API key, forwards to
// the upstream provider, and streams the response back. The remote backend
// reaches it via the SSH -R tunnel (no remote internet/key needed). Honors the
// machine's HTTP proxy and surfaces the real upstream error.
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { ProxyAgent } = require("proxy-agent");

const UPSTREAM_TIMEOUT_MS = 90000;

let server = null;
let agent = null;

// Read ~/.clutch/settings.json; legacy {profiles, active} maps resolve to the active profile
function readSettingsFile() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".clutch", "settings.json"), "utf-8"));
    if (d && d.profiles) {
      return d.profiles[d.active] || {};
    }
    return d || {};
  } catch (e) {
    return {};
  }
}

// Upstream LLM endpoint: env first, then ~/.clutch/settings.json, then the
// DeepSeek default — any OpenAI-compatible base URL works.
function getUpstream() {
  const e = process.env;
  if (e.CLUTCH_LLM_UPSTREAM) return e.CLUTCH_LLM_UPSTREAM;
  const d = readSettingsFile();
  if (d.base_url) return d.base_url;
  return "https://api.deepseek.com";
}

// Client API key: env first, then the settings file, so a UI-saved key is honored
function getApiKey() {
  const e = process.env;
  if (e.CLUTCH_API_KEY) return e.CLUTCH_API_KEY;
  const d = readSettingsFile();
  if (d.api_key) return d.api_key;
  return "";
}

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

// Build the upstream URL: strip the SDK's /v1, append the remainder to the
// upstream's own path (which may carry one, e.g. Zhipu /api/paas/v4) — not new
// URL(path, base), whose leading "/" would replace that path.
function joinUpstream(upstream, reqUrl) {
  const [rawPath, search = ""] = reqUrl.split("?");
  const rel = rawPath.replace(/^\/v1(?=\/|$)/, "").replace(/^\//, "");
  const u = new URL(upstream);
  u.pathname = (u.pathname.endsWith("/") ? u.pathname : u.pathname + "/") + rel;
  u.search = search ? "?" + search : "";
  return u.href;
}

function startLlmProxy(upstream) {
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
        const target = new URL(joinUpstream(upstream || getUpstream(), req.url));
        const transport = target.protocol === "http:" ? http : https;
        const preq = transport.request(
          target,
          {
            method: "POST",
            agent: getAgent(target),
            headers: {
              "Content-Type": req.headers["content-type"] || "application/json",
              Accept: req.headers["accept"] || "application/json",
              Authorization: "Bearer " + getApiKey(),
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

module.exports = { startLlmProxy, stopLlmProxy, joinUpstream, getUpstream, getApiKey };
