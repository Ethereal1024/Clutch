// One supervisor per machine (agent/supervisor.py) spawns/kills per-window
// session children; the first window starts it and it self-exits when idle.
const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  supervisorProbe,
  supervisorIdentity,
  supervisorSessionStart,
  supervisorSessionStop,
  startSupervisorHeartbeat,
  supervisorShutdown,
} = require("./supervisor-client");

const SUPERVISOR_PORT = parseInt(process.env.CLUTCH_SUPERVISOR_PORT || "8890", 10); // fixed machine-wide single instance
const HEALTH_TIMEOUT_MS = 20_000; // PyInstaller onefile extracts on first run
const HEALTH_POLL_MS = 250;
const RETIRE_TIMEOUT_MS = 10_000; // a SIGTERM'd supervisor stops its sessions and exits
const RETIRE_POLL_MS = 200;

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

// This app's own build — what /api/health of a matching supervisor must say.
// Packaged, Electron reports the number the installer shipped (the deb/rpm/exe
// are built from ui/package.json); in the source tree it is VERSION, the same
// file the dev supervisor (python -m agent.supervisor) reads.
function ownBuild() {
  if (app.isPackaged) return typeof app.getVersion === "function" ? app.getVersion() : "";
  try {
    return fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}

// Retire a supervisor that is not this build (supervisorIdentity explains why a
// reused one is the whole bug: every host-side call keeps running the code the
// update replaced).
//
// A pid is the direct way: SIGTERM is the supervisor's normal close — it stops
// its sessions and exits — so a predecessor is replaced immediately instead of
// waiting for an idle-exit that its sessions postpone forever. Every host from
// 0.1.57 on names both its build and its pid.
//
// A host too old to name itself cannot be asked to die: /api/shutdown only arms
// an exit for when its last session is gone, and it never is while the new app's
// windows keep claiming sessions on it. So this returns whether the port is
// actually free, and ensureSupervisor decides what to tell the user.
async function retireSupervisor(seen) {
  if (seen.pid && seen.pid !== process.pid) {
    try {
      process.kill(seen.pid, "SIGTERM");
      console.log(`[server-bootstrap] retiring supervisor pid ${seen.pid} (build ${seen.version || "unknown"})`);
    } catch (e) {
      console.error(`[server-bootstrap] could not signal supervisor pid ${seen.pid}:`, e && e.message);
      supervisorShutdown(localBase); // polite second chance: arm its idle exit
    }
  } else {
    supervisorShutdown(localBase);
  }
  const deadline = Date.now() + RETIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await supervisorProbe(localBase)) === "down") return true;
    await sleep(RETIRE_POLL_MS);
  }
  return false;
}

// Idempotent and race-safe: concurrent spawns lose the bind and exit.
//
// The plugin tab injects this as its wake (ui/components-view.js): a write aimed
// at this machine starts its supervisor rather than reporting "did not answer",
// since the supervisor exits when idle and the plugin tab can be open before any
// window holds a session.
//
// "Up" is not the same as "mine": the supervisor holds a fixed port and outlives
// the app, so after an upgrade the PREVIOUS build is usually still answering it,
// kept alive by the very sessions this app starts. Reusing it looks like the
// upgrade did nothing — the component table and every install keep running the
// old host code — so a supervisor that answers with another build (or cannot say
// which build it is) is retired first.
async function ensureSupervisor() {
  const seen = await supervisorIdentity(localBase);
  if (seen.state === "foreign") {
    console.error(
      `[server-bootstrap] port ${SUPERVISOR_PORT} is held by a non-supervisor server ` +
        "(an old shared agent-server?) — close it; the app only runs through the supervisor"
    );
    return false;
  }
  if (seen.state === "up") {
    const mine = ownBuild();
    if (!mine) {
      console.error(
        `[server-bootstrap] reusing the supervisor on ${SUPERVISOR_PORT} unverified: ` +
          "this app cannot name its own build, so it cannot tell whose supervisor it talks to"
      );
      return true;
    }
    if (seen.version === mine) return true;
    console.error(
      `[server-bootstrap] supervisor on ${SUPERVISOR_PORT} is build ` +
        `${seen.version || "unknown (older than 0.1.57)"}, this app is ${mine} — ` +
        "it would keep running the code this update replaced; retiring it"
    );
    if (!(await retireSupervisor(seen))) {
      // Half-old is still usable (the session children come from the NEW on-disk
      // agent-server, so chat runs this build; only host-side component work is
      // old), while an app that cannot start is not usable at all. Say the one
      // manual step instead of pretending.
      console.error(
        `[server-bootstrap] it still holds port ${SUPERVISOR_PORT} and will not let go: quit every Clutch ` +
          "window and run `pkill -f agent-supervisor`, then reopen. Running on it meanwhile."
      );
      return true;
    }
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
