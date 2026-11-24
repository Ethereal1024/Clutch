"use strict";

// The plugin tab is the ONE place this UI can write to a machine, so all
// three of its write paths are what must not drift silently: which
// machine a control claims, what the confirmation says, what a refusal looks
// like, and what the page does afterwards — for the install, for the removal
// (the reverse verb, which is the one that DELETES, so its wording is checked for
// the fact that it is not a rollback), and for the switch (which deletes nothing,
// is the undo of itself, and therefore must NOT ask). Nothing smaller than the
// page's own file tests that, and the page is DOM code driven by
// ui/components-view.js over the clutchComponents channel.
//
// So this runner loads ui/src/renderer/components-panel.ts itself (taken from
// ui/index.html's script list, so a page that forgets to load it fails here)
// into a vm context with a hand-rolled mini-DOM and a fake component channel,
// then presses the buttons the way a user would.
//
// What is stubbed is the ENVIRONMENT (document, window, askConfirm, the channel);
// the logic under test is the real file. The fake host answers are the real
// shapes: ui/components-view.js:64 list() -> {target, held, error} and
// :186 install() -> {ok, status, version, digest, path}.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, uiModules, rendererScript } = require("./harness.js");

// ---- mini-DOM: elements, ids, text, clicks, parents ----
function makeDocument(ids) {
  function node(tag) {
    const n = {
      tag,
      className: "",
      title: "",
      attrs: {},
      type: "",
      disabled: false,
      value: "",
      children: [],
      handlers: {},
      parent: null,
      _text: "",
      _html: "",
      classList: {
        add(...cls) {
          const set = new Set(n.className.split(" ").filter(Boolean));
          cls.forEach((c) => set.add(c));
          n.className = [...set].join(" ");
        },
        remove(...cls) {
          const set = new Set(n.className.split(" ").filter(Boolean));
          cls.forEach((c) => set.delete(c));
          n.className = [...set].join(" ");
        },
        toggle(c, on) { (on ? n.classList.add : n.classList.remove)(c); },
        contains: (c) => n.className.split(" ").includes(c),
      },
      appendChild(ch) { ch.parent = n; n.children.push(ch); return ch; },
      removeChild(ch) { n.children = n.children.filter((c) => c !== ch); return ch; },
      remove() {},
      addEventListener(ev, fn) { (n.handlers[ev] = n.handlers[ev] || []).push(fn); },
      click() { for (const fn of n.handlers.click || []) fn(); },
      focus() {},
      // what the panel says about a control it cannot show with a class alone
      // (aria-pressed, aria-expanded, aria-describedby, role): the real DOM API,
      // one attribute at a time — see cselect-test.js's mini-DOM for the same pair
      getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
      setAttribute(k, v) { n.attrs[k] = String(v); },
      removeAttribute(k) { delete n.attrs[k]; },
      // an element's own text: the panel names its sr-only facts through the id
      // an aria attribute points at, so a test has to be able to look one up
      id: "",
      querySelector: () => null,
      get textContent() { return n._text; },
      set textContent(v) { n._text = String(v); n.children = []; },
      get innerHTML() { return n._html; },
      set innerHTML(v) { n._html = String(v); if (!v) n.children = []; },
    };
    return n;
  }
  const byId = new Map();
  for (const id of ids) byId.set("#" + id, node("div"));
  return {
    node,
    byId,
    document: {
      createElement: (tag) => node(tag),
      getElementById: (id) => byId.get("#" + id) || node("div"),
      querySelector: (sel) => byId.get(sel) || node("div"),
      addEventListener() {},
    },
  };
}

// every element under a root, in document order
function walk(n, out = []) {
  out.push(n);
  for (const c of n.children) walk(c, out);
  return out;
}

function textOf(n) {
  return ((n._text || "") + " " + n.children.map(textOf).join(" ")).replace(/\s+/g, " ").trim();
}

// what a row PRINTS: everything except the sr-only facts a control points at with
// `aria-describedby` (U-10 puts them one hover away, and this is that same
// sentence for whoever cannot hover). "Nothing else is drawn in the row" is a
// claim about the drawn page, so it is asked of this and not of textOf.
function drawnText(n) {
  if (/(^| )sr-only( |$)/.test(n.className)) return "";
  return ((n._text || "") + " " + n.children.map(drawnText).join(" ")).replace(/\s+/g, " ").trim();
}

// the sr-only node an aria attribute points at, looked up the way assistive tech
// resolves it: the id, inside the subtree the attribute was written on
function describedBy(el, root) {
  const id = el.getAttribute("aria-describedby");
  return (id && walk(root).find((n) => n.id === id)) || null;
}

// the row a control sits in, by walking up the parents the mini-DOM kept. The
// class is matched as a whole word: a row also carries the state it is in
// (.stopped, .busy), and the version rows under a held row are rows as well.
function rowOf(el) {
  let cur = el;
  while (cur && !/(^| )plug-row( |$)/.test(cur.className)) cur = cur.parent;
  return cur;
}

// a row is TWO columns now (ui/src/renderer/components-panel.ts): the words in
// `.plug-row-main` and the controls in `.plug-row-actions` beside them. So the
// name is no longer the row's first child — it leads the words column instead.
// Walking finds the row's OWN name first: the versions box (the row's last child)
// is the only place a nested row can appear.
function nameOf(row) {
  return walk(row).find((n) => /(^| )plug-name( |$)/.test(n.className)) || null;
}
// the row's name LINE: the name and the marks that belong beside it
function headOf(row) {
  return walk(row).find((n) => /(^| )plug-row-head( |$)/.test(n.className)) || null;
}
// the words column itself
function mainOf(row) {
  return row.children.find((c) => /(^| )plug-row-main( |$)/.test(c.className)) || null;
}

function ownerName(el) {
  const row = rowOf(el);
  const name = row && nameOf(row);
  return name ? textOf(name).trim() : "";
}

// the row that NAMES this component (a version row names a version, not a
// component), and the state line inside it: what is happening to that one row
// right now — a write in flight, or the host's verdict on the last one.
function rowNamed(body, name) {
  return (
    walk(body).find((n) => {
      if (!/(^| )plug-row( |$)/.test(n.className)) return false;
      const nm = nameOf(n);
      return Boolean(nm) && textOf(nm).trim() === name;
    }) || null
  );
}

function stateOf(body, name) {
  const row = rowNamed(body, name);
  if (!row) return null;
  return walk(row).find((c) => /(^| )plug-state( |$)/.test(c.className)) || null;
}

// ONE declared setting, by the key the declaration names — the label IS the key,
// word for word, the way an editor's settings page prints the setting's id
function settingRowIn(body, key) {
  return (
    walk(body).find((n) => {
      if (!/(^| )plug-setting( |$)/.test(n.className)) return false;
      const label = walk(n).find((c) => /(^| )plug-setting-label( |$)/.test(c.className));
      return Boolean(label) && label.textContent === key;
    }) || null
  );
}

// the control at a setting's right end, whatever the type chose to draw there
function settingCtlIn(row) {
  if (!row) return null;
  return walk(row).find((n) => /(^| )plug-setting-(check|select|input|list)( |$)/.test(n.className)) || null;
}

// the way back to the declared default, drawn only on a setting that left it
function settingResetIn(row) {
  if (!row) return null;
  return walk(row).find((n) => /(^| )plug-setting-reset( |$)/.test(n.className)) || null;
}

// ONE declared setting, by the key the declaration names — the label IS the key,
// word for word, the way an editor's settings page prints the setting's id
function settingRowIn(body, key) {
  return (
    walk(body).find((n) => {
      if (!/(^| )plug-setting( |$)/.test(n.className)) return false;
      const label = walk(n).find((c) => /(^| )plug-setting-label( |$)/.test(c.className));
      return Boolean(label) && label.textContent === key;
    }) || null
  );
}

// the control at a setting's right end, whatever the type chose to draw there
function settingCtlIn(row) {
  if (!row) return null;
  return walk(row).find((n) => /(^| )plug-setting-(check|select|input|list)( |$)/.test(n.className)) || null;
}

// the way back to the declared default, drawn only on a setting that left it
function settingResetIn(row) {
  if (!row) return null;
  return walk(row).find((n) => /(^| )plug-setting-reset( |$)/.test(n.className)) || null;
}

const IDS = [
  "plug-body",
  "plug-note",
  "plug-reload",
  "plug-filter",
  // the right dock's group and the aside it lives in: the pane reads only while it
  // is on screen (components-panel.ts plugPaneVisible), and a test has to be able
  // to fold the group the way dock.ts does
  "dock-plugins",
  "right",
  // the source-mirror row the pane draws above the list (report: "downloads and
  // uploads still needed a VPN" — the field is the only door to the knob). It moved
  // to the settings dialog with the mirror LIST it belongs beside
  // (ui/index.html `#settings-pane-mirrors`), so the page has to hold both halves:
  // the tab that shows that pane, and the box components-panel.ts paints into.
  "mirror-input",
  "mirror-save",
  "mirror-note",
  "settings-tab-mirrors",
  "settings-mirrors",
];

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 5) { for (let i = 0; i < n; i++) await tick(); }

function defer() {
  const d = {};
  d.promise = new Promise((res, rej) => { d.res = res; d.rej = rej; });
  return d;
}

const LOCAL = { kind: "local", base: "http://127.0.0.1:8890" };
const REMOTE = { kind: "remote", base: "http://127.0.0.1:7788" };

const COMPONENTS = [
  { name: "clutch-workspace", version: "0.1.0", origin: "checkout", source: "…/clutch-workspace", published: null },
  { name: "clutch-memory", version: "0.1.0", origin: "release", source: "clutch-memory@v0.1.0", published: null },
];

