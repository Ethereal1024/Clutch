"use strict";

// The picker's device reports, in one runner:
//   #1  the file list must never carry connection chatter or errors as rows — the
//       body folds when there is nothing to browse (the conn bar is the picker);
//   #2  the phone has no "Local (this machine)" escape hatch, because there is no
//       backend behind 127.0.0.1 there to escape to;
//   #3  opening the picker dials nothing on its own: a remembered host is not a
//       connection, and no host is dressed up as the answer the picker landed on;
//   #4  choosing a host in the list CONNECTS to it — one act, not two — the welcome
//       page preselects no remote host at all (entering the app must not put the
//       user into a connection they did not ask for), and the one Connect button
//       left, the conn bar's, exists only while the browser body is folded, in the
//       row's own form, and is disabled while an attempt is in flight.
//
// The runner drives the REAL renderConnSelector / connTarget / updateConnConnect /
// connConnect — plus the two wiring statements conn-flow.js installs — against
// stubs, so neither end of the rule can be dropped on its own: what the list may
// offer, what a choice dials, and what the folded bar's button can press.
//
// Run: node tests/fs-picker-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource, uiModules } = require("./harness.js");

async function main() {
  const APP = uiSource(); // the renderer, every module in page load order
  const { fnBody } = slicer(APP);
  const HTML = fs.readFileSync(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  const CSS = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8");
  const CONN_STORE = uiModules().find((m) => m.file === "js/conn-store.js").code;
  const CONN_FLOW = uiModules().find((m) => m.file === "js/conn-flow.js").code;

  // ---- stub environment (the picker's own nodes, and nothing else) ----
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // the picker's <select>: options in, a value in, a disabled flag out, and the
  // change listener the page installs on it
  const connSelect = {
    opts: [],
    value: "",
    disabled: false,
    listeners: [],
    set innerHTML(_v) {
      this.opts.length = 0;
      this.value = "";
    },
    appendChild(o) {
      this.opts.push(o);
    },
    addEventListener(ev, fn) {
      if (ev === "change") this.listeners.push(fn);
    },
    textOf(v) {
      const o = this.opts.find((x) => x.value === v);
      return o ? o.textContent : null;
    },
    fire() {
      for (const fn of this.listeners) fn();
    },
  };
  const connStatus = { textContent: "" };
  const connectBtn = {
    disabled: false,
    clicks: [],
    addEventListener(ev, fn) {
      if (ev === "click") this.clicks.push(fn);
    },
    click() {
      for (const fn of this.clicks) fn();
    },
  };
  const newConnectBtn = { disabled: false };
  global.connSelect = connSelect; // the eval'd bodies read the page's global scope
  global.connStatus = connStatus;
  global.$ = (sel) =>
    ({ "#conn-select": connSelect, "#conn-connect": connectBtn, "#conn-new-connect": newConnectBtn })[sel];
  global.document = { createElement: () => ({}) };
  global.API_BASE = null;
  global.IS_ANDROID = true;
  global.connOnValue = "";
  global.connBusy = false;

  // indirect eval in the global scope: the REAL bodies, as the page loads them
  for (const name of [
    "sshConns",
    "connLabel",
    "connTarget",
    "renderConnSelector",
    "updateConnConnect",
    "setConnBusy",
  ]) {
    (0, eval)(fnBody(name));
  }

  const done = [];
  global.window = { clutchTunnel: { disconnect: async () => done.push("disconnect") } };
  global.handleSshConnect = async (host, user, port) => {
    done.push(`dial:"${host}" "${user}" "${port}"`);
    return true;
  };
  global.switchBackendResolved = async () => {
    done.push("switchBackendResolved");
    return true;
  };
  global.resetBackendLocal = async () => done.push("resetBackendLocal");
  global.refreshPicker = () => done.push("refreshPicker");
  (0, eval)(fnBody("connConnect"));

  // the REAL wiring from conn-flow.js: the list's change listener and the folded
  // bar's click listener, exactly as the page installs them
  const wireAt = CONN_FLOW.indexOf('connSelect.addEventListener("change"');
  const doorAt = CONN_FLOW.indexOf('$("#conn-connect").addEventListener("click"');
  (0, eval)(CONN_FLOW.slice(wireAt, CONN_FLOW.indexOf("));", doorAt) + 3));
  check(connSelect.listeners.length === 1,
    `the list carries exactly one change listener (got ${connSelect.listeners.length})`);
  check(connectBtn.clicks.length === 1,
    `and the folded bar's Connect exactly one click listener (got ${connectBtn.clicks.length})`);

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const seed = (hosts, extra) => {
    store.clear();
    if (hosts) store.set("clutch_ssh_connections", JSON.stringify(hosts));
    for (const [k, v] of Object.entries(extra || {})) store.set(k, v);
    connSelect.opts.length = 0;
    connSelect.value = "";
    connSelect.disabled = false;
    connectBtn.disabled = false;
    newConnectBtn.disabled = false;
    global.connOnValue = "";
    global.connBusy = false;
    done.length = 0;
  };
  const HOSTS = [
    { host: "new.example.com", user: "me", port: "22" }, // most recent first
    { host: "old.example.com", user: "me", port: "2222" },
  ];
  // what a device that was on a host remembers across a restart: the standing
  // intent (no session yet — that is what clutches API_BASE)
  const INTENT = {
    clutch_ssh_connected: "1",
    clutch_ssh_host: "new.example.com",
    clutch_ssh_user: "me",
    clutch_ssh_port: "22",
  };
  const SESSION = { ...INTENT, clutch_api_url: "http://127.0.0.1:31001" };

  // ---- 1) an empty list is DISABLED, and carries no placeholder entry ----
  seed(null, {});
  renderConnSelector();
  check(connSelect.opts.length === 0,
    `no saved host = no options at all (got ${connSelect.opts.length})`);
  check(connSelect.disabled === true,
    "a phone picker with nothing to pick from is disabled, not padded with a fake backend");
  check(connectBtn.disabled === true,
    "and Connect cannot press what the list cannot offer");
  check(connStatus.textContent === "Not connected — no backend",
    "the picker says what it is (nothing) instead of claiming a host");

  // ---- 2) the welcome page chooses NO host, and says so ----
  seed(HOSTS, {});
  renderConnSelector();
  check(connSelect.opts.length === 3,
    `the saved hosts are all listed (got ${connSelect.opts.length} entries)`);
  check(connSelect.opts.every((o) => o.value === "" || /^ssh:me@/.test(o.value)),
    "one entry per saved host, and no Local entry on the phone");
  check(connSelect.value === "" && connSelect.opts[0].value === "",
    `nothing is preselected: entering the app must not land on a host (got ${JSON.stringify(connSelect.value)})`);
  check(connSelect.textOf("") === "Select a host…",
    `the list says what its empty choice means (got ${JSON.stringify(connSelect.textOf(""))})`);
  check(!connSelect.opts.some((o) => /✓/.test(o.textContent || "")),
    "and no host is shown as the one this window is on");
  check(connSelect.disabled === false, "with hosts to pick from, the list is live");
  check(connectBtn.disabled === true,
    "Connect is disabled while there is nothing to dial: no session, no host last on");
  check(store.get("clutch_ssh_connected") === undefined,
    "opening the picker connects to nothing (nothing dialled, nothing moved)");

  // ---- 3) choosing a host in the list IS the connection ----
  global.API_BASE = "http://127.0.0.1:31001";
  seed(HOSTS, SESSION);
  renderConnSelector();
  check(connSelect.value === "ssh:me@new.example.com:22",
    `a live session shows the host this window is on (got ${JSON.stringify(connSelect.value)})`);
  check(/✓$/.test(connSelect.textOf("ssh:me@new.example.com:22") || ""),
    "and it is the one marked with the ✓");
  check(connectBtn.disabled === true,
    "Connect is not armed on where the window already is: there is nowhere to move to");
  connSelect.value = "ssh:me@old.example.com:2222"; // the user picks another host...
  connSelect.fire(); // ...and that choice is the dial, with no second press
  await flush();
  check(/dial:"old\.example\.com" "me" "2222"/.test(done.join("|")),
    `choosing a host connects to it, in one act (got ${done.join(",")})`);
  check(!/refreshPicker|switchBackendResolved/.test(done.join("|")),
    "and does nothing else itself: the connect path owns what follows it");
  check(done[0] === "disconnect",
    `leaving one remote for another drops the tunnel first (got ${done.join(",")})`);
  check(!store.has("clutch_ssh_connected") && !store.has("clutch_degrade"),
    "the standing intent goes before the drop, so the move is not announced as a loss");
  global.API_BASE = null;

  // ---- 4) the "nothing chosen" entry is not a host ----
  seed(HOSTS, INTENT);
  renderConnSelector();
  connSelect.value = "";
  connSelect.fire();
  await flush();
  check(done.length === 0, `choosing "Select a host…" dials nothing (got ${done.join(",")})`);

  // ---- 5) the phone's welcome page: no host chosen, the last host one press away ----
  seed(HOSTS, INTENT);
  renderConnSelector();
  check(connSelect.value === "",
    `a device that was last on a host still chooses nothing on the welcome page (got ${JSON.stringify(connSelect.value)})`);
  check(!connSelect.opts.some((o) => /✓/.test(o.textContent || "")),
    "the standing intent is not shown as a session this window has");
  check(connectBtn.disabled === false,
    "…which is what the folded bar's Connect is for: it spends the standing intent");
  check(connTarget() === "ssh:me@new.example.com:22",
    `Connect's target is the host this device was last on (got ${JSON.stringify(connTarget())})`);
  await connectBtn.click();
  await flush();
  check(/dial:"new\.example\.com" "me" "22"/.test(done.join("|")),
    `pressing it dials that host (got ${done.join(",")})`);
  check(!store.has("clutch_ssh_connected"),
    "with the intent cleared before the dial, so the move is not announced as a loss");

  // ---- 6) the desktop keeps its own session as the thing Connect may adopt ----
  global.IS_ANDROID = false;
  seed(HOSTS, {});
  renderConnSelector();
  check(connSelect.opts[0] && connSelect.opts[0].value === "local" && connSelect.value === "local",
    "the desktop lists (and preselects) this machine's own session");
  check(connectBtn.disabled === false,
    "with no session yet, Connect is the press that asks the host for one");
  await connectBtn.click();
  await flush();
  check(done.join(",") === "switchBackendResolved,refreshPicker",
    `Connect on Local adopts this machine's own session (got ${done.join(",")})`);
  check(!store.has("clutch_ssh_connected"), "without inventing a standing SSH intent");
  global.API_BASE = "http://127.0.0.1:31002";
  renderConnSelector();
  check(connectBtn.disabled === true,
    "once the window is on it, there is nowhere left to connect to");
  done.length = 0;
  await connectBtn.click();
  await flush();
  check(done.length === 0, `and the press does nothing at all (got ${done.join(",")})`);
  global.IS_ANDROID = true;
  global.API_BASE = null;

  // ---- 7) a connect in flight cannot be taken twice ----
  seed(HOSTS, INTENT);
  renderConnSelector();
  check(connectBtn.disabled === false, "the folded bar's Connect is armed before the attempt");
  setConnBusy(true);
  check(connectBtn.disabled === true,
    "an attempt in flight disables it: a second connect cannot be started");
  check(newConnectBtn.disabled === true,
    "and the new-connection popup's Connect says the same thing");
  setConnBusy(false);
  check(connectBtn.disabled === false && newConnectBtn.disabled === false,
    "when the attempt is over both are back");
  check(/setConnBusy\(true\);/.test(fnBody("handleSshConnect")) &&
    /finally \{\s*setConnBusy\(false\);/.test(fnBody("handleSshConnect")),
    "the one place that runs an attempt is what flags it, and clears it either way");

  // ---- 8) the source: what must NOT be there any more ----
  check(!/autoReconnectAndroid/.test(APP),
    "nothing dials a remembered host on its own any more (boot, picker and lifecycle alike)");
  check(!/waitBackend/.test(APP),
    "and the picker no longer polls for a backend: the listing follows the one announced");

  const loadBody = fnBody("loadDir");
  check(loadBody.includes("hidePickerBody()") && loadBody.includes("showPickerBody()"),
    "loadDir owns the body: it unfolds only with a listing in hand, and folds without one");
  check(!/connecting to backend|backend did not come up|Reset to local backend/.test(loadBody),
    "no connection chatter, no 'did not come up', and no second local-backend door in the list");
  check(!/fsRow\(\s*"Cannot reach backend/.test(loadBody),
    "the unreachable-backend message is not a directory row either");
  check(/connStatus\.textContent\s*=/.test(loadBody),
    "it goes on the conn bar, where the picker's own state belongs");
  check(/if \(!API_BASE\) \{[\s\S]*?hidePickerBody\(\);/.test(loadBody),
    "with no session the body is folded before anything is drawn in the list");
  check(/const token = \+\+fsListToken;/.test(loadBody) && /if \(token !== fsListToken\) return;/.test(loadBody),
    "and a listing that comes back late cannot unfold the body over a newer intent");
  check(/function hidePickerBody\(\) \{[\s\S]*?fsListToken\+\+;/.test(fnBody("hidePickerBody")),
    "folding is what retires a listing still in flight");
  check(/openFsBrowser\(mode\) \{[\s\S]*?hidePickerBody\(\);/.test(fnBody("openFsBrowser")),
    "the picker opens folded: nothing is browsed before a backend answers");
  check(!/showPickerBody\(\)/.test(fnBody("refreshPicker")),
    "and no other path unfolds it: the picker resets its connect chrome and the listing decides");
  check(/resetConnChrome\(\)/.test(fnBody("showPickerBody")) &&
    /resetConnChrome\(\)/.test(fnBody("refreshPicker")) &&
    /\$\("#conn-progress"\)\.classList\.add\("hidden"\)/.test(fnBody("resetConnChrome")),
    "while the chrome of a finished attempt (progress, Retry/Cancel) is still cleared");

  // ---- 9) the pins: the list chooses and dials, the folded bar presses ----
  check(!/connSelect\.addEventListener/.test(CONN_STORE),
    "the store that draws the list registers no listener of its own: the dial lives in the flow");
  check(/connSelect\.addEventListener\("change", \(\) => \{[\s\S]*?connConnect\(connSelect\.value\);/.test(CONN_FLOW),
    "the list's change listener hands the choice straight to the door");
  check(/\$\("#conn-connect"\)\.addEventListener\("click", \(\) => connConnect\(connTarget\(\)\)\);/.test(CONN_FLOW),
    "and the folded bar's button presses the same door with the target it can dial");
  check(/async function connConnect\(v\) \{\s*if \(!v \|\| v === connOnValue\) return;/.test(CONN_FLOW),
    "which validates: nowhere to dial, or dialling where the window already is, is not a dial");
  check(!/connBusy\s*=/.test(CONN_FLOW),
    "the in-flight flag has one owner (js/conn-store.js); the flow only asks it to change");
  check(/\$\("#conn-connect"\)\.disabled = connBusy \|\| !connTarget\(\);/.test(CONN_STORE) &&
    /\$\("#conn-new-connect"\)\.disabled = connBusy;/.test(CONN_STORE),
    "both Connect buttons are disabled by one function, from the same two facts");
  check(/connSelect\.disabled = IS_ANDROID && !hosts\.length;/.test(CONN_STORE),
    "an empty phone list is disabled at the source, and a list with hosts stays live");
  check(!/connSelect\.value = "ssh:" \+ connLabel\(saved\[0\]\)/.test(CONN_STORE),
    "the phone's most recent host is no longer preselected: the welcome page chooses nothing");

  // a disabled custom picker must not open: the button is a real <button>, so only
  // the class marks it (the profile picker sets disabled and still opened)
  const select = fnBody("customSelect");
  check(/if \(root\.classList\.contains\("disabled"\)\) return;/.test(select) &&
    select.indexOf('classList.contains("disabled")') < select.indexOf('root.classList.toggle("open")'),
    "customSelect refuses to open while it is disabled");

  // ---- 10) the markup and the CSS the report is about ----
  const connBar = HTML.slice(HTML.indexOf('<div class="fs-conn">'), HTML.indexOf('<div id="fs-body">'));
  const rowEnd = connBar.search(/\n {8}<\/div>/); // the host row closes at the row's own indent
  const connRow = connBar.slice(connBar.indexOf('<div class="fs-conn-row">'), rowEnd);
  check(rowEnd > 0 && connRow.includes('id="conn-select"') && connRow.includes('id="conn-new"') &&
    connRow.includes('id="conn-connect"'),
    "the picker's Connect is a button of the host row, next to ＋ New SSH connection");
  check(!/width: 100%/.test(connBar) && !/#conn-connect[^{]*\{[^}]*width:/.test(CSS),
    "and it no longer spans the window: the same box as the row's other button");
  check(/#conn-connect \{ display: none; \}/.test(CSS) &&
    /\.fs-conn:has\(\+ #fs-body\.collapsed\) #conn-connect \{ display: inline-flex; \}/.test(CSS),
    "it exists only while the file-browser body is folded, and not while a listing is up");
  check(!/id="conn-connect"[^>]*\n[^<]*<\/button>\s*\n\s*<p id="conn-status"/.test(HTML) ||
    connBar.indexOf('id="conn-connect"') < connBar.indexOf('id="conn-status"'),
    "and it stays above the picker's own status line");

  summary("fs-picker");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack || e.message) || e);
  process.exit(1);
});
