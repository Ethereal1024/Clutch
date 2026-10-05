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
      // OS-assigned local port: a fresh one per open, like the real forwarder
      return { localPort: 31000 + state.forwards.length, close: () => (state.forwardClosed = true) };
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
  const calls = { started: [], stopped: [], shutdown: [], heartbeats: [] };
  let seq = 0;
  const beats = [];
  const self = {
    calls,
    beats,
    sessionAlive: true,
    supervisorSessionStart: async (base, baseUrl) => {
      calls.started.push({ base, baseUrl });
      return { sessionId: "s" + ++seq, port: 30000 + seq };
    },
    supervisorSessionStop: (base, sid) => calls.stopped.push({ base, sid }),
    supervisorSessionHeartbeat: async (base, sid) => {
      calls.heartbeats.push({ base, sid });
      return self.sessionAlive;
    },
    startSupervisorHeartbeat: (base, sid, onFail) => {
      const h = { base, sid, onFail };
      beats.push(h);
      return { stop: () => (h.stopped = true) };
    },
    supervisorShutdown: (base) => calls.shutdown.push(base),
  };
  return self;
}

// ---- the target machine's supervisor face: the component endpoints ONLY ----
// A real HTTP server, because ui/components.js reads a machine's components with
// fetch, exactly the way it reads the machine on the far side of a tunnel; only
// the answers are canned. So the loop the phone runs (shim -> bridge -> host ->
// components-view -> HTTP) is the real one, with one fake at the far end.
function fakeTargetSupervisor() {
  // a name no dev checkout beside this repo can shadow: the market row has to be
  // the release this test publishes, on every machine, not a local edit
  const NAME = "clutch-probe";
  const PIN = "b".repeat(64); // what the published manifest pins
  const VERSION = "0.1.0+" + PIN.slice(0, 16); // what an install of it records
  const HELD = "c".repeat(64); // other bytes of the same component, already there
  const HELD_VERSION = "0.1.0+" + HELD.slice(0, 16);
  const ARTIFACT = `${NAME}.tar.gz`;
  const state = { calls: [], install: null };
  const server = http.createServer((req, res) => {
    state.calls.push(`${req.method} ${req.url}`);
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // the release: a manifest naming an artifact for `any` platform, so the
    // target machine is the one that would fetch the bytes (this client has none)
    if (req.method === "GET" && req.url === "/clutch-component.json") {
      return send(200, {
        schema: 1,
        name: NAME,
        interface: "cli",
        version: "0.1.0",
        artifacts: { any: { asset: ARTIFACT, sha256: PIN } },
      });
    }
    if (req.method === "GET" && req.url === "/api/components") {
      return send(200, {
        components: [
          { name: NAME, version: HELD_VERSION, interface: "cli", digest: HELD, path: `/data/components/${NAME}` },
        ],
      });
    }
    if (req.method === "GET" && req.url.startsWith("/api/components/versions")) {
      return send(200, {
        versions: [
          { name: NAME, version: HELD_VERSION, interface: "cli", digest: HELD, path: `/data/components/${NAME}`, resolved: true },
        ],
      });
    }
    if (req.method === "POST" && req.url === `/api/components/${NAME}/disable`) {
      return send(200, { status: "disabled", name: NAME, disabled: true });
    }
    if (req.method === "DELETE" && req.url.startsWith(`/api/components/${NAME}`)) {
      return send(200, { status: "removed", name: NAME, removed: [HELD_VERSION] });
    }
    if (req.method === "POST" && req.url === "/api/components/install") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        state.install = {
          bytes: Buffer.byteLength(raw),
          manifest: JSON.parse(Buffer.from(req.headers["x-clutch-component"] || "", "base64").toString("utf8")),
        };
        send(200, {
          status: "installed",
          name: NAME,
          version: VERSION,
          digest: PIN,
          path: `/data/components/${NAME}`,
        });
      });
      return;
    }
    return send(404, { error: `no such endpoint: ${req.method} ${req.url}` });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ state, name: NAME, artifact: ARTIFACT, base, pin: PIN, version: VERSION, held: HELD_VERSION, manifestUrl: `${base}/clutch-component.json`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// one raw POST to the bridge, for the calls the shim does not expose (an unknown
