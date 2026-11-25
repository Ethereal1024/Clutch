"use strict";

// M2 supply line, exercised from the build side to the provider seam (the
// phone runs the same provider against the same index — N3):
//
//   1. scripts/build-pylibs-tar.sh is BYTE-DETERMINISTIC: two builds with the
//      same target produce identical sha256. This is not cosmetic — the tar's
//      content hash IS the remote VERSION gate (ssh-tunnel writes
//      `echo ${version} > ~/.clutch-server/VERSION` and reinstalls iff it
//      differs), and unstable bytes would re-upload the whole stack on every
//      session instead of hitting the ~/.clutch/bundles cache.
//   2. A CI-named tar served by a fake Release index flows through the real
//      wiring: setArtifactProvider(createAndroidArtifactProvider(...)) then
//      server-bundle's ensurePyLibsTar seam. Assertions:
//        - version === sha256(tar).slice(0,16)  → the VERSION gate value the
//          desktop path computes, so the remote check runs unmodified;
//        - the tar lands in a sandboxed ~/.clutch/bundles;
//        - `uname -s` says "Linux" (capital L) and must map onto the lowercase
//          CI index key;
//        - a second call is a cache hit (zero further tar downloads; the
//          few-KB index JSON is re-read on every call by design);
//        - an index without the key rejects cleanly (→ SSH-tools fallback).
//   3. the tar carries NO wheel (the agent's Python side is stdlib-only) and its
//      bytes do not depend on the target at all: an aarch64 build is
//      byte-identical to the x86_64 one. That is the whole point of dropping
//      the wheel set — an old remote became a question about the sources
//      instead of a five-package downgrade, and a py3.8 remote and a py3.12 one
//      are offered the SAME asset (the key has no interpreter in it).
//
// Run: node tests/android-pylibs-path-test.js
//
// Needs bash + python3 + tar. No venv and no network: there is nothing left to
// resolve (this used to need a venv with pip, because pip downloaded wheels).

const { check, summary } = require("./harness");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const TAR_SH = path.join(REPO, "scripts", "build-pylibs-tar.sh");
// The target is a LABEL now: it decides which asset a remote is offered, not
// what the asset holds. §1 builds two unrelated targets and demands one sha256.
const KEY = "linux-x86_64-glibc";
const OTHER_KEY = "linux-aarch64-glibc";
const OTHER_TARGET = { os: "Linux", arch: "aarch64", libc: "glibc" };
const DEFAULT_TARGET = { os: "Linux", arch: "x86_64", libc: "glibc" };

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// sandbox HOME *before* these requires: server-bundle.js captures CACHE from
// os.homedir() at require time; the provider reads it per call
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-pylibs-home-"));
const realHomedir = os.homedir;
os.homedir = () => SANDBOX_HOME;

const {
  setArtifactProvider,
  hasLocalBundle,
  ensurePyLibsTar,
} = require("../ui/server-bundle");
const {
  createAndroidArtifactProvider,
} = require("../android/host/artifact-provider-android");

// fake Release host: GET /pylibs-index.json → indexJson, GET /<file> → bytes.
// Counts index requests and artifact downloads separately: the provider
// re-reads the (few-KB) index on every call BY DESIGN — only the tar itself
// must be served from the on-disk cache.
function serveIndex(indexJson, files) {
  const state = { indexHits: 0, tarHits: 0, server: null };
  return new Promise((resolve) => {
    state.server = http.createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1));
      if (name === "pylibs-index.json") {
        state.indexHits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(indexJson);
      } else if (Object.prototype.hasOwnProperty.call(files, name)) {
        state.tarHits++;
        res.writeHead(200);
        res.end(files[name]);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    state.server.listen(0, "127.0.0.1", () => resolve(state));
  });
}

