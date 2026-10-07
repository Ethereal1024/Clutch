// The two things a remote read has to decide before it happens: WHICH fetch this
// machine uses, and WHERE a source this build ships is read from. Both are
// "the network this app runs on" questions, so both live in one small seam.
//
// 1. WHICH fetch. node's global fetch has no proxy of its own: HTTPS_PROXY is not
//    read, nor any other name a machine files its proxy under — so on a network
//    where github.com is reachable only through one, the read hangs until its own
//    timeout and the plugin page reports a source that "answered" nothing.
//    Electron's main process has the better one: `net.fetch` issues the request
//    through the Chromium stack of the default session, which means the machine's
//    proxy configuration (system settings; a per-session override would be
//    session.setProxy) applies without this file — or any caller — knowing
//    anything about it. Outside Electron (tests, scripts, the phone's embedded
//    node 18) the global fetch is the only one there is, which is what non-Electron
//    gets. Node 24 does have its own switch for this (NODE_USE_ENV_PROXY=1, read
//    at process startup), so a build that would rather not come through here at
//    all sets that instead.
//
//    What deliberately does NOT come through here: the host endpoints
//    (ui/components.js hostJSON / postInstall). A session is 127.0.0.1 on either
//    side of the SSH tunnel — a proxy there is a hop to our own machine, which is
//    why those calls keep the plain global fetch.
//
// 2. WHERE. A source is already data (ui/components.sources.json plus the user's
//    own list), and a mirror is the one string that moves all of it: the prefix
//    every source this build SHIPS is read under. It is applied once, where a
//    source becomes a URL (components.js `sources()`), because everything a
//    manifest names is its SIBLING (components.js `assetLocation`) — so one
//    prefix moves the manifest, the declaration AND the artifact the target
//    machine fetches for itself, with every digest still verified against the
//    release's own pins. A prefix is all a mirror has to be:
//
//      <mirror>/<the absolute github url>
//
//    which is the shape of the public accelerators and equally what a
//    path-preserving bucket of your own gets. Nothing here is a version: the
//    mirror serves the same bytes, and a mirror that serves others is refused by
//    the pin rather than believed.
//
//    The user's own list is NOT rewritten: a list somebody wrote is taken
//    literally (write the URL you mean, mirror or not), the same way a caller
//    that names its own list gets exactly that list.
//
// The prefix comes from CLUTCH_SOURCE_MIRROR first (a build, a script, a LAN
// deployment's shell) and then from source_mirror in ~/.clutch/settings.json — a
// GUI launch inherits no environment from you, and the settings widget is a later
// round, so until then that key is written by hand.

"use strict";

const { readSettings } = require("./settings-mirror");

// --------------------------------------------------------------- the fetch --

let electronFetch = null; // Chromium's, once this process has one

// Electron's fetch, or null wherever there is none: plain node (every test, any
// script, the phone) has no `electron` to require, and a main process that asks
// for `net` before the app is ready would get a throw rather than a fetch — so
// readiness is checked FIRST and the answer is only cached once it is a yes.
// A read that happens before ready then takes node's fetch and still happens.
function appFetch() {
  if (electronFetch) return electronFetch;
  if (!process.versions.electron) return null;
  try {
    const { app, net } = require("electron");
    if (app && typeof app.isReady === "function" && !app.isReady()) return null;
    if (net && typeof net.fetch === "function") electronFetch = net.fetch.bind(net);
  } catch (e) {
    /* no electron to require here, or not ready yet: node's fetch below */
  }
  return electronFetch;
}

// The fetch a remote read should use. Same (url, init) either way — `signal`
// included, so every caller's AbortController timeout still bounds the read:
// a fetch that ignores it would turn a 30s manifest budget into an unbounded
// one, which is the failure this file exists to make rare, not longer.
function netFetch() {
  const app = appFetch();
  return app || ((...args) => fetch(...args));
}

// -------------------------------------------------------------- the mirror --

// The scheme-less half of a mirror value, or "" for "none": a prefix that is not
// http(s) is dropped rather than obeyed — obeying it would rewrite http(s)
// sources into something that is not a URL at all, and the report would name a
// network failure for what is a typo in this file's setting.
function normalize(prefix) {
  const p = String(prefix || "").trim();
  if (!/^https?:\/\//i.test(p)) return "";
  return p.replace(/\/+$/, ""); // "<mirror>" and "<mirror>/" are the same mirror
}

// The mirror this machine reads sources under, or "". Env first: a shell that
// sets it is a deliberate, this-run answer. Then the settings mirror, which is
// where a desktop launch can put one at all.
function mirrorPrefix() {
  const env = normalize(process.env.CLUTCH_SOURCE_MIRROR);
  if (env) return env;
  const settings = readSettings();
  return normalize(settings && settings.source_mirror);
}

// One URL under the prefix. Only http(s) is rewritten — a source may be a path
// on disk, and a path has no mirror — and a URL already under the prefix is left
// alone, so a list that was written pre-mirrored (or a source read twice) is not
// rewritten twice into a URL nobody serves.
function mirrored(url, prefix) {
  const p = normalize(prefix);
  if (!p || !/^https?:\/\//i.test(url)) return url;
  return url.startsWith(p + "/") ? url : `${p}/${url}`;
}

module.exports = { netFetch, mirrorPrefix, mirrored };
