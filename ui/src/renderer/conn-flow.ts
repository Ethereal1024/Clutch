// the connect flow — progress, password, and the picker's own popups
//
// One attempt at a host (`handleSshConnect`) and the chrome around it: the
// coarse progress stages the tunnel reports over IPC, the password prompt shown
// only after key auth fails, the new-connection popup, and Retry/Cancel.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { IS_ANDROID } from "./env";
import {
  dropStaleBackend, resetBackendLocal, switchBackendResolved,
  tryDegradeToSshTools,
} from "./backend-lifecycle";
import { connLostExitClear, connLostNeedsUser } from "./conn-lost";
import {
  connBusy, connNewHost, connNewPort, connNewUser, connOnValue, connSelect,
  connStatus, connTarget, passInput, passLabel, passModal,
  renderConnSelector, setConnBusy, updateConnConnect, upsertConn,
} from "./conn-store";
import { $ } from "./dom";
import { loadDir } from "./fs-browser";
import { paneHopSettled, reportHopStage } from "./pane";
import { closeModal, dismissOnOverlayPress } from "./settings";
import { state } from "./state";

// restore the picker after a connect/disconnect: the bar's connect chrome is over,
// and the body follows whatever the listing the picker is about to ask for answers
// with (loadDir owns that visibility — a folded body is folded only until a backend
// answers, and no answer means it stays folded). The ask itself is a fact the bar's
// door reads (fsListing, setFsListing below): while the listing is on its way, the
// folded bar is WAITING for a body, which is not the welcome page.
export function refreshPicker() {
  resetConnChrome();
  loadDir("", false); // re-list the (new) backend from home; keep the remembered dir
  renderConnSelector();
}

export function showPasswordPrompt(label) {
  return new Promise((resolve) => {
    passLabel.textContent = label;
    passInput.value = "";
    state.passResolve = resolve;
    passModal.classList.remove("hidden", "closing");
    passInput.focus();
  });
}

export function closePasswordPrompt() {
  // resolve immediately (the connect flow is waiting); only the visual close animates
  closeModal(passModal);
  // A declined password is not "keep trying": the user answered the one question
  // the reconnect had, so the disconnect dialog stops retrying behind them and
  // waits for the button (see connLostNeedsUser in conn-lost.ts)
  connLostNeedsUser();
  if (state.passResolve) state.passResolve(null);
  state.passResolve = null;
}

export let lastConn = null;  // { host, user, port, statusEl } of the last BAR attempt (Retry)

// Monotonic token for the file listing (loadDir in fs-browser.ts): a listing
// that comes back after the user asked for something else — another directory, a
// connect that folded the body — must not paint itself, nor unfold the body, over
// the newer intent.

// A listing has been asked for and has not answered yet. The fold says the body is not
// up; WHY it is not up is this: the picker is waiting to be shown something to browse
// (loadDir in fs-browser.ts — and the picker's own opening, which settles the
// backend's URL before it can list at all). Without this fact the only way to tell "the
// bar is the picker" from "the bar is waiting for an answer" was the fold itself, and the
// two read alike: the folded bar's Connect came back for the whole round-trip of the
// listing a successful connect starts, then left again the moment it landed (device
// report: a Connect flashing at the instant a connection succeeded).
export let fsListing = false;
export function setFsListing(on) {
  if (fsListing === on) return;
  fsListing = on;
  syncConnConnect(); // the door follows the wait, not only the fold
}

// The folded bar's Connect is the welcome state's own door (ui/index.html): with nothing
// browsed, the conn bar IS the picker and the host this device was last on — the list's
// first entry — is one press away. The fold alone is not that state — a connect folds the
// body to retire it, and a listing in flight folds it to wait — so the button follows the
// three facts that make the bar the picker: no attempt in flight (connBusy,
// conn-store.ts), no listing outstanding (fsListing above), and no failure verdict on
// the bar (Retry/Cancel, setFsConnectError below). Reading the fold alone is what put the
// button back the instant an attempt started: a second Connect beside the one already
// running, greyed only because that attempt had disabled it.
//
// This is the ONE place the button is drawn, both halves of it, so that "shown" and
// "armed" cannot disagree: the armed half is conn-store.ts's (updateConnConnect, the
// store owning the target and the in-flight flag), asked for from here.
export function syncConnConnect() {
  const folded = $("#fs-body").classList.contains("collapsed");
  const busy = connBusy || fsListing || !$("#conn-actions").classList.contains("hidden");
  $("#conn-connect").classList.toggle("hidden", !folded || busy);
  updateConnConnect(); // ...and the other half, from the same facts
}

