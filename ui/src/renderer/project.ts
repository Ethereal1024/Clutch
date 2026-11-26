// the open project — stream reset, history paging, open, create
//
// Clearing the pane for a new project, paging older events back in, and the
// open/create calls themselves.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { apiFetch, noBackend } from "./app";
import { els } from "./els";
import { $ } from "./dom";
import { hasMathText, typesetProgressively } from "./markdown";
import {
  currentPane,
  onPaneChange,
  paneBlocked,
  paneBlockedTabId,
  paneLoad,
  paneReplayProgress,
  paneTab,
  paneWelcome,
  setPane,
  type PaneState,
} from "./pane";
import { endSend, resumeTurn } from "./render-events";
import { notice } from "./settings";
import { closeSSE, connectSSE } from "./sse-stream";
import { state, type Machine } from "./state";
import { addEvent, dropOrphanLive, settleCatchUp } from "./stream-events";
import { endCatchUp, nearBottom, setClaimed, setJumpVisible, setReadOnly, setStatus } from "./stream-view";
import { eventsEl, stream } from "./els";
import { refreshRollbackAnchors, resetRollbackAnchors } from "./task-rollback";
import { enterWorkspace, refreshTree } from "./workspace-panel";
import {
  activeTab,
  adoptBase,
  asMachine,
  claimTab,
  ensureTab,
  findTabByPath,
  hopUpFor,
  machineLabel,
  mementoOf,
  noteTabMachine,
  recordTabMachine,
  releaseTab,
  restoreMemento,
  sameMachine,
  saveMemento,
  saveDomCache,
  restoreDomCache,
  forgetDomCache,
  unwatchTab,
  watchTab,
} from "./slots";

export let currentProject = ""; // path of the active .clc project file

// ---- one activation generation -------------------------------------------------
//
// Opening a project is a long NDJSON replay (a large .clc is megabytes), and a
// tab click can supersede it at any moment. Without a generation, two replays
// interleave into the ONE visible stream, the later completer flips
// currentProject/activeTab under the reader, and the previous session's SSE
// keeps appending into the new pane. Both were reported as "two tabs, both
// showing the other project". So:
//   * ++openSeq invalidates every open in flight; its AbortController is aborted;
//   * the previous SSE is closed IMMEDIATELY (not when the new replay ends);
//   * every UI mutation of an open is behind `seq === openSeq`.
let openSeq = 0;
let openAbort: AbortController | null = null;
// The view restore's own requests (/api/session and the history pages). A tab
// click supersedes them the same way it supersedes the open: they are the tab we
// left's, and on a remote project each abandoned page is another 256 KB dragged
// off the tunnel while the tab the reader actually wants is waiting for it. Left
// running they are what made a delay ADD UP instead of repeating.
let viewAbort: AbortController | null = null;
let opening: { id: string; promise: Promise<PaneState | null> } | null = null;

function supersedeOpen(): number {
  openSeq++;
  if (openAbort) {
    try {
      openAbort.abort();
    } catch (e) {
      /* already aborted */
    }
    openAbort = null;
  }
  if (viewAbort) {
    try {
      viewAbort.abort();
    } catch (e) {
      /* already aborted */
    }
    viewAbort = null;
  }
  return openSeq;
}

function isStale(seq: number, e?: any): boolean {
  return seq !== openSeq || !!(e && e.name === "AbortError");
}

function dirOf(path: string): string {
  if (!path) return "";
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at > 0 ? path.slice(0, at) : "";
}

export function clearStream() {
  // clear session content; the overlay/events wrapper stay mounted. The nodes a
  // cut closed (stream-events.ts `awaiting`) go with it: a block that is not on the
  // page is never asked to be filled, so that list needs no telling.
  eventsEl.innerHTML = "";
  state.lastTextEl = null;
  state.lastTextContent = "";
  state.textSealed = false;
  // ...and the block a record drew went with them: a final in this pane must never
  // complete a node the pane that just left owned (stream-events.ts lastRecordEl)
  state.lastRecordEl = null;
  state.lastRecordText = "";
  state.thinkingEl = null;
  state.thinkingContent = "";
  if (state.textRenderRaf) { cancelAnimationFrame(state.textRenderRaf); state.textRenderRaf = 0; }
  if (state.thinkingRenderRaf) { cancelAnimationFrame(state.thinkingRenderRaf); state.thinkingRenderRaf = 0; }
  state.compactionEl = null;
  state.retryNoteEl = null;
  state.oldestOffset = null; // fresh project: no loaded events yet
  state.streamHighOffset = null; // and no replayed record to dedupe a reconnect against
  state.runSettled = false; // a fresh pane holds no run's ending (stream-events.ts)
  // ...and no queued paint of a catch-up: those rows belong to the pane that just
  // left, and a queue that outlived this would append them into the new one
  state.owedRecords.length = 0;
  // ...and no OPEN catch-up either: the bracket belonged to the stream that just
  // left, and a window still flagged as catching up would hold every later row
  // in a batch nothing would ever close (the `replayed` frame that closes it is
  // not coming: a fresh connect with no `since` never sends one)
  endCatchUp();
  resetRollbackAnchors(); // and no journal anchors: they belong to the project that left
  setOlderPill(0);
}

// ---- scroll-up paging (lazily-opened projects) ----
// olderRemaining mirrors the server's on-disk count, so a dropped page
// never makes the pill lie
export let olderRemaining = 0;
// whether a TRANSCRIPT owns the pane (pane.ts publishes it, setOlderOwner below):
// a load card, a failure panel or the welcome page takes the pill off screen
// without touching the count.
let olderOwner = false;
// byte offset of the NEWEST rendered event: a reconnecting stream replays the
// window from its start, and everything at or below this is a record this window
// already painted (addEvent in stream-events.ts). Reset with the pane.
export let paging = false;   // one history fetch at a time
// what the pill is waiting on: "" (offering the page), "fetch" (the request is
// out) or "render" (the reply is here and the pane is taking it). A `history`
// frame that lands mid-page reads this instead of overwriting the wait.
export let olderBusy = "";
// when non-null, addEvent appends into this off-DOM sink instead of #events
export let pageSink = null;

