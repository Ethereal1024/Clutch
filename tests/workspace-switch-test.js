"use strict";

// The workspace panel follows the TAB, in the same task that switches it.
//
// The reported bug: switching tabs left the workspace panel on the tab that was
// left — its tree, its root, its expansions — until a fresh `/api/workspace/tree`
// came back, which on a remote project is a walk of seconds. Flipping through
// tabs made it worse: every switch queued another walk behind the last one, and a
// walk that answered late painted ONE workspace under ANOTHER tab.
//
// So the panel's state is per project (workspace-panel.ts trees/shownWorkspace),
// a switch paints that project's last tree at once, and a refresh belongs to the
// workspace on screen: the switch aborts the walk that was the other tab's, and
// an answer that is no longer the current one is dropped instead of painted.
//
// This runner drives the REAL functions against stubs (no DOM, no backend), the
// same way tests/tab-tail-restore-test.js drives the real restore.
//
// Run: node tests/workspace-switch-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "ui", "src", "renderer", "workspace-panel.ts"), "utf8");
const { region, fnBody } = slicer(SRC);

// ---- the real code ------------------------------------------------------------
// The module-level names the tree section reads from the rest of the module, plus
// the panel's two elements, are provided as globals; everything else below is the
// renderer's own text, sliced out and run.
global.showHidden = false;
global.lastTreeSig = "";
global.treeRefreshTimer = null;
global.escapeHtml = (s) => String(s);
// the dir toggle asks for a walk through a timer; here the delays are recorded
// instead of run, so a toggle can be examined without waiting (its own scheduling
// is one line, and the panel's own tests cover the debounce)
const scheduled = [];
global.scheduleTreeRefresh = (delay) => scheduled.push(delay);

function fakeEl() {
  const el = {
    className: "",
    style: {},
    textContent: "",
    children: [],
    listeners: {},
    _html: "",
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    querySelector() {
      return fakeEl();
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return this._html;
    },
    set(v) {
      this._html = v;
      if (v === "") this.children = []; // the real element drops its children here
    },
  });
  return el;
}

const treeEl = fakeEl();
const rootEl = fakeEl();
global.els = { tree: treeEl, workspace: rootEl };
global.document = { createElement: () => fakeEl() };

// (0, eval) is indirect: the sliced text runs in the global scope, so the functions
// declared there are callable from here and close over the module state they were
// sliced with (trees / shownWorkspace / treeGen / treeWalk). `treeStates` is a
// `const`, so it stays inside that eval's scope — which is why everything that
// reads it is sliced into the SAME eval (the real scheduleTreeRefresh included;
// the global name is re-stubbed right after, so a toggle still only records).
(0, eval)(
  runnableSnippet(region("const treeStates = new Map<string, TreeState>();", "refreshTree")) +
    "\n" +
    runnableSnippet(fnBody("scheduleTreeRefresh")) +
    "\n" +
    runnableSnippet(fnBody("pendingRow")) +
    "\n" +
    runnableSnippet(fnBody("renderNode")) +
    "\nglobal.realScheduleTreeRefresh = scheduleTreeRefresh;",
);
global.scheduleTreeRefresh = (delay) => scheduled.push(delay);

// ---- the backend --------------------------------------------------------------
const calls = [];
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => warns.push(a.join(" "));

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  p.resolve = resolve;
  p.reject = reject;
  return p;
}

let nextAnswer = null; // null: answer with an empty workspace
function answer(data) {
  nextAnswer = data;
}

global.apiFetch = function (p, init = {}) {
  const d = deferred();
  calls.push({ path: p, signal: init.signal, d });
  if (nextAnswer !== null) {
    const data = nextAnswer;
    nextAnswer = null;
    Promise.resolve().then(() => d.resolve(data));
  }
  return d;
};

const tick = () => new Promise((r) => setImmediate(r));

const node = (name, dir, children) => ({
  name,
  path: name,
  dir: !!dir,
  link: null,
  ...(children ? { children } : {}),
});

// the rows the panel is showing, by name
function shown() {
  return treeEl.children.map((wrap) => wrap.children[0].children[0] && wrap.children[0]._name);
}

// a fake row carries its label through innerHTML, so read it off that
function rowName(wrap) {
  const m = /class="name"[^>]*>([^<]*)</.exec((wrap.children[0] || {}).innerHTML || "");
  return m ? m[1] : "";
}

function names() {
  return treeEl.children.map(rowName);
}

