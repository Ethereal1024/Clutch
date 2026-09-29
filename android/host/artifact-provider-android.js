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
//   3. releases/latest/download (dev APKs: best effort)
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
  return "https://github.com/clutch-dev/clutch/releases/latest/download/pylibs-index.json";
}

function cacheDir() {
  return path.join(os.homedir(), ".clutch", "bundles"); // same cache the desktop uses
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// tiny GET with redirect following (GitHub release assets redirect to S3)
function fetchBuf(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects fetching " + url));
    const mod = url.startsWith("https:") ? https : http;
    mod
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchBuf(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function fetchJson(url) {
  return JSON.parse((await fetchBuf(url)).toString("utf-8"));
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
        throw e;
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
      const buf = await fetch(indexUrl.replace(/[^/]*$/, "") + entry.file);
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
