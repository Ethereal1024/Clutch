// Standalone check for ui/components.js (the install layer's sending half).
// Run: node tests/components.test.js
//
// A real machine supervisor is started on a random port with its own temp
// component root, so the whole path is exercised end to end: read what the host
// holds, build the artifact a client would send, upload it, and let the HOST
// land it. No mocks: the gate, the digest and the unpacking are the product's.
// The same machine answers the reverse direction at the end (which versions it
// holds for one component, letting that one go, and stopping or starting the
// driving of it) — the three are the same endpoint read three ways, so they are
// checked against the same run.
//
// Two supplies are checked, because they are the two the product has:
//
//   - a DEV CHECKOUT beside this repo, tarred by scripts/build-component-tar.sh
//     (so bash + tar are required; without them those checks SKIP — an
//     environment limit), and
//   - a module's PUBLISHED release, listed by ONE row of a market index this test
//     writes and fetched over http from a server it runs: the file it names is relative to the manifest and pinned by
//     the sha256 the manifest carries, and the HOST is the one that fetches it —
//     the install request carries the URL and the pin, no bytes (PLUGIN_PLAN.md
//     零之四.4), and nothing lands unless what the host fetched matches the pin.
//
// The run gets its own HOME: the client caches downloads in ~/.clutch/artifacts,
// so pointing the cache at a temp directory keeps the user's real one untouched
// (and makes the market index below a file, not a stub).

"use strict";

const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-components-home-"));
if (process.platform !== "win32") process.env.HOME = HOME; // components.js reads it at load
// A mirror forced by the environment would move every source before anything is
// read, and this runner is about the OTHER path (the per-source fallback): the
// machine's configuration must not decide what these checks exercise.
delete process.env.CLUTCH_SOURCE_MIRROR;
// The manifest budget is the suite's, not the release's: a case that wants to see
// the timeout branch must not spend 30 s learning that it works. Set before
// ui/components is required, because that is where the number is read.
process.env.CLUTCH_MANIFEST_TIMEOUT_MS = "1000";

const { check, summary } = require("./harness");
const components = require("../ui/components");
const { resolveBash } = require("../ui/server-bundle");

const ROOT = path.join(__dirname, "..");
const PY = path.join(ROOT, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
const TAR_SCRIPT = path.join(ROOT, "scripts", "build-component-tar.sh");
const BANNER = /http:\/\/127\.0\.0\.1:(\d+)/;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// One tar, exactly the shape a published artifact has to be: the component's
// members at the archive's TOP level.
function buildTar(src, out) {
  const r = spawnSync(resolveBash(), [TAR_SCRIPT, src, out], { stdio: "pipe" });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`build-component-tar.sh failed: ${r.stderr}`);
  return out;
}

// The ONE document every read goes through now (ui/components.js readIndex): a
// market index holding exactly the rows a case needs, written where the client can
// read it as a path — the same code as a URL, minus the network.
function indexOf(dir, rows) {
  const file = path.join(dir, "index.json");
  fs.writeFileSync(file, JSON.stringify({ schema: 2, entries: rows }));
  return file;
}

// One row pointing at a manifest this test serves, pinned to the bytes it wrote:
// a row's manifest is read through its digest (components.js entryManifest), so a
// row this test makes is a pinned one by construction.
function rowFor(manifestFile, manifestUrl, extra = {}) {
  const bytes = fs.readFileSync(manifestFile);
  const doc = JSON.parse(bytes.toString("utf8"));
  return {
    id: `test/${doc.name}`,
    name: doc.name,
    manifest: manifestUrl,
    manifest_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    version: doc.version || "",
    ...extra,
  };
}

// A stand-in for a module's release: one directory holding the manifest and every
// asset it names, served over http. Asset URLs here are relative to the manifest,
// so the path this exercises is the one a real release uses.
function serve(dir) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.replace(/^\/+/, "").split("?")[0]);
    const file = path.join(dir, name);
    if (!name || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("not here");
      return;
    }
    res.writeHead(200, { "Content-Length": String(fs.statSync(file).size) });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// A source that does not answer the way a healthy one does, twice over: the first
