"use strict";

// Scope regression test (⑤): ONE window's dropped connection must not raise the
// reconnect dialog — and must not re-dial a host it was never on — in any other
// window of the same app.
//
// The cause was a scope mismatch, not a detection bug. The tunnel (the hop) is ONE
// resource for the whole process: ui/host-core.js holds one claim per window in
// `windowBackends`, ui/main.js owns the single hop. A SESSION, on the other hand,
// belongs to the window that claimed it (`wc.id`).
//
// The old notification threw that distinction away: every window was sent a bare
// "the tunnel ended" with nothing saying whether THAT window had anything on the
// hop, and each window then decided from a GLOBAL localStorage key
// (clutch_ssh_connected — one profile for every window). So one window's outage
// became every window's outage: the reconnect dialog went up in windows that were
// working, connLostRemoteIntent read the global host/user/port and re-dialled
// another device, and the exit's teardown released every window's claim.
//
// The fix, in four pieces — each has a section below:
//   1. the host answers PER WINDOW: releaseTunnelBackends() returns the window ids
//      the hop actually owned, and the shells put that verdict in the message
//      (`{ lost }`, ui/main.js / android/host/android-host.js);
//   2. the renderer's tunnel-end handler reads it (js/backend-lifecycle.js): a
//      window the hop never owned keeps its session, its stream and its work;
//   3. leaving an outage releases THIS window's claim and stops the shared tunnel
//      only when it was the last window on it (`session:release`); releasing every
//      window's claim stays the picker's own Disconnect — the user leaving the
//      machine (tunnel:disconnect);
//   4. what the renderer remembers about its session URL is per window
//      (sessionStorage), so one window's base is never the next window's memory.
//
// The behavioral half drives the REAL host core and the REAL tunnel-end handler,
// and passes one window's own verdict from the first to the second — the same two
// hops the shipped notification makes.
//
// Run: node tests/tunnel-scope-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, uiSource } = require("./harness.js");
const { createHostCore } = require("../ui/host-core");

const ROOT = path.join(__dirname, "..");
const APP = uiSource(); // the renderer, every module in page load order
const MAIN = fs.readFileSync(path.join(ROOT, "ui", "main.js"), "utf8");
const HOST = fs.readFileSync(path.join(ROOT, "android", "host", "android-host.js"), "utf8");
const PRELOAD = fs.readFileSync(path.join(ROOT, "ui", "preload.js"), "utf8");
const SHIM = fs.readFileSync(path.join(ROOT, "ui", "bridge-shim.js"), "utf8");
const LIBS = fs.readFileSync(path.join(ROOT, "ui", "js", "backend-lifecycle.js"), "utf8");

// ---- 1. the host answers per window, and says so in the message ----
const sendAt = MAIN.indexOf('tunnel.onTunnelEnd');
const sendEnd = MAIN.indexOf("// the main process re-established", sendAt);
const notify = sendAt < 0 ? "" : MAIN.slice(sendAt, sendEnd < sendAt ? sendAt + 1200 : sendEnd);
check(/const affected = await hostCore\.releaseTunnelBackends\(\);/.test(notify) &&
  /send\("tunnel:ended", \{ lost: lost\.has\(w\.webContents\.id\) \}\)/.test(notify),
  "the desktop shell tells every window about the hop — each one with its OWN verdict, computed from the windows the hop owned");
check(!/send\("tunnel:ended"\)/.test(MAIN) && !/broadcast\("tunnel:ended"\)/.test(HOST),
  "and no shell sends a bare tunnel end any more: the message says whose loss it is");
check(/const affected = await hostCore\.releaseTunnelBackends\(\);/.test(HOST) &&
  /bus\.broadcast\("tunnel:ended", \{ lost: affected\.includes\(window\.id\) \}\)/.test(HOST),
  "the phone asks the same question of the same core (one window there, so the answer is its own claim)");

// ---- 2. leaving an outage is a WINDOW act; the machine-wide release is the picker ----
const releaseAt = MAIN.indexOf('ipcMain.handle("session:release"');
const releaseHandler = releaseAt < 0 ? "" : MAIN.slice(releaseAt, releaseAt + 700);
check(/hostCore\.releaseWindowBackend\(e\.sender\.id\)/.test(releaseHandler),
  "one window's exit releases THAT window's claim — the shell names it from e.sender, so a renderer cannot release another window's session");
