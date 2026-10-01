// N3 — Android pylibs artifact provider. The pylibs tar is ABI-sensitive
// (os,arch,libc,pyver) and Android has no pip/bash, so the tar comes from CI
// prebuilt Release artifacts instead of a local build (the desktop default in
// server-bundle.js runs build-pylibs-tar.sh — unavailable on the phone).
//
// The tars are byte-deterministic, so a tar's sha256 IS its content hash and
// its first 16 hex chars are the VERSION-gate value — the same fileHash()
// computation server-bundle.js applies on desktop. After download we recompute
// the hash locally, so the remote VERSION gate runs unmodified.
//
// Release index (published by the pylibs-matrix CI job alongside the tars):
//   { "<os>-<arch>-<libc>-py<ver>": { "file": "agent-pylibs-<...>-<hash>.tar.gz",
//                                     "sha256": "<64 hex>",
//                                     "version": "<16 hex = gate value>" } }
//
// The index must be the SAME COMMIT as the installed app: the tar embeds the
// agent/ source the remote executes, so a newer release's tar could speak a
// protocol the installed app's host JS doesn't. Resolution order:
//   1. CLUTCH_PYLIBS_INDEX_URL env (dev runs / tests)
//   2. pylibs-index-url.txt next to this file — stamped by the release CI
//      with THIS APK's own tag (…/download/<tag>/pylibs-index.json)
//   3. releases/latest/download of THIS repo (dev APKs: best effort)
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");

function defaultIndexUrl() {
  if (process.env.CLUTCH_PYLIBS_INDEX_URL) return process.env.CLUTCH_PYLIBS_INDEX_URL;
  try {
    const stamped = fs.readFileSync(path.join(__dirname, "pylibs-index-url.txt"), "utf-8").trim();
    if (stamped) return stamped;
  } catch (e) {
    /* not stamped: dev build */
  }
  // this repo, never a placeholder host: a 404 from a repo that does not
  // exist gets reported as "that release carries no pylibs-matrix assets
  // (the tag predates the job)" -- sending the user after a release that is
  // fine. Only an unstamped dev build lands here (build-android-apk.sh always
  // stamps), i.e. exactly the assets sync-android-host.sh produces alone.
  return "https://github.com/Ethereal1024/Clutch/releases/latest/download/pylibs-index.json";
}