// a fresh page: the real panel file, a fresh mini-DOM, a fake channel
// `mirror` is the fake of the mirror channel (ui/components-view.js mirrors/add/
// removeMirror). Passed, this page HAS that channel (three reads, and the section
// under the list); omitted, it is a shell that predates the feature and must draw
// exactly as it did before — the reason the default is null and not a stub.
// What the connect's automatic components pass did is NOT a parameter: it is a
// log line (ui/tunnel-bootstrap.js) and never part of a list, so a page cannot be
// handed one. Section 39 keeps it that way.
function page({ held = [], heldError = null, listError = null, target = LOCAL, entries = COMPONENTS, errors = [], unreachable = false, store = {}, session = {}, mirror = null, client = false, clientError = null, clientHeldError = null, heldPlace = "session", entryPlace = "session", settings = null, slot = "" } = {}) {
  const dom = makeDocument(IDS);
  const world = {
    listCalls: 0,
    marketCalls: 0,
    installCalls: [],
    removeCalls: [],
    removeOpts: [],
    switchCalls: [],
    versionsCalls: [],
    progress: null,
    control: null,
    reply: null,
    removeReply: { ok: true, status: "removed", removed: ["0.1.0+5f900739"] },
    switchReply: { ok: true, status: "disabled", disabled: true },
    versionsControl: null,
    versionsReply: {
      versions: [
        { name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000", path: "/home/u/.clutch/components/clutch-workspace/0.1.0+bbbb", resolved: true, disabled: false },
        { name: "clutch-workspace", version: "0.1.0+aaaa", digest: "aaaa0000aaaa0000", path: "/home/u/.clutch/components/clutch-workspace/0.1.0+aaaa", resolved: false, disabled: false },
      ],
      error: null,
    },
    confirms: [],
    answer: true,
    // the host channel the mirror FIELD row writes through (clutchSettings.save):
    // the window's copy of the knob is only kept when this answers ok
    settingsSaves: [],
    settingsReply: { ok: true },
    settingsControl: null,
    // the mirror LIST channel (ui/components-view.js mirrors/add/removeMirror)
    mirrorCalls: 0,
    mirrorAdds: [],
    mirrorRemoves: [],
    mirrorControl: null, // a deferred read, for the "still reading" frame
    // WHICH tab's session each channel call named (components-panel.ts
    // plugState.slot): one tab is one session, and two tabs can be two machines,
    // so this is the fact that decides whether a write lands where it says it does
    // `slot` is decided before the module runs, because the pane names the open
    // tab on the reads it starts at load time (an empty tab list is ""
    slot,
    // which machine the session half is asked of. A tab's session ARRIVES a moment
    // after the tab does, so a test moves this to say "the claim landed".
    target,
    slots: [],
    listDefer: false,
    listDeferreds: [],
  };
  const api = {
    list: async (slot = "") => {
      world.listCalls++;
      world.slots.push(["list", slot]);
      // a read this runner can hold open, so a reply can arrive AFTER the strip has
      // moved (the tab that asked is not the tab on screen any more)
      if (world.listDefer) {
        const d = defer();
        world.listDeferreds.push(d);
        return d.promise;
      }
      if (listError) throw new Error(listError);
      // the shape ui/components-view.js list() answers in: two places, and for
      // each one the difference between "cannot be aimed at" (`error` / no
      // `client`) and "answered without its own list" (`inventoryError`)
      //
      // ...and WHICH machine the session half was asked of (`target`) as a fact,
      // not left in the sentence: "none" is a tab with no session yet — nobody to
      // ask, and it is answered by waiting — while "remote" with no base is a
      // machine that exists and cannot be reached. The page draws the two in
      // different weights (components-panel.ts plugReadNote), so a fake that only
      // wrote the sentence could not tell them apart. It is read from `world` so a
      // test can let a tab's session ARRIVE between two reads.
      const said = world.target;
      const missing = said.kind === "none";
      return {
        sessionBase: said.base,
        target: said.kind,
        held: held.map((h) => ({ place: heldPlace, ...h })),
        error: missing
          ? "this tab has no session yet, so there is no machine to ask — its components are read once it has one"
          : said.kind === "remote" && !said.base
          ? "the tunnel is up but carries no supervisor URL yet"
          : null,
        inventoryError: heldError,
        client,
        clientError,
        clientInventoryError: clientHeldError,
      };
    },
    market: async () => {
      world.marketCalls++;
      // a market row as ui/components-view.js entry() answers it: the place comes
      // off the declaration (`destinationOf`), and `problem` is the refusal when
      // the two words name a pair that cannot exist
      return { entries: entries.map((e) => ({ place: entryPlace, problem: "", read: true, ...e })), errors, unreachable, origin: "remote", note: "" };
    },
    install: async (name, slot = "") => {
      world.installCalls.push(name);
      world.slots.push(["install", slot]);
      if (world.control) return world.control.promise;
      return world.reply;
    },
    remove: async (name, opts, place, slot = "") => {
      world.removeCalls.push(name);
      world.removeOpts.push(opts || null);
      world.slots.push(["remove", slot, place]);
      if (world.control) return world.control.promise;
      return world.removeReply;
    },
    versions: async (name, place, slot = "") => {
      world.versionsCalls.push(name);
      world.slots.push(["versions", slot, place]);
      if (world.versionsControl) return world.versionsControl.promise;
      return world.versionsReply;
    },
    onProgress: (cb) => { world.progress = cb; },
    setDisabled: async (name, disabled, place, slot = "") => {
      world.switchCalls.push([name, disabled]);
      world.slots.push(["setDisabled", slot, place]);
      if (world.control) return world.control.promise;
      return world.switchReply;
    },
  };
  // the settings channel (ui/components-view.js `settings` / `setSetting`): the
  // declaration's schema, the values this machine holds, and one write per call.
  // Passed, this page HAS the verb; omitted, it is a shell that predates it and
  // must not draw a control that looks like one — the reason the default is null.
  // The write answers the values AS THEY NOW ARE (the store holds the effective
  // document), which is what the form draws: never what the page sent.
  if (settings) {
    const doc = { schema: settings.schema || {}, values: { ...(settings.values || {}) } };
    world.settingsReads = [];
    world.settingWrites = [];
    world.settingsDoc = doc;
    api.settings = async (name, place, slot = "") => {
      world.settingsReads.push(name);
      world.slots.push(["settings", slot, place]);
      if (world.settingsControl) return world.settingsControl.promise;
      if (settings.readError) return { ok: false, name, error: settings.readError };
      return { ok: true, name, place, schema: doc.schema, values: { ...doc.values } };
    };
    api.setSetting = async (name, patch, place, slot = "") => {
      world.settingWrites.push([name, patch]);
      world.slots.push(["setSetting", slot, place]);
      if (world.settingWriteControl) return world.settingWriteControl.promise;
      if (settings.writeError) return { ok: false, name, error: settings.writeError };
      for (const [key, value] of Object.entries(patch || {})) doc.values[key] = value;
      const values = {};
      for (const [key, spec] of Object.entries(doc.schema)) {
        values[key] = key in doc.values ? doc.values[key] : (spec || {}).default;
      }
      return { ok: true, name, place, values };
    };
  }
  // the mirror channel, when this page is given one: a mutable list the fake
  // answers from, in the shape ui/mirrors.js speaks — every write answers with
  // the list AS IT NOW IS, and a refusal is a sentence rather than a rejection
  if (mirror) {
    const state = { list: (mirror.list || []).map((e) => ({ ...e })), forced: mirror.forced || "" };
    // the order ui/mirrors.js `entries()` answers in: the user's entries first,
    // then the ones this build ships — so a page drawing this list is drawing the
    // order a fallback would actually try
    const snapshot = () =>
      [...state.list.filter((e) => e.source === "user"), ...state.list.filter((e) => e.source !== "user")].map((e) => ({ ...e }));
    world.mirrorState = state;
    api.mirrors = async () => {
      world.mirrorCalls++;
      if (world.mirrorControl) return world.mirrorControl.promise;
      if (mirror.error) return { mirrors: [], forced: "", error: mirror.error };
      return { mirrors: snapshot(), forced: state.forced, error: null };
    };
    api.addMirror = async (raw) => {
      world.mirrorAdds.push(raw);
      if (mirror.addError) return { ok: false, error: mirror.addError };
      if (state.list.some((e) => e.url === raw)) return { ok: false, error: `${raw} is already in the list` };
      state.list = [...state.list, { url: raw, source: "user" }];
      return { ok: true, mirrors: snapshot(), forced: state.forced, error: null };
    };
    api.removeMirror = async (raw) => {
      world.mirrorRemoves.push(raw);
      if (mirror.removeError) return { ok: false, error: mirror.removeError };
      state.list = state.list.filter((e) => e.url !== raw);
      return { ok: true, mirrors: snapshot(), forced: state.forced, error: null };
    };
  }
  const ctx = {
    console,
    setImmediate,
    setTimeout,
    clearTimeout,
    Promise,
    document: dom.document,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
    // the session URL names THIS window's session, so every reader of it uses
    // sessionStorage (js/backend-lifecycle.js): the panel's ✓ is about the window
    // the panel is drawn in, not about the machine the profile remembers (⑤)
    sessionStorage: { getItem: (k) => (k in session ? session[k] : null), setItem() {}, removeItem() {} },
    askConfirm: async (opts) => { world.confirms.push(opts); return world.answer; },
    // WHICH tab is open (ui/src/renderer/slots.ts activeSlotId): the pane names it
    // on every read and every write, and follows it on `clutch:tab-state`
    activeSlotId: () => world.slot,
    $: (sel) => dom.document.querySelector(sel),
    renderPlugins: null, // the real one, declared in the file
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.window.clutchComponents = api;
  // the mirror row's channel, one for one with ui/preload.js + ui/src/renderer/bridge-shim.ts:
  // a save is asked of the HOST (it holds ~/.clutch/settings.json), so this is the
  // only way a value becomes the mirror reads are sent under
  ctx.window.clutchSettings = {
    save: async (data) => {
      world.settingsSaves.push(data);
      if (world.settingsControl) return world.settingsControl.promise;
      return world.settingsReply;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: "ui/src/renderer/components-panel.ts" });
  return {
    ctx,
    world,
    store,
    byId: dom.byId,
    el: (id) => dom.byId.get("#" + id),
    body: () => dom.byId.get("#plug-body"),
    buttons: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-install/.test(n.className)),
    removes: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-remove/.test(n.className)),
    ones: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-remove-one/.test(n.className)),
    versionBtns: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-versions/.test(n.className)),
    switches: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-switch/.test(n.className)),
    mores: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-more/.test(n.className)),
    // the control a row LEADS with: the first child of the first row's action
    // box. Which control leads is the row's own rule, so this has to be asked of
    // the drawn row and not inferred from the controls that exist somewhere in it
    primary: () => {
      const box = walk(dom.byId.get("#plug-body")).find((n) => /(^| )plug-row-actions( |$)/.test(n.className));
      return box && box.children.length ? box.children[0] : null;
    },
    menus: () => walk(dom.byId.get("#plug-body")).filter((n) => /plug-menu/.test(n.className)),
    // what a component DECLARES, as drawn: the menu item, the box it opens, and
    // one row per key — asked of the page, never of a stored copy
    settingsBtns: () =>
      walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /(^| )plug-settings( |$)/.test(n.className)),
    settingsBox: () =>
      walk(dom.byId.get("#plug-body")).find((n) => /(^| )plug-settings-box( |$)/.test(n.className)) || null,
    settingRows: () => walk(dom.byId.get("#plug-body")).filter((n) => /(^| )plug-setting( |$)/.test(n.className)),
    settingRow: (key) => settingRowIn(dom.byId.get("#plug-body"), key),
    settingCtl: (key) => settingCtlIn(settingRowIn(dom.byId.get("#plug-body"), key)),
    settingReset: (key) => settingResetIn(settingRowIn(dom.byId.get("#plug-body"), key)),
    // what a component DECLARES, as drawn: the menu item, the box it opens, and
    // one row per key — asked of the page, never of a stored copy
    settingsBtns: () =>
      walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /(^| )plug-settings( |$)/.test(n.className)),
    settingsBox: () =>
      walk(dom.byId.get("#plug-body")).find((n) => /(^| )plug-settings-box( |$)/.test(n.className)) || null,
    settingRows: () => walk(dom.byId.get("#plug-body")).filter((n) => /(^| )plug-setting( |$)/.test(n.className)),
    settingRow: (key) => settingRowIn(dom.byId.get("#plug-body"), key),
    settingCtl: (key) => settingCtlIn(settingRowIn(dom.byId.get("#plug-body"), key)),
    settingReset: (key) => settingResetIn(settingRowIn(dom.byId.get("#plug-body"), key)),
    chips: () => walk(dom.byId.get("#plug-filter")).filter((n) => n.tag === "button" && /plug-filter-chip/.test(n.className)),
    // the number behind each chip, as drawn: one entry per chip, "" when the view
    // holds nothing (a zero is not drawn — the empty message under it says why)
    chipCounts: () =>
      walk(dom.byId.get("#plug-filter"))
        .filter((n) => /(^| )plug-filter-count( |$)/.test(n.className))
        .map((n) => n.textContent.trim()),
    nameBox: () => walk(dom.byId.get("#plug-filter")).find((n) => n.tag === "input"),
    // the component names on the page, and NOTHING ELSE: the Mirrors section draws
    // its rows through the same row builder, so a mirror's URL lands in a
    // `.plug-name` too. The mirror rows mark themselves (`.plug-mirrors`), and a
    // name inside one of them is not a component name.
    names: () => walk(dom.byId.get("#plug-body"))
      .filter((n) => /(^| )plug-name( |$)/.test(n.className))
      .filter((n) => {
        for (let c = n; c; c = c.parent) if (/(^| )plug-mirrors( |$)/.test(c.className)) return false;
        return true;
      })
      .map((n) => textOf(n)),
    // the mirror rows themselves, and the controls/fields they carry. They are
    // drawn in the SETTINGS dialog's Mirrors pane now (`#settings-mirrors`), not at
    // the foot of the plugin page: the list is a fact about this machine, and the
    // page beside it is a fact about the open tab's session.
    mirrorRows: () => walk(dom.byId.get("#settings-mirrors")).filter((n) => /(^| )plug-mirrors( |$)/.test(n.className)),
    mirrorRemoves: () => walk(dom.byId.get("#settings-mirrors")).filter((n) => n.tag === "button" && /plug-mirrors-remove/.test(n.className)),
    mirrorInput: () => walk(dom.byId.get("#settings-mirrors")).find((n) => /(^| )plug-mirrors-input( |$)/.test(n.className)),
    mirrorAddBtn: () => walk(dom.byId.get("#settings-mirrors")).find((n) => /(^| )plug-mirrors-add-btn( |$)/.test(n.className)),
    mirrorNote: () => walk(dom.byId.get("#settings-mirrors")).find((n) => /(^| )plug-mirrors-note( |$)/.test(n.className)),
    mirrorForced: () => walk(dom.byId.get("#settings-mirrors")).find((n) => /(^| )plug-mirrors-forced( |$)/.test(n.className)),
    mirrorResult: () => walk(dom.byId.get("#settings-mirrors")).find((n) => /(^| )plug-mirrors-result( |$)/.test(n.className)),
    // the Mirrors section itself, by its heading — so "the section is drawn" is a
    // claim about the page and not about a class that could be anything
    mirrorSection: () =>
      walk(dom.byId.get("#settings-mirrors")).find(
        (n) => /(^| )plug-section( |$)/.test(n.className) && walk(n).some((c) => /(^| )plug-section-title( |$)/.test(c.className) && c.textContent === "Mirrors")
      ) || null,
    // the chips inside the mirror rows, as drawn: "yours" / "shipped"
    mirrorChips: () =>
      walk(dom.byId.get("#settings-mirrors"))
        .filter((n) => /(^| )plug-mirrors( |$)/.test(n.className))
        .map((r) => walk(r).filter((c) => /(^| )plug-chip( |$)/.test(c.className)).map((c) => c.textContent).join("")),
    note: () => dom.byId.get("#plug-note"),
    // the paragraph the page used to stand under the list to explain the three
    // writes. It is gone (the confirmations say it where it is asked for), and
    // this is how a test asks whether it came back.
    caution: () => walk(dom.byId.get("#plug-body")).filter((n) => /(^| )plug-caution( |$)/.test(n.className)),
    text: () => drawnText(dom.byId.get("#plug-body")),
    // the state line of one component's row, or null when that row is not drawn
    state: (name) => stateOf(dom.byId.get("#plug-body"), name),
    stateText: (name) => {
      const el = stateOf(dom.byId.get("#plug-body"), name);
      return el ? el.textContent : "";
    },
    open: async () => { vm.runInContext("pluginTabShown()", ctx); await settle(); },
    // ...and the other surface: the settings dialog's Mirrors tab is what the list
    // is drawn behind now, and its click is what starts the list's own read
    showMirrors: async () => {
      dom.byId.get("#settings-tab-mirrors").click();
      await settle();
    },
  };
}

// ---- the page loads this file at all ----
const mod = uiModules().find((m) => m.file === "components-panel.ts");
check(Boolean(mod), "boot.ts loads this module (uiModules() is boot.ts's own import list)");
// the source as a runnable classic script: imports dropped, types stripped. What
// the file used to take from the page's global scope ($, the bridges) the context
// below still provides; nothing else crosses a module boundary at load.
const CODE = mod ? rendererScript("components-panel") : "";

