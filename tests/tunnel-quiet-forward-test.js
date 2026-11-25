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
// Two releases answered that with a clock (0.1.47) and then by taking the ask out
// of the connect altogether (0.1.48); since 甲-P1 there is no model path to
// install either — the reverse forward belongs to the plugin channel and is asked
// for on the first claim. This runner pins the result on the REAL protocol,
// because the fact that matters is about the far side, not about this repo's
// code: an ssh2 server that authenticates, runs the probe, forwards direct-tcpip
// — and says nothing at all when asked to listen.
//
//   * the connect ASKS FOR NOTHING: no tcpip-forward global request leaves a hop
//     whose job is the hop (what a channel asks for is the channel runner's);
//   * the hop's own forward is where the connect's verdict comes from, and the
//     fake far side records the direct-tcpip it was asked for — so "nothing was
//     asked" can be told apart from "the wire was never used";
//   * a far side that never answers therefore cannot park anything, and a hop
//     that was granted no listener has none to hand back (nothing is cancelled);
//   * and the field's OTHER shape is told apart from silence: a far side that is
//     up, reports SERVING, and still will not carry a forwarded channel is a
//     verdict about the WIRE, not about the server.
//
// The reverse-forward asks themselves — the contract port, port 0, the ladder,
// and "silence ends the install on its own clock" — are
// tests/tunnel-reverse-channel-test.js.
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
// Same seam and same reason as tests/tunnel-reverse-channel-test.js: the probe and the
// install are not what this runner is about, and stubbing them here is what
// lets the real forwards run without a real remote shell.
const bootPath = require.resolve("../ui/tunnel-bootstrap");
const bootMod = new Module(bootPath);
bootMod.filename = bootPath;
bootMod.loaded = true;
// what the far side answers when the connect's health gate asks it about its OWN
// port over exec (tunnel-connect's failed-gate verdict). "" is "the stub has no
// answer", which is the shape every scenario but `noForwardingFarSide` wants: the
// verdict then falls back to the plain sentence.
let farReports = "";
bootMod.exports = {
  PROBE_CMD: "true",
  parseProbe: () => ({ os: "linux", arch: "x86_64", home: "/home/far", python: "3.11", libc: "glibc" }),
  installServer: async () => ({ ok: true }),
  installComponents: () => {},
  remoteServingState: async () => farReports,
};
// the part a bound instance is given (see ssh-tunnel's bind): a hop module no
// longer requires its neighbours, so the fake has to be attachable too — and it
// hands back the SAME object, so `farReports` stays live per scenario
bootMod.exports.attach = () => bootMod.exports;
require.cache[bootPath] = bootMod;

const { connectTunnel, stopTunnel } = require("../ui/ssh-tunnel");
const { state } = require("../ui/tunnel-core");

const CONNECT_BUDGET_MS = 8000; // the connect: the hop, and nothing else
// The health gate's own clock (CONNECT_TIMEOUT_MS) plus the far-side ask it makes
// after it fails: a hop that cannot be forwarded has to be waited out once.
const NO_FORWARD_BUDGET_MS = 22000;

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

// ---- the far sides ---------------------------------------------------------

async function silentFarSide(hopShouldWork) {
  const far = await startFakeSshd({ forward: "silent" });
  const { res, stages, ms } = await connectOnce(far);

  check(stages.includes("forward"), "quiet: the connect reached the forward stage (the label on screen)");
  check(
    ms < CONNECT_BUDGET_MS,
    `quiet: the connect settled in ${ms}ms with a far side that never answers the reverse forward`
  );

  // The whole promise in one assertion: a hop asks for no reverse forward, so a
  // far side that would not answer the question is never asked it. The control
  // beside it matters — the wire WAS used (the hop's own forward dialled the far
  // side's service), so "no tcpip-forward" is "we did not ask", not "we never got
  // that far".
  const asks = far.events.filter((e) => e.startsWith("tcpip-forward"));
  check(
    asks.length === 0,
    `quiet: the connect asked the far side for NO reverse forward at all (${asks.join(",") || "none"})`
  );
  check(
    far.events.some((e) => e.startsWith("direct-tcpip:")),
    "quiet: …while the hop's own forward did go out (the wire carried the connect)"
  );

  const log = tunnelLogText();
  check(!/reverse forward/.test(log), "quiet: the connect's log has no reverse-forward step in it at all");

  // The connect's verdict is the hop it built — a local forward and a live
  // supervisor behind it — and nothing beside it.
  if (hopShouldWork) {
    check(res.ok === true, "quiet: the hop is up");
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
    "quiet: a hop that was granted no listener has none to hand back (nothing is cancelled)"
  );
  await far.close();
}

async function answeringFarSide() {
  // Control: the same wire, the same hop — with a far side that would answer. It
  // is still not asked, because the connect has no question to ask it. That is
  // the difference between "the far side was silent" and "the far side was
  // never asked", and only this pair can tell them apart.
  const far = await startFakeSshd({ forward: "accept" });
  const { res, stages, ms } = await connectOnce(far);

  check(stages.includes("forward"), "answer: the connect reached the forward stage");
  check(ms < CONNECT_BUDGET_MS, `answer: the connect settled in ${ms}ms`);
  const asks = far.events.filter((e) => e.startsWith("tcpip-forward"));
  check(
    asks.length === 0,
    `answer: a far side that WOULD answer is not asked either (${asks.join(",") || "none"})`
  );
  check(res.ok === true, "answer: the hop is up");

  await stopTunnel();
  check(await closedTo(far), "answer: the wire is closed once the teardown is done");
  check(
    !far.events.some((e) => e.startsWith("cancel-tcpip-forward")),
    "answer: …and the teardown cancels nothing, because nothing was ever asked for"
  );
  await far.close();
}

async function noForwardingFarSide() {
  // The ambiguity that cost a whole field investigation: the far side is up and
  // says its OWN server is SERVING, but it will not carry a single forwarded
  // channel to this client (sshd `AllowTcpForwarding no`, a jump host or proxy
  // that only carries exec, a hardening policy). The gate must name the WIRE.
  // "backend not reachable on the remote host" sends the user to restart a box
  // that was answering all along, and hides the one fact that matters: this hop
  // cannot forward, so no reconnect through it can ever work.
  farReports = "SERVING";
  const far = await startFakeSshd({ forward: "accept", forwardTo: false });
  const { res, ms } = await connectOnce(far);
  check(res.ok === false, "no-forward: a hop whose channels are refused is not called up");
  check(ms < NO_FORWARD_BUDGET_MS, `no-forward: the gate settled in ${ms}ms (its own clock, then the question)`);
  const why = (res && res.error) || "";
  check(/forwarded port never answered/.test(why), "no-forward: the verdict names the WIRE, not the server: " + why);
  check(!/^backend not reachable/.test(why), "no-forward: …and stops blaming a server that is serving");
  check(/the far side reports SERVING/.test(tunnelLogText()), "no-forward: the far side's own answer is in the log");
  await far.close();
  farReports = "";
}

async function main() {
  const hopShouldWork = await supervisorOn8890();
  console.log(`      (a supervisor answers on 127.0.0.1:8890: ${hopShouldWork} — the hop's own gate)`);

  await silentFarSide(hopShouldWork);
  await answeringFarSide();
  await noForwardingFarSide();

  summary("tunnel-quiet-forward", "the connect asks the far side for nothing, so its silence cannot hold it");
  process.exit(0);
}

main().catch((e) => {
  console.error("runner failed:", (e && e.stack) || e);
  process.exit(1);
});
