// the right sidebar's dock — which of its groups are open, and what opening one
// means
//
// ui/index.html's `aside#right` is a DOCK: views stacked top to bottom the way VS
// Code's sidebar stacks its own, each one a head you collapse it by and a body
// that scrolls inside itself. Two different kinds of state meet in that column and
// must not be confused: HOW the reader partitioned their screen is theirs and
// outlives the moment (remembered per window in localStorage), while WHAT a group
// holds belongs to the tab that is open (the plugin list follows `clutch:tab-state`
// in components-panel.ts). This file owns the first kind and only the first.
//
// A collapsed group is its head and nothing else — 30px of title, the state a
// reader uses to give the height to the other view — so the three ends of it have
// to agree: the class the sheet paints, `aria-expanded` (what a screen reader is
// told), and one read. A pane nobody is looking at asks nothing, so the read it
// deferred has to happen when it comes back on screen — from the group's own head
// (below), or from the panel itself reappearing (`clutch:panel-shown`, the other
// way a group can come back into view).

import { $ } from "./dom";
import { NARROW_Q, setShellPanel, shellPanel, showShellPanel } from "./workspace-panel";
import { pluginTabShown } from "./components-panel";

// the partition is the reader's, so it is remembered by group and not by tab: two
// tabs are two sessions on possibly two machines, but they are one screen
const STORE = "clutch_dock_groups";

// ...and so is HOW MUCH of the column each open group gets: the same kind of state
// (the reader's screen, not the tab), remembered the same way. The number is the
// workspace group's own height in pixels — the group that grows downward toward a
// drag handle, so the number is the one the drag changes — and 0 means "never set":
// the two bodies then share the column as CSS shares it (`flex: 1 1 0`).
const SPLIT_STORE = "clutch_dock_split";
const SPLIT_MIN = 80; // the least either group keeps: a head, its title, one row
const SPLIT_STEP = 16; // one arrow key

type DockGroup = {
  id: string;
  head: Element;
  group: Element;
  // what this group's BODY asks for when it comes back on screen
  opened?: () => void;
  open: boolean;
};

// the groups, in the order the sidebar stacks them. `opened` is the body's own
// entry point (components-panel.ts `pluginTabShown`) and not a read invented here:
// the workspace tree keeps its DOM, so it has nothing to ask for.
const SPECS = [
  { id: "workspace", head: "#dock-toggle-workspace", group: "#dock-workspace" },
  { id: "plugins", head: "#dock-toggle-plugins", group: "#dock-plugins", opened: () => pluginTabShown() },
];

// a record that will not parse is not a layout: every group falls back to its
// default, which is open — a sidebar that came back folded would read as broken
function remembered(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) {
    return {};
  }
}

const saved = remembered();
const groups: DockGroup[] = SPECS.map((spec) => ({
  ...spec,
  head: $(spec.head),
  group: $(spec.group),
  open: saved[spec.id] !== false,
}));

function byId(id: string): DockGroup | null {
  return groups.find((g) => g.id === id) || null;
}

function save() {
  const layout: Record<string, boolean> = {};
  for (const g of groups) layout[g.id] = g.open;
  localStorage.setItem(STORE, JSON.stringify(layout));
}

// ---- the split between the two groups --------------------------------------
//
// #dock-split (ui/index.html) is the rule between them, and it is a handle: a tree
// wants depth on one screen and the plugin list wants it on the next, and no fixed
// proportion guesses which screen this is. Three inputs, one number: a drag, the
// arrow keys (it is a `role="separator"` with a tab stop, so it has to answer a
// keyboard), and the record a returning window reads. Nothing is drawn while only
// one group is open — a fold is already the whole column, and a handle over nothing
// is a grip that moves no boundary.
const splitEl = $("#dock-split");

let splitPx = 0; // the workspace group's height; 0 = never set (CSS halves)
let dragFrom = 0; // pointer y when the drag began
let dragPx = 0; // the height it began from
let dragging = false;

