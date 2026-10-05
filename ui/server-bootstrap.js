// One supervisor per machine (agent/supervisor.py) spawns/kills per-window
// session children; the first window starts it and it self-exits when idle.
const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { supervisorProbe, supervisorSessionStart, supervisorSessionStop, startSupervisorHeartbeat } = require("./supervisor-client");

const SUPERVISOR_PORT = parseInt(process.env.CLUTCH_SUPERVISOR_PORT || "8890", 10); // fixed machine-wide single instance
const HEALTH_TIMEOUT_MS = 20_000; // PyInstaller onefile extracts on first run
const HEALTH_POLL_MS = 250;

// this machine's supervisor (spawned below); the pure HTTP calls live in
// supervisor-client.js so the same code also drives a tunneled remote
const localBase = `http://127.0.0.1:${SUPERVISOR_PORT}`;

let supervisorChild = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnSupervisorCommand() {
  const idleTimeout = process.env.CLUTCH_SUPERVISOR_IDLE_TIMEOUT || "8";
  const portArgs = ["--port", String(SUPERVISOR_PORT), "--idle-timeout", idleTimeout];
  if (app.isPackaged) {
    // Windows bundles carry the .exe suffix (PyInstaller onefile)
    const exe = process.platform === "win32" ? ".exe" : "";
    const bin = path.join(process.resourcesPath, "agent-supervisor" + exe);
    if (!fs.existsSync(bin)) {
      console.error("[server-bootstrap] bundled supervisor missing:", bin);
      return null;
    }
    try {
      fs.chmodSync(bin, 0o755);
    } catch (e) {
      console.error("[server-bootstrap] chmod failed:", e && e.message);
    }
    // a onefile's sys.executable is not the sibling agent-server: pass it explicitly
    const agent = path.join(process.resourcesPath, "agent-server" + exe);
    return { cmd: bin, args: [...portArgs, "--agent-cmd", agent], cwd: os.homedir() };
  }
  const root = path.join(__dirname, "..");
  const isWin = process.platform === "win32";
  const venvPy = path.join(root, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  const args = ["-m", "agent.supervisor", ...portArgs];
  if (fs.existsSync(venvPy)) return { cmd: venvPy, args, cwd: root };
  return { cmd: "uv", args: ["run", "python", ...args], cwd: root };
}

// Idempotent and race-safe: concurrent spawns lose the bind and exit.
//
// The plugin tab injects this as its wake (ui/components-view.js): a write aimed
// at this machine starts its supervisor rather than reporting "did not answer",
// since the supervisor exits when idle and the plugin tab can be open before any
// window holds a session.
async function ensureSupervisor() {
  const probe = await supervisorProbe(localBase);
  if (probe === "up") return true;
  if (probe === "foreign") {
    console.error(
      `[server-bootstrap] port ${SUPERVISOR_PORT} is held by a non-supervisor server ` +
        "(an old shared agent-server?) — close it; the app only runs through the supervisor"
    );
    return false;
  }
  const spec = spawnSupervisorCommand();
  if (!spec) return false;
  console.log(`[server-bootstrap] spawning supervisor: ${spec.cmd} ${spec.args.join(" ")}`);
  supervisorChild = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    detached: process.platform !== "win32",
    windowsHide: true, // no console flash behind the GUI on Windows
    stdio: ["ignore", "pipe", "pipe"],
  });
  supervisorChild.stdout.on("data", (d) => process.stdout.write(d));
  supervisorChild.stderr.on("data", (d) => process.stderr.write(d));
  supervisorChild.on("error", (e) => console.error("[server-bootstrap] supervisor spawn error:", e.message));
  supervisorChild.on("exit", (code, sig) => {
    console.log(`[server-bootstrap] supervisor exited (code=${code} signal=${sig})`);
    supervisorChild = null;
  });
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await supervisorProbe(localBase)) === "up") return true;
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

// ---- local session: this window's session child from the LOCAL supervisor ----
// onFail fires when the supervisor stops answering (idle-exit or crash)
async function startLocalSession(onFail = null) {
  if (!(await ensureSupervisor())) {
    return { mode: "failed", reason: "could not start the machine supervisor" };
  }
  const res = await supervisorSessionStart(localBase);
  if (res.error) return { mode: "failed", reason: res.error };
  const hb = startSupervisorHeartbeat(localBase, res.sessionId, onFail);
  console.log(`[server-bootstrap] session ${res.sessionId} on port ${res.port}`);
  return {
    mode: "spawned",
    sessionId: res.sessionId,
    url: `http://127.0.0.1:${res.port}`,
    stop: () => {
      hb.stop();
      supervisorSessionStop(localBase, res.sessionId);
      // we don't own the supervisor's lifetime: it self-exits at zero sessions
    },
  };
}

module.exports = {
  SUPERVISOR_PORT,
  ensureSupervisor,
  startLocalSession,
};
