"use strict";

// What a far side that never answers the reverse forward must NOT be able to do.
//
// The field report is "it sits on Starting tunnel… forever". The label is the
// tunnel's own `progress("forward")` (js/conn-flow.js: forward → pct 90,
// "Starting tunnel…"), and the thing that used to hang under it was
// `await installReverseForward(client)`: ssh2 answers forwardIn's callback from
// the reply handler and from nowhere else, so a far side that takes the
// `tcpip-forward` global request and never replies leaves that promise pending
// for as long as the client object lives — no error, no close, no clock. Nothing
// else in that phase is unbounded, so the connect parked there for good.
//
// Two releases answered that with a clock (0.1.47) and then by taking the model
// path out of the connect's verdict altogether (0.1.48). This runner pins the
// result on the REAL protocol, because the fact that matters is about the far
// side, not about this repo's code: an ssh2 server that authenticates, runs the
// probe, forwards direct-tcpip — and says nothing at all when asked to listen.
//
//   * the connect settles anyway, and quickly, and the far side is asked ONCE
//     (asking a silent far side again is the same question on the same wire);
//   * silence is not success: no listener is claimed, a session is never
//     pointed at a port nobody serves, and the answer each asker gets is
//     "unavailable" — from the same bounded clock, however many askers there are;
//   * the connect's own verdict is the hop it built (a local forward and a live
//     supervisor behind it), not the model path beside it;
//   * and the field's OTHER shape is told apart from silence: a far side that
//     REFUSES 8892 (the orphaned listener in the field log) is an answer, so the
//     ladder runs, ends by asking the far side for a port of its own, and the
//     connect is still called good on the port it was given.
//
// Run: node tests/tunnel-quiet-forward-test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");

// the tunnel log and the settings mirror live under HOME
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-quiet-"));
process.env.HOME = SCRATCH_HOME;
if (process.platform === "win32") process.env.USERPROFILE = SCRATCH_HOME;
delete process.env.SSH_AUTH_SOCK; // no real agent: the dial is the fake far side's

const { check, summary } = require("./harness");
const { startFakeSshd } = require("./fake-sshd");

// ---- the far-side bootstrap, stubbed at its module seam --------------------
//
// Same seam and same reason as tunnel-reverse-port-test.js: the probe and the
// install are not what this runner is about, and stubbing them here is what
// lets the real forwards run without a real remote shell.
const bootPath = require.resolve("../ui/tunnel-bootstrap");
const bootMod = new Module(bootPath);
bootMod.filename = bootPath;
bootMod.loaded = true;
bootMod.exports = {
  PROBE_CMD: "true",
  parseProbe: () => ({ os: "linux", arch: "x86_64", home: "/home/far", python: "3.11", libc: "glibc" }),
  installServer: async () => ({ ok: true }),
  installComponents: () => {},
};
require.cache[bootPath] = bootMod;

const { connectTunnel, stopTunnel, awaitModelPath, tunnelStatus } = require("../ui/ssh-tunnel");
const { state, remoteLlmBase, LLM_PROXY_REMOTE_PORT } = require("../ui/tunnel-core");

// The clock the code gives ONE unanswered ask, read from the source so this
// runner cannot drift from it (the budgets below are that number plus room).
const connectSrc = fs.readFileSync(path.join(__dirname, "..", "ui", "tunnel-connect.js"), "utf8");
const BIND_TIMEOUT_MS = Number(
  (/REVERSE_FORWARD_BIND_TIMEOUT_MS = (\d+)/.exec(connectSrc) || [])[1]
);
const CONNECT_BUDGET_MS = 8000; // the connect: the hop, not the model path
const SILENT_BUDGET_MS = BIND_TIMEOUT_MS + 6000; // one clock, then done
const LADDER_BUDGET_MS = 20000; // 6 refusals + the ladder's backoff + the port-0 ask

// Where the far host's supervisor is: the local forward dials 127.0.0.1:8890
// through the fake sshd, so the health gate needs something there. On a machine
// that already runs one (the desktop app) it is that; a bare CI box has nothing
// and the hop fails at its own gate — which this runner accepts, as long as the
// failure is that one and not a park.
function supervisorOn8890() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:8890/api/health", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body.includes('"status"')));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => req.destroy());
  });
}

function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ settled: false, ms }), ms);
    promise.then(
      (value) => {
        clearTimeout(t);
        resolve({ settled: true, value });
      },
      (e) => {
        clearTimeout(t);
        resolve({ settled: true, value: "threw: " + ((e && e.message) || e) });
      }
    );
  });
}

