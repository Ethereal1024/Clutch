// The desktop half of "install the update you just downloaded": the one place in
// this app that hands a file it fetched to the operating system and asks it to
// replace this very build.
//
// Every install is the same shape — spawn a command DETACHED (it has to outlive
// this process, which is about to be replaced), then quit — but what that command
// is differs per platform, and that difference is the whole file:
//
//   Windows  NSIS: `<Setup>.exe /S`. The installer handles a running app (it
//            renames the old exe and moves the new one in), and /S is its silent
//            switch — the user already said yes by pressing Install.
//   macOS    Unsigned dmg, so there is nothing to hand the OS: hdiutil attaches
//            it and the bundle is copied over the app's own path. That has to
//            happen AFTER this process exits, and no process can wait for its own
//            exit — hence a small shell script, spawned detached, that waits for
//            the app to go, swaps the bundle, and reopens it (macSwapScript).
//   Linux    `pkexec dpkg -i <deb>` — the same thing the user would type, with the
//            polkit prompt standing in for sudo. Without pkexec the deb is handed
//            to the desktop's own installer (xdg-open), which is the honest
//            fallback on a distro that has neither.
//
// What this file deliberately does NOT do: verify anything about the file it is
// given. That happened where the bytes arrived (ui/update-service.js), which is
// also the only place that knows what the release claimed — by the time a path
// gets here, it is a file this app downloaded into its own directory.
//
// The pure commands are exported separately from the spawner so a test can read
// exactly what would run on a platform this machine is not.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const child_process = require("child_process");