// The page's size as a person reads it: the pill offers it, and names it again
// while it is being fetched.
export function olderSizeLabel(bytes) {
  const kb = Math.max(1, Math.ceil(bytes / 1024));
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

// The pill's one label, in all three states. It is painted from `olderBusy`, so a
// reconnecting stream's `history` frame (stream-events.ts setOlderPill) mid-page
// rewrites the same sentence instead of taking the spinner's place.
export function paintOlderLabel() {
  const label = document.getElementById("older-label");
  if (!label) return;
  const size = olderSizeLabel(olderRemaining);
  if (olderBusy === "render") label.textContent = "rendering earlier records…";
  else if (olderBusy === "fetch") label.textContent = `loading ${size}…`;
  else label.textContent = `load earlier records (${size})`;
}

export function setOlderPill(n) {
  olderRemaining = Math.max(0, n | 0);
  paintOlderPill();
}

// The pill is a TRANSCRIPT's control, so whether one owns the pane is an input of
// its visibility too — and pane.ts is the one that knows. The count survives a
// switch: leaving a tab must not forget how much is still unloaded above it.
export function setOlderOwner(on) {
  olderOwner = !!on;
  paintOlderPill();
}

// The pill's two inputs meet in one place. (It lives inside the pager's own block
// because tests/older-pill-test.js evaluates that block on its own.)
function paintOlderPill() {
  const pill = document.getElementById("older-pill");
  if (!pill) return;
  if (olderOwner && olderRemaining > 0) {
    pill.classList.remove("hidden");
    paintOlderLabel();
  } else {
    pill.classList.add("hidden");
  }
}

// The tap has to be answered on the frame it lands. A page is ONE /api/history
// request whose budget is a megabyte and a turn (below), the server assembles it
// from disk, and the prepend that follows is one synchronous pass over the reply —
// so the wait is spent inside the control that was just pressed: a ring, the number
// being fetched, and `aria-busy` for assistive tech. Cleared in loadOlder's
// `finally`, whatever the outcome.
export function setOlderBusy(stage) {
  olderBusy = stage || "";
  const pill = document.getElementById("older-pill");
  if (!pill) return;
  pill.classList.toggle("busy", !!olderBusy);
  if (olderBusy) pill.setAttribute("aria-busy", "true");
  else pill.removeAttribute("aria-busy");
  paintOlderLabel();
}

// One PAINTED frame: the first rAF only promises the browser is about to paint.
// Used to put the reply's own state on screen before the synchronous prepend takes
// the main thread — otherwise the label would change and then freeze unseen.
export function nextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export async function loadOlder() {
  if (paging || stream.classList.contains("loading") || !state.oldestOffset || olderRemaining <= 0) return;
  paging = true;
  setOlderBusy("fetch"); // synchronous: this is the frame the tap lands on
  try {
    const anchor = eventsEl.firstElementChild; // identity survives the prepend
    // A page is a BYTE budget, and a byte budget splits turns: the median finished
    // turn in a real project is ~278 KB (ui-fix.clc), so a 256 KiB page cut one
    // nearly every time. Two things follow from that. `limit` is now ~2 turns'
    // worth, and `align=turn` has the server walk the page's start back to the task
    // row that opens the turn the budget cut (agent/core/lazy.py aligned_start) —
    // a page then begins where a turn begins, and the pane is handed whole turns.
    const data = await apiFetch(`/api/history?before=${state.oldestOffset}&limit=1048576&align=turn`, { timeout: 60000 });
    const page = data.events || [];
    if (!page.length) { setOlderPill(0); return; }
    // What follows is one synchronous pass (the sink render below, the prepend, the
    // folds), so the reply's own stage is painted first. Nothing has moved yet:
    // `pageSink` is not set and `oldestOffset` is not read again, so a live frame
    // that lands in this yield renders into the pane exactly as it always would.
    setOlderBusy("render");
    await nextPaint();
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    // render the page through the full replay pipeline into an off-DOM sink,
    // then prepend it in one pass; save/restore live-stream state
    const sink = document.createElement("div");
    sink.style.display = "contents"; // transparent wrapper: children lay out in #events
    const savedLastTextEl = state.lastTextEl, savedLastTextContent = state.lastTextContent;
    const savedTextSealed = state.textSealed;
    const savedThinkingEl = state.thinkingEl, savedThinkingContent = state.thinkingContent;
    const savedToolGroupEl = state.toolGroupEl;
    state.lastTextEl = null; state.lastTextContent = "";
    state.textSealed = false; // the sink renders records, never a sealed live block
    state.thinkingEl = null; state.thinkingContent = "";
    state.toolGroupEl = null;
    pageSink = sink;
    try {
      for (const item of page) addEvent(item); // unwrap tracks oldestOffset
    } finally {
      pageSink = null;
      state.lastTextEl = savedLastTextEl; state.lastTextContent = savedLastTextContent;
      state.textSealed = savedTextSealed;
      state.thinkingEl = savedThinkingEl; state.thinkingContent = savedThinkingContent;
      state.toolGroupEl = savedToolGroupEl;
    }
    // typeset AFTER insertion: MathJax needs real layout
    const mathBlocks = Array.from(sink.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
    const frag = document.createDocumentFragment();
    while (sink.firstChild) frag.appendChild(sink.firstChild);
    eventsEl.insertBefore(frag, eventsEl.firstElementChild);
    // This page can carry the end of a turn this window opened in the middle of: a
    // compaction fired mid-run, so the window's first region is a turn whose task
    // row is older than the window (agent/core/lazy.py cpr_start). Its `final`
    // arrived while the sink was the render target — where folding is refused,
    // because the pane is about to be handed those rows (auto-fold.ts) — so it
    // is folded now, on the prepended pane and before anything paints. Announced by
    // name, not called: auto-fold.ts loads after this file and a classic script
    // may only name what the files above it declared (tests/ui-load-order-test.js).
    eventsEl.dispatchEvent(new CustomEvent("clutch:page-prepended"));
    if (typeof MathJax !== "undefined" && typeof MathJax.typesetPromise === "function") {
      for (const b of mathBlocks) {
        try { await MathJax.typesetPromise([b]); } catch (e) {}
        await new Promise((r) => setTimeout(r, 0)); // repaint between blocks
      }
    }
    // prepending (and typesetting) shifted the content down: re-anchor the view on
    // the row that was on top. That row can now be inside a fold the line above
    // just closed, and a hidden row has no box — its rect reads zero, which would
    // throw the scroll position — so anchor on the fold that holds it instead: the
    // fold's head sits exactly where that row was.
    if (anchor && anchorTop !== null) {
      const onTop = anchor.getClientRects().length ? anchor : anchor.closest(".turn-fold");
      if (onTop) stream.scrollTop += onTop.getBoundingClientRect().top - anchorTop;
    }
    setOlderPill(data.older);
  } catch (e) {
    notice("Failed to load earlier records: " + e.message);
  } finally {
    paging = false;
    setOlderBusy(""); // the pill goes back to offering the page (or hides at 0)
  }
}

// The pill is the only way back to older records, and it is wired here with the
// paging state it reads — it used to be registered from the settings block,
// which only worked while the whole renderer was one file.
$("#older-pill").addEventListener("click", loadOlder);

// The session owns both answers, so it owns both controls: this file only hands
// them to the view. Every (re)connect re-asks them (the status frame, which knows
// both the open's mode and whether ANOTHER window holds the run), and the
// session's watchdog announces the changes it sees (server.py claim_watch_loop) —
// which is the whole point: a foreign run ENDS by itself, and the composer comes
// back then, with no reload and no retry here.
//
// Two announcements because there are two facts (render-events.ts):
//   * clutch:project-read-only — this project is OPENED as a viewer here;
//   * clutch:project-claim — another window is RUNNING it right now, which is
//     what the pill beside the run controls says and what its click reloads.
//
// Neither is answered here at open time: the flags are the last thing the session
// said about the project the stream is on, and setProjectInfo deliberately leaves
// them alone. A tab switch therefore keeps the claim state it had for the instant
// before its stream's status frame arrives, and that frame is the one authority.
document.addEventListener("clutch:project-read-only", (ev) => {
  const d = ((ev as any) && (ev as any).detail) || {};
  setReadOnly(!!d.readOnly);
});

// ---- a claim whose window may be gone ---------------------------------------
//
// "Another window is running this project" is only as true as the window the
// claim names, and the host cannot tell on its own: the record it holds names a
// process on the machine that claimed it, and nothing on the machine that HOLDS
// the lock can see that process. The status frame therefore carries the record
// itself (running_elsewhere + claim_owner, agent/server.py claim_watch_loop), and
// the host answers for it with this machine's own kernel (host-core settleClaim):
// only a PROVEN dead owner on the machine it names is reclaimed, at the host that
// holds the lock; every doubt ("elsewhere", "unknown", "live") changes nothing.
//
// This is asked unasked — the pill's own state has no other way out. A session
// that died mid-turn leaves its claim behind, and no process anywhere would ever
// release it: every window would keep reading "another window is running" from a
// window that no longer exists. Asked once per claim (project + host + pid +
// start), never in a loop: a reclaim answers with a new claim only if somebody
// really took it again, and that is a different claim.
let pendingClaim: any = null; // the owner record of the claim the pane is showing
const settledClaims = new Set<string>();
let settlingClaim = false; // one question at a time: the answer changes the pane

function claimIdentity(project: string, owner: any): string {
  const host = owner && typeof owner.claim_host === "string" ? owner.claim_host : "";
  const pid = owner && Number.isInteger(owner.claim_pid) ? owner.claim_pid : 0;
  const start = owner && typeof owner.claim_start === "string" ? owner.claim_start : "";
  if (!project || !host || !pid) return ""; // a record naming no window is not one
  return [project, host, pid, start].join("|");
}

async function settleAnnouncedClaim(owner: any): Promise<void> {
  const tab = activeTab();
  if (!tab || !tab.path) return;
  const project = projectOf(tab);
  const key = claimIdentity(project, owner);
  if (!key || settledClaims.has(key) || settlingClaim) return;
  const api = (window as any).clutchApi;
  if (!api || typeof api.settleClaim !== "function") return;
  settledClaims.add(key);
  // the set only remembers claims this page asked about; a page that lives for
  // months keeps a handful of keys, and a cleared one is asked again, not trusted
  if (settledClaims.size > 64) {
    const oldest = settledClaims.values().next().value;
    if (oldest) settledClaims.delete(oldest);
  }
  settlingClaim = true;
  let answer: any = null;
  try {
    answer = await api.settleClaim(tab.id, project, owner);
  } catch (e) {
    // a host that could not be reached answered nothing, so the claim is NOT
    // remembered as settled: the next frame asks again. Forgetting a failed
    // question is what keeps this pill from parking on the page for good.
    settledClaims.delete(key);
    return;
  } finally {
    settlingClaim = false;
  }
  // Reclaimed (or the lock was already free): the claim is OVER, and the pane is
  // still standing on the log as the dead window left it. Re-read it now, from
  // disk — this is the half the reader cannot do without a click, and the reason
  // the tab used to keep a transcript frozen at an unexpected end.
  if (answer && (answer.verdict === "reclaimed" || answer.verdict === "free")) {
    if (state.activeTabId === tab.id && currentProject) await reloadActiveProject(tab);
  }
}

document.addEventListener("clutch:project-claim", (ev) => {
  const d = ((ev as any) && (ev as any).detail) || {};
  setClaimed(!!d.claimed);
  pendingClaim = d.claimed && d.owner && typeof d.owner === "object" ? d.owner : null;
  if (pendingClaim) void settleAnnouncedClaim(pendingClaim);
});

// The pill's click: the claim may name a window that is gone (settleAnnouncedClaim
// frees it when this machine can prove it), and then the pane re-reads the log
// FROM DISK — not just a reconnect at its own watermark, which is what made the
// click look like it did nothing: the page keeps the log it last painted, and a
// session that ended unusually left lines after that watermark that no reconnect
// will ever resend (the foreign writer appends to the file; a frame that was
// never published is not a frame anybody owes this page).
//
// The three facts a disk re-read needs, all of them this file's own records:
//   * the memento written NOW names the range the reader is looking at, so the
//     restore walk (restoreTabView) repaints this tab's tail from the LOG's end
//     back to `oldest` — a bounded read (RESTORE_MAX_PAGES), not the whole file;
//   * the DOM cache has to go with it, or paintCachedView hands back the very
//     picture being re-read (activateTab's instant path) and nothing is fetched;
//   * `currentProject = ""` is what makes it an open at all: activateTab answers
//     an already-active tab with an early return, and that no-op was the click.
export async function reloadActiveProject(tab?) {
  const here = tab || activeTab();
  if (!here || !here.path) return;
  if (pendingClaim) await settleAnnouncedClaim(pendingClaim);
  saveMemento(here.id, { older: olderRemaining, workdir: els.workspace.textContent || "" });
  forgetDomCache(here.id);
  if (state.activeTabId === here.id) currentProject = "";
  await activateTab(here);
}

const claimPill = $("#claim-pill");
if (claimPill) claimPill.addEventListener("click", () => { void reloadActiveProject(); });

export function setProjectInfo(info) {
  currentProject = info.project || "";
  if (info.workdir) els.workspace.textContent = info.workdir;
  setStatus("idle");
  // notify status-bar.ts
  document.dispatchEvent(new CustomEvent("clutch:project-info", { detail: { project: currentProject, name: info.name } }));
}

// No tab left: back to the welcome page. The sessions were released by
// tab-bar.ts; this only tells the view what it is looking at now.
export function showWelcome() {
  supersedeOpen(); // a replay in flight must not repaint after the last tab closes
  currentProject = "";
  // no tab, no workspace: the tree goes with the project it belonged to
  enterWorkspace("");
  state.apiBase = null;
  try {
    sessionStorage.removeItem("clutch_api_url");
  } catch (e) {
    /* file:// restrictions: the base is gone either way */
  }
  // The stream goes with the panels: closing it DROPS THE SCOPE too (sse-stream.ts),
  // so the welcome page holds no log — and nothing that heals a socket on its own
  // can bring a stream back until an open adopts one again.
  closeSSE();
  // the welcome page is the pane's view now, and pane.ts is the ONE writer of
  // #stream: a load card, a bar or a failure panel a closed tab left standing
  // goes with the same state (it also clears the stream, so there is no second
  // call to keep in order here)
  apply(paneWelcome());
  setReadOnly(false);
  setClaimed(false);
  setStatus("idle");
  document.dispatchEvent(new CustomEvent("clutch:project-info", { detail: { project: "", name: "" } }));
}

// Who holds a locked project, in the user's words. The host's own record is the
// only source: it names the holding process, the machine it runs on, and when it
// took the lock. A holder that wrote no record (an older build) says nothing —
// the honest answer, never a guess.
export function describeHolder(owner) {
  if (!owner || typeof owner !== "object") return "";
  const bits = [];
  if (Number.isInteger(owner.pid)) bits.push(`process ${owner.pid}`);
  if (owner.host) bits.push(`on ${owner.host}`);
  if (typeof owner.since === "number" && owner.since > 0) {
    bits.push(`since ${new Date(owner.since * 1000).toLocaleString()}`);
  }
  return bits.length ? `Held by ${bits.join(" ")}.` : "";
}

// ---- a pane that has to explain itself --------------------------------------
//
// Opening a tab can fail in ways the user must READ: the file is on a machine
// this window is not on, the remembered host will not authenticate, the working
// directory is gone. That used to be a notice() toast — and notice() hides
// itself after 8 seconds, so the failure's only words vanished while the pane
// stayed blank underneath with nothing on it (the reported "标签页一片空白").
// A failed activation therefore paints this panel INSIDE the pane, where it
// stays until the tab opens or the user dismisses it; and its one action is
// Retry — the load again, from the top, exactly as a click on the tab opens it.

// Hide it but keep knowing WHICH tab it was standing in for: that tab's pane is
// still no transcript, so its DOM must not be cached as one (activateTab asks
// paneBlockedTabId). Dismissing is therefore a flag on the same state, never a
// different state — and any other state replaces it outright (pane.ts).
function dismissBlocked() {
  const state = currentPane();
  if (state.view === "blocked") setPane({ ...state, shown: false });
}

// A tab could not open: the panel explains why. The load card and its bar go with
// the same act — a hop's bar left at 100% over a panel is the same lie as no panel
// at all — because one state replaces the other (pane.ts).
function showBlocked(tab, text, machine?) {
  apply(paneBlocked((tab && tab.id) || null, text, machine || null));
}

// Retry is not a second way to open a tab: it IS the tab again, from the top.
// Everything a panel can be standing over — a dial that did not get through, a
// claim with no session behind it, a lock, a forward that died mid-replay — is
// answered by running the one route a click on the tab runs, and that route's
// own bar is where it reports (the load card in pane.ts, conn-flow's hop with its
// password prompt and its share of the bar, then the replay).
//
// The panel used to offer the PICKER's door instead ("Connect"), from before the
// load route could dial: handleSshConnect is a WINDOW-level move (it calls
// switchBackendResolved and refreshPicker, and a change of host tears down what
// the window was on) whose progress could only ever be a line of text in this
// panel — the same load, reported in a second shape on a second surface. The load
// route asks for a password itself now (conn-flow.ts connectTabMachine), so that
// door had no reason left, and the picker's move stays in the picker.
export async function retryTab(tab) {
  if (!tab) return;
  dismissBlocked();
  // The panel says this open did not land, so any picture cached for the tab is
  // the OLD one and must not stand in for it: activateTab would paint it over the
  // load's card, and every stage the hop reports would land in a pane that is not
  // a load (pane.ts setProgress reports into nothing).
  forgetDomCache(tab.id);
  // ...and the verdict the panel is showing belongs to the attempt that just
  // failed. A stale sentence here would outlive its truth (the hop it asked for
  // may be up by now, from the picker), and the new attempt writes its own.
  tab.unreachable = null;
  beginPaneLoad(tab);
  // "currentProject" is the window's belief that it is LOOKING at a project. A
  // failure AFTER the meta line (a forward that died mid-replay) leaves the belief
  // behind, and activateTab's "already open" early return would then leave this
  // fresh card at 0% with nothing running. Only this tab's own belief is spent —
  // another tab's project is none of this retry's business.
  if (state.activeTabId === tab.id) currentProject = "";
  await activateTab(tab);
}

// The panel is markup in index.html; its two buttons are wired once, at load.
(function wireBlocked() {
  const retry = document.getElementById("tab-blocked-retry") as HTMLButtonElement | null;
  if (retry) {
    retry.addEventListener("click", async () => {
      const tab = state.tabs.find((x) => x.id === paneBlockedTabId());
      if (!tab) return;
      retry.disabled = true;
      try {
        await retryTab(tab);
      } finally {
        retry.disabled = false;
      }
    });
  }
  const dismiss = document.getElementById("tab-blocked-dismiss");
  if (dismiss) dismiss.addEventListener("click", () => dismissBlocked());
})();

// ---- a tab on the wrong machine ----------------------------------------------
//
// agent/api/project.py answers "not a .clc project file" for a path that is not a
// .clc, and — on the machine whose session ran the open — for one that is not
// there. The second half is a fact about ONE machine and nothing more: it does not
// say the path is bad, and it does not say where the file is.
//
// This used to be answered by GUESSING. A tab that had never recorded a machine
// (state.ts `machine`) was handed `rememberedMachine()` — the picker's most
// recently dialled host — which is a different fact entirely ("where the user last
// connected"), and it was written into the tab and persisted with the working set.
// With two projects on two machines that guess is simply the other one: the
// reported tennis.clc lived on hero@192.168.31.237, its tab was stamped
// root@region-46.seetacloud.com:31943 (the machine the OTHER tab was on), and
// because the old diagnosis only spoke for tabs with NO machine, while slots.ts
// prepareTabMachine pins every claim to the machine a tab names, that tab asked the
// wrong host for a hero path for the rest of its life — across restarts.
//
// So nothing here is remembered or guessed. The machines this window can reach
// RIGHT NOW are asked, one /api/fs/stat each, for the tab's own file; the one that
// answers "file" is the machine the open must run on. When no live machine holds it
// (a genuinely bad path, or the file's machine is not connected) no record is
// invented: the refusal stands as the honest answer, and the panel says so.
//
// A machine this window is not on cannot be asked, and that is deliberate: "who
// has this file" must be an answer a host produced, never a dial into whichever
// host the user happened to touch last.

// Every machine this window can ask right now, with the base to ask it on: one
// entry per live hop (the shell's row is {url, target}, i.e. tunnel-core's bound
// instance per endpoint). A row with no address or no target cannot be asked and
// is left out — reading a machine off a URL's shape is the bug above.
async function liveMachines(): Promise<Array<{ machine: Machine; base: string }>> {
  if (!(window.clutchTunnel && window.clutchTunnel.list)) return [];
  let rows;
  try {
    rows = await window.clutchTunnel.list();
  } catch (e) {
    return [];
  }
  const out: Array<{ machine: Machine; base: string }> = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const machine = asMachine(row && row.target);
    if (!machine || !row.url) continue;
    out.push({ machine, base: String(row.url).replace(/\/+$/, "") });
  }
  return out;
}

// Does THIS machine hold the tab's file? Exact, not "its directory exists":
// /api/fs/stat answers "file" for a regular file and "none" for anything else
// (nothing there, a directory, a broken link — agent/browsing.py stat_payload), and
// a machine that will not answer is not a holder. The deadline is short because
// this runs while a failed open is on screen: a dead forward must cost a moment,
// not the whole diagnosis.
async function holdsFile(c: { machine: Machine; base: string }, path: string): Promise<boolean> {
  try {
    const st = await apiFetch("/api/fs/stat?path=" + encodeURIComponent(path), {
      base: c.base,
      timeout: 10000,
    });
    return !!(st && st.type === "file");
  } catch (e) {
    return false;
  }
}

// The machine that HAS this tab's file, other than the one the open just ran on:
// the answer the refusal could not give. null when the path is not a .clc at all
// (the other half of the host's one message, which no machine can heal) or when no
// live machine holds it — the caller then invents nothing.
async function machineWithFile(tab): Promise<{ machine: Machine; base: string } | null> {
  const path = tab && tab.path;
  if (!path || !/\.clc$/i.test(String(path))) return null;
  const live = await liveMachines();
  if (!live.length) return null;
  // asked together: N hops are one wait, not a queue of timeouts
  const held = await Promise.all(live.map((c) => holdsFile(c, path)));
  for (let i = 0; i < live.length; i++) {
    // the machine the open already failed on is not an answer: a second try there
    // would only repeat the same refusal
    if (held[i] && !sameMachine(live[i].machine, tab.machine)) return live[i];
  }
  return null;
}

// ---- the pane's transitions -------------------------------------------------
//
// Who owns #stream, and what a load is doing, are pane.ts's state (PaneState).
// This file contributes the two things that state cannot know: the tab's NAME as
// the card shows it, and the transcript work a view implies. `apply` is the ONE
// place a state lands on screen, so the invariant is structural instead of a
// convention spread over every call site:
//
//   * a view that is not a transcript holds no transcript — the tab we left is in
//     the view cache, never behind a card (that was the reported bug);
//   * a load reads from its first line;
//   * and a state that arrives from an open that has been superseded is not
//     applied at all (the caller checks, here it just cannot half-land).
function apply(next: PaneState) {
  if (next.view !== "tab") clearStream();
  if (next.view === "load") stream.scrollTop = 0;
  setPane(next);
}

// How a tab is named in the pane's own words: its title when it has one, else
// the file it stands for, else just "project".
function tabLabel(tab) {
  return (tab && (tab.name || (tab.path ? String(tab.path).split("/").pop() : ""))) || "project";
}

// The LOG a tab stands for: the host's canonical path once the tab is open (that
// is its resource identity), the picker's spelling before that. This is what the
// live stream adopts when the tab's open ends — the same value the memento and the
// tab's own record use, so a read and its tab can never name different files.
function projectOf(tab) {
  return (tab && (tab.projectKey || tab.path)) || "";
}

// A tab is being opened. Every load begins here: the stream is emptied, the card
// names the tab, and the bar starts unmeasured before the claim (a hop, a session
// spawn) has anything to number. conn-flow.ts then REPORTS its stages into that
// bar (pane.ts reportHopStage) and openInTab continues it from the state.
export function beginPaneLoad(tab) {
  const id = (tab && tab.id) || "";
  const label = tabLabel(tab);
  const where = tab && tab.machine ? `on ${machineLabel(tab.machine)}` : "";
  // ONE load, one card — and one bar. A boot puts this tab's card up before the
  // first claim and then activates the same tab (boot.ts), and that activation
  // used to paint a SECOND, fresh card over the first: the position the hop had
  // just reported fell back to "nothing measured" and the bar started again from
  // zero mid-dial (the reported "the bar does not animate, it jumps forward").
  // A card already naming this tab IS this load's; only its words are refreshed.
  const now = currentPane();
  if (id && now.view === "load" && now.tabId === id) {
    if (now.label !== label || now.where !== where) setPane({ ...now, label, where });
    return;
  }
  apply(paneLoad(id, label, where));
}

// The paging pill is a transcript's control; its count and its own paging are the
// pager's (here), only its owner is the pane's.
onPaneChange((pane) => setOlderOwner(pane.view === "tab"));

// Open a project on the session that owns this tab. Activation is always
// allowed — every tab has its OWN session, so a run in one tab cannot conflict
// with opening another tab. The busy guard belongs to explicit Open/New (a
// project opened from the picker replaces the active tab).
//
// It RETURNS what the pane must show when the open did not land (null when it
// did: the transcript is the pane's now), so an opener decides and `apply`
// paints — no failure path can leave a load card standing over an open that is
// over, which used to be a `finally` re-check.
async function openInTab(tab, base, readOnly = false, seq = openSeq, retried = false): Promise<PaneState | null> {
  const path = tab.path;
  try {
    // NOT apiFetch: this endpoint streams NDJSON (meta/progress/event/done), so
    // the body must stay a stream; only the error unwrap below shares apiFetch's
    // contract (Error with .code/.status)
    if (!base) throw noBackend(); // never fetch "null/api/project/open"
    const ctl = new AbortController();
    openAbort = ctl;
    const r = await fetch(base + "/api/project/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...(readOnly ? { read_only: true } : {}) }),
      signal: ctl.signal,
    });
    if (isStale(seq)) return null;
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const e = new Error(err.error || r.status);
      e.code = err.code || null; // e.g. project_open_conflict (HTTP 409)
      // who holds it, as far as that holder's record knows, and the exact file
      // the host locked (so the lock list can be matched without re-resolving)
      e.owner = err.owner || null;
      e.project = err.project || null;
      throw e;
    }
    if (isStale(seq)) return null;
    clearStream();
    // the pane and its bar are already this load's (beginPaneLoad): the replay
    // CONTINUES the one bar from where the hop left it (pane.ts keeps that value
    // in the state — the hop reported a fraction, the replay reports its own)
    paneReplayProgress("parse", 0);
    // /api/project/open streams NDJSON: meta, progress, event, done
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let started = false;
    let processed = 0;
    let totalEvents = 0;
    let rendered = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (isStale(seq)) return null; // superseded mid-replay: paint nothing more
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { console.warn("[openProject] undecodable line", e); continue; }
        if (isStale(seq)) return null;
        if (msg.error) {
          const e = new Error(msg.error);
          e.code = msg.code || null;
          throw e;
        }
        if (msg.meta) {
          // the host's canonical path is this tab's resource identity; the path
          // the picker gave us may be relative or a symlink spelling
          tab.path = msg.meta.project;
          tab.projectKey = msg.meta.project;
          if (msg.meta.name) tab.name = msg.meta.name;
          setProjectInfo({
            project: msg.meta.project,
            name: msg.meta.name,
            workdir: msg.meta.workdir,
          });
          started = true;
        } else if (msg.count) {
          totalEvents = msg.count;
          // lazy open: "older" = durable records still on disk before the loaded tail
          if (typeof msg.older === "number") setOlderPill(msg.older);
        } else if (msg.progress && msg.progress.total) {
          // phase "parse": the host is reading the file, the first half of the replay
          paneReplayProgress("parse", msg.progress.done / msg.progress.total);
        } else if (msg.event) {
          // {offset, event}: addEvent unwraps and tracks the oldest loaded offset
          addEvent(msg);
          // phase "render": the records are here and the pane is taking them
          if (totalEvents) paneReplayProgress("render", ++rendered / totalEvents);
        }
        // yield periodically so the browser paints the bar and streams events progressively
        if (++processed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (isStale(seq)) return null;
    // phase "typeset": the math the replay painted, as the tail of the same bar
    await typesetProgressively(eventsEl, (f) => paneReplayProgress("typeset", f));
    if (isStale(seq)) return null;
    if (started) paneReplayProgress("typeset", 1);
    // the load ends here: the transcript is the pane's now (the card and the bar
    // were part of the LOAD state, so they go with it)
    apply(paneTab(tab.id));
    // ...and back where this tab was left: the replay repainted the same records,
    // so the reader's own pixel is the honest place to stand (a tab with no place
    // of its own lands on the tail instead — placeRestored decides)
    placeRestored(tab.id);
    // The host resolved this path on SOME machine, and that is a fact now — not
    // before. Recording it here (rather than at claim time) is what keeps a tab
    // from this store's pre-machine past diagnosable: a claim that lands local
    // for a file that lives elsewhere must stay unproven until the open proves
    // it one way or the other.
    if (started) await noteTabMachine(tab, base);
    if (isStale(seq)) return null;
    finishOpen(projectOf(tab));
    return null; // it opened: the pane is this tab's, and nothing else to show
  } catch (e) {
    if (isStale(seq, e)) return null; // a superseded open says nothing and paints nothing
    // Nothing below paints: each path RETURNS the state the pane must show — the
    // load card for an open that is still going (a reclaim that worked re-opens on
    // it), the panel for one that is over. The caller applies it, so no path here
    // can leave the card standing over an open that has finished.
    // A "not a .clc" refusal is a fact about the machine that RAN the open: it
    // could not see the file. Which machine can is asked, not remembered
    // (machineWithFile), and the tab learns it — the claim that follows pins that
    // machine (slots.ts prepareTabMachine) and the open is tried once more, there.
    // `retried` makes a second refusal final: one probe per open, so a machine that
    // answers "file" and then refuses anyway cannot loop either.
    if (!retried && e && /not a \.clc/i.test(String(e.message || ""))) {
      const there = await machineWithFile(tab);
      if (isStale(seq)) return null;
      if (there) {
        recordTabMachine(tab, there.machine);
        const moved = await claimTab(tab);
        if (isStale(seq)) return null;
        if (moved) {
          adoptBase(moved);
          clearStream();
          return await openInTab(tab, moved, readOnly, seq, true);
        }
        clearStream();
        // the claim refused and said why (slots.ts): that is the honest message,
        // and it stays on the pane with the door that fixes it
        return paneBlocked(
          tab.id,
          tab.unreachable || `${tab.name || tab.path} lives on ${machineLabel(there.machine)}`,
          there.machine
        );
      }
    }
    // A genuine open failure (bad path, dead forward, "not a clc"): the open is
    // over, so the panel takes the pane — a load that will never finish must not
    // keep saying it is running.
    // a network "Failed to fetch" usually means the remote session forward died
    console.error("[openProject] failed:", { api: state.apiBase, path, error: e && e.message });
    // Same medium as every other failed open: the panel, which stays. (A toast
    // here was gone in 8 s, and what it left behind was the blank pane.)
    return paneBlocked(
      tab.id,
      "Failed to open project: " + e.message +
        (tab.machine ? ` (on ${machineLabel(tab.machine)})` : ""),
      tab.machine
    );
  }
}

