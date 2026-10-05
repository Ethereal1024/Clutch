"use strict";

// The plugin tab is the ONE place this UI can write to a machine (PLUGIN_PLAN.md
// I5), so all three of its write paths are what must not drift silently: which
// machine a control claims, what the confirmation says, what a refusal looks
// like, and what the page does afterwards — for the install, for the removal
// (the reverse verb, which is the one that DELETES, so its wording is checked for
// the fact that it is not a rollback), and for the switch (which deletes nothing,
// is the undo of itself, and therefore must NOT ask). Nothing smaller than the
// page's own file tests that, and the page is DOM code driven by
// ui/components-view.js over the clutchComponents channel.
//
// So this runner loads ui/js/components-panel.js itself (taken from
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
const { check, summary, uiModules } = require("./harness.js");

// ---- mini-DOM: elements, ids, text, clicks, parents ----
function makeDocument(ids) {
  function node(tag) {
    const n = {
      tag,
      className: "",
      title: "",
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

// the row a control sits in, by walking up the parents the mini-DOM kept. The
// class is matched as a whole word: a row also carries the state it is in
// (.stopped, .busy), and the version rows under a held row are rows as well.
function rowOf(el) {
  let cur = el;
  while (cur && !/(^| )plug-row( |$)/.test(cur.className)) cur = cur.parent;
  return cur;
}

function ownerName(el) {
  const row = rowOf(el);
  return row ? textOf(row.children[0].children[0]).trim() : "";
}

// the row that NAMES this component (a version row names a version, not a
// component), and the state line inside it: what is happening to that one row
// right now — a write in flight, or the host's verdict on the last one.
function rowNamed(body, name) {
  return (
    walk(body).find(
      (n) => /(^| )plug-row( |$)/.test(n.className) && textOf(n.children[0].children[0]).trim() === name
    ) || null
  );
}

function stateOf(body, name) {
  const row = rowNamed(body, name);
  if (!row) return null;
  return row.children.find((c) => /(^| )plug-state( |$)/.test(c.className)) || null;
}

const IDS = ["plug-body", "plug-target", "plug-base", "plug-note", "plug-reload", "plug-filter", "settings-tab-plugins"];

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
  { name: "clutch-workspace", interface: "daemon", version: "0.1.0", origin: "checkout", source: "…/clutch-workspace", published: null },
  { name: "clutch-memory", interface: "daemon", version: "0.1.0", origin: "release", source: "clutch-memory@v0.1.0", published: null },
];

// a fresh page: the real panel file, a fresh mini-DOM, a fake channel
function page({ held = [], heldError = null, listError = null, target = LOCAL, entries = COMPONENTS, store = {}, session = {} } = {}) {
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
  };
  const api = {
    list: async () => {
      world.listCalls++;
      if (listError) throw new Error(listError);
      return { target, held, error: heldError };
    },
    market: async () => { world.marketCalls++; return { entries, errors: [], sources: 4 }; },
    install: async (name) => {
      world.installCalls.push(name);
      if (world.control) return world.control.promise;
      return world.reply;
    },
    remove: async (name, opts) => {
      world.removeCalls.push(name);
      world.removeOpts.push(opts || null);
      if (world.control) return world.control.promise;
      return world.removeReply;
    },
    versions: async (name) => {
      world.versionsCalls.push(name);
      if (world.versionsControl) return world.versionsControl.promise;
      return world.versionsReply;
    },
    onProgress: (cb) => { world.progress = cb; },
    setDisabled: async (name, disabled) => {
      world.switchCalls.push([name, disabled]);
      if (world.control) return world.control.promise;
      return world.switchReply;
    },
  };
  const ctx = {
    console,
    setImmediate,
    setTimeout,
    clearTimeout,
    Promise,
    document: dom.document,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
    // the session URL names THIS window's session, so every reader of it uses
    // sessionStorage (js/backend-lifecycle.js): the panel's ✓ is about the window
    // the panel is drawn in, not about the machine the profile remembers (⑤)
    sessionStorage: { getItem: (k) => (k in session ? session[k] : null), setItem() {}, removeItem() {} },
    askConfirm: async (opts) => { world.confirms.push(opts); return world.answer; },
    $: (sel) => dom.document.querySelector(sel),
    renderPlugins: null, // the real one, declared in the file
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.window.clutchComponents = api;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: "ui/js/components-panel.js" });
  return {
    ctx,
    world,
    byId: dom.byId,
    el: (id) => dom.byId.get("#" + id),
    body: () => dom.byId.get("#plug-body"),
    buttons: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-install/.test(n.className)),
    removes: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-remove/.test(n.className)),
    ones: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-remove-one/.test(n.className)),
    versionBtns: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-versions/.test(n.className)),
    switches: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-switch/.test(n.className)),
    mores: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-more/.test(n.className)),
    menus: () => walk(dom.byId.get("#plug-body")).filter((n) => /plug-menu/.test(n.className)),
    chips: () => walk(dom.byId.get("#plug-filter")).filter((n) => n.tag === "button" && /plug-filter-chip/.test(n.className)),
    // the number behind each chip, as drawn: one entry per chip, "" when the view
    // holds nothing (a zero is not drawn — the empty message under it says why)
    chipCounts: () =>
      walk(dom.byId.get("#plug-filter"))
        .filter((n) => /(^| )plug-filter-count( |$)/.test(n.className))
        .map((n) => n.textContent.trim()),
    nameBox: () => walk(dom.byId.get("#plug-filter")).find((n) => n.tag === "input"),
    names: () => walk(dom.byId.get("#plug-body"))
      .filter((n) => /(^| )plug-name( |$)/.test(n.className))
      .map((n) => textOf(n)),
    note: () => dom.byId.get("#plug-note"),
    text: () => textOf(dom.byId.get("#plug-body")),
    // the state line of one component's row, or null when that row is not drawn
    state: (name) => stateOf(dom.byId.get("#plug-body"), name),
    stateText: (name) => {
      const el = stateOf(dom.byId.get("#plug-body"), name);
      return el ? el.textContent : "";
    },
    open: async () => { vm.runInContext("pluginTabShown()", ctx); await settle(); },
  };
}

