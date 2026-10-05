// the permission prompt and the trust countdown
//
// A guarded tool call is answered here on purpose, including the arming
// countdown that stops a stray keypress from granting trust.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// ---- permission confirm ----
const permModal = $("#perm-modal");
let pendingPerm = null;
// asks this window has already answered: an ask is re-announced while it waits
// and re-delivered on every (re)connect (agent/core/permission.py REANNOUNCE_S,
// agent/api/events.py) — a copy arriving after the verdict must not re-open a
// prompt the user already answered, and one already on screen is rendered in
// place, never as a second dialog (or a restarted trust countdown)
const answeredPerm = new Set();
// ...and the marks are per RUN, not per page. A request_id belongs to the run
// whose gate minted it (agent/core/permission.py), and a run's ids are dead the
// moment it ends. Hosts that predate this fix numbered asks from 1 in EVERY run, so
// a page-lifetime mark swallowed the next run's first prompt: the frame returned
// early, no dialog ever appeared, and the run stayed blocked on an answer nobody
// could give until Stop. The stream calls this at every run boundary
// (js/stream-events.js), so a copy of a LIVE ask is still deduped while an id
// the run that just ended used can never mute a new one.
function forgetAnsweredPerm() {
  if (answeredPerm.size) answeredPerm.clear();
}
function openPerm(ev) {
  if (answeredPerm.has(ev.request_id)) return;
  if (pendingPerm && pendingPerm.request_id === ev.request_id) return;
  pendingPerm = ev;
  const reason = permReason(ev.reason);
  $("#perm-tool").textContent = `Tool: ${ev.tool} — ${reason}`;
  const argsEl = $("#perm-args");
  let txt = ev.args_repr || "";
  let isJson = false;
  // the payload is unwrapped generically: a command-shaped one shows as the
  // command the user is being asked about, anything else as formatted JSON
  const cmd = extractCommand(txt);
  if (cmd !== null) txt = "$ " + cmd;
  else { try { txt = JSON.stringify(JSON.parse(txt), null, 2); isJson = true; } catch (e) {} }
  argsEl.textContent = "";
  if (typeof hljs !== "undefined" && isJson) {
    const code = document.createElement("code");
    code.className = "language-json";
    code.textContent = txt;
    argsEl.appendChild(code);
    try { hljs.highlightElement(code); } catch (e) {}
  } else {
    argsEl.textContent = txt;
  }
  permModal.classList.remove("hidden", "closing");
  setStatus("waiting");
  if (trustArmed()) startTrustCountdown(); // armed: the prompt answers itself in 10s
}
function closePerm() {
  // respond immediately (the agent is blocked); only the visual close animates
  stopTrustCountdown(); // any close (allow/deny/stale final) kills the clock
  closeModal(permModal);
  pendingPerm = null;
}
async function respondPerm(allow) {
  if (!pendingPerm) return;
  const ev = pendingPerm;
  closePerm();
  // the verdict is given HERE, not when the POST lands: a re-announced copy of
  // the ask racing it must never re-open a prompt the user just answered. A
  // transport failure takes the mark back below and puts the prompt back up.
  answeredPerm.add(ev.request_id);
  setStatus("running");
  try {
    await apiFetch("/api/permission/respond", {
      method: "POST",
      body: { request_id: ev.request_id, allow },
    });
  } catch (e) {
    // core/permission.py blocks the agent on this verdict and has NO timeout, so a
    // reply the backend never heard hangs the run for good with the prompt already
    // gone. An HTTP answer (e.status) means the backend DID hear about the request
    // — resolved, or no run waiting for it — and then there is nothing to answer;
    // a transport failure means the gate is still waiting: put the prompt back.
    console.error("[permission] verdict not delivered", e);
    if (e && e.status) return;
    answeredPerm.delete(ev.request_id); // the verdict never arrived: prompt it again
    openPerm(ev);
  }
}
$("#perm-allow").addEventListener("click", () => respondPerm(true));
$("#perm-deny").addEventListener("click", () => respondPerm(false));

// Enter answers Allow. The agent is BLOCKED on this verdict and this prompt is
// the only way to answer it, so the key a user presses by reflex must be the
// permissive one — and nothing else may answer for them: this modal takes no
// backdrop dismiss (a click outside the box used to mean DENY), so a stray
// press can only ever allow, never reject a permission request.
function permKey(e) {
  if (e.key !== "Enter" || e.isComposing || !pendingPerm) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false; // those are the task box's shortcuts
  e.preventDefault(); // a focused Deny button must not take the key too
  respondPerm(true);
  return true;
}
document.addEventListener("keydown", permKey);

// ---- trust mode: permission prompts auto-allow after a short countdown ----
// UI-side only: the armed flag lives in localStorage, the countdown lives here.
// Expiry takes the same respondPerm(true) path as clicking Allow, so the backend
// sees an ordinary allow; deny / any close / disarm cancels the clock. The clock
// is a plain setTimeout chain (1 tick per second) so a closed prompt is seen on
// the next tick at worst.
const TRUST_COUNTDOWN_S = 10;
let trustTimer = null;

function trustArmed() {
  return localStorage.getItem("clutch_trust_all") === "1";
}

function paintTrustBtn() {
  els.trust.textContent = trustArmed() ? "🛡 Trusted" : "🛡 Trust";
}

function setTrustArmed(on) {
  localStorage.setItem("clutch_trust_all", on ? "1" : "0");
  els.trust.classList.toggle("trust-on", on);
  els.trust.title = on
    ? `trust mode ON — prompts auto-allow after ${TRUST_COUNTDOWN_S}s unless denied. Click to disable.`
    : `trust mode OFF — every prompt waits. Click to auto-allow after ${TRUST_COUNTDOWN_S}s.`;
  paintTrustBtn();
  if (!on) stopTrustCountdown();
  else if (pendingPerm) startTrustCountdown(); // arming mid-prompt starts the clock now
}

function startTrustCountdown() {
  stopTrustCountdown();
  if (!trustArmed() || !pendingPerm) return;
  let left = TRUST_COUNTDOWN_S;
  const allowBtn = $("#perm-allow");
  const tick = () => {
    if (!pendingPerm) return; // prompt closed under a pending tick
    if (left <= 0) {
      respondPerm(true); // same path as clicking Allow (which also closes + resets)
      return;
    }
    allowBtn.textContent = `Allow (${left}s)`;
    left -= 1;
    trustTimer = setTimeout(tick, 1000);
  };
  tick();
}

function stopTrustCountdown() {
  if (trustTimer) {
    clearTimeout(trustTimer);
    trustTimer = null;
  }
  $("#perm-allow").textContent = "Allow";
}

els.trust.addEventListener("click", () => setTrustArmed(!trustArmed()));
setTrustArmed(trustArmed()); // paint the stored state on startup