// Where a tab's view stands once its transcript is back, and what the pane
// follows from there.
//
// Coming back to a tab means the SAME part of the log, at the same pixel: the
// replay (or the tail restore) is how the records get here, never a reason to
// land somewhere else. So the tab's own place is the placement, and the latch is
// read OFF that placement — a reader who left on the tail comes back following
// it, one who left in the middle comes back there and stays there while the
// reconnect appends below (the ↓ pill is the way to the new tail). What the tab's
// run did while it was away is not a reason to move the reader: it was not asked
// for, and it is exactly the "it jumps somewhere else" this replaces.
//
// A tab with no place to go back to — its first open, or one abandoned before it
// ever painted — stands on the tail, which is where a fresh transcript starts.
function placeRestored(tabId: string): void {
  const placed = restoreMemento(tabId);
  if (placed === null) {
    state.followTail = true;
    stream.scrollTop = stream.scrollHeight;
    setJumpVisible(false);
    return;
  }
  state.followTail = nearBottom();
  setJumpVisible(!state.followTail);
}

// The ending every open path shares (full replay and tail restore alike): adopt
// the live stream onto the log that was just opened, then let the host continue a
// turn the log still has open. One place, so the orders cannot drift.
//
// `project` is the log ITSELF, named by the open that produced it — never read off
// `currentProject`: adopting is a decision, and a decision needs its input, not a
// global another path may have moved. It is also what makes the stream's scope
// bounded by the open: nothing has been adopted since closeSSE at the start of the
// switch, so every automatic heal in between was a no-op (sse-stream.ts), and this
// is the ONE moment a pane says which log it is showing.
function finishOpen(project: string) {
  // the watermark (streamHighOffset) holds this project's tail after the replay,
  // so the stream resumes exactly there
  connectSSE(project);
  refreshTree();
  refreshRollbackAnchors(); // the rows just replayed can be rolled back; ask the journal
  // What was replayed may END with an open turn — a host that died before the
  // final, a phone frozen mid-step. Now that this page is looking at that log,
  // it is the one that asks the host to continue it (render-events.ts
  // resumeTurn: one state() question, then drive() if it is open). Not awaited:
  // the open is finished and the turn is the host's to drive.
  resumeTurn();
}

