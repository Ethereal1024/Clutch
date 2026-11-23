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

import { paneShowsTab } from "./pane";
import { state } from "./state";
import type { Machine } from "./state";

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

// ---- which machine a tab's .clc lives on -------------------------------------
//
// The host keeps a session per slot, and WHICH MACHINE that session runs on is
// decided at claim time (host-core.ts claimSlotBackend): a slot pinned to
// "local" always gets this machine's supervisor, a live tunnel gets the far
// side, and — the case this section exists for — no tunnel at all falls back to
// a LOCAL session. A local session cannot open a file that lives on another
// machine: it answers "not a .clc project file" (agent/api/project.py), which is
// what a restored remote tab used to hit right after a quit (the slot table in
// the host is memory, the tab store on disk is not).
//
// So a tab remembers its machine, it travels with the working set
// (tab-bar.ts), and every claim either serves that machine or refuses — it
// never silently lands the tab somewhere the file is not.

export function machineLabel(m: Machine | null | undefined): string {
  if (!m) return "this machine";
  return m.user ? `${m.user}@${m.host}:${m.port}` : `${m.host}:${m.port}`;
}

// A machine as the store or an IPC answer spells it, or undefined when it is not
// one at all (a store from before the field, a hand-edited value).
export function asMachine(v: any): Machine | null | undefined {
  if (v === undefined) return undefined; // never recorded: unknown, not "local"
  if (v === null || v === false) return null; // recorded as this machine
  if (typeof v !== "object" || !v.host) return undefined;
  return {
    host: String(v.host),
    user: String(v.user || ""),
    port: String(v.port === undefined || v.port === null || v.port === "" ? 22 : v.port),
  };
}

// undefined/null/object are three DIFFERENT answers ("unknown", "here", "there"),
// so this compares all three rather than truthiness.
export function sameMachine(a: Machine | null | undefined, b: Machine | null | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  return a.host === b.host && a.user === b.user && String(a.port) === String(b.port);
}

// The host's answer for a live hop, as a machine (null when the hop does not
// say, or when there is no hop).
function tunnelTarget(ts: any): Machine | null {
  const t = ts && ts.target;
  if (!t || !t.host) return null;
  return { host: String(t.host), user: String(t.user || ""), port: String(t.port || 22) };
}

async function tunnelNow(): Promise<{ active: boolean; target: Machine | null }> {
  if (!(window.clutchTunnel && window.clutchTunnel.status)) return { active: false, target: null };
  try {
    const s = await window.clutchTunnel.status();
    return { active: !!(s && s.active), target: tunnelTarget(s) };
  } catch (e) {
    return { active: false, target: null }; // an unanswerable question is not a live hop
  }
}

// Pin a slot's NEXT claim: { kind: "local" } forces this machine even while a
// tunnel is up, { kind: "tunnel" } says this slot's file lives on a machine (the
// hop that serves it is up — the claim follows the live tunnel, and host-core
// reads the pin as the promise that a local session is NOT an acceptable answer),
// null clears the pin (follow the live tunnel, either way). Only the next claim
// moves — a session already running is not torn down by this.
async function pinSlot(slotId: string, target: any): Promise<void> {
  if (!(window.clutchApi && window.clutchApi.setSlotTarget)) return;
  try {
    await window.clutchApi.setSlotTarget(slotId, target);
  } catch (e) {
    /* no bridge / an older host: the claim then falls back to the default */
  }
}

// The machine this window was last working on: the live picker's first entry
// (upsertConn unshifts, so it is the most recent), else the flat clutch_ssh_*
// triple an older build wrote.
export function rememberedMachine(): Machine | null {
  try {
    const list = JSON.parse(localStorage.getItem("clutch_ssh_connections") || "[]");
    const first = Array.isArray(list) ? list.find((c) => c && c.host) : null;
    if (first) return asMachine(first) as Machine;
  } catch (e) {
    /* a broken list is not a machine */
  }
  try {
    const host = localStorage.getItem("clutch_ssh_host");
    if (!host) return null;
    return {
      host,
      user: localStorage.getItem("clutch_ssh_user") || "",
      port: String(localStorage.getItem("clutch_ssh_port") || 22),
    };
  } catch (e) {
    return null;
  }
}

