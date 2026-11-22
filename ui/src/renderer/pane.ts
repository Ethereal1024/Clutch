// the pane — the ONE owner of #stream
//
// #stream is a single surface, and four different things want it: a tab's
// transcript, the LOAD of a tab that has no transcript yet, the panel that says
// why a tab could not open, and the welcome page. Two of them on screen at once
// was the reported bug ("switching tabs left the previous tab's conversation
// under the bar that was loading the one being opened"), so ownership is a SUM
// TYPE rather than a set of class toggles that one function remembers to sweep:
//
//   welcome  nothing is open
//   tab      a transcript is on screen, and it belongs to tabId
//   load     a tab is being opened; the card names it and reports the load
//   blocked  the panel explains why a tab could not open
//
// `render` is the only writer of that surface, and it derives every element from
// the state:
//
//   * the views declare themselves in the markup (`data-view`), so a fifth view
//     is a new element and a new alternative here — never a new line in a list
//     that somebody has to remember to extend;
//   * the load's progress is DATA. The hop that dials a tab's machine and the
//     replay that follows both REPORT a fraction; neither paints, and neither
//     reads the other's pixels back to find out where to continue. What the
//     fill SHOWS chases that number, so a coarse report is travel, not a jump;
//   * the view cache asks `paneShowsTab`, not the DOM.
//
// The bar's arithmetic lives here too: one load is one bar moving one way, and
// this file is the only place that knows how its parts divide it.

// What the load is doing, as data. `null` = no bar at all (the card still names
// the tab), `pct: null` = nothing measured yet (the fill animates), a number is
// the WHOLE load's percentage — the hop and the replay share that one scale.
export type LoadProgress = { pct: number | null; note: string } | null;

export type PaneMachine = { host?: string; user?: string; port?: number | string } | null;

export type PaneState =
  | { view: "welcome" }
  | { view: "tab"; tabId: string }
  | { view: "load"; tabId: string; label: string; where: string; progress: LoadProgress }
  | {
      view: "blocked";
      tabId: string | null;
      text: string;
      status: string;
      machine: PaneMachine;
      shown: boolean;
    };

// How much of the load's bar the HOP may fill. The bar carries one load from end
// to end: the dial its file needs first, then the project's replay. A hop that
// owned the bar outright would read 100% and then start again at 0 for the open.
export const HOP_SHARE = 0.4;

// ...and how the replay divides what is left. Each phase's own fraction is real
// work (records parsed on the host, records rendered here, math typeset here);
// this table is where their shares of the bar are decided, in one place.
const REPLAY_PHASES = {
  parse: [0, 0.5],
  render: [0.5, 0.9],
  typeset: [0.9, 1],
} as const;

export type ReplayPhase = keyof typeof REPLAY_PHASES;

// ---- the states ------------------------------------------------------------

export function paneWelcome(): PaneState {
  return { view: "welcome" };
}

export function paneTab(tabId: string): PaneState {
  return { view: "tab", tabId: tabId || "" };
}

export function paneLoad(tabId: string, label: string, where = ""): PaneState {
  // a load starts with a bar it has not measured yet: a card standing still at 0%
  // while a remote machine is dialled is the "is it hung?" the animation answers
  return { view: "load", tabId: tabId || "", label: label || "", where: where || "", progress: { pct: null, note: "" } };
}

export function paneBlocked(tabId: string | null, text: string, machine: PaneMachine = null): PaneState {
  return {
    view: "blocked",
    tabId: tabId || null,
    text: text || "",
    status: "", // a new verdict, not the last one's words
    machine: machine || null,
    shown: true,
  };
}

// ---- the current one -------------------------------------------------------

let pane: PaneState = paneWelcome();
const listeners: Array<(state: PaneState) => void> = [];

export function currentPane(): PaneState {
  return pane;
}

export function paneShowsTab(tabId: string): boolean {
  return pane.view === "tab" && !!tabId && pane.tabId === tabId;
}

export function paneBlockedTabId(): string | null {
  return pane.view === "blocked" ? pane.tabId : null;
}

// Where the replay continues from: the hop's last measured percentage, read from
// the STATE. The old code read it back out of the fill's inline width, which is
// two painters guessing each other's position through the DOM. Only a load has a
// position to read, so only this file asks (below).
function paneLoadPct(): number | null {
  return pane.view === "load" && pane.progress ? pane.progress.pct : null;
}

