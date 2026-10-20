// The mirrors a shipped source is read through when the release host cannot be
// reached — and the policy that decides WHEN that happens.
//
// ui/net-fetch.js already has a mirror: ONE prefix, from CLUTCH_SOURCE_MIRROR or
// source_mirror in ~/.clutch/settings.json, applied to every shipped source before
// anything is read. That one is a decision the user makes up front, and it moves
// the MANIFEST reads too (the plugin page's market). This file is the list BEHIND
// it: accelerators this build ships, plus whatever the user adds, tried in turn
// when a source fails for a reason that looks like the network rather than a
// reason the source itself gave.
//
// Two facts make that safe, and both are upstream of here:
//
//   * a prefix is applied to the URL and nothing else — a mirror serves the same
//     path, and every digest is still weighed against the release's own pin
//     (ui/components.js, agent/tools/components.py accept()), so a mirror that
//     serves other bytes is refused rather than believed;
//   * an ANSWER is never retried. A 404, a schema this client cannot read, a body
//     that does not hash to the pin, a platform the release published nothing
//     for: a mirror carries the same bytes, so a second ask gets the same one.
//     Only a failure that says "this machine could not reach it" is worth trying
//     somewhere else, which is what `looksLikeNetwork` decides — deliberately a
//     small classifier, because being wrong costs one wasted request and being
//     silent costs the install.
//
// The order is the user's list first, then the one this build ships: the same
// convention the market uses (ui/components.js `readIndex()` — live index, then
// `~/.clutch/market/index.json`, then `ui/market.snapshot.json`), so a user can
// put an accelerator of their own in front of the shipped one. The shipped
// entries are view-only — they are what a fallback IS, and a build whose list
// could be emptied from the UI would lose the feature silently. `source_mirror`
// outranks all of it: it moves every read, manifest included, so while it is set
// there is nothing left for a per-source fallback to do.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { mirrorPrefix, normalize } = require("./net-fetch");

// The one place the shipped list is read from is __dirname, i.e. inside the asar
// once packaged (ui/verify-build-config.js asserts it is in the bundle): dropped
// from the bundle, this build falls back to nothing, which is the pre-existing
// behavior rather than a crash.
const BUILTIN_FILE = path.join(__dirname, "components.mirrors.json");
const USER_FILE = path.join(os.homedir(), ".clutch", "components.mirrors.json");
const SCHEMA = 1;

// --------------------------------------------------------------- the list --

// What a value has to be to be a mirror: an http(s) prefix with a host. This is
// the ONE rule for every path into the list — a file written by hand, the field
// in the UI, a caller that names its own array — so a value that works typed is a
// value that works written down.
//
// A bare host ("gh-proxy.com", the way a user writes one) is read as https: the
// scheme is the one thing a mirror cannot have a preference about. Everything
// else is dropped rather than obeyed, because a prefix is applied to every source
// at once: obeying a typo rewrites the whole supply line into a URL nobody serves
// and reports a network failure for it.
function asMirror(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  // the host has to be there: "https:///srv/mirror" is a URL a parser will happily
  // read as the host "srv", and every source rewritten under it would be fetched
  // from a machine that does not exist
  if (!withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0]) return "";
  const url = normalize(withScheme);
  if (!url) return ""; // not http(s): a path on disk, a bare word, a file: URL
  try {
    return new URL(url).hostname ? url : ""; // "https://" is a typo, not a prefix
  } catch (e) {
    return ""; // normalize accepted it, a URL parser will not
  }
}

