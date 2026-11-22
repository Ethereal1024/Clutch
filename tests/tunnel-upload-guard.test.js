// "Uploading server…" that never ends — what the upload now does about it.
//
// Field report (2026-11-21 15:29): a dial sat on "Uploading server…" for ever.
// The tunnel log told the whole story and the code did not: the socket was reset
// half way through the 78 MB bundle ("read ECONNRESET" at 07:29:53, three
// seconds after the SFTP writes stopped being acked), and then NOTHING — no
// "connect failed", no teardown, no retry, so the page kept the last stage it
// had been told. ssh2's fastPut never calls its callback once the channel is
// gone, and nothing outside it was watching, so the connect promise never
// settled.
//
// So the transfer is now watched from the outside: no byte for the stall
// window, a wire that is known to be gone, or the overall deadline ends the
// upload with a sentence that says how far it got. Those three are what this
// runner drives, against a fake sftp subsystem — no SSH host involved.
//
// Run: node tests/tunnel-upload-guard.test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

// the tunnel log lives under HOME; a test line in the real one is evidence
// tampering, so point it at a scratch dir before the module loads
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-uploadguard-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;

const { check, summary } = require("./harness");
const UI = path.join(__dirname, "..", "ui");
const core = require(path.join(UI, "tunnel-core"));
const { uploadFile } = require(path.join(UI, "tunnel-remote"));

const state = core.state;
const BIG_BYTES = 1024 * 1024;
const BIG = path.join(SCRATCH_HOME, "big.bin");
const SMALL = path.join(SCRATCH_HOME, "small.txt");
fs.writeFileSync(BIG, Buffer.alloc(BIG_BYTES, 7));
fs.writeFileSync(SMALL, "hello");

// a fake ssh2 client: `sftp` hands the case's subsystem to getSftp, `exec` is
// only there to prove when it is NOT used
function fakeClient(sftp) {
  const client = {
    execCalls: [],
    sftp: (cb) => cb(null, sftp),
    exec: (cmd, cb) => {
      client.execCalls.push(cmd);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      process.nextTick(() => stream.emit("close", 0));
      cb(null, stream);
    },
    end: () => {},
  };
  return client;
}

function fakeSftp(overrides) {
  const calls = { ended: 0 };
  const sftp = Object.assign(
    {
      fastPut() {
        throw new Error("case did not supply fastPut");
      },
      end() {
        calls.ended++;
      },
    },
    overrides
  );
  sftp.calls = calls;
  return sftp;
}

