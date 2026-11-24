"use strict";

// The settings modal's three panes are different lengths (a profile form, the mirror
// list, the build's name plate) and the box is only as tall as the one that is
// showing, so a tab
// click RESIZES the box. That is the part of this modal a user notices, and it is
// the part a stylesheet cannot do: the height belongs to no element of its own, and
// it keeps moving after the tab lands — a validation line appears under a field, a
// notice is drawn — so the pane arrives at a height nobody measured at the click.
// ui/src/renderer/settings.ts therefore drives it by hand, one frame at a time, and
// this runner drives THAT: the real block is sliced out of the page's own settings
// module and run against a stub document and a fake frame clock, so the claims that
// are invisible in a passing screenshot can be asked one at a time —
//
//   the box is held at the height it had across the swap (no flash of the pane's
//   own height before the travel starts);
//   the travel is aimed at the NEXT frame, on purpose, because the pane that has
//   just been shown has not been laid out in the task that showed it;
//   a pane that grows under a travelling box takes the box with it, in the same
//   direction, and the box arrives at the height that pane ENDED up with (which is
//   exactly what a CSS transition aimed at the height measured at the click cannot
//   do);
//   a second click continues from wherever the first had reached, instead of
//   snapping to a pane's own height first;
//   a click on the tab already showing books no travel at all;
//   a box that is not on screen (display: none — where openSettings calls this) and
//   a reader who asked for less motion both get the pane change and no travel, and
//   the height is released to the stylesheet the moment the travel is over, so
//   every later resize is one frame again.
//
// The panes used to be three, became two when the plugin list left the dialog for a
// group of the right dock (ui/src/renderer/dock.ts), and are three again now that the
// mirror list has moved in from that same dock page: a mirror list is a fact about
// this machine, not about the session the plugin page is about, so it is a setting.
// Either way the mechanism below is the same — panes of different heights, one box.
//
// The same run checks the stylesheet facts the design leans on: the box's height is
// NOT transitioned anywhere (nothing in CSS fights the tween), the box does not
// scroll (the pane is the scroll region, and it is the box that is measured), the
// 300ms comes from the file picker's own transition (the sheet's --size token, and
// the constant that drives this tween is checked against that token), and
// ui/index.html opens with the strip and the panes agreeing about which one is
// showing.
//
// Run: node tests/settings-tabs-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, uiSource, runnableSnippet } = require("./harness.js");

const UI = path.join(__dirname, "..", "ui");
const css = fs.readFileSync(path.join(UI, "style.css"), "utf8");
const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");

// the real thing: from the strip's tabs, through the constants the travel's length
// lives on, to the switch that starts it. Sliced out of the page's own source
// (harness.js reads the script list index.html declares), so a module this page
// forgets to load fails here rather than passing against a copy.
const REGION = slicer(uiSource()).region('const SETTINGS_TABS = ["llm", "mirrors", "about"]', "showSettingsTab");

// one rule's declarations, with its whitespace folded away
function decls(sheet, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = sheet.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// ---- a frame clock: rAF timestamps the test controls ----
function makeClock() {
  let now = 0;
  let seq = 0;
  let queue = [];
  return {
    now: () => now,
    raf(cb) {
      const id = ++seq;
      queue.push({ id, cb });
      return id;
    },
    cancel(id) {
      queue = queue.filter((q) => q.id !== id);
    },
    pending: () => queue.length,
    // a browser frame is ~16 ms, and a callback armed DURING a step is due on the
    // next one — which is what makes the tween's own re-arm a real frame boundary
    // instead of a recursion that never yields
    advance(ms, onFrame) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        const due = queue;
        queue = [];
        for (const q of due) q.cb(now);
        if (onFrame) onFrame();
      }
    },
  };
}