// collapse the picker body during a connect/failure; only the conn bar remains.
// Folding is also what retires a listing that is still in flight: its answer decides
// nothing any more, so the wait ends with it (a retired listing returns early and never
// clears the wait itself, which would leave fsListing true for good and the door with it).
export function hidePickerBody() {
  state.fsListToken++;
  setFsListing(false);
  $("#fs-body").classList.add("collapsed");
  syncConnConnect(); // the bar is the picker now — unless an attempt owns it
}
export function showPickerBody() {
  $("#fs-body").classList.remove("collapsed");
  resetConnChrome();
}
// the connect chrome on the conn bar (progress, Retry/Cancel) belongs to an attempt
// that is over the moment the picker is back in its browsing state
export function resetConnChrome() {
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.add("hidden");
  syncConnConnect(); // the attempt's chrome is over: the folded bar's door is back
}

export let activeConnStatus = null; // status element of the modal currently connecting
// ...and the door that attempt came from, named once where it started (the
// element alone cannot say it: the tab's own load reports into the PANE's state,
// which is no element at all — pane.ts). updateConnProgress reads this.
let activeDoor = "";

// connection progress bar: the tunnel reports coarse stages over IPC
export const CONN_STAGES = {
  auth: { pct: 10, label: "Connecting…" },
  probe: { pct: 22, label: "Inspecting remote…" },
  // the gate's own stage: a remote that already runs our version never reaches
  // "install", so reconnecting to a healthy server must not claim it does
  check: { pct: 30, label: "Checking remote server…" },
  install: { pct: 35, label: "Installing remote server…" },
  // the artifact itself: a Release download (or a first-time build on the
  // desktop), and the only part of an install that can take minutes. It has its
  // own stage so it cannot hide inside the check above — that is what made a
  // connect on a phone look like it "only checks the remote server" and never
  // installs (report #5)
  "install:fetch": { pct: 40, label: "Preparing remote server…" },
  // `span`: the stage has measured work to show, and a fraction of it moves the
  // bar. The upload is 78 MB of bundle and takes as long as the link takes — a
  // label frozen at 45% for a minute is how a live transfer reads as a hung one
  "install:upload": { pct: 45, span: 25, label: "Uploading server…" },
  "install:start": { pct: 70, label: "Starting server…" },
  forward: { pct: 90, label: "Starting tunnel…" },
};

// How much of the tab's own loading bar (#open-progress) the HOP may fill is
// pane.ts's business: one load is one bar moving one way, and the file that owns
// that arithmetic (HOP_SHARE, the replay's phases) is the same one that paints it.
// This flow only REPORTS a stage (reportHopStage) — it never touches the bar.

// A transfer's own speed, in the units a person reads: 13 KB/s is the number that
// matters when the far side is writing at a crawl, because it is the one that
// says "this is slow, not stuck".
export function fmtRate(bps) {
  const n = Number(bps) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB/s";
  if (n >= 1024) return Math.round(n / 1024) + " KB/s";
  return Math.round(n) + " B/s";
}

// ...and how much longer, coarse on purpose: an ETA that counts seconds during a
// hundred-minute upload is noise.
export function fmtEta(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h + " h" + (m ? " " + m + " min" : "");
  }
  if (s >= 60) return Math.round(s / 60) + " min";
  return s + " s";
}

