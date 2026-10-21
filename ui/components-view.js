// the plugin page's backend: what each component's declaration puts where, what
// those places hold, what this client could give them, and the writes that move
// it (an install, a removal, the switch that drives it or stops it, and the list
// of mirrors a failed fetch is retried through).
//
// The one rule this file exists to keep honest: WHERE a component goes is a fact
// of its declaration, never a choice and never something a page offers (see
// `destinationOf` in ui/components.js). A component that names only an `entry`
// module is this client's, one that names a `service` or a `launch` is the session
// machine's, and one component has one place in every session —
// so this layer answers per PLACE, not per "target machine", and no caller can
// aim a write anywhere else.
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
//   tunnelStatus()    => {active, url, execBridge} a live tunnel: its far
//                                                 supervisor, and the exec
//                                                 channel a DEGRADED session
//                                                 runs its commands through
//   plugins()         => ui/plugin-host.js        THIS client's plugin domain
//                      (or null)                 (null on a host that has none)
//   windowKind(win)   => "local" | "tunnel" | null  which session this window holds
//   ensureSupervisor()=> true | false             start THIS machine's supervisor
//                      (absent on a host that owns none — the phone, N4)
//   log(...)          => sink
//   lib               => ui/components.js (the install layer itself)
//   mirrorStore       => ui/mirrors.js (the list a failed fetch is retried through)
//   now()             => clock (the market cache's TTL)
"use strict";

const defaultLib = require("./components");
const defaultMirrors = require("./mirrors");
// The PLACEMENT rule is not an effect: it is one pure function over a
// declaration, so it is read from the real module even when `lib` is a fake that
// stands in for the network and the disk. A test that had to restate the rule
// would be testing its own copy of it.
const rule = defaultLib;

// The market is one HTTP read and does not change second to second, so a page
// re-opened a moment later must not re-read the index. Five minutes is short
// enough that a release published while the app is open shows up without a
// restart, long enough that the tab is instant to re-open.
const MARKET_TTL_MS = 5 * 60_000;

// A read that LOST the index is the exception to that: keeping a failure for five
// minutes is how a moment of bad network becomes "this page is broken" — every
// re-open draws the same error without asking again. So a read that fell back to
// the cached or shipped copy is fresh only for a moment; the next look is the
// next ask. (The rows that did answer are kept in the meantime — a list from the
// snapshot is still a market.)
const MARKET_ERROR_TTL_MS = 30_000;

const NO_CLIENT =
  "this shell has no client plugin domain, and that component is one: a plugin is held by the app process itself";

