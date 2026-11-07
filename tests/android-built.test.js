// The phone's host is TypeScript TOO: android/host/src/*.ts compiles to the
// android/host/*.js that scripts/sync-android-host.sh copies into the APK, and
// the phone runs libnode 18.20.4 — which cannot strip types. So the same failure
// this repo already guards for ui/ applies one tree over: a source edited
// without a rebuild is not "unsaved work", it is the phone running code nobody
// wrote, while every desktop test passes on the old module.
//
// Deliberately tsc-free (build-host.js --check only recomputes digests), like
// tests/host-built.test.js: it has to run in a bare checkout and in the Android
// release job, where `npm install` has not happened yet.
// Run: node tests/android-built.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness.js");
const { sources, emittedFiles, digestOf, BANNER_MARK } = require("../android/build-host.js");

const ROOT = path.join(__dirname, "..");
const HOST_DIR = path.join(ROOT, "android", "host");
const SRC_DIR = path.join(HOST_DIR, "src");
const SYNC = path.join(ROOT, "scripts", "sync-android-host.sh");

function main() {
  const list = sources();

  // 1. source <-> output, banner and digest
  const missing = [];
  const unbannered = [];
  const stale = [];
  for (const file of list) {
    const name = file.replace(/\.ts$/, "");
    const out = path.join(HOST_DIR, name + ".js");
    if (!fs.existsSync(out)) {
      missing.push(name + ".js");
      continue;
    }
    const text = fs.readFileSync(out, "utf8");
    if (!text.startsWith(BANNER_MARK)) unbannered.push(name + ".js");
    const recorded = /^\/\/ source sha256: ([0-9a-f]{64})$/m.exec(text);
    const expected = digestOf(fs.readFileSync(path.join(SRC_DIR, file), "utf8"));
    if (!recorded || recorded[1] !== expected) stale.push(name + ".js");
  }
  check(missing.length === 0, `every src module has an emitted module (missing: ${missing.join(",") || "—"})`);
  check(unbannered.length === 0, `every emitted module carries the generated banner (not: ${unbannered.join(",") || "—"})`);
  check(stale.length === 0, `every emitted module matches its source (stale: ${stale.join(",") || "—"} — run \`node android/build-host.js\`)`);

  // 2. the set is exactly what the phone boots: index.js is the nodejs-mobile
  // entry (NodeEngine runs `node index.js`), android-host.js is what it loads,
  // and the other two are its own dependencies. A module added to src/ without
  // being here still ships (the sync glob takes every .js), so this is a
  // "did the tree move" check, not an allow-list.
  const names = list.map((f) => f.replace(/\.ts$/, "")).sort();
  check(
    names.join(",") === "android-host,artifact-provider-android,bridge-server,index",
    `the phone's host is its four modules (found ${names.join(",")})`
  );

  // 3. nothing in android/host/*.js is hand-written: everything the sync glob
  // copies must be output of this build. A stray .js beside them would ship to
  // the phone with no source describing it — and no test would ever load it.
  const handWritten = fs
    .readdirSync(HOST_DIR)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => !emittedFiles().includes(f));
  check(handWritten.length === 0, `every android/host/*.js is generated (hand-written: ${handWritten.join(",") || "—"})`);

  // 4. no orphan: an emitted module whose source is gone is still require-able
  const orphans = emittedFiles().filter((f) => !list.includes(f.replace(/\.js$/, ".ts")));
  check(orphans.length === 0, `no emitted module outlives its source (orphans: ${orphans.join(",") || "—"})`);

  // 5. CommonJS, because the phone loads these with require() — and `index.ts`
  // is loaded by PATH (NodeEngine's entry), which is why the emit is in place.
  const esm = list.filter((f) =>
    /^exports\.[A-Za-z_$]/m.test(fs.readFileSync(path.join(HOST_DIR, f.replace(/\.ts$/, ".js")), "utf8"))
  );
  check(esm.length === 0, `no module emits ESM exports (found in: ${esm.join(",") || "—"})`);

  // 6. the sync script must still refuse a stale tree before it copies: a phone
  // that got the old bytes is only discoverable on a phone.
  const sync = fs.readFileSync(SYNC, "utf8");
  check(/^node android\/build-host\.js --check$/m.test(sync), "sync-android-host.sh checks the phone's own build before copying");
  check(/^cp android\/host\/\*\.js /m.test(sync), "the copy is still the *.js glob (src/ is a directory and must not travel)");
  check(!/cp -r? ?android\/host\/(src|\.)/m.test(sync), "no sync line copies android/host/src/ to the phone");

  summary("android-built", "the phone's host .js is built from src/ and current");
}

main();