// ---- switching back: rebuild the tail, not the whole file ----------------------
//
// Every switch used to re-read the entire .clc through /api/project/open. This
// restores the END of the log — the tail paged backwards to where the tab's
// painted range began — so nothing is left for the reconnect to pour into a pane
// that is already on screen. One small /api/session read first, because a
// session that was REPLACED under the tab has no project open — then the full
// open path is the only honest answer.
const RESTORE_MAX_PAGES = 8;
const RESTORE_PAGE_BYTES = 256 * 1024;

async function restoreTabView(tab, base, seq: number): Promise<boolean> {
  const m = mementoOf(tab.id);
  if (!m || m.high === null || !tab.path) return false;
  // This restore's own requests are cancellable: the NEXT tab click aborts them
  // (supersedeOpen), so an abandoned walk stops here instead of dragging its
  // remaining pages off the tunnel while the tab the reader wants waits.
  const ctl = new AbortController();
  viewAbort = ctl;
  const signal = ctl.signal;
  let info;
  try {
    info = await apiFetch("/api/session", { base, signal });
  } catch (e) {
    return false;
  }
  if (isStale(seq)) return false;
  const openPath = info && info.memory && typeof info.memory.path === "string" ? info.memory.path : "";
  if (!openPath || openPath !== projectOf(tab)) return false;

  const pages: any[][] = [];
  // WHERE THE RANGE ENDS: at the log's tail, not at the offset the tab was left
  // on. The memento's `high` is a snapshot of the moment the tab was left, so
  // everything the project wrote while it was away is NEWER than the range a
  // `high`-anchored restore repainted — and that is exactly what the reconnect
  // (`?since=high`) then had to pour into the pane AFTER the card was gone, one
  // record per SSE frame, one paint per record (`_owed_records` has no cap). Over
  // a tunnel every frame is its own chunk and its own paint: the reported "a pile
  // of messages loads itself in a burst" the instant the load finished. Loopback
  // hands the same block over in one read, which is why a LOCAL tab just appeared
  // at the bottom of the transcript. Paging backwards FROM the tail puts those
  // records inside the restore — behind the card, batched, before anything is
  // scrolled — and leaves `?since=` with nothing to flood the pane with.
  //
  // `/api/session`'s memory.bytes is the whole file (header included) while
  // `before` counts from the event region, so it over-approximates by the
  // header's bytes; the server clamps (lazy.py read_page: hi = min(hi,
  // file_bytes - base)) and answers with the real tail. A host too old to report
  // it falls back to the memento's own high — every build's behaviour until now.
  const mem = info && (info as any).memory;
  const tail = mem && typeof mem.bytes === "number" && Number.isFinite(mem.bytes) ? mem.bytes : null;
  let cursor = tail === null ? m.high + 1 : tail; // before is exclusive
  const target = typeof m.oldest === "number" ? m.oldest : m.high;
  // The range being rebuilt is measured in bytes (one record per offset) and it
  // is the only thing this restore knows the size of. The bar moves by how much
  // of it has arrived, because on a remote tab this fetch IS the wait: a restore
  // that reported nothing left the card standing still for as long as the
  // network took, and then the transcript appeared (the reported "the bar does
  // not animate, it jumps forward").
  const span = Math.max(1, cursor - target);
  const from = cursor;
  for (let i = 0; i < RESTORE_MAX_PAGES && cursor > target; i++) {
    let page;
    try {
      page = await apiFetch(
        `/api/history?before=${cursor}&limit=${RESTORE_PAGE_BYTES}&align=turn`,
        { base, signal }
      );
    } catch (e) {
      break; // partly restored is still usable: the older pill offers the rest
    }
    if (isStale(seq)) return false;
    const events = page && Array.isArray(page.events) ? page.events : [];
    if (!events.length) break;
    pages.push(events);
    const older = Number.isFinite(page.older) ? page.older : 0;
    if (older >= cursor) break;
    cursor = older;
    // the tail is an ABSOLUTE file size while the walk's end is a relative
    // offset (the header is not part of the log), so the last step can overshoot
    // the span by those header bytes: the bar is full, not fuller
    paneReplayProgress("parse", Math.min(1, (from - cursor) / span));
  }
  if (!pages.length) return false;

  const project = projectOf(tab);
  clearStream();
  setProjectInfo({
    project,
    name: tab.name || project.split("/").pop() || project,
    workdir: m.workdir || dirOf(project),
  });
  // pages were fetched backward; paint them oldest-first — and move the bar with
  // the records actually painted, yielding between bursts: a synchronous loop
  // over a megabyte leaves the browser ONE frame at the end of it, which is a bar
  // that moves once (openInTab's replay yields for the same reason)
  const total = pages.reduce((n, p) => n + p.length, 0);
  let painted = 0;
  for (let i = pages.length - 1; i >= 0; i--) {
    for (const item of pages[i]) {
      if (isStale(seq)) return true; // a newer tab is taking the pane
      addEvent(item);
      if (total) paneReplayProgress("render", ++painted / total);
      if (painted % 25 === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (isStale(seq)) return true;
      }
    }
  }
  setOlderPill(Math.max(0, cursor));
  // the math the restored tail carries, as the bar's last phase — openInTab does
  // the same, and typesetting BEFORE the view is placed is what keeps that
  // placement honest (a taller row would otherwise put the tail above the fold)
  await typesetProgressively(eventsEl, (f) => paneReplayProgress("typeset", f));
  if (isStale(seq)) return true; // a newer tab is taking the pane
  // The tail is painted up to the LOG's end, which may be past where this tab was
  // left; its own place is what the reader comes back to, and the caller puts it
  // back once the card is down — see activateTab, and note that openInTab places
  // its own the same way, right after its apply. It cannot be put back here: the
  // card's end is where the pane SETTLES (auto-fold folds the turn this tail is cut
  // in the middle of), and a place put back before that fold is a pixel of a taller
  // pane — the reader would land above the tail they left, and the latch would read
  // "scrolled up" on a pane that is at its end.
  //
  // the tail is painted and the card is about to go: the bar closes on the same
  // phase the full replay uses, so no path ends a load with the bar short of it
  paneReplayProgress("typeset", 1);
  // the tail is painted and the pane is still the LOAD card's: the caller ends
  // the load (apply(paneTab)) in the same place every other open path does
  finishOpen(project);
  return true;
}