function createComponentsView(deps) {
  const {
    supervisorBase,
    tunnelStatus = () => ({}),
    plugins = null, // a function: this client plugin domain, or null where it has none
    windowKind = null,
    ensureSupervisor = null,
    log = () => {},
    lib = defaultLib,
    mirrorStore = defaultMirrors,
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

  // The session machine, and the one shape in which this app cannot reach it.
  //
  // A session whose commands run somewhere else than its own process does is the
  // SSH-tools degradation (ui/js/backend-lifecycle.js): a LOCAL agent with an exec
  // bridge, so `backendKind` says local while every command a tool runs lands on
  // the far machine. A cli/daemon component belongs where those commands run —
  // its own tools call it over THAT loopback — so installing it here would put it
  // on the wrong machine, which is exactly the failure the plug-in page used to
  // hide behind "Local (this machine)". The bridge is an exec channel, not a
  // supervisor, so there is nothing to install through: the honest answer is the
  // sentence, per read and per write.
  function bridged(t) {
    const ts = tunnelStatus() || {};
    if (t.kind !== "local" || !ts.active || !ts.execBridge) return "";
    return (
      "this session runs its commands on another machine over an SSH bridge, and this build has no " +
      "component channel to that machine — a component installed here would land on the machine this " +
      "window is on instead"
    );
  }

  // One answer for "why this cannot be done here", covering both shapes (no
  // machine yet, and the machine the declaration names being out of reach).
  function trouble(t) {
    return why(t) || bridged(t) || null;
  }

  // This client plugin domain, or null. A throw is the domain saying it cannot
  // read its own table, which is the same answer as "no plugins" for a caller
  // that has to draw a list: the error travels beside the rows.
  function clientDomain() {
    if (!plugins) return null;
    try {
      return plugins() || null;
    } catch (e) {
      log(`[components] this client plugin domain is unreadable: ${(e && e.message) || e}`);
      return null;
    }
  }

  // Where ONE name lives, for the verbs that take a name and no spec (a removal, a
  // switch, a version list). The declaration answers it when the market knows the
  // component; otherwise a component this client holds is its own answer, and
  // whatever is left can only be the session machine (the only other place there
  // is). Same rule as `destinationOf`, never a second opinion.
  async function placeOf(name) {
    let spec = null;
    try {
      spec = await specFor(name);
    } catch (e) {
      // the market could not be read: the two inventories still answer below
      spec = null;
    }
    if (spec) {
      const where = rule.destinationOf(spec);
      if (where.error) return { place: null, error: where.error };
      return { place: where.place, error: null };
    }
    const host = clientDomain();
    if (host) {
      try {
        if (host.list().some((r) => r.name === name)) return { place: rule.PLACE_CLIENT, error: null };
      } catch (e) {
        return { place: null, error: (e && e.message) || String(e) };
      }
    }
    return { place: rule.PLACE_SESSION, error: null };
  }

  // What the places hold. Both domains answer here, and each row says which one
  // it came from (`place`), because the page draws one list: a component that is
  // held somewhere and offered by the market is ONE row, and the row's place is a
  // fact of the component, not of the section it was found in.
  //
  // Each half can fail on its own and says so in its own words: the session
  // machine may not answer while this client still lists its plugins, and an
  // empty list must never be drawn as "nothing is installed" when the truth is
  // "that machine could not be asked".
  async function list(win = null) {
    const t = target(win);
    // Four facts, not two, because a page has two different things to do with
    // them: whether each place can be AIMED AT at all (`error`, `client`), and
    // separately whether its own list arrived (`inventoryError`,
    // `clientInventoryError`). A place that exists and whose list failed is still
    // a place a write can land on -- the bytes travel over the channel, and it is
    // the READING that did not arrive -- so the page may offer the write and say
    // what it could not see. A place this build cannot reach is the other answer,
    // and the only one that may kill a control.
    const out = {
      sessionBase: t.base,
      held: [],
      error: null,
      inventoryError: null,
      client: false,
      clientError: null,
      clientInventoryError: null,
    };
    const problem = trouble(t);
    if (problem) {
      out.error = problem;
    } else {
      try {
        const rows = await lib.hostInventory(t.base);
        out.held.push(...rows.map((r) => ({ ...r, place: rule.PLACE_SESSION })));
      } catch (e) {
        out.inventoryError = (e && e.message) || String(e);
      }
    }
    let host = null;
    try {
      host = plugins ? plugins() || null : null;
    } catch (e) {
      // the domain exists and cannot be read: not the same answer as having none
      out.clientError = (e && e.message) || String(e);
      host = null;
    }
    out.client = Boolean(host);
    if (host) {
      try {
        out.held.push(...host.list().map((r) => ({ ...r, place: rule.PLACE_CLIENT })));
      } catch (e) {
        out.clientInventoryError = (e && e.message) || String(e);
      }
    }
    return out;
  }

  // One market row: the facts a page needs and nothing it does not — a checkout
  // is a directory this client could archive, a release is a manifest it could
  // download, and a checkout that has a release under it says so (the release is
  // then the only thing a machine that already holds the checkout can receive).
  //
  // The display words come from the index ROW when there is one (`spec.entry`):
  // a module's own declaration carries what an installer needs and nothing about
  // how to describe itself in a market, so the curator's summary and tags ride
  // with the row instead. `origin` says which of the two this row is — a
  // contributor's checkout, or a line the market lists.
  function entry(spec) {
    const declared = spec.declaration || null;
    const published = spec.published || null;
    const row = spec.entry || null;
    // the contribution the declaration is read for, and the one answer it gives
    // (`destinationOf`): a page that had to derive the place itself would be a
    // second copy of the rule, and a page that asked the user would be a third
    const where = rule.destinationOf(spec);
    return {
      name: spec.name,
      id: (row && row.id) || spec.id || "",
      // where this component goes: "client" | "session" | null (a contradiction,
      // or a declaration this page has not read yet — see `read` below)
      place: where.place,
      problem: where.error || "",
      // was there a declaration to place it by? A market row is drawn from the
      // index alone (`marketEntries`), so its release's declaration only arrives
      // when something is installed from it: "not read yet" is not a refusal.
      read: where.read,
      version: (declared && declared.version) || (published && published.version) || "",
      origin: spec.checkout ? "checkout" : "market",
      source: spec.checkout ? spec.source : (published && published.source) || spec.source || "",
      published: published
        ? { version: published.version || "", source: published.source || "" }
        : null,
      // what the row says ABOUT the component, for the page's benefit only
      summary: (row && row.summary) || "",
      tags: (row && row.tags) || [],
      homepage: (row && row.homepage) || "",
      license: (row && row.license) || "",
    };
  }

  async function readMarket() {
    const known = await lib.marketEntries(); // errors are data, never a throw
    const value = {
      entries: known.specs.map(entry),
      // the reasons as drawn, and the one bit a page can act on
      // (`ui/js/components-panel.js`): at least one source that could not be
      // reached is a question about this machine's network, and a mirror prefix
      // is the answer to it. An answer that said no is not that question.
      errors: known.errors.map((e) => e.reason),
      unreachable: known.errors.some((e) => e.unreachable),
      // WHICH index answered — remote, this machine's cache, or the copy this
      // build ships — and, when it was not the remote one, why (the page draws
      // that reason as a hint; a list should say which list it is)
      origin: known.origin || "",
      note: known.note || "",
    };
    market = { at: now(), value, specs: known.specs };
    log(
      `[components] market read: ${value.entries.length} known (index: ${value.origin || "none"}), ` +
        `${value.errors.length} reason(s)`
    );
    return market;
  }

  // Is the last read still this page's picture of the market? A read that failed
  // some source is worth asking again almost immediately (MARKET_ERROR_TTL_MS) —
  // that is the retry, and the page gets it by looking again rather than by
  // holding a timer of its own.
  function stillFresh() {
    if (!market) return false;
    return now() - market.at < (market.value.errors.length ? MARKET_ERROR_TTL_MS : MARKET_TTL_MS);
  }

  // The market, from the last read when it is still fresh. `force` is the page's
  // refresh: a user asking again is asking because something changed.
  async function marketList({ force = false } = {}) {
    if (!force && stillFresh()) return market.value;
    try {
      const fresh = await readMarket();
      return fresh.value;
    } catch (e) {
      // marketEntries reports as data; this only catches something broken
      // underneath it, and still answers with a shape the page can draw
      const value = { entries: [], errors: [(e && e.message) || String(e)], unreachable: false, origin: "", note: "" };
      market = { at: now(), value, specs: [] };
      return value;
    }
  }

  // The market row for one name, from the cached read when it is still fresh.
  //
  // A row from the index is a POINTER, not a spec: the index says which release
  // is current and pins it, and which machine receives the bytes has to come from
  // the module's own declaration. So a market row's manifest — and the declaration
  // it pins — is read (and checked against the row's pin, name and version) HERE,
  // once, when something is actually about to be installed: that is the read that
  // turns an unplaced row into a placed one. A checkout needs no read at all: its
  // declaration and its bytes are the directory itself.
  async function specFor(name) {
    const fresh = stillFresh() ? market : await readMarket();
    const listed = fresh.specs.find((s) => s.name === name) || null;
    if (!listed) return null;
    if (listed.checkout || listed.declaration || !listed.entry) return listed;
    const manifest = listed.published || (await lib.entryManifest(listed.entry));
    return { ...listed, ...manifest, published: manifest, declaration: await lib.remoteDeclaration(manifest) };
  }

  // Hand ONE component to the place its declaration names.
  //
  // The page asks for a NAME and nothing else: which machine receives the bytes is
  // the declaration answer (`destinationOf`) and is the same in every session, so
  // there is no machine to pick and none to report. A declaration that
  // contradicts itself is refused here, before any byte is built or sent.
  async function install(name, win = null, { progress = null } = {}) {
    const say = (stage, extra = {}) => {
      if (progress) progress({ stage, name, ...extra });
    };
    let spec;
    try {
      spec = await specFor(name);
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
    if (!spec) return { ok: false, name, error: `${name} is not a component this client knows of` };
    const where = rule.destinationOf(spec);
    if (where.error) return { ok: false, name, error: where.error };
    return where.place === rule.PLACE_CLIENT ? clientInstall(spec, say) : sessionInstall(spec, win, say);
  }

  // This client half: the bytes come HERE and stay here. There is no supervisor
  // in this path at all — a plugin is installed by the app process itself
  // (`ui/plugin-host.js`), which is also what runs it — so the only two steps are
  // "get the bytes onto this machine" (`localArtifact`: a checkout is already
  // here, a release is fetched once into the digest-named cache) and "lay them
  // down" (the host own install, which measures the digest again).
  async function clientInstall(spec, say) {
    const name = spec.name;
    const host = clientDomain();
    if (!host) {
      return {
        ok: false,
        name,
        error: `this shell has no client plugin domain, so ${name} has nowhere to go: a plugin is installed by the app process itself`,
      };
    }
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
    // the same shortcut the session domain takes: exactly this version and digest
    // already held costs no transfer
    let held = null;
    try {
      held = host.list().find((r) => r.name === name) || null;
    } catch (e) {
      log(`[components] this client inventory is unreadable before install: ${(e && e.message) || e}`);
    }
    if (held && held.version === file.version && held.digest === file.digest) {
      say("current", { version: file.version });
      return {
        ok: true,
        name,
        status: "current",
        version: file.version,
        digest: file.digest,
        place: rule.PLACE_CLIENT,
      };
    }
    say("copy", { version: file.version, digest: file.digest });
    let artifact;
    try {
      artifact = await lib.localArtifact(file);
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
    if (!artifact) {
      return { ok: false, name, error: `no bytes reached this machine for ${name}` };
    }
    try {
      const row = host.install({ manifest: lib.manifestFor(file), artifact, version: file.version });
      say("installed", { version: file.version });
      return {
        ok: true,
        name,
        status: "installed",
        version: row.version || file.version,
        digest: row.digest || file.digest,
        place: rule.PLACE_CLIENT,
      };
    } catch (e) {
      // the host own sentence: a wrong digest, a declaration this client cannot
      // run, a payload it would not accept
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
  }

  // Hand ONE component to the machine the session runs on — the session-domain
  // half of `install` (the client-domain half is `clientInstall`).
  //
  // The verdict is the HOST's: the bytes are measured against the digest the
  // declaration pinned — whichever way they reached that machine, in the request
  // body or by its own fetch — and the machine that would RUN the code decides
  // whether it needed them ("current") or landed them ("installed"). The gate is
  // checked here first as well, so a component that machine already holds at
  // exactly this version and digest costs no transfer — the same shortcut the
  // automatic pass takes.
  async function sessionInstall(spec, win, say) {
    const name = spec.name;
    const t = target(win);
    const problem = trouble(t);
    if (problem) return { ok: false, name, error: problem };

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

    // The machine's supervisor exits when it is idle (it is the app that starts it
    // on demand), and the plugin tab can be open before any window holds a session
    // — so the machine this install is aimed at may not be running. A WRITE is the
    // user asking that machine to do something, and this client is the one holding
    // its spawn command: an idle-exited supervisor is started here rather than
    // reported as "did not answer". A READ stays honest (list() says "not
    // answering", the page draws that) — waking a machine to answer a question
    // nobody asked it to answer yet is not this layer's business.
    //
    // It happens HERE, at the first moment the machine itself has to answer, so a
    // request this client refuses on its own (an unknown name, no bytes for this
    // platform) never starts a machine for nothing. And it is only ever the LOCAL
    // one: the far side of a tunnel starts its own supervisor, exactly as it does
    // in VS Code, where installing onto a remote server is part of that machine's
    // server start rather than the client's (COMPONENTS.md 第八节).
    if (t.kind === "local" && ensureSupervisor) {
      say("wake");
      if (!(await ensureSupervisor())) {
        return {
          ok: false,
          name,
          error: "this machine's supervisor is not running and could not be started (the app log says why)",
        };
      }
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
      return {
        ok: true,
        name,
        status: "current",
        version: file.version,
        digest: file.digest,
        place: rule.PLACE_SESSION,
        target: t,
      };
    }

    // Which shape this install takes is decided by where the bytes ARE
    // (ui/components.js `artifactFor`): the target machine fetches a published
    // release for itself — the default, because that machine is the one that will
    // run them — and only bytes this client alone holds travel as a body. The
    // page is told which one is happening, since that is the slow step and it is
    // not the same step.
    //
    // A fetch the release host cannot answer is retried through the mirrors this
    // machine knows of (ui/mirrors.js, already carried on `file` by `artifactFor`):
    // the bytes still have to hash to the release's own pin, so a mirror can only
    // move them, never vouch for them. `onRetry` is why the page hears about it —
    // one attempt can spend its whole timeout, and a page that says "installing…"
    // for two minutes is indistinguishable from a broken one.
    const sends = Boolean(file.path);
    say(sends ? "upload" : "fetch", { version: file.version, digest: file.digest });
    try {
      const res = sends
        ? await lib.upload(t.base, file, lib.REQUEST_TIMEOUT_MS)
        : await lib.fetchInstall(t.base, file, lib.REQUEST_TIMEOUT_MS, {
            onRetry: (prefix, reason) =>
              say("mirror", { version: file.version, digest: file.digest, prefix, reason }),
          });
      say(res.status === "current" ? "current" : "installed", { version: file.version });
      return {
        ok: true,
        name,
        status: res.status,
        version: res.version || file.version,
        digest: res.digest || file.digest,
        // the prefix the bytes this machine now runs came through, when they did
        // not come from the release's own URL
        via: res.via || file.via || "",
        path: res.path || "",
        place: rule.PLACE_SESSION,
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
    const there = await placeOf(name);
    if (there.error) return { name, place: null, versions: [], error: there.error };
    if (there.place === rule.PLACE_CLIENT) {
      const host = clientDomain();
      if (!host) return { name, place: null, versions: [], error: NO_CLIENT };
      try {
        // the client own table, newest first by the same rule the host sorts with
        return { name, place: rule.PLACE_CLIENT, versions: host.versions(name), error: null };
      } catch (e) {
        return { name, place: rule.PLACE_CLIENT, versions: [], error: (e && e.message) || String(e) };
      }
    }
    const t = target(win);
    const problem = trouble(t);
    if (problem) return { name, place: rule.PLACE_SESSION, versions: [], error: problem };
    try {
      return {
        name,
        place: rule.PLACE_SESSION,
        versions: await lib.hostVersions(t.base, name),
        error: null,
      };
    } catch (e) {
      return { name, place: rule.PLACE_SESSION, versions: [], error: (e && e.message) || String(e) };
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
    const there = await placeOf(name);
    if (there.error) return { ok: false, name, error: there.error };
    if (there.place === rule.PLACE_CLIENT) {
      const host = clientDomain();
      if (!host) return { ok: false, name, error: NO_CLIENT };
      try {
        const res = host.remove(name, version);
        return {
          ok: true,
          name,
          place: rule.PLACE_CLIENT,
          status: res.status || "removed",
          removed: Array.isArray(res.removed) ? res.removed : [],
        };
      } catch (e) {
        return { ok: false, name, error: (e && e.message) || String(e) };
      }
    }
    const t = target(win);
    const problem = trouble(t);
    if (problem) return { ok: false, name, error: problem };
    try {
      const res = await lib.hostRemove(t.base, name, version);
      return {
        ok: true,
        name,
        status: res.status || "removed",
        removed: Array.isArray(res.removed) ? res.removed : [],
        place: rule.PLACE_SESSION,
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
    const there = await placeOf(name);
    if (there.error) return { ok: false, name, error: there.error };
    if (there.place === rule.PLACE_CLIENT) {
      const host = clientDomain();
      if (!host) return { ok: false, name, error: NO_CLIENT };
      try {
        const res = host.setDisabled(name, disabled);
        return {
          ok: true,
          name,
          place: rule.PLACE_CLIENT,
          status: res.status || (disabled ? "disabled" : "enabled"),
          disabled: typeof res.disabled === "boolean" ? res.disabled : disabled,
        };
      } catch (e) {
        return { ok: false, name, error: (e && e.message) || String(e) };
      }
    }
    const t = target(win);
    const problem = trouble(t);
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
        place: rule.PLACE_SESSION,
        target: t,
      };
    } catch (e) {
      return { ok: false, name, error: (e && e.message) || String(e) };
    }
  }

  // The mirrors this machine retries a failed fetch through: the shipped list
  // (ui/components.mirrors.json, inside the app bundle) merged with the user's own
  // (ui/mirrors.js `entries()`), each row saying which it is — a user entry can be
  // removed and a shipped one cannot, and a page that draws them alike is drawing
  // a button that does nothing.
  //
  // `forced` is the prefix this machine reads EVERY source through
  // (CLUTCH_SOURCE_MIRROR, or `source_mirror` in ~/.clutch/settings.json). While
  // one is set there is no per-source fallback left to take, so the page says
  // which knob is in charge rather than offering a list that would be ignored.
  function mirrorList() {
    try {
      return { mirrors: mirrorStore.entries(), forced: mirrorStore.forced(), error: null };
    } catch (e) {
      return { mirrors: [], forced: "", error: (e && e.message) || String(e) };
    }
  }

  // Add one mirror to the USER's list. The refusal is the list's own (a value
  // already there, a value that is not an http(s) prefix) and travels as `error`,
  // because it is a sentence to draw under the field rather than a failure of the
  // page. Both writes answer with the list as it now is: the page then draws what
  // was actually written, not what it hoped it asked for.
  function addMirror(raw) {
    let res;
    try {
      res = mirrorStore.add(raw);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
    return res.ok ? { ok: true, ...mirrorList() } : { ok: false, error: res.error };
  }

  function removeMirror(raw) {
    let res;
    try {
      res = mirrorStore.remove(raw);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
    return res.ok ? { ok: true, ...mirrorList() } : { ok: false, error: res.error };
  }

  return {
    target,
    placeOf,
    destination: (spec) => rule.destinationOf(spec),
    list,
    market: marketList,
    install,
    versions,
    remove,
    setDisabled,
    mirrors: mirrorList,
    addMirror,
    removeMirror,
    marketCache: () => market,
  };
}

module.exports = { createComponentsView, MARKET_TTL_MS, MARKET_ERROR_TTL_MS };
