// the filesystem picker (open project / new project)
//
// Walks the backend's filesystem, with a tap-versus-scroll press slop and a path
// back when the remembered directory is gone.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { apiFetch } from "./app";
import { reconciledBackendUrl, switchBackend, switchBackendResolved } from "./backend-lifecycle";
import { hidePickerBody, setFsListing, showPickerBody } from "./conn-flow";
import { connStatus, renderConnSelector } from "./conn-store";
import { $ } from "./dom";
import { IS_ANDROID } from "./env";
import { createProject, openProject } from "./project";
import { closeModal, dismissOnOverlayPress, notice } from "./settings";
import { activeSlotId } from "./slots";
import { state } from "./state";
import { busy } from "./stream-view";
import { showHidden } from "./workspace-panel";

// ---- server file browser (unified open/new on the backend's filesystem) ----
export const fsModal = $("#fs-modal");
export let fsMode = "open";
export let fsPath = "";
export let fsParent = null;

// the directory on screen, by name: the default name for a new folder is the
// first "New folder" variant this listing does not already hold
let fsEntries: string[] = [];
// the inline create row, while it is open. One at a time: a second press on
// ＋ New folder returns to the one on screen instead of stacking another
let fsNewFolder: { row: HTMLElement; input: HTMLInputElement; error: HTMLElement; busy: boolean } | null = null;
// the folder just created, so the listing that replaces the row can mark it
let fsCreatedPath = "";
// the first listing after opening puts the caret where a file picker expects it
let fsFirstLoad = true;
// the rows a keyboard can land on, in list order: the arrow keys walk this
// (a row that navigates or opens — not the muted "empty" line)
let fsRows: HTMLElement[] = [];

function syncFilenameBar() {
  const name = (fsMode === "new" ? "Project name" : "File name");
  $("#fs-filename-label").textContent = name;
  ($("#fs-filename-input") as HTMLInputElement).placeholder =
    fsMode === "new" ? "my-project" : "name.clc or sub/path.clc";
}

// the primary action belongs to the field above it: with no name there is
// nothing to create, and a greyed Create says so before the press
function syncCreateAction() {
  if (fsMode !== "new") return;
  const value = ($("#fs-filename-input") as HTMLInputElement).value.trim();
  ($("#fs-create") as HTMLButtonElement).disabled = !value || !fsPath;
}

// ---- making a folder, in the list ----
//
// + New folder opens ONE row at the top of the listing with the caret already in
// it: the name is entered where the folder will appear, the way VS Code does it.
// The input starts empty with a placeholder hint. Enter — or a click anywhere else,
// which is agreement — creates it if a name was typed; Escape or confirming empty
// leaves nothing behind. There is no second button to press: the row IS the form.

// the server's refusals are already sentences for a user ("a name is required",
// "that name is reserved", "already exists: X"); only the last one names the entry
// rather than the problem, so it is the one that is said differently here
function fsMkdirError(e) {
  const msg = String((e && e.message) || e || "could not create the folder");
  const exists = /^already exists:\s*(.+)$/.exec(msg);
  return exists ? "a folder named " + exists[1] + " is already here" : msg;
}

function cancelNewFolder() {
  const nf = fsNewFolder;
  if (!nf) return;
  fsNewFolder = null; // before the row goes: its blur listener reads this
  nf.row.remove();
}

// after the row is dismissed the keyboard stays in the list, on the first entry,
// or on the button that opened it when the listing is empty — Escape is never a
// dead end
function focusAfterNewFolder() {
  const first = fsRows[0];
  if (first) first.focus();
  else ($("#fs-mkdir-btn") as HTMLButtonElement).focus();
}

