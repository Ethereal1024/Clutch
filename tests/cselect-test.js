"use strict";

// The dropdown widget's own device report: an option's MARK (the ✓ of the host or
// profile this window is on) is not part of the option's NAME.
//
// When it was — `textContent = name + " ✓"`, however it was spelled — a long
// unbreakable label (user@a-rather-long-host-name.example.com:2222) had exactly one
// break opportunity: the space before the tick. So on a narrow screen the label
// pushed the popup sideways into a horizontal scrollbar and dropped the ✓ onto a
// second line, and the closed control showed the same wreckage (device report).
//
// The widget now draws a mark in a COLUMN of its own — one flex child beside the
// label, on the button (value | mark | arrow) and on the row (label | mark) — and it
// is the LABEL that gives way (…). This runner drives the REAL customSelect out of
// js/settings.js against a stub DOM, so the two nodes can be seen apart (text in the
// label, tick in the mark, and neither one inside the other), and checks the
// stylesheet still holds the two facts the split depends on: the label truncates,
// the mark never does, and the popup grows to its content instead of inheriting the
// sliver the closed control may be squeezed into.
//
// Run: node tests/cselect-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource } = require("./harness.js");

// ---- stub DOM: enough shape for the widget (class names, children, listeners) ----
function node(tag) {
  const n = {
    tag,
    children: [],
    className: "",
    attrs: {},
    listeners: {},
    focused: false,
    _text: "",
    appendChild(ch) {
      n.children.push(ch);
      ch.parent = n;
      return ch;
    },
    getAttribute(k) {
      return k in n.attrs ? n.attrs[k] : null;
    },
    setAttribute(k, v) {
      n.attrs[k] = String(v);
    },
    contains(m) {
      return m === n || n.children.some((c) => c.contains && c.contains(m));
    },
    addEventListener(ev, fn) {
      (n.listeners[ev] || (n.listeners[ev] = [])).push(fn);
    },
    fire(ev, arg) {
      for (const fn of n.listeners[ev] || []) fn(arg || { stopPropagation() {} });
    },
    focus() {
      n.focused = true;
    },
    classList: {
      add(...cls) {
        for (const c of cls) if (!has(n, c)) n.className = (n.className + " " + c).trim();
      },
      remove(...cls) {
        n.className = n.className.split(" ").filter((c) => c && !cls.includes(c)).join(" ");
      },
      contains: (c) => has(n, c),
      toggle(c, on) {
        const want = on === undefined ? !has(n, c) : !!on;
        if (want) n.classList.add(c);
        else n.classList.remove(c);
      },
    },
    get textContent() {
      return n.children.length ? n.children.map((c) => c.textContent).join("") : n._text;
    },
    set textContent(v) {
      n.children.length = 0;
      n._text = String(v);
    },
  };
  Object.defineProperty(n, "innerHTML", {
    get: () => "",
    set: () => {
      n.children.length = 0;
    },
  });
  return n;
}
const has = (n, c) => n.className.split(" ").filter(Boolean).includes(c);
const kids = (n, c) => n.children.filter((x) => has(x, c));
// a structure that is wrong must fail a CHECK, not abort the run: a missing node
// comes back as an empty stand-in, so every assertion still speaks
const NONE = node("span");
const one = (n, c) => {
  const m = kids(n, c);
  return m.length === 1 ? m[0] : NONE;
};

const doc = {
  listeners: {},
  createElement: (t) => node(t),
  addEventListener(ev, fn) {
    (doc.listeners[ev] || (doc.listeners[ev] = [])).push(fn);
  },
  fire(ev, arg) {
    for (const fn of doc.listeners[ev] || []) fn(arg || {});
  },
};
global.document = doc;

const APP = uiSource(); // the renderer, every module in page load order
const { fnBody } = slicer(APP);
(0, eval)(fnBody("customSelect")); // the REAL widget

const CSS = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
const MOBILE = fs.readFileSync(path.join(__dirname, "..", "ui", "mobile.css"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "ui", "index.html"), "utf8");

