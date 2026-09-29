// Pure HTTP client for the machine supervisor (agent/supervisor.py): probe,
// session start/stop, heartbeat, shutdown. No process management and no
// Electron — every call takes an explicit base URL, so the SAME client drives
// the local supervisor (http://127.0.0.1:SUPERVISOR_PORT) and a remote one
// reached through the SSH tunnel. Consumed by server-bootstrap.js (desktop
// spawn path) and host-core.js (the session-claim state machine).
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
// session/start boots a onefile child: cover the supervisor's start timeout
const SESSION_START_TIMEOUT_MS = 35_000;
const HEARTBEAT_INTERVAL_MS = 8000; // < supervisor stale timeout (30s)

async function supervisorProbe(base) {
  // "up" = supervisor shape, "foreign" = another server on the port, "down" = nothing listening
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(`${base}/api/health`, { signal: ctl.signal });
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

// Ask a supervisor to exit once its sessions are gone (fire-and-forget: it may
// already be gone, and there is nobody left to tell).
function supervisorShutdown(base) {
  try {
    fetch(`${base}/api/shutdown`, { method: "POST" }).catch(() => {});
  } catch { /* best effort */ }
}

module.exports = {
  supervisorProbe,
  supervisorSessionStart,
  supervisorSessionStop,
  startSupervisorHeartbeat,
  supervisorShutdown,
};
