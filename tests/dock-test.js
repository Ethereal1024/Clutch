"use strict";

// The right sidebar is a DOCK (ui/index.html `aside#right`): views stacked top to
// bottom the way VS Code's sidebar stacks its own, each one a head you collapse it
// by. This runner drives ui/src/renderer/dock.ts itself — the real file, taken from
// boot.ts's own import list — against a mini-DOM, because the state it owns has
// three ends that have to move together and no screenshot shows any of them:
//
//   the class the sheet paints (`.dock-collapsed`), the attribute a screen reader is
//   told (`aria-expanded`), and the layout the NEXT window opens with (localStorage,
//   remembered by group and NOT by tab: two tabs are two sessions, but one screen);
//   a body that comes back on screen is READ — the plugin list is a fact about the
//   open tab's machine, and a pane nobody looked at deliberately asked nothing, so
//   the read it deferred happens here, or on `clutch:panel-shown` (the panel's own
//   way back on screen);
//   and the View menu's door (`revealPlugins`) shows the panel, opens the group, or
//   — with both already on screen — puts the group away.
//
// What is stubbed is the environment (document, localStorage, the two modules dock
// imports); the logic under test is the real file.
//
// Run: node tests/dock-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, uiModules, rendererScript } = require("./harness.js");

const UI = path.join(__dirname, "..", "ui");
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
const css = fs.readFileSync(path.join(UI, "style.css"), "utf8");

// one rule's declarations, with its whitespace folded away
function decls(sheet, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = sheet.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// ---- a mini-DOM: the four elements the dock binds, plus the aside ----
function makeDocument() {
  function node(cls) {
    const n = {
      className: cls || "",
      title: "",
      attrs: {},
      listeners: {},
      classList: {
        add(...cs) {
          const s = new Set(n.className.split(" ").filter(Boolean));
          cs.forEach((c) => s.add(c));
          n.className = [...s].join(" ");
        },
        remove(...cs) {
          const s = new Set(n.className.split(" ").filter(Boolean));
          cs.forEach((c) => s.delete(c));
          n.className = [...s].join(" ");
        },
        toggle(c, on) {
          const want = on === undefined ? !n.classList.contains(c) : !!on;
          want ? n.classList.add(c) : n.classList.remove(c);
        },
        contains: (c) => n.className.split(" ").filter(Boolean).includes(c),
      },
      setAttribute(k, v) {
        n.attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in n.attrs ? n.attrs[k] : null;
      },
      addEventListener(ev, fn) {
        (n.listeners[ev] = n.listeners[ev] || []).push(fn);
      },
      click() {
        for (const fn of n.listeners.click || []) fn();
      },
    };
    return n;
  }
  const shell = node(""); // #right: the aside the groups live in
  const bySelector = new Map([
    ["#dock-toggle-workspace", node("")],
    ["#dock-workspace", node("dock-group")],
    ["#dock-toggle-plugins", node("")],
    ["#dock-plugins", node("dock-group")],
  ]);
  const panelShown = [];
  return {
    node,
    shell,
    bySelector,
    panelShown,
    document: {
      querySelector: (sel) => bySelector.get(sel) || null,
      addEventListener(ev, fn) {
        // the one event dock.ts listens for: the panel is on screen again
        if (ev === "clutch:panel-shown") panelShown.push(fn);
      },
    },
  };
}

// ---- one window: the real module, a fresh DOM, a remembered layout ----
// `layout` is what a previous window left in localStorage (the record dock.ts
// writes), so a scenario can open on a folded group the way a returning reader
// would.
function page({ layout = null, narrow = false } = {}) {
  const dom = makeDocument();
  const world = {
    store: {},
    reads: 0, // pluginTabShown() calls: a body asking for itself
    shown: 0, // showShellPanel() calls: the panel put back on screen
    narrow,
  };
  if (layout !== null) world.store.clutch_dock_groups = typeof layout === "string" ? layout : JSON.stringify(layout);
  const ctx = {
    console,
    document: dom.document,
    localStorage: {
      getItem: (k) => (k in world.store ? world.store[k] : null),
      setItem: (k, v) => {
        world.store[k] = String(v);
      },
    },
    $: (sel) => dom.bySelector.get(sel) || null,
    // ui/src/renderer/components-panel.ts: what the plugin group's body asks for
    // when it comes back on screen
    pluginTabShown: () => {
      world.reads++;
    },
    // ui/src/renderer/workspace-panel.ts: the shell the panel lives in
    NARROW_Q: { matches: narrow },
    shellPanel: dom.shell,
    setShellPanel: (open) => {
      dom.shell.classList.toggle("drawer-open", open);
      if (open) shownEvent();
    },
    showShellPanel: () => {
      world.shown++;
      // the real one ends in whichever shell is on screen: the drawer on a phone,
      // the column on the desktop — so the stub must not flatten the two
      if (narrow) {
        ctx.setShellPanel(true);
        return;
      }
      dom.shell.classList.remove("panel-hidden");
      shownEvent();
    },
    // ...and the event the real module dispatches when the panel comes back (one
    // listener list, exactly as the page has it)
    CustomEvent: function CustomEvent(type) {
      return { type };
    },
  };
  function shownEvent() {
    for (const fn of dom.panelShown) fn();
  }
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: "ui/src/renderer/dock.ts" });

  const el = (sel) => dom.bySelector.get(sel);
  return {
    ctx,
    world,
    store: () => {
      const raw = world.store.clutch_dock_groups;
      return raw ? JSON.parse(raw) : null;
    },
    workspace: () => el("#dock-workspace"),
    plugins: () => el("#dock-plugins"),
    head: (id) => el("#dock-toggle-" + id),
    click: (id) => el("#dock-toggle-" + id).click(),
    collapsed: (id) => el("#dock-" + id).classList.contains("dock-collapsed"),
    says: (id) => el("#dock-toggle-" + id).getAttribute("aria-expanded"),
    title: (id) => el("#dock-toggle-" + id).getAttribute("title"),
    reveal: () => vm.runInContext("revealPlugins()", ctx),
    open: (id) => vm.runInContext("dockIsOpen(" + JSON.stringify(id) + ")", ctx),
    shownEvent,
  };
}

