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
const { platformTag, ensureBundle, ensurePyLibsTar, resolvePyLibsVersion, hasLocalBundle } = require("./server-bundle");
const components = require("./components");

// ---- bootstrap ----

// How long a stopped remote server gets to let go of 8890 before we insist
// (SIGKILL) and, past even that, report the process that is still holding it.
// The env override keeps the test suite from spending the grace twice per case.
const STOP_GRACE_MS = Number(process.env.CLUTCH_TUNNEL_STOP_GRACE_MS || 5000);

// Does the far side's tree still vouch for itself? A file WE wrote cannot: the
// field's broken remote held a VERSION that matched ours exactly (so every
// reconnect skipped the install — the gate is "the marker equals our hash") over
// a site-packages that was a MERGE of three releases, and the far side's server
// died on `import pydantic` before it could bind. So the tree is asked the two
// questions a marker cannot answer, both far cheaper than the transfer they
// avoid:
//
//   * is any project carrying more than one dist-info? An install that unpacks
//     ON TOP of a live tree leaves the previous generation's metadata (and the
//     modules the new release does not ship) behind forever; two generations on
//     one tree is what a merge is, and it is visible from the names alone.
//   * does the import the far side's server does FIRST still work? `agent/llm`
//     imports openai, which imports pydantic, which checks pydantic_core's
//     version — that pair is the one the field broke on, and it is also the
//     cheap one to import (openai pulls the whole client stack).
//
// One token, and neither the program nor anything it prints contains `__`: the
// probe's sections are delimited by it. NONE = the VERSION file describes a tree
// that is not there; NOPY = no python3 to ask with (not a verdict about the
// tree). The import is caught by NAME rather than reflected off the exception
// (type(exc).__name__ is the one dunder that would put the delimiter in the
// program), and the names are the field's: SystemError is the mismatch pydantic
// raises when pydantic_core is not the version it was built against.
const TREE_PROBE_CMD = `echo "__TREE__"; PYTHONPATH="$HOME/.clutch-server/site-packages" python3 -c '
import os, sys
sp = os.environ["PYTHONPATH"]
if not os.path.isdir(sp):
    print("NONE")
    raise SystemExit(0)
names = [d[:-10].rsplit("-", 1)[0] for d in os.listdir(sp) if d.endswith(".dist-info")]
dups = sorted(set(n for n in names if names.count(n) > 1))
if dups:
    print("DUP:" + ",".join(dups[:4]))
    raise SystemExit(0)
try:
    import pydantic, pydantic_core
except SystemError:
    print("IMPORT:SystemError")
except ImportError:
    print("IMPORT:ImportError")
except Exception:
    print("IMPORT:Other")
else:
    print("OK")
' 2>/dev/null || echo NOPY`;

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
  TREE_PROBE_CMD,
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
    // the far side's tree vouching for itself (see TREE_PROBE_CMD): "OK",
    // "NONE", "DUP:…", "IMPORT:…", "NOPY", or "" for a probe that answered
    // nothing at all
    pylibsTree: section("__TREE__"),
    internet: section("__NET__") === "OK",
    tmpWritable: section("__TMP__") === "YES",
  };
}

function startCommand(strategy, home) {
  // remote supervisor runs on 8890 like local; session children get --base-url later
  const args = "--port " + REMOTE_API_PORT + " --idle-timeout 25";
  const nohup = "nohup setsid ";
  // APPEND to the log, never truncate it: the failure worth reading is the one
  // the previous session died of, and `>` erases exactly that — the evidence is
  // gone at the moment someone reconnects to look at it (agent/procmgr/stdio.py
  // stamps every line, so attempts sharing the file stay separable).
  const logredir = ">>/tmp/clutch-server.log 2>&1 </dev/null &";
  if (strategy === "bundle") {
    // explicit: a onefile's sys.executable cannot locate the sibling agent-server
    return `${nohup}${home}/.clutch-server/agent-supervisor ${args} --agent-cmd ${home}/.clutch-server/agent-server ${logredir}`;
  }
  // pylibs: the remote imports the whole wheel stack before binding (cold
  // start can take several seconds on slow disks), so keep the idle reaper
  // at 25s (> the 20s start poll). NOTE: argparse takes the LAST --idle-timeout,
  // so never append a second one after ${args}.
  return `cd ${home}/.clutch-server && ${nohup}env PYTHONPATH=site-packages python3 -m agent.supervisor ${args} ${logredir}`;
}

