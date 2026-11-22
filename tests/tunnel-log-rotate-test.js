// The tunnel log is verbose on purpose — and bounded by contract.
//
// ssh2 debug output is logged unconditionally (tunnel-connect.ts): that is what
// makes a tunnel failure diagnosable, and it is also why one install's log
// reached 258 MB. Nothing ever rotated it, so the file grew without limit and
// every append got slower. tunnelLog (host/tunnel-core.ts) now rolls at 16 MB
// into ONE archive, and the archive keeps only its newest bytes.
//
// This drives the REAL tunnelLog — the built host module, ui/tunnel-core.js —
// against a scratch HOME, so the checks are about the code that ships:
//   1. a log an older build left oversized is rolled on the first line of the
//      process, and the archive keeps the TAIL (the newest lines explain the
//      failure; the oldest megabytes are the ones worth dropping);
//   2. crossing the cap while running rolls the same way, and the fresh file
//      starts empty instead of being appended to the archive;
//   3. the file is 0600 — it can hold an SSH password in plaintext.
//
// Run: node tests/tunnel-log-rotate-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { check, summary } = require("./harness");

// HOME first: tunnel-core.ts computes LOG_FILE from os.homedir() at module load,
// and a runner must never scribble on the developer's own ~/.clutch/tunnel.log.
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-log-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const LOG = path.join(SCRATCH_HOME, ".clutch", "tunnel.log");
const PREV = LOG + ".1";
const CAP = 16 * 1024 * 1024;
const MODULE = path.join(__dirname, "..", "ui", "tunnel-core.js");

// A fresh module graph per scenario: `logBytes` (the measured size) is module
// state, exactly like the app's single load.
function fresh() {
  for (const f of [LOG, PREV]) fs.rmSync(f, { force: true });
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

function size(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return -1; // gone
  }
}

function mode(file) {
  return (fs.statSync(file).mode & 0o777).toString(8);
}

function main() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });

  {
    // 1) the field state: a 20 MB log left by an older build, and the first line
    // this process writes
    const tun = fresh();
    const big = Buffer.alloc(20 * 1024 * 1024, 0x78);
    big.write("TAILMARK", big.length - 8);
    fs.writeFileSync(LOG, big);
    tun.tunnelLog("first line of the run");

    check(size(LOG) > 0 && size(LOG) < 4096,
      "the first line of the process rolls an oversized log away instead of growing it (" + size(LOG) + " bytes)");
    check(size(PREV) === CAP,
      "the archive is exactly the cap, whatever the old file was (" + size(PREV) + " of " + CAP + ")");
    check(fs.readFileSync(PREV).slice(-8).toString() === "TAILMARK",
      "and it keeps the TAIL: the newest lines are the ones that explain the failure");
    check(/first line of the run/.test(fs.readFileSync(LOG, "utf8")),
      "the line that triggered the roll is in the NEW file, not buried in the archive");
    check(mode(LOG) === "600",
      "the log is 0600 even after the roll took the file away: it can hold a password in plaintext (" + mode(LOG) + ")");
  }

  {
    // 2) crossing the cap while running: the archive takes the file that filled
    // up, and the next line starts a new one
    const tun = fresh();
    fs.writeFileSync(LOG, Buffer.alloc(CAP, 0x61));
    tun.tunnelLog("line over the cap");           // measured at the cap, then crosses it
    tun.tunnelLog("after the roll");

    check(size(PREV) === CAP && size(PREV) <= CAP,
      "crossing the cap rolls the file to .1, never past the cap (" + size(PREV) + ")");
    check(/line over the cap/.test(fs.readFileSync(PREV, "utf8")),
      "the archive has the lines that filled it, trimmed to its tail");
    check(fs.readFileSync(LOG, "utf8").trim().split("\n").length === 1 &&
          /after the roll/.test(fs.readFileSync(LOG, "utf8")),
      "the new log starts clean: only the line written after the roll is in it");
    check(size(LOG) + size(PREV) <= 2 * CAP + 4096,
      "the whole archive stays under two caps — a runaway debug line cannot fill a disk (" +
      (size(LOG) + size(PREV)) + ")");
  }

  fs.rmSync(SCRATCH_HOME, { recursive: true, force: true });
}

main();

summary("tunnel-log-rotate", "the tunnel log rolls at its cap and keeps its newest bytes");
