// Standalone checks for ssh-tunnel.js: the exec upload path (byte-exact
// chunks under the sshd cap) and the end-of-tunnel notification, which is
// what tells the renderer that its session URL is gone.
// Run: node tests/ssh-tunnel.test.js
//
// Text must be written byte-exactly (printf chunks) and binary via base64, and
// every exec command must stay under the chunk cap (~8KB on minimal sshd). The
// injectable `exec` runs through local sh, so no real SSH host is needed.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec: shExec, execFile: shExecFile, execFileSync } = require("child_process");
const UI_DIR = path.join(__dirname, "..", "ui");
// ui/ssh-tunnel.js is only the public face: the tunnel is six files over one
// shared state object. The source assertions below slice whichever file holds
// the function, so they read the whole module, in dependency order.
const TUNNEL_FILES = [
  "ssh-tunnel.js",
  "tunnel-core.js",
  "tunnel-net.js",
  "tunnel-remote.js",
  "tunnel-bootstrap.js",
  "tunnel-lifecycle.js",
  "tunnel-connect.js",
].map((f) => path.join(UI_DIR, f));
const TUNNEL_SRC = TUNNEL_FILES.map((f) => fs.readFileSync(f, "utf8")).join("\n");

// stopTunnel appends to ~/.clutch/tunnel.log -- the forensic record of the
// frozen-window incident -- so point HOME at a scratch dir before the module
// is loaded: a test line in the real log would be evidence tampering.
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-home-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { uploadFileViaExec, stopTunnel, onTunnelEnd } = require("../ui/ssh-tunnel");
const { check, summary, slicer } = require("./harness");
const { fnBody } = slicer(TUNNEL_SRC);

// The mock remote is a POSIX shell: the real remote's exec bridge runs `sh -c`
// there. On Windows child_process.exec is cmd.exe, which cannot run printf /
// base64 / heredocs, so run the mock through a real bash (Git for Windows /
// MSYS2) — mirrors agent/tools/localshell.py's detection, including the WSL
// launcher exclusion (System32\bash.exe is a different filesystem). No bash at
// all => the check SKIPS (an environment limit, not a product bug); a real
// remote always has a POSIX shell.
function findPosixSh() {
  if (process.platform !== "win32") return null; // exec's default is /bin/sh
  const sysDir = path.resolve(process.env.SystemRoot || "C:\\Windows", "System32").toLowerCase();
  const candidates = [
    process.env.CLUTCH_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs\\Git\\bin\\bash.exe"),
  ].filter(Boolean);
  for (const cand of candidates) {
    try {
      if (!fs.existsSync(cand) || path.resolve(cand).toLowerCase().startsWith(sysDir + path.sep)) continue;
      if (execFileSync(cand, ["-c", "echo clutch-bash-ok"], { stdio: "pipe" }).includes("clutch-bash-ok")) {
        return cand;
      }
    } catch (e) {
      /* broken install: try the next candidate */
    }
  }
  return null;
}

const POSIX_SH = findPosixSh();

// A SECOND, private instance of the module: stopTunnel is a singleton (its end
// latch lives in the shared tunnel-core state), and the latch must start fresh
// here. Dropping the whole tunnel from the require cache and requiring it again
// yields a private instance that still resolves "./llm-proxy" etc. from ui/; it
// exposes only the flag a successful connect would have set, so the
// notification itself stays unmodified.
function loadFreshTunnel() {
  for (const f of TUNNEL_FILES) delete require.cache[require.resolve(f)];
  const inst = require("../ui/ssh-tunnel");
  inst.__testMarkLive = (v) => {
    require("../ui/tunnel-core").state.wasDisconnected = v;
  };
  return inst;
}

// Simulated remote sh: run each exec command locally, recording the peak
// command length (what the chunk cap must bound).
let maxCmdLen = 0;
function mockExec(cmd, timeoutMs) {
  maxCmdLen = Math.max(maxCmdLen, Buffer.byteLength(cmd));
  const opts = { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 };
  const done = (err, stdout, stderr) => ({
    code: err ? (err.code == null ? 1 : err.code) : 0,
    stdout: String(stdout || ""),
    stderr: String(stderr || ""),
  });
  return new Promise((resolve) => {
    if (POSIX_SH) {
      shExecFile(POSIX_SH, ["-c", cmd], opts, (err, stdout, stderr) => resolve(done(err, stdout, stderr)));
      return;
    }
    shExec(cmd, opts, (err, stdout, stderr) => resolve(done(err, stdout, stderr)));
  });
}

