// Hermetic check of the session-claim state machine (ui/host-core.js).
// Everything platform-shaped is faked, so the machine that main.js AND the
// future Android host both run is exercised directly: claim/dedup, remote vs
// local claims, heartbeat self-heal, re-bind over a bounced hop, supersede
// guards, shutdown fan-out.
//
// The "where does it run" half is the REAL executor table (ui/executors.js) over
// a fake hop module and a fake local supervisor — the point of the table is that
// this test does not have to re-implement its decisions, and that host-core sees
// one kind of endpoint either way.
// Run: node tests/host-core.test.js
const assert = require("assert");
const { createHostCore } = require("../ui/host-core");
const { createExecutors, LOCAL_ID } = require("../ui/executors");

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// this machine's supervisor, and the one machine a hop could be open to
const LOCAL_BASE = "http://127.0.0.1:8890";
const FAR = { host: "far.example", user: "me", port: 22 };
const FAR_ID = "me@far.example:22"; // tunnel-core's tunnelId spelling: user@host:port
const FAR_BASE = "http://127.0.0.1:8891";

function fakeSessions() {
  const calls = { started: [], stopped: [], shutdown: [], forwards: [], heartbeats: [], reclaims: [] };
  let seq = 0;
  const beats = [];
  const self = {
    calls,
    beats,
    // what the far supervisor answers to "may this stranded claim be revoked?"
    // (POST /api/locks/reclaim): { revoked, why, before } — scenarios replace it
    reclaimAnswer: null,
    supervisorReclaimLock: async (base, project, witness) => {
      calls.reclaims.push({ base, project, witness });
      if (self.reclaimAnswer) return self.reclaimAnswer(base, project, witness);
      return { revoked: true, why: "revoked", before: { held: true } };
    },
    // what the supervisor answers to "is this session still there?" — the
    // re-claim's first question, in the client's own three states: true (it
    // vouches for the session), false (it says it no longer holds it) and null
    // (the question could not be asked — no route to the supervisor). Scenarios
    // flip it to say the far host really dropped the session instead of just
    // this client's forward to it.
    sessionAlive: true,
    supervisorSessionStart: async (base, ...rest) => {
      calls.started.push({ base, rest });
      return { sessionId: "s" + ++seq, port: 30000 + seq };
    },
    supervisorSessionStop: (base, sid) => calls.stopped.push({ base, sid }),
    supervisorSessionHeartbeat: async (base, sid) => {
      calls.heartbeats.push({ base, sid });
      return self.sessionAlive;
    },
    startSupervisorHeartbeat: (base, sid, onFail) => {
      const h = { base, sid, onFail, stopped: false };
      beats.push(h);
      return { stop: () => (h.stopped = true) };
    },
    supervisorShutdown: (base) => calls.shutdown.push(base),
  };
  return self;
}

function fakeWin(id) {
  return {
    id,
    destroyed: false,
    sent: [],
    isDestroyed() {
      return this.destroyed;
    },
    send(ch, payload) {
      this.sent.push([ch, payload]);
    },
  };
}

// deps factory; each knob is reconfigurable per scenario via .over
//
// `tunnel` is the mutable hop the fake module reports (active/url/target/
// execBridge): scenarios flip it to model a hop that comes back with a new
// forward URL, one that is up but serving nothing, or one that is gone.
//   over.openSessionForward / over.restartRemoteServer  the hop's two verbs
//   over.local        the local supervisor (null = a host with no local mode)
//   over.sessions     the supervisor HTTP client, faked
function makeCore({ tunnel = { active: false, url: null }, over = {} } = {}) {
  const sessions = over.sessions || fakeSessions();
  const state = { wakes: [], logs: [] };
  const log = (...a) => state.logs.push(a.join(" "));

  const hop = {
    tunnelId: FAR_ID,
    lifecycle: {
      tunnelStatus: () => ({
        active: !!tunnel.active,
        url: tunnel.url || null,
        target: tunnel.target === undefined ? FAR : tunnel.target,
        execBridge: tunnel.execBridge,
      }),
      openSessionForward:
        over.openSessionForward ||
        (async (port) => {
          sessions.calls.forwards.push(port);
          return { localPort: port + 1000, close: () => (sessions.calls.forwards.closed = true) };
        }),
      restartRemoteServer: over.restartRemoteServer || (async () => true),
    },
  };
  // the hop module's surface (ui/ssh-tunnel.ts): primaryTunnel / tunnelFor / listTunnels
  const tunnelModule = {
    primaryTunnel: () => hop,
    tunnelFor: (id) => (id === FAR_ID ? hop : null),
    listTunnels: () => (tunnel.active || tunnel.url ? [hop] : []),
  };
  const local =
    over.local === undefined
      ? {
          base: () => LOCAL_BASE,
          wake: async () => {
            state.wakes.push(1);
            return true;
          },
        }
      : over.local;

  const executors =
    over.executors || createExecutors({ tunnel: tunnelModule, local, log });
  const core = createHostCore({ executors, log, sessions });

  // "a session was started on THIS machine": the base the supervisor client was
  // handed is the one and only tell — a local session is an ordinary session on
  // this machine's supervisor, not a second code path
  const localStarts = () => sessions.calls.started.filter((c) => c.base === LOCAL_BASE);
  const localStops = () => sessions.calls.stopped.filter((c) => c.base === LOCAL_BASE);

  return { core, sessions, state, deps: { executors, local, sessions, log }, localStarts, localStops };
}

