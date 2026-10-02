// the filesystem picker (open project / new project)
//
// Walks the backend's filesystem, with a tap-versus-scroll press slop and a path
// back when the remembered directory is gone.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// ---- server file browser (unified open/new on the backend's filesystem) ----
const fsModal = $("#fs-modal");
let fsMode = "open";
let fsPath = "";
let fsParent = null;

function openFsBrowser(mode) {
  if (busy) {
    notice("a run is active — stop it before opening another project");
    return;
  }
  fsMode = mode;
  fsPath = "";
  fsParent = null;
  $("#fs-title").textContent = mode === "new" ? "New project" : "Open project";
  $("#fs-create").classList.toggle("hidden", mode !== "new");
  $("#fs-name-input").value = "";
  // Nothing is browsed until a backend answers: open with the body folded, the
  // conn bar showing what there is to connect to and the user's Connect as the
  // only door (report #1: the file list must never carry connection chatter or
  // errors, and report #3: opening the picker dials nothing on its own — loadDir
  // unfolds the body the moment it has a listing to show)
  hidePickerBody();
  // ...and the listing that will decide it is already wanted: settling the backend's
  // URL (below) comes first, and the wait for a body is the same wait either way
  setFsListing(true);
  $("#fs-up").disabled = false;
  $("#fs-go").disabled = false;
  $("#fs-path-input").disabled = false;
  fsModal.classList.remove("hidden", "closing");
  // settle the stored URL against the tunnel's real state first, then list once
  reconciledBackendUrl()
    .catch((e) => {
      // an unreachable bridge must not leave the dialog empty with no word: say
      // so and fall through, so the local listing still has a chance to appear
      notice("could not reach the backend: " + (e && e.message ? e.message : e));
      return null;
    })
    .then((url) => {
      if (url) switchBackend(url);
      renderConnSelector();
      // reopen where the user last left the browser instead of the home directory
      loadDir(localStorage.getItem("clutch_fs_last_dir") || "");
    });
}

function closeFsBrowser() {
  setFsListing(false); // a closed picker browses nothing: no listing is still wanted
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
const fsRowActions = new WeakMap(); // row element -> its activation (no leak: keyed by the row)
const TAP_SLOP_PX = 10; // a press that travels farther than this is a scroll, not a tap
let fsPress = null;
let fsActivatedRow = null; // row already activated by the pointer path

function fsTappableRowAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const row = el && el.closest ? el.closest(".fs-row") : null;
  return row && fsRowActions.has(row) ? row : null;
}

function fsRow(label, cls, onClick) {
  const row = document.createElement("div");
  row.className = "fs-row " + cls;
  row.textContent = label;
  if (onClick) {
    fsRowActions.set(row, onClick);
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

// Draw the directory the backend answered with. The listing FOLLOWS the base: a
// picker that is already open re-lists the moment the host announces one
// (backend-lifecycle.js, backend:base-changed), and no base at all means no
// listing to draw.
async function loadDir(path, remember = true) {
  const listEl = $("#fs-list");
  const token = ++fsListToken; // latest listing request: a stale answer must not paint
  if (!API_BASE) {
    // no session, so nothing to browse: the body stays folded and the file list
    // stays empty (report #1 — a status line about the connection was drawn as if
    // it were a directory entry, and "wait for the backend then list" made the
    // list a place where a backend appears rather than a place that lists one)
    listEl.innerHTML = "";
    hidePickerBody();
    return;
  }
  listEl.innerHTML = '<div class="fs-row plain">loading…</div>';
  // a listing is on its way: the folded body is this wait, not the welcome bar (the
  // bar's own door reads it — see syncConnConnect in js/conn-flow.js). The wait is
  // opened only where something is actually asked for, so it can only end two ways:
  // this listing answering (the finally below, if it is still the latest), or the
  // fold retiring it (hidePickerBody)
  setFsListing(true);
  try {
    const data = await apiFetch(
      "/api/fs/list?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "")
    );
    if (token !== fsListToken) return; // superseded while the listing was in flight
    fsPath = data.path;
    fsParent = data.parent;
    // remember the last browsed directory (re-lists pass remember=false)
    if (remember) localStorage.setItem("clutch_fs_last_dir", fsPath);
    $("#fs-path-input").value = data.path;
    listEl.innerHTML = "";
    if (data.parent) {
      listEl.appendChild(fsRow(".. (up)", "dir", () => loadDir(data.parent)));
    }
    for (const e of data.entries) {
      const label = e.link ? e.name + " → " + e.link : e.name;
      if (e.dir) {
        listEl.appendChild(fsRow(label, "dir", () => loadDir(e.path)));
      } else if (e.name.endsWith(".clc") && fsMode === "open") {
        listEl.appendChild(
          fsRow(label, "file clc", () => {
            closeFsBrowser();
            openProject(e.path);
          })
        );
      } else {
        listEl.appendChild(fsRow(label, "file plain"));
      }
    }
    if (!listEl.children.length) listEl.appendChild(fsRow("(empty)", "plain"));
    // there IS something to browse: the body (path bar + list + actions) is the
    // picker now
    showPickerBody();
  } catch (e) {
    if (token !== fsListToken) return;
    // a remembered last directory may be gone: forget it and retry from home once
    const remembered = localStorage.getItem("clutch_fs_last_dir");
    if (remembered && path === remembered) {
      localStorage.removeItem("clutch_fs_last_dir");
      loadDir("");
      return;
    }
    // the base answers nothing: there is no listing to draw, so the body folds
    // and the reason goes on the conn bar. Reaching the local machine, or another
    // host, is the Connect button's job (the old reset row that used to live here
    // was both a fake directory entry AND a second door).
    listEl.innerHTML = "";
    hidePickerBody();
    connStatus.textContent =
      "Cannot reach backend at " + API_BASE + " (" + (e.message || e) + "). Connect again below.";
  } finally {
    // the wait is over only when THIS listing is still the one the picker is waiting
    // on: a listing superseded by another directory (or retired by a fold, which ends
    // the wait itself) leaves it to whoever took over — clearing it here would call
    // their round-trip over and put the door back mid-listing
    if (token === fsListToken) setFsListing(false);
  }
}

$("#fs-cancel").addEventListener("click", closeFsBrowser);
$("#fs-up").addEventListener("click", () => {
  if (fsParent) loadDir(fsParent);
});
$("#fs-go").addEventListener("click", () => loadDir($("#fs-path-input").value.trim()));
$("#fs-path-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadDir($("#fs-path-input").value.trim());
});
$("#fs-create").addEventListener("click", () => {
  const name = $("#fs-name-input").value.trim();
  if (!name || !fsPath) return;
  closeFsBrowser();
  createProject(fsPath, name);
});
dismissOnOverlayPress(fsModal, closeFsBrowser);

$("#new-project-btn").addEventListener("click", () => openFsBrowser("new"));
$("#open-project-btn").addEventListener("click", () => openFsBrowser("open"));
$("#welcome-new").addEventListener("click", () => openFsBrowser("new"));
$("#welcome-open").addEventListener("click", () => openFsBrowser("open"));

