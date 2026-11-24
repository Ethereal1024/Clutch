// Standalone check for llm-proxy.js: where the model endpoint and key come from,
// and how a request path joins an upstream.
// Run: node tests/llm-proxy.test.js
//
// /v1/... requests must land on ANY OpenAI-compatible upstream, including ones
// that carry their own path (e.g. Zhipu /api/paas/v4). The calls themselves are
// made by this process (llm-client); there is no proxy and no reverse forward.

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const { joinUpstream, getUpstream, getApiKey } = require("../ui/llm-proxy");
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

// 4b. both wire protocols the client can be configured for join the same way
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

  // a file that EXISTS and does not parse is NOT "nothing configured". Folding it
  // to the built-in default is what sent the user's requests to DeepSeek while
  // their own endpoint and key sat in bytes we had failed to read — and said
  // nothing. It is reported instead (the request fails with this message).
  const throwsWith = (fn, re, label) => {
    try {
      fn();
      check(false, label + " (no error thrown)");
    } catch (e) {
      check(re.test((e && e.message) || String(e)), label + " (" + ((e && e.message) || e) + ")");
    }
  };

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

    // corrupt bytes: reported, and the built-in default is NOT substituted
    fs.writeFileSync(path.join(tmp, ".clutch", "settings.json"), "{not json");
    throwsWith(() => getUpstream(), /cannot be read/, "corrupt settings file is reported, not defaulted");
    throwsWith(() => getApiKey(), /cannot be read/, "…and the key read reports it too");
    check(
      fs.readFileSync(path.join(tmp, ".clutch", "settings.json"), "utf-8") === "{not json",
      "…and the bytes are left where the user can fix them",
    );

    // a legacy map whose `active` name has no profile behind it: same answer
    fs.writeFileSync(path.join(tmp, ".clutch", "settings.json"), JSON.stringify({ profiles: {}, active: "gone" }));
    throwsWith(() => getUpstream(), /holds no such profile/, "an active profile that is absent is reported, not defaulted");

    // parses, but is not an endpoint object: the same "exists and is not
    // readable as settings" answer, not the built-in default
    fs.writeFileSync(path.join(tmp, ".clutch", "settings.json"), "[1,2,3]");
    throwsWith(() => getUpstream(), /does not hold a settings object/, "a wrong-shaped document is reported, not defaulted");

    // an EMPTY file is not corrupt: it is a machine nobody configured yet
    fs.writeFileSync(path.join(tmp, ".clutch", "settings.json"), "   ");
    check(getUpstream() === "https://api.deepseek.com", "a blank file is 'not configured yet', not a failure");
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