function rememberedSplit(): number {
  try {
    const n = Math.round(Number(localStorage.getItem(SPLIT_STORE)));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0; // a storage this window cannot read is a window with the CSS halves
  }
}

function saveSplit() {
  try {
    localStorage.setItem(SPLIT_STORE, String(Math.round(splitPx)));
  } catch (e) {
    /* a window that cannot remember it still has it for this one */
  }
}

// A number in px read off a box that may have no layout at all (the tests' DOM, a
// hidden panel) — 0 then, and the caller decides what that means.
function boxPx(el: Element | null): number {
  if (!el || typeof el.getBoundingClientRect !== "function") return 0;
  return Math.round(el.getBoundingClientRect().height) || 0;
}

function headPx(g: DockGroup | null): number {
  const head = g && g.head;
  return head && typeof head.getBoundingClientRect === "function" ? Math.round(head.getBoundingClientRect().height) || 0 : 0;
}

// The two ends of the drag. Both groups keep SPLIT_MIN of BODY, and their heads are
// not part of the partition (a collapsed group is a head and nothing else, which is
// why this is only asked while both are open): so the workspace group can be its
// head plus SPLIT_MIN tall and no shorter, and the plugin group below it needs the
// same room plus the handle between them. With no layout to measure — a DOM with no
// geometry — the floor still holds and the ceiling is nobody's.
function splitBounds(): { min: number; max: number } {
  const workspace = byId("workspace");
  const plugins = byId("plugins");
  const min = headPx(workspace) + SPLIT_MIN;
  const column = boxPx(splitEl ? splitEl.parentElement : null);
  const handle = boxPx(splitEl);
  if (!column) return { min, max: Infinity };
  return { min, max: Math.max(min, column - handle - headPx(plugins) - SPLIT_MIN) };
}

function clampSplit(px: number): number {
  const b = splitBounds();
  const n = Math.round(Number(px));
  if (!Number.isFinite(n)) return b.min;
  return Math.min(Math.max(n, b.min), b.max);
}

// The one place the number becomes layout: the workspace group is given a FIXED
// height (it may not shrink, or a short window would eat the boundary the reader
// set) and the group under it takes what is left, which is what its own `flex: 1 1
// 0` already says.
function applySplit() {
  const workspace = byId("workspace");
  const plugins = byId("plugins");
  const both = Boolean(workspace && plugins && workspace.open && plugins.open);
  if (splitEl) splitEl.classList.toggle("hidden", !both);
  const style = workspace && workspace.group ? (workspace.group as HTMLElement).style : null;
  if (!style) return;
  if (both && splitPx) style.flex = "0 0 " + clampSplit(splitPx) + "px";
  else style.flex = "";
}

// A drag, a key, or a test: one door to the number, one save after it. `remember:
// false` is a drag in progress — the record is written when the hand lets go, not on
// every pointer move (the same reason a scroll position is not written per frame).
export function dockSetSplit(px: number, { remember = true } = {}) {
  splitPx = clampSplit(px);
  applySplit();
  if (remember) saveSplit();
}

export function dockSplit(): number {
  return splitPx;
}

function splitDragStart(ev) {
  if (!splitEl || !dockIsOpen("workspace") || !dockIsOpen("plugins")) return;
  dragging = true;
  dragFrom = Number(ev && ev.clientY) || 0;
  // where the boundary IS, not where the record says it is: a window that has never
  // been dragged starts from the halves it is showing
  dragPx = splitPx || boxPx(byId("workspace") ? byId("workspace").group : null);
  splitEl.classList.add("dragging");
  if (typeof splitEl.setPointerCapture === "function" && ev && ev.pointerId !== undefined) {
    try {
      splitEl.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* a pointer that cannot be captured still drags while it is over the handle */
    }
  }
  if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
}

function splitDragMove(ev) {
  if (!dragging) return;
  dockSetSplit(dragPx + (Number(ev && ev.clientY) || 0) - dragFrom, { remember: false });
  if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
}

