// The engine-side reconnect ladder: the half of an outage that has to outlive
// the page.
//
// The report is "the automatic reconnect waits until I bring the app back to the
// foreground". It does — by design, and in the one half of the app the platform
// freezes. The redial ladder lives in the renderer (ui/js/conn-lost.js):
// connLostArm refuses to arm on a hidden page ("a window nobody is looking at has
// nothing to reconnect FOR yet"), and a hidden page's timers are not running
// anyway, so a hop that dies while the phone is in another app stays dead until
// somebody looks at it. The engine — the process the foreground service protects
// (android/app/src/main/java/io/clutch/mobile/TunnelService.kt) — only ever TOLD
// the page (`tunnel:ended`) and never dialled anything itself.
//
// That split is the whole bug: the policy sat in the frozen half while the
// capability sat in the surviving one. What the surviving half needs is exactly
// what the shops' background downloads have — the entity that outlives the
// screen owns the retry — so this is the SAME ladder, moved to the side that
// survives:
//   * one attempt at a time, on a growing backoff that never gives up;
//   * the credential the engine ALREADY holds, and never a prompt: a prompt in a
//     pocket is not an answer. So a PASSWORD host with nothing cached is left to
//     the page's own dialog, which can ask — and the connect it wins with arms
//     this ladder again — while a host whose winning connect needed no secret
//     (a key, or the agent) is dialled exactly the same way, with none: refusing
//     to redial those because the password cache is empty would leave a key-only
//     host dead for no reason at all.
//   * the exits are the user's own acts: a connect that SUCCEEDED arms it (that
//     is the standing intent), Disconnect and the outage's Cancel disarm it;
//   * and it says so: every change of that intent is published to the shell
//     (onState). The phone needs exactly this one bit — its foreground service
//     keeps the CPU awake only while a tunnel is actually wanted (android-host.js
//     writes the marker, TunnelService.kt polls it) — and this ladder's own
//     stand-downs never pass through a shell call site, so a watcher wired to the
//     call sites alone would leave the CPU pinned for a tunnel nobody is getting.
//
// What it deliberately is not: a second policy. `noteConnected` records an
// intent the engine itself just served, `hopLost` is the same `tunnel:ended` the
// page hears, and the success path calls back into the shell's own claim (`onUp`
// — ui/host-core.js claimWindowBackend → rebindTunnelBackend), because this
// module opens no forward and owns no session: the far-side session outlives
// every hop, and re-binding it correctly is host-core's three-way verdict, not a
// thing to re-invent here.

// the page's own ladder, one for one (ui/js/conn-lost.js CONN_LOST_BACKOFF_MS):
// doubling to a steady 128s, no end of its own. The number that matters is that
// the first attempt is cheap and the last one is not a storm: a phone that comes
// back into signal has to reconnect with nobody touching anything, and a host
// that is down for an hour must not cost an attempt a second.
const DEFAULT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