function remoteRunningCmd(probe) {
  if (probe && probe.python) {
    return `python3 -c "import socket;s=socket.socket();s.settimeout(1);s.connect(('127.0.0.1',${REMOTE_API_PORT}));print('UP')" 2>/dev/null || echo DOWN`;
  }
  // no python3 to ask: try ss, and say UNKNOWN (not DOWN) when even that is
  // missing — "I could not look" and "nobody is listening" are different
  // answers, and only one of them justifies replacing the process on the port.
  return `(command -v ss >/dev/null && (ss -ltn 2>/dev/null | grep -q ':${REMOTE_API_PORT} ' && echo UP || echo DOWN)) || echo UNKNOWN`;
}

// The far side's OWN health check. A bound port is not a serving server: the
// wedged survivor of an earlier session keeps the socket bound with nothing
// behind it, and the port alone cannot tell the two apart — that is how a
// reconnect used to skip the install, then die at the local health gate with
// no way back (report: "only restarting the server helps").
function remoteHealthCmd(probe) {
  const url = `http://127.0.0.1:${REMOTE_API_PORT}/api/health`;
  if (probe && probe.python) {
    return `python3 -c "import urllib.request;print(urllib.request.urlopen('${url}',timeout=3).status)" 2>/dev/null || echo DOWN`;
  }
  return `(command -v curl >/dev/null && (curl -fsS -m 3 -o /dev/null '${url}' && echo 200 || echo DOWN)) || echo UNKNOWN`;
}

// What is on the far side's port: DOWN (nobody), WEDGED (bound, silent),
// SERVING (answers), UNMEASURABLE (no python3 and no curl to ask with — a
// remote whose answer we cannot hear must not be mistaken for a dead one).
async function remoteServingState(probe) {
  const out = (await remoteExec(remoteRunningCmd(probe))).stdout || "";
  if (!out.includes("UP")) return out.includes("UNKNOWN") ? "UNMEASURABLE" : "DOWN";
  const h = (await remoteExec(remoteHealthCmd(probe))).stdout || "";
  if (h.includes("200")) return "SERVING";
  if (h.includes("UNKNOWN")) return "UNMEASURABLE";
  return "WEDGED";
}