function buildPylibs(out, target = DEFAULT_TARGET) {
  // same invocation shape as defaultEnsurePyLibsTar: bash + the 4 args.
  // Output is captured and only shown on failure — a green run must not bury
  // its assertion labels under build chatter.
  const r = spawnSync(
    "bash",
    [TAR_SH, out, target.os, target.arch, target.libc],
    { cwd: REPO, encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.log("--- build-pylibs-tar.sh failed, output tail: ---");
    console.log(((r.stdout || "") + (r.stderr || "")).split("\n").slice(-25).join("\n"));
  }
  return r;
}

async function main() {
  // ---- environment gate (SKIP, not FAIL) ----
  if (process.platform === "win32" || spawnSync("bash", ["-c", "true"]).status !== 0) {
    console.log("SKIP: no bash on this host; the pylibs build script needs one");
    return;
  }
  // the packer needs some interpreter; the build script prefers this
  // checkout's .venv and otherwise falls back to python3/python on PATH
  const py = spawnSync(
    "bash",
    [
      "-c",
      'test -x .venv/bin/python || test -x .venv/Scripts/python.exe || command -v python3 >/dev/null || command -v python >/dev/null',
    ],
    { cwd: REPO, encoding: "utf8" }
  );
  if (py.status !== 0) {
    console.log("SKIP: no interpreter to pack the tar with (need .venv or python3)");
    return;
  }

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-pylibs-build-"));
  try {
    // ---- 1. byte determinism: same target twice → same sha256 ----
    const tarA = path.join(buildDir, "a.tar.gz");
    const tarB = path.join(buildDir, "b.tar.gz");
    const r1 = buildPylibs(tarA);
    check(r1.status === 0, "build #1 exits 0");
    if (r1.status !== 0) return;
    const r2 = buildPylibs(tarB);
    check(r2.status === 0, "build #2 exits 0");
    if (r2.status !== 0) return;
    const hash = sha256File(tarA);
    check(fs.statSync(tarA).size > 1024, "tar is non-empty");
    check(
  hash === sha256File(tarB),
  "two builds are byte-identical (sha256 equal) — the VERSION gate can trust the cache"
);

    const listing = spawnSync("tar", ["-tzf", tarA], { encoding: "utf8" }).stdout;
    check(
      listing.split("\n").some((l) => l === "agent/" || l === "agent") &&
        listing.includes("agent/supervisor.py") &&
        listing.includes("site-packages/"),
      "tar embeds agent/ (incl. supervisor entry) + site-packages/"
    );

    // The agent's Python side is stdlib-only now (pyproject.toml: no
    // dependencies). No wheel, no .dist-info — that metadata is what the tree
    // probe counts, so a leftover second generation is the half-installed
    // state the probe reports as DUP. An empty site-packages keeps the tree
    // shape the installer swaps and the probe scans.
    const distInfos = listing.split("\n").filter((l) => /\.dist-info\/?$/.test(l));
    check(distInfos.length === 0, "tar carries zero .dist-info (no wheel, one fixed tree shape)");
    check(
      !/\bsite-packages\/[^/]+\//.test(listing),
      "site-packages/ ships empty (the agent needs nothing from it)"
    );

    // ---- 1b. the target no longer decides content ----
    // Same input set → same bytes regardless of the key we claim: build the
    // far end of the matrix (aarch64) and demand the x86_64 hash.
    // This is the property that makes an old remote a source question instead
    // of a five-wheel downgrade, so it is asserted, not assumed.
    const tarC = path.join(buildDir, "c.tar.gz");
    const r3 = buildPylibs(tarC, OTHER_TARGET);
    check(r3.status === 0, `build for ${OTHER_KEY} exits 0`);
    if (r3.status !== 0) return;
    check(
      sha256File(tarC) === hash,
      `${OTHER_KEY} is byte-identical to ${KEY} — the artifact does not depend on the target`
    );

    // ---- 2. CI-named tar through the Android provider over a fake index ----
    // exactly the pylibs-index job's assertion: the name's hash equals the
    // content hash, so the index can be generated from filenames alone
    const ciName = `agent-pylibs-${KEY}-${hash.slice(0, 16)}.tar.gz`;
    check(ciName.endsWith(hash.slice(0, 16) + ".tar.gz"), "CI filename embeds the content hash");

    const index = { [KEY]: { file: ciName, sha256: hash, version: hash.slice(0, 16) } };
    const fake = await serveIndex(JSON.stringify(index), { [ciName]: fs.readFileSync(tarA) });
    const indexUrl = `http://127.0.0.1:${fake.server.address().port}/pylibs-index.json`;

    const provider = createAndroidArtifactProvider({ indexUrl });
    setArtifactProvider(provider);
    check(hasLocalBundle() === false, "provider registered → hasLocalBundle() is false (N4)");
    check(
  await provider.ensureBundle().then(
        () => false,
        (e) => /no backend bundle/.test(e.message)
      ),
  "provider hard-rejects ensureBundle (the belt behind chooseStrategy)"
);

    try {
      const got = await ensurePyLibsTar({ os: "Linux", arch: "x86_64", libc: "glibc" });
      check(
  got.path === path.join(SANDBOX_HOME, ".clutch", "bundles", ciName),
  "tar lands in the sandbox ~/.clutch/bundles (same cache the desktop uses)"
);
      check(
  got.version === hash.slice(0, 16),
  "version === fileHash(tar).slice(0,16) — the remote VERSION gate value"
);
      check(sha256File(got.path) === hash, "downloaded bytes match the index sha256");

      const tarsAfterFirst = fake.tarHits;
      const again = await ensurePyLibsTar({ os: "linux", arch: "x86_64", libc: "glibc" });
      check(
        fake.tarHits === tarsAfterFirst && again.version === got.version && again.path === got.path,
        "second call is a tar cache hit: zero further downloads, same path+version"
      );

      let rejected = null;
      try {
        await ensurePyLibsTar({ os: "Linux", arch: "riscv64", libc: "glibc" });
      } catch (e) {
        rejected = e;
      }
      check(
  !!rejected && /no prebuilt pylibs artifact/.test(rejected.message),
  "index without the key rejects cleanly (→ strategy falls back, no partial state)"
);

      // fetch is injected so the fake host need not serve the body. The index is
      // SELF-CONSISTENT (version = sha256 prefix, as CI publishes it) and the
      // download is the thing that lies: the provider recomputes the hash of the
      // bytes it got and must refuse them, never trust the catalogue (nor the
      // file name) — and an index that contradicted itself would be refused
      // before any download at all.
      const lieBytes = crypto.createHash("sha256").update(Buffer.from("tampered")).digest("hex");
      const tampered = await serveIndex(
        JSON.stringify({
          [KEY]: { file: ciName + ".evil", sha256: lieBytes, version: lieBytes.slice(0, 16) },
        }),
        {}
      );
      const evilProvider = createAndroidArtifactProvider({
        indexUrl: `http://127.0.0.1:${tampered.server.address().port}/pylibs-index.json`,
        fetch: () => Promise.resolve(Buffer.from("not the bytes this index names")),
      });
      let hashFail = null;
      try {
        await evilProvider.ensurePyLibsTar({ os: "Linux", arch: "x86_64", libc: "glibc" });
      } catch (e) {
        hashFail = e;
      }
      check(
  !!hashFail && /failed sha256/.test(hashFail.message) &&
          !fs.existsSync(path.join(SANDBOX_HOME, ".clutch", "bundles", ciName + ".evil")),
  "a tampered download fails the sha256 gate and writes nothing"
);
      tampered.server.close();
    } finally {
      setArtifactProvider(null);
      check(hasLocalBundle() === true, "provider removed → hasLocalBundle() true again (desktop behavior intact)");
      fake.server.close();
    }
  } finally {
    os.homedir = realHomedir;
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  }
}

main()
  .then(() => summary("android-pylibs-path"))
  .catch((e) => {
    console.log("FAIL: uncaught: " + ((e && e.stack) || e));
    process.exit(1);
  });
