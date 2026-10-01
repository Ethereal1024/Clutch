// the plugin page's backend: the target machine, what it holds, what this
// client could give it, and the three writes that move it (an install onto the
// machine, a removal off it, and the switch that drives it or stops it)
//
// Everything the plugin tab shows crosses this file. The renderer may not touch
// the filesystem, a supervisor, or a release, so it asks and receives facts.
// Three of the four answers carry their failure INSIDE the answer (a source that
// did not answer, a supervisor that did not answer) rather than throwing: a page
// that draws an empty list has to be able to say why it is empty, and one dead
// source must never blank out the others.
//
// `deps` (injected, so a test can drive this with no Electron and no network):
//   supervisorBase()  => "http://127.0.0.1:8890"   THIS machine's supervisor
//   tunnelStatus()    => {active, url}            a live tunnel's far supervisor
//   windowKind(win)   => "local" | "tunnel" | null  which session this window holds
//   log(...)          => sink
//   lib               => ui/components.js (the install layer itself)
//   now()             => clock (the market cache's TTL)
"use strict";

const defaultLib = require("./components");

// The market is one HTTP read per source and does not change second to second,
// so a page re-opened a moment later must not re-read every release. Five
// minutes is short enough that a release published while the app is open shows
// up without a restart, long enough that the tab is instant to re-open.
const MARKET_TTL_MS = 5 * 60_000;