// Wait for the port to go quiet after a stop. The verdict is the last one
// observed: anything but UP means nothing is holding 8890 any more.
async function waitForRemotePortFree(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let out = "";
    try {
      out = (await remoteExec(remoteRunningCmd(probe))).stdout || "";
    } catch (e) {
      tunnelLog("[bootstrap] port check failed: " + ((e && e.message) || e));
    }
    if (!out.includes("UP")) return out.includes("UNKNOWN") ? "UNKNOWN" : "DOWN";
    if (Date.now() >= deadline) return "UP";
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Stop the far side's server and PROVE it let go of the port. SIGTERM first,
// then SIGKILL, then say who is still holding it. A replacement started while
// the old process still owns 8890 dies with "cannot bind … port in use" — a
// failure this side used to read as "the install did not come up", retry
// forever, and never see the real cause of.
async function stopServer(probe, strategy) {
  // The wire may already be gone: ssh2's exec throws 'Not connected' the moment
  // the socket is dead, and a healer that dies HERE never reaches its "the port
  // is still held" verdict — it rejects, and the caller's teardown is skipped.
  // An unreachable wire is reported as a stop that could not be proven, with the
  // reason, which is what the caller acts on.
  try {
    await remoteExec(stopServerCmd(strategy));
  } catch (e) {
    return { ok: false, state: "UNREACHABLE", diag: "the tunnel could not run the stop: " + ((e && e.message) || e) };
  }
  let verdict = await waitForRemotePortFree(probe, STOP_GRACE_MS);
  if (verdict !== "UP") return { ok: true, state: verdict };
  tunnelLog(`[bootstrap] port ${REMOTE_API_PORT} still held after SIGTERM — SIGKILL`);
  try {
    await remoteExec(stopServerCmd(strategy, "-9"));
  } catch (e) {
    return { ok: false, state: "UNREACHABLE", diag: "the tunnel died holding the port: " + ((e && e.message) || e) };
  }
  verdict = await waitForRemotePortFree(probe, STOP_GRACE_MS);
  if (verdict !== "UP") return { ok: true, state: verdict };
  let diag = "";
  try {
    const d = await remoteExec(
      `ps ax 2>/dev/null | grep -E '[a]gent[.-](supervisor|server)' | head -5; ` +
        `command -v ss >/dev/null && ss -ltnp 2>/dev/null | grep ':${REMOTE_API_PORT} ' || true`
    );
    diag = (d.stdout || "").trim().slice(0, 400);
  } catch (e) {
    /* diagnostics are best-effort */
  }
  return { ok: false, state: verdict, diag };
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

// What the tree said about itself (TREE_PROBE_CMD), read as "may I hand this
// remote our code with no install?". Only the answers that mean "this tree
// cannot serve" make it unsound:
//
//   NONE      the VERSION file describes a tree that is not there
//   DUP:…     two releases merged on one tree (the field's shape)
//   IMPORT:…  the wheels are present and cannot be imported together
//
// "NOPY" (no python3 to ask with) and an exec that came back without the section
// are NOT verdicts about the tree, and an install forced on one of them would be
// a guess: a pylibs install is refused outright on a remote without python3, so
// nothing healthy is ever skipped by this default.
function pylibsTreeSound(verdict) {
  const v = String(verdict || "").trim();
  if (!v || v === "NOPY" || v === "UNKNOWN") return true;
  return v === "OK";
}

// How the pylibs tar lands on the far side: by REPLACE, never by merge.
//
// The tar carries two top-level trees — `site-packages` (the wheels) and `agent`
// (the far side's own code) — and unpacking it OVER the live ones is not an
// install. tarfile only adds and overwrites: every file the new release does not
// ship (a dropped module, the previous generation's `pydantic_core-2.50.1.dist-info`,
// an older extension module under the same name) stays behind forever, and two
// releases merged on one tree is a tree no import survives. That is the field's
// "no backend": pydantic 2.13.5 beside pydantic_core 2.50.1 raising SystemError
// at import, under a VERSION file that matched the release being connected to.
//
// So: unpack into a staging directory ON THE SAME FILESYSTEM, check that BOTH
// trees really arrived, and only then swap them in — `mv` inside one directory
// is a rename, the old tree is deleted only after the new one is in place, and
// every failure before the first `mv` leaves the live tree exactly as it was
// (the staging directory is the only thing thrown away). The far side's server
// is already stopped by the caller (see the note above), so nothing is reading
// either tree while it is swapped.
function pylibsInstallCmd(dir) {
  const stage = `${dir}/pylibs.stage`;
  // the OLD tree is renamed aside first and removed last: a swap that dies
  // between the two renames leaves `site-packages.old` recoverable, not a hole
  const swap = (name) =>
    `rm -rf ${dir}/${name}.old && (mv ${dir}/${name} ${dir}/${name}.old 2>/dev/null || true) && ` +
    `mv ${stage}/${name} ${dir}/${name} && rm -rf ${dir}/${name}.old`;
  const chain = [
    `rm -rf ${stage}`,
    `mkdir -p ${stage}`,
    `python3 -c "import tarfile;tarfile.open('${dir}/pylibs.tar.gz').extractall('${stage}')"`,
    // both trees before either swap: a tar that carries no `agent` (or no
    // site-packages) installs NOTHING rather than half of itself
    `test -d ${stage}/site-packages -a -d ${stage}/agent`,
    swap("site-packages"),
    swap("agent"),
    `rm -f ${dir}/pylibs.tar.gz`,
  ].join(" && ");
  // …and the staging tree is thrown away whatever happened. On success the swap
  // already removed it; on a failure it holds a half-unpacked copy of the wheels
  // (tens of megabytes, on a phone) until the next attempt's own `rm -rf` — so
  // the failure path clears it too, and the exit status is preserved: a failed
  // install is a nonzero exit, which installServer now asks about by name.
  return `${chain} ; rc=$?; rm -rf ${stage}; test $rc -eq 0`;
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
  const target = { os: probe.os, arch: probe.arch, libc: probe.libc || "unknown", pyver: probe.python };
  let artifact;  let version;
  if (strategy === "bundle") {
    artifact = await ensureBundle();
    version = artifact.version;
  } else {
    // the gate asks WHICH artifact this release ships, not for its bytes: on the
    // phone that is the few-KB release catalogue, so a remote that already runs
    // this release is recognised without the multi-megabyte tar moving at all.
    // Fetching the tar here made every check a transfer — and on a phone link
    // that transfer IS the connect (report #5).
    try {
      version = await resolvePyLibsVersion(target);
    } catch (e) {
      tunnelLog("[bootstrap] pylibs resolve failed: " + e.message);
      return { ok: false, error: "cannot obtain wheels for target: " + e.message };
    }
  }
  // The gate has two halves, and the second one is the field's fix: VERSION is a
  // marker this client wrote (so it can only report the last install that got
  // as far as writing it), and the tree is the truth the marker stands for. A
  // remote whose marker matches but whose tree does not is an install, not a
  // no-op — see TREE_PROBE_CMD for what the tree is asked and why it is
  // believed over the file.
  const versionMatches = probe.installedVersion === version;
  const treeSound = strategy !== "pylibs" || pylibsTreeSound(probe.pylibsTree);
  const installed = versionMatches && treeSound;
  tunnelLog(
    `[bootstrap] strategy=${strategy} version=${version.slice(0, 12)}… installed=${installed}` +
      (versionMatches && !treeSound
        ? `; the VERSION file matches but its tree does not (${probe.pylibsTree}) — installing over it`
        : "")
  );

  const home = probe.home || "~";
  const dir = `${home}/.clutch-server`;
  state.lastStrategy = strategy;
  state.lastHome = home;
  state.lastProbe = probe; // the healer restarts with the same target's spellings

  let reinstalled = false;
  if (!installed) {
    // announced HERE, not before this call: a reconnect to a remote that
    // already runs our version is not an install, and saying "Installing
    // remote server…" for it was the reported lie on every retry
    if (progress) progress("install");
    if (strategy === "pylibs") {
      // the bytes, fetched only now that there really is an install to do — and
      // before the remote's old server is stopped, so a failed transfer leaves
      // it running
      if (progress) progress("install:fetch");
      try {
        artifact = (await ensurePyLibsTar(target)).path;
      } catch (e) {
        tunnelLog("[bootstrap] pylibs fetch failed: " + e.message);
        return { ok: false, error: "cannot obtain wheels for target: " + e.message };
      }
    }
    // the NAS refuses to truncate an executing binary in place: stop first
    await remoteExec(`mkdir -p ${dir}`);
    tunnelLog("[bootstrap] stopping old server before reinstall");
    const stopped = await stopServer(probe, strategy);
    if (!stopped.ok) {
      tunnelLog("[bootstrap] the old server would not let go of the port:\n" + stopped.diag);
      return {
        ok: false,
        error:
          `the remote still holds port ${REMOTE_API_PORT} after a stop (${stopped.diag || "no owner found"}) — ` +
          "something is running there that this client cannot replace. Free the port and reconnect.",
      };
    }
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
      // pylibs: the target-platform site-packages tar, fetched when this install was decided
      tunnelLog(`[bootstrap] uploading pylibs ${path.basename(artifact)}`);
      if (progress) progress("install:upload");
      await uploadFile(artifact, `${dir}/pylibs.tar.gz`);
      // the unpack-and-swap is a chain of shell steps that can fail as a whole
      // (a truncated upload, a tar that carries only one of the two trees): its
      // exit status is the only thing that says whether the trees actually
      // changed, and a VERSION file written over a tree that did not land is
      // exactly the lie this release is about. The install is reported, not
      // assumed — the marker is only reached on the path that succeeded.
      const landed = await remoteExec(pylibsInstallCmd(dir));
      if (landed.code !== 0) {
        const diag = (landed.stderr || landed.stdout || "").trim().slice(0, 400);
        tunnelLog(`[bootstrap] the pylibs install failed (exit ${landed.code}):\n` + diag);
        return {
          ok: false,
          error:
            "the remote could not unpack the wheels (exit " +
            landed.code +
            (diag ? ": " + diag : "") +
            "). Nothing was replaced — the far side's tree is the one it had.",
        };
      }
    }
    await remoteExec(`echo ${version} > ${dir}/VERSION && echo ${strategy} > ${dir}/STRATEGY`);
    tunnelLog("[bootstrap] installed");
    reinstalled = true;
  }

  // ensure the server runs the freshly installed code — and that it ANSWERS.
  // The port alone is not enough: a supervisor left wedged by an earlier
  // session holds the socket with nothing behind it, so a port-only check
  // skipped the restart and the connect then died at the health gate on every
  // attempt, forever, until someone restarted the remote box.
  const before = await remoteServingState(probe);
  if (reinstalled || before === "DOWN" || before === "WEDGED") {
    if (before === "WEDGED") {
      tunnelLog(`[bootstrap] port ${REMOTE_API_PORT} is bound but not answering — replacing its process`);
      const stopped = await stopServer(probe, strategy);
      if (!stopped.ok) {
        tunnelLog("[bootstrap] the wedged server would not let go of the port:\n" + stopped.diag);
        return {
          ok: false,
          error:
            `the remote port ${REMOTE_API_PORT} is held by a process that does not answer and cannot be ` +
            `stopped (${stopped.diag || "no owner found"}). Free the port and reconnect.`,
        };
      }
    }
    tunnelLog("[bootstrap] starting server");
    if (progress) progress("install:start");
    // short timeout: the start command backgrounds the server
    await remoteExec(startCommand(strategy, home), 10000);
    // wait for it to answer; pylibs cold-start imports the whole wheel stack
    // and can take >10s on slow servers, so poll for up to 20s (vs the old 6s
    // window that reported a healthy install as "did not come up")
    let after = "DOWN";
    for (let i = 0; i < 40; i++) {
      after = await remoteServingState(probe);
      if (after === "SERVING" || after === "UNMEASURABLE") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (after !== "SERVING" && after !== "UNMEASURABLE") {
      let diag = "";
      try {
        const d = await remoteExec(
          `tail -n 40 /tmp/clutch-server.log 2>/dev/null; ` +
            `ls -la ${dir}/agent-supervisor ${dir}/agent-server 2>&1; ` +
            `ps ax 2>/dev/null | grep -E '[a]gent[.-](supervisor|server)' | head -5`
        );
        diag = (d.stdout || "").slice(0, 800);
      } catch (e) {
        /* best effort */
      }
      tunnelLog("[bootstrap] remote supervisor did not come up; log:\n" + diag);
      return {
        ok: false,
        error:
          "the remote Clutch supervisor failed to start on port " + REMOTE_API_PORT +
          ` (state: ${after})` +
          (diag ? ` (remote log: ${diag.replace(/\n/g, " | ")})` : ""),
      };
    }
  } else {
    tunnelLog(`[bootstrap] server already running (${before.toLowerCase()})`);
  }
  return { installed: true, strategy };
}

// Every spelling the far side's server can take. The bracket guards keep pkill
// from matching its own shell (and the calling exec's), and the list must cover
// the pip/pylibs spelling too: `python3 -m agent.supervisor` matches NONE of
// the bundle names. Missing it was the reconnect bug — the old supervisor kept
// 8890, the replacement died with "cannot bind 127.0.0.1:8890 — port in use",
// and since the port still answered, every later attempt skipped the install
// and failed at the health gate: only restarting the remote box cleared it.
const SERVER_PATTERNS = [
  "[a]gent-supervisor", // bundle: ~/.clutch-server/agent-supervisor
  "[a]gent-server", // bundle: ~/.clutch-server/agent-server
  "[a]gent\\.supervisor", // pylibs: python3 -m agent.supervisor
  "[a]gent\\.server", // pylibs: python3 -m agent.server (its session children)
];

function stopServerCmd(strategy, signal = "") {
  void strategy;
  const flag = signal ? `${signal} ` : "";
  return SERVER_PATTERNS.map((p) => `pkill ${flag}-f '${p}' 2>/dev/null`).join("; ") + "; true";
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
  TREE_PROBE_CMD,
  parseProbe,
  pylibsTreeSound,
  pylibsInstallCmd,
  startCommand,
  stopServerCmd,
  stopServer,
  remoteRunningCmd,
  remoteServingState,
  chooseStrategy,
  installServer,
  installComponents,
};