// A view that is not a transcript owes the tab's paging and jump controls
// nothing, so they ask this (and so does project.ts's pill, through this hook:
// its count and its paging live in the pager, only its owner is the pane's).
export function onPaneChange(fn: (state: PaneState) => void) {
  listeners.push(fn);
}

export function setPane(next: PaneState) {
  pane = next;
  render();
  for (const fn of listeners) fn(pane);
}

// ---- the only writer -------------------------------------------------------

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function render() {
  const state = pane;
  const stream = byId("stream");
  if (stream) {
    // the published owner: the paging guard (project.ts loadOlder) and the view
    // cache read this, and it is derived from the state on every change
    stream.dataset.pane = state.view;
    stream.dataset.tabId = state.view === "tab" || state.view === "load" ? state.tabId : "";
    // records are being rebuilt under this pane: no entrance motion for them
    stream.classList.toggle("loading", state.view === "load");
  }
  // A dismissed panel shows NO view: it is not a transcript either, so nothing
  // takes its place (activateTab's cache policy asks paneBlockedTabId).
  const visible = state.view === "blocked" && !state.shown ? "" : state.view;
  for (const el of Array.from(document.querySelectorAll("[data-view]"))) {
    el.classList.toggle("hidden", el.getAttribute("data-view") !== visible);
  }
  if (state.view === "load") renderLoad(state);
  else stopBar(); // the bar is the load's alone: no other view owes it a position
  if (state.view === "blocked") renderBlocked(state);
  // the ↓ latch belongs to a transcript (stream-view.ts owns when it comes back;
  // here it is only ever taken away)
  if (state.view !== "tab") {
    const jump = byId("jump-bottom");
    if (jump) jump.classList.add("hidden");
  }
}

function renderLoad(state: Extract<PaneState, { view: "load" }>) {
  const title = byId("tab-load-title");
  if (title) title.textContent = state.label;
  const where = byId("tab-load-where");
  if (where) where.textContent = state.where;
  const barEl = byId("open-progress");
  if (!barEl) return;
  const progress = state.progress;
  barEl.classList.toggle("hidden", !progress);
  if (!progress) {
    stopBar();
    return;
  }
  const note = byId("open-progress-note");
  if (note) note.textContent = progress.note || "";
  const fill = barEl.querySelector(".open-progress-fill") as HTMLElement | null;
  const label = barEl.querySelector(".open-progress-label") as HTMLElement | null;
  if (!fill) return;
  if (progress.pct === null) {
    // nothing measured yet: the fill IS the sliding sliver (CSS), and a number
    // here would be either a lie or a bar that stands still — so the chase paints
    // nothing at all until there is something to travel to
    stopBar();
    fill.classList.add("indeterminate");
    fill.style.width = "";
    if (label) label.textContent = "";
    return;
  }
  const whole = Math.round(Math.max(0, Math.min(100, progress.pct)));
  fill.classList.remove("indeterminate");
  // a DIFFERENT tab's load is a different bar, and a bar starts where a bar starts
  const fresh = !bar || bar.tabId !== state.tabId;
  bar = { fill, label, tabId: state.tabId };
  if (fresh) {
    barShown = 0;
    barPainted = -1;
  }
  barTarget = whole;
  paintBar(); // a position already reached needs no frame to say so
  if (!barStop && barShown !== barTarget) {
    barAt = 0; // the first frame of a chase measures no time: it moves
    barStop = nextFrame(barFrame);
  }
}

// ---- painting the bar -------------------------------------------------------
//
// What a load REPORTED and what the fill is SHOWING are two numbers. Reports
// arrive in bursts (one per record of a replay) and, on a remote restore, in a
// handful of COARSE steps — the hop's stages, then the tail fetch — so painting
// each one the instant it lands is the reported "the bar does not animate, it
// jumps forward". The fill therefore CHASES the reported number: a report says
// where the bar belongs, and the eased travel to it is what reads as motion.
//
// The chase cannot lie about the work, which is what the old CSS `transition:
// width` did: it never moves back (one load, one bar, one way), it never passes
// the reported target (a bar ahead of the work done is the lie in the other
// direction), and the PERCENT IS PAINTED FROM THE SAME NUMBER as the fill — so
// the label cannot run ahead of the bar, which is what a transition did under a
// per-record burst (the label read 90% over a fill stuck at 50%, the bug that
// took the transition away and left this bar jumping).
const CHASE_TAU_MS = 130; // how quickly an ordinary gap closes
const CHASE_MIN_PCT = 0.35; // ...with a floor, so the last pixel still arrives

