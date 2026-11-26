// the backend this window talks to — switching, healing
//
// `switchBackend` is the one door API_BASE moves through, and it refuses the
// supervisor's lifecycle port: that port answers no API, so adopting it (the
// old "fallback") was a guaranteed "Failed to fetch". A remote that goes away is
// re-attempted (reconciled, re-connected, retried) instead of being replaced by
// a local backend the phone does not have — and the announcement of that loss,
// with the one way back from it, belongs to ui/src/renderer/conn-lost.ts (connectionLost).
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { SUPERVISOR_BASE, hostSessionUrl } from "./app";
import { IS_ANDROID } from "./env";
import { refreshPicker } from "./conn-flow";
import { connLostExitPending, connectionLost } from "./conn-lost";
import { renderConnSelector, noteBrowsedOn } from "./conn-store";
import { fsModal, fsPath, loadDir } from "./fs-browser";
import { reconnectSSE } from "./sse-stream";
import { state } from "./state";
import { busy } from "./stream-view";
import { eventsEl } from "./els";
import { activeSlotId, activeTab, adoptBase, asMachine, claimTab, refreshHopMirror, rewatchTab, tabForSlot, unwatchAll } from "./slots";

// Switch the active backend in place without a full page reload. The
// supervisor's lifecycle port is refused: it is not a backend, and letting it
// through (the old "fallback") pointed the whole window at a port that answers
// no API — a guaranteed "Failed to fetch", and on the phone a port that cannot
// exist at all. Returns whether the base actually moved.
export function switchBackend(url) {
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
  if (busy && clean !== state.apiBase) state.sseRunAtRisk = true;
  state.apiBase = clean;
  // sessionStorage, not localStorage: an API URL names THIS window's session, and
  // localStorage is shared by every window in the process (one Electron instance,
  // one profile) — a global key here made one window's base the next window's
  // remembered value. It survives a reload with the page, which is all it is for.
  sessionStorage.setItem("clutch_api_url", state.apiBase);
  // notify status-bar.ts
  document.dispatchEvent(new CustomEvent("clutch:backend-changed", { detail: state.apiBase }));
  // The base moved; the LOG did not. This heals the stream onto the new session —
  // and cannot name a project, so a window that has adopted none (a boot with no
  // tab, a pane on a card or the welcome page) opens nothing here.
  reconnectSSE();
  return true;
}

// Ask the host (main process / Android bridge) for THIS window's session URL
// and adopt it. The ask is app.ts hostSessionUrl() and not baseUrl() directly:
// that is where the exit's note is read before the ask (a boot after the conn-lost
// Cancel claims nothing) and where the supervisor sentinel is refused. null means
// "no session": there is no second route to guess at, so the window stays on
// "not running" instead of being pointed at a local port that cannot serve it —
// the host announces a real URL when it has one (backend:base-changed).
export async function switchBackendResolved() {
  if (!switchBackend(await hostSessionUrl())) return false;
  return true;
}

// The reconnect door for a page with TABS: there is no window-level session to
// re-resolve — the visible tab owns one, and after a hop the host is the one
// that can re-bind its far-side session (heartbeat-first, never a replacement).
// The session still has the .clc open, so a reconnect with the tab's watermark
// is enough; if it was provably gone, the SSE subscription adopts the project.
export async function switchBackendActiveSlot() {
  const tab = activeTab();
  if (!tab) return switchBackendResolved();
  const base = await claimTab(tab);
  if (!base) return false;
  adoptBase(base);
  // the visible tab's log is still what this window reads: re-open it on the
  // session that just answered (the pane adopted that scope when the tab opened)
  reconnectSSE();
  return true;
}

// Is the claim the host holds for ONE slot remote (a machine other than this
// one)? The renderer may not assume it: `slot:status` answers
// { claimed, executor, remote, url, target } without claiming anything
// (host-core.ts slotStatus). "Could not ask" (a build with no slotStatus, a
// thrown IPC) answers NO — that is the safe half, because the bit it guards is
// the flag the picker reads as "this window is on the saved host".
async function claimedByTunnel(slot) {
  if (!(window.clutchApi && window.clutchApi.slotStatus)) return false;
  try {
    const st = await window.clutchApi.slotStatus(slot);
    return Boolean(st && st.claimed && st.remote);
  } catch (e) {
    return false;
  }
}

