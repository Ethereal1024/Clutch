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

// restore the picker's normal browsing state after a connect/disconnect
function refreshPicker() {
  showPickerBody();
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

let connBusy = false; // a connect is in flight: ignore re-clicks
let lastConn = null;  // { host, user, port, statusEl } of the last attempt (Retry)

// collapse the picker body during a connect/failure; only the conn bar remains
function hidePickerBody() {
  $("#fs-body").classList.add("collapsed");
}
function showPickerBody() {
  $("#fs-body").classList.remove("collapsed");
  $("#fs-new").classList.toggle("hidden", fsMode !== "new");
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.add("hidden");
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

function setFsConnecting(host, statusEl) {
  activeConnStatus = statusEl;
  statusEl.textContent = "Connecting to " + host + "…";
  hidePickerBody();
  $("#conn-actions").classList.add("hidden");
  // animate the bar under the active modal (the new-connection popup has its own)
  const bar = statusEl && statusEl.id === "conn-new-status" ? $("#conn-new-progress") : $("#conn-progress");
  bar.classList.remove("hidden");
  const fill = bar.querySelector(".conn-progress-fill");
  fill.classList.add("indeterminate");
  fill.style.width = "";
}

function setFsConnectError(msg, statusEl) {
  activeConnStatus = statusEl;
  statusEl.textContent = msg;
  hidePickerBody();
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.remove("hidden"); // offer Retry / Cancel
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
  lastConn = { host, user, port, statusEl }; // Retry re-uses this on failure
  connBusy = true;
  setFsConnecting(host, statusEl); // sets the status text + shows the progress bar
  try {
    // try keys/agent first; only prompt for a password if auth fails
    let res = await window.clutchTunnel.connect({ host, user, port: Number(port) });
    if (!res.ok && res.error && /authentication/i.test(res.error)) {
      const pw = await showPasswordPrompt("Password for " + user + "@" + host);
      if (!pw) {
        setFsConnectError("connection cancelled", statusEl);
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
        statusEl
      );
    }
  } catch (e) {
    setFsConnectError("connection failed: " + e.message, statusEl);
  } finally {
    connBusy = false;
  }
}

connSelect.addEventListener("change", async () => {
  const v = connSelect.value;
  if (v === "local") {
    if (localStorage.getItem("clutch_ssh_connected")) {
      // the standing intent goes FIRST: the disconnect below ends the tunnel and
      // the host announces that as "tunnel:ended", which the renderer reads as a
      // LOST session unless the intent is already gone (backend-lifecycle.js)
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
      await window.clutchTunnel.disconnect();
      await resetBackendLocal(); // end any SSH degradation on the local server
      await switchBackendResolved(); // stay in the picker, back to the local backend
      refreshPicker();
    }
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
});

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
  closeConnNew(); // a new-connection attempt may have failed with its modal open
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