// The instant half of a switch: a tab whose rendered view is still cached is
// painted BEFORE anything is claimed, so moving between tabs on this machine
// never shows a load card at all. The card used to be painted first and the
// cache restored after the claim — and the claim is at least one IPC round trip,
// so every cached switch flashed "loading" for a frame or more (the reported
// bug). Painting the cache here costs nothing: `restoreDomCache` is synchronous
// and DOM-only (slots.ts), and the claim that follows only buys the SSE base.
//
// A tab that names a MACHINE takes this path as soon as its hop is already up —
// nothing is dialled then, and the claim that follows is a plain IPC round trip.
// A tab whose hop is NOT up keeps the card: its claim has to dial, conn-flow.ts
// reports that attempt into the load card, and a cached picture under a busy bar
// would say the session is ready before it is. Those tabs land on their cache
// when the claim is through.
//
// True means the pane already shows this tab. The caller then only has to claim
// (for the base) and end the open — or, if the claim fails, put the panel up.
function paintCachedView(tab): boolean {
  if (!tab || !tab.id || !tab.path) return false;
  // A tab that names a MACHINE keeps the card only while its claim still has to
  // DIAL: conn-flow reports that attempt into the card, and a cached picture
  // under a busy bar would say the session is ready before it is. Once the tab is
  // already on its hop — claimed in this life, and this window on that machine
  // (slots.ts hopUpFor) — nothing gets dialled, the claim is one IPC round trip,
  // and the tab takes the instant path exactly like a local one. Holding the card
  // for every machine tab is what made coming back to a remote tab rebuild it
  // from the network every single time (the reported "it keeps loading for a long
  // while instead of showing the page it already had").
  if (tab.machine && !hopUpFor(tab)) return false;
  if (!restoreDomCache(tab.id)) return false;
  // The picture is the pane's again, on the exact pixel it was left on — so the
  // latch is read off that place, not off the tab we just left: the cache's own
  // snapshot is a coarser answer, and what must hold from here is "a reader who
  // came back mid-transcript stays there while the catch-up appends below".
  state.followTail = nearBottom();
  setJumpVisible(!state.followTail);
  // The picture is the pane's again, live pointers and all (slots.ts DomCache).
  // A tab that was running when it was left brings back the block its step was
  // still writing into, and no delta for it is owed: the frames of a background
  // tab were routed to its badge (render-events.ts onEvent), so the block is
  // exactly as long as the last delta the pane saw, and the deltas it missed are
  // never stored — they can only be abandoned. That is the SAME teardown a
  // reconnect performs (sse-stream.ts es.onopen), so it is done here, in the very
  // task that put the nodes back — no frame reaches the screen in between — and
  // not a frame later. It must follow restoreDomCache, not precede it:
  // dropOrphanLive asks whether state.lastTextEl is CONNECTED, which is only true
  // once the cached node is the pane's again.
  //
  // What it does with that block is CLOSE it (stream-events.ts): the text stays on
  // the page — the deltas arriving now are the text after a gap, and appending them
  // is the answer that began mid-sentence ("，下一次") — and the step's durable
  // record is what writes the block whole.
  dropOrphanLive();
  // the workdir from the memento belongs to THIS tab, not to whatever the
  // workspace element still shows from the tab we just left
  const m = mementoOf(tab.id);
  const projectPath = projectOf(tab);
  setProjectInfo({
    project: projectPath,
    name: tab.name || projectPath.split("/").pop() || projectPath,
    workdir: (m && m.workdir) || dirOf(projectPath),
  });
  // the older-pill count the tab had when it was last seen; the SSE catch-up may
  // append records but cannot add new older ones
  if (m) setOlderPill(m.older);
  return true;
}

