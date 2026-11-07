// The renderer is one program, and the page now loads it as one script.
//
// The history this file's name comes from: the renderer used to be a stack of
// classic scripts that ui/index.html listed in the only order that worked (they
// shared one global scope — Electron serves the page over file://, where module
// scripts are refused — so a file could use a name declared above it and nothing
// below). The failure mode was silent: a forward reference threw during load, the
// rest of that file never ran, and the wiring it was going to do was simply
// missing. The old runner caught that by loading every file, in page order, into
// one vm context and failing on the first throw.
//
// The order is a BUILD INPUT now (ui/renderer.modules.json → ui/build-renderer.js
// → ui/renderer.js, one IIFE), so the claims this runner can still make — and the
// ones that matter — are:
//
//   1. the page loads ONE renderer script, and it is the bundle; no per-module
//      <script> is left behind, and the two files that must stay separate stay
//      separate for the reason written down (version.js is rewritten data, the
//      vendored third-party libraries are not ours to bundle);
//   2. the committed bundle IS what the sources build (a stale bundle is a page
//      running code nobody edited — the one failure a build step can introduce);
//   3. loading the bundle wires the whole program without a throw (the old
//      claim, now over one file);
//   4. it puts nothing on `window` except the five host-bridge namespaces the
//      shim publishes deliberately — that was the point of the IIFE;
//   5. the control: build with one module dropped and the load THROWS, so a green
//      run above is not a loader that swallows everything.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, uiModules } = require("./harness.js");
const { loadModules, build } = require("../ui/build-renderer.js");

const UI = path.join(__dirname, "..", "ui");
const read = (...p) => fs.readFileSync(path.join(UI, ...p), "utf8");

// Loading the bundle also kicks off the app's async work (boot.js ends with an
// async IIFE). A rejection there is not a load-time throw and is out of scope
// here, so it must not decide this runner's exit code.
process.on("unhandledRejection", () => {});

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
// to a test about the page's wiring.
function makeBox() {
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
  return box;
}

// Load one script into a fresh context. Returns { error, added } where `added`
// is what the script put on `window` (the box IS the window here).
function load(code) {
  const box = makeBox();
  const before = new Set(Object.keys(box));
  let error = null;
  try {
    vm.runInContext(code, vm.createContext(box), { filename: "renderer.js" });
  } catch (e) {
    error = e;
  }
  return { error, added: Object.keys(box).filter((k) => !before.has(k)) };
}

const describe = (r) => (r.error ? `${r.error.constructor.name}: ${r.error.message}` : "no throw");

// ---- 1) the page loads one script for the renderer ----
const html = read("index.html");
const pageScripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
const ownScripts = pageScripts.filter((s) => !s.startsWith("vendor/"));
check(ownScripts.includes("renderer.js"),
      `index.html loads the bundle (${ownScripts.join(", ")})`);
check(ownScripts.filter((s) => s === "renderer.js").length === 1,
      "exactly one renderer script — the bundle is not loaded twice");
check(!pageScripts.some((s) => s === "app.js" || s === "bridge-shim.js" || s.startsWith("js/")),
      "and no per-module script is left behind: a tag for a source file would run that file a second time, outside the IIFE");
check(pageScripts[pageScripts.length - 1] === "version.js" && pageScripts.includes("renderer.js") &&
      pageScripts.indexOf("renderer.js") < pageScripts.indexOf("version.js"),
      "the build stamp keeps its own tag, after the bundle (the release scripts rewrite it; nothing reads it at load time)");
check(pageScripts.slice(0, pageScripts.indexOf("renderer.js")).every((s) => s.startsWith("vendor/")),
      "every script before the bundle is a vendored third-party library (marked / DOMPurify / highlight / mermaid / MathJax)");

// ---- 2) the manifest is the page's list, and the bundle is the sources ----
const { bundled, separate } = loadModules();
const modules = uiModules().map((m) => m.file);
check(bundled.join() === ["bridge-shim.js", ...modules.filter((f) => !separate.includes(f))].join(),
      `the bundle's modules are the manifest's, in order (${bundled.length} files)`);
check(bundled[0] === "bridge-shim.js",
      "the host bridge is bundled first: the page must run it before anything touches window.clutch");
check(modules[modules.length - 1] === "js/boot.js" && modules[0] === "app.js",
      "first module is the entry, last module is the one that starts the app");
check(separate.join() === "version.js",
      "version.js is the only module kept out of the bundle (rewritten data, not code)");

const built = build({ bundled, separate });
const onDisk = read("renderer.js");
check(onDisk === built,
      `ui/renderer.js is what these sources build — ${built.split("\n").length} lines; ` +
      "a stale bundle ships a program nobody edited (rebuild: cd ui && npm run build)");
check(!/CLUTCH_VERSION\s*=\s*"/.test(onDisk),
      "and it does not carry the build stamp: bumping the version must not need a rebuild");

// ---- 3) loading it wires the whole program ----
const real = load(onDisk);
check(!real.error, "loading the bundle wires the page with no load-time throw (" + describe(real) + ")");
const PUBLISHED = ["clutchComponents", "clutchLocks", "clutchRun", "clutchSettings", "clutchUpdate"];
check(real.added.slice().sort().join() === PUBLISHED.join(),
      `the only names it puts on window are the host bridge's five namespaces (got ${JSON.stringify(real.added)})`);
check(/^(?:\/\/[^\n]*\n)*(?:\(\(\) => \{|\(function \(\) \{|\(function\(\)\{)/.test(onDisk),
      "and the whole renderer is inside ONE function scope (the IIFE at the top of the file)");

// ---- 4) control: a build missing a module still throws ----
// Same builder, same loader, one module dropped. If this passed, the loader above
// would pass anything and claim 3 would mean nothing.
const drop = "js/stream-view.js";
const broken = build({ bundled: bundled.filter((f) => f !== drop), separate });
const control = load(broken);
check(Boolean(control.error),
      `control: building without ${drop} makes the load throw, so a clean run above means something (${describe(control)})`);

summary("ui-load-order");
