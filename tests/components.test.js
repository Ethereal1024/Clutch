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
//   - a module's PUBLISHED release manifest, fetched over http from a server
//     this test runs: the file it names is relative to the manifest and pinned by
//     the sha256 the manifest carries, and the HOST is the one that fetches it —
//     the install request carries the URL and the pin, no bytes (PLUGIN_PLAN.md
//     零之四.4), and nothing lands unless what the host fetched matches the pin.
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
      (await components.componentSpecs({ sources: [] })).specs.find((s) => s.name === "clutch-memory"),
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
  const held = after.find((c) => c.name === "clutch-memory");
  check(
    held && held.version.endsWith("+" + held.digest.slice(0, 16)),
    "and it lists a version a page can read: the component's own, with the content digest appended"
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
  try {
    const manifest = await components.readManifest(source);
    check(manifest.name === "clutch-memory" && manifest.artifacts.any.sha256 === artDigest, "a published manifest names its artifact and its digest");
    check((await components.readManifest(manifestPath)).name === "clutch-memory", "the same manifest works from disk: a source is a URL or a path");
    const merged = (await components.componentSpecs({ sources: [source] })).specs.find((s) => s.name === "clutch-memory");
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

    const pinned = await components.ensureComponents(base, { checkout: false, sources: [source], progress: null });
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

    const repinned = await components.ensureComponents(base, { checkout: false, sources: [source] });
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
    const deceived = await components.ensureComponents(base, {
      checkout: false,
      sources: [`${pubServer.base}/lying.json`],
      progress: null,
    });
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

  // 9. the reverse verbs, against the same real machine: which versions it holds
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

  // 10. cleanup: this run's supervisor goes away (its root is a temp dir)
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
