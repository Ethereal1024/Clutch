// Standalone check for llm-proxy.js's upstream URL joining.
// Run: node ui/llm-proxy.test.js
//
// The proxy must forward the remote backend's /v1/... requests onto ANY
// OpenAI-compatible upstream, including ones that carry their own path
// (Zhipu /api/paas/v4, Ollama /v1, ...) — the original bug concatenated the
// URLs and produced /api/paas/v4/v1/chat/completions for Zhipu.

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const { joinUpstream, getUpstream, getApiKey } = require("./llm-proxy");

let failures = 0;
function check(ok, label) {
  console.log((ok ? "ok:   " : "FAIL: ") + label);
  if (!ok) failures++;
}

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

// 5. getUpstream(): env wins, then the settings file, then the deepseek default
const origEnv = process.env.CLUTCH_LLM_UPSTREAM;
delete process.env.CLUTCH_LLM_UPSTREAM;
try {
  check(getUpstream() === "https://api.deepseek.com", "no env/settings -> deepseek default (never hard-locked)");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-proxy-"));
  const origHome = os.homedir;
  os.homedir = () => tmp; // llm-proxy reads os.homedir()/.clutch/settings.json
  try {
    fs.mkdirSync(path.join(tmp, ".clutch"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".clutch", "settings.json"), JSON.stringify({ base_url: "https://open.bigmodel.cn/api/paas/v4" }));
    check(getUpstream() === "https://open.bigmodel.cn/api/paas/v4", "legacy flat settings base_url overrides the deepseek default");

    // multi-API profiles: the ACTIVE profile decides the upstream (and key)
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

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