// ---- stub page: the strip, the two panes, the box, and its height ----
function makePage(opts) {
  const o = Object.assign({ visible: true, reduced: false }, opts);

  function node(cls) {
    const n = {
      className: cls || "",
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
        contains: (c) => n.className.split(" ").includes(c),
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
    };
    return n;
  }

  const panes = { llm: node("modal-pane"), mirrors: node("modal-pane hidden"), about: node("modal-pane hidden") };
  const tabs = { llm: node("modal-tab active"), mirrors: node("modal-tab"), about: node("modal-tab") };
  tabs.llm.setAttribute("aria-selected", "true");
  tabs.mirrors.setAttribute("aria-selected", "false");
  tabs.about.setAttribute("aria-selected", "false");

  // what the three panes measure when each is showing on its own: the model form is
  // the long one, the mirror list sits in the middle, the name plate is three lines.
  // `about` is what MOVES in this run: a pane can change height while the box is on
  // its way to it (a validation line arriving, a notice drawn), which is the fact
  // the whole design is built around
  const natural = { llm: 300, mirrors: 600, about: 480 };

  const box = node("modal-box");
  // the sheet owns the height until a switch puts a number on the element, so the
  // stub starts where a real one does: an empty inline height, not an absent one
  box.style = { height: "" };
  box.getBoundingClientRect = () => {
    // an inline height wins while it is set, exactly as CSS would resolve it —
    // which is why the box is measured by clearing it first
    if (box.style.height) return { height: parseFloat(box.style.height) };
    if (!o.visible) return { height: 0 }; // display: none, the modal not yet opened
    const showing = ["llm", "mirrors", "about"].find((t) => !panes[t].classList.contains("hidden"));
    return { height: showing ? natural[showing] : 0 };
  };

  const bySelector = new Map([
    ["#settings-modal .modal-box", box],
    ["#settings-tab-llm", tabs.llm],
    ["#settings-tab-mirrors", tabs.mirrors],
    ["#settings-tab-about", tabs.about],
    ["#settings-pane-llm", panes.llm],
    ["#settings-pane-mirrors", panes.mirrors],
    ["#settings-pane-about", panes.about],
  ]);
  const clock = makeClock();
  const ctx = {
    $: (sel) => bySelector.get(sel) || node("div"),
    reducedMotion: () => o.reduced,
    requestAnimationFrame: clock.raf,
    cancelAnimationFrame: clock.cancel,
  };
  vm.createContext(ctx);
  vm.runInContext(runnableSnippet(REGION), ctx);

  return {
    ctx,
    box,
    panes,
    tabs,
    natural,
    clock,
    rect: () => box.getBoundingClientRect().height,
    held: () => box.style.height,
    anim: () => vm.runInContext("settingsHeightAnim", ctx),
    click: (name) => vm.runInContext("showSettingsTab(" + JSON.stringify(name) + ")", ctx),
    showing: () => ["llm", "mirrors", "about"].filter((t) => !panes[t].classList.contains("hidden")),
  };
}

// ---- 1. the swap is held at the height the box had ----
{
  const p = makePage();
  check(vm.runInContext("typeof showSettingsTab", p.ctx) === "function", "ui/src/renderer/settings.ts still owns the settings tab switch");
  check(decls(css, "#settings-modal .modal-box").includes("max-height"), "and the box it resizes is the one the sheet limits (max-height)");
  check(p.rect() === 300, "the stub opens on the model pane, a 300px box");

  p.click("about");
  check(p.held() === "300px", "the click holds the box at the height it HAD, so the swap cannot flash the pane's own height");
  check(p.showing().join() === "about", "the panes have changed under the hold");
  check(p.panes.llm.classList.contains("hidden"), "...the one that was showing is hidden, not merely outranked");
  check(
    p.tabs.about.attrs["aria-selected"] === "true" && p.tabs.llm.attrs["aria-selected"] === "false",
    "and the strip says which one is showing to a reader, not only to the eye (aria-selected, the half a class cannot say)"
  );
  check(
    p.anim() && p.anim().from === 300 && p.clock.pending() === 1 && p.rect() === 300,
    "the travel is ARMED for the next frame and not started in this one: the mirror pane is painted by a second listener in the same task (components-panel.ts), and that is the height to go to"
  );

  // ---- 2. it travels, and follows a pane that is still filling ----
  p.clock.advance(150);
  const mid = p.rect();
  check(mid > 300 && mid < 480, "halfway through, the box is between the two heights, on its way up");

  // the read answers: the market's list arrives while the box is still moving, and
  // the pane under it grows. (Its length is what a CSS transition aimed at the
  // height measured at the click would have missed.)
  p.natural.about = 720;
  const before = p.rect();
  p.clock.advance(20);
  check(p.rect() > before, "a pane that grows under a travelling box takes the box with it, in the same direction");

  let prev = p.rect();
  let monotone = true;
  p.clock.advance(500, () => {
    const h = p.rect();
    if (h < prev) monotone = false;
    prev = h;
  });
  check(monotone, "and it never doubles back on the way");
  check(p.rect() === 720, "the box arrives at the height the pane ENDED up with, not the one it had when the click landed");
  check(p.held() === "", "with the inline height released the moment it arrives, so every later resize is one frame again");
  check(p.anim() === null && p.clock.pending() === 0, "and no frame left running behind it");
}

