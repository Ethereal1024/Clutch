// M1 engine loop, verified end-to-end on Linux: the REAL ui/bridge-shim.js
// (loaded the way a WebView page loads it) talks HTTP+SSE to the REAL
// android/host/bridge-server.js, whose handlers are the REAL android-host.js
// wiring of the REAL host-core state machine — only the ssh2 tunnel and the
// supervisor HTTP client are fakes, because there is no remote in the loop.
// This is the Linux stand-in for the device acceptance "clutchApi.baseUrl()
// walks through" and exercises the whole N1 bridge contract.
// Run: node tests/bridge-server.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const Module = require("module");
const origLoad = Module._load;

// N2 in test form: HOME points at a sandbox before any module reads homedir()
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-android-home-"));
const realHomedir = os.homedir.bind(os);
os.homedir = () => HOME;

const { createAndroidHost } = require("../android/host/android-host");

// ---- fakes: the ssh2 tunnel face + the supervisor HTTP client face ----
function fakeTunnel() {
  const state = {
    status: { active: true, url: "http://127.0.0.1:8891" },
    forwards: [],
    forwardClosed: false,
    connects: [],
    stopped: 0,
    progress: null,
    endCbs: [],
    logs: [],
  };
  return {
    state,
    tunnelStatus: () => state.status,
    restartRemoteServer: async () => true,
    openSessionForward: async (port) => {
      state.forwards.push(port);
      return { localPort: port + 1000, close: () => (state.forwardClosed = true) };
    },
    connectTunnel: async (cfg, onProgress) => {
      state.connects.push(cfg);
      state.progress = onProgress;
      return { ok: true, url: state.status.url };
    },
    stopTunnel: async () => {
      state.stopped += 1;
    },
    onTunnelEnd: (cb) => state.endCbs.push(cb),
    tunnelLog: (...a) => state.logs.push(a.join(" ")),
  };
}

function fakeSessions() {
  const calls = { started: [], stopped: [], shutdown: [] };
  let seq = 0;
  const beats = [];
  return {
    calls,
    beats,
    supervisorSessionStart: async (base, baseUrl) => {
      calls.started.push({ base, baseUrl });
      return { sessionId: "s" + ++seq, port: 30000 + seq };
    },
    supervisorSessionStop: (base, sid) => calls.stopped.push({ base, sid }),
    startSupervisorHeartbeat: (base, sid, onFail) => {
      const h = { base, sid, onFail };
      beats.push(h);
      return { stop: () => (h.stopped = true) };
    },
    supervisorShutdown: (base) => calls.shutdown.push(base),
  };
}

// ---- a lean SSE client over real HTTP: same frames the WebView consumes ----
class TestEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onopen = null;
    this.closed = false;
    TestEventSource.instances.push(this);
    http
      .get(url, (res) => {
        if (this.closed) return res.resume();
        if (this.onopen) this.onopen();
        let buf = "";
        let data = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("data:")) data += line.slice(5).trimStart() + "\n";
            }
            if (data && this.onmessage) {
              this.onmessage({ data: data.replace(/\n$/, "") });
            }
          }
        });
        res.on("error", () => {});
      })
      .on("error", () => {});
  }
  close() {
    this.closed = true;
  }
}
TestEventSource.instances = [];

async function eventually(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      return fn();
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw last || new Error("eventually: condition never held");
}

