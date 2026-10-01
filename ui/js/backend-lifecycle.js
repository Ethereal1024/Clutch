// the backend this window talks to — switching, degrading, healing
//
// `switchBackend` is the one door API_BASE moves through, and it refuses the
// supervisor's lifecycle port: that port answers no API, so adopting it (the
// old "fallback") was a guaranteed "Failed to fetch". Degrade mode re-points a
// live local session at the remote exec bridge; a remote that goes away is
// re-attempted (reconciled, re-connected, retried) instead of being replaced by
// a local backend the phone does not have — and the announcement of that loss,
// with the one way back from it, belongs to ui/js/conn-lost.js (connectionLost).
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// Switch the active backend in place without a full page reload. The
// supervisor's lifecycle port is refused: it is not a backend, and letting it
// through (the old "fallback") pointed the whole window at a port that answers
// no API — a guaranteed "Failed to fetch", and on the phone a port that cannot
// exist at all. Returns whether the base actually moved.
function switchBackend(url) {
  const clean = url ? String(url).replace(/\/+$/, "") : "";
  if (!clean || clean === SUPERVISOR_BASE) {
    console.warn("[backend] refused a non-session base:", url);
    return false;
  }
  // Moving the base while a run is in flight replaces the SESSION that run lives
  // in: the host releases the old one (its heartbeat/self-heal, a re-claim, the
  // user connecting elsewhere), so the new session starts with nothing in flight
  // and its status frame will honestly say idle. Remember the run, so that frame
  // cannot slip the badge from running to idle without a word.
  if (busy && clean !== API_BASE) sseRunAtRisk = true;
  API_BASE = clean;
  localStorage.setItem("clutch_api_url", API_BASE);
  reconnectSSE();
  return true;
}

// Ask the host (main process / Android bridge) for THIS window's session URL
// and adopt it. null means "no session": there is no second route to guess at,
// so the window stays on "not running" instead of being pointed at a local port
// that cannot serve it — the host announces a real URL when it has one
// (backend:base-changed).
async function switchBackendResolved() {
  if (!window.clutchApi) return false;
  const url = await window.clutchApi.baseUrl();
  if (!switchBackend(url)) return false;
  await reapplyDegradeIfNeeded();
  return true;
}

// degrade mode is a per-process setting that dies with the session: re-apply
// it whenever the session is (re)claimed
async function reapplyDegradeIfNeeded() {
  const raw = localStorage.getItem("clutch_degrade");
  if (!raw || !window.clutchTunnel) return;
  const s = await window.clutchTunnel.status();
  if (!s.active || !s.execBridge) {
    // the tunnel is gone: degrade mode is meaningless, drop the marker
    localStorage.removeItem("clutch_degrade");
    return;
  }
  let bridge = null;
  try {
    bridge = JSON.parse(raw).bridge;
  } catch (e) {
    localStorage.removeItem("clutch_degrade");
    return;
  }
  try {
    await apiFetch("/api/backend", {
      method: "POST",
      body: { mode: "ssh", bridge, workspace: "~" },
    });
  } catch (e) {
    /* best effort: the next re-apply retries */
  }
}

// ---- SSH-tools degradation (host alive but unusable for bootstrap) ----
// local agent, remote exec bridge; true = degraded, false = tunnel dead

async function tryDegradeToSshTools() {
  if (!window.clutchTunnel) return false;
  const s = await window.clutchTunnel.status();
  // degradable only while the tunnel is alive (a dead tunnel has no bridge)
  if (!s.active || !s.execBridge) return false;
  // resolve the current backend first: the main process may have fallen back
  // to a fresh local session
  const url = await window.clutchApi.baseUrl();
  if (!url) return "not running";
  try {
    await apiFetch("/api/backend", {
      method: "POST",
      body: { mode: "ssh", bridge: s.execBridge, workspace: "~" },
      base: url,
    });
  } catch (e) {
    // .status = the backend answered but refused the mode (session gone);
    // no .status = the request itself failed (backend unreachable)
    return e.status ? "not running" : "unreachable";
  }
  // persist the mode: the session process may be re-created later
  localStorage.setItem("clutch_degrade", JSON.stringify({ bridge: s.execBridge }));
  return true;
}

async function resetBackendLocal() {
  // nothing to reset without a resolved base: DEFAULT_BASE is the supervisor
  // sentinel until this machine's own session is claimed, and the supervisor
  // does not serve /api/backend — posting there is a guaranteed "Failed to fetch"
  if (DEFAULT_BASE === SUPERVISOR_BASE) return;
  try {
    // DEFAULT_BASE, not API_BASE: this machine's local session answers even
    // while no window has claimed it yet
    await apiFetch("/api/backend", { method: "POST", body: { mode: "local" }, base: DEFAULT_BASE });
  } catch (e) {
    /* the local server may be down; the renderer still falls back in place */
  }
}

