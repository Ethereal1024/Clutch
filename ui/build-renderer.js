#!/usr/bin/env node
// Builds ui/renderer.js — the whole renderer as ONE classic script.
//
// Why a bundle at all: the page runs under file:// (Electron's win.loadFile),
// where module scripts are refused, so the renderer ships as a single classic
// <script>. The SOURCES are ordinary ES modules (ui/src/renderer/*.ts) and
// boot.ts is the entry: its side-effect imports are the page's load order, and
// esbuild resolves the rest from the import graph. The program becomes one IIFE:
// nothing leaks to window, nothing can be loaded twice, and a name resolves by
// import instead of by "whatever file happened to be loaded above this one".
//
// The sources are TypeScript, so boot.ts is also the type-check entry
// (ui/tsconfig.renderer.json). tsc never sees this file's output: esbuild strips
// the types, and the two never disagree because neither is asked about the
// other's job.
//
// Usage:
//   node build-renderer.js           write ui/renderer.js      (needs esbuild)
//   node build-renderer.js --check   fail if the file on disk is stale
//
// `npm run build` is the same thing, and it is wired into `predev`, `prestart`
// and `predist` (ui/package.json): an app must never launch, and a release must
// never package, a bundle older than the sources beside it.
//
// `--check` is deliberately esbuild-free: it compares the digest of the inputs
// (which the banner records) instead of rebuilding, so a checkout that can only
// run node — the Android release job, scripts/sync-android-host.sh — can still
// refuse to ship a stale bundle. The stronger check (rebuild and compare bytes,
// which also catches a changed esbuild) is tests/ui-load-order-test.js, which
// runs where esbuild is installed.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UI_DIR = __dirname;
const SRC_DIR = path.join(UI_DIR, "src", "renderer");
const ENTRY = path.join(SRC_DIR, "boot.ts");
const OUT = path.join(UI_DIR, "renderer.js");

// Every module the bundle is made of. boot.ts is the entry, not part of this
// list's own order: the build reads the order from the imports, and the digest
// only needs the set.
function sources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(SRC_DIR, file), "utf8") }));
}

// Fingerprint of the INPUTS: every source's name, length and bytes, in name
// order. It lives in the banner so `--check` can separate a stale bundle from a
// fresh one without esbuild. Hashing the inputs rather than the output is
// deliberate: esbuild REPRINTS (roughly 10k source lines become 6k), so the
// output is not reconstructible by concatenation and cannot be checked that way.
function sourceDigest(list = sources()) {
  const h = crypto.createHash("sha256");
  for (const { file, text } of list) h.update(file + "\n" + text.length + "\n" + text);
  return h.digest("hex");
}

function bannerFor(digest) {
  return [
    "// GENERATED FILE — do not edit; edit ui/src/renderer/*.ts and run `npm run build`.",
    `// sources sha256: ${digest}`,
    "// Entry: src/renderer/boot.ts — its imports are the load order.",
  ].join("\n");
}

// `overrides` (tests only): file name -> replacement text. A control build needs
// to break one module without touching the tree, so the substitution happens at
// LOAD time, inside the bundler. That hook is why this is async: esbuild refuses
// plugins in its synchronous API, and a second, plugin-free code path would be a
// second build.
async function build({ overrides = {} } = {}) {
  const esbuild = require("esbuild");
  const replace = {
    name: "override",
    setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/]renderer[\\/][^\\/]+\.ts$/ }, (args) => {
        const file = path.basename(args.path);
        return file in overrides ? { contents: overrides[file], loader: "ts" } : undefined;
      });
    },
  };
  const result = await esbuild.build({
    absWorkingDir: UI_DIR, // the banner and the `// src/renderer/…` comments are cwd-independent
    entryPoints: [ENTRY],
    bundle: true,
    // one IIFE: the wrapper, not the sources, is what hides the modules
    format: "iife",
    // Electron 44's Chromium and the Android WebView are both far newer than
    // this floor; it exists so a syntax error fails the BUILD, not the app.
    target: "es2020",
    minify: false, // the bundle is committed and reviewed as a diff
    legalComments: "none",
    write: false,
    outfile: OUT,
    banner: { js: bannerFor(sourceDigest()) },
    plugins: Object.keys(overrides).length ? [replace] : [],
  });
  for (const w of result.warnings) {
    console.error(`build-renderer: warning: ${w.location ? w.location.file + ": " : ""}${w.text}`);
  }
  return result.outputFiles[0].text;
}

// required by tests/ui-load-order-test.js: build in memory and compare
module.exports = { sources, sourceDigest, bannerFor, build, ENTRY, OUT };

if (require.main === module) {
  Promise.resolve(CLI()).catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

function CLI() {
  if (process.argv.includes("--check")) return check();

  return main();
}

async function main() {
  const text = await build();
  fs.writeFileSync(OUT, text);
  console.log(
    `build-renderer: wrote ui/renderer.js — ${sources().length} modules, ` +
    `${text.split("\n").length} lines, ${text.length} bytes`
  );
}

// No esbuild here on purpose (see the header): recompute the input digest and
// compare it with the one the committed bundle records.
function check() {
  const expected = sourceDigest();
  const onDisk = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  const recorded = /^\/\/ sources sha256: ([0-9a-f]{64})$/m.exec(onDisk);
  if (!recorded || recorded[1] !== expected) {
    console.error(
      "build-renderer: ui/renderer.js is STALE — the sources changed and the bundle did not.\n" +
      "  Rebuild it: cd ui && npm run build\n" +
      `  sources now ${expected}, bundle ${recorded ? recorded[1] : "records no digest"}`
    );
    process.exit(1);
  }
  console.log(
    `build-renderer: up to date — ${sources().length} modules, ` +
    `${onDisk.split("\n").length} lines, sources ${expected.slice(0, 12)}…`
  );
}
