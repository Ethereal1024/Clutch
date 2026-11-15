// tab bar — document tabs for open projects
//
// Implements tabOpen / tabClose / tabActivate and renders the #tab-bar DOM.
// Persists the tab list in localStorage so a reload restores the visual state.
// Does NOT import project.ts — project switches are driven by a DOM event
// (clutch:tab-activate) so there is no circular dependency.
//
// Data flow:
//   user opens project → project.ts setProjectInfo → clutch:project-info
//     → tab-bar.ts tabOpen (adds / activates tab, re-renders)
//
//   user clicks tab → tabActivate → clutch:tab-activate
//     → project.ts listener → openProject(path)
//       → setProjectInfo → clutch:project-info → tabOpen (no-op: already active)

import { state } from "./state";

// ---- persistence ----

const LS_KEY = "clutch_tabs";

function saveTabs(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ tabs: state.tabs }));
  } catch {}
}

function loadTabs(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.tabs)) {
      state.tabs = data.tabs.filter(
        (t) => t && typeof t.id === "string" && typeof t.path === "string"
      );
    }
    // activeTabId is not restored: the project is not open yet on boot.
    // setProjectInfo fires when the host re-opens a project and sets it then.
    state.activeTabId = null;
  } catch {}
}

// ---- id generation ----

function newTabId(): string {
  return "tab-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---- rendering ----

export function renderTabBar(): void {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  const newBtn = document.getElementById("tab-new-btn");
  // remove existing tab elements, keep the new-tab button
  Array.from(bar.querySelectorAll(".doc-tab")).forEach((el) => el.remove());
  // show/hide the bar itself depending on whether any tabs exist
  bar.classList.toggle("hidden", state.tabs.length === 0);
  // show/hide the bar itself depending on whether any tabs exist
  bar.classList.toggle("hidden", state.tabs.length === 0);

  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = "doc-tab" + (tab.id === state.activeTabId ? " active" : "");
    el.dataset.tabId = tab.id;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", tab.id === state.activeTabId ? "true" : "false");
    el.title = tab.path;

    const label = document.createElement("span");
    label.className = "doc-tab-label";
    label.textContent = tab.name;
    el.appendChild(label);

    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "doc-tab-dirty";
      dot.setAttribute("aria-label", "unsaved");
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

    if (newBtn) bar.insertBefore(el, newBtn);
    else bar.appendChild(el);
  }
}

// ---- public API ----

/** Add a tab for `path` / `name`, or activate it if already open. */
export function tabOpen(path: string, name: string): void {
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) {
    if (existing.id === state.activeTabId) return; // already shown, nothing to do
    state.activeTabId = existing.id;
    renderTabBar();
    saveTabs();
    return;
  }
  const id = newTabId();
  state.tabs.push({ id, path, name, dirty: false });
  state.activeTabId = id;
  renderTabBar();
  saveTabs();
}

/** Remove tab `id`. If it was active, switch to the nearest remaining tab. */
export function tabClose(id: string): void {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[idx] ?? state.tabs[idx - 1] ?? null;
    if (next) {
      state.activeTabId = next.id;
      // ask project.ts to open it via the event bus
      document.dispatchEvent(
        new CustomEvent("clutch:tab-activate", { detail: { path: next.path } })
      );
    } else {
      state.activeTabId = null;
    }
  }
  renderTabBar();
  saveTabs();
}

/**
 * Switch the active tab to `id` and trigger the project open.
 * No-op if the tab is already active (prevents the event-loop ping-pong).
 */
export function tabActivate(id: string): void {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.id === state.activeTabId) return;
  state.activeTabId = id;
  renderTabBar();
  saveTabs();
  document.dispatchEvent(
    new CustomEvent("clutch:tab-activate", { detail: { path: tab.path } })
  );
}

/** Mark (or unmark) a tab's dirty indicator without triggering a project open. */
export function tabMarkDirty(path: string, dirty: boolean): void {
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab || tab.dirty === dirty) return;
  tab.dirty = dirty;
  renderTabBar();
  saveTabs();
}

// ---- keyboard navigation ----
// Ctrl+Tab → next tab, Ctrl+Shift+Tab → previous tab

document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.key !== "Tab" || state.tabs.length < 2) return;
  e.preventDefault();
  const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
  if (idx < 0) return;
  const len = state.tabs.length;
  const next = e.shiftKey
    ? state.tabs[(idx - 1 + len) % len]
    : state.tabs[(idx + 1) % len];
  tabActivate(next.id);
});

// ---- new-tab button ----
// Surfaces the welcome screen so the user can pick a project.

document.getElementById("tab-new-btn")?.addEventListener("click", () => {
  const welcome = document.getElementById("welcome");
  if (welcome) welcome.classList.remove("hidden");
});

// ---- respond to project opens ----
// setProjectInfo (project.ts) dispatches clutch:project-info; we open/activate
// the matching tab so the tab bar always reflects the live project.

document.addEventListener("clutch:project-info", (ev) => {
  const { project, name } = (ev as CustomEvent).detail ?? {};
  if (project) tabOpen(project, name || project.split("/").pop() || project);
});

// ---- init ----

loadTabs();
renderTabBar();