async function main() {
  // 1. hop active: a remote claim through the tunnel's forwarded supervisor
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: FAR_BASE } });
    const url = await core.ensureSlotBackend(fakeWin(1));
    assert.strictEqual(url, "http://127.0.0.1:31001", "remote claim forwards the session port");
    assert.strictEqual(sessions.calls.started[0].base, FAR_BASE);
    // Nothing about a model travels with the claim: the run's model calls are
    // made in THIS process (ui/llm-client), so the far side is never handed an
    // endpoint, a model name or a knob — and never has one to go stale on.
    assert.deepStrictEqual(
      sessions.calls.started[0].rest,
      [],
      "the claim names the supervisor and nothing else",
    );
    // second ensure: same window reuses its backend, no new session child
    assert.strictEqual(await core.ensureSlotBackend(fakeWin(1)), url, "existing remote backend is reused");
    assert.strictEqual(sessions.calls.started.length, 1);
    assert.strictEqual(core.backendCount(), 1);
  }

  // 2. notify=true pushes backend:base-changed
  {
    const { core, sessions } = makeCore();
    const w = fakeWin(2);
    const url = await core.ensureSlotBackend(w, "", true);
    assert.deepStrictEqual(w.sent, [["backend:base-changed", url]], "local claim notifies");
    assert.strictEqual(url, "http://127.0.0.1:30001",
      "a local session needs no forward: the port it listens on IS the URL");
  }

  // 3. overlapping claims share ONE in-flight session (no double spawn)
  {
    const sessions = fakeSessions();
    const orig = sessions.supervisorSessionStart;
    sessions.supervisorSessionStart = async (...a) => {
      await sleep(40);
      return orig(...a);
    };
    const { core, localStarts } = makeCore({ over: { sessions } });
    const w = fakeWin(3);
    const [a, b] = await Promise.all([core.ensureSlotBackend(w), core.ensureSlotBackend(w)]);
    assert.strictEqual(a, b, "concurrent ensures get the same URL");
    assert.strictEqual(localStarts().length, 1, "one session child for overlapping claims");
  }

  // 4. Android shape: no hop serving and no local mode -> null (renderer shows
  //    "not running"). There is no endpoint at all, which is what the table says
  //    when this build has no supervisor of its own.
  {
    const { core, state } = makeCore({ over: { local: null } });
    const w = fakeWin(4);
    assert.strictEqual(await core.ensureSlotBackend(w), null, "no hop + no local mode -> null");
    assert.strictEqual(core.backendCount(), 0);
    assert(state.logs.some((l) => l.includes("no local mode")), "absence is logged");
  }

  // 5. remote supervisor dead: restartRemoteServer + retry once
  {
    const sessions = fakeSessions();
    let calls = 0;
    const orig = sessions.supervisorSessionStart;
    sessions.supervisorSessionStart = async (...a) => {
      if (++calls === 1) return { error: "boom" };
      return orig(...a);
    };
    let restarts = 0;
    const { core } = makeCore({
      tunnel: { active: true, url: FAR_BASE },
      over: { sessions, restartRemoteServer: async () => ++restarts && true },
    });
    const url = await core.ensureSlotBackend(fakeWin(5));
    assert.strictEqual(restarts, 1, "dead remote supervisor triggers one restart");
    assert.strictEqual(calls, 2, "session start retried after restart");
    assert.ok(url, "retry succeeds");
  }

  // 6. remote heartbeat failure with the session STILL on the far host: the
  //    dead thing is this client's own forward — re-bind the SAME session over
  //    the current hop (stop + start here is what SIGTERMed runs in flight)
  {
    let n = 0;
    const { core, sessions } = makeCore({
      tunnel: { active: true, url: FAR_BASE },
      over: { openSessionForward: async () => ({ localPort: 31000 + ++n, close: () => {} }) },
    });
    const w = fakeWin(6);
    const first = await core.ensureSlotBackend(w);
    sessions.beats[0].onFail(); // supervisor stopped answering
    await tick();
    await tick();
    await tick();
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent, "self-heal pushes base-changed");
    assert.notStrictEqual(sent[1], first, "the pushed URL is the re-opened forward, never the dead one");
    assert.strictEqual(sessions.calls.started.length, 1,
      "the SAME session is kept: no stop + start over work in flight");
    assert.deepStrictEqual(sessions.calls.stopped, [], "and the far-side session is never told to stop");
    assert.deepStrictEqual(sessions.calls.heartbeats, [{ base: FAR_BASE, sid: "s1" }],
      "the re-claim asks the supervisor first: it alone knows the session is still there");
  }

  // 7. supersede guard: a heartbeat from a replaced backend must not fire
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: FAR_BASE } });
    const w = fakeWin(7);
    await core.ensureSlotBackend(w);
    await core.releaseWindowBackends(w.id); // window closed; heartbeat still armed
    sessions.beats[0].onFail();
    await tick();
    await tick();
    assert.strictEqual(core.backendCount(), 0, "superseded heartbeat re-claims nothing");
    assert.strictEqual(sessions.calls.started.length, 1, "no extra session after release");
  }

  // 8. local heartbeat failure: a session HERE is a child of this machine's
  //    supervisor, so there is nothing out there to re-bind — release and claim
  //    again, and tell the window where it landed
  {
    const { core, sessions } = makeCore();
    const w = fakeWin(8);
    const first = await core.ensureSlotBackend(w);
    assert.strictEqual(first, "http://127.0.0.1:30001");
    sessions.beats[0].onFail();
    await tick();
    await tick();
    await tick();
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent && sent[1] !== first, "local self-heal repoints the window");
    assert.strictEqual(sessions.calls.stopped.length, 1, "the dead local session was stopped");
    assert.strictEqual(sessions.calls.started.length, 2, "and exactly one fresh session was claimed");
  }

  // 9. stopAllBackends: stops sessions + closes forwards + shutdown both supervisors
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: FAR_BASE } });
    await core.ensureSlotBackend(fakeWin(9)); // remote backend
    await core.stopAllBackends();
    assert.strictEqual(sessions.calls.forwards.closed, true, "session forward closed");
    assert.deepStrictEqual(
      [...sessions.calls.shutdown].sort(),
      [LOCAL_BASE, FAR_BASE],
      "shutdown reaches the local AND the remote supervisor"
    );
    assert.strictEqual(sessions.calls.stopped.length, 1, "session stop told to the remote supervisor");
    assert.strictEqual(core.backendCount(), 0);
  }

  // 10. Android shutdown: no local supervisor -> only the remote is told
  {
    const { core, sessions } = makeCore({
      tunnel: { active: true, url: FAR_BASE },
      over: { local: { base: () => null, wake: async () => false } },
    });
    await core.ensureSlotBackend(fakeWin(10));
    await core.stopAllBackends();
    assert.deepStrictEqual(sessions.calls.shutdown, [FAR_BASE], "no local shutdown on a local-mode-less host");
  }

  // 11. transient local boot failure: the retried claim is a claim like any
  //     other — it carries a heartbeat too (regression: the retried session used
  //     to heal nobody)
  {
    const sessions = fakeSessions();
    let calls = 0;
    const orig = sessions.supervisorSessionStart;
    sessions.supervisorSessionStart = async (...a) => {
      if (++calls === 1) return { error: "mid-spawn hiccup" };
      return orig(...a);
    };
    const { core, state } = makeCore({ over: { sessions } });
    const w = fakeWin(11);
    assert.strictEqual(await core.ensureSlotBackend(w), "http://127.0.0.1:30001", "one failure then a landed retry");
    assert.strictEqual(calls, 2, "exactly one retry");
    assert.strictEqual(sessions.beats.length, 1, "the retried claim is watched like any other");
    assert.strictEqual(state.wakes.length, 2, "the wake ran before the ask and once as the reboot");
    sessions.beats[0].onFail(); // the retried session's heartbeat dies later
    await tick();
    await tick();
    await tick();
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent, "retry-session self-heal still re-claims and notifies");
    assert.strictEqual(calls, 3, "heal spawned one more session");
  }

  // 12. a hop end drops the window's forward but NOT its claim: the session
  //     is a process on the far host that outlives the hop (a run in flight
  //     must outlive it too), so the returning hop re-opens a forward over the
  //     SAME session — never stop + start over work in flight (the shells call
  //     this from their tunnel-end notification, BEFORE they tell the renderer)
  {
    const ts = { active: true, url: FAR_BASE };
    let closedForwards = 0;
    let n = 0;
    const { core, sessions } = makeCore({
      tunnel: ts,
      over: {
        // the port number can repeat across tunnels: the guard cannot lean on it
        openSessionForward: async () => ({ localPort: 31000 + ++n, close: () => closedForwards++ }),
      },
    });
    const w = fakeWin(12);
    const first = await core.ensureSlotBackend(w);
    assert.deepStrictEqual(await core.releaseTunnelBackends(), [{ winId: 12, slotId: "" }],
      "the end drops the window's forward, and names the slot it dropped");
    assert.strictEqual(closedForwards, 1, "and the forward is closed exactly once: a detach is idempotent");
    assert.strictEqual(core.backendCount(), 1, "the CLAIM survives the hop: it names the far-side process, not the dead forward");
    assert.deepStrictEqual(sessions.calls.stopped, [],
      "the session behind it is not told to stop: its run is in flight and the reaper collects it when idle");
    // the tunnel comes back (a new hop): the claim re-binds over the same session
    ts.url = "http://127.0.0.1:9999";
    const again = await core.ensureSlotBackend(w);
    assert.strictEqual(sessions.calls.started.length, 1, "the returning hop keeps the session child it had");
    assert.deepStrictEqual(sessions.calls.heartbeats, [{ base: "http://127.0.0.1:9999", sid: "s1" }],
      "re-bound only after the supervisor vouched for the session");
    assert.notStrictEqual(again, first, "and the window is handed the re-opened forward, never the dead hop's port");
  }

  // 13. the reuse guard: a forward opened through ANOTHER hop is never handed
  //     back (the notification may race the re-claim that follows it) — what is
  //     handed back is a forward the CURRENT hop opened, over the same session
  {
    const ts = { active: true, url: FAR_BASE };
    const opened = [];
    const { core, sessions } = makeCore({
      tunnel: ts,
      over: {
        openSessionForward: async (port) => {
          opened.push(port);
          return { localPort: 31000 + opened.length, close: () => {} };
        },
      },
    });
    const w = fakeWin(13);
    const first = await core.ensureSlotBackend(w);
    assert.strictEqual(await core.ensureSlotBackend(w), first, "the same hop reuses its forward");
    assert.strictEqual(sessions.calls.started.length, 1, "without spawning a second session");
    ts.url = "http://127.0.0.1:9999"; // a new hop, same window
    const again = await core.ensureSlotBackend(w);
    assert.notStrictEqual(again, first, "a forward from the dead hop is not reused");
    assert.strictEqual(sessions.calls.started.length, 1,
      "and the session is kept across the hop: never stop + start over work in flight");
    assert.strictEqual(opened.length, 2, "the new hop's own forward is the answer");
  }

  // 14. a hop end leaves a LOCAL backend alone: its session never went through
  //     the tunnel (the desktop keeps its local claim; the phone has none)
  {
    const { core, localStarts } = makeCore();
    const w = fakeWin(14);
    const local = await core.ensureSlotBackend(w);
    assert.deepStrictEqual(await core.releaseTunnelBackends(), [], "nothing remote-shaped to drop");
    assert.strictEqual(core.backendCount(), 1, "the local session is still this window's backend");
    assert.strictEqual(await core.ensureSlotBackend(w), local, "and it is still the same URL");
    assert.strictEqual(localStarts().length, 1);
  }

  // 14b. the list is a per-window verdict, not a count: the hop's end names the
  //      windows it owned and no others. That is what the shells turn into
  //      `{ lost }` for each renderer (ui/main.js `tunnel:ended`), and it is the
  //      whole difference between "your session is gone" and "a hop you are not
  //      on went away" — raising the reconnect dialog (and re-dialling a stranger's
  //      host) in a window that was working fine is the reported bug.
  {
    const tunnel = { active: false, url: null };
    const { core } = makeCore({ tunnel });
    const mine = fakeWin(21);
    const theirs = fakeWin(22);
    const localUrl = await core.ensureSlotBackend(mine); // this machine's own session
    tunnel.active = true;
    tunnel.url = FAR_BASE;
    await core.ensureSlotBackend(theirs); // and this window went over the hop
    assert.strictEqual(core.backendCount(), 2, "two windows, two sessions");
    assert.deepStrictEqual(await core.releaseTunnelBackends(), [{ winId: 22, slotId: "" }],
      "the hop names the window it owned — the local one is not in the list");
    assert.strictEqual(core.backendCount(), 2, "and that window's claim outlives its forward");
    assert.strictEqual(core.backendRemote(mine.id), false,
      "the untouched window is still on its own session, unharmed by a hop it never used");
    assert.strictEqual(core.backendExecutor(mine.id), LOCAL_ID, "and the executor it names is this machine");
    assert.strictEqual(core.backendRemote(theirs.id), true, "while the other window's claim is the hop's");
    assert.strictEqual(localUrl, "http://127.0.0.1:30001",
      "and that session is this machine's own, never the hop's forward");
  }

  // 14c. only the LAST window on the tunnel may stop it (anyTunnelWindow, the
  //      `session:release` rule in ui/main.js): releasing one window's claim must
  //      leave the hop up for the windows still on it
  {
    const { core } = makeCore({ tunnel: { active: true, url: FAR_BASE } });
    const a = fakeWin(31);
    const b = fakeWin(32);
    await core.ensureSlotBackend(a);
    await core.ensureSlotBackend(b);
    assert.strictEqual(core.anyTunnelWindow(), true, "two windows are on the hop");
    await core.releaseWindowBackends(a.id);
    assert.strictEqual(core.anyTunnelWindow(), true,
      "one window left, so the tunnel is still somebody's: it must not be stopped");
    assert.strictEqual(core.backendRemote(b.id), true, "and the other window's claim is untouched");
    await core.releaseWindowBackends(b.id);
    assert.strictEqual(core.anyTunnelWindow(), false, "nobody is left on it: now the tunnel may go");
  }

  // 15. heartbeat failure and the session is PROVABLY gone: only then is it
  //     replaced — "re-bind first" answers a stale forward, never a stale guess
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: FAR_BASE } });
    const w = fakeWin(15);
    await core.ensureSlotBackend(w);
    sessions.sessionAlive = false; // the supervisor no longer holds it
    sessions.beats[0].onFail();
    await tick();
    await tick();
    await tick();
    assert.strictEqual(sessions.calls.started.length, 2, "a provably gone session is replaced");
    assert.strictEqual(sessions.calls.started[1].base, FAR_BASE);
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent, "and the window is pointed at the replacement");
  }

  // 16. the re-bind supersede guard: a claim that changed hands while the
  //     question was in flight is not replaced behind the new holder's back
  {
    const ts = { active: true, url: FAR_BASE };
    const sessions = fakeSessions();
    const slow = { ...sessions };
    slow.supervisorSessionHeartbeat = async (base, sid) => {
      await sleep(30);
      return sessions.supervisorSessionHeartbeat(base, sid);
    };
    const { core } = makeCore({ tunnel: ts, over: { sessions: slow } });
    const w = fakeWin(16);
    await core.ensureSlotBackend(w);
    sessions.beats[0].onFail(); // the re-claim puts its question...
    await tick();
    await core.releaseWindowBackends(w.id); // ...and the window goes away mid-ask
    await sleep(60);
    assert.strictEqual(core.backendCount(), 0, "the closed window keeps no claim");
    assert.strictEqual(sessions.calls.started.length, 1, "and no session is spawned for it");
  }

  // 17. the reuse guard keys on the HOP, never the port number: a new hop with
  //     the same local port on offer still re-opens a forward of its own
  {
    const ts = { active: true, url: FAR_BASE };
    const opened = [];
    const { core, sessions } = makeCore({
      tunnel: ts,
      over: {
        openSessionForward: async (port) => {
          opened.push(port);
          return { localPort: 31001, close: () => {} };
        },
      },
    });
    const w = fakeWin(17);
    await core.ensureSlotBackend(w);
    ts.url = "http://127.0.0.1:9999";
    await core.ensureSlotBackend(w);
    assert.deepStrictEqual(opened, [30001, 30001],
      "the dead hop's forward is not reused, even for the same port number: a new one is opened over the same session");
    assert.deepStrictEqual(sessions.calls.heartbeats.map((h) => h.sid), ["s1"], "and the re-open went through the supervisor's answer");
  }

  // 18. hop unreachable is NOT "session gone": the supervisor could not be
  //     asked, so the claim is kept (parked) and the NEXT claim re-binds it.
  //     Replacing it on a guess starts a second session over the first one's
  //     work — the far host then reports "this project is already open in
  //     another window", which is exactly the ssh-drop -> reconnect outage
  {
    const ts = { active: true, url: FAR_BASE };
    let n = 0;
    const { core, sessions } = makeCore({
      tunnel: ts,
      over: { openSessionForward: async () => ({ localPort: 31000 + ++n, close: () => {} }) },
    });
    const w = fakeWin(18);
    await core.ensureSlotBackend(w);
    sessions.sessionAlive = null; // no route to the supervisor (the hop is down)
    sessions.beats[0].onFail();
    await tick();
    await tick();
    await tick();
    assert.strictEqual(core.backendCount(), 1, "an unconfirmed claim is kept, not replaced");
    assert.strictEqual(sessions.calls.started.length, 1, "no second session over the old one's work");
    assert.deepStrictEqual(sessions.calls.stopped, [], "and nothing is told to stop on a guess");
    // the hop returns: the next claim (the reconnect's api:base) re-binds
    ts.url = "http://127.0.0.1:9999";
    sessions.sessionAlive = true;
    const again = await core.ensureSlotBackend(w);
    assert.strictEqual(sessions.calls.started.length, 1, "the returning hop keeps the session child it had");
    assert.deepStrictEqual(
      sessions.calls.heartbeats.map((h) => h.base),
      [FAR_BASE, "http://127.0.0.1:9999"],
      "the re-claim asked the supervisor through the hop that is up now",
    );
    assert.ok(again, "and the window is handed a live forward again");
  }

  // 19. the local fallback never takes over a parked remote claim: while the
  //     far session is not provably gone, a local session is the second window
  //     over its work. "Not running" is state, not advice — wait for the hop
  {
    const ts = { active: true, url: FAR_BASE };
    const { core, sessions, localStarts } = makeCore({ tunnel: ts });
    const w = fakeWin(19);
    await core.ensureSlotBackend(w);
    sessions.sessionAlive = null;
    sessions.beats[0].onFail();
    await tick();
    await tick();
    await tick();
    ts.active = false;
    ts.url = null; // the hop is gone again before any claim ran
    assert.strictEqual(await core.ensureSlotBackend(w), null, "no local session over an unconfirmed far one");
    assert.strictEqual(localStarts().length, 0, "the local fallback did not fire");
    assert.strictEqual(core.backendCount(), 1, "the parked claim still names the far session");
  }

  // 20. the claiming window is named in ONE place — the supervisor client, with
  //     (host, pid, start tick) on every session start, local or tunnelled — so
  //     the state machine hands the claim nothing and cannot get it wrong. That
  //     pid is the HOST process (the Electron main / Android host), never the
  //     renderer behind `wc.getOSProcessId()`: a reload or a crash recovery
  //     replaces the renderer while the app lives, and the session's watchdog
  //     ends a session whose claim pid is gone (agent/core/claim_watch.py), so
  //     naming the renderer would let a routine reload look like "app gone".
  //     What the claim actually carries is asserted in
  //     tests/session-heartbeat-test.js, on the client that builds it.
  {
    const { core, sessions } = makeCore();
    const w = fakeWin(23);
    w.getOSProcessId = () => 4242; // the renderer's pid: NOT something to claim by
    assert.ok(await core.ensureSlotBackend(w), "a window claims as usual");
    assert.deepStrictEqual(sessions.calls.started[0].rest, [],
      "host-core hands the session start nothing: the claim has one author");

    const { core: core2, sessions: sessions2 } = makeCore();
    assert.ok(await core2.ensureSlotBackend(fakeWin(24)), "a handle without getOSProcessId still claims");
    assert.strictEqual(sessions2.calls.started.length, 1,
      "and the claim does not depend on the window handle at all");
  }

  // 21. one window, two SLOTS: each tab claims its own session child, releases
  //     independently, and every notification names the slot it is about —
  //     the whole point of the tab refactor (old windows = old sessions).
  {
    const { core, sessions, localStarts, localStops } = makeCore();
    const w = fakeWin(25);
    const a = await core.ensureSlotBackend(w, "tab-a", true);
    const b = await core.ensureSlotBackend(w, "tab-b", true);
    assert.notStrictEqual(a, b, "two tabs are two sessions");
    assert.strictEqual(localStarts().length, 2, "each claim spawned its own child");
    assert.strictEqual(core.backendCount(), 2, "the window holds both");
    assert.deepStrictEqual(
      w.sent,
      [
        ["backend:base-changed", { slotId: "tab-a", url: a }],
        ["backend:base-changed", { slotId: "tab-b", url: b }],
      ],
      "a named slot's notification names the slot (a bare URL stays the default slot's shape)",
    );
    assert.deepStrictEqual(core.slotStatus(w.id, "tab-a"), {
      claimed: true, executor: LOCAL_ID, remote: false, url: a, target: null,
    }, "a claim on this machine names the reserved local executor and no machine record");
    assert.strictEqual(await core.ensureSlotBackend(w, "tab-a"), a, "re-asking a slot reuses its session");
    assert.strictEqual(localStarts().length, 2, "no second child for the same tab");
    await core.releaseSlot(w.id, "tab-a");
    assert.deepStrictEqual(core.slotStatus(w.id, "tab-a"), {
      claimed: false, executor: null, remote: false, url: null, target: null,
    });
    assert.strictEqual(core.slotStatus(w.id, "tab-b").claimed, true, "the other tab is untouched");
    assert.strictEqual(localStops().length, 1, "only the released tab's child was stopped");
    await core.releaseWindowBackends(w.id);
    assert.strictEqual(core.backendCount(), 0, "closing the window releases the rest");
    assert.strictEqual(localStops().length, 2, "each stop is per session");
  }

  // 22. a slot whose FILE LIVES ON A MACHINE is never served by a local session
  //
  // The reported dead end: a restored remote tab claimed a slot while the hop
  // was not serving it, the host fell back to a local session, and the open
  // answered "not a .clc project file" — a refusal that names neither the
  // machine nor the way back. slots.ts pins the MACHINE for such a tab
  // (prepareTabMachine), and that pin is the host's licence to refuse.
  {
    const { core, state, localStarts } = makeCore(); // no hop at all
    const w = fakeWin(25);
    core.setSlotTarget(w.id, "tab-far", { kind: "executor", target: FAR });
    assert.strictEqual(await core.ensureSlotBackend(w, "tab-far"), null,
      "no hop and a machine's file: no base (the pane then names the machine)");
    assert.strictEqual(localStarts().length, 0, "and no local session was ever started over that path");
    assert.deepStrictEqual(core.slotStatus(w.id, "tab-far"), {
      claimed: false, executor: null, remote: false, url: null, target: null,
    });
    assert(state.logs.some((l) => /slot .*tab-far.* is on a machine .*no local session/.test(l)),
      "the refusal is on the record: " + JSON.stringify(state.logs.filter((l) => /tab-far/.test(l))));
  }

  // 22b. a pin may also name an endpoint by its id (the picker's own answer),
  //      not only by the machine triple a tab remembers
  {
    const { core, localStarts } = makeCore({ tunnel: { active: true, url: FAR_BASE } });
    const w = fakeWin(29);
    core.setSlotTarget(w.id, "tab-here", { kind: "executor", id: LOCAL_ID });
    assert.strictEqual(await core.ensureSlotBackend(w, "tab-here"), "http://127.0.0.1:30001",
      "an id pin claims on exactly that endpoint, whatever the hop is doing");
    assert.strictEqual(localStarts().length, 1);
  }

  // 25b. the hop is up but between forwards (active, no url): same answer
  {
    const { core, localStarts } = makeCore({ tunnel: { active: true, url: null } });
    const w = fakeWin(25);
    core.setSlotTarget(w.id, "tab-far", { kind: "executor", target: FAR });
    assert.strictEqual(await core.ensureSlotBackend(w, "tab-far"), null, "a hop with no URL serves nothing");
    assert.strictEqual(localStarts().length, 0, "and it is still not an invitation to open the far path here");
  }

  // 25c. the hop is up and the FAR supervisor will not start a session: the
  // claim fails, instead of "falling back" onto this machine's filesystem
  {
    const sessions = fakeSessions();
    sessions.supervisorSessionStart = async () => ({ error: "no python on the far side" });
    const { core, state, localStarts } = makeCore({
      tunnel: { active: true, url: FAR_BASE },
      over: { restartRemoteServer: async () => false, sessions },
    });
    const w = fakeWin(25);
    core.setSlotTarget(w.id, "tab-far", { kind: "executor", target: FAR });
    assert.strictEqual(await core.ensureSlotBackend(w, "tab-far"), null, "a far-side failure is the claim's failure");
    assert.strictEqual(localStarts().length, 0, "no local session for a slot whose file is on a machine");
    assert(state.logs.some((l) => /is on a machine and no tunnel session could be started/.test(l)),
      "and the log says which it was: " + JSON.stringify(state.logs.filter((l) => /tab-far/.test(l))));
    assert(!state.logs.some((l) => /falling back to a local session/.test(l)),
      "the old fallback line is not printed for this slot");
  }

  // 25d. control: the SAME window without the pin keeps its local fallback — a
  // tab known to live here must not change behaviour. The default endpoint is
  // "the hop that is serving, else this machine", and this hop serves nothing.
  {
    const { core, localStarts } = makeCore({ tunnel: { active: true, url: null } });
    const w = fakeWin(25);
    const url = await core.ensureSlotBackend(w, "tab-local");
    assert.strictEqual(url, "http://127.0.0.1:30001", "an unpinned slot still falls back to a local session");
    assert.strictEqual(localStarts().length, 1);
  }

  // 23. a release the supervisor did NOT confirm keeps the claim, PARKED
  //
  // The reported defect: a tab that had been open for WRITE came back after a
  // reconnect with "Already open elsewhere — open it read-only?", though the
  // session was that tab's own. The far side is a PROCESS, not a socket: when the
  // release cannot reach it — the usual case, since the hop the release travels
  // over is the very thing that just died — dropping the local record leaves the
  // far session alive and still holding the .clc's flock, and the next claim
  // starts a SECOND session over the first one's project. project_open_conflict,
  // and the page offers read-only. So the claim is parked instead: detached (its
  // forward and heartbeat died with the hop), invisible to anyTunnelWindow — the
  // picker's Disconnect and the outage's Cancel must still be able to end a hop
  // no window is using — and re-bindable by the next claim.
  {
    const ts = { active: true, url: FAR_BASE };
    const { core, sessions, state } = makeCore({ tunnel: ts });
    sessions.supervisorSessionStop = async () => ({ ok: false }); // the release never left this machine
    const w = fakeWin(26);
    const url = await core.ensureSlotBackend(w, "tab-a");
    assert.ok(url, "the tab claims a far-side session");
    assert.strictEqual(core.anyTunnelWindow(ts.url), true, "a live claim holds the hop open");
    await core.releaseSlot(w.id, "tab-a");
    assert.strictEqual(core.backendCount(), 1, "an unconfirmed stop is not a stopped session: the claim is kept");
    assert.strictEqual(core.slotStatus(w.id, "tab-a").url, null, "…detached: it hands out no URL");
    assert.strictEqual(core.anyTunnelWindow(ts.url), false,
      "a parked claim is not a window on the hop: Cancel and Disconnect can still end it");
    assert(state.logs.some((l) => /tab-a.*release was not confirmed; keeping the claim/.test(l)),
      "the parking is on the record: " + JSON.stringify(state.logs.filter((l) => /tab-a/.test(l))));

    // …and the reconnect's claim ADOPTS it: the same far session, one process
    ts.url = "http://127.0.0.1:9999";
    sessions.sessionAlive = true;
    const again = await core.ensureSlotBackend(w, "tab-a");
    assert.ok(again, "the next hop hands the tab a live forward again");
    assert.strictEqual(sessions.calls.started.length, 1,
      "no second session: the far one is re-bound, so nothing is opened twice over the same project");
    assert.deepStrictEqual(sessions.calls.heartbeats.map((h) => h.sid), ["s1"],
      "the re-bind asked the far supervisor about THAT session");
    assert.strictEqual(core.slotStatus(w.id, "tab-a").url, again, "and the slot is claimed on the rebound forward");
  }

  // 26b. a release the supervisor DID confirm drops the claim outright: a
  // parked claim exists only for the doubt, never as a place to hide a stop
  {
    const ts = { active: true, url: FAR_BASE };
    const { core, sessions, state } = makeCore({ tunnel: ts });
    sessions.supervisorSessionStop = async () => ({ ok: true });
    const w = fakeWin(26);
    await core.ensureSlotBackend(w, "tab-a");
    await core.releaseSlot(w.id, "tab-a");
    assert.strictEqual(core.backendCount(), 0, "a confirmed stop is a stopped session");
    assert(!state.logs.some((l) => /release was not confirmed/.test(l)), "and nothing claims otherwise");
  }

  // 26c. the APP is leaving: nothing will ever re-bind, so nothing is parked —
  // a claim kept on the way out is a claim nobody can ask about again
  {
    const ts = { active: true, url: FAR_BASE };
    const { core, sessions } = makeCore({ tunnel: ts });
    sessions.supervisorSessionStop = async () => ({ ok: false });
    const w = fakeWin(26);
    await core.ensureSlotBackend(w, "tab-a");
    await core.releaseSlot(w.id, "tab-a", { leaving: true });
    assert.strictEqual(core.backendCount(), 0, "a quitting app keeps no claim for a hop that will never come");
  }

  // 26d. only a REMOTE claim is parked. A local session's release runs on the
  // same machine as the session, so a stop that reported failure there is not
  // the far-side leak the parking exists for (and a local stop reports nothing)
  {
    const { core, localStops } = makeCore();
    const w = fakeWin(26);
    await core.ensureSlotBackend(w, "tab-a");
    await core.releaseSlot(w.id, "tab-a");
    assert.strictEqual(core.backendCount(), 0, "a local claim goes when its window lets it go");
    assert.strictEqual(localStops().length, 1, "and its session was told to stop");
  }

  // 27. the executor table itself: this machine is a row like any other, and a
  //     slot that names nothing follows the hop that is serving — or this
  //     machine when none is — in ONE place instead of per caller
  {
    const tunnel = { active: false, url: null };
    const { deps } = makeCore({ tunnel });
    const ex = deps.executors;
    assert.strictEqual(ex.defaultId(), LOCAL_ID, "no hop serving: this machine is the default endpoint");
    assert.deepStrictEqual(
      ex.list().map((r) => [r.id, r.remote]),
      [[LOCAL_ID, false]],
      "and the list says so, with its capabilities",
    );
    assert.strictEqual(ex.get(LOCAL_ID).capabilities().supervisor, true, "this machine can hold a session");
    assert.deepStrictEqual(ex.get(LOCAL_ID).forward(4123).then ? "promise" : "value", "promise",
      "a local forward is awaited like any other");
    tunnel.active = true;
    tunnel.url = FAR_BASE;
    assert.strictEqual(ex.defaultId(), FAR_ID, "a serving hop takes the default");
    assert.deepStrictEqual(
      ex.list().map((r) => [r.id, r.remote, r.base]),
      [[LOCAL_ID, false, LOCAL_BASE], [FAR_ID, true, FAR_BASE]],
      "both endpoints are rows: this machine first, then the hop",
    );
    const far = ex.get(FAR_ID);
    assert.deepStrictEqual(far.target(), FAR, "a remote endpoint remembers the machine it is");
    assert.strictEqual(ex.get(LOCAL_ID).target(), null, "and this machine has no machine record to be");
    assert.strictEqual(far.ready && (await far.ready()), true,
      "the far supervisor starts itself: nothing here may wake it");
  }

  // 28. a claim whose window may be gone: settled HERE or not at all. The
  //     record names a process on the machine that claimed it, and only that
  //     machine's kernel can prove it exited — a doubt is never a death, and
  //     only a proven death is carried to the host that HOLDS the lock.
  {
    const os = require("os");
    const procstat = require("../ui/procstat");
    const { spawnSync } = require("child_process");
    const ts = { active: true, url: FAR_BASE };
    const w = fakeWin(28);
    const { core, sessions } = makeCore({ tunnel: ts });
    await core.ensureSlotBackend(w, "tab-a");
    const project = "/work/p.clc";
    assert.strictEqual(core.supervisorBaseFor(w.id, "tab-a"), FAR_BASE,
      "the base a claim was opened through is the host to ask about that project's lock");
    const owner = { claim_host: os.hostname(), claim_pid: 4242, claim_start: "111" };

    // another machine's window: this one cannot see that process table, and a
    // guess here is how a live window loses its work
    const elsewhere = await core.settleClaim(w.id, "tab-a", project, {
      ...owner,
      claim_host: "some-other-machine",
    });
    assert.strictEqual(elsewhere.verdict, "elsewhere");
    assert.strictEqual(sessions.calls.reclaims.length, 0, "and it asks nobody: only that machine may speak");

    // a record naming no window answers nothing at all
    assert.strictEqual((await core.settleClaim(w.id, "tab-a", project, {})).verdict, "doubt");
    assert.strictEqual((await core.settleClaim(w.id, "tab-a", "", owner)).verdict, "doubt");
    assert.strictEqual(sessions.calls.reclaims.length, 0);

    // a window that is STILL THERE is the pill telling the truth: no button takes
    // a running window's project away
    const live = await core.settleClaim(w.id, "tab-a", project, {
      claim_host: os.hostname(),
      claim_pid: process.pid,
      claim_start: procstat.starttime(process.pid),
    });
    assert.strictEqual(live.verdict, "live");
    assert.strictEqual(sessions.calls.reclaims.length, 0, "a live owner is not asked about");

    // …and a pid that is gone IS: the witness names the claim exactly, identity
    // and all, so the far side can refuse it if it is not the same claim
    const gone = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = gone.pid;
    sessions.reclaimAnswer = null;
    const reclaimed = await core.settleClaim(w.id, "tab-a", project, {
      claim_host: os.hostname(),
      claim_pid: deadPid,
      claim_start: "0",
    });
    assert.strictEqual(reclaimed.verdict, "reclaimed");
    assert.strictEqual(sessions.calls.reclaims.length, 1);
    assert.strictEqual(sessions.calls.reclaims[0].base, FAR_BASE, "asked at the host that holds the file");
    assert.strictEqual(sessions.calls.reclaims[0].project, project);
    assert.deepStrictEqual(
      sessions.calls.reclaims[0].witness,
      { host: os.hostname(), pid: deadPid, start: "0" },
      "the witness is the record the claim itself holds",
    );

    // the far side may refuse: "kept" is an answer, not a failure
    sessions.reclaimAnswer = () => ({ revoked: false, why: "not a proven orphan", before: { held: true } });
    assert.strictEqual((await core.settleClaim(w.id, "tab-a", project, owner)).verdict, "kept");
    // …somebody else may have freed it between the frame and this call
    sessions.reclaimAnswer = () => ({ revoked: false, why: "already free", before: { held: false } });
    assert.strictEqual((await core.settleClaim(w.id, "tab-a", project, owner)).verdict, "free");
    // …and the question itself may not land
    sessions.reclaimAnswer = () => ({ error: "no route to the far supervisor" });
    assert.strictEqual((await core.settleClaim(w.id, "tab-a", project, owner)).verdict, "doubt");
    // no supervisor to ask: nothing is invented
    sessions.supervisorReclaimLock = undefined;
    assert.strictEqual((await core.settleClaim(w.id, "tab-a", project, owner)).verdict, "doubt");
  }

  console.log("host-core: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