// Tell the picker WHICH machine the session it is browsing runs on — the fact the
// ✓, the selected entry and the "Connected:" line are drawn from (conn-store.ts,
// browsedOn). The session is the one this window's BASE is, so the answer only
// counts while it is still about that base: a host may take a moment to answer,
// and a base that moved in the meantime makes the answer about a session nobody is
// browsing. Which slot to ask about is the caller's to name, because only the
// caller knows which session the body will list (the active tab's, a tab whose
// session the host just announced, or the window's own default "").
//
// Nothing is drawn here: the callers redraw once this settles, so a picker that is
// mid-attempt keeps the line that attempt put on it. An unanswerable ask (a build
// with no slotStatus, a thrown IPC, a remote with no named target) clears the
// record rather than guessing — the safe half: no ✓ is a smaller lie than a ✓ on
// the wrong machine.
export async function refreshBrowsedMachine(slot = activeSlotId()) {
  const clean = (v) => (v ? String(v).replace(/\/+$/, "") : "");
  const base = clean(state.apiBase);
  if (!base || !(window.clutchApi && window.clutchApi.slotStatus)) {
    noteBrowsedOn(null, null);
    return;
  }
  let st;
  try {
    st = await window.clutchApi.slotStatus(slot);
  } catch (e) {
    noteBrowsedOn(null, null);
    return;
  }
  // the answer is only worth anything while it still describes what is browsed
  const url = st && st.claimed ? clean(st.url) : "";
  if (clean(state.apiBase) !== base || url !== base) {
    noteBrowsedOn(null, null);
    return;
  }
  if (!st.remote) {
    noteBrowsedOn(base, null); // this machine's session: no host to tick
    return;
  }
  const machine = asMachine(st.target);
  if (!machine) {
    noteBrowsedOn(null, null);
    return;
  }
  noteBrowsedOn(base, machine);
}

// reconcile the stored URL with the tunnel's real state; a live tunnel is
// authoritative, and a dead-tunnel leftover falls back to the local backend only
// for a slot whose own claim is not remote — the flag alone says where this window
// once connected, never where the SLOT it is reconciling is.
//
// `slot` is the session this reconcile is FOR, and it defaults to the window's own
// (""). A caller that is acting for one tab passes that tab's slot: the ask claims
// what it names, so reconciling the default slot while a tab is on a machine would
// start a second session here and hand its URL back to be adopted — the window then
// browses this machine while its tab, and the picker, still say the host.
export async function reconciledBackendUrl(slot = "") {
  if (!window.clutchTunnel) return null;
  // The second claim entry, and the one that fires when the tunnel still answers
  // (s.active below asks the host for THIS window's session). Same note, same read-
  // before-ask as app.ts: a boot that follows the exit claims nothing. No teardown is
  // started here — resolveApiBase runs first in boot.ts and owns that wait; this
  // guard only refuses the claim (fs-browser.ts reaches here without a boot too).
  if (connLostExitPending()) return null;
  const s = await window.clutchTunnel.status();
  const override = sessionStorage.getItem("clutch_api_url");
  const flag = localStorage.getItem("clutch_ssh_connected");
  if (s.active) {
    // live tunnel: the main process owns this window's session URL — ask it
    const target = await hostSessionUrl(slot);
    if (target && override !== target) {
      // The standing intent is written only for a claim that really is the
      // tunnel's: a slot that fell back to a session on THIS machine is working
      // here, and marking it SSH-connected is how the picker came to offer a host
      // it could not dial (the ✓ it would not move off). It is not the ✓ itself —
      // the picker asks the host which machine its session is on (conn-store.ts
      // browsedOn) — but it is what a lost hop is announced by and what a fresh
      // connect spends. Where the claim cannot be asked about, nothing is claimed
      // on its behalf either.
      if (await claimedByTunnel(slot)) localStorage.setItem("clutch_ssh_connected", "1");
      return target;
    }
    return null;
  }
  if (flag) {
    // The flag is the standing intent of a window that once connected — it is not
    // evidence about the session `slot` holds. With one named hop per TAB the
    // window's own tunnel can be down while the tab's session is up and remote, and
    // this branch used to answer that by asking for the WINDOW's default slot
    // (switchBackendResolved → hostSessionUrl("")): that CLAIMS a session on this
    // machine and adopts it, which is how a picker opened on a remote host listed
    // this machine's files and moved the whole window off the tab's session. So ask
    // the slot this reconcile is for first: if its claim really is remote, that is
    // the session to browse and the intent is still true — keep the flag.
    if (await claimedByTunnel(slot)) {
      const target = await hostSessionUrl(slot);
      return target && override !== target ? target : null;
    }
    if (IS_ANDROID) {
      // device report #2: "fall back to the local backend" is not a fallback on
      // the phone — there is no agent behind 127.0.0.1, so that branch pointed
      // the app at a dead port while the picker still showed the saved host
      // (the reported "selected SSH client but 127.0.0.1:8891 + connection
      // error"). Keep the flag: it is the user's standing intent, and the picker
      // preselects exactly that host for the user's own Connect press
      // (conn-store.ts) — nothing here dials it behind their back.
      return null;
    }
    // stale SSH leftover: fall back to the local backend via the main process
    localStorage.removeItem("clutch_ssh_connected");
    await switchBackendResolved();
    return null; // switchBackendResolved already switched
  }
  return null;
}

