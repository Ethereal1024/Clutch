// A stored record the UI cannot parse must be REPORTED, not quietly read as an
// empty one.
//
// localStorage is the renderer's own source of truth for the saved LLM profiles,
// the saved SSH hosts, the recent-project list and the tab working set. Every
// reader of those records has the same two failure modes to keep apart:
//
//   a record that is ABSENT is a real empty value — a machine nobody has
//   configured yet — and says nothing to the user;
//
//   a record that EXISTS but does not parse is a fact about stored bytes. Answering
//   "nothing here" for it is how the next save wrote a one-entry record over the
//   only copy the user had (the reported "my saved hosts are all gone" shape), and
//   nothing on screen ever said so.
//
// The rule these runners pin down (settings.ts corruptRecord): one report per
// record per page life, the bytes copied aside as `<key>.corrupt`, and no write
// to the record itself — the value each reader hands back is empty, exactly as the
// honest "these bytes are readable by nobody" answer, but the user has been told
// and their data is not the price.
//
// The REAL readers are driven here — sliced out of the page's own modules, in one
// vm context, against a stub localStorage and a stub #notice — so this is not a
// re-implementation of the rule: it is the rule.
//
// Run: node tests/corrupt-record-test.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, runnableSnippet } = require("./harness.js");

const RENDERER = path.join(__dirname, "..", "ui", "src", "renderer");
const src = (name) => fs.readFileSync(path.join(RENDERER, name + ".ts"), "utf8");

const Profiles = slicer(src("settings"));
const Conns = slicer(src("conn-store"));
const Recent = slicer(src("titlebar"));
const Tabs = slicer(src("tab-bar"));
const Slots = slicer(src("slots"));
const Boot = slicer(src("boot"));

// the pieces the readers are built on, each from its own module
const REGIONS = [
  // notice() — the only line the renderer can say a thing on — plus the report
  // itself and the once-per-page-life ledger
  Profiles.region("// one self-dismissing line at the bottom", "corruptRecord"),
  // the LLM profile store
  Profiles.region("const PROFILES_KEY", "llmProfiles"),
  // the saved SSH hosts
  Conns.region("export const CONNS_KEY", "sshConns"),
  // the recent-project list
  Recent.region("const RECENT_KEY", "recentList"),
  // the tab working set (saveTabs rides along: loadTabs calls asMachine)
  Tabs.region("const LS_KEY", "loadTabs"),
  // what a tab's recorded machine reads as, from slots.ts
  Slots.fnBody("asMachine"),
  // the legacy flat LLM config boot mirrors to ~/.clutch/settings.json
  Boot.fnBody("storedLlmConfig"),
];

// ---- a page: one context is one page life (the report ledger is module level) ----
function makePage(seed) {
  const map = new Map(Object.entries(seed || {}));
  const writes = [];
  const notices = [];

  const storage = {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      writes.push([k, String(v)]);
      map.set(k, String(v));
    },
    removeItem(k) {
      writes.push([k, null]);
      map.delete(k);
    },
  };

  // #notice: the one element the renderer reports on (ui/index.html)
  const noticeEl = { textContent: "", className: "hidden" };
  Object.defineProperty(noticeEl, "textContent", {
    get: () => "",
    set: (v) => {
      notices.push(String(v));
      noticeEl.shown = String(v);
    },
  });
  noticeEl.classList = {
    add() {},
    remove() {},
    toggle() {},
    contains: (c) => String(noticeEl.className).split(" ").includes(c),
  };

  const ctx = {
    localStorage: storage,
    document: { getElementById: (id) => (id === "notice" ? noticeEl : null) },
    // the notice self-dismisses on a timer; a test has no page to repaint
    setTimeout: () => 0,
    clearTimeout: () => {},
    state: { tabs: [], activeTabId: null },
  };
  vm.createContext(ctx);
  for (const code of REGIONS) vm.runInContext(runnableSnippet(code), ctx);

  return {
    ctx,
    storage,
    notices,
    run: (expr) => vm.runInContext(expr, ctx),
    get: (k) => (map.has(k) ? map.get(k) : null),
    writesFor: (k) => writes.filter((w) => w[0] === k),
  };
}