// ---- the page loads this file at all ----
const mod = uiModules().find((m) => m.file === "dock.ts");
check(Boolean(mod), "boot.ts loads this module (uiModules() is boot.ts's own import list)");
const CODE = mod ? rendererScript("dock") : "null";

// ---- 1. a fresh window opens with both groups showing ----
{
  const p = page();
  check(!p.collapsed("workspace") && !p.collapsed("plugins"), "both groups are open in a window that has never been used");
  check(p.says("workspace") === "true" && p.says("plugins") === "true", "and the strip says so to a reader, not only to the eye (aria-expanded)");
  check(p.store() === null, "nothing is written until somebody changes it — opening the app is not a layout decision");
  check(p.world.reads === 0, "and a body that is on screen is not read by this file: the pane reads on the tab it is about, not on being painted");
}

// ---- 2. the head is the control, and it moves ONE group ----
{
  const p = page();
  p.click("workspace");
  check(p.collapsed("workspace") && !p.collapsed("plugins"), "collapsing the workspace leaves the plugin group where it was");
  check(p.says("workspace") === "false" && p.says("plugins") === "true", "and only that head's aria-expanded moves");
  check(p.title("workspace") === "expand the workspace", "the tooltip says what pressing it does NOW, which is the other half of the state");
  check(JSON.stringify(p.store()) === JSON.stringify({ workspace: false, plugins: true }), "and the layout is remembered by group");

  p.click("workspace");
  check(!p.collapsed("workspace") && p.says("workspace") === "true", "pressing it again puts it back");
  check(p.title("workspace") === "collapse the workspace", "with the tooltip saying so again");
  check(JSON.stringify(p.store()) === JSON.stringify({ workspace: true, plugins: true }), "and the record follows, both ways");
}

// ---- 3. the plugin group defers its read to the moment it is opened ----
{
  const p = page();
  p.click("plugins");
  check(p.collapsed("plugins"), "the plugin group folds to its head");
  check(p.world.reads === 0, "folding it asks for nothing: there is nothing on screen to answer");

  p.click("plugins");
  check(!p.collapsed("plugins") && p.world.reads === 1, "opening it is what reads it, once");
  p.click("plugins");
  p.click("plugins");
  check(p.world.reads === 2, "and every later opening asks again — a list that was folded away has drawn nothing since");
}

// ---- 4. a remembered layout is where the next window opens ----
{
  const p = page({ layout: { workspace: true, plugins: false } });
  check(!p.collapsed("workspace") && p.collapsed("plugins"), "the window opens exactly as it was left");
  check(p.says("plugins") === "false" && p.world.reads === 0, "with the head saying so — and the folded list is not read at load");

  // a record that will not parse is not a layout: a broken note must not open the
  // sidebar to nothing
  const broken = page({ layout: "{not json" });
  check(!broken.collapsed("workspace") && !broken.collapsed("plugins"), "a record that will not parse falls back to both groups open");
}

