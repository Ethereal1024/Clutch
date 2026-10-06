// Standalone check for llm-proxy.js's upstream URL joining.
// Run: node tests/llm-proxy.test.js
//
// /v1/... requests must land on ANY OpenAI-compatible upstream, including ones
// that carry their own path (e.g. Zhipu /api/paas/v4).

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const { joinUpstream, isLlmPath, getUpstream, getApiKey } = require("../ui/llm-proxy");
const { check, summary } = require("./harness");

// 1. deepseek-style upstream without a path: /v1 is stripped, URL is correct
check(
  joinUpstream("https://api.deepseek.com", "/v1/chat/completions") ===
    "https://api.deepseek.com/chat/completions",
  "deepseek root upstream joins cleanly"
);

// 2. zhipu upstream WITH a path: no /v1/... double-up (the original bug)
check(
  joinUpstream("https://open.bigmodel.cn/api/paas/v4", "/v1/chat/completions") ===
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  "zhipu path upstream joins without doubling"
);

// 3. openai/ollama upstream ending in /v1: keeps its own /v1
check(
  joinUpstream("https://api.openai.com/v1", "/v1/chat/completions") ===
    "https://api.openai.com/v1/chat/completions",
  "upstream ending in /v1 keeps its segment"
);

// 4. non-/v1 request paths (e.g. /models) pass through untouched
check(
  joinUpstream("https://open.bigmodel.cn/api/paas/v4", "/models") ===
    "https://open.bigmodel.cn/api/paas/v4/models",
  "non-v1 path appended to upstream"
);

// 4b. the proxy serves both wire protocols (and only those): the responses
// client must reach the upstream through the tunnel too, or the SSH-mode
// responses setup 404s from our own proxy
check(isLlmPath("/v1/chat/completions"), "chat completions path is served");
check(isLlmPath("/api/paas/v4/chat/completions"), "chat path served under a provider prefix");
check(isLlmPath("/v1/responses"), "responses path is served");
check(isLlmPath("/responses?stream=true"), "query string does not hide the path");
check(!isLlmPath("/v1/models"), "other API paths are still refused");
check(!isLlmPath("/v1/chat/completions/extra"), "only the exact resource path is served");
check(
  joinUpstream("https://open.bigmodel.cn/api/paas/v4", "/v1/responses") ===
    "https://open.bigmodel.cn/api/paas/v4/responses",
  "responses request joins the upstream the same way"
);

// 5. getUpstream(): env wins, then the settings file, then the deepseek default
const origEnv = process.env.CLUTCH_LLM_UPSTREAM;
delete process.env.CLUTCH_LLM_UPSTREAM;
// isolate from the real ~/.clutch/settings.json for the whole section
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-proxy-"));
const origHome = os.homedir;
os.homedir = () => tmp; // llm-proxy reads os.homedir()/.clutch/settings.json
try {
  check(getUpstream() === "https://api.deepseek.com", "no env/settings -> deepseek default (never hard-locked)");

  try {
    fs.mkdirSync(path.join(tmp, ".clutch"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".clutch", "settings.json"), JSON.stringify({ base_url: "https://open.bigmodel.cn/api/coding/paas/v4" }));
    check(getUpstream() === "https://open.bigmodel.cn/api/coding/paas/v4", "flat settings base_url overrides the deepseek default");

    // legacy profile map: the ACTIVE profile decides the upstream (and key)
    fs.writeFileSync(
      path.join(tmp, ".clutch", "settings.json"),
      JSON.stringify({
        profiles: {
          deepseek: { base_url: "https://api.deepseek.com", model: "deepseek-v4-flash", api_key: "sk-ds" },
          "zhipu-53": { base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3", api_key: "sk-zp" },
        },
        active: "zhipu-53",
      })
    );
    check(
      getUpstream() === "https://open.bigmodel.cn/api/paas/v4",
      "profiles: active profile's base_url is the upstream",
    );
    check(getApiKey() === "sk-zp", "profiles: active profile's api_key is used");
    fs.writeFileSync(
      path.join(tmp, ".clutch", "settings.json"),
      JSON.stringify({
        profiles: {
          deepseek: { base_url: "https://api.deepseek.com", model: "deepseek-v4-flash", api_key: "sk-ds" },
          "zhipu-53": { base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3", api_key: "sk-zp" },
        },
        active: "deepseek",
      })
    );
    check(getUpstream() === "https://api.deepseek.com", "profiles: switching active follows the switch");
    check(getApiKey() === "sk-ds", "profiles: switching active swaps the key");
  } finally {
    os.homedir = origHome;
  }

  process.env.CLUTCH_LLM_UPSTREAM = "https://api.moonshot.cn/v1";
  check(getUpstream() === "https://api.moonshot.cn/v1", "CLUTCH_LLM_UPSTREAM env wins");
} finally {
  if (origEnv === undefined) delete process.env.CLUTCH_LLM_UPSTREAM;
  else process.env.CLUTCH_LLM_UPSTREAM = origEnv;
}

summary("llm-proxy");

// ---- 6. a connection that dies mid-stream must not stay open ----
//
// The proxy sits between the agent (over the reverse-forward tunnel) and the
// provider, and both ends can die half-way through a streamed body. The one
// thing it may never do is leave the response OPEN: an accepted connection that
// nobody ever answers is exactly what the agent's read parks on until its own
// 240s budget runs out — the reported "the model sat in thinking long after the
// network was back". Real sockets below (a real upstream server, a real client
// request), so the closing behavior is observed, not read off the source.
const http = require("http");
const net = require("net");
const { startLlmProxy, stopLlmProxy } = require("../ui/llm-proxy");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// POST to the proxy and report how the response ENDED: a status, a complete
// body, or an aborted/errored read — plus whether it never ended at all.
function post(port, { path = "/v1/chat/completions", onChunk } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" } },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (onChunk) onChunk(res, body);
        });
        res.on("end", () => finish({ status: res.statusCode, body, ended: true }));
        res.on("aborted", () => finish({ status: res.statusCode, body, ended: false }));
        res.on("error", (e) => finish({ status: res.statusCode, body, ended: false, error: e }));
      }
    );
    req.on("error", (e) => finish({ status: 0, body: "", ended: false, error: e }));
    req.end("{}");
  });
}

