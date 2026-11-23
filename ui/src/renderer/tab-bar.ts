// tab bar — one tab per open project, and one SESSION per tab
//
// The id of a tab is also its session slot (ui/src/renderer/slots.ts): clicking
// a tab asks the host for that slot's session, adopts its base and replays its
// .clc. Two tabs therefore run in parallel, exactly like two windows did before
// the tabs existed.
//
// Persistence stores the visual working set (id/path/name) and the machine
// each file lives on. A base is not persisted: after a reload the host still
// holds the session, and the slot's own claim re-attaches to it (no second
// spawn). The machine IS persisted, because the host's slot table is not: a
// remote tab that forgot its machine claimed a LOCAL session after a quit, and
// the local host answered "not a .clc project file" for a file it does not have
// (slots.ts, which records the machine from what the host claimed).
//
// Data flow:
//   user opens project → project.ts activateTab → setProjectInfo
//     → clutch:project-info → tab-bar.ts tabOpen (updates/pins the tab)
//   user clicks tab → tabActivate → project.ts activateTab (claim + replay)

import { state } from "./state";
import { busy } from "./stream-view";
import { askConfirm, corruptRecord } from "./settings";
import { asMachine, ensureTab, findTabByPath, forgetDomCache, forgetMemento, onTabsPersist, releaseTab, unwatchTab } from "./slots";
import { execute } from "./commands";
import { activateTab, showWelcome } from "./project";

// ---- persistence ----

const LS_KEY = "clutch_tabs";

function saveTabs(): void {
  try {
    // runtime fields (base/running/needsInput/projectKey) belong to THIS page
    // life: a session URL from the last life names a forward that is gone.
    const tabs = state.tabs.map((t) => ({
      id: t.id,
      path: t.path,
      name: t.name,
      // undefined (never recorded) is dropped by JSON.stringify: the next load
      // reads it back as undefined, which is exactly "still unknown"
      machine: t.machine,
    }));
    // the tab the user is looking at is part of the working set: boot.ts reopens
    // it (claiming its own slot) instead of stopping at the welcome page
    localStorage.setItem(LS_KEY, JSON.stringify({ tabs, activeTabId: state.activeTabId || "" }));
  } catch (e) {
    /* storage off or full: the working set is this life's, the next launch opens
       with none — nothing to report, there is no user action behind it */
  }
}

function loadTabs(): void {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch (e) {
    return; // no storage at all: no remembered tabs, and nothing to say about it
  }
  if (!raw) return;
  let data: any;
  try {
    data = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("it is not a tab store");
  } catch (e) {
    // A store that will not parse is not "no tabs": the tabs the user had are in
    // those bytes, and the first tab-state save would write an empty strip over
    // them. Reported and kept aside (corruptRecord), then the boot opens on the
    // welcome page — the honest view when the working set cannot be read.
    corruptRecord("remembered tabs", LS_KEY, e);
    return;
  }
  if (Array.isArray(data.tabs)) {
    // One slot per id and one tab per project: a duplicate id would make two
    // tabs share ONE session (both showing whatever that session has open),
    // and a duplicate path would put two writers on one .clc. Old stores could
    // carry either; drop the later copy instead of repairing it ambiguously.
    const seenId = new Set<string>();
    const seenPath = new Set<string>();
    state.tabs = data.tabs
      .filter((t) => t && typeof t.id === "string" && typeof t.path === "string")
      .filter((t) => {
        if (!t.id || seenId.has(t.id) || !t.path || seenPath.has(t.path)) return false;
        seenId.add(t.id);
        seenPath.add(t.path);
        return true;
      })
      .map((t) => ({
        id: t.id,
        path: t.path,
        name: typeof t.name === "string" ? t.name : t.path.split("/").pop() || t.path,
        // undefined for a store written before the field existed: unknown, and
        // the claim then follows whatever the window is on (with the open's
        // own self-heal, project.ts, as the backstop)
        machine: asMachine(t.machine),
        base: null,
        running: false,
        needsInput: false,
      }));
  }
  // The remembered tab is a HINT, not a promise: boot.ts claims its slot and
  // falls back to the welcome page when that slot has no session. An id no
  // restored tab carries (closed elsewhere, stale store) names nothing.
  const active = typeof data.activeTabId === "string" ? data.activeTabId : "";
  state.activeTabId = state.tabs.some((t) => t.id === active) ? active : null;
}

// ---- MRU and the closed-tab stack --------------------------------------------
// VS Code's Ctrl+Tab is "the editor I used before this one", not "the next tab
// in the strip"; the strip order answer is what Ctrl+Shift+Tab keeps.
let mru: string[] = [];
let closedStack: Array<{ path: string; name: string }> = [];
let draggingId: string | null = null;