// ---- the page loads this file at all ----
const mod = uiModules().find((m) => m.file === "js/components-panel.js");
check(Boolean(mod), "ui/index.html loads js/components-panel.js");
const CODE = mod ? mod.code : "";

(async function main() {
  // 1. a row per market entry, each with its own install control
  {
    const p = page();
    await p.open();
    check(p.buttons().length === 2, "every market entry gets its own install control");
    check(p.buttons().map(ownerName).join(",") === "clutch-workspace,clutch-memory", "each control belongs to the row it installs");
    check(p.buttons().every((b) => b.textContent === "Install"), "a component the machine does not hold offers 'Install'");
    check(p.buttons().every((b) => !b.disabled), "and the control is live once the target is known");
    check(/neither is a rollback/.test(p.text()), "the market says in plain words that a write is never a rollback (I5, visible without hovering)");
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
    check(/has not been read yet/.test(lost.buttons()[0].title), "and the button says nothing may be sent before it is");
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

  // 4. the question names the machine and the fact that cannot be undone
  {
    const p = page({ store: { clutch_ssh_host: "10.0.0.5", clutch_ssh_user: "ubuntu", clutch_ssh_port: "22" } , target: REMOTE });
    await p.open();
    p.world.answer = false;
    p.buttons()[0].click();
    await settle();
    const ask = p.world.confirms[0];
    check(p.world.confirms.length === 1 && ask.ok === "Install", "installing asks first, with the verb on the button");
    check(/SSH ubuntu@10\.0\.0\.5:22/.test(ask.text), "the question names the machine the write lands on");
    check(/neither act is a rollback/.test(ask.text), "and says what the write costs: removable again, but never a rollback (I5)");
    check(p.world.installCalls.length === 0, "a declined install writes nothing");
    check(p.note().textContent === "", "and leaves no verdict behind");
  }

  // 4b. the ✓ on the remote's label is THIS window's session, not the machine's (⑤)
  // One profile, several windows: clutch_ssh_connected is one fact for the whole
  // process, but the URL that says a window is ON the remote belongs to the window
  // that claimed it — read from localStorage, the next window ticked a machine it
  // was never on.
  {
    const remote = { clutch_ssh_host: "10.0.0.5", clutch_ssh_user: "ubuntu", clutch_ssh_port: "22" };
    const label = (p) => p.el("plug-target").textContent;
    const shared = page({
      store: { ...remote, clutch_ssh_connected: "1", clutch_api_url: "http://127.0.0.1:7788" },
      target: REMOTE,
    });
    await shared.open();
    check(label(shared) === "SSH ubuntu@10.0.0.5:22",
      `a URL another window remembered in the shared storage does not tick this one's machine (got ${JSON.stringify(label(shared))})`);
    const mine = page({
      store: { ...remote, clutch_ssh_connected: "1" },
      session: { clutch_api_url: "http://127.0.0.1:7788" },
      target: REMOTE,
    });
    await mine.open();
    check(label(mine) === "SSH ubuntu@10.0.0.5:22 ✓",
      `this window's own session does tick it (got ${JSON.stringify(label(mine))})`);
    const noIntent = page({ store: { ...remote }, session: { clutch_api_url: "http://127.0.0.1:7788" }, target: REMOTE });
    await noIntent.open();
    check(label(noIntent) === "SSH ubuntu@10.0.0.5:22",
      "and a window with a session and no standing intent behind it is not connected either");
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
      /Local \(this machine\) is starting its supervisor/.test(p.stateText("clutch-workspace")),
      "the wake stage says the target machine's supervisor is coming up"
    );

    p.world.progress({ stage: "upload", name: "clutch-workspace", version: "0.1.0+5f900739" });
    check(/sending clutch-workspace 0\.1\.0\+5f900739 to Local \(this machine\)/.test(p.stateText("clutch-workspace")), "the upload stage names the bytes and the machine");
    p.world.progress({ stage: "upload", name: "clutch-memory" });
    check(/sending clutch-workspace/.test(p.stateText("clutch-workspace")), "a stage from another window's install is ignored");

    // the other shape: no bytes travel from this machine at all, so the stage says
    // which machine is doing the moving
    p.world.progress({ stage: "fetch", name: "clutch-workspace", version: "0.1.0+5f900739" });
    check(
      /Local \(this machine\) is fetching clutch-workspace 0\.1\.0\+5f900739/.test(p.stateText("clutch-workspace")),
      "the fetch stage says the target machine is getting its own bytes, not receiving ours"
    );
    p.world.progress({ stage: "fetch", name: "clutch-memory" });
    check(/is fetching clutch-workspace/.test(p.stateText("clutch-workspace")), "and a fetch stage is read per window like every other one");

    p.world.control.res({ ok: true, status: "installed", version: "0.1.0+5f900739", digest: "5f900739e6a35f43", path: "/home/u/.clutch/components/clutch-workspace" });
    await settle();
    check(/^installed clutch-workspace 0\.1\.0\+5f900739 on Local \(this machine\) · \/home\/u/.test(p.stateText("clutch-workspace")), "the verdict is the host's, with the path it landed at, and it stays on that row");
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
    check(/already current \(0\.1\.0\+5f900739\) on Local \(this machine\) — nothing was sent/.test(p.stateText("clutch-workspace")), "the host's 'current' verdict is reported as nothing sent");
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
    check(/remove clutch-workspace 0\.1\.0\+5f900739 from Local \(this machine\)/.test(p.removes()[0].title), "and its title names the machine that would lose the bytes");
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
    check(/is deleted from Local \(this machine\)/.test(ask.text), "the question says the bytes are deleted, and where");
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
    check(/^removed clutch-workspace 0\.1\.0\+5f900739 from Local \(this machine\)$/.test(p.stateText("clutch-workspace")), "the host's verdict names the versions that went");
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
    check(/^clutch-workspace was not installed on Local \(this machine\) — there was nothing to remove$/.test(p.stateText("clutch-workspace")), "a component that was already gone is reported as nothing to remove");
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
    check(/removing clutch-workspace from Local \(this machine\)/.test(p.stateText("clutch-workspace")), "the row says what is being removed from it, while it is being removed");
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
    check(p.world.marketCalls >= 2, "and it re-reads the sources (force)");
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
      /stop Local \(this machine\) driving clutch-workspace/.test(p.switches()[0].title),
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
    check(/drive clutch-workspace on Local \(this machine\) again/.test(held.switches()[0].title), "and its title names the machine it drives again");
    check(/its bytes stay where they are/.test(held.switches()[0].title), "still saying the bytes are what does not move");
    check(/clutch-workspace 0\.1\.0\+5f900739 stopped/.test(held.text()), "the row carries a 'stopped' chip beside the version");
    check(
      /(^| )stopped( |$)/.test(rowNamed(held.body(), "clutch-workspace").className),
      "and the whole row is coloured as stopped, not just the chip (U-7)"
    );
    check(/held on this machine, but not driven/.test(held.text()), "and a line saying it is still held (so 'stopped' is not read as 'gone')");
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
      /^stopped driving clutch-workspace on Local \(this machine\) — it is still held there, its tools are no longer offered$/.test(p.stateText("clutch-workspace")),
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
      /^driving clutch-workspace on Local \(this machine\) again — its tools are offered once more$/.test(p.stateText("clutch-workspace")),
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
      /^clutch-workspace is not held by Local \(this machine\) — there was nothing to stop or start$/.test(p.stateText("clutch-workspace")),
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
    check(/stopping clutch-workspace on Local \(this machine\)…/.test(p.stateText("clutch-workspace")), "the row says what is being stopped, while it is being stopped");
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
    check(/driving clutch-workspace on Local \(this machine\) again…/.test(back.stateText("clutch-workspace")), "the other direction has its own sentence");
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
    check(/cannot switch components/.test(p.switches()[0].title), "and it says the shell cannot, not that the machine refused");
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
    check(/the marked one is what that machine runs/.test(p.versionBtns()[0].title), "and which mark is the one that matters");
    check(p.ones().length === 0, "nothing per-version is drawn before it is asked for");
    p.versionBtns()[0].click();
    await settle();
    check(p.world.versionsCalls.join(",") === "clutch-workspace", "opening reads that one component from the machine that holds it");
    check(/this machine runs it/.test(p.text()), "the version the host resolved is marked as the one that runs");
    check(/held beside it/.test(p.text()), "and the others are drawn as held beside it, not as failures");
    check(/0\.1\.0\+bbbb/.test(p.text()) && /0\.1\.0\+aaaa/.test(p.text()), "every version the machine named is drawn");
    check(
      ownerName(p.ones()[0]) === "0.1.0+bbbb" && ownerName(p.ones()[1]) === "0.1.0+aaaa",
      "in the host's own order, newest first — this page never re-sorts it"
    );
    check(p.ones().length === 2, "each version gets its own removal control");
    check(ownerName(p.ones()[0]) === "0.1.0+bbbb", "and each control belongs to the version row that names what it takes");
    check(/remove clutch-workspace 0\.1\.0\+bbbb from Local \(this machine\)/.test(p.ones()[0].title), "its title names the machine that would lose those bytes");
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
    check(/cannot read the versions/.test(deaf.versionBtns()[0].title), "and it says the shell cannot, not that the machine refused");
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
    check(/^removed clutch-workspace 0\.1\.0\+bbbb from Local \(this machine\)$/.test(go.stateText("clutch-workspace")), "the host's verdict names the version that went");
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
    check(/removing clutch-workspace 0\.1\.0\+bbbb from Local \(this machine\)/.test(one.stateText("clutch-workspace")), "a removal of ONE version names that version while it happens");
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
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    check(p.buttons()[0].textContent === "Reinstall", "the row leads with the one write its state calls for");
    check(p.mores().length === 1, "and offers ONE '…' beside it, not a row of controls");
    check(ownerName(p.mores()[0]) === "clutch-workspace", "which belongs to the row whose actions it holds");
    check(p.menus().length === 1, "and holds one menu");
    check(p.menus()[0].classList.contains("open") === false, "closed on the first draw");
    check(
      p.menus()[0].children.length === 3 && p.menus()[0].children.every((c) => c.tag === "button"),
      "while the items are already in it: the switch, the versions, the removal"
    );
    p.mores()[0].click();
    check(p.menus()[0].classList.contains("open"), "a click opens it");
    p.mores()[0].click();
    check(p.menus()[0].classList.contains("open") === false, "and a second one shuts it again");

    // a component only this machine holds has nothing to install: the switch is
    // the write that leads, and the menu carries the read and the removal
    const alone = page({ held: [{ name: "solo", version: "0.1.0+aaaa", digest: "aaaa0000aaaa0000" }] });
    await alone.open();
    check(alone.switches()[0].textContent === "Disable", "a held row nothing offers leads with the switch");
    check(ownerName(alone.mores()[0]) === "solo", "and still carries its own menu");
    check(alone.menus()[0].children.length === 2, "holding the versions and the removal — no second switch beside the one that leads");
  }

  // 32. the filter row is a way of LOOKING at the one list, never a second one:
  //     every view narrows what is on screen, nothing is asked of the host to
  //     draw it, and going back to All shows the same rows that were there
  {
    const entries = [
      ...COMPONENTS,
      { name: "clutch-websearch", interface: "tool", version: "0.3.0", origin: "release", source: "clutch-websearch@v0.3.0", published: null },
      { name: "clutch-skills", interface: "tool", version: "0.2.0", origin: "release", source: "clutch-skills@v0.2.0", published: null },
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
    const box = p.nameBox();
    check(Boolean(box), "the row carries a box to filter by name");
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
    check(/no component is installed on it or known to this client/.test(bare.text()), "while a machine that really holds nothing keeps its own sentence");
    bare.chips()[3].click();
    check(
      !/matches this filter/.test(bare.text()) && /no component is installed on it or known to this client/.test(bare.text()),
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
      /^removed solo 1\.0\.0\+bbbbbbbb from Local \(this machine\)$/.test(p.note().textContent),
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
      { name: "clutch-websearch", interface: "tool", version: "0.3.0", origin: "release", source: "clutch-websearch@v0.3.0", published: null },
      { name: "clutch-skills", interface: "tool", version: "0.2.0", origin: "release", source: "clutch-skills@v0.2.0", published: null },
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

  summary("components-panel: the plugin tab's writes (target, confirm text, verdicts, re-read)");
})();
