// GENERATED FILE — do not edit; edit src/host/tunnel-bootstrap.ts and run `npm run build:host`.
// source sha256: 6642447e93c6a1829730b870bfb58bf962172b07caa405973a05a51c3a6d4ea0

"use strict";
// make the far side exist — probe, choose a strategy, install, start
//
// One exec prints every fact the decision needs; chooseStrategy turns that
// into "bundle" (same platform, and a local bundle is available) or "pylibs"
// (the far side's own code, run by the remote's python3). The version of the
// artifact we ship is the
// only install gate, so a remote already running it is left alone. Components
// go last on purpose: they are code the far side runs on its own machine, and
// the connect must not wait on the upload.
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const fs = require("fs");
const { tunnelLog, REMOTE_API_PORT } = require("./tunnel-core");
const { platformTag, ensureBundle, ensurePyLibsTar, resolvePyLibsVersion, hasLocalBundle } = require("./server-bundle");
const components = require("./components");
function attach(ctx) {
    // (the body below keeps the module's own indentation: this move lifted it whole,
    // and re-indenting 300-800 lines would have rewritten a diff whose point is that
    // nothing in them changed)
    const state = ctx.st;
    const { remoteExec, uploadFile } = ctx.remote;
    // ---- bootstrap ----
    // How long a stopped remote server gets to let go of 8890 before we insist
    // (SIGKILL) and, past even that, report the process that is still holding it.
    // The env override keeps the test suite from spending the grace twice per case.
    const STOP_GRACE_MS = Number(process.env.CLUTCH_TUNNEL_STOP_GRACE_MS || 5000);
    // The bytes an artifact will put on the wire — what the upload's fraction is
    // measured against. A file we cannot stat is counted as zero, which costs the
    // fraction, never the transfer.
    function fileSize(p) {
        try {
            return fs.statSync(p).size;
        }
        catch (e) {
            return 0;
        }
    }
    // ---- which python? ----
    //
    // The tunnel's commands run through ssh2's `exec`, which is a NON-LOGIN,
    // NON-INTERACTIVE shell: it sources no profile, so it inherits the bare PATH
    // sshd hands it. On a machine whose python3 lives in a conda/miniforge prefix —
    // the SeetaCloud/AutoDL GPU images are built that way, and the field's
    // region-46 host is one — `command -v python3` answers nothing there while the
    // user's own terminal answers /root/miniconda3/bin/python3 all day. The old
    // probe asked that one question, believed the empty answer, and refused the
    // connect with "without python3 … no bundle for this platform" — a statement
    // about the shell this client gets, not about the machine (the report: an x86_64
    // box with everything needed to install).
    //
    // The component layer already settled this exact question for the same reason
    // (agent/tools/modules.py `_login_shell_python`: CLUTCH_PYTHON, then PATH, then
    // a login shell). So the probe asks in the same order — the exec's PATH, then
    // the prefixes a profile would have put there, then a login shell — and REPORTS
    // THE PATH it found, because every later command (the unpack, the start, the
    // port and health checks) runs in that same bare shell and has to be handed the
    // path rather than the name `python3`, which is exactly what PATH is missing.
    //
    // A candidate is accepted only if it ANSWERS as a python 3: `python3-config`
    // matches a `python3.*` glob and `python` may be python 2, and either would be
    // found by the shell and then fail every command built from it.
    const PY_CANDIDATES = [
        '"$(command -v python3 2>/dev/null)"',
        '"$(command -v python 2>/dev/null)"',
        // the prefixes a profile (conda init, venv activate, pyenv, homebrew) puts on
        // PATH for an interactive shell, by their usual homes
        '"$HOME/miniconda3/bin/python3"',
        '"$HOME/anaconda3/bin/python3"',
        '"$HOME/miniforge3/bin/python3"',
        '"$HOME/mambaforge/bin/python3"',
        '"$HOME/.venv/bin/python3"',
        '"$HOME/venv/bin/python3"',
        '"/opt/conda/bin/python3"',
        '"/opt/venv/bin/python3"',
        '"/usr/local/bin/python3"',
        '"/usr/bin/python3"',
        // …and the same directories' versioned spellings, where the unversioned name
        // is the thing that was never created (an image that installed 3.10 only)
        '"$HOME/miniconda3/bin/python3."*',
        '"$HOME/anaconda3/bin/python3."*',
        '"/opt/conda/bin/python3."*',
        '"/usr/local/bin/python3."*',
        '"/usr/bin/python3."*',
    ];
    // One section, three answers: the version (or NONE), then the absolute path the
    // version came from. `$PY` stays set for the sections after this one, so the
    // tree probe and the network check ask the SAME interpreter — and it is left as
    // the name `python3` when nothing was found, so those sections still answer
    // NOPY/NO instead of vanishing.
    // The last ask, and the general one: the machine's own LOGIN shell. `bash -lc`
    // sources the profile, which is the only place conda init / pyenv / a venv
    // activation puts itself on PATH — the same question agent/tools/modules.py asks
    // (LOGIN_PROBE) for the same reason. Its stdout is filtered to an absolute
    // `…/python[0-9.]*` line, because a profile is free to print anything else, and
    // `timeout` bounds the wait: a profile that blocks would otherwise hang the one
    // exec the whole connect is waiting on.
    const PY_LOGIN_PROBE_CMD = `{ Q='command -v python3 || command -v python'; ` +
        `(command -v timeout >/dev/null 2>&1 && timeout 10 bash -lc "$Q") || bash -lc "$Q"; } ` +
        `2>/dev/null </dev/null | grep -E '^/.*python[0-9.]*$' | tail -n 1`;
    const PY_PROBE_CMD = `echo "__PY__"; PY=; VER=
for p in ${PY_CANDIDATES.join(" ")}; do
  case "$p" in
    /*) v=$("$p" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)
        case "$v" in 3.[0-9]*) PY="$p"; VER="$v"; break;; esac;;
  esac
done
if [ -z "$PY" ]; then
  PY=$(${PY_LOGIN_PROBE_CMD})
  case "$PY" in
    /*) v=$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)
        case "$v" in 3.[0-9]*) VER="$v";; *) PY=;; esac;;
    *) PY=;;
  esac
fi
if [ -n "$PY" ]; then echo "$VER"; echo "$PY"; else echo NONE; PY=python3; fi`;
    // Does the far side's tree still vouch for itself? A file WE wrote cannot: the
    // field's broken remote held a VERSION that matched ours exactly (so every
    // reconnect skipped the install — the gate is "the marker equals our hash") over
    // a site-packages that was a MERGE of three releases, and the far side's server
    // died on `import pydantic` before it could bind. So the tree is asked the three
    // questions a marker cannot answer, all far cheaper than the transfer they
    // avoid:
    //
    //   * are both trees there at all? (`agent/` and `site-packages/` — the install
    //     swaps both, so a marker over one of them is a marker over nothing)
    //   * is any project carrying more than one dist-info? An install that unpacks
    //     ON TOP of a live tree leaves the previous generation's metadata (and the
    //     modules the new release does not ship) behind forever; two generations on
    //     one tree is what a merge is, and it is visible from the names alone. The
    //     tar ships no third-party wheel any more (pyproject.toml), so on a tree
    //     this client installed the directory is empty — the scan now guards the
    //     upgrade path off a tree an OLDER release left behind;
    //   * does the far side's own server import on the far side's python? That is
    //     `python3 -m agent.supervisor`'s first act (see remoteStartCmd), and it is
    //     the one question that separates "the bytes landed" from "they run here":
    //     a half-swapped tree fails with ImportError, and a python older than the
    //     sources fail with SyntaxError.
    //
    // One token, and neither the program nor anything it prints contains `__`: the
    // probe's sections are delimited by it. NONE = the VERSION file describes a tree
    // that is not there; NOPY = no python3 to ask with (not a verdict about the
    // tree). The import is caught by NAME rather than reflected off the exception
    // (type(exc).__name__ is the one dunder that would put the delimiter in the
    // program).
    const TREE_PROBE_CMD = `echo "__TREE__"; [ -n "$PY" ] || PY=python3; PYTHONPATH="$HOME/.clutch-server/site-packages" "$PY" -c '
import os, sys
d = os.path.join(os.environ.get("HOME", ""), ".clutch-server")
sp = os.path.join(d, "site-packages")
if not (os.path.isdir(sp) and os.path.isdir(os.path.join(d, "agent"))):
    print("NONE")
    raise SystemExit(0)
names = [x[:-10].rsplit("-", 1)[0] for x in os.listdir(sp) if x.endswith(".dist-info")]
dups = sorted(set(n for n in names if names.count(n) > 1))
if dups:
    print("DUP:" + ",".join(dups[:4]))
    raise SystemExit(0)
sys.path.insert(0, d)
try:
    import agent.server
except SyntaxError:
    print("IMPORT:SyntaxError")
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
        PY_PROBE_CMD,
        'echo "__LIBC__"; (ldd --version 2>&1 | head -1 | grep -qi musl && echo musl) || ([ -f /etc/alpine-release ] && echo musl) || (ldd --version 2>&1 | head -1 | grep -qE "GLIBC|glibc|GNU libc" && echo glibc) || echo unknown',
        'echo "__PATH__"; echo "$PATH"',
        'echo "__VER__"; (cat "$HOME/.clutch-server/VERSION" 2>/dev/null) || echo NONE',
        'echo "__STRATEGY__"; (cat "$HOME/.clutch-server/STRATEGY" 2>/dev/null) || echo NONE',
        'echo "__ART__"; (test -x "$HOME/.clutch-server/agent-server" -a -x "$HOME/.clutch-server/agent-supervisor" && echo bundle || true); (test -x "$HOME/.clutch-server/venv/bin/python" && echo pip || true); (test -d "$HOME/.clutch-server/site-packages" && echo pylibs || true)',
        TREE_PROBE_CMD,
        'echo "__NET__"; ("${PY:-python3}" -c "import urllib.request;urllib.request.urlopen(\'https://pypi.org\',timeout=3);print(\'OK\')" 2>/dev/null) || echo NO',
        'echo "__TMP__"; (test -w /tmp && echo YES) || echo NO',
    ].join("; ");
    function parseProbe(out) {
        const section = (marker) => {
            const parts = out.split(marker);
            return parts.length > 1 ? parts[1].split("__")[0].trim() : "";
        };
        const arts = out.split("__ART__").pop().split("\n").map((s) => s.trim()).filter(Boolean);
        // the interpreter section is TWO lines when one was found: the version, then
        // the absolute path every later command has to be handed (PY_PROBE_CMD). A
        // line is a version only if it looks like one and a path only if it is
        // absolute: the far side filters the login shell's answer, but a profile's
        // own chatter reaches this string unfiltered, and nothing here is trusted by
        // position.
        const pyLines = section("__PY__").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return {
            os: section("__OS__"),
            arch: section("__ARCH__"),
            home: section("__HOME__"),
            osrel: section("__OSREL__"),
            python: pyLines.find((s) => /^\d+\.\d+$/.test(s)) || "",
            pythonPath: pyLines.find((s) => s.startsWith("/")) || "",
            libc: section("__LIBC__"),
            // what a NON-LOGIN shell sees, which is how a python3 that only a profile
            // knows about goes missing (reported in the refusal, so it is answerable)
            path: section("__PATH__"),
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
    // The interpreter every far-side command must name: the one the probe FOUND
    // (an absolute path), never the bare `python3` that PATH is missing. Only a
    // path that is absolute, free of quoting hazards and named like an interpreter
    // is used; anything else — no probe, a path with a space, an alias a shell
    // echoed — falls back to the name, which is what the old code always used and
    // is still right for the ordinary case (a system python3 on PATH).
    function pyBin(probe) {
        const p = String((probe && probe.pythonPath) || "");
        if (/^\/[A-Za-z0-9._/+-]+$/.test(p) && /(^|\/)python[0-9.]*$/.test(p))
            return p;
        return "python3";
    }
    function startCommand(strategy, home, probe) {
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
        // pylibs: the remote runs its own code now (no wheel stack to import, so the
        // cold start is a bare `import agent.supervisor`), but a slow disk or a busy
        // server can still take seconds before the port answers — keep the idle
        // reaper at 25s (> the 20s start poll). NOTE: argparse takes the LAST
        // --idle-timeout, so never append a second one after ${args}.
        return `cd ${home}/.clutch-server && ${nohup}env PYTHONPATH=site-packages ${pyBin(probe)} -m agent.supervisor ${args} ${logredir}`;
    }
    function remoteRunningCmd(probe) {
        if (probe && probe.python) {
            return `${pyBin(probe)} -c "import socket;s=socket.socket();s.settimeout(1);s.connect(('127.0.0.1',${REMOTE_API_PORT}));print('UP')" 2>/dev/null || echo DOWN`;
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
            return `${pyBin(probe)} -c "import urllib.request;print(urllib.request.urlopen('${url}',timeout=3).status)" 2>/dev/null || echo DOWN`;
        }
        return `(command -v curl >/dev/null && (curl -fsS -m 3 -o /dev/null '${url}' && echo 200 || echo DOWN)) || echo UNKNOWN`;
    }
    // What is on the far side's port: DOWN (nobody), WEDGED (bound, silent),
    // SERVING (answers), UNMEASURABLE (no python3 and no curl to ask with — a
    // remote whose answer we cannot hear must not be mistaken for a dead one).
    //
    // `timeoutMs` is the budget for EACH ask. The healer passes one because it is
    // asking over a wire that just failed and its round has a clock of its own:
    // remoteExec's default is a minute per ask, so a heal round on a dead hop used to
    // sit here for two of them (the 2-minute gap in the field log between "backend
    // unreachable" and the teardown it eventually caused).
    async function remoteServingState(probe, timeoutMs) {
        const ask = (cmd) => remoteExec(cmd, timeoutMs);
        const out = (await ask(remoteRunningCmd(probe))).stdout || "";
        if (!out.includes("UP"))
            return out.includes("UNKNOWN") ? "UNMEASURABLE" : "DOWN";
        const h = (await ask(remoteHealthCmd(probe))).stdout || "";
        if (h.includes("200"))
            return "SERVING";
        if (h.includes("UNKNOWN"))
            return "UNMEASURABLE";
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
            }
            catch (e) {
                tunnelLog("[bootstrap] port check failed: " + ((e && e.message) || e));
            }
            if (!out.includes("UP"))
                return out.includes("UNKNOWN") ? "UNKNOWN" : "DOWN";
            if (Date.now() >= deadline)
                return "UP";
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
        }
        catch (e) {
            return { ok: false, state: "UNREACHABLE", diag: "the tunnel could not run the stop: " + ((e && e.message) || e) };
        }
        let verdict = await waitForRemotePortFree(probe, STOP_GRACE_MS);
        if (verdict !== "UP")
            return { ok: true, state: verdict };
        tunnelLog(`[bootstrap] port ${REMOTE_API_PORT} still held after SIGTERM — SIGKILL`);
        try {
            await remoteExec(stopServerCmd(strategy, "-9"));
        }
        catch (e) {
            return { ok: false, state: "UNREACHABLE", diag: "the tunnel died holding the port: " + ((e && e.message) || e) };
        }
        verdict = await waitForRemotePortFree(probe, STOP_GRACE_MS);
        if (verdict !== "UP")
            return { ok: true, state: verdict };
        let diag = "";
        try {
            const d = await remoteExec(`ps ax 2>/dev/null | grep -E '[a]gent[.-](supervisor|server)' | head -5; ` +
                `command -v ss >/dev/null && ss -ltnp 2>/dev/null | grep ':${REMOTE_API_PORT} ' || true`);
            diag = (d.stdout || "").trim().slice(0, 400);
        }
        catch (e) {
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
    // Cross-platform remotes use pylibs: the far side's own code (and an empty
    // site-packages) is unpacked client-side and run by the remote's own python3.
    function chooseStrategy(probe, localTag = platformTag()) {
        const [localOs, localArch] = localTag.split("-");
        if (String(probe.os || "").toLowerCase() === localOs &&
            probe.arch === localArch &&
            hasLocalBundle()) {
            // same-platform: self-contained bundle (remote python3 has segfaulted on a NAS)
            return "bundle";
        }
        if (probe.python)
            return "pylibs";
        return null;
    }
    // The interpreter floor the sources DECLARE (pyproject.toml `requires-python`,
    // mirrored by the 3.8 CI leg). It is stated here, once, because nothing else on
    // the supply line knows it: the artifact is interpreter-agnostic by construction
    // (scripts/build-pylibs-tar.sh) and the probe only reports whether a python3
    // exists at all. Without this check a 3.6 remote gets "pylibs" — it HAS a
    // python3 — installs, passes the import probe, and dies later on a construct the
    // 3.8 floor no longer allows, inside the user's first request instead of at the
    // door. Ubuntu 20.04's system python3 (3.8) is the case this floor exists for.
    const PY_FLOOR = [3, 8];
    // "3.6" -> too old; "" or an unparseable answer -> not a verdict about age (the
    // strategy check above/below already refuses a remote with no python3 at all).
    function pythonTooOld(python) {
        const m = /^(\d+)\.(\d+)$/.exec(String(python || "").trim());
        if (!m)
            return false;
        return Number(m[1]) * 100 + Number(m[2]) < PY_FLOOR[0] * 100 + PY_FLOOR[1];
    }
    // What the tree said about itself (TREE_PROBE_CMD), read as "may I hand this
    // remote our code with no install?". Only the answers that mean "this tree
    // cannot serve" make it unsound:
    //
    //   NONE      the VERSION file describes a tree that is not there
    //   DUP:…     two releases merged on one tree (the field's shape)
    //   IMPORT:…  the far side's own code does not import on the far side's python
    //             (a half-swapped tree, or a python older than the sources)
    //
    // "NOPY" (no python3 to ask with) and an exec that came back without the section
    // are NOT verdicts about the tree, and an install forced on one of them would be
    // a guess: a pylibs install is refused outright on a remote without python3, so
    // nothing healthy is ever skipped by this default.
    function pylibsTreeSound(verdict) {
        const v = String(verdict || "").trim();
        if (!v || v === "NOPY" || v === "UNKNOWN")
            return true;
        return v === "OK";
    }
    // How the pylibs tar lands on the far side: by REPLACE, never by merge.
    //
    // The tar carries two top-level trees — `agent` (the far side's own code) and
    // `site-packages` (empty since the Python side went stdlib-only, but still a
    // tree the install swaps and the probes read) — and unpacking it OVER the live
    // ones is not an install. tarfile only adds and overwrites: every file the new
    // release does not ship (a module dropped from `agent/`, an older extension
    // module under the same name, the previous generation's `-<version>.dist-info`
    // from a release that still carried wheels) stays behind forever, and two
    // releases merged on one tree is a tree no import survives. That is the field's
    // "no backend": pydantic 2.13.5 beside pydantic_core 2.50.1 raising SystemError
    // at import, under a VERSION file that matched the release being connected to —
    // the wheels are gone, the shape a merge leaves behind is not.
    //
    // So: unpack into a staging directory ON THE SAME FILESYSTEM, check that BOTH
    // trees really arrived, and only then swap them in — `mv` inside one directory
    // is a rename, the old tree is deleted only after the new one is in place, and
    // every failure before the first `mv` leaves the live tree exactly as it was
    // (the staging directory is the only thing thrown away). The far side's server
    // is already stopped by the caller (see the note above), so nothing is reading
    // either tree while it is swapped.
    function pylibsInstallCmd(dir, probe) {
        const stage = `${dir}/pylibs.stage`;
        // the interpreter the probe found, not the name: the unpack runs in the same
        // bare shell that could not see a conda python3 by name (pyBin)
        const py = pyBin(probe);
        // the OLD tree is renamed aside first and removed last: a swap that dies
        // between the two renames leaves `site-packages.old` recoverable, not a hole
        const swap = (name) => `rm -rf ${dir}/${name}.old && (mv ${dir}/${name} ${dir}/${name}.old 2>/dev/null || true) && ` +
            `mv ${stage}/${name} ${dir}/${name} && rm -rf ${dir}/${name}.old`;
        const chain = [
            `rm -rf ${stage}`,
            `mkdir -p ${stage}`,
            `${py} -c "import tarfile;tarfile.open('${dir}/pylibs.tar.gz').extractall('${stage}')"`,
            // both trees before either swap: a tar that carries no `agent` (or no
            // site-packages) installs NOTHING rather than half of itself
            `test -d ${stage}/site-packages -a -d ${stage}/agent`,
            swap("site-packages"),
            swap("agent"),
            `rm -f ${dir}/pylibs.tar.gz`,
        ].join(" && ");
        // …and the staging tree is thrown away whatever happened. On success the swap
        // already removed it; on a failure it holds a half-unpacked copy of the tree
        // until the next attempt's own `rm -rf` — so the failure path clears it too,
        // and the exit status is preserved: a failed install is a nonzero exit, which
        // installServer now asks about by name.
        return `${chain} ; rc=$?; rm -rf ${stage}; test $rc -eq 0`;
    }
    // The refusal owes the user a TRUE sentence. The old one said "no bundle for
    // this platform is available", which was wrong twice over: the pylibs artifact's
    // bytes do not depend on the target label at all (scripts/build-pylibs-tar.sh
    // takes the label as an argument and ships the same tree for every one), and the
    // thing actually missing was an interpreter the probe could FIND — a fact about
    // the shell this client gets, not about the machine. The two are different
    // failures with different actions, so they are said apart: what was searched,
    // what that shell sees, and whether python is the whole story.
    const POSIX_OS = ["linux", "darwin", "freebsd", "openbsd", "netbsd", "solaris"];
    function noStrategyError(probe, localTag = platformTag(), forced = "") {
        const os = String(probe.os || "?").trim();
        const arch = String(probe.arch || "?").trim();
        const libc = probe.libc || "unknown";
        if (forced) {
            return (`the bootstrap was forced to "${forced}" (CLUTCH_TUNNEL_FORCE), which is not an install ` +
                `strategy. Unset it and reconnect: this target runs ${os}/${arch}` +
                (probe.python ? ` with python ${probe.python}` : "") +
                ".");
        }
        if (!POSIX_OS.includes(os.toLowerCase())) {
            return (`target runs ${os}/${arch} (${libc} libc). This client installs the server through a POSIX ` +
                "shell (tar, mkdir, mv), and no self-contained bundle is available for that platform here, " +
                "so the server cannot be installed on it. Connect to a Linux or macOS host instead.");
        }
        const searched = [
            "python3/python on the tunnel's own PATH",
            "the usual prefixes (miniconda3, anaconda3, miniforge3, mambaforge, /opt/conda, /opt/venv, " +
                "/usr/local/bin, /usr/bin — including versioned python3.x)",
            "a LOGIN shell's answer (bash -lc 'command -v python3')",
        ].join("; ");
        return (`target runs ${os}/${arch} (${libc} libc), and the PLATFORM is not the problem: the release's ` +
            "pylibs artifact carries no platform-specific code (its bytes are the same for every target " +
            "label), so a python 3.8+ on the device is all it needs. What could not be found is a python 3 " +
            "the tunnel can run it with. The tunnel runs non-login, non-interactive commands, so it sees " +
            `PATH=${String(probe.path || "").trim() || "(empty)"}, and none of these answered: ${searched}. ` +
            "A python3 that exists only for interactive shells (conda init in ~/.bashrc, a venv's " +
            "activate, pyenv shims) is invisible to that shell. Install python 3 (apt install python3, or " +
            "the distribution's python3-venv), or make the one already on the machine reachable — on PATH, " +
            "or at one of the prefixes above (a conda install at ~/miniconda3/bin/python3 is found " +
            "automatically) — then reconnect.");
    }
    async function installServer(probe, { force, progress } = {}) {
        const localTag = platformTag();
        tunnelLog(`[bootstrap] probe os=${probe.os} arch=${probe.arch} libc=${probe.libc || "?"} ` +
            `py=${probe.python || "none"}${probe.pythonPath ? " (" + probe.pythonPath + ")" : ""} ` +
            `local=${localTag}`);
        if (!probe.python) {
            // the one fact the refusal is about: a shell that sees this PATH is where a
            // conda/pyenv/venv python3 goes missing, and it cannot be seen after the
            // fact — the tunnel is torn down with the verdict
            tunnelLog("[bootstrap] no python 3 answered the probe; the non-login shell sees PATH=" +
                (String(probe.path || "").trim().slice(0, 300) || "(empty)"));
        }
        let strategy;
        if (force) {
            strategy = force;
        }
        else if (process.env.CLUTCH_TUNNEL_FORCE) {
            strategy = process.env.CLUTCH_TUNNEL_FORCE;
        }
        else {
            strategy = chooseStrategy(probe, localTag);
        }
        if (strategy !== "bundle" && strategy !== "pylibs") {
            // e.g. no python3: there is no deterministic install path, so the hop cannot
            // serve a session at all (an explicit CLUTCH_TUNNEL_FORCE=assist lands here
            // too — noStrategyError says which of the two it is)
            return {
                ok: false,
                error: noStrategyError(probe, localTag, force || process.env.CLUTCH_TUNNEL_FORCE || ""),
            };
        }
        // The declared floor, checked only where it applies: "bundle" is a
        // self-contained build that never runs the remote's python3, so an old
        // interpreter there is not a reason to refuse.
        if (strategy === "pylibs" && pythonTooOld(probe.python)) {
            return {
                ok: false,
                error: `target runs python ${probe.python}${probe.pythonPath ? " at " + probe.pythonPath : ""} ` +
                    `(${probe.os}/${probe.arch}, ${probe.libc || "?"} libc), and the ` +
                    `server's sources declare python ${PY_FLOOR.join(".")} or newer. ` +
                    "Install a newer python3 on the device to connect to it.",
            };
        }
        // content-hash version is the only install gate: installed iff the remote's
        // VERSION equals our binaries' hash
        const target = { os: probe.os, arch: probe.arch, libc: probe.libc || "unknown" };
        let artifact;
        let version;
        if (strategy === "bundle") {
            artifact = await ensureBundle();
            version = artifact.version;
        }
        else {
            // the gate asks WHICH artifact this release ships, not for its bytes: on the
            // phone that is the few-KB release catalogue, so a remote that already runs
            // this release is recognised without the multi-megabyte tar moving at all.
            // Fetching the tar here made every check a transfer — and on a phone link
            // that transfer IS the connect (report #5).
            try {
                version = await resolvePyLibsVersion(target);
            }
            catch (e) {
                tunnelLog("[bootstrap] pylibs resolve failed: " + e.message);
                return { ok: false, error: "cannot obtain the far side's artifact for target: " + e.message };
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
        tunnelLog(`[bootstrap] strategy=${strategy} version=${version.slice(0, 12)}… installed=${installed}` +
            (versionMatches && !treeSound
                ? `; the VERSION file matches but its tree does not (${probe.pylibsTree}) — installing over it`
                : ""));
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
            if (progress)
                progress("install");
            if (strategy === "pylibs") {
                // the bytes, fetched only now that there really is an install to do — and
                // before the remote's old server is stopped, so a failed transfer leaves
                // it running
                if (progress)
                    progress("install:fetch");
                try {
                    artifact = (await ensurePyLibsTar(target)).path;
                }
                catch (e) {
                    tunnelLog("[bootstrap] pylibs fetch failed: " + e.message);
                    return { ok: false, error: "cannot obtain the far side's artifact for target: " + e.message };
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
                    error: `the remote still holds port ${REMOTE_API_PORT} after a stop (${stopped.diag || "no owner found"}) — ` +
                        "something is running there that this client cannot replace. Free the port and reconnect.",
                };
            }
            // What the far side looks like BEFORE the bytes go out. A transfer that then
            // crawls (13 KB/s on 2026-11-21) or stops is a question about the host — a
            // full disk, a load average of 40, no memory left — and the answer has to be
            // in the log already, because a dying wire cannot be asked afterwards (the
            // failure path's own `df` never ran: the tunnel was gone by then).
            try {
                const facts = await remoteExec(`df -h ${dir} 2>&1 | tail -2; cat /proc/loadavg 2>/dev/null; free -m 2>/dev/null | head -2`);
                tunnelLog("[bootstrap] far side before the transfer:\n" + (facts.stdout || "").trim().slice(0, 600));
            }
            catch (e) {
                /* a host that cannot answer this is still a host to install on */
            }
            if (strategy === "bundle") {
                const { server, supervisor } = artifact;
                tunnelLog(`[bootstrap] uploading bundle ${path.basename(server)} + supervisor`);
                // The transfer is 78 MB of binary over whatever link the user has, so it
                // reports its own fraction: a bar that sits at one number for a minute is
                // indistinguishable from a hung connect. The supervisor counts into the
                // same fraction, so the bar never goes backwards between the two files.
                // The rate and the time left come from the file being sent and are scaled
                // to what is left of BOTH: they are the only thing that tells a throttled
                // remote (13 KB/s, ~100 minutes) apart from a broken one.
                const sizes = [fileSize(server), fileSize(supervisor)];
                const totalBytes = sizes[0] + sizes[1];
                let base = 0;
                let lastBps = 0;
                const report = (done, info) => {
                    if (!progress)
                        return;
                    const moved = base + done;
                    const frac = totalBytes ? Math.min(1, moved / totalBytes) : 0;
                    // the first file's rate carries into the second: the bar must not lose
                    // its number in the gap between them
                    const bps = info && info.bps ? info.bps : lastBps;
                    if (bps)
                        lastBps = bps;
                    progress("install:upload", frac, {
                        bps,
                        eta: bps > 0 ? Math.max(0, Math.round((totalBytes - moved) / bps)) : 0,
                    });
                };
                if (progress)
                    progress("install:upload", 0);
                try {
                    // atomic rename over the old binary
                    await uploadFile(server, `${dir}/agent-server.new`, { onProgress: report });
                    base = sizes[0];
                    report(0, null);
                    await uploadFile(supervisor, `${dir}/agent-supervisor.new`, { onProgress: report });
                }
                catch (e) {
                    tunnelLog("[bootstrap] bundle upload failed: " + (e && e.message));
                    try {
                        const diag = await remoteExec(`ls -la ${dir} 2>&1; df -h ${dir} 2>&1 | tail -3`);
                        tunnelLog("[bootstrap] upload diagnostics:\n" + (diag.stdout || "").slice(0, 800));
                    }
                    catch (e2) {
                        /* diagnostics are best-effort */
                    }
                    throw e;
                }
                await remoteExec(`chmod +x ${dir}/agent-server.new ${dir}/agent-supervisor.new && ` +
                    `mv -f ${dir}/agent-server.new ${dir}/agent-server && ` +
                    `mv -f ${dir}/agent-supervisor.new ${dir}/agent-supervisor`);
            }
            else {
                // pylibs: the target-platform site-packages tar, fetched when this install was decided
                tunnelLog(`[bootstrap] uploading pylibs ${path.basename(artifact)}`);
                if (progress)
                    progress("install:upload", 0);
                await uploadFile(artifact, `${dir}/pylibs.tar.gz`, {
                    onProgress: (done, total, info) => {
                        if (!progress)
                            return;
                        const bps = info && info.bps ? info.bps : 0;
                        progress("install:upload", total ? Math.min(1, done / total) : 0, {
                            bps,
                            eta: bps > 0 ? Math.max(0, Math.round((total - done) / bps)) : 0,
                        });
                    },
                });
                // the unpack-and-swap is a chain of shell steps that can fail as a whole
                // (a truncated upload, a tar that carries only one of the two trees): its
                // exit status is the only thing that says whether the trees actually
                // changed, and a VERSION file written over a tree that did not land is
                // exactly the lie this release is about. The install is reported, not
                // assumed — the marker is only reached on the path that succeeded.
                const landed = await remoteExec(pylibsInstallCmd(dir, probe));
                if (landed.code !== 0) {
                    const diag = (landed.stderr || landed.stdout || "").trim().slice(0, 400);
                    tunnelLog(`[bootstrap] the pylibs install failed (exit ${landed.code}):\n` + diag);
                    return {
                        ok: false,
                        error: "the remote could not unpack the artifact (exit " +
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
        // A port we could not MEASURE is not a server we may skip. On a remote with no
        // python3 and no `ss` (the field's GPU box: probe py=none, and the port check's
        // own answer was UNKNOWN) that is the only verdict there is, and reading it as
        // "already running" made the connect unwinnable: the supervisor reaps itself
        // 25s after its last session (`--idle-timeout 25`, agent/procmgr/supervise.py),
        // so by the next connect nothing was listening — and this gate, the ONLY place
        // that ever starts it, kept concluding "server already running (unmeasurable)"
        // and skipping the start. Seven attempts in one field log died at the health
        // gate with "backend not reachable on the remote host" over a remote whose
        // install was intact and whose port was empty. So an unmeasurable port starts
        // the server too: a start when one IS already running costs nothing (the far
        // side's bind is refused, that process exits, and the supervisor holding the
        // port keeps answering), while a start skipped when nothing is running cannot
        // be recovered anywhere else in this client.
        if (reinstalled || before === "DOWN" || before === "WEDGED" || before === "UNMEASURABLE") {
            if (before === "WEDGED") {
                tunnelLog(`[bootstrap] port ${REMOTE_API_PORT} is bound but not answering — replacing its process`);
                const stopped = await stopServer(probe, strategy);
                if (!stopped.ok) {
                    tunnelLog("[bootstrap] the wedged server would not let go of the port:\n" + stopped.diag);
                    return {
                        ok: false,
                        error: `the remote port ${REMOTE_API_PORT} is held by a process that does not answer and cannot be ` +
                            `stopped (${stopped.diag || "no owner found"}). Free the port and reconnect.`,
                    };
                }
            }
            tunnelLog("[bootstrap] starting server");
            if (progress)
                progress("install:start");
            // short timeout: the start command backgrounds the server
            await remoteExec(startCommand(strategy, home, probe), 10000);
            // wait for it to answer; a cold start on a slow server (first import of the
            // sources, a phone-class disk) can take a while, so poll for up to 20s (vs
            // the old 6s window that reported a healthy install as "did not come up")
            let after = "DOWN";
            for (let i = 0; i < 40; i++) {
                after = await remoteServingState(probe);
                if (after === "SERVING" || after === "UNMEASURABLE")
                    break;
                await new Promise((r) => setTimeout(r, 500));
            }
            if (after !== "SERVING" && after !== "UNMEASURABLE") {
                let diag = "";
                try {
                    const d = await remoteExec(`tail -n 40 /tmp/clutch-server.log 2>/dev/null; ` +
                        `ls -la ${dir}/agent-supervisor ${dir}/agent-server 2>&1; ` +
                        `ps ax 2>/dev/null | grep -E '[a]gent[.-](supervisor|server)' | head -5`);
                    diag = (d.stdout || "").slice(0, 800);
                }
                catch (e) {
                    /* best effort */
                }
                tunnelLog("[bootstrap] remote supervisor did not come up; log:\n" + diag);
                return {
                    ok: false,
                    error: "the remote Clutch supervisor failed to start on port " + REMOTE_API_PORT +
                        ` (state: ${after})` +
                        (diag ? ` (remote log: ${diag.replace(/\n/g, " | ")})` : ""),
                };
            }
        }
        else {
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
    //
    // The same pass runs the other way too: a component the far side holds while the
    // market no longer asks it for — retired, or moved to the client — is let go
    // there (ui/components.js `retireComponents`), one DELETE per name and one log
    // line each. It is the same promise as above and not a separate cleaner: the
    // name it hands over and the name it takes back are both the market's answer.
    //
    // `onPass` receives that answer, because the log is a file and a removal is
    // something a user has to be able to SEE: the plugin tab draws the names this
    // pass let go of (ui/js/components-panel.js). No second pass and no second
    // summary — the page reads the one pass and the one log line.
    function installComponents(base) {
        // The pass's answer goes to the log and nowhere else. It is a thing that
        // happened to ONE machine at ONE moment, and it used to travel to the plugin tab
        // as `state.componentsPass` — a second, older picture of what a place holds,
        // drawn under a list that had just been read. What a place holds is its own
        // inventory (ui/src/host/components-view.ts `list`); what the pass did is an
        // event, and ~/.clutch/tunnel.log is where events live.
        Promise.resolve()
            .then(() => components.ensureComponents(base, { progress: (m) => tunnelLog("[components] " + m) }))
            .then((r) => {
            tunnelLog(`[components] current=${r.current.length} installed=${r.installed.length} ` +
                `skipped=${r.skipped.length} deferred=${r.deferred.length} ` +
                `retired=${r.retired.map((x) => x.name).join(",") || 0} errors=${r.errors.length}`);
            // a removal is a DELETE and leaves no row behind, so the reasons are said
            // here or nowhere: "the market moved it" must not read as "it vanished"
            for (const x of r.retired) {
                tunnelLog(`[components] let go of ${x.name}${x.version ? " " + x.version : ""} (${x.reason})`);
            }
            for (const e of r.errors) {
                tunnelLog(`[components] could not let go of ${e.name || "a component"} (${e.reason})`);
            }
        })
            .catch((e) => {
            tunnelLog("[components] pass failed: " + ((e && e.message) || e));
        });
    }
    return {
        PROBE_CMD,
        PY_PROBE_CMD,
        PY_LOGIN_PROBE_CMD,
        TREE_PROBE_CMD,
        parseProbe,
        pyBin,
        pylibsTreeSound,
        pylibsInstallCmd,
        startCommand,
        stopServerCmd,
        stopServer,
        remoteRunningCmd,
        remoteServingState,
        chooseStrategy,
        noStrategyError,
        installServer,
        installComponents,
    };
}
// The old direct-require names resolve against the primary tunnel; `attach` is
// this module's own export (see tunnel-core's compatSurface).
module.exports = require("./tunnel-core").compatSurface("bootstrap", [
    "PROBE_CMD",
    "PY_PROBE_CMD",
    "PY_LOGIN_PROBE_CMD",
    "TREE_PROBE_CMD",
    "parseProbe",
    "pyBin",
    "pylibsTreeSound",
    "pylibsInstallCmd",
    "startCommand",
    "stopServerCmd",
    "stopServer",
    "remoteRunningCmd",
    "remoteServingState",
    "chooseStrategy",
    "noStrategyError",
    "installServer",
    "installComponents",
], { attach });