// A stage name, or { stage, frac, bps, eta } for a stage that has measured work to
// show. The fraction is read only for the stage it belongs to: a number with no
// stage is nothing to paint. bps/eta are the transfer's own (see tunnel-remote):
// they are shown next to the percent and never turn the stage into an error.
export function updateConnProgress(update) {
  const stage = typeof update === "string" ? update : update && update.stage;
  const frac =
    update && typeof update === "object" && typeof update.frac === "number"
      ? Math.max(0, Math.min(1, update.frac))
      : null;
  const bps =
    update && typeof update === "object" && typeof update.bps === "number" && update.bps > 0
      ? update.bps
      : null;
  const eta =
    update && typeof update === "object" && typeof update.eta === "number" && update.eta > 0
      ? update.eta
      : null;
  const s = CONN_STAGES[stage];
  // The tab's own loading bar (#open-progress, door "load") has a percent of its
  // own at the right end, so its note says the STAGE and the speed and never the
  // number: "Uploading server 42% 42%" is what a shared label would read. That
  // note is the pane's state, not an element (pane.ts), so this door writes
  // nothing here: it REPORTS the stage below.
  const pane = activeDoor === "load";
  let label = "Working…";
  if (s) {
    label = s.label;
    // "Uploading server 42%": the ellipsis is the promise that something is
    // coming, so a number replaces it rather than following it
    if (frac !== null) label = s.label.replace(/\s*…$/, "") + (pane ? "" : " " + Math.round(frac * 100) + "%");
    // ...and the rate (with what is left) when the transfer measured one: a
    // percent that is real but crawling was the last thing that read as a hang
    if (frac !== null && bps) {
      label += " · " + fmtRate(bps);
      if (eta) label += " · " + fmtEta(eta) + " left";
    }
  }
  if (activeConnStatus) activeConnStatus.textContent = label;
  const pct = s ? s.pct + (frac !== null ? (s.span || 0) * frac : 0) : null;
  // the same stage arithmetic as the picker's bars, reported as the hop's own
  // fraction — the pane turns it into its share of the bar (one load, one bar)
  if (pane) reportHopStage(pct, label);
  for (const bar of [$("#conn-progress"), $("#conn-new-progress"), $("#conn-lost-progress")]) {
    if (bar.classList.contains("hidden")) continue;
    const fill = bar.querySelector(".conn-progress-fill");
    if (s) {
      fill.classList.remove("indeterminate");
      fill.style.width = s.pct + (frac !== null ? (s.span || 0) * frac : 0) + "%";
    } else {
      fill.classList.add("indeterminate"); // unknown stage: keep the bar animating
      fill.style.width = "";
    }
  }
}

// One bar, one way to say "no stage yet": it animates until the tunnel reports
// where it is (updateConnProgress above). Every door that puts a bar up says it
// through this call, so no door can leave a bar that never moves — and there is one
// place to change how a bar waits.
export function connBarWaiting(bar) {
  bar.classList.remove("hidden");
  const fill = bar.querySelector(".conn-progress-fill");
  fill.classList.add("indeterminate");
  fill.style.width = "";
}

// An attempt reports to the status element of the door that started it: the picker's
// own line (#conn-status), the new-connection popup's (#conn-new-status), or the
// disconnect dialog's (#conn-lost-why). The three carry different chrome, and each
// door owns its own: the popup has its status line, its progress bar, its Connect to
// press again; the disconnect dialog has its line, its bar, and the Reconnect that
// conn-lost.ts renders from the attempt itself. So the bar underneath is not the
// actor in a popup attempt, nor in the dialog's own reconnect — and an attempt of
// theirs is not the bar's: it takes no fold from it, no progress bar, no
// Retry/Cancel, and leaves the folded bar's Connect where the fold put it. Reading an
// attempt as one thing is what left a failed popup attempt with Retry/Cancel on the
// folded bar behind the modal, pointing at the popup's status element: closing the
// popup then showed a bar whose Retry painted the next attempt into a closed popup,
// with no Connect door back.
//
// The door's name is read once, where the attempt starts (handleSshConnect), and the
// functions below are TOLD which door they are acting for instead of each reading it
// back out of the DOM node they were handed.
export function doorOf(statusEl) {
  if (!statusEl) return "bar";
  if (statusEl.id === "conn-new-status") return "popup";
  // ...and the tab's own LOAD is not a door at all: connectTabMachine names it
  // where it starts ("load"), because its surface is the pane's state rather than
  // an element (pane.ts) — no element here can stand for it
  // the disconnect dialog: a re-dial of the host this window was on (conn-lost.ts)
  // reports here, and it is a door of its own for one more reason — the picker's Retry
  // re-uses the last attempt made FROM THE BAR, and a reconnect is not that press
  if (statusEl.id === "conn-lost-why") return "lost";
  return "bar";
}

