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

  // this claim's heartbeat gave up on its session. Re-bind FIRST — the
  // failure can be THIS client's own stale forward while the far host kept
  // running the session all along (the phone returning from the background is
  // exactly that) — and only replace the session when the old one is provably
  // gone. Silence is not that proof: when the supervisor cannot be ASKED (the
  // hop is down — this beat failing is usually the hop's dying breath), the
  // claim is kept, parked, for the next hop to re-bind.
  function tunnelClaimOnFail(wc, supBase, sessionId) {
    return () => {
      log(`[backend] window ${wc.id} session heartbeat failed; re-establishing`);
      (async () => {
        const cur = windowBackends.get(wc.id);
        if (!cur || cur.sessionId !== sessionId) return; // superseded / closed
        // ask through the hop that is up NOW: the failing beat was the OLD
        // hop's, and a question asked into a dead hop can only say "unreachable"
        const ts = tunnelStatus();
        const hop = ts.active && ts.url ? ts.url : supBase;
        const verdict = await rebindTunnelBackend(wc, hop, cur);
        if (verdict.verdict === "kept") {
          if (!wc.isDestroyed()) wc.send(BASE_CHANGED, verdict.url);
          return;
        }
        if (windowBackends.get(wc.id) !== cur) return; // the claim changed hands while we were asking: replacing now would spawn a session nobody is waiting for
        if (verdict.verdict !== "gone") {
          // doubt (no route to the supervisor): NOT provably gone, so the
          // claim stays — its forward and heartbeat are already dropped — and
          // the next claim (the reconnect's api:base) re-binds it. Replacing it
          // here would start a second session over the first one's work, which
          // the far host reports as "this project is already open in another window"
          log(`[backend] window ${wc.id} session ${sessionId} not provably gone; keeping the claim for the next hop`);
          return;
        }
        await releaseWindowBackend(wc.id);
        const url = await ensureWindowBackend(wc);
        if (!wc.isDestroyed()) wc.send(BASE_CHANGED, url);
      })();
    };
  }

  // the shape of a tunnel claim. What survives a hop is the SESSION — its id
  // and the remote port it listens on name a process on the far host — and
  // what the hop owns is the local half (the forward and its URL, the
  // heartbeat). `detach` drops exactly that half, ONCE: a detached claim is
  // detached again when it is stopped or re-bound, and one close is all a
  // forward needs.
  function tunnelClaim(supBase, sessionId, sessionPort, fwd, hb) {
    let dropped = false;
    const wb = {
      kind: "tunnel",
      sessionId,
      // the REMOTE port the session listens on: the session is a process on
      // the far host and outlives any hop to it, so a bounced tunnel re-opens
      // this forward instead of replacing the session (rebindTunnelBackend)
      sessionPort,
      // the hop this forward was opened through: stopTunnel closes EVERY session
      // forward, so a URL from one tunnel names a dead port on the next one
      tunnelUrl: supBase,
      url: `http://127.0.0.1:${fwd.localPort}`,
      // drop this claim's LOCAL half (heartbeat + forward) and nothing else:
      // the far-side session is left to its own lifecycle, and the claim stays
      // re-bindable (session id + remote port name it, not the dead forward)
      detach: () => {
        if (dropped) return;
        dropped = true;
        hb.stop();
        fwd.close();
        wb.url = null; // never hand out a port whose forward is gone
      },
      stop: () => {
        wb.detach();
        sessions.supervisorSessionStop(supBase, sessionId);
      },
    };
    return wb;
  }

  async function registerTunnelBackend(wc, supBase, res) {
    const fwd = await openSessionForward(res.port);
    const hb = sessions.startSupervisorHeartbeat(supBase, res.sessionId, tunnelClaimOnFail(wc, supBase, res.sessionId));
    const wb = tunnelClaim(supBase, res.sessionId, res.port, fwd, hb);
    windowBackends.set(wc.id, wb);
    return wb.url;
  }

  // A claim that outlived its hop. The SESSION is a process on the far host
  // and survives every tunnel bounce; what died is only this client's local
  // forward to it (and the URL that forward had). So re-open the forward to
  // the SAME session through the current hop instead of stop + start: stop
  // SIGTERMs the session mid-run (agent/server.py record_release writes "the
  // host released this session while the run was in flight" into work nobody
  // abandoned) and start hands the window a second session while the first
  // one is still working. The verdict is three-way, and only one of the three
  // may ever replace a claim:
  //   { verdict: "kept", url } — the forward is back on the SAME session
  //   { verdict: "gone" }      — the supervisor answered that it no longer
  //                              holds the session (the one proof there is)
  //   { verdict: "doubt" }     — the question could not be asked, or the
  //                              answer could not be acted on (no route to the
  //                              supervisor, a forward that would not open, a
  //                              claim that changed hands mid-ask): the claim
  //                              is kept, detached, for the next hop
  async function rebindTunnelBackend(wc, supBase, existing) {
    if (!existing || existing.kind !== "tunnel" || !existing.sessionId || !existing.sessionPort) {
      return { verdict: "gone" };
    }
    if (typeof existing.detach === "function") existing.detach(); // the old forward/heartbeat are dead weight
    // the supervisor is the authority on "is the session still there", and the
    // beat doubles as the re-claim: it re-arms the window contract the reaper
    // judges staleness by
    const alive = await sessions.supervisorSessionHeartbeat(supBase, existing.sessionId);
    if (alive == null) return { verdict: "doubt" }; // unreachable is not gone
    if (!alive) return { verdict: "gone" };
    let fwd;
    try {
      fwd = await openSessionForward(existing.sessionPort);
    } catch (e) {
      log(`[backend] session ${existing.sessionId} forward failed: ${(e && e.message) || e}`);
      // the session PROVED itself alive above; a forward that will not open is
      // this hop's failing, not the session's — keep the claim and try again
      return { verdict: "doubt" };
    }
    const hb = sessions.startSupervisorHeartbeat(supBase, existing.sessionId, tunnelClaimOnFail(wc, supBase, existing.sessionId));
    const wb = tunnelClaim(supBase, existing.sessionId, existing.sessionPort, fwd, hb);
    if (windowBackends.get(wc.id) !== existing) {
      // superseded while we worked (a newer claim, or the window closed):
      // what we opened serves nobody, and what changed hands is not replaced
      // behind the new holder's back
      wb.detach();
      return { verdict: "doubt" };
    }
    windowBackends.set(wc.id, wb);
    return { verdict: "kept", url: wb.url };
  }

  // Decide (and, if needed, re-create) this window's backend URL.
  async function claimWindowBackend(wc, notify = false) {
    const ts = tunnelStatus();
    if (ts.active && ts.url) {
      const existing = windowBackends.get(wc.id);
      if (existing && existing.kind === "tunnel") {
        // reuse only a forward opened through THIS tunnel: the forward an earlier
        // tunnel opened died with it, and handing its port out again points the
        // window at a socket nobody serves — the EventSource then errors into the
        // phone's "lost the live stream" while the drop already happened
        if (existing.tunnelUrl === ts.url && existing.url) {
          return existing.url;
        }
        // a different hop (or a claim whose forward went with the last one):
        // the far-side session outlives every hop, so re-open its forward —
        // never stop + start, which is what killed runs in flight
        const kept = await rebindTunnelBackend(wc, ts.url, existing);
        if (kept.verdict === "kept") {
          if (notify && !wc.isDestroyed()) wc.send(BASE_CHANGED, kept.url);
          return kept.url;
        }
        if (kept.verdict !== "gone") {
          // doubt: the session is not provably gone, so no second session may
          // be started over its work — the window waits at "not running" for
          // the next claim to re-bind it
          return null;
        }
      }
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
    if (existing && existing.kind === "tunnel") {
      // a parked tunnel claim is not provably gone (its hop died mid-ask, and
      // only a supervisor that ANSWERS may retire it). A local session here
      // would be the second window over the far session's work — the exact
      // "already open in another window" conflict — so wait instead: the
      // reconnect's claim re-binds this one
      return null;
    }
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

  // Every window's claim at once, WITHOUT asking any supervisor to exit (the
  // machine may still serve other windows — their sessions keep running on it).
  // Machine-wide acts only: app shutdown, and the picker's own Disconnect, which
  // IS the user leaving the machine. A window leaving an outage releases its OWN
  // claim instead (releaseWindowBackend, through the `session:release` handler):
  // dropping every window's session because one of them pressed Cancel is how a
  // disconnect in one window used to take the other windows' work down with it.
  async function releaseAllBackends() {
    for (const id of [...windowBackends.keys()]) await releaseWindowBackend(id);
  }

  // A tunnel is gone. Every window's forward through it died with it (stopTunnel
  // closes all of them, and a tunnel whose ssh hop ended serves nothing either),
  // so no window may keep pointing at one — a cached URL would be the port of a
  // dead hop. Both shells call this from their tunnel-end notification, BEFORE
  // they tell the renderer, so nothing races a half-closed forward. The CLAIMS
  // themselves survive: session id + remote port name a process on the far host
  // that outlives the hop (a run in flight must outlive it too — the session is
  // left running and the reaper collects it when it goes idle), so a re-claim
  // after the reconnect re-opens its forward instead of starting a new session
  // over the old one's work.
  //
  // Returns the WINDOW IDS whose forward it dropped — not a count. The tunnel is
  // one process-wide resource and the session is not: a shell's tunnel-end
  // notification has to name the windows the hop actually owned, or every other
  // window is told it lost a session that is still running fine (see the
  // `lost` flag the shells compute from this list).
  async function releaseTunnelBackends() {
    const affected = [];
    for (const [id, wb] of [...windowBackends]) {
      if (wb.kind !== "tunnel") continue;
      if (typeof wb.detach === "function") wb.detach();
      else await releaseWindowBackend(id); // no detach on this claim: full stop
      affected.push(id);
    }
    return affected;
  }

  // Is any window still working over the tunnel? The tunnel is a shared resource
  // and stopping it is a machine-wide act, so only a caller that is about to
  // release the LAST window on it may stop it (ui/main.js `session:release`).
  function anyTunnelWindow() {
    for (const wb of windowBackends.values()) {
      if (wb.kind === "tunnel") return true;
    }
    return false;
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
    releaseTunnelBackends,
    anyTunnelWindow,
    stopAllBackends,
    claimWindowBackend,
    backendKind,
    backendCount: () => windowBackends.size,
  };
}

module.exports = { createHostCore, BASE_CHANGED };