function createComponentsView(deps) {
  const {
    supervisorBase,
    tunnelStatus = () => ({}),
    windowKind = null,
    log = () => {},
    lib = defaultLib,
    now = Date.now,
  } = deps;

  let market = null; // {at, value, specs} — the last market read

  // Which machine a request is about. The components endpoint lives on a
  // machine's SUPERVISOR, not on its session server, so this cannot simply be
  // the URL the window's API calls go to: a window whose session sits on the far
  // side of a tunnel installs THERE (the tunnel's own supervisor URL), and a
  // window with a local session installs here.
  function target(win = null) {
    const ts = tunnelStatus() || {};
    const remote = ts.active && ts.url ? String(ts.url) : "";
    const kind = win && windowKind ? windowKind(win) : null;
    // no session claimed yet (kind null): the tunnel, if any, is still the
    // machine this window is about
    if (kind === "tunnel" || (!kind && remote)) return { kind: "remote", base: remote };
    return { kind: "local", base: supervisorBase() };
  }

  // A target with no URL is not an unreadable machine, it is no machine yet.
  function why(t) {
    if (t.base) return null;
    return t.kind === "remote"
      ? "the tunnel is up but carries no supervisor URL yet"
      : "this build has no supervisor URL for the local machine";
  }

  // What the target machine holds. `error` is the reason it could not be told.
  async function list(win = null) {
    const t = target(win);
    const out = { target: t, held: [], error: null };
    const problem = why(t);
    if (problem) {
      out.error = problem;
      return out;
    }
    try {
      out.held = await lib.hostInventory(t.base);
    } catch (e) {
      out.error = (e && e.message) || String(e);
    }
    return out;
  }

  // One market row: the facts a page needs and nothing it does not — a checkout
  // is a directory this client could archive, a release is a manifest it could
  // download, and a checkout that has a release under it says so (the release is
  // then the only thing a machine that already holds the checkout can receive).
  function entry(spec) {
    const declared = spec.declaration || null;
    const published = spec.published || null;
    return {
      name: spec.name,
      interface:
        spec.interface || (declared && declared.interface) || (published && published.interface) || "",
      version: (declared && declared.version) || (published && published.version) || "",
      origin: spec.checkout ? "checkout" : "release",
      source: spec.checkout ? spec.source : (published && published.source) || spec.source || "",
      published: published
        ? { version: published.version || "", source: published.source || "" }
        : null,
    };
  }

  async function readMarket() {
    const known = await lib.componentSpecs(); // errors are data, never a throw
    const value = {
      entries: known.specs.map(entry),
      errors: known.errors.map((e) => e.reason),
      sources: lib.sources().length,
    };
    market = { at: now(), value, specs: known.specs };
    log(`[components] market read: ${value.entries.length} known, ${value.errors.length} source(s) failed`);
    return market;
  }

  // The market, from the last read when it is still fresh. `force` is the page's
  // refresh: a user asking again is asking because something changed.
  async function marketList({ force = false } = {}) {
    if (!force && market && now() - market.at < MARKET_TTL_MS) return market.value;
    try {
      const fresh = await readMarket();
      return fresh.value;
    } catch (e) {
      // componentSpecs reports as data; this only catches something broken
      // underneath it, and still answers with a shape the page can draw
      const value = { entries: [], errors: [(e && e.message) || String(e)], sources: 0 };
      market = { at: now(), value, specs: [] };
      return value;
    }
  }

  // Hand ONE component to the target machine.
  //
  // The verdict is the host's, not this client's: the bytes are measured against
  // the digest the declaration pinned before they are sent, and the machine that
  // would RUN the code decides whether it needed them ("current") or landed them
  // ("installed"). The gate is checked here first as well, so a component the
  // target already holds at exactly this version and digest costs no upload —
  // the same shortcut the automatic pass takes.
  async function install(name, win = null, { progress = null } = {}) {
    const say = (stage, extra = {}) => {
      if (progress) progress({ stage, name, ...extra });
    };
    const t = target(win);
    const problem = why(t);
    if (problem) return { ok: false, name, error: problem };
    let specs;
    try {
      const fresh = market && now() - market.at < MARKET_TTL_MS ? market : await readMarket();
      specs = fresh.specs;
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
    const spec = specs.find((s) => s.name === name);
    if (!spec) return { ok: false, name, error: `${name} is not a component this client knows of` };

    say("artifact");
    let file;
    try {
      file = await lib.artifactFor(spec); // the checkout beside this repo outranks a release
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
    if (!file) {
      return {
        ok: false,
        name,
        error: `this client has no bytes for ${name}: no checkout beside the host repo, and no artifact for this platform in its release`,
      };
    }

    let have = [];
    try {
      have = await lib.hostInventory(t.base);
    } catch (e) {
      // the inventory is a shortcut, not the gate: the host decides either way.
      // An unreadable inventory means "ask the host by uploading".
      log(`[components] inventory unreadable before install: ${(e && e.message) || e}`);
    }
    const held = have.find((h) => h.name === name);
    if (held && held.version === file.version && held.digest === file.digest) {
      say("current", { version: file.version });
      return { ok: true, name, status: "current", version: file.version, digest: file.digest, target: t };
    }

    say("upload", { version: file.version, digest: file.digest });
    try {
      const res = await lib.upload(t.base, file, lib.REQUEST_TIMEOUT_MS);
      say(res.status === "current" ? "current" : "installed", { version: file.version });
      return {
        ok: true,
        name,
        status: res.status,
        version: res.version || file.version,
        digest: res.digest || file.digest,
        path: res.path || "",
        target: t,
      };
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
  }

  // Every version of ONE component the target machine holds, newest first, with
  // `resolved` marking the one it would run. Same shape as list(): the reason a
  // read failed travels INSIDE the answer, because an empty list of versions and
  // "the machine could not be asked" are not the same fact.
  async function versions(name, win = null) {
    const t = target(win);
    const problem = why(t);
    if (problem) return { target: t, name, versions: [], error: problem };
    try {
      return { target: t, name, versions: await lib.hostVersions(t.base, name), error: null };
    } catch (e) {
      return { target: t, name, versions: [], error: (e && e.message) || String(e) };
    }
  }

  // Let ONE component go from the target machine. `version` names one version to
  // drop; with no version the component goes whole. The verdict is the host's and
  // it has three shapes, all of them answers rather than failures — "removed"
  // (with the versions that went), "absent" (nothing was there, so the request is
  // already true), and a refusal as `error`, which is what arrives when something
  // is running the component: this client cannot stop a process on another
  // machine, and the host will not delete code out from under one.
  async function remove(name, { version = "" } = {}, win = null) {
    const t = target(win);
    const problem = why(t);
    if (problem) return { ok: false, name, error: problem };
    try {
      const res = await lib.hostRemove(t.base, name, version);
      return {
        ok: true,
        name,
        status: res.status || "removed",
        removed: Array.isArray(res.removed) ? res.removed : [],
        target: t,
      };
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
  }

  // Stop driving ONE component on the target machine, or start again. The one
  // write on this layer that touches no bytes, and the only one that is
  // reversible from the same control — so nothing about it is confirmed, and the
  // answer says which bit the machine now holds.
  //
  // `disabled` is the state being ASKED FOR, spelled the way the host stores it
  // (true = held, not driven): passing the current state back would be a no-op,
  // and passing `!held.disabled` at every call site is how a page ends up
  // inviting the user to "disable" something it is about to start. The verdict is
  // the host's, and "absent" is one of its shapes: THIS machine does not hold the
  // component at all, which is an answer rather than a failure — the request was
  // already true there — and the page has to say so, because it means the machine
  // it was aimed at was not the machine to switch.
  async function setDisabled(name, disabled, win = null) {
    const t = target(win);
    const problem = why(t);
    if (problem) return { ok: false, name, error: problem };
    try {
      const res = await lib.hostSetDisabled(t.base, name, disabled);
      return {
        ok: true,
        name,
        status: res.status || (disabled ? "disabled" : "enabled"),
        // the host's bit when it sent one, and the request's own state otherwise:
        // a verdict without the field is still an answer about the state asked for
        disabled: typeof res.disabled === "boolean" ? res.disabled : disabled,
        target: t,
      };
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
  }

  return {
    target,
    list,
    market: marketList,
    install,
    versions,
    remove,
    setDisabled,
    marketCache: () => market,
  };
}

module.exports = { createComponentsView, MARKET_TTL_MS };