function splitDragEnd() {
  if (!dragging) return;
  dragging = false;
  if (splitEl) splitEl.classList.remove("dragging");
  saveSplit();
}

// the keyboard half of `role="separator"`: Up gives the plugin group more of the
// column, Down gives the workspace group more, one step a press
function splitKey(ev) {
  const key = ev && ev.key;
  if (key !== "ArrowUp" && key !== "ArrowDown") return;
  if (typeof ev.preventDefault === "function") ev.preventDefault();
  const base = splitPx || boxPx(byId("workspace") ? byId("workspace").group : null) || splitBounds().min;
  const next = base + (key === "ArrowDown" ? SPLIT_STEP : -SPLIT_STEP);
  dockSetSplit(next);
}


// the two ends of one state: the class the sheet paints, and the attribute a
// screen reader reads. The title says what pressing the head DOES, which is the
// same fact said as the next act instead of as the current one.
function paint(g: DockGroup) {
  g.group.classList.toggle("dock-collapsed", !g.open);
  g.head.setAttribute("aria-expanded", g.open ? "true" : "false");
  g.head.setAttribute("title", (g.open ? "collapse the " : "expand the ") + g.id);
}

function setOpen(g: DockGroup, open: boolean) {
  if (g.open === open) return;
  g.open = open;
  paint(g);
  save();
  // the boundary only exists between two open groups: a fold takes its height and
  // the handle with it, and puts the other group's back when it opens again
  applySplit();
  // ...and a body that has just come on screen is asked for itself NOW: that is
  // the whole point of the deferred read — a folded list said nothing about the
  // session it is about, and the tab may have moved since it was last drawn
  if (open && g.opened) g.opened();
}

export function dockOpen(id: string, open: boolean) {
  const g = byId(id);
  if (g) setOpen(g, open);
}

export function dockIsOpen(id: string): boolean {
  const g = byId(id);
  return Boolean(g && g.open);
}

// every open body, asked for itself: the panel has just come back on screen, so
// what each one holds is worth re-reading — it was drawing while hidden, and
// "hidden" is exactly when this page does not read (a hidden list spends a network
// read on nothing).
document.addEventListener("clutch:panel-shown", () => {
  for (const g of groups) if (g.open && g.opened) g.opened();
});

// the View menu's door to the plugin page: it used to be a settings tab, so a
// reader who does not think to look at the sidebar has to be able to reach it from
// the menu that names panels. The panel comes first (it is the surface), then the
// group — and a second press, with both already on screen, puts the group away,
// the way every other item in that menu toggles.
export function revealPlugins() {
  const onScreen = NARROW_Q.matches
    ? shellPanel.classList.contains("drawer-open")
    : !shellPanel.classList.contains("panel-hidden");
  if (!onScreen) {
    // showing the panel announces itself (`clutch:panel-shown`), so a group that
    // was already open is read on the way back without a line of its own here
    showShellPanel();
    if (!dockIsOpen("plugins")) dockOpen("plugins", true);
    return;
  }
  dockOpen("plugins", !dockIsOpen("plugins"));
}

for (const g of groups) {
  paint(g);
  g.head.addEventListener("click", () => setOpen(g, !g.open));
}

// ---- the handle is wired last, once the groups exist -----------------------
splitPx = rememberedSplit();
applySplit();
if (splitEl) {
  splitEl.addEventListener("pointerdown", splitDragStart);
  splitEl.addEventListener("pointermove", splitDragMove);
  splitEl.addEventListener("pointerup", splitDragEnd);
  splitEl.addEventListener("pointercancel", splitDragEnd);
  splitEl.addEventListener("keydown", splitKey);
}
// a window that gets shorter re-clamps the boundary it was left with: the SPLIT is
// still the reader's (the stored number does not move), it just cannot be taller
// than the column it divides
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("resize", () => applySplit());
}
