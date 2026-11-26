"use strict";

// Startup tab restore: a page that reloads comes back to the tab it was looking
// at, not to the welcome overlay.
//
// The root cause this runner locks down: tab-bar.ts restores the strip and paints
// it at module init, but the boot sequence used to return early whenever cached
// tabs existed — no tab was ever activated, no session was claimed, and #welcome
// (`position: fixed; inset: 0`) kept covering the strip that was already there.
// The fix is two halves: persist/restore the ACTIVE tab id, and have boot.ts claim
// and open that one tab (all the others stay lazy, unclaimed, until clicked).
//
// Part 1 and 2 drive the REAL saveTabs/loadTabs/tabActivate against stubs — the
// persistence is data, so it can be exercised for real. Part 3 is a source
// contract on boot.ts, whose async IIFE imports the whole page and cannot be run
// in a node context.
//
// Run: node tests/tab-restore-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary, slicer, runnableSnippet, stateStub } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const tabBar = read("ui/src/renderer/tab-bar.ts");
const boot = read("ui/src/renderer/boot.ts");
const project = read("ui/src/renderer/project.ts");
const slots = read("ui/src/renderer/slots.ts");
const { region, fnBody } = slicer(tabBar);
const projectFn = slicer(project).fnBody;
const slotsFn = slicer(slots).fnBody;

