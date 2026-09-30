"use strict";

// The plugin tab is the ONE place this UI can write to a machine (PLUGIN_PLAN.md
// I5), so its install path is the part that must not drift silently: which
// machine the button claims, what the confirmation says, what a refusal looks
// like, and what the page does afterwards. Nothing smaller than the page's own
// file tests that, and the page is DOM code driven by ui/components-view.js over
// the clutchComponents channel.
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

// the row a control sits in, by walking up the parents the mini-DOM kept
function rowOf(el) {
  let cur = el;
  while (cur && cur.className !== "plug-row") cur = cur.parent;
  return cur;
}

function ownerName(el) {
  const row = rowOf(el);
  return row ? textOf(row.children[0].children[0]).trim() : "";
}

const IDS = ["plug-body", "plug-target", "plug-base", "plug-note", "plug-reload", "settings-tab-plugins"];

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
function page({ held = [], heldError = null, listError = null, target = LOCAL, entries = COMPONENTS, store = {} } = {}) {
  const dom = makeDocument(IDS);
  const world = {
    listCalls: 0,
    marketCalls: 0,
    installCalls: [],
    progress: null,
    control: null,
    reply: null,
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
    onProgress: (cb) => { world.progress = cb; },
  };
  const ctx = {
    console,
    setImmediate,
    setTimeout,
    clearTimeout,
    Promise,
    document: dom.document,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
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
    note: () => dom.byId.get("#plug-note"),
    text: () => textOf(dom.byId.get("#plug-body")),
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
    check(/take an installed component back yet/.test(p.text()), "the market says a write cannot be taken back (I5, visible without hovering)");
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
    check(/cannot undo that/.test(ask.text), "and states that this page cannot undo it (I5)");
    check(p.world.installCalls.length === 0, "a declined install writes nothing");
    check(p.note().textContent === "", "and leaves no verdict behind");
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
    check(/installing clutch-workspace/.test(p.note().textContent), "the note says what is happening while it happens");
    check(p.buttons().every((b) => b.disabled), "and every button is dead while a write is in flight");
    p.world.progress({ stage: "artifact", name: "clutch-workspace" });
    check(/preparing the bytes/.test(p.note().textContent), "the building stage is drawn");

    p.world.progress({ stage: "upload", name: "clutch-workspace", version: "0.1.0+5f900739" });
    check(/sending clutch-workspace 0\.1\.0\+5f900739 to Local \(this machine\)/.test(p.note().textContent), "the upload stage names the bytes and the machine");
    p.world.progress({ stage: "upload", name: "clutch-memory" });
    check(/sending clutch-workspace/.test(p.note().textContent), "a stage from another window's install is ignored");

    p.world.control.res({ ok: true, status: "installed", version: "0.1.0+5f900739", digest: "5f900739e6a35f43", path: "/home/u/.clutch/components/clutch-workspace" });
    await settle();
    check(/^installed clutch-workspace 0\.1\.0\+5f900739 on Local \(this machine\) · \/home\/u/.test(p.note().textContent), "the verdict is the host's, with the path it landed at");
    check(p.note().className.includes("error") === false, "a successful install is not drawn as an error");
    check(p.world.listCalls > before, "the machine's inventory is read again after it changed");
  }

  // 6. a verdict of 'current' sends nothing and says so
  {
    const p = page();
    await p.open();
    p.world.reply = { ok: true, status: "current", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" };
    p.buttons()[0].click();
    await settle();
    check(/already current \(0\.1\.0\+5f900739\) on Local \(this machine\) — nothing was sent/.test(p.note().textContent), "the host's 'current' verdict is reported as nothing sent");
  }

  // 7. a refusal is quoted, not paraphrased, and drawn as a failure
  {
    const p = page();
    await p.open();
    p.world.reply = { ok: false, name: "clutch-workspace", error: "artifact sha256 does not match the declaration" };
    p.buttons()[0].click();
    await settle();
    check(p.note().textContent.includes("artifact sha256 does not match the declaration"), "the host's own refusal reaches the page verbatim");
    check(p.note().className.includes("error"), "and is drawn as a failure");
    check(p.buttons().every((b) => !b.disabled), "the buttons come back once the write failed");
  }

  // 8. a broken IPC hop is a failure with a reason, not a silent no-op
  {
    const p = page();
    await p.open();
    p.ctx.window.clutchComponents.install = async () => { throw new Error("main process is gone"); };
    p.buttons()[1].click();
    await settle();
    check(/could not install clutch-memory .*main process is gone/.test(p.note().textContent), "a channel that threw is reported as the install's reason");
  }

  // 9. a read started from the tab shows the pending line, not a stale verdict
  {
    const p = page();
    await p.open();
    check(p.buttons().length === 2, "the first read drew the market");
    p.world.reply = { ok: true, status: "installed", version: "0.1.0+x", digest: "x" };
    p.buttons()[0].click();
    await settle();
    const kept = p.note().textContent;
    p.el("plug-reload").click(); // a refresh is a request for facts, not a place to keep a report
    check(p.note().textContent !== kept || /reading/.test(p.note().textContent), "a reload replaces the last verdict with what it is doing now");
    await settle();
    check(p.world.marketCalls >= 2, "and it re-reads the sources (force)");
  }

  summary("components-panel: the plugin tab's install path (target, confirm text, verdicts, re-read)");
})();