function beginNewFolder() {
  if (fsNewFolder) {
    // a second press returns to the row already open instead of stacking another
    if (fsNewFolder.busy) return; // ...unless that row is still being made
    fsNewFolder.input.focus();
    return;
  }
  if (!fsPath) return;
  clearCreateOffer(); // one offer at a time: this row is the new one on the table
  const listEl = $("#fs-list");
  const row = document.createElement("div");
  row.className = "fs-row fs-edit-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "fs-inline-input";
  input.value = "";
  input.placeholder = "New folder";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "new folder name");
  const error = document.createElement("p");
  error.className = "fs-edit-error";
  error.setAttribute("role", "alert"); // a refusal is announced, not just drawn
  row.appendChild(input);
  row.appendChild(error);
  const nf = { row, input, error, busy: false };
  fsNewFolder = nf;
  input.addEventListener("keydown", (e) => {
    if (nf.busy) return; // the name is already being made: no key takes it back
    if (e.key === "Enter") {
      e.preventDefault();
      commitNewFolder();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelNewFolder();
      focusAfterNewFolder();
    }
  });
  // typing is a new attempt: the refusal above belonged to the old name
  input.addEventListener("input", () => {
    row.classList.remove("fs-edit-row-error");
    error.textContent = "";
    input.removeAttribute("aria-invalid");
  });
  // a click elsewhere agrees with the name typed here (the row commits, as a
  // desktop file manager does) — but the click's own destination keeps the caret:
  // whatever it landed on is where the user is going, not the folder just made
  input.addEventListener("blur", (e) => {
    if (fsNewFolder === nf && !nf.busy) commitNewFolder(true, (e as FocusEvent).relatedTarget as HTMLElement | null);
  });
  listEl.insertBefore(row, listEl.firstChild);
  listEl.scrollTop = 0; // the row is the first thing in the list, and the list may be scrolled
  input.focus(); // the input starts empty with a placeholder; type to name the folder
}

async function commitNewFolder(fromBlur = false, nextFocus: HTMLElement | null = null) {
  const nf = fsNewFolder;
  if (!nf || nf.busy) return;
  const name = nf.input.value.trim();
  if (!name) {
    // an empty name is not an error worth a sentence: the row simply goes
    cancelNewFolder();
    if (!fromBlur) focusAfterNewFolder(); // ...and the caret goes back where it was
    return;
  }
  const dir = fsPath;
  const token = state.fsListToken; // the listing on screen: another one means the user left
  nf.busy = true;
  nf.row.setAttribute("aria-busy", "true");
  nf.input.readOnly = true;
  try {
    const data = await apiFetch("/api/fs/mkdir", { method: "POST", body: { dir, name } });
    if (fsNewFolder !== nf) return; // the picker moved on while the folder was being made
    fsNewFolder = null;
    nf.row.remove();
    fsCreatedPath = (data && data.path) || "";
    // the folder is made, not entered: a re-list in place is the receipt, and the
    // marked row is where the next click (or Enter) goes in. A listing asked for in
    // the meantime (the click that blurred this row went somewhere) is the user's
    // answer instead — re-listing here would drag them back to the folder they left.
    if (state.fsListToken !== token) return;
    await loadDir(dir, false);
    // the caret was moved by the user, not by the create: put it back on its
    // destination (a field that survived the listing; a row it replaced is gone)
    if (fromBlur && nextFocus && nextFocus.isConnected) nextFocus.focus();
  } catch (e) {
    if (fsNewFolder !== nf) return;
    nf.busy = false;
    nf.input.readOnly = false;
    nf.row.removeAttribute("aria-busy");
    nf.row.classList.add("fs-edit-row-error");
    nf.error.textContent = fsMkdirError(e);
    nf.input.setAttribute("aria-invalid", "true");
    nf.input.focus();
    nf.input.select(); // the name is what the refusal is about: type over it
  }
}

export function openFsBrowser(mode) {
  fsMode = mode;
  fsPath = "";
  fsParent = null;
  fsEntries = [];
  fsCreatedPath = "";
  fsFirstLoad = true;
  cancelNewFolder();
  if (mode === "new") {
    $("#fs-title").textContent = "New project";
    $("#fs-create").textContent = "Create";
    $("#fs-create").classList.remove("hidden");
  } else {
    $("#fs-title").textContent = "Open project";
    $("#fs-create").classList.add("hidden");
  }
  syncFilenameBar();
  ($("#fs-filename-input") as HTMLInputElement).value = "";
  syncCreateAction();
  // Nothing is browsed until a backend answers: open with the body folded, the
  // conn bar showing what there is to connect to and the user's Connect as the
  // only door (report #1: the file list must never carry connection chatter or
  // errors, and report #3: opening the picker dials nothing on its own — loadDir
  // unfolds the body the moment it has a listing to show)
  hidePickerBody();
  // ...and the listing that will decide it is already wanted: settling the backend's
  // URL (below) comes first, and the wait for a body is the same wait either way
  setFsListing(true);
  ($("#fs-up") as HTMLButtonElement).disabled = true;
  ($("#fs-mkdir-btn") as HTMLButtonElement).disabled = true;
  $("#fs-path-input").disabled = false;
  fsModal.classList.remove("hidden", "closing");
  // Settle the stored URL against the tunnel's real state first, then list once —
  // except while a run is in flight. Opening another project is another TAB, and
  // a tab is its own session (project.ts's openProject / createProject claim one
  // for it), so this picker only browses: no project has to make way for it. It
  // browses the session of the tab it was opened from, and the reconcile asks for
  // exactly that slot: asking for the WINDOW's default one would CLAIM a second
  // session (this machine's, when the tunnel has no URL yet) and adopt it, which
  // is how a picker on a remote host came to list this machine's files. The base
  // it browses through is the one streaming the run, which is as alive as a base
  // gets, so the reconcile is what a run skips — never the picker.
  const settled = busy
    ? Promise.resolve(null)
    : reconciledBackendUrl(activeSlotId()).catch((e) => {
        // an unreachable bridge must not leave the dialog empty with no word: say
        // so and fall through, so the local listing still has a chance to appear
        notice("could not reach the backend: " + (e && e.message ? e.message : e));
        return null;
      });
  settled.then((url) => {
    if (url) switchBackend(url);
    renderConnSelector();
    // reopen where the user last left the browser instead of the home directory
    loadDir(localStorage.getItem("clutch_fs_last_dir") || "");
  });
}

