"use strict";

// Switching back to a tab shows the PART OF THE TRANSCRIPT that tab was showing
// when it was switched out — the same pixel, every time.
//
// The reported bug: coming back to a tab landed somewhere else than where it was
// left, at the top in one case and at the bottom in another. There were four
// separate reasons, and this runner pins each of them:
//
//   * `saveMemento` saved whatever the pane held, whoever it belonged to. Leaving
//     a tab while its LOAD CARD was up (the usual way a tab is abandoned: it was
//     still opening) saved the card's scroll — 0 — plus `high: null`, over the
//     place the reader had actually left it on. Coming back, the tab had no usable
//     memento at all: full replay, and the top of the log.
//   * `restoreMemento` read only the in-memory map. After a page or app reload
//     that map is empty and the localStorage copy is the only memento left, so
//     every tab of a restored working set silently landed on its tail.
//   * the DOM cache saved its offset AFTER moving the rows out of the pane, and
//     emptying a pane clamps scrollTop to 0: the instant path restored every tab
//     to the very top of its transcript.
//   * both open paths pinned to the tail first and restored "unless the tab's run
//     had produced records while it was away" — so a running tab always landed at
//     the end, never at the reader's place, and the latch it left behind was the
//     run's, not the reader's.
//
// Part 1 drives the REAL saveMemento/restoreMemento/mementoOf, part 2 the REAL
// saveDomCache/restoreDomCache, part 3 the REAL placeRestored with the REAL
// nearBottom, part 4 states the contracts those cannot show (who may write a
// memento, in what order the cache reads the pane, and where the open paths place
// the view).
//
// Run: node tests/tab-position-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, runnableSnippet, stateStub, installCountdown } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SLOTS = read("ui/src/renderer/slots.ts");
const PROJECT = read("ui/src/renderer/project.ts");
const { fnBody } = slicer(SLOTS);
const projectFn = (name) => slicer(PROJECT).fnBody(name);

// ---- a storage that outlives a context ----------------------------------------
//
// `localStorage` is the point of part 1: a page reload is a NEW context with the
// SAME storage, and the only place the tab's view can come from then.
function storage() {
  const items = new Map();
  return {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
    removeItem: (k) => items.delete(k),
    keys: () => Array.from(items.keys()),
    raw: items,
  };
}

// ---- a DOM, just enough of one (the rows, not their markup) -------------------
function node(tag) {
  const kids = [];
  const n = {
    nodeType: 1,
    tagName: (tag || "div").toUpperCase(),
    dataset: {},
    style: {},
    classList: new Set(),
    children: kids,
    childNodes: kids,
    parentNode: null,
  };
  Object.defineProperty(n, "firstChild", { get: () => kids[0] || null });
  n.appendChild = (child) => {
    // a node has ONE parent: appending it here takes it out of where it was
    if (child.parentNode) {
      const at = child.parentNode.childNodes.indexOf(child);
      if (at >= 0) child.parentNode.childNodes.splice(at, 1);
    }
    child.parentNode = n;
    kids.push(child);
    return child;
  };
  n.replaceChildren = (...incoming) => {
    kids.length = 0;
    for (const c of incoming) {
      if (!c) continue;
      if (c.nodeType === 11) for (const inner of c.childNodes.slice()) n.appendChild(inner);
      else n.appendChild(c);
    }
  };
  n.querySelectorAll = () => [];
  n.querySelector = () => null;
  n.matches = () => false;
  return n;
}

function fragment(kids) {
  const f = node("fragment");
  f.nodeType = 11;
  for (const kid of kids) f.childNodes.push(kid);
  return f;
}

function paneOf(rows) {
  const el = node("div");
  for (let i = 0; i < rows; i++) el.appendChild(node("div"));
  return el;
}

// The pane's scroller as a browser behaves: what it holds is the content's height,
// and an offset past the end is clamped the moment anything asks for it. This is
// the whole reason the cache's read order matters.
function scroller(eventsEl, viewport) {
  let top = 0;
  const contentH = () => eventsEl.childNodes.length * 200;
  return {
    clientHeight: viewport,
    get scrollHeight() { return contentH() + viewport; },
    get scrollTop() { return Math.max(0, Math.min(top, this.scrollHeight - viewport)); },
    set scrollTop(v) { top = Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - viewport)); },
  };
}

// ---- part 1 & 2: the real memento and cache functions -------------------------

