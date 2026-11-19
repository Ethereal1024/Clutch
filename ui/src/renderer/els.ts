// the page's elements — the handles a module body reaches for at LOAD time
//
// `$` (dom.ts) resolves one selector. This file resolves the ones the renderer
// keeps and hands them out by name, and it is a LEAF for the same reason dom.ts
// is: several modules touch these handles in their own body — task-input.ts wires
// the input box, render-events.ts paints the run and mode buttons, stream-text.ts
// hangs the scroll listener on the pane, settings.ts measures the textarea — and a
// module body runs when the import graph reaches it. With the renderer's cycles
// that is NOT the order boot.ts lists (app.ts finishes last: everything imports
// it), so a handle owned by a module is a handle whose initialization depends on
// who happens to be first. A leaf is initialized before any body that read it
// can run, so the read needs no order at all.
//
// The table is the chrome a panel reaches into. The pane and its record list are
// not in it: every renderer reads them by name, hundreds of times.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { $ } from "./dom";

export const els = {
  task: $("#task-input"),
  run: $("#run-btn"),
  mode: $("#mode-btn"),
  trust: $("#trust-btn"),
  status: $("#status"),
  tree: $("#tree"),
  workspace: $("#sb-workdir"),
};

// the pane every record is painted into, and the list it is painted into
export const stream = $("#stream");
export const eventsEl = document.getElementById("events");
