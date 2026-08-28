// Bundle builder + cache for the remote clutch-server.
//
// Two self-contained artifacts, both cached in ~/.clutch/bundles/ keyed by
// <platform>-<git HEAD>:
//   - agent-server-<os>-<arch>-<ver>        PyInstaller onefile (no python needed)
//   - agent-pylibs-<os>-<arch>-<ver>.tar.gz source + venv site-packages (runs on a
//     remote python3 of the same minor/arch, no internet required)
//
// Cross-platform remotes are not pre-built: the adaptive installer (venv+pip or
// the client-side LLM assist) handles them instead of an infinite build matrix.

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

function clientPythonMinor() {
  const r = spawnSync(path.join(REPO, ".venv", "bin", "python"), ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"]);
  return r.stdout.toString().trim() || "";
}

function ensureBundle(version = getVersion()) {
  const out = path.join(CACHE, `agent-server-${platformTag()}-${version}`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(CACHE, { recursive: true });
  const r = spawnSync("bash", [path.join(REPO, "scripts", "build-server-bundle.sh"), version, out], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("bundle build failed");
  return out;
}

function ensurePyLibsTar(version = getVersion()) {
  const out = path.join(CACHE, `agent-pylibs-${platformTag()}-${version}.tar.gz`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(CACHE, { recursive: true });
  const r = spawnSync("bash", [path.join(REPO, "scripts", "build-pylibs-tar.sh"), version, out], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("pylibs tar build failed");
  return out;
}

module.exports = { getVersion, platformTag, clientPythonMinor, ensureBundle, ensurePyLibsTar };
