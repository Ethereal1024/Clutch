// Standalone check for ui/components.js (the install layer's sending half).
// Run: node tests/components.test.js
//
// A real machine supervisor is started on a random port with its own temp
// component root, so the whole path is exercised end to end: read what the host
// holds, build the artifact a client would send, upload it, and let the HOST
// land it. No mocks: the gate, the digest and the unpacking are the product's.
//
// The dev artifact is the checkout tarred by scripts/build-component-tar.sh —
// the shape a client with no prebuilt onefile has to send — so bash + tar are
// required. Without them the dev-supply checks SKIP (an environment limit).

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { check, summary } = require("./harness");
const components = require("../ui/components");

const ROOT = path.join(__dirname, "..");
const PY = path.join(ROOT, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
const BANNER = /http:\/\/127\.0\.0\.1:(\d+)/;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let supervisor = null;
let hostRoot = null;

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
  hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-components-js-"));
  supervisor = await startSupervisor({ ...process.env, CLUTCH_COMPONENTS_DIR: hostRoot });
  const base = supervisor.base;

  // 1. a fresh host holds nothing
  const before = await components.hostInventory(base);
  check(Array.isArray(before) && before.length === 0, "a fresh host reports no installed components");

  // 2. the artifact a client would send for a checked-out component
  const spec = components.artifactFor({ name: "clutch-memory", interface: "cli" }, { checkout: true });
  const haveBash = spawnSync(components.artifactFor ? "bash" : "bash", ["-c", "command -v tar"], { stdio: "pipe" }).status === 0;
  if (!spec || !haveBash) {
    console.log("SKIP: no checkout to archive (or no bash + tar on this host)");
  } else {
    check(fs.statSync(spec.path).isFile(), "the client has an artifact to send for a checked-out component");
    check(/^[0-9a-f]{64}$/.test(spec.digest), "the artifact's sha256 is the version gate's key");
    check(spec.version === spec.digest.slice(0, 16), "the version is the content's own prefix, not a claim");
    check(spec.path.endsWith(".tar.gz"), "an archived checkout keeps its suffix (the host reads the shape from it)");
  }

  // 3. the install pass: upload what the host lacks, land it, gate it next time
  const res = await components.ensureComponents(base, { progress: null });
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

  const after = await components.hostInventory(base);
  check(after.length === res.installed.length, "the host lists exactly what was installed");
  check(
    after.every((c) => c.digest && versions.length),
    "each landed component carries the digest the gate compares"
  );

  // 4. the gate: the second pass sends nothing (the point of a content hash)
  const again = await components.ensureComponents(base);
  check(again.installed.length === 0, "the second pass uploads nothing");
  check(again.current.includes("clutch-memory"), "what the host already holds is reported current");
  check(again.errors.length === 0, "and the pass is clean");

  // 5. a host that cannot be reached is reported, never thrown: a component is an
  //    optimization, and a session must start without one (R2)
  const dead = await components.ensureComponents("http://127.0.0.1:1");
  check(dead.errors.length === 1 && dead.installed.length === 0, "an unreachable host is a report, not a crash");

  // 6. cleanup: this run's supervisor goes away (its root is a temp dir)
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
  if (hostRoot) {
    try {
      fs.rmSync(hostRoot, { recursive: true, force: true });
    } catch (e) {
      /* best effort */
    }
  }
}

main()
  .then(() => {
    cleanup();
    summary("components", "all passed (client install + host gate)");
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    cleanup();
    process.exit(1);
  });