export function closeFsBrowser() {
  setFsListing(false); // a closed picker browses nothing: no listing is still wanted
  cancelNewFolder(); // no row outlives the picker, and none commits on the way out
  closeModal(fsModal);
}

// Row activation is DELEGATED to #fs-list and keyed to pointerup, not to a
// per-row click listener. Why: a background re-list replaces every row (a
// backend connected from the picker re-fetches the directory a moment after the
// list is up), and a click whose mousedown target has been
// removed from the document is never dispatched at all — the tap does nothing
// at all, silently (device report: "opening another project on the phone does
// nothing"). pointerup still fires and still reaches the list, so the tap lands
// on whatever row is under the finger when it is released.
export const fsRowActions = new WeakMap(); // row element -> its activation (no leak: keyed by the row)
export const TAP_SLOP_PX = 10; // a press that travels farther than this is a scroll, not a tap
export let fsPress = null;
export let fsActivatedRow = null; // row already activated by the pointer path

export function fsTappableRowAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const row = el && el.closest ? el.closest(".fs-row") : null;
  return row && fsRowActions.has(row) ? row : null;
}

export function fsRow(label, cls = "", onClick = null) {
  const row = document.createElement("div");
  row.className = "fs-row " + cls;
  // the name is its own box so a long one ends in an ellipsis instead of wrapping
  // the row to two lines and moving every row after it
  const name = document.createElement("span");
  name.className = "fs-name";
  name.textContent = label;
  name.title = label; // ...and the full name is still there on hover
  row.appendChild(name);
  if (onClick) {
    // a row that acts is a control: it takes the caret, says so, and answers the
    // two keys a button answers
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    fsRowActions.set(row, onClick);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
    // The click listener is kept for what the pointer path cannot serve: a
    // synthetic click (assistive tech, a test, a WebView without Pointer Events)
    // has no pointerdown/up to pair with. A real tap produces both, in that
    // order, so the trailing click of an already-activated row is dropped —
    // without this the conflict offer would be asked twice for one tap.
    row.addEventListener("click", () => {
      if (fsActivatedRow === row) {
        fsActivatedRow = null; // this click IS the pointerup above: not a second tap
        return;
      }
      onClick();
    });
  }
  return row;
}
$("#fs-list").addEventListener("pointerdown", (e) => {
  fsPress = fsTappableRowAt(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
});
$("#fs-list").addEventListener("pointerup", (e) => {
  const press = fsPress;
  fsPress = null;
  if (!press) return;
  if (Math.abs(e.clientX - press.x) > TAP_SLOP_PX || Math.abs(e.clientY - press.y) > TAP_SLOP_PX) return;
  const row = fsTappableRowAt(e.clientX, e.clientY);
  if (!row) return;
  fsActivatedRow = row; // ...so the click that follows is ignored
  fsRowActions.get(row)();
});
// the browser cancels the pointer when the gesture turns into a scroll
$("#fs-list").addEventListener("pointercancel", () => {
  fsPress = null;
});
// The list is one control, so its keys are read here rather than on every row:
// ↑/↓ walk the rows that act, Home/End jump to the ends — the four keys a list
// owes a keyboard. The inline create row owns its own keys (it is an input, and
// the guard below says so).
$("#fs-list").addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target && target.tagName === "INPUT") return;
  if (!fsRows.length) return;
  const at = fsRows.indexOf(target);
  let next = -1;
  if (e.key === "ArrowDown") next = at < 0 ? 0 : Math.min(at + 1, fsRows.length - 1);
  else if (e.key === "ArrowUp") next = at <= 0 ? 0 : at - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = fsRows.length - 1;
  else if (e.key === "Backspace" && fsParent) {
    // up one level, the gesture a list owes a keyboard as well as a folder tree
    e.preventDefault();
    loadDir(fsParent);
    return;
  }
  if (next < 0) return;
  e.preventDefault();
  fsRows[next].focus();
});