// a real upstream that answers SSE by script; returns its port
async function upstream(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: srv.address().port };
}

(async () => {
  process.env.CLUTCH_API_KEY = "sk-unit"; // the proxy injects it; asserted below
  const origUpstream = process.env.CLUTCH_LLM_UPSTREAM;
  delete process.env.CLUTCH_LLM_UPSTREAM;
  try {
    // 6a. the provider drops the body mid-stream: the client's read FAILS FAST
    {
      let sawAuth = null;
      const up = await upstream((req, res) => {
        sawAuth = req.headers.authorization;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"delta":"he"}\n\n');
        setTimeout(() => res.socket.destroy(), 60); // the far side goes away
      });
      const port = await startLlmProxy("http://127.0.0.1:" + up.port);
      let partial = "";
      const t0 = Date.now();
      const out = await Promise.race([
        post(port, { onChunk: (_r, b) => (partial = b) }),
        new Promise((r) => setTimeout(() => r({ hung: true }), 5000)),
      ]);
      const ms = Date.now() - t0;
      check(!out.hung, "an upstream death mid-body does not leave the response open (the agent must not park on it)");
      check(out.ended === false, "…the response is torn down, not ended as if the stream were complete");
      check(partial.includes("he"), "…after the bytes that did arrive were delivered");
      check(ms < 3000, `…and the client learns of it at once, not at a read budget (took ${ms}ms)`);
      check(sawAuth === "Bearer sk-unit", "the proxy still injects the client's own API key upstream");
      stopLlmProxy();
      await new Promise((r) => up.srv.close(r));
    }

    // 6b. the CLIENT goes away mid-body: the upstream request is released, not
    //     left pumping into a socket nobody reads
    {
      let closedAt = 0;
      let startedAt = 0;
      const up = await upstream((req, res) => {
        startedAt = Date.now();
        req.on("close", () => (closedAt = Date.now()));
        res.on("close", () => (closedAt = Date.now()));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"delta":"hi"}\n\n'); // then nothing, forever
      });
      const port = await startLlmProxy("http://127.0.0.1:" + up.port);
      const t0 = Date.now();
      const out = await post(port, { onChunk: (res) => res.destroy() }); // the agent's window died
      check(out.ended === false, "the client's own abort ends its request (nothing to wait for)");
      for (let i = 0; i < 60 && !closedAt; i++) await new Promise((r) => setTimeout(r, 50));
      check(closedAt > 0, "the upstream request is destroyed when the client hangs up (no ghost upstream work)");
      check(
        closedAt === 0 || closedAt - t0 < 3000,
        `…promptly, not when the upstream timeout expires (${closedAt ? closedAt - t0 + "ms" : "never closed"})`
      );
      check(startedAt > 0, "…and the upstream request had really started before the client left");
      stopLlmProxy();
      await new Promise((r) => up.srv.close(r));
    }

    // 6c. an upstream that cannot be reached at all: still a plain 502 (the
    //     pre-existing behavior — a request that never opened must read as one)
    {
      const dead = await freePort(); // nothing listens here
      const port = await startLlmProxy("http://127.0.0.1:" + dead);
      const out = await post(port);
      check(out.status === 502 && /upstream LLM unreachable/.test(out.body),
            "an upstream that refuses the connection is still answered as 502");
      stopLlmProxy();
    }
  } finally {
    if (origUpstream === undefined) delete process.env.CLUTCH_LLM_UPSTREAM;
    else process.env.CLUTCH_LLM_UPSTREAM = origUpstream;
    delete process.env.CLUTCH_API_KEY;
  }

  summary("llm-proxy");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
