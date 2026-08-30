// Machine supervisor bootstrap + per-window session management.
//
// Architecture (phase 4): every machine — local or remote — runs exactly ONE
// supervisor (a thin process that owns no session logic). Each UI window asks
// the supervisor for a SESSION: a dedicated agent.server child spawned with
// --port 0 whose real port is parsed from its stdout banner. The window then
// talks to its session child DIRECTLY; the supervisor never proxies traffic,
// it only owns the lifecycle (spawn / kill / stale-reap / idle-exit).
//
// Lifecycle per product decision:
//   - the FIRST window starts the supervisor (probe /api/health, spawn when
//     down); the LAST window's exit ends it — every window stops its session
//     on close, and the supervisor self-exits after an idle grace at zero
//     sessions. So we never kill the supervisor; it governs itself.
//   - a window that crashes stops heartbeating, and the supervisor reaps the
//     stale session (heartbeat timeout) — no leaked children.
//
// CLUTCH_API_URL set -> direct connect, never spawn (compat: dev.sh, manual
// start, an explicitly shared server). No sessions, no heartbeats.

const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SUPERVISOR_PORT = parseInt(process.env.CLUTCH_SUPERVISOR_PORT || "8890", 10); // fixed machine-wide single instance
const HEALTH_TIMEOUT_MS = 20_000; // PyInstaller onefile extracts on first run
const HEALTH_POLL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 8000; // < supervisor stale timeout (30s)

let supervisorChild = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function supervisorProbe() {
  // Distinguish the supervisor from any other server squatting on the port:
  //   "up"      — /api/health answered with {"status":"ok"} (supervisor shape)
  //   "foreign" — something else answered (old shared agent-server, another app)
  //   "down"    — nothing listening
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
  const idleTimeout = process.env.CLUTCH_SUPERVISOR_IDLE_TIMEOUT || "8"; // seconds
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
    return { cmd: bin, args: portArgs, cwd: os.homedir() };
  }
  const root = path.join(__dirname, "..");
  const isWin = process.platform === "win32";
  const venvPy = path.join(root, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  const args = ["-m", "agent.supervisor", ...portArgs];
  if (fs.existsSync(venvPy)) return { cmd: venvPy, args, cwd: root };
  return { cmd: "uv", args: ["run", "python", ...args], cwd: root };
}

// Bring the machine supervisor up if it is not already there. Idempotent and
// race-safe: we always probe first; if two windows spawn concurrently, the
// loser's bind fails and it exits, while the winner serves both.
async function ensureSupervisor() {
  const probe = await supervisorProbe();
  if (probe === "up") return true;
  if (probe === "foreign") {
    console.error(
      `[server-bootstrap] port ${SUPERVISOR_PORT} is held by a non-supervisor server ` +
        "(an old shared agent-server?) — close it or set CLUTCH_API_URL"
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

// ---- shared supervisor session HTTP (local AND tunnel use this) ----
// The machine supervisor API is identical wherever it runs: locally on
// 127.0.0.1:8890, or remotely behind the SSH tunnel (the control forward to
// the remote 8890). A caller passes the supervisor's base URL; sessions are
// per-window and the heartbeat owns its own timer.

async function supervisorSessionStart(base, baseUrl) {
  // POST {base}/api/session/start {base_url} -> {session_id, port}
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HEALTH_REQUEST_TIMEOUT_MS);
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

// Keep a session alive; onFail fires when the supervisor stops answering (the
// session was reaped, the remote supervisor restarted, the tunnel died, ...).
// The caller decides whether to re-establish the session.
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
async function startLocalSession() {
  if (!(await ensureSupervisor())) {
    return { mode: "failed", reason: "could not start the machine supervisor" };
  }
  const res = await supervisorSessionStart(`http://127.0.0.1:${SUPERVISOR_PORT}`);
  if (res.error) return { mode: "failed", reason: res.error };
  const hb = startSupervisorHeartbeat(`http://127.0.0.1:${SUPERVISOR_PORT}`, res.sessionId, null);
  console.log(`[server-bootstrap] session ${res.sessionId} on port ${res.port}`);
  return {
    mode: "spawned",
    sessionId: res.sessionId,
    url: `http://127.0.0.1:${res.port}`,
    stop: () => {
      hb.stop();
      supervisorSessionStop(`http://127.0.0.1:${SUPERVISOR_PORT}`, res.sessionId);
      // We deliberately do NOT touch supervisorChild here: we spawned the
      // supervisor, but we do not own its lifetime — it self-exits at zero
      // sessions; the exit handler just logs the fact.
    },
  };
}

module.exports = {
  startLocalSession,
  supervisorSessionStart,
  supervisorSessionStop,
  startSupervisorHeartbeat,
};
