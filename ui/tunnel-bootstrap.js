// make the far side exist — probe, choose a strategy, install, start
//
// One exec prints every fact the decision needs; chooseStrategy turns that
// into "bundle" (same platform, and a local bundle is available) or "pylibs"
// (exact wheels for the target). The version of the artifact we ship is the
// only install gate, so a remote already running it is left alone. Components
// go last on purpose: they are code the far side runs on its own machine, and
// the connect must not wait on the upload.

const path = require("path");
const { state, tunnelLog, REMOTE_API_PORT } = require("./tunnel-core");
const { remoteExec, uploadFile } = require("./tunnel-remote");
const { platformTag, ensureBundle, ensurePyLibsTar, hasLocalBundle } = require("./server-bundle");
const components = require("./components");

// ---- bootstrap ----

const PROBE_CMD = [
  'echo "__OS__"; uname -s',
  'echo "__ARCH__"; uname -m',
  'echo "__HOME__"; echo "$HOME"',
  'echo "__OSREL__"; (grep -E "^(NAME|VERSION)=" /etc/os-release 2>/dev/null || true) | head -2',
  'echo "__PY__"; (command -v python3 >/dev/null && python3 -c "import sys;print(\'%d.%d\'%sys.version_info[:2])") || echo NONE',
  'echo "__LIBC__"; (ldd --version 2>&1 | head -1 | grep -qi musl && echo musl) || ([ -f /etc/alpine-release ] && echo musl) || (ldd --version 2>&1 | head -1 | grep -qE "GLIBC|glibc|GNU libc" && echo glibc) || echo unknown',
  'echo "__VER__"; (cat "$HOME/.clutch-server/VERSION" 2>/dev/null) || echo NONE',
  'echo "__STRATEGY__"; (cat "$HOME/.clutch-server/STRATEGY" 2>/dev/null) || echo NONE',
  'echo "__ART__"; (test -x "$HOME/.clutch-server/agent-server" -a -x "$HOME/.clutch-server/agent-supervisor" && echo bundle || true); (test -x "$HOME/.clutch-server/venv/bin/python" && echo pip || true); (test -d "$HOME/.clutch-server/site-packages" && echo pylibs || true)',
  'echo "__NET__"; (python3 -c "import urllib.request;urllib.request.urlopen(\'https://pypi.org\',timeout=3);print(\'OK\')" 2>/dev/null) || echo NO',
  'echo "__TMP__"; (test -w /tmp && echo YES) || echo NO',
].join("; ");

function parseProbe(out) {
  const section = (marker) => {
    const parts = out.split(marker);
    return parts.length > 1 ? parts[1].split("__")[0].trim() : "";
  };
  const arts = out.split("__ART__").pop().split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    os: section("__OS__"),
    arch: section("__ARCH__"),
    home: section("__HOME__"),
    osrel: section("__OSREL__"),
    python: section("__PY__") === "NONE" ? "" : section("__PY__"),
    libc: section("__LIBC__"),
    installedVersion: section("__VER__"),
    installedStrategy: section("__STRATEGY__"),
    artifacts: arts,
    internet: section("__NET__") === "OK",
    tmpWritable: section("__TMP__") === "YES",
  };
}

function startCommand(strategy, home) {
  // remote supervisor runs on 8890 like local; session children get --base-url later
  const args = "--port " + REMOTE_API_PORT + " --idle-timeout 25";
  const nohup = "nohup setsid ";
  if (strategy === "bundle") {
    // explicit: a onefile's sys.executable cannot locate the sibling agent-server
    return `${nohup}${home}/.clutch-server/agent-supervisor ${args} --agent-cmd ${home}/.clutch-server/agent-server >/tmp/clutch-server.log 2>&1 </dev/null &`;
  }
  // pylibs: the remote imports the whole wheel stack before binding (cold
  // start can take several seconds on slow disks), so keep the idle reaper
  // at 25s (> the 20s start poll). NOTE: argparse takes the LAST --idle-timeout,
  // so never append a second one after ${args}.
  return `cd ${home}/.clutch-server && ${nohup}env PYTHONPATH=site-packages python3 -m agent.supervisor ${args} >/tmp/clutch-server.log 2>&1 </dev/null &`;
}

