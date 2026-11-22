"use strict";

// The per-tab DOM cache: it must hand the pane back the SAME nodes, and it must
// take the picture of a RUNNING tab too — carrying the live pointers that make
// the picture completable — while refusing the few states no record can finish.
//
// The bug this locks down (reported against two tabs running a task each):
//   * the cache stored `#events.innerHTML` and restored it as markup. A fold in
//     this pane is not its markup — the head's click handler, the body its rows
//     are moved into (`wrap._body`), the <pre> the next reasoning delta appends to
//     (`_content`/`_drawn`) are PROPERTIES on the elements. A restored copy had
//     none of them: every fold in the tab refused a click, and the next process
//     row could not join its block (absorbInto writes through `wrap._body`, which
//     threw) so the run's rows landed OUTSIDE the "process · N steps" fold.
//   * a tab cached mid-stream came back with its thinking/text block cut off where
//     it was left (deltas are never stored, so nothing can complete it) and the
//     record that finally landed opened a SECOND block with the complete text:
//     the same answer painted twice, once truncated.
//
// ...and the bug the first version of the refusal created in their place: a tab
// whose run was merely IN FLIGHT was never cached at all, so every switch fell
// back to /api/session + /api/history — a progress bar and a re-render on every
// visit, which through a tunnel also *looked* like the background run had
// stopped. A live pane is cacheable; what it needs is for its render pointers to
// travel with its nodes (stateSnapshot) and to be normalised once it is back
// (project.ts dropOrphanLive — the teardown a reconnect performs).
//
// Part 1 drives the REAL saveDomCache/restoreDomCache/viewIsSettled against a
// minimal DOM; part 2 drives auto-fold's observer entry point; part 3 is a source
// contract, because "store the nodes, not the HTML" is a property of one line.
//
// Run: node tests/tab-dom-cache-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, runnableSnippet, stateStub } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const slots = read("ui/src/renderer/slots.ts");
const autoFold = read("ui/src/renderer/auto-fold.ts");

// ---- a DOM, just enough of one ------------------------------------------------
//
// Elements carry the four things the functions under test read: children,
// matches()/querySelector(All), dataset and inline style. The selector engine
// understands the compound shapes those functions use (`.a.b`, `tag`,
// `[data-x='1']`, and comma lists) and nothing more, on purpose: a selector the
// code adds later and this cannot read fails loudly instead of matching nothing.

