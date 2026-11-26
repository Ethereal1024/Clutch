"use strict";

// The tab load card's BAR: what it is showing, and what the load reported.
//
// Two reports on a REMOTE tab, one owner (pane.ts) and two halves:
//
//   (a) "when a tab is restored the remote page's bar does not animate, it jumps
//       forward". Three causes, all fixed here:
//         * the bar painted every REPORTED number the instant it landed, and a
//           remote restore's reports are a handful of COARSE steps (the hop's
//           stages, then the tail fetch) — so every step was a jump;
//         * the tail restore reported NOTHING at all: the network was the longest
//           part of the wait and the card stood still through all of it;
//         * the bar was thrown away mid-load. A boot puts the tab's card up
//           (boot.ts) and then activates the same tab, and that activation
//           painted a SECOND, fresh card — the position the hop had just filled
//           fell back to "nothing measured" and started again from zero.
//
//   (b) "after a remote tab is restored, leaving it and coming back keeps
//       loading for a long time instead of showing the page it already had":
//       the view cache was refused for every tab that names a MACHINE, so a
//       switch back re-claimed the slot and rebuilt the transcript from the
//       network (project.ts paintCachedView). The cache is now refused only when
//       the claim still has to DIAL (slots.ts hopUpFor, synchronous by design).
//
// Part 1 drives the real easing step, part 5 the real hopUpFor; the rest are
// source contracts on the files that ship.
//
// Run: node tests/tab-load-bar-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const pane = read("ui/src/renderer/pane.ts");
const project = read("ui/src/renderer/project.ts");
const slots = read("ui/src/renderer/slots.ts");
const css = read("ui/style.css");
const boot = read("ui/src/renderer/boot.ts");
const paneFn = slicer(pane).fnBody;
const projectFn = slicer(project).fnBody;
const slotsFn = slicer(slots).fnBody;

// A rule's body out of the stylesheet (the runners' usual little helper).
function ruleBody(sel) {
  const i = css.indexOf(sel + " {");
  if (i < 0) return "";
  return css.slice(i, css.indexOf("}", i) + 1);
}

// ---- 1) the chase, driven: a coarse report is travel, not a jump --------------
{
  // the REAL constants and the REAL step function, out of the file that ships
  const consts =
    (pane.match(/const CHASE_TAU_MS = [^;]+;/) || [""])[0] +
    "\n" +
    (pane.match(/const CHASE_MIN_PCT = [^;]+;/) || [""])[0];
  const ctx = vm.createContext({ Math });
  vm.runInContext(runnableSnippet(consts + "\n" + paneFn("chasePct")), ctx);
  const chase = ctx.chasePct;
  const tau = Number((pane.match(/const CHASE_TAU_MS = ([\d.]+)/) || [])[1]);
  const floor = Number((pane.match(/const CHASE_MIN_PCT = ([\d.]+)/) || [])[1]);

  check(typeof chase === "function", "the bar's easing step exists as a pure function (pane.ts chasePct)");
  check(tau > 60 && tau < 400,
    "and its time constant is an ANIMATION, not a jump and not a lag: " + tau + "ms");
  check(floor > 0 && floor < 1,
    "with a sub-percent floor (" + floor + "%), so the last pixel of a load still arrives");

  // 40% -> 90%: the jump this used to paint in one frame
  let shown = 40;
  const frames = [];
  for (let i = 0; i < 240 && shown < 90; i++) {
    shown = chase(shown, 90, 16);
    frames.push(shown);
  }
  const monotone = frames.every((v, i) => i === 0 ? v >= 40 : v >= frames[i - 1]);
  check(frames.length >= 4,
    "a 50% step is TRAVELLED: it takes " + frames.length + " frames (~" + Math.round(frames.length * 16) + "ms), " +
    "not the single frame that was the reported jump");
  check(frames.length <= 70,
    "and it lands in about a second — an animation, not a bar that crawls behind the load");
  check(monotone && shown === 90,
    "the travel only ever moves forward and never passes the reported target (ended at " + shown + "%)");
  check(Math.max(...frames) <= 90,
    "no frame of it is past the work the load actually reported");

  // a target BEHIND the bar is the state's own answer (a new bar starts at 0):
  // never a backward animation
  check(chase(80, 40, 16) === 40, "a lower target is taken at once: one bar never travels backwards");
  // then there is nothing left to chase
  check(chase(90, 90, 16) === 90, "an unchanged target needs no travel at all");

  // a burst of per-record reports must be TRACKED, not trailed: the old CSS
  // transition is what left the fill 40 points behind its label
  check(Math.abs(chase(40, 40.4, 16) - 40.4) < 0.5,
    "a per-record increment is followed within half a percent on the next frame (bar and label stay one thing)");
  // the first frame of a large gap is a fraction of it, never all of it
  check(chase(0, 100, 16) < 40, "the first frame of a full bar's travel is a fraction of it: " + chase(0, 100, 16).toFixed(1) + "%");

  // junk in, a sane bar out
  let top = 90;
  for (let i = 0; i < 240 && top < 100; i++) top = chase(top, 150, 16);
  check(chase(Number.NaN, Number.NaN, 16) === 0 && top === 100,
    "a missing number is 0 and an over-range one travels to 100 and stops: the fill is never NaN% or 150%");
}

