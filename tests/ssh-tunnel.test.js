// Standalone check for ssh-tunnel.js's exec upload path.
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
const { uploadFileViaExec } = require("../ui/ssh-tunnel");
const { check, summary } = require("./harness");

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
  summary("ssh-tunnel");
}

main();