function noteMru(id: string) {
  mru = [id, ...mru.filter((x) => x !== id)];
  if (mru.length > 50) mru.length = 50;
}

export function closedTabCount(): number {
  return closedStack.length;
}

// ---- rendering ----

/** The tab's status, or null when it has none. ONE value, because a tab can only
 *  ever report one thing: a tab waiting for the user outranks a tab that is
 *  merely working — "waiting" is itself a running execution (slots.ts maps
 *  execution_status "waiting" to running), so an asking tab is both, and of the
 *  two the reader can only act on one. The strip's dot and the switcher's glyph
 *  (titlebar.ts) both read this, so they cannot disagree, and the strip can
 *  never paint two marks on one tab. */
export function tabMarkState(tab: { running?: boolean; needsInput?: boolean }): "ask" | "run" | null {
  if (tab.needsInput) return "ask";
  if (tab.running) return "run";
  return null;
}

export function renderTabBar(): void {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  const newBtn = document.getElementById("tab-new-btn");
  // remove existing tab elements, keep the new-tab button
  Array.from(bar.querySelectorAll(".doc-tab")).forEach((el) => el.remove());
  // show/hide the bar itself depending on whether any tabs exist
  bar.classList.toggle("hidden", state.tabs.length === 0);

  for (const tab of state.tabs) {
    const el = document.createElement("div");
    const mark = tabMarkState(tab);
    // the one state that changes the tab itself is "active" (lifted). "running"
    // only lifts the text; "waiting for an answer" is the amber dot below.
    el.className =
      "doc-tab" +
      (tab.id === state.activeTabId ? " active" : "") +
      (tab.running ? " running" : "");
    el.dataset.tabId = tab.id;
    el.tabIndex = 0; // arrow keys walk the strip (see the keydown below)
    el.draggable = true;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", tab.id === state.activeTabId ? "true" : "false");
    // the words follow the same one state as the dot: an asking tab says what
    // the reader can act on, not "running and waiting"
    el.title = tab.path + (mark === "ask" ? "\nwaiting for your answer" : mark === "run" ? "\nrunning" : "");
    el.setAttribute(
      "aria-label",
      tab.name + (mark === "ask" ? " — waiting for input" : mark === "run" ? " — running" : "")
    );

    const label = document.createElement("span");
    label.className = "doc-tab-label";
    label.textContent = tab.name;
    el.appendChild(label);

    // one dot, one build path: .doc-tab-dot is the box, the state class adds
    // colour and motion only (style.css)
    if (mark) {
      const dot = document.createElement("span");
      dot.className = "doc-tab-dot doc-tab-dot-" + mark;
      dot.setAttribute("aria-hidden", "true");
      el.appendChild(dot);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "doc-tab-close";
    closeBtn.setAttribute("aria-label", `Close ${tab.name}`);
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      tabClose(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => tabActivate(tab.id));
    // middle-click closes, like every mature tab strip
    el.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      tabClose(tab.id);
    });
    // arrow keys move through the strip (focus follows the activated tab)
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const idx = state.tabs.findIndex((t) => t.id === tab.id);
      if (idx < 0) return;
      const next = state.tabs[(idx + (e.key === "ArrowRight" ? 1 : -1) + state.tabs.length) % state.tabs.length];
      if (next) tabActivate(next.id);
    });
    // drag to reorder: the strip order is a user preference, the MRU and the
    // sessions are not touched by it
    el.addEventListener("dragstart", (e) => {
      draggingId = tab.id;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", tab.id); } catch (err) {}
      }
    });
    el.addEventListener("dragover", (e) => {
      if (draggingId && draggingId !== tab.id) e.preventDefault();
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = state.tabs.findIndex((t) => t.id === draggingId);
      const to = state.tabs.findIndex((t) => t.id === tab.id);
      draggingId = null;
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = state.tabs.splice(from, 1);
      state.tabs.splice(to, 0, moved);
      saveTabs();
      renderTabBar();
    });
    el.addEventListener("dragend", () => {
      draggingId = null;
    });

    if (newBtn) bar.insertBefore(el, newBtn);
    else bar.appendChild(el);
  }

  // the window title names what the window is showing (and whether its own run
  // is in flight), the way every editor's title does
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  document.title = active
    ? `${active.running ? "● " : ""}${active.name} — Clutch`
    : "Clutch";
}

// ---- public API ----

/**
 * Pin the project the host just opened to its tab (called from setProjectInfo).
 * Pure record bookkeeping: the open itself is project.ts's job.
 */