// Is the hop that serves this tab's file ALREADY up, so that claiming its slot
// costs no dial? Synchronous on purpose: the cached-view decision (project.ts
// paintCachedView) runs BEFORE anything is awaited — that is the whole point of
// it — so it cannot ask the host.
//
// Two facts, both of which a dial would change: the tab HAS a base from this life
// (it was claimed here, so the hop was serving it), and this window is on that
// machine (`clutch_ssh_connected`, which connectTabMachine sets on a landing and
// a Disconnect or a move to another host clears — the same standing intent
// prepareTabMachine reads). A tab that names no machine never dials at all.
export function hopUpFor(tab: Tab): boolean {
  if (!tab || !tab.machine) return true;
  if (!tab.base) return false; // never claimed in this life: that claim may dial
  try {
    if (localStorage.getItem("clutch_ssh_connected") !== "1") return false;
  } catch (e) {
    return false; // a page that forbids storage cannot promise a hop is up
  }
  return sameMachine(rememberedMachine(), tab.machine);
}

let dialing = false;

// Dial a machine WITHOUT asking anything. This is a reconnect, not a new
// connection: the engine redials with the secret the last connect cached
// (tunnel-connect.ts getSshSecret) or with the key/agent. A password prompt
// cannot be answered in the middle of a boot, so a host that will not
// authenticate this way is reported to the user instead — the picker's own
// Connect is the door that can ask for a password.
//
// This is the FALLBACK: the app hands in the connect flow's own attempt below,
// which reports its stages into the tab's loading bar and can ask for the
// password itself. Nothing here runs when that door is wired (boot.ts).
export async function dialMachine(m: Machine | null): Promise<boolean> {
  if (!m || dialing) return false;
  if (!(window.clutchTunnel && window.clutchTunnel.connect)) return false;
  dialing = true;
  try {
    const res = await window.clutchTunnel.connect({
      host: m.host,
      user: m.user,
      port: Number(m.port) || 22,
    });
    return !!(res && res.ok);
  } catch (e) {
    return false;
  } finally {
    dialing = false;
  }
}

// ---- the hop a tab's file needs ----------------------------------------------
//
// The dial above is the ENGINE's half. The half the user sees — the stages, the
// upload's rate and ETA, the password dialog when the cached secret is refused,
// and the bar it all reports into — belongs to the connect flow, and this module
// may not import it (project → slots and conn-flow → fs-browser → project are
// chains already; a back-edge here would close the cycle). boot.ts, the one
// module that sees both, hands the attempt in.
let autoConnectDoor: ((m: Machine) => Promise<string>) | null = null;
export function onTabAutoConnect(fn) {
  autoConnectDoor = fn;
}

// One attempt per machine at a time: two tabs of the same host claimed together
// (a double click, a boot restoring both) are ONE dial — the second joins the
// first instead of being refused because the wire is busy. A different machine
// is not joined: the tunnel carries one host at a time and prepareTabMachine has
// already refused that case.
let autoDial: { m: Machine; p: Promise<string> } | null = null;

// "" when the hop is up, or the sentence to show on the tab (why it is not).
function autoConnect(m: Machine): Promise<string> {
  if (!autoConnectDoor) {
    return dialMachine(m).then((ok) =>
      ok ? "" : `could not reconnect to ${machineLabel(m)} — open the file picker and press Connect`
    );
  }
  if (autoDial && sameMachine(autoDial.m, m)) return autoDial.p;
  const p = autoConnectDoor(m).finally(() => {
    if (autoDial && autoDial.p === p) autoDial = null;
  });
  autoDial = { m, p };
  return p;
}

