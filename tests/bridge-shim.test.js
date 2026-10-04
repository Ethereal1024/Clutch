// Bridge-shim contract check (R4): ui/bridge-shim.js must expose EXACTLY the
// window.clutch* surface of ui/preload.js — same namespaces, same method names,
// same arities — and reproduce its call semantics (invoke resolves / throws,
// event subscriptions return removers). Drift between the two breaks either
// the desktop or the Android renderer; this test is the tripwire.
// Run: node tests/bridge-shim.test.js
const assert = require("assert");
const path = require("path");
const Module = require("module");
const origLoad = Module._load;

// ---- capture preload's exposed surface through an electron stub ----
const exposed = {};
const fakeIpc = { invoke: async () => ({}), on: () => {}, removeListener: () => {} };
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          exposed[name] = api;
        },
      },
      ipcRenderer: fakeIpc,
    };
  }
  return origLoad.call(this, request, ...rest);
};
delete require.cache[require.resolve("../ui/preload")];
require("../ui/preload");
Module._load = origLoad;

// ---- load the shim the way a browser would, with a pinned bridge base ----
const BRIDGE = "http://127.0.0.1:9999/";
globalThis.CLUTCH_BRIDGE_BASE = BRIDGE;

const fakes = { fetches: [] };
globalThis.fetch = async (url, opts) => {
  fakes.fetches.push({ url, opts });
  return fakes.next || { json: async () => ({ ok: true, result: null }) };
};

class FakeES {
  constructor(url) {
    FakeES.instances.push(this);
    this.url = url;
    this.closed = false;
    this.onmessage = null;
  }
  close() {
    this.closed = true;
  }
  emit(event, args) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify({ event, args }) });
  }
}
FakeES.instances = [];
globalThis.EventSource = FakeES;

delete require.cache[require.resolve("../ui/bridge-shim")];
require("../ui/bridge-shim");

function arityOf(api) {
  const out = {};
  for (const ns of Object.keys(api)) {
    out[ns] = {};
    for (const m of Object.keys(api[ns])) out[ns][m] = api[ns][m].length;
  }
  return out;
}

async function main() {
  // 1. method-for-method parity with preload
  assert.deepStrictEqual(
    arityOf({
      clutchApi: globalThis.clutchApi,
      clutchSettings: globalThis.clutchSettings,
      clutchComponents: globalThis.clutchComponents,
      clutchTunnel: globalThis.clutchTunnel,
    }),
    arityOf(exposed),
    "shim surface == preload surface (names + arities)"
  );

  // 2. baseUrl: POST to the bridge endpoint, result unwrapped
  fakes.next = { json: async () => ({ ok: true, result: "http://127.0.0.1:45678" }) };
  assert.strictEqual(await globalThis.clutchApi.baseUrl(), "http://127.0.0.1:45678", "baseUrl resolves the result");
  assert.strictEqual(fakes.fetches.at(-1).url, BRIDGE + "api/clutchApi/baseUrl", "call hits the bridge API route");
  assert.strictEqual(fakes.fetches.at(-1).opts.body, "[]", "no args -> empty JSON array");

  // 2b. releaseSession: the conn-lost Cancel's verb, and it takes NO window id —
  //     the host reads the caller (one window on the phone, e.sender on the
  //     desktop), so a renderer cannot name another window's session
  fakes.next = { json: async () => ({ ok: true, result: { ok: true } }) };
  assert.deepStrictEqual(await globalThis.clutchApi.releaseSession(), { ok: true }, "releaseSession resolves the result");
  assert.strictEqual(fakes.fetches.at(-1).url, BRIDGE + "api/clutchApi/releaseSession", "releaseSession hits its own bridge route");
  assert.strictEqual(fakes.fetches.at(-1).opts.body, "[]", "and names no window: the host knows who asked");

  // 3. args travel as a JSON array
  fakes.next = { json: async () => ({ ok: true, result: { ok: true } }) };
  await globalThis.clutchSettings.save({ api_key: "k" });
  assert.strictEqual(fakes.fetches.at(-1).url, BRIDGE + "api/clutchSettings/save");
  assert.strictEqual(fakes.fetches.at(-1).opts.body, '[{"api_key":"k"}]', "args arrive as an array");

  // 4. {ok:false,error} rejects, like ipcRenderer.invoke when a handler throws
  fakes.next = { json: async () => ({ ok: false, error: "tunnel failed: bad host" }) };
  await assert.rejects(
    () => globalThis.clutchTunnel.connect({ host: "h" }),
    /tunnel failed: bad host/,
    "error payloads surface as rejections"
  );

  // 5. events: ONE shared SSE stream carries the IPC channel names
  const got = { progress: [], ended: [], base: [] };
  const offP = globalThis.clutchTunnel.onProgress((stage) => got.progress.push(stage));
  globalThis.clutchTunnel.onEnd((info) => got.ended.push(info));
  globalThis.clutchApi.onBaseChanged((url) => got.base.push(url));
  assert.strictEqual(FakeES.instances.length, 1, "all subscriptions share one stream");
  assert.strictEqual(FakeES.instances[0].url, BRIDGE + "events", "stream is the bridge /events route");

  FakeES.instances[0].emit("tunnel:progress", ["probe"]);
  FakeES.instances[0].emit("backend:base-changed", ["http://127.0.0.1:45679"]);
  FakeES.instances[0].emit("tunnel:ended", [{ lost: true }]);
  assert.deepStrictEqual(got.progress, ["probe"]);
  assert.deepStrictEqual(got.base, ["http://127.0.0.1:45679"]);
  assert.deepStrictEqual(got.ended, [{ lost: true }],
    "the payload travels whole: the host's per-window verdict is what the renderer decides on");

  // 6. unsubscribe removes only its own listener
  offP();
  FakeES.instances[0].emit("tunnel:progress", ["install"]);
  assert.deepStrictEqual(got.progress, ["probe"], "removed listener stays quiet");

  // 7. a throwing listener must not break the stream or its siblings
  //    (a good sibling is re-registered first: check 6 already removed the original)
  globalThis.clutchTunnel.onProgress((stage) => got.progress.push(stage));
  globalThis.clutchTunnel.onProgress(() => {
    throw new Error("bad listener");
  });
  FakeES.instances[0].emit("tunnel:progress", ["health"]);
  assert.deepStrictEqual(got.progress, ["probe", "health"], "stream survives a bad listener");

  console.log("bridge-shim: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