function remoteRunningCmd(probe) {
  if (probe.python) {
    return `python3 -c "import socket;s=socket.socket();s.settimeout(1);s.connect(('127.0.0.1',${REMOTE_API_PORT}));print('UP')" 2>/dev/null || echo DOWN`;
  }
  return `(command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ':${REMOTE_API_PORT} ' && echo UP) || echo DOWN`;
}

// The bundle strategy ships binaries built for THIS host, so it is only valid
// when the remote runs the same OS *and* CPU arch — arch alone is not enough
// (a Windows client must not ship its .exe to a Linux remote, and vice versa).
// hasLocalBundle() gates it a second time: a registered artifact provider
// (Android, N3/N4) cannot produce a bundle, so even a same-platform remote
// goes through pylibs — otherwise a linux-aarch64 phone facing a linux-aarch64
// remote would pick "bundle" and die in the provider's hard reject.
// Cross-platform remotes use pylibs: exact wheels for the target are fetched
// client-side and the remote runs them with its own python3.
function chooseStrategy(probe, localTag = platformTag()) {
  const [localOs, localArch] = localTag.split("-");
  if (
    String(probe.os || "").toLowerCase() === localOs &&
    probe.arch === localArch &&
    hasLocalBundle()
  ) {
    // same-platform: self-contained bundle (remote python3 has segfaulted on a NAS)
    return "bundle";
  }
  if (probe.python) return "pylibs";
  return null;
}

