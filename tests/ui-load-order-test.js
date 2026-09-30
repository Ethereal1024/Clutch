// The renderer is now several files, and ui/index.html's script order is the
// contract between them: they are CLASSIC scripts sharing one global scope
// (Electron serves the page over file://, where module scripts are refused), so
// a file may use a name declared above it and nothing below. In the single-file
// renderer this could not break — a function declaration hoists over the whole
// script, so `$("#older-pill").addEventListener("click", loadOlder)` was fine
// even with loadOlder defined 1500 lines below. Split across files it is a
// ReferenceError during load: the line throws, the rest of that file never runs,
// and the wiring it was going to do is silently missing.
//
// So this runner loads the page's real script list, in page order, into one vm
// context with a universal DOM stub, and fails on the first load-time throw.
// The stub is deliberately dumb: every global, property and call answers with
// another stub (a callable, iterable proxy that stringifies to ""), which is
// enough for the top-level wiring — element lookups, addEventListener calls,
// timers — to run as it does in the browser, while any name that is NOT there
// yet still throws. It does not model the DOM and asserts nothing about
// rendering: its single claim is "every file loads in this order".
//
// The last section is the control: the same list with the first file dropped
// must FAIL, proving this runner can tell the difference (a loader that swallows
// everything would pass the page order and mean nothing).

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, uiModules } = require("./harness.js");

// Loading a script also kicks off the app's async work (boot.js ends with an
// async IIFE). A rejection there is not a load-time throw and is out of scope
// here, so it must not decide this runner's exit code.
process.on("unhandledRejection", () => {});

const MODULES = uiModules(); // in page order

// ---- the universal stub ----
// One proxy per name, cached so identity holds (els.a === els.a): callable,
// constructible, indexable, assignable, iterable, and "" when used as a string.
// `then` is undefined on purpose — an await on a stub must settle immediately
// instead of recursing forever looking for a thenable.
function makeStub() {
  const cache = new Map();
  function stub(name) {
    if (cache.has(name)) return cache.get(name);
    const p = new Proxy(function () {}, {
      get(t, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive) return () => "";
        if (prop === Symbol.iterator) return function* () {};
        if (prop === Symbol.toStringTag) return "Stub";
        if (prop === "length") return 0;
        if (prop === "nodeType") return 1;
        if (prop === "name") return name;
        return stub(name + "." + String(prop));
      },
      set() { return true; },
      has() { return true; },
      apply() { return stub(name + "()"); },
      construct() { return stub("new " + name); },
      deleteProperty() { return true; },
      ownKeys() { return []; },
      getOwnPropertyDescriptor() { return { configurable: true, enumerable: true, value: undefined }; },
    });
    cache.set(name, p);
    return p;
  }
  return stub;
}

// ---- a context with the globals the page expects to find ----
// console.warn is silenced: load-time wiring legitimately warns (e.g. the
// backend guard rejecting the stub's URL) and that noise belongs to the app, not
// to a test about load order.
function makeContext() {
  const stub = makeStub();
  const box = {};
  box.window = box;
  box.self = box;
  box.globalThis = box;
  box.console = { ...console, warn: () => {}, info: () => {} };
  for (const g of ["document", "localStorage", "sessionStorage", "navigator", "location",
                   "fetch", "EventSource", "mermaid", "marked", "DOMPurify", "hljs", "MathJax",
                   "CSS", "matchMedia", "getComputedStyle", "requestAnimationFrame",
                   "cancelAnimationFrame", "ResizeObserver", "IntersectionObserver",
                   "performance", "history", "screen", "devicePixelRatio", "clutchApi",
                   "clutchTunnel", "clutch", "URL", "TextDecoder"]) {
    box[g] = stub(g);
  }
  // timers fire at once (the boot path awaits them); nothing here needs real time
  box.setTimeout = (f) => { if (typeof f === "function") f(); return 0; };
  box.clearTimeout = () => {};
  box.setInterval = () => 0;
  box.clearInterval = () => {};
  box.queueMicrotask = (f) => queueMicrotask(f);
  box.addEventListener = () => {};
  box.removeEventListener = () => {};
  box.WebSocket = function () { return stub("WebSocket"); };
  return vm.createContext(box);
}

// Load one script into a context, returning the error it threw or null.
function load(ctx, mod) {
  try {
    vm.runInContext(mod.code, ctx, { filename: mod.file });
    return null;
  } catch (e) {
    return e;
  }
}

// ---- 1) the page's own order loads clean ----
check(MODULES.length > 1, `the page loads ${MODULES.length} renderer scripts (not one big file)`);
check(MODULES[0].file === "app.js" && MODULES[MODULES.length - 1].file === "js/boot.js",
      "first file is the entry, last file is the one that starts the app");

const ctx = makeContext();
const failures = [];
for (const mod of MODULES) {
  const err = load(ctx, mod);
  if (err) failures.push(`${mod.file}: ${err.constructor.name}: ${err.message}`);
}
check(failures.length === 0,
      "every renderer script loads in page order (no forward reference, no TDZ)" +
      (failures.length ? "\n      " + failures.join("\n      ") : ""));

// ---- 2) control: this runner can fail ----
// Same context, same loader, one file removed. A later file must then hit a name
// that is not there — if it does not, this runner would pass any order and the
// check above would mean nothing.
const ctx2 = makeContext();
const controlFailures = [];
for (const mod of MODULES.slice(1)) if (load(ctx2, mod)) controlFailures.push(mod.file);
check(controlFailures.length > 0,
      "control: dropping the first file makes a later one throw, so a green run above means something" +
      (controlFailures.length ? ` (threw: ${controlFailures.join(", ")})` : ""));

summary("ui-load-order");