// Draw the directory the backend answered with. The listing FOLLOWS the base: a
// picker that is already open re-lists the moment the host announces one
// (backend-lifecycle.ts, backend:base-changed), and no base at all means no
// listing to draw.
export async function loadDir(path, remember = true, refetched = false) {
  const listEl = $("#fs-list");
  const token = ++state.fsListToken; // latest listing request: a stale answer must not paint
  // any pending create offer belongs to the previous path: clear it
  pendingCreate = "";
  lastStatInput = "";
  if (!state.apiBase) {
    // no session, so nothing to browse: the body stays folded and the file list
    // stays empty (report #1 — a status line about the connection was drawn as if
    // it were a directory entry, and "wait for the backend then list" made the
    // list a place where a backend appears rather than a place that lists one)
    listEl.innerHTML = "";
    hidePickerBody();
    // On the phone there IS no local base to fall back to (N4): "no base" here is
    // the picker's own ask having come back empty, and a host that has a session
    // since then announces it over backend:base-changed. Ask once, the same way
    // openFsBrowser does, so a claim that landed between the two is not a picker
    // that stays folded for ever.
    if (!refetched) {
      const before = state.apiBase;
      try {
        await switchBackendResolved();
      } catch (e) {
        /* nothing to ask: stay folded, which is the honest answer */
      }
      if (token === state.fsListToken && state.apiBase && state.apiBase !== before) {
        return loadDir(path, remember, true);
      }
    }
    return;
  }
  listEl.innerHTML = '<div class="fs-row plain">loading…</div>';
  // a listing is on its way: the folded body is this wait, not the welcome bar (the
  // bar's own door reads it — see syncConnConnect in conn-flow.ts). The wait is
  // opened only where something is actually asked for, so it can only end two ways:
  // this listing answering (the finally below, if it is still the latest), or the
  // fold retiring it (hidePickerBody)
  setFsListing(true);
  try {
    const data = await apiFetch(
      "/api/fs/list?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "")
    );
    if (token !== state.fsListToken) return; // superseded while the listing was in flight
    fsPath = data.path;
    fsParent = data.parent;
    // remember the last browsed directory (re-lists pass remember=false)
    if (remember) localStorage.setItem("clutch_fs_last_dir", fsPath);
    const pathInput = $("#fs-path-input");
    pathInput.value = data.path;
    pathInput.title = data.path; // the bar is one line: the whole path on hover
    // ...and it reads from its END when it does not fit: the folder you are in is
    // the last segment, not the home directory it happens to live under
    pathInput.scrollLeft = pathInput.scrollWidth;
    // the listing that replaces these rows owns them: a create row still open (and
    // the name typed in it) belonged to the listing that is going away
    fsNewFolder = null;
    $("#fs-up").disabled = !data.parent;
    $("#fs-mkdir-btn").disabled = false;
    showPickerBody(); // there IS something to browse: the body is the picker now
    listEl.innerHTML = "";
    fsEntries = (data.entries || []).map((e) => e.name);
    fsRows = [];
    let created = null;
    const entries = data.entries || [];
    for (const e of entries) {
      const label = e.link ? e.name + " → " + e.link : e.name;
      let row;
      if (e.dir) {
        const fresh = e.path === fsCreatedPath;
        row = fsRow(label, fresh ? "dir just-created" : "dir", () => loadDir(e.path));
        if (fresh) created = row;
      } else if (e.name.endsWith(".clc") && fsMode === "open") {
        row = fsRow(label, "file clc", () => {
          closeFsBrowser();
          openProject(e.path);
        });
      } else {
        row = fsRow(label, "file plain");
      }
      listEl.appendChild(row);
      // the rows that act take the caret; a muted line of text does not
      if (row.tabIndex === 0) fsRows.push(row);
    }
    fsCreatedPath = ""; // one listing marks it: the next one is not news
    if (!entries.length) {
      // an empty folder says which of the two things it is: a place a project can
      // be made in (`new`), or a place with nothing to open (`open`)
      const empty = document.createElement("div");
      empty.className = "fs-empty";
      const glyph = document.createElement("span");
      glyph.className = "fs-empty-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "▤";
      const line = document.createElement("p");
      line.textContent = "this folder is empty";
      const hint = document.createElement("p");
      hint.className = "fs-empty-hint";
      hint.textContent = fsMode === "new" ? "＋ New folder makes one here" : "nothing to open in it";
      empty.appendChild(glyph);
      empty.appendChild(line);
      empty.appendChild(hint);
      listEl.appendChild(empty);
    }
    // The caret follows the eye: the folder just created (so Enter walks into it),
    // else the first entry, so a keyboard is never left outside the list. On a
    // fresh open it starts where the job is — the name bar in `new`, the listing in
    // `open`; never on the phone, where a focused field is a keyboard over half the
    // window the moment the picker opens.
    if (created) created.focus();
    else if (!IS_ANDROID) {
      if (fsFirstLoad && fsMode === "new") $("#fs-filename-input").focus();
      else if (fsRows.length) fsRows[0].focus();
    }
    fsFirstLoad = false;
  } catch (e) {
    if (token !== state.fsListToken) return;
    // a remembered last directory may be gone: forget it and retry from home once
    const remembered = localStorage.getItem("clutch_fs_last_dir");
    if (remembered && path === remembered) {
      localStorage.removeItem("clutch_fs_last_dir");
      loadDir("");
      return;
    }
    // A request that never landed (no .status: a refused port, an aborted wait) is
    // not a base that answered "no" — it is a base that is not there any more. The
    // far session usually is: a hop that came back, or a claim that landed after
    // this page resolved its URL, has moved the session's forward while this window
    // still holds the old one. Printing "cannot reach the backend at <dead port>"
    // then told the user their API was broken while the engine was serving it —
    // the reported "connected, the API answers, yet the app says it cannot fetch the
    // API". So ask the host for THIS window's session once (the same ask
    // openFsBrowser makes, and the one backend:base-changed would make had the page
    // been listening when it was announced) and retry the listing only if the base
    // actually moved: a host that hands the same URL back is the honest banner below.
    if (!e.status && !refetched && state.apiBase) {
      const before = state.apiBase;
      let moved = false;
      try {
        moved = await switchBackendResolved();
      } catch (err) {
        moved = false;
      }
      if (token === state.fsListToken && moved && state.apiBase && state.apiBase !== before) {
        return loadDir(path, remember, true);
      }
    }
    // the base answers nothing: there is no listing to draw, so the body folds
    // and the reason goes on the conn bar. Reaching the local machine, or another
    // host, is the Connect button's job (the old reset row that used to live here
    // was both a fake directory entry AND a second door).
    listEl.innerHTML = "";
    hidePickerBody();
    connStatus.textContent =
      "Cannot reach backend at " + state.apiBase + " (" + (e.message || e) + "). Connect again below.";
  } finally {
    // the wait is over only when THIS listing is still the one the picker is waiting
    // on: a listing superseded by another directory (or retired by a fold, which ends
    // the wait itself) leaves it to whoever took over — clearing it here would call
    // their round-trip over and put the door back mid-listing
    if (token === state.fsListToken) setFsListing(false);
  }
}

