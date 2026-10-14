// The engine-side reconnect ladder (ui/tunnel-ladder.js).
//
// The reported symptom: "the automatic reconnect waits until I bring the app
// back to the foreground". The redial policy lived in the renderer
// (ui/js/conn-lost.js), which the platform freezes in the background, while the
// capability lived in the FGS-held engine — so a hop that died in a pocket
// stayed dead until the page ran again. The fix moves the ladder to the side
// that survives, and this runner pins the rules that keep it from becoming a
// second, rogue policy:
//   * nothing dials before a connect the user made and WON (no boot-time dial);
//   * a successful connect arms, a user exit (Disconnect / the outage's Cancel)
//     disarms — those are the only exits;
//   * one attempt at a time, on the page's own doubling backoff, capped;
//   * the credential the engine ALREADY holds, and never a prompt: a password
//     host with nothing cached is handed back to the page, which can ask, while
//     a host whose winning connect needed no secret (a key, the agent) is
//     dialled the same way, with none;
//   * a hop that is already up is left alone (never reset a working tunnel);
//   * on success the shell is told to re-claim (onUp), the far session outliving
//     every hop;
//   * every change of the standing intent is published to the shell (onState):
//     the phone's foreground service keeps the CPU awake on exactly that bit
//     (M4 — android-host.js writes $HOME/tunnel.state) and the ladder's own
//     stand-downs pass through no call site in either shell.
//
// The clock is injected: every wait is driven by hand, so the runner cannot
// become a timing test.
//
// Run: node tests/tunnel-ladder-test.js

"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness");

const { createTunnelLadder, DEFAULT_DELAYS_MS } = require("../ui/tunnel-ladder");
const ROOT = path.join(__dirname, "..");

// -- a clock nobody else can advance: setTimer records, and the runner decides
//    when a wait is over. `advance()` runs the earliest pending timer.
function fakeClock() {
  let seq = 0;
  let now = 0;
  const pending = new Map(); // id -> { fn, at }
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    size() {
      return pending.size;
    },
    // the delay of the single pending timer (the ladder holds at most one)
    nextDelay() {
      const t = [...pending.values()][0];
      return t ? t.at - now : null;
    },
    async advance() {
      let bestId = null;
      let bestAt = Infinity;
      for (const [id, t] of pending) if (t.at < bestAt) ((bestAt = t.at), (bestId = id));
      if (bestId === null) return false;
      const t = pending.get(bestId);
      pending.delete(bestId);
      now = t.at;
      await t.fn();
      return true;
    },
  };
}

