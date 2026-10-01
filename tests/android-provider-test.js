// N3 artifact provider, hermetic: a local HTTP server plays the CI release
// host (index + prebuilt tar); the provider must download to the SAME cache
// the desktop uses, sha256-verify, cache-hit without re-downloading, reject a
// tampered artifact without leaving it behind, and return a `version` that is
// byte-identical to what the desktop's fileHash().slice(0,16) would produce —
// that value IS the remote's VERSION gate, so the gate runs unmodified.
// Run: node tests/android-provider-test.js
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

// N2 in test form: HOME -> sandbox before anything reads homedir()
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-android-prov-"));
const realHomedir = os.homedir.bind(os);
os.homedir = () => HOME;

const { createAndroidArtifactProvider } = require("../android/host/artifact-provider-android");
const { fileHash } = require("../ui/server-bundle"); // the desktop gate, for parity

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const CACHE = path.join(HOME, ".clutch", "bundles");

function serveArtifacts(tars) {
  // tars: Map<filename, Buffer>; the index is generated from it. Serialized
  // per request so the test can tamper with entries between calls.
  const index = {};
  for (const [file, buf] of tars) {
    // CI naming: agent-pylibs-<os>-<arch>-<libc>-py<ver>-<hash>.tar.gz
    const m = file.match(/^agent-pylibs-(.+)-([0-9a-f]{16})\.tar\.gz$/);
    if (!m) throw new Error("bad fixture name: " + file);
    index[m[1]] = { file, sha256: sha256(buf), version: m[2] };
  }
  const fetches = [];
  const server = http.createServer((req, res) => {
    fetches.push(req.url);
    if (req.url === "/pylibs-index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(index));
    }
    const name = decodeURIComponent(req.url.replace(/^\//, ""));
    const buf = tars.get(name);
    if (!buf) {
      res.writeHead(404);
      return res.end("no such artifact");
    }
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(buf);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: base + "/pylibs-index.json",
        index,
        fetches,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function main() {
  // 0. the unstamped dev fallback must name THIS repo. A placeholder host 404s,
  // and the provider then reports "that release carries no pylibs-matrix assets
  // (the tag predates the job)" -- the user goes looking for a release that
  // exists. Asserted as a literal on purpose: moving the project must be a
  // deliberate edit here, not a silent 404 on every assets-only APK.
  const PROVIDER_SRC = fs.readFileSync(
    path.join(__dirname, "..", "android", "host", "artifact-provider-android.js"),
    "utf8"
  );
  const fallback = PROVIDER_SRC.match(/return "([^"]+\/pylibs-index\.json)";/);
  assert(fallback, "the provider has a dev fallback index URL");
  assert.strictEqual(
    fallback[1],
    "https://github.com/Ethereal1024/Clutch/releases/latest/download/pylibs-index.json",
    "the dev fallback points at this repo releases/latest"
  );

  // a deterministic 4-byte gzip-ish payload is enough: the provider must not care
  const good = Buffer.from([0x1f, 0x8b, 0x07, 0x99]);
  const goodHash16 = sha256(good).slice(0, 16);
  const bad = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const badHash16 = sha256(bad).slice(0, 16);
  const srv = await serveArtifacts(
    new Map([
      [`agent-pylibs-linux-x86_64-glibc-py3.12-${goodHash16}.tar.gz`, good],
      [`agent-pylibs-linux-aarch64-musl-py3.13-${badHash16}.tar.gz`, bad],
    ])
  );
  const tarFetches = () => srv.fetches.filter((u) => u.endsWith(".tar.gz")).length;

  const provider = createAndroidArtifactProvider({ indexUrl: srv.url });

  // 1. N4 belt: Android never hosts a backend, whatever it is asked
  await assert.rejects(
    () => provider.ensureBundle({ os: "linux", arch: "x86_64" }),
    /no backend bundle on Android/,
    "ensureBundle hard-rejects"
  );

  // 2. a probe result the CI matrix never published: reject, do not guess
  await assert.rejects(
    () => provider.ensurePyLibsTar({ os: "sunos", arch: "riscv64", libc: "glibc", pyver: "3.12" }),
    /no prebuilt pylibs artifact for sunos-riscv64-glibc-py3\.12/,
    "missing index key rejects"
  );

  // 3. the manifest LIES about the bad artifact (CI drift simulation): the
  // provider must catch it via its own sha256, not trust the index
  srv.index["linux-aarch64-musl-py3.13"].sha256 = sha256(good); // the lie
  await assert.rejects(
    () => provider.ensurePyLibsTar({ os: "linux", arch: "aarch64", libc: "musl", pyver: "3.13" }),
    /failed sha256/,
    "tampered manifest is caught by the recomputed hash"
  );
  assert.deepStrictEqual(
    fs.readdirSync(CACHE).filter((f) => !f.startsWith("pylibs-index-")),
    [],
    "a rejected download leaves nothing behind (a cached INDEX is not an artifact)"
  );

  // 4. the good probe: download, verify, land in the desktop's cache
  const { path: p, version } = await provider.ensurePyLibsTar({
    os: "linux",
    arch: "x86_64",
    libc: "glibc",
    pyver: "3.12",
  });
  assert.strictEqual(
    path.dirname(p),
    CACHE,
    "lands in ~/.clutch/bundles — the SAME cache the desktop uses"
  );
  assert.strictEqual(
    path.basename(p),
    `agent-pylibs-linux-x86_64-glibc-py3.12-${goodHash16}.tar.gz`,
    "kept the CI artifact name"
  );
  assert(fs.readFileSync(p).equals(good), "on-disk bytes are byte-identical to the artifact");
  assert(
    !fs.readdirSync(CACHE).some((f) => f.startsWith(".pylibs-")),
    "no temp file left after the atomic rename"
  );

  // 5. gate parity: our recomputed version == the desktop fileHash prefix, so
  // the remote VERSION gate runs unmodified on an Android-supplied tar
  assert.strictEqual(version, goodHash16, "version is the content-hash prefix");
  assert.strictEqual(
    version,
    fileHash(p).slice(0, 16),
    "identical to ui/server-bundle.js fileHash().slice(0,16)"
  );

  // 6. cache hit: a second identical probe must not re-download
  const before = tarFetches(); // the tampered probe above also fetched once, then rejected
  const again = await provider.ensurePyLibsTar({
    os: "linux",
    arch: "x86_64",
    libc: "glibc",
    pyver: "3.12",
  });
  assert.strictEqual(again.path, p, "cache hit returns the same path");
  assert.strictEqual(again.version, goodHash16, "cache hit still recomputes the gate value");
  assert.strictEqual(tarFetches(), before, "cache hit did NOT re-download the tar");

  // 7. the release host does not answer (the phone is on a LAN with no
  // internet, or the CDN is blocked). The cached index names the same artifact
  // and the cache holds it byte-for-byte, so a reconnect to a remote that
  // already runs this tar must still gate exactly instead of failing with
  // "cannot obtain wheels for target" — which is what made a reconnect look
  // like it could never complete.
  assert(
    fs.readdirSync(CACHE).some((f) => f.startsWith("pylibs-index-")),
    "the release index is cached beside the tars"
  );
  const offline = createAndroidArtifactProvider({
    indexUrl: srv.url,
    fetchIndex: () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com")),
  });
  const offlineHit = await offline.ensurePyLibsTar({
    os: "linux",
    arch: "x86_64",
    libc: "glibc",
    pyver: "3.12",
  });
  assert.strictEqual(offlineHit.version, goodHash16, "offline: the gate value is unchanged");
  assert.strictEqual(offlineHit.path, p, "offline: the cached tar is the artifact");

  // ...but only for an artifact that is really here: a target whose tar was
  // never downloaded still reports the network failure rather than guessing
  await assert.rejects(
    () => offline.ensurePyLibsTar({ os: "linux", arch: "aarch64", libc: "musl", pyver: "3.13" }),
    /ENOTFOUND/,
    "offline + no cached tar for this target: the fetch error still surfaces"
  );

  // ...and a cache written for ANOTHER release (a different index URL, i.e. a
  // newer APK's tag) is never reused: it could name an older tar and silently
  // pin the remote to code this app no longer speaks
  await assert.rejects(
    () =>
      createAndroidArtifactProvider({
        indexUrl: srv.url + "?tag=v9.9.9",
        fetchIndex: () => Promise.reject(new Error("offline")),
      }).ensurePyLibsTar({ os: "linux", arch: "x86_64", libc: "glibc", pyver: "3.12" }),
    /offline/,
    "a cached index for another release URL is not reused"
  );

  // 8. a stalled transfer is capped: without a socket timeout a hung fetch
  // leaves the connect on "Installing remote server…" indefinitely (the
  // reported "reconnecting just installs the server again and again").
  assert(
    /req\.setTimeout\(timeoutMs/.test(PROVIDER_SRC),
    "a stalled artifact fetch is bounded by a socket timeout"
  );

  await srv.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  os.homedir = realHomedir;
  console.log("android-provider: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
