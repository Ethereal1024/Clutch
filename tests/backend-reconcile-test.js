"use strict";

// WHICH session a reconcile is about, and what it may claim about it.
//
// Two device reports, one rule. Opening the file picker on a remote host listed
// THIS machine's files, and the remote .clc then would not open ("not a .clc
// project file"): the picker's reconcile asked the host for the WINDOW's session
// (slot "") — a claim of its own, which with a live tunnel and no URL answered a
// LOCAL session — and adopted the answer, moving the whole window off the machine
// its tab was still on. And the picker went on showing the host as connected:
// the same branch wrote the standing SSH intent for ANY adopted claim, including
// the local one it had just manufactured.
//
// So this runner drives the REAL app.ts hostSessionUrl and backend-lifecycle.ts
// claimedByTunnel / reconciledBackendUrl against stubs, and reads fs-browser.ts
// for the one call site that has to name a slot:
//   * the ask names the session it is for — a tab id when a tab asked, "" when
//     the window itself did (a boot, the welcome page);
//   * the standing intent is written only for a claim that really is the
//     tunnel's, and never on a host that cannot be asked;
//   * a claim that is not the tunnel's is still returned (the caller adopts what
//     the host actually holds) — what it may not do is call it a connection.
//
// Run: node tests/backend-reconcile-test.js

const { check, summary, slicer, uiModules } = require("./harness.js");

