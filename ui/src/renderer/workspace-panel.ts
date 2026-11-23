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
// behind a single trigger. That panel is #right, carrying the workspace tree.
// The dismissal is a square ✕ at the panel's top edge, so it can never land in
// the middle of a row. The project actions live in the titlebar's File menu on
// both desktop and phone, so this panel does not duplicate them.
export const shellBackdrop = $("#shell-backdrop");
export const shellPanel = $("#right");
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
// close button: on desktop it collapses the panel (panel-hidden); on mobile it
// goes through the drawer/history path (closeShellPanel).
$("#shell-close-btn").addEventListener("click", () => {
  if (NARROW_Q.matches) closeShellPanel();
  else shellPanel.classList.add("panel-hidden");
});
shellBackdrop.addEventListener("click", closeShellPanel);

export function layoutShell() {
  // Buttons now live permanently in the titlebar dropdown menus on both
  // desktop and mobile — no DOM moves needed. Just close the panel when
  // rotating back to desktop width.
  if (!NARROW_Q.matches) closeShellPanel();
}
NARROW_Q.addEventListener("change", layoutShell);
layoutShell();

// file changes only arrive via tool results: debounced refresh, no polling.
// A dir the reader OPENS asks immediately (delay 0): with no lookahead its
// children are not in hand yet, and a 300 ms wait on top of a remote walk is a
// panel that looks broken.
export function scheduleTreeRefresh(delay = 300) {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(() => {
    // A tool that can write may have written in a tab that is NOT on screen (a
    // task keeps running while the reader looks at another one), so no cached
    // tree is known-good any more: the freshness window must not keep a stale one.
    for (const one of treeStates.values()) one.fetchedAt = 0;
    void refreshTree(true);
  }, delay);
}

// ---- WHICH workspace the panel is showing ------------------------------------
//
// A tree belongs to a WORKSPACE, and a tab IS one (its own session, its own
// project). Three things here used to be window-level singletons — the expanded
// set, the painted signature, the refresh in flight — and every one of them is
// wrong the instant the tab changes, which is what "the tab and the workspace
// disagree" looks like:
//
//   * the tab we just left answered for the tab we opened: its expansions rode
//     into the new walk (on a remote project every extra level is an extra SSH
//     round trip) and its signature could suppress the new tree's re-render;
//   * NOTHING was painted until a fresh walk came back, so the panel kept the
//     previous workspace's files, under the new tab's title, for as long as that
//     walk took — a second or more on a remote project, which is the reported
//     "the workspace switch is sluggish";
//   * the walk already running was neither cancelled nor ordered: it could land
//     after the switch and paint one workspace over another, and flipping through
//     tabs stacked one walk per click on the far host (the reported "the delay
//     adds up").
//
// So the state is per project, a switch paints that project's last tree at once
// (or an empty panel — never another project's), and a refresh belongs to the
// workspace on screen: a switch aborts the walk that was the other tab's.
type TreeState = {
  root: string;            // the workspace root the host reported
  tree: any[];             // the last tree painted for it
  expanded: Set<string>;   // the dirs the reader had open HERE
  sig: string;             // signature of the tree above ("" = nothing yet)
  fetchedAt: number;       // when a walk of it last answered (ms, 0 = never)
};
const treeStates = new Map<string, TreeState>();
const NO_TREE: TreeState = { root: "", tree: [], expanded: new Set(), sig: "", fetchedAt: 0 };
let shownWorkspace: string | null = null; // null until a tab names one
let treeGen = 0;                          // the only refresh allowed to paint
let treeWalk: { project: string; ctl: AbortController } | null = null;

// How long a workspace's tree is treated as current. A tab switched away from and
// back to within this window is NOT re-walked: the panel already shows that exact
// tree, and on a remote project the walk is 1 SSH round trip (0.3–0.9 s measured).
// The window is only ever a cache OF A PICTURE, never a reason to miss a change:
// a tool result (the only thing that writes) forces the walk and drops every
// cached picture, including the tabs that are not on screen.
const TREE_FRESH_MS = 10_000;

function treeState(project: string): TreeState {
  let st = treeStates.get(project);
  if (!st) {
    st = { root: "", tree: [], expanded: new Set<string>(), sig: "", fetchedAt: 0 };
    treeStates.set(project, st);
  }
  return st;
}

function paintTree(tree: any[], expanded: Set<string>, sig: string) {
  lastTreeSig = sig;
  els.tree.innerHTML = "";
  for (const node of tree) els.tree.appendChild(renderNode(node, 0, expanded));
}

/** The panel is showing `project`'s workspace from now on. Called SYNCHRONOUSLY
 *  by the activation that switched the tab, before anything is claimed or
 *  fetched, so the tab bar and the workspace panel change in the same task: a
 *  switch can never be seen with the previous workspace's files under it. Coming
 *  back to a workspace paints the tree it had — no walk, no wait. */
export function enterWorkspace(project: string, root = "") {
  const next = project || "";
  if (shownWorkspace === next) {
    if (root) els.workspace.textContent = root;
    return;
  }
  shownWorkspace = next;
  treeGen++; // the walk in flight is the tab we left's
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = null;
  dropWalk();
  const st = treeStates.get(next) || NO_TREE;
  const where = root || st.root;
  els.workspace.textContent = where || ""; // nothing to name: no workspace shown
  paintTree(st.tree, st.expanded, st.sig);
}

