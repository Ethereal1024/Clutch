// Standalone check for ui/components.js (the install layer's sending half).
// Run: node tests/components.test.js
//
// A real machine supervisor is started on a random port with its own temp
// component root, so the whole path is exercised end to end: read what the host
// holds, build the artifact a client would send, upload it, and let the HOST
// land it. No mocks: the gate, the digest and the unpacking are the product's.
//
// Two supplies are checked, because they are the two the product has:
//
//   - a DEV CHECKOUT beside this repo, tarred by scripts/build-component-tar.sh
//     (so bash + tar are required; without them those checks SKIP — an
//     environment limit), and
//   - a module's PUBLISHED release manifest, fetched over http from a server
//     this test runs: the file it names is relative to the manifest, pinned by
//     the sha256 the manifest carries, and installed only if the bytes match.
//
// The run gets its own HOME: the client caches downloads in ~/.clutch/artifacts,
// so pointing the cache at a temp directory keeps the user's real one untouched
// (and makes the source-list override below a file, not a stub).

"use strict";

const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-components-home-"));
if (process.platform !== "win32") process.env.HOME = HOME; // components.js reads it at load

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

  // 1. where a component comes from is DATA this build ships, not code: the list
  //    of module release manifests, with the user's own list read first so a
  //    user can override a source this build knows.
  const listed = components.sources();
  check(listed.length > 0 && listed.every((s) => /^https?:\/\//.test(s)), "the build ships a source list, and a source is a URL");
  check(listed.every((s) => /clutch-component\.json$/.test(s)), "and each source is a module's own release manifest");
  check(components.sources([]).length === 0, "a caller that names its own list gets exactly that list");
  fs.mkdirSync(path.dirname(components.USER_SOURCES_FILE), { recursive: true });
  fs.writeFileSync(components.USER_SOURCES_FILE, JSON.stringify({ schema: 1, sources: ["https://example.invalid/mine.json"] }));
  const withUser = components.sources();
  check(withUser[0] === "https://example.invalid/mine.json", "a user's own list is read first, so it outranks a source this build ships");
  check(withUser.includes(listed[0]), "and the shipped list stays as the fallback");
  fs.rmSync(components.USER_SOURCES_FILE);

  // 2. a fresh host holds nothing
  const before = await components.hostInventory(base);
  check(Array.isArray(before) && before.length === 0, "a fresh host reports no installed components");

  // 3. the components beside this repo are the dev supply, read from each
  //    checkout's OWN component.json — nothing here holds a roster of them.
  const dev = await components.componentSpecs({ sources: [] });
  check(dev.errors.length === 0, `a pass with no sources has nothing to report (${JSON.stringify(dev.errors)})`);
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
    check(spec.version === spec.digest.slice(0, 16), "the version is the content's own prefix, not a claim");
    check(spec.path.endsWith(".tar.gz"), "an archived checkout keeps its suffix (the host reads the shape from it)");
  }

  // 5. the install pass: upload what the host lacks, land it, gate it next time
  const res = await components.ensureComponents(base, { sources: [], progress: null });
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

  // 6. the gate: the second pass sends nothing (the point of a content hash)
  const again = await components.ensureComponents(base, { sources: [] });
  check(again.installed.length === 0, "the second pass uploads nothing");
  check(again.current.includes("clutch-memory"), "what the host already holds is reported current");
  check(again.errors.length === 0, "and the pass is clean");

  // 7. a host that cannot be reached is reported, never thrown: the pass runs
  //    in the background, so a session starts without waiting for it
  const dead = await components.ensureComponents("http://127.0.0.1:1");
  check(dead.errors.length === 1 && dead.installed.length === 0, "an unreachable host is a report, not a crash");

  // 8. the published supply: a module's release manifest, its artifact downloaded
  //    over http and pinned by the digest the manifest carries. The bytes are a
  //    DELIBERATELY different artifact than the checkout (one extra file), so the
  //    install is the download and not a cache hit.
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
  try {
    const manifest = await components.readManifest(source);
    check(manifest.name === "clutch-memory" && manifest.artifacts.any.sha256 === artDigest, "a published manifest names its artifact and its digest");
    check((await components.readManifest(manifestPath)).name === "clutch-memory", "the same manifest works from disk: a source is a URL or a path");
    const merged = (await components.componentSpecs({ sources: [source] })).specs.find((s) => s.name === "clutch-memory");
    check(
      Boolean(merged && merged.checkout && merged.published && merged.published.artifacts.any.sha256 === artDigest),
      "a checkout outranks the release it came from, but keeps the release reachable under it"
    );

    const pinned = await components.ensureComponents(base, { checkout: false, sources: [source], progress: null });
    check(pinned.errors.length === 0, `a published artifact installs (${JSON.stringify(pinned.errors)})`);
    check(pinned.installed.includes("clutch-memory"), "and it is the download that lands, not the checkout beside the repo");
    const published = fs.readdirSync(path.join(hostRoot, "clutch-memory"));
    check(published.length === 1 && published[0] === artDigest.slice(0, 16), "the landed version IS the digest its manifest pinned");
    check(fs.existsSync(path.join(hostRoot, "clutch-memory", published[0], "RELEASE")), "the host holds the published bytes");

    const repinned = await components.ensureComponents(base, { checkout: false, sources: [source] });
    check(repinned.installed.length === 0 && repinned.current.includes("clutch-memory"), "a second pass against the same pin uploads nothing");

    // a manifest that pins nothing, or pins the wrong bytes, is refused rather
    // than trusted — the pin is the only thing that makes a download safe
    let refused = "";
    try {
      await components.artifactFor({ name: "clutch-nothing", interface: "cli", artifacts: { any: "x.tar.gz" } });
    } catch (e) {
      refused = (e && e.message) || "";
    }
    check(/pins no sha256/.test(refused), "an unpinned artifact is refused, not guessed at");

    let lied = "";
    try {
      await components.artifactFor({
        name: "clutch-nothing",
        interface: "cli",
        source,
        artifacts: { any: { asset: "clutch-memory-any.tar.gz", sha256: "0".repeat(64) } },
      });
    } catch (e) {
      lied = (e && e.message) || "";
    }
    check(/sha256 [0-9a-f]+, not the [0-9a-f]+ its manifest pins/.test(lied), "bytes that do not hash to the pin are refused");

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

  // 9. cleanup: this run's supervisor goes away (its root is a temp dir)
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
    summary("components", "all passed (checkout + published supplies, client install + host gate)");
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    cleanup();
    process.exit(1);
  });