export function setFsConnecting(host, statusEl, door) {
  activeConnStatus = statusEl;
  activeDoor = door;
  if (door === "lost") {
    // The disconnect dialog is its own chrome, and it is already the whole UI: its
    // line says "Reconnecting…", the host it is going back to is on the line above
    // it, and its bar and button come from the attempt itself (connLostChrome,
    // conn-lost.ts) — so what the flow adds here is the stage it reaches
    // (updateConnProgress paints it into this line), not a second "connecting to
    // <host>" and not a second bar. The picker's own door still stands down: an
    // attempt is in flight, whichever door it came from.
    syncConnConnect();
    return;
  }
  if (door === "load") {
    // the tab's loading card is the whole chrome here: its NOTE is the pane's
    // state (pane.ts), so even this first sentence is a report (and the bar under
    // it, with the stage and the transfer's speed, follows through
    // updateConnProgress). The picker's bars, its Retry/Cancel and its fold
    // belong to another door, and moving them from a boot would paint chrome onto
    // a picker nobody opened.
    reportHopStage(null, "Connecting to " + host + "…");
    syncConnConnect(); // ...but the picker's Connect still stands down while it runs
    return;
  }
  statusEl.textContent = "Connecting to " + host + "…";
  if (door === "bar") {
    $("#conn-actions").classList.add("hidden"); // an attempt replaces the last verdict
    // and retires the listing in flight (hidePickerBody ends that wait): the fold is
    // what the bar's door reads
    hidePickerBody();
  }
  // animate the bar under the active modal (the new-connection popup has its own)
  connBarWaiting(door === "popup" ? $("#conn-new-progress") : $("#conn-progress"));
  syncConnConnect(); // an attempt is in flight, either door: the door stands down
}

export function setFsConnectError(msg, statusEl, door) {
  activeConnStatus = statusEl;
  activeDoor = door;
  statusEl.textContent = msg;
  if (door === "popup") {
    // the verdict is the popup's, with its own Connect armed again by setConnBusy:
    // the bar underneath keeps whatever it was already offering, and keeps it once
    // the popup closes
    $("#conn-new-progress").classList.add("hidden");
    return;
  }
  if (door === "lost") {
    // the verdict is the dialog's own line, and the dialog renders the rest of
    // itself (its bar goes down and its Reconnect comes back the moment this attempt
    // returns — connLostChrome). Retry/Cancel belong to the picker's bar, which this
    // attempt never took: leaving them there would be a second door onto a second
    // attempt, behind a dialog that is still up.
    return;
  }
  if (door === "load") {
    // the tab's own panel is where a failed hop is read (project.ts showBlocked
    // from the claim's verdict): the bar only carried the attempt, and the caller
    // takes it down — writing the sentence into a vanishing note would lose it
    return;
  }
  $("#conn-progress").classList.add("hidden");
  $("#conn-new-progress").classList.add("hidden");
  $("#conn-actions").classList.remove("hidden"); // offer Retry / Cancel
  hidePickerBody(); // and the verdict owns the folded bar, Retry/Cancel included
}

