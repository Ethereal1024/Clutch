// End-to-end check for the remote-mode bootstrap against a REAL host.
// Run: CLUTCH_E2E_HOST=10.x.x.x CLUTCH_E2E_PORT=22 CLUTCH_E2E_USER=me \
//      CLUTCH_E2E_PASS='...' node tests/remote-bootstrap-e2e.js [--probe-only]
//
// --probe-only runs just the SSH probe (read-only: no install, no start).
// Without it, the full connectTunnel bootstrap runs (installs ~/.clutch-server
// on the remote and starts the supervisor) — exactly what the UI's
// "install server" does in remote mode.

"use strict";

const os = require("os");
const path = require("path");
const { Client } = require("../ui/node_modules/ssh2");
const {
  connectTunnel,
  stopTunnel,
  onTunnelEnd,
} = require("../ui/ssh-tunnel");

const host = process.env.CLUTCH_E2E_HOST;
const user = process.env.CLUTCH_E2E_USER;
const port = Number(process.env.CLUTCH_E2E_PORT || 22);
const password = process.env.CLUTCH_E2E_PASS;
const probeOnly = process.argv.includes("--probe-only");

if (!host || !user || !password) {
  console.error("need CLUTCH_E2E_HOST, CLUTCH_E2E_USER, CLUTCH_E2E_PASS");
  process.exit(2);
}

const PROBE_CMD = [
  'echo "__OS__"; uname -s',
  'echo "__ARCH__"; uname -m',
  'echo "__HOME__"; echo "$HOME"',
  'echo "__PY__"; (command -v python3 >/dev/null && python3 -c "import sys;print(\'%d.%d\'%sys.version_info[:2])") || echo NONE',
  'echo "__LIBC__"; (ldd --version 2>&1 | head -1 | grep -qi musl && echo musl) || ([ -f /etc/alpine-release ] && echo musl) || (ldd --version 2>&1 | head -1 | grep -qE "GLIBC|glibc|GNU libc" && echo glibc) || echo unknown',
  'echo "__VER__"; (cat "$HOME/.clutch-server/VERSION" 2>/dev/null) || echo NONE',
  'echo "__NET__"; (python3 -c "import urllib.request;urllib.request.urlopen(\'https://pypi.org\',timeout=3);print(\'OK\')" 2>/dev/null) || echo NO',
].join("; ");

function parseSection(out, marker) {
  const parts = out.split(marker);
  return parts.length > 1 ? parts[1].split("__")[0].trim() : "";
}

function probeOnce() {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error("probe timed out"));
    }, 20000);
    client.on("ready", () => {
      client.exec(PROBE_CMD, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let out = "";
        stream.on("data", (d) => (out += d));
        stream.stderr.on("data", (d) => (out += d));
        stream.on("close", () => {
          clearTimeout(timer);
          client.end();
          resolve({
            os: parseSection(out, "__OS__"),
            arch: parseSection(out, "__ARCH__"),
            home: parseSection(out, "__HOME__"),
            python: parseSection(out, "__PY__"),
            libc: parseSection(out, "__LIBC__"),
            installed: parseSection(out, "__VER__"),
            internet: parseSection(out, "__NET__"),
            raw: out,
          });
        });
      });
    });
    client.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.connect({
      host,
      port,
      username: user,
      password,
      tryKeyboard: true,
      readyTimeout: 15000,
    });
    client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish([password]));
  });
}

async function main() {
  console.log(`[e2e] host=${host}:${port} user=${user} mode=${probeOnly ? "probe-only" : "full"}`);

  if (probeOnly) {
    const p = await probeOnce();
    console.log("[e2e] probe:", JSON.stringify({ ...p, raw: undefined }, null, 2));
    const { platformTag } = require("../ui/server-bundle");
    console.log("[e2e] client platformTag:", platformTag());
    console.log(
      "[e2e] same-os+arch (bundle allowed):",
      p.os.toLowerCase() === platformTag().split("-")[0] && p.arch === platformTag().split("-")[1]
    );
    return;
  }

  const done = new Promise((resolve) => onTunnelEnd(resolve));
  const t0 = Date.now();
  const res = await connectTunnel({ host, user, port, password }, (stage) =>
    console.log(`[e2e] progress: ${stage} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  );
  console.log(`[e2e] connectTunnel ->`, JSON.stringify(res), `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (res.ok) {
    const status = require("../ui/ssh-tunnel").tunnelStatus();
    console.log("[e2e] tunnelStatus:", JSON.stringify(status));
    stopTunnel();
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  }
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[e2e] FAILED:", e.message);
  process.exit(1);
});
