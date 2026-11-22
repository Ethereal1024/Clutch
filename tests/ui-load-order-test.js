// The renderer is one program, and the page loads it as one script.
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
// The sources are ES modules now (ui/src/renderer/*.ts) and the order they run
// in is their import graph, entered at boot.ts. ui/build-renderer.js bundles
// them into ui/renderer.js (one IIFE), and the claims that still matter are:
//
//   1. the page loads ONE renderer script, and it is the bundle; no per-module
//      <script> is left behind, and the two files that must stay separate stay
//      separate for the reason written down (version.js is rewritten data, the
//      vendored third-party libraries are not ours to bundle);
//   2. the committed bundle IS what the sources build (a stale bundle is a page
//      running code nobody edited — the one failure a build step can introduce);
//   3. every source is IN that bundle — nothing is orphaned by an import that
//      stopped reaching it;
//   4. loading the bundle wires the whole program without a throw, and puts
//      nothing on `window` except the five host-bridge namespaces the shim
//      publishes deliberately (that was the point of the IIFE);
//   5. the control: append a top-level `throw` to one source at a time and the
//      load throws — every module really runs, so a green run above is not a
//      loader that swallows everything.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary } = require("./harness.js");
const { sources, sourceDigest, build } = require("../ui/build-renderer.js");

const UI = path.join(__dirname, "..", "ui");
const SRC = path.join(UI, "src", "renderer");
const read = (...p) => fs.readFileSync(path.join(UI, ...p), "utf8");

