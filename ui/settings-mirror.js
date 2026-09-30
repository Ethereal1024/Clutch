// The ~/.clutch/settings.json mirror (shared by the Electron shell and the
// Android host): the UI's localStorage is the source of truth, this flat file
// is what session children + the LLM proxy actually read. os.homedir()
// resolves per platform (Android: N2 sets HOME to the app's filesDir before
// Node boots, so the same call lands in the right place on both).
const fs = require("fs");
const os = require("os");
const path = require("path");

// The flat mirror the backend + LLM proxy read; (re)written on every UI save.
function writeSettingsMirror(data) {
  const p = path.join(os.homedir(), ".clutch", "settings.json");
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    /* first save: start from an empty file */
  }
  if (cur && cur.profiles) {
    cur = cur.profiles[cur.active] || {}; // legacy map: keep the active profile's values
  }
  const upd = {};
  for (const k of ["base_url", "model"]) {
    if (data && data[k]) upd[k] = data[k];
  }
  if (data && data.api_key) upd.api_key = data.api_key;
  // empty string clears the knob (provider default), undefined keeps it
  if (data && data.reasoning_effort !== undefined) upd.reasoning_effort = data.reasoning_effort;
  if (data && data.api_protocol !== undefined) upd.api_protocol = data.api_protocol;
  const flat = Object.assign({}, cur, upd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(flat, null, 2), { mode: 0o600 });
}

// Self-heal the mirror: it is derived state that only a UI save recreates —
// if it went missing/corrupt while localStorage still holds the config, the
// next session silently boots with an EMPTY LLM config. Rebuild from the
// renderer's copy, but ONLY when the file is missing/blank/corrupt: an
// existing file may hold intentional manual edits.
function ensureSettingsMirror(data, log = () => {}) {
  let cur = null;
  try {
    cur = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".clutch", "settings.json"), "utf-8"));
  } catch (e) {
    /* missing/corrupt: heal below */
  }
  if (cur && (cur.base_url || cur.api_key || cur.model)) return { ok: true, healed: false };
  writeSettingsMirror(data);
  log("[settings] mirror missing — rebuilt ~/.clutch/settings.json from the UI config");
  return { ok: true, healed: true };
}

// The settings as the backend + LLM proxy read them back: a legacy
// {profiles, active} map resolves to the active profile, anything unreadable to
// {} (callers treat "absent" as "no endpoint configured yet").
function readSettings() {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".clutch", "settings.json"), "utf-8"));
  } catch (e) {
    return {};
  }
  if (cur && cur.profiles) return cur.profiles[cur.active] || {};
  return cur && typeof cur === "object" ? cur : {};
}

module.exports = { writeSettingsMirror, ensureSettingsMirror, readSettings };