// ---- 2) one painter: the fill and the percent are the same number -------------
{
  const render = paneFn("renderLoad");
  const paint = paneFn("paintBar");
  check(/bar\.fill\.style\.width = whole \+ "%";[\s\S]{0,120}bar\.label\.textContent = whole \+ "%";/.test(paint),
    "the fill's width and the percent are written by ONE function, from ONE number — the percent cannot run " +
    "ahead of the bar (what a CSS width transition did under a burst of reports)");
  check(/barTarget = whole;/.test(render) && !/fill\.style\.width = whole/.test(render),
    "a render REPORTS the new target and never paints a position itself: the state is the target, the chase is " +
    "the paint");
  check(/function paintBar\(\)[\s\S]{0,200}if \(whole === barPainted\) return;/.test(paint),
    "a frame that changes nothing writes nothing (no layout per frame on a bar that has arrived)");
  check(/if \(progress\.pct === null\) \{\s*\/\/[\s\S]{0,400}?stopBar\(\);\s*fill\.classList\.add\("indeterminate"\);/.test(render),
    "an unmeasured load stops the chase and leaves the sliding sliver alone — a number there would be a lie, " +
    "and the sliver's own width would be overwritten by a painted 0%");
  check(/const fresh = !bar \|\| bar\.tabId !== state\.tabId;/.test(render) &&
        /if \(fresh\) \{\s*barShown = 0;/.test(render),
    "a DIFFERENT tab's load is a different bar and starts where a bar starts — never at the previous tab's position");
  check(/if \(!bar \|\| pane\.view !== "load"\) \{\s*bar = null;\s*return;/.test(paneFn("barFrame")) &&
        /else stopBar\(\);/.test(paneFn("render")),
    "and the loop stops with the load: no frame keeps painting a card that is gone (another tab, a panel, welcome)");
  check(/function nextFrame\([\s\S]{0,400}requestAnimationFrame[\s\S]{0,300}setTimeout/.test(pane),
    "the frames ride rAF where the shell has it (Electron, the Android WebView) and a timer where it does not");
  check(typeof pane.match(/export function chasePct/) !== "undefined",
    "the step is exported: the runner above drives the shipped arithmetic, not a copy of it");
}

// ...and no CSS width transition may come back to do the same job badly
{
  const fill = ruleBody(".open-progress-fill");
  check(!!fill && !/transition\s*:/.test(fill),
    "the fill has no CSS width transition: the motion is the pane's, so the LABEL is painted from the same " +
    "number (a transition moves the bar and leaves the percent ahead of it)");
  check(/chasePct/.test(css) && /pane\.ts/.test(fill + css.slice(0, css.indexOf(".open-progress-fill"))),
    "and the rule says where the motion went, so nobody re-adds the transition that caused the split");
}

// ---- 2b) the bar, DRIVEN: one card, coarse reports, a fill that travels -------
//
// pane.ts imports nothing, so the whole module runs here against a fake DOM and a
// fake frame clock. This is the half a source contract cannot reach: that
// renderLoad really hands the reported number to the chase, and that what the
// fill paints (and the percent beside it) travels between coarse reports.
{
  const frames = new Map();
  let seq = 0;
  function el(attrs) {
    const classes = new Set();
    return {
      attrs: attrs || {},
      style: {},
      textContent: "",
      dataset: {},
      scrollTop: 0,
      scrollHeight: 0,
      children: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; want ? classes.add(c) : classes.delete(c); },
      },
      getAttribute(k) { return this.attrs[k]; },
      querySelector(sel) { return this.children[sel] || null; },
    };
  }
  const els = {};
  for (const id of ["stream", "tab-load-title", "tab-load-where", "open-progress", "open-progress-note"]) els[id] = el();
  const fill = el();
  const label = el();
  els["open-progress"].children[".open-progress-fill"] = fill;
  els["open-progress"].children[".open-progress-label"] = label;
  const views = [el({ "data-view": "load" }), el({ "data-view": "tab" })];

  const ctx = vm.createContext({
    console,
    Math,
    Number,
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: (sel) => (sel === "[data-view]" ? views : []),
    },
    requestAnimationFrame: (cb) => { frames.set(++seq, cb); return seq; },
    cancelAnimationFrame: (id) => { frames.delete(id); },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(runnableSnippet(pane), ctx);

  // one card, ONE bar: the boot's beginPaneLoad and the activation's are the same
  // tab, so the position is the card's, not each call's
  vm.runInContext("setPane(paneLoad('tab-fix', 'fix-train', 'on far'))", ctx);
  vm.runInContext("reportHopStage(10, 'Connecting…')", ctx);
  vm.runInContext("reportHopStage(90, 'Starting tunnel…')", ctx);
  vm.runInContext("paneHopSettled(true)", ctx);

  // ...then the restore reports what it is doing, as it does it
  const painted = [];
  let now = 0;
  const tick = (n) => {
    for (let i = 0; i < n; i++) {
      const first = frames.entries().next();
      if (first.done) return false;
      const [id, cb] = first.value;
      frames.delete(id);
      now += 16;
      cb(now);
      painted.push(fill.style.width + "|" + label.textContent);
    }
    return true;
  };
  tick(6);
  check(painted.length && painted.every((p) => /^\d+%\|/.test(p)),
    "the fill and the percent are both painted from the load (a driven frame writes both): " + painted.slice(-1));
  check(painted.every((p) => { const [w, l] = p.split("|"); return w === l; }),
    "and they are ALWAYS the same number — the label never runs ahead of the bar");
  const early = painted.map((p) => parseInt(p, 10));
  check(early.length >= 4 && early.every((v, i) => i === 0 || v >= early[i - 1]),
    "a coarse report (the hop's last stage, 36%) is TRAVELLED over the frames after it: " + early.join(" "));
  check(early[early.length - 1] < 36,
    "and the first frames are still short of it — the bar moved, it did not jump (" + early[early.length - 1] + "% of 36%)");

  // the replay continues the same bar, from the same state
  for (let i = 1; i <= 10; i++) {
    vm.runInContext("paneReplayProgress('render', " + i / 10 + ")", ctx);
    tick(3);
  }
  const late = painted.map((p) => parseInt(p, 10));
  check(late.every((v, i) => i === 0 || v >= late[i - 1]),
    "and it never travels backwards through the replay either: " + late[late.length - 1] + "% at the end");
  check(late[late.length - 1] > early[early.length - 1],
    "the replay's own reports push the same bar past where the hop left it");

  // the load ends: the loop stops with it
  const before = frames.size;
  vm.runInContext("setPane(paneTab('tab-fix'))", ctx);
  check(frames.size === 0,
    "the card going is the end of the bar: no frame is left queued to paint a load that is over (" + before + " -> " + frames.size + ")");
  check(els["stream"].dataset.pane === "tab" && !els["stream"].classList.contains("loading"),
    "and the pane's own state says the transcript is on screen, not a load");
  // a card for another tab starts a bar at zero
  vm.runInContext("setPane(paneLoad('tab-two', 'other'))", ctx);
  vm.runInContext("reportHopStage(90, 'Starting tunnel…')", ctx);
  tick(1);
  check(parseInt(fill.style.width, 10) < 20,
    "a different tab's load is a different bar and starts at its bottom (" + fill.style.width + "), not at the last tab's position");
}

// ---- 3) the tail restore reports the work it is actually doing ----------------
{
  const restore = projectFn("restoreTabView");
  check(/const span = Math\.max\(1, cursor - target\);/.test(restore) && /const from = cursor;/.test(restore),
    "the restore measures its own range: the bytes between the newest painted record and the oldest one");
  check(/paneReplayProgress\("parse", Math\.min\(1, \(from - cursor\) \/ span\)\);/.test(restore),
    "the FETCH moves the bar by bytes that arrived — on a remote tab this is the whole wait, and it used to " +
    "report nothing at all");
  check(/const total = pages\.reduce\(\(n, p\) => n \+ p\.length, 0\);/.test(restore) &&
        /paneReplayProgress\("render", \+\+painted \/ total\);/.test(restore),
    "the paint moves it by records actually painted, the same phase the full replay uses");
  check(/if \(painted % 25 === 0\) \{\s*await new Promise\(\(r\) => setTimeout\(r, 0\)\);\s*if \(isStale\(seq\)\) return true;/.test(restore),
    "and the paint yields every 25 records (checking the generation after each yield): a synchronous loop over " +
    "a megabyte is ONE frame at the end of it — a bar that moves exactly once");
  check(/paneReplayProgress\("typeset", 1\);/.test(restore),
    "the restore closes the bar at the same phase the full replay does: no path ends a load with its bar short");
}

// ---- 4) one load, one card: a boot's card is the activation's card ------------
{
  const begin = projectFn("beginPaneLoad");
  check(/const now = currentPane\(\);/.test(begin) && /if \(id && now\.view === "load" && now\.tabId === id\) \{/.test(begin),
    "beginPaneLoad keeps the card that already names this tab: the boot (boot.ts) puts one up and the activation " +
    "of the SAME tab used to replace it");
  check(/setPane\(\{ \.\.\.now, label, where \}\);[\s\S]{0,80}return;/.test(begin) && /apply\(paneLoad\(id, label, where\)\);/.test(begin),
    "only its words are refreshed — no fresh card, no bar back at 'nothing measured' — and a DIFFERENT tab still " +
    "gets its own card");
  check(boot.indexOf("beginPaneLoad(bootTab)") > 0 && boot.indexOf("beginPaneLoad(bootTab)") < boot.indexOf("claimTab(bootTab)"),
    "and that is the order the boot makes: the card goes up before the claim that reports into it");
}

// ---- 5) a cached remote tab is instant when nothing has to be dialled ---------
{
  // the REAL hopUpFor and the real machine helpers it reads
  const src = ["asMachine", "sameMachine", "rememberedMachine", "hopUpFor"].map(slotsFn).join("\n");
  function world(store) {
    const mem = new Map(Object.entries(store || {}));
    const ctx = vm.createContext({
      console,
      localStorage: {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
      },
    });
    vm.runInContext(runnableSnippet(src), ctx);
    return ctx;
  }
  const FAR = { host: "124.220.181.209", user: "fanshu", port: "6001" };
  const OTHER = { host: "10.0.0.9", user: "fanshu", port: 22 };
  const up = world({
    clutch_ssh_connected: "1",
    clutch_ssh_connections: JSON.stringify([FAR]),
  });
  const tab = (over) => Object.assign({ id: "t1", path: "/w/a.clc", machine: FAR, base: "http://127.0.0.1:44521" }, over);

  const answer = up.hopUpFor(tab());
  check(answer === true,
    "a remote tab that was claimed in this life while the window is on its machine needs NO dial — it is the " +
    "instant path, exactly like a local tab");
  check(typeof answer === "boolean" && !/await |Promise/.test(slotsFn("hopUpFor")),
    "and the answer is SYNCHRONOUS: the cached view is painted before anything is awaited, so this question " +
    "cannot be asked of the host");

  check(up.hopUpFor(tab({ machine: null })) === true,
    "a tab that names no machine never dials: nothing to wait for");
  check(up.hopUpFor(tab({ base: null })) === false,
    "a remote tab with no base from this life keeps the card: its claim may have to dial, and that attempt " +
    "belongs in the card");
  check(world({ clutch_ssh_connections: JSON.stringify([FAR]) }).hopUpFor(tab()) === false,
    "no standing connection (a Disconnect, or a move to another host) means the claim may dial again: the card stays");
  check(world({ clutch_ssh_connected: "1", clutch_ssh_connections: JSON.stringify([OTHER]) }).hopUpFor(tab()) === false,
    "and a window on ANOTHER machine cannot promise this tab's hop: it would have to be re-dialled, so the card stays");
  check(!/async/.test(slotsFn("hopUpFor")),
    "hopUpFor itself is not async — a promise here would silently make the cache gate always-true");

  // and the gate is what project.ts asks, before the cache is read
  const paint = projectFn("paintCachedView");
  check(/if \(tab\.machine && !hopUpFor\(tab\)\) return false;/.test(paint),
    "paintCachedView refuses the cache for a machine tab only while its hop is down");
  check(paint.indexOf("hopUpFor(tab)") < paint.indexOf("restoreDomCache(tab.id)"),
    "and it asks BEFORE restoring: the cache is DOM-only, so the whole decision happens before the first await");
  check(/if \(cached\) \{\s*finishOpen\(projectOf\(tab\)\);\s*return paneTab\(tab\.id\);/.test(projectFn("activateTab")),
    "a cached remote switch then only re-binds its stream — it does not rebuild the transcript from the network, " +
    "and it re-binds it to the log the tab names (the scope belongs to the stream, not to whoever opened before)");
}

summary("tab-load-bar-test.js");