// May this tab's claim happen at all, and what must be pinned first? Returns ""
// when it may, or the reason it must not (the tab then has no session and the
// user is told which machine the file is on).
async function prepareTabMachine(tab: Tab): Promise<string> {
  const m = tab.machine;
  if (m === null) {
    // this machine's own file: pin it, so a tunnel another tab opened cannot
    // route this claim to a host that has never heard of the path
    await pinSlot(tab.id, { kind: "local" });
    return "";
  }
  if (!m) return ""; // unknown (a store from before the field): claim normally
  const now = await tunnelNow();
  if (now.active && sameMachine(now.target, m)) {
    // the hop IS this machine, and the pin SAYS so: host-core takes a
    // {kind:"tunnel"} pin as "this slot's file lives on a machine", so a hop that
    // stops serving between here and the claim is answered with a failure the
    // renderer can name — never with a local session, which would open the path
    // on the wrong machine and answer "not a .clc project file"
    await pinSlot(tab.id, { kind: "tunnel" });
    return "";
  }
  const name = tab.name || tab.path;
  if (now.active) {
    // one tunnel at a time: moving it would take every OTHER remote tab's
    // session with it, so this is the user's decision, not a side effect
    return (
      `${name} lives on ${machineLabel(m)}, but this window is on ` +
      `${now.target ? machineLabel(now.target) : "another machine"} — ` +
      `connect to ${machineLabel(m)} in the file picker to open it`
    );
  }
  // The tab's OWN record is the intent, and it is the strong one: it names a file
  // on a machine, the file cannot open anywhere else, and the connect that put it
  // there cached the secret it needed (settings mirror ssh_secrets). The
  // window-wide flag (clutch_ssh_connected) is deliberately NOT a gate: it is
  // cleared by a move to another host and by a Disconnect, and gating on it left a
  // tab the user had just asked for waiting for a Connect press somewhere else —
  // the reported "a cached tab was already connected, why must I connect again".
  // None of this is behind the user's back any more either: the attempt reports
  // into the tab's own loading bar (conn-flow connectTabMachine), which is what
  // makes the hop a STEP of opening the tab.
  const why = await autoConnect(m);
  if (why) return `${name} lives on ${machineLabel(m)} — ${why}`;
  // same promise as above, now that the hop is up: the file is on that machine,
  // so no claim of this slot may land on this one
  await pinSlot(tab.id, { kind: "tunnel" });
  return "";
}

// What the HOST actually claimed — never a guess from the path. "local" is this
// machine; "tunnel" is the far side of the hop that is up.
//
// Called once the project has OPENED on that claim (project.ts openInTab), not
// when the slot is claimed: a claim is only a guess about where a path lives
// until the host has resolved it, and recording "local" for a tab whose file is
// on a remote machine is exactly what would disarm the one-time diagnosis
// (project.ts machineMismatch) that repairs such a tab.
export async function noteTabMachine(tab: Tab): Promise<void> {
  if (!(window.clutchApi && window.clutchApi.slotStatus)) return;
  let st: any;
  try {
    st = await window.clutchApi.slotStatus(tab.id);
  } catch (e) {
    return;
  }
  if (!st || !st.claimed) return;
  let next: Machine | null | undefined = tab.machine;
  if (st.kind === "local") next = null;
  else if (st.kind === "tunnel") {
    const now = await tunnelNow();
    if (now.target) next = now.target;
  }
  if (sameMachine(tab.machine, next)) return;
  tab.machine = next;
  // the machine is part of the working set: tab-bar.ts saved it (onTabsPersist)
  // so the NEXT boot knows where this tab's file is before it claims anything
  announceTabState();
  if (persistTabs) {
    try {
      persistTabs();
    } catch (e) {
      /* storage is a convenience: this life still knows the machine */
    }
  }
}

// tab-bar.ts owns the `clutch_tabs` store; it registers its save here so a
// machine learned by a claim is persisted with the rest of the working set.
let persistTabs: (() => void) | null = null;
export function onTabsPersist(cb: () => void) {
  persistTabs = cb;
}

// ---- session claim / release -------------------------------------------------

// The one answer that cannot be acted on: a session on THIS machine opening a
// file that lives on another one. agent/api/project.py answers it "not a .clc
// project file", which names neither the machine nor the way out — and because
// the tab already records its machine, project.ts machineMismatch (which repairs
// tabs that never learned one) cannot help. So the claim is what refuses.
function noSessionThere(tab: Tab): string {
  return (
    `${tab.name || tab.path} lives on ${machineLabel(tab.machine)} — ` +
    `no session there right now: connect to it in the file picker to open it`
  );
}

