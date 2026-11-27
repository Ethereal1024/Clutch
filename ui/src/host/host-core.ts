// Session-claim state machine, extracted from the Electron main process (R2)
// so the Android host can drive the exact same logic. Everything platform-
// shaped enters through `deps`; a window handle only needs
// { id, isDestroyed(), send(channel, payload) } — which Electron webContents
// already satisfies, and the Android bridge wraps with its SSE notifier.
//
// deps:
//   executors             the execution endpoints this process can claim on
//                         (ui/executors.ts): this machine and every hop. The
//                         whole of "where does this session run" is one lookup
//                         there — there is no local path and tunnel path here,
//                         only an endpoint that does or cannot serve.
//   log(...args)          => sink (tunnelLog on desktop)
//   sessions              => pure supervisor HTTP client (supervisor-client.js;
//                            injectable so tests can run the machine hermetically)
const defaultSessions = require("./supervisor-client");
const { LOCAL_ID } = require("./executors");
const os = require("os");
const procstat = require("./procstat");

// the one channel the machine itself pushes to the renderer; a healthy
// session overrides the boot placeholder via `backend:base-changed`
const BASE_CHANGED = "backend:base-changed";

function createHostCore(deps) {
  const { executors, log = () => {}, sessions = defaultSessions } = deps;

  // per-SLOT backend state:
  //   `${winId}::${slotId}` -> {executor, remote, target, sessionId, url, ...}
  //
  // A slot is ONE TAB's session. The supervisor already spawns one agent child
  // per claim, so a second tab is a second process with its own open project and
  // its own run lease — the old multi-window parallelism, keyed by tab instead
  // of by window. An empty slotId is the window's default slot, which keeps
  // single-tab clients (and every call site that predates tabs) working
  // unchanged.
  const windowBackends = new Map();
  const slotKey = (winId, slotId) => (slotId ? `${winId}::${slotId}` : String(winId));

  // per-SLOT execution endpoint:
  //   slotKey -> { kind: "executor", target: {host, user, port} }  a named machine
  //            | { kind: "executor", id: string }                  an endpoint by id
  //
  // A slot with no entry follows the default endpoint — the hop that is serving,
  // else this machine — which is the rule every call site that predates tabs
  // already obeys. A pin is the promise that no OTHER machine's session is an
  // acceptable answer for this slot: the claim is made on the endpoint the pin
  // names, or not at all.
  const slotTargets = new Map();

  // The endpoint this slot claims on, or null when there is none. `pinned` says
  // whether the slot named it — the difference between "this is where the file
  // is" (a failure is final) and "nothing said, so try the default" (a hop that
  // cannot serve leaves this machine as the honest answer).
  function slotExecutor(winId, slotId = "") {
    const pin = slotTargets.get(slotKey(winId, slotId));
    if (pin) {
      const id = executors.resolve(pin);
      return { ex: id ? executors.get(id) : null, pinned: true };
    }
    const id = executors.defaultId();
    return { ex: id ? executors.get(id) : null, pinned: false };
  }

  // Set the endpoint for a specific slot. target is:
  //   { kind: "executor", target: {host,user,port} } — the machine the file is on
  //   { kind: "executor", id: string }               — an endpoint, by its id
  //   null | undefined                               — clear (follow the default)
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
    // only a session on ANOTHER machine leaks this way: this machine's session is
    // a child of this machine's supervisor, and a stop that could not reach that
    // supervisor is a session that died with it
    if (!wb || !wb.remote || !wb.sessionId) return;
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
  function claimOnFail(wc, slotId, ex, sessionId) {
    const key = slotKey(wc.id, slotId);
    return () => {
      log(`[backend] slot ${key} session heartbeat failed; re-establishing`);
      (async () => {
        const cur = windowBackends.get(key);
        if (!cur || cur.sessionId !== sessionId) return; // superseded / closed
        if (!cur.remote) {
          // a session HERE is a child of this machine's supervisor: a beat that
          // failed means that supervisor stopped answering, and the session went
          // with it. There is nothing out there to re-bind — release and claim
          // again, which wakes the supervisor and starts a fresh session.
          await releaseSlot(wc.id, slotId);
          const url = await ensureSlotBackend(wc, slotId);
          if (!wc.isDestroyed()) notifyBase(wc, slotId, url);
          return;
        }
        // ask through the endpoint that is serving it NOW: the executor reads
        // the live hop, so a reconnect that landed since the last beat is the
        // one the re-bind goes through
        const verdict = await rebindSessionBackend(wc, slotId, ex, cur);
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

  // the shape of a claim. It is the same shape whether the session runs here or
  // behind a hop: what survives a hop is the SESSION — its id and the port it
  // listens on name a process on that machine — and what the claim owns is the
  // local half (the forward and its URL, the heartbeat). `detach` drops exactly
  // that half, ONCE: a detached claim is detached again when it is stopped or
  // re-bound, and one close is all a forward needs.
  function sessionClaim(wc, slotId, ex, supBase, sessionId, sessionPort, fwd, hb) {
    let dropped = false;
    const wb = {
      // the endpoint this claim is on, as an id: what a re-claim compares to know
      // whether it is looking at the same machine
      executor: ex.id,
      // does the work happen somewhere other than this process? That — not the
      // executor's name — is what decides whether a hop can strand the session
      remote: !!ex.remote,
      // the machine, for a tab that has to remember it (null for this one)
      target: ex.target(),
      winId: wc.id,
      slotId,
      sessionId,
      // the port the session listens on where it runs: the session is a process
      // on that machine and outlives any hop to it, so a bounced hop re-opens
      // this forward instead of replacing the session (rebindSessionBackend)
      sessionPort,
      // the base the forward was opened through: a URL opened through one hop
      // names a dead port on the next one
      tunnelUrl: supBase,
      url: `http://127.0.0.1:${fwd.localPort}`,
      // drop this claim's LOCAL half (heartbeat + forward) and nothing else:
      // the far-side session is left to its own lifecycle, and the claim stays
      // re-bindable (session id + session port name it, not the dead forward)
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

  // Ask ONE endpoint for a session and hold what it hands back. This is the whole
  // of "claim a session": the endpoint knows whether a supervisor has to be woken
  // first or whether the far side starts its own, and how a port here reaches a
  // port there. Nothing above it needs to know which kind of machine it is.
  // Returns { url } or { error } — a caller decides whether a failure is final
  // (a slot pinned to a machine) or a reason to try this machine instead.
  async function startSessionOn(wc, slotId, ex) {
    const key = slotKey(wc.id, slotId);
    await ex.ready();
    const supBase = ex.base();
    if (!supBase) return { error: `no supervisor URL for ${ex.id}` };
    // The claiming window is named in ONE place — the supervisor client, which
    // sends (host, pid, start tick) with every session start, local or tunnelled
    // — so this state machine hands the claim nothing and cannot get it wrong.
    // The pid there is the host process (the Electron main / Android host), never
    // the renderer: a reload or a crash recovery replaces the renderer while the
    // app lives, and the session's watchdog polls that pid once a second
    // (agent/core/claim_watch.py). Naming the renderer would make those routine
    // events look exactly like "the app is gone" and end a live session.
    let res = await sessions.supervisorSessionStart(supBase);
    if (res.error) {
      // it is up (or was) and is not answering: a remote supervisor idle-exited,
      // a local one crashed between the wake and the ask. Reboot and ask once.
      log(`[backend] slot ${key} session start failed on ${ex.id} (${res.error}); restarting its supervisor`);
      const ok = await ex.restart();
      if (ok) {
        res = await sessions.supervisorSessionStart(ex.base() || supBase);
        if (res.error) log(`[backend] slot ${key} session retry failed: ${res.error}`);
      }
    }
    if (res.error) return { error: res.error };
    let fwd;
    try {
      fwd = await ex.forward(res.port);
    } catch (e) {
      log(`[backend] slot ${key} session ${res.sessionId} forward failed: ${(e && e.message) || e}`);
      return { error: `forward failed: ${(e && e.message) || e}` };
    }
    const hb = sessions.startSupervisorHeartbeat(
      supBase,
      res.sessionId,
      claimOnFail(wc, slotId, ex, res.sessionId)
    );
    const wb = sessionClaim(wc, slotId, ex, supBase, res.sessionId, res.port, fwd, hb);
    windowBackends.set(key, wb);
    return { url: wb.url };
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
  async function rebindSessionBackend(wc, slotId, ex, existing) {
    if (!existing || !existing.sessionId || !existing.sessionPort) {
      return { verdict: "gone" };
    }
    const supBase = ex ? ex.base() : null;
    // the question can only be asked through a supervisor, and a claim whose
    // endpoint cannot name one is not one this client may replace on a guess
    if (!supBase) return { verdict: "doubt" };
    if (typeof existing.detach === "function") existing.detach(); // the old forward/heartbeat are dead weight
    // the supervisor is the authority on "is the session still there", and the
    // beat doubles as the re-claim: it re-arms the window contract the reaper
    // judges staleness by
    const alive = await sessions.supervisorSessionHeartbeat(supBase, existing.sessionId);
    if (alive == null) return { verdict: "doubt" }; // unreachable is not gone
    if (!alive) return { verdict: "gone" };
    let fwd;
    try {
      fwd = await ex.forward(existing.sessionPort);
    } catch (e) {
      log(`[backend] session ${existing.sessionId} forward failed: ${(e && e.message) || e}`);
      // the session PROVED itself alive above; a forward that will not open is
      // this endpoint's failing, not the session's — keep the claim and try again
      return { verdict: "doubt" };
    }
    const hb = sessions.startSupervisorHeartbeat(
      supBase,
      existing.sessionId,
      claimOnFail(wc, slotId, ex, existing.sessionId)
    );
    const wb = sessionClaim(wc, slotId, ex, supBase, existing.sessionId, existing.sessionPort, fwd, hb);
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

  // Decide (and, if needed, create) this slot's backend URL.
  //
  // ONE path for every endpoint: the slot names a machine (or follows the default
  // one), that endpoint is asked whether it can serve, and then it is asked for a
  // session. "Local" and "the tunnel" are not two branches here — they are two
  // rows of the same table (ui/executors.ts), and the difference that matters is
  // only what the claim does with a failure (a pinned slot's failure is final,
  // because no other machine has the file).
  async function claimSlotBackend(wc, slotId = "", notify = false) {
    const key = slotKey(wc.id, slotId);
    const { ex, pinned } = slotExecutor(wc.id, slotId);

    // What the slot already holds comes FIRST — asking a supervisor for a second
    // session while the first one is working is the failure this whole state
    // machine exists to avoid.
    const existing = windowBackends.get(key);
    if (existing && ex && existing.executor === ex.id) {
      // The URL it holds was opened through the base that is serving it now: that
      // is the answer already. Reusing a forward opened through an EARLIER hop
      // would point the window at a socket nobody serves — the EventSource then
      // errors into the phone's "lost the live stream" while the drop already
      // happened.
      if (existing.url && existing.tunnelUrl === ex.base()) return existing.url;
      // a different hop (or a claim whose forward went with the last one): the
      // session outlives every hop, so re-open its forward — never stop + start,
      // which is what killed runs in flight
      const kept = await rebindSessionBackend(wc, slotId, ex, existing);
      if (kept.verdict === "kept") {
        if (notify && !wc.isDestroyed()) notifyBase(wc, slotId, kept.url);
        return kept.url;
      }
      if (kept.verdict !== "gone") {
        // doubt: the session is not provably gone, so no second session may be
        // started over its work — the window waits at "not running" for the next
        // claim to re-bind it
        return null;
      }
      await releaseSlot(wc.id, slotId); // the supervisor said it no longer holds it
    }

    if (!ex) {
      // Nothing to claim on: the slot named no machine, no hop is serving, and
      // this host has no supervisor of its own (Android, N4). The renderer's
      // api:base placeholder shows "not running" — there is nothing to fall back to.
      log(`[backend] slot ${key} has no endpoint to claim on: no hop is serving it and this build has no local mode`);
      return null;
    }

    if (!ex.capabilities().supervisor) {
      // The endpoint exists and cannot serve a claim: a hop that is up but between
      // forwards, or a far host whose server is not answering. Nothing is
      // retired for that — the session the slot may still hold out there is not
      // provably gone, and the next hop is the answer for it.
      if (pinned || ex.remote) {
        // a session that will never start on the far side is a FAILURE of this
        // claim, never a reason to pretend the file is here: a local session
        // cannot have the path, and its answer — "not a .clc project file" —
        // names neither the machine nor the way back
        log(`[backend] slot ${key} is on a machine and the hop is not serving it; no local session for it`);
      } else {
        log(`[backend] slot ${key} has no supervisor to claim a session on`);
      }
      return null;
    }

    if (existing) {
      // The slot is MOVING to another endpoint — a pin that names a different
      // machine, or a default that moved. What it walks away from is a session on
      // the old endpoint, and only an answered question may retire it: a move onto
      // THIS machine while a far-side session is not provably gone starts a second
      // window over work the far host still holds ("Already open elsewhere — open
      // it read-only?"), which is the reported read-only offer after a reconnect.
      if (existing.remote) {
        const from = executors.get(existing.executor);
        const verdict = await rebindSessionBackend(wc, slotId, from, existing);
        if (verdict.verdict !== "gone") {
          log(`[backend] slot ${key} is moving off ${existing.executor} and its session is not provably gone; keeping the claim for the next hop`);
          return null;
        }
      }
      await releaseSlot(wc.id, slotId);
      const parked = windowBackends.get(key);
      if (parked && parked.parked) return null; // the release was not confirmed
    }

    let attempt = await startSessionOn(wc, slotId, ex);
    if (attempt.error) {
      if (pinned) {
        log(`[backend] slot ${key} is on a machine and no tunnel session could be started; not claiming a local session`);
        return null;
      }
      // The slot named no machine, so this machine is the honest fallback: a
      // window that named no host has no host to fail on, and one that cannot
      // work there can still work here.
      const local = executors.isLocal(ex.id) ? null : executors.get(LOCAL_ID);
      if (!local || !local.capabilities().supervisor) {
        log(`[backend] slot ${key} session failed: ${attempt.error}`);
        return null;
      }
      log(`[backend] slot ${key} could not get a session on ${ex.id} (${attempt.error}); falling back to a local session`);
      attempt = await startSessionOn(wc, slotId, local);
      if (attempt.error) {
        log(`[backend] slot ${key} local session failed: ${attempt.error}`);
        return null;
      }
    }
    if (notify && !wc.isDestroyed()) notifyBase(wc, slotId, attempt.url);
    return attempt.url;
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
  // The QUIT GATE's act, and nothing else. The picker's own Disconnect used to
  // come through here ("every window was on the tunnel the user just dropped"),
  // and that premise died with per-endpoint hops: a session on THIS machine never
  // went through a hop, and a tab on another machine holds a different one — so
  // that disconnect releases only the claims on the hop it stops
  // (releaseTunnelBackends + releaseSlot, ui/main.ts tunnel:disconnect). A window
  // leaving an outage releases its OWN claim instead (releaseWindowBackends,
  // through the `session:release` handler): dropping every window's session
  // because one of them pressed Cancel is how a disconnect in one window used to
  // take the other windows' work down with it.
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
  // count. A hop is a process-wide resource — and, since per-endpoint hops, one
  // of SEVERAL — while the sessions are not: a shell's tunnel-end notification
  // has to name the slots the hop actually owned, or every other tab is told it
  // lost a session that is still running fine (see the `lost` flag the shells
  // compute from this list). This is also what makes the picker's own Disconnect
  // safe to scope by URL (ui/main.ts tunnel:disconnect).
  //
  // `tunnelUrl` (optional): when given, only releases backends whose forward
  // was opened through that tunnel. Slots on a different tunnel are untouched.
  // Omit to release ALL tunnel backends: the shell could not say which hop died
  // (a tunnel end with no URL), so no forward may be left pointing at a port
  // nobody serves any more.
  async function releaseTunnelBackends(tunnelUrl?: string) {
    const affected = [];
    for (const [key, wb] of [...windowBackends]) {
      // a session on THIS machine never went through a hop
      if (!wb.remote) continue;
      // With per-endpoint routing a slot may be on a different tunnel than the one
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

  // A forward that carries no bytes is worse than no forward at all: the claim
  // keeps its URL, so every later claim hands the same dead port back and every
  // request over it ends the same way — undici's bare "fetch failed" in the run
  // loop, an EventSource error in the page, and a user pressing Run or Reconnect
  // into a socket nobody serves. The claim is right about the SESSION (what died
  // is the local half: a hop that bounced, or a session the far host ended under
  // a listener that still accepts connections) — so exactly that half is dropped
  // here, and the claim stays re-bindable.
  //
  // `detach` is the whole of it (sessionClaim): the URL goes with the forward
  // that owned it, the session id and port stay, and the next claim takes the
  // re-bind path (rebindSessionBackend) — the SAME session, re-opened through the
  // live hop, never a second session over the first one's work.
  function dropSlotForward(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    if (!wb || !wb.remote || typeof wb.detach !== "function") return false;
    wb.detach();
    return true;
  }

  // Is any window still working over the tunnel? The tunnel is a shared resource
  // and stopping it is a machine-wide act, so only a caller that is about to
  // release the LAST window on it may stop it (ui/main.js `session:release`).
  // `tunnelUrl` (optional): when given, checks only windows on that tunnel.
  function anyTunnelWindow(tunnelUrl?: string) {
    for (const wb of windowBackends.values()) {
      if (!wb.remote) continue;
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

  // The claims still WORKING through this hop, as {winId, slotId}: the same
  // question anyTunnelWindow answers with a yes, asked so a caller can say whose
  // work it is. The picker's move needs exactly this — "is somebody else riding
  // the hop this window is leaving?" — because closing a hop that still serves a
  // tab is what killed that tab's session (and its run in flight) with "fetch
  // failed" (ui/main.ts tunnel:disconnect keeps the hop instead).
  //
  // Parked claims are absent, for the same reason they are absent above: their
  // release could not be confirmed, nobody is watching the session, and keeping a
  // wire alive for one would make every Disconnect unable to end anything.
  function claimsOnTunnel(tunnelUrl?: string) {
    const out = [];
    if (!tunnelUrl) return out;
    for (const wb of windowBackends.values()) {
      if (!wb.remote || wb.parked) continue;
      if (wb.tunnelUrl && wb.tunnelUrl !== tunnelUrl) continue;
      out.push({ winId: wb.winId, slotId: wb.slotId });
    }
    return out;
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
  // lock is freed by the host that holds it, never by the client. A remote claim
  // means that machine's supervisor (through the base its forward was opened on);
  // a claim here (or no claim yet) means this machine's.
  //
  // `wb.tunnelUrl` records which base the claim was opened through — that is the
  // supervisor to use, not the current default endpoint (which may be a different
  // device entirely).
  function supervisorBaseFor(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    if (wb) {
      if (!wb.remote) return wb.tunnelUrl || executors.base(LOCAL_ID);
      // The claim already knows the base it was opened through; an unrooted
      // claim asks its own endpoint what is serving it now
      return wb.tunnelUrl || executors.base(wb.executor) || null;
    }
    return executors.base(LOCAL_ID);
  }

  // ---- a claim nobody can use ----------------------------------------------
  //
  // "Another window is running this project" is a claim, and a claim is only as
  // good as the window behind it. A window that is GONE — the app killed, a crash,
  // a machine closed mid-turn — leaves a record naming a process that no longer
  // exists, and nothing on the host that holds the lock can tell: the session that
  // took it may run on a far machine (a remote claim), whose reaper refuses a claim
  // it cannot see rather than guess (agent/core/lock_reconcile.py remote_claim).
  // The machine named by the record is the only one that can answer, and this
  // process is on it exactly when the record's claim_host is this hostname.
  //
  // So the answer is asked HERE, of this kernel — identity is (pid, start tick),
  // never a bare pid (procstat.state, the same three verdicts as
  // agent/core/procstat.py) — and a positive "dead" is carried to the host that
  // holds the file as the witness of its reclaim (POST /api/locks/reclaim). The
  // far side then decides: it revokes the holder only when the witness names the
  // very claim its record holds, and it never touches a claim this machine cannot
  // account for.
  //
  // Every answer that is NOT a reclaim is a real one and is reported as such:
  //   "elsewhere" — the claim is another machine's window: only that machine may
  //                 speak for it, and this one must not (it cannot see that
  //                 process table, and guessing is how a live window loses work)
  //   "live"      — the window is still there: this app's own second instance,
  //                 another tab's session. The pill is telling the truth, and no
  //                 button takes a running window's project away
  //   "unknown"   — this host cannot read that process's table (Windows, a kernel
  //                 without /proc): a doubt, and doubt never frees anything
  //   "doubt"     — the question could not be asked at all (no supervisor for the
  //                 slot's machine, a reclaim that errored)
  async function settleClaim(winId, slotId = "", project, owner) {
    const path = typeof project === "string" ? project : "";
    if (!path) return { verdict: "doubt", why: "no project named" };
    const rec = owner && typeof owner === "object" ? owner : null;
    const host = rec && typeof rec.claim_host === "string" ? rec.claim_host : "";
    const pid = rec && Number.isInteger(rec.claim_pid) ? rec.claim_pid : 0;
    if (!host || pid <= 0) {
      return { verdict: "doubt", why: "the claim names no window" };
    }
    if (host !== os.hostname()) {
      return { verdict: "elsewhere", why: `claimed by a window on ${host}` };
    }
    const started = rec && typeof rec.claim_start === "string" ? rec.claim_start : "";
    const holder = procstat.state(pid, started);
    if (holder === "live") {
      return { verdict: "live", why: `process ${pid} on ${host} is still running` };
    }
    if (holder !== "dead") {
      return { verdict: "unknown", why: `this machine cannot tell whether process ${pid} is gone` };
    }
    if (typeof sessions.supervisorReclaimLock !== "function") {
      return { verdict: "doubt", why: "this host has no way to ask for a reclaim" };
    }
    // the host that HOLDS the file: the machine this slot's session runs on (a
    // lock is freed there, never here), reached through the base its claim was
    // opened on
    const base = supervisorBaseFor(winId, slotId);
    if (!base) return { verdict: "doubt", why: "no supervisor to ask about this project's lock" };
    const answer = await sessions.supervisorReclaimLock(base, path, { host, pid, start: started });
    if (!answer || answer.error) {
      return { verdict: "doubt", why: String((answer && answer.error) || "the reclaim answered nothing") };
    }
    const before = answer.before && typeof answer.before === "object" ? answer.before : {};
    if (answer.revoked) return { verdict: "reclaimed", why: String(answer.why || ""), base };
    if (before.held === false) {
      // somebody else freed it between the frame and this call: nothing is held,
      // which is the outcome the caller asked for
      return { verdict: "free", why: String(answer.why || "the lock was already free"), base };
    }
    return { verdict: "kept", why: String(answer.why || "the holder is not a proven orphan"), base };
  }

  // The supervisors this client has to tell when it leaves. Read BEFORE the
  // claims are dropped: a claim's `tunnelUrl` is the only record of the base it
  // was opened through, and releaseAllBackends deletes that record.
  function supervisorBases() {
    // A session may hold claims on several supervisors (one per machine) and all
    // of them need to know the client is leaving.
    const bases = new Set<string>();
    const local = executors.base(LOCAL_ID);
    if (local) bases.add(local);
    for (const wb of windowBackends.values()) {
      if (wb.remote && wb.tunnelUrl) bases.add(wb.tunnelUrl);
    }
    // Also include the endpoint a slot with no claim would land on, so a hop that
    // is up but has not been claimed yet hears it too
    const fallback = executors.base(executors.defaultId());
    if (fallback) bases.add(fallback);
    return [...bases];
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

  // The endpoint a window's session runs on, as an executor id (null when it has
  // not claimed one yet), and whether that endpoint is this machine. The
  // components page needs both: components live on a machine's supervisor, so
  // "install where this window works" means the far side of a hop, and a hop
  // being up is not the same claim — a window that fell back to a session here is
  // working HERE.
  function backendExecutor(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    return wb ? wb.executor : null;
  }

  function backendRemote(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    return !!(wb && wb.remote);
  }

  // What the renderer needs to know about one slot without claiming it: whether
  // a session exists (a page reload re-attaches instead of spawning a second
  // one), which machine it runs on, where it is, and — for a tab that has to
  // remember it across a restart — the machine record itself.
  function slotStatus(winId, slotId = "") {
    const wb = windowBackends.get(slotKey(winId, slotId));
    if (!wb) return { claimed: false, executor: null, remote: false, url: null, target: null };
    return {
      claimed: true,
      executor: wb.executor,
      remote: !!wb.remote,
      url: wb.url || null,
      target: wb.target || null,
    };
  }

  return {
    ensureSlotBackend,
    releaseSlot,
    dropSlotForward,
    releaseWindowBackends,
    releaseAllBackends,
    releaseTunnelBackends,
    stopAllBackends,
    anyTunnelWindow,
    claimsOnTunnel,
    backendExecutor,
    backendRemote,
    slotStatus,
    // how many live claims this host holds (diagnostics and tests)
    backendCount: () => windowBackends.size,
    supervisorBaseFor,
    settleClaim,
    setSlotTarget,
    getSlotTarget,
  };
}

module.exports = { createHostCore, BASE_CHANGED };
