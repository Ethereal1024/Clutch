// Settings-mirror self-heal check: ~/.clutch/settings.json is derived state
// (session children + the LLM proxy read it) that only a UI save recreates.
// The app must rebuild it from the renderer's localStorage copy when it went
// missing/corrupt, and must NOT touch an existing healthy file (manual edits).
// Run: node tests/settings-mirror.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const origLoad = Module._load;

// isolated home so the test never touches the real ~/.clutch
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-settings-test-"));
const SETTINGS = path.join(FAKE_HOME, ".clutch", "settings.json");

// main.js needs electron + a redirected homedir; capture ipcMain.handle
// targets so the test can drive the real handlers
const handlers = new Map();
Module._load = function (request, ...rest) {
  if (request === "electron") {
    function BrowserWindow() {
      return { webContents: { id: 1 }, on: () => {}, loadFile: () => {} };
    }
    BrowserWindow.getAllWindows = () => [];
    return {
      app: {
        isPackaged: false,
        requestSingleInstanceLock: () => true,
        on: () => {},
        whenReady: () => Promise.resolve(),
        quit: () => {},
      },
      BrowserWindow,
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      session: { defaultSession: { clearCache: async () => {} } },
    };
  }
  if (request === "os") {
    const real = origLoad.call(this, request, ...rest);
    return { ...real, homedir: () => FAKE_HOME };
  }
  return origLoad.call(this, request, ...rest);
};

const CFG = { base_url: "https://api.example.com", model: "m1", api_key: "sk-test", reasoning_effort: "" };

async function main() {
  delete require.cache[require.resolve("../ui/main")];
  require("../ui/main");
  await new Promise((r) => setImmediate(r)); // whenReady callback registers the handlers
  const ensure = handlers.get("settings:ensure");
  const save = handlers.get("settings:save");
  assert(ensure && save, "settings:ensure and settings:save are registered");

  let r;

  // 1. missing file -> rebuilt from the renderer's copy
  r = await ensure(null, CFG);
  assert.deepStrictEqual(r, { ok: true, healed: true }, "missing file heals");
  const onDisk = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
  assert.strictEqual(onDisk.api_key, "sk-test", "healed file carries the key");
  assert.strictEqual(onDisk.base_url, "https://api.example.com", "healed file carries the upstream");

  // 2. existing healthy file -> untouched (manual edits preserved)
  fs.writeFileSync(SETTINGS, JSON.stringify({ base_url: "https://manual.example", custom: "keep" }));
  r = await ensure(null, CFG);
  assert.deepStrictEqual(r, { ok: true, healed: false }, "existing file is not clobbered");
  assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS, "utf-8")).custom, "keep", "manual keys survive");

  // 3. corrupt file -> heals
  fs.writeFileSync(SETTINGS, "{not json");
  r = await ensure(null, CFG);
  assert.strictEqual(r.healed, true, "corrupt file heals");

  // 4. blank object -> heals
  fs.writeFileSync(SETTINGS, "{}");
  r = await ensure(null, CFG);
  assert.strictEqual(r.healed, true, "blank file heals");

  // 5. save still merges (unknown keys preserved)
  fs.writeFileSync(SETTINGS, JSON.stringify({ base_url: "https://a", custom: "x" }));
  r = await save(null, { api_key: "k2" });
  assert.deepStrictEqual(r, { ok: true }, "save ok");
  const merged = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
  assert.strictEqual(merged.api_key, "k2", "save writes the key");
  assert.strictEqual(merged.custom, "x", "save preserves unknown keys");

  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  console.log("settings mirror: all passed");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
