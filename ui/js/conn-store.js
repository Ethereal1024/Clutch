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

// The option whose backend this window is ALREADY on ("" = none). renderConnSelector
// computes it from the same state it draws the list from, so the picker cannot
// offer to "connect" to where it already is.
let connOnValue = "";

// The host this window would connect to: the one the user has chosen, or — with
// nothing chosen, which is how the phone's welcome page opens (device report #4:
// no remote host is preselected) — the host this device was last on. That standing
// intent is not a selection: nothing is chosen, so nothing is dialled behind the
// user's back, and no host is dressed up as the answer. `connTarget()` is where
// the folded conn bar's Connect spends it, by the user's own press. "" = nothing
// to dial.
function connTarget() {
  const chosen = connSelect.value;
  if (chosen) return chosen === connOnValue ? "" : chosen;
  const host = localStorage.getItem("clutch_ssh_host");
  const user = localStorage.getItem("clutch_ssh_user");
  if (!localStorage.getItem("clutch_ssh_connected") || !host || !user) return "";
  return "ssh:" + connLabel({ host, user, port: localStorage.getItem("clutch_ssh_port") || "22" });
}

let connBusy = false; // a connect is in flight: it cannot be taken twice

// Both buttons that start a connect read the same two facts: is one already in
// flight, and is there anywhere to dial. #conn-connect (the conn bar's) is only
// ever visible while the browser body is folded (ui/style.css) and
// #conn-new-connect (the new-connection popup's) while the popup is up; the list
// carries no button, because choosing an entry in it IS the dial.
function updateConnConnect() {
  $("#conn-connect").disabled = connBusy || !connTarget();
  $("#conn-new-connect").disabled = connBusy;
}
function setConnBusy(b) {
  connBusy = b;
  updateConnConnect();
}

function renderConnSelector() {
  const override = localStorage.getItem("clutch_api_url");
  // a session, not a memory: the standing intent survives a restart (that is what
  // the phone's old auto-reconnect spent), so the ✓ and the selection follow the
  // backend this window is actually on. With no session nothing is selected — the
  // welcome page opens on no host at all (device report #4: entering the app must
  // not put the user into a connection to a host they did not choose).
  const connected = !!(override && localStorage.getItem("clutch_ssh_connected") && API_BASE);
  const cHost = localStorage.getItem("clutch_ssh_host");
  const cUser = localStorage.getItem("clutch_ssh_user");
  const cPort = localStorage.getItem("clutch_ssh_port");
  const hosts = sshConns();
  connSelect.innerHTML = "";
  if (!IS_ANDROID) {
    // report #2: the phone has no local backend, so the desktop-only escape
    // hatch must not appear there at all
    const localOpt = document.createElement("option");
    localOpt.value = "local";
    localOpt.textContent = "Local (this machine)";
    connSelect.appendChild(localOpt);
  }
  // Nothing chosen is the phone's welcome state, and the list has to SAY so instead
  // of landing on a saved host. The entry carries "" — it is not a backend, nothing
  // is dialled from it, and no host is dressed up as the answer; the real hosts
  // follow it, and choosing one is what connects.
  if (IS_ANDROID && !connected && hosts.length) {
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "Select a host…";
    connSelect.appendChild(ph);
    connSelect.value = "";
  }
  // keep the connected host entry selected instead of adding a synthetic URL
  let connectedValue = null;
  for (const c of hosts) {
    const label = connLabel(c);
    const isConnected =
      connected && c.host === cHost && c.user === cUser && String(c.port) === String(cPort);
    const opt = document.createElement("option");
    opt.value = "ssh:" + label;
    opt.textContent = isConnected ? label + " ✓" : label;
    connSelect.appendChild(opt);
    if (isConnected) connectedValue = opt.value;
  }
  let onValue = "";
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
    onValue = connSelect.value;
  } else if (!IS_ANDROID) {
    connSelect.value = "local";
    // this machine's own session: where the window is, once it has a base at all
    if (API_BASE) onValue = "local";
  }
  // (the phone with no session keeps the "" of the "Select a host…" entry above:
  // the welcome page preselects no remote host)
  connOnValue = onValue;
  // nothing to pick from = a disabled picker, not a placeholder entry dressed up
  // as a backend: on the phone, before the first host is saved, "＋ New SSH
  // connection" is the way in. A list that HAS hosts stays live even with none of
  // them chosen — choosing is what connects — and the desktop always has its own
  // machine to pick.
  connSelect.disabled = IS_ANDROID && !hosts.length;
  updateConnConnect();
  // never claim "Using <url>" when there is no session: with the supervisor's
  // port refused as a base, API_BASE is either a real session or null
  connStatus.textContent = connected
    ? "Connected: " + override
    : API_BASE
      ? "Using " + API_BASE
      : "Not connected — no backend";
}