// reconcile the stored URL with the tunnel's real state; a live tunnel is
// authoritative, a dead-tunnel leftover falls back to the local backend
async function reconciledBackendUrl() {
  if (!window.clutchTunnel) return null;
  const s = await window.clutchTunnel.status();
  const override = localStorage.getItem("clutch_api_url");
  const flag = localStorage.getItem("clutch_ssh_connected");
  if (s.active) {
    // live tunnel: the main process owns this window's session URL — ask it
    const target = await window.clutchApi.baseUrl();
    if (target && override !== target) {
      localStorage.setItem("clutch_ssh_connected", "1");
      return target;
    }
    return null;
  }
  if (flag) {
    if (IS_ANDROID) {
      // device report #2: "fall back to the local backend" is not a fallback on
      // the phone — there is no agent behind 127.0.0.1, so that branch pointed
      // the app at a dead port while the picker still showed the saved host
      // (the reported "selected SSH client but 127.0.0.1:8891 + connection
      // error"). Keep the flag: it is the user's standing intent, and
      // autoReconnectAndroid() re-establishes the host with it.
      return null;
    }
    // stale SSH leftover: fall back to the local backend via the main process
    localStorage.removeItem("clutch_ssh_connected");
    await switchBackendResolved();
    return null; // switchBackendResolved already switched
  }
  return null;
}

// device report #2: a phone that was on an SSH backend must come back to it.
// Re-entry runs the same path as the user's own connect (keys first, password
// prompt only if the host demands one) instead of leaving the UI pointed at a
// local backend that cannot exist there.
async function autoReconnectAndroid() {
  if (!IS_ANDROID || !window.clutchTunnel) return false;
  // no flag = the user left the picker disconnected on purpose
  if (!localStorage.getItem("clutch_ssh_connected")) return false;
  const host = localStorage.getItem("clutch_ssh_host");
  const user = localStorage.getItem("clutch_ssh_user");
  if (!host || !user) return false;
  const s = await window.clutchTunnel.status().catch(() => null);
  if (s && s.active) return true; // tunnel survived: already the active backend
  const ok = await handleSshConnect(host, user, localStorage.getItem("clutch_ssh_port") || "22", connStatus);
  if (!ok) {
    // never leave the picker claiming a host we are not on
    renderConnSelector();
    connStatus.textContent = "Not connected — " + user + "@" + host + " did not come back.";
  }
  return Boolean(ok);
}

// The backend this window was talking to is gone: drop the stale session URL so
// nothing keeps posting into a port nobody serves, and the picker stops
// claiming a connection. The standing intent (clutch_ssh_connected) is the
// caller's to keep. The next real URL arrives via switchBackend /
// backend:base-changed.
function dropStaleBackend() {
  // the session this window's run lived in is what just went away: same story as
  // a base move, and it must not end in a silent idle either
  if (busy) sseRunAtRisk = true;
  API_BASE = null;
  localStorage.removeItem("clutch_api_url");
  reconnectSSE(); // closes the dead stream; connectSSE bails on a null base
}

// The tunnel died mid-session. A dropped remote is neither a reason to quietly
// point the window at a local port (on the phone there is no local backend to
// point at — N4 — so that "fallback" could only produce "Failed to fetch" while
// the picker claimed 127.0.0.1:8890, a port that answers no API) nor a toast that
// dismisses itself: this window has no session, and the ONLY door back is the
// dialog ui/js/conn-lost.js raises — it re-attempts this very host, by name, so
// the user never has to introduce an old host as a new one.
if (window.clutchTunnel) {
  window.clutchTunnel.onEnd(() => {
    // the tunnel (and its exec bridge) is gone: any degrade mode dies with it
    localStorage.removeItem("clutch_degrade");
    // no flag = the user's own disconnect (the picker's Cancel/Disconnect):
    // they left the remote on purpose, so there is no lost session to announce
    if (!localStorage.getItem("clutch_ssh_connected")) return;
    const pickerOpen = !fsModal.classList.contains("hidden");
    connectionLost("lost the remote connection");
    // the picker must not keep claiming a connection that does not exist; with
    // a session on its way back it re-lists itself (see loadDir's waitBackend)
    if (pickerOpen) refreshPicker();
  });
}

// the main process re-established this window's session: point the app at the new URL
if (window.clutchApi && window.clutchApi.onBaseChanged) {
  window.clutchApi.onBaseChanged((url) => {
    if (url) switchBackend(url);
    // null is an answer too, and the honest one: the host looked and this window
    // has no session (no tunnel, and no local one either). Staying on the dead
    // URL was the reported "Connected: http://127.0.0.1:4xxxx" that answered
    // nothing — the dialog is what replaces it.
    else connectionLost("the host has no session for this window");
  });
}