export function tabOpen(path: string, name: string): void {
  if (!path) return;
  let tab = findTabByPath(path);
  if (!tab) {
    tab = ensureTab(path, name);
  } else if (name) {
    tab.name = name; // the host's canonical name wins
  }
  tab.path = path; // canonical path from the host's meta
  tab.projectKey = path;
  // the tab the host opened is the tab the user is looking at
  state.activeTabId = tab.id;
  noteMru(tab.id);
  renderTabBar();
  saveTabs();
}

/** Close a tab: stop-and-confirm when its own run is in flight, release always. */
export async function tabClose(id: string): Promise<void> {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  const running = !!tab.running || (tab.id === state.activeTabId && busy);
  if (running) {
    const yes = await askConfirm({
      title: "Stop this task and close the tab?",
      text:
        `${tab.name} is still running.\n` +
        "Closing its tab stops the task and writes an aborted ending to the project log.",
      ok: "Stop and close",
      cancel: "Keep it",
    });
    if (!yes) return;
    if (window.clutchRun && window.clutchRun.stop) {
      try {
        await window.clutchRun.stop(tab.id);
      } catch (e) {
        /* the session may already be gone; closing is still what was asked */
      }
    }
  }
  unwatchTab(id);
  await releaseTab(tab);
  forgetMemento(id);
  forgetDomCache(id);
  state.tabs.splice(idx, 1);
  if (tab.path) {
    closedStack.push({ path: tab.path, name: tab.name });
    if (closedStack.length > 20) closedStack.shift();
  }
  mru = mru.filter((x) => x !== id);
  const wasActive = state.activeTabId === id;
  if (wasActive) state.activeTabId = null;
  renderTabBar();
  saveTabs();
  if (!wasActive) return;
  const next = state.tabs[idx] ?? state.tabs[idx - 1] ?? null;
  if (next) {
    await tabActivate(next.id);
  } else {
    showWelcome();
  }
}

/** Switch to `id`: claim its own session, replay its log, restore its view. */
export async function tabActivate(id: string): Promise<void> {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  noteMru(tab.id);
  await activateTab(tab);
  // the tab last looked at is the one a reload reopens
  saveTabs();
}

// Window > Close Other Tabs / Close All Tabs. Each running tab still asks its
// own stop-and-close question; a tab that refuses stops the batch there.
export async function tabCloseOthers(): Promise<void> {
  const keep = state.activeTabId;
  for (const t of [...state.tabs]) {
    if (keep && t.id === keep) continue;
    await tabClose(t.id);
  }
}

export async function tabCloseAll(): Promise<void> {
  for (const t of [...state.tabs]) await tabClose(t.id);
}

// Ctrl+Shift+T: bring back the last closed project. Its slot is claimed fresh
// (or re-bound by the host) and its .clc replays — nothing is lost with the tab.
export async function tabReopen(): Promise<void> {
  const last = closedStack.pop();
  if (!last) return;
  const tab = ensureTab(last.path, last.name);
  await tabActivate(tab.id);
}

// ---- keyboard navigation ----
// Ctrl+Tab → next tab, Ctrl+Shift+Tab → previous tab

document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.key !== "Tab" || state.tabs.length < 2) return;
  e.preventDefault();
  // Ctrl+Tab walks the MRU list (the editor you used before this one); the
  // directional answer, Ctrl+Shift+Tab, walks the strip order.
  if (!e.shiftKey) {
    const prior = mru.find((id) => id !== state.activeTabId && state.tabs.some((t) => t.id === id));
    if (prior) tabActivate(prior);
    return;
  }
  const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
  if (idx < 0) return;
  const len = state.tabs.length;
  const next = state.tabs[(idx - 1 + len) % len];
  tabActivate(next.id);
});

// ---- new-tab button ----
// Opens the file picker so the user can open (or create) a project in a new tab.
// Triggers the same action as #open-project-btn — the file picker is registered
// in fs-browser.ts and is the right entry point; we avoid importing fs-browser
// here to keep the dependency graph acyclic.

document.getElementById("tab-new-btn")?.addEventListener("click", () => {
  execute("tab-new");
});

// ---- respond to project opens ----
// setProjectInfo (project.ts) dispatches clutch:project-info; we pin/activate
// the matching tab so the tab bar always reflects the live project.

document.addEventListener("clutch:project-info", (ev) => {
  const { project, name } = (ev as CustomEvent).detail ?? {};
  if (project) tabOpen(project, name || project.split("/").pop() || project);
});

// a background watcher (slots.ts) moved a tab's badge: repaint only the strip
document.addEventListener("clutch:tab-state", () => renderTabBar());

// ---- init ----

// a machine learned by a claim (slots.ts noteTabMachine) is part of the working
// set: it is written with the rest of it, so the next boot knows where each
// tab's file is before anything is claimed
onTabsPersist(saveTabs);
loadTabs();
renderTabBar();
