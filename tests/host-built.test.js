// The host half is TypeScript that COMPILES to the committed .js beside it, and
// the .js is what actually runs: the Electron main process loads main.js by
// path, node tests require("../ui/x"), scripts/sync-android-host.sh copies the
// same names to the phone's libnode 18 (which cannot strip types). So a source
// edited without a rebuild is not "unsaved work" — it is the app running code
// nobody wrote, and every test below (and the phone) would pass on the old one.
//
// This suite is the gate that says the two halves match, and it is deliberately
// tsc-free (build-host.js --check only recomputes digests): it has to run in a
// bare checkout and in the Android release job.
// Run: node tests/host-built.test.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { check, summary } = require("./harness.js");
const { sources, emittedFiles, digestOf, BANNER_MARK } = require("../ui/build-host.js");

const UI_DIR = path.join(__dirname, "..", "ui");

function main() {
  const list = sources();

  // 1. every source has output, and the output records that source's digest
  const missing = [];
  const stale = [];
  const unbannered = [];
  for (const file of list) {
    const name = file.replace(/\.ts$/, "");
    const out = path.join(UI_DIR, name + ".js");
    if (!fs.existsSync(out)) {
      missing.push(name + ".js");
      continue;
    }
    const text = fs.readFileSync(out, "utf8");
    if (!text.startsWith(BANNER_MARK)) unbannered.push(name + ".js");
    const recorded = /^\/\/ source sha256: ([0-9a-f]{64})$/m.exec(text);
    const expected = digestOf(fs.readFileSync(path.join(UI_DIR, "src", "host", file), "utf8"));
    if (!recorded || recorded[1] !== expected) stale.push(name + ".js");
  }
  check(missing.length === 0, `every src/host module has an emitted module (missing: ${missing.join(",") || "—"})`);
  check(unbannered.length === 0, `every emitted module carries the generated banner (not: ${unbannered.join(",") || "—"})`);
  check(stale.length === 0, `every emitted module matches its source (stale: ${stale.join(",") || "—"} — run \`npm run build:host\`)`);

  // 2. …and nothing in the emitted set is orphaned: a ui/*.js with our banner
  // but no source would still be require-able by main.js
  const orphans = emittedFiles().filter((f) => !list.includes(f.replace(/\.js$/, ".ts")));
  check(orphans.length === 0, `no emitted module outlives its source (orphans: ${orphans.join(",") || "—"})`);

  // 3. the set is the whole host half, and the modules that carry paths relying
  // on the emit-in-place layout are in it. main.ts is loaded BY PATH
  // (package.json "main"), preload.ts by main's __dirname, and mirrors.ts reads
  // its JSON from __dirname — a build that wrote anywhere else would break all
  // three at launch, and only at launch.
  const names = new Set(list.map((f) => f.replace(/\.ts$/, "")));
  for (const required of ["main", "preload", "mirrors", "components", "plugin-host", "run"]) {
    check(names.has(required), `src/host/${required}.ts exists (it is loaded by path, not by require)`);
  }
  check(names.size === 44, `the host half is 44 modules (found ${names.size})`);

  // 4. the emitted modules are CommonJS: they are loaded by require() here and
  // by the phone's node, and an ESM emit would make the file unloadable in that
  // slot. The scan is of the OUTPUT, not the sources: tunnel-bootstrap.ts holds a
  // Python script in a template literal ("import os, sys" on its own line), which
  // a source-text scan cannot tell from a real import.
  //
  // `Object.defineProperty(exports, "__esModule", …)` does NOT count: the
  // compiler writes it for every file (moduleDetection "force" makes each one a
  // module), and it is inert under require(). A real export is `exports.x = …`,
  // which is what would turn this file into something a reader must import.
  const esm = [];
  for (const file of list) {
    const text = fs.readFileSync(path.join(UI_DIR, file.replace(/\.ts$/, ".js")), "utf8");
    if (/^exports\.[A-Za-z_$]/m.test(text)) esm.push(file);
  }
  check(esm.length === 0, `no module emits ESM exports (found in: ${esm.join(",") || "—"})`);
  const noRequire = list.filter((f) => {
    const text = fs.readFileSync(path.join(UI_DIR, f.replace(/\.ts$/, ".js")), "utf8");
    return !/\brequire\(/.test(text) && !/module\.exports/.test(text);
  });
  check(noRequire.length === 0, `every module loads its neighbours or exports (none: ${noRequire.join(",") || "—"})`);

  // 5. no source still claims to be in the OLD type gate: the pragma made tsc
  // check a .js file opt-in, and the whole half is compiled now. A stale
  // `// @ts-check — in the type gate (ui/tsconfig.check.json …)` line would
  // point the next reader at a config that no longer exists.
  const pragmas = [];
  for (const file of list) {
    const head = fs.readFileSync(path.join(UI_DIR, "src", "host", file), "utf8").slice(0, 400);
    if (head.includes("@ts-check")) pragmas.push(file);
  }
  check(pragmas.length === 0, `no source keeps the old // @ts-check pragma (still in: ${pragmas.join(",") || "—"})`);

  // 6. the gate answers on a BARE checkout. `--check` is what
  // scripts/sync-android-host.sh runs to decide whether the committed .js match
  // their sources, and the release job that runs it (android-apk) installs no
  // ui/node_modules: the phone's build needs no packages. Requiring the
  // compiler at module load broke exactly that — the 0.2.0 APK job died with
  //   Error: Cannot find module 'typescript/lib/tsc.js'
  //     at Object.<anonymous> (ui/build-ts.js:34:21)
  // before the check could say anything — so this asserts the property
  // directly: the CLI, driven in a copy of its inputs with no node_modules
  // beside it, exits 0. Both halves are covered: android/build-host.js resolves
  // the same ui/build-ts.js, one directory up.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-bare-checkout-"));
  try {
    for (const dir of [path.join(bare, "ui"), path.join(bare, "android", "host")]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    for (const f of ["build-ts.js", "build-host.js", "tsconfig.host.json"]) {
      fs.copyFileSync(path.join(UI_DIR, f), path.join(bare, "ui", f));
    }
    fs.cpSync(path.join(UI_DIR, "src", "host"), path.join(bare, "ui", "src", "host"), { recursive: true });
    for (const f of emittedFiles()) fs.copyFileSync(path.join(UI_DIR, f), path.join(bare, "ui", f));
    fs.copyFileSync(path.join(__dirname, "..", "android", "build-host.js"), path.join(bare, "android", "build-host.js"));
    fs.cpSync(path.join(__dirname, "..", "android", "host", "src"), path.join(bare, "android", "host", "src"), {
      recursive: true,
    });
    for (const f of fs.readdirSync(path.join(__dirname, "..", "android", "host"))) {
      if (f.endsWith(".js")) fs.copyFileSync(path.join(__dirname, "..", "android", "host", f), path.join(bare, "android", "host", f));
    }
    check(!fs.existsSync(path.join(bare, "ui", "node_modules")), "the copy under test has no node_modules (a bare checkout)");
    for (const [script, label] of [
      ["ui/build-host.js", "build-host"],
      ["android/build-host.js", "android-build-host"],
    ]) {
      const r = spawnSync(process.execPath, [path.join(bare, script), "--check"], { encoding: "utf8" });
      check(
        r.status === 0 && new RegExp(`${label}: up to date`).test(r.stdout || ""),
        `${script} --check answers without typescript installed (exit ${r.status}: ${((r.stdout || "") + (r.stderr || "")).trim().split("\n")[0]})`
      );
    }
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }

  summary("host-built");
}

main();