function dropWalk() {
  if (!treeWalk) return;
  try {
    treeWalk.ctl.abort();
  } catch (e) {
    /* already over */
  }
  treeWalk = null;
}

/** Refresh the tree of the workspace ON SCREEN. One walk at a time, and only a
 *  walk that is still the current one may paint: a coalesced call (a tool result
 *  and a switch asking together) joins the walk already running instead of
 *  queueing a second one behind it.
 *
 *  A tree younger than TREE_FRESH_MS is not walked again unless `force` says so:
 *  switching back to a tab repaints what the panel already has (enterWorkspace)
 *  and must not pay for the same directory listing twice. Tool results and dir
 *  toggles force — they are the events that can make the painted tree wrong. */
export async function refreshTree(force = false) {
  const project = shownWorkspace || "";
  if (treeWalk && treeWalk.project === project) return; // this workspace is already being walked
  const st = treeState(project);
  if (!force && st.fetchedAt && Date.now() - st.fetchedAt < TREE_FRESH_MS) return;
  dropWalk(); // a walk for a workspace that is no longer on screen
  const gen = ++treeGen;
  const ctl = new AbortController();
  treeWalk = { project, ctl };
  try {
    const params = new URLSearchParams();
    if (showHidden) params.set("hidden", "1");
    for (const p of st.expanded) params.append("expanded", p);
    const qs = params.toString() ? "?" + params : "";
    const data = await apiFetch("/api/workspace/tree" + qs, { signal: ctl.signal });
    if (gen !== treeGen) return; // the panel is another workspace's: this answer is not ours
    if (data.root) {
      st.root = data.root;
      els.workspace.textContent = data.root;
    }
    const tree = data.tree || [];
    // include expansion state in the signature so a toggle always re-renders
    const sig = JSON.stringify([...st.expanded]) + "|" + JSON.stringify(tree);
    st.tree = tree;
    st.sig = sig;
    st.fetchedAt = Date.now(); // this answer is the workspace's current picture
    if (sig !== lastTreeSig) paintTree(tree, st.expanded, sig); // unchanged: keep the pixels
  } catch (e) {
    // An abandoned walk is not a failure (the pane moved to another tab). A real
    // one is never swallowed: the view would silently diverge from the disk.
    if (!(e && e.name === "AbortError")) console.warn("[tree] refresh failed", e);
  } finally {
    if (treeWalk && treeWalk.ctl === ctl) treeWalk = null;
  }
}

/** A row that says the walk for an opened dir has not answered yet.
 *
 *  With the lookahead gone, an opened dir's children only exist after its walk
 *  returns — one SSH round trip on a remote workspace. An empty box in the
 *  meantime reads as "this directory is empty", which is a different (and wrong)
 *  answer; a row that says the fetch is running is the honest one. */
function pendingRow(depth: number) {
  const row = document.createElement("div");
  row.className = "tree-node file tree-pending";
  row.style.paddingLeft = depth * 12 + "px";
  row.style.opacity = "0.55";
  row.style.fontStyle = "italic";
  row.innerHTML = `<span class="icon">·</span><span class="name">loading…</span>`;
  return row;
}

export function renderNode(node, depth, expanded: Set<string>) {
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
    const isOpen = expanded.has(node.path);
    const children = document.createElement("div");
    children.className = "tree-children";
    children.style.display = isOpen ? "" : "none";
    if (isOpen) row.querySelector(".icon").textContent = "▾";
    if (isOpen) {
      if (node.children) {
        for (const c of node.children) children.appendChild(renderNode(c, depth + 1, expanded));
      } else {
        // open, but the walk that lists it has not answered yet
        children.appendChild(pendingRow(depth + 1));
      }
    }
    row.addEventListener("click", (e) => {
      e.stopPropagation(); // don't bubble to ancestor dirs (would collapse them)
      const open = children.style.display !== "none";
      if (open) {
        expanded.delete(node.path);
        children.style.display = "none"; // instant collapse; refresh prunes deep data
        row.querySelector(".icon").textContent = "▸";
        // no walk: what is on screen is still right, and the next refresh
        // simply returns this dir without children
        return;
      }
      expanded.add(node.path);
      row.querySelector(".icon").textContent = "▾";
      // clear first: rapid toggles reuse this element
      children.innerHTML = "";
      if (node.children && node.children.length) {
        // a tree we already hold paints its children at once; a walk still
        // confirms it below (readers edit files outside the panel too)
        for (const c of node.children) children.appendChild(renderNode(c, depth + 1, expanded));
      } else {
        children.appendChild(pendingRow(depth + 1));
      }
      children.style.display = "";
      // the OPEN is what asked for this dir's contents: walk now, not in 300 ms
      // (the debounce is for a burst of tool results, not for one click)
      scheduleTreeRefresh(0);
    });
    // children are siblings of the row, so the row's hover box never covers the subtree
    wrap.appendChild(children);
  }
  return wrap;
}