// Did a hop for EXACTLY this host land while this attempt was being reset by it?
//
// A connect is not alone on the wire: the engine's own redial ladder
// (ui/tunnel-ladder.js) and a second window dial the same host, and whichever
// dial loses is reset by the one that won. The loser's words are the socket's —
// "read ECONNRESET" — and shown as "connection failed" they say the opposite of
// what happened: the user IS on the host they asked for. So a failed attempt
// asks the shell which host its hop is for before it believes itself:
//
//   * a live hop for this host, with its url up → the connect succeeded, by the
//     other attempt; report it as the success it is;
//   * anything else on the wire → not ours, and not a success;
//   * nothing at all → a plain failure, answered at once (the common case: a
//     connect that genuinely could not get through must not spend seconds
//     pretending somebody else might arrive — that is a slower lie).
//
// The wait is only for the case in between: a hop for this host still bootstrapping
// (active, no url yet), which is the winner this attempt lost to, a few seconds
// behind its dial.
export async function hopLandedFor(host, user, port, budgetMs = 5000) {
  const st = window.clutchTunnel && window.clutchTunnel.status;
  if (typeof st !== "function") return false;
  const wantPort = Number(port) || 22;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let s = null;
    try {
      // ask about THIS machine, not "the tunnel": with a hop per endpoint the
      // window's own hop may well be up and pointed somewhere else, and reading
      // its target would answer somebody else's question
      s = await st({ host: String(host), user: String(user), port: wantPort });
    } catch (e) {
      return false; // an unanswerable question is not a live hop
    }
    const t = s && s.target;
    const mine =
      t && t.host === String(host) && t.user === String(user) && (Number(t.port) || 22) === wantPort;
    if (s && mine && s.active && s.url) return true;
    if (!s || !mine || !s.active) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// "ssh:user@host:port" — the list's own spelling (conn-store.ts connLabel), read
// back as the three fields the tunnel dials. `local`, and the synthetic
// "ssh:__connected__" entry a session with no saved host draws, are not hosts:
// there is nothing to dial, and nothing to verify against the tunnel either.
function sshTargetOf(v) {
  if (!v || !v.startsWith("ssh:") || v.includes("__connected__")) return null;
  const [user, hostPort] = v.slice(4).split("@");
  if (!user || !hostPort) return null;
  const [host, port] = hostPort.split(":");
  if (!host) return null;
  return { user, host, port: port || "22" };
}

export async function handleSshConnect(host, user, port, statusEl) {
  // same door as connConnect, reached from the picker's New-connection popup, the
  // bar's Retry and the outage redial (conn-lost.ts): every one of them is an
  // attempt to BE on a host, so the exit's note is spent before it is made
  connLostExitClear();
  if (!window.clutchTunnel) {
    statusEl.textContent = "SSH requires the desktop app (Electron).";
    return;
  }
  if (connBusy) {
    statusEl.textContent = "connecting…";
    return;
  }
  if (!host || !user) {
    statusEl.textContent = "host and user are required";
    return;
  }
  // which door this attempt belongs to, read once: everything below acts for it
  const door = doorOf(statusEl);
  // the bar's Retry re-uses the last attempt made FROM THE BAR: a popup attempt is
  // the popup's own press (its Connect is that retry), so it does not claim it
  if (door === "bar") lastConn = { host, user, port, statusEl };
  setConnBusy(true); // no second attempt can start while this one is in flight
  setFsConnecting(host, statusEl, door); // status text + progress bar, on that door's chrome
  try {
    // try keys/agent first (plus any secret the tunnel has cached for this
    // host); only prompt when auth still fails
    let res = await window.clutchTunnel.connect({ host, user, port: Number(port) });
    if (!res.ok && res.error && /authentication/i.test(res.error)) {
      const pw = await showPasswordPrompt("Password / key passphrase for " + user + "@" + host);
      if (!pw) {
        setFsConnectError("connection cancelled", statusEl, door);
        return;
      }
      res = await window.clutchTunnel.connect({ host, user, port: Number(port), password: pw });
    }
    // The loser of a race is not a failed connect (see hopLandedFor): a concurrent
    // attempt can reset this one and then come up, and the hop the user asked for
    // is up. Read that as the success it is, not as the socket's words — the field
    // report behind this is a user told "connection failed: read ECONNRESET" about
    // a tunnel that was already carrying their file list.
    if (!res.ok && (await hopLandedFor(host, user, port))) res = { ok: true, url: null };
    if (res.ok) {
      upsertConn(host, user, port);
      localStorage.setItem("clutch_ssh_connected", "1");
      // the tunnel URL is the supervisor control channel; the API base is the
      // per-window session, decided by the main process
      await switchBackendResolved();
      refreshPicker();
      return true;
    } else {
      // host alive but unbootstrappable: degrade to SSH-tools
      const degraded = await tryDegradeToSshTools();
      if (degraded === true) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        await switchBackendResolved(); // the local server is now remote-backed
        refreshPicker();
        return true;
      }
      // false = tunnel never came up; string = local backend down (the real failure).
      // res.error is the bootstrap verdict (e.g. the pylibs index 404) — never
      // drop it: the bare "unreachable" hid a whole class of supply-line
      // failures behind a symptom.
      setFsConnectError(
        degraded === false
          ? "connection failed: " + (res.error || "could not connect")
          : "SSH connected, but the local agent server is " + degraded +
            (res.error ? " (" + res.error + ")" : ""),
        statusEl,
        door
      );
    }
  } catch (e) {
    setFsConnectError("connection failed: " + e.message, statusEl, door);
  } finally {
    setConnBusy(false);
    syncConnConnect(); // the attempt is over, either door: no longer in flight, so the
    // folded bar reads its fold again — and a listing still outstanding (fsListing) keeps
    // that a WAIT rather than the welcome state, which is what kept the door from
    // flashing back the instant a connect succeeded (a popup failure never took the
    // bar's chrome, so there is nothing else on the bar to settle here)
  }
}

