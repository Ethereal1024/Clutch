// The settings modal's third tab answers the first question of every bug report:
// which build was this? Three facts, and only the first one is a build's own —
// the number. It cannot be typed into the page (that is how a version page ends up
// lying after a release), and the renderer cannot ask the shell for it either: the
// page runs over file:// in Electron and inside the phone's system WebView, and no
// channel to the Kotlin shell exists. So the number lives in a STAMP, ui/version.js,
// which is a data file the page loads like any other script, and which the Android
// build rewrites with the exact versionName it hands gradle.
//
// This runner is the contract around that stamp, and it pins it in four places:
//
//   1. the number: ui/version.js, VERSION and ui/package.json (what the desktop deb
//      is built as) are ONE number — a release that bumps two of them fails here;
//   2. the page: index.html loads the stamp after app.js and before the module that
//      paints the pane, and the strip, the panes and SETTINGS_TABS agree, so a
//      fourth tab cannot be added to one of them alone;
//   3. the painting: the real aboutVersion/aboutPlatform/aboutBackend/paintAbout are
//      sliced out of ui/js/settings.js and driven with stubbed window/navigator/
//      API_BASE/document — Electron, an Android WebView, a plain desktop browser, a
//      checkout with no stamp, and a window with no session;
//   4. the build: the APK is stamped with the version it was given, and the stamp
//      step sits between the asset sync and gradle (before the sync it would be
//      copied over; after gradle it would not be in the APK at all).
//
// Run: node tests/about-version-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, uiSource, uiModules } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const UI = path.join(ROOT, "ui");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

const VERSION = read(ROOT, "VERSION").trim();
const stampSrc = read(UI, "version.js");
const html = read(UI, "index.html");
const css = read(UI, "style.css");
const syncSh = read(ROOT, "scripts", "sync-android-host.sh");
const buildSh = read(ROOT, "scripts", "build-android-apk.sh");

