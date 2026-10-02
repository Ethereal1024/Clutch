// the connect flow — progress, password, and the picker's own popups
//
// One attempt at a host (`handleSshConnect`) and the chrome around it: the
// coarse progress stages the tunnel reports over IPC, the password prompt shown
// only after key auth fails, the new-connection popup, and Retry/Cancel.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// restore the picker after a connect/disconnect: the bar's connect chrome is over,
// and the body follows whatever the listing the picker is about to ask for answers
// with (loadDir owns that visibility — a folded body is folded only until a backend
// answers, and no answer means it stays folded). The ask itself is a fact the bar's
// door reads (fsListing, setFsListing below): while the listing is on its way, the
// folded bar is WAITING for a body, which is not the welcome page.
function refreshPicker() {
  resetConnChrome();
  loadDir("", false); // re-list the (new) backend from home; keep the remembered dir
  renderConnSelector();
}

function showPasswordPrompt(label) {
  return new Promise((resolve) => {
    passLabel.textContent = label;
    passInput.value = "";
    passResolve = resolve;
    passModal.classList.remove("hidden", "closing");
    passInput.focus();
  });
}

function closePasswordPrompt() {
  // resolve immediately (the connect flow is waiting); only the visual close animates
  closeModal(passModal);
  // A declined password is not "keep trying": the user answered the one question
  // the reconnect had, so the disconnect dialog stops retrying behind them and
  // waits for the button (see connLostNeedsUser in js/conn-lost.js)
  connLostNeedsUser();
  if (passResolve) passResolve(null);
  passResolve = null;
}

let lastConn = null;  // { host, user, port, statusEl } of the last BAR attempt (Retry)

// Monotonic token for the file listing (loadDir in js/fs-browser.js): a listing
// that comes back after the user asked for something else — another directory, a
// connect that folded the body — must not paint itself, nor unfold the body, over
// the newer intent.
let fsListToken = 0;

// A listing has been asked for and has not answered yet. The fold says the body is not
// up; WHY it is not up is this: the picker is waiting to be shown something to browse
// (loadDir in js/fs-browser.js — and the picker's own opening, which settles the
// backend's URL before it can list at all). Without this fact the only way to tell "the
// bar is the picker" from "the bar is waiting for an answer" was the fold itself, and the
// two read alike: the folded bar's Connect came back for the whole round-trip of the
// listing a successful connect starts, then left again the moment it landed (device
// report: a Connect flashing at the instant a connection succeeded).
let fsListing = false;
function setFsListing(on) {
  if (fsListing === on) return;
  fsListing = on;
  syncConnConnect(); // the door follows the wait, not only the fold
}

// The folded bar's Connect is the welcome state's own door (ui/index.html): with nothing
// browsed, the conn bar IS the picker and the host this device was last on is one press
// away. The fold alone is not that state — a connect folds the body to retire it, and a
// listing in flight folds it to wait — so the button follows the three facts that make the
// bar the picker: no attempt in flight (connBusy, js/conn-store.js), no listing
// outstanding (fsListing above), and no failure verdict on the bar (Retry/Cancel,
// setFsConnectError below). Reading the fold alone is what put the button back the instant
// an attempt started: a second Connect beside the one already running, greyed only because
// that attempt had disabled it.
//
// This is the ONE place the button is drawn, both halves of it, so that "shown" and
// "armed" cannot disagree: the armed half is js/conn-store.js's (updateConnConnect, the
// store owning the target and the in-flight flag), asked for from here.
function syncConnConnect() {
  const folded = $("#fs-body").classList.contains("collapsed");
  const busy = connBusy || fsListing || !$("#conn-actions").classList.contains("hidden");
  $("#conn-connect").classList.toggle("hidden", !folded || busy);
  updateConnConnect(); // ...and the other half, from the same facts
}