// ---- the tab's own load: the hop its file needs ------------------------------
//
// A tab whose file lives on a far machine cannot claim a session until the hop to
// that machine is up (slots.ts prepareTabMachine), so that hop IS a step of
// loading the tab — and it belongs in the tab's own loading bar, not behind a
// Connect button somewhere else.
//
// The tab's record is the intent. The user opened that file on that machine, the
// connect that got them there won, and the secret it typed is in the settings
// mirror (ssh_secrets) for the next dial — so this is a RECONNECT: one attempt,
// the cached secret first, and the password dialog only when the far side refuses
// that secret (a changed password, a host whose secret was never cached). A
// question asked while the tab is loading is still one press, and it is the ONLY
// press the user has to make: nothing here sends them to the picker to do it.
//
// REPORTS into the tab's own load (door "load", above) — the stage and the
// transfer's speed as the card's note, the fraction as the bar's first share of
// one whole load. The arithmetic belongs to pane.ts, which also continues that
// same bar with the replay (project.ts openInTab). Returns "" when the hop is up,
// or the sentence the tab's panel should carry.
//
// It does NOT switch this window's backend: that is the claim's business and the
// caller is about to make it (claimTab → the tab's own slot). Resolving the
// window's default session here would claim one for the window itself — a session
// nobody is looking at, which is what boot.ts exists to avoid.
export async function connectTabMachine(machine): Promise<string> {
  const host = machine && machine.host;
  const user = machine && machine.user;
  const port = Number((machine && machine.port) || 22);
  if (!host || !user) return ""; // nothing named: not this path's question
  if (!(window.clutchTunnel && window.clutchTunnel.connect)) {
    return "this shell cannot open an SSH tunnel";
  }
  if (connBusy) return "another connection is already in progress";
  setConnBusy(true);
  setFsConnecting(host, null, "load");
  let up = false;
  try {
    // `endpoint: true` — the shell names this hop after the machine, so a tab on
    // a second host gets the hop for THAT host instead of renaming the window's
    // own (tunnel-core: a pinned, named hop never renames — it is refused)
    let res = await window.clutchTunnel.connect({ host, user, port, endpoint: true });
    if (!res.ok && res.error && /authentication/i.test(res.error)) {
      // the cached secret did not authenticate (changed password, or none was ever
      // cached for this host): ask HERE, once, and let the host cache what wins so
      // the next boot needs no dialog at all
      const pw = await showPasswordPrompt("Password / key passphrase for " + user + "@" + host);
      if (!pw) return "connection cancelled";
      res = await window.clutchTunnel.connect({ host, user, port, password: pw, endpoint: true });
    }
    // the loser of a concurrent dial is not a failed connect (hopLandedFor)
    if (!res.ok && (await hopLandedFor(host, user, port))) res = { ok: true, url: null };
    if (res.ok) {
      upsertConn(host, user, port);
      localStorage.setItem("clutch_ssh_connected", "1");
      up = true;
      return "";
    }
    // No degrade-to-SSH-tools here: a tab whose FILE is on that machine needs the
    // hop's session, and a local server with a remote exec bridge has no file.
    // The honest verdict is this attempt's own words.
    return "connection failed: " + (res.error || "could not connect");
  } catch (e) {
    return "connection failed: " + ((e && e.message) || e);
  } finally {
    // Up: the bar keeps the hop's share and says what is happening now (the
    // session spawns, then the replay — project.ts continues the same bar). Down:
    // no bar at all, because the panel that carries the verdict takes the pane.
    paneHopSettled(up);
    activeConnStatus = null;
    activeDoor = "";
    setConnBusy(false);
    syncConnConnect();
  }
}


