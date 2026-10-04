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
// dialog it raises IS the reconnect entry. It has exactly TWO exits and both are
// deliberate: the first session that answers again (adopted in place — same
// project, same transcript — rather than in a fresh window), and the user's own
// Cancel, which takes the window out of the outage for good — no session, no
// dialog, no redial — by landing it where a fresh start lands: the welcome page
// (see connLostCancel and connLostQuit). There is still no backdrop press, no
// Escape and no ×: a stray key or a missed tap must not abandon a reconnect.
// What a dismissable modal lacked was not an exit, it was a LABELLED one.
//
// The redial behind it has no end of its own any more (the backoff grows to a
// steady 128s and keeps trying — a phone that comes back into signal must
// reconnect with nobody touching anything), and a dialog with no upper bound and
// no labelled way out is a window held hostage: that is what the Cancel is for.
//
// The door back is the host this window was on and no other: the standing intent
// says which one that is, and a remote that will not answer keeps its tries. The
// dialog never quietly swaps hosts under the user (see connLostRecover).
//
// It reads as little as possible, and what it shows is state, not advice: the
// cause, the host it is going back to, what the attempt is doing (its own line
// and its own progress bar — the same bar the picker's attempts animate), and the
// flow's verdict when there is one. Of its two buttons only "Reconnect now" is
// held back while an attempt runs — a live one is an invitation to start a second
// — and the Cancel is on screen for the WHOLE life of the dialog, attempt in
// flight or not: the redial above has no end of its own, and a dialog the user
// cannot leave is a window held hostage. It is not "stop this attempt" — it is "I
// am done with this outage": the window's session ends and the page reloads into
// the welcome page, which is what quitting the app and starting it again would do
// (connLostCancel, connLostQuit).
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
// the flow's verdict, in its own line: the dialog paints its progress into
// #conn-lost-status, so reading that back as "why" quoted the dialog's own
// "Reconnecting…" at the user ("Not back yet — retrying. (Reconnecting…)"). It is
// the stage the attempt reached, or why it failed — never quoted into the
// progress line beside it (that would be the same fact twice).
const connLostWhyEl = $("#conn-lost-why");
// the dialog's own chrome: the progress bar an attempt in flight animates, and the
// two buttons that are the user's once it is over (connLostChrome, below)
const connLostProgressEl = $("#conn-lost-progress");
const connLostActionsEl = $("#conn-lost-actions");
const connLostRetryBtn = $("#conn-lost-retry");
const connLostCancelBtn = $("#conn-lost-cancel");

// How long to wait before the next automatic attempt: the same ladder the LLM
// client redials on and the same one the ssh hop uses (js/../tunnel-connect.js),
// 1,2,4,...,128s, held at the top. A phone that comes back into signal must
// reconnect with nobody touching anything — and a reconnect that has already
// been running for a minute is exactly the one the far side is closest to
// answering, so the gap must not settle at a "steady 30s" and hammer a host that
// is simply down either: doubling is what keeps both cheap. Nothing here gives
// up; the way out of a redial that never lands is the user's Cancel.
const CONN_LOST_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

// the dialog's one line for "nothing is running: it is your move" (a declined
// password, or an attempt that came back after one). One string, one meaning — the
// button under it says what the move is.
const CONN_LOST_WAITING = "Waiting for you";

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

// The dialog's chrome, drawn from the ONE fact that decides it — is an attempt in
// flight? The picker makes the same swap between #conn-progress and #conn-actions,
// and for the same reason: while a reconnect runs there is nothing to reconnect to,
// so a live "Reconnect now" would read as a second door and swallow its own press.
// Cancel is the exception and is never taken off screen: it does not act on the
// attempt at all — it leaves the outage (see connLostCancel).
// The bar is the attempt's own: it animates until js/conn-flow.js paints a stage
// into its fill.
function connLostChrome() {
  // The dialog can come down while an attempt is still finishing (the user's own
  // Cancel): there is no chrome to paint for a dialog nobody is looking at, and
  // focusing a button inside a hidden modal would take the keys nowhere.
  if (!connLost) return;
  connLostActionsEl.classList.remove("hidden"); // the row is up for the whole outage
  connLostRetryBtn.classList.toggle("hidden", connLostAttempting);
  if (connLostAttempting) {
    connBarWaiting(connLostProgressEl);
  } else {
    connLostProgressEl.classList.add("hidden");
    // the attempt is over and the dialog is still up: the keys belong to the door
    // that just came back (Reconnect, the first thing to press). NOT while an
    // attempt is in flight — the Cancel is on screen then, and a focused button
    // one stray tap from quitting the window is not a risk worth taking.
    connLostRetryBtn.focus();
  }
}