function camel(attr) {
  return attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseSelector(sel) {
  const compound = { tag: null, classes: [], attrs: [] };
  let rest = sel.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    compound.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  const part = /(?:\.([\w-]+))|(?:\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]'"]*)))?\])/g;
  let m;
  while ((m = part.exec(rest))) {
    if (part.lastIndex === 0) break;
    if (m[1]) compound.classes.push(m[1]);
    else {
      const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
      compound.attrs.push([m[2], value === undefined ? null : value]);
    }
  }
  if (compound.tag && compound.classes) {
    const known = (compound.tag ? compound.tag.length : 0) + rest.length;
    if (known <= 0) throw new Error("unreadable selector: " + sel);
  }
  return compound;
}

function matchesOne(node, compound) {
  if (!node || node.nodeType !== 1) return false;
  if (compound.tag && node.tagName.toLowerCase() !== compound.tag) return false;
  for (const c of compound.classes) if (!node.classList.has(c)) return false;
  for (const [attr, value] of compound.attrs) {
    const key = camel(attr);
    const present = key in node.dataset;
    if (!present) return false;
    if (value !== null && String(node.dataset[key]) !== value) return false;
  }
  return true;
}

function container(nodeType) {
  const kids = [];
  const node = { nodeType, children: kids, childNodes: kids, parentNode: null };
  Object.defineProperty(node, "firstChild", { get: () => kids[0] || null });
  node.appendChild = (child) => {
    if (child.parentNode) {
      const at = child.parentNode.childNodes.indexOf(child);
      if (at >= 0) child.parentNode.childNodes.splice(at, 1);
    }
    child.parentNode = node;
    kids.push(child);
    return child;
  };
  node.replaceChildren = (...incoming) => {
    for (const old of kids.slice()) old.parentNode = null;
    kids.length = 0;
    for (const c of incoming) {
      if (!c) continue;
      if (c.nodeType === 11) {
        for (const inner of c.childNodes.slice()) node.appendChild(inner);
      } else node.appendChild(c);
    }
  };
  node.matches = (sel) => sel.split(",").some((s) => matchesOne(node, parseSelector(s)));
  node.querySelectorAll = (sel) => {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  };
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  return node;
}

function el(spec = {}) {
  const node = container(1);
  node.tagName = (spec.tag || "div").toUpperCase();
  node.classList = new Set(spec.classes || []);
  node.dataset = Object.assign({}, spec.dataset || {});
  node.style = {};
  node.textContent = spec.text || "";
  return node;
}

function textNode(data) {
  return { nodeType: 3, data: String(data), parentNode: null, childNodes: [] };
}

// ---- the functions, executed for real ----------------------------------------

function cacheContext(opts = {}) {
  const eventsEl = opts.eventsEl || el({ tag: "div" });
  const stream = el({ tag: "div" });
  const ctx = vm.createContext({
    console,
    Array,
    Map,
    document: {
      getElementById: (id) => (id === "events" ? eventsEl : id === "stream" ? stream : null),
      createDocumentFragment: () => container(11),
    },
    cancelAnimationFrame: () => {},
    paneShowsTab: () => (opts.showsTab === undefined ? true : !!opts.showsTab),
    state: stateStub(),
  });
  const { fnBody } = slicer(slots);
  vm.runInContext("var domCaches = new Map();", ctx);
  vm.runInContext(runnableSnippet(fnBody("viewIsSettled")), ctx);
  vm.runInContext(runnableSnippet(fnBody("saveDomCache")), ctx);
  vm.runInContext(runnableSnippet(fnBody("restoreDomCache")), ctx);
  return { ctx, eventsEl, stream };
}

function paneWith(rows, opts = {}) {
  const eventsEl = el({ tag: "div" });
  for (const row of rows) eventsEl.appendChild(row);
  if (opts.extra) for (const extra of opts.extra) eventsEl.appendChild(extra);
  return eventsEl;
}

function main() {
  // ---- 1) a settled transcript: the cache keeps the NODES, not their markup ----
  {
    // the task row, a process fold holding two rows, and the divider that closed it
    const task = el({ classes: ["event", "user"] });
    const fold = el({ classes: ["turn-fold"] });
    const body = el({});
    body.appendChild(el({ classes: ["event", "tool"] }));
    body.appendChild(el({ classes: ["event", "tool"] }));
    // what buildFold puts on the wrapper: the parts a serialiser cannot carry
    fold._body = body;
    fold._head = el({ tag: "button", classes: ["turn-fold-head"] });
    fold._head.onclick = () => {};
    fold._fold = el({ classes: ["fold", "hidden"] });
    fold.appendChild(fold._fold);
    const answer = el({ classes: ["event", "text"] });
    const divider = el({ classes: ["event", "completion"] });
    const eventsEl = paneWith([task, fold, answer, divider]);
    const { ctx } = cacheContext({ eventsEl });
    ctx.__eventsEl = eventsEl;

    ctx.state.streamHighOffset = 4096;
    ctx.state.oldestOffset = 128;
    ctx.state.followTail = false;
    ctx.state.runSettled = true;
    ctx.saveDomCache("tab-a");

    check(eventsEl.children.length === 0, "1a) saving EMPTIES the pane: the rows move into the cache instead of being copied");
    const cache = ctx.domCaches.get("tab-a");
    check(!!cache && cache.nodes.childNodes.length === 4, "1b) all four rows (task, fold, answer, divider) went into the cache");
    check(cache.nodes.childNodes[1] === fold && cache.nodes.childNodes[2] === answer,
      "1c) the cached rows are the SAME node objects — not a re-parse of their HTML");
    check(fold._body === body && typeof fold._head.onclick === "function",
      "1d) the fold still carries the body it moves rows into and a live click handler");

    // ...and restoring puts exactly those objects back
    const back = cacheContext({ eventsEl, showsTab: true });
    back.ctx.domCaches.set("tab-a", cache);
    back.ctx.state.streamHighOffset = 999;
    const ok = back.ctx.restoreDomCache("tab-a");
    check(ok === true, "1e) restoreDomCache reports success");
    check(eventsEl.children[0] === task && eventsEl.children[1] === fold && eventsEl.children[2] === answer &&
      eventsEl.children[3] === divider, "1f) the very same nodes are the pane again, in the same order");
    check(fold._body === body && typeof fold._head.onclick === "function",
      "1g) …and the restored fold can still take rows and still answers a click (the reported dead folds)");
    check(eventsEl.children[0].dataset.restored === "1" && eventsEl.children[1].dataset.restored === "1",
      "1h) every restored row is marked as restored, so the live-folding observer leaves it alone");
    check(back.ctx.state.streamHighOffset === 4096 && back.ctx.state.oldestOffset === 128 &&
      back.ctx.state.followTail === false && back.ctx.state.runSettled === true,
      "1i) …and the render state the SSE reconnect reads comes back with it");
    check(back.ctx.restoreDomCache("tab-a") === false,
      "1j) the cache is a one-shot handoff: a second restore without a save falls back to the replay instead of blanking the pane");
  }

  // ---- 2) a pane a run is still drawing into: TAKEN, with its live pointers ----
  {
    const task = el({ classes: ["event", "user"] });
    const liveFold = el({ classes: ["turn-fold"], dataset: { turnLive: "1" } });
    const partial = el({ classes: ["event", "text"] }); // the answer, mid-stream
    const eventsEl = paneWith([task, liveFold, partial]);
    const { ctx } = cacheContext({ eventsEl });
    // the render state the block is still being written through
    ctx.state.lastTextEl = partial;
    ctx.state.lastTextContent = "half an answer";
    ctx.state.textSealed = false;

    check(ctx.viewIsSettled(eventsEl) === true,
      "2a) a running transcript IS a picture — refusing it is what made every switch cost a replay and a progress bar");
    ctx.saveDomCache("tab-a");
    check(ctx.domCaches.has("tab-a"), "2b) …so it is taken");
    const cache = ctx.domCaches.get("tab-a");
    check(cache.stateSnapshot.lastTextEl === partial && cache.stateSnapshot.lastTextContent === "half an answer",
      "2c) the live text pointer travels with the nodes it names");

    // restoring puts the pointers back, so the record that owns that block can
    // finish it in place instead of opening a complete second copy under it
    const back = cacheContext({ eventsEl });
    back.ctx.domCaches.set("tab-a", cache);
    back.ctx.state.lastTextEl = null;
    back.ctx.state.lastTextContent = "";
    check(back.ctx.restoreDomCache("tab-a") === true, "2d) the running pane restores");
    check(back.ctx.state.lastTextEl === partial && back.ctx.state.lastTextContent === "half an answer" &&
      partial.dataset.restored === "1",
      "2e) …and the block on the page is the one the render state names again (no second, truncated-then-complete copy)");

    // an EMPTY pane is nothing to keep: the replay is one request
    check(ctx.viewIsSettled(el({ tag: "div" })) === false, "2f) an empty pane is not settled");

    // a call whose arguments are still streaming: half an argument list is never
    // stored, and its in-memory handle may not be this window's any more
    const streamRow = el({ classes: ["event", "tool", "stream"] });
    const streaming = paneWith([el({ classes: ["event", "user"] }), streamRow]);
    const live = cacheContext({ eventsEl: streaming });
    live.ctx.domCaches.set("tab-a", { nodes: container(11), streamScrollTop: 0, stateSnapshot: {} });
    check(live.ctx.viewIsSettled(streaming) === false, "2g) a `.stream` row (a tool call mid-arguments) is not cacheable");
    live.ctx.saveDomCache("tab-a");
    check(!live.ctx.domCaches.has("tab-a"),
      "2h) saving refuses it AND drops the older picture it had for the tab (that one would come back missing everything since)");
    check(streaming.children.length === 2, "2i) …and leaves the pane alone (nothing was moved out)");

    // the run talking about itself: a retry chip, a compaction in progress
    const chip = paneWith([el({ classes: ["event", "user"] }), el({ classes: ["event", "llm-note", "live"] }),
      el({ classes: ["event", "completion"] })]);
    check(live.ctx.viewIsSettled(chip) === false,
      "2j) a transient .live row is not cacheable — no durable record ever retires a restored one");

    // a fold caught mid-move carries the animation's inline height
    const moving = el({ classes: ["turn-fold"] });
    moving.appendChild(el({ classes: ["fold", "open"] }));
    const movingFold = moving.children[0];
    const midMove = paneWith([el({ classes: ["event", "user"] }), moving]);
    movingFold.style.height = "120px";
    check(live.ctx.viewIsSettled(midMove) === false, "2k) a fold frozen mid-animation (inline height) is not cacheable");
    movingFold.style.height = "";
    check(live.ctx.viewIsSettled(midMove) === true, "2l) …and is cacheable again once the move has landed");
  }

  // ---- 3) the pane the window is NOT showing is never cached under a tab id ----
  {
    const eventsEl = paneWith([el({ classes: ["event", "user"] }), el({ classes: ["event", "completion"] })]);
    const { ctx } = cacheContext({ eventsEl, showsTab: false });
    ctx.domCaches.set("tab-a", { nodes: container(11), streamScrollTop: 0, stateSnapshot: {} });
    ctx.saveDomCache("tab-a");
    check(!ctx.domCaches.has("tab-a") && eventsEl.children.length === 2,
      "3a) a pane that shows another tab (or a load card) is cached as nothing, and its stale entry is dropped");
  }

  // ---- 4) the live-folding observer leaves restored rows alone ----
  {
    const calls = [];
    const eventsEl = el({ tag: "div" });
    const restoreRow = el({ classes: ["event", "tool"] });
    const liveRow = el({ classes: ["event", "tool"] });
    eventsEl.appendChild(restoreRow); // a row the cache put back stands IN the pane
    eventsEl.appendChild(liveRow); // …and so does a row the run drew
    const ctx = vm.createContext({
      console, Array,
      eventsEl,
      runInFlight: () => true, // the run of the tab we just LEFT is still marked busy
      runProcessRow: () => true,
      settleRunBlocks: () => calls.push("settle"),
      openRunBlock: (node) => { calls.push(node); return { _body: { appendChild() {} } }; },
      takeIntoBlock: () => calls.push("take"),
      autoScroll: () => {},
    });
    const { fnBody } = slicer(autoFold);
    vm.runInContext(runnableSnippet(fnBody("foldLiveRow")), ctx);
    ctx.__restoreRow = restoreRow;
    ctx.__liveRow = liveRow;
    restoreRow.dataset.restored = "1";
    vm.runInContext("foldLiveRow(__restoreRow);", ctx);
    check(calls.length === 0, "4a) a restored row is not folded into the run that is still busy (it is a finished transcript)");
    check(!("restored" in restoreRow.dataset), "4b) …and the mark is spent by reading it");
    vm.runInContext("foldLiveRow(__liveRow);", ctx);
    check(calls.length === 2 && calls[0] === liveRow && calls[1] === "take",
      "4c) …while a row the run really drew in the same pane still goes into its block (the guard is the mark, not the pane)");
  }

  // ---- 5) source contract: the cache holds nodes, and asks what it is caching ----
  {
    const { fnBody } = slicer(slots);
    const save = fnBody("saveDomCache");
    const restore = fnBody("restoreDomCache");
    check(!/innerHTML/.test(save) && !/innerHTML/.test(restore),
      "5a) neither half of the cache serialises the pane any more (innerHTML was what stripped the folds)");
    check(/createDocumentFragment\(\)/.test(save) && /replaceChildren\(cache\.nodes\)/.test(restore),
      "5b) the pane's children are MOVED out and MOVED back");
    check(/viewIsSettled\(eventsEl\)/.test(save) && /domCaches\.delete\(slotId\)/.test(save),
      "5c) saving asks whether the transcript is a picture, and forgets what it had when it is not");
    check(/domCaches\.delete\(slotId\)/.test(restore),
      "5d) restoring consumes the entry, so an emptied fragment can never be painted over a populated pane");
    check(/lastTextEl: state\.lastTextEl/.test(save) && /state\.lastTextEl = s\.lastTextEl/.test(restore),
      "5e) the live pointer is part of what a tab's picture IS: snapshotted with it and put back with it");
    const project = read("ui/src/renderer/project.ts");
    check(/restoreDomCache\(tab\.id\)[^]*?dropOrphanLive\(\);/.test(project),
      "5f) a restored pane is normalised in the same task that paints it — after the nodes are back, before any frame — the same teardown a reconnect performs");
  }

  summary("tab-dom-cache", "the tab view cache moves the real nodes, and takes a running transcript too");
}

main();