// and the new-connection popup's Connect — are attempts to BE on that host, and a
// window is on one host at a time: the standing intent (and the tunnel that
// carried it) is spent BEFORE the new attempt, exactly as the list's choice always
// did. The popup used not to do this, so an attempt for a new host was made ON TOP
// of the live tunnel: the engine reused the hop it still held and reported the new
// host as connected while the bytes never left the old one (the picker ticked the
// new host over the previous host's file system).
//
// A move that fails must also leave no claim behind. The tunnel it dropped is
// gone, so the base and the listing that described it are dead: saying "connected"
// over them is the same lie in the other direction, and it kept the old host
// marked as the place the window already was — selecting it could not dial it
// again (connConnect refuses to "connect" where it believes it already is). So a
// failed move drops the stale base and redraws the picker: no ✓, no old listing,
// and the host it left is a choice that can be dialled again.
export async function connSwitch(host, user, port, statusEl) {
  // a request with nothing to dial (or no engine to dial it with, or an attempt
  // already in flight) is not a move: the flow answers it in place, and the host
  // this window is on is left exactly where it is
  if (!host || !user || !window.clutchTunnel || connBusy) {
    return await handleSshConnect(host, user, port, statusEl);
  }
  const leaving = Boolean(localStorage.getItem("clutch_ssh_connected"));
  if (leaving) {
    // the intent goes FIRST, so the teardown below is the user leaving on purpose
    // and is not announced as a lost session (backend-lifecycle.ts)
    localStorage.removeItem("clutch_ssh_connected");
    localStorage.removeItem("clutch_degrade");
    if (window.clutchTunnel) await window.clutchTunnel.disconnect();
  }
  const ok = await handleSshConnect(host, user, port, statusEl);
  if (!ok && leaving) {
    // the attempt may have left a partial hop (the SSH session kept for SSH-tools,
    // a dial the failure path could not tear down): the move is over either way,
    // so nothing of it may outlive the verdict
    if (window.clutchTunnel) {
      try {
        await window.clutchTunnel.disconnect();
      } catch (e) {
        /* the host is gone or unreachable: the state below is still the honest one */
      }
    }
    dropStaleBackend(); // API_BASE names a session whose forward died with the hop
    if (doorOf(statusEl) === "popup") {
      // nothing of the popup's attempt is drawn on the picker: it folds, forgets
      // the old listing and shows the host it left as a choice again, while the
      // popup keeps the error that explains why the new host is not there
      refreshPicker();
    } else {
      // the bar's attempt owns the bar's verdict (its error, then Retry/Cancel):
      // redraw only the store's half — no ✓, and the host it left is a choice
      // again — and put the verdict back on top of the honest state
      const verdict = statusEl.textContent;
      renderConnSelector();
      statusEl.textContent = verdict;
    }
  }
  return ok;
}

// Connect — the user's own act. The picker has two doors onto it: choosing a host
// in the list (below), and pressing Connect while the body is folded — the welcome
// state, where the list's first entry (the host this device was last on) is one
// press away (connTarget() in conn-store.ts). connOnValue is the backend this
// window is already on, so a choice that does not move the window is not a dial.
export async function connConnect(v) {
  // The user's own Connect: a session is what they just asked for, so the exit's
  // note (conn-lost.ts) is spent — this is the door that pays it. Cleared before
  // the guards below on purpose: the note is about what the NEXT boot may claim, and
  // no press of this button is a boot nobody asked for.
  connLostExitClear();
  if (!v) return;
  if (v === connOnValue) {
    // The ✓ is the picker's memory of a connect; the tunnel's own target is the
    // fact. A window whose base moved off that host — a claim that fell back to a
    // session on THIS machine, a reconcile that adopted another one — still carries
    // the tick, and refusing the press here is what left the host undiallable: the
    // one entry the user needed was the one entry that did nothing. So the guard
    // asks the tunnel instead of the picker: still on it is not a dial, anywhere
    // else is (and `local` and the synthetic connected entry are no host at all).
    const t = sshTargetOf(v);
    if (!t || (await hopLandedFor(t.host, t.user, t.port, 0))) return;
  }
  if (v === "local") {
    if (localStorage.getItem("clutch_ssh_connected")) {
      // the standing intent goes FIRST: the disconnect below ends the tunnel and
      // the host announces that as "tunnel:ended", which the renderer reads as a
      // LOST session unless the intent is already gone (backend-lifecycle.ts)
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
      await window.clutchTunnel.disconnect();
      await resetBackendLocal(); // end any SSH degradation on the local server
    }
    // this machine's own session, by asking the host for it: with no session yet
    // the honest answer is still "not connected", never a guessed local port
    await switchBackendResolved();
    refreshPicker();
    return;
  }
  if (v.startsWith("ssh:") && !v.includes("__connected__")) {
    // switching: the standing intent and the tunnel it names are spent first, then
    // the new host is dialled (connSwitch owns both halves, and the failed move's
    // clean-up: see above)
    const t = sshTargetOf(v);
    if (!t) return;
    await connSwitch(t.host, t.user, t.port, connStatus);
  }
}
// The list's door: choosing a host connects to it, immediately — selection IS the
// dial (device report #4: the extra press the picker briefly required is gone).
// The selection the picker LANDS on is not a choice — a list of hosts opens on its
// first entry (conn-store.ts) and dials nothing, because only the user's own act
// fires this listener; the folded bar's Connect below spends that same entry.
connSelect.addEventListener("change", () => {
  updateConnConnect(); // the folded bar's Connect follows the new choice
  connConnect(connSelect.value);
});
// The folded bar's door: it dials what the picker holds (connTarget()), so it can
// never dial more than the list offers — an empty list leaves it with nothing.
$("#conn-connect").addEventListener("click", () => connConnect(connTarget()));

