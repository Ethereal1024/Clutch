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