// The backend this window was talking to is gone: drop the stale session URL so
// nothing keeps posting into a port nobody serves, and the picker stops
// claiming a connection. The standing intent (clutch_ssh_connected) is the
// caller's to keep. The next real URL arrives via switchBackend /
// backend:base-changed.
export function dropStaleBackend() {
  // the session this window's run lived in is what just went away: same story as
  // a base move, and it must not end in a silent idle either
  if (busy) state.sseRunAtRisk = true;
  // The rows that run had drawn are the process of a turn no ending is coming to
  // in THIS window: fold them now, open, instead of leaving the whole
  // disconnected stretch expanded until some later run ends (auto-fold.ts
  // foldOpenTurn). Announced by name because that file loads after this one — and
  // announced, not invented: the ending itself is the departing session's to write
  // (agent/server.py record_release), and the fold takes it in when a session
  // serves it.
  if (busy && eventsEl) eventsEl.dispatchEvent(new CustomEvent("clutch:turn-interrupted"));
  state.apiBase = null;
  sessionStorage.removeItem("clutch_api_url");
  // The dead socket ends here and the SCOPE stays: no base is not "no log". The
  // session URL the host announces next (switchBackend -> reconnectSSE) brings the
  // same read back, which is exactly what a tunnel redial has to do.
  reconnectSSE();
}

// The tunnel died mid-session. A dropped remote is neither a reason to quietly
// point the window at a local port (on the phone there is no local backend to
// point at — N4 — so that "fallback" could only produce "Failed to fetch" while
// the picker claimed 127.0.0.1:8890, a port that answers no API) nor a toast that
// dismisses itself: a window that lost its session has no session, and the ONLY
// door back is the dialog ui/src/renderer/conn-lost.ts raises — it re-attempts this very
// host, by name, so the user never has to introduce an old host as a new one.
//
// But the hop is ONE resource for the whole process while a session belongs to the
// window that claimed it, and the end of the hop is announced to every window (they
// all have to drop what it implied). Only the windows the hop actually owned lost a
// session with it, and the shells say so per window (`{ lost }`, ui/main.js): a
// window that was on its own local session hears the news and keeps its session,
// its stream and its work. Raising the reconnect dialog in THAT window — and
// re-dialling the host another window was on — was the innocent-window bug.
if (window.clutchTunnel) {
  window.clutchTunnel.onEnd((info) => {
    // The hop list just changed, and the change is the shell's word, not a question
    // this window asked: re-read it BEFORE the early returns below, because a window
    // whose session was not on that hop still has tabs that point at it — and those
    // tabs must stop taking the cached path (slots.ts hopUpFor).
    void refreshHopMirror();
    // the host's verdict for THIS window: false = its session was never on the
    // hop, so there is no lost session here to announce
    if (info && info.lost === false) return;
    // every slot forward died with the hop (main releases them before this
    // broadcast); a badge watcher on one would retry a dead port in silence —
    // activation re-claims the slot and re-opens its stream
    if (typeof unwatchAll === "function") unwatchAll();
    // no flag = the user's own disconnect (the picker's Cancel/Disconnect):
    // they left the remote on purpose, so there is no lost session to announce
    if (!localStorage.getItem("clutch_ssh_connected")) return;
    const pickerOpen = !fsModal.classList.contains("hidden");
    connectionLost("lost the remote connection");
    // the picker must not keep claiming a connection that does not exist: with the
    // base gone it folds to the conn bar, and the session the host announces when
    // the dialog gets it back re-lists it (see the base-changed handler below)
    if (pickerOpen) refreshPicker();
  });
}

// the main process re-established a session: point the app at the new URL.
// A bare string is the pre-tabs shape (the window's default slot); the object
// names the TAB whose session moved, so a background tab's re-bind is stored and
// used when it is activated instead of replacing the visible tab's stream.
if (window.clutchApi && window.clutchApi.onBaseChanged) {
  window.clutchApi.onBaseChanged((change) => {
    const slotId = change && typeof change === "object" ? change.slotId || "" : "";
    const url = change && typeof change === "object" ? change.url : change;
    if (slotId) {
      const tab = tabForSlot(slotId);
      if (tab) tab.base = url ? String(url) : null;
      if (slotId !== state.activeTabId) {
        if (tab) rewatchTab(tab); // its badge keeps following its own session
        return;
      }
    }
    // the host's answer: a URL is this session, and null is an answer too — the
    // honest one, meaning the host looked and there is no session. Staying on the
    // dead URL was the reported "Connected: http://127.0.0.1:4xxxx" that answered
    // nothing, so the dialog the announcement raises is what replaces it.
    if (url) {
      switchBackend(url);
      // A picker that is already open lists the backend it is pointed at: this
      // announcement IS the session it was waiting for, so the listing follows the
      // base instead of a timer polling for it (the picker opens folded — see
      // openFsBrowser in fs-browser.ts — and unfolds on this first listing)
      if (!fsModal.classList.contains("hidden")) {
        // the announcement is the answer to the same question a connect asks, so
        // ask WHICH machine this session is on before drawing the bar: the ✓ names
        // that machine, never the one the standing SSH record remembers
        void refreshBrowsedMachine(slotId).then(() => {
          renderConnSelector();
          loadDir(fsPath, false);
        });
      }
    } else connectionLost("the host has no session for this window");
  });
}