// Is the claim the host just made LOCAL over a file this machine does not have?
// Asked, not assumed: the kind is the claim the host actually holds (host-core
// slotStatus), and a directory that IS here is a real copy on this machine — a
// perfectly good place to open the tab — so only an absent one is a mismatch.
async function localClaimHasNoFile(tab: Tab): Promise<boolean> {
  if (!(window.clutchApi && window.clutchApi.slotStatus)) return false;
  let st: any;
  try {
    st = await window.clutchApi.slotStatus(tab.id);
  } catch (e) {
    return false;
  }
  if (!st || st.kind !== "local") return false; // a tunnel claim is the right machine
  const dir = String(tab.path || "").replace(/\/[^/]*$/, "");
  if (!dir) return false;
  try {
    const r = await fetch(tab.base + "/api/fs/stat?path=" + encodeURIComponent(dir));
    if (!r.ok) return false;
    const body = await r.json();
    return !!(body && body.type === "none");
  } catch (e) {
    return false; // a host that will not answer is not proof of a wrong machine
  }
}

// Always ask the host, even when this tab already has a base: after a tunnel
// hop the old forward is dead and the host is the one that can re-bind it to the
// same far-side session (host-core's heartbeat-first rebind).
export async function claimTab(tab: Tab): Promise<string | null> {
  if (!tab) return null;
  if (!(window.clutchApi && window.clutchApi.baseUrl)) {
    // plain-browser debugging: no bridge at all
    return tab.base || null;
  }
  // A tab whose file lives elsewhere is never claimed onto a machine that does
  // not have it: the host would fall back to a local session and the open would
  // fail with "not a .clc project file" (see this section's header).
  const why = await prepareTabMachine(tab);
  if (why) {
    tab.base = null;
    tab.unreachable = why;
    return null;
  }
  try {
    const base = await window.clutchApi.baseUrl(tab.id);
    tab.base = base ? String(base).replace(/\/+$/, "") : null;
    if (!tab.base) {
      // No session at all (a hop that is up but serving nothing, a supervisor
      // that would not start one). For a tab whose file is on a machine that is
      // worth saying WITH the machine, so the panel can offer the door that
      // dials it — "the backend is not running" over a remote file is a dead end.
      if (tab.machine) tab.unreachable = noSessionThere(tab);
      return null;
    }
    tab.unreachable = null;
    // A local session was handed to a tab whose file is on a machine (the host
    // had no hop at claim time, or it gave up on it). Opening it there can only
    // answer "not a .clc project file", so the claim is refused and the wrong
    // session released: the pane then names the machine and the door to it.
    if (tab.machine && (await localClaimHasNoFile(tab))) {
      await releaseTab(tab);
      tab.unreachable = noSessionThere(tab);
      return null;
    }
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

// ---- per-tab view memento & DOM cache ----------------------------------------

// What a tab looked like when it was left. The events themselves are durable in
// its .clc, so activation replays them through the same /api/project/open path
// the first open uses; this only puts the reader back where they were.
//
// The place is `scroll` — the pixel the pane stood at — and that is the whole
// answer to "where was I". A tab comes back showing the part of the transcript it
// was showing when it was switched out, whether or not the log grew meanwhile and
// whether or not its run was still going. There is deliberately no `follow` flag
// to disagree with it: the latch (stream-view.ts followTail) is read OFF the
// place once the pane is back on it (project.ts placeRestored), so a reader who
// left on the tail keeps following it and one who left in the middle stays there
// while the reconnect appends below.
type Memento = {
  scroll: number;
  high: number | null;   // newest painted byte offset (start of that record)
  oldest: number | null; // oldest painted byte offset — the range to rebuild
  older: number;         // bytes still unloaded before `oldest`
  workdir: string;
};

const mementos = new Map<string, Memento>();

// DOM cache: keep each tab's rendered transcript so coming back to it paints the
// page the reader left instead of rebuilding it out of the .clc.
//
// It holds the LIVE NODES — moved into a detached fragment — not their innerHTML.
// A fold in this pane is not its markup: the head's click handler, the body its
// rows are moved into, the block's own copy of what it drew, the <pre> its next
// delta appends to are all PROPERTIES on the elements (auto-fold.ts buildFold,
// stream-text.ts buildThinkingBlock, tool-render.ts), and serialising to HTML
// strips every one of them. The restored copy was a pane whose folds could not be
// opened at all (no handler on the head), and whose process block the next row
// could not join — absorbInto writes through `wrap._body`, which the copy no
// longer had, so the throw left every later row outside the block: the reported
// "the process rows stop going into the process fold". Moving the nodes keeps the
// whole fold, its open/closed state, and the reader's own choices with it.
//
// A cache is one PICTURE of a FINISHED transcript (viewIsSettled below), and it is
// a one-shot handoff: the nodes go back into #events, so the entry is dropped as it
// is used and taken again the next time the tab is left.
type DomCache = {
  nodes: DocumentFragment;     // the #events children, moved out whole
  streamScrollTop: number;     // cached scroll position
  stateSnapshot: {             // cached render state values
    streamHighOffset: number | null;
    oldestOffset: number | null;
    followTail: boolean;
    runSettled: boolean;       // whether this tab's last run already painted its ending
    // The live pointers belong to the nodes above, not to the window: they name
    // the block a run is still writing into, and they are the ONLY record that
    // the block's text is the log's own (textSealed) or that its tool group is
    // still open. A cache that carried the nodes but not the pointers left a
    // running tab's answer frozen at the delta it was left on, and let the step's
    // durable assistant_message paint a second, complete block underneath it —
    // one answer, twice, once cut short (stream-events.ts dropOrphanLive).
    lastTextEl: any;
    lastTextContent: string;
    textSealed: boolean;
    // ...and the block the newest durable record DREW (stream-events.ts), when it
    // was not a live block at all: a replayed or stored turn paints its answer from
    // the record, and the run's `final` — which repeats that record's text — comes
    // back through the reconnect with it. A cache that dropped this pointer made
    // the final paint the answer a second time under the one already on the page.
    lastRecordEl: any;
    lastRecordText: string;
    thinkingEl: any;
    thinkingContent: string;
    toolGroupEl: any;
    compactionEl: any;
    retryNoteEl: any;
  };
};

const domCaches = new Map<string, DomCache>();

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
  // Only a pane that is SHOWING this tab knows what it looked like. A tab left
  // while its load card was still up (or while a failure panel stood in its
  // place) has no place to remember: a card is not a transcript, and the scroll a
  // load starts from is 0 (project.ts apply). Saving that overwrote the place the
  // reader had actually left the tab on, so every return to a tab abandoned
  // mid-load landed at the very top of its log — while a tab abandoned on a
  // transcript, the common case, came back correctly. Keeping the memento the tab
  // already had is the honest answer, and it is now the ONLY writer of the place.
  if (!stream || !paneShowsTab(slotId)) return;
  const m: Memento = {
    scroll: stream.scrollTop,
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

/** Put the pane back on the place this tab was left at.
 *
 *  Returns the offset the pane landed on, or null when the tab has no place to go
 *  back to (its very first open, or one left before it ever painted a
 *  transcript) — which is the caller's cue to stand on the tail instead.
 *
 *  The saved place is a PIXEL, not a fraction of the log: the same records paint
 *  to the same height, so the pixel is exactly what "the part I was looking at"
 *  means. `mementoOf` (not the in-memory map) is what makes that survive a page
 *  or app reload: after one, the map is empty and localStorage is the only copy
 *  left — reading only the map put every tab of a restored working set back on
 *  the tail. A log that shrank under the tab (a compaction, rows folded away) can
 *  leave the pixel past the end, so it is clamped here rather than left to the
 *  browser to clamp behind our back.
 */
export function restoreMemento(slotId: string): number | null {
  const m = mementoOf(slotId);
  const stream = document.getElementById("stream");
  if (!m || !stream) return null;
  const end = Math.max(0, stream.scrollHeight - stream.clientHeight);
  stream.scrollTop = Math.max(0, Math.min(m.scroll, end));
  return stream.scrollTop;
}

// ---- DOM cache: save and restore per-tab rendered content --------------------

/** Is this transcript a picture worth taking, or is a run still drawing into it?
 *
 *  Read off the DOM rather than off a status flag, because the flag describes the
 *  tab the window is SHOWING and this question is always asked about the tab it is
 *  LEAVING.
 *
 *  A RUNNING tab IS cached. That is the whole point of the cache: the reported
 *  bug was that every switch of a tab whose run was in flight fell back to the
 *  replay — `/api/session` plus a page of `/api/history` through the tunnel — so
 *  coming back to a remote tab always cost a progress bar and a re-render, and the
 *  run that was only "in flight" looked stopped while the reader was away. What a
 *  live pane needs is not a refusal but the two things the restore now does: put
 *  the live pointers back (stateSnapshot) and normalise them once the pane is up
 *  (dropOrphanLive, project.ts) — the same teardown a reconnect performs.
 *
 *  What is still refused is what no record can ever complete, or what a recorded
 *  frame of it would freeze:
 *
 *  * an empty pane: nothing to keep, and the replay is one request;
 *  * a `.stream` row: a tool call whose arguments are still being generated. Half
 *    an argument list is never written to the .clc, so the picture could only
 *    come back as a call that never happened — and its in-memory handle
 *    (streamRows) may not even be the window's any more;
 *  * a `.live` row: the run talking ABOUT itself (a reconnect chip, a compaction
 *    in progress). Those exist for seconds and no durable record retires a
 *    restored one, so it would sit in the pane for good;
 *  * a fold caught mid-move: it carries the animation's own inline height, and a
 *    picture of that is a box frozen at a random size with its content clipped —
 *    the reported "a fold that ends halfway and cannot be opened".
 *
 *  A view that fails is not cached at all: the tab falls back to
 *  restoreTabView/openInTab, which rebuild the same range out of the log — the one
 *  place a complete transcript can come from. */
function viewIsSettled(eventsEl: HTMLElement): boolean {
  if (!eventsEl.children.length) return false;
  // a call whose arguments are still streaming, and the run's own transient news
  if (eventsEl.querySelector(".stream, .live")) return false;
  // a fold (or a diff) whose close/open animation has not landed yet
  for (const el of Array.from(eventsEl.querySelectorAll<HTMLElement>(".fold, pre"))) {
    if (el.style.height || el.style.gridTemplateRows) return false;
  }
  return true;
}

/** Save the current #events DOM tree and render state for a tab so it can be
 *  instantly restored when the tab is re-activated, without re-rendering. */
export function saveDomCache(slotId: string) {
  if (!slotId) return;
  const eventsEl = document.getElementById("events");
  const stream = document.getElementById("stream");
  if (!eventsEl || !stream || !paneShowsTab(slotId) || !viewIsSettled(eventsEl)) {
    // Nothing in the pane is this tab's picture of a finished transcript. Drop
    // whatever was cached for it: a picture taken of an EARLIER state is worse
    // than none — it would come back missing everything since.
    domCaches.delete(slotId);
    return;
  }
  // The place is read BEFORE any row moves: emptying the pane shrinks the
  // scrollable area, and the browser clamps scrollTop with it (that clamp is the
  // trusted "content shrank" scroll stream-view.ts learns to ignore). A cache
  // that read the offset after the move stored 0 and put every restored tab back
  // at the very top of its transcript.
  const streamScrollTop = stream.scrollTop;
  const nodes = document.createDocumentFragment();
  while (eventsEl.firstChild) nodes.appendChild(eventsEl.firstChild);
  domCaches.set(slotId, {
    nodes,
    streamScrollTop,
    stateSnapshot: {
      streamHighOffset: state.streamHighOffset,
      oldestOffset: state.oldestOffset,
      followTail: state.followTail,
      runSettled: state.runSettled,
      // the live pointers go with the nodes they name (see DomCache). They are
      // read here, while this tab is still the pane's, and put back by
      // restoreDomCache when it is the pane's again.
      lastTextEl: state.lastTextEl,
      lastTextContent: state.lastTextContent,
      textSealed: state.textSealed,
      // ...and the block a record drew, for the same reason: the final that repeats
      // it is replayed into the restored pane, and only this pointer says the answer
      // is already on the page (stream-events.ts)
      lastRecordEl: state.lastRecordEl,
      lastRecordText: state.lastRecordText,
      thinkingEl: state.thinkingEl,
      thinkingContent: state.thinkingContent,
      toolGroupEl: state.toolGroupEl,
      compactionEl: state.compactionEl,
      retryNoteEl: state.retryNoteEl,
    },
  });
}

/** Restore the #events DOM tree and render state from cache. Returns true if
 *  the cache was present and applied; false means the caller must do a full
 *  replay instead. */
export function restoreDomCache(slotId: string): boolean {
  if (!slotId) return false;
  const cache = domCaches.get(slotId);
  const eventsEl = document.getElementById("events");
  const stream = document.getElementById("stream");
  if (!cache || !eventsEl || !stream) return false;
  // One shot: the nodes ARE the cache and they are about to be the pane's again,
  // so the entry goes now. A second activation of the same tab without a save in
  // between must fall back to the replay, never paint an emptied fragment.
  domCaches.delete(slotId);
  // A row put back is not a row the run just drew. The live-folding observer
  // (auto-fold.ts watchLiveRows) sees every append to #events, and the run the
  // window was showing a moment ago may still be marked busy — it would fold this
  // finished transcript into itself, moving rows the reader had in plain sight.
  // The mark says where the rows came from; the observer drops the mark and
  // leaves them alone (foldLiveRow).
  for (const node of Array.from(cache.nodes.childNodes)) {
    if (node.nodeType === 1) (node as HTMLElement).dataset.restored = "1";
  }
  // Restore the events content.
  eventsEl.replaceChildren(cache.nodes);
  // Restore scroll position — the same pixel the tab was left on, clamped to what
  // the pane it just landed in can actually reach (a viewport that grew while the
  // tab was away, or a pane restored into a webview that had not laid out yet).
  const end = Math.max(0, stream.scrollHeight - stream.clientHeight);
  stream.scrollTop = Math.max(0, Math.min(cache.streamScrollTop, end));
  // Restore the offsets the SSE stream uses: streamHighOffset tells
  // reconnectSSE where to pick up (?since=), so the tab only receives the
  // events it missed while it was in the background.
  const s = cache.stateSnapshot;
  state.streamHighOffset = s.streamHighOffset;
  state.oldestOffset = s.oldestOffset;
  state.followTail = s.followTail;
  state.runSettled = s.runSettled;
  // The live pointers come back exactly as they were, because the nodes they
  // name are the pane's again: the block a step was still writing into is HERE,
  // with the text it held, and the seal says whether it is still taking deltas.
  // Both facts are what stream-events.ts needs to finish that block in place
  // (dropOrphanLive) instead of opening a second one under it — and the pane's own
  // `renderTextBlock` reads them.
  state.lastTextEl = s.lastTextEl || null;
  state.lastTextContent = s.lastTextContent || "";
  state.textSealed = !!s.textSealed;
  // ...and the block the last record drew, if this pane painted one (a replayed or
  // stored turn). It is only read while it is CONNECTED, so a snapshot that names
  // nothing this pane put back is ignored rather than completing a foreign node.
  state.lastRecordEl = s.lastRecordEl || null;
  state.lastRecordText = s.lastRecordText || "";
  state.thinkingEl = s.thinkingEl || null;
  state.thinkingContent = s.thinkingContent || "";
  state.toolGroupEl = s.toolGroupEl || null;
  state.compactionEl = s.compactionEl || null;
  state.retryNoteEl = s.retryNoteEl || null;
  // Cancel any pending coalesced-render frame from the previous tab: its
  // closure captures elements that belong to that tab's DOM, not this one.
  if (state.textRenderRaf) { cancelAnimationFrame(state.textRenderRaf); state.textRenderRaf = 0; }
  if (state.thinkingRenderRaf) { cancelAnimationFrame(state.thinkingRenderRaf); state.thinkingRenderRaf = 0; }
  return true;
}

/** Discard the DOM cache for a tab (called when it is closed). */
export function forgetDomCache(slotId: string) {
  domCaches.delete(slotId);
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