// Activate a tab: it keeps its OWN session. Saving the view of the tab we leave
// is all the switch does to it — a run behind it keeps running on its host, and
// the tab's watcher keeps its badge honest (slots.ts).
export async function activateTab(tab, readOnly = false) {
  if (!tab) return;
  const same = tab.id === state.activeTabId;
  // a double click on the tab already opening joins that open instead of
  // racing a second replay of the same project
  if (same && opening && opening.id === tab.id) {
    await opening.promise;
    return;
  }
  const here = projectOf(tab);
  if (same && !opening && currentProject && currentProject === here) return;

  const prev = activeTab();
  if (prev && prev.id !== tab.id) {
    // A catch-up the pane is still receiving is the LEAVING tab's last words, and
    // both records taken below (the memento and the DOM cache) carry the watermark
    // that already counts them: paint them into the pane first, and close the
    // block, or the tab comes back missing exactly that block — the one thing a
    // reconnect will not resend — and the next tab opens inside a bracket that
    // was never closed.
    settleCatchUp();
    saveMemento(prev.id, { older: olderRemaining, workdir: els.workspace.textContent || "" });
    if (paneBlockedTabId() === prev.id) {
      // That pane held a failure panel, not a transcript: caching it would save
      // the blank pane (and bring it back on a later switch) instead of the
      // panel that explains it. Drop the cache and put the panel away — the tab
      // repaints it if its claim fails again.
      forgetDomCache(prev.id);
      dismissBlocked();
    } else {
      // Cache the previous tab's complete DOM and render state for instant restoration
      saveDomCache(prev.id);
    }
    if (prev.running) watchTab(prev);
  }
  const seq = supersedeOpen();
  // the stream that is open right now belongs to the tab we are leaving; letting
  // it live through the next replay is how one project's records landed in the
  // other tab's pane. Closing it drops the SCOPE as well, so from here until this
  // activation's own open finishes (finishOpen) there is no log to read: the
  // automatic heals in between (a new base, a dropped one) are no-ops by
  // construction rather than by a rule each of them has to remember.
  closeSSE();
  // ...and that stream is the one fact that would have confirmed a send in
  // flight (render-events.ts outbox): the wait ends here, with the message still
  // in the box. A send belongs to the tab that started it, and this box is about
  // to belong to another project — the tab it came from replays its own row when
  // the reader comes back to it.
  endSend();
  const changed = state.activeTabId !== tab.id;
  state.activeTabId = tab.id;
  if (changed) document.dispatchEvent(new CustomEvent("clutch:tab-state"));
  unwatchTab(tab.id);
  tab.needsInput = false;
  // A tab that already has a picture shows it BEFORE the claim (see
  // paintCachedView): the claim is an IPC round trip, and painting the card first
  // made every cached switch flash it. A tab that names a machine keeps the card
  // — its claim is the thing being reported, and it may dial. Either way one
  // switch is one state.
  const cached = paintCachedView(tab);
  if (!cached) beginPaneLoad(tab);
  // The workspace panel is the other half of what a click changes, and it changes
  // in THIS task: the tree, its expansions and its root belong to the project the
  // tab stands for, never to the one we just left. Painting it here is what makes
  // a switch atomic — and coming back to a workspace paints the tree it had,
  // instead of keeping the other tab's files up until a walk answers (seconds on
  // a remote project, which is the "the tab and the workspace disagree" report).
  // The root we can already name is this tab's own record; the host's answer
  // replaces it the moment the claim lands (refreshTree below).
  const hereMemo = mementoOf(tab.id);
  enterWorkspace(here, (hereMemo && hereMemo.workdir) || dirOf(here));

  // What this activation must SHOW when it is over. Every path below decides
  // that and paints nothing, so a state can only land once — at the end, and
  // only while this is still the current activation.
  // A tail rebuilt from the log (`restoreTabView`) is the one path whose place is
  // put back after that landing: the card's end settles the pane, and a place is a
  // pixel of the pane it is put back on.
  let restored = false;
  const run = async (): Promise<PaneState | null> => {
    const base = await claimTab(tab);
    if (isStale(seq)) return null;
    if (!base) {
      // No session for THIS tab: the pane must not keep another project's
      // transcript under a "no session" line. slots.ts says why when it is a
      // machine it would not cross (a remote tab and no hop to its host): that
      // names the host, which is the one fact the user needs to get the tab back
      // — and the tab has recorded a machine, so the panel can offer the door
      // that dials it. Otherwise there is simply no backend, and the panel says
      // that instead. Either way it STAYS: the toast that used to say this was
      // gone with the reason it carried.
      return paneBlocked(
        tab.id,
        tab.unreachable || "This tab has no session — the backend is not running.",
        tab.unreachable ? tab.machine || null : null
      );
    }
    tab.unreachable = null;
    adoptBase(base);
    // The workspace walk starts NOW, next to the transcript restore instead of
    // after it: it is a different question to a different endpoint, and the panel
    // it fills is already showing this project (enterWorkspace). Coalesced with
    // finishOpen's own call below (one walk at a time), so this costs a switch
    // nothing — it only stops the two from being serial.
    refreshTree();
    if (!tab.path) return paneTab(tab.id); // a placeholder tab (createProject fills the path)

    // The cached picture (when there was one) is already the pane's: it was
    // painted before the claim, so this claim only bought the SSE base. The
    // stream reconnects at the offsets that cache restored (finishOpen), which is
    // what makes switching back instant instead of a replay.
    if (cached) {
      finishOpen(projectOf(tab));
      return paneTab(tab.id); // the cached view IS this tab's pane again
    }

    // No DOM cache: fall back to replaying from disk. Try restoring just the
    // painted range (if this session still has the same project open), then
    // the full open if needed.
    if (await restoreTabView(tab, base, seq)) {
      if (isStale(seq)) return null;
      restored = true;
      return paneTab(tab.id);
    }
    if (isStale(seq)) return null;
    return await openInTab(tab, base, readOnly, seq);
  };
  const mine = { id: tab.id, promise: run() };
  opening = mine;
  let next: PaneState | null = null;
  try {
    next = await mine.promise;
  } finally {
    if (opening === mine) opening = null;
  }
  // the ONE place an activation's state lands — and only from the activation
  // that is still current: one superseded has already painted its own card, and
  // applying this one would paint over it (the reported "two tabs, both showing
  // the other project").
  if (next && !isStale(seq)) {
    apply(next);
    // …and back where a rebuilt tail was left, on the pane the card left: the
    // settle above folds the turn that tail is cut in the middle of, so the height
    // this place is a pixel of is the settled one. openInTab does the same, inside
    // its own apply.
    if (restored) placeRestored(tab.id);
  }
}