// -- the shell's connect, driven by whatever `handler` currently is: each call
//    is recorded so a test can say HOW MANY dials happened, not just the last.
function harness({ secret = "s3cret", active = false, watch = null } = {}) {
  const calls = [];
  let handler = async () => ({ ok: true });
  let up = { active };
  let secretValue = () => secret;
  const ups = [];
  const logs = [];
  const states = []; // every published standing-intent change, in order
  const clock = fakeClock();
  const ladder = createTunnelLadder({
    connect: (cfg, onProgress) => {
      calls.push(cfg);
      return handler(cfg, onProgress);
    },
    status: () => up,
    secretFor: (host, user, port) => secretValue(`${host}|${user}|${port}`),
    onUp: async () => {
      ups.push(true);
    },
    onState: (s) => {
      states.push(s);
      if (watch) watch(s);
    },
    log: (m) => logs.push(m),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    ladder,
    clock,
    calls,
    ups,
    logs,
    states,
    // the fake shell's own state: a live hop, the cached secret, next verdict
    setUp: (v) => (up = v),
    setSecret: (v) => (secretValue = () => v),
    setHandler: (h) => (handler = h),
    ok: () => async () => ({ ok: true }),
    fail: (err) => async () => ({ ok: false, error: err || "boom" }),
  };
}

// one arm: a connect the user made and won
async function arm(h, cfg = { host: "far", user: "me", port: 2222 }) {
  h.setHandler(h.ok());
  await h.ladder.userConnect(cfg);
}

async function main() {
  // ---- the backoff IS the page's own ladder, one for one ----
  //
  // Read out of the renderer, not copied: if either side's numbers move the
  // other must move with them, or a hop that dies on the phone reconnects on a
  // rhythm the dialog tells the user to expect and nothing else does.
  const connLost = fs.readFileSync(path.join(ROOT, "ui", "js", "conn-lost.js"), "utf8");
  const m = connLost.match(/CONN_LOST_BACKOFF_MS\s*=\s*\[([^\]]+)\]/);
  const pageDelays = m ? m[1].split(",").map((s) => Number(s.trim())) : null;
  check(
    JSON.stringify(pageDelays) === JSON.stringify(DEFAULT_DELAYS_MS),
    "the engine's ladder is the page's own backoff, number for number"
  );
  check(
    DEFAULT_DELAYS_MS[0] === 1000 && DEFAULT_DELAYS_MS[DEFAULT_DELAYS_MS.length - 1] === 128000,
    "it starts cheap (1s) and ends steady (128s), never a storm"
  );

  // ---- 1. nothing dials before a connect the user WON ----
  //
  // The page's boot reconciliation refuses to dial a stale leftover ("nothing
  // here dials it behind their back"), and a background process has even less
  // business: a hop loss with no standing intent is a notification, not a dial.
  {
    const h = harness();
    h.ladder.hopLost();
    check(h.calls.length === 0 && h.clock.size() === 0, "hop lost with no standing intent: nothing is dialled");
    check(h.ladder.state().armed === false, "…and nothing is armed");
  }

  // ---- 2. a successful connect arms; hop loss then redials on the first step ----
  {
    const h = harness();
    await arm(h);
    let st = h.ladder.state();
    check(st.armed === true && st.intent && st.intent.host === "far" && st.intent.user === "me" && st.intent.port === 2222,
      "a connect that succeeded is the standing intent the ladder may dial");

    h.ladder.hopLost();
    check(h.clock.size() === 1, "the hop dying arms exactly one pending attempt");
    check(h.clock.nextDelay() === DEFAULT_DELAYS_MS[0], "the first attempt is the first step of the backoff, not an instant retry");
    check(h.calls.length === 1, "…and nothing is dialled until that step elapses");

    await h.clock.advance();
    check(h.calls.length === 2, "the wait elapsing makes the attempt");
    check(h.calls[1].host === "far" && h.calls[1].user === "me" && h.calls[1].port === 2222,
      "…to the same host, user and port the user was on");
    check(h.ups.length === 1, "a hop that comes back tells the shell to re-claim its windows");
    check(h.clock.size() === 0, "and a recovered hop waits on nothing");
    check(h.ladder.state().armed === true && h.ladder.state().tries === 0,
      "…while the standing intent stays armed for the next outage");
  }

  // ---- 3. one attempt at a time: the backoff doubles, then holds ----
  {
    const h = harness();
    await arm(h);
    h.setHandler(h.fail("no route"));
    h.ladder.hopLost();
    const wanted = DEFAULT_DELAYS_MS;
    for (let i = 0; i < wanted.length + 2; i++) {
      const expected = wanted[Math.min(i, wanted.length - 1)];
      check(h.clock.size() === 1 && h.clock.nextDelay() === expected,
        `attempt ${i + 1} waits ${expected}ms (never two at once, never past the cap)`);
      await h.clock.advance();
    }
    check(h.calls.length === 1 + (wanted.length + 2),
      "a host down for good keeps being retried, once per step, with nobody touching the phone");
    check(h.ups.length === 0, "…and never claims a hop that did not come back");
    check(h.ladder.state().armed === true, "…and never gives up on its own");
  }

  // ---- 4. many teardowns, one timer ----
  //
  // `tunnel:ended` can fire per window/hop while a redial is already parked;
  // each one must not add a second dial.
  {
    const h = harness();
    await arm(h);
    h.setHandler(h.fail());
    h.ladder.hopLost();
    h.ladder.hopLost();
    h.ladder.hopLost();
    check(h.clock.size() === 1, "repeated hop-loss notifications arm one attempt, not one each");
  }

  // ---- 5. the user's own act owns the wire ----
  //
  // Disconnect and the outage's Cancel (a release with no window left) are the
  // two ways out: whatever was waiting is cancelled with them.
  for (const exit of ["noteUserLeft", "stop"]) {
    const h = harness();
    await arm(h);
    h.setHandler(h.fail());
    h.ladder.hopLost();
    check(h.clock.size() === 1, `${exit}: an outage is waiting to redial`);
    h.ladder[exit]();
    check(h.clock.size() === 0, `${exit}: the pending attempt is cancelled`);
    const st = h.ladder.state();
    check(st.armed === false && st.intent === null, `${exit}: nothing is left to dial this host`);
    h.ladder.hopLost();
    check(h.calls.length === 1 && h.clock.size() === 0, `${exit}: a later hop loss dials nothing (the user is done with it)`);
  }

  // ---- 6. a connect races nothing, and a FAILED one forgets the old host ----
  {
    const h = harness();
    await arm(h, { host: "old", user: "me", port: 22 });
    // the user asks for a different host and it fails: the host they were on
    // before is not the host they are asking for now
    h.setHandler(h.fail("auth refused"));
    const res = await h.ladder.userConnect({ host: "new", user: "me", port: 2222 });
    check(res && res.ok === false, "the failed connect's verdict reaches the caller unchanged");
    const st = h.ladder.state();
    check(st.armed === false && st.intent === null, "a connect that failed leaves NO standing intent");
    h.ladder.hopLost();
    check(h.calls.length === 2 && h.clock.size() === 0, "…so the previous host is not redialled behind the failure");
  }
  {
    // a connect that WINS while a redial was waiting cancels the wait: the
    // user's own dial owns the wire, and the ladder re-arms on its verdict
    const h = harness();
    await arm(h);
    h.setHandler(h.fail());
    h.ladder.hopLost();
    check(h.clock.size() === 1, "a redial is waiting");
    h.setHandler(h.ok());
    await h.ladder.userConnect({ host: "picked", user: "me", port: 2200 });
    check(h.clock.size() === 0, "the user's own connect cancels the parked redial");
    check(h.ladder.state().intent.host === "picked", "…and becomes the new standing intent");
  }

  // ---- 7. the credential the engine holds, and never an auth failure in a loop ----
  //
  // A prompt in a pocket is not an answer: with the password gone the ladder may
  // not dial at all — it hands the host back to the page, whose dialog can ask,
  // and whatever connect that wins arms this ladder again.
  {
    const h = harness();
    await arm(h);
    check(h.ladder.state().needsSecret === true, "a connect that used the cached password says so when it arms");
    h.setSecret("");
    h.ladder.hopLost();
    await h.clock.advance();
    check(h.calls.length === 1, "with that credential gone the ladder does not dial");
    const st = h.ladder.state();
    check(st.armed === false && st.intent === null && h.clock.size() === 0,
      "…it stands down and leaves the host to the page's dialog");
  }

  // ---- 7b. a host that authenticated with a KEY needs no secret at all ----
  //
  // The connect that armed the ladder held no secret (a key, or the agent did
  // the work), so the redial is the same connect, with none. Standing down here
  // because the password cache is empty would leave every key-only host dead for
  // no reason at all — and a key-only host is exactly what a server with
  // PasswordAuthentication off serves.
  {
    const h = harness({ secret: "" });
    await arm(h);
    check(h.ladder.state().needsSecret === false, "a winning connect that held no secret arms a key-only intent");
    h.ladder.hopLost();
    await h.clock.advance();
    check(h.calls.length === 2, "…and that intent is dialled with no secret at all");
    check(h.ups.length === 1, "…so the hop comes back with nobody touching the phone");
  }

  // ---- 8. never reset a working tunnel ----
  //
  // The page's own redial, a second window's connect or the picker's retry may
  // have brought the hop back between the loss and our step: dialling a second
  // client over a live hop is how a working tunnel gets reset under its user.
  {
    const h = harness();
    await arm(h);
    h.setUp({ active: true, url: "http://127.0.0.1:9000" });
    h.ladder.hopLost();
    await h.clock.advance();
    check(h.calls.length === 1, "a hop that is already up is not dialled again");
    const st = h.ladder.state();
    check(st.armed === false && st.tries === 0 && h.clock.size() === 0, "…the ladder stands down instead");
  }
  {
    // an unanswerable status is not a live hop: the attempt still runs
    const h = harness();
    await arm(h);
    h.setUp(null);
    h.ladder.hopLost();
    await h.clock.advance();
    check(h.calls.length === 2, "a status nobody can answer does not stop the redial");
  }

  // ---- 9. a connect that throws is a failed attempt, not a broken ladder ----
  {
    const h = harness();
    await arm(h);
    h.setHandler(async () => {
      throw new Error("socket hang up");
    });
    h.ladder.hopLost();
    await h.clock.advance();
    check(h.clock.size() === 1 && h.clock.nextDelay() === DEFAULT_DELAYS_MS[1],
      "a connect that throws is retried on the next backoff step");
    check(h.ladder.state().armed === true, "…and the ladder survives it");
  }

  // ---- 10. the intent a noteConnected records is normalised ----
  {
    const h = harness();
    h.ladder.noteConnected({ host: "far", user: "me" }); // no port: the ssh default
    const st = h.ladder.state();
    check(st.armed === true && st.intent.port === 22, "a connect with no port records the ssh default (22)");
    h.ladder.noteConnected({ host: "", user: "me" });
    check(h.ladder.state().armed === false, "a host with no address is not an intent");
  }

  // ---- 11. whoever watches is told every change of the standing intent ----
  //
  // One bit leaves this module: is a tunnel wanted right now. The phone's
  // foreground service decides whether to keep the CPU awake from exactly that
  // (TunnelService.kt), and its input is written here (tunnel.state) — so a
  // watcher that misses a disarm pins the CPU for a tunnel nobody wants, and one
  // that misses an arm is the original bug: the redial timer never fires because
  // the processor is asleep.
  {
    const h = harness();
    check(h.states.length === 0, "a ladder that has done nothing says nothing: boot is not an intent");
    await arm(h);
    check(h.states.length === 1 && h.states[0].armed === true && h.states[0].intent.host === "far",
      "the connect that arms it tells the watcher the standing intent");
    h.ladder.noteConnected({ host: "far", user: "me", port: 2222 });
    check(h.states.length === 1, "…and re-arming the SAME host is not a second change");
    h.ladder.noteUserLeft();
    check(h.states.length === 2 && h.states[1].armed === false && h.states[1].intent === null,
      "the user leaving tells it the intent is gone");
    h.ladder.noteUserLeft();
    check(h.states.length === 2, "…and leaving twice is not a second change");
  }
  // the two stand-downs no shell call site ever sees: the watcher HAS to be on
  // the ladder itself, or the phone holds a wake lock the ladder has already
  // given up on (and the far side gets auth failures at every backoff step)
  {
    const h = harness();
    await arm(h);
    h.setSecret("");
    h.ladder.hopLost();
    await h.clock.advance();
    check(h.states.length === 2 && h.states[1].armed === false,
      "standing down because the credential is gone is a change the watcher hears");
  }
  {
    const h = harness();
    await arm(h);
    h.setUp({ active: true });
    h.ladder.hopLost();
    await h.clock.advance();
    check(h.states.length === 2 && h.states[1].armed === false,
      "…and so is standing down because somebody else brought the hop back");
  }
  {
    // a connect that FAILED drops the previous intent without a noteConnected:
    // the watcher must not be left holding onto a host that is no longer asked for
    const h = harness();
    await arm(h, { host: "old", user: "me", port: 22 });
    h.setHandler(h.fail("auth refused"));
    await h.ladder.userConnect({ host: "new", user: "me", port: 2222 });
    check(h.states.length === 2 && h.states[1].armed === false,
      "…and a connect that failed says the old intent is gone");
  }
  {
    const h = harness({ watch: () => { throw new Error("read-only home"); } });
    await arm(h);
    h.ladder.hopLost();
    check(h.ladder.state().armed === true && h.clock.size() === 1,
      "a watcher that throws does not break the ladder it watches");
  }

  // ---- 12. both shells put the ladder on every seam it needs ----
  //
  // The module is only half the fix; the other half is that the two shells route
  // their tunnel seams through it. Both are read as text, because the wiring IS
  // the change — a ladder nothing calls is the bug, in a new file.
  {
    const host = fs.readFileSync(path.join(ROOT, "android", "host", "android-host.js"), "utf8");
    const main = fs.readFileSync(path.join(ROOT, "ui", "main.js"), "utf8");

    for (const [what, src, connectCall] of [
      ["the phone's host", host, "connect: (cfg, onProgress) => tunnel.connectTunnel(cfg, onProgress)"],
      ["the desktop shell", main, "connect: (cfg, onProgress) => tunnel.connectTunnel(cfg, onProgress)"],
    ]) {
      check(src.includes('require("./tunnel-ladder")') || src.includes('useUI("tunnel-ladder.js")'),
        `${what} loads the ladder`);
      check(src.includes("createTunnelLadder({") && src.includes(connectCall),
        `${what} builds the ladder over its own connectTunnel`);
      check(/secretFor: \(host, user, port\) => getSshSecret\(host, user, port\)/.test(src) &&
        src.includes("getSshSecret"),
        `${what} feeds it the same credential cache connectTunnel reads`);
      check(/ladder\.userConnect\(/.test(src), `${what} routes the user's own connect through the ladder`);
      check(/ladder\.noteUserLeft\(\)/.test(src),
        `${what} disarms on the user's own exit (Disconnect and the outage's Cancel)`);
      // the order is the contract: the dead forwards go first, the redial is
      // armed second, the page is told last — a redial that raced the release
      // would open its forward against the hop it just lost
      check(/releaseTunnelBackends\(\);[\s\S]{0,600}ladder\.hopLost\(\);[\s\S]{0,400}tunnel:ended/.test(src),
        `${what} arms the redial on the hop's own end — after the release, before the page hears about it`);
    }

    check(/onUp:[\s\S]{0,300}hostCore\.ensureWindowBackend\(window, true\)/.test(host),
      "the phone's ladder re-claims its one window through host-core's own verdict");
    check(/onUp:[\s\S]{0,400}hostCore\.ensureWindowBackend\(w\.webContents, true\)/.test(main),
      "the desktop's ladder re-claims each window the hop owned, through the same verdict");

    // the wake marker (M4): the phone's foreground service polls $HOME/tunnel.state
    // and keeps the CPU awake on it — so its writer must hang off the LADDER's own
    // state changes (the stand-downs inside the ladder reach no call site), and a
    // boot must not inherit a previous life's "up"
    check(/createTunnelLadder\(\{[\s\S]{0,1200}onState:/.test(host),
      "the phone's host subscribes to the ladder's state changes");
    check(host.includes('"tunnel.state"') && /armed \? "up" : "down"/.test(host),
      "…and writes the up/down marker the foreground service polls (armed = up)");
    check(/unlinkSync\(path\.join\(os\.homedir\(\), "tunnel\.state"\)\)/.test(host),
      "…and clears a stale marker at boot: last life's intent is not this life's");
    check(!/onState/.test(main),
      "the desktop has no foreground service to feed: it writes no marker for one");
  }

  summary("tunnel-ladder", "the reconnect ladder survives the page freeze it was moved out of");
}

main();