// One mirror list, in the shape the source lists use: `{schema, mirrors: [...]}`.
// An unreadable file is [], never a throw — a build with no list falls back to
// nothing, and a user's file that got mangled must not take the install path down
// with it.
function readList(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return [];
  }
  if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.mirrors)) return [];
  const out = [];
  for (const raw of parsed.mirrors) {
    const url = asMirror(raw);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

// Every mirror this machine would try, in the order it tries them, each one
// saying where it came from: `{url, source}` with source "user" or "builtin". The
// page draws this list (ui/js/components-panel.js), so "which is yours and which
// came with the build" has to travel with the rows — an entry nobody can remove
// that looks like every removable one is a button that does nothing.
function entries() {
  const out = [];
  const seen = new Set();
  for (const [file, source] of [[USER_FILE, "user"], [BUILTIN_FILE, "builtin"]]) {
    for (const url of readList(file)) {
      if (seen.has(url)) continue; // one entry per prefix, whichever list named it first
      seen.add(url);
      out.push({ url, source });
    }
  }
  return out;
}

// The same list as plain prefixes: what a fallback actually tries.
function candidates() {
  return entries().map((e) => e.url);
}

// The prefix this machine is FORCED to read through (ui/net-fetch.js), or "". With
// one set, every shipped source was already rewritten before anything was read —
// manifest and artifact alike — so there is nothing left to fall back to.
function forced() {
  return mirrorPrefix();
}

// Which mirror a URL is already being read through, or "". A URL under a prefix
// is not a URL to prefix again: `<a>/<b>/https://…` is served by nobody, so both
// `fallbackFor` and ui/components.js ask this before they rewrite anything.
function viaPrefix(url) {
  const u = String(url || "");
  for (const p of [mirrorPrefix(), ...candidates()]) {
    if (p && u.startsWith(p + "/")) return p;
  }
  return "";
}

// ------------------------------------------------------------ the policy --

// The prefixes worth trying when `source` could not be read, in order, or [].
//
// `explicit` is the caller's own answer, spelled the way the source list spells
// it: an ARRAY is exactly that list (a test, a packager pointing a build at a LAN
// index), `false` is "no fallback, ever", and null/undefined is this machine's
// configuration — the user's list, then the shipped one.
//
// Three sources have no fallback at all, and each is a real case:
//
//   * a source that is not http(s) — a path on disk has no mirror;
//   * a source ALREADY under a prefix (written pre-mirrored by hand, or moved by
//     `source_mirror`), which is a URL to prefix once, not twice;
//   * any source at all while `source_mirror`/CLUTCH_SOURCE_MIRROR is set: that
//     knob already moved every one of them, so a second attempt would be the same
//     read against the same prefix.
function fallbackFor(source, explicit = null) {
  if (explicit === false) return [];
  const url = String(source || "");
  if (!/^https?:\/\//i.test(url)) return [];
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (e) {
    return [];
  }
  // <prefix>/<an absolute url>: the shape `mirrored()` writes, so an already
  // mirrored URL is recognized without knowing which prefix wrote it
  if (/^\/(https?|file):\/\//i.test(pathname)) return [];
  if (Array.isArray(explicit)) return explicit.map(asMirror).filter(Boolean);
  if (forced()) return [];
  return candidates();
}

// --------------------------------------------------- the classifier --

// What a connection failure can say, from whichever side of the wire said it:
// this client's fetch (node's "fetch failed" with a system code under it, a
// Chromium net:: error in the app), or the TARGET machine quoting Python's
// urllib for the fetch IT does on our behalf ("<urlopen error timed out>",
// "HTTP Error 504: Gateway Time-out"). None of these is a fact about the bytes —
// they are facts about this machine's path to them, which is the one thing a
// mirror changes.
const NETWORK_WORDS = new RegExp(
  [
    // this client's own read (ui/components.js readFailure is not used here: a
    // failed fetch of the BYTES is always the host's sentence or the socket's)
    "timed?[-_ ]?out", // "timed out", "timeout", "Gateway Time-out", "ERR_TIMED_OUT"
    "unreachable",
    "aborted",
    "fetch failed",
    "ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO",
    "socket hang up",
    "other side closed",
    "remote end closed", // python's http.client, which is what the TARGET machine fetches with
    "connection (reset|refused|closed)",
    "reset by peer",
    "name resolution|getaddrinfo|temporary failure",
    // a proxy or a gateway in the path, which is exactly what a failing
    // accelerator answers with
    "bad gateway|service unavailable|temporarily unavailable|too many requests",
    "network is down|network error",
    "certificate",
    "stream (closed|error)",
  ].join("|"),
  "i"
);

// The statuses a RETRY can change: the request did not become an answer about
// the bytes (a gateway, an overloaded host, a dead proxy). Everything else —
// 404, 403, 401, 400 — is the source's own verdict, and a mirror that serves the
// same path answers the same way.
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 523, 524]);

// Whether one failed install attempt is worth trying through a mirror. `reason`
// is whatever the target machine said (or the socket did), in its own words: this
// is a search for the vocabulary of a connection, not a parser for our own
// sentences.
//
// The statuses are read out of the text as WHOLE numbers — `\b(\d{3})\b` — since
// the same sentence may carry a digest, a byte count or a version beside the
// status, and `608f3392` (a hex digest's own first bytes) must not be read as a
// "608".
function looksLikeNetwork(reason) {
  const text = String(reason || "");
  if (!text) return false;
  for (const m of text.match(/\b\d{3}\b/g) || []) {
    if (RETRY_STATUS.has(Number(m))) return true;
  }
  return NETWORK_WORDS.test(text);
}

// ------------------------------------------------------------ the writes --

// One list written back, whole: the format a reader above expects, and the
// rename-beside-it dance every other list in this app uses — a crash or a full
// disk leaves the previous list in place, and the install path reads this file on
// every attempt.
function writeList(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, mirrors: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Add one mirror to the USER's list (never to the shipped one): the entries a
// build ships are data in the app bundle, and a UI write must not have to reach
// into it. A value already in either list is refused rather than duplicated —
// the same prefix twice is the same attempt twice.
function add(raw) {
  const url = asMirror(raw);
  if (!url) return { ok: false, error: "a mirror is an http(s) URL, e.g. https://gh-proxy.com" };
  const known = entries().find((e) => e.url === url);
  if (known) {
    return { ok: false, error: `${url} is already in the list${known.source === "builtin" ? " (this build ships it)" : ""}` };
  }
  const list = readList(USER_FILE);
  writeList(USER_FILE, list.concat(url));
  return { ok: true, url };
}

// Drop one mirror the USER added. A shipped entry cannot be removed: it is what
// the fallback is made of, and the error says so instead of pretending the button
// is broken.
function remove(raw) {
  const url = asMirror(raw);
  if (!url) return { ok: false, error: "that is not a mirror" };
  const list = readList(USER_FILE);
  if (!list.includes(url)) {
    return {
      ok: false,
      error: readList(BUILTIN_FILE).includes(url)
        ? `${url} is a mirror this build ships — it is always tried, so there is nothing to remove`
        : `${url} is not in your list`,
    };
  }
  writeList(
    USER_FILE,
    list.filter((u) => u !== url)
  );
  return { ok: true };
}

module.exports = {
  BUILTIN_FILE,
  USER_FILE,
  entries,
  candidates,
  viaPrefix,
  fallbackFor,
  looksLikeNetwork,
  forced,
  add,
  remove,
};
