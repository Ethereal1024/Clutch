// The ~/.clutch/settings.json mirror (shared by the Electron shell and the
// Android host): the UI's localStorage is the source of truth, this flat file
// is what session children + the LLM proxy actually read. os.homedir()
// resolves per platform (Android: N2 sets HOME to the app's filesDir before
// Node boots, so the same call lands in the right place on both).
//
// ssh_secrets (below) is the one map whose source of truth IS this file: the
// tunnel layer caches the per-host auth secret (password or key passphrase)
// here, the same shape api_key already has — an explicit caller value first,
// then this file (cf. llm-proxy.js getApiKey). Like api_key it is plaintext
// in a 0600 file; forgetSshSecret (or deleting the map) clears it.
const fs = require("fs");
const os = require("os");
const path = require("path");

function mirrorPath(): string {
  return path.join(os.homedir(), ".clutch", "settings.json");
}

// The mirror as it is on disk. ABSENT (no file yet, or an empty one) is null —
// a machine that has never been configured, which every caller reads as "nothing
// set yet". A file that EXISTS and does not parse is NOT that: it is a fact about
// bytes the user may have hand-edited, and ssh_secrets — the only copy of a
// cached password — lives nowhere else. Answering "nothing set" for it is what
// let the next save, heal or forget write a one-key object over the whole file,
// so this throws instead. Every caller above already has a place to say it: the
// UI save answers {ok:false, error}, the LLM proxy answers 502 with it, a session
// start and a download fail with it.
function readMirror(): any {
  let raw: string;
  try {
    raw = fs.readFileSync(mirrorPath(), "utf-8");
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  if (!raw.trim()) return null;
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(
      `~/.clutch/settings.json cannot be read (${e && e.message}); it was left untouched — fix or delete that file`,
    );
  }
  // parses, but is not the object this file holds (an array, a number, a
  // string): the same "exists and is not readable as settings" case the parse
  // error is, just later. Folding it to {} would let the next write replace it.
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(
      `~/.clutch/settings.json does not hold a settings object; it was left untouched — fix or delete that file`,
    );
  }
  return doc;
}

// A legacy {profiles, active} file resolves to the active profile's values, the
// same rule the LLM proxy applies. An `active` name with no profile behind it is
// a broken file, not an empty config: folding it to {} would write one profile
// over all of them on the next save.
function activeProfile(cur: any): any {
  if (!cur || !cur.profiles) return cur;
  const p = cur.active ? cur.profiles[cur.active] : null;
  if (!p) {
    throw new Error(
      `~/.clutch/settings.json names LLM profile "${cur.active}" and holds no such profile; fix or delete that file`,
    );
  }
  return p;
}

// The flat mirror the backend + LLM proxy read; (re)written on every UI save.
/**
 * @param {any} data the renderer's config object ({} when nothing is set yet)
 */
function writeSettingsMirror(data) {
  const p = mirrorPath();
  const stored = readMirror() || {}; // unreadable: throws, nothing is written over it
  const secrets = stored.ssh_secrets; // not profile state: must survive the fold below
  const cur = activeProfile(stored) || {}; // legacy map: keep the active profile's values
  const upd: any = {};
  for (const k of ["base_url", "model"]) {
    if (data && data[k]) upd[k] = data[k];
  }
  if (data && data.api_key) upd.api_key = data.api_key;
  // empty string clears the knob (provider default), undefined keeps it
  if (data && data.reasoning_effort !== undefined) upd.reasoning_effort = data.reasoning_effort;
  if (data && data.api_protocol !== undefined) upd.api_protocol = data.api_protocol;
  // the source mirror (ui/net-fetch.js reads it per fetch, and the Android host's
  // artifact downloads read the same key): same rule as the knobs above — an
  // empty string clears it, undefined keeps whatever is there. It is written
  // through this path on purpose: on the phone this file is the ONLY place
  // mirrorPrefix() can read a mirror from, so a UI save is the only way to set
  // one there at all (report: downloads still needed a VPN).
  if (data && data.source_mirror !== undefined) upd.source_mirror = String(data.source_mirror || "").trim();
  const flat = Object.assign({}, cur, upd);
  if (secrets) flat.ssh_secrets = secrets;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(flat, null, 2), { mode: 0o600 });
}

// Self-heal the mirror: it is derived state that only a UI save recreates — if it
// went missing or blank while localStorage still holds the config, the next
// session silently boots with an EMPTY LLM config. Rebuild from the renderer's
// copy, but ONLY then, and never over a file that is there: an unreadable file is
// reported (readMirror) instead of replaced, and an existing readable one may hold
// intentional manual edits.
/**
 * @param {any} data the renderer's config object ({} when nothing is set yet)
 * @param {(msg: string) => void} [log] one line per heal, for the tunnel log
 * @returns {{ ok: boolean, healed: boolean }}
 */
function ensureSettingsMirror(data, log: (msg: string) => void = () => {}) {
  const cur = readMirror(); // unreadable: throws, the bytes stay where the user can fix them
  if (cur && (cur.base_url || cur.api_key || cur.model)) return { ok: true, healed: false };
  writeSettingsMirror(data);
  log("[settings] mirror missing — rebuilt ~/.clutch/settings.json from the UI config");
  return { ok: true, healed: true };
}

// The settings as the backend + LLM proxy read them back: a legacy
// {profiles, active} map resolves to the active profile. Absent is {} (callers
// treat "not configured yet" as no endpoint); unreadable THROWS, because {} here
// is a claim about the user's configuration that nobody ever checked.
function readSettings() {
  const cur = activeProfile(readMirror());
  return cur && typeof cur === "object" ? cur : {};
}

// ---- the per-host SSH secret cache (ssh_secrets) ----
//
// One entry per host, keyed the way the picker labels a host: user@host:port.
// Written when a typed secret authenticates, read back on the next connect —
// the same "explicit value first, then this file" read llm-proxy does for
// api_key. Empty string = nothing cached.

function sshSecretId(host, user, port) {
  return `${user}@${host}:${port || 22}`;
}

function readRawSettings(): any {
  // the whole file, unfurled (ssh_secrets is not profile state): absent is {},
  // unreadable throws — see readMirror
  return readMirror() || {};
}

function getSshSecret(host, user, port) {
  const cur = readRawSettings();
  const v = cur.ssh_secrets && cur.ssh_secrets[sshSecretId(host, user, port)];
  return typeof v === "string" ? v : "";
}

// what worked is reused next time (reconnect, app restart, either shell)
function saveSshSecret(host, user, port, secret) {
  const p = mirrorPath();
  const cur = readRawSettings();
  const secrets = Object.assign({}, cur.ssh_secrets || {});
  const id = sshSecretId(host, user, port);
  if (secrets[id] === String(secret)) return; // already this value: no rewrite
  secrets[id] = String(secret);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Object.assign({}, cur, { ssh_secrets: secrets }), null, 2), {
    mode: 0o600,
  });
}

// a cached secret that stops working is dropped (and one the user replaces is
// overwritten by saveSshSecret) — never a stale secret that keeps prompting
function forgetSshSecret(host, user, port) {
  const p = mirrorPath();
  const cur = readRawSettings();
  const id = sshSecretId(host, user, port);
  if (!cur.ssh_secrets || !(id in cur.ssh_secrets)) return;
  delete cur.ssh_secrets[id];
  fs.writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
}

module.exports = {
  writeSettingsMirror,
  ensureSettingsMirror,
  readSettings,
  sshSecretId,
  getSshSecret,
  saveSshSecret,
  forgetSshSecret,
};