const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {

// ---- 1) the store carries the remembered tab, and restores only a real one ----

// one localStorage as the page has it: a string map
function storage() {
  const mem = new Map();
  return {
    mem,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

function persistence() {
  const ctx = vm.createContext({ console, state: stateStub(), localStorage: storage() });
  // the real pair, sliced out of the module (LS_KEY included: it is their key).
  // loadTabs validates the stored machine with asMachine (slots.ts): the real
  // function, so the check is about the code that ships, not a stand-in.
  vm.runInContext(runnableSnippet(slotsFn("asMachine")), ctx);
  vm.runInContext(runnableSnippet(region("const LS_KEY", "loadTabs")), ctx);
  return ctx;
}

const stored = (ctx) => JSON.parse(ctx.localStorage.getItem("clutch_tabs"));

// the strip the scenario starts from: two tabs, the second one the one on screen
function twoTabs(ctx) {
  ctx.state.tabs = [
    { id: "t1", path: "/w/a", name: "a", dirty: false, base: "http://127.0.0.1:1", running: true },
    { id: "t2", path: "/w/b", name: "b", dirty: true, base: null, running: false },
  ];
  ctx.state.activeTabId = "t2";
}

{
  const ctx = persistence();
  twoTabs(ctx);
  ctx.saveTabs();
  const data = stored(ctx);
  check(data && data.activeTabId === "t2",
    "closing the loop on the strip's own save: the remembered tab id is in the store (" +
    JSON.stringify(data && data.activeTabId) + ")");
  check(Array.isArray(data.tabs) && data.tabs.length === 2 &&
        data.tabs.every((t) => !("base" in t) && !("running" in t)),
    "and the tabs stay what they were — the working set, with no page-life session URL in it");
}

{
  const ctx = persistence();
  twoTabs(ctx);
  ctx.saveTabs();
  // a fresh page: nothing in memory, the store is all it has
  ctx.state.tabs = [];
  ctx.state.activeTabId = null;
  ctx.loadTabs();
  check(ctx.state.tabs.length === 2, "a reload puts the strip back");
  check(ctx.state.activeTabId === "t2",
    "and the tab the last page was looking at is the tab this one will open");
  check(ctx.state.tabs.every((t) => t.base === null && t.running === false),
    "the restored tabs carry no session: nothing has been claimed yet");
}

{
  const ctx = persistence();
  twoTabs(ctx);
  ctx.saveTabs();
  // the remembered slot is gone (host restarted, project deleted, tab closed in
  // another window): the store names a tab the strip does not have
  ctx.localStorage.setItem("clutch_tabs",
    JSON.stringify({ tabs: stored(ctx).tabs, activeTabId: "gone" }));
  ctx.state.tabs = [];
  ctx.state.activeTabId = "t1"; // a stale in-memory id must not survive either
  ctx.loadTabs();
  check(ctx.state.activeTabId === null,
    "an id no restored tab carries names nothing: boot falls back to the welcome page");
}

{
  const ctx = persistence();
  // a store written by the previous build: tabs, no activeTabId
  ctx.localStorage.setItem("clutch_tabs", JSON.stringify({
    tabs: [{ id: "t9", path: "/w/z", name: "z", dirty: false }],
  }));
  ctx.loadTabs();
  check(ctx.state.tabs.length === 1 && ctx.state.activeTabId === null,
    "an older store still restores its tabs, and claims no tab it never remembered");
}

// ---- 1b) the machine travels with the tab ------------------------------------
//
// Reported bug: after a quit and a relaunch, a tab whose session ran on a remote
// execution endpoint could not be opened — "not a .clc project file". The tab
// store carried a path and nothing else, the host's slot table is memory, so the
// restored tab claimed a LOCAL session for a file that machine does not have.
// The machine is now part of the working set, with three distinct answers.
{
  const ctx = persistence();
  ctx.state.tabs = [
    { id: "t1", path: "/w/a", name: "a", dirty: false, machine: null },
    { id: "t2", path: "/w/r", name: "r", dirty: false, machine: { host: "h", user: "u", port: "6001" } },
    { id: "t3", path: "/w/old", name: "old", dirty: false }, // never recorded
  ];
  ctx.state.activeTabId = "t2";
  ctx.saveTabs();
  const data = stored(ctx);
  check(JSON.stringify(data.tabs[1].machine) === JSON.stringify({ host: "h", user: "u", port: "6001" }),
    "which machine a tab's file lives on is saved with it (" +
    JSON.stringify(data.tabs[1].machine) + ")");
  check("machine" in data.tabs[0] && data.tabs[0].machine === null,
    "this machine is a recorded answer (null), not an absent one");
  check(!("machine" in data.tabs[2]),
    "a tab that never learned its machine stores no claim about one");

  ctx.state.tabs = [];
  ctx.state.activeTabId = null;
  ctx.loadTabs();
  const [a, r, old] = ctx.state.tabs;
  check(r.machine && r.machine.host === "h" && r.machine.user === "u" && String(r.machine.port) === "6001",
    "a reload reads the machine back, so the claim can serve it before anything opens");
  check(a.machine === null,
    "and the tab that lives here still says so (that is what pins its claim local)");
  check(old.machine === undefined,
    "while a tab from a store written before the field stays UNKNOWN — the open self-heals it, " +
    "it is not silently declared local");
}

{
  const ctx = persistence();
  // a hostile/hand-edited store: the machine must never be a half-object or a
  // string that would compare equal to nothing
  ctx.localStorage.setItem("clutch_tabs", JSON.stringify({
    tabs: [
      { id: "t4", path: "/w/d", name: "d", dirty: false, machine: { host: "h" } },
      { id: "t5", path: "/w/e", name: "e", dirty: false, machine: "local" },
    ],
  }));
  ctx.loadTabs();
  check(ctx.state.tabs[0].machine.host === "h" && String(ctx.state.tabs[0].machine.port) === "22",
    "a machine with no port is the default SSH port, not an undefined one");
  check(ctx.state.tabs[1].machine === undefined,
    "a value that is not a machine is UNKNOWN, never a guess about where the file is");
}

// ---- 2) activating a tab is what the next reload remembers -------------------
{
  const order = [];
  const ctx = vm.createContext({
    console,
    state: stateStub(),
    noteMru: (id) => order.push("mru:" + id),
    activateTab: async (tab) => {
      order.push("activate:" + tab.id);
      await tick(); // the real activation is async: a claim, then a replay
      ctx.state.activeTabId = tab.id;
    },
    saveTabs: () => order.push("save:" + ctx.state.activeTabId),
  });
  ctx.state.tabs = [{ id: "t1" }, { id: "t2" }];
  ctx.state.activeTabId = "t1";
  vm.runInContext(runnableSnippet(fnBody("tabActivate")), ctx);

  ctx.tabActivate("t2");
  await tick();
  check(order.join() === "mru:t2,activate:t2,save:t2",
    "a tab click saves AFTER its activation lands, so the store names the tab on screen (" +
    order.join(" → ") + ")");

  order.length = 0;
  await ctx.tabActivate("nope");
  check(order.length === 0,
    "and an id that is not in the strip writes nothing: a phantom tab never reaches the store");
}

// ---- 3) boot.ts opens the remembered tab instead of stopping at the overlay ---
{
  const restoredAt = boot.indexOf("if (restoredTabs) {");
  const nonRestoredAt = boot.indexOf("const url = await reconciledBackendUrl();");
  const branch = restoredAt >= 0 && nonRestoredAt > restoredAt
    ? boot.slice(restoredAt, nonRestoredAt)
    : "";

  check(/const restoredTabs = state\.tabs\.length > 0 && !connLostExitPending\(\);/.test(boot),
    "the conn-lost exit note still refuses a restore: that boot belongs to the welcome page");
  check(/import \{[^}]*\bclaimTab\b[^}]*\} from "\.\/slots";/.test(boot) &&
        /import \{[^}]*\bshowWelcome\b[^}]*\} from "\.\/project";/.test(boot) &&
        /import \{ tabActivate \} from "\.\/tab-bar";/.test(boot),
    "boot names the claim, the base, the overlay and the activation it uses (module, not global scope)");
  check(/const bootTab = restoredTabs[\s\S]{0,120}state\.tabs\.find\(\(t\) => t\.id === state\.activeTabId\) \|\| state\.tabs\[0\]/.test(boot),
    "the tab it reopens is the remembered one (or the first, when the store named none)");
  check(!/if \(restoredTabs\) return;/.test(boot),
    "the restored branch no longer returns before a tab is activated — that early return is the bug");

  const claimAt = boot.indexOf("const base = await claimTab(bootTab);");
  const adoptAt = boot.indexOf("adoptBase(base)");
  const defaultsAt = boot.indexOf("await loadHostDefaults();");
  const activateAt = boot.indexOf("await tabActivate(bootTab.id);");
  check(claimAt > -1 && adoptAt > claimAt &&
        /if \(bootTab\) \{[\s\S]{0,900}const base = await claimTab\(bootTab\);/.test(boot),
    "it claims that tab's OWN slot (one session, and it is the one somebody is looking at)");
  check(defaultsAt > adoptAt && defaultsAt < activateAt,
    "the host's ui defaults are fetched on that tab's base, before the rows are drawn");
  check(claimAt < defaultsAt && activateAt > defaultsAt,
    "and only then is the tab opened — claim, defaults, activation, in that order");
  check(/if \(!bootTab \|\| !state\.apiBase\) \{[\s\S]{0,320}showWelcome\(\);/.test(branch),
    "no session for the remembered tab: the welcome page is the honest view");
  check(/await tabActivate\(bootTab\.id\);[\s\S]{0,400}if \(!state\.apiBase\) \{[\s\S]{0,220}showWelcome\(\);/.test(branch),
    "and a session that died between the claim and the replay lands there too, not on an empty pane");
  check(/state\.activeTabId = null;[\s\S]{0,160}clutch:tab-state/.test(branch),
    "the fallback drops the highlight too: the strip must not point at a tab nothing is showing");

  check(/if \(!restoredTabs\) \{[\s\S]{0,520}await resolveApiBase\(\);/.test(boot) &&
        /const url = await reconciledBackendUrl\(\);/.test(boot) &&
        /connectSSE\(""\);/.test(boot),
    "the boot that has no tabs is untouched: resolve the window's session, read the session's own resident window, resume");
  check(/if \(!restoredTabs\) \{[\s\S]{0,300}state\.activeTabId = null;/.test(boot),
    "and it drops the remembered highlight there: the conn-lost Cancel boot opens no tab, " +
    "so no tab may look open");

  // The welcome page is a VIEW of the pane, and the tab's transcript is another:
  // both success paths of project.ts land on the tab's own state (apply(paneTab)),
  // which is what takes the welcome view down. There is no call to remember.
  check(/apply\(paneTab\(tab\.id\)\);/.test(projectFn("openInTab")) &&
        /return paneTab\(tab\.id\)/.test(projectFn("activateTab")),
    "activation itself lands on the tab's transcript: the welcome view goes with the state that replaces it");

  // ...and it must be REPLACED before the hop, not after it. The hop a restored
  // remote tab needs is reported into the tab's own loading card, which the welcome
  // page used to be stacked over: leaving that view up would run the reconnect
  // invisibly, so boot puts the LOAD on the pane first.
  check(/onTabAutoConnect\(connectTabMachine\);/.test(boot) &&
        /import \{[^}]*\bconnectTabMachine\b[^}]*\} from "\.\/conn-flow";/.test(boot) &&
        /import \{[^}]*\bonTabAutoConnect\b[^}]*\} from "\.\/slots";/.test(boot),
    "boot hands slots.ts the connect flow's own attempt: the tab's reconnect reports into its loading bar " +
    "and can ask for the password, which the plain dial cannot");
  check(/import \{[^}]*\bbeginPaneLoad\b[^}]*\} from "\.\/project";/.test(boot) &&
        /if \(bootTab\) \{[\s\S]{0,900}beginPaneLoad\(bootTab\);[\s\S]{0,300}const base = await claimTab\(bootTab\);/.test(boot),
    "and the boot makes the pane this tab's LOAD before it claims, so the hop reports where the user can see it " +
    "(a boot that ends with no session calls showWelcome() again)");

  // The strip is painted from the store before boot decides anything, so the
  // remembered tab is already highlighted during the boot replay.
  check(/loadTabs\(\);\s*\n\s*renderTabBar\(\);\s*$/.test(tabBar.trimEnd() + "\n"),
    "tab-bar.ts still restores and paints the strip at module init (before boot's first await)");
}