(async function main() {
  // 1. a row per market entry, each with its own install control
  {
    const p = page();
    await p.open();
    check(p.buttons().length === 2, "every market entry gets its own install control");
    check(p.buttons().map(ownerName).join(",") === "clutch-workspace,clutch-memory", "each control belongs to the row it installs");
    check(p.buttons().every((b) => b.textContent === "Install"), "a component the machine does not hold offers 'Install'");
    check(p.buttons().every((b) => !b.disabled), "and the control is live once the target is known");
    // I5 is a fact about the WRITES, and it is said where one is asked for — the
    // confirmations in section 8/10 — not as a standing paragraph under the list.
    // The list is the list: a page that explains itself at rest is a manual, and
    // this build has none. Nothing is drawn in the place that paragraph held.
    check(!/neither is a rollback/.test(p.text()), "the list carries no standing essay on what a write costs");
    check(p.caution().length === 0, "and nothing is drawn where that paragraph used to be (.plug-caution)");
  }

  // 2. an unreachable target never draws a live button
  {
    const died = page({ target: { kind: "remote", base: "" } });
    await died.open();
    check(died.buttons().every((b) => b.disabled), "a tunnel with no supervisor URL leaves every button dead");
    check(/no supervisor URL/.test(died.buttons()[0].title), "and the button says why");

    const lost = page({ listError: "the supervisor did not answer" });
    await lost.open();
    check(lost.buttons().every((b) => b.disabled), "a target whose read failed leaves every button dead");
    check(/the supervisor did not answer/.test(lost.buttons()[0].title), "and the button is the failure itself, not an empty offer");
    check(/the supervisor did not answer/.test(lost.note().textContent), "while the note carries the reason the read failed");

    // an unreadable INVENTORY is different: the machine is known and has a URL,
    // so the write is offered — the inventory is a shortcut, and the host decides
    const unread = page({ held: [], heldError: "the supervisor did not answer" });
    await unread.open();
    check(unread.buttons().every((b) => !b.disabled), "an inventory that could not be read still offers the write");
    check(/could not be read; the host still decides/.test(unread.buttons()[0].title), "and the button says the host is the one deciding");
  }

  // 3. the label is the target's own inventory: same version says Reinstall
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    const labels = p.buttons().map((b) => b.textContent);
    check(labels[0] === "Reinstall" && labels[1] === "Install", "a version the machine already carries says 'Reinstall', the other still 'Install'");
    check(/already holds clutch-workspace 0.1.0\+5f900739/.test(p.buttons()[0].title), "and its title says what it will rewrite");
  }

  // 3b. a record from before installs carried a version is an UPDATE, not a
  // reinstall: the release was never recorded, so there is no release to compare
  // against — the page must not call a bare digest "already holds 0.1.0"
  // (old records are replaced, not kept beside the new shape).
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "5f900739e6a35f43", digest: "5f900739e6a35f43" }] });
    await p.open();
    check(p.buttons()[0].textContent === "Update", "a digest-only record is an update, never 'Reinstall'");
    check(
      /before installs carried a version/.test(p.buttons()[0].title) &&
        /0\.1\.0\+5f900739e6a35f43 replaces it/.test(p.buttons()[0].title),
      "the title names the record being replaced and the version the reinstall gives it"
    );
    p.chips()[3].click();
    check(p.names().join(",") === "clutch-workspace", "the Updates view counts it before any release number moves");
  }

  // 4. the question names the PLACE the bytes land in, and the fact that cannot
  // be undone. The place is not chosen and not discovered here: it came off the
  // declaration (ui/components.js destinationOf), which is why a question that
  // named a machine would be asking the user to confirm a fact nobody picks.
  {
    const p = page({ store: { clutch_ssh_host: "10.0.0.5", clutch_ssh_user: "ubuntu", clutch_ssh_port: "22" } , target: REMOTE });
    await p.open();
    p.world.answer = false;
    p.buttons()[0].click();
    await settle();
    const ask = p.world.confirms[0];
    check(p.world.confirms.length === 1 && ask.ok === "Install", "installing asks first, with the verb on the button");
    check(/into the component directory on the session machine/.test(ask.text), "the question names the place the bytes land in");
    check(/neither act is a rollback/.test(ask.text), "and says what the write costs: removable again, but never a rollback (I5)");
    check(p.world.installCalls.length === 0, "a declined install writes nothing");
    check(p.note().textContent === "", "and leaves no verdict behind");
  }

  // 4b. no machine is NAMED on this page, and none can be picked (I2). The place a
  // component goes to is a fact of its declaration, so the page neither asks for it
  // nor prints it as a heading: a session on the far side of an SSH bridge is the
  // case that used to be drawn as "Local (this machine)", because the page was
  // describing the window it lived in instead of where the bytes go.
  {
    const remote = { clutch_ssh_host: "10.0.0.5", clutch_ssh_user: "ubuntu", clutch_ssh_port: "22" };
    const p = page({ store: { ...remote, clutch_ssh_connected: "1" }, session: { clutch_api_url: "http://127.0.0.1:7788" }, target: REMOTE });
    await p.open();
    check(p.el("plug-target") === undefined && p.el("plug-base") === undefined, "the header has no target element to fill in");
    check(!/10\.0\.0\.5|ubuntu@|this machine|Local \(/.test(p.text()), "and nothing in the pane names a machine or an ssh address");
    check(p.world.listCalls === 1, "the page still read the session inventory, which is what the place means");
  }

  // 4c. a plugin goes to this client, and every sentence that would once have
  //     named a machine names the place instead: the row facts, the control, the
  //     question, the stage line. The routing is NOT this page business
  //     (ui/components-view.js dispatches on the same declaration), which is why
  //     the page can only be right about WHERE by quoting the declaration.
  {
    const entry = { name: "clutch-websearch", place: "client", version: "0.2.0", origin: "checkout", source: "…/clutch-websearch", published: null };
    const p = page({ entries: [entry], client: true });
    await p.open();
    check(
      !/goes to|this client|the session machine/.test(rowNamed(p.body(), "clutch-websearch").title),
      "the row facts do not restate the place: it is the declaration's, it is not a choice, and the row already draws what it means"
    );
    check(p.buttons()[0].title === "install clutch-websearch on this client", "and the control says the same place, with no third one to pick");
    p.world.control = defer();
    p.buttons()[0].click();
    await settle(2);
    check(/written into the component directory on this client/.test(p.world.confirms[0].text), "the question names the client the bytes stay on");
    check(p.world.installCalls.join(",") === "clutch-websearch", "and the same one channel carries it: the page never routes bytes itself");
    p.world.progress({ stage: "copy", name: "clutch-websearch", version: "0.2.0" });
    check(
      /bringing clutch-websearch 0\.2\.0 onto this client…/.test(p.stateText("clutch-websearch")),
      "the copy stage is the one a plugin install has, and it says where the bytes are going"
    );
    p.world.control.res({ ok: true, name: "clutch-websearch", place: "client", version: "0.2.0", path: "/home/u/.clutch/client/clutch-websearch" });
    await settle();
    check(
      /^installed clutch-websearch 0\.2\.0 on this client · \/home\/u\/\.clutch\/client/.test(p.stateText("clutch-websearch")),
      "and the verdict says the client, with the path it landed at"
    );
  }

  // 4d. a declaration that cannot be placed is refused BEFORE any byte is built,
  //     and the refusal is the declaration own sentence — not a dead button with
  //     no reason beside it (a place this build cannot derive is not a place the
  //     user may choose)
  {
    const problem =
      "clutch-odd declares `entry` and `launch`: `entry` is the module this client runs for a component with no " +
      "process here, and that one starts a process where the session's commands run";
    const p = page({ entries: [{ name: "clutch-odd", place: null, problem, version: "1.0.0", origin: "release", source: "…/clutch-odd", published: null }] });
    await p.open();
    check(p.buttons()[0].disabled, "the Install beside a contradictory declaration is dead");
    check(p.buttons()[0].title === problem, "and its title is that sentence, quoted rather than paraphrased");
    check(p.text().includes(problem), "the row line is the sentence too, so it is readable without hovering");
    p.buttons()[0].click();
    await settle();
    check(p.world.confirms.length === 0 && p.world.installCalls.length === 0, "and a click on it asks nothing and writes nothing");
  }

  // 4e. the two places fail on their own, and each row carries the reason of ITS
  //     place: a session inventory that did not arrive is one sentence (the page
  //     line), a client domain that would not open is another (the client row
  //     facts), and neither is ever drawn as "nothing is installed there"
  {
    const entries = [
      { name: "clutch-workspace", place: "session", version: "0.1.0", origin: "checkout", source: "…/clutch-workspace", published: null },
      { name: "clutch-websearch", place: "client", version: "0.2.0", origin: "checkout", source: "…/clutch-websearch", published: null },
    ];
    const p = page({ entries, heldError: "the supervisor did not answer", client: true, clientHeldError: "the plugin table is unreadable" });
    await p.open();
    check(/the supervisor did not answer/.test(p.note().textContent), "the session reason is the page line");
    const clientRow = rowNamed(p.body(), "clutch-websearch");
    check(/on this client, unknown/.test(drawnText(clientRow)), "while the client row says its place is unknown, not empty");
    check(/the plugin table is unreadable/.test(clientRow.title), "and its facts carry the sentence that explains it");
    check(p.buttons().every((b) => !b.disabled), "a place whose list failed still receives bytes: it is a shelf that was not read, not a place that is gone");
    check(
      /what the session machine holds could not be read; the host still decides/.test(p.buttons()[0].title) &&
        /what this client holds could not be read; the host still decides/.test(p.buttons()[1].title),
      "and both controls say the host is still the one deciding"
    );
  }

  // 4f. nothing is offered for a place this page has not found yet: a read still
  //     in flight is not a licence to write somewhere
  {
    const p = page();
    vm.runInContext(
      "plugState.market = { entries: [{ name: 'clutch-workspace', place: 'session', version: '0.1.0', origin: 'release', source: 'x' }], errors: [] }; renderPlugins();",
      p.ctx
    );
    check(p.buttons().length === 1 && p.buttons()[0].disabled, "a row drawn before the read answered has a dead Install");
    check(/not been read yet/.test(p.buttons()[0].title), "and its title says nothing is sent to a place the page has not found");
    await p.open();
    check(!p.buttons()[0].disabled, "once the read lands, the same row offers the write");
  }

  // 5. the happy path: stages as they happen, then the host's verdict, then a re-read
  {
    const p = page();
    await p.open();
    const before = p.world.listCalls;
    p.world.control = defer();
    p.buttons()[0].click();
    await settle(3);
    check(p.world.installCalls.join(",") === "clutch-workspace", "the confirmed install hands that name to the channel");
    // U5: the write is reported on the row it changes, not in the page's note
    check(/installing clutch-workspace/.test(p.stateText("clutch-workspace")), "the row says what is happening to it while it happens");
    check(p.note().textContent === "", "and the page's own note says nothing about a write a row is carrying");
    check(p.buttons().every((b) => b.disabled), "and every button is dead while a write is in flight");
    p.world.progress({ stage: "artifact", name: "clutch-workspace" });
    check(/preparing the bytes/.test(p.stateText("clutch-workspace")), "the building stage is drawn");

    // a local install may have to start this machine's supervisor first (it exits
    // when it is idle): the page says so, because the first start is the slow one
    p.world.progress({ stage: "wake", name: "clutch-workspace" });
    check(
      /the session machine is starting its supervisor/.test(p.stateText("clutch-workspace")),
      "the wake stage says the target machine's supervisor is coming up"
    );

    p.world.progress({ stage: "upload", name: "clutch-workspace", version: "0.1.0+5f900739" });
    check(/sending clutch-workspace 0\.1\.0\+5f900739 to the session machine/.test(p.stateText("clutch-workspace")), "the upload stage names the bytes and the machine");
    p.world.progress({ stage: "upload", name: "clutch-memory" });
    check(/sending clutch-workspace/.test(p.stateText("clutch-workspace")), "a stage from another window's install is ignored");

    // the other shape: no bytes travel from this machine at all, so the stage says
    // which machine is doing the moving
    p.world.progress({ stage: "fetch", name: "clutch-workspace", version: "0.1.0+5f900739" });
    check(
      /the session machine is fetching clutch-workspace 0\.1\.0\+5f900739/.test(p.stateText("clutch-workspace")),
      "the fetch stage says the target machine is getting its own bytes, not receiving ours"
    );
    p.world.progress({ stage: "fetch", name: "clutch-memory" });
    check(/is fetching clutch-workspace/.test(p.stateText("clutch-workspace")), "and a fetch stage is read per window like every other one");

    p.world.control.res({ ok: true, status: "installed", version: "0.1.0+5f900739", digest: "5f900739e6a35f43", path: "/home/u/.clutch/components/clutch-workspace" });
    await settle();
    check(/^installed clutch-workspace 0\.1\.0\+5f900739 on the session machine · \/home\/u/.test(p.stateText("clutch-workspace")), "the verdict is the host's, with the path it landed at, and it stays on that row");
    check(/busy/.test(p.state("clutch-workspace").className) === false, "the row is no longer drawn as busy once the write is over");
    check(p.state("clutch-workspace").className.includes("error") === false, "a successful install is not drawn as an error");
    check(p.world.listCalls > before, "the machine's inventory is read again after it changed");
  }

  // 6. a verdict of 'current' sends nothing and says so
  {
    const p = page();
    await p.open();
    p.world.reply = { ok: true, status: "current", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" };
    p.buttons()[0].click();
    await settle();
    check(/already current \(0\.1\.0\+5f900739\) on the session machine — nothing was sent/.test(p.stateText("clutch-workspace")), "the host's 'current' verdict is reported as nothing sent");
  }

  // 7. a refusal is quoted, not paraphrased, and drawn as a failure
  {
    const p = page();
    await p.open();
    p.world.reply = { ok: false, name: "clutch-workspace", error: "artifact sha256 does not match the declaration" };
    p.buttons()[0].click();
    await settle();
    check(p.stateText("clutch-workspace").includes("artifact sha256 does not match the declaration"), "the host's own refusal reaches the page verbatim");
    check(p.state("clutch-workspace").className.includes("error"), "and is drawn as a failure");
    check(p.buttons().every((b) => !b.disabled), "the buttons come back once the write failed");
  }

  // 8. a broken IPC hop is a failure with a reason, not a silent no-op
  {
    const p = page();
    await p.open();
    p.ctx.window.clutchComponents.install = async () => { throw new Error("main process is gone"); };
    p.buttons()[1].click();
    await settle();
    check(/could not install clutch-memory .*main process is gone/.test(p.stateText("clutch-memory")), "a channel that threw is reported as the install's reason");
  }

  // 9. the reverse verb is offered where the component is: the row that names
  //    what this machine holds is the row that can take it away
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    check(p.removes().length === 1, "an installed component gets a removal control, one per held row");
    check(ownerName(p.removes()[0]) === "clutch-workspace", "and it belongs to the row it would empty");
    check(p.removes()[0].textContent === "Remove", "the control says what it does");
    check(/remove clutch-workspace 0\.1\.0\+5f900739 from the session machine/.test(p.removes()[0].title), "and its title names the machine that would lose the bytes");
  }

  // 10. asking first, and the question is the whole point: a removal is a
  //     DELETION, not a rollback (I5 — the page must not dress it up as one)
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.answer = false;
    p.removes()[0].click();
    await settle();
    const ask = p.world.confirms[0];
    check(p.world.confirms.length === 1 && ask.ok === "Remove", "removing asks first, with the verb on the button");
    check(/is deleted from the component directory on the session machine/.test(ask.text), "the question says the bytes are deleted, and where");
    check(/cannot be undone from here/.test(ask.text), "and that nothing here can put them back (I5)");
    check(p.world.removeCalls.length === 0, "a declined removal deletes nothing");
    check(p.note().textContent === "", "and leaves no verdict behind");
  }

  // 11. the happy path: the host's verdict names the versions that went, and the
  //     machine is read back — the row it emptied is gone from the page next time
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    const before = p.world.listCalls;
    p.world.removeReply = { ok: true, status: "removed", removed: ["0.1.0+5f900739"] };
    p.removes()[0].click();
    await settle();
    check(p.world.removeCalls.join(",") === "clutch-workspace", "the confirmed removal hands that name to the channel");
    check(
      p.world.slots.filter((c) => c[0] === "remove").every((c) => c[2] === "session"),
      "and it is aimed by the place the row named, not by the component's name (a name is not a place)"
    );
    check(/^removed clutch-workspace 0\.1\.0\+5f900739 from the session machine$/.test(p.stateText("clutch-workspace")), "the host's verdict names the versions that went");
    check(p.state("clutch-workspace").className.includes("error") === false, "a completed removal is not drawn as an error");
    check(p.world.listCalls > before, "and the machine's inventory is read again after it changed");
  }

  // 12. "absent" is an ANSWER, not a failure: the request was already true, so
  //     nothing was there to remove and nothing is reported as broken
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.removeReply = { ok: true, status: "absent", removed: [] };
    p.removes()[0].click();
    await settle();
    check(/^clutch-workspace was not installed on the session machine — there was nothing to remove$/.test(p.stateText("clutch-workspace")), "a component that was already gone is reported as nothing to remove");
    check(p.state("clutch-workspace").className.includes("error") === false, "and it is not drawn as a failure");
  }

  // 13. a refusal is the host's sentence, quoted: what is running the component
  //     is the host's to know, and this page must not paraphrase it away
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.removeReply = {
      ok: false,
      name: "clutch-workspace",
      error: "clutch-workspace is being served right now by a daemon this process did not start (pid 4242): stop it first",
    };
    p.removes()[0].click();
    await settle();
    check(p.stateText("clutch-workspace").includes("pid 4242"), "the host's own refusal reaches the page verbatim");
    check(p.state("clutch-workspace").className.includes("error"), "and is drawn as a failure");
    check(p.removes()[0].disabled === false, "the control comes back once the write failed");

    const broken = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await broken.open();
    broken.ctx.window.clutchComponents.remove = async () => { throw new Error("main process is gone"); };
    broken.removes()[0].click();
    await settle();
    check(/could not remove clutch-workspace .*main process is gone/.test(broken.stateText("clutch-workspace")), "a channel that threw is reported as the removal's reason");
  }

  // 14. one write at a time, including across the two directions: a removal in
  //     flight disables the installs, an install in flight disables the removals
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.control = defer();
    p.removes()[0].click();
    await settle(3);
    check(/removing clutch-workspace from the session machine/.test(p.stateText("clutch-workspace")), "the row says what is being removed from it, while it is being removed");
    check(p.removes().every((b) => b.disabled), "and the removal control is dead for the duration");
    check(p.buttons().every((b) => b.disabled), "as is every install control (one write at a time)");
    p.world.control.res({ ok: true, status: "removed", removed: ["0.1.0+5f900739"] });
    await settle();
    check(p.buttons().every((b) => !b.disabled), "and the installs come back once the write is over");
  }

  // 15. a target the page cannot name is no target: no supervisor URL, no removal
  {
    const died = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }], target: { kind: "remote", base: "" } });
    await died.open();
    check(died.removes().every((b) => b.disabled), "a tunnel with no supervisor URL leaves the removal control dead");
    check(/no supervisor URL/.test(died.removes()[0].title), "and it says why");
  }

  // 16. a read started from the tab shows the pending line, not a stale verdict:
  //     the verdict lived on the row it was about, so a reload — a request for
  //     facts, not a place to keep a report — takes it away with the row it was
  //     drawn on
  {
    const p = page();
    await p.open();
    check(p.buttons().length === 2, "the first read drew the market");
    p.world.reply = { ok: true, status: "installed", version: "0.1.0+x", digest: "x" };
    p.buttons()[0].click();
    await settle();
    const kept = p.stateText("clutch-workspace");
    check(/^installed clutch-workspace 0\.1\.0\+x/.test(kept), "the last verdict is drawn on the row it is about");
    p.el("plug-reload").click(); // a refresh is a request for facts, not a place to keep a report
    check(p.stateText("clutch-workspace") === "", "a reload drops the last verdict with the row it was drawn on");
    check(/reading/.test(p.note().textContent), "and the note says what it is doing now");
    await settle();
    check(p.world.marketCalls >= 2, "and it re-reads the market (force)");
  }

  // 17. the switch is offered where the held fact is, and it says what it does
  //     NOT touch: the bytes stay, the row stays, only the tools go
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    check(p.switches().length === 1, "an installed component gets a switch, one per held row");
    check(ownerName(p.switches()[0]) === "clutch-workspace", "and it belongs to the row whose fact it changes");
    check(p.switches()[0].textContent === "Disable", "a component the machine is driving offers 'Disable'");
    check(
      /stop the session machine driving clutch-workspace/.test(p.switches()[0].title),
      "and its title names the machine it stops, not the bytes"
    );
    check(/nothing is deleted/.test(p.switches()[0].title), "the title says the bytes are untouched");
    check(!/stopped/.test(p.text().split("clutch-memory")[0]), "nothing is drawn as stopped while the machine is driving it");
    check(!/(^| )stopped( |$)/.test(rowNamed(p.body(), "clutch-workspace").className), "and the row itself is not coloured as stopped either");

    // a component the machine holds but does not drive says so as a state, not
    // as a hint: the chip and the line both carry it
    const held = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43", disabled: true }] });
    await held.open();
    check(held.switches()[0].textContent === "Enable", "a component that is held but not driven offers 'Enable'");
    check(/drive clutch-workspace on the session machine again/.test(held.switches()[0].title), "and its title names the machine it drives again");
    check(/its bytes stay where they are/.test(held.switches()[0].title), "still saying the bytes are what does not move");
    check(
      /^clutch-workspace stopped$/.test(textOf(headOf(rowNamed(held.body(), "clutch-workspace")))),
      "the row carries a 'stopped' chip beside the name"
    );
    check(
      /(^| )stopped( |$)/.test(rowNamed(held.body(), "clutch-workspace").className),
      "and the whole row is coloured as stopped, not just the chip (U-7)"
    );
    check(/held on the session machine, but not driven/.test(held.text()), "and a line saying it is still held (so 'stopped' is not read as 'gone')");
    check(held.removes().length === 1, "a stopped component is still listed and can still be removed");
  }

  // 18. the switch asks NOTHING: it deletes nothing and its own label is the way
  //     back, so a confirmation here would only teach the user to click through
  //     the two that are not free
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    const before = p.world.listCalls;
    p.world.switchReply = { ok: true, status: "disabled" }; // no bit on the verdict
    p.switches()[0].click();
    await settle();
    check(p.world.confirms.length === 0, "switching asks no question (nothing is destroyed and the act is its own undo)");
    check(JSON.stringify(p.world.switchCalls) === JSON.stringify([["clutch-workspace", true]]), "the state asked for goes on the wire, not a verb");
    check(
      p.world.slots.filter((c) => c[0] === "setDisabled").every((c) => c[2] === "session"),
      "and the switch says which place it is switching, so a client plugin is never aimed at the session machine"
    );
    check(
      /^stopped driving clutch-workspace on the session machine — it is still held there, its tools are no longer offered$/.test(p.stateText("clutch-workspace")),
      "the verdict says the component is still held (the machine's own bit, when it sent one, else the state asked for)"
    );
    check(p.state("clutch-workspace").className.includes("error") === false, "a completed switch is not drawn as a failure");
    check(p.world.listCalls > before, "the machine is read back after the switch, so the row is drawn as it now is");
  }

  // 19. the other direction sends the other state, and says the tools are back
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43", disabled: true }] });
    await p.open();
    p.world.switchReply = { ok: true, status: "enabled", disabled: false };
    p.switches()[0].click();
    await settle();
    check(JSON.stringify(p.world.switchCalls) === JSON.stringify([["clutch-workspace", false]]), "an Enable sends disabled=false — the state, the way the host spells it");
    check(
      /^driving clutch-workspace on the session machine again — its tools are offered once more$/.test(p.stateText("clutch-workspace")),
      "and the verdict says the tools are offered again"
    );
    check(p.world.confirms.length === 0, "starting a component again is as unceremonious as stopping it");
  }

  // 20. "absent" is an ANSWER, not a failure: that machine holds nothing of this
  //     name, so there was nothing to stop or start — which usually means the
  //     switch was aimed at a machine that is not the one holding it
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.switchReply = { ok: true, status: "absent", disabled: false };
    p.switches()[0].click();
    await settle();
    check(
      /^clutch-workspace is not held by the session machine — there was nothing to stop or start$/.test(p.stateText("clutch-workspace")),
      "a component that machine does not hold is reported as nothing to switch"
    );
    check(p.state("clutch-workspace").className.includes("error") === false, "and it is not drawn as a failure");
  }

  // 21. a refusal is the host's sentence, quoted, and a broken hop is a failure
  //     with a reason
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.switchReply = {
      ok: false,
      name: "clutch-workspace",
      error: "component name clutch-workspace is declared 'data': it holds no tools to stop",
    };
    p.switches()[0].click();
    await settle();
    check(p.stateText("clutch-workspace").includes("it holds no tools to stop"), "the host's own refusal reaches the page verbatim");
    check(p.state("clutch-workspace").className.includes("error"), "and is drawn as a failure");
    check(p.switches()[0].disabled === false, "the control comes back once the write failed");

    const broken = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await broken.open();
    broken.ctx.window.clutchComponents.setDisabled = async () => { throw new Error("main process is gone"); };
    broken.switches()[0].click();
    await settle();
    check(/could not switch clutch-workspace .*main process is gone/.test(broken.stateText("clutch-workspace")), "a channel that threw is reported as the switch's reason");
  }

  // 22. one write at a time, across all three directions: a switch in flight
  //     stops the installs and the removal too, and each dead control says which
  //     act is the one holding it up
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.control = defer();
    p.switches()[0].click();
    await settle(3);
    check(/stopping clutch-workspace on the session machine…/.test(p.stateText("clutch-workspace")), "the row says what is being stopped, while it is being stopped");
    check(/is being stopped/.test(p.removes()[0].title), "and the removal control names the act that is holding it up, not 'installed'");
    check(p.switches().every((b) => b.disabled), "the switch is dead for the duration");
    check(p.buttons().every((b) => b.disabled), "so is every install control");
    p.world.control.res({ ok: true, status: "disabled", disabled: true });
    await settle();
    check(p.switches().every((b) => !b.disabled), "and the switch comes back once the write is over");

    const back = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43", disabled: true }] });
    await back.open();
    back.world.control = defer();
    back.switches()[0].click();
    await settle(3);
    check(/driving clutch-workspace on the session machine again…/.test(back.stateText("clutch-workspace")), "the other direction has its own sentence");
    back.world.control.res({ ok: true, status: "enabled", disabled: false });
    await settle();
  }

  // 23. a target the page cannot name is no target: no supervisor URL, no switch
  {
    const died = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }], target: { kind: "remote", base: "" } });
    await died.open();
    check(died.switches().every((b) => b.disabled), "a tunnel with no supervisor URL leaves the switch dead");
    check(/no supervisor URL/.test(died.switches()[0].title), "and it says why");
  }

  // 24. a shell that never got the verb draws no control that looks like one
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    p.ctx.window.clutchComponents.setDisabled = undefined;
    await p.open();
    check(p.switches()[0].disabled, "a shell without setDisabled leaves the switch dead rather than silently inert");
    check(/cannot switch components at all/.test(p.switches()[0].title), "and it says the shell cannot, not that the place refused");
  }

  // 25. the version list is a disclosure on the held row: the machine's own
  //     answer, in the machine's own order, one row per version — and each
  //     version row names ITSELF as what its control takes
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await p.open();
    check(p.versionBtns().length === 1, "one disclosure per held row opens the versions behind it");
    check(ownerName(p.versionBtns()[0]) === "clutch-workspace", "and it belongs to the row whose versions it would show");
    check(p.versionBtns()[0].textContent === "Versions", "closed, it offers to open");
    check(/newest first/.test(p.versionBtns()[0].title), "its title says what will be shown");
    check(/the marked one is what that place runs/.test(p.versionBtns()[0].title), "and which mark is the one that matters");
    check(p.ones().length === 0, "nothing per-version is drawn before it is asked for");
    p.versionBtns()[0].click();
    await settle();
    check(p.world.versionsCalls.join(",") === "clutch-workspace", "opening reads that one component from the machine that holds it");
    check(/this one is run/.test(p.text()), "the version the host resolved is marked as the one that runs");
    check(/held beside it/.test(p.text()), "and the others are drawn as held beside it, not as failures");
    check(/0\.1\.0\+bbbb/.test(p.text()) && /0\.1\.0\+aaaa/.test(p.text()), "every version the machine named is drawn");
    check(
      ownerName(p.ones()[0]) === "0.1.0+bbbb" && ownerName(p.ones()[1]) === "0.1.0+aaaa",
      "in the host's own order, newest first — this page never re-sorts it"
    );
    check(p.ones().length === 2, "each version gets its own removal control");
    check(ownerName(p.ones()[0]) === "0.1.0+bbbb", "and each control belongs to the version row that names what it takes");
    check(/remove clutch-workspace 0\.1\.0\+bbbb from the session machine/.test(p.ones()[0].title), "its title names the machine that would lose those bytes");
    check(/the versions beside it stay/.test(p.ones()[0].title), "and says the versions beside it stay — one version is not the whole component");
    p.versionBtns()[0].click();
    await settle();
    check(p.versionBtns()[0].textContent === "Versions" && p.ones().length === 0, "the second click closes it again");
    check(p.world.versionsCalls.length === 1, "closing reads nothing — the list was read once, on open");
  }

  // 26. the version rows carry what the machine said: the digest it is pinned
  //     by, where it is kept, and the stop bit of a component that is held but
  //     not driven
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await p.open();
    p.world.versionsReply = {
      versions: [
        { name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000", path: "/home/u/.clutch/components/clutch-workspace/0.1.0+bbbb", resolved: true, disabled: true },
      ],
      error: null,
    };
    p.versionBtns()[0].click();
    await settle();
    check(/digest bbbb0000bbbb0000/.test(p.text()), "each version carries the digest the host records for it");
    check(/at \/home\/u\/\.clutch\/components\/clutch-workspace\/0\.1\.0\+bbbb/.test(p.text()), "and where on that machine it is kept");
    check(/0\.1\.0\+bbbb stopped/.test(p.text()), "a version of a component the machine holds but does not drive is marked here too");
    check(p.ones().length === 1, "and a stopped version can still be let go of");
  }

  // 27. a read that failed is a reason, never an empty list: "no versions" and
  //     "the machine could not be asked" are not the same fact
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await p.open();
    p.world.versionsReply = { versions: [], error: "the supervisor did not answer" };
    p.versionBtns()[0].click();
    await settle();
    check(/could not be read — the supervisor did not answer/.test(p.text()), "the reason the read failed is what is drawn");
    check(!/no version of it is held/.test(p.text()), "an unreadable list is never drawn as an empty one");
    check(p.ones().length === 0, "and no control is drawn for versions the page has not heard of");

    const broken = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await broken.open();
    broken.ctx.window.clutchComponents.versions = async () => { throw new Error("main process is gone"); };
    broken.versionBtns()[0].click();
    await settle();
    check(/could not be read — main process is gone/.test(broken.text()), "a channel that threw is reported as the read's reason");

    const gone = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await gone.open();
    gone.world.versionsReply = { versions: [], error: null };
    gone.versionBtns()[0].click();
    await settle();
    check(/no version of it is held here now/.test(gone.text()), "an empty list the machine DID answer with is drawn as one");
  }

  // 28. the disclosure is a read and stays live behind a write, but a target
  //     the page cannot name is no target — and a shell without the verb draws
  //     no control that looks like one
  {
    const died = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }], target: { kind: "remote", base: "" } });
    await died.open();
    check(died.versionBtns().every((b) => b.disabled), "a tunnel with no supervisor URL leaves the disclosure dead");
    check(/no supervisor URL/.test(died.versionBtns()[0].title), "and it says why");

    const deaf = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    deaf.ctx.window.clutchComponents.versions = undefined;
    await deaf.open();
    check(deaf.versionBtns()[0].disabled, "a shell without versions leaves the disclosure dead rather than silently inert");
    check(/cannot read a version list at all/.test(deaf.versionBtns()[0].title), "and it says the shell cannot, not that the place refused");
  }

  // 29. letting ONE version go: asks first, names that version, and quotes the
  //     host — a version not installed is a REFUSAL, not "absent" (the host's
  //     rule: `?version=` naming what is not there is a request that is wrong)
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await p.open();
    p.versionBtns()[0].click();
    await settle();
    p.world.answer = false;
    p.ones()[0].click();
    await settle();
    const ask = p.world.confirms[0];
    check(p.world.confirms.length === 1 && ask.ok === "Remove", "removing one version asks first, with the verb on the button");
    check(ask.title === "Remove clutch-workspace 0.1.0+bbbb?", "and the question is about that one version");
    check(/exactly the version named/.test(ask.text), "it says exactly that version goes");
    check(/the versions beside it stay/.test(ask.text), "and that the versions beside it stay — this is not the whole component");
    check(/cannot be undone from here/.test(ask.text), "while still saying what a deletion costs (I5)");
    check(p.world.removeCalls.length === 0, "a declined removal deletes nothing");
    check(p.note().textContent === "", "and leaves no verdict behind");

    const go = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await go.open();
    go.versionBtns()[0].click();
    await settle();
    const before = go.world.listCalls;
    go.world.removeReply = { ok: true, status: "removed", removed: ["0.1.0+bbbb"] };
    go.ones()[0].click();
    await settle();
    check(go.world.removeCalls.join(",") === "clutch-workspace", "the name goes to the channel like any removal");
    check(go.world.removeOpts[0] && go.world.removeOpts[0].version === "0.1.0+bbbb", "and the version names which one — the whole-component removal sends no such thing");
    check(/^removed clutch-workspace 0\.1\.0\+bbbb from the session machine$/.test(go.stateText("clutch-workspace")), "the host's verdict names the version that went");
    check(go.world.listCalls > before, "the machine's inventory is read again after it changed");
    check(go.world.versionsCalls.length === 2, "and so is the open version list — what it shows is what the machine now holds");

    const refused = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await refused.open();
    refused.versionBtns()[0].click();
    await settle();
    refused.world.removeReply = { ok: false, name: "clutch-workspace", error: "no such version of clutch-workspace here: 0.1.0+zzzz" };
    refused.ones()[0].click();
    await settle();
    check(refused.stateText("clutch-workspace").includes("no such version of clutch-workspace here"), "the host's own refusal reaches the page verbatim");
    check(refused.state("clutch-workspace").className.includes("error"), "and is drawn as a failure");
    check(refused.ones()[0].disabled === false, "the control comes back once the write failed");
  }

  // 30. one write at a time reaches the per-version controls too, in both
  //     directions — and a version removal says WHICH version it is taking
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await p.open();
    p.versionBtns()[0].click();
    await settle();
    p.world.control = defer();
    p.switches()[0].click();
    await settle(3);
    check(p.ones().every((b) => b.disabled), "a switch in flight leaves every per-version removal dead");
    check(/is being stopped/.test(p.ones()[0].title), "and each names the act that is holding it up");
    check(p.versionBtns()[0].disabled === false, "the disclosure is a read: it stays live behind a write");
    p.world.control.res({ ok: true, status: "disabled", disabled: true });
    await settle();

    const one = page({ held: [{ name: "clutch-workspace", version: "0.1.0+bbbb", digest: "bbbb0000bbbb0000" }] });
    await one.open();
    one.versionBtns()[0].click();
    await settle();
    one.world.control = defer();
    one.ones()[0].click();
    await settle(3);
    check(/removing clutch-workspace 0\.1\.0\+bbbb from the session machine/.test(one.stateText("clutch-workspace")), "a removal of ONE version names that version while it happens");
    check(one.removes().every((b) => b.disabled) && one.switches().every((b) => b.disabled) && one.buttons().every((b) => b.disabled), "one write at a time, across every control");
    one.world.control.res({ ok: true, status: "removed", removed: ["0.1.0+bbbb"] });
    await settle();
    check(one.removes().every((b) => !b.disabled), "and the controls come back once the write is over");
  }

  // 31. one row = one primary write + one "…": which control leads follows the
  //     row's own state, and everything beside it is a menu that is DRAWN while
  //     it is shut. Opening it builds nothing, so the items can be asked about
  //     (and pressed) without the page first being clicked into a state.
  {
    // held, and this client offers nothing newer: the write the row leads with is
    // the switch — the Install action is GONE, not greyed, once the bytes are on
    // the machine (extensionsActions.ts:472-500)
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    check(p.primary() === p.switches()[0], "the row leads with the one write its state calls for");
    check(p.primary().textContent === "Disable", "which on an installed component is the switch, not Install");
    check(
      walk(rowNamed(p.body(), "clutch-workspace"))
        .filter((n) => /plug-install/.test(n.className))
        .every((b) => b.textContent === "Reinstall"),
      "and nothing on that row says 'Install' any more"
    );
    check(p.mores().length === 1, "and offers ONE '…' beside it, not a row of controls");
    check(ownerName(p.mores()[0]) === "clutch-workspace", "which belongs to the row whose actions it holds");
    check(p.menus().length === 1, "and holds one menu");
    check(p.menus()[0].classList.contains("open") === false, "closed on the first draw");
    check(
      p.menus()[0].children.length === 4 && p.menus()[0].children.every((c) => c.tag === "button"),
      "while the items are already in it: the settings it declares, the write this client can still make, the versions, the removal"
    );
    check(p.buttons()[0].textContent === "Reinstall", "the write kept beside the switch is the same release again");
    check(p.mores()[0].getAttribute("aria-expanded") === "false", "the '…' answers for the menu it holds before it is opened");
    check(
      p.mores()[0].getAttribute("aria-controls") === p.menus()[0].id && Boolean(p.menus()[0].id),
      "and names the box it opens, which is why that box carries an id"
    );
    check(p.mores()[0].getAttribute("aria-haspopup") === "true", "and says it opens something at all");
    check(
      /more actions for clutch-workspace on/.test(p.mores()[0].getAttribute("aria-label") || ""),
      "and carries a name that says which component's actions it holds"
    );
    p.mores()[0].click();
    check(p.menus()[0].classList.contains("open"), "a click opens it");
    check(p.mores()[0].getAttribute("aria-expanded") === "true", "and the '…' reports it open, not just coloured");
    p.mores()[0].click();
    check(p.menus()[0].classList.contains("open") === false, "and a second one shuts it again");
    check(p.mores()[0].getAttribute("aria-expanded") === "false", "with the '…' reporting that too");

    // the list is a box with a bottom edge (item 3), so a menu with no room under
    // its row is drawn UPWARD: measured against that edge, and only where there is
    // something to measure — this runner's mini-DOM has no layout at all
    const near = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await near.open();
    near.mores()[0].click();
    check(near.menus()[0].classList.contains("open") && !near.menus()[0].classList.contains("drop-up"), "with no layout to measure the menu opens downward, as before");
    const box = (bottom) => () => ({ top: 0, bottom, height: bottom, left: 0, right: 500, width: 500 });
    near.mores()[0].click(); // shut it again
    near.el("plug-body").getBoundingClientRect = box(400);
    // the row sits 20px above the bottom edge: less than the menu needs
    near.mores()[0].getBoundingClientRect = () => ({ top: 364, bottom: 380, height: 16, left: 0, right: 40, width: 40 });
    near.mores()[0].click();
    check(near.menus()[0].classList.contains("drop-up"), "a menu with no room below its row is drawn upward instead");
    near.mores()[0].click();
    check(near.menus()[0].classList.contains("drop-up") === false, "and closing it drops that decision with it");
    // the same row with room under it keeps the downward menu
    near.mores()[0].getBoundingClientRect = () => ({ top: 20, bottom: 36, height: 16, left: 0, right: 40, width: 40 });
    near.mores()[0].click();
    check(near.menus()[0].classList.contains("open") && !near.menus()[0].classList.contains("drop-up"), "while a row with room under it opens the way it always did");

    // this client offers a DIFFERENT release: the row leads with Update, it says
    // what that does to the bytes it replaces, and the switch moves into the menu
    // — which is where VS Code keeps Enable/Disable once a row has an Update
    const older = page({ held: [{ name: "clutch-workspace", version: "0.0.9+aaaa0000", digest: "aaaa0000aaaa0000" }] });
    await older.open();
    check(older.primary() === older.buttons()[0], "a row whose held release is behind leads with the install family");
    check(older.primary().textContent === "Update", "and the label says Update, because that is what it is");
    check(
      /it holds 0\.0\.9/.test(older.primary().title) && /replaced, not kept/.test(older.primary().title),
      "and its title says what happens to the release it replaces"
    );
    check(older.switches()[0].textContent === "Disable", "with the switch drawn in the menu beside it");
    check(older.menus()[0].children.length === 4, "which is how many items the menu carries once the update leads");

    // a component only this machine holds has nothing to install: the switch is
    // the write that leads, and the menu carries the read and the removal
    const alone = page({ held: [{ name: "solo", version: "0.1.0+aaaa", digest: "aaaa0000aaaa0000" }] });
    await alone.open();
    check(alone.switches()[0].textContent === "Disable", "a held row nothing offers leads with the switch");
    check(ownerName(alone.mores()[0]) === "solo", "and still carries its own menu");
    check(alone.menus()[0].children.length === 3, "holding the settings, the versions and the removal — no second switch beside the one that leads");
  }

  // 32. the filter row is a way of LOOKING at the one list, never a second one:
  //     every view narrows what is on screen, nothing is asked of the host to
  //     draw it, and going back to All shows the same rows that were there
  {
    const entries = [
      ...COMPONENTS,
      { name: "clutch-websearch", version: "0.3.0", origin: "release", source: "clutch-websearch@v0.3.0", published: null },
      { name: "clutch-skills", version: "0.2.0", origin: "release", source: "clutch-skills@v0.2.0", published: null },
    ];
    const p = page({
      entries,
      held: [
        { name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" },
        { name: "clutch-memory", version: "0.0.9+aaaaaaaa", digest: "aaaaaaaaaaaaaaaa" },
        { name: "clutch-websearch", version: "0.3.0+cccccccc", digest: "cccccccccccccccc", disabled: true },
        { name: "solo", version: "1.0.0+bbbbbbbb", digest: "bbbbbbbbbbbbbbbb" },
      ],
    });
    await p.open();
    check(p.chips().map((c) => c.textContent).join(",") === "All,Installed,Market,Updates,Stopped", "every view of the list is a chip on one row");
    check(p.chips()[0].classList.contains("active"), "and the list opens on All");
    const chipGroup = p.chips()[0].parent;
    check(
      chipGroup.getAttribute("role") === "group" && /which components to show/.test(chipGroup.getAttribute("aria-label") || ""),
      "the five views are announced as one group, named for what it chooses between"
    );
    check(
      p.chips().filter((c) => c.getAttribute("aria-pressed") === "true").length === 1 &&
        p.chips()[0].getAttribute("aria-pressed") === "true",
      "exactly one chip is pressed, and it is the view drawn as active"
    );
    const reads = p.world.listCalls + p.world.marketCalls;
    check(
      p.names().join(",") === "clutch-workspace,clutch-memory,clutch-websearch,clutch-skills,solo",
      "All is every component the machine holds or this client knows, each once"
    );

    p.chips()[1].click();
    check(p.names().join(",") === "clutch-workspace,clutch-memory,clutch-websearch,solo", "Installed is what the machine holds");
    p.chips()[2].click();
    check(p.names().join(",") === "clutch-workspace,clutch-memory,clutch-websearch,clutch-skills", "Market is what this client could put there");
    p.chips()[3].click();
    check(p.names().join(",") === "clutch-memory", "Updates is held AND carrying a different release, not merely held");
    p.chips()[4].click();
    check(p.names().join(",") === "clutch-websearch", "Stopped is held but not driven — a different fact from an update");
    check(p.world.listCalls + p.world.marketCalls === reads, "no view asks the host anything: the list is already on the page");

    p.chips()[0].click();
    check(p.names().length === 5, "and going back to All shows the rows the filter only hid");
    check(
      p.chips()[0].getAttribute("aria-pressed") === "true" && p.chips()[4].getAttribute("aria-pressed") === "false",
      "with the pressed mark moving to the view that is now on"
    );
    const box = p.nameBox();
    check(Boolean(box), "the row carries a box to filter by name");
    check(box.getAttribute("aria-label") === "filter the list by name", "which has no <label> beside it, so it names itself");
    box.value = "clutch-work";
    box.handlers.input[0]();
    check(p.names().join(",") === "clutch-workspace", "the name filter narrows by name, case and all");
    box.value = "CLUTCH-SK";
    box.handlers.input[0]();
    check(p.names().join(",") === "clutch-skills", "and it is the name that matches, not the case of it");
    // a view with nothing in it is not a machine with nothing on it
    box.value = "clutch-skills";
    box.handlers.input[0]();
    p.chips()[3].click();
    check(p.names().length === 0 && /matches this filter/.test(p.text()), "a view with nothing in it says so, and does not claim the machine is empty");

    const bare = page({ held: [], entries: [] });
    await bare.open();
    check(/nothing is installed in either place/.test(bare.text()), "while a page whose places are really empty keeps its own sentence");
    bare.chips()[3].click();
    check(
      !/matches this filter/.test(bare.text()) && /nothing is installed in either place/.test(bare.text()),
      "and no filter turns that sentence into the other one"
    );
  }

  // 33. a write belongs to its row, and follows it off the screen: when the row
  //     is not drawn — the removal took it away, or a filter is hiding it — the
  //     page's own note carries the stage and the verdict again. A page that went
  //     silent about a write it started would be a page that loses a deletion.
  {
    const held = [{ name: "solo", version: "1.0.0+bbbbbbbb", digest: "bbbbbbbbbbbbbbbb" }];
    const p = page({ held, entries: [] });
    await p.open();
    check(p.state("solo") === null && p.note().textContent === "", "a held row with nothing happening to it carries no state line, and the note is quiet");
    held.length = 0; // the machine stopped holding it the moment the removal landed
    p.world.removeReply = { ok: true, status: "removed", removed: ["1.0.0+bbbbbbbb"] };
    p.removes()[0].click();
    await settle();
    check(p.state("solo") === null, "the row went away with the bytes it held");
    check(
      /^removed solo 1\.0\.0\+bbbbbbbb from the session machine$/.test(p.note().textContent),
      "so the host's verdict falls back to the note instead of going missing with the row"
    );

    // the other way a row leaves the screen: a write in flight while the user
    // narrows the list. The stage must not vanish with the row it was drawn on.
    const q = page();
    await q.open();
    q.world.control = defer();
    q.buttons()[0].click();
    await settle(3);
    check(/installing clutch-workspace/.test(q.stateText("clutch-workspace")), "the stage is drawn on the row while the row is there");
    q.chips()[3].click(); // Updates: nothing is installed yet, so this hides every row
    check(q.state("clutch-workspace") === null, "filtering the row out takes its state line with it");
    check(/installing clutch-workspace/.test(q.note().textContent), "and the note says what the hidden row was saying");
    q.chips()[0].click();
    check(/installing clutch-workspace/.test(q.stateText("clutch-workspace")), "back on All the stage is on the row again, and it never stopped being true");
    q.world.control.res({ ok: true, status: "installed", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" });
    await settle();
    check(/^installed clutch-workspace/.test(q.stateText("clutch-workspace")), "and the verdict lands on the row like any other");
  }

  // 34. every view carries how much it holds, in a quieter voice than its own
  //     name — "Updates 2" is a reason to click a chip, "Updates" alone is not.
  //     The number belongs to the VIEW (what the machine holds and what this client
  //     knows), never to the name box beside it: typing a name narrows the rows on
  //     screen and must leave the counts where they were, or a chip would be
  //     answering the box instead of the machine.
  {
    const entries = [
      ...COMPONENTS,
      { name: "clutch-websearch", version: "0.3.0", origin: "release", source: "clutch-websearch@v0.3.0", published: null },
      { name: "clutch-skills", version: "0.2.0", origin: "release", source: "clutch-skills@v0.2.0", published: null },
    ];
    const p = page({
      entries,
      held: [
        { name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" },
        { name: "clutch-memory", version: "0.0.9+aaaaaaaa", digest: "aaaaaaaaaaaaaaaa" },
        { name: "clutch-websearch", version: "0.3.0+cccccccc", digest: "cccccccccccccccc", disabled: true },
        { name: "solo", version: "1.0.0+bbbbbbbb", digest: "bbbbbbbbbbbbbbbb" },
      ],
    });
    await p.open();
    check(
      p.chipCounts().join(",") === "5,4,4,1,1",
      "each view carries how much it holds: All 5, Installed 4, Market 4, Updates 1, Stopped 1"
    );
    check(
      p.chips().map((c) => c.textContent).join(",") === "All,Installed,Market,Updates,Stopped",
      "and the number sits beside the label, never inside it"
    );

    const box = p.nameBox();
    box.value = "clutch-work";
    box.handlers.input[0]();
    check(p.names().length === 1, "the name box narrows the rows");
    check(p.chipCounts().join(",") === "5,4,4,1,1", "and leaves the machine's counts where they were");

    // a view with nothing in it draws no number at all — the sentence under the
    // list already explains the emptiness, and a "0" would simply repeat it
    const bare = page({ held: [], entries: [] });
    await bare.open();
    check(bare.chipCounts().join(",") === ",,,,", "a view that holds nothing carries no number");
    check(
      bare.chips().map((c) => c.textContent).join(",") === "All,Installed,Market,Updates,Stopped",
      "while the chips are still the five views of the one list"
    );
  }

  // 35. one row says WHO it is and ONE sentence about its state, and nothing else.
  //     Everything a row used to spell out — the held version, its digest, the
  //     source path, the offered version, the release under it — is on the row's
  //     `title=` (U-10) and in the Versions disclosure, which is what VS Code does
  //     with the same material: the list is name + description in one column and
  //     the controls in the column beside them (extensionsList.ts:70-90, whose
  //     ActionBar sits beside `.details`; media/extension.css `.description`), and
  //     the rest is the extension's own page.
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    const row = rowNamed(p.body(), "clutch-workspace");
    check(nameOf(row).textContent === "clutch-workspace", "the row leads with the component's name");
    const descs = walk(row).filter((n) => /(^| )plug-row-desc( |$)/.test(n.className));
    check(descs.length === 1 && descs[0].textContent === "installed — nothing newer is offered here", "then ONE sentence about this row's state");
    check(!/5f900739|digest|\/home\/|checkout|release/.test(drawnText(row)), "and nothing else: no version, digest, path or origin is drawn in the row");
    check(
      textOf(headOf(row)).length + descs[0].textContent.length < 80,
      "the row's own words (name and sentence) stay inside one short line"
    );
    check(
      /held 0\.1\.0\+5f900739/.test(row.title) &&
        /digest 5f900739e6a35f43/.test(row.title) &&
        /offered 0\.1\.0/.test(row.title) &&
        /clutch-workspace/.test(row.title),
      "the facts it no longer draws are on its title, one hover away"
    );
    const main = mainOf(row);
    const foot = row.children[row.children.length - 1];
    check(
      /(^| )plug-row-actions( |$)/.test(foot.className) && /plug-switch/.test(foot.children[0].className),
      "and its controls are the column beside the words (VS Code's ActionBar)"
    );
    check(
      Boolean(main) && walk(main).includes(descs[0]) && main.children.indexOf(headOf(row)) === 0,
      "the words — name line and sentence — are the row's ONE column"
    );
    check(
      row.children.indexOf(main) < row.children.indexOf(foot),
      "and the controls come after them, in the direction the page reads"
    );
    // ...and the split is a claim about the SHEET as much as about this DOM: two
    // children side by side in a block container are still two stacked blocks, so
    // the row is only two columns because of what ui/style.css says about them. The
    // words column is the one that yields, the controls are the column that never
    // does (a target that shrinks is a target that moves).
    const css = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
    const decls = (sel) => {
      const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
      return m ? m[1].replace(/\s+/g, " ").trim() : "";
    };
    const rowRule = decls(".plug-row");
    check(
      /display: flex/.test(rowRule) && /flex-wrap: wrap/.test(rowRule) && /align-items: center/.test(rowRule),
      "the row is one wrapping flex line with its two columns centred against each other, not two stacked blocks"
    );
    check(
      /flex: 1 1 0%/.test(decls(".plug-row-main")) && /min-width: 0/.test(decls(".plug-row-main")),
      "the words take the room that is LEFT rather than the width they ask for, and yield it by truncating"
    );
    check(
      /flex: none/.test(decls(".plug-row-actions")) && /margin-left: auto/.test(decls(".plug-row-actions")),
      "while the controls keep their size and are pinned to the row's right edge, whatever the sentence did"
    );
    const mobile = fs.readFileSync(path.join(__dirname, "..", "ui", "mobile.css"), "utf8");
    check(
      /\.plug-row-actions\s*\{[^}]*flex: 1 1 100%/.test(mobile),
      "and on a phone that column takes a line of its own again — four controls do not fit beside a name in 288px"
    );

    // ...and the facts the row no longer DRAWS are still reachable without a
    // pointer: a `title=` needs a mouse resting on the row, so the same sentence
    // also sits on the control line as sr-only text, and every control on that
    // line — the menu's items included — points at it with `aria-describedby`
    const controls = walk(foot).filter((n) => n.tag === "button");
    check(controls.length >= 2, "the row's control line holds the controls, and the facts node is not one of them");
    check(
      controls.every((c) => describedBy(c, foot) && describedBy(c, foot).textContent === row.title),
      "every control on the row announces the row's title= facts, by pointing at the node that carries them"
    );
    const facts = walk(foot).filter((n) => /(^| )sr-only( |$)/.test(n.className));
    check(facts.length === 1 && facts[0].textContent === row.title, "which is ONE sr-only sentence, the row's own title");
    check(describedBy(controls[0], row) === facts[0], "resolvable inside the row a reader is standing in, not somewhere else on the page");
    check(foot.children[foot.children.length - 1] === facts[0], "and it is the control line's last child, so no control changes places");
    check(facts[0].className === "sr-only", "and the class that carries it to a screen reader is the same one that keeps it off the screen");

    // a row whose component is on the machine but not driven says which of the two
    // facts it is, and the marks stay beside the name where they belong
    const stopped = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43", disabled: true }] });
    await stopped.open();
    const srow = rowNamed(stopped.body(), "clutch-workspace");
    check(drawnText(srow).includes("held on the session machine, but not driven"), "a stopped row's sentence says it is still held");
    check(stopped.switches()[0].textContent === "Enable", "and its control offers the way back, not the way out");
  }

  // 36. a source that could not be REACHED is a question about this machine's
  // network, and the page answers it: the reason is drawn as before, and one
  // quieter line under it names the one thing the user can change. A source that
  // ANSWERED no (404) is a different fact and must not draw that line — sending a
  // user to rewrite settings.json over a missing release would be a wild goose.
  {
    const LOST = "https://github.com/Ethereal1024/clutch-memory/releases/latest/download/clutch-component.json: the source could not be reached (other side closed, asked 3 times)";
    const NO_SUCH = "https://github.com/Ethereal1024/clutch-skills/releases/latest/download/clutch-component.json: the source answered 404";
    const dead = page({ errors: [LOST], unreachable: true });
    await dead.open();
    const body = dead.body();
    const errs = () => walk(body).filter((n) => /(^| )plug-source-error( |$)/.test(n.className));
    const hints = () => walk(body).filter((n) => /(^| )plug-source-hint( |$)/.test(n.className));
    check(errs().length === 1 && errs()[0].textContent === LOST, "a source that failed is drawn as its reason, in full");
    check(hints().length === 1, "and a source that could not be reached adds exactly one line saying what to do about it");
    check(
      /source_mirror/.test(hints()[0].textContent) && /settings\.json/.test(hints()[0].textContent),
      "which names the setting and the file it goes in, because there is no other way to change where the bytes come from"
    );
    check(
      /box there/.test(hints()[0].textContent),
      "and points at the field on that settings page, which is the door on a machine whose HOME nobody can write to"
    );
    check(
      /github\.com/.test(hints()[0].textContent) && /pin/.test(hints()[0].textContent),
      "and says WHY the mirror is safe: the source is this build's own github one, and the digests are still the release's"
    );
    check(
      /Mirrors/.test(hints()[0].textContent),
      "and names the section the list is managed in, so the automatic retry is something the user can see and edit"
    );
    check(dead.buttons().length === 2 && dead.buttons().every((b) => !b.disabled), "the line is a sentence, not a second control: the rows the index DID answer for are untouched");
    const lines = walk(body).filter((n) => /(^| )plug-source-(error|hint)( |$)/.test(n.className));
    check(
      lines.length === 2 && /plug-source-error/.test(lines[0].className) && /plug-source-hint/.test(lines[1].className),
      "and it comes after the reason it answers — the way out last, not before the complaint"
    );

    // two failures, one of them a network one: still one hint, under both reasons
    const mixed = page({ errors: [NO_SUCH, LOST], unreachable: true });
    await mixed.open();
    check(
      walk(mixed.body()).filter((n) => /(^| )plug-source-error( |$)/.test(n.className)).length === 2 &&
        walk(mixed.body()).filter((n) => /(^| )plug-source-hint( |$)/.test(n.className)).length === 1,
      "one line per failed source, and one way out for all of them"
    );

    // an answer that was simply "no": the reason only
    const answered = page({ errors: [NO_SUCH], unreachable: false });
    await answered.open();
    check(walk(answered.body()).filter((n) => /(^| )plug-source-hint( |$)/.test(n.className)).length === 0, "a source that answered is not a machine that cannot reach github, so no hint is drawn");
    check(walk(answered.body()).some((n) => n.textContent === NO_SUCH), "its reason is still on the page");

    // ...and the quiet line is a claim about the SHEET too: the same kind of
    // paragraph as the failure above it, in a quieter voice
    const sheet = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
    const decls = (sel) => {
      const m = sheet.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
      return m ? m[1].replace(/\s+/g, " ").trim() : "";
    };
    const hintRule = decls(".plug-source-hint");
    check(hintRule !== "", "ui/style.css gives the hint a rule of its own (an unstyled paragraph inherits the page's body size)");
    check(
      /color: var\(--muted\)/.test(hintRule) && /font-size: var\(--fs-xs\)/.test(hintRule),
      "small and muted: a way out is not a second complaint"
    );
    check(
      /color: var\(--danger\)/.test(decls(".plug-source-error")) && /font-size: var\(--fs-sm\)/.test(decls(".plug-source-error")),
      "while the reason above it stays the failure's own colour and size — the two are not the same fact"
    );
  }

  // 37. the source mirror is a field, not a hand-written file (report: "downloads
  //     and uploads to the server still need a VPN — the domestic mirror never took
  //     effect"). Two machines have to agree on it: the host process is the one that
  //     OBEYS the prefix (ui/net-fetch.js, and on the phone the host's own artifact
  //     downloads), and this window is the one that can only remember what it was
  //     told. So the save writes the host's file FIRST and this window's copy
  //     second, a value that is not a URL is refused before either is touched, and
  //     the list is read again because where the bytes come from just moved.
  {
    const note = (p) => p.el("mirror-note");
    const box = (p) => p.el("mirror-input");
    const bad = (p) => /(^| )error( |$)/.test(note(p).className);

    // what the field says when nothing was saved in this session: the copy this
    // window kept, and — with none — that the market index is read from github.com
    const fresh = page();
    check(box(fresh).value === "", "a window that never set a mirror leaves the field empty");
    check(/no mirror/.test(note(fresh).textContent) && !bad(fresh), "and says so in the plain words of the thing it decides: the index and every manifest are read from github.com");
    const seeded = page({ store: { clutch_source_mirror: "https://mirror.example" } });
    check(box(seeded).value === "https://mirror.example", "a window that did set one comes back with the field filled from its own copy of it");
    check(/read under https:\/\/mirror\.example/.test(note(seeded).textContent), "and the note names the prefix the index and every manifest are read under");

    // a value that is not http(s) never reaches the file: obeying it would rewrite
    // every source into something that is not a URL, and the page would then blame
    // the network for a typo in this box
    const typo = page();
    box(typo).value = "mirror.example/clutch";
    typo.el("mirror-save").click();
    await settle();
    check(typo.world.settingsSaves.length === 0, "a value that is not a URL is not written to the host at all");
    check(!("clutch_source_mirror" in typo.store), "nor kept as this window's own copy of it");
    check(bad(typo) && /not http\(s\)/.test(note(typo).textContent) && /nothing was written/.test(note(typo).textContent), "and the verdict says what is wrong with it before anything happens");

    // the save itself: the host's file, then this window's copy, then a fresh read
    // of the market — a source that could not be reached a second ago may answer now
    const saved = page();
    const marketsBefore = saved.world.marketCalls;
    const listsBefore = saved.world.listCalls;
    box(saved).value = "https://mirror.example/";
    saved.el("mirror-save").click();
    await settle();
    check(
      saved.world.settingsSaves.length === 1 && saved.world.settingsSaves[0].source_mirror === "https://mirror.example",
      "the host is asked for exactly the one key (ui/settings-mirror.js merges it, so the LLM knobs beside it survive) and a trailing slash is the same mirror"
    );
    check(saved.store.clutch_source_mirror === "https://mirror.example", "and the window remembers the prefix it saved, not the text that was typed");
    check(saved.world.marketCalls === marketsBefore + 1 && saved.world.listCalls === listsBefore + 1, "the market is read again under it, because the mirror moves where the bytes come from");
    check(!bad(saved) && /read under https:\/\/mirror\.example/.test(note(saved).textContent), "and the line then says what the index follows");
    check(/pin/.test(note(saved).textContent), "and repeats what a mirror cannot change: the digest is still the release's own");

    // clearing it is a save too (an empty value is the answer "github.com again")
    const cleared = page({ store: { clutch_source_mirror: "https://mirror.example" } });
    box(cleared).value = "";
    cleared.el("mirror-save").click();
    await settle();
    check(cleared.world.settingsSaves.length === 1 && cleared.world.settingsSaves[0].source_mirror === "", "an empty field clears the knob rather than leaving the old prefix in the file");
    check(cleared.store.clutch_source_mirror === "", "and this window's copy with it");
    check(/github\.com again/.test(note(cleared).textContent), "the line says the index and manifests are back to github.com");

    // a write the host refused is not remembered as if it had landed: a filled
    // field would claim a mirror this window is not reading under
    const refused = page();
    refused.world.settingsReply = { ok: false, error: "read-only file system" };
    box(refused).value = "https://mirror.example";
    refused.el("mirror-save").click();
    await settle();
    check(bad(refused) && /read-only file system/.test(note(refused).textContent), "a refusal is drawn with the host's own reason");
    check(!("clutch_source_mirror" in refused.store), "and nothing is kept for a mirror that is not in force");
    const thrown = page();
    thrown.ctx.window.clutchSettings = { save: async () => { throw new Error("main process is gone"); } };
    box(thrown).value = "https://mirror.example";
    thrown.el("mirror-save").click();
    await settle();
    check(bad(thrown) && /main process is gone/.test(note(thrown).textContent), "a channel that threw is a refusal too, not a mirror that landed");

    // a shell without the channel draws no lie: the value is refused, loudly
    const shell = page();
    shell.ctx.window.clutchSettings = undefined;
    box(shell).value = "https://mirror.example";
    shell.el("mirror-save").click();
    await settle();
    check(bad(shell) && /cannot write the setting/.test(note(shell).textContent), "a shell without the channel says it cannot write the setting rather than pretending it did");
    check(!("clutch_source_mirror" in shell.store), "and keeps no copy of a mirror only this window could not apply");

    // the sheet: the row is the field's own rule, and it must not scroll away from
    // the list that explains why it is wanted
    const sheet = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
    const rules = (sel) => [...sheet.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g"))].map((m) => m[1].replace(/\s+/g, " ").trim());
    check(rules(".plug-mirror").some((r) => /display: flex/.test(r)), "ui/style.css draws the mirror row as its own block above the list");
    check(rules(".plug-mirror").some((r) => /flex: none/.test(r)), "pinned like the head and the note: a field scrolled out of reach is not the door the hint points at");
    check(rules(".plug-mirror input").some((r) => /flex: 1/.test(r) && /width: auto/.test(r)), "and the input gives its full width to the Save button beside it");
    const dangerRules = [...sheet.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(
      (m) => /\.plug-mirror-note\.error\b/.test(m[1]) && /var\(--danger\)/.test(m[2])
    );
    check(dangerRules.length === 1, "while a refused value takes the failure colour, not the muted one the note is written in");
  }

  // 38. the mirror list: where a release host that could not be reached is retried
  //     (ui/mirrors.js). It is a SETTING, not a fact about the session the plugin
  //     page is about, so it is drawn in the settings dialog's Mirrors pane
  //     (`#settings-mirrors`) and read when that pane is opened — and the plugin
  //     page below draws no part of it.
  {
    const MINE = { url: "https://mine.example/", source: "user" };
    const list = [MINE, { url: "https://gh-proxy.com/", source: "builtin" }, { url: "https://ghfast.top/", source: "builtin" }];

    // (a) a shell with no mirror channel is the page it always was
    {
      const none = page();
      await none.open();
      await none.showMirrors();
      check(none.mirrorSection() === null, "a shell with no mirror channel draws no Mirrors section");
      check(none.mirrorInput() === undefined && none.mirrorAddBtn() === undefined, "and no field or button for a list it cannot read");
      check(/cannot read or write the mirror list/.test(textOf(none.el("settings-mirrors"))), "the pane says so in its own line rather than offering a field that could not be read from or written to");
      check(none.names().join(",") === "clutch-workspace,clutch-memory", "the components it does know are drawn exactly as before");
    }

    // (b) the section: the user's entries first, the build's after — and it is the
    //     DIALOG that draws it, because the page below is about another machine
    {
      const p = page({ mirror: { list } });
      await p.open();
      check(p.world.mirrorCalls === 0, "the plugin page does not read the mirror list: it is not a fact about the session it reports on");
      check(!/plug-mirrors/.test(walk(p.body()).map((n) => n.className).join(" ")), "and it draws no mirror row or field of its own");
      await p.showMirrors();
      check(p.world.mirrorCalls === 1, "opening the Mirrors tab reads the mirror list, once");
      check(p.mirrorRows().length === 3, "one row per mirror this machine would try");
      check(
        p.mirrorRows().map((r) => textOf(nameOf(r))).join(",") === "https://mine.example/,https://gh-proxy.com/,https://ghfast.top/",
        "the user's own entry is drawn first, the shipped ones after it — the order they are tried in"
      );
      check(p.mirrorChips().join(",") === "yours,shipped,shipped", "each row says where it came from");
      check(/1 of yours · 2 shipped/.test(textOf(p.mirrorSection())), "and the heading counts the two halves of the list");
      check(
        /tried in this order/.test(p.mirrorNote().textContent) && /digest/.test(p.mirrorNote().textContent),
        "the note says the order is what is tried, and that the bytes are still weighed against the release's own digest"
      );
      check(p.mirrorRemoves().length === 1, "only an entry the user added carries a Remove — the shipped ones are what the fallback is made of");
      check(ownerName(p.mirrorRemoves()[0]) === "https://mine.example/", "and it is the user's own row");
      check(p.names().join(",") === "clutch-workspace,clutch-memory", "the mirror rows are not component rows: the component list is untouched beside them");
    }

    // (c) adding one: the field's value is what is written, and the section is
    //     redrawn from the list the write ANSWERED with, not from what was asked
    {
      const q = page({ mirror: { list } });
      await q.open();
      await q.showMirrors();
      const input = q.mirrorInput();
      check(Boolean(input) && input.getAttribute("aria-label") === "a mirror to add, as an https URL", "the field names itself, and says what a mirror is");
      check(q.mirrorAddBtn().disabled, "with nothing typed the Add button is dead");
      input.value = "https://new.example";
      input.handlers.input[0]();
      check(!q.mirrorAddBtn().disabled, "typing one makes it live, without a redraw moving the caret");
      q.mirrorAddBtn().click();
      await settle();
      check(q.world.mirrorAdds.join(",") === "https://new.example", "the value in the field is what the list is asked to hold");
      check(
        q.mirrorRows().length === 4 && q.mirrorChips().join(",") === "yours,yours,shipped,shipped",
        "and the section is redrawn from the list that was written, with the new entry among the user's own"
      );
      const ok1 = q.mirrorResult();
      check(/is in your list/.test(ok1.textContent) && !/(^| )error( |$)/.test(ok1.className), "the write is confirmed in the list's own words, as an answer and not as a failure");
      check(q.mirrorInput().value === "", "and the field is empty again, because the list took what it was given");
    }

    // (d) a value the list refuses is a sentence under the field, and nothing moved
    {
      const refused = page({ mirror: { list, addError: "https://gh-proxy.com/ is already in the list (this build ships it)" } });
      await refused.open();
      await refused.showMirrors();
      const ri = refused.mirrorInput();
      ri.value = "https://gh-proxy.com/";
      ri.handlers.input[0]();
      refused.mirrorAddBtn().click();
      await settle();
      const line = refused.mirrorResult();
      check(
        Boolean(line) && /already in the list \(this build ships it\)/.test(line.textContent) && /(^| )error( |$)/.test(line.className),
        "a value the list refuses is drawn under the field, in the list's own words and as the failure it is"
      );
      check(refused.mirrorRows().length === 3 && refused.mirrorInput().value === "https://gh-proxy.com/", "and nothing was written, so the field keeps what the user typed");
    }

    // (e) removing one: the row's own prefix is what is asked for, and the answer
    //     is the list without it
    {
      const gone = page({ mirror: { list } });
      await gone.open();
      await gone.showMirrors();
      gone.mirrorRemoves()[0].click();
      await settle();
      check(gone.world.mirrorRemoves.join(",") === "https://mine.example/", "Remove asks for exactly the row's own prefix");
      check(
        gone.mirrorRows().length === 2 && gone.mirrorChips().join(",") === "shipped,shipped",
        "the row goes with the entry, and the shipped ones — which cannot be removed — stay"
      );
      check(
        /is no longer tried/.test(gone.mirrorResult().textContent) && !/(^| )error( |$)/.test(gone.mirrorResult().className),
        "and the removal is confirmed in words, not drawn as a failure"
      );
    }

    // (f) the knob that outranks the list: while source_mirror is set, every source
    //     AND every release URL was already rewritten, so this list is not read —
    //     the page says which setting to clear instead of offering a dead field
    {
      const forced = page({ mirror: { list, forced: "https://gh-proxy.com/" } });
      await forced.open();
      await forced.showMirrors();
      check(
        Boolean(forced.mirrorForced()) && /not used while that is set/.test(forced.mirrorForced().textContent),
        "with source_mirror set the section names the prefix that outranks the list"
      );
      check(forced.mirrorInput().disabled && forced.mirrorAddBtn().disabled, "and both the field and the Add button are dead behind it");
      check(forced.mirrorRemoves()[0].disabled, "as is the Remove on a user's entry: the list is not read at all while that setting is");
      check(
        /CLUTCH_SOURCE_MIRROR/.test(forced.mirrorRemoves()[0].title) && /settings\.json/.test(forced.mirrorRemoves()[0].title),
        "and the dead control says which knob to clear"
      );
    }

    // (g) a list that could not be read at all: the reason, and no field to write
    //     into a file this machine cannot open
    {
      const broken = page({ mirror: { list, error: "EACCES: permission denied, open ~/.clutch/components.mirrors.json" } });
      await broken.open();
      await broken.showMirrors();
      check(broken.mirrorRows().length === 0, "a list that could not be read draws no rows it does not have");
      check(broken.mirrorInput() === undefined, "and no field to add to it");
      check(
        walk(broken.el("settings-mirrors")).some((n) => /(^| )plug-source-error( |$)/.test(n.className) && /EACCES/.test(n.textContent)),
        "the reason is drawn in the failure's own voice"
      );
      check(/unreadable/.test(textOf(broken.mirrorSection())), "and the heading says the list is unreadable rather than empty");

      // ...and a failure is the one answer worth asking again: the pane draws no
      // retry control (the field is not drawn while the list is unreadable), so
      // coming back to the tab is the only door there is
      broken.world.mirrorControl = defer();
      await broken.showMirrors();
      check(broken.world.mirrorCalls === 2, "coming back to the tab asks an unreadable list again, because nothing else can");
      check(/reading…/.test(textOf(broken.mirrorSection())), "and the pane says it is reading instead of keeping the old failure on screen");
      check(/reading the list/.test(textOf(broken.el("settings-mirrors"))), "with the line under the heading saying what is being read");
      broken.world.mirrorControl.res({ mirrors: list.map((e) => ({ ...e })), forced: "", error: null });
      await settle();
      check(broken.mirrorRows().length === 3, "so a file that was fixed on disk heals the pane without restarting the app");
    }

    // (h) the read is the PANE's, and a read in flight is not started twice: while
    //     it travels the pane says it is reading, not that there is no mirror, and
    //     the plugin page's own line says nothing about a list it does not read
    {
      const d = page({ mirror: { list } });
      d.world.mirrorControl = defer();
      await d.open();
      check(d.note().textContent === "", "the plugin page's line is about its own reads, and the mirror list is not one of them");
      await d.showMirrors();
      check(d.world.mirrorCalls === 1, "opening the pane asks for the list once");
      await d.showMirrors();
      check(d.world.mirrorCalls === 1, "and a second look at a pane whose read is still travelling does not start a second read");
      check(d.mirrorRows().length === 0, "no rows are drawn before the answer lands");
      check(/reading…/.test(textOf(d.mirrorSection())), "and the section says it is reading in its own voice, instead of claiming there is no mirror");
      check(/reading the list/.test(textOf(d.el("settings-mirrors"))), "with one more line saying what is being read");
      d.world.mirrorControl.res({ mirrors: list.map((e) => ({ ...e })), forced: "", error: null });
      await settle();
      check(d.mirrorRows().length === 3, "when the read lands, the rows are there");
    }
  }

  // 38b. ONE NAME, TWO PLACES: the copy the declaration names is the row, and the
  //      other copy is drawn under it as a leftover with its own way to let it go.
  //      Joining the two by name alone is what used to make the second copy vanish
  //      from the page while its bytes stayed on that machine — and a page that
  //      cannot show a thing cannot let it go either.
  {
    const p = page({
      client: true,
      held: [
        { name: "clutch-websearch", place: "session", version: "0.1.0+aaaa", digest: "aaaa0000aaaa0000" },
        { name: "clutch-websearch", place: "client", version: "0.2.0+bbbb", digest: "bbbb0000bbbb0000" },
      ],
      entries: [
        { name: "clutch-websearch", place: "client", version: "0.2.0", origin: "checkout", source: "…/clutch-websearch", published: null },
      ],
    });
    await p.open();
    const at = (cls) => walk(p.body()).filter((n) => new RegExp("(^| )" + cls + "( |$)").test(n.className));
    check(at("plug-row").length === 1, "one name is one row, wherever it is held");
    check(
      /held 0\.2\.0\+bbbb/.test(rowNamed(p.body(), "clutch-websearch").title),
      "and that row is the copy the declaration names (this client's), not whichever the inventory listed first"
    );
    check(at("plug-stray").length === 1, "the other copy is drawn as a leftover rather than folded away");
    const stray = at("plug-stray")[0];
    check(
      /also held on the session machine — a leftover/.test(drawnText(stray)),
      "the leftover says which place still holds it, and that the row above is the one the declaration names"
    );
    const letGo = at("plug-remove").find((n) => n.textContent === "Let it go");
    check(Boolean(letGo), "with its own control, which is an ordinary removal — not an automatic pass over the inventory");
    check(
      /remove clutch-websearch 0\.1\.0\+aaaa from the session machine/.test(letGo.title) &&
        /stays where it is/.test(letGo.title),
      "and its title names the copy it would remove, and says the row's copy is not touched"
    );

    // letting it go is aimed at the place that HOLDS that copy: the verb carries a
    // place, so this cannot land on the row's machine by name
    p.world.removeReply = { ok: true, status: "removed", removed: ["0.1.0+aaaa"] };
    letGo.click();
    await settle(2);
    check(p.world.removeCalls.join(",") === "clutch-websearch", "the leftover's control removes that name");
    check(
      p.world.slots.filter((c) => c[0] === "remove").every((c) => c[2] === "session"),
      "and it is aimed at the place the leftover came from (the row's own copy is this client's)"
    );
  }

  // 39. the automatic pass at connect is not on this page at all. It is a thing
  //     that happened to one machine at one moment (a retirement, a failed fetch)
  //     and it says its piece in the log (ui/tunnel-bootstrap.js). It used to ride
  //     along on `list()` as `pass` and be drawn as a line under the list — a
  //     second, older picture of what a machine holds, under a list that had just
  //     been read. Two pictures of one machine is how the page came to disagree
  //     with itself; what a place holds is the inventories and nothing else.
  {
    const p = page();
    await p.open();
    const lines = walk(p.body()).filter((n) => /(^| )plug-pass( |$)/.test(n.className));
    check(lines.length === 0, "no pass line is drawn: the list is the only picture of what a machine holds");
    check(
      walk(p.body()).every((n) => !/could not let go of|let go of/.test(n.textContent || "")),
      "and nothing on the page narrates a pass, in either voice"
    );

    // ...and the words and the rule it was drawn with are gone with it, so a later
    // change cannot quietly bring a second picture back
    const sheet = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
    check(!/\.plug-pass\s*\{/.test(sheet), "ui/style.css carries no rule for a pass line");
    const panel = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "renderer", "components-panel.ts"), "utf8");
    check(!/plugPassLine|plug-pass/.test(panel), "and the panel has no code that could draw one");
  }

  // 40. the settings a component DECLARES: the schema is the component's, the form
  //     is this page's, and the values are the machine's. That is an editor's
  //     extension settings narrowed to where a plugin lives — one row per declared
  //     key, the control its declared TYPE calls for, a mark (and a way back) only
  //     on a value that left its default, and a write that redraws from what the
  //     machine ANSWERS rather than from what the page sent. The page knows no
  //     knob of anybody, so nothing here can be true of one component and false of
  //     the next.
  {
    const SKILLS = {
      schema: {
        "library.enabled": { type: "boolean", default: true, description: "Offer this library to the model." },
        "library.root": { type: "string", default: "", description: "Directory to serve instead of this machine's own library." },
      },
      values: { "library.enabled": true, "library.root": "/home/u/.agents/skills" },
    };
    const held = [{ name: "clutch-skills", version: "0.1.2", digest: "69159b6c00000000" }];
    const labelOf = (row) => walk(row).find((n) => /(^| )plug-setting-label( |$)/.test(n.className));

    // the item lives in the row's own menu, FIRST: it is the one item there about
    // how the component BEHAVES, beside the ones about whether it is here at all
    const p = page({ held, entries: [], settings: SKILLS });
    await p.open();
    check(p.menus()[0].children[0] === p.settingsBtns()[0], "the menu leads with what this component lets a user set");
    check(p.settingsBtns()[0].textContent === "Settings…", "and the item says what it opens");

    // a shell whose bridge predates the verb draws that item DEAD, not missing: a
    // control that only appears on a click is a control the page cannot be asked
    // about, and a live one would be a promise this page cannot keep
    const old = page({ held, entries: [] });
    await old.open();
    check(old.settingsBtns().length === 1 && old.settingsBtns()[0].disabled, "a shell that cannot read settings draws the item dead");
    check(/cannot read component settings/.test(old.settingsBtns()[0].title), "and says why, instead of opening nothing");

    // opening it is a READ of the row it belongs to, and the box says so plainly
    // until the machine answers
    p.world.settingsControl = defer();
    p.settingsBtns()[0].click();
    await settle();
    check(p.world.settingsReads.join(",") === "clutch-skills", "opening it reads the settings of the row it belongs to");
    check(/reading the settings/.test(p.text()), "and the box says it is reading while it does");
    p.world.settingsControl.res({ ok: true, name: "clutch-skills", schema: SKILLS.schema, values: SKILLS.values });
    await settle();

    // one row per key the declaration names, each carrying the declaration's own
    // sentence — the page adds no word of its own about what a setting means
    check(
      p.settingRows().map((r) => labelOf(r).textContent).join(",") === "library.enabled,library.root",
      "one row per declared key"
    );
    check(ownerName(p.settingsBox()) === "clutch-skills", "and the form hangs inside the row of the component it is about");
    check(
      walk(p.settingRow("library.enabled")).find((n) => /(^| )plug-setting-desc( |$)/.test(n.className)).textContent ===
        "Offer this library to the model.",
      "with the declaration's own sentence under the key"
    );

    // the CONTROL is the declared type, never a box for everything
    const enabled = p.settingCtl("library.enabled");
    check(enabled.tag === "input" && enabled.type === "checkbox" && enabled.checked, "a `boolean` is a checkbox, checked because that is what the machine holds");
    check(
      p.settingCtl("library.root").tag === "input" &&
        p.settingCtl("library.root").type === "text" &&
        p.settingCtl("library.root").value === "/home/u/.agents/skills",
      "a `string` is a text box holding the value the machine answered"
    );

    // a value at its declared default is drawn as nothing special; one that left it
    // says so, and says how to come back
    check(p.settingReset("library.enabled") === null, "a value still at its declared default carries no mark and no way back");
    check(
      Boolean(walk(p.settingRow("library.enabled")).find((n) => /(^| )plug-chip( |$)/.test(n.className))) === false,
      "and is not marked as set"
    );
    check(
      p.settingReset("library.root") !== null && /set library\.root back to ""/.test(p.settingReset("library.root").title),
      "a value that left it carries both, and the way back names the default"
    );

    // a write names the ONE key the control settled on, and the form then draws the
    // answer — which is the machine's document, not the page's memory of a click
    enabled.checked = false;
    enabled.handlers.change[0]();
    await settle();
    check(
      JSON.stringify(p.world.settingWrites) === JSON.stringify([["clutch-skills", { "library.enabled": false }]]),
      "a write names the one key the control settled on"
    );
    check(
      p.world.slots.filter((c) => c[0] === "settings" || c[0] === "setSetting").every((c) => c[2] === "session"),
      "and the read and the write both name the place that owns the store, so no form is ever asked of a place that has none"
    );
    check(/library\.enabled is set — it takes effect the next time clutch-skills runs/.test(p.text()), "and the form says the write landed, and when it happens");
    check(p.settingReset("library.enabled") !== null, "the key that left its default now offers the way back");

    // the answer is what is drawn: a machine that stores something else than what
    // was sent is not a page that keeps its own copy
    const w = defer();
    p.world.settingWriteControl = w;
    p.settingCtl("library.root").value = "/tmp/other";
    p.settingCtl("library.root").handlers.change[0]();
    await settle();
    check(p.settingCtl("library.root").disabled && p.settingCtl("library.enabled").disabled, "one write at a time: every control of that form is dead until it answers");
    w.res({ ok: true, name: "clutch-skills", values: { "library.enabled": false, "library.root": "~/.agents/skills" } });
    await settle();
    check(p.settingCtl("library.root").value === "~/.agents/skills", "when it answers, the form draws what the machine now HOLDS, not what the page sent");
    p.world.settingWriteControl = null;

    // the way back writes the declaration's default — the store holds the effective
    // document, so "unset" would be a second meaning for an absent key
    p.settingReset("library.root").click();
    await settle();
    const back = p.world.settingWrites[p.world.settingWrites.length - 1];
    check(back[1] && back[1]["library.root"] === "", "the way back writes the declared default");

    // a refusal is the machine's sentence under the form, and the values did not move
    const refused = page({ held, entries: [], settings: { ...SKILLS, writeError: "library.root must be a directory" } });
    await refused.open();
    refused.settingsBtns()[0].click();
    await settle();
    refused.settingCtl("library.root").value = "/nope";
    refused.settingCtl("library.root").handlers.change[0]();
    await settle();
    check(/library\.root must be a directory/.test(refused.text()), "a refusal is quoted as the machine said it");
    check(refused.settingCtl("library.root").value === "/home/u/.agents/skills", "and nothing moved: the form still draws what the machine holds");

    // nothing declared, and a read that failed, are two different answers
    const none = page({ held, entries: [], settings: { schema: {}, values: {} } });
    await none.open();
    none.settingsBtns()[0].click();
    await settle();
    check(/declares no settings/.test(none.text()), "a component that declares nothing says exactly that");
    const broke = page({ held, entries: [], settings: { ...SKILLS, readError: "the supervisor did not answer" } });
    await broke.open();
    broke.settingsBtns()[0].click();
    await settle();
    check(/could not be read — the supervisor did not answer/.test(broke.text()), "a read that failed is a reason, not an empty form");
  }

  // ---- the pane follows the TAB -------------------------------------------------
  // One tab is one session, and two sessions can sit on two machines (ui/src/
  // renderer/slots.ts, which is why this page had to leave the settings dialog: a
  // dialog covers the strip that says which session it is reporting on). So which
  // machine the list is about is the STRIP's answer: every read and every write
  // names the open tab's slot, a tab switch reads for the new tab, and an answer
  // that arrives after the strip has moved is dropped rather than painted under the
  // tab the reader is now looking at.
  {
    const p = page({ slot: "tab-a", held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", place: "session", disabled: false }] });
    await settle();
    await p.open();
    check(p.world.slots.length > 0 && p.world.slots.every((c) => c[1] === "tab-a"), "every read names the open tab's slot, not the window's");

    // a write is the same fact one level down: it has to land on the machine the
    // tab on screen is on, or the page would install onto one it is not showing
    p.world.slot = "tab-b";
    p.world.reply = { ok: true, status: "installed", version: "0.1.0+x", digest: "x" };
    vm.runInContext("plugSetSlot('tab-b')", p.ctx);
    await settle();
    p.buttons()[0].click();
    await settle();
    const installs = p.world.slots.filter((c) => c[0] === "install");
    check(installs.length === 1 && installs[0].join(":") === "install:tab-b", "and a write follows the tab, not the tab that opened the page");

    // the same slot again is a badge moving in the background: a tab that starts or
    // stops running is still the same machine, and costs no read
    const before = p.world.listCalls;
    vm.runInContext("plugSetSlot('tab-b')", p.ctx);
    await settle();
    check(p.world.listCalls === before, "a tab state for the slot already on screen costs no read");

    // a reply from the tab that is GONE describes a machine this tab may not even
    // be able to reach: the read answers in two halves, and the strip can move
    // between them
    const late = page({ held: [] });
    late.world.slot = "tab-a";
    late.world.listDefer = true;
    vm.runInContext("plugSetSlot('tab-a')", late.ctx); // in flight, and held
    await settle();
    vm.runInContext("plugSetSlot('tab-b')", late.ctx);
    await settle();
    check(late.world.listDeferreds.length === 2, "the switch starts a read of its own");
    late.world.listDeferreds[0].res({
      sessionBase: "http://box-a.example",
      held: [{ place: "session", name: "clutch-a-only", version: "0.1.0+aaaa" }],
      error: null,
    });
    await settle();
    check(!/clutch-a-only/.test(late.text()), "an answer from the tab we left is dropped, not painted under the new one");
    late.world.listDeferreds[1].res({
      sessionBase: "http://box-b.example",
      held: [{ place: "session", name: "clutch-b-only", version: "0.1.0+bbbb" }],
      error: null,
    });
    await settle();
    check(/clutch-b-only/.test(late.text()), "…while the new tab's own answer is what the pane draws");
  }

  // ---- a pane nobody is looking at asks nothing --------------------------------
  // The pane lives in the sidebar now (ui/index.html `#dock-plugins`), so "on
  // screen" is two facts: the aside is not put away, and its plugin group is not
  // folded to its head. The read is deferred to the moment somebody opens it —
  // dock.ts calls pluginTabShown() on exactly that — and a hidden list spends no
  // network read on nothing.
  {
    const folded = page();
    folded.el("dock-plugins").classList.add("dock-collapsed");
    folded.world.slot = "tab-a";
    vm.runInContext("plugSetSlot('tab-a')", folded.ctx);
    await settle();
    check(folded.world.listCalls === 0, "a folded plugin group is not read when the tab changes");
    folded.el("dock-plugins").classList.remove("dock-collapsed");
    await folded.open(); // what dock.ts does when the group is opened
    check(folded.world.listCalls === 1, "and opening the group is what asks for it");

    const away = page();
    away.el("right").classList.add("panel-hidden");
    away.world.slot = "tab-a";
    vm.runInContext("plugSetSlot('tab-a')", away.ctx);
    await settle();
    check(away.world.listCalls === 0, "a sidebar that is put away is the same fact one level up");
  }

  // 41. a tab with no session YET is a wait, not a failure — and the wait ends by
  //     itself. The reported shape: a tab linked to a far machine is opened, and
  //     the pane is read for it BEFORE its claim lands (ui/src/renderer/project.ts
  //     activateTab announces the tab, then awaits the claim), so every
  //     session-place row says `on the session machine, unknown` over a red
  //     sentence. Nothing had failed — there was nobody to ask yet, and the claim
  //     was already on its way — so the sentence is said quietly; and because the
  //     tab ends up with a session, the list is asked again when it arrives
  //     (`clutch:backend-changed` → plugSessionArrived) instead of keeping a
  //     picture of a tab that had none for the rest of that tab's life.
  {
    const NONE = { kind: "none", base: "" };
    const p = page({ target: NONE, held: [], client: true });
    await p.open();
    check(
      /no session yet/.test(p.note().textContent) && !/(^| )error( |$)/.test(p.note().className),
      "a tab with no session yet is said in the quiet weight: nobody failed, there was nobody to ask"
    );
    check(
      /on the session machine, unknown/.test(p.text()),
      "…and the row says `unknown` because its place was NOT read, which is not the same as holding nothing"
    );
    check(!/is claimed/.test(p.note().textContent), "and the host's own word for it is not on the page");

    // the session ARRIVES: this is the one event that ends the wait, and the pane
    // is what asks again — no tab switch, no folded group, no reload
    const before = p.world.listCalls;
    p.world.target = LOCAL;
    vm.runInContext("plugSessionArrived()", p.ctx);
    await settle();
    check(p.world.listCalls === before + 1, "the session arriving is what asks the list again");
    check(p.note().textContent === "", "…and the note goes away with the wait it described");

    // a session that arrives WHILE the list is being read: the read in flight is
    // the one that missed it, so it is asked again once it settles — once, because
    // two reads for one arrival is a read on somebody else's answer
    const flight = page({ target: NONE, held: [] });
    flight.world.listDefer = true; // this read is held open, so the arrival can land mid-flight
    flight.world.slot = "tab-r";
    vm.runInContext("plugSetSlot('tab-r')", flight.ctx);
    await settle();
    const asked = flight.world.listCalls;
    flight.world.target = LOCAL;
    vm.runInContext("plugSessionArrived()", flight.ctx);
    await settle();
    check(flight.world.listCalls === asked, "a session that arrives mid-read does not start a second read beside the one in flight");
    flight.world.listDefer = false;
    flight.world.listDeferreds[0].res({
      sessionBase: "",
      target: "none",
      held: [],
      error: "this tab has no session yet, so there is no machine to ask — its components are read once it has one",
    });
    await settle();
    check(flight.world.listCalls === asked + 1, "…it is asked again as soon as that read settles, exactly once");

    // the other shape, which must stay red: a machine that is there and did not
    // answer. Waiting does not fix this one, and the page says so in the error
    // colour (`plugReadNote` weighs the two by `list().target`, not by the words)
    const broken = page({ target: { kind: "remote", base: "" } });
    await broken.open();
    check(
      /(^| )error( |$)/.test(broken.note().className) && /tunnel is up/.test(broken.note().textContent),
      "a machine that exists and cannot be reached is still a failure, in red"
    );

    // ...and an empty list under a tab with no session says the machine was not
    // asked, rather than "nothing is installed in either place"
    const bare = page({ target: NONE, held: [], entries: [] });
    await bare.open();
    check(
      /this tab has no session yet/.test(bare.text()) && !/nothing is installed/.test(bare.text()),
      "an empty list under a tab with no session says the session machine was not asked"
    );

    // the wiring itself: the mini-DOM's document has a no-op addEventListener, so
    // the ONE line that connects the event to the read is pinned in the source.
    // It is the renderer's `clutch:backend-changed` and not the host's
    // `backend:base-changed`, on purpose: a first claim is answered silently
    // (ensureSlotBackend's `notify = false`), because announcing a base makes every
    // page in the window reconnect its stream.
    const panel = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "renderer", "components-panel.ts"), "utf8");
    check(
      /document\.addEventListener\("clutch:backend-changed", \(\) => plugSessionArrived\(\)\)/.test(panel),
      "the pane listens for the session arriving, which is the only signal a FIRST claim produces"
    );
    check(
      /if \(plugState\.pending\) \{\s*plugAskAgain = true;/.test(panel),
      "a read in flight is not raced: the arrival is remembered and spent when it settles"
    );
  }

  // 42. the slot a read ASKS FOR is the tab strip's answer at the moment of the ask,
  //     not the copy this pane took the last time it was told. The reported shape: a
  //     window booted onto one tab sets state.activeTabId from the strip's saved
  //     list (tab-bar.ts loadTabs) WITHOUT dispatching `clutch:tab-state`, and the
  //     pane's own module body had already run plugSetSlot(activeSlotId()) while
  //     there was no tab to name — so it kept the window's default slot ("") and
  //     asked it for the rest of that tab's life. Every read came back
  //     `target: "none"`, the quiet note stayed up through the session's own claim,
  //     and the reload button only re-asked the same empty slot; a tab switch
  //     (which does dispatch) was the one thing that repaired it.
  {
    const NONE = { kind: "none", base: "" };
    const p = page({ target: NONE, held: [], client: true }); // no tab yet: the strip answers ""
    await p.open();
    check(p.world.slots.every(([, slot]) => slot === ""), "with no tab on screen, every read names the window's own session");
    check(/no session yet/.test(p.note().textContent), "…and that session has no machine to ask, which the note says");

    // the tab comes back (a RESTORE, not a switch): no `clutch:tab-state` reaches
    // the pane, so plugState.slot is still the "" it took at load time, and the
    // tab's claim has landed with it
    p.world.slot = "tab-restored";
    p.world.target = LOCAL;
    const before = p.world.listCalls;
    p.el("plug-reload").click(); // the one manual ask the user has
    await settle();
    check(p.world.listCalls === before + 1, "a reload is one read");
    check(
      p.world.slots[p.world.slots.length - 1][1] === "tab-restored",
      "…and it asks the tab on screen, not the default slot the pane took before the tab existed"
    );
    check(p.note().textContent === "", "…so the session that DID arrive ends the note without a tab switch");

    // the same fact through the session's own arrival (what boot does after the
    // claim): the read that event starts names the tab as well
    const second = page({ target: NONE, held: [] });
    await second.open();
    second.world.slot = "tab-later";
    second.world.target = LOCAL;
    vm.runInContext("plugSessionArrived()", second.ctx);
    await settle();
    check(
      second.world.slots[second.world.slots.length - 1][1] === "tab-later",
      "the session arriving is read for the tab that has it"
    );

    // the wiring, pinned in the source: the live slot is taken on BEFORE the ask,
    // and taking it on does not start a read of its own (that would be the read
    // calling itself)
    const panel = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "renderer", "components-panel.ts"), "utf8");
    check(
      /const live = activeSlotId\(\);\s*if \(live !== plugState\.slot\) plugSetSlot\(live, \{ reread: false \}\);/.test(panel),
      "plugRead asks the tab strip for the slot before it asks the host for the list"
    );
    check(
      /export function plugSetSlot\(slot, \{ reread = true \} = \{\}\)/.test(panel) &&
        /if \(reread && plugPaneVisible\(\)\) plugRead\(\);/.test(panel),
      "…and the slot-taking can be done without starting a read beside this one"
    );

    // 42b. the pane's own height: it is the group's, not its content's, and a note
    //      with nothing to say is not a line. What the user saw: a short list opened
    //      with a blank band above it — a reserved note line, a filter row that
    //      wrapped its five chips onto two lines, and a body that never got the
    //      height of the group it sits in (the list started two thirds down a pane
    //      whose rest was empty).
    const sheet = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
    const rules = (sel) => [...sheet.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g"))].map((m) => m[1].replace(/\s+/g, " ").trim());
    check(rules("#plug-pane").some((r) => /flex: 1 1 auto/.test(r)), "the pane fills its dock group instead of hugging its content");
    check(!rules(".plug-note").some((r) => /min-height/.test(r)), "and the note reserves no line for a sentence it does not have");
    check(rules(".plug-note:empty").some((r) => /display: none/.test(r)), "…it is not drawn at all when it is empty");
    check(rules(".plug-filter-chips").some((r) => /flex-wrap: nowrap/.test(r)), "the five views are one row of height, never two");
    check(rules(".plug-filter-chip").some((r) => /flex: none/.test(r)), "…and a chip's label is never the thing that gives way");
  }

  summary("components-panel: the plugin tab's writes (destination, confirm text, verdicts, re-read)");
})();