// One frame of the chase, as a pure step: the tests drive this directly.
export function chasePct(shown: number, target: number, dtMs: number): number {
  const to = Math.max(0, Math.min(100, Number(target) || 0));
  const from = Math.max(0, Math.min(100, Number(shown) || 0));
  if (!(to > from)) return to; // a target behind us is the state's, not a travel
  const k = 1 - Math.exp(-Math.max(0, Number(dtMs) || 0) / CHASE_TAU_MS);
  return Math.min(to, Math.max(from + (to - from) * k, from + CHASE_MIN_PCT));
}

// The bar being eased: the elements a render found, the tab whose load owns them,
// and the two numbers (reported target, painted position).
type BarPaint = { fill: HTMLElement; label: HTMLElement | null; tabId: string };
let bar: BarPaint | null = null;
let barTarget = 0;
let barShown = 0;
let barPainted = -1; // the whole percent last written to BOTH fill and label
let barStop: (() => void) | null = null; // the queued frame, when one is queued
let barAt = 0;

// A frame, whichever way this shell runs animation: Electron and the Android
// WebView have rAF; anything driving this page without one gets a timer, so the
// bar still moves instead of painting only where it was last set.
function nextFrame(cb: (now: number) => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(() => cb(Date.now()), 16);
  return () => clearTimeout(id);
}

function paintBar() {
  if (!bar) return;
  const whole = Math.round(barShown);
  if (whole === barPainted) return;
  barPainted = whole;
  bar.fill.style.width = whole + "%";
  if (bar.label) bar.label.textContent = whole + "%";
}

function barFrame(now: number) {
  barStop = null;
  if (!bar || pane.view !== "load") {
    bar = null;
    return;
  }
  const dt = barAt ? Math.max(1, now - barAt) : 16;
  barAt = now;
  barShown = chasePct(barShown, barTarget, dt);
  paintBar();
  if (barShown < barTarget) barStop = nextFrame(barFrame);
}

function stopBar() {
  if (barStop) barStop();
  barStop = null;
  bar = null;
  barTarget = 0;
  barShown = 0;
  barPainted = -1;
  barAt = 0;
}


function renderBlocked(state: Extract<PaneState, { view: "blocked" }>) {
  const text = byId("tab-blocked-text");
  if (text) text.textContent = state.text;
  const status = byId("tab-blocked-status");
  if (status) status.textContent = state.status;
  const connect = byId("tab-blocked-connect");
  if (connect) connect.classList.toggle("hidden", !state.machine);
}

// ---- what a load reports ---------------------------------------------------

function setProgress(progress: LoadProgress) {
  if (pane.view !== "load") return; // a load that is over reports into nothing
  setPane({ ...pane, progress });
}

// The hop a tab's file needs (conn-flow connectTabMachine): its stage percentage
// is in the hop's own 0..100 space and becomes the first HOP_SHARE of the bar.
export function reportHopStage(stagePct: number | null, note: string) {
  setProgress({
    pct: stagePct === null ? null : stagePct * HOP_SHARE,
    note: note || "",
  });
}

// The hop is over. Up: keep the bar where the hop left it and say what is
// happening now (the session spawns, then the replay). Down: no bar — the panel
// that carries the verdict is about to take the pane.
export function paneHopSettled(up: boolean) {
  if (pane.view !== "load") return;
  setProgress(up ? { pct: paneLoadPct(), note: "Opening project…" } : null);
}

// The replay (`phase`'s own fraction) fills what the hop left: continuing from
// the state is what makes one load one bar, moving one way.
export function paneReplayProgress(phase: ReplayPhase, frac: number) {
  if (pane.view !== "load") return;
  const [from, to] = REPLAY_PHASES[phase];
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  const start = paneLoadPct() ?? 0;
  const end = start + (100 - start) * (from + (to - from) * f);
  setProgress({ pct: end, note: pane.progress ? pane.progress.note : "" });
}
