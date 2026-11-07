#!/usr/bin/env node
// Builds ui/renderer.js — the whole renderer as ONE classic script.
//
// Why a bundle at all: the page runs under file:// (Electron's win.loadFile),
// where module scripts are refused, so the renderer has always been a stack of
// classic scripts sharing one global scope: "load order is the contract" —
// every file could reach anything declared above it and nothing below it. That
// contract is invisible to a compiler and only checked by a vm runner that
// loads the files in page order (tests/ui-load-order-test.js). Here the order
// is a build input, and the program becomes one IIFE: nothing leaks to window,
// nothing can be loaded twice, and a name that used to resolve "because a file
// above declared it" is now an ordinary lexical binding.
//
// The input is a CONCATENATION, not ES modules: the sources are classic
// scripts that reference each other's top-level names. Importing them as
// modules would put each file in its own scope and break every cross-file
// reference; concatenating them and wrapping the result in one IIFE keeps the
// same bindings while removing the globals.
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
//
// ui/renderer.modules.json is the list (and its rationale). Every consumer —
// this build, tests/harness.js, tests/testsupport.py — reads that one file.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UI_DIR = __dirname;
const MANIFEST = path.join(UI_DIR, "renderer.modules.json");
const OUT = path.join(UI_DIR, "renderer.js");

function loadModules() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const separate = new Set(manifest.separate || []);
  // prefix first (the host bridge), then the renderer's modules in page order,
  // each exactly once
  const order = [...(manifest.prefix || []), ...manifest.modules];
  const seen = new Set();
  for (const file of order) {
    if (seen.has(file)) throw new Error(`renderer.modules.json lists ${file} twice`);
    seen.add(file);
    if (!fs.existsSync(path.join(UI_DIR, file))) {
      throw new Error(`renderer.modules.json lists ${file}, which does not exist`);
    }
  }
  for (const file of separate) {
    if (!seen.has(file)) throw new Error(`renderer.modules.json marks ${file} separate but does not list it`);
  }
  return {
    bundled: order.filter((f) => !separate.has(f)),
    separate: order.filter((f) => separate.has(f)),
  };
}

// The bytes of every bundled module, read once: the digest and the build must
// describe exactly the same inputs, or `--check` answers a different question
// than the one that was asked.
function readSources(bundled) {
  return bundled.map((file) => ({ file, text: fs.readFileSync(path.join(UI_DIR, file), "utf8") }));
}

// Fingerprint of the INPUTS: the list (bundled and separate, in order) plus every
// bundled byte. It lives in the banner so `--check` can separate a stale bundle
// from a fresh one without esbuild. Hashing the inputs rather than the output is
// deliberate: esbuild REPRINTS (roughly 10k source lines become 6k), so the
// output is not reconstructible by concatenation and cannot be checked that way.
function sourceDigest({ bundled, separate }, sources) {
  const h = crypto.createHash("sha256");
  h.update("bundled\n" + bundled.join("\n") + "\nseparate\n" + separate.join("\n") + "\n");
  for (const { file, text } of sources) h.update(file + "\n" + text.length + "\n" + text);
  return h.digest("hex");
}

function bannerFor({ bundled, separate }, digest) {
  return [
    "// GENERATED FILE — do not edit; edit the sources and run `npm run build`.",
    `// sources sha256: ${digest}`,
    "// Sources, in order (ui/renderer.modules.json):",
    ...bundled.map((f) => `//   ${f}`),
    ...(separate.length
      ? ["// loaded by index.html as its own script tag (a data file, not a module):",
         ...separate.map((f) => `//   ${f}`)]
      : []),
  ].join("\n");
}

function build({ bundled, separate }) {
  const esbuild = require("esbuild");
  const sources = readSources(bundled);
  // `;\n` between files, not a bare newline: each source is its own program
  // (automatic semicolon insertion at the file boundary used to do this job),
  // and a file that ends mid-expression must not swallow the next one's first
  // token. A lone `;` is an empty statement, so it is safe after anything.
  const contents = sources.map((s) => s.text).join("\n;\n");
  const banner = bannerFor({ bundled, separate }, sourceDigest({ bundled, separate }, sources));
  const result = esbuild.buildSync({
    stdin: { contents, resolveDir: UI_DIR, sourcefile: "renderer.js", loader: "js" },
    banner: { js: banner },
    // one IIFE: the wrapper, not the sources, is what hides the globals
    format: "iife",
    // Electron 44's Chromium and the Android WebView are both far newer than
    // this floor; it exists so a syntax error fails the BUILD, not the app.
    target: "es2020",
    minify: false, // the bundle is committed and reviewed as a diff
    legalComments: "none",
    write: false,
    outfile: OUT,
  });
  for (const w of result.warnings) {
    console.error(`build-renderer: warning: ${w.location ? w.location.file + ": " : ""}${w.text}`);
  }
  return result.outputFiles[0].text;
}

const { bundled, separate } = loadModules();

// required by tests/ui-load-order-test.js: build in memory, compare, and build
// a variant (e.g. one module dropped) as the control
module.exports = { loadModules, build, sourceDigest };

if (require.main === module) CLI({ bundled, separate });

function CLI({ bundled, separate }) {
  if (process.argv.includes("--check")) return check({ bundled, separate });

  const text = build({ bundled, separate });
  fs.writeFileSync(OUT, text);
  console.log(
    `build-renderer: wrote ui/renderer.js — ${bundled.length} modules, ` +
    `${text.split("\n").length} lines, ${text.length} bytes`
  );
}

// No esbuild here on purpose (see the header): recompute the input digest and
// compare it with the one the committed bundle records.
function check({ bundled, separate }) {
  const expected = sourceDigest({ bundled, separate }, readSources(bundled));
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
    `build-renderer: up to date — ${bundled.length} modules, ` +
    `${onDisk.split("\n").length} lines, sources ${expected.slice(0, 12)}…`
  );
}
