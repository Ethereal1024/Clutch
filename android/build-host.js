#!/usr/bin/env node
// Builds the phone's host: android/host/src/*.ts -> android/host/*.js.
//
// The same thing ui/build-host.js does for the desktop, via the same
// implementation (ui/build-ts.js): compile to a temp dir, stamp each output with
// a banner naming its source and that source's sha256, write it back IN PLACE,
// delete orphans.
//
//    node android/build-host.js              compile            (needs tsc)
//    node android/build-host.js --check      stale?             (no tsc at all)
//    node android/build-host.js --typecheck  tsc --noEmit       (no emit)
//
// (the same two commands are `npm run build:host` / `npm run typecheck` inside
// android/host, whose package.json is the phone's manifest).
//
// Why the output is the SOURCE OF SHIPPING and not a build dir: the phone runs
// libnode 18.20.4, which cannot strip types, and scripts/sync-android-host.sh
// copies `android/host/*.js` whole into the APK's assets. So the emitted .js are
// committed, exactly like ui/*.js, and a source edited without a rebuild would
// ship the phone the old module while every desktop test passes.
//
// Why the sources are one level down (android/host/src/) and this file one level
// UP: everything directly inside android/host/ is copied to the phone by that
// `*.js` glob, so a build script living there would be shipped. The source
// directory is a directory, the glob is `*.js` — it travels nowhere.
//
// There is no node_modules here on purpose: the repo has exactly one TypeScript
// install (ui/node_modules, pinned to 5.9.3) and ui/build-ts.js resolves it from
// there, so building the phone's host needs no second `npm install` on a machine
// that already builds the desktop.
const path = require("path");
const { createBuilder } = require("../ui/build-ts.js");

// Its own marker: ui/*.js and android/host/*.js are swept by different builds,
// and a marker shared with another build would let one sweep delete the other's
// output (that is exactly how ui/renderer.js was once deleted).
const BANNER_MARK = "// GENERATED FILE — do not edit; edit android/host/src/";

const builder = createBuilder({
  root: path.join(__dirname, "host"),
  src: "src",
  config: path.join(__dirname, "tsconfig.host.json"),
  banner: BANNER_MARK,
  hint: "`node android/build-host.js`",
  label: "android-build-host",
  rebuild: "node android/build-host.js",
  where: "android/host/",
});

// exercised by tests/android-built.test.js
module.exports = {
  sources: builder.sources,
  emittedFiles: builder.emittedFiles,
  digestOf: builder.digestOf,
  BANNER_MARK,
  builder,
};

if (require.main === module) builder.cli();