// ---- 3. a second click continues from wherever the box is ----
{
  const p = makePage();
  p.click("about");
  p.clock.advance(150);
  const mid = p.rect();
  check(mid > 300 && mid < 480, "the box is in the air");
  p.click("llm");
  check(
    p.held() === mid + "px",
    "a second click takes the box over from the height it had reached, instead of snapping back to a pane's own height first"
  );
  check(p.tabs.llm.attrs["aria-selected"] === "true" && p.showing().join() === "llm", "and the swap itself is not deferred to the end of the travel");
  let prev = p.rect();
  let monotone = true;
  p.clock.advance(600, () => {
    const h = p.rect();
    if (h > prev) monotone = false;
    prev = h;
  });
  check(monotone && p.rect() === 300 && p.held() === "", "the box comes down to the model pane and stops there");
}

// ---- 4. a click on the tab already showing books no travel ----
{
  const p = makePage();
  p.click("llm");
  check(p.tabs.llm.attrs["aria-selected"] === "true" && p.showing().join() === "llm", "re-clicking the showing tab is a no-op the user cannot see");
  p.clock.advance(50);
  check(p.held() === "" && p.anim() === null && p.clock.pending() === 0, "and the hold it takes for the length of the swap is dropped on the first frame, with nothing moving");
}

// ---- 5. a name that is not a tab lands on the model pane ----
{
  const p = makePage();
  p.click("nope");
  check(p.showing().join() === "llm" && p.tabs.llm.attrs["aria-selected"] === "true", "a tab name the strip does not know falls back to the model pane, which is where the page opens");
}

// ---- 6. a box that is not on screen has no height to travel ----
{
  const p = makePage({ visible: false });
  check(p.rect() === 0, "a modal that has not been opened measures nothing (this is where openSettings switches tabs from)");
  p.click("about");
  check(p.held() === "" && p.anim() === null && p.clock.pending() === 0, "no height to hold and no travel booked — a pane change and nothing else");
  check(p.showing().join() === "about", "the pane still changes: opening straight onto a pane other than the model one works");
}

// ---- 7. less motion means no travel ----
{
  const p = makePage({ reduced: true });
  p.click("about");
  check(
    p.held() === "" && p.anim() === null && p.clock.pending() === 0,
    "a reader who asked for less motion gets the pane change and no travel: reduce-motion stops the sheet's transitions, and this is not one"
  );
  check(p.showing().join() === "about", "the pane change is still a pane change");
}

// ---- 7b. the mirror list is a pane of the same strip ----
// It moved here from the dock's plugin page (components-panel.ts used to draw it),
// so the one thing worth asking is that it is switched by the SAME mechanism as the
// other two and not by a listener of its own: one class on the pane, aria-selected
// on the tab, and the box held across the swap like any other click.
{
  const p = makePage();
  p.click("mirrors");
  check(p.showing().join() === "mirrors", "the mirror tab shows the mirror pane, and no other");
  check(p.panes.llm.classList.contains("hidden") && p.panes.about.classList.contains("hidden"), "...the two that were not chosen are hidden, not left showing underneath");
  check(
    p.tabs.mirrors.attrs["aria-selected"] === "true" && p.tabs.llm.attrs["aria-selected"] === "false",
    "and the strip announces it the same way it announces the other two"
  );
  check(p.held() === "300px" && p.anim() && p.anim().from === 300, "a mirror click books the same travel as any other tab: the box is held at the height it had");
  p.clock.advance(600);
  check(p.rect() === 600 && p.held() === "", "and it arrives at the mirror pane's own height, then lets go");
  p.click("llm");
  check(p.showing().join() === "llm" && p.tabs.llm.attrs["aria-selected"] === "true", "leaving the mirror pane is an ordinary tab click too");
}

