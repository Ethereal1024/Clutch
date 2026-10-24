// The About pane's update button — the whole "is there a newer Clutch, and can I
// get it without leaving this window?" conversation, as one control and one line
// of text under it.
//
// Everything that decides anything lives behind a bridge, and this file owns only
// the two things a page can own: the WORDS and the ORDER of the presses. The facts
// (which release is newest, which file belongs to this machine) are ui/update-core.js;
// the bytes and their verification are ui/update-service.js; running the installer
// is ui/update-install.js in Electron and the WebView's `clutchShell` on the phone.
// Keeping the split there is why this file can be read end to end in a minute: it
// asks, it shows the answer, it asks again.
//
// The reference for the shape is what every open-source desktop updater outside a
// store converges on (Sparkle, electron-updater's UI layer, VS Code, Signal): the
// user presses ONE button, the app says what it found, and the download that
// follows reports bytes because a 100 MB installer on a phone's connection is
// minutes. Two presses, not one — the second one is the consent to replace the
// build that is running, and it is the same press that starts the download. What is
// deliberately NOT here: an update that starts by itself, a button that installs a
// file the release page never named, and a spinner with no percentage under it.
//
// States, in the order they can be entered (the button's own words in quotes):
//
//   idle         "Check for updates"    nothing asked yet
//   checking     "Checking…"            the release page is being read
//   available    "Install 0.1.61"       a file for this machine exists, second press
//                                       downloads it and hands it to the installer
//   downloading  "Downloading 42%"      bytes are arriving
//   installing   "Installing…"          the platform's installer has been started
//   error        "Try again"            whatever went wrong, in the line below
//
// "error" is the only state whose line is a FAILURE the user has to act on, so it is
// the only one that takes the alert colour (.about-update-note.error).

"use strict";

const UPDATE_BUTTON_ID = "about-update-btn";
const UPDATE_NOTE_ID = "about-update-note";

// What the button says and what the line under it says. One object painted, so a
// state change can never leave the two disagreeing — a button reading "Installing…"
// over a note that still says "downloading" is the kind of thing a person reports
// as a hang.
const updateUi = { label: "Check for updates", note: "", error: false, disabled: false };

let updateBusy = false; // a check, a download or an install is in flight
let updatePhase = ""; // which one: "check" | "download" | "install"
let updatePlan = null; // the answer check() settled on (the service's own shape)
let updateFile = ""; // a verified download that is waiting for its Install press

// The two bridges. `clutchUpdate` is the common one: the Electron preload and the
// Android host's window both expose it, so check and download are the same call on
// both. `clutchShell` is the phone's own escape hatch — an APK is installed by the
// phone, not by node — and its presence is also how this file tells which platform
// it is painting for.
function updateBridge() {
  const bridge = window.clutchUpdate;
  return bridge && typeof bridge.check === "function" ? bridge : null;
}

function updateShell() {
  const shell = window.clutchShell;
  return shell && typeof shell.installApk === "function" ? shell : null;
}

// The number this check is compared against is the one the pane is showing:
// window.CLUTCH_VERSION, the build stamp (ui/version.js), which the Android build
// rewrites with its own versionName. It is passed through as it is — an empty stamp
// is a real answer ("this build does not state its own version", which the service
// says back), and the desktop shell falls back to its own package version only when
// the page has nothing to say at all.
function updateVersion() {
  return String(window.CLUTCH_VERSION == null ? "" : window.CLUTCH_VERSION).trim();
}

// A release tag is "v0.1.61" and the About row is "0.1.61": the prefix belongs to
// git, not to the sentence under the button.
function updateTag(version) {
  return String(version == null ? "" : version).trim().replace(/^v/i, "");
}

// Bytes in the units a person reads and no further: one decimal is the whole
// difference between "23 MB" and "23.4 MB", and nobody needs the second one.
function updateSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// The one place the two elements are written. Both are looked up every time rather
// than cached at load: the pane's markup is not something this file is allowed to
// make a load-time assumption about (index.html owns it), and a missing one must
// leave the other working.
function paintUpdate() {
  const button = document.getElementById(UPDATE_BUTTON_ID);
  if (button) {
    button.textContent = updateUi.label;
    button.disabled = updateUi.disabled;
  }
  const note = document.getElementById(UPDATE_NOTE_ID);
  if (note) {
    note.textContent = updateUi.note;
    // `classList.toggle` with a second argument keeps the class list honest without
    // a class by class dance: the tone is a fact about this line, not a style.
    if (note.classList && typeof note.classList.toggle === "function") {
      note.classList.toggle("error", Boolean(updateUi.error));
    }
  }
}

