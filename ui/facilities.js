// GENERATED FILE — do not edit; edit src/host/facilities.ts and run `npm run build:host`.
// source sha256: 49ef6e8d8d400ff40410860ce425b003afcfa6c4ce7542b89f4e1dcc9faf4410

// The host facilities a component's statements stand on, and the two ways this
// app installs one: over a far machine's SSH wire, or on THIS machine with the
// desktop's own privilege prompt.
//
// A component is code a machine RUNS, but some of its statements are spoken
// through a facility the component declares (`requires`, agent/tools/rendezvous.py
// `unavailable_reason`). clutch-workspace's four file tools are `curl` requests
// to its own loopback daemon: installed bytes without curl are a component the
// machine cannot DRIVE — `available:false`, no tools — while its row in the
// plugin list still says "installed". That is the whole reason this module
// exists: laying a component's bytes down is not the same act as making it
// runnable, and the second half belongs to whoever owns an exec channel to that
// machine.
//
// Only facilities with a package name are handled. `python` is the server's own
// interpreter (present by construction wherever a component with a `{py}` launch
// is installed) and `posix-shell` is the shell this very command already runs in,
// so neither can be the missing one; anything else is left alone rather than
// guessed at.
//
// The pure command (facilityCommand) is exported apart from the spawner so a test
// can read exactly what would run without installing anything.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process = require("child_process");
// facility -> the package that provides it, on every manager this app speaks.
const FACILITY_PACKAGES = { curl: "curl" };
// One POSIX-sh command. Present -> say so and stop. Else pick the machine's
// package manager, then install through the escalation its caller named:
//
//   sudo    the far side of a tunnel: `sudo -S` reading the password from stdin,
//           so the secret never sits in the remote process table
//   pkexec  THIS desktop: polkit's graphical prompt, the same helper the app's
//           own update uses (update-install.ts). A machine without pkexec falls
//           back to sudo -S, which is right for a root shell or a passwordless
//           sudoers rule and simply fails otherwise.
//
// An apt install that fails gets one retry after `apt-get update` — a fresh
// focal image can have a curl candidate while its lists are older than the pin.
function facilityCommand(facility, pkg, escalate = "sudo") {
    const ascent = escalate === "pkexec"
        ? `if [ "$(id -u)" = 0 ]; then RUN="sh -c"; elif command -v pkexec >/dev/null 2>&1; then RUN="pkexec sh -c"; else RUN="sudo -S sh -c"; fi`
        : `if [ "$(id -u)" = 0 ]; then RUN="sh -c"; else RUN="sudo -S sh -c"; fi`;
    return [
        `if command -v ${facility} >/dev/null 2>&1; then echo PRESENT; exit 0; fi`,
        `if command -v apt-get >/dev/null 2>&1; then PM="apt-get install -y"`,
        `elif command -v dnf >/dev/null 2>&1; then PM="dnf install -y"`,
        `elif command -v yum >/dev/null 2>&1; then PM="yum install -y"`,
        `elif command -v apk >/dev/null 2>&1; then PM="apk add"`,
        `elif command -v pacman >/dev/null 2>&1; then PM="pacman -S --noconfirm"`,
        `else echo NO_PACKAGE_MANAGER; exit 3; fi`,
        ascent,
        `$RUN "$PM ${pkg}" && { echo INSTALLED; exit 0; }`,
        `if command -v apt-get >/dev/null 2>&1; then $RUN "apt-get update -qq" && $RUN "$PM ${pkg}" && { echo INSTALLED; exit 0; }; fi`,
        `echo INSTALL_FAILED; exit 5`,
    ].join("; ");
}
// The facilities this module knows how to install, from a component's own
// `requires` list. Order kept (dedup only): a log reads the declaration's order.
function installable(requirements) {
    const seen = new Set();
    const out = [];
    for (const name of Array.isArray(requirements) ? requirements : []) {
        if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(FACILITY_PACKAGES, name))
            continue;
        if (seen.has(name))
            continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}
// Make sure the machine behind `exec` has every facility it can install.
//
// `exec(command, timeoutMs, binary, stdin)` answers `{code, stdout, stderr}`; it
// is the tunnel's `remoteExec` for a far machine and `localExec` below for this
// one. Returns the one-line verdicts (also handed to `log`), never throws: a
// facility this app could not install is said, not raised, because the bytes it
// stands on are already there and a failed dependency must not undo them.
async function ensureFacilities(exec, requirements, opts = {}) {
    const secret = typeof opts.secret === "string" ? opts.secret : "";
    const escalate = opts.escalate === "pkexec" ? "pkexec" : "sudo";
    const log = typeof opts.log === "function" ? opts.log : () => { };
    const out = [];
    for (const facility of installable(requirements)) {
        try {
            const r = await exec(facilityCommand(facility, FACILITY_PACKAGES[facility], escalate), 180000, false, secret ? secret + "\n" : "");
            const text = String((r && r.stdout) || "").trim();
            const err = String((r && r.stderr) || "").trim();
            let line;
            if (/PRESENT/.test(text)) {
                line = `${facility} is already present`;
            }
            else if (/INSTALLED/.test(text)) {
                line = `installed ${facility} (a component needs it to be drivable)`;
            }
            else {
                const why = (text || err || "no answer").split("\n").pop();
                line = `could not install ${facility}: ${why} (exit ${r && r.code})`;
            }
            out.push(line);
            log(`[components] ${line}`);
        }
        catch (e) {
            const line = `could not install ${facility}: ${(e && e.message) || e}`;
            out.push(line);
            log(`[components] ${line}`);
        }
    }
    return out;
}
// The SAME command, run on this machine by the app process. `/bin/sh` is the
// shell the command is written for; Windows and macOS are not asked to install
// anything (curl ships with both), so the caller only reaches here on a POSIX
// host. `stdin` is the sudo password for the fallback path.
function localExec(command, timeoutMs = 180000, _binary = false, stdin = null) {
    return new Promise((resolve) => {
        let child;
        try {
            child = child_process.spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
        }
        catch (e) {
            resolve({ code: -1, stdout: "", stderr: (e && e.message) || String(e) });
            return;
        }
        let stdout = "";
        let stderr = "";
        let done = false;
        const finish = (code) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        };
        const timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            }
            catch (e) {
                /* already gone */
            }
            finish(-1);
        }, timeoutMs);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => finish(code));
        child.on("error", (e) => {
            stderr += (e && e.message) || String(e);
            finish(-1);
        });
        try {
            if (stdin !== null && stdin !== undefined)
                child.stdin.write(String(stdin));
            child.stdin.end();
        }
        catch (e) {
            /* the command may exit before reading it */
        }
    });
}
module.exports = {
    FACILITY_PACKAGES,
    facilityCommand,
    installable,
    ensureFacilities,
    localExec,
};
