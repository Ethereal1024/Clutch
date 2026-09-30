"use strict";

// The plugin tab is the ONE place this UI can write to a machine (PLUGIN_PLAN.md
// I5), so both of its write paths are what must not drift silently: which machine
// a control claims, what the confirmation says, what a refusal looks like, and
// what the page does afterwards — for the install and for the removal (the
// reverse verb, which is the one that DELETES, so its wording is checked for the
// fact that it is not a rollback). Nothing smaller than the page's own file tests
// that, and the page is DOM code driven by ui/components-view.js over the
// clutchComponents channel.
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
    removeCalls: [],
    progress: null,
    control: null,
    reply: null,
    removeReply: { ok: true, status: "removed", removed: ["0.1.0+5f900739"] },
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
    remove: async (name) => {
      world.removeCalls.push(name);
      if (world.control) return world.control.promise;
      return world.removeReply;
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
    removes: () => walk(dom.byId.get("#plug-body")).filter((n) => n.tag === "button" && /plug-remove/.test(n.className)),
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
    check(/^removed clutch-workspace 0\.1\.0\+5f900739 from Local \(this machine\)$/.test(p.note().textContent), "the host's verdict names the versions that went");
    check(p.note().className.includes("error") === false, "a completed removal is not drawn as an error");
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
    check(/^clutch-workspace was not installed on Local \(this machine\) — there was nothing to remove$/.test(p.note().textContent), "a component that was already gone is reported as nothing to remove");
    check(p.note().className.includes("error") === false, "and it is not drawn as a failure");
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
    check(p.note().textContent.includes("pid 4242"), "the host's own refusal reaches the page verbatim");
    check(p.note().className.includes("error"), "and is drawn as a failure");
    check(p.removes()[0].disabled === false, "the control comes back once the write failed");

    const broken = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await broken.open();
    broken.ctx.window.clutchComponents.remove = async () => { throw new Error("main process is gone"); };
    broken.removes()[0].click();
    await settle();
    check(/could not remove clutch-workspace .*main process is gone/.test(broken.note().textContent), "a channel that threw is reported as the removal's reason");
  }

  // 14. one write at a time, including across the two directions: a removal in
  //     flight disables the installs, an install in flight disables the removals
  {
    const p = page({ held: [{ name: "clutch-workspace", version: "0.1.0+5f900739", digest: "5f900739e6a35f43" }] });
    await p.open();
    p.world.control = defer();
    p.removes()[0].click();
    await settle(3);
    check(/removing clutch-workspace from Local \(this machine\)/.test(p.note().textContent), "the note says what is being removed, while it is being removed");
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

  // 16. a read started from the tab shows the pending line, not a stale verdict
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

  summary("components-panel: the plugin tab's writes (target, confirm text, verdicts, re-read)");
})();
