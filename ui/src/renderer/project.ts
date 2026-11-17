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
import { resumeTurn } from "./render-events";
import { askConfirm, notice } from "./settings";
import { closeSSE, reconnectSSE } from "./sse-stream";
import { state } from "./state";
import { addEvent } from "./stream-events";
import { busy, setStatus } from "./stream-view";
import { eventsEl, stream } from "./els";
import { refreshRollbackAnchors, resetRollbackAnchors } from "./task-rollback";
import { refreshTree } from "./workspace-panel";
import {
  activeTab,
  adoptBase,
  claimTab,
  ensureTab,
  findTabByPath,
  mementoOf,
  releaseTab,
  restoreMemento,
  saveMemento,
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
let opening: { id: string; promise: Promise<void> } | null = null;

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
  eventsEl.innerHTML = ""; // clear session content; the overlay/events wrapper stay mounted
  state.lastTextEl = null;
  state.lastTextContent = "";
  state.textSealed = false;
  state.thinkingEl = null;
  state.thinkingContent = "";
  if (state.textRenderRaf) { cancelAnimationFrame(state.textRenderRaf); state.textRenderRaf = 0; }
  if (state.thinkingRenderRaf) { cancelAnimationFrame(state.thinkingRenderRaf); state.thinkingRenderRaf = 0; }
  state.compactionEl = null;
  state.retryNoteEl = null;
  state.oldestOffset = null; // fresh project: no loaded events yet
  state.streamHighOffset = null; // and no replayed record to dedupe a reconnect against
  state.runSettled = false; // a fresh pane holds no run's ending (stream-events.ts)
  resetRollbackAnchors(); // and no journal anchors: they belong to the project that left
  setOlderPill(0);
}

