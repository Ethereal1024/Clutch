// Bundle builder + content-hash cache: the hash doubles as the version written
// to the remote's VERSION file (an exact content match is the only install gate).
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const REPO = path.join(__dirname, "..");
const CACHE = path.join(os.homedir(), ".clutch", "bundles");

// On Windows, a bare "bash" from PATH may not exist (an Explorer-launched app
// does not see Git's bin/) or may be WSL's System32\bash.exe, which sees a
// completely different filesystem. Locate a real Git Bash / MSYS2 bash — the
// same detection tests/ssh-tunnel.test.js and agent/tools/localshell.py use.
let bashPath = null;
function resolveBash() {
  if (bashPath) return bashPath;
  if (process.platform !== "win32") return (bashPath = "bash");
  const sysDir = path.resolve(process.env.SystemRoot || "C:\\Windows", "System32").toLowerCase();
  const candidates = [
    process.env.CLUTCH_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs\\Git\\bin\\bash.exe"),
  ].filter(Boolean);
  for (const cand of candidates) {
    try {
      if (!fs.existsSync(cand)) continue;
      if (path.resolve(cand).toLowerCase().startsWith(sysDir + path.sep)) continue;
      const probe = spawnSync(cand, ["-c", "echo clutch-bash-ok"], { stdio: "pipe" });
      if (String(probe.stdout || "").includes("clutch-bash-ok")) return (bashPath = cand);
    } catch (e) {
      /* broken install: try the next candidate */
    }
  }
  return (bashPath = "bash"); // last resort: whatever PATH has
}

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
  for (const root of [
    "agent",
    "scripts/server_entry.py",
    "scripts/supervisor_entry.py",
    "scripts/build-server-bundle.sh",
    // the bundle ships the skills library out of the clutch-skills module, so a
    // changed skill has to invalidate a dev build like changed agent code does
    "clutch-skills/skills",
  ]) {
    const p = path.join(REPO, root);
    if (!fs.existsSync(p)) continue; // a module that is not checked out
    visit(p);
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
    resolveBash(),
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

// Pin the venv's LLM-stack versions into the cache key: a pip upgrade must
// invalidate cached tars even when agent/ sources did not change.
function venvPin() {
  const venvPy =
    process.platform === "win32"
      ? path.join(REPO, ".venv", "Scripts", "python.exe")
      : path.join(REPO, ".venv", "bin", "python");
  if (!fs.existsSync(venvPy)) return "novenv";
  const r = spawnSync(
    venvPy,
    ["-c", "import importlib.metadata as m;print(m.version('openai'),m.version('httpx2'))"],
    { encoding: "utf8" }
  );
  return r.status === 0 ? r.stdout.trim().replace(/\s+/g, "-") : "unknown";
}

// Download exact wheels for the remote platform, package agent + site-packages
// into a tar cached under a content-derived key: the script builds
// byte-deterministic tars, so key hit == the exact artifact the remote's
// VERSION gate expects and the rebuild (pip download: tens of seconds) is
// skipped entirely on reconnect.
function ensurePyLibsTar(target) {
  const key = `${target.os}-${target.arch}-${target.libc}-${target.pyver}-${venvPin()}-${sourceFingerprint().slice(0, 16)}`;
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `agent-pylibs-${key}.tar.gz`);
  if (fs.existsSync(out)) return { path: out, version: fileHash(out).slice(0, 16) };
  const tmp = path.join(CACHE, `.pylibs-${key}-${process.pid}.tar.gz`);
  const r = spawnSync(
    resolveBash(),
    [path.join(REPO, "scripts", "build-pylibs-tar.sh"), key, tmp, target.os, target.arch, target.libc, target.pyver],
    { cwd: REPO, stdio: "inherit" }
  );
  if (r.status !== 0) {
    const why = r.error ? r.error.message : `exit=${r.status}${r.signal ? " signal=" + r.signal : ""}`;
    throw new Error(`pylibs tar build failed (${why})`);
  }
  fs.renameSync(tmp, out);
  return { path: out, version: fileHash(out).slice(0, 16) };
}

module.exports = { platformTag, ensureBundle, ensurePyLibsTar, resolveBash };