function main() {
  // the picker's root in the markup: a <select> with a title, which the widget
  // replaces with its own button + popup
  const root = node("select");
  root.setAttribute("title", "Choose a host");
  const sel = customSelect(root);

  const LONG = "me@a-rather-long-host-name.example.com:2222";
  const opt = (text, mark) => {
    const o = node("option");
    o.value = "ssh:" + text;
    o.textContent = text;
    if (mark) o.mark = mark;
    return o;
  };

  sel.innerHTML = "";
  sel.appendChild(opt(LONG, "✓")); // the host this window is on
  sel.appendChild(opt("me@box.example.com:22")); // and one it is not
  const btn = one(root, "cselect-btn");
  const pop = one(root, "cselect-pop");

  // ---- 1) the ROW: the label is the name, the mark is a node beside it ----
  check(pop.children.length === 2, `one row per option (got ${pop.children.length})`);
  const row = pop.children[0];
  const bare = pop.children[1];
  check(kids(row, "cselect-opt-label").length === 1 && kids(row, "cselect-mark").length === 1,
    "a marked option is a label node AND a mark node, not one string");
  const label = one(row, "cselect-opt-label");
  const mark = one(row, "cselect-mark");
  check(label.textContent === LONG,
    `the label holds the option's whole name, untouched (got ${JSON.stringify(label.textContent)})`);
  check(!/✓/.test(label.textContent), "and no tick is hiding inside it");
  check(mark.textContent === "✓" && mark !== label, "the ✓ is its own node, beside the label");
  check(row.children.indexOf(label) < row.children.indexOf(mark),
    "label first, mark after: the mark column closes the row");
  check(kids(bare, "cselect-mark").length === 0 &&
    one(bare, "cselect-opt-label").textContent === "me@box.example.com:22",
    "an option with no mark grows no mark column at all: an unmarked row is its label");

  // ---- 2) the BUTTON: value, mark, arrow — three nodes, not one line of text ----
  sel.value = "ssh:" + LONG;
  const valueEl = one(btn, "cselect-value");
  const markEl = one(btn, "cselect-mark");
  check(valueEl.textContent === LONG && !/✓/.test(valueEl.textContent),
    `the closed control shows the name in its own node (got ${JSON.stringify(valueEl.textContent)})`);
  check(markEl.textContent === "✓", "with the ✓ in a column of its own after it");
  check(btn.children.indexOf(valueEl) < btn.children.indexOf(markEl) &&
    btn.children.indexOf(markEl) < btn.children.indexOf(one(btn, "cselect-arrow")),
    "value, then mark, then arrow: the arrow stays last");
  check(btn.children.length === 3 && kids(btn, "cselect-mark").length === 1,
    `three children, exactly one of them the mark column (got ${btn.children.length})`);
  sel.value = "ssh:me@box.example.com:22";
  check(one(btn, "cselect-value").textContent === "me@box.example.com:22" &&
    one(btn, "cselect-mark").textContent === "",
    "an option with no mark EMPTIES the column instead of taking it away: the button keeps its shape as the choice moves");

  // ---- 3) a re-render rebuilds both, and never keeps an old tick ----
  sel.value = "ssh:" + LONG;
  sel.value = "ssh:me@box.example.com:22";
  sel.value = "ssh:" + LONG;
  check(pop.children.length === 2 && kids(pop.children[0], "cselect-mark").length === 1 &&
    kids(pop.children[1], "cselect-mark").length === 0 &&
    one(pop.children[0], "cselect-opt-label").textContent === LONG,
    "each render redraws the rows whole: one mark where the option has one, none anywhere else");
  check(has(pop.children[0], "active") && !has(pop.children[1], "active"),
    "and the row that is the choice is the active one");

  // ---- 4) choosing a row is one act, and it moves the button with it ----
  const fired = [];
  sel.addEventListener("change", () => fired.push(sel.value));
  sel.value = "ssh:me@box.example.com:22"; // the page's own landing choice, as the picker makes it
  check(fired.length === 0,
    "a value the PAGE sets is not a change: landing on an entry dials nothing — only a press fires the listener");
  pop.children[0].fire("click"); // row 0: the host this window is on
  check(fired.length === 1 && sel.value === "ssh:" + LONG,
    `pressing a row IS the choice, once (got ${fired.length}: ${fired.join(",")})`);
  check(one(btn, "cselect-value").textContent === LONG && one(btn, "cselect-mark").textContent === "✓",
    "the button follows it, mark column and all");
  check(!root.classList.contains("open"), "and the popup closes on the press");
  pop.children[0].fire("click"); // the row the picker already holds
  check(fired.length === 1, "choosing where the picker already is is not a change");
  check(kids(pop.children[1], "cselect-mark").length === 0,
    "nor does it hand out a mark the option never had");

  // ---- 5) a picker with nothing to pick from cannot be opened ----
  btn.fire("click");
  check(root.classList.contains("open"), "a live picker opens on the button's own press");
  btn.fire("click");
  check(!root.classList.contains("open"), "and closes on the next");
  sel.disabled = true;
  check(sel.disabled === true && root.classList.contains("disabled"),
    "an empty picker is disabled — the class, since the button is a real <button>");
  btn.fire("click");
  check(!root.classList.contains("open"), "and a disabled control does not open (the profile picker used to)");
  sel.disabled = false;
  btn.fire("click");
  check(root.classList.contains("open"), "while one with options opens again");

  // ---- 6) the ways out: a click outside, and Escape ----
  doc.fire("click", { target: node("body") });
  check(!root.classList.contains("open"), "a click elsewhere on the page closes it");
  btn.fire("click");
  doc.fire("click", { target: valueEl });
  check(root.classList.contains("open"), "a click inside does not: the press belongs to the picker");
  doc.fire("keydown", { key: "Escape" });
  check(!root.classList.contains("open"), "and Escape closes it");

  // ---- 7) the source: the widget draws two nodes, and its callers mark, never glue ----
  const body = fnBody("customSelect");
  check(/label\.textContent = opt\.text;/.test(body) && !/textContent\s*=[^;\n]*✓/.test(body),
    "the widget writes the option's NAME into the label and nothing else");
  check(/markEl\.textContent = \(o && o\.mark\) \|\| "";/.test(body),
    "the button's mark column is the selected option's mark, or empty — never absent");
  check(/if \(opt\.mark\) \{[\s\S]*?row\.appendChild\(mark\);/.test(body) &&
    /row\.appendChild\(label\);[\s\S]*?if \(opt\.mark\) \{/.test(body),
    "a row appends its label first, and a mark after it only when there is one");
  check(/btn\.appendChild\(valueEl\);[\s\S]{0,60}btn\.appendChild\(markEl\);[\s\S]{0,60}btn\.appendChild\(arrow\);/.test(body),
    "the button is assembled node by node: value, mark, arrow");
  const connOpt = /opt\.mark = "✓";/.test(fnBody("renderConnSelector")) &&
    /opt\.textContent = label;/.test(fnBody("renderConnSelector")) &&
    !/textContent\s*=[^;\n]*✓/.test(fnBody("renderConnSelector"));
  check(connOpt, "the host list names the host in the label and the ✓ as the mark");
  const profOpt = /opt\.mark = "✓"/.test(fnBody("renderLlmProfiles")) &&
    /opt\.textContent = name;/.test(fnBody("renderLlmProfiles")) &&
    !/textContent\s*=[^;\n]*✓/.test(fnBody("renderLlmProfiles"));
  check(profOpt, "and so does the profile list: neither caller glues a tick into a name");

  // ---- 8) the stylesheet: the label gives way, the mark never does, the popup grows ----
  const rule = (css, selector) => {
    const at = css.indexOf(selector + " {");
    if (at < 0) return "";
    return css.slice(at + selector.length, css.indexOf("}", at));
  };
  const rowCss = rule(CSS, ".cselect-opt");
  const labelCss = rule(CSS, ".cselect-opt-label");
  const markCss = rule(CSS, ".cselect-mark");
  const valueCss = rule(CSS, ".cselect-value");
  const popCss = rule(CSS, ".cselect-pop");
  check(/display:\s*flex/.test(rowCss) && /align-items:\s*center/.test(rowCss) && /gap:/.test(rowCss),
    "a row lays its parts out in a line, honouring no break opportunity at all");
  check(/overflow:\s*hidden/.test(labelCss) && /text-overflow:\s*ellipsis/.test(labelCss) &&
    /white-space:\s*nowrap/.test(labelCss) && /min-width:\s*0/.test(labelCss),
    "the LABEL is what truncates (…) — and a flex item only truncates with min-width: 0");
  check(/flex:\s*none/.test(markCss),
    "the mark is flex: none: it can never be the thing that shrinks, nor wrap onto a second line");
  check(/min-width:\s*0/.test(valueCss) && /text-overflow:\s*ellipsis/.test(valueCss),
    "and the closed control's value truncates the same way, next to the same mark column");
  check(/width:\s*max-content/.test(popCss) && /min-width:\s*100%/.test(popCss),
    "the popup grows to its widest option while the short case stays flush with the button");
  check(/overflow-x:\s*hidden/.test(popCss) && /max-width:\s*min\(460px,\s*80vw\)/.test(popCss),
    "and it never scrolls sideways: beyond its cap it is the label that gives way");
  check(rule(MOBILE, ".fs-conn-row .cselect") !== "" &&
    /flex:\s*1 0 100%/.test(rule(MOBILE, ".fs-conn-row .cselect")) &&
    /flex-wrap:\s*wrap/.test(rule(MOBILE, ".fs-conn-row")),
    "on the phone the picker takes a line of its own in the host row, instead of a sliver shared with two buttons");
  check(/media="\(max-width: 640px\)"/.test(HTML),
    "which is the stylesheet the page loads only under its narrow-screen media");

  summary("cselect");
}

try {
  main();
} catch (e) {
  console.error("FAIL:", (e && e.stack) || e.message || e);
  process.exit(1);
}