$("#fs-cancel").addEventListener("click", closeFsBrowser);
$("#fs-up").addEventListener("click", () => {
  if (fsParent) loadDir(fsParent);
});

// The address bar is the single surface for navigation, opening, and creation.
// A path that is a directory is navigated into; an existing .clc is opened; a
// path that does not exist yet is offered as a new file the user confirms with a
// second Enter (or a click on the offer row). No separate "new file" button.
let pendingCreate = "";   // "dir\x00name" while a create offer is on screen
let lastStatInput = "";   // the input that produced the current offer
function clearCreateOffer() {
  // the row is classed `create-offer` (see showCreateOffer); this query used to
  // ask for `.fs-create-offer`, so it never found one and offers stacked
  const offer = $("#fs-list").querySelector(".create-offer");
  if (offer) offer.remove();
}
function showCreateOffer(dir: string, name: string) {
  clearCreateOffer();
  // the same ＋ the button above carries: both lines make something
  const label = "＋ New: " + name;
  const row = fsRow(label, "create-offer", () => confirmCreate(dir, name));
  $("#fs-list").insertBefore(row, $("#fs-list").firstChild);
}
function confirmCreate(dir: string, name: string) {
  pendingCreate = "";
  lastStatInput = "";
  closeFsBrowser();
  createProject(dir, name);
}
async function resolvePathInput() {
  const value = ($("#fs-filename-input") as HTMLInputElement).value.trim();
  if (!value) return;
  // A second Enter on the same input that produced a create offer confirms it
  if (pendingCreate && value === lastStatInput) {
    const [dir, name] = pendingCreate.split("\x00");
    confirmCreate(dir, name);
    return;
  }
  lastStatInput = value;
  pendingCreate = "";
  clearCreateOffer();
  // Resolve relative paths against the currently browsed directory so typing
  // "foo.clc" means "foo.clc here", not "foo.clc at the browse root"
  const input = value.startsWith("/") || value.startsWith("~")
    ? value
    : (fsPath ? fsPath.replace(/\/$/, "") + "/" + value : value);
  try {
    const data = await apiFetch("/api/fs/stat?path=" + encodeURIComponent(input));
    if (data && data.error) { notice(data.error); return; }
    if (data.type === "dir") {
      loadDir(data.path);
    } else if (data.type === "file") {
      if (data.path.endsWith(".clc") && (fsMode === "open" || fsMode === "new")) {
        closeFsBrowser();
        openProject(data.path);
      } else {
        // A non-.clc file, or save mode: navigate to the containing directory
        const slash = data.path.lastIndexOf("/");
        const parent = slash >= 0 ? data.path.slice(0, slash) || "/" : fsPath;
        if (parent) loadDir(parent);
      }
    } else {
      // "none" — nothing there yet. In `new` the bar holds a NAME, and a name that
      // is not taken is the whole answer: create it here and now, no offer row and
      // no second Enter. In `open` the user is describing a PATH, so the offer row
      // says what would be created and a second Enter makes it.
      const slash = data.path.lastIndexOf("/");
      const dir = slash >= 0 ? data.path.slice(0, slash) || "/" : fsPath;
      const name = slash >= 0 ? data.path.slice(slash + 1) : data.path;
      if (!dir || !name) return;
      if (fsMode === "new") {
        confirmCreate(dir, name);
        return;
      }
      pendingCreate = dir + "\x00" + name;
      showCreateOffer(dir, name);
    }
  } catch (e) {
    notice("Could not check path: " + (e && e.message ? e.message : e));
  }
}
$("#fs-filename-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") resolvePathInput();
});
$("#fs-filename-input").addEventListener("input", () => {
  pendingCreate = "";
  lastStatInput = "";
  clearCreateOffer();
  syncCreateAction(); // the primary action is the field's own: no name, no Create
});
$("#fs-create").addEventListener("click", () => {
  const name = ($("#fs-filename-input") as HTMLInputElement).value.trim();
  if (!name || !fsPath) return;
  closeFsBrowser();
  createProject(fsPath, name);
});
// Leaving the picker is not agreement with a name that is still open in the list:
// a pointerdown on the way out lands before the row's blur would commit it, so the
// row goes without a folder being made behind the exit.
$("#fs-cancel").addEventListener("pointerdown", cancelNewFolder);
$("#fs-create").addEventListener("pointerdown", cancelNewFolder);
fsModal.addEventListener(
  "pointerdown",
  (e) => {
    if (e.target === fsModal) cancelNewFolder(); // the backdrop is an exit too
  },
  true
);

// + New folder: an editable row at the top of the listing, not a popup (see
// beginNewFolder). One button, one act.
$("#fs-mkdir-btn").addEventListener("click", beginNewFolder);

dismissOnOverlayPress(fsModal, closeFsBrowser);

// The welcome screen's two doors are the menu's two doors: "New project" asks
// WHERE first (`new` mode: pick the folder the session will work in, type the
// name, Create), "Open project" browses for an existing .clc. A project's
// working directory is the directory holding its .clc, so the location is part
// of creating one — there is no scratch project to relocate later.
// #open-project-btn / #new-project-btn are menu commands in titlebar.ts; their
// elements carry no second listener — one action, one handler.
$("#welcome-new").addEventListener("click", () => openFsBrowser("new"));
$("#welcome-open").addEventListener("click", () => openFsBrowser("open"));

