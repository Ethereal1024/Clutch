// one tab = one session slot
//
// The host claims one supervisor session per tab id (ui/src/host/host-core.ts),
// so two tabs are two agent processes with their own open .clc and their own run
// lease. This module is the renderer's side of that fact: claim/release a tab's
// session, keep the per-tab view memento, and watch a BACKGROUND running tab
// just closely enough to paint its badge (run state, and whether a permission
// ask is waiting) without stealing focus.
//
// It deliberately imports nothing from project.ts / render-events.ts: those
// modules import it, and a cycle through the event pipeline is exactly the kind
// of load-order dependency this refactor removes.

import { state } from "./state";

export type Tab = (typeof state.tabs)[number];

const SLOT_EVENT = "clutch:tab-state";

export function activeTab(): Tab | null {
  if (!state.activeTabId) return null;
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

// The default slot ("" ; the window's pre-tabs session) is what a page with no
// tabs uses — the welcome screen, a File > Open before any tab exists.
export function activeSlotId(): string {
  return state.activeTabId || "";
}

export function tabForSlot(slotId: string): Tab | null {
  if (!slotId) return null;
  return state.tabs.find((t) => t.id === slotId) || null;
}

export function findTabByPath(path: string): Tab | null {
  // the picker's spelling and the host's canonical path can differ (relative,
  // a symlink); either one names the same resource
  return state.tabs.find((t) => t.path === path || t.projectKey === path) || null;
}

export function ensureTab(path: string, name = ""): Tab {
  const existing = path ? findTabByPath(path) : null;
  if (existing) return existing;
  const tab: Tab = {
    id: "tab-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    path,
    name: name || (path ? path.split("/").pop() || path : ""),
    dirty: false,
    base: null,
    running: false,
    needsInput: false,
  };
  state.tabs.push(tab);
  return tab;
}

export function announceTabState() {
  document.dispatchEvent(new CustomEvent(SLOT_EVENT));
}

// ---- session claim / release -------------------------------------------------

// Always ask the host, even when this tab already has a base: after a tunnel
// hop the old forward is dead and the host is the one that can re-bind it to the
// same far-side session (host-core's heartbeat-first rebind).
export async function claimTab(tab: Tab): Promise<string | null> {
  if (!tab) return null;
  if (!(window.clutchApi && window.clutchApi.baseUrl)) {
    // plain-browser debugging: no bridge at all
    return tab.base || null;
  }
  try {
    const base = await window.clutchApi.baseUrl(tab.id);
    tab.base = base ? String(base).replace(/\/+$/, "") : null;
    return tab.base;
  } catch (e) {
    console.warn("[slot] claim failed", tab.id, e);
    tab.base = null;
    return null;
  }
}

export async function releaseTab(tab: Tab): Promise<void> {
  if (!tab) return;
  unwatchTab(tab.id);
  tab.running = false;
  tab.needsInput = false;
  if (window.clutchApi && window.clutchApi.releaseSession) {
    try {
      await window.clutchApi.releaseSession(tab.id);
    } catch (e) {
      /* the session may already be gone; the tab is going away either way */
    }
  }
  tab.base = null;
}

// Point the ACTIVE projection at a tab's session without opening a stream: the
// caller's open connects at the right moment, with the right project and
// watermark. (switchBackend is for a session that MOVED under a page already
// showing it.) The window's sessionStorage key is the active tab's base.
export function adoptBase(base: string | null) {
  const clean = base ? String(base).replace(/\/+$/, "") : "";
  state.apiBase = clean || null;
  try {
    if (clean) sessionStorage.setItem("clutch_api_url", clean);
  } catch (e) {
    /* the page may forbid storage; the in-memory base is what matters */
  }
  document.dispatchEvent(new CustomEvent("clutch:backend-changed", { detail: state.apiBase }));
}

// ---- per-tab view memento ----------------------------------------------------

// What a tab looked like when it was left. The events themselves are durable in
// its .clc, so activation replays them through the same /api/project/open path
// the first open uses; this only puts the reader back where they were.
type Memento = {
  scroll: number;
  follow: boolean;
  high: number | null;   // newest painted byte offset (start of that record)
  oldest: number | null; // oldest painted byte offset — the range to rebuild
  older: number;         // bytes still unloaded before `oldest`
  workdir: string;
};

const mementos = new Map<string, Memento>();

// A tab id is persisted with the working set, so the painted range can be too:
// after a PAGE reload the host still holds the same session (same project
// open), and the first activation can restore the tail instead of re-streaming
// the whole file. A memento from another session is harmless: the restore
// checks /api/session's project before using it, and falls back to a full open.
const MEMENTO_KEY = (slotId: string) => "clutch_view:" + slotId;

function readStoredMemento(slotId: string): Memento | null {
  try {
    const raw = localStorage.getItem(MEMENTO_KEY(slotId));
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object" || typeof m.high !== "number") return null;
    return {
      scroll: typeof m.scroll === "number" ? m.scroll : 0,
      follow: !!m.follow,
      high: typeof m.high === "number" ? m.high : null,
      oldest: typeof m.oldest === "number" ? m.oldest : null,
      older: typeof m.older === "number" ? m.older : 0,
      workdir: typeof m.workdir === "string" ? m.workdir : "",
    };
  } catch (e) {
    return null;
  }
}

export function saveMemento(
  slotId: string,
  extra: { older?: number; workdir?: string } = {}
) {
  if (!slotId) return;
  const stream = document.getElementById("stream");
  const m: Memento = {
    scroll: stream ? stream.scrollTop : 0,
    follow: !!state.followTail,
    high: state.streamHighOffset,
    oldest: state.oldestOffset,
    older: typeof extra.older === "number" ? extra.older : 0,
    workdir: extra.workdir || "",
  };
  mementos.set(slotId, m);
  try {
    localStorage.setItem(MEMENTO_KEY(slotId), JSON.stringify(m));
  } catch (e) {
    /* storage is a convenience: the in-memory copy still works this life */
  }
}

export function mementoOf(slotId: string): Memento | null {
  return mementos.get(slotId) || readStoredMemento(slotId);
}

export function forgetMemento(slotId: string) {
  mementos.delete(slotId);
  try {
    localStorage.removeItem(MEMENTO_KEY(slotId));
  } catch (e) {
    /* nothing to forget without storage */
  }
}

export function restoreMemento(slotId: string) {
  const m = mementos.get(slotId);
  const stream = document.getElementById("stream");
  if (!m || !stream) return false;
  state.followTail = m.follow;
  // after the replay the pane is at its end; a reader who had scrolled up goes
  // back to where they were, a tail-follower stays on the tail
  stream.scrollTop = m.follow ? stream.scrollHeight : m.scroll;
  return true;
}

// ---- background tab watcher --------------------------------------------------

// A background RUNNING tab needs exactly three facts while it is away: is the run
// still going, did it end, and is it waiting on a permission answer. A dedicated
// live-only stream per such tab (replay=0: no history) gives all three without
// touching the visible stream, which belongs to the active tab. When the tab is
// activated the watcher is closed and the real stream re-delivers the pending ask.
const watchers = new Map<string, EventSource>();

export function watchTab(tab: Tab) {
  if (!tab || !tab.running || !tab.base || !tab.path) return;
  if (watchers.has(tab.id)) return;
  let es: EventSource;
  try {
    const qs = new URLSearchParams();
    qs.set("project", tab.projectKey || tab.path);
    qs.set("replay", "0"); // live facts only: the durable gap is replayed on activation
    es = new EventSource(tab.base + "/api/events?" + qs.toString());
  } catch (e) {
    return;
  }
  es.onmessage = (m) => {
    let ev: any;
    try {
      ev = JSON.parse(m.data);
    } catch (e) {
      return;
    }
    let changed = false;
    if (ev && ev.type === "state_update" && ev.key === "execution_status") {
      const running = ev.value === "running" || ev.value === "waiting";
      if (tab.running !== running) {
        tab.running = running;
        changed = true;
      }
    } else if (ev && ev.type === "permission_request") {
      if (!tab.needsInput) {
        tab.needsInput = true;
        changed = true;
      }
    } else if (ev && ev.type === "final") {
      if (tab.running || tab.needsInput) {
        tab.running = false;
        tab.needsInput = false;
        changed = true;
      }
      unwatchTab(tab.id);
    }
    if (changed) announceTabState();
  };
  es.onerror = () => {
    // EventSource retries on its own; a session that is really gone is re-asked
    // on activation (claimTab), which is the only place that can rebind it.
  };
  watchers.set(tab.id, es);
}

// The slot's session moved (a tunnel hop re-bound it): point the badge watcher
// at the new forward. A dead EventSource would otherwise retry the old port in
// silence for as long as the tab stays in the background.
export function rewatchTab(tab: Tab) {
  if (!tab) return;
  unwatchTab(tab.id);
  if (!tab.running) return;
  watchTab(tab);
}

export function unwatchTab(slotId: string) {
  const es = watchers.get(slotId);
  if (!es) return;
  watchers.delete(slotId);
  try {
    es.close();
  } catch (e) {
    /* already closed */
  }
}

export function unwatchAll() {
  for (const id of [...watchers.keys()]) unwatchTab(id);
}

// ---- run-state badge updates -------------------------------------------------

// Called from the run:event route for a tab that is not visible: only the badge
// moves, the transcript is replayed when the reader comes back.
export function noteTabEvent(slotId: string, ev: any) {
  const tab = tabForSlot(slotId);
  if (!tab || !ev || typeof ev !== "object") return false; // consumed: background
  let changed = false;
  if (ev.type === "state_update" && ev.key === "execution_status") {
    const running = ev.value === "running" || ev.value === "waiting";
    if (tab.running !== running) {
      tab.running = running;
      changed = true;
    }
  } else if (ev.type === "permission_request") {
    if (!tab.needsInput) {
      tab.needsInput = true;
      changed = true;
    }
  } else if (ev.type === "final") {
    if (tab.running || tab.needsInput) {
      tab.running = false;
      tab.needsInput = false;
      changed = true;
    }
  }
  if (changed) announceTabState();
  return true;
}

export function setTabRunning(slotId: string, running: boolean) {
  const tab = tabForSlot(slotId);
  if (!tab) return;
  if (tab.running === running) return;
  tab.running = running;
  announceTabState();
}