// ---- 4) a tab never claims a machine its file is not on -----------------------
//
// The restore half above only carries the machine; this half is what the claim
// does with it. The host's claim falls back to a LOCAL session whenever no
// tunnel is up (host-core.ts claimSlotBackend), so the renderer must either
// bring the tab's own machine back or say which one it is — never let the claimed
// session answer "not a .clc project file" for a machine that never had the file.
{
  const prepare = slotsFn("prepareTabMachine");
  check(/const m = tab\.machine;/.test(prepare) && /if \(m === null\)/.test(prepare),
    "the claim looks at the tab's own machine first, and this machine (null) is its own answer");
  check(/await pinSlot\(tab\.id, \{ kind: "executor", id: LOCAL_EXECUTOR \}\)/.test(prepare),
    "a tab that lives HERE pins its claim to this machine's endpoint: a tunnel another tab opened " +
    "must not route it away");
  check(/if \(now\.active && sameMachine\(now\.target, m\)\)/.test(prepare),
    "a tab that lives THERE claims through the hop only when the hop FOR ITS MACHINE is live — asked by " +
    "machine, so the window's own hop to another host cannot answer for it");
  check(!/in the file picker to open it/.test(prepare),
    "and a live hop to ANOTHER machine no longer refuses the tab: it dials its own machine's hop, and the " +
    "hop somebody else is on is left exactly where it was (tunnel-core: one bound instance per endpoint)");
  check(/const now = await tunnelNow\(m\);/.test(prepare) && !/await tunnelNow\(\);/.test(prepare),
    "the question is asked about the tab's machine, never about 'the' tunnel");
  check(/const why = await autoConnect\(m\);/.test(prepare),
    "with no hop for its machine, the tab dials it through the injected attempt — " +
    "a reconnect, not a new connection, and the tab does not wait for a Connect press elsewhere");
  check(!/standingRemoteIntent/.test(slots),
    "and the window-wide clutch_ssh_connected flag is NOT a gate any more: a move or a Disconnect " +
    "clears it, which left a tab the user had just asked for waiting for a door somewhere else");
  check(/if \(why\) return `\$\{name\} lives on \$\{machineLabel\(m\)\} — \$\{why\}`;/.test(prepare),
    "a reconnect that could not land says WHICH machine the file is on, and why the hop failed");
  check(/if \(!autoConnectDoor\) \{[\s\S]{0,220}open the file picker and press Connect/.test(slotsFn("autoConnect")),
    "with no attempt handed in, the plain dial is the fallback and its failure names the picker's Connect " +
    "— the one door that can ask for a password");
  check(/if \(autoDial && sameMachine\(autoDial\.m, m\)\) return autoDial\.p;/.test(slotsFn("autoConnect")),
    "two tabs of the same host claimed together share ONE dial instead of the second being refused as busy");
  check(/export function onTabAutoConnect\(fn\)/.test(slots),
    "the attempt is handed in from outside (slots.ts may not import conn-flow.ts: a cycle)");
  check(/await pinSlot\(tab\.id, \{ kind: "executor", target: m \}\)/.test(prepare),
    "and the slot is pinned to the MACHINE before the claim: the pin says the file lives there, so a hop " +
    "that stops serving is answered with a failure the pane can name, never with a local session");

  check(/const why = await prepareTabMachine\(tab\);[\s\S]{0,220}tab\.unreachable = why;/.test(slotsFn("claimTab")),
    "a refused claim leaves its reason ON THE TAB (activation and boot say it), and claims nothing");
  check(!/noteTabMachine/.test(slotsFn("claimTab")),
    "a claim records no machine by itself — until the host has RESOLVED the path, 'local' is a guess, " +
    "and recording it would disarm the diagnosis below");
  check(/if \(started\) await noteTabMachine\(tab, base\);/.test(projectFn("openInTab")),
    "the machine is recorded by the open that proved it (project.ts), from the host's own slot status — " +
    "and against the BASE it ran on, so a slot re-bound mid-open records nothing");
  const note = slotsFn("noteTabMachine");
  check(/st\.remote \? asMachine\(st\.target\)/.test(note) && /window\.clutchApi\.slotStatus/.test(note),
    "that answer comes from the host's own slot status (a remote claim names its machine; a local one is " +
    "this machine), not from a URL's shape");
  check(/recordTabMachine\(tab, next\)/.test(note) &&
        /persistTabs\(\)/.test(slotsFn("recordTabMachine")) && /onTabsPersist\(saveTabs\)/.test(tabBar),
    "a machine learned this way is persisted with the working set (recordTabMachine is the one writer), " +
    "so the NEXT boot knows it");

  // The diagnosis is project.ts's, and it ASKS the machines instead of remembering
  // one: the reported tennis.clc was stamped with the machine the OTHER tab was on
  // (the picker's most recently dialled host) and then asked that host forever.
  const withFile = projectFn("machineWithFile");
  check(/window\.clutchTunnel\.list/.test(projectFn("liveMachines")),
    "the candidate machines are the window's LIVE hops, not its connection history");
  check(/!\/\\\.clc\$\/i\.test\(String\(path\)\)/.test(withFile),
    "a path that is not a .clc is the host's other message: no machine can heal it, so nothing is asked");
  check(/sameMachine\(live\[i\]\.machine, tab\.machine\)/.test(withFile),
    "and the machine the open already failed on is not an answer — a second try there repeats the refusal");
  check(!/rememberedMachine|localStorage/.test(withFile),
    "nothing is remembered or guessed: the answer is a host's own /api/fs/stat");
  const probe = projectFn("holdsFile");
  check(/\/api\/fs\/stat\?path=/.test(probe) && /encodeURIComponent\(path\)/.test(probe) &&
        /st\.type === "file"/.test(probe),
    "each live machine is asked whether this exact FILE is there (a workspace-relative /api/fs/stat), " +
    "not whether some directory exists");
  check(/catch \(e\) \{[\s\S]{0,80}return false;/.test(probe),
    "and a machine that will not answer is not a holder: silence must never become a machine");

  const open = projectFn("openInTab");
  check(/if \(!retried && e && \/not a \\\.clc\/i\.test/.test(open),
    "a host refusing the path as 'not a .clc' is what starts that diagnosis — once per open");
  check(/const there = await machineWithFile\(tab\);/.test(open),
    "and what decides is which live machine has the file, asked after the refusal");
  check(/recordTabMachine\(tab, there\.machine\);[\s\S]{0,400}await openInTab\(tab, moved, readOnly, seq, true\)/.test(open),
    "the tab records that machine, re-claims there and tries the open once more — flagged as retried, so " +
    "a second refusal is final and cannot loop");
  check(/return paneBlocked\(\s*tab\.id,\s*tab\.unreachable \|\|/.test(open) &&
        !/tab\.unreachable = null;\s*return;/.test(open),
    "a refused claim keeps its reason on the pane, not in a toast that hides itself in 8 s");
  check(/return paneBlocked\([\s\S]{0,200}"Failed to open project: "/.test(open) &&
        !/notice\(\s*"Failed to open project/.test(open),
    "and every other failed open (a bad path, a dead forward) lands on the same panel, so the " +
    "pane can never be blank with the reason gone");

  const activate = projectFn("activateTab");
  check(/return paneBlocked\(\s*tab\.id,\s*tab\.unreachable \|\|/.test(activate) &&
        !/notice\(tab\.unreachable/.test(activate),
    "a tab with no session says WHERE its file is on that panel instead of a generic toast");
  check(!/tab\.unreachable = null;\s*return;/.test(activate),
    "and the reason is not wiped right after it is shown: the panel's Connect needs it");
  check(/if \(paneBlockedTabId\(\) === prev\.id\) \{[\s\S]{0,600}forgetDomCache\(prev\.id\);/.test(activate),
    "a pane that held a panel is never cached as a view: switching back repaints the reason " +
    "instead of restoring the blank pane");
  check(/tab\.unreachable = null;\s*\n\s*adoptBase\(base\);/.test(activate) &&
        /if \(next && !isStale\(seq\)\) \{\s*apply\(next\);/.test(activate) &&
        (activate.match(/apply\(next\)/g) || []).length === 1,
    "and the panel comes down the moment the tab has a session of its own: the claim clears the reason and " +
    "the state that run returns replaces it at the one landing point");
}

// ---- 4b) the panel itself: markup and the ONE action it offers ----------------
{
  const index = read("ui/index.html");
  check(/id="tab-blocked"[\s\S]{0,900}id="stream"/.test(index),
    "the failure panel is markup INSIDE the pane (before the stream), not a toast floating over it");
  check(/id="tab-blocked-text"/.test(index) && /id="tab-blocked-retry"[^>]*>Retry</.test(index) &&
        /id="tab-blocked-dismiss"/.test(index),
    "it carries the reason and two buttons: Retry (the load again) and Dismiss");
  check(!/tab-blocked-status/.test(index) && !/tab-blocked-connect/.test(index),
    "the old Connect and the progress line it wrote into are gone: a retry IS the load, and the load's " +
    "bar is the pane's own (#open-progress), not a second shape for the same attempt");

  const flow = read("ui/src/renderer/conn-flow.ts");
  check(/export async function retryTab\(tab\)/.test(project) &&
        /dismissBlocked\(\);\s*\n\s*\/\/[\s\S]{0,400}forgetDomCache\(tab\.id\);\s*\n\s*\/\/[\s\S]{0,300}tab\.unreachable = null;\s*\n\s*beginPaneLoad\(tab\);/.test(project),
    "Retry makes the tab load again, from the top: the panel goes, a stale picture and the failed " +
    "attempt's own verdict are dropped, and the load card comes back");
  check(/if \(state\.activeTabId === tab\.id\) currentProject = "";\s*\n\s*await activateTab\(tab\);/.test(project),
    "and it spends the window's \"already open\" belief for THAT tab only, so activateTab cannot early-return " +
    "and leave the fresh card at 0% with nothing running");
  check(/getElementById\("tab-blocked-retry"\)/.test(project) && /state\.tabs\.find\(\(x\) => x\.id === paneBlockedTabId\(\)\)/.test(project),
    "the button is wired to the tab the panel stands for, and only to it");
  check(!/onConnectDoor|connectDoor|blockedStatus/.test(project) && !/onConnectDoor|handleSshConnect/.test(boot),
    "the panel's door into conn-flow is gone from project.ts and from boot.ts: the picker's window-level " +
    "connect (switchBackendResolved, refreshPicker, a host change) is not how a tab opens its file");
  check(!/"tab-blocked-status"\) return "pane"/.test(flow) && !/door === "pane"/.test(flow),
    "and conn-flow has no third door for it: an attempt reports into the picker, the popup, the disconnect " +
    "dialog, or the tab's own load");
  check(/function dismissBlocked\(\)/.test(project) && !/blockedTabId = null;[\s\S]{0,80}dismissBlocked/.test(project),
    "Dismiss hides the panel but still remembers which tab it stood in for (that pane is no transcript)");
}

// ---- 4c) Retry, DRIVEN: the panel gives way to the load, in that order --------
{
  // The REAL function, out of the file that ships, against stubs that record what
  // it did and in which order. The order is the contract: the panel must be gone
  // and the card up BEFORE activateTab runs (it decides what to paint from the
  // pane it finds), and a stale picture must be dropped before the card, or it
  // would be restored over it.
  const drive = async (tab, activeTabId) => {
    const calls = [];
    const ctx = vm.createContext({
      console,
      state: { activeTabId },
      currentProject: "/w/a.clc",
      dismissBlocked: () => calls.push("dismiss"),
      forgetDomCache: (id) => calls.push("forget:" + id),
      beginPaneLoad: (t) => calls.push("load:" + t.id),
      activateTab: async (t) => calls.push("activate:" + t.id),
    });
    vm.runInContext(runnableSnippet(slicer(project).fnBody("retryTab")), ctx);
    ctx.tab = tab;
    await vm.runInContext("retryTab(tab)", ctx);
    return {
      calls: calls.join(" "),
      current: vm.runInContext("currentProject", ctx),
      unreachable: tab ? tab.unreachable : undefined,
    };
  };

  const mine = await drive({ id: "tab-a", path: "/w/a.clc", unreachable: "lives on X, connect in the picker" }, "tab-a");
  check(mine.calls === "dismiss forget:tab-a load:tab-a activate:tab-a",
    "Retry dismisses the panel, drops the tab's cached picture, puts the load card up and only then " +
    "re-activates the tab — the normal route, from the top (" + mine.calls + ")");
  check(mine.current === "",
    "and it spends the window's already-open belief, so activateTab re-runs the claim instead of returning");
  check(mine.unreachable === null,
    "…and the reason the panel was showing: a new attempt writes its own verdict, a stale one would outlive its truth");

  const other = await drive({ id: "tab-b", path: "/w/b.clc" }, "tab-a");
  check(other.calls === "dismiss forget:tab-b load:tab-b activate:tab-b" && other.current === "/w/a.clc",
    "a panel standing in a tab that is NOT the active one leaves the window's project alone — a retry in the " +
    "background is not a reason to forget what the window is showing");

  const none = await drive(null, "tab-a");
  check(none.calls === "" && none.current === "/w/a.clc",
    "a panel with no tab behind it does nothing at all");
}

// the machine the reported tab lives on, and the tab itself
const FAR = { host: "124.220.181.209", user: "fanshu", port: "6001" };
const farTab = (machine) => ({ id: "tab-fix", path: "/w/fix-train.clc", name: "fix-train", dirty: false, machine });

// ---- 4c) the reconnect is a STEP of loading the tab, not a hidden retry -------
//
// Reported: "the tab was cached, so it was connected, so a secret was cached —
// why do I have to press Connect?" The hop is now made by the claim itself, and
// it reports into the tab's own loading bar (#open-progress), so one tab load
// reads as one bar: dial, upload, open.
{
  const index = read("ui/index.html");
  const css = read("ui/style.css");
  const flowSrc = read("ui/src/renderer/conn-flow.ts");
  const paneSrc = read("ui/src/renderer/pane.ts");

  check(/id="open-progress"[\s\S]{0,700}id="open-progress-note"/.test(index),
    "the tab's loading bar carries a NOTE slot, so the hop can say what it is doing there");
  check(/\.open-progress-note\s*\{/.test(css) && /\.open-progress-fill\.indeterminate\s*\{/.test(css),
    "the note has a rule of its own, and a bar with no measured stage animates instead of standing at 0%");
  check(/setFsConnecting\(host, null, "load"\)/.test(flowSrc) &&
        /const pane = activeDoor === "load";/.test(flowSrc),
    "conn-flow gives that bar a door of its own — and it is not an element: an attempt from a boot names it " +
    "where it starts, because the tab's load is the pane's state (pane.ts)");
  check(/\n  if \(door === "load"\) \{/.test(flowSrc) &&
        !/door === "load"[\s\S]{0,900}renderConnSelector/.test(flowSrc),
    "and that door moves no picker chrome — the picker is not on screen at boot");
  check(!/\$\("#open-progress(-note)?"\)/.test(flowSrc) &&
        /if \(pane\) reportHopStage\(pct, label\);/.test(flowSrc),
    "the stage, the upload's rate and its ETA are REPORTED to the pane, which is the bar's only writer");
}

// ---- 4c-2) the load card's geometry is fixed, not a function of what arrived --
//
// Two reports, one cause: the card was laid out by its contents. (a) "the loading
// window is a different height once the percentage shows": the bar stands there
// from the first frame, but the percent and the note only arrive with the first
// measured event, and an empty flex item is a box of no height — so the row was
// 3px (the track) until the number showed up and then grew to a text line. (b)
// "the bar goes short and long": the note was a flex item BESIDE the track,
// capped at 58% of the card, so whatever the truncated stage text happened to be
// wide was taken from the track. The fix is markup: a fixed-height ROW (track +
// percent, in that order) and the note on a line of its own below it.
{
  const index = read("ui/index.html");
  const css = read("ui/style.css");
  const ruleBody = (sel) => {
    const i = css.indexOf(sel + " {");
    if (i < 0) return "";
    return css.slice(i, css.indexOf("}", i) + 1);
  };
  const start = index.indexOf('id="open-progress"');
  const noteAt = index.indexOf('id="open-progress-note"');
  const head = start >= 0 && noteAt > start ? index.slice(start, noteAt) : "";

  check(/class="open-progress-row"/.test(head) && /open-progress-track/.test(head) && /open-progress-label/.test(head),
    "the bar is a ROW of its own: track then percent, nothing else in it");
  check(!/open-progress-note/.test(head),
    "and the note is not a flex sibling of the track — beside it, its truncated width is the track's " +
    "remainder, which is the bar that changes length with the words");
  check(/\bheight\s*:\s*16px/.test(ruleBody(".open-progress-row")) &&
        /line-height\s*:\s*16px/.test(ruleBody(".open-progress-label")),
    "that row reserves the percent's line whether or not there is a number in it yet — the card's height " +
    "is the markup's, never a function of what has arrived");
  check(/width\s*:\s*4ch/.test(ruleBody(".open-progress-label")),
    "the percent is four mono cells wide, so gaining a digit ('99%' -> '100%') does not move the track");
  const note = ruleBody(".open-progress-note");
  check(/\bheight\s*:\s*16px/.test(note) && /text-overflow\s*:\s*ellipsis/.test(note),
    "and the note keeps a line of its own: 16px, truncating at the card's width");
  check(!/\.open-progress-note:empty/.test(css) && !/max-width\s*:\s*58%/.test(note),
    "an empty note still holds its line (a replay has only a percent) and no longer sizes the bar");
}

// ---- 4d) the dial itself: cached secret first, a prompt only when refused -----
{
  const flowFn = slicer(read("ui/src/renderer/conn-flow.ts")).fnBody;
  const src = flowFn("connectTabMachine");
  const paneSrc = read("ui/src/renderer/pane.ts");

  check(/let res = await window\.clutchTunnel\.connect\(\{ host, user, port, endpoint: true \}\)/.test(src),
    "the reconnect dials with NO password first: the host authenticates with the secret settings.json " +
    "cached when this machine last connected");
  check(/endpoint: true/.test(src) && /password: pw, endpoint: true/.test(src),
    "and both dials are the tab's OWN endpoint: a tab's hop is named for its machine, so two tabs on two " +
    "machines hold two hops instead of renaming one");
  check(/if \(!res\.ok && res\.error && \/authentication\/i\.test\(res\.error\)\)[\s\S]{0,600}showPasswordPrompt\(/.test(src),
    "only a REFUSED secret asks the user, once — and the host caches what wins, so the next boot is silent");
  check(!/switchBackendResolved|refreshPicker/.test(src),
    "and it claims no window-default session: the caller claims the TAB's own slot right after");
  check(/paneHopSettled\(up\);/.test(src) && !/open-progress|style\.width/.test(src),
    "on success the bar is not swept to 100% and started again at 0: the flow hands the verdict to the pane, " +
    "which keeps the hop's share and lets the replay continue it");
  check(/export const HOP_SHARE = 0\.4;/.test(paneSrc) &&
        /pct: stagePct === null \? null : stagePct \* HOP_SHARE,/.test(paneSrc),
    "and the hop paints only the first 40% of that bar: the replay behind it is the same load — " +
    "the arithmetic is pane.ts's, not this flow's");
  check(!/LOAD_HOP_SHARE/.test(read("ui/src/renderer/conn-flow.ts")) &&
        /const start = paneLoadPct\(\) \?\? 0;/.test(paneSrc) &&
        /const end = start \+ \(100 - start\) \* \(from \+ \(to - from\) \* f\);/.test(paneSrc),
    "the open continues from where the hop left the bar (0 when the bar was down), so it only ever moves forward");

  // driven for real: the same function the page runs, against a fake engine
  function dialWorld(opts) {
    const calls = { dials: [], prompts: [], upserts: [], connecting: [], settled: [] };
    const ctx = vm.createContext({
      console,
      localStorage: storage(),
      document: { dispatchEvent: () => true },
      setConnBusy: () => {},
      // the two surfaces a hop reports to: the door it names where it starts, and
      // the pane's own verdict when it is over (pane.ts is the bar's only writer)
      setFsConnecting: (...a) => calls.connecting.push(a),
      paneHopSettled: (up) => calls.settled.push(up),
      reportHopStage: () => {},
      syncConnConnect: () => {},
      upsertConn: (...a) => calls.upserts.push(a),
      hopLandedFor: async () => false,
      showPasswordPrompt: async () => { calls.prompts.push(1); return opts.answer || ""; },
      window: {
        clutchTunnel: {
          connect: async (cfg) => {
            calls.dials.push(cfg);
            if (cfg.password) return { ok: true }; // the prompted dial
            return opts.refuse ? { ok: false, error: "authentication failed" } : { ok: true };
          },
        },
      },
    });
    vm.runInContext("let connBusy = false; let activeConnStatus = null; let activeDoor = \"\";", ctx);
    vm.runInContext(runnableSnippet(src), ctx);
    return { ctx, calls };
  }

  {
    const { ctx, calls } = dialWorld({ refuse: false });
    const verdict = await ctx.connectTabMachine({ ...FAR });
    check(verdict === "" && calls.dials.length === 1 && !("password" in calls.dials[0]),
      "a cached secret authenticates: ONE silent dial, no dialog, nothing for the user to press");
    check(calls.dials[0].host === FAR.host && calls.dials[0].user === FAR.user &&
          calls.dials[0].port === 6001,
      "to the machine the tab names, port number and all");
    check(calls.prompts.length === 0 && calls.upserts.length === 1 &&
          calls.dials[0].host === FAR.host,
      "the host joins the picker's own list (so the connect is visible there too) with no prompt");
    check(calls.connecting.length === 1 && calls.connecting[0].length === 3 &&
          calls.connecting[0][0] === FAR.host && calls.connecting[0][1] === null &&
          calls.connecting[0][2] === "load",
      "the attempt opens on the tab's OWN load (door \"load\", no element behind it): one load, one card");
    check(calls.settled.length === 1 && calls.settled[0] === true,
      "and it ends UP: the pane keeps the hop's share and says 'Opening project…' until the replay continues it");
  }

  {
    const { ctx, calls } = dialWorld({ refuse: true, answer: "pw-123" });
    const verdict = await ctx.connectTabMachine({ ...FAR });
    check(calls.dials.length === 2 && calls.dials[1].password === "pw-123" && verdict === "",
      "a refused secret asks once, once, and redials with what the user typed");
    check(calls.settled.length === 1 && calls.settled[0] === true,
      "and the note hands over to the open: the gap while the session spawns still says what is happening " +
      "(the pane's own \"Opening project…\", not a second sentence from this flow)");
  }

  {
    const { ctx, calls } = dialWorld({ refuse: true, answer: "" });
    const verdict = await ctx.connectTabMachine({ ...FAR });
    check(calls.dials.length === 1 && /cancelled/.test(verdict),
      "a cancelled prompt is not a dial with an empty password (" + verdict + ")");
    check(calls.settled.length === 1 && calls.settled[0] === false,
      "and the bar comes down: the tab's panel carries the verdict, there is no progress left to show");
  }
}

// ---- 5) the claim's decision table, driven for real ---------------------------
//
// The contracts above say the shape; this runs it. The functions are sliced out
// of slots.ts and executed against a fake host bridge, so the answers a restored
// tab can get — claim here, redial there, refuse and name the host, claim through
// the hop that already serves its machine — are checked as behaviour, not as
// source text. The bridge keeps one hop per MACHINE (tunnel-core's bound
// instances), so "which hop" is a question the fake can answer honestly.
function machineWorld(opts) {
  const calls = { pins: [], dials: [], claims: [], stats: [], releases: [] };
  const store = storage();
  // `tunnel` is the WINDOW's own hop (the picker's: what a page asks about with
  // no machine), `endpoints` the hops bound to machines — one per endpoint, the
  // way tunnel-core holds them. A page that asks about a machine gets THAT hop
  // and nothing else, which is the whole point of the per-endpoint layer.
  const fake = { tunnel: null, endpoints: new Map(), dialOk: opts.dialOk !== false };
  const machineKeyOf = (c) => `${c.user}@${c.host}:${Number(c.port) || 22}`;
  const pins = new Map(); // slotId -> the pin the host holds for it (the real slotTargets)
  // the directories the machine that answers the claim HAS: the claim's own probe
  // (slots.ts localClaimHasNoFile) asks for the tab's directory, and "none" is the
  // wrong-machine answer
  const here = new Set(opts.localDirs || []);
  if (opts.intent) store.setItem("clutch_ssh_connected", "1");
  if (opts.remembered) store.setItem("clutch_ssh_connections", JSON.stringify([opts.remembered]));
  if (opts.tunnel) fake.tunnel = opts.tunnel;
  if (opts.endpoint) fake.endpoints.set(machineKeyOf(opts.endpoint), opts.endpoint);
  // what a GET to a claimed host answers here: the directory the machine has, or
  // "none" — the same answer apiFetch and a plain fetch both unwrap
  const statAnswer = (url) => {
    calls.stats.push(url);
    if (opts.statFails) throw new Error("no route to host");
    const at = String(url).indexOf("path=");
    const dir = at < 0 ? "" : decodeURIComponent(String(url).slice(at + 5));
    return here.has(dir) ? "dir" : "none";
  };
  const ctx = vm.createContext({
    console,
    localStorage: store,
    document: { dispatchEvent: () => true },
    // what the page's apiFetch does here: one GET to the claimed host, answered
    // from `here` — or a thrown Error when the host cannot answer at all
    apiFetch: async (url) => ({ type: statAnswer(url) }),
    // slots.ts has no app import (this module deliberately precedes it), so the
    // claim's own probe is a plain fetch: answered the same way here
    fetch: async (url) => ({
      ok: true,
      json: async () => ({ type: statAnswer(url) }),
    }),
    state: { apiBase: "http://127.0.0.1:9000" },
    window: {
      clutchTunnel: {
        // asked BY MACHINE by the modules that care about a tab's own hop
        // (slots.ts tunnelNow(m), conn-flow hopLandedFor): answer with that
        // machine's hop, or with the window's own when nothing is named
        status: async (where) => {
          const row = where ? fake.endpoints.get(machineKeyOf(where)) : fake.tunnel;
          return row
            ? { active: true, url: "http://127.0.0.1:7000", target: row }
            : { active: false, url: null, target: null };
        },
        connect: async (cfg) => {
          calls.dials.push(cfg);
          if (!fake.dialOk) return { ok: false, error: "authentication failed" };
          const row = { host: cfg.host, user: cfg.user, port: cfg.port };
          // `endpoint: true`: the tab's OWN machine, named by the shell. The hop
          // lands under that machine — the window's own tunnel is not touched.
          if (cfg.endpoint) fake.endpoints.set(machineKeyOf(cfg), row);
          else fake.tunnel = row;
          return { ok: true };
        },
      },
      clutchApi: {
        baseUrl: async (id) => {
          calls.claims.push(id);
          return "http://127.0.0.1:9000/"; // the host's URL, trailing slash and all
        },
        // what the HOST answers, from the pin it holds: a slot pinned to THIS
        // machine is claimed here even while a hop is up, exactly like
        // host-core.ts. The answer is the host's own shape (slotStatus):
        // `remote` says the work happens on another machine, `target` names it
        // (null for this one).
        slotStatus: async (id) => {
          if (opts.claimRemote !== undefined)
            return { claimed: true, remote: opts.claimRemote, url: "x", target: FAR };
          const pin = pins.get(id);
          const pinnedLocal = Boolean(pin && pin.id === "local");
          // the hop that carries a claim: the window's own, else the endpoint hop
          // this fake holds (one tab, one machine in these cases)
          const hop = fake.tunnel || [...fake.endpoints.values()][0] || null;
          const remote = !pinnedLocal && Boolean(hop);
          // the base the renderer was handed for the claim (a real slotStatus
          // answers the wb.url it holds); a scenario may move it under an open
          return { claimed: true, remote, url: opts.claimUrl || "x", target: remote ? hop : null };
        },
        releaseSession: async (id) => {
          calls.releases.push(id);
          return { ok: true };
        },
        setSlotTarget: async (id, target) => {
          calls.pins.push([id, target]);
          if (target === null) pins.delete(id);
          else pins.set(id, target);
          return { ok: true };
        },
      },
    },
  });
  for (const fn of [
    "machineLabel", "asMachine", "sameMachine", "tunnelTarget", "tunnelNow",
    "pinSlot", "rememberedMachine", "dialMachine", "autoConnect",
    "prepareTabMachine", "noteTabMachine", "noSessionThere", "localClaimHasNoFile",
    "claimTab", "releaseTab", "unwatchTab",
  ]) {
    vm.runInContext(runnableSnippet(slotsFn(fn)), ctx);
  }
  // the diagnosis itself is project.ts's (it is the module that sees the 400) and
  // lives in tests/machine-of-file-test.js: it asks the live hops. What this world
  // needs is the claim's own probe — a directory the answering machine has or does
  // not have (localClaimHasNoFile) — and the ONE writer of a recorded machine,
  // which the base guard in noteTabMachine goes through
  vm.runInContext(runnableSnippet(projectFn("dirOf")), ctx);
  // the writer both ways of learning a machine share: the open that proved it, and
  // the diagnosis that asked the machines which one holds the file
  vm.runInContext(runnableSnippet(slotsFn("recordTabMachine")), ctx);
  // the module-level cells the slices read (they are per-context: a runner's
  // scenario must not leak into the next), plus the DOM repaint a learned
  // machine asks for — this runner is about the store, not the strip
  vm.runInContext(
    "let dialing = false; let persistTabs = null; function announceTabState() {}" +
    // slots.ts names this machine in the same id space as a hop (executors.ts
    // LOCAL_ID): it is a module const, so the slices read it from this context
    '\nconst LOCAL_EXECUTOR = "local";' +
    // releaseTab stops the badge watcher before giving the session back
    "\nconst watchers = new Map();" +
    // the auto-connect door slots.ts is handed at load (boot.ts): this runner
    // wires none, so the plain dial is what runs — the fallback is under test
    "\nlet autoConnectDoor = null; let autoDial = null;",
    ctx,
  );
  return { ctx, calls, fake };
}


{
  // the reported case: the tab remembers the machine, the window's standing
  // intent survived the quit, and there is no hop yet → redial it and claim THERE
  const { ctx, calls } = machineWorld({ intent: true, remembered: FAR });
  const tab = farTab({ ...FAR });
  const base = await ctx.claimTab(tab);
  check(calls.dials.length === 1 && calls.dials[0].host === FAR.host &&
        calls.dials[0].user === FAR.user && calls.dials[0].port === 6001,
    "a restored remote tab redials ITS OWN machine before claiming (user, host and port, in one connect)");
  check(base === "http://127.0.0.1:9000",
    "and it claims the session that hop serves — normalized, no trailing slash (" + base + ")");
  check(calls.claims.length === 1 && calls.claims[0] === "tab-fix",
    "one claim, for this tab's own slot");
  check(tab.machine && tab.machine.host === FAR.host && String(tab.machine.port) === "6001",
    "the tab keeps the machine it was opened on");
  check(calls.pins.some(([id, t]) => id === "tab-fix" && t && t.kind === "executor" && t.target && String(t.target.port) === "6001"),
    "the pin says the file lives on a machine, so the host can never answer this slot with a local session " +
    "(the reported 'not a .clc file': the hop stopped serving and the claim silently landed here)");
  check(!tab.unreachable, "nothing to complain about: the tab opened where its file is");
}

{
  // THE REPORTED CASE ITSELF: the tab was connected when the page died — that is
  // why a cached secret exists for that host — but clutch_ssh_connected is gone
  // (a move to another host clears it, and so does a Disconnect). It used to gate
  // the reconnect, so the tab sat there needing a Connect press it had already
  // paid for. The tab's own recorded machine is the intent now, and the flag must
  // make NO difference to what the claim does.
  const off = machineWorld({ intent: false, remembered: FAR });
  const offTab = farTab({ ...FAR });
  const offBase = await off.ctx.claimTab(offTab);

  const on = machineWorld({ intent: true, remembered: FAR });
  const onTab = farTab({ ...FAR });
  const onBase = await on.ctx.claimTab(onTab);

  check(off.calls.dials.length === 1 && off.calls.dials[0].host === FAR.host &&
        off.calls.dials[0].user === FAR.user && off.calls.dials[0].port === 6001,
    "with no window-wide flag at all, the restored tab still redials its own machine (the cached secret " +
    "in ~/.clutch/settings.json authenticates without a prompt)");
  check(offBase === "http://127.0.0.1:9000" && off.calls.claims.length === 1 && !offTab.unreachable,
    "and it claims this tab's slot exactly like the flagged boot did — nobody had to press Connect (" + offBase + ")");
  check(offBase === onBase && off.calls.dials.length === on.calls.dials.length,
    "the flag changes nothing about the claim: it is not a gate, it is only a note of where the window was");
}

{
  // A hop is up — but it is the WINDOW's own, for another machine. This used to be
  // a refusal ("one tunnel at a time: moving it would take every OTHER remote
  // tab's session with it"), and the refusal was honest while there was one
  // tunnel. There are now N bound instances (tunnel-core), so the tab dials its
  // OWN machine's hop and the window's own is not moved, stopped, or read.
  const { ctx, calls, fake } = machineWorld({
    intent: true,
    tunnel: { host: "10.0.0.9", user: "root", port: 22 },
  });
  const tab = farTab({ ...FAR });
  const base = await ctx.claimTab(tab);
  check(base === "http://127.0.0.1:9000" && calls.claims.length === 1,
    "a tab whose machine is not the window's own hop dials its own and claims there");
  check(calls.dials.length === 1 && calls.dials[0].host === FAR.host && calls.dials[0].endpoint === true,
    "the dial is the tab's OWN endpoint (endpoint: true), not a rename of the window's tunnel");
  check(!tab.unreachable, "nothing to refuse: the file is on a machine this tab can reach (" + tab.unreachable + ")");
  check(fake.tunnel && fake.tunnel.host === "10.0.0.9",
    "and the live hop to another host is left exactly where it was — nobody's session was yanked");
  check(calls.pins.some(([id, t]) => id === "tab-fix" && t && t.kind === "executor" && t.target &&
        t.target.host === FAR.host),
    "the pin says the file lives on the tab's machine, so the claim cannot land on the other hop");
}

{
  // the hop FOR THE TAB'S MACHINE is up: claim through it, no second connect
  const { ctx, calls } = machineWorld({ endpoint: { ...FAR, port: 6001 } });
  const tab = farTab({ ...FAR });
  const base = await ctx.claimTab(tab);
  check(base === "http://127.0.0.1:9000" && calls.dials.length === 0,
    "a live hop to the tab's own machine is used as it is (no second connect)");
  check(calls.pins.some(([id, t]) => id === "tab-fix" && t && t.kind === "executor" && t.target && String(t.target.port) === "6001"),
    "and the slot states where its file is: a hop that dies between here and the claim is a failure to " +
    "report, not an invitation to open the far path in a local session");
}

{
  // this machine's own file: never through a tunnel another tab opened
  const { ctx, calls } = machineWorld({ tunnel: { host: "10.0.0.9", user: "root", port: 22 } });
  const tab = farTab(null);
  const base = await ctx.claimTab(tab);
  check(base === "http://127.0.0.1:9000" && calls.dials.length === 0,
    "a tab that lives HERE claims here, even while a tunnel is up");
  check(calls.pins.some(([id, t]) => id === "tab-fix" && t && t.kind === "executor" && t.id === "local"),
    "by pinning its slot local — otherwise the hop would carry the claim to a host without the file");
  check(tab.machine === null, "and it is still recorded as this machine's");
}

{
  // the fallback dial cannot ask for anything, and it could not authenticate: the
  // tab says which machine it is on AND where the door is. (With boot.ts's own
  // attempt wired, this same failure would have prompted for the password first:
  // conn-flow connectTabMachine.)
  const { ctx, calls } = machineWorld({ intent: true, remembered: FAR, dialOk: false });
  const tab = farTab({ ...FAR });
  const base = await ctx.claimTab(tab);
  check(base === null && calls.claims.length === 0 && calls.dials.length === 1,
    "a redial that cannot authenticate claims nothing (no local fallback over the user's file)");
  check(/^fix-train lives on fanshu@124\.220\.181\.209:6001 — /.test(tab.unreachable || ""),
    "the panel names the machine the file is on, then the reason (" + tab.unreachable + ")");
  check(/could not reconnect to fanshu@124\.220\.181\.209:6001/.test(tab.unreachable || "") &&
        /Connect/.test(tab.unreachable || ""),
    "and it sends the user to the one door that can ask for a password");
}

{
  // THE REPORTED DEAD END, at the claim: the host has a session for this slot and
  // says it is LOCAL, over a directory this machine does not have. Opening it can
  // only answer "not a .clc project file" — a refusal that names neither the
  // machine nor the way out. So the claim is refused, the wrong session given
  // back, and the pane says where the file really is.
  const { ctx, calls } = machineWorld({ intent: true, remembered: FAR, claimRemote: false, localDirs: [] });
  const tab = farTab({ ...FAR });
  const base = await ctx.claimTab(tab);
  check(base === null, "a local claim over a file only the machine has is refused (" + base + ")");
  check(calls.releases.length === 1 && calls.releases[0] === "tab-fix",
    "the session the host handed out is released: it was never the right one");
  check(/fix-train lives on fanshu@124\.220\.181\.209:6001/.test(tab.unreachable || ""),
    "and the pane names the machine instead of showing an open that fails (" + tab.unreachable + ")");
  check(calls.stats.length === 1 && /\/api\/fs\/stat\?path=%2Fw$/.test(calls.stats[0]),
    "asked, not assumed: the host said local and the directory was probed (" + calls.stats[0] + ")");
}

{
  // ...but a local claim over a directory this machine DOES have is a real copy,
  // and a perfectly good place to open the tab: no refusal, no release
  const { ctx, calls } = machineWorld({ intent: true, remembered: FAR, claimRemote: false, localDirs: ["/w"] });
  const tab = farTab({ ...FAR });
  const base = await ctx.claimTab(tab);
  check(base === "http://127.0.0.1:9000" && calls.releases.length === 0 && !tab.unreachable,
    "the same local claim opens when the directory is here — that is a local copy, not a wrong machine (" + base + ")");
}

{
  // a store from before any of this: unknown machine, no pin, local claim — and
  // NOTHING recorded, because a claim is not proof of where the file lives
  const { ctx, calls } = machineWorld({});
  const tab = farTab(undefined);
  const base = await ctx.claimTab(tab);
  check(base === "http://127.0.0.1:9000" && calls.pins.length === 0,
    "an unknown machine claims as it always did — no pin, no dial, no invented answer");
  check(tab.machine === undefined,
    "and the claim invents nothing: the tab stays 'unknown' until a project actually opens somewhere");
}

{
  // A record names the machine the OPEN ran on. The host can re-bind a slot while
  // the open is still streaming (a hop dies, another tab's move re-claims it), and
  // the claim it holds then is a DIFFERENT base: recording that one's machine would
  // be the old lie in a new place — a tab sent to a host that never served the
  // file — so nothing is recorded at all.
  const { ctx } = machineWorld({ endpoint: { ...FAR, port: 6001 }, claimUrl: "http://127.0.0.1:9000" });
  const tab = farTab(undefined);
  const base = await ctx.claimTab(tab);
  await ctx.noteTabMachine(tab, "http://127.0.0.1:4321"); // a claim that has since moved
  check(tab.machine === undefined,
    "a claim that is not the base this open ran on records NOTHING: the machine that served the file is " +
    "the only one worth remembering");
  await ctx.noteTabMachine(tab, base);
  check(tab.machine && tab.machine.host === FAR.host,
    "the claim the open really used records the machine the host names for it (" +
    JSON.stringify(tab.machine) + ")");
}

{
  // ONE writer for a recorded machine: the open that proved it and the diagnosis
  // that asked the machines (project.ts machineWithFile) leave the tab — and the
  // store — in the same state, and an unchanged record does not churn either.
  const { ctx } = machineWorld({});
  const tab = farTab(undefined);
  vm.runInContext("let saves = 0; persistTabs = () => { saves++; };", ctx);
  check(ctx.recordTabMachine(tab, { ...FAR }) === true && tab.machine.host === FAR.host,
    "recording a machine the tab did not have writes it on the tab");
  check(vm.runInContext("saves", ctx) === 1,
    "and saves the working set once, so the NEXT boot knows where the file is before it claims anything");
  check(ctx.recordTabMachine(tab, { ...FAR }) === false && vm.runInContext("saves", ctx) === 1,
    "the same machine again is not a change: no repaint of the strip, no write");
  check(ctx.recordTabMachine(tab, null) === true && tab.machine === null && vm.runInContext("saves", ctx) === 2,
    "and 'this machine' (null) is a record like any other — unknown, here and there are three answers");
}

{
  // the tunnel answer is what records a far machine, not the URL's shape
  const { ctx, fake } = machineWorld({});
  fake.tunnel = { ...FAR, port: 6001 };
  const tab = farTab(undefined);
  await ctx.claimTab(tab);
  await ctx.noteTabMachine(tab); // the open through the live hop
  check(tab.machine && tab.machine.host === FAR.host && tagPort(tab.machine) === "6001",
    "opening through a hop records the hop's own target (" + JSON.stringify(tab.machine) + ")");
}

function tagPort(m) {
  return String(m && m.port);
}

summary("tab-restore", "the remembered tab is reopened on boot, and a tab that lives on a remote machine says so instead of 'not a .clc file'");

}

main();
