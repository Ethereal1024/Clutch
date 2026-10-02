"use strict";

// The picker's three device reports, in one runner:
//   #1  the file list must never carry connection chatter or errors as rows — the
//       body folds when there is nothing to browse (the conn bar is the picker);
//   #2/#3 a remembered host is a PRESELECTION, not a connection: opening the
//       picker dials nothing, an empty list is DISABLED (never padded with a
//       placeholder entry that would read as a backend), and the user's own
//       Connect press is the only door.
//
// The runner drives the REAL renderConnSelector / updateConnConnect / connConnect
// against stubs, so the rule cannot be dropped from one end (what the list may
// offer) or the other (what a press may dial), and then reads the source for the
// half that is about what is NOT there any more (the auto-connect, the polling
// wait for a backend, the error rows, the local-reset row).
//
// Run: node tests/fs-picker-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource, uiModules } = require("./harness.js");

async function main() {
  const APP = uiSource(); // the renderer, every module in page load order
  const { fnBody } = slicer(APP);
  const HTML = fs.readFileSync(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  const CONN_STORE = uiModules().find((m) => m.file === "js/conn-store.js").code;
  const CONN_FLOW = uiModules().find((m) => m.file === "js/conn-flow.js").code;

  // ---- stub environment (the picker's own nodes, and nothing else) ----
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // the picker's <select>: options in, a value in, a disabled flag out
  const connSelect = {
    opts: [],
    value: "",
    disabled: false,
    set innerHTML(_v) {
      this.opts.length = 0;
      this.value = "";
    },
    appendChild(o) {
      this.opts.push(o);
    },
    textOf(v) {
      const o = this.opts.find((x) => x.value === v);
      return o ? o.textContent : null;
    },
  };
  const connStatus = { textContent: "" };
  const connectBtn = { disabled: false };
  global.connSelect = connSelect; // the eval'd bodies read the page's global scope
  global.connStatus = connStatus;
  global.$ = (sel) => ({ "#conn-select": connSelect, "#conn-connect": connectBtn })[sel];
  global.document = { createElement: () => ({}) };
  global.API_BASE = null;
  global.IS_ANDROID = true;
  global.connOnValue = "";

  // indirect eval in the global scope: the REAL bodies, as the page loads them
  for (const name of ["sshConns", "connLabel", "renderConnSelector", "updateConnConnect"]) {
    (0, eval)(fnBody(name));
  }

  const seed = (hosts, extra) => {
    store.clear();
    if (hosts) store.set("clutch_ssh_connections", JSON.stringify(hosts));
    for (const [k, v] of Object.entries(extra || {})) store.set(k, v);
    connSelect.opts.length = 0;
    connSelect.value = "";
    connSelect.disabled = false;
    connectBtn.disabled = false;
    global.connOnValue = "";
  };
  const HOSTS = [
    { host: "new.example.com", user: "me", port: "22" }, // most recent first
    { host: "old.example.com", user: "me", port: "2222" },
  ];
  const CONNECTED = {
    clutch_ssh_connected: "1",
    clutch_api_url: "http://127.0.0.1:31001",
    clutch_ssh_host: "new.example.com",
    clutch_ssh_user: "me",
    clutch_ssh_port: "22",
  };

  // ---- 1) an empty list is DISABLED, and carries no placeholder entry ----
  seed(null, {});
  renderConnSelector();
  check(connSelect.opts.length === 0,
    `no saved host = no options at all (got ${connSelect.opts.length})`);
  check(connSelect.disabled === true,
    "an empty picker is disabled instead of padded with a placeholder");
  check(!connSelect.opts.some((o) => o.value === "" || /add an SSH connection/.test(o.textContent)),
    "the '— add an SSH connection —' entry the user had to read as a backend is gone");
  check(connectBtn.disabled === true,
    "and Connect cannot press what the list cannot offer");
  check(connStatus.textContent === "Not connected — no backend",
    "the picker says what it is (nothing) instead of claiming a host");

  // ---- 2) a saved host is PRESELECTED — and that is all it is ----
  seed(HOSTS, {});
  renderConnSelector();
  check(connSelect.opts.length === 2 && connSelect.opts.every((o) => /^ssh:me@/.test(o.value)),
    "one option per saved host, and no Local entry on the phone");
  check(connSelect.value === "ssh:me@new.example.com:22",
    `the most recent host is preselected (got ${JSON.stringify(connSelect.value)})`);
  check(connSelect.disabled === false, "with something to pick, the picker is live");
  check(connectBtn.disabled === false,
    "and Connect is armed: the user asked for the door, not for a dial");
  check(store.get("clutch_ssh_connected") === undefined,
    "preselecting does not mark the host connected (nothing dialled, nothing moved)");

  // ---- 3) the backend this window is ON is not something to connect to ----
  seed(HOSTS, CONNECTED);
  renderConnSelector();
  check(connSelect.value === "ssh:me@new.example.com:22" && store.get("clutch_ssh_connected") === "1",
    "the host this window is on stays the selected one");
  check(/✓$/.test(connSelect.textOf("ssh:me@new.example.com:22") || ""),
    "and it is the one marked with the ✓");
  check(connectBtn.disabled === true,
    "Connect is for MOVING somewhere: it is not armed on where we already are");
  connSelect.value = "ssh:me@old.example.com:2222"; // the user picks another host...
  updateConnConnect();
  check(connectBtn.disabled === false, "...and choosing another host is what arms it");

  // ---- 4) the desktop keeps its own session as the thing Connect may adopt ----
  global.IS_ANDROID = false;
  seed(HOSTS, {});
  renderConnSelector();
  check(connSelect.opts[0] && connSelect.opts[0].value === "local" && connSelect.value === "local",
    "the desktop lists (and preselects) this machine's own session");
  check(connectBtn.disabled === false,
    "with no session yet, Connect is the press that asks the host for one");
  global.API_BASE = "http://127.0.0.1:31002";
  renderConnSelector();
  check(connectBtn.disabled === true,
    "once the window is on it, there is nowhere left to connect to");
  global.IS_ANDROID = true;
  global.API_BASE = null;

  // ---- 5) the door: the press is what dials, and only when it goes somewhere ----
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

  // the backend we are already on: nothing to do, and above all no tunnel bounce
  seed(HOSTS, CONNECTED);
  renderConnSelector();
  await connConnect();
  check(done.length === 0, `pressing Connect on the backend we are on does nothing (got ${done})`);

  // a host the user picked: the one door, with the fields the option carries
  seed(HOSTS, {});
  connSelect.value = "ssh:me@old.example.com:2222";
  done.length = 0;
  await connConnect();
  check(/dial:"old\.example\.com" "me" "2222"/.test(done.join("|")),
    `Connect hands the chosen host to handleSshConnect (got ${done.join(",")})`);
  check(!/refreshPicker|switchBackendResolved/.test(done.join("|")),
    "and does nothing else itself: the connect path owns what follows it");

  // switching hosts: the old tunnel goes first, and the intent before that
  seed(HOSTS, { clutch_ssh_connected: "1", clutch_degrade: "{}" });
  connSelect.value = "ssh:me@old.example.com:2222";
  done.length = 0;
  await connConnect();
  check(done[0] === "disconnect",
    `leaving one remote for another drops the tunnel first (got ${done.join(",")})`);
  check(!store.has("clutch_ssh_connected") && !store.has("clutch_degrade"),
    "the standing intent goes before the drop, so the move is not announced as a loss");

  // local, nothing standing: ask the host for this window's own session
  seed(HOSTS, {});
  connSelect.value = "local";
  done.length = 0;
  await connConnect();
  check(done.join(",") === "switchBackendResolved,refreshPicker",
    `Connect on Local adopts this machine's own session (got ${done.join(",")})`);
  check(!store.has("clutch_ssh_connected"), "without inventing a standing SSH intent");

  // ---- 6) the source: what must NOT be there any more ----
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

  // the pins: the list may only arm the door, and the door is the press
  check((CONN_STORE.match(/connSelect\.addEventListener\(/g) || []).length === 1 &&
    /connSelect\.addEventListener\("change", updateConnConnect\);/.test(CONN_STORE),
    "the list's own change listener only re-arms the button");
  check(!/connSelect\.addEventListener/.test(CONN_FLOW) &&
    /\$\("#conn-connect"\)\.addEventListener\("click", connConnect\);/.test(CONN_FLOW),
    "and the press is wired to the door, in the connect flow that owns it");
  check(/\$\("#conn-connect"\)\.disabled = !connSelect\.value \|\| connSelect\.value === connOnValue;/.test(CONN_STORE),
    "Connect is armed exactly when the choice can move this window");
  check(/connSelect\.disabled = !connSelect\.value;/.test(CONN_STORE),
    "an empty picker is disabled at the source, not padded");

  // a disabled custom picker must not open: the button is a real <button>, so only
  // the class marks it (the profile picker sets disabled and still opened)
  const select = fnBody("customSelect");
  check(/if \(root\.classList\.contains\("disabled"\)\) return;/.test(select) &&
    select.indexOf('classList.contains("disabled")') < select.indexOf('root.classList.toggle("open")'),
    "customSelect refuses to open while it is disabled");

  // the markup the whole report is about: a Connect button of its own, under the row
  check(/<button id="conn-connect" class="primary"/.test(HTML),
    "the picker has its own Connect button");
  const connBar = HTML.slice(HTML.indexOf('<div class="fs-conn">'), HTML.indexOf('<div id="fs-body">'));
  check(connBar.indexOf('id="conn-select"') < connBar.indexOf('id="conn-connect"') &&
    connBar.indexOf('id="conn-connect"') < connBar.indexOf('id="conn-status"'),
    "on its own line under the host row, and above the picker's status line");

  summary("fs-picker");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack || e.message) || e);
  process.exit(1);
});