// one rule's declarations, with its whitespace folded away
function decls(sheet, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = sheet.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// ---- 1. the stamp, and the number it has to be ----
{
  const m = stampSrc.match(/window\.CLUTCH_VERSION\s*=\s*"([^"]*)"\s*;/);
  check(Boolean(m), "ui/version.js sets window.CLUTCH_VERSION");
  check(m && m[1] === VERSION, "and it carries VERSION's number (" + VERSION + "), which is the whole point of a stamp");

  check(
    !/^\s*(?:import|export)\b/m.test(stampSrc) && !/\brequire\s*\(/.test(stampSrc),
    "the stamp is a CLASSIC script that assigns one global — no import/export (refused over file://) and nothing to load"
  );

  const pkg = JSON.parse(read(UI, "package.json"));
  const lock = JSON.parse(read(UI, "package-lock.json"));
  check(pkg.version === VERSION, "ui/package.json — the version electron-builder puts on the deb — is the same number");
  check(
    lock.version === VERSION && lock.packages && lock.packages[""] && lock.packages[""].version === VERSION,
    "and package-lock.json agrees in both places npm reads it, so an install cannot change what the deb is called"
  );
}

// ---- 2. the page: load order, the strip, the panes ----
{
  const at = (s) => html.indexOf(s);
  check(at('<script src="version.js"></script>') > 0, "index.html loads the stamp as a script the page already runs");
  check(
    at('<script src="version.js"></script>') > at('<script src="app.js"></script>'),
    "after app.js, so app.js stays the page's first renderer script (the load-order contract tests/ui-load-order-test.js pins)"
  );
  check(
    at('<script src="version.js"></script>') < at('<script src="js/settings.js"></script>'),
    "and before the module that paints the About pane"
  );
  check(
    uiModules().some((m) => m.file === "version.js"),
    "the page's script list really carries it: the load-order runner loads every file in that list, so a script index.html drops is a file nothing loads"
  );

  // the strip and the panes come out of the two files that have to agree, not out of
  // a list kept here: SETTINGS_TABS is the switch's own idea of the tabs, and the
  // markup is what a reader sees before any script runs
  const src = uiSource();
  const tabsLit = src.match(/const SETTINGS_TABS = (\[[^\]]*\]);/);
  check(Boolean(tabsLit), "ui/js/settings.js still declares SETTINGS_TABS");
  const tabs = tabsLit ? JSON.parse(tabsLit[1]) : [];
  check(tabs.includes("about"), "and that list includes the About tab, so the switch knows to hide the other panes when it shows");
  check(tabs[0] === "llm", "the model pane is still the one the modal opens on");

  for (const t of tabs) {
    const tab = new RegExp('<button id="settings-tab-' + t + '"[^>]*role="tab"[^>]*aria-selected="(?:true|false)" aria-controls="settings-pane-' + t + '">');
    const pane = new RegExp('<div id="settings-pane-' + t + '"[^>]*role="tabpanel" aria-labelledby="settings-tab-' + t + '">');
    check(tab.test(html), 'index.html declares #settings-tab-' + t + " as a tab whose aria-controls names its own pane");
    check(pane.test(html), "and #settings-pane-" + t + " as the tabpanel that names it back");
  }

  const tabsInMarkup = [...html.matchAll(/id="settings-tab-([a-z]+)"/g)].map((m) => m[1]);
  check(
    tabsInMarkup.join() === tabs.join(),
    "the strip in the markup and SETTINGS_TABS are the same tabs in the same order (" + tabs.join(", ") + ") — a tab in only one of them is a pane nobody can reach or a click that hides everything"
  );

  const visible = [...html.matchAll(/id="settings-pane-([a-z]+)"[^>]*class="([^"]*)"/g)]
    .filter((m) => !/\bhidden\b/.test(m[2]))
    .map((m) => m[1]);
  check(visible.join() === "llm", "and exactly one pane is showing when the page loads: the model one");

  // the three rows the pane paints, inside the pane, and each of them only once
  const paneOpen = html.indexOf('id="settings-pane-about"');
  const paneEnd = html.indexOf('<div class="modal-actions">');
  const paneHtml = paneOpen >= 0 && paneEnd > paneOpen ? html.slice(paneOpen, paneEnd) : "";
  check(/<dl class="about-list">/.test(paneHtml), "the About pane is a definition list (label / value), not a form");
  for (const id of ["about-version", "about-platform", "about-backend"]) {
    check(paneHtml.includes('id="' + id + '"'), "#" + id + " is a row inside that pane");
    check(
      html.split('id="' + id + '"').length === 2,
      "...and the page has exactly one of it (paintAbout writes by id, so a second copy would silently disagree)"
    );
  }

  // the number is never spelled out where it is painted: a version typed into the
  // pane is a version that lies one release later. (Comments are not code — the
  // header explains the stamp by naming the current number.)
  const settingsSrc = (uiModules().find((m) => m.file === "js/settings.js") || { code: "" }).code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check(!/\b\d+\.\d+\.\d+\b/.test(settingsSrc), "ui/js/settings.js names no version at all — it reads the stamp on every paint");
}

// ---- 3. the painting: the real functions, one scenario each ----
const ABOUT = slicer(uiSource()).region("// ---- the About pane", "paintAbout");

const ELECTRON_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Clutch/0.1.54 Chrome/108.0.5359.215 Electron/22.3.26 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ODD_UA = "curl/8.5.0";

// a page holding just what the pane touches: the stamp on window, the user agent,
// the session's base address, and a document whose rows record what they were told
function makePane(opts) {
  const o = Object.assign({ version: VERSION, ua: ELECTRON_UA, backend: "http://127.0.0.1:8787", rows: [] }, opts);
  const written = {};
  const rows = {};
  for (const id of o.rows) {
    rows[id] = {
      set textContent(v) {
        written[id] = v;
      },
      get textContent() {
        return written[id];
      },
    };
  }
  const ctx = {
    window: { CLUTCH_VERSION: o.version },
    navigator: { userAgent: o.ua },
    API_BASE: o.backend,
    document: { getElementById: (id) => rows[id] || null },
  };
  vm.createContext(ctx);
  vm.runInContext(ABOUT, ctx);
  const call = (name) => vm.runInContext(name + "()", ctx);
  return { ctx, written, call };
}

