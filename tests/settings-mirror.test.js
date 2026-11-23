// Settings-mirror self-heal check: ~/.clutch/settings.json is derived state
// (session children + the LLM proxy read it) that only a UI save recreates.
// The app must rebuild it from the renderer's localStorage copy when it went
// MISSING, must NOT touch an existing healthy file (manual edits), and must not
// guess at a file that exists and does not parse: that one is reported, its
// bytes left untouched.
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
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
      session: { defaultSession: { clearCache: async () => {} } },
    };
  }
  if (request === "os") {
    const real = origLoad.call(this, request, ...rest);
    return { ...real, homedir: () => FAKE_HOME };
  }
  return origLoad.call(this, request, ...rest);
};

const CFG = {
  base_url: "https://api.example.com",
  model: "m1",
  api_key: "sk-test",
  reasoning_effort: "",
  api_protocol: "responses",
};

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
  assert.strictEqual(onDisk.api_protocol, "responses", "healed file carries the wire protocol knob");

  // 2. existing healthy file -> untouched (manual edits preserved)
  fs.writeFileSync(SETTINGS, JSON.stringify({ base_url: "https://manual.example", custom: "keep" }));
  r = await ensure(null, CFG);
  assert.deepStrictEqual(r, { ok: true, healed: false }, "existing file is not clobbered");
  assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS, "utf-8")).custom, "keep", "manual keys survive");

  // 3. corrupt file -> REPORTED, bytes untouched. Deriving "nothing configured"
  // from a file that exists and does not parse is what let the next save write a
  // one-key object over a hand-edited file whose ssh_secrets were the only copy
  // of a cached password. The file is the user's; it stays where they can fix it.
  fs.writeFileSync(SETTINGS, "{not json");
  r = await ensure(null, CFG);
  assert.strictEqual(r.ok, false, "corrupt file is not silently replaced");
  assert.match(r.error, /cannot be read/, "and the answer says why: " + r.error);
  assert.match(r.error, /left untouched/, "and that its bytes were left alone");
  assert.strictEqual(fs.readFileSync(SETTINGS, "utf-8"), "{not json", "the corrupt bytes are still there");
  r = await save(null, { api_key: "k1" });
  assert.strictEqual(r.ok, false, "a save over a corrupt file is refused too");
  assert.strictEqual(fs.readFileSync(SETTINGS, "utf-8"), "{not json", "and writes nothing over it");

  // 3b. parses, but is not a settings object (an array) -> the same report: the
  // bytes exist and are not this file's document, so they are not "nothing set".
  fs.writeFileSync(SETTINGS, "[1,2,3]");
  r = await ensure(null, CFG);
  assert.strictEqual(r.ok, false, "a wrong-shaped document is not silently replaced either");
  assert.match(r.error, /does not hold a settings object/, "and the answer names the shape: " + r.error);
  assert.strictEqual(fs.readFileSync(SETTINGS, "utf-8"), "[1,2,3]", "its bytes are still there");

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

  // 6. the source mirror rides through the SAME save (report: "downloads and
  // uploads to the server still need a VPN"). On Android this file is the only
  // place mirrorPrefix() can read a mirror from, so what the UI's field writes has
  // to land here — merged next to whatever else the file holds, with the same
  // explicit rules as the knobs above: a value sets it, "" clears it, and a save
  // that does not mention it leaves it alone.
  fs.writeFileSync(SETTINGS, JSON.stringify({ base_url: "https://a", custom: "x", ssh_secrets: { "u@h:22": "s" } }));
  r = await save(null, { source_mirror: "  https://mirror.example/  " });
  assert.deepStrictEqual(r, { ok: true }, "a mirror-only save is a save");
  let withMirror = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
  assert.strictEqual(withMirror.source_mirror, "https://mirror.example/", "the mirror is written trimmed");
  assert.strictEqual(withMirror.custom, "x", "and the keys the LLM knobs do not own survive it");
  assert.strictEqual(withMirror.ssh_secrets["u@h:22"], "s", "the secret cache survives it too");
  assert.strictEqual(withMirror.base_url, "https://a", "as does the endpoint beside it");

  r = await save(null, { api_key: "k3" });
  withMirror = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
  assert.strictEqual(withMirror.source_mirror, "https://mirror.example/", "a save that does not mention the mirror keeps it (undefined keeps, like the knobs)");
  assert.strictEqual(withMirror.api_key, "k3", "while the key it does mention lands");

  r = await save(null, { source_mirror: "" });
  withMirror = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
  assert.strictEqual(withMirror.source_mirror, "", "an empty string clears the knob back to github.com");

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