// ---- 8. the stylesheet facts the design leans on ----
{
  const box = decls(css, "#settings-modal .modal-box");
  check(!/transition/.test(box), "the box's height is not transitioned anywhere in the sheet: nothing in CSS fights the frame-by-frame height");
  check(/overflow: hidden/.test(box), "and the box never scrolls (the PANE is the scroll region), so the box is a height that can be measured");
  check(
    /overflow-y: auto/.test(decls(css, "#settings-modal .modal-pane")),
    "which leaves the pane as the only thing that scrolls when the list is longer than the box"
  );
  check(
    /flex: 1 1 auto/.test(decls(css, "#settings-modal .modal-pane")),
    "the pane fills what is left of the box, so the box's height is the pane's height plus the box's own chrome"
  );

  // the --size is the sheet's own "a surface changing its own height" duration,
  // and settings.js takes its length from there (a box travelling between two
  // panes is exactly that kind of move). The number is read out of the sheet the
  // way the token is: a hardcoded 0.42s here would pin a copy of the value
  // instead of the value. The file picker's body collapses on a token too — the
  // same one for the height and the fade, which is the property its comment in
  // the sheet is about (a fade that outlives the collapse lingers over whatever
  // moved up into its place); WHICH token it uses is the picker's call.
  const fsBody = decls(css, "#fs-body");
  const travel = fsBody.match(/transition:\s*([^;]+);/);
  const heightToken = travel && travel[1].match(/max-height\s+var\((--[a-z0-9-]+)\)/);
  check(
    Boolean(heightToken) && new RegExp(`opacity\\s+var\\(${heightToken[1]}\\)`).test(travel[1]),
    "#fs-body still collapses its height — and its fade is the same length as the collapse"
  );
  const size = css.match(/--size:\s*([\d.]+)s\s*;/);
  check(
    Boolean(size) && Math.round(parseFloat(size[1]) * 1000) === vm.runInContext("SETTINGS_HEIGHT_MS", makePage().ctx),
    "and the settings box travels for exactly as long as the sheet's --size says"
  );
  check(
    /prefers-reduced-motion: reduce/.test(css),
    "the sheet still has the reduce-motion block settings.js steps aside for"
  );

  // the strip is real in the markup, and it OPENS agreeing with itself: the swap
  // moves a class and writes aria-selected, so a page that started the two out of
  // step would open lying about which pane is showing
  check(
    /id="settings-tab-llm"[^>]*role="tab"/.test(html) &&
      /id="settings-tab-mirrors"[^>]*role="tab"/.test(html) &&
      /id="settings-tab-about"[^>]*role="tab"/.test(html),
    "index.html declares the strip as role=tablist's three tabs"
  );
  check(
    /id="settings-pane-llm"[^>]*role="tabpanel"/.test(html) &&
      /id="settings-pane-mirrors"[^>]*role="tabpanel"/.test(html) &&
      /id="settings-pane-about"[^>]*role="tabpanel"/.test(html),
    "over three role=tabpanel panes"
  );
  check(
    /id="settings-pane-about"[^>]*class="[^"]*hidden/.test(html) && /id="settings-tab-about"[\s\S]*?aria-selected="false"/.test(html),
    "and the About pane opens hidden with its tab saying so (aria-selected=false), the state the first switch moves away from"
  );
  check(
    /id="settings-pane-mirrors"[^>]*class="[^"]*hidden/.test(html) && /id="settings-tab-mirrors"[\s\S]*?aria-selected="false"/.test(html),
    "the mirror pane opens hidden too, its tab saying the same, because the model pane is where the dialog opens"
  );
  check(!/id="settings-pane-llm"[^>]*hidden/.test(html), "while the model pane is the one showing");
  // ...and the strip carries no fourth: the plugin list left the dialog for a group
  // of the right dock, and a tab still pointing at a pane that no longer exists would
  // be the same page lying in a quieter way
  check(!/settings-(tab|pane)-plugins/.test(html), "and no plugins tab: the plugin list is a view of the sidebar now, not a pane of this dialog");

  // the focus look of a box you type in is ONE line: the border goes accent and no
  // ring is drawn around it, because the ring cannot be handed to the keyboard alone
  // (a browser marks a text field however it was focused, so a ring here is a second
  // accent line 2px outside the first on every click). These four say the look is
  // still that one, in the sheet and in the markup that reads it.
  check(
    !/#task-input:focus-visible|\.modal-box input:focus-visible/.test(css),
    "the ring's list does not name a text box: a field marks focus with its lit border, not with a second accent line 2px outside it"
  );
  check(
    /outline: none/.test(decls(css, "#task-input:focus")) && /border-color: var\(--accent\)/.test(decls(css, "#task-input:focus")),
    "the composer turns the outline off and lights its own border instead, so the pointer and the keyboard get the same single line"
  );
  check(
    /outline: none/.test(decls(css, ".modal-box input:focus")),
    "and every field in a modal says the same, one line and no ring"
  );
  // ...and the pane that left the dialog kept the look: it is a sidebar view now, so
  // it says the same thing in its own rule instead of inheriting the dialog's
  check(
    /#plug-pane input:focus[^{]*\{[^}]*outline: none/.test(css),
    "the plugin list's own fields light their border the same way, in their own block"
  );
  check(
    /outline: none/.test(decls(css, ".fs-conn-row select:focus")),
    "the picker's host row keeps up with them, which is why the picker's other selects are the only ones the ring still reaches"
  );
}

summary("settings-tabs: the settings modal's tabs and the box that follows them");
