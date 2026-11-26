// WHICH python the tunnel drives the far side with — and the refusal it owes a
// host that has one the tunnel could not see.
//
// The field case (region-46.seetacloud.com, an x86_64 GPU box): SSH connected,
// and the client answered "target runs Linux/x86_64 without python3 … no bundle
// for this platform is available". The machine was fine; the QUESTION was wrong.
// The tunnel's commands go through ssh2's `exec`, a non-login, non-interactive
// shell, so a python3 that a profile puts on PATH (conda init, a venv activate,
// pyenv) is invisible — while the user's own terminal answers it all day. The
// component layer had already learned this (agent/tools/modules.py
// `_login_shell_python`); the probe had not.
//
// Everything here is the REAL shell: the shipped probe string is run against
// real sandbox homes, because the defect is what a shell does (or does not) put
// on PATH, and a fake shell could not show it.
//
//   1. a python3 that exists ONLY at ~/miniconda3/bin/python3, with a PATH that
//      does not contain it, is FOUND — with its absolute path;
//   2. a python3 that exists only where a LOGIN SHELL puts it is found too, and
//      the sandbox profile is the proof that the login shell was really asked;
//   3. when there is none, the probe says NONE (the strategy gate refuses) and
//      the refusal names what was searched, what PATH the shell sees, and never
//      claims the platform is unsupported;
//   4. the path the probe found is carried into EVERY command the bootstrap
//      builds — the unpack, the start, the port and health checks — because they
//      all run in that same bare shell, where `python3` by name is what was
//      missing;
//   5. pyBin is a gate, not a passthrough: only an absolute, quotable,
//      interpreter-named path is used; anything else falls back to the name the
//      old code always used.
//
// Run: node tests/remote-interpreter-test.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { check, summary } = require("./harness");
const {
  PROBE_CMD,
  PY_PROBE_CMD,
  PY_LOGIN_PROBE_CMD,
  TREE_PROBE_CMD,
  parseProbe,
  pyBin,
  startCommand,
  pylibsInstallCmd,
  remoteRunningCmd,
  noStrategyError,
} = require("../ui/tunnel-bootstrap");

// bash by ABSOLUTE path: one case runs the probe with a PATH that has no bash
// in it, which is the point (the shell it gets is the one under test).
const BASH = (spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout || "").trim();
const PY3 = (spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).stdout || "").trim();

function run(cmd, env) {
  return spawnSync(BASH || "bash", ["-c", cmd], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { PY: "" }, env || {}),
  });
}

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clutch-interp-"));
}

// ---- staging a machine that has NO python ----
//
// Two of the cases below are about a probe that must fall through to a login
// shell, and one about a probe that must come back empty. This host HAS
// /usr/bin/python3, and the probe looks in the usual prefixes by absolute path on
// purpose, so neither case can be staged by PATH alone. A private mount
// namespace makes those files /dev/null for the probe and its children only: the
// probe is the real shipped string, asking a real shell on a machine that really
// answers "not a python" — not a mock of one. Where the kernel refuses (unshare
// is not universal, and user namespaces are off in some CI), the two cases say so
// instead of pretending they ran.
const MASKED = [
  "/usr/bin/python3",
  "/usr/bin/python3.10",
  "/usr/bin/python3.10-config",
  "/usr/local/bin/python3",
].filter((p) => fs.existsSync(p));

function canMask() {
  if (process.platform !== "linux" || !MASKED.length) return false;
  const r = spawnSync(
    "unshare",
    ["-rm", "bash", "-c", `mount --bind /dev/null ${MASKED[0]} && ! ${MASKED[0]} -c '' 2>/dev/null`],
    { encoding: "utf8" }
  );
  return r.status === 0;
}

const MASK = canMask();

