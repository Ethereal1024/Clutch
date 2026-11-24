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

// ---- a mini-DOM: the elements the dock binds, plus the aside ----
// Every node carries a `style` object and reports a height of 0 until a scenario
// gives it one (`page().measure`): that is a DOM with no layout, which is one of
// the two states the splitter has to survive (the other is a measured column).
function makeDocument() {
  function node(cls) {
    const n = {
      className: cls || "",
      title: "",
      attrs: {},
      listeners: {},
      style: {},
      parentElement: null,
      getBoundingClientRect: () => ({ height: 0 }),
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
  // the handle sits between the two groups, exactly as it does in the page, and it
  // measures its own height out of the column it divides
  const split = node("dock-split");
  split.parentElement = shell;
  const bySelector = new Map([
    ["#dock-toggle-workspace", node("")],
    ["#dock-workspace", node("dock-group")],
    ["#dock-toggle-plugins", node("")],
    ["#dock-plugins", node("dock-group")],
    ["#dock-split", split],
  ]);
  const panelShown = [];
  const resizes = [];
  return {
    node,
    shell,
    split,
    bySelector,
    panelShown,
    resizes,
    document: {
      querySelector: (sel) => bySelector.get(sel) || null,
      addEventListener(ev, fn) {
        // the one event dock.ts listens for: the panel is on screen again
        if (ev === "clutch:panel-shown") panelShown.push(fn);
      },
    },
    // ...and the one event it listens for on the window: a column that got shorter
    addEventListener(ev, fn) {
      if (ev === "resize") resizes.push(fn);
    },
  };
}

// ---- one window: the real module, a fresh DOM, a remembered layout ----
// `layout` is what a previous window left in localStorage (the record dock.ts
// writes), so a scenario can open on a folded group the way a returning reader
// would.
function page({ layout = null, split = null, narrow = false } = {}) {
  const dom = makeDocument();
  const world = {
    store: {},
    reads: 0, // pluginTabShown() calls: a body asking for itself
    shown: 0, // showShellPanel() calls: the panel put back on screen
    narrow,
  };
  if (layout !== null) world.store.clutch_dock_groups = typeof layout === "string" ? layout : JSON.stringify(layout);
  // what a previous window left as the boundary between the groups (px), when a
  // scenario opens on one
  if (split !== null) world.store.clutch_dock_split = String(split);
  const ctx = {
    console,
    document: dom.document,
    addEventListener: dom.addEventListener,
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
    // ---- the splitter ----
    splitEl: () => el("#dock-split"),
    splitHidden: () => el("#dock-split").classList.contains("hidden"),
    splitPx: () => vm.runInContext("dockSplit()", ctx),
    setSplit: (px, remember) => vm.runInContext("dockSetSplit(" + Number(px) + (remember === false ? ", {remember:false}" : "") + ")", ctx),
    savedSplit: () => (world.store.clutch_dock_split === undefined ? null : world.store.clutch_dock_split),
    flex: () => el("#dock-workspace").style.flex,
    // a height for one of the boxes the splitter measures (the column, a head, the
    // handle); the handle's own rect is the one element measured twice
    measure(sel, height) {
      const target = sel === "#dock-split" ? dom.split : sel === "#right" ? dom.shell : el(sel);
      if (!target) throw new Error("no node for " + sel);
      target.getBoundingClientRect = () => ({ height });
    },
    // a pointer drag on the handle: down at y0, move to y1, let go
    pointer(type, y, id = 1) {
      for (const fn of dom.split.listeners[type] || []) fn({ clientY: y, pointerId: id, preventDefault() {} });
    },
    drag(fromY, toY) {
      this.pointer("pointerdown", fromY);
      this.pointer("pointermove", toY);
      this.pointer("pointerup", toY);
    },
    key(name) {
      for (const fn of dom.split.listeners.keydown || []) fn({ key: name, preventDefault() {} });
    },
    resize() {
      for (const fn of dom.resizes) fn();
    },
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

// ---- 8. how much of the column each open group gets ----
// #dock-split is the line between the two groups and the control that moves it.
// Three inputs reach one number — a drag, the arrow keys, the record a returning
// window reads — and the number is the workspace group's height, because that is
// the group a downward drag grows. Nothing is drawn between two groups only one of
// which is open: a fold is already the whole column.
{
  const p = page();
  check(/id="dock-workspace"[\s\S]*?id="dock-split"[\s\S]*?id="dock-plugins"/.test(html), "the handle is a real element BETWEEN the two groups, which is the boundary a reader sees");
  check(/id="dock-split"[\s\S]{0,200}?role="separator"/.test(html), "it is a separator, so a screen reader is told what the line is");
  check(/id="dock-split"[\s\S]{0,200}?tabindex="0"/.test(html), "with a tab stop: the keyboard has to be able to reach the control the mouse has");
  check(!p.splitHidden(), "with both groups open the handle is on screen");
  check(p.flex() === "", "and a window that has never been dragged leaves the halves to the sheet (no inline height)");
  check(p.splitPx() === 0 && p.savedSplit() === null, "nothing is written until somebody moves it — opening the app is not a layout decision either");
}

// ---- 9. one number, written on the way out ----
{
  const p = page();
  p.setSplit(240);
  check(p.splitPx() === 240 && p.flex() === "0 0 240px", "a split is applied as a FIXED height on the workspace group, so a short window cannot eat the boundary the reader set");
  check(p.savedSplit() === "240", "and it is remembered the way the fold is: a number of px in localStorage, not a fraction of a column that may not be the same size");

  const q = page({ split: 300 });
  check(q.splitPx() === 300 && q.flex() === "0 0 300px", "a returning window opens on the boundary it was left with");

  // a record that is not a usable number is not a layout
  const bad = page({ split: "half" });
  check(bad.splitPx() === 0 && bad.flex() === "", "a record that is not a positive number falls back to the sheet's halves");
}

// ---- 10. neither group can be squeezed away ----
{
  const p = page();
  p.setSplit(10);
  check(p.splitPx() === 80 && p.flex() === "0 0 80px", "a boundary below the floor is held at the floor: a group is a head and at least one row");

  // now the column can be measured: 600px, a 7px handle and a 30px plugin head
  p.measure("#right", 600);
  p.measure("#dock-split", 7);
  p.measure("#dock-toggle-plugins", 30);
  p.setSplit(10000);
  check(p.splitPx() === 483, "and it cannot eat the plugin group: the ceiling is the column minus the handle, the plugin head and the same floor");

  p.measure("#right", 0); // a DOM with no layout at all, which is also a hidden panel
  p.setSplit(10000);
  check(p.splitPx() === 10000, "with nothing to measure the floor still holds and the ceiling is nobody's (the splitter does not invent a height)");
}

// ---- 11. the handle goes with the fold it cannot divide ----
{
  const p = page({ split: 240 });
  p.click("plugins");
  check(p.splitHidden(), "folding one group puts the handle away with it: a grip over nothing moves no boundary");
  check(p.flex() === "", "and the group that is left takes the whole column (the inline height is dropped, not merely ignored)");
  p.click("plugins");
  check(!p.splitHidden() && p.flex() === "0 0 240px", "reopening brings the boundary back exactly where the reader left it");
}

// ---- 12. the keyboard half of a separator ----
{
  const p = page({ split: 240 });
  p.key("ArrowDown");
  check(p.splitPx() === 256 && p.savedSplit() === "256", "one press down gives the workspace group a step, and it is remembered like a drag's");
  p.key("ArrowUp");
  p.key("ArrowUp");
  check(p.splitPx() === 224, "and up gives the column back to the plugin group, one step a press");
  p.key("Enter");
  check(p.splitPx() === 224 && p.savedSplit() === "224", "a key that is not the separator's changes nothing and writes nothing");
  p.setSplit(90);
  p.key("ArrowUp");
  p.key("ArrowUp");
  check(p.splitPx() === 80, "the floor is a floor from the keyboard too");
}

// ---- 13. a drag is one number at the end, not one per frame ----
{
  const p = page({ split: 240 });
  p.pointer("pointerdown", 300);
  check(p.splitEl().classList.contains("dragging"), "the handle marks itself while a hand is on it, which is what lights the line");
  p.pointer("pointermove", 260);
  check(p.splitPx() === 200 && p.flex() === "0 0 200px", "moving up by 40px gives the plugin group those 40px");
  check(p.savedSplit() === "240", "and nothing is written while the hand is still moving: a drag is not a frame's worth of layouts");
  p.pointer("pointerup", 260);
  check(!p.splitEl().classList.contains("dragging") && p.savedSplit() === "200", "letting go writes the one number it landed on");
  p.pointer("pointermove", 100);
  check(p.splitPx() === 200, "a pointer that is not dragging moves nothing (the move listener does not trust the window it is in)");
}

// ---- 14. a column that got shorter re-clamps, and keeps the reader's number ----
{
  const p = page({ split: 400 });
  p.measure("#dock-toggle-plugins", 30);
  p.measure("#dock-split", 7);
  p.measure("#right", 300);
  p.resize();
  check(p.flex() === "0 0 183px", "a window that got shorter re-clamps the boundary it was showing, so the plugin group is never squeezed off the bottom");
  check(p.splitPx() === 400 && p.savedSplit() === "400", "without rewriting the reader's number: the split is still theirs, it just cannot be taller than the column it divides");
  p.measure("#right", 800);
  p.resize();
  check(p.flex() === "0 0 400px", "and a window that grows again gets that boundary back, not a new guess");
}

// ---- 15. the sheet draws the handle it was given ----
{
  const handle = decls(css, ".dock-split");
  check(/height: 7px/.test(handle) && /cursor: row-resize/.test(handle), "the sheet draws a 7px strip with the row-resize pointer: the line is the control");
  check(/touch-action: none/.test(handle), "and touch-action is off, so a drag on a phone resizes instead of scrolling the pane under the finger");
  check(/flex: none/.test(handle), "the handle keeps its own height instead of sharing the column with the groups it divides");
  check(
    /\.dock-split:hover::before/.test(css) && /\.dock-split\.dragging::before/.test(css),
    "the hairline lights up under the pointer and under a drag, the same accent any other control with the pointer carries"
  );
  check(!/\.dock-group \+ \.dock-group\s*\{/.test(css), "and the groups' own seam is gone: the handle is the only line between them, or there would be two");
}

summary("dock: the sidebar's groups, what folds, and what is read when one opens");
