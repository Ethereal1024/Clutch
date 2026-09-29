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
//
// Run: node tests/android-pylibs-path-test.js
//
// Needs bash + a venv with pip (pip download hits PyPI). uv-built venvs ship
// without pip: that is an environment limit, not a product bug → SKIP, the
// same policy as ssh-tunnel.test.js on a Windows host without a POSIX shell.

const { check, summary } = require("./harness");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const TAR_SH = path.join(REPO, "scripts", "build-pylibs-tar.sh");
const VENV_PY = path.join(
  REPO,
  process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"
);
// mid of the CI matrix (pylibs-matrix builds 3.10–3.13); pip download resolves
// wheels for it regardless of the local interpreter's version
const PYVER = "3.12";
const KEY = `linux-x86_64-glibc-py${PYVER}`;

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

function buildPylibs(out) {
  // same invocation shape as defaultEnsurePyLibsTar: bash + the 6 args.
  // Output is captured and only shown on failure — a green run must not bury
  // its assertion labels under a hundred lines of pip chatter.
  const r = spawnSync(
    "bash",
    [TAR_SH, "key-unused", out, "Linux", "x86_64", "glibc", PYVER],
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
  if (!fs.existsSync(VENV_PY) || spawnSync(VENV_PY, ["-m", "pip", "--version"]).status !== 0) {
    console.log("SKIP: .venv has no pip (uv-built venvs do not); run: uv pip install pip");
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
  listing
        .split("\n")
        .some((l) => l === "agent/" || l === "agent") &&
        listing.includes("agent/supervisor.py") &&
        listing.includes("site-packages/openai/"),
  "tar embeds agent/ (incl. supervisor entry) + site-packages"
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
      const got = await ensurePyLibsTar({ os: "Linux", arch: "x86_64", libc: "glibc", pyver: PYVER });
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
      const again = await ensurePyLibsTar({ os: "linux", arch: "x86_64", libc: "glibc", pyver: PYVER });
      check(
        fake.tarHits === tarsAfterFirst && again.version === got.version && again.path === got.path,
        "second call is a tar cache hit: zero further downloads, same path+version"
      );

      let rejected = null;
      try {
        await ensurePyLibsTar({ os: "Linux", arch: "riscv64", libc: "glibc", pyver: PYVER });
      } catch (e) {
        rejected = e;
      }
      check(
  !!rejected && /no prebuilt pylibs artifact/.test(rejected.message),
  "index without the key rejects cleanly (→ strategy falls back, no partial state)"
);

      const tampered = await serveIndex(
        JSON.stringify({ [KEY]: { file: ciName + ".evil", sha256: "0".repeat(64), version: "x" } }),
        {}
      );
      // fetch is injected so the fake host need not serve the body: the index
      // (fetched over real HTTP) says sha256=000…0, the body is "tampered"
      const evilProvider = createAndroidArtifactProvider({
        indexUrl: `http://127.0.0.1:${tampered.server.address().port}/pylibs-index.json`,
        fetch: () => Promise.resolve(Buffer.from("tampered")),
      });
      let hashFail = null;
      try {
        await evilProvider.ensurePyLibsTar({ os: "Linux", arch: "x86_64", libc: "glibc", pyver: PYVER });
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
