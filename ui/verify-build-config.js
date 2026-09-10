#!/usr/bin/env node
// Guards electron-builder.yml against two silent packaging traps.
//
// (2) The app's own files go in through the `files` glob. ui/electron-builder.yml
// carries only an ignore ("!dev.sh"), and when a `files` list holds nothing but
// ignores electron-builder PREPENDS "**/*" (fileMatcher.js getMainFileMatchers)
// before appending its default excludes — so today everything under ui/ ships.
// Narrowing that list later (e.g. listing "**/*.js") would drop an asset the UI
// loads at runtime from file://…, and NOTHING fails: the app starts and just
// renders in the OS fallback face. The vendored fonts are asserted against the
// real matcher below.
//
// (1) Platform sections do NOT override the root list: fileMatcher.js
// getFileMatchers() runs
// addPatterns(config[name]) and then addPatterns(customBuildOptions[name]), so a
// root-level `extraResources` leaks into EVERY platform bundle and is only
// skipped at copy time with a "file source doesn't exist" warning.
//
// This runs the real loader + schema validator + file matchers (no build, no
// download) and asserts each platform resolves exactly the backend binaries it
// must bundle, with the right names (.exe on Windows). Run: node verify-build-config.js
const fs = require("fs");
const path = require("path");

const { getConfig, validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
const { getFileMatchers, getMainFileMatchers } = require("app-builder-lib/out/fileMatcher.js");

const PROJECT_DIR = __dirname;
const SRC_DIR = path.resolve(PROJECT_DIR, ".."); // extraResources `from` is relative to the project dir

// the only files each installer may carry into the app's resources dir
const EXPECTED = {
  linux: ["agent-server", "agent-supervisor"],
  mac: ["agent-server", "agent-supervisor"],
  win: ["agent-server.exe", "agent-supervisor.exe"],
};

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}

function effectiveExtraResources(config, platform) {
  const matchers = getFileMatchers(config, "extraResources", path.join("/resources"), {
    macroExpander: (it) => it,
    customBuildOptions: config[platform] || {},
    defaultSrc: SRC_DIR,
    globalOutDir: path.join(PROJECT_DIR, "dist"),
  });
  return (matchers || []).map((m) => ({ from: path.basename(m.from), to: path.basename(m.to) }));
}

// Windows needs build/icon.ico (a png/icns would be rejected) and electron-
// builder wants a 256x256 entry; NSIS embeds it as the installer icon.
function checkIco(file) {
  const b = fs.readFileSync(file);
  if (!check(b.length > 22, `${file}: too short to be an ico`)) return;
  const entries = b.readUInt16LE(4);
  check(b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1, `${file}: not an icon container`);
  let has256 = false;
  for (let i = 0; i < entries; i++) {
    const off = 6 + i * 16;
    const w = b[off] === 0 ? 256 : b[off];
    const h = b[off + 1] === 0 ? 256 : b[off + 1];
    if (w >= 256 && h >= 256) has256 = true;
  }
  check(entries > 0, `${file}: no image entries`);
  check(has256, `${file}: no 256x256 entry (electron-builder requires one)`);
}

// Assets the renderer loads at runtime from file://… . A missing webfont is not
// an error anywhere in the build: the UI silently renders in the platform's own
// fallback face, which is exactly the cross-platform drift the vendored fonts
// exist to remove. Each entry is asserted present in the packaged file set.
const REQUIRED_ASSETS = [
  "vendor/fonts/archivo-var.woff2",
  "vendor/fonts/jetbrains-mono-400.woff2",
  "vendor/fonts/clutch-icons.woff2", // the 16-glyph symbol subset (tests/ui_fonts_check.py)
  "vendor/fonts/clutch-icons.LICENSE.txt",
  "vendor/fonts/clutch-icons.manifest.txt",
  "index.html",
  "app.js",
  "style.css",
];
// …and files that must NOT ship. They prove the filter below really filters
// (a filter that says "yes" to everything would pass the list above vacuously).
const EXCLUDED_FILES = [
  "dev.sh",
  "package-lock.json",
  "vendor/fonts/README.md", // survey/licence rationale lives in the repo, not in the app
];

const FILE = { isDirectory: () => false, isFile: () => true };

// The app-dir matcher exactly as the packager builds it: real config, real
// getMainFileMatchers, real filter.
function appFileFilter(config) {
  const packager = {
    info: {
      projectDir: PROJECT_DIR,
      buildResourcesDir: "build",
      config,
      isPrepackedAppAsar: false,
      debugLogger: { isEnabled: false, add() {} },
    },
  };
  const [matcher] = getMainFileMatchers(PROJECT_DIR, "/app", (it) => it, {}, packager, path.join(PROJECT_DIR, "dist"), false);
  return (rel) => matcher.createFilter()(path.join(PROJECT_DIR, rel), FILE);
}

function checkAppFiles(config) {
  const included = appFileFilter(config);
  const unpackaged = REQUIRED_ASSETS.filter((rel) => !included(rel));
  check(unpackaged.length === 0, `app files: not packaged -> ${JSON.stringify(unpackaged)}`);
  // the glob decides what is copied; it cannot know whether the file is there,
  // so a typo'd path would sail through the check above
  const absent = REQUIRED_ASSETS.filter((rel) => !fs.existsSync(path.join(PROJECT_DIR, rel)));
  check(absent.length === 0, `app files: listed but missing on disk -> ${JSON.stringify(absent)}`);
  const leaked = EXCLUDED_FILES.filter((rel) => included(rel));
  check(leaked.length === 0, `app files: packaged but should not be -> ${JSON.stringify(leaked)}`);
  console.log(`  app   ${REQUIRED_ASSETS.length} runtime assets packaged (incl. 3 woff2), dev-only files excluded`);
}

(async () => {
  const config = await getConfig(PROJECT_DIR);
  // real schema validation: catches e.g. extraResources placed where the scheme
  // does not allow it (the docs point users at the wrong section for that)
  await validateConfiguration(config, { isEnabled: false, add: () => {} });

  for (const [platform, expected] of Object.entries(EXPECTED)) {
    const got = effectiveExtraResources(config, platform);
    const sort = (a) => a.slice().sort();
    check(
      JSON.stringify(sort(got.map((m) => m.from))) === JSON.stringify(sort(expected)),
      `${platform}: extraResources from = ${JSON.stringify(got.map((m) => m.from))}, expected ${JSON.stringify(expected)}`
    );
    // `to` is what server-bootstrap.js looks up in process.resourcesPath
    check(
      JSON.stringify(sort(got.map((m) => m.to))) === JSON.stringify(sort(expected)),
      `${platform}: extraResources to = ${JSON.stringify(got.map((m) => m.to))}, expected ${JSON.stringify(expected)}`
    );
    const icon = (config[platform] || {}).icon;
    check(icon != null, `${platform}: no icon configured`);
    if (platform === "win") check(path.extname(icon) === ".ico", `win: icon must be .ico, got ${icon}`);
    check(fs.existsSync(path.join(PROJECT_DIR, icon)), `${platform}: icon ${icon} does not exist`);
    console.log(`  ${platform.padEnd(5)} extraResources -> ${got.map((m) => m.to).join(", ")}  (icon ${icon})`);
  }

  checkIco(path.join(PROJECT_DIR, config.win.icon));
  checkAppFiles(config);

  if (failures.length > 0) {
    console.error("\nverify-build-config FAILED:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("verify-build-config OK");
})().catch((e) => {
  console.error("verify-build-config errored:", e && e.stack ? e.stack : e);
  process.exit(1);
});