// collapse the picker body during a connect/failure; only the conn bar remains.
// Folding is also what retires a listing that is still in flight: its answer decides
// nothing any more, so the wait ends with it (a retired listing returns early and never
// clears the wait itself, which would leave fsListing true for good and the door with it).
function hidePickerBody() {
  fsListToken++;
  setFsListing(false);
  $("#fs-body").classList.add("collapsed");
  syncConnConnect(); // the bar is the picker now — unless an attempt owns it
}
function showPickerBody() {
  $("#fs-body").classList.remove("collapsed");
  $("#fs-new").classList.toggle("hidden", fsMode !== "new");
  resetConnChrome();
}
// the connect chrome on the conn bar (progress, Retry/Cancel) belongs to an attempt
// that is over the moment the picker is back in its browsing state
function resetConnChrome() {
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.add("hidden");
  syncConnConnect(); // the attempt's chrome is over: the folded bar's door is back
}

let activeConnStatus = null; // status element of the modal currently connecting

// connection progress bar: the tunnel reports coarse stages over IPC
const CONN_STAGES = {
  auth: { pct: 10, label: "Connecting…" },
  probe: { pct: 22, label: "Inspecting remote…" },
  // the gate's own stage: a remote that already runs our version never reaches
  // "install", so reconnecting to a healthy server must not claim it does
  check: { pct: 30, label: "Checking remote server…" },
  install: { pct: 35, label: "Installing remote server…" },
  // the artifact itself: a Release download (or a first-time build on the
  // desktop), and the only part of an install that can take minutes. It has its
  // own stage so it cannot hide inside the check above — that is what made a
  // connect on a phone look like it "only checks the remote server" and never
  // installs (report #5)
  "install:fetch": { pct: 40, label: "Preparing remote server…" },
  "install:upload": { pct: 45, label: "Uploading server…" },
  "install:start": { pct: 70, label: "Starting server…" },
  forward: { pct: 90, label: "Starting tunnel…" },
};
function updateConnProgress(stage) {
  const s = CONN_STAGES[stage];
  if (activeConnStatus) activeConnStatus.textContent = s ? s.label : "Working…";
  for (const bar of [$("#conn-progress"), $("#conn-new-progress")]) {
    if (bar.classList.contains("hidden")) continue;
    const fill = bar.querySelector(".conn-progress-fill");
    if (s) {
      fill.classList.remove("indeterminate");
      fill.style.width = s.pct + "%";
    } else {
      fill.classList.add("indeterminate"); // unknown stage: keep the bar animating
      fill.style.width = "";
    }
  }
}

// An attempt reports to the status element of the door that started it: the picker's
// own line (#conn-status) or the new-connection popup's (#conn-new-status). The two
// carry different chrome, and the popup has all of its own: its status line, its
// progress bar, its Connect to press again. So the bar underneath is not the actor in
// a popup attempt (and a popup attempt is not the bar's): it takes no fold from it,
// no progress bar, no Retry/Cancel, and leaves the folded bar's Connect where the
// fold put it. Reading an attempt as one thing is what left a failed popup attempt
// with Retry/Cancel on the folded bar behind the modal, pointing at the popup's
// status element: closing the popup then showed a bar whose Retry painted the next
// attempt into a closed popup, with no Connect door back.
//
// The door's name is read once, where the attempt starts (handleSshConnect), and the
// functions below are TOLD which door they are acting for instead of each reading it
// back out of the DOM node they were handed.
function doorOf(statusEl) {
  return statusEl && statusEl.id === "conn-new-status" ? "popup" : "bar";
}

function setFsConnecting(host, statusEl, door) {
  activeConnStatus = statusEl;
  statusEl.textContent = "Connecting to " + host + "…";
  if (door === "bar") {
    $("#conn-actions").classList.add("hidden"); // an attempt replaces the last verdict
    // and retires the listing in flight (hidePickerBody ends that wait): the fold is
    // what the bar's door reads
    hidePickerBody();
  }
  // animate the bar under the active modal (the new-connection popup has its own)
  const bar = door === "popup" ? $("#conn-new-progress") : $("#conn-progress");
  bar.classList.remove("hidden");
  const fill = bar.querySelector(".conn-progress-fill");
  fill.classList.add("indeterminate");
  fill.style.width = "";
  syncConnConnect(); // an attempt is in flight, either door: the door stands down
}

