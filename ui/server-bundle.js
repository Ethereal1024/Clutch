// Bundle builder + cache for the remote clutch-server.
//
// Two self-contained artifacts, cached in ~/.clutch/bundles/ keyed by the target
// platform + git HEAD:
//   - agent-server-<os>-<arch>-<ver>        PyInstaller onefile (no python needed)
//   - agent-pylibs-<os>-<arch>-<libc>-<pyver>-<ver>.tar.gz source + site-packages
//     downloaded for the TARGET platform (client runs pip; the remote never does)
//
// Anything the deterministic paths can't cover goes to the client-side LLM
// assisted installer instead of an infinite build matrix.

const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const REPO = path.join(__dirname, "..");
const CACHE = path.join(os.homedir(), ".clutch", "bundles");

const OS_MAP = { linux: "linux", darwin: "darwin", win32: "windows", freebsd: "freebsd" };
const ARCH_MAP = { x64: "x86_64", arm64: "arm64", ia32: "i686" };

function getVersion() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO });
  return r.stdout.toString().trim() || "dev";
}

function platformTag() {
  return `${OS_MAP[os.platform()] || os.platform()}-${ARCH_MAP[os.arch()] || os.arch()}`;
}

function ensureBundle(version = getVersion()) {
  const out = path.join(CACHE, `agent-server-${platformTag()}-${version}`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(CACHE, { recursive: true });
  // Packaged app: the deb already ships a same-platform onefile binary in
  // resources/ — seed the cache with it instead of rebuilding from the repo
  // (which a packaged app does not contain). Cache key uses the "dev" version
  // tag, matching getVersion() when there is no git repo.
  if (typeof process.resourcesPath === "string") {
    const bundled = path.join(process.resourcesPath, "agent-server");
    if (fs.existsSync(bundled)) {
      fs.copyFileSync(bundled, out);
      try {
        fs.chmodSync(out, 0o755);
      } catch (e) {
        /* best effort */
      }
      return out;
    }
  }
  const r = spawnSync("bash", [path.join(REPO, "scripts", "build-server-bundle.sh"), version, out], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("bundle build failed");
  return out;
}

// target: { os, arch, libc, pyver } from the remote probe. Downloads the exact
// wheels for that platform on the client and packages agent + site-packages.
function ensurePyLibsTar(version, target) {
  const key = `${target.os}-${target.arch}-${target.libc}-${target.pyver}-${version}`;
  const out = path.join(CACHE, `agent-pylibs-${key}.tar.gz`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(CACHE, { recursive: true });
  const r = spawnSync(
    "bash",
    [
      path.join(REPO, "scripts", "build-pylibs-tar.sh"),
      key,
      out,
      target.os,
      target.arch,
      target.libc,
      target.pyver,
    ],
    { cwd: REPO, stdio: "inherit" }
  );
  if (r.status !== 0) throw new Error("pylibs tar build failed");
  return out;
}

module.exports = { getVersion, platformTag, ensureBundle, ensurePyLibsTar };