function createTunnelLadder({
  connect, // (cfg, onProgress) => Promise<{ok, url?|error?}> — the shell's connectTunnel
  status, // () => ({ active, url }) — the shell's tunnelStatus
  secretFor = () => "", // (host, user, port) => the credential already held, "" when none
  onUp = () => {}, // the hop is back: the shell re-claims its windows
  onState = () => {}, // the standing intent changed (armed <-> disarmed): who else cares
  log = () => {},
  delays = DEFAULT_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let intent = null; // {host,user,port} | null — the host the user was on
  let armed = false; // a connect that succeeded armed it; a user exit disarms it
  let timer = null;
  let tries = 0;
  let inFlight = false;
  // did the connect that armed this ladder need a credential? A password host
  // does (and it is in the cache); a key/agent host does not, and must be
  // dialled the same way. Captured at ARM time, from the very connect that won,
  // because that is the only moment we know how this host authenticates.
  let needsSecret = false;
  // the standing intent the shell was last told about ("" = none — the key an
  // unarmed ladder produces). A watcher hears one call per CHANGE, not per call:
  // re-arming the host the user is already on is silent, and a boot with nothing
  // armed says nothing at all.
  let published = "";

  function clearTimerIfAny() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  // what a field report needs to be read without the log: is anything armed,
  // what host, did its winning connect need a credential, how many attempts,
  // is one in flight, is one waiting
  function snapshot() {
    return { intent, armed, needsSecret, tries, inFlight, waiting: Boolean(timer) };
  }

  // Tell the shell the standing intent changed. The phone's foreground service
  // asks the ONE question a background process can be trusted with — "does this
  // user want a tunnel right now?" — and holds the CPU awake only while the
  // answer is yes (android-host.js writes $HOME/tunnel.state, TunnelService.kt
  // polls it). One call per change; a watcher that throws may not break the
  // ladder under it.
  function publish() {
    const key = armed && intent ? `${intent.host}\u0000${intent.user}\u0000${intent.port}` : "";
    if (key === published) return;
    published = key;
    try {
      onState(snapshot());
    } catch (e) {
      log(`[ladder] the state watcher failed: ${(e && e.message) || e}`);
    }
  }

  // nothing to redial: forget the host, the count and the wait — silently. The
  // user's own connect disarms before it dials (so a failed one cannot leave the
  // previous host standing), and whether the shell hears about that is decided
  // by the verdict below, not in here.
  function disarm() {
    intent = null;
    armed = false;
    tries = 0;
    needsSecret = false;
    clearTimerIfAny();
  }

  // the same forgetting, said out loud: the standing intent is GONE and whoever
  // watches has to know — the user left, or a connect that failed left nothing
  // behind, or this ladder stood itself down.
  function standDown() {
    disarm();
    publish();
  }

  function isUp() {
    try {
      const s = status();
      return Boolean(s && s.active);
    } catch (e) {
      return false; // an unanswerable question is not a live hop
    }
  }

  // A connect the user made and won: this is the standing intent the ladder may
  // dial, and it replaces whatever host was there before (the picker has one
  // connection, not a list of them). How that connect authenticated is read from
  // the credential store right here, while the answer is still true: a password
  // (typed and just cached, ssh-tunnel's saveSshSecret) leaves a secret to dial
  // with, a key or the agent leaves none to need.
  function noteConnected({ host, user, port } = {}) {
    clearTimerIfAny();
    tries = 0;
    intent = host && user ? { host, user, port: Number(port) || 22 } : null;
    armed = Boolean(intent);
    needsSecret = Boolean(intent) && Boolean(secretFor(intent.host, intent.user, intent.port));
    if (intent) log(`[ladder] armed for ${intent.user}@${intent.host}:${intent.port}${needsSecret ? "" : " (key or agent: nothing to ask for)"}`);
    publish();
  }

  // The user's own act owns the wire: a connect must not race a background dial,
  // and a connect that fails leaves NO standing intent — the host they were on
  // before is not the host they are asking for now.
  async function userConnect(cfg, onProgress) {
    disarm();
    const res = await connect(cfg, onProgress);
    if (res && res.ok) {
      noteConnected({ host: cfg && cfg.host, user: cfg && cfg.user, port: cfg && cfg.port });
    } else {
      // nothing replaced the intent that the disarm above dropped, and a watcher
      // that was told "armed" before must not be left thinking so
      standDown();
    }
    return res;
  }

  function schedule() {
    if (timer || inFlight || !armed || !intent) return;
    const wait = delays[Math.min(tries, delays.length - 1)];
    timer = setTimer(() => {
      timer = null;
      attempt();
    }, wait);
  }

  async function attempt() {
    if (!armed || !intent || inFlight) return;
    if (isUp()) {
      // somebody else brought it back (the page's own redial, a second window's
      // connect, the picker's retry): dialling a second client over a live hop
      // is how a working tunnel gets reset under its user
      log("[ladder] hop is up already; standing down");
      standDown();
      return;
    }
    const { host, user, port } = intent;
    if (needsSecret && !secretFor(host, user, port)) {
      // the connect that armed this ladder used a password, and there is none
      // left to dial with (forgotten, or the cache went with it). This ladder may
      // not ask for one, and an attempt that cannot authenticate is not a retry —
      // it is an auth failure repeated at every backoff step, which is how a
      // pocketed phone gets its own address banned. The page's dialog owns this
      // host now; it can ask, and whatever connect it wins with arms us again.
      log(`[ladder] the credential for ${user}@${host}:${port} is gone; the page's dialog owns this host`);
      standDown();
      return;
    }
    inFlight = true;
    tries += 1;
    log(`[ladder] attempt ${tries}: ${user}@${host}:${port}`);
    let res = null;
    try {
      res = await connect({ host, user, port });
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    } finally {
      inFlight = false;
    }
    if (res && res.ok) {
      tries = 0;
      log(`[ladder] hop back: ${user}@${host}:${port}`);
      try {
        await onUp();
      } catch (e) {
        log(`[ladder] claim after reconnect failed: ${(e && e.message) || e}`);
      }
      return;
    }
    log(`[ladder] attempt ${tries} failed: ${(res && res.error) || "unknown"}`);
    schedule();
  }

  // The hop died (the shell's tunnel-end notification, the same event the
  // renderer hears as `tunnel:ended`). This is the ONLY thing that ever arms a
  // dial: nothing here dials a host nobody was on in this process life — the
  // page's boot reconciliation already refuses to dial a stale leftover
  // (ui/js/backend-lifecycle.js "nothing here dials it behind their back"), and
  // a background process has even less business doing it.
  function hopLost() {
    if (!armed || !intent) return;
    if (inFlight || timer) return; // one attempt at a time, however many teardowns fire
    log(`[ladder] hop lost; redialing ${intent.user}@${intent.host}:${intent.port}`);
    schedule(); // the first attempt is the first step, not an instant retry at the teardown
  }

  return {
    userConnect,
    noteConnected,
    // Disconnect / the outage's Cancel, and the shell shutting down: the user is
    // done with this host, and something outside may be acting on that (the
    // phone's wake marker, so it must be said, not just done)
    noteUserLeft: standDown,
    stop: standDown,
    hopLost,
    // what a field report needs to be read without the log: is anything armed,
    // what host, did its winning connect need a credential, how many attempts,
    // is one in flight, is one waiting
    state: snapshot,
  };
}

module.exports = { createTunnelLadder, DEFAULT_DELAYS_MS };
