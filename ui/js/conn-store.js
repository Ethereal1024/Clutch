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

// The host this window would connect to: the one the picker holds. The list IS the
// choice — a phone with saved hosts opens on its first (most recent) one, and the
// desktop always has this machine's own session — so "nothing chosen" means a list
// with nothing IN it, and that is a disabled picker (below) with an empty list's
// worth of targets: none. Connect therefore has nothing to dial exactly when the
// user has nothing to choose from, instead of reaching for a remembered host the
// list does not offer. Choosing is still NOT dialling: the welcome page opens on
// the first host without anything being dialled behind the user's back, and the
// user's own press — the folded conn bar's Connect, or another entry in the list —
// is what spends the choice (connTarget(), by that press). "" = nothing to dial.
function connTarget() {
  const chosen = connSelect.value;
  if (!chosen || chosen === connOnValue) return "";
  return chosen;
}

let connBusy = false; // a connect is in flight: it cannot be taken twice

// Both buttons that start a connect read the same two facts: is one already in
// flight, and is there anywhere to dial. This is the DISABLED half of both of them:
// the conn bar's Connect is shown or hidden by syncConnConnect (js/conn-flow.js, the
// file below this one in the page, which asks for this as the other half of its own
// render), and #conn-new-connect (the new-connection popup's) only exists while the
// popup is up. The list carries no button, because choosing an entry in it IS the dial.
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
  // backend this window is actually on. With no session the picker still opens ON
  // a host — the first of the list, which is the most recent one — but being
  // selected is not being connected: nothing is dialled until the user asks (the
  // folded conn bar's Connect, or choosing another entry).
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
  // No placeholder entry: a list that has hosts is a list of hosts, and Connect is
  // the door that dials what it holds. An entry that is not a backend ("Select a
  // host…") only padded the list with something no host could be chosen from.
  // keep the connected host entry selected instead of adding a synthetic URL
  let connectedValue = null;
  for (const c of hosts) {
    const label = connLabel(c);
    const isConnected =
      connected && c.host === cHost && c.user === cUser && String(c.port) === String(cPort);
    const opt = document.createElement("option");
    opt.value = "ssh:" + label;
    opt.textContent = label;
    // The ✓ is the option's MARK, not part of its name: the widget draws it in a
    // column of its own, so a long user@host:port truncates (…) instead of pushing
    // the tick onto a second line (device report).
    if (isConnected) opt.mark = "✓";
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
        ? cUser + "@" + cHost + (cPort ? ":" + cPort : "")
        : "SSH: " + override;
      opt.mark = "✓";
      connSelect.appendChild(opt);
      connSelect.value = "ssh:__connected__";
    }
    onValue = connSelect.value;
  } else if (!IS_ANDROID) {
    connSelect.value = "local";
    // this machine's own session: where the window is, once it has a base at all
    if (API_BASE) onValue = "local";
  } else if (hosts.length) {
    // the phone's welcome page opens ON a host: the list is most recent first, so
    // its first entry is the host this device was last on, and a picker with
    // something to pick from never comes up blank. The entry carries the host's
    // own value — a real choice, not a placeholder: landing in the picker still
    // dials nothing, the folded bar's Connect (or choosing another entry) is the
    // user's own press.
    connSelect.value = "ssh:" + connLabel(hosts[0]);
  }
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
