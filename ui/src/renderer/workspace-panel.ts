// the right-hand panel — hidden-file policy, shell panel, file tree
//
// The narrow-screen panel and its history entry, the show-hidden toggle, and the
// workspace tree that re-renders on a signature change.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { apiFetch } from "./app";
import { els } from "./els";
import { $ } from "./dom";
import { fsModal, fsPath, loadDir } from "./fs-browser";
import { escapeHtml } from "./render-events";

// ---- workspace tree ----
export let lastTreeSig = "";
export let treeRefreshTimer = null;

// dotfiles hidden everywhere until the shared toggle turns them on
export let showHidden = localStorage.getItem("clutch_show_hidden") === "1";

export function updateHiddenToggles() {
  $("#fs-hidden-toggle").checked = showHidden;
  $("#tree-hidden-toggle").checked = showHidden;
}

export function toggleHidden() {
  showHidden = !showHidden;
  localStorage.setItem("clutch_show_hidden", showHidden ? "1" : "0");
  updateHiddenToggles();
  // re-list the picker's current dir and the tree with the new visibility
  if (!fsModal.classList.contains("hidden")) loadDir(fsPath);
  refreshTree();
}

$("#fs-hidden-toggle").addEventListener("change", toggleHidden);
$("#tree-hidden-toggle").addEventListener("change", toggleHidden);
updateHiddenToggles();

// ---- phone shell (device reports #2/#3): ONE slide-over panel ----
// 主流 phone clients keep the conversation column clean and park the shell
// behind a single trigger. That panel is #right with a project section on top:
// the three project actions and the workspace tree stack in one drawer instead
// of the project actions sitting alone in a mostly-empty second one. The
// dismissal is a square ✕ at the panel's top edge, so it can never land in the
// middle of a row.
// The project buttons are NOT duplicated: they are MOVED between #topbar and
// #shell-project-actions, so there is exactly one node, one handler and one
// disabled state per action — and a rotation back to the desktop layout moves
// the same nodes home.
export const shellBackdrop = $("#shell-backdrop");
export const shellPanel = $("#right");
export const shellActions = $("#shell-project-actions");
export const SHELL_ACTIONS = ["#open-project-btn", "#new-project-btn", "#settings-btn"];
export const NARROW_Q = window.matchMedia("(max-width: 640px)");

// paintShellPanel only moves the classes; setShellPanel also owns the history
// entry, so the two must not call each other (see the popstate listener).
export function paintShellPanel(open) {
  shellPanel.classList.toggle("drawer-open", open);
  shellBackdrop.classList.toggle("open", open);
}

// The panel is a surface OVER the app, not a page: the phone's back button has
// to dismiss it instead of walking out of the app. The WebView can only see
// history, so opening pushes an entry of our own — exactly what the diagram
// viewer does (a CSS overlay is invisible to MainActivity.onKeyDown).
// A popstate's event.state describes the entry we LANDED on, not the one that
// was popped, so which pop belongs to us is tracked by two flags: the open
// panel owns an entry, and our own history.back() announces itself. Without the
// second flag a stale pop (tapping ✕ and reopening a frame later) would close
// the panel the user just reopened.
export let panelHistoryEntry = false; // the open panel owns a history entry
export let consumingEntry = false;    // our own history.back() is in flight
export function setShellPanel(open) {
  const was = shellPanel.classList.contains("drawer-open");
  paintShellPanel(open);
  if (open === was) return;
  if (open) {
    try {
      history.pushState({ clutchShellPanel: 1 }, "");
      panelHistoryEntry = true;
    } catch (e) {
      panelHistoryEntry = false; // file:// (Electron) refuses pushState: nothing to consume
    }
  } else if (panelHistoryEntry) {
    panelHistoryEntry = false;
    consumingEntry = true;
    try {
      history.back(); // consume our own entry
    } catch (e) {
      consumingEntry = false;
    }
  }
}
export function closeShellPanel() {
  setShellPanel(false);
}

window.addEventListener("popstate", () => {
  if (consumingEntry) {
    consumingEntry = false; // the pop we asked for, not the back button
    return;
  }
  if (!panelHistoryEntry) return;
  panelHistoryEntry = false;
  paintShellPanel(false); // the back button dismisses the panel
});