async function main() {
  let stepper = null; // case 5's slow-but-alive stepper is cleared by the case

  // ---- 1. a transfer that stops moving ends, and says how far it got --------
  {
    const sftp = fakeSftp({
      fastPut(local, remote, opts) {
        // two chunks acked, then the far side goes quiet — and ssh2 never calls
        // the callback, which is the hang this exists for
        opts.step(32768, null, BIG_BYTES);
        opts.step(65536, null, BIG_BYTES);
      },
    });
    state.sshClient = fakeClient(sftp);
    state.sftpHandle = sftp;
    const t0 = Date.now();
    const err = await uploadFile(BIG, "/r/big", { stallMs: 300 }).then(
      () => null,
      (e) => e
    );
    const ms = Date.now() - t0;
    check(Boolean(err), "an upload nothing is acking no longer waits for ever");
    check(/stopped moving/.test(err.message), "it says the transfer stopped moving: " + err.message);
    check(
      /64 KB of 1\.0 MB \(6%\)/.test(err.message),
      "and how far it got, in bytes and percent, so a retry is an informed one"
    );
    check(ms < 5000, "it gives up on its own window, not on the host (" + ms + " ms)");
    check(
      sftp.calls.ended === 1 && state.sftpHandle === null,
      "the half-open sftp channel is closed and dropped from the cache — the next attempt opens its own"
    );
    check(
      state.sshClient.execCalls.length === 0,
      "a transfer that STARTED is never re-sent as printf chunks (the old catch-all fallback)"
    );
  }

  // ---- 2. a wire that is gone fails the upload at once ---------------------
  {
    const sftp = fakeSftp({
      fastPut() {
        /* the channel died with the socket: no step, no callback */
      },
    });
    state.sshClient = fakeClient(sftp);
    state.sftpHandle = null;
    const t0 = Date.now();
    const pending = uploadFile(BIG, "/r/big", { stallMs: 5000 }).then(
      () => null,
      (e) => e
    );
    setTimeout(() => {
      state.sshClient = null; // tunnelGone, exactly as 'lost the socket' leaves it
    }, 60);
    const err = await pending;
    const ms = Date.now() - t0;
    check(
      Boolean(err) && /SSH connection dropped/.test(err.message),
      "a socket that died under the upload fails it: " + (err && err.message)
    );
    check(ms < 1500, "and it does not wait out the stall window: the wire is KNOWN to be gone (" + ms + " ms)");
  }

  // ---- 3. a transfer that works reports its own bytes and keeps the channel -
  {
    const seen = [];
    const sftp = fakeSftp({
      fastPut(local, remote, opts, cb) {
        [0, 512000, BIG_BYTES].forEach((n) => opts.step(n, null, BIG_BYTES));
        cb(null);
      },
    });
    state.sshClient = fakeClient(sftp);
    state.sftpHandle = sftp;
    let err = null;
    await uploadFile(BIG, "/r/big", {
      onProgress: (sent, total) => seen.push([sent, total]),
      stallMs: 300,
    }).catch((e) => {
      err = e;
    });
    check(!err, "a transfer that is acked resolves" + (err ? " (" + err.message + ")" : ""));
    check(
      seen.length === 3 && seen[2][0] === BIG_BYTES && seen[0][1] === BIG_BYTES,
      "every step is handed to the caller with the file's own size (" + JSON.stringify(seen) + ")"
    );
    check(
      state.sftpHandle === sftp && sftp.calls.ended === 0,
      "a FINISHED upload keeps its sftp subsystem: the second file reuses the one handle"
    );
  }

  // ---- 4. a host with no SFTP subsystem still gets the exec path -----------
  {
    const client = fakeClient(null);
    client.sftp = (cb) => cb(new Error("No SFTP support"));
    state.sshClient = client;
    state.sftpHandle = null;
    let err = null;
    await uploadFile(SMALL, "/r/small.txt").catch((e) => {
      err = e;
    });
    check(!err, "no SFTP subsystem: the exec upload still carries the file" + (err ? " (" + err.message + ")" : ""));
    check(client.execCalls.length > 0, "and it went through exec (" + client.execCalls.length + " commands)");
  }

  // ---- 5. an upload that crawls but never lands hits the deadline ----------
  {
    const sftp = fakeSftp({
      fastPut(local, remote, opts) {
        let n = 0;
        stepper = setInterval(() => {
          n += 32768;
          opts.step(Math.min(n, BIG_BYTES), null, BIG_BYTES);
        }, 40);
      },
    });
    state.sshClient = fakeClient(sftp);
    state.sftpHandle = sftp;
    state.sftpUnavailable = false; // a fresh dial's capability flag (case 4 set it)
    const err = await uploadFile(BIG, "/r/big", { stallMs: 5000, deadlineMs: 300 }).then(
      () => null,
      (e) => e
    );
    clearInterval(stepper);
    check(
      Boolean(err) && /had not finished after/.test(err.message),
      "a transfer that moves but never completes is stopped by the deadline: " + (err && err.message)
    );
  }

  // ---- 5b. a busy far side is not a dead one: every ack pokes the keepalive --
  // The 2026-11-21 07:45 failure: the remote acked a chunk every 2.5 s (it was
  // writing at ~13 KB/s) and ssh2 still declared "Keepalive timeout" 100 ms after
  // three acks arrived, because its count only ever counts unanswered PINGS. A
  // byte from the far side is proof of life, so it resets that count.
  {
    let pokes = 0;
    const sftp = fakeSftp({
      fastPut(local, remote, opts, cb) {
        [32768, 65536, 98304].forEach((n) => opts.step(n, null, BIG_BYTES));
        cb(null);
      },
    });
    const client = fakeClient(sftp);
    client._resetKA = () => {
      pokes++;
    };
    state.sshClient = client;
    state.sftpHandle = sftp;
    state.sftpUnavailable = false;
    let err = null;
    await uploadFile(BIG, "/r/big", { stallMs: 5000 }).catch((e) => {
      err = e;
    });
    check(!err, "an acked transfer resolves with a client that carries a keepalive timer");
    check(pokes === 3, "every ack resets the keepalive count that times out on pings (" + pokes + " pokes)");

    // ...and a client whose shape this build does not know is not an error
    const odd = fakeClient(sftp);
    delete odd._resetKA;
    state.sshClient = odd;
    state.sftpHandle = sftp;
    err = null;
    await uploadFile(BIG, "/r/big", { stallMs: 5000 }).catch((e) => {
      err = e;
    });
    check(!err, "a client with no _resetKA still uploads (the poke is best-effort)");
  }

  // ---- 5c. a real transfer says how fast it is going and what is left ------
  // A percent that climbs by 1% a minute is honest and useless: the rate is what
  // tells a throttled host (13 KB/s, ~100 min for the bundle) from a hung one.
  {
    const infos = [];
    const sftp = fakeSftp({
      fastPut(local, remote, opts, cb) {
        let n = 0;
        let ticks = 0;
        const t = setInterval(() => {
          n += 100000;
          ticks++;
          opts.step(Math.min(n, BIG_BYTES), null, BIG_BYTES);
          if (ticks >= 6) {
            clearInterval(t);
            cb(null);
          }
        }, 80);
      },
    });
    state.sshClient = fakeClient(sftp);
    state.sftpHandle = sftp;
    await uploadFile(BIG, "/r/big", {
      stallMs: 5000,
      onProgress: (sent, total, info) => infos.push(info),
    }).catch(() => {});
    const last = infos[infos.length - 1];
    const midway = infos.find((i) => i && i.eta > 0);
    check(
      Boolean(last) && typeof last.bps === "number" && last.bps > 0 && last.total === BIG_BYTES,
      "a moving transfer reports its own bytes per second: " + JSON.stringify(last)
    );
    check(
      Boolean(midway) && midway.eta < 3600,
      "and, while there is still something to send, the time left at that rate (" +
        (midway && midway.eta) +
        " s)"
    );
  }

  // ---- 6. the wiring: the fraction reaches the label and the bar ----------
  {
    const boot = fs.readFileSync(path.join(UI, "src", "host", "tunnel-bootstrap.ts"), "utf8");
    check(
      /const totalBytes = sizes\[0\] \+ sizes\[1\]/.test(boot) &&
        /onProgress: report/.test(boot),
      "the bootstrap measures the whole transfer (both binaries) and reports its fraction"
    );
    check(
      /progress\("install:upload", 0\)/.test(boot),
      "the upload stage paints 0% the moment it is announced, not a bar waiting on stage names"
    );

    const conn = fs.readFileSync(path.join(UI, "src", "renderer", "conn-flow.ts"), "utf8");
    check(
      /"install:upload": \{ pct: 45, span: 25, label: "Uploading server…" \}/.test(conn),
      "the upload stage carries the span its fraction moves through"
    );
    check(
      /update\.stage/.test(conn) && /update\.frac/.test(conn) && /s\.pct \+ \(frac !== null/.test(conn),
      "the renderer reads { stage, frac } as well as a bare stage name, and moves the bar by the span"
    );
    check(
      /replace\(\/\\s\*…\$\/, ""\) \+ \(pane \? "" : " " \+ Math\.round\(frac \* 100\) \+ "%"\)/.test(conn),
      "and writes the percent where the ellipsis was: 'Uploading server 42%' — except on the tab's own " +
        "loading bar, which prints the number at its own right end instead"
    );
    check(
      /if \(frac !== null && bps\) \{/.test(conn) && /fmtRate\(bps\)/.test(conn) && /fmtEta\(eta\)/.test(conn),
      "and appends the transfer's own rate — and what is left — to that percent"
    );

    const main = fs.readFileSync(path.join(UI, "src", "host", "main.ts"), "utf8");
    check(
      /typeof frac === "number"/.test(main) && /\bstage,\s*\n?\s*frac,/.test(main) && /bps: info/.test(main),
      "the IPC sends a fraction as { stage, frac, bps, eta } and leaves a bare stage a string"
    );

    const remote = fs.readFileSync(path.join(UI, "src", "host", "tunnel-remote.ts"), "utf8");
    check(
      /const UPLOAD_STALL_MS = 30000/.test(remote) &&
        /const UPLOAD_DEADLINE_MS = 3 \* 60 \* 60 \* 1000/.test(remote),
      "the stall window outlasts an 11 s gap between acks (and stays under the 45 s dead-wire budget), " +
        "and the deadline outlasts a ~100 minute bundle"
    );
    check(
      /pokeKeepalive\(\);/.test(remote) && /function pokeKeepalive\(\)/.test(remote) && /_resetKA/.test(remote),
      "an ack resets ssh2's keepalive count, so a busy far side is not read as a dead wire"
    );

    const connect = fs.readFileSync(path.join(UI, "src", "host", "tunnel-connect.ts"), "utf8");
    check(
      /keepaliveInterval: 15000,\n\s*keepaliveCountMax: 3,/.test(connect),
      "the hop's own dead-wire budget is unchanged (45 s, the stair-step session-heartbeat pins)"
    );
  }

  // ---- 7. the numbers a person actually reads ----------------------------
  // The label is assembled from two pure helpers, so the bundle itself is asked
  // what they print (the build is tsc, one module per function: names survive).
  {
    const bundle = fs.readFileSync(path.join(UI, "renderer.js"), "utf8");
    const grab = (name) => {
      const at = bundle.indexOf("function " + name + "(");
      if (at < 0) return null;
      let i = bundle.indexOf("{", at);
      let depth = 0;
      for (; i < bundle.length; i++) {
        if (bundle[i] === "{") depth++;
        else if (bundle[i] === "}" && --depth === 0) return bundle.slice(at, i + 1);
      }
      return null;
    };
    const src = ["fmtRate", "fmtEta"].map(grab);
    check(src.every(Boolean), "the rate and ETA helpers are in the bundle the page loads");
    const helpers = new Function(src.join("\n") + "\nreturn { fmtRate: fmtRate, fmtEta: fmtEta };")();
    check(helpers.fmtRate(13312) === "13 KB/s", "13 KB/s reads as '13 KB/s' (" + helpers.fmtRate(13312) + ")");
    check(helpers.fmtRate(2411724) === "2.3 MB/s", "a healthy link reads as MB/s (" + helpers.fmtRate(2411724) + ")");
    check(
      helpers.fmtEta(6000) === "1 h 40 min" && helpers.fmtEta(95) === "2 min" && helpers.fmtEta(9) === "9 s",
      "and the time left is coarse: " + [6000, 95, 9].map(helpers.fmtEta).join(" / ")
    );
    // the whole line, in the shipped bundle: 'Uploading server 42% · 13 KB/s ·
    // 1 h 40 min left' — the percent, then the rate, then what is left. The
    // bundle escapes the middle dot (tsc's ES5 target writes it as \xB7), so
    // both spellings are accepted.
    check(
      /" (?:\\xB7|·) " \+ fmtRate\(bps\)/.test(bundle) &&
        /" (?:\\xB7|·) " \+ fmtEta\(eta\) \+ " left"/.test(bundle),
      "and the bundle assembles them as '… 42% · 13 KB/s · 1 h 40 min left'"
    );
  }

  fs.rmSync(SCRATCH_HOME, { recursive: true, force: true });
}

main().then(
  () => summary("tunnel-upload-guard", "an upload that stops moving fails with its own bytes, instead of hanging on 'Uploading server…'"),
  (e) => {
    console.log("FAIL: the runner itself threw: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
);