// one shell word, quoted the way /bin/sh wants it: a path with a space in it
// ("/Users/me/Applications/Clutch.app") must not become two words
function shq(value) {
  return "'" + String(value == null ? "" : value).replace(/'/g, "'\\''") + "'";
}

// The bundle a running macOS app lives in, from the executable Electron reports:
// <bundle>.app/Contents/MacOS/<exe> -> <bundle>.app. Anything that is not a .app
// (a `npm start` checkout) has no bundle to replace, and says so.
function macBundle(exePath) {
  const bundle = path.resolve(String(exePath || ""), "../../..");
  return /\.app$/i.test(bundle) ? bundle : "";
}

// The script that finishes a mac update. It runs detached, with no terminal and
// no parent, so everything it has to say goes to a log file beside the download —
// a silent failure here would leave the app gone with no explanation anywhere.
//
// Order matters: wait for the app (it is quitting right now, and a bundle cannot
// be replaced while its executable is mapped), attach the disk image read-only at
// a mount point of our own choosing (so the volume name cannot collide with one
// the user already has mounted), copy with `ditto` (it keeps the bundle's
// metadata and extended attributes, which a plain `cp -R` does not), swap the
// bundle aside instead of deleting it first (a failed move puts the old one back),
// then reopen the app the user was using.
function macSwapScript({ dmg, app, log }) {
  const out = log || `${dmg}.log`;
  return [
    "#!/bin/sh",
    "# Written by Clutch's updater. Runs after the app exits; see ui/update-install.js.",
    `DMG=${shq(dmg)}`,
    `APP=${shq(app)}`,
    `LOG=${shq(out)}`,
    'exec >>"$LOG" 2>&1',
    'echo "[update] $(date) install $APP from $DMG"',
    "",
    "# 1. the app is quitting as this starts: up to a minute for it to go",
    "i=0",
    'while [ "$i" -lt 300 ]; do',
    '  pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || break',
    "  i=$((i + 1))",
    "  sleep 0.2",
    "done",
    "",
    "# 2. mount the disk image somewhere of our own",
    'MNT=$(mktemp -d "${TMPDIR:-/tmp}/clutch-update.XXXXXX") || exit 1',
    'hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MNT" || exit 1',
    'SRC=$(find "$MNT" -maxdepth 1 -name "*.app" | head -n 1)',
    'if [ -z "$SRC" ]; then',
    '  echo "[update] no .app inside $DMG"',
    '  hdiutil detach "$MNT" -quiet',
    "  exit 1",
    "fi",
    "",
    "# 3. a staged copy next to the target, then one swap",
    'STAGE="$APP.new.$$"',
    'rm -rf "$STAGE"',
    'if ! ditto "$SRC" "$STAGE"; then',
    '  echo "[update] ditto failed"',
    '  hdiutil detach "$MNT" -quiet',
    '  rm -rf "$STAGE"',
    "  exit 1",
    "fi",
    'hdiutil detach "$MNT" -quiet',
    'OLD="$APP.old.$$"',
    'mv "$APP" "$OLD" || exit 1',
    'if mv "$STAGE" "$APP"; then',
    '  rm -rf "$OLD"',
    "else",
    '  echo "[update] could not move the new bundle in; restoring the old one"',
    '  mv "$OLD" "$APP"',
    "  exit 1",
    "fi",
    "",
    "# 4. unsigned dmg: a quarantined copy would be refused on launch",
    'xattr -cr "$APP" 2>/dev/null',
    'echo "[update] done"',
    'open "$APP"',
    "",
  ].join("\n");
}

// The command one kind of update runs, as data. null = this platform has no way
// to install that file from inside the app.
//
// `pkexec` is a fact, not a guess: it is looked for on disk before it is used,
// because a missing polkit helper fails asynchronously in a detached child, i.e.
// in a place nobody sees.
function detachedCommand(kind, file, { scriptPath = "", pkexec = false } = {}) {
  const target = String(file || "");
  if (!target) return null;
  if (kind === "nsis") return { cmd: target, args: ["/S"] };
  if (kind === "dmg") return scriptPath ? { cmd: "/bin/sh", args: [scriptPath] } : null;
  if (kind === "deb") {
    return pkexec
      ? { cmd: "pkexec", args: ["dpkg", "-i", target] }
      : { cmd: "xdg-open", args: [target] };
  }
  return null;
}

// The installer the Electron main process wires into ui/update-service.js.
//
// opts:
//   appBundle   the .app to replace (macOS only — ui/main.js derives it from
//               app.getPath("exe") through macBundle)
//   quit        how to leave this process (app.quit); injected so a test can watch
//   spawnImpl / existsSync / tmpDir / platform   what this machine is
function createDesktopInstaller(opts = {}) {
  const {
    appBundle = "",
    quit = () => {},
    spawnImpl = child_process.spawn,
    existsSync = fs.existsSync,
    tmpDir = os.tmpdir(),
    platform = process.platform,
    log = () => {},
  } = opts;

  const defaultKind = platform === "win32" ? "nsis" : platform === "darwin" ? "dmg" : "deb";

  function hasPkexec() {
    return existsSync("/usr/bin/pkexec") || existsSync("/usr/local/bin/pkexec");
  }

  function install(file, info = {}) {
    const kind = info.kind || defaultKind;
    const target = String(file || "");
    if (!target) return { ok: false, error: "no file to install" };
    if (!existsSync(target)) return { ok: false, error: `the downloaded file is gone: ${target}` };

    let scriptPath = "";
    if (kind === "dmg") {
      if (!appBundle) {
        return {
          ok: false,
          error: "this copy of Clutch is not running from a .app bundle, so there is nothing to replace",
        };
      }
      scriptPath = path.join(tmpDir, `clutch-update-${process.pid}.sh`);
      try {
        fs.writeFileSync(scriptPath, macSwapScript({ dmg: target, app: appBundle }), { mode: 0o700 });
      } catch (e) {
        return { ok: false, error: `could not write the install script: ${(e && e.message) || e}` };
      }
    }

    const command = detachedCommand(kind, target, { scriptPath, pkexec: hasPkexec() });
    if (!command) return { ok: false, error: `no way to install a ${kind || "that"} file from inside Clutch` };

    try {
      const child = spawnImpl(command.cmd, command.args, { detached: true, stdio: "ignore" });
      if (child && typeof child.unref === "function") child.unref();
      if (child && typeof child.on === "function") {
        // a command that dies after the spawn answers asynchronously — too late to
        // report it to the page, but never too late to be honest in the log
        child.on("error", (e) => log(`[update] ${command.cmd} failed: ${(e && e.message) || e}`));
      }
    } catch (e) {
      return { ok: false, error: `could not start ${command.cmd}: ${(e && e.message) || e}` };
    }

    // The running build is what the command is replacing, so on Windows and macOS
    // this process has to go — the mac script is already waiting for exactly that,
    // and NSIS only renames the running exe once it is gone. On Linux dpkg does
    // not need the app to exit (the running process keeps the old files' inodes),
    // and the polkit prompt may be cancelled: there the user closes the app
    // themselves, which is what `quits: false` tells the page to say.
    const quits = kind !== "deb";
    if (quits) {
      setTimeout(() => {
        try {
          quit();
        } catch (e) {
          log(`[update] quit failed: ${(e && e.message) || e}`);
        }
      }, 250);
    }
    log(`[update] installing ${target} with ${command.cmd} ${command.args.join(" ")}`);
    return { ok: true, command: command.cmd, args: command.args, quits };
  }

  return { install };
}

module.exports = {
  shq,
  macBundle,
  macSwapScript,
  detachedCommand,
  createDesktopInstaller,
};