// method), so the sentence from the bug report can be checked at the wire.
function bridgePost(base, urlPath, args = []) {
  const body = JSON.stringify(args);
  return new Promise((resolve, reject) => {
    const req = http.request(
      base.replace(/\/$/, "") + urlPath,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
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
  globalThis.clutchTunnel.onEnd((info) => got.ended.push(info));
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

  // 4. backend:base-changed: the session heartbeat gives up -> the claim is
  //    re-bound to the SAME far-side session (the SESSION survived the drop;
  //    only this client's forward died) and the SAME window handle pushes the
  //    new URL through SSE (N5 mapping)
  sessions.beats[0].onFail();
  await eventually(() => {
    assert.strictEqual(got.base.length, 1, "base-changed arrived once");
    assert.strictEqual(got.base[0], "http://127.0.0.1:31002", "the re-bound forward's URL is pushed, never the dead one");
  });
  assert.deepStrictEqual(tunnel.state.forwards, [30001, 30001], "re-bind re-opened the forward to the SAME far-side session");
  assert.strictEqual(sessions.calls.started.length, 1, "no stop + start over work in flight");
  assert.deepStrictEqual(sessions.calls.stopped, [], "the far-side session is never told to stop");
  assert.deepStrictEqual(sessions.calls.heartbeats, [{ base: "http://127.0.0.1:8891", sid: "s1" }],
    "the re-claim asks the supervisor first: it alone knows the session is still there");

  // 4b. the session is PROVABLY gone (the supervisor says no): only then is
  //     the claim replaced the old way — stop the husk, start a new session
  sessions.sessionAlive = false;
  sessions.beats[1].onFail();
  await eventually(() => {
    assert.strictEqual(got.base.length, 2, "second base-changed for the replacement");
    assert.strictEqual(got.base[1], "http://127.0.0.1:31003", "the replacement session's URL is pushed");
  });
  assert.deepStrictEqual(tunnel.state.forwards, [30001, 30001, 30002], "a new forward for the new session");
  assert.deepStrictEqual(sessions.calls.stopped.map((s) => s.sid), ["s1"], "the dead session's husk is stopped");
  sessions.sessionAlive = true;

  // 5. tunnel:ended broadcast — with the host's per-window verdict
  tunnel.state.endCbs.forEach((cb) => cb());
  await eventually(() => assert.deepStrictEqual(got.ended, [{ lost: true }],
    "tunnel:ended via real SSE, carrying this window's own verdict"));

  // 5b. one window leaving its session (the conn-lost Cancel's verb, `session:release`
  //     in the shells): over the bridge it is `releaseSession`, it names no window
  //     (the host knows who asked) and it stops the shared tunnel only when nobody is
  //     left on it. The claim has to be released either way: the page reloads after
  //     it, and a claim that outlived the exit is handed straight back to the boot.
  const stoppedBefore = tunnel.state.stopped;
  assert.deepStrictEqual(await globalThis.clutchApi.releaseSession(), { ok: true }, "releaseSession resolves over the bridge");
  assert.strictEqual(tunnel.state.stopped, stoppedBefore + 1,
    "the claim it just released was the last one on the hop: now the tunnel may stop");

  // 6. N4: disconnect releases the session (remote told, no local supervisor touched)
  assert.deepStrictEqual(await globalThis.clutchTunnel.disconnect(), { ok: true }, "disconnect ok");
  await eventually(() => assert.strictEqual(tunnel.state.stopped, stoppedBefore + 2, "tunnel stopped"));
  assert.deepStrictEqual(
    sessions.calls.stopped.map((s) => s.sid),
    ["s1", "s2"], // s1 replaced in the provably-gone step above, s2 in this disconnect
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

  // 9. the plugin tab on the phone: the SAME `clutchComponents` channel the
  //    desktop shell serves (ui/main.js:173-197), registered in the Android host.
  //    Before this, every line of the tab ended at "no such bridge method:
  //    clutchComponents.list" (PLUGIN_PLAN.md 零之三.3); what the page reads now
  //    is the target machine's own answers.
  {
    const sup = await fakeTargetSupervisor();
    const realFetch = globalThis.fetch;
    // This runner has no internet: the shipped source list is four GitHub
    // releases, so every URL but the fake target machine's is refused. Those
    // refusals land in the market as its "why is this empty" rows, which keeps
    // the read deterministic and offline.
    globalThis.fetch = (url, opts) => {
      const u = String(url);
      if (u.startsWith(sup.base) || u.startsWith(BRIDGE)) return realFetch(url, opts);
      return Promise.reject(new Error("no network in this test"));
    };
    try {
      // this client's OWN list names one manifest, and it names it the way a
      // release does — a URL. The phone reads it over HTTP, not from disk.
      const userSources = path.join(HOME, ".clutch", "components.sources.json");
      fs.mkdirSync(path.dirname(userSources), { recursive: true });
      fs.writeFileSync(userSources, JSON.stringify({ schema: 1, sources: [sup.manifestUrl] }));
      // the window's session is on the far side of the tunnel: components are
      // installed on the machine that will RUN them, so that is the target
      tunnel.state.status = { active: true, url: sup.base };

      const progress = [];
      globalThis.clutchComponents.onProgress((stage) => progress.push(stage));
      await new Promise((r) => setTimeout(r, 250)); // let the subscription land

      // 9a. what the target machine holds — the read that used to be an error
      const listed = await globalThis.clutchComponents.list();
      assert.deepStrictEqual(listed.target, { kind: "remote", base: sup.base },
        "the target is the tunnel's machine, not this phone");
      assert.strictEqual(listed.error, null, "the inventory answered");
      assert.strictEqual(listed.held[0].name, sup.name);
      assert.strictEqual(listed.held[0].version, sup.held);
      assert(sup.state.calls.includes("GET /api/components"), "the inventory really came from the far supervisor");

      // 9b. the market: what this client could hand that machine
      const mkt = await globalThis.clutchComponents.market({});
      const row = mkt.entries.find((e) => e.name === sup.name);
      assert(row, "the manifest this client holds shows up as a market row");
      assert.strictEqual(row.origin, "release");
      assert.strictEqual(row.source, sup.manifestUrl, "the row names where the release is");
      assert(mkt.errors.length > 0, "an unreadable source is named, never hidden");
      assert(mkt.errors.every((r) => !r.includes(sup.base)), "the one reachable source never failed");

      // 9c. the one write: the bytes stay on the far side — the request carries
      //     the URL and the pin, never the tens of megabytes (零之四.4)
      const res = await globalThis.clutchComponents.install(sup.name);
      assert.strictEqual(res.ok, true, "install answered: " + JSON.stringify(res));
      assert.strictEqual(res.status, "installed");
      assert.strictEqual(res.version, sup.version);
      assert.deepStrictEqual(res.target, { kind: "remote", base: sup.base });
      assert.strictEqual(sup.state.install.bytes, 0, "no bytes crossed from the phone");
      assert.strictEqual(sup.state.install.manifest.artifact_url, `${sup.base}/${sup.artifact}`);
      assert.strictEqual(sup.state.install.manifest.digest, sup.pin, "the host fetches under the release's own pin");
      assert.strictEqual(sup.state.install.manifest.name, sup.name);
      await eventually(() =>
        assert.deepStrictEqual(progress.map((p) => p.stage), ["artifact", "fetch", "installed"],
          "install progress reaches the page over the bridge's SSE"));

      // 9d. the reverse verbs, same channel, same answers as the desktop
      const vers = await globalThis.clutchComponents.versions(sup.name);
      assert.deepStrictEqual(vers.target, { kind: "remote", base: sup.base });
      assert.strictEqual(vers.error, null);
      assert.strictEqual(vers.versions[0].resolved, true, "the machine says which version it would run");

      const off = await globalThis.clutchComponents.setDisabled(sup.name, true);
      assert.deepStrictEqual(off, {
        ok: true, name: sup.name, status: "disabled", disabled: true,
        target: { kind: "remote", base: sup.base },
      });
      assert(sup.state.calls.includes(`POST /api/components/${sup.name}/disable`), "the switch was asked of the far machine");

      const gone = await globalThis.clutchComponents.remove(sup.name, { version: sup.held });
      assert.deepStrictEqual(gone, {
        ok: true, name: sup.name, status: "removed", removed: [sup.held],
        target: { kind: "remote", base: sup.base },
      });
      assert(sup.state.calls.includes(`DELETE /api/components/${sup.name}?version=${encodeURIComponent(sup.held)}`));

      // 9e. no session and no local supervisor (N4): the tab says WHY in words a
      //     page can draw — the answer a phone with nothing to install on owes
      tunnel.state.status = { active: false, url: "" };
      const offline = await globalThis.clutchComponents.list();
      assert.deepStrictEqual(offline.target, { kind: "local", base: null });
      assert.strictEqual(offline.error, "this build has no supervisor URL for the local machine");
      assert.deepStrictEqual(offline.held, [], "no placeholder port, so no misleading empty machine");

      // 9f. what that sentence is for now: methods that do not exist. The
      //     namespace is registered, so the tab can tell the two apart.
      const bogus = await bridgePost(BRIDGE, "/api/clutchComponents/nope");
      assert.strictEqual(bogus.status, 404);
      assert.strictEqual(bogus.body.error, "no such bridge method: clutchComponents.nope");
    } finally {
      globalThis.fetch = realFetch;
      tunnel.state.status = { active: true, url: "http://127.0.0.1:8891" };
      await sup.close();
    }
  }

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