async function main() {
  if (process.platform === "win32" && !POSIX_SH) {
    console.log("SKIP: no POSIX shell on this host (Windows without Git Bash / MSYS2)");
    console.log("      the mock remote runs `sh -c` like exec-bridge.js on a real remote;");
    console.log("      cmd.exe cannot run printf/base64, so this check needs one.");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-upload-"));

  // 1. text with special chars + trailing newline: byte-exact
  let src = path.join(tmp, "src1.txt");
  const tricky = "l1\nwith $VAR `bt` 'sq' \"dq\"\n\ttab\tend\n";
  fs.writeFileSync(src, tricky);
  await uploadFileViaExec(src, path.join(tmp, "dst1.txt"), 30000, mockExec);
  check(fs.readFileSync(path.join(tmp, "dst1.txt"), "utf8") === tricky, "text upload byte-exact (special chars + trailing newline)");

  // 2. text without trailing newline: no newline is invented
  src = path.join(tmp, "src2.txt");
  fs.writeFileSync(src, "no trailing newline");
  await uploadFileViaExec(src, path.join(tmp, "dst2.txt"), 30000, mockExec);
  check(fs.readFileSync(path.join(tmp, "dst2.txt"), "utf8") === "no trailing newline", "text upload byte-exact (no invented newline)");

  // 3. empty file is still created
  src = path.join(tmp, "src3.txt");
  fs.writeFileSync(src, "");
  await uploadFileViaExec(src, path.join(tmp, "dst3.txt"), 30000, mockExec);
  check(fs.existsSync(path.join(tmp, "dst3.txt")) && fs.readFileSync(path.join(tmp, "dst3.txt")).length === 0, "empty text file created");

  // 4. large text (>10KB, with quotes): byte-exact + every exec under the cap
  src = path.join(tmp, "src4.txt");
  const big = Array.from({ length: 300 }, (_, i) => `line ${i} with 'quotes' and $VAR\n`).join("");
  fs.writeFileSync(src, big);
  await uploadFileViaExec(src, path.join(tmp, "dst4.txt"), 30000, mockExec);
  check(fs.readFileSync(path.join(tmp, "dst4.txt"), "utf8") === big, "large text upload byte-exact (chunked)");

  // 5. binary (null bytes): byte-exact via base64 chunks
  src = path.join(tmp, "src5.bin");
  const bin = Buffer.from(Array.from({ length: 20000 }, (_, i) => i % 256));
  fs.writeFileSync(src, bin);
  await uploadFileViaExec(src, path.join(tmp, "dst5.bin"), 30000, mockExec);
  check(fs.readFileSync(path.join(tmp, "dst5.bin")).equals(bin), "binary upload byte-exact (base64 chunks)");

  // 6. every exec command stays under the sshd's ~8KB drop threshold
  const cap = 3500 + 400; // chunk content + shq/wrapper overhead
  check(maxCmdLen <= cap, `all exec commands under the chunk cap (max ${maxCmdLen} bytes)`);

  fs.rmSync(tmp, { recursive: true, force: true });

  // 7. the end-of-tunnel notification: until it arrives the renderer keeps a
  // session URL and a Stop button that post into whatever the SSH hop left
  // behind. An intentional disconnect (the picker, window close) is handled by
  // its caller and stays silent; a teardown the renderer did NOT ask for -- the
  // healer giving up, or an unexpected death -- must be announced, even though
  // stopTunnel nulls state.sshClient before end(), which is exactly why the ssh
  // end handler cannot deliver it (its currency guard suppresses it).
  const solo = loadFreshTunnel();
  let ends = 0;
  solo.onTunnelEnd(() => {
    ends++;
  });
  await solo.stopTunnel();
  check(ends === 0, "an intentional disconnect stays silent (the caller clears its own flag)");
  solo.__testMarkLive(false); // what a successful connect has set by then
  await solo.stopTunnel(true);
  check(ends === 1, "a teardown the renderer did not ask for is announced");
  await solo.stopTunnel(true);
  check(ends === 1, "the latch keeps the end from being announced twice");

  // 8. the paths a behavioural test cannot reach, asserted on the source: the
  // notice must come AFTER the ports are closed (a listener that re-claims must
  // not land on a half-alive tunnel), the last resort of the healer must
  // notify, and a request racing the teardown must fail its own socket instead
  // of throwing on a null client in the main process.
  const stopBody = fnBody("stopTunnel");
  check(/function stopTunnel\(notify = false\)/.test(stopBody),
    "stopTunnel takes the notify flag (default: the caller manages its own disconnect)");
  check(stopBody.indexOf("if (notify) notifyEnd();") > stopBody.indexOf("stopExecBridge();"),
    "the announcement follows the port teardown, not the reverse");
  check(/await stopTunnel\(true\)/.test(fnBody("healOnce")),
    "the healer announces the teardown of its last resort");
  check(/if \(!state\.sshClient\) return sock.destroy\(\);/.test(fnBody("openSessionForward")),
    "a session request racing the teardown fails its own socket");
  const fwdBody = slicer(TUNNEL_SRC).region("async function establishForwardAndHealth", "establishForwardAndHealth");
  check(/if \(!state\.sshClient\) return sock.destroy\(\);/.test(fwdBody),
    "a stale local forward fails its socket instead of throwing in the main process");

  fs.rmSync(SCRATCH_HOME, { recursive: true, force: true });
  summary("ssh-tunnel");
}

main();