const KEY_PROFILES = "clutch_llm_profiles";
const KEY_CONNS = "clutch_ssh_connections";
const KEY_RECENT = "clutch_recent";
const KEY_TABS = "clutch_tabs";
const KEY_LEGACY_LLM = "clutch_llm";

// the readers, by record: [label, expression, key, what "empty" is]
const READERS = [
  ["saved LLM profiles", "llmProfiles()", KEY_PROFILES, {}],
  ["saved SSH hosts", "sshConns()", KEY_CONNS, []],
  ["recent-project list", "recentList()", KEY_RECENT, []],
  ["remembered tabs", "loadTabs(), state.tabs", KEY_TABS, []],
  ["saved LLM endpoint (legacy clutch_llm)", "storedLlmConfig()", KEY_LEGACY_LLM, null],
];

// ---- 1. the modules still own these readers ----
{
  const p = makePage();
  for (const [label, expr] of READERS) {
    const ok = (() => {
      try {
        p.run(expr);
        return true;
      } catch (e) {
        return false;
      }
    })();
    check(ok, "ui/src/renderer still has the reader for the " + label);
  }
  check(typeof p.run("corruptRecord") === "function", "and the one report every reader uses (settings.ts corruptRecord)");
}

// ---- 2. ABSENT is empty, and silent ----
//
// A machine nobody configured yet must not open with a warning on it. This is the
// half that keeps the report worth reading.
for (const [label, expr, key, emptyVal] of READERS) {
  const p = makePage();
  const v = p.run(expr);
  check(
    JSON.stringify(v ?? null) === JSON.stringify(emptyVal),
    "no stored " + label + " reads as the empty value (" + JSON.stringify(v ?? null) + ")",
  );
  check(p.notices.length === 0, "…and says nothing (" + p.notices.join(" | ") + ")");
  check(p.writesFor(key).length === 0, "…and writes nothing over it");
}

// ---- 3. VALID data still reads back, untouched ----
{
  const p = makePage({
    [KEY_PROFILES]: JSON.stringify({ fast: { base_url: "https://a.example", model: "m" } }),
    [KEY_CONNS]: JSON.stringify([{ host: "h.example", user: "u", port: "22" }]),
    [KEY_RECENT]: JSON.stringify([{ path: "/p/one", name: "one" }]),
    [KEY_TABS]: JSON.stringify({ tabs: [{ id: "t1", path: "/p/one", name: "one" }], activeTabId: "t1" }),
    [KEY_LEGACY_LLM]: JSON.stringify({ base_url: "https://legacy.example", model: "lm" }),
  });
  check(p.run('llmProfiles()["fast"].model') === "m", "a valid profile map reads back");
  check(p.run("sshConns()[0].host") === "h.example", "a valid host list reads back");
  check(p.run("recentList()[0].path") === "/p/one", "a valid recent list reads back");
  check(p.run("loadTabs(), state.tabs[0].id") === "t1", "a valid tab store reads back");
  check(p.run("storedLlmConfig().model") === "lm", "a valid legacy LLM record reads back");
  check(p.notices.length === 0, "reading healthy records says nothing (" + p.notices.join(" | ") + ")");
  for (const [, , key] of READERS) {
    check(p.writesFor(key).length === 0, "…and rewrites nothing (" + key + ")");
  }
}

// ---- 4. CORRUPT is reported, kept, and not written over ----
//
// One case per record, each with the bytes that make it corrupt (two of them parse
// and are still not what this build writes — the shape check is part of the
// reader).
const CORRUPT = [
  [KEY_PROFILES, "{not json"],
  [KEY_CONNS, '{"host":"h"}'],
  [KEY_RECENT, '{"path":"/p"}'],
  [KEY_TABS, "not json at all"],
  [KEY_LEGACY_LLM, "{not json"],
];

// a record that PARSES and is still not the shape this build writes (the readers
// validate shape the same way, so `[]` for a profile map is corruption and not an
// empty store) — one more, reported like the parse failures above
const WRONG_SHAPE = [
  [KEY_PROFILES, {}, '[{"base_url":"https://a"}]'], // a list where a map belongs
  [KEY_LEGACY_LLM, null, "[1,2,3]"], // an array is not a flat endpoint record
];