function tunnelLogText() {
  try {
    return fs.readFileSync(path.join(SCRATCH_HOME, ".clutch", "tunnel.log"), "utf8");
  } catch (e) {
    return "";
  }
}

// The far side records what it was asked as the packets arrive, so "what did the
// teardown do to the far side's ports" is asked at the far side. Everything the
// client sends is ordered before the FIN on one TCP stream, so once the fake
// sshd has seen the session close, its `events` are complete — the wait is for
// that, never for a duration.
async function closedTo(far, ms = 2000) {
  const t0 = Date.now();
  while (far.connections.size > 0 && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return far.connections.size === 0;
}

async function connectOnce(far) {
  const stages = [];
  const t0 = Date.now();
  const res = await connectTunnel(
    { host: "127.0.0.1", user: "far", port: far.port, password: "e2e-secret" },
    (s) => stages.push(s)
  );
  return { res, stages, ms: Date.now() - t0 };
}

// ---- the three far sides ---------------------------------------------------

async function silentFarSide(hopShouldWork) {
  const far = await startFakeSshd({ forward: "silent" });
  const { res, stages, ms } = await connectOnce(far);

  check(stages.includes("forward"), "quiet: the connect reached the forward stage (the label on screen)");
  check(
    ms < CONNECT_BUDGET_MS,
    `quiet: the connect settled in ${ms}ms with a far side that never answers the reverse forward`
  );
  check(
    far.events.filter((e) => e.startsWith("tcpip-forward")).length === 1,
    "quiet: the far side was asked exactly once (asking it again is the same question on the same wire)"
  );

  // The other half of the same promise: a session must not be pointed at a port
  // nobody serves, and every asker must get that answer from the same clock.
  const asked = await withDeadline(awaitModelPath(), SILENT_BUDGET_MS);
  check(
    asked.settled,
    asked.settled
      ? "quiet: awaitModelPath settled (the claim never parks either)"
      : `quiet: awaitModelPath TIMED OUT after ${SILENT_BUDGET_MS}ms — a claim would park here`
  );
  check(asked.value === "unavailable", `quiet: silence is not success — the model path is ${asked.value}`);
  check(tunnelStatus().modelPath !== "listening", "quiet: no listener is claimed for a far side that said nothing");
  check(
    remoteLlmBase() === `http://127.0.0.1:${LLM_PROXY_REMOTE_PORT}/v1`,
    "quiet: a session would still be pointed at the contract port, never at a port nobody answered for"
  );

  const log = tunnelLogText();
  check(
    /reverse forward unanswered .*not asking for a port of its own/.test(log),
    "quiet: the ladder stopped at the unanswered ask instead of spending another clock"
  );
  check(!/model path listening/.test(log), "quiet: nothing was installed, so nothing is logged as listening");

  // The connect's verdict is the hop it built — a local forward and a live
  // supervisor behind it — and the silent model path beside it is not part of it.
  if (hopShouldWork) {
    check(res.ok === true, "quiet: a silent model path does not fail a hop that is otherwise up");
    check(res.url === state.currentUrl, "quiet: the hop's url is the one the connect reported");
  } else {
    check(
      res.ok === false && /backend not reachable|not a Clutch supervisor/.test(res.error || ""),
      "quiet: with nothing behind the far side's 8890 the hop fails at its own gate: " + (res.error || "")
    );
  }

  await stopTunnel();
  check(await closedTo(far), "quiet: the wire is closed once the teardown is done");
  check(
    !far.events.some((e) => e.startsWith("cancel-tcpip-forward")),
    "quiet: a hop that was never granted a listener has none to hand back (nothing is cancelled)"
  );
  await far.close();
}

async function answeringFarSide() {
  // Control: the same wire, the same question — answered. Silence has to be
  // told apart from a reply, or "the far side said nothing" is just "we never
  // went there".
  const far = await startFakeSshd({ forward: "accept" });
  const { res, stages, ms } = await connectOnce(far);

  check(stages.includes("forward"), "answer: the connect reached the forward stage");
  check(ms < CONNECT_BUDGET_MS, `answer: the connect settled in ${ms}ms`);
  const asked = await withDeadline(awaitModelPath(), SILENT_BUDGET_MS);
  check(asked.settled && asked.value === "listening", `answer: the model path is listening (${asked.value})`);
  check(
    remoteLlmBase() === `http://127.0.0.1:${LLM_PROXY_REMOTE_PORT}/v1`,
    "answer: a session is pointed at the port the far side granted"
  );
  check(res.ok === true, "answer: the hop is up");

  // …and the hop hands its listener back on the way out. An sshd releases a
  // session's tcpip-forward bindings only when it learns the session ENDED, and
  // a client that just closes the socket teaches it nothing until the TCP
  // keepalive does (two hours on a stock sshd) — which is where the field's next
  // hop found its own 8892 held by a listener nobody had ever answered on.
  await stopTunnel();
  check(await closedTo(far), "answer: the wire is closed once the teardown is done");
  const cancels = far.events.filter((e) => e.startsWith("cancel-tcpip-forward"));
  check(
    cancels.length === 1 && cancels[0] === `cancel-tcpip-forward:${LLM_PROXY_REMOTE_PORT}`,
    "answer: the far side is told to release exactly the listener it granted (" + (cancels.join(",") || "none") + ")"
  );
  const grants = far.events.filter((e) => e.startsWith("tcpip-forward"));
  check(
    grants.length === 1 && grants[0] === `tcpip-forward:${LLM_PROXY_REMOTE_PORT}`,
    "answer: …and it is the only listener this hop was ever given (" + grants.join(",") + ")"
  );
  await far.close();
}

async function refusingFarSide() {
  // The field log's shape: 8892 is held on the far host (an orphaned listener
  // from a hop this window no longer owns), so every bind is refused. That is an
  // ANSWER — the ladder may spend its retries, but the connect must still be
  // called good, on a port the far side picks for itself.
  const CHOSEN = 46123;
  const far = await startFakeSshd({ forward: "held", chosenPort: CHOSEN });
  const { res, stages, ms } = await connectOnce(far);

  check(stages.includes("forward"), "held: the connect reached the forward stage");
  check(ms < CONNECT_BUDGET_MS, `held: the connect does not wait for the ladder (${ms}ms)`);

  const asked = await withDeadline(awaitModelPath(), LADDER_BUDGET_MS);
  check(asked.settled, "held: the ladder finished inside its own budget");
  check(asked.value === "listening", `held: a port of the far side's own is the model path (${asked.value})`);
  check(
    remoteLlmBase() === `http://127.0.0.1:${CHOSEN}/v1`,
    "held: a session spawned now is pointed at the port the far side chose"
  );
  check(res.ok === true, "held: a held 8892 is not a failed connect");

  const asks = far.events.filter((e) => e.startsWith("tcpip-forward")).map((e) => e.split(":")[1]);
  check(
    asks.filter((p) => p === String(LLM_PROXY_REMOTE_PORT)).length === 6 && asks.includes("0"),
    `held: the contract port was tried to the end of the ladder, then the far side was asked for its own (${asks.join(",")})`
  );
  const log = tunnelLogText();
  check(/reverse forward on 8892 refused/.test(log), "held: the refusal is logged as a refusal, not as silence");
  check(/chosen by the far side/.test(log), "held: the port that landed is logged as the far side's choice");

  await stopTunnel();
  check(await closedTo(far), "held: the wire is closed once the teardown is done");
  // The listener to hand back is the one this hop was GRANTED (the far side's
  // own pick), never the contract port it was refused: 8892 on that far host is
  // somebody else's listener, and a cancel for a port this client never held
  // would be a request about theirs — exactly the orphan the field log is made
  // of.
  const cancels = far.events.filter((e) => e.startsWith("cancel-tcpip-forward"));
  check(
    cancels.length === 1 && cancels[0] === `cancel-tcpip-forward:${CHOSEN}`,
    "held: the port the far side granted is the one handed back (" + (cancels.join(",") || "none") + ")"
  );
  check(
    !cancels.some((e) => e === `cancel-tcpip-forward:${LLM_PROXY_REMOTE_PORT}`),
    "held: the port it REFUSED is never cancelled (that listener is not this window's)"
  );
  await far.close();
}

async function main() {
  check(BIND_TIMEOUT_MS > 0 && BIND_TIMEOUT_MS < 60000, `read the far side clock from the source: ${BIND_TIMEOUT_MS}ms`);
  const hopShouldWork = await supervisorOn8890();
  console.log(`      (a supervisor answers on 127.0.0.1:8890: ${hopShouldWork} — the hop's own gate)`);

  await silentFarSide(hopShouldWork);
  await answeringFarSide();
  await refusingFarSide();

  summary("tunnel-quiet-forward", "the connect is not held open by the far side's answer");
  process.exit(0);
}

main().catch((e) => {
  console.error("runner failed:", (e && e.stack) || e);
  process.exit(1);
});