function updateSay(label, note, opts = {}) {
  updateUi.label = label;
  updateUi.note = note || "";
  updateUi.error = Boolean(opts.error);
  updateUi.disabled = Boolean(opts.disabled);
  paintUpdate();
}

// The idle line as it reads when nothing has been asked yet — and the one taken
// when the pane is reopened, so a finished answer does not sit there looking like
// the state of the world an hour later.
function updateIdle() {
  const bridge = updateBridge();
  if (!bridge) {
    updateSay(
      "Check for updates",
      "this page is not running inside Clutch, so it has nothing to install. Open the app to update it.",
      { disabled: true }
    );
    return;
  }
  updateSay("Check for updates", "", {});
}

// ---------------------------------------------------------------- the presses --

// One entry point for the button, whichever press this is. What the next press
// means is decided by what is already in hand, in this order: a verified file (the
// installer was refused once — a permission, a missing polkit prompt), a checked
// release that is newer (download it now), anything else (go and ask).
async function runUpdate() {
  const bridge = updateBridge();
  if (updateBusy || !bridge) return;
  updateBusy = true;
  try {
    if (updateFile) await installUpdateFile(bridge, updateFile);
    else if (updatePlan && updatePlan.available && updatePlan.asset) await downloadUpdate(bridge);
    else await checkUpdate(bridge);
  } catch (e) {
    // a bridge that REJECTED (an IPC that died, a host that went away) lands here:
    // the button must come back to something pressable rather than stay disabled.
    updateSay("Try again", "the update failed: " + ((e && e.message) || String(e)), { error: true });
  } finally {
    updateBusy = false;
  }
}

async function checkUpdate(bridge) {
  updatePlan = null;
  updatePhase = "check";
  updateSay("Checking…", "asking the release page which build is newest…", { disabled: true });
  const answer = await bridge.check(updateVersion());
  updatePhase = "";
  if (!answer || !answer.ok) {
    updateSay("Try again", "the check failed: " + ((answer && answer.error) || "no answer"), { error: true });
    return;
  }
  updatePlan = answer;
  const latest = updateTag(answer.latest);
  const current = updateTag(answer.current) || "this build";
  if (answer.available && answer.asset) {
    const size = updateSize(answer.asset.size);
    updateSay(
      "Install " + (latest || "the update"),
      "Clutch " + (latest || "a newer build") + " is out" +
        (answer.key ? " for " + answer.key : "") +
        (size ? " (" + size + ")" : "") +
        ". Press Install: it downloads here, checks the file against the release, then opens the installer.",
      {}
    );
    return;
  }
  if (answer.reason === "up to date") {
    updateSay(
      "Check for updates",
      "this is the newest release: Clutch " + current + (latest && latest !== current ? " (latest is " + latest + ")" : "") + ".",
      {}
    );
    return;
  }
  updateSay("Check for updates", "nothing to install: " + (answer.reason || "the release has no build for " + answer.key) + ".", {});
}

async function downloadUpdate(bridge) {
  const asset = (updatePlan && updatePlan.asset) || {};
  const label = updateTag(updatePlan && updatePlan.latest);
  updatePhase = "download";
  updateSay("Downloading…", "downloading " + (asset.name || "the update") + "…", { disabled: true });
  const got = await bridge.download();
  updatePhase = "";
  if (!got || !got.ok) {
    // a failed download drops the plan with it: the file is gone (the service
    // removes its `.part`), and the next press must be a fresh check rather than a
    // retry of a decision about a release that may have moved on.
    updatePlan = null;
    updateSay("Try again", "the download failed: " + ((got && got.error) || "no answer"), { error: true });
    return;
  }
  // Set BEFORE the installer runs: a phone that has to be given permission first
  // must be able to press Install again WITHOUT downloading the same 100 MB twice.
  updateFile = got.path || "";
  updateSay("Installing…", "the file matches the release; starting the installer for " + (label || "the new build") + "…", {
    disabled: true,
  });
  await installUpdateFile(bridge, updateFile);
}

