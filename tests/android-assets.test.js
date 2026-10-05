// The Android asset assembly (scripts/sync-android-host.sh) is the ONE place the
// repo layout is mapped onto the phone package: android/host/*.js plus a
// hand-written subset of ui/*.js, because the host resolves its shared modules
// through useUI() and the Electron-only modules must NOT travel. That list has
// exactly one failure mode — a new useUI("…") or a new ui/-relative require that
// nobody added to UI_NODE — and it fails silently here and loudly on the phone:
// the Node host dies before the bridge ever binds ("Cannot find module").
//
// That is how the plugin tab shipped broken (PLUGIN_PLAN.md 零之三.3): the host
// did not name components-view.js at all, so nothing failed at boot — the app
// booted and every read on the tab ended at `no such bridge method:
// clutchComponents.list`. So this runner walks the subset the way the phone's
// boot does — every name, transitively — and refuses to let it drift.
// Run: node tests/android-assets.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness");

const ROOT = path.join(__dirname, "..");
const SYNC = path.join(ROOT, "scripts", "sync-android-host.sh");
const HOST_DIR = path.join(ROOT, "android", "host");
const UI_DIR = path.join(ROOT, "ui");

// the subset exactly as the shell spells it (one double-quoted assignment)
function uiNode() {
  const src = fs.readFileSync(SYNC, "utf8");
  const m = src.match(/^UI_NODE="([^"]*)"[ \t]*$/m);
  if (!m) throw new Error("scripts/sync-android-host.sh has no UI_NODE assignment");
  return m[1].trim().split(/\s+/);
}

// Node's own resolution for a `require("./x")`: the file, then .js
function resolveIn(dir, name) {
  for (const candidate of [name, `${name}.js`]) {
    if (fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return null;
}

function relativeRequires(dir, file) {
  const src = fs.readFileSync(path.join(dir, file), "utf8");
  return [...src.matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
}

// Electron, but only where it is legal to touch it: a shipped module may reach
// for it BEHIND the plain-node guard (ui/server-bundle.js:119-126 — under node
// the package is not even installed), never at load time, which is what a
// top-of-file `require("electron")` would be.
function unguardedElectron(src) {
  const lines = [];
  const guard = src.indexOf("process.versions.electron");
  const re = /require\("electron"\)/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const indented = /^[ \t]/.test(src.slice(lineStart, m.index));
    if (!indented || guard < 0 || guard > m.index) lines.push(src.slice(lineStart, m.index).trim());
  }
  return lines;
}

function main() {
  const list = uiNode();

  // 1. every name the host resolves with useUI() is shipped
  const named = new Set();
  for (const file of fs.readdirSync(HOST_DIR)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(HOST_DIR, file), "utf8");
    for (const m of src.matchAll(/useUI\("([^"]+)"\)/g)) named.add(m[1]);
  }
  const unnamed = [...named].filter((n) => !list.includes(n)).sort();
  check(unnamed.length === 0,
    "every useUI() name in android/host is in UI_NODE" + (unnamed.length ? `: missing ${unnamed.join(", ")}` : ""));
  check(named.has("components-view.js"), "the plugin tab's backend is one of the names the host resolves");

  // 2. …and so is everything those modules require, transitively: the phone has
  //    no repo beside it to fall back on
  const walked = new Set(list.filter((f) => f.endsWith(".js")));
  const queue = [...walked];
  const unresolved = [];
  while (queue.length) {
    const file = queue.pop();
    for (const dep of relativeRequires(UI_DIR, file)) {
      const resolved = resolveIn(UI_DIR, dep);
      if (!resolved) {
        unresolved.push(`${file} -> ${dep}`);
        continue;
      }
      if (!walked.has(resolved)) {
        walked.add(resolved);
        queue.push(resolved);
      }
    }
  }
  const absent = [...walked].filter((f) => !list.includes(f)).sort();
  check(absent.length === 0,
    "every ui/-relative require of a shipped module is shipped too" + (absent.length ? `: missing ${absent.join(", ")}` : ""));
  check(unresolved.length === 0,
    "every ui/-relative require resolves" + (unresolved.length ? `: ${unresolved.join(", ")}` : ""));

  // 3. the list is copyable as-is: no stale entry, and nothing that could walk
  //    out of ui/ (the loop in the script copies `ui/$f` verbatim)
  const stale = list.filter((f) => !fs.existsSync(path.join(UI_DIR, f)));
  check(stale.length === 0, "every UI_NODE entry exists in ui/" + (stale.length ? `: ${stale.join(", ")}` : ""));
  check(list.every((f) => /^[A-Za-z0-9._-]+$/.test(f)), "no entry carries a path separator (ui/$f stays inside ui/)");

  // 4. the copy must LOAD on the phone: no shipped module reaches for Electron
  //    at load time (the whole reason the subset is hand-written — the renderer's
  //    modules are the ones that require it, and they stay out)
  const electron = [];
  for (const f of walked) {
    for (const line of unguardedElectron(fs.readFileSync(path.join(UI_DIR, f), "utf8"))) {
      electron.push(`${f}: ${line}`);
    }
  }
  check(electron.length === 0, "no shipped module requires Electron at load time" + (electron.length ? `: ${electron.join(", ")}` : ""));

  // 5. the host's own requires, the ones the boot hits before any useUI():
  //    android/host/*.js travels whole, so they must resolve beside each other
  const hostMissing = [];
  for (const file of fs.readdirSync(HOST_DIR)) {
    if (!file.endsWith(".js")) continue;
    for (const dep of relativeRequires(HOST_DIR, file)) {
      if (!resolveIn(HOST_DIR, dep)) hostMissing.push(`${file} -> ${dep}`);
    }
  }
  check(hostMissing.length === 0, "every android/host require is copied beside it" + (hostMissing.length ? `: ${hostMissing.join(", ")}` : ""));

  summary("android-assets", "the phone's asset subset covers what the host resolves");
}

main();