// ---- scroll-up paging (lazily-opened projects) ----
// olderRemaining mirrors the server's on-disk count, so a dropped page
// never makes the pill lie
export let olderRemaining = 0;
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
  const pill = document.getElementById("older-pill");
  if (olderRemaining > 0) {
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

// read-only badge: visible only while the active project is read-only
export function showReadOnlyBadge(readOnly) {
  const badge = document.getElementById("readonly-badge");
  if (badge) badge.classList.toggle("hidden", !readOnly);
}

// The host owns the claim, so it also owns the badge. A (re)connect re-asks for
// a project this window once had to open read-only, and the session's watchdog
// takes the claim back as soon as the other holder is gone; both announce it
// (render-events.ts). Clearing the badge from that is the whole point: the
// ghost read-only was this state outliving the lock, and only this file's
// open-time meta used to be allowed to clear it.
document.addEventListener("clutch:project-read-only", (ev) => {
  const d = ((ev as any) && (ev as any).detail) || {};
  if (d.project && currentProject && d.project !== currentProject) return;
  showReadOnlyBadge(!!d.readOnly);
});

export function setProjectInfo(info) {
  currentProject = info.project || "";
  if (info.workdir) els.workspace.textContent = info.workdir;
  showReadOnlyBadge(!!info.read_only);
  setStatus("idle");
  // notify status-bar.ts
  document.dispatchEvent(new CustomEvent("clutch:project-info", { detail: { project: currentProject, name: info.name } }));
}

export function hideWelcome() {
  document.getElementById("welcome").classList.add("hidden");
  els.run.disabled = busy || !currentProject;
}

// No tab left: back to the welcome page. The sessions were released by
// tab-bar.ts; this only tells the view what it is looking at now.
export function showWelcome() {
  supersedeOpen(); // a replay in flight must not repaint after the last tab closes
  const welcome = document.getElementById("welcome");
  if (welcome) welcome.classList.remove("hidden");
  currentProject = "";
  state.apiBase = null;
  try {
    sessionStorage.removeItem("clutch_api_url");
  } catch (e) {
    /* file:// restrictions: the base is gone either way */
  }
  closeSSE();
  clearStream();
  showReadOnlyBadge(false);
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

// Is this project's lock a PROVEN orphan? Only the host can answer — the kernel
// fact about the claiming window belongs to the machine the work runs on — and
// only "orphan" (holder alive, claiming window gone) may be taken back by a
// button. Every other state belongs to somebody, and a host that cannot answer
// is no reason to take anything.
export async function provenOrphan(project) {
  const api = window.clutchLocks;
  if (!project || !api || typeof api.list !== "function") return false;
  try {
    const res = await api.list();
    const locks = (res && res.locks) || [];
    const mine = locks.find((lk) => lk && lk.project === project);
    return !!(mine && mine.state === "orphan");
  } catch {
    return false;
  }
}

// Take a proven-orphaned project back: the host stops the dead window's session
// (the one still holding the flock), and then the open can succeed. The verdict
// is the host's, so a refusal is reported instead of retried.
export async function reclaimLock(project) {
  const api = window.clutchLocks;
  if (!api || typeof api.reclaim !== "function") return false;
  try {
    const res = await api.reclaim(project);
    if (res && res.revoked) return true;
    notice("The host would not release it: " + ((res && (res.why || res.error)) || "no answer"));
  } catch (e) {
    notice("Could not reach the host: " + (e && e.message));
  }
  return false;
}

// Open a project on the session that owns this tab. Activation is always
// allowed — every tab has its OWN session, so a run in one tab cannot conflict
// with opening another tab. The busy guard belongs to explicit Open/New (a
// project opened from the picker replaces the active tab).
async function openInTab(tab, base, readOnly = false, seq = openSeq) {
  const path = tab.path;
  const prog = document.getElementById("open-progress");
  const fill = prog.querySelector(".open-progress-fill") as HTMLElement;
  const label = prog.querySelector(".open-progress-label") as HTMLElement;
  const setPct = (pct) => {
    fill.style.width = pct + "%";
    label.textContent = Math.round(pct) + "%";
  };
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
    if (isStale(seq)) return;
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
    if (isStale(seq)) return;
    clearStream();
    stream.classList.add("loading"); // history reconstruction: no entrance motion
    prog.classList.remove("hidden");
    setPct(0);
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
      if (isStale(seq)) return; // superseded mid-replay: paint nothing more
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { console.warn("[openProject] undecodable line", e); continue; }
        if (isStale(seq)) return;
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
            read_only: !!msg.meta.read_only,
          });
          hideWelcome();
          started = true;
        } else if (msg.count) {
          totalEvents = msg.count;
          // lazy open: "older" = durable records still on disk before the loaded tail
          if (typeof msg.older === "number") setOlderPill(msg.older);
        } else if (msg.progress && msg.progress.total) {
          // phase A: server file parse maps to the first 50% of the bar
          setPct(50 * msg.progress.done / msg.progress.total);
        } else if (msg.event) {
          // {offset, event}: addEvent unwraps and tracks the oldest loaded offset
          addEvent(msg);
          // phase B: client rendering of the events maps to 50-90%
          if (totalEvents) setPct(50 + 40 * (++rendered / totalEvents));
        }
        // yield periodically so the browser paints the bar and streams events progressively
        if (++processed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (isStale(seq)) return;
    // phase C: typeset replayed math as the remaining 90-100%
    await typesetProgressively(eventsEl, (f) => setPct(90 + 10 * f));
    if (isStale(seq)) return;
    if (started) setPct(100);
    prog.classList.add("hidden");
    stream.classList.remove("loading"); // instant reveal — no fade, no replay
    stream.scrollTop = stream.scrollHeight; // jump straight to the end of the record
    // ...unless this is a tab coming back: put the reader where they left it,
    // unless its own run produced records while it was away (then the tail is
    // what they came back for)
    if (!tab.running && !tab.needsInput) restoreMemento(tab.id);
    finishOpen();
  } catch (e) {
    if (isStale(seq, e)) return; // a superseded open says nothing and paints nothing
    prog.classList.add("hidden");
    stream.classList.remove("loading");
    // same project open for write in another window: offer read-only instead of failing
    if (e && e.code === "project_open_conflict") {
      const held = describeHolder(e.owner);
      // The one case a user can undo without hunting for a dead process: the
      // window that claimed this project is PROVEN gone and the session it left
      // behind is still holding the lock. The host decides (only it can read the
      // kernel's answer); this page asks and reports, then reopens.
      if (seq !== openSeq) return;
      if (await provenOrphan(e.project)) {
        if (seq !== openSeq) return;
        const take = await askConfirm({
          title: "Take this project back?",
          text:
            "The window that held this project is gone, but its session still holds the lock.\n" +
            (held ? held + "\n" : "") +
            "Reclaim the project and open it?",
          ok: "Reclaim",
          cancel: "Leave it",
        });
        if (take && (await reclaimLock(e.project))) {
          if (seq !== openSeq) return;
          await openInTab(tab, base, readOnly, seq);
          return;
        }
        return;
      }
      if (seq !== openSeq) return;
      const wantReadOnly = await askConfirm({
        title: "Already open elsewhere",
        text:
          (held ? held + "\n" : "") +
          "This project is already open in another window.\n" +
          "Open it read-only? Read-only mode cannot run tasks.",
        ok: "Open read-only",
      });
      if (wantReadOnly) {
        if (seq !== openSeq) return;
        await openInTab(tab, base, true, seq); // retry without the write lock
        return;
      }
      return; // cancelled: keep the previous project as-is
    }
    notice("Failed to open project: " + e.message);
    // a network "Failed to fetch" usually means the remote session forward died
    console.error("[openProject] failed:", { api: state.apiBase, path, error: e && e.message });
  }
}