// Handing the file over. Three ways this ends, and the line under the button says
// which one it was: the installer took it (and on Windows/macOS this process is
// about to be replaced), the phone wants a permission first, or nothing started.
async function installUpdateFile(bridge, file) {
  updatePhase = "install";
  const label = updateTag(updatePlan && updatePlan.latest);
  const shell = updateShell();
  updateSay("Installing…", "starting the installer…", { disabled: true });
  let answer = null;
  if (shell) {
    // The phone's bridge is SYNCHRONOUS: `installApk` starts the system installer
    // and returns its verdict as a JSON string in the same call (android/…/UpdateInstaller.kt),
    // because @JavascriptInterface has no promise to give back.
    try {
      answer = JSON.parse(String(shell.installApk(file)));
    } catch (e) {
      answer = { error: "the phone's installer answered something unreadable: " + ((e && e.message) || e) };
    }
  } else {
    answer = await bridge.install(file);
  }
  updatePhase = "";

  if (answer && answer.needsPermission) {
    // the phone has already opened the "allow installs from this app" screen; the
    // file stays in hand, so the press that follows it skips the download.
    updateSay(
      "Install",
      "the phone has to allow installs from Clutch first: turn it on in the screen that just opened, then press Install again — the download is kept.",
      { error: true }
    );
    return;
  }
  if (!answer || !answer.ok) {
    // The file stays in hand here too: whatever went wrong (a polkit prompt that
    // was cancelled, an installer that would not start) is worth one more press
    // before it is worth another download.
    updateSay("Install", "the installer did not start: " + ((answer && answer.error) || "no answer"), { error: true });
    return;
  }

  updateFile = "";
  const name = label ? "Clutch " + label : "the new build";
  if (shell) {
    updateSay("Installing…", "the phone's installer is opening: confirm it there and Clutch comes back as " + name + ".", {
      disabled: true,
    });
    return;
  }
  if (answer.quits === false) {
    // the Linux case: dpkg does not need this process to exit (the running binary
    // keeps the old files' inodes) and the polkit prompt may yet be cancelled — so
    // the app stays up and the user closes it, which is what the note asks for.
    updateSay("Installing…", "the installer is open: finish it there, then start Clutch again for " + name + ".", {
      disabled: true,
    });
    return;
  }
  updateSay("Restarting…", "Clutch closes now and comes back as " + name + ".", { disabled: true });
}

// ------------------------------------------------------------------- progress --

// The service reports bytes on whole percents (or every 1 MB when the release
// stated no size), so this is a repaint of one line, not a counter. A stage that
// arrives while the pane is not downloading is ignored: the desktop shell forwards
// progress to the window that asked, but the phone's bridge fans out to every
// window, and a stale "42%" on a pane that is not downloading is a lie.
function updateProgress(stage) {
  if (!stage || typeof stage !== "object" || updatePhase !== "download") return;
  const file = String(stage.file || "the update");
  if (stage.phase === "verified") {
    updateSay("Installing…", "the file matches the release; starting the installer…", { disabled: true });
    return;
  }
  if (stage.phase !== "download") return;
  const total = Number(stage.total) || 0;
  const received = Number(stage.received) || 0;
  const percent = total ? Math.min(100, Math.max(0, Math.floor((received * 100) / total))) : 0;
  const line = total ? percent + "% of " + updateSize(total) : updateSize(received);
  updateSay("Downloading…", "downloading " + file + (line ? " — " + line : "") + "…", { disabled: true });
}

// ---------------------------------------------------------------------- wiring --

// A finished answer is not a fact worth carrying across modal closings: reopening
// the pane starts from "Check for updates". An in-flight download or a started
// installer keeps its line — those are still true, and taking them away would be
// the one thing worse than a stale note.
function resetUpdate() {
  if (updateBusy || updateFile) return;
  updatePlan = null;
  updatePhase = "";
  updateIdle();
}

{
  const button = document.getElementById(UPDATE_BUTTON_ID);
  if (button) button.addEventListener("click", runUpdate);
  // the About tab is painted by ui/js/settings.js on its own click; this hangs the
  // reset on the same click (two listeners, one gesture, no ordering to get wrong)
  const tab = document.getElementById("settings-tab-about");
  if (tab) tab.addEventListener("click", resetUpdate);

  const bridge = updateBridge();
  if (bridge && typeof bridge.onProgress === "function") bridge.onProgress(updateProgress);
  updateIdle();
}