// An explicit Open from the picker: a project is a TAB, and a tab is its own
// session. Opening a path that is already a tab just switches to it.
export async function openProject(path, readOnly = false) {
  const existing = findTabByPath(path);
  // already here, and already open: nothing to do (and never a re-open that
  // would be refused by the session's own run lease)
  if (existing && existing.id === state.activeTabId && currentProject === path) return;
  // Opening while another tab runs is the POINT of tab-per-session: a new
  // project gets its own tab and its own session, so no guard is needed here.
  const tab = existing || ensureTab(path);
  await activateTab(tab, readOnly);
}

export async function createProject(dir, name) {
  // A new project is a new tab with its own session: it can be created while
  // another tab is running.
  //
  // Leaving the current tab is then the same act activateTab() performs: its
  // view goes into a memento, and a run still behind it keeps a badge watcher.
  // Without that watcher the tab we leave reads "running" for as long as it stays
  // in the background, because nothing is listening to its session any more.
  const prev = activeTab();
  if (prev) {
    saveMemento(prev.id, { older: olderRemaining, workdir: els.workspace.textContent || "" });
    // Cache the previous tab's DOM so switching back to it is instant, the same
    // way activateTab() does — leaving a tab is one act, however it is left.
    saveDomCache(prev.id);
    if (prev.running) watchTab(prev);
  }
  // the new project needs a session before it has a path: claim the tab's slot
  // first, then create the file on THAT session.
  const seq = supersedeOpen();
  // same act as leaving a tab (activateTab): the stream — and with it the SCOPE —
  // is dropped, and the new project adopts its own log when the create succeeds
  // (finishOpen at the end of this function).
  closeSSE();
  const tab = ensureTab("", name);
  state.activeTabId = tab.id;
  document.dispatchEvent(new CustomEvent("clutch:tab-state"));
  // the pane is this create's: the tab has no file yet, so the card is the only
  // honest thing on screen — and the claim may have to dial a machine
  beginPaneLoad(tab);
  const base = await claimTab(tab);
  if (isStale(seq)) return;
  if (!base) {
    showBlocked(
      tab,
      tab.unreachable || "Could not start a session for the new project — the backend is not running.",
      tab.unreachable ? tab.machine || null : null
    );
    return;
  }
  adoptBase(base);
  try {
    const data = await apiFetch("/api/project/new", { method: "POST", body: { dir, name } });
    if (isStale(seq)) return;
    tab.path = data.project;
    tab.projectKey = data.project;
    if (data.name) tab.name = data.name;
    clearStream();
    setProjectInfo(data);
    apply(paneTab(tab.id)); // a new project is empty, but it IS the pane's view now
    finishOpen(projectOf(tab)); // new empty project: the watermark resets with the stream
  } catch (e) {
    if (isStale(seq)) return;
    // a create that hits another window's file is the same conflict as an open:
    // say who holds it, even though there is nothing to take back here (the
    // project already exists — this dialog was asking to MAKE one)
    const held = e && e.code === "project_open_conflict" ? describeHolder(e.owner) : "";
    const why = "Failed to create project: " + e.message + (held ? " — " + held : "");
    // a placeholder tab with no file is not a tab the user can use
    if (!tab.path) {
      const i = state.tabs.indexOf(tab);
      if (i >= 0) state.tabs.splice(i, 1);
      if (state.activeTabId === tab.id) state.activeTabId = null;
      await releaseTab(tab);
      document.dispatchEvent(new CustomEvent("clutch:tab-state"));
    }
    // the create is over and it failed: the card comes down and the reason stays
    // up (a toast was gone in 8 s, and the blank pane outlived it)
    showBlocked(tab, why);
    // ...unless it took the last tab with it: then there is nothing left to open
    // and the welcome page is the honest view
    if (!state.tabs.length) showWelcome();
  }
}