// ---- 5. the panel coming back on screen is the other way a body is read ----
{
  const p = page({ layout: { workspace: true, plugins: false } });
  p.shownEvent();
  check(p.world.reads === 0, "a folded group stays unread when the panel is put back on screen");

  p.click("plugins");
  p.click("plugins"); // folded again: 2 reads so far (one per opening)
  const before = p.world.reads;
  p.shownEvent();
  check(p.world.reads === before, "and only the groups that are OPEN are asked for themselves");
  p.click("plugins");
  const opened = p.world.reads;
  p.shownEvent();
  check(p.world.reads === opened + 1, "so an open plugin group is read again every time the panel comes back");
}

// ---- 6. the View menu's door: panel first, then the group ----
{
  // the aside is put away (the desktop column, .panel-hidden): the menu item puts
  // the surface back and leaves the group as the reader left it
  const p = page();
  // the panel is on screen and the group is open, so the menu item — a toggle, like
  // the rest of the menu — puts the group away
  p.reveal();
  check(p.collapsed("plugins"), "with the panel and the group both showing, the menu item puts the group away");

  p.reveal();
  check(!p.collapsed("plugins"), "and pressing it again brings the group back");

  p.ctx.shellPanel.classList.add("panel-hidden");
  p.reveal();
  check(p.world.shown === 1, "a panel that is put away is shown first (it is the surface), then the group");
  check(!p.collapsed("plugins"), "and the group is open on the way back");

  // a panel that is away AND a group that is folded: the read happens because the
  // panel came back (dock.ts listens for the same event the shell dispatches)
  p.ctx.shellPanel.classList.add("panel-hidden");
  p.click("plugins"); // folded
  const before = p.world.reads;
  p.reveal();
  check(!p.collapsed("plugins") && p.world.reads === before + 1, "a folded group is opened, and opened is read once");

  // the phone's drawer is the same act in a different shell
  const phone = page({ narrow: true });
  phone.reveal();
  check(phone.ctx.shellPanel.classList.contains("drawer-open"), "on a phone the drawer is what opens, through the shell's own entry point");
}

// ---- 7. the markup and the sheet this file drives ----
{
  check(/<div id="dock-workspace" class="dock-group"/.test(html), "the sidebar's first group is the workspace tree");
  check(/<div id="dock-plugins" class="dock-group"/.test(html), "and the second is the plugins this session can reach");
  check(
    /<button id="dock-toggle-workspace"[\s\S]{0,160}?aria-expanded="true"[\s\S]{0,80}?aria-controls="tree"/.test(html),
    "each head is a real button with the state and the region it owns (aria-expanded / aria-controls)"
  );
  check(
    /<button id="dock-toggle-plugins"[\s\S]{0,160}?aria-expanded="true"[\s\S]{0,80}?aria-controls="plug-pane"/.test(html),
    "…and the plugin head points at the pane, not at the dialog it used to live in"
  );
  check(/id="dock-plugins"[\s\S]*?id="plug-pane"[\s\S]*?<\/aside>/.test(html), "the plugin pane is INSIDE its group, which is what a fold hides");
  check(!/settings-pane-plugins/.test(html), "and the dialog's copy of it is gone: two places drawing one list is two answers to one question");

  check(
    decls(css, ".dock-group.dock-collapsed > .dock-body").includes("display: none"),
    "a folded group hides its BODY only — the head stays, which is what makes it a fold and not a dismissal"
  );
  // ...and the fold has to WIN the cascade, not merely be written down: the pane
  // states its own layout with an id (`#plug-pane { display: flex }`), and no number
  // of classes outranks an id, so a class-only fold silently lost and a "collapsed"
  // group kept its body — and its height — on screen (found by a real engine: 198px
  // of list under a head that said it was folded). The fold is the PARENT's state,
  // so one of its rules carries the sidebar's own id.
  const folds = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /\.dock-collapsed/.test(m[1]) && /display:\s*none/.test(m[2]))
    .map((m) => m[1].replace(/\s+/g, " ").trim());
  check(
    folds.some((sel) => /#[\w-]/.test(sel) && /\.dock-body\s*$/.test(sel)),
    "and that fold is stated at the sidebar's weight — an id in the selector — so `#plug-pane`'s own `display: flex` cannot outrank it"
  );
  check(/flex: 1 1 0/.test(decls(css, ".dock-group")), "the two open groups share the column's height between them");
  check(/flex: 0 0 auto/.test(decls(css, ".dock-group.dock-collapsed")), "and a folded one gives its height back to the group that is left");
  check(
    /content: "▸"/.test(css) && /content: "▾"/.test(css),
    "the caret is the state and it is the only thing that says a group can be put away at all"
  );
}

summary("dock: the sidebar's groups, what folds, and what is read when one opens");