// The ending every open path shares (full replay and tail restore alike):
// re-scope the live stream to this project, then let the host continue a turn
// the log still has open. One place, so the orders cannot drift.
function finishOpen() {
  // the watermark (streamHighOffset) holds this project's tail after the replay,
  // so the stream resumes exactly there
  reconnectSSE();
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
// restores exactly the byte range the tab had painted (memento oldest..high),
// then lets SSE `?since=` fill whatever happened while it was away. One small
// /api/session read first, because a session that was REPLACED under the tab has
// no project open — then the full open path is the only honest answer.
const RESTORE_MAX_PAGES = 8;
const RESTORE_PAGE_BYTES = 256 * 1024;

async function restoreTabView(tab, base, seq: number): Promise<boolean> {
  const m = mementoOf(tab.id);
  if (!m || m.high === null || !tab.path) return false;
  let info;
  try {
    info = await apiFetch("/api/session", { base });
  } catch (e) {
    return false;
  }
  if (isStale(seq)) return false;
  const openPath = info && info.memory && typeof info.memory.path === "string" ? info.memory.path : "";
  if (!openPath || openPath !== (tab.projectKey || tab.path)) return false;

  const pages: any[][] = [];
  let cursor = m.high + 1; // before is exclusive; this includes the last record
  const target = typeof m.oldest === "number" ? m.oldest : cursor - 1;
  for (let i = 0; i < RESTORE_MAX_PAGES && cursor > target; i++) {
    let page;
    try {
      page = await apiFetch(
        `/api/history?before=${cursor}&limit=${RESTORE_PAGE_BYTES}&align=turn`,
        { base }
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
  }
  if (!pages.length) return false;

  const project = tab.projectKey || tab.path;
  clearStream();
  setProjectInfo({
    project,
    name: tab.name || project.split("/").pop() || project,
    workdir: m.workdir || dirOf(project),
    read_only: false, // the stream's status frame carries the real claim
  });
  hideWelcome();
  // pages were fetched backward; paint them oldest-first
  for (let i = pages.length - 1; i >= 0; i--) {
    for (const item of pages[i]) {
      if (isStale(seq)) return true; // a newer tab is taking the pane
      addEvent(item);
    }
  }
  setOlderPill(Math.max(0, cursor));
  stream.scrollTop = stream.scrollHeight;
  if (!tab.running && !tab.needsInput) restoreMemento(tab.id);
  finishOpen();
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
  if (same && opening && opening.id === tab.id) return opening.promise;
  const here = tab.projectKey || tab.path;
  if (same && !opening && currentProject && currentProject === here) return;

  const prev = activeTab();
  if (prev && prev.id !== tab.id) {
    saveMemento(prev.id, { older: olderRemaining, workdir: els.workspace.textContent || "" });
    if (prev.running) watchTab(prev);
  }
  const seq = supersedeOpen();
  // the stream that is open right now belongs to the tab we are leaving; letting
  // it live through the next replay is how one project's records landed in the
  // other tab's pane
  closeSSE();
  const changed = state.activeTabId !== tab.id;
  state.activeTabId = tab.id;
  if (changed) document.dispatchEvent(new CustomEvent("clutch:tab-state"));
  unwatchTab(tab.id);
  tab.needsInput = false;

  const run = (async () => {
    const base = await claimTab(tab);
    if (isStale(seq)) return;
    if (!base) {
      notice("this tab has no session — the backend is not running");
      return;
    }
    adoptBase(base);
    if (!tab.path) return; // a placeholder tab (createProject fills the path)
    // an already-opened tab only needs its painted range back; a first visit (or
    // a replaced session) takes the full open below
    if (await restoreTabView(tab, base, seq)) return;
    if (isStale(seq)) return;
    await openInTab(tab, base, readOnly, seq);
  })();
  const mine = { id: tab.id, promise: run };
  opening = mine;
  try {
    await run;
  } finally {
    if (opening === mine) opening = null;
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
  // the new project needs a session before it has a path: claim the tab's slot
  // first, then create the file on THAT session.
  const seq = supersedeOpen();
  closeSSE();
  const tab = ensureTab("", name);
  state.activeTabId = tab.id;
  document.dispatchEvent(new CustomEvent("clutch:tab-state"));
  const base = await claimTab(tab);
  if (isStale(seq)) return;
  if (!base) {
    notice("could not start a session for the new project");
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
    hideWelcome();
    finishOpen(); // new empty project: the watermark resets with the stream
  } catch (e) {
    if (isStale(seq)) return;
    // a create that hits another window's file is the same conflict as an open:
    // say who holds it, even though there is nothing to take back here (the
    // project already exists — this dialog was asking to MAKE one)
    const held = e && e.code === "project_open_conflict" ? describeHolder(e.owner) : "";
    notice("Failed to create project: " + e.message + (held ? " — " + held : ""));
    // a placeholder tab with no file is not a tab the user can use
    if (!tab.path) {
      const i = state.tabs.indexOf(tab);
      if (i >= 0) state.tabs.splice(i, 1);
      if (state.activeTabId === tab.id) state.activeTabId = null;
      await releaseTab(tab);
      document.dispatchEvent(new CustomEvent("clutch:tab-state"));
    }
  }
}