function setFsConnectError(msg, statusEl, door) {
  activeConnStatus = statusEl;
  statusEl.textContent = msg;
  if (door === "popup") {
    // the verdict is the popup's, with its own Connect armed again by setConnBusy:
    // the bar underneath keeps whatever it was already offering, and keeps it once
    // the popup closes
    $("#conn-new-progress").classList.add("hidden");
    return;
  }
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.remove("hidden"); // offer Retry / Cancel
  hidePickerBody(); // and the verdict owns the folded bar, Retry/Cancel included
}

async function handleSshConnect(host, user, port, statusEl) {
  if (!window.clutchTunnel) {
    statusEl.textContent = "SSH requires the desktop app (Electron).";
    return;
  }
  if (connBusy) {
    statusEl.textContent = "connecting…";
    return;
  }
  if (!host || !user) {
    statusEl.textContent = "host and user are required";
    return;
  }
  // which door this attempt belongs to, read once: everything below acts for it
  const door = doorOf(statusEl);
  // the bar's Retry re-uses the last attempt made FROM THE BAR: a popup attempt is
  // the popup's own press (its Connect is that retry), so it does not claim it
  if (door === "bar") lastConn = { host, user, port, statusEl };
  setConnBusy(true); // no second attempt can start while this one is in flight
  setFsConnecting(host, statusEl, door); // status text + progress bar, on that door's chrome
  try {
    // try keys/agent first; only prompt for a password if auth fails
    let res = await window.clutchTunnel.connect({ host, user, port: Number(port) });
    if (!res.ok && res.error && /authentication/i.test(res.error)) {
      const pw = await showPasswordPrompt("Password for " + user + "@" + host);
      if (!pw) {
        setFsConnectError("connection cancelled", statusEl, door);
        return;
      }
      res = await window.clutchTunnel.connect({ host, user, port: Number(port), password: pw });
    }
    if (res.ok) {
      upsertConn(host, user, port);
      localStorage.setItem("clutch_ssh_connected", "1");
      // the tunnel URL is the supervisor control channel; the API base is the
      // per-window session, decided by the main process
      await switchBackendResolved();
      refreshPicker();
      return true;
    } else {
      // host alive but unbootstrappable: degrade to SSH-tools
      const degraded = await tryDegradeToSshTools();
      if (degraded === true) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        await switchBackendResolved(); // the local server is now remote-backed
        refreshPicker();
        return true;
      }
      // false = tunnel never came up; string = local backend down (the real failure).
      // res.error is the bootstrap verdict (e.g. the pylibs index 404) — never
      // drop it: the bare "unreachable" hid a whole class of supply-line
      // failures behind a symptom.
      setFsConnectError(
        degraded === false
          ? "connection failed: " + (res.error || "could not connect")
          : "SSH connected, but the local agent server is " + degraded +
            (res.error ? " (" + res.error + ")" : ""),
        statusEl,
        door
      );
    }
  } catch (e) {
    setFsConnectError("connection failed: " + e.message, statusEl, door);
  } finally {
    setConnBusy(false);
    syncConnConnect(); // the attempt is over, either door: no longer in flight, so the
    // folded bar reads its fold again — and a listing still outstanding (fsListing) keeps
    // that a WAIT rather than the welcome state, which is what kept the door from
    // flashing back the instant a connect succeeded (a popup failure never took the
    // bar's chrome, so there is nothing else on the bar to settle here)
  }
}

