// the disconnect dialog — the one door a lost session comes back through
//
// Device report: after a blip the window went on claiming "Connected:
// http://127.0.0.1:4xxxx" while nothing answered it, the task badge slid to
// idle by itself, and the next message came back "Failed to fetch". The only way
// back was open/new -> "+ New SSH connection", re-entering the very host
// parameters the window had never actually left — asking the user to introduce
// an old host as a new one.
//
// The cause was structural: a lost remote announced itself through a toast
// (auto-dismissed after 8 seconds) and, on the phone, through a retry loop
// nobody could see. Nothing owned the state "this window has no session", and
// nothing offered the user a way back.
//
// So: every way a disconnect is detected funnels into connectionLost(), and the
// dialog it raises IS the reconnect entry. It cannot be dismissed — no backdrop
// press, no Escape, no ×, no Cancel — because dismissing it would leave the
// window exactly where it started: pointed at a port nobody serves. It closes
// on the first session that answers again, and that session is adopted in place
// (same project, same transcript) rather than in a fresh window.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

const connLostModal = $("#conn-lost-modal");
const connLostReasonEl = $("#conn-lost-reason");
const connLostTargetEl = $("#conn-lost-target");
const connLostStatusEl = $("#conn-lost-status");
// the connect flow's verdict, in its own line: the dialog paints its progress
// into #conn-lost-status, so reading that back as "why" quoted the dialog's own
// "Reconnecting…" at the user ("Not back yet — retrying. (Reconnecting…)")
const connLostWhyEl = $("#conn-lost-why");

// how long to wait before the next automatic attempt. A phone that comes back
// into signal must reconnect without the user touching anything, and a host
// that is simply down must not be hammered: the gap grows to a steady 30s.
const CONN_LOST_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];
// how many redials a named remote gets before a desktop gives up on it and takes
// the host's own (local) session instead. The phone has no local session at all
// (N4), so there the remote keeps its tries forever.
const CONN_LOST_HOST_FALLBACK_AFTER = 3;

let connLost = false; // this window has no session, and the dialog is up
let connLostTries = 0; // attempts spent on the outage (drives the backoff)
let connLostAttempting = false; // one attempt at a time: the timer and the button race
let connLostTimer = null;
let connLostManualOnly = false; // the user declined the password prompt: wait for them

// what the dialog says the window is trying to get back to
function connLostTargetText() {
  const host = localStorage.getItem("clutch_ssh_host");
  const user = localStorage.getItem("clutch_ssh_user");
  const port = localStorage.getItem("clutch_ssh_port");
  if (!host) return "This window's session (no named host to re-attempt).";
  return "Host: " + (user ? user + "@" : "") + host + (port ? ":" + port : "");
}

function connLostPaint(status) {
  connLostStatusEl.textContent = status || "";
}

// ---- the dialog is NOT dismissable ----
// Escape is swallowed here so that neither this box nor anything behind it can
// answer for the user: the ONE way out is a session that answers again. Nothing
// registers dismissOnOverlayPress on this modal, and there is no close button.
connLostModal.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
});

// ---- the announcement: one funnel, raised from wherever the loss is seen ----
// Idempotent by design: several detectors may fire for one outage (the ssh
// close, the dead stream, the failed request), and the user must see one dialog,
// named by the cause that got there first.
function connectionLost(reason) {
  if (connLost) return;
  // A connect attempt of its own is already re-establishing a session, and a
  // connect to another host STOPS the old tunnel — that end is not a loss. The
  // flow reports its own outcome in the picker, so nothing is swallowed; when it
  // fails there, the next detector (the dead stream) raises this dialog with no
  // attempt in flight.
  if (connBusy) return;
  connLost = true;
  connLostTries = 0;
  connLostManualOnly = false;
  // The session this window's run lived in is what just went away: dropping the
  // base says so (and retires the run honestly — see sseRunAtRisk), and the
  // picker stops claiming a connection that does not exist.
  dropStaleBackend();
  renderConnSelector();
  connLostReasonEl.textContent = reason;
  connLostTargetEl.textContent = connLostTargetText();
  connLostWhyEl.textContent = ""; // fresh outage: nothing carried over from the last
  connLostPaint("Reconnecting…");
  connLostModal.classList.remove("hidden", "closing");
  // the dialog is the whole UI now: give it the keys (its own Escape swallow is
  // a listener on the box, and this is what makes a keydown reach it)
  $("#conn-lost-retry").focus();
  connLostAttempt();
}

// called only where a session really answers: the dialog has no other exit
function resolveConnectionLost() {
  if (!connLost) return;
  connLost = false;
  connLostManualOnly = false;
  if (connLostTimer) {
    clearTimeout(connLostTimer);
    connLostTimer = null;
  }
  connLostPaint("");
  connLostWhyEl.textContent = "";
  closeModal(connLostModal);
}

// the password prompt was declined: stop retrying behind the user's back
function connLostNeedsUser() {
  if (!connLost) return;
  connLostManualOnly = true;
  connLostPaint("Waiting for you: reconnect when ready.");
}

function connLostArm() {
  if (connLostTimer) clearTimeout(connLostTimer);
  if (!connLost) return;
  if (connLostManualOnly) return; // the user said no: the button is the way back
  // the first attempt is immediate, so the gap that follows it is the FIRST step
  const idx = Math.max(0, Math.min(connLostTries - 1, CONN_LOST_BACKOFF_MS.length - 1));
  connLostTimer = setTimeout(() => {
    connLostTimer = null;
    connLostAttempt();
  }, CONN_LOST_BACKOFF_MS[idx]);
}