// the command goes in through the environment and `eval`: quoting the probe
// (which holds single quotes of its own) into the unshare string twice would be
// the only thing this helper could get wrong
function runMasked(cmd, env) {
  const mounts = MASKED.map((p) => `mount --bind /dev/null ${p} 2>/dev/null; `).join("");
  return run(
    `unshare -rm bash -c '${mounts}eval "$CLUTCH_UNDER_TEST"'`,
    Object.assign({}, env, { CLUTCH_UNDER_TEST: cmd })
  );
}

// a home whose ONLY interpreter is at ~/miniconda3/bin/python3 (the SeetaCloud /
// AutoDL shape), linked to this host's real python3 so it is a real interpreter
function condaHome() {
  const home = sandbox();
  fs.mkdirSync(path.join(home, "miniconda3", "bin"), { recursive: true });
  fs.symlinkSync(fs.realpathSync(PY3), path.join(home, "miniconda3", "bin", "python3"));
  return home;
}

function main() {
  if (process.platform === "win32" || !BASH || !fs.existsSync(PY3)) {
    console.log("SKIP: the probe is a POSIX shell command and needs a real python3");
    return;
  }
  const homes = [];
  try {
    // ---- 1. the reported host: python3 only under conda, PATH without it ----
    const conda = condaHome();
    homes.push(conda);
    const found = parseProbe(run(PY_PROBE_CMD, { HOME: conda, PATH: "/nonexistent" }).stdout);
    check(
      found.python === "3.10" || /^3\.\d+$/.test(found.python),
      `a conda-only python3 is FOUND, with its version (${found.python || "none"})`
    );
    check(
      found.pythonPath === path.join(conda, "miniconda3", "bin", "python3"),
      `…and the probe reports the PATH it came from (${found.pythonPath || "none"})`
    );
    check(
      found.python !== "" && pyBin(found) === found.pythonPath,
      "…so every command built from this probe names that file, not the bare name"
    );

    // the same home, through the whole probe: the interpreter AND a tree verdict
    const whole = parseProbe(run(PROBE_CMD, { HOME: conda, PATH: "/nonexistent" }).stdout);
    check(
      whole.python === found.python && whole.pythonPath === found.pythonPath,
      "the interpreter section answers the same inside the one-exec probe"
    );
    check(
      whole.pylibsTree === "NONE" && whole.pylibsTree !== "NOPY",
      "…and the tree probe RAN on that interpreter (no tree here, so NONE — NOPY would mean it never ran)"
    );
    check(
      typeof whole.path === "string",
      "the probe also reports the PATH the non-login shell sees (what the refusal quotes)"
    );

    // ---- 2. the general case: only a LOGIN shell knows where it is ----
    const login = sandbox();
    homes.push(login);
    const bin = path.join(login, "special", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(fs.realpathSync(PY3), path.join(bin, "python3"));
    // PATH is REPLACED, not extended: any answer other than the sandbox path
    // would prove the profile had not been read
    fs.writeFileSync(
      path.join(login, ".bash_profile"),
      "# the only place this machine's interpreter appears\nexport PATH=" + bin + "\n"
    );
    const viaLogin = run(PY_LOGIN_PROBE_CMD, { HOME: login });
    check(
      viaLogin.stdout.trim() === path.join(bin, "python3"),
      "a python3 only a profile puts on PATH is found by asking a login shell (" +
        (viaLogin.stdout.trim() || "nothing") + ")"
    );
    // …and the probe itself falls back to that ask when nothing on its PATH or at
    // a usual prefix answers. That needs a machine with no other python, so the
    // system ones are emptied out for the duration (see MASKED)
    if (MASK) {
      // a COPY of the interpreter, not a symlink to it: the namespace empties the
      // system file, and this home's profile has to offer a python that really runs
      const loginHome = sandbox();
      homes.push(loginHome);
      const loginBin = path.join(loginHome, "special", "bin");
      fs.mkdirSync(loginBin, { recursive: true });
      fs.copyFileSync(fs.realpathSync(PY3), path.join(loginBin, "python3"));
      fs.writeFileSync(
        path.join(loginHome, ".bash_profile"),
        "# the only place this machine's interpreter appears\nexport PATH=" + loginBin + "\n"
      );
      const loginProbe = parseProbe(
        runMasked(PY_PROBE_CMD, { HOME: loginHome, PATH: "/usr/bin:/bin" }).stdout
      );
      check(
        loginProbe.pythonPath === path.join(loginBin, "python3"),
        "…and that is the probe's LAST ask: with every prefix empty it asks the login shell (" +
          (loginProbe.pythonPath || "nothing") + ")"
      );
      check(
        /^3\.\d+$/.test(loginProbe.python),
        "…and the answer is verified as a python 3 before it is believed (" + loginProbe.python + ")"
      );
    } else {
      console.log("note: no mount namespace on this host — the last ask is proven by PY_LOGIN_PROBE_CMD above");
    }

    // ---- 3. nothing at all: an honest refusal ----
    // The same emptied-out machine, with no profile to rescue it: every prefix is
    // empty and the login shell's own /etc/profile answer is /usr/bin/python3,
    // which is now /dev/null — so a probe that believed the shell's path without
    // RUNNING it would report a python that cannot execute (part of what makes the
    // NONE case worth staging for real).
    if (MASK) {
      const empty = sandbox();
      homes.push(empty);
      const none = runMasked(PY_PROBE_CMD, { HOME: empty, PATH: "/usr/bin:/bin" });
      check(
        /\bNONE\s*$/.test(none.stdout.trim()),
        "with nothing to find, the interpreter section says NONE (" +
          (none.stdout.trim().split("\n").pop() || "nothing") + ")"
      );
      const noProbe = parseProbe(runMasked(PROBE_CMD, { HOME: empty, PATH: "/usr/bin:/bin" }).stdout);
      check(
        noProbe.python === "" && noProbe.pythonPath === "",
        "…which parseProbe reads as 'no interpreter', the only thing chooseStrategy refuses on"
      );
      check(
        noProbe.path === "/usr/bin:/bin",
        "…and the same probe still reports the PATH the refusal has to quote (" + noProbe.path + ")"
      );
    } else {
      console.log("note: no mount namespace on this host — the empty case rests on parseProbe('NONE') below");
    }

    const refusal = noStrategyError(
      { os: "Linux", arch: "x86_64", libc: "glibc", path: "/usr/local/bin:/usr/bin:/bin" },
      "windows-x86_64"
    );
    check(
      !/no bundle for this platform/i.test(refusal),
      "the refusal no longer claims there is no bundle for this platform (it was never true)"
    );
    check(
      /Linux\/x86_64/.test(refusal) && /glibc/.test(refusal) && /PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/.test(refusal),
      "…it names the target AND the PATH the non-login shell sees"
    );
    check(
      /miniconda3/.test(refusal) && /anaconda3/.test(refusal) && /LOGIN shell/i.test(refusal),
      "…and what was searched, including the login shell, so the next step is answerable"
    );
    check(
      /python 3\.8\+/.test(refusal) && /PLATFORM is not the problem/.test(refusal),
      "…and says the platform needs only a python, which is the useful half"
    );
    const forced = noStrategyError({ os: "Linux", arch: "x86_64", libc: "glibc" }, "linux-x86_64", "assist");
    check(
      /CLUTCH_TUNNEL_FORCE/.test(forced) && /assist/.test(forced),
      "a forced non-strategy is reported as the forced thing it is, not as a missing python"
    );
    const windows = noStrategyError({ os: "Windows", arch: "x86_64" }, "linux-x86_64");
    check(
      /POSIX shell/.test(windows) && !/without python3/.test(windows),
      "a Windows target is refused for the POSIX-install reason, not for a python it may well have"
    );

    // ---- 4. the path reaches every command ----
    const probe = { python: found.python, pythonPath: found.pythonPath };
    const start = startCommand("pylibs", "/home/u", probe);
    check(
      start.includes(found.pythonPath) && !/\benv PYTHONPATH=site-packages python3 /.test(start),
      "the start command runs the interpreter the probe found"
    );
    check(
      startCommand("pylibs", "/home/u").includes("env PYTHONPATH=site-packages python3 ") &&
        startCommand("bundle", "/home/u", probe).includes("agent-supervisor"),
      "…and falls back to the name only when there is no probe (the ordinary case)"
    );
    // the found path ENDS in "python3", so a bare `/\bpython3 -c/` would match the
    // very thing we want: the question is whether any command still names the
    // interpreter by NAME, i.e. after the path is taken out of the text
    const byName = (s) => s.split(found.pythonPath).join("<py>");
    const unpack = pylibsInstallCmd("/home/u/.clutch-server", probe);
    check(
      unpack.includes(found.pythonPath + " -c") && !/\bpython3 -c/.test(byName(unpack)),
      "the unpack-and-swap uses it too — it runs in the same bare shell"
    );
    const port = remoteRunningCmd(probe);
    check(
      port.startsWith(found.pythonPath + " -c") && !/\bpython3 -c/.test(byName(port)),
      "…and so do the port and health checks (a check is only a check if the interpreter runs)"
    );
    check(
      remoteRunningCmd({ python: "" }).includes("ss ") && remoteRunningCmd({ python: "" }).includes("UNKNOWN"),
      "a remote with no interpreter still gets the ss fallback, and UNKNOWN is still not DOWN"
    );

    // ---- 5. pyBin is a gate ----
    for (const bad of ["", "python3", "python3.11", "relative/python3", "/a b/python3", "/a'python3", "/usr/bin/python3-config"]) {
      check(pyBin({ pythonPath: bad }) === "python3", `pyBin refuses to interpolate ${JSON.stringify(bad)}`);
    }
    check(pyBin(null) === "python3" && pyBin({}) === "python3", "…and an absent probe is the name it always was");
    check(
      pyBin({ pythonPath: "/root/miniconda3/bin/python3" }) === "/root/miniconda3/bin/python3" &&
        pyBin({ pythonPath: "/usr/bin/python3.10" }) === "/usr/bin/python3.10",
      "…while a real absolute interpreter path is passed through"
    );

    // ---- 6. a profile may print; the answer is still the interpreter ----
    const chatty = parseProbe(
      '__PY__\nWelcome to this machine!\n3.11\n/opt/conda/bin/python3\n__LIBC__\nglibc\n'
    );
    check(
      chatty.python === "3.11" && chatty.pythonPath === "/opt/conda/bin/python3",
      "the interpreter section is read by SHAPE, not by position (a profile's banner is not a version)"
    );
    check(
      parseProbe("__PY__\nNONE\n__LIBC__\nglibc\n").python === "" &&
        parseProbe("__PY__\nNONE\n").pythonPath === "",
      "NONE is no interpreter, not a version named NONE"
    );

    // ---- 7. one exec, one interpreter ----
    check(
      PROBE_CMD.includes(PY_PROBE_CMD) && PROBE_CMD.includes(TREE_PROBE_CMD) && PROBE_CMD.includes("__PATH__"),
      "the interpreter is resolved in the probe's own exec (no extra round trip)"
    );
    check(
      TREE_PROBE_CMD.includes('"$PY"') && PROBE_CMD.includes('"${PY:-python3}"'),
      "…and the tree probe and the network check reuse it, so one connect never runs two pythons"
    );
    check(
      PROBE_CMD.indexOf("__PY__") < PROBE_CMD.indexOf("__PATH__") &&
        PROBE_CMD.indexOf("__PATH__") < PROBE_CMD.indexOf("__ART__"),
      "…before the sections that report on the machine it was found on"
    );
  } finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  }

  summary("remote-interpreter", "the probe finds the machine's python, and every command uses it");
}

main();
