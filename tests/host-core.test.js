// Hermetic check of the session-claim state machine (ui/host-core.js).
// Everything platform-shaped is faked, so the machine that main.js AND the
// future Android host both run is exercised directly: claim/dedup, tunnel
// vs local paths, heartbeat self-heal, supersede guards, shutdown fan-out.
// Run: node tests/host-core.test.js
const assert = require("assert");
const { createHostCore } = require("../ui/host-core");

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSessions() {
  const calls = { started: [], stopped: [], shutdown: [], forwards: [] };
  let seq = 0;
  const beats = [];
  return {
    calls,
    beats,
    supervisorSessionStart: async (base, baseUrl) => {
      calls.started.push({ base, baseUrl });
      return { sessionId: "s" + ++seq, port: 30000 + seq };
    },
    supervisorSessionStop: (base, sid) => calls.stopped.push({ base, sid }),
    startSupervisorHeartbeat: (base, sid, onFail) => {
      const h = { base, sid, onFail, stopped: false };
      beats.push(h);
      return { stop: () => (h.stopped = true) };
    },
    supervisorShutdown: (base) => calls.shutdown.push(base),
  };
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

  // 6. tunnel heartbeat failure: release + re-claim + base-changed with the NEW url
  {
    const { core, sessions } = makeCore({ tunnel: { active: true, url: "http://127.0.0.1:8891" } });
    const w = fakeWin(6);
    const first = await core.ensureWindowBackend(w);
    sessions.beats[0].onFail(); // supervisor stopped answering
    await tick();
    await tick();
    await tick();
    const sent = w.sent.find(([ch]) => ch === "backend:base-changed");
    assert(sent, "self-heal pushes base-changed");
    assert.notStrictEqual(sent[1], first, "the pushed URL is the re-claimed one");
    assert.strictEqual(sessions.calls.started.length, 2, "exactly one re-claim");
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

  console.log("host-core: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
