"use strict";

// The history pager's WAIT, inside the control that starts it (ui/js/project.js
// loadOlder, ui/style.css's `.older-pill.busy`): device report — "load earlier
// records has a long delay; the moment after the tap looks like nothing happened,
// a progress bar or a loading animation would help".
//
// The tap has to be answered on the frame it lands. A page is ONE /api/history
// request whose budget is a megabyte and a whole turn (the server reads it off
// disk and aligns its start back to a task row), and the prepend that follows is a
// single synchronous pass over the reply — so there is no second control, no
// per-record progress and no intermediate state the pane could show on its own.
// The wait therefore lives in the pill: a ring, the number it is fetching,
// `aria-busy`, and one more message for the pass over the reply.
//
// This runner drives the REAL functions against a stub pane, a stub pill and a
// promise it resolves by hand, because the two claims that matter are both about
// ORDER — the busy state is on before the first await, off after the last .then,
// and a second tap cannot start a second page.
//
// Run: node tests/older-pill-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer } = require("./harness.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "ui", "js", "project.js"), "utf8");
const { region } = slicer(SRC);

// ---- a node with the three things the pill is written through ----
function node(tag) {
  const set = new Set();
  const n = {
    tagName: tag,
    textContent: "",
    attrs: {},
    kids: [],
    style: {},
    classList: {
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
        return on;
      },
      contains: (c) => set.has(c),
    },
    has: (c) => set.has(c),
    setAttribute: (k, v) => { n.attrs[k] = v; },
    removeAttribute: (k) => { delete n.attrs[k]; },
    // real DOM nodes MOVE when they are appended, they are not copied — the pager
    // empties the sink with `while (sink.firstChild) frag.appendChild(sink.firstChild)`,
    // which only ends on a stub that detaches the child it is handed
    appendChild: (kid) => {
      if (kid.parent) {
        const at = kid.parent.kids.indexOf(kid);
        if (at >= 0) kid.parent.kids.splice(at, 1);
      }
      kid.parent = n;
      n.kids.push(kid);
      return kid;
    },
    get firstChild() { return n.kids[0] || null; },
    querySelectorAll: () => [],
  };
  return n;
}

const pill = node("button");
const label = node("span");
const byId = { "older-pill": pill, "older-label": label };

// the pane: children in order, plus the insert the pager prepends through
const pane = {
  kids: [],
  get firstElementChild() { return pane.kids[0] || null; },
  insertBefore(frag, ref) {
    const at = ref ? pane.kids.indexOf(ref) : pane.kids.length;
    for (const kid of frag.kids) kid.parent = pane;
    pane.kids.splice(at < 0 ? 0 : at, 0, ...frag.kids);
  },
  dispatchEvent: () => {},
};

let lastDiv = null; // the sink the pager renders a page into before the prepend

// what the reply says, resolved by hand: the test has to look at the pill BETWEEN
// the tap and the answer, which is exactly the window the report is about
let pending = null;
let fetches = 0;
let renderedInto = [];

const ctx = {
  console,
  CustomEvent: class {},
  document: {
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => { const n = node(tag); if (tag === "div") lastDiv = n; return n; },
    createDocumentFragment: () => node("#fragment"),
  },
  eventsEl: pane,
  stream: { classList: { contains: () => false }, scrollTop: 0, clientTop: 0 },
  // the render pass target: the sink the pager is writing into, in the real order
  addEvent: (item) => {
    const row = {
      item,
      dataset: {},
      label: label.textContent, // the pill AS THE PANE RENDERS — the second stage
      getClientRects: () => [{ top: 0 }],
      closest: () => null,
      getBoundingClientRect: () => ({ top: 0 }),
      matches: () => false,
    };
    renderedInto.push(row);
    if (lastDiv) lastDiv.appendChild(row);
  },
  apiFetch: (url, opts) => {
    fetches++;
    return new Promise((resolve, reject) => { pending = { url, opts, resolve, reject }; });
  },
  notice: (msg) => { noticeArgs.push(msg); },
  hasMathText: () => false,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  setTimeout,
  lastTextEl: null,
  lastTextContent: "",
  thinkingEl: null,
  thinkingContent: "",
  toolGroupEl: null,
};
const noticeArgs = [];
vm.createContext(ctx);
// the slice: the pager's own state and its functions, ending at the end of loadOlder.
// `let` bindings are not properties of the context's global, so the two things this
// runner has to set up (the byte offset the pane has loaded) and to read back
// (the pager's own state) are reached through a probe the slice ends with.
vm.runInContext(
  region("let olderRemaining", "loadOlder") +
  "\nctx_probe = { setOldest: (v) => { oldestOffset = v; }," +
  " state: () => ({ paging, olderBusy, olderRemaining, oldestOffset }) };", ctx);
ctx.ctx_probe.setOldest(4096); // the tail of a project is loaded: there is a page below it

