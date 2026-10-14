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
// The COUNTDOWN THAT DECIDES lives on the far side, in the gate that owns the
// ask (agent/core/permission.py TRUST_COUNTDOWN_S, armed here by
// POST /api/permission/trust): a page in the background is FROZEN — Android
// stops the WebView and every timer in it — so a countdown kept only here
// paused with the page and left the run blocked on a prompt whose answer was
// already armed. What lives here is the label on the button (a WALL-CLOCK
// deadline, so a page that comes back paints the truth instead of the seconds
// it was frozen for) and the arming of that far-side clock. Expiry takes the
// same respondPerm(true) path as clicking Allow, so a visible page still
// answers its own prompt first; the far side's expiry is the backstop for a
// page that is not running, and a copy of the ask arriving after either verdict
// is swallowed by the answered marks above.
const TRUST_COUNTDOWN_S = 10; // keep in step with agent/core/permission.py
let trustTimer = null;
let trustDeadline = 0; // wall-clock ms at which an armed prompt allows

function trustArmed() {
  return localStorage.getItem("clutch_trust_all") === "1";
}

// Mirror the armed flag to the backend, which is what actually counts down.
// Best effort by design: a push that cannot land (no backend yet, a session
// being replaced) costs nothing, because the page's own clock still answers a
// visible prompt and the next (re)connect pushes again (js/sse-stream.js).
async function pushTrustArmed() {
  if (!API_BASE) return; // no session to arm: the connect below pushes it
  try {
    await apiFetch("/api/permission/trust", { method: "POST", body: { armed: trustArmed() } });
  } catch (e) {
    console.warn("[trust] could not mirror the armed flag to the backend", e);
  }
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
  pushTrustArmed(); // arm the far-side clock too: it is the one that keeps ticking
  if (!on) stopTrustCountdown();
  else if (pendingPerm) startTrustCountdown(); // arming mid-prompt starts the clock now
}

// one countdown tick: paint what is left of the WALL-CLOCK deadline and either
// schedule the next or answer. Reading the clock each time (instead of counting
// ticks down) is what makes a thawed page honest: a timer that came due while
// the page was frozen fires late with a deadline already behind it, so the
// prompt it belongs to closes at once instead of reliving its last seconds.
function trustTick() {
  trustTimer = null;
  if (!pendingPerm) return; // prompt closed under a pending tick
  const left = Math.ceil((trustDeadline - Date.now()) / 1000);
  if (left <= 0) {
    respondPerm(true); // same path as clicking Allow (which also closes + resets)
    return;
  }
  $("#perm-allow").textContent = `Allow (${left}s)`;
  trustTimer = setTimeout(trustTick, 1000);
}

// a page that comes back owns a prompt nothing was counting down while it was
// away: re-tick now rather than wait for the overdue timer, so a prompt whose
// deadline already passed (the far side has long since answered it) closes on
// the spot. The platform's own resume signals, exactly as the SSE stream
// listens for them (js/sse-stream.js).
function trustResumeTick() {
  if (typeof document !== "undefined" && document.hidden) return; // still away
  if (!pendingPerm || !trustArmed()) return;
  if (trustTimer) {
    clearTimeout(trustTimer);
    trustTimer = null;
  }
  trustTick();
}

function startTrustCountdown() {
  stopTrustCountdown();
  if (!trustArmed() || !pendingPerm) return;
  trustDeadline = Date.now() + TRUST_COUNTDOWN_S * 1000;
  trustTick();
}

function stopTrustCountdown() {
  if (trustTimer) {
    clearTimeout(trustTimer);
    trustTimer = null;
  }
  trustDeadline = 0;
  $("#perm-allow").textContent = "Allow";
}

// every way the platform announces that this page stops and starts running
// again: a hidden tab, the WebView frozen outright, a bfcache-style suspend
document.addEventListener("visibilitychange", trustResumeTick);
window.addEventListener("pageshow", trustResumeTick);
window.addEventListener("focus", trustResumeTick);

els.trust.addEventListener("click", () => setTrustArmed(!trustArmed()));
setTrustArmed(trustArmed()); // paint the stored state on startup