// ---- no accidental exit ----
// Escape is swallowed here so that neither this box nor anything behind it can
// answer for the user: a stray keystroke must not drop a reconnect that is in
// progress. Nothing registers dismissOnOverlayPress on this modal, and there is
// no × either. The two things that do end it are both deliberate acts: a session
// that answered (resolveConnectionLost) and the user's own Cancel (below).
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
  // the dialog is the whole UI now: give it the keys (its own Escape swallow is a
  // listener on the box, and this is what makes a keydown reach it). The button is
  // not on screen while an attempt runs, so the keys go to the dialog itself and
  // the attempt below paints its chrome (bar up, nothing to press) in this same
  // task: the user never sees a Reconnect it cannot honour.
  connLostModal.focus();
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
  connLostPaint(CONN_LOST_WAITING);
}

// The user's own exit — and this is the whole of it: leaving the outage is
// leaving the window's session behind, which is the state a fresh start boots
// into. It is an explicit, labelled act, which is the difference between this and
// the × the dialog does not have: it ends the outage the USER has been told about,
// so nothing here may keep asking.
//
// What it does, and why each part is needed:
//   * the standing intent goes FIRST, exactly as the picker's own Cancel does
//     (js/conn-flow.js): the hop this window asked for is no longer wanted, so
//     the teardown that follows is not a LOST session — the renderer reads
//     "tunnel:ended" as a loss only while the intent is there
//     (backend-lifecycle.js), and this is what keeps a detector from raising the
//     dialog again for an outage the user has just ended. The same is true of the
//     next page load: reconciledBackendUrl has nothing to dial without the intent;
//   * the redial timer is disarmed and connLost goes false: no attempt of ours is
//     left armed, and an attempt already in flight loses its tail (connLostAttempt
//     checks connLost before it reports a verdict or arms the next one);
//   * the badge is settled to idle, and it is NOT the invented idle sseDegrade
//     refuses to paint: with no session this window has nothing to show and
//     nothing to stop, and leaving a stale "running" would be worse than a lie —
//     it would block the picker (openFsBrowser refuses while a run is active)
//     and make Stop raise this very dialog again. The run's real fate is not
//     guessed here: sseRunAtRisk is already set, so the next session's own
//     history settles it (see js/stream-events.js);
//   * the picker stops claiming a connection, the dialog comes down — and then the
//     window itself goes: connLostQuit tears the tunnel down and reloads, so the
//     page boots exactly as it would after quitting the app and starting it again
//     (no session, no dialog, nothing dialled). Cancel is therefore usable at any
//     moment, attempt in flight or not: it is not "stop trying", it is "I am done".
function connLostCancel() {
  if (!connLost) return;
  localStorage.removeItem("clutch_ssh_connected");
  localStorage.removeItem("clutch_degrade"); // exiting the degrade mode too
  if (connLostTimer) {
    clearTimeout(connLostTimer);
    connLostTimer = null;
  }
  connLost = false;
  connLostManualOnly = false;
  connLostPaint("");
  connLostWhyEl.textContent = "";
  setStatus("idle");
  renderConnSelector(); // the picker claims no connection: there is none
  closeModal(connLostModal);
  connLostQuit(); // and the window leaves the outage the way a fresh start arrives
}

// How long the teardown is given before the reload goes ahead anyway. The bound is
// the point: "the host did not answer" must not be a reason the user cannot leave.
const CONN_LOST_EXIT_MS = 2000;

// ---- the note the exit leaves for the page that follows it ----
//
// The reload is what gets a clean page, and it is also the ONE thing that can hand
// the new page the very session the user just left: its boot asks the host for a
// session (app.js resolveApiBase, and js/backend-lifecycle.js reconciledBackendUrl
// when the tunnel still answers), and the host is what hands sessions out. That ask
// is answered by claimWindowBackend from what the host still holds for this window —
// so a teardown that has not finished yet (and the bound above exists precisely for
// the case where it does not finish) is still holding the old claim when the new
// page asks for one.
//
// So the exit also leaves a mark, and the page that follows reads it BEFORE it asks
// anything (connLostExitPending): it finishes the teardown the exit began (idempotent
// — the exit's own call either landed or is still queued) and claims nothing, which
// is what the exit promised: a boot with no session, no dialog, nothing dialled.
// sessionStorage, not localStorage: the mark belongs to this page life (a real quit
// takes it with it), and the user's own Connect clears it (js/conn-flow.js) — so the
// only boot it can ever hold back is one nobody asked for.
const CONN_LOST_EXIT_KEY = "clutch_conn_lost_exit";
// the successor's own bound on that teardown: shorter than the exit's, because this
// one is not holding a user's press down — and it must never keep a boot open.
const CONN_LOST_EXIT_BOOT_MS = 1500;