const settle = async () => {
  // let the two rAFs of nextPaint() and the promise chain drain
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function load(older, events) {
  const p = ctx.loadOlder();
  pending.resolve({ events, older });
  await p;
}

async function main() {
  // ---- 1) the offer, and its two sizes ----
  ctx.setOlderPill(3 * 1024 * 1024);
  check(!pill.has("hidden") && label.textContent === "load earlier records (3.0 MB)",
        "a page of megabytes reads as megabytes (" + label.textContent + ")");
  ctx.setOlderPill(1300);
  check(label.textContent === "load earlier records (2 KB)",
        "and a small page still rounds up to a whole KB, never to 0 (" + label.textContent + ")");

  // ---- 2) the tap is answered on the frame it lands ----
  ctx.setOlderPill(3 * 1024 * 1024);
  const first = ctx.loadOlder();
  check(fetches === 1 && pending.url.includes("/api/history?before=") &&
        pending.url.includes("align=turn") && pending.opts.timeout === 60000,
        "the tap starts ONE request, at the turn boundary, with the long timeout the page "
        + "budget needs (" + pending.url.slice(0, 46) + "…)");
  check(pill.has("busy") && pill.attrs["aria-busy"] === "true" &&
        label.textContent === "loading 3.0 MB…",
        "and the pill says so BEFORE the reply: busy, aria-busy, and the size it is fetching "
        + "(" + label.textContent + ")");
  check(pane.kids.length === 0,
        "nothing has been prepended yet — the pane is untouched while the request is out");

  // a second tap while the first page is in flight starts nothing
  ctx.loadOlder();
  check(fetches === 1, "a second tap mid-page starts no second request (" + fetches + ")");

  // a `history` frame from a reconnecting stream lands mid-page: it may restate the
  // count, but it must not take the wait's place
  ctx.setOlderPill(999);
  check(pill.has("busy") && /^loading /.test(label.textContent),
        "a history frame mid-page restates the count inside the wait, instead of putting the "
        + "offer back under the reader's finger (" + label.textContent + ")");

  // ---- 3) the reply: a second stage, then the rows ----
  lastDiv = null;
  renderedInto = [];
  pending.resolve({ events: [{ offset: 100, event: { type: "text" } }], older: 512 });
  await settle();
  await first;
  check(renderedInto.length === 1 && renderedInto[0].label === "rendering earlier records…",
        "the pass over the reply announces itself before it takes the main thread (" +
        (renderedInto[0] && renderedInto[0].label) + ")");
  check(pane.kids.length === 1 && pane.kids[0] === renderedInto[0],
        "and the page is prepended once, the row it rendered being the row in the pane");
  check(!pill.has("busy") && pill.attrs["aria-busy"] === undefined &&
        label.textContent === "load earlier records (1 KB)",
        "then the pill offers the next page again, at the count the server reported ("
        + label.textContent + ")");

  // ---- 4) the end of the history hides it, and a failure gives the pill back ----
  pending = null;
  const last = ctx.loadOlder();
  pending.resolve({ events: [{ offset: 8, event: { type: "text" } }], older: 0 });
  await last;
  check(pill.has("hidden") && !pill.has("busy"),
        "a page that exhausts the disk hides the pill — there is nothing left to load");

  ctx.setOlderPill(4096);
  noticeArgs.length = 0;
  const failing = ctx.loadOlder();
  check(pill.has("busy"), "the next tap is busy again");
  pending.reject(new Error("boom"));
  await failing;
  check(noticeArgs.length === 1 && noticeArgs[0] === "Failed to load earlier records: boom",
        "a failure is still reported through the one visible line (" + noticeArgs[0] + ")");
  check(!pill.has("busy") && pill.attrs["aria-busy"] === undefined &&
        label.textContent === "load earlier records (4 KB)",
        "and the pill goes back to offering the page instead of spinning forever ("
        + label.textContent + ")");

  // ---- 5) the waiting state is on the page, and in the sheet ----
  const html = fs.readFileSync(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
  const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  check(/<button id="older-pill"[^>]*>[\s\S]{0,400}?class="older-spinner"[\s\S]{0,200}?id="older-label"/
        .test(html),
        "the page carries the ring inside the pill, ahead of the label it spins beside");
  check(/\.older-pill\s*\{[^}]*display:\s*flex[^}]*width:\s*fit-content[^}]*margin:\s*0 auto 12px/
        .test(cssBare),
        "and the pill is a centred row of two parts (fit-content, not a full-width bar)");
  check(/\.older-pill\.busy \.older-spinner\s*\{[^}]*animation:\s*older-spin/.test(cssBare) &&
        /@keyframes older-spin\s*\{[^}]*rotate\(360deg\)/.test(cssBare),
        "a ring that turns only while the pill is busy — at rest it takes no room and no clock");
  check(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*\s*\{[^}]*animation:\s*none !important/.test(cssBare),
        "and reduced motion still switches the loop off sheet-wide: the label is what carries the "
        + "state for a reader who asked for no motion");

  summary("older-pill");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
