// The one TypeScript build in this repo. Compiles a tree of .ts sources IN PLACE
// next to them, stamps every output with a banner naming its source and that
// source's sha256, and refuses to let output be older than the code it was made
// from.
//
// Two callers, one implementation:
//   ui/build-host.js      ui/src/host/*.ts      -> ui/*.js          (desktop host)
//   android/build-host.js android/host/src/*.ts -> android/host/*.js (phone host)
// The parts worth sharing are exactly the ones a second copy would get subtly
// wrong: the banner digest (which is what makes `--check` work without tsc), the
// orphan sweep (an emitted module whose source is gone is still require-able),
// and "write nothing unless tsc exited 0".
//
// Emit is IN PLACE in both trees on purpose. Every module finds its neighbours,
// its preload, its JSON and its prompts from __dirname, so moving the output
// would mean rewriting paths that already work — in the phone's case paths that
// only run on a device.
//
// Usage (from a thin caller):
//   node build-host.js           compile
//   node build-host.js --check   fail if any emitted file is stale (no tsc)
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// There is exactly ONE TypeScript install in the repo (ui/node_modules, pinned
// to an exact version in ui/package.json) and every build here uses it: the
// emitted .js are committed, so a second compiler version would re-print the
// same source into different bytes and every committed file would show as
// changed.
const UI_DIR = __dirname;
const TSC = require.resolve("typescript/lib/tsc.js", { paths: [UI_DIR] });

// The digest is of the SOURCE, not of the output: tsc REPRINTS (a one-line
// `if (x) y();` becomes a block), so the emitted bytes are not reconstructible
// from the source text by any cheap means. Hashing the input is what makes
// `--check` answer "is this output older than the code it was made from?"
// without running the compiler.
function digestOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// root      absolute dir the .js land in (and that ships)
// src       path of the source dir, relative to root
// config    path of the tsconfig, relative to root
// banner    the marker the orphan sweep recognises; must be specific to this
//           build, or one build's sweep deletes the other's output
// hint      what a reader is told to run, e.g. "`npm run build:host`"
// label     prefix for messages, e.g. "build-host"
// rebuild   the command line printed when output is stale
// where     how the output dir is named in messages, e.g. "ui/"
function createBuilder({ root, src, config, banner, hint, label, rebuild, where }) {
  const srcDir = path.resolve(root, src);
  const configPath = path.resolve(root, config);

  function sources() {
    return fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .sort();
  }

  function bannerFor(name, digest) {
    return `${banner}${name}.ts and run ${hint}.\n` + `// source sha256: ${digest}`;
  }

  // A compiled file's text with our banner in front. One blank line after the
  // banner so the generated header reads as a header, not as the first
  // statement's comment.
  function stamped(name, compiled) {
    const source = fs.readFileSync(path.join(srcDir, name + ".ts"), "utf8");
    return bannerFor(name, digestOf(source)) + "\n\n" + compiled;
  }

  // Every .js in root carrying THIS build's banner — the emitted set, as opposed
  // to hand-written JS that happens to live beside it.
  function emittedFiles() {
    return fs
      .readdirSync(root)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => {
        const head = fs.readFileSync(path.join(root, f), "utf8").slice(0, banner.length);
        return head === banner;
      })
      .sort();
  }

  function compile() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), label + "-"));
    try {
      const run = spawnSync(process.execPath, [TSC, "-p", configPath, "--outDir", tmp], {
        cwd: root,
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
        fs.writeFileSync(path.join(root, name + ".js"), stamped(name, compiled));
        written.push(name + ".js");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (said) console.error(said);
    // An emitted file whose source is gone is deleted here, not left behind: a
    // stale module is still require-able, so a phone that pulled the new tree
    // would run code no source describes.
    const orphans = emittedFiles().filter((f) => !sources().includes(f.replace(/\.js$/, ".ts")));
    for (const f of orphans) fs.rmSync(path.join(root, f));
    return { written, orphans };
  }

  function check() {
    const bad = [];
    const list = sources();
    for (const file of list) {
      const name = file.replace(/\.ts$/, "");
      const out = path.join(root, name + ".js");
      const expected = digestOf(fs.readFileSync(path.join(srcDir, file), "utf8"));
      if (!fs.existsSync(out)) {
        bad.push(`${name}.js is MISSING (${src}/${file} has no output)`);
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
      if (!list.includes(f.replace(/\.js$/, ".ts"))) bad.push(`${f} has no source in ${src}/ — remove it or restore the source`);
    }
    if (bad.length) {
      console.error(
        `${label}: the emitted modules do not match ${src}/:\n` +
          bad.map((b) => "  - " + b).join("\n") +
          `\n  Rebuild: ${rebuild}`
      );
      process.exit(1);
    }
    console.log(`${label}: up to date — ${list.length} modules`);
  }

  // type-check only: the same compiler, the same config, nothing written. For a
  // tree whose committed output is what runs, "does it compile" and "is the
  // output current" are different questions (check/--check answers the second).
  function typecheck() {
    const run = spawnSync(process.execPath, [TSC, "-p", configPath, "--noEmit"], {
      cwd: root,
      stdio: "inherit",
    });
    if (run.status !== 0) process.exit(run.status === null ? 1 : run.status);
    console.log(`${label}: typecheck OK`);
  }

  // the thin callers are packaged scripts, so the CLI lives here once
  function cli() {
    if (process.argv.includes("--check")) return check();
    if (process.argv.includes("--typecheck")) return typecheck();
    const { written, orphans } = build();
    console.log(
      `${label}: wrote ${written.length} modules to ${where}` + (orphans.length ? `, removed ${orphans.join(", ")}` : "")
    );
  }

  return { root, srcDir, banner, sources, emittedFiles, digestOf, build, check, typecheck, cli };
}

module.exports = { createBuilder, digestOf };