// Connect — the user's own act. The picker has two doors onto it: choosing a host
// in the list (below), and pressing Connect while the body is folded — the welcome
// state, where nothing is chosen and the host this device was last on is one press
// away (connTarget() in js/conn-store.js). connOnValue is the backend this window
// is already on, so a choice that does not move the window is not a dial.
async function connConnect(v) {
  if (!v || v === connOnValue) return;
  if (v === "local") {
    if (localStorage.getItem("clutch_ssh_connected")) {
      // the standing intent goes FIRST: the disconnect below ends the tunnel and
      // the host announces that as "tunnel:ended", which the renderer reads as a
      // LOST session unless the intent is already gone (backend-lifecycle.js)
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
      await window.clutchTunnel.disconnect();
      await resetBackendLocal(); // end any SSH degradation on the local server
    }
    // this machine's own session, by asking the host for it: with no session yet
    // the honest answer is still "not connected", never a guessed local port
    await switchBackendResolved();
    refreshPicker();
    return;
  }
  if (v.startsWith("ssh:") && !v.includes("__connected__")) {
    // switching: drop any current tunnel first, then connect to the new host.
    // The intent is cleared before the drop, for the same reason as above: the
    // user is leaving this host on purpose, so it is not a lost session.
    if (localStorage.getItem("clutch_ssh_connected")) {
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade");
      await window.clutchTunnel.disconnect();
    }
    const [user, hostPort] = v.slice(4).split("@");
    const [host, port] = hostPort.split(":");
    await handleSshConnect(host, user, port || "22", connStatus);
  }
}
// The list's door: choosing a host connects to it, immediately — selection IS the
// dial (device report #4: the extra press the picker briefly required is gone).
// The standing intent is not a choice, so opening the picker still dials nothing;
// the "" entry ("Select a host…", js/conn-store.js) is not a host at all.
connSelect.addEventListener("change", () => {
  updateConnConnect(); // the folded bar's Connect follows the new choice
  connConnect(connSelect.value);
});
// The folded bar's door: with nothing chosen, Connect spends the standing intent
// (connTarget()); with a choice in the list, that same choice is what it dials.
$("#conn-connect").addEventListener("click", () => connConnect(connTarget()));

// new-connection popup (only shown when the user asks to add an SSH host)
const connNewModal = $("#conn-new-modal");
const connNewStatus = $("#conn-new-status");

function openConnNew() {
  connNewHost.value = localStorage.getItem("clutch_ssh_host") || "";
  connNewUser.value = localStorage.getItem("clutch_ssh_user") || "";
  connNewPort.value = localStorage.getItem("clutch_ssh_port") || "22";
  connNewStatus.textContent = "";
  connNewModal.classList.remove("hidden", "closing");
  connNewHost.focus();
}
function closeConnNew() {
  closeModal(connNewModal);
}
$("#conn-new").addEventListener("click", openConnNew);
$("#conn-new-cancel").addEventListener("click", closeConnNew);
$("#conn-new-connect").addEventListener("click", async () => {
  const host = connNewHost.value.trim();
  const user = connNewUser.value.trim();
  const port = connNewPort.value.trim() || "22";
  const ok = await handleSshConnect(host, user, port, connNewStatus);
  if (ok) closeConnNew(); // stay in the picker
});
dismissOnOverlayPress(connNewModal, closeConnNew);
connNewHost.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#conn-new-connect").click();
});
$("#conn-retry").addEventListener("click", () => {
  if (lastConn) handleSshConnect(lastConn.host, lastConn.user, lastConn.port, lastConn.statusEl);
});
$("#conn-cancel").addEventListener("click", async () => {
  localStorage.removeItem("clutch_ssh_connected");
  localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
  // the bar's Cancel belongs to the picker's own attempt (a popup attempt keeps
  // its verdict inside the popup), so no popup should be up here; closing one anyway
  // is the cheap guarantee that none is (closeModal returns early on a closed modal)
  closeConnNew();
  if (!IS_ANDROID) {
    // desktop only: "cancel" goes back to this machine's local session. There
    // is no local backend on the phone, so that path could only point the app
    // at 127.0.0.1:8890 — a port nothing there serves.
    resetBackendLocal(); // end any SSH degradation on the local server
    await switchBackendResolved();
  }
  refreshPicker();
});
if (window.clutchTunnel && window.clutchTunnel.onProgress) {
  window.clutchTunnel.onProgress(updateConnProgress); // drive the connect progress bar
}
$("#ssh-pass-ok").addEventListener("click", () => {
  const pw = passInput.value;
  closeModal(passModal);
  if (passResolve) passResolve(pw);
  passResolve = null;
});
$("#ssh-pass-cancel").addEventListener("click", closePasswordPrompt);
dismissOnOverlayPress(passModal, closePasswordPrompt);
passInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#ssh-pass-ok").click();
});
