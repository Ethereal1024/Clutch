// Reconnecting to a remote that was already set up. Everything here comes from
// the field report: after a disconnect the client "kept installing the server"
// and could never get the session back ("only restarting the server helps").
//
// Two facts are pinned, and they fail independently:
//   1. the stop command must cover every spelling of the far-side server —
//      `python3 -m agent.supervisor` (the pylibs strategy) matches none of the
//      bundle binary names, and a survivor holding 8890 makes the replacement
//      die with "cannot bind … port in use" while the port still answers, so
//      every later attempt skips the install and dies at the health gate;
//   2. a remote whose VERSION already matches is NOT an install: it must not
//      announce one, and it must not stop/start anything.
// Run: node tests/tunnel-reconnect.test.js
//
// The bootstrap runs against a FAKE remote (its remoteExec/uploadFile and the
// artifact provider are swapped at the module seam): one little machine with a
// port, a version file, and a process table, so the decision path is exercised
// for real instead of being read off the source.

"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const { check, summary } = require("./harness");

process.env.CLUTCH_TUNNEL_STOP_GRACE_MS = process.env.CLUTCH_TUNNEL_STOP_GRACE_MS || "250";

const UI_DIR = path.join(__dirname, "..", "ui");
const BOOTSTRAP = path.join(UI_DIR, "tunnel-bootstrap.js");
const BOOTSTRAP_SRC = fs.readFileSync(BOOTSTRAP, "utf8");
const CONNECT_SRC = fs.readFileSync(path.join(UI_DIR, "tunnel-connect.js"), "utf8");
const LIFECYCLE_SRC = fs.readFileSync(path.join(UI_DIR, "tunnel-lifecycle.js"), "utf8");

// ---- the fake far side ----
//
// rport: is anything bound to 8890, and does it answer /api/health? Those are
// different questions on purpose — the wedged survivor of an earlier session
// keeps the socket bound with nothing behind it.
const remote = {
  bound: false,
  serving: false,
  version: null, // the VERSION file, i.e. the install gate
  stubborn: false, // a process pkill cannot remove (another user's server)
  stopped: 0,
  started: 0,
  commands: [],
  reset({ bound = false, serving = false, version = null, stubborn = false } = {}) {
    this.bound = bound;
    this.serving = serving;
    this.version = version;
    this.stubborn = stubborn;
    this.stopped = 0;
    this.started = 0;
    this.commands = [];
  },
};