function connLostExitMark() {
  try {
    sessionStorage.setItem(CONN_LOST_EXIT_KEY, "1");
  } catch (e) {
    /* no storage (a harness, or a browser with it switched off): the teardown is
       still the exit — only the successor's guard is missing */
  }
}

// the user's own Connect: they asked for a session, so the exit's note is spent
// (js/conn-flow.js, the two doors every connect goes through)
function connLostExitClear() {
  try {
    sessionStorage.removeItem(CONN_LOST_EXIT_KEY);
  } catch (e) {
    /* nothing to clear without storage */
  }
}

// read by the boot path before it asks the host for anything (app.js,
// js/backend-lifecycle.js)
function connLostExitPending() {
  try {
    return sessionStorage.getItem(CONN_LOST_EXIT_KEY) === "1";
  } catch (e) {
    return false;
  }
}

// the successor's half of the exit: once per page life, bounded like the exit's own
// wait, and never allowed to throw into the boot path. The call is idempotent by
// nature (the host releases a claim it no longer holds and stopTunnel nulls what it
// closes), so asking twice is the same as asking once.
let connLostExitToreDown = false;
function connLostExitBootTeardown() {
  if (connLostExitToreDown) return Promise.resolve();
  connLostExitToreDown = true;
  try {
    if (!window.clutchTunnel || !window.clutchTunnel.disconnect) return Promise.resolve();
    return Promise.race([
      Promise.resolve(window.clutchTunnel.disconnect()).catch(() => {}),
      new Promise((r) => setTimeout(r, CONN_LOST_EXIT_BOOT_MS)),
    ]);
  } catch (e) {
    return Promise.resolve();
  }
}

// Exit the window — the second half of Cancel, and the one that makes it equal to
// quitting and reopening. The reload is what gets a clean page (no session, no
// dialog, no redial: the welcome page is what a page with nothing claimed boots
// into, js/boot.js), and it only works if the tunnel is down FIRST: the tunnel
// lives in the MAIN process (Electron, ui/preload.js) or in the Android host
// (bridge-shim → android-host), so a reload that left it up would boot into the
// very session the user just left — the new page's own claimWindowBackend would
// hand it back and this dialog would be up again within seconds. So: disconnect,
// then reload.
//
// The teardown is bounded, and that is the one place this exit is not literally a
// restart: the IPC call runs to completion in the main process whatever the
// renderer does, but a reload that beat it could hand the new page the OLD session
// one beat before it dies (its own claim on Android, resolveApiBase on the
// desktop). Two seconds is far longer than a teardown takes, and the alternative —
// waiting without a bound — is exactly the dead end this exit exists to end.
async function connLostQuit() {
  connLostExitMark(); // FIRST: the reload must never outrun the note it leaves behind
  let bye = Promise.resolve();
  try {
    if (window.clutchTunnel && window.clutchTunnel.disconnect) {
      bye = Promise.resolve(window.clutchTunnel.disconnect()).catch(() => {});
    }
  } catch (e) {
    /* the teardown is best effort, the reload is not */
  }
  await Promise.race([bye, new Promise((r) => setTimeout(r, CONN_LOST_EXIT_MS))]);
  window.location.reload();
}

function connLostArm() {
  if (connLostTimer) clearTimeout(connLostTimer);
  if (!connLost) return;
  if (connLostManualOnly) return; // the user said no: the button is the way back
  // A window nobody is looking at has nothing to reconnect FOR yet: the stream
  // itself is suspended while the page is hidden (js/sse-stream.js), and a try from
  // behind it only wakes the phone's radio for an answer nobody can see. The arm
  // waits; the listener below fires the attempt the moment the user looks, so the
  // redial still needs nobody touching anything — it just stops paying for a page
  // that is not there.
  if (typeof document !== "undefined" && document.hidden) return;
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
  // this attempt's verdict is this attempt's to write: the flow's last line (a stage,
  // or why the last one failed) is not evidence about this one
  connLostWhyEl.textContent = "";
  connLostChrome(); // bar up, button down: an attempt is in flight
  if (connLostTries > 1) connLostPaint(`Reconnecting (attempt ${connLostTries})…`);
  let verdict = "";
  try {
    if (await connLostRecover()) {
      // The door reported success, and that verdict can only come from
      // connLostAwaitAnswer — which waits for connLost to go false, i.e. for a
      // session to answer. That answer already took the dialog down (the only
      // closer is es.onopen in js/sse-stream.js), so there is nothing to close
      // here. Had it timed out instead, the notice below says so and the retry
      // still goes to the same host.
      return;
    }
    verdict = "Not back yet";
  } catch (e) {
    verdict = "reconnect failed: " + ((e && e.message) || e);
  } finally {
    connLostAttempting = false;
    connLostChrome(); // and the user's door back is on screen again
  }
  // The user's own Cancel may have landed while this attempt was in flight: it
  // ended the outage, disarmed everything and put the page on its way to a fresh
  // start. A verdict and a next redial would then land in a dialog nobody is in
  // any more (and would be the one thing the exit promised not to leave behind).
  if (!connLost) return;
  // The password prompt may have been declined while this attempt ran: then the
  // user owns the next move (connLostNeedsUser), and "retrying" would be a lie.
  connLostPaint(connLostManualOnly ? CONN_LOST_WAITING : verdict + " — retrying.");
  connLostArm();
}

