// the titlebar's menu bar — one open dropdown at a time, and every item's action
//
// The DOM and the CSS were migrated from ui/preview.html; this is the behavior
// half, built the way VS Code builds a menu: every item names a COMMAND
// (commands.ts), and the command owns both the work and the `when` test that
// enables it. Nothing here is a second implementation of a feature, and no item
// can ship permanently disabled — the enablement runs on every state change.
//
// File > Recent and Window > Open Tabs are generated from state, so they name
// the projects actually open instead of being decorative labels.

import { $ } from "./dom";
import { setMode } from "./env";
import { state } from "./state";
import { busy } from "./stream-view";
import { currentProject, openProject } from "./project";
import { tabActivate, tabClose, tabCloseAll, tabCloseOthers, tabReopen, closedTabCount, tabMarkState } from "./tab-bar";
import { NARROW_Q, shellPanel, setShellPanel, toggleHidden } from "./workspace-panel";
import { openSettings, showSettingsTab } from "./settings";
import { openFsBrowser } from "./fs-browser";
import { setTrustArmed, trustArmed } from "./permissions";
import { run as runTask, stop as stopTask } from "./render-events";
import { bindKeys, execute, has, isEnabled, onChange, register } from "./commands";

const menu = $("#tb-menu") as HTMLElement | null;
let openItem: HTMLElement | null = null;

const hasProject = () => !!currentProject;
const tabCount = () => state.tabs.length;
const activeId = () => state.activeTabId || "";
const activeRunning = () => !!busy;

function closeMenu() {
  if (!openItem) return;
  openItem.classList.remove("open");
  openItem = null;
}

// ---- commands -----------------------------------------------------------------

register({ id: "open", key: "mod+o", run: () => openFsBrowser("open") });
register({ id: "new", key: "mod+n", run: () => openFsBrowser("new") });
register({ id: "settings", run: () => openSettings() });
register({ id: "about", run: () => openSettings().then(() => showSettingsTab("about")) });

register({ id: "run", enabled: () => hasProject() && !activeRunning(), run: () => runTask() });
register({ id: "stop", enabled: () => activeRunning(), run: () => stopTask() });
register({ id: "mode-work", run: () => setMode("work") });
register({ id: "mode-chat", run: () => setMode("chat") });
register({ id: "trust", run: () => setTrustArmed(!trustArmed()) });

register({
  id: "toggle-right",
  // desktop: collapse/show the aside; phone: the aside IS the drawer
  run: () => {
    if (NARROW_Q.matches) setShellPanel(!shellPanel.classList.contains("drawer-open"));
    else shellPanel.classList.toggle("panel-hidden");
  },
});
register({ id: "toggle-statusbar", run: () => $("#statusbar")?.classList.toggle("hidden") });
register({ id: "toggle-hidden", run: () => toggleHidden() });

register({ id: "tab-new", run: () => openFsBrowser("open") });
register({ id: "tab-close", key: "mod+w", enabled: () => tabCount() > 0, run: () => tabClose(activeId()) });
register({ id: "tab-close-others", enabled: () => tabCount() > 1, run: () => tabCloseOthers() });
register({ id: "tab-close-all", enabled: () => tabCount() > 0, run: () => tabCloseAll() });
register({ id: "tab-reopen", key: "mod+shift+t", enabled: () => closedTabCount() > 0, run: () => tabReopen() });
register({ id: "activate-tab", run: ({ tab }) => tab && tabActivate(tab) });
register({ id: "open-recent", run: ({ path }) => path && openProject(path) });

// ---- dynamic lists --------------------------------------------------------------

const RECENT_KEY = "clutch_recent";

function recentList(): Array<{ path: string; name: string }> {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === "string") : [];
  } catch (e) {
    return [];
  }
}

function recordRecent(project: string, name: string) {
  if (!project) return;
  const list = recentList().filter((r) => r.path !== project);
  list.unshift({ path: project, name: name || project.split("/").pop() || project });
  if (list.length > 8) list.length = 8;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch (e) {
    /* no storage: the list is a convenience, never a requirement */
  }
}

function ddItem(action: string, text: string, attrs: Record<string, string> = {}) {
  const el = document.createElement("div");
  el.className = "tb-dd-item";
  el.dataset.action = action;
  el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.dataset[k] = v;
  return el;
}

function renderRecent() {
  const box = document.getElementById("tb-recent");
  if (!box) return;
  box.textContent = "";
  const list = recentList();
  if (!list.length) {
    const empty = ddItem("", "No recent projects");
    empty.classList.add("disabled");
    box.appendChild(empty);
    return;
  }
  for (const r of list) {
    const item = ddItem("open-recent", r.name || r.path, { path: r.path });
    item.title = r.path;
    box.appendChild(item);
  }
}

function renderOpenTabs() {
  const box = document.getElementById("tb-tabs");
  if (!box) return;
  box.textContent = "";
  if (!state.tabs.length) {
    const empty = ddItem("", "No open tabs");
    empty.classList.add("disabled");
    box.appendChild(empty);
    return;
  }
  for (const tab of state.tabs) {
    const mark = tab.id === state.activeTabId ? "✓ " : "";
    // the switcher says the same ONE thing the strip's dot does (tab-bar.ts
    // tabMarkState): a tab waiting for the user is not also drawn as busy
    const tabState = tabMarkState(tab);
    const dot = tabState === "ask" ? "  ●" : tabState === "run" ? "  ◐" : "";
    const item = ddItem("activate-tab", mark + tab.name + dot, { tab: tab.id });
    item.title = tab.path;
    if (tab.id === state.activeTabId) item.classList.add("active-tab");
    box.appendChild(item);
  }
}

// ---- menu paint ----------------------------------------------------------------

function refreshMenu() {
  // static items: a command nobody registered, or one whose `when` is false, is
  // greyed here — the single place enablement is painted
  menu?.querySelectorAll("[data-action]").forEach((el) => {
    const id = (el as HTMLElement).dataset.action || "";
    if (!id || !has(id)) return;
    el.classList.toggle("disabled", !isEnabled(id));
  });
  renderRecent();
  renderOpenTabs();
}

// ---- menu interaction -----------------------------------------------------------

menu?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const action = target.closest("[data-action]") as HTMLElement | null;
  if (action && action.dataset.action) {
    e.stopPropagation();
    if (action.classList.contains("disabled")) return; // a greyed command does nothing
    closeMenu();
    execute(action.dataset.action, { path: action.dataset.path, tab: action.dataset.tab });
    return;
  }
  const item = target.closest(".tb-menu-item") as HTMLElement | null;
  if (!item) return;
  if (item === openItem) {
    closeMenu();
    return;
  }
  closeMenu();
  item.classList.add("open");
  openItem = item;
  refreshMenu();
});

document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  if (!target || !target.closest("#tb-menu")) closeMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

// ---- keep the menu honest -------------------------------------------------------

document.addEventListener("clutch:project-info", (ev) => {
  const { project, name } = (ev as CustomEvent).detail ?? {};
  recordRecent(project, name);
  refreshMenu();
});
document.addEventListener("clutch:tab-state", () => refreshMenu());
document.addEventListener("clutch:status-changed", () => refreshMenu());
document.addEventListener("clutch:backend-changed", () => refreshMenu());
onChange(refreshMenu);

bindKeys();
refreshMenu();
