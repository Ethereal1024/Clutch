// A settings save must reach the NEXT turn of an EXISTING tab.
//
// The loop instance is cached per slot and built from the settings file, so a
// model switch used to leave every open tab on the model it was built with
// (the reported "I changed the model and the session kept the old one"). The
// fix is a fingerprint (llmSettingsRev) compared before an instance is reused,
// with one exception: never replace an instance that is mid-drive.
//
// Run: node tests/model-switch-test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-model-switch-"));
const settingsPath = path.join(home, ".clutch", "settings.json");
const saved = {
  HOME: process.env.HOME,
  UPSTREAM: process.env.CLUTCH_LLM_UPSTREAM,
  KEY: process.env.CLUTCH_API_KEY,
};

function writeSettings({ model, protocol = "", effort = "", key = "test-key" }) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      model,
      api_protocol: protocol,
      reasoning_effort: effort,
      base_url: "http://127.0.0.1:1",
      api_key: key,
    })
  );
}

function restore() {
  process.env.HOME = saved.HOME;
  if (saved.UPSTREAM === undefined) delete process.env.CLUTCH_LLM_UPSTREAM;
  else process.env.CLUTCH_LLM_UPSTREAM = saved.UPSTREAM;
  if (saved.KEY === undefined) delete process.env.CLUTCH_API_KEY;
  else process.env.CLUTCH_API_KEY = saved.KEY;
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch (e) {
    /* best effort */
  }
}

async function main() {
  process.env.HOME = home;
  process.env.CLUTCH_LLM_UPSTREAM = "http://127.0.0.1:1";
  process.env.CLUTCH_API_KEY = "test-key";

  const { llmSettingsRev } = require("../ui/run-session.js");

  // ---- 1. the fingerprint follows every fact the loop is built with ---------
  writeSettings({ model: "model-a", protocol: "", effort: "" });
  const a = llmSettingsRev();

  writeSettings({ model: "model-b", protocol: "", effort: "" });
  const b = llmSettingsRev();
  check(a !== b, "a model change changes the fingerprint (the next turn rebuilds)");

  writeSettings({ model: "model-b", protocol: "responses", effort: "" });
  const c = llmSettingsRev();
  check(b !== c, "a protocol change does too");

  writeSettings({ model: "model-b", protocol: "responses", effort: "high" });
  const d = llmSettingsRev();
  check(c !== d, "and a reasoning-effort change");

  process.env.CLUTCH_API_KEY = "another-key";
  const e = llmSettingsRev();
  check(d !== e, "and a key change (the key is fingerprinted, never logged)");

  // A round trip back to the same settings is the same fingerprint (no rebuild
  // for a save that changed nothing the loop uses).
  process.env.CLUTCH_API_KEY = "test-key";
  writeSettings({ model: "model-b", protocol: "responses", effort: "high" });
  check(llmSettingsRev() === d, "an unchanged save is the same fingerprint");

  // ---- 2. the shells compare it before reusing an instance -------------------
  const main = read("ui/src/host/main.ts");
  check(/const \{ createSessionRun, llmSettingsRev \} = require\("\.\/run-session"\);/.test(main),
    "the desktop shell imports the fingerprint");
  check(/const rev = typeof llmSettingsRev === "function" \? llmSettingsRev\(\) : "";/.test(main),
    "it computes it at the one instance-building path");
  check(/inst\.rev === rev/.test(main), "an instance from other settings is not reused");
  check(/inst\.driving/.test(main) && /inst\.driving = true;/.test(main),
    "but one that is mid-drive is never replaced (two loops on one turn)");
  check(/rev, driving: false/.test(main), "the built instance remembers what it was built from");

  const android = read("android/host/src/android-host.ts");
  check(/mod\.llmSettingsRev/.test(android) && /inst\.rev === rev/.test(android),
    "the phone's host compares the same fingerprint");
  check(/inst\.driving = true;/.test(android), "and keeps the same mid-drive exception");

  // ---- 3. the save announces itself to the status bar ------------------------
  check(/document\.dispatchEvent\(new CustomEvent\("clutch:settings-saved"\)\)/.test(read("ui/src/renderer/settings.ts")),
    "a successful settings save announces itself (the status bar's model repaints)");
  check(/addEventListener\("clutch:settings-saved", paintModel\)/.test(read("ui/src/renderer/status-bar.ts")),
    "and the status bar listens for it");

  const { fnBody } = slicer(read("ui/src/renderer/settings.ts"));
  const push = fnBody("pushSettings");
  check(push.indexOf("window.clutchSettings.save") < push.indexOf('apiFetch("/api/settings"'),
    "the mirror file is written BEFORE the live session is told: a save works with no session");
  check(/catch \(e\) \{\s*console\.warn\("\[settings\] the session did not take the update/.test(push),
    "a session that cannot answer is not a failed save");

  // ---- 4. the loop's retry notes stop looking like the user's tasks ---------
  const render = read("ui/src/renderer/render-events.ts");
  check(/\^Your previous reply contained no visible text/.test(render),
    "the empty-reply note is recognised as the loop's own");
  check(/event internal-note/.test(render),
    "and painted as a quiet retry row, not a task with a rollback gesture");
  check(/\^ERROR: The previous response hit the max_tokens limit/.test(render),
    "the max_tokens note gets the same treatment");

  restore();
  summary("model-switch-test.js");
}

main().catch((e) => {
  restore();
  console.error("FAIL:", e && (e.stack || e.message || e));
  process.exit(1);
});