async function main() {
  const tunnel = fakeTunnel();
  const sessions = fakeSessions();
  const logs = [];
  const host = createAndroidHost({ tunnel, sessions, log: (...a) => logs.push(a.join(" ")) });

  // port 0 -> an OS-assigned loopback port; the shim is pointed at the result
  const server = await host.start();
  const BRIDGE = server.url;

  // readiness marker: the Kotlin shell polls for exactly this file (N2/N1 glue)
  assert.strictEqual(
    fs.readFileSync(path.join(HOME, "bridge.port"), "utf-8"),
    String(server.port),
    "bridge.port ready marker written under HOME (= filesDir on device)"
  );

  // cold-restart race: a marker left by a PREVIOUS process life must be
  // unlinked before the bind attempt — the shell polls at 150ms and would
  // otherwise read the dead port during the seconds the asset re-copy takes.
  // Prove it by planting a stale marker and forcing the bind to fail: a
  // failed boot must leave NO marker behind.
  {
    // The base is claimed from the OS (8899 itself may be held by the server
    // above, or by a real desktop shell on the dev box) and the WHOLE retry
    // range port..port+20 is occupied, so the boot has nowhere to walk to.
    // Every probe carries an 'error' handler: a bare net.Server turns an
    // EADDRINUSE into an unhandled 'error' event that kills the process.
    const holders = [];
    let base = -1;
    for (let round = 0; round < 3 && base === -1; round++) {
      const probe = new net.Server();
      const claimed = await new Promise((resolve) => {
        probe.on("error", () => resolve(false));
        probe.listen(0, "127.0.0.1", () => resolve(true));
      });
      if (!claimed) break;
      base = probe.address().port;
      holders.push(probe);
      let ok = true;
      for (let i = 1; i <= 20 && ok; i++) {
        const s = new net.Server();
        const got = await new Promise((resolve) => {
          s.on("error", () => resolve(false));
          s.listen(base + i, "127.0.0.1", () => resolve(true));
        });
        if (got) holders.push(s);
        else ok = false; // one port of the range was snatched: retry elsewhere
      }
      if (!ok) {
        holders.forEach((h) => h.close());
        holders.length = 0;
        base = -1;
      }
    }
    assert.notStrictEqual(base, -1, "could not claim a free 21-port range for the race test");
    fs.writeFileSync(path.join(HOME, "bridge.port"), "9999");
    const failing = createAndroidHost({
      tunnel,
      sessions,
      log: () => {},
      bridgePort: base,
    });
    await failing.start().then(
      () => {
        throw new Error("expected bind conflict, got a server");
      },
      (e) => {
        assert.strictEqual(
          (e && e.code) || "",
          "EADDRINUSE",
          `the boot must die of EADDRINUSE after the walk, got ${(e && e.message) || e}`
        );
      }
    );
    holders.forEach((s) => s.close());
    assert.strictEqual(
      fs.existsSync(path.join(HOME, "bridge.port")),
      false,
      "a failed boot must not leave a stale bridge.port for the shell to trip on"
    );
  }

  // load the shim the way a page would
  globalThis.CLUTCH_BRIDGE_BASE = BRIDGE;
  globalThis.EventSource = TestEventSource;
  delete require.cache[require.resolve("../ui/bridge-shim")];
  require("../ui/bridge-shim");

  // events first: subscriptions before any trigger
  const got = { base: [], progress: [], ended: [] };
  globalThis.clutchApi.onBaseChanged((u) => got.base.push(u));
  globalThis.clutchTunnel.onProgress((s) => got.progress.push(s));
  globalThis.clutchTunnel.onEnd(() => got.ended.push(true));
  await new Promise((r) => setTimeout(r, 250)); // let the SSE connection land

  // 1. the M1 acceptance call: baseUrl walks the full stack
  //    (shim -> bridge POST -> android-host -> host-core tunnel claim -> fake remote)
  const url = await globalThis.clutchApi.baseUrl();
  assert.strictEqual(url, "http://127.0.0.1:31001", "baseUrl resolves the forwarded session port");
  assert.strictEqual(sessions.calls.started[0].base, "http://127.0.0.1:8891", "session start hits the tunnel");
  assert.strictEqual(sessions.calls.started[0].baseUrl, "http://127.0.0.1:8892/v1", "remote LLM base via reverse forward");
  assert.deepStrictEqual(tunnel.state.forwards, [30001], "one session forward opened");

  // 2. settings mirror: save writes the flat file (0600) under the sandbox HOME
  assert.deepStrictEqual(
    await globalThis.clutchSettings.save({ api_key: "sk-x", base_url: "https://up.example", model: "m1" }),
    { ok: true },
    "save ok over the bridge"
  );
  const settingsPath = path.join(HOME, ".clutch", "settings.json");
  const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  assert.strictEqual(onDisk.api_key, "sk-x", "mirror carries the key");
  assert.strictEqual((fs.statSync(settingsPath).mode & 0o777), 0o600, "mirror stays 0600");
  assert.deepStrictEqual(
    await globalThis.clutchSettings.ensure({ api_key: "sk-x" }),
    { ok: true, healed: false },
    "a healthy mirror is left alone"
  );
  fs.rmSync(settingsPath);
  assert.deepStrictEqual(
    await globalThis.clutchSettings.ensure({ api_key: "sk-heal" }),
    { ok: true, healed: true },
    "a missing mirror heals"
  );

  // 3. tunnel.connect: cfg reaches the tunnel, progress flows back over SSE
  assert.deepStrictEqual(
    await globalThis.clutchTunnel.connect({ host: "r", user: "u" }),
    { ok: true, url: "http://127.0.0.1:8891" },
    "connect resolves with the tunnel status"
  );
  assert.deepStrictEqual(tunnel.state.connects, [{ host: "r", user: "u" }], "tunnel got the config");
  tunnel.state.progress("probe");
  await eventually(() => assert.deepStrictEqual(got.progress, ["probe"], "progress via real SSE"));

  // 4. backend:base-changed: kill the session heartbeat -> host-core re-claims
  //    and the SAME window handle pushes the new URL through SSE (N5 mapping)
  sessions.beats[0].onFail();
  await eventually(() => {
    assert.strictEqual(got.base.length, 1, "base-changed arrived once");
    assert.strictEqual(got.base[0], "http://127.0.0.1:31002", "the re-claimed URL is pushed");
  });
  assert.deepStrictEqual(tunnel.state.forwards, [30001, 30002], "self-heal opened a new forward");

  // 5. tunnel:ended broadcast
  tunnel.state.endCbs.forEach((cb) => cb());
  await eventually(() => assert.deepStrictEqual(got.ended, [true], "tunnel:ended via real SSE"));

  // 6. N4: disconnect releases the session (remote told, no local supervisor touched)
  assert.deepStrictEqual(await globalThis.clutchTunnel.disconnect(), { ok: true }, "disconnect ok");
  await eventually(() => assert.strictEqual(tunnel.state.stopped, 1, "tunnel stopped"));
  assert.deepStrictEqual(
    sessions.calls.stopped.map((s) => s.sid),
    ["s1", "s2"], // s1 died in the self-heal above, s2 in this disconnect
    "both live sessions were stopped"
  );
  assert.deepStrictEqual(sessions.calls.shutdown, [], "no supervisor shutdown on disconnect (that is stopAllBackends' job)");
  assert(tunnel.state.forwardClosed, "session forward closed");

  // 7. handler errors surface as rejections, like ipcRenderer.invoke
  tunnel.state.connects.length = 0;
  const orig = tunnel.connectTunnel;
  tunnel.connectTunnel = async () => {
    throw new Error("ssh handshake refused");
  };
  await assert.rejects(() => globalThis.clutchTunnel.connect({ host: "bad" }), /ssh handshake refused/, "error -> rejection");
  tunnel.connectTunnel = orig;

  // 8. parity with reality: every subscription shared ONE EventSource
  assert.strictEqual(TestEventSource.instances.length, 1, "one shared stream for all channels");

  await server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  os.homedir = realHomedir;
  console.log("bridge-server: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
