// the saved SSH hosts and the picker that lists them
//
// The host list is a localStorage record (most recent first); this file owns
// that record and the <select> the user picks a backend from, including the
// "✓ connected" entry and the phone's no-Local variant of the list.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { IS_ANDROID } from "./env";
import { $ } from "./dom";
import { corruptRecord, customSelect } from "./settings";
import { state, type Machine } from "./state";

// ---- SSH connection (in the project picker) ----
export const connSelect = customSelect($("#conn-select"));
export const connStatus = $("#conn-status");
// report #2: the tooltip's "go back to the local backend" reads wrong on the
// phone, where no local backend exists to go back to
if (IS_ANDROID) $("#conn-cancel").title = "abort the connection attempt";
export const connNewHost = $("#conn-new-host");
export const connNewUser = $("#conn-new-user");
export const connNewPort = $("#conn-new-port");

export const passModal = $("#ssh-pass-modal");
export const passInput = $("#ssh-pass-input");
export const passLabel = $("#ssh-pass-label");

export const CONNS_KEY = "clutch_ssh_connections";

// The saved hosts, most recent first. No record yet IS an empty list; a record
// that will not parse is not — answering [] for it is what let the next connect
// write a one-host list over every host the user had saved. It is reported and
// kept aside instead (corruptRecord), and the picker then offers what is actually
// there: nothing.
export function sshConns() {
  const raw = localStorage.getItem(CONNS_KEY);
  if (raw === null) return [];
  let list;
  try {
    list = JSON.parse(raw);
    if (!Array.isArray(list) || list.some((c) => !c || typeof c.host !== "string"))
      throw new Error("it is not a list of hosts");
  } catch (e) {
    corruptRecord("saved SSH hosts", CONNS_KEY, e);
    return [];
  }
  return list;
}

export function upsertConn(host, user, port) {
  const list = sshConns().filter((c) => !(c.host === host && c.user === user && String(c.port) === String(port)));
  list.unshift({ host, user, port: String(port) });
  localStorage.setItem(CONNS_KEY, JSON.stringify(list));
  localStorage.setItem("clutch_ssh_host", host);
  localStorage.setItem("clutch_ssh_user", user);
  localStorage.setItem("clutch_ssh_port", String(port));
}

export function connLabel(c) {
  return `${c.user}@${c.host}:${c.port}`;
}

// ---- WHICH machine the body is listing ----
//
// The ✓, the entry the picker opens on and the "Connected:" line are one claim:
// THIS is the machine the session being browsed runs on. So they are drawn from
// the host's answer about that session (slot:status, recorded by
// refreshBrowsedMachine in backend-lifecycle.ts) and never from where this profile
// last connected (clutch_ssh_connected / clutch_ssh_host). With one named hop per
// TAB (slots.ts) those two disagree the moment the window is on a local tab while
// the record still names the remote: the picker then drew ✓ on
// `root@region-46…:31943` over this machine's file list (device report:
// 「牛头不对马嘴」— a remote host in the bar, this machine's directories under it),
// and connOnValue said the window was already there, so that host could not be
// dialled again either.
//
// `base` is the session URL the answer is ABOUT, not a flag beside it: once the
// base moves, the answer describes a session nobody is browsing and is not shown
// as current. null = no answer (nobody could be asked), which draws no claim at
// all — the safe half, same as claimedByTunnel below.
export type BrowsedOn = { base: string; machine: Machine | null };
export let browsedOn: BrowsedOn | null = null;

// Record the answer. `machine` is null for a session on THIS machine and a
// Machine for one on a far one; a caller with no definite machine clears the
// record instead of guessing (base null).
export function noteBrowsedOn(base, machine) {
  browsedOn = base ? { base: String(base).replace(/\/+$/, ""), machine: machine || null } : null;
}

// The option whose backend this window is ALREADY on ("" = none). renderConnSelector
// computes it from the same state it draws the list from, so the picker cannot
// offer to "connect" to where it already is.
export let connOnValue = "";

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
export function connTarget() {
  const chosen = connSelect.value;
  if (!chosen || chosen === connOnValue) return "";
  return chosen;
}

export let connBusy = false; // a connect is in flight: it cannot be taken twice

// Both buttons that start a connect read the same two facts: is one already in
// flight, and is there anywhere to dial. This is the DISABLED half of both of them:
// the conn bar's Connect is shown or hidden by syncConnConnect (conn-flow.ts, the
// file below this one in the page, which asks for this as the other half of its own
// render), and #conn-new-connect (the new-connection popup's) only exists while the
// popup is up. The list carries no button, because choosing an entry in it IS the dial.
export function updateConnConnect() {
  $("#conn-connect").disabled = connBusy || !connTarget();
  $("#conn-new-connect").disabled = connBusy;
}
export function setConnBusy(b) {
  connBusy = b;
  updateConnConnect();
}

export function renderConnSelector() {
  // WHICH machine the host says the session being browsed runs on — and only if
  // that answer is about this very session. `undefined` is "nobody answered", and
  // then no entry is ticked: being selected is not being connected, and nothing is
  // dialled until the user asks (the folded conn bar's Connect, or choosing
  // another entry). null is this machine; a Machine is a far one.
  const base = state.apiBase ? String(state.apiBase).replace(/\/+$/, "") : "";
  const on = browsedOn && base && browsedOn.base === base ? browsedOn.machine : undefined;
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
    // the host's answer, matched to a saved host: only a session the host says is
    // on THAT machine ticks it. This machine's session (on === null) matches no
    // host, and a Machine the list does not hold becomes its own entry below.
    const isConnected =
      !!on && c.host === on.host && c.user === on.user && String(c.port) === String(on.port);
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
  if (on) {
    if (connectedValue) {
      connSelect.value = connectedValue;
    } else {
      // the host says this session is on a machine the saved list does not hold
      // (dialled from another window, or a host removed since): still show the
      // machine it IS, by name — never the standing record's host
      const opt = document.createElement("option");
      opt.value = "ssh:__connected__";
      opt.textContent = connLabel(on);
      opt.mark = "✓";
      connSelect.appendChild(opt);
      connSelect.value = "ssh:__connected__";
    }
    onValue = connSelect.value;
  } else if (!IS_ANDROID) {
    connSelect.value = "local";
    // this machine's own session: where the window is, once it has a base at all
    if (state.apiBase) onValue = "local";
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
  connStatus.textContent = on
    ? "Connected: " + state.apiBase
    : state.apiBase
      ? "Using " + state.apiBase
      : "Not connected — no backend";
}