{
  check(/function aboutVersion\(\)/.test(ABOUT) && /function paintAbout\(\)/.test(ABOUT), "the About pane's code is still where this runner slices it from");

  check(makePane({}).call("aboutVersion") === VERSION, "the pane prints the stamp, so the number on screen is the number in the build");

  check(
    makePane({ version: undefined }).call("aboutVersion") === "dev build",
    "a page with no stamp (a checkout served plainly, a file that was never shipped) says 'dev build' instead of an empty row that looks like a broken read"
  );
  check(
    makePane({ version: "   " }).call("aboutVersion") === "dev build",
    "and a blank stamp is the same answer — whitespace is not a version"
  );

  check(
    makePane({ ua: ELECTRON_UA }).call("aboutPlatform") === "Linux · Electron 22.3.26 · Chromium 108",
    "the desktop names its shell and engine: 'Linux · Electron 22.3.26 · Chromium 108'"
  );
  check(
    makePane({ ua: ANDROID_UA }).call("aboutPlatform") === "Android 13 · Android WebView · Chromium 108",
    "the phone names the system it is running in and the engine that WebView is (the same renderer, a different host) — '0.1.54' alone would not say which"
  );
  check(
    makePane({ ua: DESKTOP_UA }).call("aboutPlatform") === "Linux · browser · Chromium 120",
    "a plain desktop browser says 'browser': no shell of ours is in the path, and the pane does not pretend otherwise"
  );
  check(makePane({ ua: WINDOWS_UA }).call("aboutPlatform") === "Windows · browser", "Windows is named, and a UA with no engine version ends after the shell (no dangling separator)");
  check(makePane({ ua: MAC_UA }).call("aboutPlatform") === "macOS · browser", "macOS keeps its own name rather than 'Mac OS X'");
  check(
    makePane({ ua: ODD_UA }).call("aboutPlatform") === "unknown system · browser",
    "and a user agent it cannot read says so, which is a fact worth reporting too"
  );

  check(
    makePane({ backend: "http://127.0.0.1:8787" }).call("aboutBackend") === "http://127.0.0.1:8787",
    "the backend row is the session's own base address, so a report says what the build was talking to"
  );
  for (const gone of [null, undefined, ""]) {
    check(
      makePane({ backend: gone }).call("aboutBackend") === "not connected",
      "and with no session (" + JSON.stringify(gone) + " — before a connect, or after one ends) it says 'not connected' rather than an empty row"
    );
  }

  check(
    /\$\("#settings-tab-about"\)\.addEventListener\("click", paintAbout\)/.test(uiSource()),
    "the pane is painted on the tab's click, not only on open: a session can come or go under a modal that is already up"
  );
  check(
    /paintAbout\(\);\s*\/\/ no read, no wait/.test(uiSource()),
    "and on openSettings too, so opening the modal straight onto a stale pane is impossible"
  );
}

// ---- 4. paintAbout writes the three rows and survives a page missing one ----
{
  const p = makePane({ rows: ["about-version", "about-platform", "about-backend"], backend: "http://10.0.0.2:9000" });
  p.call("paintAbout");
  check(p.written["about-version"] === VERSION, "paintAbout writes the version row");
  check(
    p.written["about-platform"] === "Linux · Electron 22.3.26 · Chromium 108",
    "the platform row (the same text aboutPlatform returns)"
  );
  check(p.written["about-backend"] === "http://10.0.0.2:9000", "and the backend row");
  check(Object.keys(p.written).length === 3, "one row each, nothing else touched");

  const partial = makePane({ rows: ["about-version"] });
  let threw = null;
  try {
    partial.call("paintAbout");
  } catch (e) {
    threw = e;
  }
  check(!threw, "a page without all three rows still paints the ones it has: the pane is not allowed to take the modal down with it");
  check(partial.written["about-version"] === VERSION, "...which is the row a reader came for");
}

