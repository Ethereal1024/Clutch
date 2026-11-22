// Session-claim state machine, extracted from the Electron main process (R2)
// so the Android host can drive the exact same logic. Everything platform-
// shaped enters through `deps`; a window handle only needs
// { id, isDestroyed(), send(channel, payload) } — which Electron webContents
// already satisfies, and the Android bridge wraps with its SSE notifier.
//
// deps:
//   supervisorBase()      => "http://127.0.0.1:8890" | null  (null = no local mode, N4)
//   remoteLlmBase()       => "http://127.0.0.1:8892/v1"     (reverse-forward LLM proxy;
//                            the port is the one the reverse forward landed on —
//                            8892 unless the far side had to choose another)
//   remoteLlmModel()      => "deepseek-v4-flash" | ""       (model for the remote session)
//   remoteLlmKnobs()      => { reasoning_effort, api_protocol }  (same trip as the model)
//   tunnelStatus()        => { active, url }                (SSH tunnel state)
//   awaitModelPath()      => Promise<"listening"|"installing"|"unavailable"|"none">
//                            (joins the far side's in-flight reverse-forward
//                            install; "listening" is the only answer that means
//                            a session's --base-url points at something that
//                            answers. The connect no longer waits for it, so
//                            this claim does — see ui/tunnel-connect.js)
//   restartRemoteServer() => Promise<bool>                  (reboot an idle-exited remote supervisor)
//   openSessionForward(port) => Promise<{ localPort, close() }>
//   startLocalSession(onFail) => Promise<{mode, sessionId, url, stop}> | null
//                           (spawns the LOCAL supervisor + session; absent on Android.
//                            The claim that names this window's OS process rides with
//                            every session start — the supervisor client attaches it —
//                            so a lock it leaves behind can be proven orphaned by the
//                            kernel instead of timed out)
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
    // where this client serves the far side's model RIGHT NOW ({base_url, model})
    // or null when it serves nothing — the re-point target a session's heartbeat
    // carries (see llmTarget below and ui/tunnel-core.js servedLlmBase)
    remoteLlmTarget = () => null,
    remoteLlmModel = () => "",
    remoteLlmKnobs = () => ({}),
    // Global (primary) tunnel status — used when a slot has no pinned target
    tunnelStatus,
    // Per-tunnel ops: (tunnelId) => <op>. Provided by hosts that support multiple
    // simultaneous tunnels; absent on Android and in tests that inject fakes.
    tunnelStatusFor = undefined,
    openSessionForwardFor = undefined,
    awaitModelPathFor = undefined,
    restartRemoteServerFor = undefined,
    remoteLlmBaseFor = undefined,
    // Single-tunnel ops — still required for backward compat and for the global tunnel
    restartRemoteServer,
    openSessionForward,
    // no tunnel at all (a host with no tunnel dep, a hermetic test): "none" says
    // "nothing to wait for", which is also what a fake-dep suite means by it
    awaitModelPath = async () => "none",
    startLocalSession,
    log = () => {},
    sessions = defaultSessions,
  } = deps;

  // per-SLOT backend state: `${winId}::${slotId}` -> {kind, sessionId, url, winId, slotId, stop()}
  //
  // A slot is ONE TAB's session. The supervisor already spawns one agent child
  // per claim, so a second tab is a second process with its own open project and
  // its own run lease — the old multi-window parallelism, keyed by tab instead
  // of by window. An empty slotId is the window's default slot, which keeps
  // single-tab clients (and every call site that predates tabs) working
  // unchanged.
  const windowBackends = new Map();
  const slotKey = (winId, slotId) => (slotId ? `${winId}::${slotId}` : String(winId));

  // per-SLOT tunnel target:
  //   slotKey -> { kind: "local" }
  //            | { kind: "tunnel", tunnelId: string }
  //
  // A slot with no entry uses the global tunnel (backward compat). "local" forces
  // the slot onto the local supervisor even when a tunnel is active. "tunnel" pins
  // the slot to a specific tunnel by its id (host:user:port canonical form).
  const slotTargets = new Map();

  // Resolve the tunnel-specific operations for a given slot. Returns a small
  // object with the ops that `claimSlotBackend` and its helpers call. If the
  // slot is pinned to a specific tunnel (via `slotTargets`) and the host supplied
  // per-tunnel ops, those are used; otherwise the global ops apply.
  function resolveSlotTunnelDeps(winId, slotId = "") {
    const key = slotKey(winId, slotId);
    const slotTarget = slotTargets.get(key);

    // Slot pinned to a specific tunnel and the host knows how to serve it
    if (
      slotTarget &&
      slotTarget.kind === "tunnel" &&
      slotTarget.tunnelId &&
      typeof tunnelStatusFor === "function"
    ) {
      const tid = slotTarget.tunnelId;
      return {
        tunnelSt: () => tunnelStatusFor(tid) || {},
        openFwd: typeof openSessionForwardFor === "function"
          ? (port) => openSessionForwardFor(tid, port)
          : openSessionForward,
        awaitPath: typeof awaitModelPathFor === "function"
          ? () => awaitModelPathFor(tid)
          : awaitModelPath,
        restartRemote: typeof restartRemoteServerFor === "function"
          ? () => restartRemoteServerFor(tid)
          : restartRemoteServer,
        remoteLlm: typeof remoteLlmBaseFor === "function"
          ? () => remoteLlmBaseFor(tid)
          : remoteLlmBase,
      };
    }

    // Slot pinned to local: return inactive tunnel status so claimSlotBackend
    // skips the tunnel path and goes straight to the local session.
    if (slotTarget && slotTarget.kind === "local") {
      return {
        tunnelSt: () => ({ active: false }),
        openFwd: openSessionForward,
        awaitPath: awaitModelPath,
        restartRemote: restartRemoteServer,
        remoteLlm: remoteLlmBase,
      };
    }

    // No pin — use the global (primary) tunnel ops unchanged
    return {
      tunnelSt: tunnelStatus || (() => ({})),
      openFwd: openSessionForward,
      awaitPath: awaitModelPath,
      restartRemote: restartRemoteServer,
      remoteLlm: remoteLlmBase,
    };
  }

  // Set target for a specific slot. target may be:
  //   { kind: "local" }                        — force local regardless of tunnel
  //   { kind: "tunnel", tunnelId: string }      — pin to a specific tunnel
  //   null | undefined                          — clear (use global default)
  function setSlotTarget(winId, slotId = "", target) {
    const key = slotKey(winId, slotId);
    if (target === null || target === undefined) {
      slotTargets.delete(key);
    } else {
      slotTargets.set(key, target);
    }
  }

  // Returns the recorded target for a slot, or null for the global default.
  function getSlotTarget(winId, slotId = "") {
    return slotTargets.get(slotKey(winId, slotId)) || null;
  }

  // The default slot's notification keeps its pre-tabs shape (a bare URL): the
  // renderer that predates tabs reads it as a string. A named slot gets the
  // { slotId, url } pair, because a window can now hold several sessions and the
  // page has to know which one moved.
  function notifyBase(wc, slotId, url) {
    if (!wc || wc.isDestroyed()) return;
    wc.send(BASE_CHANGED, slotId ? { slotId, url } : url);
  }

  // Where this client serves the far side's model right now, as a re-point target
  // for a session whose LLM endpoint was frozen at spawn — or null when it serves
  // nothing. Read on every beat (the far side's port moves with every hop), and
  // never throws: a beat whose target cannot be named is a plain liveness beat,
  // which must keep working while the network is misbehaving.
  function llmTarget() {
    try {
      return remoteLlmTarget() || null;
    } catch (e) {
      return null;
    }
  }

  // A release the supervisor did not confirm is not a stopped session.
  //
  // The far side is a process, not a socket: it outlives the hop and it keeps
  // the .clc it opened for write LOCKED (agent/core/project_lock.py — the lock is
  // the kernel's, and it is held until that process dies). Dropping the local
  // record on a `stop` that could not reach it — the exact situation a release
  // runs in during an outage, since the hop is down — is what makes the NEXT claim
  // start a second session over the first one's project. The far host answers
  // that with `project_open_conflict`, and the page turns it into "Already open
  // elsewhere — open it read-only?": a tab that was open for write comes back
  // read-only. That is the reported read-only offer after a successful reconnect.
  //
  // So the claim is PARKED: detached (its heartbeat and forward died with the hop)
  // but still re-bindable, because session id + remote port name a process that is
  // still there. `parked` is the fact that says "no window depends on this any
  // more" — anyTunnelWindow ignores it, so the picker's Disconnect and the outage's
  // Cancel still end the hop (a session nobody watches is the reaper's, not the
  // window's). The next claim for this slot adopts it instead of starting a second
  // session (claimSlotBackend's rebind path).
  function parkIfUnconfirmed(key, wb, stopped, opts) {
    if (!wb || wb.kind !== "tunnel" || !wb.sessionId) return;
    if (opts && opts.leaving) return; // the app is leaving: nothing will re-bind
    if (!stopped || stopped.ok !== false) return; // the supervisor stopped it
    if (windowBackends.has(key)) return; // a newer claim owns the slot
    wb.parked = true;
    windowBackends.set(key, wb);
    log(`[backend] slot ${key} session ${wb.sessionId} release was not confirmed; keeping the claim for the next hop`);
  }

  // Drop one claim. `opts.leaving` says the APP is quitting (not just this
  // slot): the release then tells the supervisor to stop the session through
  // its SIGTERM ladder, so a `released` final is written. Awaitable so the quit
  // gate can wait for the answer instead of exiting first.
  async function releaseSlot(winId, slotId = "", opts = {}) {
    const key = slotKey(winId, slotId);
    const wb = windowBackends.get(key);
    if (!wb) return;
    windowBackends.delete(key);
    let stopped;
    try {
      stopped = await wb.stop(opts);
    } catch (e) {
      stopped = { ok: false };
    }
    parkIfUnconfirmed(key, wb, stopped, opts);
  }

  // every slot the window claimed (window close, window crash). A window's slots
  // are independent sessions; one leaving must not touch another window's.
  async function releaseWindowBackends(winId, opts = {}) {
    for (const [key, wb] of [...windowBackends]) {
      if (wb.winId !== winId) continue;
      windowBackends.delete(key);
      let stopped;
      try {
        stopped = await wb.stop(opts);
      } catch (e) {
        stopped = { ok: false };
      }
      parkIfUnconfirmed(key, wb, stopped, opts);
    }
  }

  // this claim's heartbeat gave up on its session. Re-bind FIRST — the
  // failure can be THIS client's own stale forward while the far host kept
  // running the session all along (the phone returning from the background is
  // exactly that) — and only replace the session when the old one is provably
  // gone. Silence is not that proof: when the supervisor cannot be ASKED (the
  // hop is down — this beat failing is usually the hop's dying breath), the
  // claim is kept, parked, for the next hop to re-bind.
  function tunnelClaimOnFail(wc, slotId, supBase, sessionId) {
    const key = slotKey(wc.id, slotId);
    return () => {
      log(`[backend] slot ${key} session heartbeat failed; re-establishing`);
      (async () => {
        const cur = windowBackends.get(key);
        if (!cur || cur.sessionId !== sessionId) return; // superseded / closed
        // ask through the hop that is up NOW: use the slot's tunnel status
        // (may be a specific per-slot tunnel or the global one)
        const { tunnelSt, openFwd } = resolveSlotTunnelDeps(wc.id, slotId);
        const ts = tunnelSt();
        const hop = ts.active && ts.url ? ts.url : supBase;
        const verdict = await rebindTunnelBackend(wc, slotId, hop, cur, openFwd);
        if (verdict.verdict === "kept") {
          if (!wc.isDestroyed()) notifyBase(wc, slotId, verdict.url);
          return;
        }
        if (windowBackends.get(key) !== cur) return; // the claim changed hands while we were asking: replacing now would spawn a session nobody is waiting for
        if (verdict.verdict !== "gone") {
          // doubt (no route to the supervisor): NOT provably gone, so the
          // claim stays — its forward and heartbeat are already dropped — and
          // the next claim (the reconnect's api:base) re-binds it. Replacing it
          // here would start a second session over the first one's work, which
          // the far host reports as "this project is already open in another window"
          log(`[backend] slot ${key} session ${sessionId} not provably gone; keeping the claim for the next hop`);
          return;
        }
        await releaseSlot(wc.id, slotId);
        const url = await ensureSlotBackend(wc, slotId);
        if (!wc.isDestroyed()) notifyBase(wc, slotId, url);
      })();
    };
  }

  // the shape of a tunnel claim. What survives a hop is the SESSION — its id
  // and the remote port it listens on name a process on the far host — and
  // what the hop owns is the local half (the forward and its URL, the
  // heartbeat). `detach` drops exactly that half, ONCE: a detached claim is
  // detached again when it is stopped or re-bound, and one close is all a
  // forward needs.
  function tunnelClaim(wc, slotId, supBase, sessionId, sessionPort, fwd, hb) {
    let dropped = false;
    const wb = {
      kind: "tunnel",
      winId: wc.id,
      slotId,
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
      stop: (opts: { leaving?: boolean } = {}) => {
        wb.detach();
        return sessions.supervisorSessionStop(supBase, sessionId, { leaving: !!(opts && opts.leaving) });
      },
    };
    return wb;
  }

  async function registerTunnelBackend(wc, slotId, supBase, res, openFwd = openSessionForward) {
    const fwd = await openFwd(res.port);
    const hb = sessions.startSupervisorHeartbeat(
      supBase,
      res.sessionId,
      tunnelClaimOnFail(wc, slotId, supBase, res.sessionId),
      // where this client serves the model right now: the session's endpoint
      // follows it when a hop lands the far-side forward on another port (a
      // session's --base-url was frozen at spawn and the run inside it outlives
      // every hop, so a frozen base is a run that can never recover)
      llmTarget
    );
    const wb = tunnelClaim(wc, slotId, supBase, res.sessionId, res.port, fwd, hb);
    windowBackends.set(slotKey(wc.id, slotId), wb);
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
  async function rebindTunnelBackend(wc, slotId, supBase, existing, openFwd = openSessionForward) {
    if (!existing || existing.kind !== "tunnel" || !existing.sessionId || !existing.sessionPort) {
      return { verdict: "gone" };
    }
    if (typeof existing.detach === "function") existing.detach(); // the old forward/heartbeat are dead weight
    // the supervisor is the authority on "is the session still there", and the
    // beat doubles as the re-claim: it re-arms the window contract the reaper
    // judges staleness by
    const alive = await sessions.supervisorSessionHeartbeat(supBase, existing.sessionId, llmTarget);
    if (alive == null) return { verdict: "doubt" }; // unreachable is not gone
    if (!alive) return { verdict: "gone" };
    let fwd;
    try {
      fwd = await openFwd(existing.sessionPort);
    } catch (e) {
      log(`[backend] session ${existing.sessionId} forward failed: ${(e && e.message) || e}`);
      // the session PROVED itself alive above; a forward that will not open is
      // this hop's failing, not the session's — keep the claim and try again
      return { verdict: "doubt" };
    }
    const hb = sessions.startSupervisorHeartbeat(
      supBase,
      existing.sessionId,
      tunnelClaimOnFail(wc, slotId, supBase, existing.sessionId),
      llmTarget
    );
    const wb = tunnelClaim(wc, slotId, supBase, existing.sessionId, existing.sessionPort, fwd, hb);
    if (windowBackends.get(slotKey(wc.id, slotId)) !== existing) {
      // superseded while we worked (a newer claim, or the window closed):
      // what we opened serves nobody, and what changed hands is not replaced
      // behind the new holder's back
      wb.detach();
      return { verdict: "doubt" };
    }
    windowBackends.set(slotKey(wc.id, slotId), wb);
    return { verdict: "kept", url: wb.url };
  }

  // Decide (and, if needed, re-create) this slot's backend URL. Uses per-slot
  // tunnel targeting when available; routes through the global tunnel or local
  // session otherwise.
  async function claimSlotBackend(wc, slotId = "", notify = false) {
    const key = slotKey(wc.id, slotId);
    
    // Resolve tunnel deps for this slot
    const { tunnelSt, openFwd, awaitPath, restartRemote, remoteLlm } = resolveSlotTunnelDeps(wc.id, slotId);
    const ts = tunnelSt();
    // Is this slot's file known to live on a MACHINE? slots.ts pins
    // {kind:"tunnel"} for a tab whose file is out there, and the pin is the
    // difference between a slot that merely happens to be claimed while a hop is
    // up and one that cannot be served here at all. For that slot no answer below
    // may be this machine's session: a local session cannot have the path, and
    // its answer — "not a .clc project file" (agent/api/project.py) — names
    // neither the machine nor the way back, which is the dead end the user hit.
    const pin = slotTargets.get(key);
    const onMachine = !!(pin && pin.kind === "tunnel");

    if (ts.active && ts.url) {
      const existing = windowBackends.get(key);
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
        const kept = await rebindTunnelBackend(wc, slotId, ts.url, existing, openFwd);
        if (kept.verdict === "kept") {
          if (notify && !wc.isDestroyed()) notifyBase(wc, slotId, kept.url);
          return kept.url;
        }
        if (kept.verdict !== "gone") {
          // doubt: the session is not provably gone, so no second session may
          // be started over its work — the window waits at "not running" for
          // the next claim to re-bind it
          return null;
        }
      }
      await releaseSlot(wc.id, slotId); // drop any local session first
      // The far side's model path is installed beside the connect, not inside it
      // (ui/tunnel-connect.js startModelPath): a far side that is silent about
      // global requests must not be able to hold "Starting tunnel…" open. What it
      // must not do either is get a session whose --base-url points at a port
      // nobody serves — the request is ACCEPTED by the reverse forward and
      // answered by nobody, and the agent's read then parks in its own budget
      // ("only Stop moved it"). So the wait happens HERE: once, at the one moment
      // the answer is actually needed, and bounded by the installer's own clocks.
      // A path that is not up is not a reason to refuse the session — a run whose
      // model does not answer beats no run — but the log says which it is. A dep
      // that THROWS is "unknown", never a failed claim: the tunnel not answering
      // about a port says nothing about whether a run may start.
      let path: string;
      try {
        path = await awaitPath();
      } catch (e) {
        path = "unknown (" + ((e && e.message) || e) + ")";
      }
      if (path !== "listening") {
        log(`[backend] the far side's model path is ${path}; starting the session anyway`);
      }
      let res = await sessions.supervisorSessionStart(
        ts.url,
        remoteLlm(),
        remoteLlmModel(),
        remoteLlmKnobs(),
      );
      if (res.error) {
        // the remote supervisor may have idle-exited: restart it through the tunnel and retry once
        log(`[backend] tunnel session start failed (${res.error}); restarting remote supervisor`);
        const ok = await restartRemote();
        if (ok) {
          res = await sessions.supervisorSessionStart(
            ts.url,
            remoteLlm(),
            remoteLlmModel(),
            remoteLlmKnobs(),
          );
          if (res.error) log(`[backend] tunnel session retry failed: ${res.error}`);
        }
      }
      if (!res.error) {
        const url = await registerTunnelBackend(wc, slotId, ts.url, res, openFwd);
        if (notify && !wc.isDestroyed()) notifyBase(wc, slotId, url);
        return url;
      }
      if (onMachine) {
        // a session that will not start on the far side is a FAILURE of this
        // claim, never a reason to pretend the file is here
        log(`[backend] slot ${key} is on a machine and no tunnel session could be started; not claiming a local session`);
        return null;
      }
      // tunnel alive but supervisorless (degraded host or remote died): fall back to a local session
      log("[backend] no tunnel session; falling back to a local session");
    }

    if (onMachine) {
      // the hop is not serving this slot (no tunnel, or one that is up without a
      // URL — the window it spends re-binding a forward): waiting for the next
      // claim is the honest answer, because a local session would be the wrong
      // machine for a path that lives out there
      log(`[backend] slot ${key} is on a machine and the hop is not serving it (${ts.active ? "up, no url" : "no tunnel"}); no local session for it`);
      return null;
    }

    if (typeof startLocalSession !== "function") {
      // no tunnel session and no local mode (Android, N4): the renderer's
      // api:base placeholder shows "not running" — there is nothing to fall back to
      log("[backend] no tunnel session and no local mode on this host");
      return null;
    }

    const existing = windowBackends.get(key);
    if (existing && existing.kind === "local") return existing.url;
    if (existing && existing.kind === "tunnel") {
      // a parked tunnel claim is not provably gone (its hop died mid-ask, and
      // only a supervisor that ANSWERS may retire it). A local session here
      // would be the second window over the far session's work — the exact
      // "already open in another window" conflict — so wait instead: the
      // reconnect's claim re-binds this one
      return null;
    }
    await releaseSlot(wc.id, slotId);
    let s;
    const onFail = () => {
      // self-heal: the local supervisor died (idle exit, crash, stale reap);
      // re-claim and point the renderer at the new URL — same as the tunnel path
      log(`[backend] slot ${key} local session heartbeat failed; re-establishing`);
      (async () => {
        const cur = windowBackends.get(key);
        if (!cur || cur.sessionId !== s.sessionId) return; // superseded / closed
        await releaseSlot(wc.id, slotId);
        await ensureSlotBackend(wc, slotId, true);
      })();
    };
    // The claiming window is named in ONE place — the supervisor client, which
    // sends (host, pid, start tick) with every session start, local or tunnelled
    // — so this state machine hands the claim nothing and cannot get it wrong.
    // The pid there is the host process (the Electron main / Android host), never
    // the renderer: a reload or a crash recovery replaces the renderer while the
    // app lives, and the session's watchdog polls that pid once a second
    // (agent/core/claim_watch.py). Naming the renderer would make those routine
    // events look exactly like "the app is gone" and end a live session.
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
    const wb = { kind: "local", winId: wc.id, slotId, sessionId: s.sessionId, url: s.url, stop: s.stop };
    windowBackends.set(key, wb);
    if (notify && !wc.isDestroyed()) notifyBase(wc, slotId, wb.url);
    return wb.url;
  }

  // one in-flight claim per SLOT: overlapping api:base calls (renderer boot,
  // retries) must share a single session claim, not spawn two session children
  const backendClaims = new Map(); // slotKey -> Promise<url|null>
  function ensureSlotBackend(wc, slotId = "", notify = false) {
    const key = slotKey(wc.id, slotId);
    const inflight = backendClaims.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        return await claimSlotBackend(wc, slotId, notify);
      } finally {
        backendClaims.delete(key);
      }
    })();
    backendClaims.set(key, p);
    return p;
  }

  // Every window's claim at once, WITHOUT asking any supervisor to exit (the
  // machine may still serve other windows — their sessions keep running on it).
  // Machine-wide acts only: app shutdown, and the picker's own Disconnect, which
  // IS the user leaving the machine. A window leaving an outage releases its OWN
  // claim instead (releaseWindowBackend, through the `session:release` handler):
  // dropping every window's session because one of them pressed Cancel is how a
  // disconnect in one window used to take the other windows' work down with it.
  async function releaseAllBackends(opts = {}) {
    for (const [key, wb] of [...windowBackends]) {
      windowBackends.delete(key);
      try {
        await wb.stop(opts);
      } catch (e) {
        /* best effort */
      }
    }
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
  // Returns the SLOTS whose forward it dropped — {winId, slotId} records, not a
  // count. The tunnel is one process-wide resource and the sessions are not: a
  // shell's tunnel-end notification has to name the slots the hop actually
  // owned, or every other tab is told it lost a session that is still running
  // fine (see the `lost` flag the shells compute from this list).
  //
  // `tunnelUrl` (optional): when given, only releases backends whose forward
  // was opened through that tunnel. Slots on a different tunnel are untouched.
  // Omit to release ALL tunnel backends (app shutdown, single-tunnel teardown).
  async function releaseTunnelBackends(tunnelUrl?: string) {
    const affected = [];
    for (const [key, wb] of [...windowBackends]) {
      if (wb.kind !== "tunnel") continue;
      // With per-tunnel routing a slot may be on a different tunnel than the one
      // that just ended. Only detach the forwards that actually died.
      if (tunnelUrl && wb.tunnelUrl && wb.tunnelUrl !== tunnelUrl) continue;
      if (typeof wb.detach === "function") wb.detach();
      else {
        windowBackends.delete(key);
        try {
          wb.stop();
        } catch (e) {
          /* best effort */
        }
      }
      affected.push({ winId: wb.winId, slotId: wb.slotId });
    }
    return affected;
  }

  // Is any window still working over the tunnel? The tunnel is a shared resource
  // and stopping it is a machine-wide act, so only a caller that is about to
  // release the LAST window on it may stop it (ui/main.js `session:release`).
  // `tunnelUrl` (optional): when given, checks only windows on that tunnel.
  function anyTunnelWindow(tunnelUrl?: string) {
    for (const wb of windowBackends.values()) {
      if (wb.kind !== "tunnel") continue;
      // a PARKED claim is a memory of a far-side session nobody is looking at
      // any more (its release could not be confirmed): keeping the hop up for it
      // would make the outage's Cancel — and the picker's Disconnect — unable to
      // end a connection no window is using
      if (wb.parked) continue;
      if (tunnelUrl && wb.tunnelUrl && wb.tunnelUrl !== tunnelUrl) continue;
      return true;
    }
    return false;
  }

  // The app is leaving: release every claim and then tell every supervisor to
  // die. `opts.leaving` must be true here — this IS the quit gate, and it is
  // the only place allowed to say so.
  async function stopAllBackends(opts = {}) {
    const bases = supervisorBases(); // before the claims (and their bases) go
    await releaseAllBackends(opts);
    await requestSupervisorShutdown(bases);
  }

  // The SUPERVISOR that owns this window's session — and therefore the only
  // process that can speak about locks on the machine the work happens on: a
  // lock is freed by the host that holds it, never by the client. A tunnel
  // claim means the far host's supervisor (through the same tunnel base); a
  // local claim (or no claim yet) means this machine's.
  //
  // With per-slot tunnel routing, `wb.tunnelUrl` records which tunnel URL the
  // claim was opened through — that is the supervisor to use, not the current
  // global tunnel status (which may be a different device entirely).
  function supervisorBaseFor(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    if (wb && wb.kind === "tunnel") {
      // The claim already knows its tunnel; use it directly
      if (wb.tunnelUrl) return wb.tunnelUrl;
      // Fall back to the slot's current tunnel if the claim is unrooted
      const { tunnelSt } = resolveSlotTunnelDeps(winId, slotId);
      const ts = tunnelSt() || {};
      return ts.active && ts.url ? ts.url : null;
    }
    return supervisorBase ? supervisorBase() : null;
  }

  // The supervisors this client has to tell when it leaves. Read BEFORE the
  // claims are dropped: a tunnel backend's `tunnelUrl` is the only record of the
  // base it was opened through, and releaseAllBackends deletes that record.
  function supervisorBases() {
    const local = supervisorBase ? supervisorBase() : null;
    // A multi-tunnel session may hold backends on several remote supervisors and
    // all of them need to know the client is leaving.
    const remote = new Set<string>();
    for (const wb of windowBackends.values()) {
      if (wb.kind === "tunnel" && wb.tunnelUrl) remote.add(wb.tunnelUrl);
    }
    // Also include the global (primary) tunnel for any slots on the default one
    if (typeof tunnelStatus === "function") {
      const ts = tunnelStatus() || {};
      if (ts.active && ts.url) remote.add(ts.url);
    }
    return [local, ...remote].filter(Boolean);
  }

  // Machine-wide half: arm the supervisor's own exit. It is NOT a kill switch —
  // a machine-wide supervisor may serve windows other than this one, so what
  // this client's sessions get is the explicit per-session {leaving:true}
  // release above; arming only makes the supervisor process itself go once its
  // sessions are gone. AWAITED so the POST leaves before the process exits.
  async function requestSupervisorShutdown(bases?) {
    const list = bases || supervisorBases();
    // supervisorShutdown() appends /api/shutdown itself — hand it bases, not URLs
    await Promise.all(list.map((base) => sessions.supervisorShutdown(base)));
  }

  // which machine a window's session runs on ("local" | "tunnel" | null when it
  // has not claimed one yet). The components page needs it: components live on a
  // machine's supervisor, so "install where this window works" means the far
  // side of a tunnel, and a tunnel being up is not the same claim — a window
  // that fell back to a local session is working HERE.
  function backendKind(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    return wb ? wb.kind : null;
  }

  // What the renderer needs to know about one slot without claiming it: whether
  // a session exists (a page reload re-attaches instead of spawning a second
  // one), where it is, and which machine it runs on.
  function slotStatus(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    if (!wb) return { claimed: false, kind: null, url: null };
    return { claimed: true, kind: wb.kind, url: wb.url || null };
  }

  return {
    ensureSlotBackend,
    releaseSlot,
    releaseWindowBackends,
    releaseAllBackends,
    releaseTunnelBackends,
    stopAllBackends,
    anyTunnelWindow,
    backendKind,
    slotStatus,
    // how many live claims this host holds (diagnostics and tests)
    backendCount: () => windowBackends.size,
    supervisorBaseFor,
    setSlotTarget,
    getSlotTarget,
  };
}

module.exports = { createHostCore, BASE_CHANGED };