function fakeRemoteExec(cmd) {
  remote.commands.push(cmd);
  if (cmd.startsWith("pkill")) {
    remote.stopped++;
    if (!remote.stubborn) {
      remote.bound = false;
      remote.serving = false;
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
  if (cmd.includes("socket") && cmd.includes("connect")) {
    return Promise.resolve({ code: 0, stdout: remote.bound ? "UP\n" : "DOWN\n", stderr: "" });
  }
  if (cmd.includes("/api/health")) {
    return Promise.resolve({ code: 0, stdout: remote.serving ? "200\n" : "DOWN\n", stderr: "" });
  }
  if (/agent-supervisor|agent\.supervisor/.test(cmd) && cmd.includes("nohup")) {
    remote.started++;
    remote.bound = true;
    remote.serving = true; // the freshly started supervisor answers
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
  if (/^echo .* > .*VERSION/.test(cmd)) {
    remote.version = cmd.split("echo ")[1].split(" ")[0];
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
}

let tarFetches = 0;
const fakeArtifacts = {
  platformTag: () => "linux-x86_64",
  hasLocalBundle: () => false,
  ensureBundle: () => Promise.reject(new Error("no bundle on this side")),
  // the gate's question: WHICH artifact this release ships — no bytes. On the
  // phone this is the few-KB release catalogue.
  resolvePyLibsVersion: () => Promise.resolve(VERSION),
  // the bytes, counted: a connect to a remote that already runs this version
  // must never ask for them (report #5 — the whole transfer used to happen
  // inside the "Checking remote server…" stage)
  ensurePyLibsTar: () => {
    tarFetches++;
    return Promise.resolve({ path: "/nowhere/pylibs.tar.gz", version: VERSION });
  },
};

const VERSION = "aaaaaaaaaaaaaaaa"; // 16 hex, exactly what the gate compares

let uploads = 0;
const fakeTunnelRemote = {
  remoteExec: fakeRemoteExec,
  uploadFile: () => {
    uploads++;
    return Promise.resolve();
  },
  uploadFileViaExec: () => Promise.resolve(),
};

// Swap at the module seam: bootstrap's own imports of the wire and the
// artifacts, everything else (parseProbe, the commands, the decision) is the
// production code.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === BOOTSTRAP) {
    if (request === "./tunnel-remote") return fakeTunnelRemote;
    if (request === "./server-bundle") return fakeArtifacts;
  }
  return origLoad.apply(this, arguments);
};

const { installServer, stopServerCmd, startCommand, parseProbe } = require("../ui/tunnel-bootstrap");

const PROBE = {
  os: "Linux",
  arch: "x86_64",
  home: "/home/u",
  libc: "glibc",
  python: "3.12",
  installedVersion: VERSION,
};

// The probe the caller would have built from THIS remote: everything the fake
// box is asked about lives in the probe (the port check is only asked when the
// probe carries a python3), and the install gate reads the VERSION file the
// remote is currently holding — so it has to be derived, not fixed.
function probeFor() {
  return { ...PROBE, installedVersion: remote.version || "" };
}

async function main() {
  // ---- 1. the stop command covers every spelling ----
  //
  // The patterns are read OUT of the real command, so this cannot drift from
  // what is shipped. Ordered so the comment in the source is not mistaken for
  // a pattern: every quoted pkill argument is a case.
  const stopCmd = stopServerCmd("pylibs");
  const patterns = [...stopCmd.matchAll(/pkill\s+(?:-\S+\s+)?-f\s+'([^']+)'/g)].map((m) => m[1]);
  check(patterns.length >= 4, `the stop command kills every server spelling (${patterns.length} patterns)`);

  const realWorld = {
    "bundle supervisor": "/home/u/.clutch-server/agent-supervisor --port 8890 --idle-timeout 25 --agent-cmd /home/u/.clutch-server/agent-server",
    "bundle session child": "/home/u/.clutch-server/agent-server --port 0 --base-url http://127.0.0.1:8892/v1",
    "pylibs supervisor": "python3 -m agent.supervisor --port 8890 --idle-timeout 25",
    "pylibs supervisor (prefixed interpreter)": "/usr/bin/python3 -m agent.supervisor --port 8890 --idle-timeout 25",
    "pylibs session child": "/usr/bin/python3 -m agent.server --port 0 --base-url http://127.0.0.1:8892/v1 --model deepseek-flash",
    "the nohup shell that started a pylibs supervisor":
      "bash -c cd /home/u/.clutch-server && nohup setsid env PYTHONPATH=site-packages python3 -m agent.supervisor --port 8890 --idle-timeout 25",
    "the pkill shell itself":
      "sh -c pkill -f '[a]gent-supervisor' 2>/dev/null; pkill -f '[a]gent\\.supervisor' 2>/dev/null; true",
    "pkill's own process": "pkill -f [a]gent-supervisor",
    "an unrelated process": "/usr/bin/python3 -m agent.tools.inst --workspace /home/u/proj",
  };
  for (const [what, cmdline] of Object.entries(realWorld)) {
    const hit = patterns.some((p) => new RegExp(p).test(cmdline));
    const want = !["the pkill shell itself", "pkill's own process", "an unrelated process"].includes(what);
    check(hit === want, `stop patterns ${want ? "match" : "spare"} ${what}`);
  }
  // the pylibs spelling is the one the shipped command was missing: it must be
  // in the list on its own, not merely covered by `agent.server` (which is a
  // different module, and `agent.server` does not match "agent.supervisor")
  check(
    patterns.includes("[a]gent\\.supervisor"),
    "the pylibs supervisor spelling is killed by name"
  );
  check(
    /pkill -9 -f/.test(stopServerCmd("pylibs", "-9")),
    "the escalation signal reaches pkill (-9) when SIGTERM is not enough"
  );

  // ---- the remote log survives the session that died in it ----
  //
  // The failure worth reading is the one the PREVIOUS session died of, and a `>`
  // redirect erases exactly that at the moment someone reconnects to look: the
  // remote supervisor appends, so the file is a history of attempts rather than
  // the last one (agent/procmgr/stdio.py stamps each line with its clock, which
  // is what makes several attempts in one file readable).
  for (const strategy of ["bundle", "pylibs"]) {
    const cmd = startCommand(strategy, "/home/u");
    check(
      cmd.includes(">>/tmp/clutch-server.log 2>&1") &&
        !/[^>]>\/tmp\/clutch-server\.log/.test(cmd),
      `${strategy}: the remote log is appended to, never truncated`
    );
  }

  // ---- 2. a remote that already runs our version is not an install ----
  uploads = 0;
  tarFetches = 0;
  remote.reset({ bound: true, serving: true, version: VERSION });
  const progress = [];
  const already = await installServer(probeFor(), {
    force: "pylibs",
    progress: (s) => progress.push(s),
  });
  check(already.installed === true, "an up-to-date remote installs nothing and reports success");
  check(!progress.includes("install"), "…and never announces 'Installing remote server…'");
  check(remote.stopped === 0 && remote.started === 0, "…and neither stops nor restarts the server");
  check(uploads === 0, "…and uploads nothing");
  check(tarFetches === 0, "…and never fetches the pylibs tar: the check is a check (report #5)");

  // ---- 3. a bound port with nothing behind it is replaced ----
  remote.reset({ bound: true, serving: false, version: VERSION });
  const wedged = await installServer(probeFor(), { force: "pylibs", progress: () => {} });
  check(wedged.installed === true, "a wedged survivor (bound, not answering) is cleared and the server comes up");
  check(remote.stopped >= 1, "the wedged process is stopped");
  check(remote.started === 1, "exactly one replacement is started");
  check(uploads === 0, "replacing a wedged survivor is not an install: nothing is uploaded");

  // ---- 4. a version mismatch IS an install, and it says so ----
  uploads = 0;
  tarFetches = 0;
  remote.reset({ bound: true, serving: true, version: "bbbbbbbbbbbbbbbb" });
  const stages = [];
  const stale = await installServer(probeFor(), { force: "pylibs", progress: (s) => stages.push(s) });
  check(stale.installed === true, "a remote running another version is installed over");
  check(stages.includes("install"), "…and that IS announced as an install");
  check(remote.stopped >= 1, "…which stops the old server first");
  check(remote.started === 1, "…and starts the new one");
  check(uploads === 1, "…after one artifact upload");
  check(tarFetches === 1, "…and the tar is fetched exactly once, for that install");
  check(
    stages.indexOf("install:fetch") > stages.indexOf("install") && stages.includes("install:upload"),
    "…with its own 'Preparing remote server…' stage between the announcement and the upload"
  );
  check(remote.version === VERSION, "…and the VERSION gate file is rewritten");

  // ---- 5. a process we cannot kill is reported, not looped on ----
  remote.reset({ bound: true, serving: true, version: "bbbbbbbbbbbbbbbb", stubborn: true });
  const stuck = await installServer(probeFor(), { force: "pylibs", progress: () => {} });
  check(stuck.ok === false, "a port this client cannot free fails the install instead of retrying forever");
  check(/8890/.test(stuck.error || ""), "…and names the port it is stuck on");
  check(remote.started === 0, "…and does not start a supervisor that would bind-fail");
  check(remote.commands.some((c) => c.startsWith("pkill -9")), "…after escalating to SIGKILL");

  // ---- 6. a stale forward over a still-serving far side is rebound, never killed ----
  //
  // The field report's second death: the phone froze in the background, came
  // back to a stale local forward, and the healer read "nothing answers" as
  // "the far server died" — `restartRemoteServer` pkill'ed the supervisor AND
  // every session child under it, ending a run in flight (the run's record then
  // said "the host released this session while the run was in flight"). A
  // failed poll is a QUESTION: the far host is asked about ITSELF over exec (a
  // path the dead forward does not share), and a far host that answers is never
  // touched — its forward is rebound on the same local port the claims name.
  {
    const http = require("http");
    const net = require("net");
    const { state } = require("../ui/tunnel-core");
    const { freePort } = require("../ui/tunnel-net");
    const { healOnce } = require("../ui/tunnel-lifecycle");

    // the far supervisor as the rebound forward reaches it: the fake ssh
    // client's forwardOut pipes whatever crosses the local listener here
    const far = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok": true, "in_flight": true}');
    });
    await new Promise((r) => far.listen(0, "127.0.0.1", r));
    let forwardedTo = null;
    const fakeClient = {
      forwardOut(_src, _sport, _dst, dport, cb) {
        forwardedTo = dport;
        const s = net.connect(far.address().port, "127.0.0.1");
        s.once("connect", () => cb(null, s));
        s.once("error", (e) => cb(e));
      },
    };

    remote.reset({ bound: true, serving: true, version: VERSION }); // answers about itself
    const port = await freePort();
    state.sshClient = fakeClient;
    state.localSrv = null;
    state.lastProbe = probeFor();
    state.lastStrategy = "pylibs";
    state.currentUrl = `http://127.0.0.1:${port}`; // nothing bound: the stale forward

    await healOnce();

    check(forwardedTo === 8890, "the rebound forward targets the far supervisor's port");
    check(
      remote.stopped === 0 && remote.started === 0 && !remote.commands.some((c) => c.includes("pkill")),
      "a far side that answers about itself is never stopped, restarted, or pkilled"
    );
    check(state.currentUrl === `http://127.0.0.1:${port}`, "the window's URL survives the bounce unchanged");
    check(
      state.localSrv && state.localSrv.listening && state.localSrv.address().port === port,
      "the forward is rebound on the same local port the window claims name"
    );
    const code = await new Promise((resolve) => {
      http
        .get(state.currentUrl + "/api/health", (r) => {
          r.resume();
          resolve(r.statusCode);
        })
        .on("error", () => resolve(0));
    });
    check(code === 200, "and the claim's own URL answers again through it");

    // the heal is not a teardown: unwind its listeners by hand
    state.localSrv.close();
    state.localSrv = null;
    state.sshClient = null;
    await new Promise((r) => far.close(r));
  }

  // ---- 7. the paths a fake remote cannot reach, asserted on the source ----
  check(
    !/progress\("install"\)/.test(CONNECT_SRC),
    "connectTunnel no longer announces an install before the gate decides"
  );
  check(
    /if \(!probe\.os \|\| !probe\.home\)/.test(CONNECT_SRC),
    "an exec that came back without the probe's markers is not read as 'nothing installed'"
  );
  check(
    /stopServer\(state\.lastProbe \|\| \{\}, state\.lastStrategy\)/.test(LIFECYCLE_SRC),
    "the healer's restart proves the old process actually went away"
  );
  check(
    /return false;/.test(LIFECYCLE_SRC.split("async function restartRemoteServer")[1].split("async function healOnce")[0]),
    "…and reports a restart it could not perform as a failure, not as 'recovered'"
  );
  check(
    /const STOP_GRACE_MS/.test(BOOTSTRAP_SRC) && /waitForRemotePortFree/.test(BOOTSTRAP_SRC),
    "the stop is verified against the port, not assumed from pkill's exit code"
  );
  check(
    !parseProbe("").os && !parseProbe("").installedVersion,
    "an exec that answered nothing carries no probe markers, so the gate can refuse it by name"
  );
  // report #5, asserted on the source because a fake remote cannot show it: the
  // gate's input is resolved BEFORE it decides, and the tar is fetched only
  // after an install has been announced — the other order made every check a
  // multi-megabyte transfer, which is the connect dying on a phone link.
  check(
    /version = await resolvePyLibsVersion\(target\)/.test(BOOTSTRAP_SRC),
    "the gate resolves 'which artifact' without the artifact's bytes"
  );
  check(
    BOOTSTRAP_SRC.indexOf('progress("install")') < BOOTSTRAP_SRC.indexOf("ensurePyLibsTar(target)") &&
      BOOTSTRAP_SRC.indexOf('progress("install:fetch")') < BOOTSTRAP_SRC.indexOf("ensurePyLibsTar(target)"),
    "the tar is fetched only after the connect has announced an install, under its own stage"
  );

  summary("tunnel-reconnect");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack) || e);
  process.exit(1);
});
