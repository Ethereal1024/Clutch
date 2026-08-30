// Local backend process manager for the click-to-use desktop app.
//
// The Clutch GUI talks to the clutch-server API over HTTP; this module makes
// the Electron shell bring the backend up itself instead of assuming the user
// ran `python -m agent.server` first. Three situations:
//   - CLUTCH_API_URL points at a remote host   -> leave it alone (SSH mode)
//   - a healthy server already listens on the port -> reuse it (dev.sh, manual
//     start) so we never fight an existing backend
//   - nothing healthy                          -> spawn the bundled backend
//       packaged: <resources>/agent-server     (PyInstaller onefile, ships in
//                                               the deb via extraResources)
//       dev:      <repo>/.venv/bin/python -m agent.server
// The spawned child is killed on app quit (whole process group on POSIX).
//
// The renderer picks the API base itself (preload: CLUTCH_API_URL or the
// default 127.0.0.1:8890); we manage only that local default/custom port.

const { app } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 8890;
const HEALTH_TIMEOUT_MS = 20_000; // PyInstaller onefile extracts on first run
const HEALTH_POLL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;

let child = null;

// The configured API base, if it is local. Remote bases are not our job.
function apiTarget() {
  const raw = process.env.CLUTCH_API_URL;
  if (!raw) return { port: DEFAULT_PORT };
  try {
    const u = new URL(raw);
    const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
    if (!local) return null;
    return { port: u.port ? Number(u.port) : DEFAULT_PORT };
  } catch {
    return { port: DEFAULT_PORT };
  }
}

async function healthy(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
      return r.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

function spawnCommand(port) {
  const portArgs = port === DEFAULT_PORT ? [] : ["--port", String(port)];
  if (app.isPackaged) {
    const bin = path.join(process.resourcesPath, "agent-server");
    if (!fs.existsSync(bin)) {
      console.error("[local-server] bundled backend missing:", bin);
      return null;
    }
    // defensive: extraResources should preserve the exec bit, but a packaged
    // file losing +x is a classic deb/asar pitfall — chmod costs nothing
    try {
      fs.chmodSync(bin, 0o755);
    } catch (e) {
      console.error("[local-server] chmod failed:", e && e.message);
    }
    return { cmd: bin, args: portArgs, cwd: os.homedir() };
  }
  const root = path.join(__dirname, "..");
  const isWin = process.platform === "win32";
  const venvPy = path.join(root, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  const args = ["-m", "agent.server", ...portArgs];
  if (fs.existsSync(venvPy)) return { cmd: venvPy, args, cwd: root };
  return { cmd: "uv", args: ["run", "python", ...args], cwd: root };
}

// Bring the local backend up (or confirm one is already there).
// Resolves with { mode: "existing"|"spawned"|"spawning"|"skip"|"failed", ... }.
async function start() {
  const target = apiTarget();
  if (!target) return { mode: "skip", reason: "CLUTCH_API_URL points at a remote host" };
  const { port } = target;

  if (await healthy(port)) return { mode: "existing", port };

  const spec = spawnCommand(port);
  if (!spec) return { mode: "failed", port, reason: "bundled backend missing" };

  console.log(`[local-server] spawning backend: ${spec.cmd} ${spec.args.join(" ")}`);
  child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    detached: process.platform !== "win32", // own process group -> group kill
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("error", (e) => console.error("[local-server] spawn error:", e.message));
  child.on("exit", (code, sig) => {
    console.log(`[local-server] backend exited (code=${code} signal=${sig})`);
    child = null;
  });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    if (await healthy(port)) return { mode: "spawned", port, pid: child && child.pid };
  }
  // still not up: leave the child running — the renderer's SSE stream
  // auto-reconnects, so a slow cold start recovers without user action
  return { mode: "spawning", port, pid: child && child.pid };
}

function stop() {
  if (!child || child.exitCode !== null) {
    child = null;
    return;
  }
  const pid = child.pid;
  child = null;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM"); // detached -> negative pid = whole group
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { start, stop };