$("#shell-ws-btn").addEventListener("click", () =>
  setShellPanel(!shellPanel.classList.contains("drawer-open"))
);
$("#shell-close-btn").addEventListener("click", closeShellPanel);
shellBackdrop.addEventListener("click", closeShellPanel);
// a panel action opens a modal: step aside as soon as one is clicked (the
// button's own handler runs first, this bubbling listener right after)
shellActions.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("button")) closeShellPanel();
});

export function layoutShell() {
  const narrow = NARROW_Q.matches;
  for (const sel of SHELL_ACTIONS) {
    const btn = $(sel);
    if (!btn) continue;
    // back into the topbar BEFORE the ▤ trigger, so the desktop order stays
    // exactly what index.html declares
    if (narrow) shellActions.appendChild(btn);
    else $("#topbar").insertBefore(btn, $("#shell-ws-btn"));
  }
  if (!narrow) closeShellPanel(); // a rotation to the desktop layout drops the panel
}
NARROW_Q.addEventListener("change", layoutShell);
layoutShell();

// file changes only arrive via tool results: debounced refresh, no polling
export function scheduleTreeRefresh() {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(refreshTree, 300);
}

export async function refreshTree() {
  try {
    const params = new URLSearchParams();
    if (showHidden) params.set("hidden", "1");
    for (const p of expandedDirs) params.append("expanded", p);
    const qs = params.toString() ? "?" + params : "";
    const data = await apiFetch("/api/workspace/tree" + qs);
    if (data.root) els.workspace.textContent = data.root;
    // include expansion state in the signature so a toggle always re-renders
    const sig = JSON.stringify([...expandedDirs]) + "|" + JSON.stringify(data.tree || []);
    if (sig === lastTreeSig) return; // unchanged: keep expansion state
    lastTreeSig = sig;
    els.tree.innerHTML = "";
    for (const node of data.tree || []) els.tree.appendChild(renderNode(node, 0));
  } catch (e) {
    // Never swallow: the view would silently diverge from the disk.
    console.warn("[tree] refresh failed", e);
  }
}

export const expandedDirs = new Set<string>();

export function renderNode(node, depth) {
  const wrap = document.createElement("div");
  wrap.className = "tree-branch";
  const row = document.createElement("div");
  row.className = "tree-node " + (node.dir ? "dir" : "file");
  row.style.paddingLeft = (depth * 12) + "px";
  const label = node.link ? `${node.name} → ${node.link}` : node.name;
  row.innerHTML =
    `<span class="icon">${node.dir ? "▸" : "·"}</span>` +
    `<span class="name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
  wrap.appendChild(row);
  if (node.dir) {
    const isOpen = expandedDirs.has(node.path);
    const children = document.createElement("div");
    children.className = "tree-children";
    children.style.display = isOpen ? "" : "none";
    if (isOpen) row.querySelector(".icon").textContent = "▾";
    if (isOpen) {
      for (const c of node.children || []) children.appendChild(renderNode(c, depth + 1));
    }
    row.addEventListener("click", (e) => {
      e.stopPropagation(); // don't bubble to ancestor dirs (would collapse them)
      const open = children.style.display !== "none";
      if (open) {
        expandedDirs.delete(node.path);
        children.style.display = "none"; // instant collapse; refresh prunes deep data
        row.querySelector(".icon").textContent = "▸";
      } else {
        expandedDirs.add(node.path);
        row.querySelector(".icon").textContent = "▾";
        // clear first: rapid toggles reuse this element
        children.innerHTML = "";
        // reveal the pre-loaded lookahead level instantly, then fetch deeper
        if (node.children && node.children.length) {
          for (const c of node.children) children.appendChild(renderNode(c, depth + 1));
          children.style.display = "";
        }
      }
      // debounced: rapid toggles coalesce into one fetch; the re-render keeps expansion
      scheduleTreeRefresh();
    });
    // children are siblings of the row, so the row's hover box never covers the subtree
    wrap.appendChild(children);
  }
  return wrap;
}