function context(opts) {
  // a pane with a transcript in it: 10 rows of 200px, in a 400px viewport
  const eventsEl = opts.eventsEl || paneOf(10);
  const stream = opts.stream || scroller(eventsEl, 400);
  const ctx = vm.createContext({
    console, Map, JSON, Math, Number, Array, Object, String,
    document: {
      getElementById: (id) => (id === "events" ? eventsEl : id === "stream" ? stream : null),
      createDocumentFragment: () => fragment([]),
    },
    localStorage: opts.storage,
    paneShowsTab: (slotId) => opts.paneShows === undefined ? true : opts.paneShows === slotId,
    state: stateStub(),
    cancelAnimationFrame: () => {},
    requestAnimationFrame: () => 0,
  });
  const keySrc = /const MEMENTO_KEY = [^;]*;/.exec(SLOTS)[0];
  const code = [
    "var mementos = new Map();",
    keySrc,
    fnBody("readStoredMemento"),
    fnBody("saveMemento"),
    fnBody("mementoOf"),
    fnBody("forgetMemento"),
    fnBody("restoreMemento"),
    "var domCaches = new Map();",
    fnBody("hasPicture"),
    fnBody("saveDomCache"),
    fnBody("restoreDomCache"),
  ].join("\n");
  vm.runInContext(runnableSnippet(code), ctx);
  // a restored view repaints the meters it carries (countdown.ts): the real
  // module, on a page that draws none
  installCountdown(ctx);
  return { ctx, eventsEl, stream };
}

// a plain scroller for the cases that only need the numbers (no DOM involved)
const plain = (scrollHeight, clientHeight) =>
  ({ scrollTop: 0, scrollHeight, clientHeight });