// One attempt at getting a session back, through the ONE door this window has:
// the host it was on. There are two ways to be on a host, and which one applies
// is a fact this window holds, not a judgement about the remote:
//   1. a NAMED remote whose hop is down: the hop is the missing piece, and the
//      standing intent says exactly what to re-dial — the same call the picker's
//      own "+ New SSH connection" makes, so the user re-enters nothing. That was
//      the reported dead end: an old host introduced as a new one.
//   2. no named remote, or its hop alive: the session this window was on is the
//      host's to hand back — its heal, a re-claim after a blip, or the local
//      session of a desktop that never had a remote.
// Which comes first is not a preference: with the SSH hop dead, asking the host
// first would hand a desktop a LOCAL session and quietly move the user to a
// machine they never asked for, and the phone has no local session at all (N4).
//
// What this deliberately does NOT do is give up on the remote after a few tries
// and switch hosts behind the user's back (a try-counted branch that cleared
// `clutch_ssh_connected` — their own standing request — and then adopted
// whatever the host offered). There is no second door here: a window that was on
// a host stays on that host, and until that host answers the dialog says it is
// not back yet. The verdict is never the door's to give — see connLostAwaitAnswer.
//
// No door is proof on its own: an adopted URL can name a forwarded port nobody
// serves (that IS the bug this dialog exists for), and a tunnel that came up can
// still front a dead session. The proof is the one that closes the dialog — a
// stream that opened (js/sse-stream.js es.onopen) — so a door reporting success
// is only allowed to claim it once that has happened.
async function connLostRecover() {
  const remote = connLostRemoteIntent();
  if (remote && !(await connLostTunnelUp())) return connLostRedial(remote);
  return connLostAskHost();
}

// the host's own session for this window, if it holds or can claim one
async function connLostAskHost() {
  if (!(await switchBackendResolved())) return false; // no session: it said so
  return connLostAwaitAnswer();
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
  return connLostAwaitAnswer();
}

// How long a door is given to produce the only verdict that counts before the
// dialog says "Not back yet". This is a NOTICE throttle, not a state change: a
// window is back when a stream opens (es.onopen, js/sse-stream.js) and never
// because this wait said so — the question asked here is simply "is the dialog
// still up?", and its answer only chooses the sentence. The bound exists so that
// a door which never produces a session cannot hold the attempt (the retry
// button included) open forever; the wait between attempts is the backoff's job.
const CONN_LOST_NOTICE_MS = 8000;
function connLostAwaitAnswer(ms = CONN_LOST_NOTICE_MS) {
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

// The other half of the hidden-page rule in connLostArm: an arm that was withheld
// because nobody was looking fires the moment the user looks — so the redial still
// needs nobody touching anything (no press, no click), it just stops paying for a
// page that is not there. An attempt already in flight, or a wait already armed for
// this outage, is left alone: this listener is the withheld arm's door, not a second
// one that could put two attempts on the wire.
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("visibilitychange", () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!connLost || connLostAttempting || connLostTimer) return;
    connLostAttempt();
  });
}

$("#conn-lost-retry").addEventListener("click", () => {
  if (!connLost || connLostAttempting) return;
  connLostTries = 0; // the user asked: forget the backoff, and the declined prompt
  connLostManualOnly = false;
  connLostAttempt();
});

// The other door, and the only one this window opens on its own account (see
// connLostCancel): an explicit, labelled way out of an outage that would
// otherwise retry for as long as the host stays down. It acts on the OUTAGE, not
// on the attempt — that is why it can be pressed while one is in flight (the same
// press a second earlier would have been an empty gap, and there is nothing the
// user must wait for to leave) — and what it does is the whole exit: the window
// tears its tunnel down and reloads into a fresh start.
$("#conn-lost-cancel").addEventListener("click", () => {
  connLostCancel();
});
