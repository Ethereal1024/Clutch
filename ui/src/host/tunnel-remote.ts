// the ssh wire — run a command on the far side, put a file there
//
// One exec channel at a time over the shared ssh client, plus the two
// upload paths: SFTP when the host has the subsystem ("reuse one handle",
// because per-file opens exceed sshd's MaxSessions), and otherwise byte-exact
// exec chunks that stay under the command size a minimal sshd drops.

const fs = require("fs");
const { state } = require("./tunnel-core");

// ---- remote command/file helpers (used by bootstrap) ----

function remoteExec(command, timeoutMs = 60000, binary = false) {
  return new Promise((resolve, reject) => {
    if (!state.sshClient) return reject(new Error("not connected"));
    state.sshClient.exec(command, (err, stream) => {
      if (err) return reject(err);
      const out = [];
      let stderr = "";
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (binary) {
          // raw bytes: base64-encoded client-side so minimal hosts need no base64
          resolve({ code, stdout_b64: Buffer.concat(out).toString("base64"), stderr });
        } else {
          resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr });
        }
      };
      const timer = setTimeout(() => {
        stream.close();
        finish(-1);
      }, timeoutMs);
      stream.on("data", (d) => out.push(d));
      stream.stderr.on("data", (d) => (stderr += d));
      stream.on("close", (code) => finish(code));
      stream.on("error", (e) => {
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  });
}

function getSftp() {
  // reuse one sftp subsystem: per-file opens exceed sshd's MaxSessions
  if (state.sftpUnavailable) return Promise.reject(new Error("SFTP unavailable on this host"));
  if (state.sftpHandle) return Promise.resolve(state.sftpHandle);
  return new Promise((resolve, reject) => {
    state.sshClient.sftp((err, sftp) => {
      if (err) {
        state.sftpUnavailable = true; // don't reopen a doomed subsystem for every file
        return reject(err);
      }
      state.sftpHandle = sftp;
      resolve(sftp);
    });
  });
}

// An upload that can FAIL. ssh2's fastPut callback does not fire when the socket
// dies under it: the client destroys the channel, and the callbacks of the
// requests still in flight go with it (ssh2/lib/protocol/SFTP.js only answers
// while the channel is alive). That is how a dial sat on "Uploading server…" for
// ever on 2026-11-21 while the log had already written "read ECONNRESET" — the
// connect was waiting on an ack that was never going to arrive. So the transfer
// is watched from the OUTSIDE, because the far side cannot be relied on to say
// it is gone: no byte for `stallMs`, a wire that is no longer there, or the
// overall deadline, and the upload ends with a sentence that says which.
// The stall window is the wire's own testimony, so it has to outlast a far side
// that is merely slow: on 2026-11-21 the remote acked one 32 KB chunk every 2.5 s
// and sometimes went 11 s between acks without dying. 20 s was one bad build
// away from killing a transfer that was still moving; 30 s is nearly three of
// those gaps — and it is UNDER the hop's own 45 s dead-wire budget on purpose,
// so a far side that stops acking is reported by this window, with its bytes and
// percent, before the keepalive can blame the wire for it.
const UPLOAD_STALL_MS = 30000;
// The deadline is the backstop for "moving so slowly it will never land", not the
// stall test. 78 MB at the ~13 KB/s that same remote managed is ~100 minutes, so
// 30 minutes would have failed a healthy-but-throttled transfer about a third of
// the way in. Three hours is generous on purpose: anything this side can do about
// a slow host is tell the truth about its rate (see the rate/ETA below), never
// silently give up on a transfer that is getting there.
const UPLOAD_DEADLINE_MS = 3 * 60 * 60 * 1000;
// How far back the reported rate is measured. Long enough that one slow ack does
// not make "13 KB/s" jump, short enough that a transfer that suddenly picks up
// says so.
const RATE_WINDOW_MS = 15000;

// ssh2's keepalive counts only the far side's answers to keepalive@openssh.com —
// NOT the data it is sending us — so a host that is busy writing can have its
// sshd too slow to answer a ping while its STATUS acks keep arriving. That is
// what killed the 2026-11-21 07:45 upload: "Keepalive timeout" 100 ms after
// three acks had come back, on a wire that was alive the whole time. A byte that
// arrived FROM the far side is proof of life; every ack resets the counter that
// times out on pings, and a wire that is really gone still trips the stall
// window above.
function pokeKeepalive() {
  const client = state.sshClient;
  if (!client || typeof client._resetKA !== "function") return;
  try {
    client._resetKA();
  } catch (e) {
    /* an unexpected client shape is not the transfer's problem */
  }
}

function uploadSize(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}

function uploadSpan(ms) {
  return ms >= 60000 ? Math.round(ms / 60000) + " min" : Math.max(1, Math.round(ms / 1000)) + " s";
}

// `info` is what a transfer that is going to take a quarter of an hour owes the
// person watching it: how fast, and how much longer. Both are measured here
// because this is the only place that sees the acks arrive.
type UploadInfo = { bps: number; eta: number; total: number };
type UploadOpts = {
  onProgress?: (sent: number, total: number, info?: UploadInfo) => void;
  stallMs?: number;
  deadlineMs?: number;
  timeoutMs?: number; // the exec fallback's per-command budget
};

function uploadFile(localPath, remotePath, opts: UploadOpts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const stallMs = Number(opts.stallMs) > 0 ? Number(opts.stallMs) : UPLOAD_STALL_MS;
  const deadlineMs = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : UPLOAD_DEADLINE_MS;
  let total = 0;
  try {
    total = fs.statSync(localPath).size;
  } catch (e) {
    return Promise.reject(e);
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let sent = 0;
    let lastByteAt = Date.now();
    const startedAt = Date.now();
    let sftp = null;
    // [when, how many bytes the far side had acked] — the left edge of the rate
    // window, kept one sample older than the window so the divisor is never a
    // fraction of a second
    const marks = [[startedAt, 0]];

    const measureRate = (now) => {
      marks.push([now, sent]);
      while (marks.length > 2 && now - marks[1][0] > RATE_WINDOW_MS) marks.shift();
      const [t0, n0] = marks[0];
      const secs = (now - t0) / 1000;
      if (secs < 0.25) return 0;
      return Math.max(0, Math.round((sent - n0) / secs));
    };

    // Abandon the channel, not the tunnel: a half-open sftp subsystem would fail
    // every later upload on the cached handle, so the handle goes with it and the
    // next attempt opens its own.
    const forgetSftp = () => {
      const doomed = sftp || state.sftpHandle;
      if (!doomed) return;
      if (state.sftpHandle === doomed) state.sftpHandle = null;
      try {
        doomed.end();
      } catch (e) {
        /* already gone with the socket */
      }
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      if (!err) return resolve();
      forgetSftp();
      reject(err);
    };

    const watch = setInterval(() => {
      if (settled) return;
      // the wire itself is gone (tunnelGone nulled the client): nothing on the
      // far side will ack any more, and fastPut's callback is not coming
      if (!state.sshClient) {
        return finish(
          new Error("the SSH connection dropped while the file was still uploading")
        );
      }
      const now = Date.now();
      if (now - lastByteAt >= stallMs) {
        const pct = total ? Math.floor((sent / total) * 100) : 0;
        return finish(
          new Error(
            `the upload stopped moving after ${uploadSize(sent)} of ${uploadSize(total)} (${pct}%) — ` +
              `not one byte in ${uploadSpan(stallMs)}`
          )
        );
      }
      if (now - startedAt >= deadlineMs) {
        return finish(
          new Error(
            `the upload had not finished after ${uploadSpan(deadlineMs)} ` +
              `(${uploadSize(sent)} of ${uploadSize(total)})`
          )
        );
      }
    }, 250);

    getSftp().then(
      (handle) => {
        sftp = handle;
        if (settled) return forgetSftp(); // the watch gave up while the subsystem opened
        lastByteAt = Date.now(); // opening it WAS progress
        handle.fastPut(
          localPath,
          remotePath,
          {
            concurrency: 64,
            chunkSize: 32768,
            step: (transferred: number) => {
              const now = Date.now();
              const advanced = transferred !== sent;
              sent = transferred;
              if (advanced) lastByteAt = now;
              pokeKeepalive(); // an ack is the far side saying it is still there
              if (onProgress) {
                try {
                  const bps = measureRate(now);
                  onProgress(transferred, total, {
                    bps,
                    eta: bps > 0 ? Math.max(0, Math.round((total - transferred) / bps)) : 0,
                    total,
                  });
                } catch (e) {
                  /* the caller's number is not the transfer's problem */
                }
              }
            },
          },
          (e) => finish(e || null)
        );
      },
      (e) => {
        if (settled) return;
        // "this host has no SFTP subsystem" is the ONLY case the exec path can
        // serve. A transfer that started and failed must not be re-sent as
        // printf chunks — that is the same bytes over a worse pipe, with no
        // progress and no resume.
        finish(Object.assign(new Error((e && e.message) || String(e)), { sftpUnavailable: true }));
      }
    );
  }).catch((e) => {
    if (e && e.sftpUnavailable) return uploadFileViaExec(localPath, remotePath, opts.timeoutMs);
    throw e;
  });
}