// `dieFirst` requests have their socket killed before any response (what a machine
// on a bad network reads as "fetch failed"), and `silent` never answers at all
// (what a blocked host looks like: the connection opens and nothing comes back).
// It counts its asks, because the number of asks IS the fact under test.
function serveBadly(file, { dieFirst = 0, silent = false } = {}) {
  const name = path.basename(file);
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (silent) return; // no response, no close: the caller's budget is what ends it
    if (hits <= dieFirst) {
      res.socket.destroy();
      return;
    }
    if (decodeURIComponent(req.url.replace(/^\/+/, "").split("?")[0]) !== name) {
      res.writeHead(404);
      res.end("not here");
      return;
    }
    res.writeHead(200, { "Content-Length": String(fs.statSync(file).size) });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}`, hits: () => hits })
    );
  });
}

// A release whose ARTIFACT is the fetch that fails. The manifest and the
// declaration — the two small files THIS client reads — are served normally, and
// the artifact, the tens-of-megabytes fetch the TARGET machine makes for itself,
// comes back the way a bad network gives it back: `die` kills the socket before
// any response, `missing` answers 404, `busy` answers 502. Each path is counted
// separately, so "who asked for the bytes, and how often" is a fact this test can
// read rather than infer.
function serveRelease(dir, { artifact = "die" } = {}) {
  const hits = { manifest: 0, declaration: 0, artifact: 0 };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.replace(/^\/+/, "").split("?")[0]);
    const kind = name.endsWith(".tar.gz") ? "artifact" : name === "clutch-component.json" ? "manifest" : "declaration";
    hits[kind]++;
    if (kind === "artifact") {
      if (artifact === "die") {
        res.socket.destroy(); // a connection that dies mid-fetch: the host reads it as "Remote end closed connection"
        return;
      }
      res.writeHead(artifact === "missing" ? 404 : 502);
      res.end("not here");
      return;
    }
    const file = path.join(dir, name);
    if (!name || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("not here");
      return;
    }
    res.writeHead(200, { "Content-Length": String(fs.statSync(file).size) });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, hits }));
  });
}

// A stand-in for an accelerator: anything under /m/ is served by FILE NAME, with
// the absolute URL it carries taken as the mirror's own business (a real one maps
// it; this one only has to record what was asked for). `busy` answers 503 and
// `refuse` kills the socket — the two ways a mirror is as unreachable as the
// release host was.
function serveMirror(files, { how = "serve" } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (how === "refuse") {
      res.socket.destroy();
      return;
    }
    if (how === "busy") {
      res.writeHead(503);
      res.end("later");
      return;
    }
    const name = decodeURIComponent(req.url.split("?")[0]).split("/").pop();
    if (!Object.prototype.hasOwnProperty.call(files, name)) {
      res.writeHead(404);
      res.end("not here");
      return;
    }
    res.writeHead(200, { "Content-Length": String(files[name].length) });
    res.end(files[name]);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, seen }));
  });
}

let supervisor = null;
let hostRoot = null;
const tempDirs = [HOME];

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function startSupervisor(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ["-m", "agent.supervisor", "--port", "0", "--idle-timeout", "3600"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const timer = setTimeout(() => reject(new Error(`no banner in 20s:\n${log}`)), 20000);
    const onData = (d) => {
      log += String(d);
      const m = BANNER.exec(log);
      if (!m) return;
      clearTimeout(timer);
      resolve({ child, base: `http://127.0.0.1:${m[1]}`, port: Number(m[1]) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`supervisor exited (${code}):\n${log}`)));
  });
}

