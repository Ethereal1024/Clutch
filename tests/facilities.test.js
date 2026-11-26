// ui/facilities.js is the half of an install that makes a component RUNNABLE:
// the host tool its statements stand on (curl for the workspace file tools),
// installed on the machine that will run it. These checks drive the pure command
// and the shared runner against a fake exec, plus the local spawner for real.
// Run: node tests/facilities.test.js
const { check, summary } = require("./harness.js");
const facilities = require("../ui/facilities");

async function main() {
  // ---- 1. only the facilities with a package are this module's ----
  {
    check(
      JSON.stringify(facilities.installable(["python", "posix-shell", "curl", "curl", 7, ""])) === '["curl"]',
      "requires is filtered to the installable facilities, deduped (python and posix-shell are the server's own)"
    );
    check(facilities.installable(null).length === 0 && facilities.installable(["nope"]).length === 0, "nothing installable is an empty list, not a throw");
  }

  // ---- 2. the command: detect, then install through the named escalation ----
  {
    const far = facilities.facilityCommand("curl", "curl", "sudo");
    check(
      far.includes("command -v curl") && far.includes('PM="apt-get install -y"') && far.includes("$PM curl"),
      "the command checks presence before it installs anything"
    );
    check(far.includes('RUN="sudo -S sh -c"') && !far.includes("pkexec"), "a far machine escalates with sudo -S (the password rides on stdin)");
    check(far.includes("apt-get update -qq"), "an apt install gets one retry after an update");

    const here = facilities.facilityCommand("curl", "curl", "pkexec");
    check(here.includes("pkexec sh -c"), "this desktop prefers polkit's prompt (the same helper the app update uses)");
    check(here.includes('RUN="sudo -S sh -c"'), "and still has sudo as the fallback a root/passwordless box needs");
    check(here.includes('if [ "$(id -u)" = 0 ]; then RUN="sh -c"'), "root installs directly, with no prompt at all");
  }

  // ---- 3. the runner: verdicts are data, never a throw ----
  {
    const seen = [];
    const lines = [];
    const installed = await facilities.ensureFacilities(
      async (cmd, timeout, binary, stdin) => {
        seen.push({ cmd, timeout, binary, stdin });
        return { code: 0, stdout: "INSTALLED\n", stderr: "" };
      },
      ["curl", "python"],
      { secret: "s3cret", log: (m) => lines.push(m) }
    );
    check(seen.length === 1, "one exec per installable facility (python is not this module's to install)");
    check(seen[0].stdin === "s3cret\n", "the secret is handed to the exec as stdin, never the command line");
    check(seen[0].timeout > 0 && seen[0].binary === false, "the exec gets a bounded timeout and the text shape");
    check(installed.length === 1 && /installed curl/.test(installed[0]) && /installed curl/.test(lines[0]), "a success is one sentence, and the log hears it");

    const present = await facilities.ensureFacilities(
      async () => ({ code: 0, stdout: "PRESENT\n", stderr: "" }),
      ["curl"],
      { log: () => {} }
    );
    check(/already present/.test(present[0]), "a facility already there is reported, and nothing is installed");

    const failed = await facilities.ensureFacilities(
      async () => ({ code: 5, stdout: "", stderr: "E: Could not open lock file\n" }),
      ["curl"],
      { log: () => {} }
    );
    check(/could not install curl/.test(failed[0]) && /Could not open lock file/.test(failed[0]), "a refusal is the host's own last line, not a crash");

    const threw = await facilities.ensureFacilities(
      async () => {
        throw new Error("not connected");
      },
      ["curl"],
      { log: () => {} }
    );
    check(/could not install curl: not connected/.test(threw[0]), "an exec that threw is said, and does not undo the bytes it stands on");
  }

  // ---- 4. the local spawner is the same command on this machine ----
  {
    const r = await facilities.localExec("echo hi", 5000);
    check(r.code === 0 && r.stdout === "hi\n" && r.stderr === "", "localExec runs the command under /bin/sh and answers its output");
    const nonzero = await facilities.localExec("exit 7", 5000);
    check(nonzero.code === 7, `the command's own exit status comes back (${nonzero.code})`);
  }

  summary("facilities: a component's host tools, installed where the component runs");
}

main();
