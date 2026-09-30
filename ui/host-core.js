// Session-claim state machine, extracted from the Electron main process (R2)
// so the Android host can drive the exact same logic. Everything platform-
// shaped enters through `deps`; a window handle only needs
// { id, isDestroyed(), send(channel, payload) } — which Electron webContents
// already satisfies, and the Android bridge wraps with its SSE notifier.
//
// deps:
//   supervisorBase()      => "http://127.0.0.1:8890" | null  (null = no local mode, N4)
//   remoteLlmBase()       => "http://127.0.0.1:8892/v1"     (reverse-forward LLM proxy)
//   remoteLlmModel()      => "deepseek-v4-flash" | ""       (model for the remote session)
//   remoteLlmKnobs()      => { reasoning_effort, api_protocol }  (same trip as the model)
//   tunnelStatus()        => { active, url }                (SSH tunnel state)
//   restartRemoteServer() => Promise<bool>                  (reboot an idle-exited remote supervisor)
//   openSessionForward(port) => Promise<{ localPort, close() }>
//   startLocalSession(onFail) => Promise<{mode, sessionId, url, stop}> | null
//                           (spawns the LOCAL supervisor + session; absent on Android)
//   log(...args)          => sink (tunnelLog on desktop)
//   sessions              => pure supervisor HTTP client (supervisor-client.js;
//                            injectable so tests can run the machine hermetically)
const defaultSessions = require("./supervisor-client");

// the one channel the machine itself pushes to the renderer; a healthy
// session overrides the boot placeholder via `backend:base-changed`
const BASE_CHANGED = "backend:base-changed";