async function main() {
  const mods = uiModules();
  const src = (file) => {
    const m = mods.find((x) => x.file === file);
    if (!m) throw new Error("module not in the page's load order: " + file);
    return m.code;
  };
  const APP = src("app.ts");
  const LIFECYCLE = src("backend-lifecycle.ts");
  const PICKER = src("fs-browser.ts");
  const { fnBody } = slicer(APP + "\n" + LIFECYCLE);

  // ---- the page's stores, and the three facts the ask is made of ----
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const session = new Map();
  global.sessionStorage = {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => session.set(k, String(v)),
    removeItem: (k) => session.delete(k),
  };
  global.state = { apiBase: null };
  global.SUPERVISOR_BASE = "http://127.0.0.1:8890";
  global.IS_ANDROID = false;

  // the exit's note (conn-lost.ts): a boot that follows an exit claims nothing.
  // Its own runner owns that behaviour; here it only has to exist and to be
  // readable before the ask.
  let note = false;
  global.connLostExitPending = () => note;
  let switches = 0;
  global.switchBackendResolved = async () => {
    switches++;
    return true;
  };

  // What the main process would answer. `asks` records the SLOT each ask was
  // made for, because that is the half that used to be wrong.
  const asks = [];
  let claim = { claimed: true, kind: "tunnel", url: "http://127.0.0.1:40555" };
  let tunnel = { active: true, url: "http://127.0.0.1:41000" };
  global.window = {
    clutchApi: {
      baseUrl: async (slotId) => {
        asks.push(slotId === undefined ? "<undefined>" : String(slotId));
        return claim.url;
      },
      slotStatus: async (slotId) => {
        asks.push("kind:" + (slotId === undefined ? "<undefined>" : String(slotId)));
        return { claimed: claim.claimed, kind: claim.kind, url: claim.url };
      },
    },
    clutchTunnel: { status: async () => tunnel },
  };

  (0, eval)(fnBody("hostSessionUrl"));
  (0, eval)(fnBody("claimedByTunnel"));
  (0, eval)(fnBody("reconciledBackendUrl"));

  const reset = () => {
    store.clear();
    session.clear();
    asks.length = 0;
    switches = 0;
    note = false;
    claim = { claimed: true, kind: "tunnel", url: "http://127.0.0.1:40555" };
    global.window.clutchApi.slotStatus = async (slotId) => {
      asks.push("kind:" + (slotId === undefined ? "<undefined>" : String(slotId)));
      return { claimed: claim.claimed, kind: claim.kind, url: claim.url };
    };
    tunnel = { active: true, url: "http://127.0.0.1:41000" };
  };

  // ---- 1) the ask names the session it is for ----
  reset();
  check((await hostSessionUrl("tab-7")) === "http://127.0.0.1:40555" && asks.join(",") === "tab-7",
    `the ask carries the slot it is about (asked for ${JSON.stringify(asks)})`);
  reset();
  await hostSessionUrl();
  check(asks.length === 1 && asks[0] === "",
    `and a window with no tab asks for the window's own session — the empty slot, not undefined (asked for ${JSON.stringify(asks)})`);
  reset();
  claim.url = "http://127.0.0.1:40556";
  check((await hostSessionUrl()) === "http://127.0.0.1:40556",
    "and the answer is the host's own, never a guess assembled here");
  check((await hostSessionUrl("tab-7")) === "http://127.0.0.1:40556" && asks.join("|") === "|tab-7",
    `a slot changes WHO is asked, not WHAT is answered (asked for ${JSON.stringify(asks)})`);

  // ---- 2) a reconcile asks that same slot, and adopts only what it is handed ----
  reset();
  session.set("clutch_api_url", "http://127.0.0.1:39999"); // this window is somewhere else
  const target = await reconciledBackendUrl("tab-7");
  check(target === "http://127.0.0.1:40555",
    `the reconcile hands back the host's answer for that slot (got ${JSON.stringify(target)})`);
  check(asks[0] === "tab-7" && asks.includes("kind:tab-7"),
    `both questions in it — the URL, and what kind of claim it is — are asked about the TAB (asked ${JSON.stringify(asks)})`);
  check(asks.every((a) => !a.endsWith("<undefined>")),
    "nothing in it is asked without a slot: an unnamed ask is the window's default session, which is the one that gets claimed");

  // ---- 3) the standing intent is written only for a claim that IS the tunnel's ----
  reset();
  session.set("clutch_api_url", "http://127.0.0.1:39999");
  await reconciledBackendUrl("tab-7");
  check(store.get("clutch_ssh_connected") === "1",
    "a claim the host says is the tunnel's is the connection the picker may show");

  reset();
  session.set("clutch_api_url", "http://127.0.0.1:39999");
  claim.kind = "local"; // the fallback: a session on THIS machine, tunnel still up
  const local = await reconciledBackendUrl("tab-7");
  check(local === "http://127.0.0.1:40555",
    `the local claim is still returned — the caller adopts what the host holds (got ${JSON.stringify(local)})`);
  check(!store.has("clutch_ssh_connected"),
    "but it is NOT written down as an SSH connection: the picker would tick a host this window is not on, " +
    "and refuse to dial it (connConnect) — the dead end the report came from");
  check(switches === 0,
    "and a local claim is not treated as a stale remote either: this branch neither dials nor falls back");

  reset();
  session.set("clutch_api_url", "http://127.0.0.1:39999");
  claim.claimed = false; // nothing claimed for that slot
  await reconciledBackendUrl("tab-7");
  check(!store.has("clutch_ssh_connected"),
    "an unclaimed slot is not a connection either, whatever URL the host volunteered");

  // ---- 4) a host that cannot be asked is not a host to claim ----
  reset();
  session.set("clutch_api_url", "http://127.0.0.1:39999");
  delete global.window.clutchApi.slotStatus;
  const noStatus = await reconciledBackendUrl("tab-7");
  check(noStatus === "http://127.0.0.1:40555" && !store.has("clutch_ssh_connected"),
    `a build with no slot:status still gets its base, and writes no intent it cannot check (got ${JSON.stringify(noStatus)})`);

  reset();
  session.set("clutch_api_url", "http://127.0.0.1:39999");
  global.window.clutchApi.slotStatus = async () => {
    throw new Error("ipc went away");
  };
  check((await reconciledBackendUrl("tab-7")) === "http://127.0.0.1:40555" && !store.has("clutch_ssh_connected"),
    "and a throwing status is the same answer as a missing one: no connection is invented over an error");

  // ---- 5) the note an exit leaves still comes first, slot or no slot ----
  reset();
  note = true;
  check((await hostSessionUrl("tab-7")) === null && asks.length === 0,
    "a slot does not open a second door past the exit's note: the ask is still refused, and not made");
  check((await reconciledBackendUrl("tab-7")) === null && asks.length === 0,
    "and the reconcile that names a slot is refused before it asks, exactly like the window's own");

  // ---- 6) the picker asks for ITS tab ----
  check(/import \{ activeSlotId \} from "\.\/slots";/.test(PICKER),
    "the picker names its tab the way the rest of the page does (slots.ts activeSlotId)");
  const openFn = slicer(PICKER).fnBody("openFsBrowser");
  check(/reconciledBackendUrl\(activeSlotId\(\)\)/.test(openFn),
    "and reconciles THAT slot: the picker browses the session of the tab it was opened from, so the ask " +
    "re-uses it instead of claiming the window's default session");
  check(!/reconciledBackendUrl\(\)/.test(openFn),
    "never the empty one: that call is what started a second session (this machine's, with no tunnel URL yet) " +
    "and adopted it under the tab's feet");

  // The ask names the session it is for, and in the page's own load order there is
  // ONE of it: the window's (hostSessionUrl). A tab's claim is the other door, in
  // slots.ts (claimTab, with its own tab id) — and boot.ts refuses to restore tabs
  // while the exit's note is up, so no boot path reaches the host's answer here
  // without passing the note.
  const APPALL = mods.map((m) => m.code).join("\n");
  check((APPALL.match(/window\.clutchApi\.baseUrl\(/g) || []).length === 1,
    "and the ask itself is still the only door to the host's session in that order: one call site, so the " +
    "exit's note and the supervisor sentinel are refused on every boot path");
  const hostFn = fnBody("hostSessionUrl");
  check(/window\.clutchApi\.baseUrl\(slot\)/.test(hostFn) &&
    hostFn.indexOf("connLostExitPending()") < hostFn.indexOf("baseUrl("),
    "which reads the note before it asks, and passes the slot on");

  summary("backend-reconcile");
}

main().catch((e) => {
  console.error("FAIL:", (e && e.stack) || e.message || e);
  process.exit(1);
});
