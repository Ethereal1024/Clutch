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
  showPickerBody(); // normal browsing: path bar + file list + (new-project area)
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
    .then(async (url) => {
      if (url) switchBackend(url);
      // reopen where the user last left the browser instead of the home directory
      loadDir(localStorage.getItem("clutch_fs_last_dir") || "");
      renderConnSelector();
      await autoReconnectAndroid(); // report #2: bring the remembered host back
    });
}

function closeFsBrowser() {
  closeModal(fsModal);
}

// Row activation is DELEGATED to #fs-list and keyed to pointerup, not to a
// per-row click listener. Why: a background re-list replaces every row (the
// phone's remembered SSH backend arriving a moment after the dialog opened
// re-fetches the directory), and a click whose mousedown target has been
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

// wait for the backend to be claimed (cold start: supervisor spawn + session
// child boot take a few seconds) so a click during that window just works
// instead of telling the user to close and re-click
function waitBackend(ms = 20000) {
  if (API_BASE) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (API_BASE || Date.now() - t0 >= ms) {
        clearInterval(iv);
        resolve(Boolean(API_BASE));
      }
    }, 200);
  });
}

async function loadDir(path, remember = true) {
  const listEl = $("#fs-list");
  if (!API_BASE) {
    // backend not claimed yet (supervisor mid-spawn): show progress and pick
    // the listing up automatically the moment the session is up
    listEl.innerHTML = '<div class="fs-row plain">connecting to backend…</div>';
    if (!(await waitBackend())) {
      listEl.innerHTML = '<div class="fs-row error-row">backend did not come up — close this dialog and retry</div>';
      return;
    }
  }
  listEl.innerHTML = '<div class="fs-row plain">loading…</div>';
  try {
    const data = await apiFetch(
      "/api/fs/list?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "")
    );
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
  } catch (e) {
    // a remembered last directory may be gone: forget it and retry from home once
    const remembered = localStorage.getItem("clutch_fs_last_dir");
    if (remembered && path === remembered) {
      localStorage.removeItem("clutch_fs_last_dir");
      loadDir("");
      return;
    }
    listEl.innerHTML = "";
    listEl.appendChild(
      fsRow(
        "Cannot reach backend at " + API_BASE + " (" + (e.message || e) + "). Reconnect SSH or check the backend URL.",
        "error-row"
      )
    );
    if (!IS_ANDROID) {
      // report #2: there is no local backend to reset to on the phone
      listEl.appendChild(
        fsRow("Reset to local backend", "action", async () => {
          localStorage.removeItem("clutch_ssh_connected");
          localStorage.removeItem("clutch_degrade"); // exiting degrade mode too
          await switchBackendResolved();
          refreshPicker();
        })
      );
    }
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

