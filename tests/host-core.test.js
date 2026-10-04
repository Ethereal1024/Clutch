// Hermetic check of the session-claim state machine (ui/host-core.js).
// Everything platform-shaped is faked, so the machine that main.js AND the
// future Android host both run is exercised directly: claim/dedup, tunnel
// vs local paths, heartbeat self-heal, re-bind over a bounced hop, supersede
// guards, shutdown fan-out.
// Run: node tests/host-core.test.js
const assert = require("assert");
const { createHostCore } = require("../ui/host-core");

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSessions() {
  const calls = { started: [], stopped: [], shutdown: [], forwards: [], heartbeats: [] };
  let seq = 0;
  const beats = [];
  const self = {
    calls,
    beats,
    // what the supervisor answers to "is this session still there?" — the
    // re-claim's first question, in the client's own three states: true (it
    // vouches for the session), false (it says it no longer holds it) and null
    // (the question could not be asked — no route to the supervisor). Scenarios
    // flip it to say the far host really dropped the session instead of just
    // this client's forward to it.
    sessionAlive: true,
    supervisorSessionStart: async (base, baseUrl, model, knobs) => {
      calls.started.push({ base, baseUrl, model, knobs });
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
function makeCore({ tunnel = { active: false, url: null }, localSessions = 99, slowLocal = 0, over = {} } = {}) {
  const sessions = fakeSessions();
  const state = { localStarts: [], localStops: [], logs: [] };
  let lseq = 0;
  const deps = {
    supervisorBase: () => "http://127.0.0.1:8890",
    remoteLlmBase: () => "http://127.0.0.1:8892/v1",
    remoteLlmModel: () => "deepseek-v4-flash",
    remoteLlmKnobs: () => ({ reasoning_effort: "max", api_protocol: "responses" }),
    tunnelStatus: () => tunnel,
    restartRemoteServer: async () => true,
    openSessionForward: async (port) => {
      sessions.calls.forwards.push(port);
      return { localPort: port + 1000, close: () => sessions.calls.forwards.closed = true };
    },
    startLocalSession: async (onFail) => {
      if (localSessions-- <= 0) return { mode: "failed", reason: "no local python" };
      if (slowLocal) await sleep(slowLocal);
      state.localStarts.push(onFail);
      return {
        mode: "spawned",
        sessionId: "L" + ++lseq,
        url: `http://127.0.0.1:${40000 + lseq}`,
        stop: () => state.localStops.push(lseq),
      };
    },
    log: (...a) => state.logs.push(a.join(" ")),
    sessions,
  };
  return { core: createHostCore(Object.assign(deps, over)), sessions, state, deps };
}

async function main() {
  // 1. tunnel active: remote claim via the reverse-forward LLM base
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: "http://127.0.0.1:8891" } });
    const url = await core.ensureWindowBackend(fakeWin(1));
    assert.strictEqual(url, "http://127.0.0.1:31001", "tunnel claim forwards the session port");
    assert.strictEqual(sessions.calls.started[0].base, "http://127.0.0.1:8891");
    assert.strictEqual(sessions.calls.started[0].baseUrl, "http://127.0.0.1:8892/v1", "remote sessions point at the reverse forward");
    assert.strictEqual(sessions.calls.started[0].model, "deepseek-v4-flash", "the client model rides along: a remote session cannot read it");
    assert.deepStrictEqual(
      sessions.calls.started[0].knobs,
      { reasoning_effort: "max", api_protocol: "responses" },
      "the two LLM knobs ride with the model: the remote host has neither",
    );
    // second ensure: same window reuses its backend, no new session child
    assert.strictEqual(await core.ensureWindowBackend(fakeWin(1)), url, "existing tunnel backend is reused");
    assert.strictEqual(sessions.calls.started.length, 1);
    assert.strictEqual(core.backendCount(), 1);
  }

  // 2. notify=true pushes backend:base-changed
  {
    const { core } = makeCore();
    const w = fakeWin(2);
    await core.ensureWindowBackend(w, true);
    assert.deepStrictEqual(w.sent, [["backend:base-changed", "http://127.0.0.1:40001"]], "local claim notifies");
  }

  // 3. overlapping claims share ONE in-flight session (no double spawn)
  {
    const { core, state } = makeCore({ slowLocal: 40 });
    const w = fakeWin(3);
    const [a, b] = await Promise.all([core.ensureWindowBackend(w), core.ensureWindowBackend(w)]);
    assert.strictEqual(a, b, "concurrent ensures get the same URL");
    assert.strictEqual(state.localStarts.length, 1, "one session child for overlapping claims");
  }

  // 4. Android shape: tunnel down + no local mode -> null (renderer shows not running)
  {
    const { core, state } = makeCore({ over: { startLocalSession: null } });
    const w = fakeWin(4);
    assert.strictEqual(await core.ensureWindowBackend(w), null, "no tunnel + no local mode -> null");
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
      tunnel: { active: true, url: "http://127.0.0.1:8891" },
      over: { sessions, restartRemoteServer: async () => ++restarts && true },
    });
    const url = await core.ensureWindowBackend(fakeWin(5));
    assert.strictEqual(restarts, 1, "dead remote supervisor triggers one restart");
    assert.strictEqual(calls, 2, "session start retried after restart");
    assert.ok(url, "retry succeeds");
  }

  // 6. tunnel heartbeat failure with the session STILL on the far host: the
  //    dead thing is this client's own forward — re-bind the SAME session over
  //    the current hop (stop + start here is what SIGTERMed runs in flight)
  {
    let n = 0;
    const { core, sessions } = makeCore({
      tunnel: { active: true, url: "http://127.0.0.1:8891" },
      over: { openSessionForward: async () => ({ localPort: 31000 + ++n, close: () => {} }) },
    });
    const w = fakeWin(6);
    const first = await core.ensureWindowBackend(w);
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
    assert.deepStrictEqual(sessions.calls.heartbeats, [{ base: "http://127.0.0.1:8891", sid: "s1" }],
      "the re-claim asks the supervisor first: it alone knows the session is still there");
  }

  // 7. supersede guard: a heartbeat from a replaced backend must not fire
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: "http://127.0.0.1:8891" } });
    const w = fakeWin(7);
    await core.ensureWindowBackend(w);
    await core.releaseWindowBackend(w.id); // window closed; heartbeat still armed
    sessions.beats[0].onFail();
    await tick();
    await tick();
    assert.strictEqual(core.backendCount(), 0, "superseded heartbeat re-claims nothing");
    assert.strictEqual(sessions.calls.started.length, 1, "no extra session after release");
  }

  // 8. local heartbeat failure: re-claim the local session, notify the window
  {
    const { core, state } = makeCore();
    const w = fakeWin(8);
    await core.ensureWindowBackend(w);
    assert.strictEqual(typeof state.localStarts[0], "function", "local session got an onFail hook");
    state.localStarts[0]();
    await tick();
    await tick();
    await tick();
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent && sent[1] !== "http://127.0.0.1:40001", "local self-heal repoints the window");
    assert.strictEqual(state.localStops.length, 1, "the dead local session was stopped");
  }

  // 9. stopAllBackends: stops sessions + closes forwards + shutdown both supervisors
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: "http://127.0.0.1:8891" } });
    await core.ensureWindowBackend(fakeWin(9)); // tunnel backend
    await core.stopAllBackends();
    assert.strictEqual(sessions.calls.forwards.closed, true, "session forward closed");
    assert.deepStrictEqual(
      [...sessions.calls.shutdown].sort(),
      ["http://127.0.0.1:8890", "http://127.0.0.1:8891"],
      "shutdown reaches the local AND the remote supervisor"
    );
    assert.strictEqual(sessions.calls.stopped.length, 1, "session stop told to the remote supervisor");
    assert.strictEqual(core.backendCount(), 0);
  }

  // 10. Android shutdown: supervisorBase()=null -> only the remote is told
  {
    const { core, sessions } = makeCore({
      tunnel: { active: true, url: "http://127.0.0.1:8891" },
      over: { supervisorBase: () => null },
    });
    await core.ensureWindowBackend(fakeWin(10));
    await core.stopAllBackends();
    assert.deepStrictEqual(sessions.calls.shutdown, ["http://127.0.0.1:8891"], "no local shutdown on a local-mode-less host");
  }

  // 11. transient local boot failure: the RETRY session must carry the onFail
  //     hook too (regression: the retried session used to heal nobody)
  {
    let calls = 0;
    const { core, state } = makeCore({
      over: {
        startLocalSession: async (onFail) => {
          state.localStarts.push(onFail);
          if (++calls === 1) return { mode: "failed", reason: "mid-spawn hiccup" };
          return {
            mode: "spawned",
            sessionId: "LR1",
            url: "http://127.0.0.1:41111",
            stop: () => {},
          };
        },
      },
    });
    const w = fakeWin(11);
    assert.strictEqual(await core.ensureWindowBackend(w), "http://127.0.0.1:41111", "one failure then a landed retry");
    assert.strictEqual(calls, 2, "exactly one retry");
    assert.strictEqual(typeof state.localStarts[1], "function", "the retry session got an onFail hook");
    state.localStarts[1](); // the retried session's heartbeat dies later
    await tick();
    await tick();
    await tick();
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent, "retry-session self-heal still re-claims and notifies");
    assert.strictEqual(calls, 3, "heal spawned one more session");
  }

  // 12. a tunnel end drops the window's forward but NOT its claim: the session
  //     is a process on the far host that outlives the hop (a run in flight
  //     must outlive it too), so the returning hop re-opens a forward over the
  //     SAME session — never stop + start over work in flight (the shells call
  //     this from their tunnel-end notification, BEFORE they tell the renderer)
  {
    const ts = { active: true, url: "http://127.0.0.1:8891" };
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
    const first = await core.ensureWindowBackend(w);
    assert.deepStrictEqual(await core.releaseTunnelBackends(), [12],
      "the end drops the window's forward, and names the window it dropped");
    assert.strictEqual(closedForwards, 1, "and the forward is closed exactly once: a detach is idempotent");
    assert.strictEqual(core.backendCount(), 1, "the CLAIM survives the hop: it names the far-side process, not the dead forward");
    assert.deepStrictEqual(sessions.calls.stopped, [],
      "the session behind it is not told to stop: its run is in flight and the reaper collects it when idle");
    // the tunnel comes back (a new hop): the claim re-binds over the same session
    ts.url = "http://127.0.0.1:9999";
    const again = await core.ensureWindowBackend(w);
    assert.strictEqual(sessions.calls.started.length, 1, "the returning hop keeps the session child it had");
    assert.deepStrictEqual(sessions.calls.heartbeats, [{ base: "http://127.0.0.1:9999", sid: "s1" }],
      "re-bound only after the supervisor vouched for the session");
    assert.notStrictEqual(again, first, "and the window is handed the re-opened forward, never the dead hop's port");
  }

  // 13. the reuse guard: a forward opened through ANOTHER hop is never handed
  //     back (the notification may race the re-claim that follows it) — what is
  //     handed back is a forward the CURRENT hop opened, over the same session
  {
    const ts = { active: true, url: "http://127.0.0.1:8891" };
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
    const first = await core.ensureWindowBackend(w);
    assert.strictEqual(await core.ensureWindowBackend(w), first, "the same hop reuses its forward");
    assert.strictEqual(sessions.calls.started.length, 1, "without spawning a second session");
    ts.url = "http://127.0.0.1:9999"; // a new hop, same window
    const again = await core.ensureWindowBackend(w);
    assert.notStrictEqual(again, first, "a forward from the dead hop is not reused");
    assert.strictEqual(sessions.calls.started.length, 1,
      "and the session is kept across the hop: never stop + start over work in flight");
    assert.strictEqual(opened.length, 2, "the new hop's own forward is the answer");
  }

  // 14. a tunnel end leaves a LOCAL backend alone: its session never went through
  //     the tunnel (the desktop keeps its local claim; the phone has none)
  {
    const { core, state } = makeCore();
    const w = fakeWin(14);
    const local = await core.ensureWindowBackend(w);
    assert.deepStrictEqual(await core.releaseTunnelBackends(), [], "nothing tunnel-shaped to drop");
    assert.strictEqual(core.backendCount(), 1, "the local session is still this window's backend");
    assert.strictEqual(await core.ensureWindowBackend(w), local, "and it is still the same URL");
    assert.strictEqual(state.localStarts.length, 1);
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
    const localUrl = await core.ensureWindowBackend(mine); // this machine's own session
    tunnel.active = true;
    tunnel.url = "http://127.0.0.1:8891";
    await core.ensureWindowBackend(theirs); // and this window went over the hop
    assert.strictEqual(core.backendCount(), 2, "two windows, two sessions");
    assert.deepStrictEqual(await core.releaseTunnelBackends(), [22],
      "the hop names the window it owned — the local one is not in the list");
    assert.strictEqual(core.backendCount(), 2, "and that window's claim outlives its forward");
    assert.strictEqual(core.backendKind(mine.id), "local",
      "the untouched window is still on its own session, unharmed by a hop it never used");
    assert.strictEqual(localUrl, "http://127.0.0.1:40001",
      "and that session is this machine's own, never the hop's forward");
  }

  // 14c. only the LAST window on the tunnel may stop it (anyTunnelWindow, the
  //      `session:release` rule in ui/main.js): releasing one window's claim must
  //      leave the hop up for the windows still on it
  {
    const { core } = makeCore({ tunnel: { active: true, url: "http://127.0.0.1:8891" } });
    const a = fakeWin(31);
    const b = fakeWin(32);
    await core.ensureWindowBackend(a);
    await core.ensureWindowBackend(b);
    assert.strictEqual(core.anyTunnelWindow(), true, "two windows are on the hop");
    await core.releaseWindowBackend(a.id);
    assert.strictEqual(core.anyTunnelWindow(), true,
      "one window left, so the tunnel is still somebody's: it must not be stopped");
    assert.strictEqual(core.backendKind(b.id), "tunnel", "and the other window's claim is untouched");
    await core.releaseWindowBackend(b.id);
    assert.strictEqual(core.anyTunnelWindow(), false, "nobody is left on it: now the tunnel may go");
  }

  // 15. heartbeat failure and the session is PROVABLY gone: only then is it
  //     replaced — "re-bind first" answers a stale forward, never a stale guess
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: "http://127.0.0.1:8891" } });
    const w = fakeWin(15);
    await core.ensureWindowBackend(w);
    sessions.sessionAlive = false; // the supervisor no longer holds it
    sessions.beats[0].onFail();
    await tick();
    await tick();
    await tick();
    assert.strictEqual(sessions.calls.started.length, 2, "a provably gone session is replaced");
    assert.strictEqual(sessions.calls.started[1].base, "http://127.0.0.1:8891");
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent, "and the window is pointed at the replacement");
  }

  // 16. the re-bind supersede guard: a claim that changed hands while the
  //     question was in flight is not replaced behind the new holder's back
  {
    const ts = { active: true, url: "http://127.0.0.1:8891" };
    const sessions = fakeSessions();
    const slow = { ...sessions };
    slow.supervisorSessionHeartbeat = async (base, sid) => {
      await sleep(30);
      return sessions.supervisorSessionHeartbeat(base, sid);
    };
    const { core } = makeCore({ tunnel: ts, over: { sessions: slow } });
    const w = fakeWin(16);
    await core.ensureWindowBackend(w);
    sessions.beats[0].onFail(); // the re-claim puts its question...
    await tick();
    await core.releaseWindowBackend(w.id); // ...and the window goes away mid-ask
    await sleep(60);
    assert.strictEqual(core.backendCount(), 0, "the closed window keeps no claim");
    assert.strictEqual(sessions.calls.started.length, 1, "and no session is spawned for it");
  }

  // 17. the reuse guard keys on the HOP, never the port number: a new hop with
  //     the same local port on offer still re-opens a forward of its own
  {
    const ts = { active: true, url: "http://127.0.0.1:8891" };
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
    await core.ensureWindowBackend(w);
    ts.url = "http://127.0.0.1:9999";
    await core.ensureWindowBackend(w);
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
    const ts = { active: true, url: "http://127.0.0.1:8891" };
    let n = 0;
    const { core, sessions } = makeCore({
      tunnel: ts,
      over: { openSessionForward: async () => ({ localPort: 31000 + ++n, close: () => {} }) },
    });
    const w = fakeWin(18);
    await core.ensureWindowBackend(w);
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
    const again = await core.ensureWindowBackend(w);
    assert.strictEqual(sessions.calls.started.length, 1, "the returning hop keeps the session child it had");
    assert.deepStrictEqual(
      sessions.calls.heartbeats.map((h) => h.base),
      ["http://127.0.0.1:8891", "http://127.0.0.1:9999"],
      "the re-claim asked the supervisor through the hop that is up now",
    );
    assert.ok(again, "and the window is handed a live forward again");
  }

  // 19. the local fallback never takes over a parked tunnel claim: while the
  //     far session is not provably gone, a local session is the second window
  //     over its work. "Not running" is state, not advice — wait for the hop
  {
    const ts = { active: true, url: "http://127.0.0.1:8891" };
    const { core, sessions, state } = makeCore({ tunnel: ts });
    const w = fakeWin(19);
    await core.ensureWindowBackend(w);
    sessions.sessionAlive = null;
    sessions.beats[0].onFail();
    await tick();
    await tick();
    await tick();
    ts.active = false;
    ts.url = null; // the hop is gone again before any claim ran
    assert.strictEqual(await core.ensureWindowBackend(w), null, "no local session over an unconfirmed far one");
    assert.strictEqual(state.localStarts.length, 0, "the local fallback did not fire");
    assert.strictEqual(core.backendCount(), 1, "the parked claim still names the far session");
  }

  console.log("host-core: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