// every visible name, nested rows included
function deepNames(box = treeEl) {
  const out = [];
  for (const wrap of box.children) {
    out.push(rowName(wrap));
    const kids = wrap.children[1];
    if (kids) out.push(...deepNames(kids));
  }
  return out;
}

function rowOf(name) {
  for (const wrap of treeEl.children) {
    const row = wrap.children[0];
    const m = /class="name"[^>]*>([^<]*)</.exec(row.innerHTML || "");
    if (m && m[1] === name) return { wrap, row };
  }
  return null;
}

async function main() {
  const A = "/work/a.clc";
  const B = "/work/b.clc";
  const ROOT_A = "/work/a";
  const ROOT_B = "/work/b";

  // ---- 1. a switch paints the workspace it names, before anything is fetched
  enterWorkspace(A, ROOT_A);
  check(rootEl.textContent === ROOT_A, "switching to a tab names that tab's workspace at once");
  check(treeEl.children.length === 0, "and the previous workspace's files are gone in the same task");
  check(calls.length === 0, "without waiting for a walk of the new workspace");

  answer({ root: ROOT_A, tree: [node("src", true), node("README.md")] });
  refreshTree();
  await tick();
  check(calls.length === 1 && calls[0].path === "/api/workspace/tree",
    "the walk that follows is this workspace's: one request, no expansions yet");
  check(names().join(",") === "src,README.md", "and it paints what the host answered");
  check(rootEl.textContent === ROOT_A, "the root the host reported is the one the status bar shows");

  // ---- 2. coming back is instant: the tree it had, and no walk of its own
  enterWorkspace(B, ROOT_B);
  check(treeEl.children.length === 0 && rootEl.textContent === ROOT_B,
    "leaving a workspace for a colder one shows an EMPTY panel under the new name, never the old files");
  answer({ root: ROOT_B, tree: [node("tests", true)] });
  refreshTree();
  await tick();
  check(names().join(",") === "tests", "the second workspace's tree is its own");

  const before = calls.length;
  enterWorkspace(A, ROOT_A);
  check(names().join(",") === "src,README.md",
    "switching back paints the tree that workspace had — synchronously, from the panel's own memory");
  check(rootEl.textContent === ROOT_A, "with the root it reported, not a guess from the path");
  check(calls.length === before, "and no request at all: the files are the ones it already had");

  // ---- 3. a walk that answers after a switch may not paint
  enterWorkspace(A, ROOT_A);
  refreshTree(true); // forced: A's tree is younger than the window (see 4b)
  await tick();
  const late = calls[calls.length - 1];
  enterWorkspace(B, ROOT_B);
  check(late.signal && late.signal.aborted,
    "the switch ABORTS the walk that belonged to the tab we left (it does not queue behind it)");
  late.d.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await tick();
  check(names().join(",") === "tests", "and the abandoned answer paints nothing: the panel is still B's");
  check(rootEl.textContent === ROOT_B, "under B's root");
  check(warns.filter((w) => /refresh failed/.test(w)).length === 0,
    "an abandoned walk is not reported as a failed one");

  // ---- 3b. an answer that is not the current generation is dropped even when it
  //          arrives on its own (a host that answers a request we already left)
  enterWorkspace(A, ROOT_A);
  refreshTree(true);
  await tick();
  const raced = calls[calls.length - 1];
  enterWorkspace(B, ROOT_B);
  raced.d.resolve({ root: ROOT_A, tree: [node("stale-file")] });
  await tick();
  check(!names().includes("stale-file"), "a late answer for another workspace is dropped, not painted");
  check(rootEl.textContent === ROOT_B, "and it cannot rename the status bar's workspace either");

  // ---- 4. expansions belong to their own workspace
  enterWorkspace(A, ROOT_A);
  answer({ root: ROOT_A, tree: [node("src", true, [node("main.ts")]), node("README.md")] });
  await refreshTree(true);
  const src = rowOf("src");
  check(!!src, "a dir row is there to open");
  src.row.listeners.click[0]({ stopPropagation() {} });
  await tick();
  check(rootEl.textContent === ROOT_A, "opening a dir keeps the workspace as it was");
  check(scheduled[scheduled.length - 1] === 0,
    "and asks for that dir's walk NOW (0 ms), not on the 300 ms debounce: with no lookahead its children are not in hand");
  // the question here is whether the NEXT walk of this workspace asks for it
  // (and whether the other workspace does not)
  answer({ root: ROOT_A, tree: [node("src", true, [node("main.ts")]), node("README.md")] });
  await refreshTree(true);
  const withExp = calls[calls.length - 1];
  check(/expanded=src/.test(withExp.path), "the expansion is asked for on this workspace's next walk");

  enterWorkspace(B, ROOT_B);
  answer({ root: ROOT_B, tree: [node("tests", true)] });
  await refreshTree(true);
  const otherExp = calls[calls.length - 1];
  check(!/expanded=src/.test(otherExp.path),
    "and the tab we left's expansions do not ride into another workspace's walk");

  // ---- 4b. an opened dir whose children are not in hand says so
  //          (no lookahead: its listing is one SSH round trip away on a remote)
  const C = "/work/c.clc";
  enterWorkspace(C, "/work/c");
  answer({ root: "/work/c", tree: [node("pkg", true)] });
  await refreshTree(true);
  const pkg = rowOf("pkg");
  check(!!pkg, "a dir row the walk did not list is there to open");
  const quiet = calls.length;
  pkg.row.listeners.click[0]({ stopPropagation() {} });
  await tick();
  check(calls.length === quiet, "opening it only SCHEDULES the walk (the panel does not fetch on its own)");
  const kids = pkg.wrap.children[1];
  check(kids.children.length === 1 && /tree-pending/.test(kids.children[0].className),
    "its box holds a placeholder row instead of an empty box that would read as an empty dir");
  check(/loading/.test(kids.children[0].innerHTML), "and the row says the walk is still running");
  answer({ root: "/work/c", tree: [node("pkg", true, [node("index.ts")])] });
  await refreshTree(true);
  check(deepNames().join(",") === "pkg,index.ts", "the walk that answers replaces the placeholder with the files");

  // ---- 4c. a tree younger than the freshness window is not walked again
  //          (switching back to a tab must repaint, not re-walk)
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  const D = "/work/d.clc";
  enterWorkspace(D, "/work/d");
  answer({ root: "/work/d", tree: [node("old.txt")] });
  await refreshTree(true);
  check(names().join(",") === "old.txt", "a workspace that was never walked is walked");
  const beforeWindow = calls.length;
  enterWorkspace(A, ROOT_A);
  enterWorkspace(D, "/work/d");
  await refreshTree();
  check(calls.length === beforeWindow,
    "coming back to a tree younger than 10 s walks nothing: the panel already shows it");
  now += 20_000;
  answer({ root: "/work/d", tree: [node("old.txt"), node("new.txt")] });
  await refreshTree();
  check(calls.length === beforeWindow + 1, "a tree older than that window is walked again");
  check(names().join(",") === "old.txt,new.txt", "and the walk's answer is the one painted");
  const beforeForce = calls.length;
  answer({ root: "/work/d", tree: [node("old.txt"), node("new.txt"), node("x.txt")] });
  await refreshTree(true);
  check(calls.length === beforeForce + 1,
    "a forced walk (a tool result, a dir toggle) ignores the window: those are the events that change files");
  Date.now = realNow;

  // ---- 4d. a tool result drops EVERY cached picture, not just the shown one:
  //          a task keeps writing while the reader is looking at another tab
  const realSchedule = global.realScheduleTreeRefresh;
  enterWorkspace(A, ROOT_A);
  answer({ root: ROOT_A, tree: [node("src")] });
  await refreshTree(true);
  enterWorkspace(B, ROOT_B);
  answer({ root: ROOT_B, tree: [node("tests")] });
  await refreshTree(true);
  check(names().join(",") === "tests", "one tab's picture is on screen, the other's is only cached");
  realSchedule(0); // a tool result in either tab
  answer({ root: ROOT_B, tree: [node("tests"), node("new.txt")] });
  await new Promise((r) => setTimeout(r, 5)); // let the debounce fire
  await tick();
  check(names().join(",") === "tests,new.txt", "the tool result re-walks the workspace on screen");
  const beforeStale = calls.length;
  answer({ root: ROOT_A, tree: [node("src"), node("added.txt")] });
  enterWorkspace(A, ROOT_A);
  await refreshTree(); // NOT forced: the freshness window alone must not skip it
  check(calls.length === beforeStale + 1,
    "and the tab that was NOT on screen is not served from the window: its picture was dropped too");
  check(names().join(",") === "src,added.txt", "so its next paint is a fresh walk, not the tree it had");

  // ---- 5. no tab: the panel is nobody's workspace
  enterWorkspace("");
  check(rootEl.textContent === "" && treeEl.children.length === 0,
    "with no tab open the panel names no workspace and shows no files");

  console.warn = realWarn;
  summary("workspace-switch", "all checks passed");
}

main().catch((e) => {
  console.warn = realWarn;
  console.error(e);
  process.exit(1);
});
