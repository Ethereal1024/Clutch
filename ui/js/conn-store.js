// the saved SSH hosts and the picker that lists them
//
// The host list is a localStorage record (most recent first); this file owns
// that record and the <select> the user picks a backend from, including the
// "✓ connected" entry and the phone's no-Local variant of the list.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// ---- SSH connection (in the project picker) ----
const connSelect = customSelect($("#conn-select"));
const connStatus = $("#conn-status");
// report #2: the tooltip's "go back to the local backend" reads wrong on the
// phone, where no local backend exists to go back to
if (IS_ANDROID) $("#conn-cancel").title = "abort the connection attempt";
const connNewHost = $("#conn-new-host");
const connNewUser = $("#conn-new-user");
const connNewPort = $("#conn-new-port");

const passModal = $("#ssh-pass-modal");
const passInput = $("#ssh-pass-input");
const passLabel = $("#ssh-pass-label");
let passResolve = null;

function sshConns() {
  try {
    return JSON.parse(localStorage.getItem("clutch_ssh_connections") || "[]");
  } catch (e) {
    return [];
  }
}

function upsertConn(host, user, port) {
  const list = sshConns().filter((c) => !(c.host === host && c.user === user && String(c.port) === String(port)));
  list.unshift({ host, user, port: String(port) });
  localStorage.setItem("clutch_ssh_connections", JSON.stringify(list));
  localStorage.setItem("clutch_ssh_host", host);
  localStorage.setItem("clutch_ssh_user", user);
  localStorage.setItem("clutch_ssh_port", String(port));
}

function connLabel(c) {
  return `${c.user}@${c.host}:${c.port}`;
}

function renderConnSelector() {
  const override = localStorage.getItem("clutch_api_url");
  const connected = override && localStorage.getItem("clutch_ssh_connected");
  const cHost = localStorage.getItem("clutch_ssh_host");
  const cUser = localStorage.getItem("clutch_ssh_user");
  const cPort = localStorage.getItem("clutch_ssh_port");
  connSelect.innerHTML = "";
  if (!IS_ANDROID) {
    // report #2: the phone has no local backend, so the desktop-only escape
    // hatch must not appear there at all
    const localOpt = document.createElement("option");
    localOpt.value = "local";
    localOpt.textContent = "Local (this machine)";
    connSelect.appendChild(localOpt);
  }
  // keep the connected host entry selected instead of adding a synthetic URL
  let connectedValue = null;
  for (const c of sshConns()) {
    const label = connLabel(c);
    const isConnected =
      connected && c.host === cHost && c.user === cUser && String(c.port) === String(cPort);
    const opt = document.createElement("option");
    opt.value = "ssh:" + label;
    opt.textContent = isConnected ? label + " ✓" : label;
    connSelect.appendChild(opt);
    if (isConnected) connectedValue = opt.value;
  }
  if (connected) {
    if (connectedValue) {
      connSelect.value = connectedValue;
    } else {
      // connected via a path that didn't save a host: still show user@host:port
      const opt = document.createElement("option");
      opt.value = "ssh:__connected__";
      opt.textContent = cHost
        ? cUser + "@" + cHost + (cPort ? ":" + cPort : "") + " ✓"
        : "SSH: " + override + " ✓";
      connSelect.appendChild(opt);
      connSelect.value = "ssh:__connected__";
    }
  } else if (IS_ANDROID) {
    // report #2: with no Local entry, land the picker on the most recent saved
    // host (display only — connecting still requires the user's change event);
    // nothing saved yet: a placeholder whose "" value the change handler skips
    const saved = sshConns();
    if (saved.length) {
      connSelect.value = "ssh:" + connLabel(saved[0]);
    } else {
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "— add an SSH connection —";
      connSelect.appendChild(ph);
      connSelect.value = "";
    }
  } else {
    connSelect.value = "local";
  }
  // never claim "Using <url>" when there is no session: with the supervisor's
  // port refused as a base, API_BASE is either a real session or null
  connStatus.textContent = connected
    ? "Connected: " + override
    : API_BASE
      ? "Using " + API_BASE
      : "Not connected — no backend";
}