function main() {
  // ---- 1a) the place is the pixel the pane stood at ----
  {
    const store = storage();
    const { ctx, stream } = context({ storage: store });
    stream.scrollTop = 1234;
    ctx.state.streamHighOffset = 4096;
    ctx.state.oldestOffset = 128;
    ctx.saveMemento("tab-a", { older: 99, workdir: "/p" });
    const m = ctx.mementoOf("tab-a");
    check(m && m.scroll === 1234 && m.high === 4096 && m.oldest === 128 && m.older === 99 && m.workdir === "/p",
      "1a) leaving a tab records the pixel it stood at, with the range the tail restore needs");
    check(!("follow" in m),
      "1a2) …and no follow flag: the memento is the PLACE, and the latch is read off the place (3a-3c)");
    check(store.raw.has("clutch_view:tab-a"),
      "1a3) the place is persisted under the tab's own key");
  }

  // ---- 1b) a pane that is NOT this tab writes nothing ----
  {
    const store = storage();
    const foreign = context({ storage: store, paneShows: "another-tab" });
    foreign.ctx.saveMemento("tab-a"); // the pane shows another tab
    check(!foreign.ctx.mementoOf("tab-a"),
      "1b) a save for a tab the pane is not showing writes nothing (there is no place to remember)");

    const mine = context({ storage: store });
    mine.ctx.state.streamHighOffset = 4096;
    mine.stream.scrollTop = 900;
    mine.ctx.saveMemento("tab-a");
    check(mine.ctx.mementoOf("tab-a").scroll === 900, "1b2) …while a save from its own pane does");

    // the abandon: the tab is left mid-load, so the pane holds a card scrolled to 0
    const card = context({ storage: store, paneShows: "nobody" });
    card.ctx.state.streamHighOffset = null; // a load clears the watermark (project.ts clearStream)
    card.ctx.saveMemento("tab-a", { older: 0, workdir: "/elsewhere" });
    const kept = card.ctx.mementoOf("tab-a");
    check(kept && kept.scroll === 900 && kept.workdir === "",
      "1b3) a tab abandoned while its load card is up keeps the place it really had — the card's 0 " +
      "never overwrites it, and neither does the card's workdir");
    check(JSON.parse(store.raw.get("clutch_view:tab-a")).scroll === 900,
      "1b4) …and the stored copy is untouched too, so a reload finds the real place");
  }

  // ---- 1c) a page reload: the map is gone, storage still has the place ----
  {
    const store = storage();
    const before = context({ storage: store });
    before.ctx.state.streamHighOffset = 4096;
    before.stream.scrollTop = 1500;
    before.ctx.saveMemento("tab-a");

    // the reload: a fresh page (empty in-memory map), same localStorage
    const after = context({ storage: store });
    const m = after.ctx.mementoOf("tab-a");
    check(m && m.scroll === 1500 && m.high === 4096,
      "1c) after a page reload the memento comes from the stored copy: the tab still knows its place");
    const landed = after.ctx.restoreMemento("tab-a");
    check(landed === 1500,
      "1c2) restoreMemento lands on that pixel and REPORTS it (the caller reads the latch off it)");
    check(after.stream.scrollTop === 1500,
      "1c3) …and the pane really is standing there");
  }

  // ---- 1d) the clamp: a log that shrank under the tab ----
  {
    const store = storage();
    const big = context({ storage: store, stream: plain(9000, 400) });
    big.ctx.state.streamHighOffset = 4096;
    big.stream.scrollTop = 8200;
    big.ctx.saveMemento("tab-a");

    // the same tab, now in a pane whose content ends at 3600
    const short = context({ storage: store, stream: plain(4000, 400) });
    const landed = short.ctx.restoreMemento("tab-a");
    check(landed === 3600 && short.stream.scrollTop === 3600,
      "1d) a place past the end of a shrunken log lands on the end, clamped here instead of by the browser");
  }

  // ---- 1e) no place at all ----
  {
    const { ctx } = context({ storage: storage() });
    check(ctx.restoreMemento("tab-a") === null,
      "1e) a tab with no memento reports null: the caller stands on the tail instead (3c)");
  }

  // ---- 2) the DOM cache: the place is read BEFORE the rows move out ----
  {
    const store = storage();
    const eventsEl = paneOf(10);
    const { ctx, stream } = context({ storage: store, eventsEl });
    stream.scrollTop = 900;
    check(stream.scrollHeight === 2400 && stream.scrollTop === 900, "2a) the pane starts mid-transcript");
    ctx.state.streamHighOffset = 4096;
    ctx.saveMemento("tab-a"); // what activateTab does first
    ctx.saveDomCache("tab-a");
    const cache = ctx.domCaches.get("tab-a");
    check(!!cache, "2b) the transcript is cached");
    check(cache.streamScrollTop === 900,
      "2c) the cached offset is the reader's 900 — read before the rows moved out, because emptying " +
      "the pane clamps scrollTop to 0 (it reads " + stream.scrollTop + " now)");
    check(stream.scrollTop === 0,
      "2d) …which is exactly what the browser did to the empty pane");

    const back = context({ storage: store, eventsEl });
    back.ctx.domCaches.set("tab-a", cache);
    check(back.ctx.restoreDomCache("tab-a") === true, "2e) the cache restores");
    check(back.stream.scrollTop === 900,
      "2f) …to the same pixel the tab was left on (not the top of its transcript)");
    check(back.ctx.mementoOf("tab-a") && back.ctx.mementoOf("tab-a").scroll === 900,
      "2g) and the memento agrees, so a cache the pane then drops still restores the same place");
  }

  // ---- 2h) a cache restored into a pane that cannot reach its pixel ----
  {
    const eventsEl = paneOf(4); // 800px of content, a 400px viewport
    const { ctx, stream } = context({ storage: storage(), eventsEl });
    ctx.domCaches.set("tab-a", { nodes: fragment(Array.from({ length: 4 }, () => node("div"))),
      streamScrollTop: 5000, stateSnapshot: {} });
    ctx.restoreDomCache("tab-a");
    check(stream.scrollTop === 800,
      "2h) an offset past what this pane can reach lands on its end (the pane grew/shrunk while away)");
  }

  // ---- 3) placeRestored: the placement, and the latch that follows it ----
  //
  // The real function, with the real nearBottom (stream-view.ts) — that pair is
  // the contract: the place decides, and the latch is read off the place.
  {
    const viewSrc = read("ui/src/renderer/stream-view.ts");
    const view = slicer(viewSrc);
    global.state = stateStub();
    global.stream = plain(4000, 400);
    global.setJumpVisible = () => {};
    // the real threshold the page uses ("near the bottom" is what re-latches)
    global.JUMP_BOTTOM_GAP = Number(/const JUMP_BOTTOM_GAP = (\d+);/.exec(viewSrc)[1]);
    (0, eval)(runnableSnippet(view.fnBody("nearBottom")));
    (0, eval)(runnableSnippet(projectFn("placeRestored")));

    let jump = null;
    global.setJumpVisible = (visible) => { jump = visible; };
    let place = 1234;
    // the place restoreMemento really performs: it LANDS the pane, then reports
    global.restoreMemento = () => {
      if (place === null) return null;
      global.stream.scrollTop = place;
      return place;
    };

    // 3a) mid-transcript: put back there, and do NOT follow
    global.stream.scrollTop = 0;
    placeRestored("tab-a");
    check(global.stream.scrollTop === 1234, "3a) the tab's own pixel is the placement — not the log's tail");
    check(global.state.followTail === false && jump === true,
      "3a2) a reader who left mid-transcript comes back unlatched, with the ↓ pill: records that " +
      "arrive after the restore must not drag the view down to them");

    // 3b) on the tail: put back there, and keep following
    place = 3600; // 4000 - 400: the end of this pane
    global.stream.scrollTop = 0;
    placeRestored("tab-a");
    check(global.stream.scrollTop === 3600 && global.state.followTail === true && jump === false,
      "3b) a reader who left on the tail comes back latched on it, with no pill");

    // 3c) no place of its own: the tail is where a fresh transcript starts
    place = null;
    global.state.followTail = false; // the tab we left was unlatched; it must not leak
    jump = true;
    global.stream.scrollTop = 0;
    placeRestored("tab-a");
    check(global.stream.scrollTop === 4000, "3c) a tab with no place stands on the tail");
    check(global.state.followTail === true && jump === false,
      "3c2) …and follows it — the previous tab's latch does not decide this one's");

    // 3d) a tab whose run produced records while it was away is NOT a reason to move
    place = 1234;
    global.stream.scrollTop = 0;
    placeRestored("tab-a");
    check(global.stream.scrollTop === 1234 && global.state.followTail === false,
      "3d) what the tab's run wrote while it was away does not move the reader: the place is still the place");
  }

  // ---- 4) source contracts ----
  {
    const save = fnBody("saveMemento");
    check(/if \(!stream \|\| !paneShowsTab\(slotId\)\) return;/.test(save),
      "4a) only the pane that is SHOWING the tab may record its place");
    check(/scroll: stream\.scrollTop,/.test(save) && !/follow:/.test(save),
      "4b) the memento holds the pixel, and no follow flag to disagree with it");

    const restore = fnBody("restoreMemento");
    check(/const m = mementoOf\(slotId\);/.test(restore) && !/mementos\.get\(slotId\)/.test(restore),
      "4c) the place is read through mementoOf, so the stored copy answers after a reload");
    check(/return stream\.scrollTop;/.test(restore) && /: number \| null \{/.test(restore),
      "4d) it reports where it landed (or null: no place), which is what the latch is read from");
    check(!/state\.followTail/.test(restore),
      "4e) …and it does not touch the latch itself: the latch belongs to the placement (project.ts placeRestored)");

    const saveCache = fnBody("saveDomCache");
    const readAt = saveCache.indexOf("stream.scrollTop");
    const moveAt = saveCache.indexOf("eventsEl.firstChild");
    check(readAt > 0 && moveAt > 0 && readAt < moveAt,
      "4f) the cache reads the scroll offset BEFORE it moves the rows out: emptying the pane clamps it to 0");

    const restoreCache = fnBody("restoreDomCache");
    check(/Math\.min\(cache\.streamScrollTop/.test(restoreCache),
      "4g) …and puts it back clamped to what the pane it lands in can reach");

    const place = projectFn("placeRestored");
    check(/const placed = restoreMemento\(tabId\);/.test(place) && /state\.followTail = nearBottom\(\);/.test(place),
      "4h) placeRestored puts the pane on the tab's place and reads the latch OFF it");

    // the two open paths place the view through that one helper, and neither gates
    // it on the tab's run any more
    const open = projectFn("openInTab");
    const activate = projectFn("activateTab");
    check(/placeRestored\(tab\.id\);/.test(open) &&
      /apply\(next\);[\s\S]{0,400}placeRestored\(tab\.id\);/.test(activate),
      "4i) a full replay and a tail restore both end by putting the tab's own place back — the " +
      "rebuilt tail after the landing, like the full replay inside its own apply: the card's end is " +
      "where the pane SETTLES (the fold of the turn a restored tail is cut in the middle of), and a " +
      "place put back before that fold is a pixel of a taller pane");
    const tail = projectFn("restoreTabView");
    check(!/placeRestored\(/.test(tail),
      "4i-b) …and the restore itself places nothing: it is done painting, not done settling");
    check(!/!tab\.running && !tab\.needsInput/.test(open) && !/!tab\.running && !tab\.needsInput/.test(tail),
      "4j) neither path asks the tab's run before placing it: a running tab comes back where its " +
      "reader left it too");
    check((PROJECT.match(/restoreMemento\(/g) || []).length === 1 &&
      (PROJECT.match(/placeRestored\(tab\.id\)/g) || []).length === 2,
      "4k) restoreMemento has exactly one caller (placeRestored) — no path can place the view behind its back");

    const cached = projectFn("paintCachedView");
    check(/if \(!restoreDomCache\(tab\.id\)\) return false;[\s\S]{0,700}state\.followTail = nearBottom\(\);/.test(cached),
      "4l) the instant path reads its latch off the pixel the cache put back, in the same task");
  }

  summary("tab-position", "a tab comes back on the part of its transcript it was left on");
}

main();
