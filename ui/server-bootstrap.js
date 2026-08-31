// One supervisor per machine (agent/supervisor.py) spawns/kills per-window
// session children; the first window starts it and it self-exits when idle.
const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SUPERVISOR_PORT = parseInt(process.env.CLUTCH_SUPERVISOR_PORT || "8890", 10); // fixed machine-wide single instance
const HEALTH_TIMEOUT_MS = 20_000; // PyInstaller onefile extracts on first run
const HEALTH_POLL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
// session/start boots a onefile child: cover the supervisor's start timeout
const SESSION_START_TIMEOUT_MS = 35_000;
const HEARTBEAT_INTERVAL_MS = 8000; // < supervisor stale timeout (30s)

let supervisorChild = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function supervisorProbe() {
  // "up" = supervisor shape, "foreign" = another server on the port, "down" = nothing listening
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(`http://127.0.0.1:${SUPERVISOR_PORT}/api/health`, { signal: ctl.signal });
      if (!r.ok) return "foreign";
      const body = await r.text();
      return body.includes('"status"') ? "up" : "foreign";
    } finally {
      clearTimeout(t);
    }
  } catch {
    return "down";
  }
}

function spawnSupervisorCommand() {
  const idleTimeout = process.env.CLUTCH_SUPERVISOR_IDLE_TIMEOUT || "8";
  const portArgs = ["--port", String(SUPERVISOR_PORT), "--idle-timeout", idleTimeout];
  if (app.isPackaged) {
    const bin = path.join(process.resourcesPath, "agent-supervisor");
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
    const agent = path.join(process.resourcesPath, "agent-server");
    return { cmd: bin, args: [...portArgs, "--agent-cmd", agent], cwd: os.homedir() };
  }
  const root = path.join(__dirname, "..");
  const isWin = process.platform === "win32";
  const venvPy = path.join(root, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  const args = ["-m", "agent.supervisor", ...portArgs];
  if (fs.existsSync(venvPy)) return { cmd: venvPy, args, cwd: root };
  return { cmd: "uv", args: ["run", "python", ...args], cwd: root };
}

// Idempotent and race-safe: concurrent spawns lose the bind and exit
async function ensureSupervisor() {
  const probe = await supervisorProbe();
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
    if ((await supervisorProbe()) === "up") return true;
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

// ---- shared supervisor session HTTP (identical local and behind the tunnel) ----
async function supervisorSessionStart(base, baseUrl) {
  // POST {base}/api/session/start {base_url} -> {session_id, port}
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SESSION_START_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseUrl ? { base_url: baseUrl } : {}),
      signal: ctl.signal,
    });
    if (r.status === 404) {
      return { error: `${base} is not a Clutch supervisor (old shared server?)` };
    }
    if (!r.ok) return { error: `session start failed (${r.status})` };
    const d = await r.json();
    return { sessionId: d.session_id, port: d.port };
  } catch (e) {
    return { error: `session start error: ${e && e.message}` };
  } finally {
    clearTimeout(t);
  }
}

function supervisorSessionStop(base, sid) {
  if (!sid) return;
  try {
    fetch(`${base}/api/session/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
    }).catch(() => {});
  } catch { /* supervisor already gone: nothing to tell */ }
}

// Keep a session alive; onFail fires when the supervisor stops answering
function startSupervisorHeartbeat(base, sid, onFail) {
  const timer = setInterval(async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), HEALTH_REQUEST_TIMEOUT_MS);
      let failed = false;
      try {
        const r = await fetch(`${base}/api/session/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sid }),
          signal: ctl.signal,
        });
        failed = !r.ok;
      } catch {
        failed = true;
      } finally {
        clearTimeout(t);
      }
      if (failed && onFail) onFail();
    } catch { /* heartbeat failures must never throw */ }
  }, HEARTBEAT_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}

// ---- local session: this window's session child from the LOCAL supervisor ----
// onFail fires when the supervisor stops answering (idle-exit or crash)
async function startLocalSession(onFail = null) {
  if (!(await ensureSupervisor())) {
    return { mode: "failed", reason: "could not start the machine supervisor" };
  }
  const res = await supervisorSessionStart(`http://127.0.0.1:${SUPERVISOR_PORT}`);
  if (res.error) return { mode: "failed", reason: res.error };
  const hb = startSupervisorHeartbeat(`http://127.0.0.1:${SUPERVISOR_PORT}`, res.sessionId, onFail);
  console.log(`[server-bootstrap] session ${res.sessionId} on port ${res.port}`);
  return {
    mode: "spawned",
    sessionId: res.sessionId,
    url: `http://127.0.0.1:${res.port}`,
    stop: () => {
      hb.stop();
      supervisorSessionStop(`http://127.0.0.1:${SUPERVISOR_PORT}`, res.sessionId);
      // we don't own the supervisor's lifetime: it self-exits at zero sessions
    },
  };
}

module.exports = {
  SUPERVISOR_PORT,
  startLocalSession,
  supervisorSessionStart,
  supervisorSessionStop,
  startSupervisorHeartbeat,
};