check(/if \(!hostCore\.anyTunnelWindow\(\)\) await tunnel\.stopTunnel\(\)/.test(releaseHandler),
  "and the shared hop is stopped only when no window is left on it: one window's Cancel is not another window's shutdown");
check(/ipcMain\.handle\("tunnel:disconnect"[\s\S]{0,400}releaseAllBackends\(\)/.test(MAIN),
  "releasing EVERY window's claim stays where it belongs: the picker's own Disconnect, which is the user leaving the machine");
check(/releaseSession: async \(\) => \{\s*\n\s*await hostCore\.releaseWindowBackend\(window\.id\);/.test(HOST) &&
  /releaseSession: async \(\) => \{[\s\S]{0,300}anyTunnelWindow\(\)/.test(HOST),
  "the phone's handler is the same rule, one for one");
check(/releaseSession: \(\) => ipcRenderer\.invoke\("session:release"\)/.test(PRELOAD) &&
  /releaseSession: \(\) => call\("clutchApi", "releaseSession"\)/.test(SHIM),
  "both renderer surfaces carry the verb and no window id (parity is asserted in bridge-shim.test.js)");

// ---- 3. the renderer's tunnel-end handler reads the verdict ----
// the handler is pulled out WHOLE and driven below, so the pins and the behavior
// are about the same text
const cbAt = LIBS.indexOf("window.clutchTunnel.onEnd(");
const cbStart = cbAt < 0 ? -1 : cbAt + "window.clutchTunnel.onEnd(".length;
const cbEnd = cbStart < 0 ? -1 : LIBS.indexOf("});", cbStart);
const onEndSrc = cbStart < 0 || cbEnd < 0 ? "" : LIBS.slice(cbStart, cbEnd + 1);
check(/^\(info\) => \{/.test(onEndSrc) && /refreshPicker\(\)/.test(onEndSrc),
  "the tunnel-end handler is one function of the verdict (and this runner found its real text)");
check(/if \(info && info\.lost === false\) return;/.test(onEndSrc),
  "a window the hop never owned returns immediately: no dialog, nothing re-dialled — the innocent-window bug's own line");
check(onEndSrc.indexOf('removeItem("clutch_degrade")') < onEndSrc.indexOf("info.lost === false"),
  "after dropping what the hop implies for everyone: degrade mode died with the exec bridge, whoever was on it");
check(onEndSrc.indexOf("info.lost === false") < onEndSrc.indexOf('getItem("clutch_ssh_connected")'),
  "and the verdict is read BEFORE the standing intent: that intent is a global key, which is exactly why it cannot decide this alone");
check(onEndSrc.indexOf('getItem("clutch_ssh_connected")') < onEndSrc.indexOf('connectionLost("lost the remote connection")'),
  "the intent is still the second word, unchanged: a disconnect the user asked for is not a loss");

// ---- 4. the session URL is remembered per window ----
check(/sessionStorage\.setItem\("clutch_api_url"/.test(APP) &&
  /sessionStorage\.removeItem\("clutch_api_url"\)/.test(APP) &&
  /sessionStorage\.getItem\("clutch_api_url"\)/.test(APP) &&
  !/localStorage\.(get|set|remove)Item\("clutch_api_url"\)/.test(APP),
  "every reader and writer of this window's session URL uses sessionStorage: one window's base is never the next window's remembered value");

// ---- 5. driven: the host's verdict, and what each window does with it ----
function fakeWin(id) {
  return {
    id,
    destroyed: false,
    sent: [],
    isDestroyed() {
      return this.destroyed;
    },
    send(ch, payload) {
      this.sent.push([ch, payload]);
    },
  };
}

// the smallest host core that can hold two claims (the state machine itself is
// exercised in host-core.test.js; here it only has to answer "whose was the hop?")
function makeCore(tunnel) {
  let lseq = 0;
  let sseq = 0;
  return createHostCore({
    supervisorBase: () => "http://127.0.0.1:8890",
    remoteLlmBase: () => "http://127.0.0.1:8892/v1",
    remoteLlmModel: () => "m",
    remoteLlmKnobs: () => ({}),
    tunnelStatus: () => tunnel,
    restartRemoteServer: async () => true,
    openSessionForward: async (port) => ({ localPort: port + 1000, close: () => {} }),
    startLocalSession: async () => ({
      mode: "spawned",
      sessionId: "L" + ++lseq,
      url: "http://127.0.0.1:" + (40000 + lseq),
      stop: () => {},
    }),
    log: () => {},
    sessions: {
      supervisorSessionStart: async () => ({ sessionId: "s" + ++sseq, port: 30000 + sseq }),
      supervisorSessionStop: () => {},
      supervisorSessionHeartbeat: async () => true,
      startSupervisorHeartbeat: () => ({ stop: () => {} }),
      supervisorShutdown: () => {},
    },
  });
}

// the renderer's own storage: one profile, shared by every window — the standing
// intent from the window that WAS on the remote is what this window sees
const store = new Map([
  ["clutch_ssh_connected", "1"],
  ["clutch_degrade", "{}"],
]);
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let losts = 0;
global.connectionLost = () => {
  losts++;
};
let pickerPaints = 0;
global.refreshPicker = () => {
  pickerPaints++;
};
global.fsModal = { classList: { contains: () => false } };

async function main() {
  const onEnd = (0, eval)("(" + onEndSrc + ")");

  const tunnel = { active: false, url: null };
  const core = makeCore(tunnel);
  const mine = fakeWin(7); // this window: this machine's own session
  const theirs = fakeWin(8); // the other window: the one over the hop
  await core.ensureWindowBackend(mine);
  tunnel.active = true;
  tunnel.url = "http://127.0.0.1:8891";
  await core.ensureWindowBackend(theirs);
  check(core.backendKind(mine.id) === "local" && core.backendKind(theirs.id) === "tunnel",
    "two windows, one app: one on its own local session, one over the shared hop");

  // the hop dies, and the shell notifies each window with its own verdict —
  // this is ui/main.js's own loop, driven
  const affected = new Set(await core.releaseTunnelBackends());
  for (const w of [mine, theirs]) w.send("tunnel:ended", { lost: affected.has(w.id) });
  check(mine.sent.length === 1 && mine.sent[0][1].lost === false,
    "the window that was never on the hop is told so");
  check(theirs.sent.length === 1 && theirs.sent[0][1].lost === true,
    "and the window that was on it is told the truth about itself");
  check(core.backendKind(mine.id) === "local" && core.backendKind(theirs.id) === "tunnel",
    "the hop's end dropped the claims of nobody: a session outlives the hop that carried it");

  // ...and now each window's own handler, with its own verdict
  await onEnd(mine.sent[0][1]);
  check(losts === 0 && pickerPaints === 0,
    "the innocent window raises no dialog and repaints no picker: it still has its session, its stream and its work");
  check(!store.has("clutch_degrade"),
    "it does still drop what the hop implied — degrade mode died with the exec bridge");
  store.set("clutch_degrade", "{}");

  await onEnd(theirs.sent[0][1]);
  check(losts === 1,
    "the window the hop owned announces the loss to its own dialog, once");

  // the same window, a second time (a detector that fires twice): still one word
  // from the host, still that window's own — nothing about this is per-process
  await onEnd(theirs.sent[0][1]);
  check(losts === 2 && mine.sent.length === 1,
    "and the innocent window is never told again: the hop's end is broadcast once, and it is not this window's news");

  // no verdict at all (an older host, or a channel that arrives without one): the
  // old behavior is the honest fallback — a window with the intent assumes a loss
  // rather than sitting on a dead session
  await onEnd(undefined);
  await onEnd({});
  check(losts === 4, "a message with no verdict is read as a loss, never as a silent pass");

  // ...and the standing intent keeps its own veto, unchanged: the user's own
  // disconnect (the picker) is not an outage, verdict or not
  store.delete("clutch_ssh_connected");
  const lostsBefore = losts;
  const paintsBefore = pickerPaints;
  await onEnd({ lost: true });
  await onEnd({ lost: false });
  check(losts === lostsBefore && pickerPaints === paintsBefore,
    "no intent = the user left on purpose: neither verdict raises the dialog (that check is older than this one, and it still stands)");

  summary("tunnel-scope");
}

main().catch((e) => {
  console.error("FAIL:", (e && (e.stack || e.message)) || e);
  process.exit(1);
});
