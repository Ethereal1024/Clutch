#!/usr/bin/env node
// Builds the host half: every ui/src/host/*.ts is compiled to ui/<name>.js —
// IN PLACE, at the root of ui/, which is where every resolver already looks.
//
// Why in place (and not ui/build/host/ or ui/dist/): the emitted modules are
// the ones that actually run, and every path they use is relative to their own
// file — main.ts does path.join(__dirname, "preload.js") and loadFile(
// path.join(__dirname, "index.html")), mirrors.ts reads components.mirrors.json
// beside itself, components.ts walks `..` for the repo root, prompts/ and
// transport_defaults.json sit at ui/ root. Moving the output would mean
// rewriting all of that (or shipping a shim); the sources moved instead, and the
// port kept every path exactly as the runtime needs it.
//
// Usage:
//   node build-host.js           compile src/host/*.ts -> ui/*.js     (needs tsc)
//   node build-host.js --check   fail if any emitted file is stale    (no tsc)
//
// `--check` is deliberately tsc-free: it recomputes each source's digest and
// compares it with the one the emitted file's banner records, so a checkout
// that can only run node (the Android release job,
// scripts/sync-android-host.sh) can still refuse to ship a stale module. It
// also fails on an orphan: a ui/<name>.js that carries our banner but whose
// source is gone.
//
// The emitted files are COMMITTED. `node tests/x.test.js` has to work in a bare
// checkout, and the Android host runs the same .js from a phone with libnode 18
// (no type stripping) — so the sources are the truth and the output is a build
// artifact that must be up to date, exactly like ui/renderer.js. That is also
// why typescript is pinned to an exact version (ui/package.json): a different
// compiler would re-print the same source into different bytes, and every
// committed file would show as changed.
//
// The compiling/stamping/checking itself lives in ui/build-ts.js, because the
// phone's host does the same thing one directory over (android/build-host.js).
const path = require("path");
const { createBuilder } = require("./build-ts.js");

// The prefix is specific to THIS build: ui/renderer.js has a banner of its own
// ("…edit the sources and run `npm run build`"), and a looser marker made the
// orphan sweep delete it. The Android build has its own marker for the same
// reason — it sits in a different tree, but the rule is the same one.
const BANNER_MARK = "// GENERATED FILE — do not edit; edit src/host/";

const builder = createBuilder({
  root: __dirname,
  src: path.join("src", "host"),
  config: "tsconfig.host.json",
  banner: BANNER_MARK,
  hint: "`npm run build:host`",
  label: "build-host",
  rebuild: "cd ui && npm run build:host",
  where: "ui/",
});

// exercised by tests/host-built.test.js
module.exports = {
  sources: builder.sources,
  emittedFiles: builder.emittedFiles,
  digestOf: builder.digestOf,
  BANNER_MARK,
  builder,
};

if (require.main === module) builder.cli();
