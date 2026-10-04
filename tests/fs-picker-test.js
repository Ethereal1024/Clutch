"use strict";

// The picker's device reports, in one runner:
//   #1  the file list must never carry connection chatter or errors as rows — the
//       body folds when there is nothing to browse (the conn bar is the picker);
//   #2  the phone has no "Local (this machine)" escape hatch, because there is no
//       backend behind 127.0.0.1 there to escape to;
//   #3  opening the picker dials nothing on its own: a remembered host is not a
//       connection, and a selection is not a dial;
//   #4  choosing a host in the list CONNECTS to it — one act, not two — while the
//       selection the picker LANDS on is not a choice: a list of hosts opens on its
//       first entry (most recent first, i.e. the host this device was last on) with
//       no ✓ on it, nothing dialled, and the one Connect button left — the conn
//       bar's, which exists only while the browser body is folded, in the row's own
//       form, and is disabled while an attempt is in flight — armed to spend that
//       entry. A list with nothing in it is DISABLED, Connect with it: no
//       placeholder entry dressed up as a backend, and no remembered host dialled
//       in its place — Connect's target is what the list holds, or nothing;
//   and on that bar: a connect folds the body too, so the folded Connect must not
//       come back the moment an attempt starts. It belongs to the welcome state
//       (nothing browsed, nothing in flight); while an attempt runs — and after it
//       fails — the attempt's own chrome (the progress bar; Retry/Cancel) is what
//       the bar offers, not a second Connect beside the one already running.
//       An attempt started from the new-connection popup is the popup's own (its own
//       status line, its own progress bar, its own Connect): the bar underneath takes
//       no fold and no Retry/Cancel from it, so closing the popup lands back on the
//       picker the popup was opened from, not on a bar whose Retry would paint into a
//       closed popup.
//   and the same fold means one more thing: the picker is WAITING for a listing. That
//       wait is its own fact (fsListing / setFsListing in js/conn-flow.js), because the
//       fold alone cannot tell it from the welcome bar — and between a successful
//       connect's last act and the listing it starts answering, the bar was exactly
//       that: folded, no attempt in flight, no verdict, so the folded Connect came back
//       for the whole round-trip and left when the listing landed (device report: a
//       Connect flashing at the instant a connection succeeded). The wait is opened
//       where a listing is actually asked for (loadDir, and the picker's own opening,
//       which settles the backend's URL first) and ended by its answer, by the fold
//       retiring it, or by the picker closing.
//
// The runner drives the REAL renderConnSelector / connTarget / updateConnConnect /
// connConnect — plus the two wiring statements conn-flow.js installs — against
// stubs, and drives the picker's state functions (hidePickerBody / showPickerBody /
// setFsConnecting / setFsConnectError / resetConnChrome / setFsListing) to see when that
// button is on the bar, so neither end of the rule can be dropped on its own: what the
// list may offer, what a choice dials, what the folded bar's button can press, and when
// the bar offers it at all. The listing itself is driven for real too (the real loadDir
// against a deferred apiFetch), because the interesting moment is the one BETWEEN the
// ask and the answer.
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
  // the nodes the bar/body states touch: a classList (the fold, the connect chrome,
  // and the button's own on/off) plus the progress fill the bar animates
  const cls = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    };
  };
  const fill = { style: {}, classList: { add() {}, remove() {}, contains: () => false } };
  const node = (extra) => Object.assign({ classList: cls(), querySelector: () => fill }, extra);
  const connectBtn = node({
    disabled: false,
    clicks: [],
    addEventListener(ev, fn) {
      if (ev === "click") this.clicks.push(fn);
    },
    click() {
      for (const fn of this.clicks) fn();
    },
  });
  const newConnectBtn = { disabled: false };
  const fsBody = node({});
  const fsNew = node({});
  const connActions = node({});
  const connProgress = node({});
  const connNewProgress = node({});
  // the picker's other nodes: the list loadDir draws into, and the chrome openFsBrowser
  // sets up. The list is a real (tiny) list so a listing can land in it.
  const fsList = node({
    children: [],
    appendChild(c) {
      this.children.push(c);
    },
  });
  const fsPathInput = node({ value: "" });
  const fsTitle = node({ textContent: "" });
  const fsCreate = node({});
  const fsNameInput = node({ value: "" });
  const fsUp = node({});
  const fsGo = node({});
  const fsModal = node({});
  global.connSelect = connSelect; // the eval'd bodies read the page's global scope
  global.connStatus = connStatus;
  global.$ = (sel) =>
    ({
      "#conn-select": connSelect,
      "#conn-connect": connectBtn,
      "#conn-new-connect": newConnectBtn,
      "#fs-body": fsBody,
      "#fs-new": fsNew,
      "#fs-list": fsList,
      "#fs-path-input": fsPathInput,
      "#fs-title": fsTitle,
      "#fs-create": fsCreate,
      "#fs-name-input": fsNameInput,
      "#fs-up": fsUp,
      "#fs-go": fsGo,
      "#fs-modal": fsModal,
      "#conn-actions": connActions,
      "#conn-progress": connProgress,
      "#conn-new-progress": connNewProgress,
    })[sel];
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
  // the door also spends the exit's note (js/conn-lost.js connLostExitClear) before
  // it validates: that note belongs to its own runner, and this one only needs the
  // call to exist and to stay out of the sequence it is counting
  global.connLostExitClear = () => {};
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
    global.fsListing = false;
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

  // ---- 2) the welcome page opens ON the first host, and dials nothing ----
  seed(HOSTS, {});
  renderConnSelector();
  check(connSelect.opts.length === 2,
    `the saved hosts are all listed, and nothing else (got ${connSelect.opts.length} entries)`);
  check(connSelect.opts.every((o) => /^ssh:me@/.test(o.value)),
    "one entry per saved host, no Local entry on the phone, and no placeholder entry");
  check(connSelect.value === "ssh:me@new.example.com:22",
    `the list opens on its first entry (most recent first) instead of coming up blank (got ${JSON.stringify(connSelect.value)})`);
  check(!connSelect.opts.some((o) => o.mark),
    "and no host is shown as one this window is on: nothing is connected");
  check(connSelect.disabled === false, "with hosts to pick from, the list is live");
  check(connectBtn.disabled === false && connTarget() === "ssh:me@new.example.com:22",
    `Connect is armed on the host the list landed on: it is the user's press that dials it (got ${JSON.stringify(connTarget())})`);
  check(done.length === 0 && store.get("clutch_ssh_connected") === undefined,
    "while landing there connects to nothing (nothing dialled, nothing moved)");

  // ---- 3) choosing a host in the list IS the connection ----
  global.API_BASE = "http://127.0.0.1:31001";
  seed(HOSTS, SESSION);
  renderConnSelector();
  check(connSelect.value === "ssh:me@new.example.com:22",
    `a live session shows the host this window is on (got ${JSON.stringify(connSelect.value)})`);
  check(connSelect.opts.find((o) => o.value === "ssh:me@new.example.com:22").mark === "✓",
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

  // ---- 4) a list with nothing in it offers nothing to choose, and nothing to dial ----
  seed(null, INTENT);
  renderConnSelector();
  check(connSelect.opts.length === 0 && connSelect.disabled === true,
    "a phone whose saved hosts are gone has an empty, disabled picker");
  check(connSelect.value === "",
    `and no entry stands in for a host: nothing is chosen (got ${JSON.stringify(connSelect.value)})`);
  connSelect.fire(); // a change on a list with nothing in it (it cannot happen by hand)
  await flush();
  check(done.length === 0, `and a change with nothing chosen dials nothing (got ${done.join(",")})`);
  check(connTarget() === "" && connectBtn.disabled === true,
    `Connect is off with it: a remembered host the list no longer holds is not a target (got ${JSON.stringify(connTarget())})`);

  // ---- 5) the phone's welcome page opens ON the host this device was last on ----
  seed(HOSTS, INTENT);
  renderConnSelector();
  check(connSelect.value === "ssh:me@new.example.com:22",
    `a device that was last on a host opens on it: the list's first entry is that host (got ${JSON.stringify(connSelect.value)})`);
  check(!connSelect.opts.some((o) => o.mark),
    "the standing intent is not shown as a session this window has: no ✓ before a connect");
  check(connectBtn.disabled === false && connTarget() === "ssh:me@new.example.com:22",
    `…which is what the folded bar's Connect is for: it spends that entry (got ${JSON.stringify(connTarget())})`);
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

  // ---- 8) the folded bar's door: the welcome state, never the fold alone ----
  // The state functions are driven for real, against the bar's own nodes seeded as
  // the markup has them.
  global.fsListToken = 0;
  global.fsListing = false; // the wait for a listing (a `let` in conn-flow.js, so seeded here)
  global.fsMode = "open";
  for (const name of [
    "syncConnConnect",
    "doorOf",
    "setFsListing",
    "hidePickerBody",
    "showPickerBody",
    "resetConnChrome",
    "connBarWaiting",
    "setFsConnecting",
    "setFsConnectError",
  ]) {
    (0, eval)(fnBody(name));
  }
  connActions.classList.add("hidden"); // the markup's starting point: no verdict yet
  connProgress.classList.add("hidden");
  connNewProgress.classList.add("hidden");
  connectBtn.classList.add("hidden");
  const doorOn = () => !connectBtn.classList.contains("hidden");

  check(!fsBody.classList.contains("collapsed") && !doorOn(),
    "the body is up with the button off: nothing has said the bar is the picker");
  hidePickerBody(); // openFsBrowser(): nothing is browsed before a backend answers
  check(fsBody.classList.contains("collapsed") && doorOn(),
    "the folded bar is the picker while nothing is browsed, and its Connect is the door");
  showPickerBody(); // loadDir(): a listing is in hand
  check(!fsBody.classList.contains("collapsed") && !doorOn(),
    "a listing up takes it away again: the list is the door");

  setConnBusy(true);
  setFsConnecting("new.example.com", connStatus, "bar");
  check(fsBody.classList.contains("collapsed") && !doorOn(),
    "a connect folds the body but must NOT bring the button back (the reported extra Connect)");
  check(/^Connecting to new\.example\.com/.test(connStatus.textContent) &&
    !connProgress.classList.contains("hidden"),
    "the attempt speaks through the bar's own status line and progress bar instead");
  check(connActions.classList.contains("hidden"),
    "with Retry/Cancel still out of the way while it runs");

  setFsConnectError("connection failed: nope", connStatus, "bar");
  setConnBusy(false); // handleSshConnect's finally
  check(fsBody.classList.contains("collapsed") && !doorOn(),
    "and a failure does not bring it back either: Retry is that same press");
  check(!connActions.classList.contains("hidden") && connProgress.classList.contains("hidden"),
    "the failure's own doors (Retry/Cancel) own the bar");

  resetConnChrome(); // #conn-cancel -> refreshPicker(): the attempt is over
  check(doorOn(), "cancelling clears the attempt's chrome and the folded bar's door is back");
  showPickerBody();
  check(!doorOn(), "with a listing up it leaves again");
  hidePickerBody(); // loadDir() with no backend, or one that does not answer
  check(doorOn(),
    "an unreachable backend folds the body with no attempt and nothing to pick from the list, and Connect is the door again");

  // ---- 8b) the popup door: an attempt it starts is the popup's own ----
  // The new-connection popup is a modal with its own status line, its own progress bar
  // and its own Connect, so the bar underneath is not the actor in an attempt the popup
  // started. Without that, a failure left Retry/Cancel on the folded bar behind the
  // modal, pointing at the popup's status element — and closing the popup then landed
  // on a bar with no door.
  const popupStatus = { textContent: "" };
  showPickerBody(); // the picker is browsing, so the bar's door is off
  connStatus.textContent = "the bar's own line";
  check(!doorOn() && connActions.classList.contains("hidden"),
    "nothing is in flight and no verdict is on the bar before the popup opens");
  setConnBusy(true);
  setFsConnecting("new.example.com", popupStatus, "popup");
  check(!fsBody.classList.contains("collapsed"),
    "a connect from the popup does not fold the body: nothing under the modal is browsed, and the listing in hand is this backend's own");
  check(!connNewProgress.classList.contains("hidden") && connProgress.classList.contains("hidden"),
    "the popup's own bar is the one the attempt animates");
  check(connActions.classList.contains("hidden") && !doorOn(),
    "and it takes no chrome from the bar underneath: no Retry/Cancel behind the modal, and no folded Connect for a popup it did not start");
  check(popupStatus.textContent === "Connecting to new.example.com…",
    "the attempt speaks through the popup's own status line");
  setFsConnectError("connection failed: nope", popupStatus, "popup");
  check(popupStatus.textContent === "connection failed: nope" && connNewProgress.classList.contains("hidden"),
    "a popup failure lands in the popup's own status line, with the popup's own bar retired");
  check(connStatus.textContent === "the bar's own line" && connActions.classList.contains("hidden"),
    "and the bar underneath is untouched: its own status line, and no Retry/Cancel left behind the modal");
  setConnBusy(false); // handleSshConnect's finally
  syncConnConnect(); // ...which settles the bar's door again
  check(!fsBody.classList.contains("collapsed") && !doorOn(),
    "so closing the popup lands back on the listing it was opened from");

  hidePickerBody(); // the other starting point: the welcome bar, nothing browsed
  check(doorOn(), "the welcome bar's door is up before the popup opens");
  setConnBusy(true);
  setFsConnecting("new.example.com", popupStatus, "popup");
  check(!doorOn(), "a popup attempt stands it down while the attempt is in flight");
  setFsConnectError("connection failed: nope", popupStatus, "popup");
  setConnBusy(false);
  syncConnConnect(); // handleSshConnect's finally
  check(doorOn() && connActions.classList.contains("hidden"),
    "and a failure that stays in the popup leaves it standing: closing the popup lands on the welcome bar, not on a bar with no door");

  const popupConnBody = fnBody("setFsConnecting");
  check(popupConnBody.includes('if (door === "bar") {') &&
    popupConnBody.indexOf("hidePickerBody()") > popupConnBody.indexOf('if (door === "bar")'),
    "the source says it too: folding is the bar door's branch, a popup attempt folds nothing");
  check(popupConnBody.includes('door === "popup" ? $("#conn-new-progress")'),
    "and the progress bar it animates is its own door's");
  const popupErrBody = fnBody("setFsConnectError");
  check(popupErrBody.includes('if (door === "popup") {') &&
    popupErrBody.indexOf("return;") < popupErrBody.indexOf(`classList.remove("hidden")`),
    "and a failure the popup owns returns before it reaches the bar's chrome");
  check(doorOf({ id: "conn-new-status" }) === "popup" && doorOf(connStatus) === "bar",
    "the two doors are named once, from the status element the attempt reports to");
  check(fnBody("handleSshConnect").includes('if (door === "bar") lastConn = {'),
    "the bar's Retry keeps the last attempt made from the bar: a popup attempt does not steal that press");
  check(fnBody("handleSshConnect").includes("setConnBusy(false);\n    syncConnConnect();"),
    "with the attempt's end, either door, settling the bar's door again");

  // ---- 8d) the disconnect dialog's door: a reconnect reports to the dialog ----
  // The dialog (ui/js/conn-lost.js) is the whole UI while it is up, and an attempt it
  // starts reports to its own line (#conn-lost-why) and owns its own chrome: the bar
  // and the Reconnect under it, both rendered from the attempt itself. The picker
  // underneath is neither its actor nor its chrome — Retry/Cancel there would be a
  // second door onto a second attempt behind a dialog that is still up, and the bar's
  // Retry re-uses the last attempt made FROM THE BAR (lastConn), which a reconnect is
  // not.
  const lostStatus = { textContent: "" };
  const foldedBefore = fsBody.classList.contains("collapsed");
  const doorBefore = doorOn();
  connActions.classList.add("hidden");
  connProgress.classList.add("hidden");
  setConnBusy(true);
  setFsConnecting("box.example", lostStatus, "lost");
  check(fsBody.classList.contains("collapsed") === foldedBefore && !doorOn(),
    "a reconnect folds nothing and stands the picker's own door down while it runs, like any attempt in flight");
  check(lostStatus.textContent === "",
    "and adds no second 'connecting to <host>' line: the dialog's own line says it, with the host on the line above");
  check(connProgress.classList.contains("hidden") && connNewProgress.classList.contains("hidden") &&
    connActions.classList.contains("hidden"),
    "the picker's chrome is left exactly as it was: no bar, no Retry/Cancel behind a dialog that is still up");
  setFsConnectError("connection failed: nope", lostStatus, "lost");
  setConnBusy(false);
  syncConnConnect();
  check(lostStatus.textContent === "connection failed: nope" &&
    connActions.classList.contains("hidden") && fsBody.classList.contains("collapsed") === foldedBefore &&
    doorOn() === doorBefore,
    "its failure lands in the dialog's own line, with the picker untouched and its door back where it was");

  const lostConnBody = fnBody("setFsConnecting");
  check(lostConnBody.includes('if (door === "lost") {') &&
    lostConnBody.indexOf("connBarWaiting(") > lostConnBody.indexOf('if (door === "lost") {'),
    "the source says it too: the dialog's door returns before it reaches any of the picker's chrome");
  const lostErrBody = fnBody("setFsConnectError");
  check(lostErrBody.includes('if (door === "lost") {') &&
    lostErrBody.indexOf("return;") < lostErrBody.indexOf(`classList.remove("hidden")`),
    "and a verdict the dialog owns returns before it can offer the picker's Retry/Cancel");
  check(doorOf({ id: "conn-lost-why" }) === "lost", "the dialog is a door of its own");
  check(fnBody("updateConnProgress").includes('$("#conn-lost-progress")'),
    "the stage the tunnel reports is painted into the dialog's bar like any other");
  check(APP.includes('connBarWaiting(door === "popup" ? $("#conn-new-progress")') &&
    APP.includes("connBarWaiting(connLostProgressEl)"),
    "and every door arms its bar through the one helper: a bar that never moves is nobody's to create");

  // The button is drawn in ONE place — the invariant that keeps the four reported bugs
  // from returning as a fifth: every write to its on/off class or to its disabled flag
  // lives in syncConnConnect (the render) or in updateConnConnect (the armed half that
  // render asks for). What the rule READS is asserted behaviourally, in 8 / 8b / 8c.
  const buttonWrites = APP.split("\n")
    .map((l) => l.trim())
    .filter((l) => /\$\("#conn-connect"\)\.(classList\.(?:add|remove|toggle)|disabled)/.test(l));
  check(buttonWrites.length === 2 &&
    buttonWrites.every((l) => fnBody("syncConnConnect").includes(l) || fnBody("updateConnConnect").includes(l)),
    `exactly two places write the folded bar's Connect: its render, and the armed half that render asks for (got ${buttonWrites.length})`);
  check(fnBody("syncConnConnect").includes("updateConnConnect();"),
    "so 'shown' and 'armed' are one render: the flow asks the store for the second half");
  check(/\bfsListing\b/.test(fnBody("syncConnConnect")) &&
    /\bconnBusy\b/.test(fnBody("syncConnConnect")) &&
    /conn-actions/.test(fnBody("syncConnConnect")),
    "from the three facts that make a folded bar the welcome bar: no attempt, no listing outstanding, no verdict");

  // ---- 8c) the wait for a listing: folded, but not the welcome bar ----
  // The reported ghost lives in the gap the fold alone cannot describe: a connect has
  // succeeded — its `finally` has cleared the attempt — while the listing that success
  // started has not answered yet. Folded with nothing in flight and nothing to pick,
  // the bar read as the welcome state, so the folded Connect came back for the whole
  // round-trip of that listing and left the moment it landed. So the wait is driven FOR
  // REAL here: the real loadDir, with its answer held until the assertions in between
  // have had their say. The door is sampled after every render — syncConnConnect is the
  // one place it is drawn — so a single frame of it being on cannot slip past.
  global.showHidden = false;
  global.fsPath = "";
  global.fsParent = null;
  global.fsRow = (label, kind) => ({ label, kind });
  global.openProject = () => {};
  global.closeModal = () => {};
  global.fsModal = fsModal;
  const listings = []; // the listing asks still unanswered, oldest first
  global.apiFetch = () => new Promise((resolve, reject) => listings.push({ resolve, reject }));
  (0, eval)(fnBody("loadDir"));
  (0, eval)(fnBody("closeFsBrowser"));
  const doorShots = []; // the door, sampled after every render while the gap below is open
  const realSync = global.syncConnConnect;
  global.syncConnConnect = () => {
    realSync();
    if (doorOn()) doorShots.push(connStatus.textContent);
  };
  const answer = (pending, path) =>
    pending.resolve({ path, parent: null, entries: [{ name: "proj", dir: true, path: path + "/proj" }] });

  global.API_BASE = "http://127.0.0.1:31001"; // the session switchBackendResolved settled
  hidePickerBody(); // the welcome bar the attempt is made from
  check(doorOn(), "the welcome bar's door is up before the attempt");
  setConnBusy(true);
  setFsConnecting("new.example.com", connStatus, "bar"); // the connect: it folds and takes the bar
  const listing = loadDir(""); // refreshPicker()'s own ask, made on the way to the `finally`
  const pending = listings.shift();
  doorShots.length = 0; // from here on: the attempt ends, its listing has not answered
  setConnBusy(false);
  syncConnConnect(); // handleSshConnect's `finally`
  check(fsBody.classList.contains("collapsed") && !doorOn(),
    "the attempt is over and its listing has not answered: the fold is a WAIT here, not the welcome bar");
  await flush(); // nothing in flight, nothing drawn — the bar's own chance to come back
  check(doorShots.length === 0,
    `no frame of the folded Connect comes back while the listing is on its way (saw ${doorShots.length})`);
  answer(pending, "/home/me");
  await listing;
  check(!fsBody.classList.contains("collapsed") && !doorOn(),
    "and the listing landing is what ends the wait: the body unfolds into what it answered with");

  // a listing that comes back after the picker asked for another one is not the answer it
  // is waiting on: ending the wait with it would unfold the body over a directory the
  // picker has already left
  hidePickerBody();
  const first = loadDir("");
  const firstPending = listings.shift();
  const second = loadDir("some/dir"); // the user picked a directory: this ask supersedes the first
  const secondPending = listings.shift();
  answer(firstPending, "/stale");
  await first;
  check(fsBody.classList.contains("collapsed") && !doorOn(),
    "a superseded listing's late answer does not call the newer one's wait over");
  answer(secondPending, "/some/dir");
  await second;
  check(!fsBody.classList.contains("collapsed") && !doorOn(),
    "the ask the picker is actually waiting on is the one that unfolds the body");

  // the other way a wait ends: the listing itself fails, and there is nothing to browse
  hidePickerBody();
  localStorage.removeItem("clutch_fs_last_dir"); // no remembered directory to fall back to
  const failed = loadDir("");
  const failedPending = listings.shift();
  failedPending.reject(new Error("no backend"));
  await failed; // loadDir answers for its own failure; nothing throws out of the picker
  check(fsBody.classList.contains("collapsed") && doorOn(),
    "a listing that fails folds the body and hands the bar its door back: nothing browsed, nothing in flight");

  // and closing the picker ends the wait on its own: there is no body left to unfold
  hidePickerBody();
  const leftOpen = loadDir("");
  const openPending = listings.shift();
  check(!doorOn(), "an ask while folded keeps the bar a wait, not the welcome bar");
  closeFsBrowser();
  check(doorOn() && global.fsListing === false,
    "closing the picker ends the wait: the folded bar is the picker again, with no listing still wanted");
  answer(openPending, "/late");
  await leftOpen; // a closed modal draws nothing the user sees; settling it keeps the runner clean

  // the two facts the block above cannot see: where the wait is opened, and that it can
  // never be left open (a wait that outlived its listing would take the door away for good)
  const loadBody8c = fnBody("loadDir");
  check(loadBody8c.indexOf("setFsListing(true)") > loadBody8c.indexOf("loading…") &&
    loadBody8c.indexOf("setFsListing(true)") < loadBody8c.indexOf("await apiFetch"),
    "loadDir opens the wait where it asks, not where it draws: the wait covers the round-trip");
  check(/finally \{[\s\S]*?if \(token === fsListToken\) setFsListing\(false\);/.test(loadBody8c),
    "and only the listing the picker is still waiting for may end it: a superseded one leaves it to whoever took over");
  check(/function hidePickerBody\(\) \{\s*fsListToken\+\+;\s*setFsListing\(false\);/.test(fnBody("hidePickerBody")) &&
    /function closeFsBrowser\(\) \{\s*setFsListing\(false\);/.test(fnBody("closeFsBrowser")),
    "the fold retires the wait, and so does closing the picker: the door comes back either way");

  // ---- 9) the source: what must NOT be there any more ----
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
  check(/async function connConnect\(v\) \{[\s\S]{0,400}?if \(!v \|\| v === connOnValue\) return;/.test(CONN_FLOW),
    "which validates: nowhere to dial, or dialling where the window already is, is not a dial");
  check(!/connBusy\s*=/.test(CONN_FLOW),
    "the in-flight flag has one owner (js/conn-store.js); the flow only asks it to change");
  check(/\$\("#conn-connect"\)\.disabled = connBusy \|\| !connTarget\(\);/.test(CONN_STORE) &&
    /\$\("#conn-new-connect"\)\.disabled = connBusy;/.test(CONN_STORE),
    "both Connect buttons are disabled by one function, from the same two facts");
  check(/connSelect\.disabled = IS_ANDROID && !hosts\.length;/.test(CONN_STORE),
    "an empty phone list is disabled at the source, and a list with hosts stays live");
  check(/connSelect\.value = "ssh:" \+ connLabel\(hosts\[0\]\);/.test(CONN_STORE),
    "the phone opens on its first (most recent) host: a list with hosts never comes up blank");
  check(!/Select a host/.test(CONN_STORE) && !/Select a host/.test(HTML),
    "and no placeholder entry stands in for a host: not in the list's source, not in the markup");
  check(/opt\.mark = "✓";/.test(CONN_STORE),
    "the ✓ rides the option as a MARK of its own, never glued into its label");
  check(!/clutch_ssh_connected|clutch_ssh_host/.test(fnBody("connTarget")),
    "and Connect dials what the list holds and nothing else: a remembered host the list no longer offers is not a target");

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
  check(/<button id="conn-connect" class="primary hidden"/.test(connRow),
    "off in the markup, so the flow is what turns it on");
  check(/#conn-connect:not\(\.hidden\) \{ display: inline-flex; \}/.test(CSS) &&
    !/:has\(\+ #fs-body\.collapsed\)[^{]*#conn-connect/.test(CSS),
    "and the stylesheet states its form, not its state: a fold is not the welcome page on its own");
  check(!/id="conn-connect"[^>]*\n[^<]*<\/button>\s*\n\s*<p id="conn-status"/.test(HTML) ||
    connBar.indexOf('id="conn-connect"') < connBar.indexOf('id="conn-status"'),
    "and it stays above the picker's own status line");

  summary("fs-picker");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack || e.message) || e);
  process.exit(1);
});
