// Standalone checks for the per-host SSH secret cache: the ssh_secrets map in
// ~/.clutch/settings.json (same cache shape as the LLM api_key — an explicit
// caller value first, then the file, cf. llm-proxy.js getApiKey), and the
// tunnel's use of it (connectTunnel drives a fake ssh2 so no host is needed).
// Run: node tests/ssh-secret-cache-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const Module = require("module");

// the cache lives under HOME (settings-mirror resolves os.homedir() per call):
// point HOME at a scratch dir before anything loads, like ssh-tunnel.test.js
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-sshcache-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");
const {
  sshSecretId,
  getSshSecret,
  saveSshSecret,
  forgetSshSecret,
  writeSettingsMirror,
  readSettings,
} = require("../ui/settings-mirror");

const MIRROR_PATH = path.join(SCRATCH_HOME, ".clutch", "settings.json");

// ---- the cache itself ----

check(sshSecretId("h.example", "alice", "22") === "alice@h.example:22", "entry is keyed user@host:port");
check(sshSecretId("h.example", "alice", "") === "alice@h.example:22", "an empty port keys as the default 22");
check(sshSecretId("h.example", "alice", 2222) === "alice@h.example:2222", "an explicit port keys as itself");

check(getSshSecret("h.example", "alice", "22") === "", "get with no mirror file is empty");
saveSshSecret("h.example", "alice", "22", "s3cret");
check(getSshSecret("h.example", "alice", "22") === "s3cret", "save then get round-trips");
check(getSshSecret("h.example", "alice", 22) === "s3cret", "the same host keys the same (string or number port)");
check(
  (fs.statSync(MIRROR_PATH).mode & 0o777) === 0o600,
  "the mirror file is 0600 (the api_key's discipline)"
);

// a settings save shares the file: it must not drop the cache
writeSettingsMirror({ base_url: "https://api.example", model: "m1", api_key: "llm-key" });
check(getSshSecret("h.example", "alice", "22") === "s3cret", "settings:save keeps ssh_secrets");
const saved = JSON.parse(fs.readFileSync(MIRROR_PATH, "utf8"));
check(saved.api_key === "llm-key" && saved.model === "m1", "settings fields sit alongside the cache");
check(readSettings().model === "m1", "readSettings sees the same file");

// the legacy {profiles, active} map: the cache survives a save's profile fold
fs.writeFileSync(
  MIRROR_PATH,
  JSON.stringify({
    profiles: { a: { api_key: "k", model: "m" }, b: {} },
    active: "a",
    ssh_secrets: { "alice@h.example:22": "s3cret" },
  })
);
writeSettingsMirror({ model: "m2" });
check(getSshSecret("h.example", "alice", "22") === "s3cret", "the legacy profiles fold keeps ssh_secrets");

// forget: one entry out, the rest in place, unknown hosts a no-op
saveSshSecret("h2.example", "bob", "2222", "other");
forgetSshSecret("h.example", "alice", "22");
check(getSshSecret("h.example", "alice", "22") === "", "forget drops the entry");
check(getSshSecret("h2.example", "bob", "2222") === "other", "forget leaves other entries");
forgetSshSecret("nope.example", "x", "22");
check(getSshSecret("h2.example", "bob", "2222") === "other", "forgetting an unknown host is a no-op");

// ---- the tunnel's use of the cache (fake ssh2) ----
//
// inject the fake BEFORE ui/ssh-tunnel loads, so tunnel-connect's
// require("ssh2") resolves to it. connectTunnel is then driven through its
// real path (auth -> probe), with exec always failing at the probe — the
// verdict {ok:false} is fine: the assertions are about WHICH secret was
// offered and what the cache did afterwards.