let reported = 0;
for (const [label, expr, key, emptyVal] of READERS) {
  const bytes = (CORRUPT.find(([k]) => k === key) || [])[1];
  const p = makePage({ [key]: bytes });
  const v = p.run(expr);
  check(
    JSON.stringify(v ?? null) === JSON.stringify(emptyVal),
    "a corrupt " + label + " reads as the empty value, not as garbage (" + JSON.stringify(v ?? null) + ")",
  );
  check(p.notices.length === 1, "…and it is REPORTED once (" + p.notices.join(" | ") + ")");
  if (p.notices.length === 1) {
    reported++;
    check(/could not be read/.test(p.notices[0]), "…in words that say what failed: " + p.notices[0]);
    check(
      p.notices[0].includes('"' + key + '.corrupt"'),
      "…and where its bytes went (" + key + ".corrupt)",
    );
  }
  check(p.get(key + ".corrupt") === bytes, "…the bytes are copied aside, verbatim");
  check(p.writesFor(key).length === 0, "…and the record itself was NOT written over (" + key + ")");
}
check(reported === READERS.length, "every record's corrupt case produced its report (" + reported + "/" + READERS.length + ")");

// ---- 4b. parsing is not the whole test: a record of the WRONG SHAPE is corrupt
// too ----
//
// `[]` where a map of profiles belongs, or a bare array where the flat endpoint
// record belongs, parses cleanly and then reads as "nothing saved" — the same
// silent empty answer, one step later. The shape check is part of the reader.
for (const [key, emptyVal, bytes] of WRONG_SHAPE) {
  const reader = READERS.find(([, , k]) => k === key);
  const p = makePage({ [key]: bytes });
  const v = p.run(reader[1]);
  check(
    JSON.stringify(v ?? null) === JSON.stringify(emptyVal),
    "a wrong-shaped " + reader[0] + " (" + bytes + ") reads as the empty value",
  );
  check(p.notices.length === 1, "…and is reported (" + p.notices.length + ")");
  check(p.get(key + ".corrupt") === bytes, "…with its bytes kept aside");
}

// ---- 5. reported once per record per page life, however often it is read ----
//
// The readers run on repaints (the picker redraws the host list, the tab strip
// redraws itself), so a report per call would be a stream of them. A page life
// that read the same broken record twice must have said it once.
{
  const p = makePage({ [KEY_CONNS]: "{not json", [KEY_PROFILES]: "[]" });
  p.run("sshConns()");
  p.run("sshConns()");
  p.run("sshConns()");
  check(p.notices.length === 1, "three reads of one broken record are one report (" + p.notices.length + ")");
  check(p.get(KEY_CONNS + ".corrupt") === "{not json", "…and the bytes are still kept aside");

  // a DIFFERENT record still gets its own report on the same page
  p.run("llmProfiles()");
  check(p.notices.length === 2, "a second broken record is reported on its own (" + p.notices.length + ")");
  check(/saved LLM profiles/.test(p.notices[1]), "…naming the record it is about: " + p.notices[1]);

  // and a SECOND page life asks again: the ledger is per page, not per install
  const q = makePage({ [KEY_CONNS]: "{not json" });
  q.run("sshConns()");
  check(q.notices.length === 1, "the next launch reports the same broken record again (" + q.notices.length + ")");
}

// ---- 6. a store the user can still fix is left where they can fix it ----
//
// Nothing in the corrupt path removes or edits the record: the copy aside is an
// ADDITION. The user's own hand-edited bytes survive until they overwrite them.
{
  const p = makePage({ [KEY_RECENT]: '{ "path": "/p/one", }' });
  p.run("recentList()");
  check(p.get(KEY_RECENT) === '{ "path": "/p/one", }', "the corrupt record is still in place after the report");
  check(p.get(KEY_RECENT + ".corrupt") === '{ "path": "/p/one", }', "and its bytes are also kept aside");
}

summary("corrupt-record");