// Loading the bundle also kicks off the app's async work (boot.ts ends with an
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
                   "clutchTunnel", "clutch", "URL", "TextDecoder", "CustomEvent", "Event"]) {
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

async function main() {
  // ---- 1) the page loads one script for the renderer ----
  const html = read("index.html");
  const pageScripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const ownScripts = pageScripts.filter((s) => !s.startsWith("vendor/"));
  check(ownScripts.includes("renderer.js"),
        `index.html loads the bundle (${ownScripts.join(", ")})`);
  check(ownScripts.filter((s) => s === "renderer.js").length === 1,
        "exactly one renderer script — the bundle is not loaded twice");
  check(!pageScripts.some((s) => s.endsWith("/app.ts") || s.endsWith("/bridge-shim.ts") || s.includes("/renderer/")),
        "and no per-module script is left behind: a tag for a source file would run that file a second time, outside the IIFE");
  check(pageScripts[pageScripts.length - 1] === "version.js" && pageScripts.indexOf("renderer.js") < pageScripts.indexOf("version.js"),
        "the build stamp keeps its own tag, after the bundle (the release scripts rewrite it; nothing reads it at load time)");
  check(pageScripts.slice(0, pageScripts.indexOf("renderer.js")).every((s) => s.startsWith("vendor/")),
        "every script before the bundle is a vendored third-party library (marked / DOMPurify / highlight / mermaid / MathJax)");

  // ---- 2) the bundle is the sources, byte for byte ----
  const onDisk = read("renderer.js");
  const built = await build();
  check(onDisk === built,
        `ui/renderer.js is what these sources build — ${built.split("\n").length} lines; ` +
        "a stale bundle ships a program nobody edited (rebuild: cd ui && npm run build)");
  check(/^\/\/ sources sha256: [0-9a-f]{64}$/m.test(onDisk) &&
        onDisk.includes(`// sources sha256: ${sourceDigest()}`),
        "and its banner records the digest of exactly the sources on disk, which is what --check reads");
  check(/^\/\/ Entry: src\/renderer\/boot\.ts/m.test(onDisk),
        "the banner names the entry module, so a reader knows where the order comes from");
  check(!/CLUTCH_VERSION\s*=\s*"/.test(onDisk),
        "and it does not carry the build stamp: bumping the version must not need a rebuild");

  // ---- 3) every source is in the bundle ----
  const files = sources().map((s) => s.file);
  const missing = files.filter((f) => !onDisk.includes(`// src/renderer/${f}\n`));
  check(missing.length === 0,
        `all ${files.length} sources are in the bundle (missing: ${missing.join(", ") || "none"}) — ` +
        "an import that stopped reaching a file would leave its code out and every test reading the file green");
  check(files.length === fs.readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).length,
        "and that set is every .ts in src/renderer (globals.d.ts is declarations: it has no code to bundle)");

  // ---- 4) loading it wires the whole program ----
  const real = load(onDisk);
  check(!real.error, "loading the bundle wires the page with no load-time throw (" + describe(real) + ")");
  const PUBLISHED = ["clutchComponents", "clutchLocks", "clutchRun", "clutchSettings", "clutchUpdate"];
  check(real.added.slice().sort().join() === PUBLISHED.join(),
        `the only names it puts on window are the host bridge's five namespaces (got ${JSON.stringify(real.added)})`);
  const body = onDisk.replace(/^(?:\/\/[^\n]*\n)+/, "");
  check(/^\(\(\) => \{/.test(body) && /\}\)\(\);\s*$/.test(body),
        "and the whole renderer is inside ONE function scope: the file is one IIFE from top to bottom");

  // ---- 5) nothing read AT LOAD comes from a module that has not run yet ----
  // Claim 4 loads the bundle and would notice a throw; this is what keeps it
  // loading. A module body runs when the import graph reaches it, and the graph
  // is one big cycle (app.ts finishes nearly last: everything imports it), so a
  // handle OWNED by a body is initialized whenever the graph gets there — the
  // failure that cost this rewrite two rounds ($ in app.ts, then els, IS_ANDROID
  // and the agent mode) and read as "app.js used to load first". It does not any
  // more, and it does not have to: a module body may read its own locals, and a
  // module that has already run. Anything else is a load-order assumption in
  // disguise, and this is the claim that names it.
  //
  // So: for every top-level statement that mentions an imported name, the module
  // that owns the name must be evaluated EARLIER. Reads inside a function body
  // are not this claim's business (they run at call time, not at load).
  const texts = new Map(sources().map((s) => [s.file, s.text]));
  const deps = new Map();
  const imports = new Map();
  for (const [file, text] of texts) {
    const from = [];
    const named = new Map();
    for (const m of text.matchAll(/^import\b([^;]*);/gm)) {
      const src = /"(\.[^"]+)"/.exec(m[1]);
      if (!src) continue;
      const dep = src[1].slice(2) + ".ts";
      from.push(dep);
      const braces = /\{([^}]*)\}/.exec(m[1]);
      if (!braces) continue;
      for (const raw of braces[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop();
        if (name) named.set(name, dep);
      }
    }
    deps.set(file, from);
    imports.set(file, named);
  }
  // the order the bundle initializes module bodies in: post-order, entry boot.ts
  const order = new Map();
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !texts.has(file)) return;
    seen.add(file);
    for (const d of deps.get(file)) walk(d);
    order.set(file, order.size);
  };
  walk("boot.ts");
  // top-level statements that read an import (an indented line is a body, and a
  // closure declaration is a value created now, not a read now). Only the part
  // of a statement BEFORE its first `=>` runs at load: what follows an arrow is
  // the code that runs when the event does.
  const reads = [];
  for (const [file, text] of texts) {
    const named = imports.get(file);
    if (!named.size) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (!line || /^[\s/*}"'`]/.test(line)) continue;
      if (/^import\b/.test(line) || /^export\s*\{/.test(line)) continue;
      if (/^export\s+(async\s+)?function\b/.test(line)) continue;
      if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\(|function\b)/.test(line)) continue;
      // A TYPE annotation is not a read, and these sources are TypeScript:
      // `let nf: { row: HTMLElement; busy: boolean } | null = null;` names an
      // imported `busy` in a type position and runs nothing. For a declaration,
      // scan its INITIALIZER (the text after the first `=` outside brackets).
      const decl = /^(export\s+)?(const|let|var)\s+\w+/.exec(line);
      if (decl) {
        let depth = 0, cut = -1;
        for (let k = decl[0].length; k < line.length; k++) {
          const c = line[k];
          if (c === "{" || c === "(" || c === "[") depth++;
          else if (c === "}" || c === ")" || c === "]") depth--;
          else if (c === "=" && depth === 0) { cut = k + 1; break; }
        }
        if (cut < 0) continue; // a declaration with no initializer reads nothing
        line = line.slice(cut);
      }
      const arrow = line.indexOf("=>");
      const now = arrow < 0 ? line : line.slice(0, arrow);
      for (const [name, dep] of named) {
        if (new RegExp("\\b" + name + "\\b").test(now)) reads.push({ file, line: i + 1, name, dep });
      }
    }
  }
  // A function declaration is initialized when its module is INSTANTIATED — before
  // any body runs — so calling one early is not the load-order bug; reading a
  // const/let/class early is, and throws. (The caveat, unchanged by this: such a
  // function must not itself touch its module's own not-yet-initialized state,
  // which is why `customSelect` and `dismissOnOverlayPress` build DOM from their
  // arguments and nothing else.)
  const hoisted = new Map();
  for (const [file, text] of texts) {
    const names = new Set();
    for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
    hoisted.set(file, names);
  }
  const late = reads.filter(
    (r) => !hoisted.get(r.dep).has(r.name) && !(order.has(r.dep) && order.get(r.dep) < order.get(r.file)));
  check(late.length === 0,
        `${reads.length} names are read in a module BODY (not inside a function or an event handler) and every one ` +
        "of them is either a function declaration (initialized before any body runs) or a value from a module " +
        `that had already run — not because boot.ts lists it first, but because the graph did ` +
        `(late: ${late.map((r) => `${r.dep}:${r.name} read by ${r.file}:${r.line}`).join(", ") || "none"})`);
  check(reads.length >= 10,
        `and that claim is not vacuous: it saw ${reads.length} such reads (a checker that sees none passes ` +
        "for no reason)");

  // ---- 6) control: every module really runs ----
  // Same builder, same loader, one source at a time as a file that throws as soon
  // as it is evaluated. If a load survived that, claim 4 would be a loader that
  // never actually executes the code it is given.
  const survivors = [];
  for (const f of files) {
    const broken = await build({ overrides: { [f]: fs.readFileSync(path.join(SRC, f), "utf8") + '\nthrow new Error("control: ' + f + '");\n' } });
    if (!load(broken).error) survivors.push(f);
  }
  check(survivors.length === 0,
        `control: each of the ${files.length} modules throws when its own code is made to throw on load ` +
        `(survivors: ${survivors.join(", ") || "none"}) — so a clean load means every module ran`);

  summary("ui-load-order");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
