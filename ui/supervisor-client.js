// Pure HTTP client for the machine supervisor (agent/supervisor.py): probe,
// session start/stop, heartbeat, shutdown. No process management and no
// Electron — every call takes an explicit base URL, so the SAME client drives
// the local supervisor (http://127.0.0.1:SUPERVISOR_PORT) and a remote one
// reached through the SSH tunnel. Consumed by server-bootstrap.js (desktop
// spawn path) and host-core.js (the session-claim state machine).
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
// session/start boots a onefile child: cover the supervisor's start timeout
const SESSION_START_TIMEOUT_MS = 35_000;
const HEARTBEAT_INTERVAL_MS = 8000; // < the supervisor's stale window (10s)
// A beat that fails is not a dead session. The supervisor reaps a session only
// once STALE_S (10s) has passed since its LAST beat, so a blip that ends inside
// that window is survivable by simply beating again sooner — the run behind it
// keeps going. Handing the failure to onFail() on the FIRST missed beat did the
// opposite: it released (and therefore stopped) a session whose task was still
// running, and the window then re-claimed an empty one — the phone's "the task
// went idle by itself". So retry on the retry cadence, and report the failure
// only once the silence has outlived the supervisor's own window: by then the
// host has reaped the session anyway and there is nothing left to keep alive.
const HEARTBEAT_RETRY_MS = 1000; // get a beat in before the stale window closes
const HEARTBEAT_STALE_MS = 10000; // must match agent/procmgr/supervise.py STALE_S

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
async function supervisorSessionStart(base, baseUrl, model, knobs = {}) {
  // POST {base}/api/session/start {base_url, model, reasoning_effort,
  //   api_protocol} -> {session_id, port}
  // model travels with base_url: a remote session reads its own host's empty
  // settings and would fail LLM init ("missing LLM argument: model")
  const payload = {};
  if (baseUrl) payload.base_url = baseUrl;
  if (model) payload.model = model;
  // the knobs travel with the model: the remote host settings file has
  // neither, so the session would otherwise run with provider defaults
  // instead of the levels this client chose (empty = child default)
  if (knobs.reasoning_effort) payload.reasoning_effort = knobs.reasoning_effort;
  if (knobs.api_protocol) payload.api_protocol = knobs.api_protocol;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SESSION_START_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

// One heartbeat, AWAITED: "does this supervisor still hold this session?" —
// three answers, because the question has three fates. TRUE = the session is
// still there — and the beat just told the reaper a window is watching it
// again, so a claim that outlived its tunnel (the session is a process on the
// far host; only this client's forward to it died) can be re-opened instead of
// replaced. FALSE = the supervisor ANSWERED and no longer holds it (its own
// 404 "unknown"): provably gone — the one verdict that may replace a claim.
// NULL = the question could not be asked (no route to the supervisor right
// now). A dead hop is not a dead session, so null is doubt: the claim is kept
// and re-bound when a hop returns, never replaced — replacing it would start a
// second session over the old one's work, which the far host then reports as
// "this project is already open in another window".
async function supervisorSessionHeartbeat(base, sid) {
  if (!sid) return false; // nothing to re-bind to: gone is the honest answer
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(`${base}/api/session/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid }),
        signal: ctl.signal,
      });
      if (r.ok) return true;
      return r.status === 404 ? false : null; // 404 is the supervisor's own "unknown"
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null; // unreachable: doubt, never a verdict
  }
}

// Keep a session alive; onFail fires when the supervisor stops answering for
// longer than its own stale window (see HEARTBEAT_STALE_MS) — i.e. when the
// session is provably gone, not when one request happened to fail.
function startSupervisorHeartbeat(base, sid, onFail) {
  let stopped = false;
  let timer = null;
  let lastOk = Date.now();
  async function beat() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), HEALTH_REQUEST_TIMEOUT_MS);
      try {
        const r = await fetch(`${base}/api/session/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sid }),
          signal: ctl.signal,
        });
        return r.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return false; // never throw: the caller is a timer
    }
  }
  async function tick() {
    timer = null;
    if (stopped) return;
    if (await beat()) {
      if (stopped) return;
      lastOk = Date.now();
      timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
      return;
    }
    if (stopped) return;
    if (Date.now() - lastOk < HEARTBEAT_STALE_MS) {
      timer = setTimeout(tick, HEARTBEAT_RETRY_MS); // the session is still there; get through
      return;
    }
    if (onFail) onFail(); // outlived the stale window: the host reaped it already
  }
  timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
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
  supervisorSessionHeartbeat,
  startSupervisorHeartbeat,
  supervisorShutdown,
};