// new-connection popup (only shown when the user asks to add an SSH host)
export const connNewModal = $("#conn-new-modal");
export const connNewStatus = $("#conn-new-status");

export function openConnNew() {
  connNewHost.value = localStorage.getItem("clutch_ssh_host") || "";
  connNewUser.value = localStorage.getItem("clutch_ssh_user") || "";
  connNewPort.value = localStorage.getItem("clutch_ssh_port") || "22";
  connNewStatus.textContent = "";
  connNewModal.classList.remove("hidden", "closing");
  connNewHost.focus();
}
export function closeConnNew() {
  closeModal(connNewModal);
}
$("#conn-new").addEventListener("click", openConnNew);
$("#conn-new-cancel").addEventListener("click", closeConnNew);
$("#conn-new-connect").addEventListener("click", async () => {
  const host = connNewHost.value.trim();
  const user = connNewUser.value.trim();
  const port = connNewPort.value.trim() || "22";
  // the popup names a host exactly like the list does: a move, not a second
  // connection beside the one this window is on (see connSwitch)
  const ok = await connSwitch(host, user, port, connNewStatus);
  if (ok) closeConnNew(); // stay in the picker
});
dismissOnOverlayPress(connNewModal, closeConnNew);
connNewHost.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#conn-new-connect").click();
});
$("#conn-retry").addEventListener("click", () => {
  if (lastConn) handleSshConnect(lastConn.host, lastConn.user, lastConn.port, lastConn.statusEl);
});
$("#conn-cancel").addEventListener("click", async () => {
  localStorage.removeItem("clutch_ssh_connected");
  localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
  // the bar's Cancel belongs to the picker's own attempt (a popup attempt keeps
  // its verdict inside the popup), so no popup should be up here; closing one anyway
  // is the cheap guarantee that none is (closeModal returns early on a closed modal)
  closeConnNew();
  if (!IS_ANDROID) {
    // desktop only: "cancel" goes back to this machine's local session. There
    // is no local backend on the phone, so that path could only point the app
    // at 127.0.0.1:8890 — a port nothing there serves.
    resetBackendLocal(); // end any SSH degradation on the local server
    await switchBackendResolved();
  }
  refreshPicker();
});
if (window.clutchTunnel && window.clutchTunnel.onProgress) {
  window.clutchTunnel.onProgress(updateConnProgress); // drive the connect progress bar
}
$("#ssh-pass-ok").addEventListener("click", () => {
  const pw = passInput.value;
  closeModal(passModal);
  if (state.passResolve) state.passResolve(pw);
  state.passResolve = null;
});
$("#ssh-pass-cancel").addEventListener("click", closePasswordPrompt);
dismissOnOverlayPress(passModal, closePasswordPrompt);
passInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#ssh-pass-ok").click();
});
