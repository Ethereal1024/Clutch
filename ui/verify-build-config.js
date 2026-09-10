#!/usr/bin/env node
// Guards electron-builder.yml against a silent packaging trap: platform
// sections do NOT override the root list. fileMatcher.js getFileMatchers() runs
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
const { getFileMatchers } = require("app-builder-lib/out/fileMatcher.js");

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