// force is for tests; auto-decides when omitted. progress(stage) drives the UI progress bar.
async function installServer(probe, { force, progress } = {}) {
  const localTag = platformTag();
  tunnelLog(
    `[bootstrap] probe os=${probe.os} arch=${probe.arch} libc=${probe.libc || "?"} py=${probe.python || "none"} ` +
      `local=${localTag}`
  );

  let strategy;
  if (force) {
    strategy = force;
  } else if (process.env.CLUTCH_TUNNEL_FORCE) {
    strategy = process.env.CLUTCH_TUNNEL_FORCE;
  } else {
    strategy = chooseStrategy(probe, localTag);
  }
  if (strategy !== "bundle" && strategy !== "pylibs") {
    // e.g. no python3 (no deterministic install path — reject, renderer falls to
    // SSH-tools), or an explicit CLUTCH_TUNNEL_FORCE=assist
    return {
      ok: false,
      error:
        `target runs ${probe.os}/${probe.arch} without python3 (${probe.libc || "?"} libc) and no ` +
        "bundle for this platform is available, so the server cannot be installed. " +
        "Falling back to SSH-tools: file and command access over the tunnel still work; " +
        "install python3 on the device to enable the full server experience.",
    };
  }
  // content-hash version is the only install gate: installed iff the remote's
  // VERSION equals our binaries' hash
  let artifact;  let version;
  if (strategy === "bundle") {
    artifact = await ensureBundle();
    version = artifact.version;
  } else {
    try {
      const p = await ensurePyLibsTar({
        os: probe.os,
        arch: probe.arch,
        libc: probe.libc || "unknown",
        pyver: probe.python,
      });
      artifact = p.path;
      version = p.version;
    } catch (e) {
      tunnelLog("[bootstrap] pylibs build failed: " + e.message);
      return { ok: false, error: "cannot obtain wheels for target: " + e.message };
    }
  }
  const installed = probe.installedVersion === version;
  tunnelLog(`[bootstrap] strategy=${strategy} version=${version.slice(0, 12)}… installed=${installed}`);

  const home = probe.home || "~";
  const dir = `${home}/.clutch-server`;
  state.lastStrategy = strategy;
  state.lastHome = home;

  let reinstalled = false;
  if (!installed) {
    // the NAS refuses to truncate an executing binary in place: stop first
    await remoteExec(`mkdir -p ${dir}`);
    tunnelLog("[bootstrap] stopping old server before reinstall");
    await remoteExec(stopServerCmd(strategy));
    if (strategy === "bundle") {
      const { server, supervisor } = artifact;
      tunnelLog(`[bootstrap] uploading bundle ${path.basename(server)} + supervisor`);
      if (progress) progress("install:upload");
      try {
        // atomic rename over the old binary
        await uploadFile(server, `${dir}/agent-server.new`);
        await uploadFile(supervisor, `${dir}/agent-supervisor.new`);
      } catch (e) {
        tunnelLog("[bootstrap] bundle upload failed: " + (e && e.message));
        try {
          const diag = await remoteExec(`ls -la ${dir} 2>&1; df -h ${dir} 2>&1 | tail -3`);
          tunnelLog("[bootstrap] upload diagnostics:\n" + (diag.stdout || "").slice(0, 800));
        } catch (e2) {
          /* diagnostics are best-effort */
        }
        throw e;
      }
      await remoteExec(
        `chmod +x ${dir}/agent-server.new ${dir}/agent-supervisor.new && ` +
          `mv -f ${dir}/agent-server.new ${dir}/agent-server && ` +
          `mv -f ${dir}/agent-supervisor.new ${dir}/agent-supervisor`
      );
    } else {
      // pylibs: the target-platform site-packages tar was already built above
      tunnelLog(`[bootstrap] uploading pylibs ${path.basename(artifact)}`);
      if (progress) progress("install:upload");
      await uploadFile(artifact, `${dir}/pylibs.tar.gz`);
      await remoteExec(
        `python3 -c "import tarfile;tarfile.open('${dir}/pylibs.tar.gz').extractall('${dir}')" && rm -f ${dir}/pylibs.tar.gz`
      );
    }
    await remoteExec(`echo ${version} > ${dir}/VERSION && echo ${strategy} > ${dir}/STRATEGY`);
    tunnelLog("[bootstrap] installed");
    reinstalled = true;
  }

  // ensure the server runs the freshly installed code
  const run = await remoteExec(remoteRunningCmd(probe));
  if (reinstalled || !run.stdout.includes("UP")) {
    tunnelLog("[bootstrap] starting server");
    if (progress) progress("install:start");
    // short timeout: the start command backgrounds the server
    await remoteExec(startCommand(strategy, home), 10000);
    // wait for it to bind; pylibs cold-start imports the whole wheel stack and
    // can take >10s on slow servers, so poll for up to 20s (vs the old 6s
    // window that reported a healthy install as "did not come up")
    for (let i = 0; i < 40; i++) {
      const chk = await remoteExec(remoteRunningCmd(probe));
      if (chk.stdout.includes("UP")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const up = await remoteExec(remoteRunningCmd(probe));
    if (!up.stdout.includes("UP")) {
      let diag = "";
      try {
        const d = await remoteExec(`tail -n 40 /tmp/clutch-server.log 2>/dev/null; ls -la ${dir}/agent-supervisor ${dir}/agent-server 2>&1`);
        diag = (d.stdout || "").slice(0, 800);
      } catch (e) {
        /* best effort */
      }
      tunnelLog("[bootstrap] remote supervisor did not come up; log:\n" + diag);
      return {
        ok: false,
        error:
          "the remote Clutch supervisor failed to start on port " + REMOTE_API_PORT +
          (diag ? ` (remote log: ${diag.replace(/\n/g, " | ")})` : ""),
      };
    }
  } else {
    tunnelLog("[bootstrap] server already running");
  }
  return { installed: true, strategy };
}

function stopServerCmd(strategy) {
  // bracket guards avoid pkill matching its own shell; also stops legacy
  // shared servers on 8890 that would make the supervisor bind-fail
  void strategy;
  return (
    "pkill -f '[a]gent-supervisor' 2>/dev/null; " +
    "pkill -f '[a]gent-server' 2>/dev/null; " +
    "pkill -f '[a]gent.server' 2>/dev/null; true"
  );
}

// The far side's server is up, and components are code IT runs on ITS machine —
// so handing them over belongs here, right after the health probe says the host
// is the one we think it is. Deliberately not awaited: connecting must not wait
// on a 30 MB upload. There is no second implementation on that side to cover for
// a component that has not landed — an absent component simply takes its tools
// with it — so a failed pass is logged and the far side keeps the surface it has.
// A dev run ships its own checkout, which is the one artifact this side has and
// the far side cannot.
function installComponents(base) {
  Promise.resolve()
    .then(() => components.ensureComponents(base, { progress: (m) => tunnelLog("[components] " + m) }))
    .then((r) =>
      tunnelLog(
        `[components] current=${r.current.length} installed=${r.installed.length} ` +
          `skipped=${r.skipped.length} deferred=${r.deferred.length} errors=${r.errors.length}`
      )
    )
    .catch((e) => tunnelLog("[components] pass failed: " + ((e && e.message) || e)));
}

module.exports = {
  PROBE_CMD,
  parseProbe,
  startCommand,
  stopServerCmd,
  chooseStrategy,
  installServer,
  installComponents,
};