class FakeClient extends EventEmitter {
  constructor() {
    super();
    FakeClient.last = this;
  }
  connect(opts) {
    this.opts = opts;
    FakeClient.lastOpts = opts;
    process.nextTick(() => {
      if (FakeClient.behavior === "auth-fail") {
        this.emit("error", new Error("All configured authentication methods failed"));
      } else if (FakeClient.behavior === "key-no-pass") {
        this.emit("error", new Error("Cannot parse privateKey: Encrypted private OpenSSH key detected, but no passphrase given"));
      } else {
        this.emit("ready");
      }
    });
  }
  exec(cmd, cb) {
    process.nextTick(() => cb(new Error("mock exec unavailable")));
  }
  end() {}
}

const ssh2Path = require.resolve("ssh2", { paths: [path.join(__dirname, "..", "ui")] });
const fakeMod = new Module(ssh2Path);
fakeMod.filename = ssh2Path;
fakeMod.loaded = true;
fakeMod.exports = { Client: FakeClient };
require.cache[ssh2Path] = fakeMod;

const { connectTunnel, stopTunnel } = require("../ui/ssh-tunnel");

function kbdAnswer() {
  const h = FakeClient.last.listeners("keyboard-interactive")[0];
  let ans = null;
  h("", [], [], [], (a) => (ans = a));
  return ans;
}

(async () => {
  // 1. cached secret is what the tunnel dials with when the caller gives none
  saveSshSecret("box.example", "alice", 22, "cached-pass");
  FakeClient.behavior = "ready";
  await connectTunnel({ host: "box.example", user: "alice", port: 22 });
  check(FakeClient.lastOpts.password === "cached-pass", "no explicit secret: the cached one is offered as password");
  check(FakeClient.lastOpts.passphrase === "cached-pass", "the same value covers the key passphrase");
  check(kbdAnswer()[0] === "cached-pass", "keyboard-interactive answers with it too");
  check(getSshSecret("box.example", "alice", 22) === "cached-pass", "a cached-only connect does not rewrite the cache");

  // 2. an explicit secret wins over the cache, and is what gets cached
  await connectTunnel({ host: "box.example", user: "alice", port: 22, password: "typed-pass" });
  check(FakeClient.lastOpts.password === "typed-pass", "an explicit secret beats the cache");
  check(getSshSecret("box.example", "alice", 22) === "typed-pass", "what authenticated replaces the cache");

  // 3. a cached secret that no longer works is dropped (auth-class error)
  saveSshSecret("box.example", "alice", 22, "old-pass");
  FakeClient.behavior = "auth-fail";
  const res3 = await connectTunnel({ host: "box.example", user: "alice", port: 22 });
  check(res3.ok === false, "a rejected secret reports the failure");
  check(/authentication/i.test(res3.error || ""), "the error is auth-class (the renderer's prompt gate)");
  check(getSshSecret("box.example", "alice", 22) === "", "a stale cached secret is forgotten");

  // 4. nothing cached, nothing typed: the attempt is key/agent only
  FakeClient.behavior = "auth-fail";
  await connectTunnel({ host: "bare.example", user: "alice", port: 22 });
  check(FakeClient.lastOpts.password === undefined, "no secret anywhere: no password is offered");
  check(kbdAnswer().length === 0, "keyboard-interactive answers empty");

  // 5. an encrypted key without a passphrase is auth-class too (so the prompt —
  //    and this cache — covers key passphrases, not just passwords)
  saveSshSecret("key.example", "alice", 22, "kp");
  FakeClient.behavior = "key-no-pass";
  const res5 = await connectTunnel({ host: "key.example", user: "alice", port: 22 });
  check(/authentication/i.test(res5.error || ""), "a key-passphrase problem reads as auth-class");
  check(getSshSecret("key.example", "alice", 22) === "", "and a cached secret that cannot parse the key is dropped");

  // 6. the secrets never reach the tunnel log
  let log = "";
  try {
    log = fs.readFileSync(path.join(SCRATCH_HOME, ".clutch", "tunnel.log"), "utf8");
  } catch (e) {
    /* no log = nothing leaked */
  }
  check(
    !/cached-pass|typed-pass|old-pass|s3cret/.test(log),
    "no secret is written to ~/.clutch/tunnel.log"
  );

  await stopTunnel(); // close the proxies the attempts started
  summary("ssh-secret-cache", "all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