function checkExec(r) {
  if (r.code !== 0) {
    throw new Error(`remote upload failed (exit ${r.code}): ${(r.stderr || r.stdout || "").slice(0, 300).trim()}`);
  }
}

// Minimal sshd (dropbear/BusyBox) drops a single exec over ~8KB; chunk limit
// comes from agent/transport_defaults.json so the Python side stays in sync.
const { exec_chunk_bytes: EXEC_CHUNK_BYTES } = require("./transport_defaults.json");

function shq(s) {
  // single-quote for sh: ' -> '\'' (works on any POSIX shell)
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function chunkText(s, cap) {
  // split so on-wire size after shq stays under cap; a quote inflates to 4 chars
  const chunks = [];
  let cur = "";
  let size = 0;
  for (const ch of s) {
    const b = ch === "'" ? 4 : Buffer.byteLength(ch);
    if (cur && size + b > cap) {
      chunks.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Fallback upload without SFTP: byte-exact printf chunks (text) or chunked
// base64 (binary), each under the sshd's exec limit; `exec` is injectable.
function uploadFileViaExec(localPath, remotePath, timeoutMs = 120000, exec = remoteExec) {
  const buf = fs.readFileSync(localPath);
  if (!buf.includes(0)) {
    const content = buf.toString("utf8");
    const chunks = chunkText(content, EXEC_CHUNK_BYTES);
    if (!chunks.length) chunks.push(""); // empty file still gets created
    let p = Promise.resolve();
    chunks.forEach((chunk, i) => {
      const op = i === 0 ? ">" : ">>";
      p = p.then(() => exec(`printf '%s' ${shq(chunk)} ${op} ${shq(remotePath)}`, timeoutMs).then(checkExec));
    });
    return p;
  }
  const data = buf.toString("base64");
  let first = true;
  let p = Promise.resolve();
  for (let i = 0; i < data.length; i += EXEC_CHUNK_BYTES) {
    const part = data.slice(i, i + EXEC_CHUNK_BYTES);
    const op = first ? ">" : ">>";
    first = false;
    p = p.then(() =>
      exec(`echo '${part}' | base64 -d ${op} ${shq(remotePath)}`, timeoutMs).then(checkExec)
    );
  }
  return p;
}

module.exports = {
  remoteExec,
  uploadFile,
  uploadFileViaExec,
};
