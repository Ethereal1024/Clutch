// Bundle builder + content-hash cache: the hash doubles as the version written
// to the remote's VERSION file (an exact content match is the only install gate).
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const REPO = path.join(__dirname, "..");
const CACHE = path.join(os.homedir(), ".clutch", "bundles");

const OS_MAP = { linux: "linux", darwin: "darwin", win32: "windows", freebsd: "freebsd" };
const ARCH_MAP = { x64: "x86_64", arm64: "arm64", ia32: "i686" };

function platformTag() {
  return `${OS_MAP[os.platform()] || os.platform()}-${ARCH_MAP[os.arch()] || os.arch()}`;
}

function fileHash(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// Dev build gate: fingerprint the source so PyInstaller only reruns on changes
function sourceFingerprint() {
  const h = crypto.createHash("sha256");
  const visit = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (name === "__pycache__") continue;
        visit(path.join(p, name));
      }
    } else if (!p.endsWith(".pyc") && !p.endsWith("_test.py")) {
      h.update(path.relative(REPO, p)).update("\0").update(fs.readFileSync(p));
    }
  };
  for (const root of ["agent", "scripts/server_entry.py", "scripts/supervisor_entry.py", "scripts/build-server-bundle.sh"]) {
    visit(path.join(REPO, root));
  }
  return h.digest("hex");
}

function buildIfStale() {
  const dist = path.join(REPO, "dist");
  const marker = path.join(dist, ".clutch-fingerprint");
  const fp = sourceFingerprint();
  const built =
    fs.existsSync(path.join(dist, "agent-server")) && fs.existsSync(path.join(dist, "agent-supervisor"));
  if (built && fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === fp) return;
  fs.mkdirSync(dist, { recursive: true });
  const r = spawnSync(
    "bash",
    [path.join(REPO, "scripts", "build-server-bundle.sh"), "dev", path.join(dist, "agent-server")],
    { cwd: REPO, stdio: "inherit" }
  );
  if (r.status !== 0) throw new Error("bundle build failed");
  fs.writeFileSync(marker, fp);
}

// app.isPackaged is the signal: resourcesPath also exists in dev mode, and in
// plain node require("electron") yields the binary path (so .app is undefined
// and we fall back to the dev build).
function isPackagedApp() {
  try {
    return require("electron").app.isPackaged;
  } catch (e) {
    return false;
  }
}

// Resolve agent binaries (packaged resources or a dev build), cache under a
// content-hash key, return paths + combined version hash.
function ensureBundle() {
  let server, supervisor;
  if (isPackagedApp()) {
    server = path.join(process.resourcesPath, "agent-server");
    supervisor = path.join(process.resourcesPath, "agent-supervisor");
    if (!fs.existsSync(server) || !fs.existsSync(supervisor)) {
      throw new Error("packaged server binaries missing from resources/");
    }
  } else {
    buildIfStale();
    server = path.join(REPO, "dist", "agent-server");
    supervisor = path.join(REPO, "dist", "agent-supervisor");
  }
  const version = fileHash(server) + fileHash(supervisor);
  const tag = platformTag();
  const out = path.join(CACHE, `agent-server-${tag}-${version}`);
  const supOut = path.join(CACHE, `agent-supervisor-${tag}-${version}`);
  if (!fs.existsSync(out) || !fs.existsSync(supOut)) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.copyFileSync(server, out);
    fs.copyFileSync(supervisor, supOut);
    try {
      fs.chmodSync(out, 0o755);
      fs.chmodSync(supOut, 0o755);
    } catch (e) {
      /* best effort */
    }
  }
  return { server: out, supervisor: supOut, version };
}

// Download exact wheels for the remote platform, package agent + site-packages
// into a tar cached under a content-hash key.
function ensurePyLibsTar(target) {
  const key = `${target.os}-${target.arch}-${target.libc}-${target.pyver}`;
  fs.mkdirSync(CACHE, { recursive: true });
  const tmp = path.join(CACHE, `.pylibs-${key}-${process.pid}.tar.gz`);
  const r = spawnSync(
    "bash",
    [path.join(REPO, "scripts", "build-pylibs-tar.sh"), key, tmp, target.os, target.arch, target.libc, target.pyver],
    { cwd: REPO, stdio: "inherit" }
  );
  if (r.status !== 0) throw new Error("pylibs tar build failed");
  const version = fileHash(tmp).slice(0, 16);
  const out = path.join(CACHE, `agent-pylibs-${key}-${version}.tar.gz`);
  if (fs.existsSync(out)) fs.unlinkSync(tmp);
  else fs.renameSync(tmp, out);
  return { path: out, version };
}

module.exports = { platformTag, ensureBundle, ensurePyLibsTar };