function createHostCore(deps) {
  const {
    supervisorBase,
    remoteLlmBase,
    remoteLlmModel = () => "",
    remoteLlmKnobs = () => ({}),
    tunnelStatus,
    restartRemoteServer,
    openSessionForward,
    startLocalSession,
    log = () => {},
    sessions = defaultSessions,
  } = deps;

  // per-window backend state: windowId -> {kind, sessionId, url, stop()}
  const windowBackends = new Map();

  async function releaseWindowBackend(winId) {
    const wb = windowBackends.get(winId);
    if (!wb) return;
    windowBackends.delete(winId);
    try {
      wb.stop();
    } catch (e) {
      /* best effort */
    }
  }

  async function registerTunnelBackend(wc, supBase, res) {
    const fwd = await openSessionForward(res.port);
    const hb = sessions.startSupervisorHeartbeat(supBase, res.sessionId, () => {
      log(`[backend] window ${wc.id} session heartbeat failed; re-establishing`);
      (async () => {
        const cur = windowBackends.get(wc.id);
        if (!cur || cur.sessionId !== res.sessionId) return; // superseded / closed
        await releaseWindowBackend(wc.id);
        const url = await ensureWindowBackend(wc);
        if (!wc.isDestroyed()) wc.send(BASE_CHANGED, url);
      })();
    });
    const wb = {
      kind: "tunnel",
      sessionId: res.sessionId,
      url: `http://127.0.0.1:${fwd.localPort}`,
      stop: () => {
        hb.stop();
        fwd.close();
        sessions.supervisorSessionStop(supBase, res.sessionId);
      },
    };
    windowBackends.set(wc.id, wb);
    return wb.url;
  }

  // Decide (and, if needed, re-create) this window's backend URL.
  async function claimWindowBackend(wc, notify = false) {
    const ts = tunnelStatus();
    if (ts.active && ts.url) {
      const existing = windowBackends.get(wc.id);
      if (existing && existing.kind === "tunnel") return existing.url;
      await releaseWindowBackend(wc.id); // drop any local session first
      let res = await sessions.supervisorSessionStart(
        ts.url,
        remoteLlmBase(),
        remoteLlmModel(),
        remoteLlmKnobs(),
      );
      if (res.error) {
        // the remote supervisor may have idle-exited: restart it through the tunnel and retry once
        log(`[backend] tunnel session start failed (${res.error}); restarting remote supervisor`);
        const ok = await restartRemoteServer();
        if (ok) {
          res = await sessions.supervisorSessionStart(
            ts.url,
            remoteLlmBase(),
            remoteLlmModel(),
            remoteLlmKnobs(),
          );
          if (res.error) log(`[backend] tunnel session retry failed: ${res.error}`);
        }
      }
      if (!res.error) {
        const url = await registerTunnelBackend(wc, ts.url, res);
        if (notify && !wc.isDestroyed()) wc.send(BASE_CHANGED, url);
        return url;
      }
      // tunnel alive but supervisorless (degraded host or remote died): fall back to a local session
      log("[backend] no tunnel session; falling back to a local session");
    }

    if (typeof startLocalSession !== "function") {
      // no tunnel session and no local mode (Android, N4): the renderer's
      // api:base placeholder shows "not running" — there is nothing to fall back to
      log("[backend] no tunnel session and no local mode on this host");
      return null;
    }

    const existing = windowBackends.get(wc.id);
    if (existing && existing.kind === "local") return existing.url;
    await releaseWindowBackend(wc.id);
    let s;
    const onFail = () => {
      // self-heal: the local supervisor died (idle exit, crash, stale reap);
      // re-claim and point the renderer at the new URL — same as the tunnel path
      log(`[backend] window ${wc.id} local session heartbeat failed; re-establishing`);
      (async () => {
        const cur = windowBackends.get(wc.id);
        if (!cur || cur.sessionId !== s.sessionId) return; // superseded / closed
        await releaseWindowBackend(wc.id);
        await ensureWindowBackend(wc, true);
      })();
    };
    s = await startLocalSession(onFail);
    if (s.mode === "failed") {
      // a window booting mid-spawn can transiently fail; retry once
      log(`[backend] local session retry: ${s.reason}`);
      await new Promise((r) => setTimeout(r, 600));
      s = await startLocalSession(onFail); // the retry session heals itself too
    }
    if (s.mode === "failed") {
      log(`[backend] local session failed: ${s.reason}`);
      return null;
    }
    const wb = { kind: "local", sessionId: s.sessionId, url: s.url, stop: s.stop };
    windowBackends.set(wc.id, wb);
    if (notify && !wc.isDestroyed()) wc.send(BASE_CHANGED, wb.url);
    return wb.url;
  }

  // one in-flight claim per window: overlapping api:base calls (renderer boot,
  // retries) must share a single session claim, not spawn two session children
  const backendClaims = new Map(); // windowId -> Promise<url|null>
  function ensureWindowBackend(wc, notify = false) {
    const inflight = backendClaims.get(wc.id);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        return await claimWindowBackend(wc, notify);
      } finally {
        backendClaims.delete(wc.id);
      }
    })();
    backendClaims.set(wc.id, p);
    return p;
  }

  // window close/disconnect: drop this window's session WITHOUT asking any
  // supervisor to exit (the machine may still serve other windows)
  async function releaseAllBackends() {
    for (const id of [...windowBackends.keys()]) await releaseWindowBackend(id);
  }

  async function stopAllBackends() {
    await releaseAllBackends();
    // Normal close: tell every supervisor to exit once their sessions are gone
    requestSupervisorShutdown();
  }

  function requestSupervisorShutdown() {
    // supervisorShutdown() appends /api/shutdown itself — hand it bases, not URLs
    const local = supervisorBase ? supervisorBase() : null;
    const ts = tunnelStatus();
    const remote = ts.active && ts.url ? ts.url : null;
    for (const base of [local, remote]) {
      if (base) sessions.supervisorShutdown(base);
    }
  }

  // which machine a window's session runs on ("local" | "tunnel" | null when it
  // has not claimed one yet). The components page needs it: components live on a
  // machine's supervisor, so "install where this window works" means the far
  // side of a tunnel, and a tunnel being up is not the same claim — a window
  // that fell back to a local session is working HERE.
  function backendKind(winId) {
    const wb = windowBackends.get(winId);
    return wb ? wb.kind : null;
  }

  return {
    ensureWindowBackend,
    releaseWindowBackend,
    releaseAllBackends,
    stopAllBackends,
    claimWindowBackend,
    backendKind,
    backendCount: () => windowBackends.size,
  };
}

module.exports = { createHostCore, BASE_CHANGED };