async function connLostAttempt() {
  if (!connLost || connLostAttempting) return;
  connLostAttempting = true;
  connLostTries += 1;
  connLostTimer = null;
  if (connLostTries > 1) connLostPaint(`Reconnecting (attempt ${connLostTries})…`);
  let verdict = "";
  try {
    if (await connLostRecover()) {
      // The door reported success, and that verdict can only come from
      // connLostProve — which waits for connLost to go false, i.e. for a session
      // to answer. That answer already took the dialog down (the only closer is
      // es.onopen in js/sse-stream.js), so there is nothing to close here.
      return;
    }
    verdict = "Not back yet";
  } catch (e) {
    verdict = "reconnect failed: " + ((e && e.message) || e);
  } finally {
    connLostAttempting = false;
  }
  // The password prompt may have been declined while this attempt ran: then the
  // user owns the next move (connLostNeedsUser), and "retrying" would be a lie.
  connLostPaint(connLostManualOnly
    ? "Waiting for you: reconnect when ready" + connLostWhy()
    : verdict + " — retrying." + connLostWhy());
  connLostArm();
}

// the connect flow writes its own verdict into this element (the stage it
// reached, or why it failed): keep it, it is the only specific reason there is
function connLostWhy() {
  const why = (connLostWhyEl.textContent || "").trim();
  return why ? " (" + why + ")" : "";
}

// One attempt at getting a session back. Two doors:
//   1. the remote this window was on: re-establish the tunnel BY NAME, from the
//      standing intent the picker keeps. This is the call "+ New SSH" makes; the
//      difference is that the user no longer has to re-enter anything (the
//      reported dead end: an old host introduced as a new one).
//   2. the host's own session for this window — its heal, a re-claim after a
//      blip, a local session on the desktop.
//
// Which comes first is decided by the tunnel, and the order matters: with the
// SSH hop dead, asking the host first would hand a desktop a LOCAL session and
// quietly abandon the remote the user never left (and on the phone there is no
// local one at all). With the hop alive, the SSH hop is not the thing to redo —
// re-dialling it would lift a working tunnel — and the dead part is the session
// behind it, which is the host's to re-claim.
//
// No door is proof on its own: an adopted URL can name a forwarded port nobody
// serves (that IS the bug this dialog exists for), and a tunnel that came up can
// still front a dead session. The proof is the one that closes the dialog — a
// stream that opened (js/sse-stream.js es.onopen) — so a door reporting success
// is only allowed to claim it once that has happened.
async function connLostRecover() {
  const remote = connLostRemoteIntent();
  const tunnelUp = await connLostTunnelUp();
  if (remote && !tunnelUp) {
    if (await connLostRedial(remote)) return true;
    // It will not answer. Where a local session can exist at all (the desktop),
    // the host's own offer is still a recovery — but only once the remote has
    // spent its tries, and the standing intent goes with it: the picker must
    // stop claiming a host this window is no longer on.
    if (IS_ANDROID || connLostTries < CONN_LOST_HOST_FALLBACK_AFTER) return false;
    localStorage.removeItem("clutch_ssh_connected");
    localStorage.removeItem("clutch_degrade"); // degrade mode died with the tunnel
  }
  return connLostAskHost();
}

// the host's own session for this window, if it holds or can claim one
async function connLostAskHost() {
  if (!(await switchBackendResolved())) return false; // no session: it said so
  return connLostProve();
}

// the standing remote intent the picker keeps — the host to re-dial, or null
// when there is nothing to re-attempt BY NAME (no host remembered, or the user
// left the picker disconnected on purpose)
function connLostRemoteIntent() {
  const host = localStorage.getItem("clutch_ssh_host");
  const user = localStorage.getItem("clutch_ssh_user");
  if (!host || !user || !localStorage.getItem("clutch_ssh_connected")) return null;
  return { host, user, port: localStorage.getItem("clutch_ssh_port") || "22" };
}

function connLostTunnelUp() {
  if (!window.clutchTunnel) return Promise.resolve(false);
  return window.clutchTunnel.status().then((s) => Boolean(s && s.active), () => false);
}

// re-establish the remote the window was on: keys/agent first, the password
// prompt only if the host demands one (the same path the picker's own connect
// takes), and then the only verdict that counts — a session that answers.
async function connLostRedial(intent) {
  const ok = await handleSshConnect(intent.host, intent.user, intent.port, connLostWhyEl);
  if (!ok) return false;
  return connLostProve();
}

// did a session really answer? It answers by opening a stream, and that is what
// takes the dialog down, so the question is simply whether the dialog is still up
// — asked with a bound, because a door that never produces one must not hang the
// attempt (the wait between attempts is the backoff's job).
const CONN_LOST_PROOF_MS = 8000;
function connLostProve(ms = CONN_LOST_PROOF_MS) {
  if (!connLost) return Promise.resolve(true);
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (!connLost) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

$("#conn-lost-retry").addEventListener("click", () => {
  if (!connLost || connLostAttempting) return;
  connLostTries = 0; // the user asked: forget the backoff, and the declined prompt
  connLostManualOnly = false;
  connLostAttempt();
});