async function main() {
  hostRoot = tmp("clutch-components-js-");
  supervisor = await startSupervisor({ ...process.env, CLUTCH_COMPONENTS_DIR: hostRoot });
  const base = supervisor.base;

  // 1. where a component comes from is ONE INDEX DOCUMENT, not a list baked into
  //    every client: a row names a module's manifest and pins it. What the
  //    document's own shape has to be is tests/market.test.js; here the point is
  //    that a caller who names an index gets exactly it, and that an EMPTY market
  //    is still a working one — the checkouts beside this repo, nothing to report.
  const indexDir = tmp("clutch-components-index-");
  const emptyIndex = indexOf(indexDir, []);
  const empty = await components.readIndex({ index: emptyIndex });
  check(empty.entries.length === 0 && empty.origin === "given", "a caller that names its own index gets exactly that index");
  check(empty.errors.length === 0 && empty.note === "", "and a readable index holding no rows is not a failure");

  // 2. a fresh host holds nothing
  const before = await components.hostInventory(base);
  check(Array.isArray(before) && before.length === 0, "a fresh host reports no installed components");

  // 3. the components beside this repo are the dev supply, read from each
  //    checkout's OWN component.json — nothing here holds a roster of them.
  const dev = await components.componentSpecs({ index: emptyIndex });
  check(dev.errors.length === 0, `a pass with an empty market has nothing to report (${JSON.stringify(dev.errors)})`);
  check(dev.specs.length >= 4, `every checkout beside the host repo is a component this client knows (${dev.specs.length})`);
  check(dev.specs.every((s) => s.checkout && s.declaration && s.declaration.name === s.name), "and each one declared itself, in its own manifest");

  // 4. the artifact a client would send for a checked-out component
  const spec = await components.artifactFor({ name: "clutch-memory", interface: "cli" }, { checkout: true });
  const haveBash = spawnSync("bash", ["-c", "command -v tar"], { stdio: "pipe" }).status === 0;
  if (!spec || !haveBash) {
    console.log("SKIP: no checkout to archive (or no bash + tar on this host)");
  } else {
    check(fs.statSync(spec.path).isFile(), "the client has an artifact to send for a checked-out component");
    check(/^[0-9a-f]{64}$/.test(spec.digest), "the artifact's sha256 is the version gate's key");
    check(spec.version === spec.digest.slice(0, 16), "a spec that names no version sends the content's own prefix, not a claim");
    check(spec.path.endsWith(".tar.gz"), "an archived checkout keeps its suffix (the host reads the shape from it)");
  }

  // 4b. a component that DOES name a version lands under `<its version>+<digest>`:
  //     the label is what a client can list and what an upgrade is asked by, and
  //     the digest suffix is what keeps the content gate honest. The host reads
  //     that shape already (agent/tools/components.py _VERSION_RE); what is new
  //     is that the client sends it.
  if (haveBash) {
    const own = JSON.parse(fs.readFileSync(path.join(ROOT, "clutch-memory", "component.json"), "utf8")).version;
    const versioned = await components.artifactFor(
      (await components.componentSpecs({ index: emptyIndex })).specs.find((s) => s.name === "clutch-memory"),
      { checkout: true }
    );
    check(
      versioned.version === `${own}+${versioned.digest.slice(0, 16)}`,
      "a versioned component installs under <its own version>+<content digest>"
    );
    check(components.installVersion({ version: "1.2.3" }, "ab".repeat(32)) === "1.2.3+" + "ab".repeat(8), "the recorded version is the component's own, digest appended");
    check(components.installVersion({}, "ab".repeat(32)) === "ab".repeat(8), "a version nobody named stays a bare digest (an identity, not a claim)");
    check(components.installVersion({ version: "1.2.3+deadbeef" }, "ab".repeat(32)) === "1.2.3+deadbeef", "a version that already carries a digest is not suffixed twice");
  }

  // 5. the install pass: upload what the host lacks, land it, gate it next time
  const res = await components.ensureComponents(base, { index: emptyIndex, progress: null });
  check(res.errors.length === 0, `every component installs (${JSON.stringify(res.errors)})`);
  check(res.installed.includes("clutch-memory"), "a missing component is uploaded");
  check(res.current.length === 0 && res.deferred.length === 0, "nothing is skipped on a fresh host");
  const landed = components.CACHE && path.join(hostRoot, "clutch-memory");
  const versions = fs.existsSync(landed) ? fs.readdirSync(landed) : [];
  check(versions.length === 1, "one component, one version in the host's landing directory");
  check(
    fs.existsSync(path.join(landed, versions[0], "memory.py")),
    "the archived checkout unpacks with its entry point at the component's root"
  );
  check(fs.existsSync(path.join(landed, versions[0], "component.json")), "and the declaration rode with the bytes");

  const after = await components.hostInventory(base);
  check(after.length === res.installed.length, "the host lists exactly what was installed");
  check(
    after.every((c) => c.digest && versions.length),
    "each landed component carries the digest the gate compares"
  );
  const held = after.find((c) => c.name === "clutch-memory");
  check(
    held && held.version.endsWith("+" + held.digest.slice(0, 16)),
    "and it lists a version a page can read: the component's own, with the content digest appended"
  );

  // 6. the gate: the second pass sends nothing (the point of a content hash)
  const again = await components.ensureComponents(base, { index: emptyIndex });
  check(again.installed.length === 0, "the second pass uploads nothing");
  check(again.current.includes("clutch-memory"), "what the host already holds is reported current");
  check(again.errors.length === 0, "and the pass is clean");

  // 6b. an OLD RECORD is replaced by the next pass, never kept beside the new
  //     shape (PLUGIN_PLAN.md 七.2, decided: force the reinstall). The force is
  //     the gate itself — the gate compares version AND digest, and a record from
  //     before installs carried a version names nothing but the digest, so no pass
  //     can call it current. This writes exactly what a 0.1.55 install left: a
  //     directory named after the digest, and a manifest whose own `version` is
  //     that digest.
  {
    const tablePath = path.join(hostRoot, "registry.json");
    const table = JSON.parse(fs.readFileSync(tablePath, "utf8"));
    const record = table.components.find((c) => c.name === "clutch-memory");
    const legacy = String(record.digest).slice(0, 16);
    const oldShape = path.join(hostRoot, "clutch-memory", legacy);
    fs.renameSync(path.join(hostRoot, record.location), oldShape);
    const manifestPath = path.join(oldShape, "component.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = legacy;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    record.version = legacy;
    record.location = "clutch-memory/" + legacy;
    fs.writeFileSync(tablePath, JSON.stringify(table, null, 2) + "\n", "utf8");

    const old = (await components.hostInventory(base)).find((c) => c.name === "clutch-memory");
    check(old && old.version === legacy, "an old install reads as the digest alone, which is the shape being retired");

    const unify = await components.ensureComponents(base, { index: emptyIndex });
    check(unify.installed.includes("clutch-memory"), "so the next pass reinstalls it rather than calling it current");
    check(!unify.current.includes("clutch-memory"), "and that component is not reported current while its record is in the old shape");
    const dirs = fs.readdirSync(path.join(hostRoot, "clutch-memory"));
    check(dirs.length === 1 && !dirs.includes(legacy), "the digest-named directory is gone: one shape, not two");
    const unified = (await components.hostInventory(base)).find((c) => c.name === "clutch-memory");
    check(
      unified && unified.version.endsWith("+" + unified.digest.slice(0, 16)),
      "and the record names the release again, with the bytes under it"
    );
  }

  // 7. a host that cannot be reached is reported, never thrown: the pass runs
  //    in the background, so a session starts without waiting for it
  const dead = await components.ensureComponents("http://127.0.0.1:1");
  check(dead.errors.length === 1 && dead.installed.length === 0, "an unreachable host is a report, not a crash");

  // 8. the published supply: a module's release manifest, whose artifact the
  //    TARGET MACHINE fetches for itself (PLUGIN_PLAN.md 零之四.4 — this client
  //    never holds those bytes), pinned by the digest the manifest carries. The
  //    bytes are a DELIBERATELY different artifact than the checkout (one extra
  //    file), so the install is a fetch and not a cache hit.
  const pub = tmp("clutch-components-pub-");
  const pubSrc = path.join(pub, "clutch-memory");
  fs.mkdirSync(pubSrc);
  for (const f of ["memory.py", "pyproject.toml", "component.json"]) {
    fs.copyFileSync(path.join(ROOT, "clutch-memory", f), path.join(pubSrc, f));
  }
  fs.writeFileSync(path.join(pubSrc, "RELEASE"), "the published artifact, not the checkout\n");
  buildTar(pubSrc, path.join(pub, "clutch-memory-any.tar.gz"));
  fs.copyFileSync(path.join(pubSrc, "component.json"), path.join(pub, "component.json")); // the declaration asset, beside the artifact
  const artDigest = sha256(path.join(pub, "clutch-memory-any.tar.gz"));
  const declDigest = sha256(path.join(pub, "component.json"));
  const manifestPath = path.join(pub, "clutch-component.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: 1,
      name: "clutch-memory",
      interface: "cli",
      version: "0.1.0",
      declaration: { asset: "component.json", sha256: declDigest },
      artifacts: { any: { asset: "clutch-memory-any.tar.gz", sha256: artDigest } },
    })
  );
  const pubServer = await serve(pub);
  const source = `${pubServer.base}/clutch-component.json`;
  // the market row that offers this release: one line, pinned to the manifest's bytes
  const releaseIndex = indexOf(tmp("clutch-components-release-index-"), [rowFor(manifestPath, source)]);
  try {
    const manifest = await components.readManifest(source);
    check(manifest.name === "clutch-memory" && manifest.artifacts.any.sha256 === artDigest, "a published manifest names its artifact and its digest");
    check((await components.readManifest(manifestPath)).name === "clutch-memory", "the same manifest works from disk: a source is a URL or a path");
    const merged = (await components.componentSpecs({ index: releaseIndex })).specs.find((s) => s.name === "clutch-memory");
    check(
      Boolean(merged && merged.checkout && merged.published && merged.published.artifacts.any.sha256 === artDigest),
      "a checkout outranks the release it came from, but keeps the release reachable under it"
    );

    // the default direction, pinned from the client side: a release is handed over
    // as the URL its bytes are at plus the digest that pins them, and this machine
    // keeps no copy at all
    // what this client's own cache holds before anything is asked of it: the
    // check below is about what an install adds to it
    const cacheBefore = fs.existsSync(components.CACHE) ? fs.readdirSync(components.CACHE).sort() : [];
    const handed = await components.artifactFor(
      { ...(await components.readManifest(source)), checkout: false },
      { checkout: false }
    );
    check(
      !handed.path && handed.url === `${pubServer.base}/clutch-memory-any.tar.gz`,
      "a published release is handed over as a URL: nothing is downloaded here"
    );
    check(
      handed.digest === artDigest && handed.artifact === "clutch-memory-any.tar.gz",
      "carrying the digest the release pinned and the file's own name (a host reads the artifact's shape from its suffix)"
    );
    check(
      handed.version === `0.1.0+${artDigest.slice(0, 16)}`,
      "and the version it would be recorded under: the release's own, with the content digest appended"
    );

    const pinned = await components.ensureComponents(base, { checkout: false, index: releaseIndex, progress: null });
    check(pinned.errors.length === 0, `a published artifact installs (${JSON.stringify(pinned.errors)})`);
    check(pinned.installed.includes("clutch-memory"), "and it is the release that lands, not the checkout beside the repo");
    // Only the DECLARATION comes through this client (a few hundred bytes, pinned
    // like everything else); the artifact itself is tens of megabytes and the
    // target machine fetches it. So exactly one cache file is new, and it is the
    // declaration — an artifact download here would show up as a second entry.
    const fetchedJustNow = (fs.existsSync(components.CACHE) ? fs.readdirSync(components.CACHE).sort() : []).filter(
      (f) => !cacheBefore.includes(f)
    );
    check(
      fetchedJustNow.length === 1 && fetchedJustNow[0] === `clutch-memory-${declDigest.slice(0, 16)}-component.json`,
      `installing it fetched the declaration and nothing else: the artifact never came through this client (${fetchedJustNow.join(", ")})`
    );
    const published = fs.readdirSync(path.join(hostRoot, "clutch-memory"));
    check(
      published.length === 1 && published[0] === `0.1.0+${artDigest.slice(0, 16)}`,
      "the landed directory is the release's own version + the digest its manifest pinned"
    );
    check(fs.existsSync(path.join(hostRoot, "clutch-memory", published[0], "RELEASE")), "the host holds the published bytes");
    const listed = (await components.hostInventory(base)).find((c) => c.name === "clutch-memory");
    check(
      listed && listed.version === `0.1.0+${artDigest.slice(0, 16)}` && listed.digest === artDigest,
      "and the host hands that version back, so a page can name what this machine holds"
    );

    const repinned = await components.ensureComponents(base, { checkout: false, index: releaseIndex });
    check(repinned.installed.length === 0 && repinned.current.includes("clutch-memory"), "a second pass against the same pin uploads nothing");

    // a manifest that pins nothing is refused rather than trusted: the pin is the
    // only thing that makes a fetch safe, and this client will not hand over an
    // artifact that nothing pins.
    let refused = "";
    try {
      await components.artifactFor({ name: "clutch-nothing", interface: "cli", artifacts: { any: "x.tar.gz" } });
    } catch (e) {
      refused = (e && e.message) || "";
    }
    check(/pins no sha256/.test(refused), "an unpinned artifact is refused, not guessed at");

    // the other half of the same rule — a manifest that pins the WRONG bytes — is
    // not this client's to catch any more: the bytes no longer pass through here,
    // so the machine that fetched them measures them against the pin and refuses.
    // (The URL is served, so the pin is the only thing wrong with the request.)
    fs.writeFileSync(
      path.join(pub, "lying.json"),
      JSON.stringify({
        schema: 1,
        name: "clutch-memory",
        interface: "cli",
        version: "0.1.0",
        artifacts: { any: { asset: "clutch-memory-any.tar.gz", sha256: "0".repeat(64) } },
      })
    );
    // the row pins the MANIFEST's own bytes (so the manifest reads), and the
    // manifest's own artifact pin is the lie: the bytes a host fetches are weighed
    // there, not here
    const lyingIndex = indexOf(tmp("clutch-components-lying-index-"), [
      rowFor(path.join(pub, "lying.json"), `${pubServer.base}/lying.json`),
    ]);
    const deceived = await components.ensureComponents(base, { checkout: false, index: lyingIndex, progress: null });
    check(
      deceived.errors.length === 1 && /hashes to/.test(deceived.errors[0].reason),
      `bytes that do not hash to the pin are refused by the host that fetched them (${JSON.stringify(deceived.errors)})`
    );
    check(deceived.installed.length === 0, "and nothing lands: the host keeps what it already held, unpinned bytes are never recorded");

    fs.writeFileSync(path.join(pub, "future.json"), JSON.stringify({ schema: 2, name: "x", artifacts: {} }));
    let unknown = "";
    try {
      await components.readManifest(path.join(pub, "future.json"));
    } catch (e) {
      unknown = (e && e.message) || "";
    }
    check(/unknown manifest schema/.test(unknown), "a manifest this client cannot read is refused by schema");
  } finally {
    pubServer.server.close();
  }

  // 9. one source read, on a network that is not good: what is asked AGAIN, and
  //    what is not. A release is served from a host reached through a redirect,
  //    and that connection dies on its own now and then — the report this group
  //    comes from was four sources, three bare "fetch failed" and one timeout,
  //    with the page keeping all four for five minutes. So: a connection that
  //    died is asked again (three asks at most, half a second apart), an ANSWER
  //    is never asked again (a status nobody can change; this client's own spent
  //    budget), and what a page reads is a sentence about which of the two
  //    happened, not the fetch implementation's word for one of them.
  {
    const dir = tmp("clutch-components-bad-source-");
    const file = path.join(dir, "clutch-component.json");
    fs.copyFileSync(manifestPath, file);

    // dies twice, answers the third ask
    const flaky = await serveBadly(file, { dieFirst: 2 });
    try {
      const manifest = await components.readManifest(`${flaky.base}/clutch-component.json`);
      check(
        manifest.name === "clutch-memory" && flaky.hits() === 3,
        `a connection that died twice is asked a third time, and the manifest is read (${flaky.hits()} asks)`
      );
    } finally {
      flaky.server.close();
    }

    // dies every time: three asks, then a reason a page can read
    const dead = await serveBadly(file, { dieFirst: 99 });
    try {
      let reason = "";
      try {
        await components.readManifest(`${dead.base}/clutch-component.json`);
      } catch (e) {
        reason = (e && e.message) || "";
      }
      check(
        /^the source could not be reached \(.+\)$/.test(reason) && /asked 3 times/.test(reason),
        `a source whose connection keeps dying is reported in words a user can act on (${reason})`
      );
      check(!/fetch failed/.test(reason), "and not in the words of the fetch implementation, which name neither the layer nor whether the source ever spoke");
      check(dead.hits() === components.MANIFEST_ATTEMPTS, `and it is asked ${components.MANIFEST_ATTEMPTS} times, not forever`);
      const report = await components.componentSpecs({
        index: indexOf(tmp("clutch-components-dead-index-"), [rowFor(manifestPath, `${dead.base}/clutch-component.json`)]),
      });
      check(
        report.errors.length === 1 && report.errors[0].reason === `${dead.base}/clutch-component.json: ${reason}`,
        "the pass reports that reason with the source it belongs to"
      );
      check(report.errors[0].unreachable === true, "and the one bit a page needs to offer a way out: this failure is about reaching the machine");
    } finally {
      dead.server.close();
    }

    // an answer is an answer: the status is reported as it is, and asked once
    const missing = await serveBadly(file);
    try {
      let reason = "";
      try {
        await components.readManifest(`${missing.base}/nope.json`);
      } catch (e) {
        reason = (e && e.message) || "";
      }
      check(/^the source answered 404$/.test(reason) && missing.hits() === 1, "a 404 is an ANSWER: reported as the status it is, and not asked again");
      // the manifest is never served, so its digest is never weighed: the row
      // exists to be asked for, and the answer is the 404 the case is about
      const report = await components.componentSpecs({
        index: indexOf(tmp("clutch-components-404-index-"), [rowFor(manifestPath, `${missing.base}/nope.json`)]),
      });
      check(
        report.errors.length === 1 && report.errors[0].unreachable === false,
        "and it is not the failure a mirror answers: the trouble is what the source has, not how this machine reached it"
      );
    } finally {
      missing.server.close();
    }

    // the budget: a source that opens a connection and never speaks is a timeout,
    // said as one, and NOT asked again — three budgets would be a minute and a
    // half of "reading…" for a source that is simply not coming back
    const mute = await serveBadly(file, { silent: true });
    try {
      let reason = "";
      try {
        await components.readManifest(`${mute.base}/clutch-component.json`);
      } catch (e) {
        reason = (e && e.message) || "";
      }
      check(/^the source did not answer within 1 s$/.test(reason), `a source that never speaks is a timeout, in seconds (${reason})`);
      check(mute.hits() === 1, "and a budget already spent is not spent again: it is asked once");
      const report = await components.componentSpecs({
        index: indexOf(tmp("clutch-components-mute-index-"), [rowFor(manifestPath, `${mute.base}/clutch-component.json`)]),
      });
      check(
        report.errors.length === 1 && report.errors[0].unreachable === true,
        "a source that never answers is one this machine cannot reach, so a mirror is the way out of it too"
      );
    } finally {
      if (mute.server.closeAllConnections) mute.server.closeAllConnections();
      mute.server.close();
    }
  }

  // 10. when the release host cannot be reached, and the bytes are the TARGET
  //     machine's fetch (PLUGIN_PLAN.md 零之四.4), the retry is the HOST's: the
  //     same pin, asked of another place (ui/mirrors.js). Everything that makes
  //     that safe is checked here — a mirror is a URL prefix and nothing more (the
  //     digest is still the release's own pin, so bytes a mirror made up are
  //     refused), the places are tried in order, and an ANSWER is never retried
  //     (a 404 and a body that does not hash are facts a mirror cannot change).
  {
    // A release of this test's OWN — the same component, built once more under a
    // name of its own — so that landing it cannot disturb the version the other
    // groups install and then check (a host runs one version per component).
    const rel = tmp("clutch-components-mirror-");
    const inside = path.join(rel, "clutch-mirror");
    fs.mkdirSync(inside);
    for (const f of ["memory.py", "pyproject.toml"]) {
      fs.copyFileSync(path.join(ROOT, "clutch-memory", f), path.join(inside, f));
    }
    // the declaration travels WITH the bytes, and one naming another component is a
    // refusal rather than a merge: this one names exactly what it is
    const own = JSON.parse(fs.readFileSync(path.join(ROOT, "clutch-memory", "component.json"), "utf8"));
    fs.writeFileSync(
      path.join(inside, "component.json"),
      JSON.stringify({ ...own, name: "clutch-mirror", version: "0.2.0" }, null, 2)
    );
    fs.writeFileSync(path.join(inside, "MIRRORED"), "the bytes a mirror serves\n"); // its own release, so its own digest
    buildTar(inside, path.join(rel, "clutch-mirror-any.tar.gz"));
    fs.copyFileSync(path.join(inside, "component.json"), path.join(rel, "component.json"));
    const bytes = fs.readFileSync(path.join(rel, "clutch-mirror-any.tar.gz"));
    const artPin = sha256(path.join(rel, "clutch-mirror-any.tar.gz"));
    const declPin = sha256(path.join(rel, "component.json"));
    fs.writeFileSync(
      path.join(rel, "clutch-component.json"),
      JSON.stringify({
        schema: 1,
        name: "clutch-mirror",
        interface: "cli",
        version: "0.2.0",
        declaration: { asset: "component.json", sha256: declPin },
        artifacts: { any: { asset: "clutch-mirror-any.tar.gz", sha256: artPin } },
      })
    );

    const dead = "http://127.0.0.1:1/m"; // nothing listens here: a prefix as unreachable as the release host
    const host = await serveRelease(rel); // the artifact fetch dies; the manifest is read fine
    const mirror = await serveMirror({ "clutch-mirror-any.tar.gz": bytes });
    const manifestFile = path.join(rel, "clutch-component.json");
    const source = `${host.base}/clutch-component.json`;
    const mirrorIndex = indexOf(tmp("clutch-components-mirror-index-"), [rowFor(manifestFile, source)]);
    try {
      const spec = (await components.componentSpecs({ index: mirrorIndex })).specs.find((s) => s.name === "clutch-mirror");
      check(
        Boolean(spec && spec.source === source && spec.artifacts.any.sha256 === artPin),
        "the release itself reads normally: what is broken is the artifact, not the manifest"
      );
      const handed = await components.artifactFor(spec, { checkout: false, mirrorFallback: [mirror.base + "/m"] });
      check(
        handed.mirrors.length === 1 && handed.mirrors[0] === mirror.base + "/m",
        "the spec carries the places this install may be retried through, in the caller's order"
      );
      check(handed.via === "" && handed.digest === artPin, "and says nothing is already read through one: the pin is the release's own");

      const retries = [];
      const out = await components.fetchInstall(base, handed, 8000, {
        onRetry: (prefix, reason) => retries.push(`${prefix} | ${reason}`),
      });
      check(
        out.status === "installed" && out.via === mirror.base + "/m",
        `an artifact the release host cannot answer is fetched through the mirror, and the answer says which (${out.status}, via ${out.via})`
      );
      check(
        host.hits.artifact === 1 && mirror.seen.length === 1,
        `each place was asked once, in order (${host.hits.artifact} of the release host, ${mirror.seen.length} of the mirror)`
      );
      check(
        /^\/m\/https?:\/\//.test(String(mirror.seen[0] || "")),
        `and the mirror was asked for the artifact under its own prefix — <mirror>/<the absolute url> (${mirror.seen[0]})`
      );
      check(
        retries.length === 1 && retries[0].startsWith(mirror.base + "/m") && /closed connection|refused|reset/.test(retries[0]),
        `the page learns which mirror is being tried, and why, before it takes its own timeout (${retries[0]})`
      );
      check(
        fs.existsSync(path.join(hostRoot, "clutch-mirror", `0.2.0+${artPin.slice(0, 16)}`)),
        "and what landed is the release's own version + the pin's digest: the mirror carried the bytes, it did not vouch for them"
      );
      const held = (await components.hostInventory(base)).find((c) => c.name === "clutch-mirror");
      check(
        Boolean(held && held.version === `0.2.0+${artPin.slice(0, 16)}` && held.digest === artPin),
        "the host records exactly what it weighed, so a page can name what it holds"
      );
    } finally {
      host.server.close();
      mirror.server.close();
    }

    // a mirror that serves SOMETHING ELSE is refused by the pin, and refused as an
    // answer: the first place that answered about the bytes has settled them. The
    // pin here is one this host does not hold, so the bytes really are weighed (an
    // install it already has is answered "current" before the digests are compared).
    fs.writeFileSync(
      path.join(rel, "wrong-pin.json"),
      JSON.stringify({
        schema: 1,
        name: "clutch-mirror",
        interface: "cli",
        version: "0.2.0",
        declaration: { asset: "component.json", sha256: declPin },
        artifacts: { any: { asset: "clutch-mirror-any.tar.gz", sha256: "a".repeat(64) } },
      })
    );
    const liar = await serveMirror({ "clutch-mirror-any.tar.gz": Buffer.from("not the release's bytes\n") });
    const next = await serveMirror({ "clutch-mirror-any.tar.gz": bytes });
    const lyingHost = await serveRelease(rel);
    try {
      const wrongIndex = indexOf(tmp("clutch-components-wrong-pin-index-"), [
        rowFor(path.join(rel, "wrong-pin.json"), `${lyingHost.base}/wrong-pin.json`),
      ]);
      const spec = (await components.componentSpecs({ index: wrongIndex })).specs.find((s) => s.name === "clutch-mirror");
      const handed = await components.artifactFor(spec, {
        checkout: false,
        mirrorFallback: [liar.base + "/m", next.base + "/m"],
      });
      let refusal = "";
      try {
        await components.fetchInstall(base, handed, 8000);
      } catch (e) {
        refusal = (e && e.message) || "";
      }
      check(
        /the artifact hashes to .+, not the declared /.test(refusal),
        `bytes a mirror made up are refused by the host that fetched them (${refusal})`
      );
      check(next.seen.length === 0, "and no further mirror is asked: the pin already answered what the first one was asked");
    } finally {
      liar.server.close();
      next.server.close();
      lyingHost.server.close();
    }

    // an ANSWER is never retried, at any level: the release host's 404 is about the
    // path, and every mirror serves the same path, so it is quoted as it stands
    const absent = await serveRelease(rel, { artifact: "missing" });
    const unused = await serveMirror({ "clutch-mirror-any.tar.gz": bytes });
    try {
      const absentIndex = indexOf(tmp("clutch-components-absent-index-"), [
        rowFor(manifestFile, `${absent.base}/clutch-component.json`),
      ]);
      const spec = (await components.componentSpecs({ index: absentIndex })).specs.find((s) => s.name === "clutch-mirror");
      const handed = await components.artifactFor(spec, { checkout: false, mirrorFallback: [unused.base + "/m"] });
      let answer = "";
      try {
        await components.fetchInstall(base, handed, 8000);
      } catch (e) {
        answer = (e && e.message) || "";
      }
      check(/^HTTP Error 404: Not Found$/.test(answer), `a 404 is the host's verdict on the path, quoted in the host's own words (${answer})`);
      check(unused.seen.length === 0, "and nothing else is asked: the same bytes are at the same path");
    } finally {
      absent.server.close();
      unused.server.close();
    }

    // every place tried and none answering: ONE sentence a page can draw in a single
    // row — what the release host said, how many places were tried, and the last
    // thing one of them said
    const stubborn = await serveRelease(rel);
    const busy = await serveMirror({}, { how: "busy" });
    try {
      const stubbornIndex = indexOf(tmp("clutch-components-stubborn-index-"), [
        rowFor(manifestFile, `${stubborn.base}/clutch-component.json`),
      ]);
      const spec = (await components.componentSpecs({ index: stubbornIndex })).specs.find((s) => s.name === "clutch-mirror");
      const handed = await components.artifactFor(spec, {
        checkout: false,
        mirrorFallback: [dead, busy.base + "/m"],
      });
      // the release host on its own first, so that the longer sentence below can
      // be held to BEGIN with exactly what it said: the failure is reported, not
      // paraphrased, and the fetch implementation's wording is not this test's to
      // know (it differs by machine and by how the socket died)
      let alone = "";
      try {
        await components.fetchInstall(base, handed, 8000, { mirrorFallback: [] });
      } catch (e) {
        alone = (e && e.message) || "";
      }
      check(/closed connection|refused|reset|timed?[-_ ]?out/.test(alone), `the release host's own failure is a network one (${alone})`);
      let covered = "";
      try {
        await components.fetchInstall(base, handed, 8000);
      } catch (e) {
        covered = (e && e.message) || "";
      }
      check(
        covered.startsWith(`${alone} — and not through 2 mirrors (`) && covered.includes(dead) &&
          covered.includes(busy.base + "/m") && /either: the last one said HTTP Error 503/.test(covered),
        `a failure everywhere is one sentence naming the first failure, the places tried, and the last thing said (${covered})`
      );
      check(busy.seen.length === 1, "every place was tried exactly once, and the order was the list's");
    } finally {
      stubborn.server.close();
      busy.server.close();
    }
  }

  // 11. the reverse verbs, against the same real machine: which versions it holds
  //    for ONE component (newest first, and the one it would run), stopping or
  //    starting the driving of it, and letting that component go. The verdicts
  //    that matter are all here — "removed" with the versions that went, "absent"
  //    for a request already true (twice: switching a component this host does not
  //    hold, and removing one it no longer does), and the switch's own bit.
  {
    const versions = await components.hostVersions(base, "clutch-memory");
    check(versions.length === 1 && versions[0].resolved === true, "the host lists the versions it holds for one component, and which one it would run");
    check(versions[0].version === `0.1.0+${artDigest.slice(0, 16)}`, "and it is the version this client installed, digest and all");

    let badName = "";
    try {
      await components.hostVersions(base, "../../etc");
    } catch (e) {
      badName = (e && e.message) || "";
    }
    check(/bad component name/.test(badName), "a name that could never be an install is refused in the host's own words");

    // the switch: the third verb, and the only one that moves no bytes. What it
    // must NOT do is what is checked first — the component stays held, stays
    // listed and keeps its version, and only the bit changes.
    const off = await components.hostSetDisabled(base, "clutch-memory", true);
    check(off.status === "disabled" && off.disabled === true, "the host answers the switch with the bit it now holds");
    const stopped = (await components.hostInventory(base)).find((c) => c.name === "clutch-memory");
    check(Boolean(stopped) && stopped.disabled === true, "a stopped component is still HELD: it stays listed, marked, with its bytes");
    check(stopped.version === `0.1.0+${artDigest.slice(0, 16)}`, "and it still names the version that is there");
    check(fs.existsSync(path.join(hostRoot, "clutch-memory")), "because nothing was deleted");
    check((await components.hostVersions(base, "clutch-memory")).length === 1, "the finer list still holds its version too");

    const on = await components.hostSetDisabled(base, "clutch-memory", false);
    check(on.status === "enabled" && on.disabled === false, "and the other direction answers with the other bit");
    const driving = (await components.hostInventory(base)).find((c) => c.name === "clutch-memory");
    check(driving.disabled === false, "so this machine offers its tools again");

    const notHeld = await components.hostSetDisabled(base, "clutch-nothing", true);
    check(notHeld.status === "absent", "switching a component this machine does not hold is 'absent' — an answer, not a failure");

    let badSwitch = "";
    try {
      await components.hostSetDisabled(base, "../../etc", true);
    } catch (e) {
      badSwitch = (e && e.message) || "";
    }
    check(/bad component name/.test(badSwitch), "and a name that could never be an install is refused before anything is written");

    const removed = await components.hostRemove(base, "clutch-memory", "");
    check(removed.status === "removed" && removed.removed.length === 1, "a removal answers with the versions that went");
    check(!fs.existsSync(path.join(hostRoot, "clutch-memory")), "and the bytes are gone from the machine");
    const left = await components.hostInventory(base);
    check(!left.some((c) => c.name === "clutch-memory"), "and it is gone from what the host lists as held");

    const again = await components.hostRemove(base, "clutch-memory", "");
    check(again.status === "absent", "removing what is already gone answers 'absent' rather than failing");
    check((await components.hostVersions(base, "clutch-memory")).length === 0, "and the host names no version of it any more");
  }

  // 12. cleanup: this run's supervisor goes away (its root is a temp dir)
  try {
    await fetch(`${base}/api/shutdown`, { method: "POST" });
  } catch (e) {
    /* already gone */
  }
  await sleep(300);
  return 0;
}

function cleanup() {
  if (supervisor && supervisor.child && supervisor.child.exitCode === null) {
    try {
      supervisor.child.kill();
    } catch (e) {
      /* already gone */
    }
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* best effort */
    }
  }
}

main()
  .then(() => {
    cleanup();
    summary("components", "all passed (checkout + published supplies, client install + host gate, reverse verbs incl. the switch)");
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    cleanup();
    process.exit(1);
  });