// ---- 5. the APK is stamped with the version it was built as ----
{
  check(
    /cp ui\/version\.js "\$UI_ASSETS\/"/.test(syncSh),
    "sync-android-host.sh copies the stamp into assets/ui, so a tree built by hand still ships one"
  );

  const stampLine = buildSh.match(/printf[^\n]*window\.CLUTCH_VERSION = "%s";[\s\S]{0,200}?android\/app\/src\/main\/assets\/ui\/version\.js/);
  check(Boolean(stampLine), "build-android-apk.sh rewrites assets/ui/version.js itself, with a printf of its own version");
  check(
    /\n\s*> android\/app\/src\/main\/assets\/ui\/version\.js/.test(buildSh) && /"\$VERSION"|%s/.test(buildSh),
    "into the file gradle packs, from $VERSION (the number gradle is handed as -PAPP_VERSION)"
  );

  const syncAt = buildSh.indexOf("bash scripts/sync-android-host.sh");
  const stampAt = buildSh.indexOf("android/app/src/main/assets/ui/version.js");
  const gradleAt = buildSh.indexOf(":app:assembleDebug");
  check(syncAt > 0 && stampAt > syncAt, "the stamp comes AFTER the sync, which would otherwise copy the source tree's number over it");
  check(stampAt < gradleAt, "and BEFORE gradle, which packs the assets: a stamp written afterwards would not be in the APK at all");
  check(
    /-PAPP_VERSION="\$VERSION"/.test(buildSh),
    "and it is the same $VERSION gradle puts on the APK's versionName — one number in the artifact and on screen, or a report that cannot be trusted"
  );
}

// ---- 6. the stylesheet the pane leans on ----
{
  const list = decls(css, ".about-list");
  check(/display: grid/.test(list), "the pane is laid out as a grid, so the three values share one left edge");
  check(
    /grid-template-columns: max-content minmax\(0, 1fr\)/.test(list),
    "with a label column as wide as its labels and a value column that may SHARE the space (minmax(0, …)): a long backend address must not widen the modal"
  );
  check(/min-width: 0/.test(decls(css, ".about-list dd")), "and the value cell may shrink below its content (min-width: 0), which is what makes that wrap");
  check(/font-family: var\(--font-mono\)/.test(decls(css, ".about-version")), "the number is set in the mono face: it is data to compare, not prose");
  check(
    /font-size: var\(--fs-lg\)/.test(decls(css, ".about-version")) && /color: var\(--text\)/.test(decls(css, ".about-version")),
    "and it is the largest, full-contrast line in the box — the one thing on this pane a reader came for"
  );
  check(/overflow-wrap: anywhere/.test(decls(css, ".about-mono")), "the platform and backend rows break anywhere: an address has no spaces to break at");
  for (const [name, sheet] of [["style.css", css], ["mobile.css", read(UI, "mobile.css")]]) {
    check(
      !/#settings-pane-about[^{]*\{[^}]*display:\s*none/.test(sheet),
      name + " does not hide the About pane outright (it is shown by the tab switch alone, like the other two)"
    );
  }
  check(
    !/\.about-(?:list|version|mono|note)\b/.test(read(UI, "mobile.css")),
    "and the phone sheet overrides none of it: three short rows fit a narrow box as they are, so a second copy of these rules would only be a place to drift"
  );
  for (const token of ["--fs-lg", "--fs-sm", "--fs-xs", "--font-mono", "--s2", "--s4"]) {
    check(css.includes(token + ":") || css.includes(token + " :"), "the sheet still declares " + token + ", which the pane's rules read");
  }
}

summary("about-version: the settings About pane, and the build stamp it reads");