function cacheDir() {
  return path.join(os.homedir(), ".clutch", "bundles"); // same cache the desktop uses
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// tiny GET with redirect following (GitHub release assets redirect to S3).
// The timeout is the point: without one a stalled TLS/HTTP connection never
// errors, and the connect sits on "Installing remote server…" for as long as
// the phone's network cares to hold the socket open — the reported "it keeps
// installing the server" on a reconnect to a remote that was already ready.
const INDEX_TIMEOUT_MS = 20000;
const TAR_TIMEOUT_MS = 180000; // ~30 MB over mobile data

function fetchBuf(url, redirects = 0, timeoutMs = INDEX_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects fetching " + url));
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuf(new URL(res.headers.location, url).toString(), redirects + 1, timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => {
        chunks.push(c);
        req.setTimeout(timeoutMs); // a download that stalls mid-body is struck too
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms fetching ${url}`));
    });
    req.on("error", reject);
  });
}

async function fetchJson(url) {
  return JSON.parse((await fetchBuf(url)).toString("utf-8"));
}

// One cached index per index URL — the URL carries the tag an APK is stamped
// with (or "latest" for a dev build), so a cached copy can only ever describe
// the release this app was built from.
function indexCachePath(indexUrl) {
  const stamp = crypto.createHash("sha256").update(indexUrl).digest("hex").slice(0, 12);
  return path.join(cacheDir(), `pylibs-index-${stamp}.json`);
}

function readCachedIndex(indexUrl) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexCachePath(indexUrl), "utf-8"));
    // the URL is stored inside: a cache written for another release is not ours
    return parsed && parsed.url === indexUrl && parsed.index ? parsed.index : null;
  } catch (e) {
    return null;
  }
}

function writeCachedIndex(indexUrl, index) {
  try {
    const out = indexCachePath(indexUrl);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + ".tmp", JSON.stringify({ url: indexUrl, index }));
    fs.renameSync(out + ".tmp", out);
  } catch (e) {
    /* an index we cannot cache is not a failed connect */
  }
}

function createAndroidArtifactProvider({ indexUrl = defaultIndexUrl(), fetchIndex = fetchJson, fetch = fetchBuf } = {}) {
  return {
    // Android never hosts a backend locally (N4): the PyInstaller bundle path
    // is unreachable by construction (chooseStrategy requires platform match);
    // this hard reject is the belt to that brace.
    ensureBundle: async () => {
      throw new Error("no backend bundle on Android: the backend runs on the SSH remote");
    },

    // target: { os, arch, libc, pyver } — the probe result, exactly what the
    // desktop key is built from. Returns { path, version } like the desktop:
    // version = recomputed content-hash prefix, i.e. the expected VERSION gate.
    async ensurePyLibsTar(target) {
      // probe spellings vary (uname -s says "Linux"); the CI index is lowercase
      const key = `${String(target.os || "").toLowerCase()}-${target.arch}-${target.libc || "unknown"}-py${target.pyver}`;
      let index;
      try {
        index = await fetchIndex(indexUrl);
        writeCachedIndex(indexUrl, index);
      } catch (e) {
        // a 404 here is the supply line, not the network: the release this
        // APK's stamp points at predates the pylibs-matrix job (v0.1.14 did)
        // and simply has no index asset. Say so — "HTTP 404 for …" sent the
        // user chasing a connectivity ghost.
        if (/HTTP 404/.test((e && e.message) || "")) {
          throw new Error(
            `pylibs index 404 at ${indexUrl}: that release carries no pylibs-matrix ` +
              "assets (the tag predates the job). Cut a new tag so the release CI " +
              "publishes the index + tars, or point the stamp at a LAN index " +
              "(docs/android/02 §7)."
          );
        }
        // An unreachable release host (the phone sits on a LAN with no
        // internet, or the release CDN is blocked) is NOT a reason a reconnect
        // to a remote that already runs this tar must fail: the cached index
        // names the same artifact, the cache holds it byte-for-byte, and the
        // hash is recomputed below, so the gate stays exact. Only a cached
        // index for THIS index URL counts, and only when its tar is here too.
        const cached = readCachedIndex(indexUrl);
        const hit = cached && cached[key] && cached[key].file;
        if (!hit || !fs.existsSync(path.join(cacheDir(), hit))) throw e;
        index = cached;
      }
      const entry = index && index[key];
      if (!entry || !entry.file || !entry.sha256) {
        throw new Error(`no prebuilt pylibs artifact for ${key}: the pylibs-matrix CI job has not published one`);
      }
      const dir = cacheDir();
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, entry.file);
      if (fs.existsSync(out)) {
        // cache hit still returns the RECOMPUTED hash: trust nothing, not even ourselves
        return { path: out, version: sha256(fs.readFileSync(out)).slice(0, 16) };
      }
      // the tar is ~30 MB: give the body transfer its own, longer stall window
      const buf = await fetch(indexUrl.replace(/[^/]*$/, "") + entry.file, 0, TAR_TIMEOUT_MS);
      const got = sha256(buf);
      if (got !== entry.sha256) {
        throw new Error(`pylibs artifact ${entry.file} failed sha256: expected ${entry.sha256}, got ${got}`);
      }
      const tmp = path.join(dir, `.pylibs-${key}-${process.pid}.tar.gz`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, out); // atomic: a partial download must never satisfy the gate
      return { path: out, version: got.slice(0, 16) };
    },
  };
}

module.exports = { createAndroidArtifactProvider };
