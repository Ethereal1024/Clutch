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
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UI_DIR = __dirname;
const SRC_DIR = path.join(UI_DIR, "src", "host");
const CONFIG = path.join(UI_DIR, "tsconfig.host.json");
// The prefix is specific to THIS build: ui/renderer.js has a banner of its own
// ("…edit the sources and run `npm run build`"), and a looser marker made the
// orphan sweep delete it.
const BANNER_MARK = "// GENERATED FILE — do not edit; edit src/host/";

function sources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
}

// The digest is of the SOURCE, not of the output: tsc REPRINTS (a one-line
// `if (x) y();` becomes a block), so the emitted bytes are not reconstructible
// from the source text by any cheap means. Hashing the input is what makes
// `--check` answer "is this output older than the code it was made from?"
// without running the compiler.
function digestOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function bannerFor(name, digest) {
  return (
    `${BANNER_MARK}${name}.ts and run \`npm run build:host\`.\n` +
    `// source sha256: ${digest}`
  );
}

// A compiled file's text with our banner in front. One blank line after the
// banner so the generated header reads as a header, not as the first statement's
// comment.
function stamped(name, compiled) {
  const source = fs.readFileSync(path.join(SRC_DIR, name + ".ts"), "utf8");
  return bannerFor(name, digestOf(source)) + "\n\n" + compiled;
}

function compile() {
  const tsc = require.resolve("typescript/lib/tsc.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-host-"));
  try {
    const run = spawnSync(process.execPath, [tsc, "-p", CONFIG, "--outDir", tmp], {
      cwd: UI_DIR,
      encoding: "utf8",
    });
    const said = ((run.stdout || "") + (run.stderr || "")).trim();
    if (run.status !== 0) {
      if (said) console.error(said);
      throw new Error(`tsc failed (${run.status}); nothing was written`);
    }
    return { tmp, said };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function build() {
  const { tmp, said } = compile();
  const written = [];
  try {
    for (const file of sources()) {
      const name = file.replace(/\.ts$/, "");
      const compiled = fs.readFileSync(path.join(tmp, name + ".js"), "utf8");
      const out = path.join(UI_DIR, name + ".js");
      fs.writeFileSync(out, stamped(name, compiled));
      written.push(name + ".js");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (said) console.error(said);
  // An emitted file whose source is gone is deleted here, not left behind: a
  // stale module is still require-able (main.js would load it), so a phone that
  // pulled the new tree would run code no source describes.
  const orphans = emittedFiles().filter((f) => !sources().includes(f.replace(/\.js$/, ".ts")));
  for (const f of orphans) fs.rmSync(path.join(UI_DIR, f));
  return { written, orphans };
}

// Every ui/*.js carrying our banner — the emitted set, as opposed to the
// hand-written JS at ui/ root (build-renderer.js, verify-build-config.js, …).
function emittedFiles() {
  return fs
    .readdirSync(UI_DIR)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => {
      const head = fs.readFileSync(path.join(UI_DIR, f), "utf8").slice(0, BANNER_MARK.length);
      return head === BANNER_MARK;
    })
    .sort();
}

function check() {
  const bad = [];
  const list = sources();
  for (const file of list) {
    const name = file.replace(/\.ts$/, "");
    const out = path.join(UI_DIR, name + ".js");
    const expected = digestOf(fs.readFileSync(path.join(SRC_DIR, file), "utf8"));
    if (!fs.existsSync(out)) {
      bad.push(`${name}.js is MISSING (src/host/${file} has no output)`);
      continue;
    }
    const recorded = /^\/\/ source sha256: ([0-9a-f]{64})$/m.exec(fs.readFileSync(out, "utf8"));
    if (!recorded) {
      bad.push(`${name}.js has no digest banner — it was not produced by this build`);
    } else if (recorded[1] !== expected) {
      bad.push(`${name}.js is STALE (source ${expected.slice(0, 12)}…, output ${recorded[1].slice(0, 12)}…)`);
    }
  }
  for (const f of emittedFiles()) {
    if (!list.includes(f.replace(/\.js$/, ".ts"))) bad.push(`${f} has no source in src/host/ — remove it or restore the source`);
  }
  if (bad.length) {
    console.error(
      "build-host: the emitted host modules do not match src/host/:\n" +
        bad.map((b) => "  - " + b).join("\n") +
        "\n  Rebuild: cd ui && npm run build:host"
    );
    process.exit(1);
  }
  console.log(`build-host: up to date — ${list.length} modules`);
}

// exercised by tests/host-built.test.js
module.exports = { sources, emittedFiles, digestOf, BANNER_MARK };

if (require.main === module) {
  if (process.argv.includes("--check")) {
    check();
  } else {
    const { written, orphans } = build();
    console.log(
      `build-host: wrote ${written.length} modules to ui/` + (orphans.length ? `, removed ${orphans.join(", ")}` : "")
    );
  }
}
