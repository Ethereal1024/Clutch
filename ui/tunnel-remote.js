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

function uploadFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    getSftp().then(
      (sftp) => sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve())),
      reject
    );
  }).catch(() => uploadFileViaExec(localPath, remotePath)); // no SFTP subsystem? exec it
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
