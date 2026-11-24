"use strict";

// The composer's outbox: a send over a tunnel.
//
// The bug this pins: run() used to empty the box the moment the button was
// clicked, and the message only appeared in the transcript when the round trip
// that appends the log's `user_message` record finished (host run.js start() does
// `await put(...)` BEFORE it drives, and the append is broadcast back to this
// pane). Over a remote session that window is visible: the box is empty, the
// transcript has nothing, and the message looks like it vanished.
//
// The fix is an invariant, not a timer: the message stays in the box, the run
// button becomes its wait ("Sending" + spinner, box read-only, button disabled
// but at full strength), and the box empties in the very paint that draws the
// row — because the row IS the acknowledgement. Anything that ends the wait
// without a row (a tab switch, a refused call) KEEPS the text.
//
// This runner drives the REAL functions out of the renderer — setStatus /
// paintControls (what the reader sees), beginSend / noteUserMessage / endSend
// (the outbox) and run() itself — against stub globals, and pins the wiring in
// the modules that cannot be run in isolation as source facts.
//
// Run: node tests/send-outbox-test.js

const fs = require("fs");
const path = require("path");
const { check, summary, slicer, uiSource, stateStub, runnableSnippet } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const src = read("ui/src/renderer/render-events.ts");
const view = read("ui/src/renderer/stream-view.ts");
const { fnBody } = slicer(src); // render-events.ts: the outbox and run()
const { fnBody: viewBody } = slicer(view); // stream-view.ts: what the reader sees

// ---- the page's controls, as stream-view.ts touches them ----
const badge = { className: "", textContent: "" };
function control(extra) {
  const cls = new Set();
  return Object.assign(
    {
      textContent: "",
      title: "",
      disabled: false,
      readOnly: false,
      value: "",
      style: {},
      attrs: {},
      classList: {
        toggle(c, on) {
          const v = on === undefined ? !cls.has(c) : !!on;
          if (v) cls.add(c);
          else cls.delete(c);
          return v;
        },
        has: (c) => cls.has(c),
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
    },
    extra || {}
  );
}
const els = { run: control(), task: control(), mode: control(), status: badge, claim: control() };

// ---- the globals those functions read (module-level on the page) ----
global.els = els;
global.sending = false;
global.busy = false;
// the two write-claim flags (stream-view.ts): this runner is the composer's, and
// neither a viewer open nor another window's run is set here
global.readOnly = false;
global.claimed = false;
global.currentProject = "proj-1";
global.TASK_BASE_H = 88;
global.state = stateStub();
global.document = { dispatchEvent() {} };

let notices = [];
global.notice = (m) => notices.push(m);
let scrolls = 0;
global.autoScroll = () => { scrolls++; };
let sentHistory = [];
global.recordSentTask = (t) => sentHistory.push(t);
let tabRunning = [];
global.setTabRunning = (id, on) => tabRunning.push(id + ":" + on);
global.activeSlotId = () => "slot-1";
global.agentMode = "work";
global.driving = new Set();
let lost = [];
global.connectionLost = (m) => lost.push(m);
let appended = [];
global.addEvent = (ev) => appended.push(ev);
// the one IPC hop: hold it open, so the test can look at the page mid-send
let releaseHost = null;
let hostCalls = [];
global.hostCall = (p) => p;
global.window = {
  clutchRun: {
    run(slotId, payload) {
      hostCalls.push({ slotId, payload });
      return new Promise((res, rej) => { releaseHost = { res, rej }; });
    },
  },
};

// ---- the real code ----
// pendingTask is the outbox's memo; on the page it is module-level `let`
global.pendingTask = "";
(0, eval)(runnableSnippet(viewBody("paintControls")));
(0, eval)(runnableSnippet(viewBody("setStatus")));
(0, eval)(runnableSnippet(fnBody("beginSend")));
(0, eval)(runnableSnippet(fnBody("noteUserMessage")));
(0, eval)(runnableSnippet(fnBody("endSend")));
(0, eval)(runnableSnippet(fnBody("run")));

const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  // ---- 1) the wait is the "sending" status, painted on the box and the button ----
  setStatus("idle");
  check(els.run.textContent === "▶ Run" && !els.run.disabled,
    "idle: the button is Run and pressable");

  setStatus("sending");
  check(sending === true, "the sending status is a state the page can read (export let sending)");
  check(els.run.textContent === "Sending",
    `the run button BECOMES the wait, so the click is visibly answered (${els.run.textContent})`);
  check(els.run.classList.has("sending"), "the button carries the class its spinner is drawn from");
  check(els.run.disabled === true, "...and cannot be pressed twice");
  check(els.task.readOnly === true, "the box holding the message is read-only while it is on its way");
  check(els.task.attrs["aria-busy"] === "true", "...and says so to assistive tech");
  check(els.mode.disabled === true, "the mode toggle is locked with it: it applies to the next run");
  check(badge.className === "badge sending" && badge.textContent === "sending",
    "the status badge names the wait too");

  setStatus("running");
  check(els.run.textContent === "■ Stop" && !els.run.disabled && !els.run.classList.has("sending"),
    "running: the same button is Stop again, not a leftover sending button");
  check(els.task.readOnly === false && !("aria-busy" in els.task.attrs),
    "the box is the reader's again once the turn is running");

  setStatus("idle");
  check(els.run.textContent === "▶ Run" && els.run.disabled === false, "and back to Run when the turn is over");
  global.busy = false;

  // ---- 2) the box empties on the ROW, not on the click ----
  els.task.value = "  explain the tunnel   ";
  els.task.style.height = "200px";
  sentHistory = [];
  beginSend("explain the tunnel");
  check(sending === true, "beginSend paints the wait");
  check(els.task.value === "  explain the tunnel   ",
    "the message is STILL IN THE BOX when the send starts — nothing has left the page yet");

  noteUserMessage("explain the tunnel");
  check(els.task.value === "", "the log's own user_message row is what empties the box");
  check(els.task.style.height === "88px", "...and the box gives its grown height back");
  check(sentHistory.length === 1 && sentHistory[0] === "explain the tunnel",
    "the sent text joins ArrowUp's history");
  check(badge.textContent === "running" && sending === false,
    "the row IS the turn opening: the wait becomes a running turn");
  check(tabRunning[tabRunning.length - 1] === "slot-1:true", "...and the tab it belongs to shows it running");

  // ---- 3) a different row is not this send ----
  beginSend("second task");
  els.task.value = "second task";
  noteUserMessage("someone else's task");
  check(els.task.value === "second task" && badge.textContent === "sending",
    "a record that is not this task leaves both the box and the wait alone");
  noteUserMessage(null);
  check(els.task.value === "second task" && badge.textContent === "sending",
    "a record with no text cannot confirm a send either");
  noteUserMessage("  second task  ");
  check(els.task.value === "", "the match is on the trimmed text: that is what the log stores");

  // ---- 4) the reader's own keys can replace the box: it is never emptied under them ----
  beginSend("typed once");
  els.task.value = "a different text the reader is typing"; // Escape / Ctrl+Z write it read-only
  noteUserMessage("typed once");
  check(els.task.value === "a different text the reader is typing",
    "a row arriving after the reader replaced the text does not delete what they now have");
  check(sentHistory[sentHistory.length - 1] === "typed once", "...but what was sent is still in its history");
  check(badge.textContent === "running", "...and the turn is running all the same");

  // ---- 5) a wait that stops without a row keeps the text ----
  els.task.value = "left in flight";
  beginSend("left in flight");
  endSend();
  check(sending === false && badge.textContent === "idle", "endSend ends the wait (a tab switch, a lost call)");
  check(els.task.value === "left in flight", "...and KEEPS the message: losing it is the one thing this state prevents");
  // the memo outlives the wait: that send's row can still land later (the tab's
  // own replay on the way back), and then the box empties as usual
  noteUserMessage("left in flight");
  check(els.task.value === "", "a row that arrives after the wait still empties the box");

  // ---- 6) run(): nothing leaves the box before the host has the task ----
  els.task.value = "ping the remote host";
  sentHistory = []; hostCalls = []; appended = []; tabRunning = []; lost = []; notices = []; scrolls = 0;
  setStatus("idle");
  const pending = run();
  await tick();
  check(hostCalls.length === 1 && hostCalls[0].payload.task === "ping the remote host",
    "the click hands the task to the host loop");
  check(hostCalls[0].payload.project === "proj-1" && hostCalls[0].payload.mode === "work",
    "with the claim run:start verifies, and the mode");
  check(els.task.value === "ping the remote host",
    "the box still holds it while the call is open — the tunnel's whole delay, visibly");
  check(badge.textContent === "sending" && els.task.readOnly && els.run.disabled,
    "and the page says why: sending, locked box, dead button");
  check(scrolls === 1, "the send returns the view to the live tail (once)");

  // a second click cannot double-send
  await run();
  check(hostCalls.length === 1, "a click while the first is still in flight is not a second send");

  releaseHost.res({ ok: true });
  await pending;
  check(els.task.value === "ping the remote host",
    "the call answering is not a send ack: run():run drives to the END of the turn, the row came/comes earlier");
  check(badge.textContent === "idle" && sending === false,
    "once it answers with no row in this pane (a continued turn writes none) the wait ends...");
  check(els.task.value === "ping the remote host", "...with the message still there to re-send");
  check(!els.task.readOnly, "and the box is editable again");

  // ---- 7) a refused call keeps the message and says why ----
  els.task.value = "against the wrong project";
  appended = []; lost = []; tabRunning = [];
  setStatus("idle");
  const refused = run();
  await tick();
  releaseHost.rej(Object.assign(new Error("project mismatch"), { code: "project_mismatch" }));
  await refused;
  check(els.task.value === "against the wrong project",
    "a refusal leaves the message in the box, where the reader can act on it");
  check(badge.textContent === "idle", "the failed send returns to idle, not to a stuck sending");
  check(appended.length === 1 && appended[0].status === "error" && /run failed: project mismatch/.test(appended[0].summary),
    "the attempt's failure is in the transcript, as it always was (`run failed: ...`)");
  check(appended[0].summary.indexOf("run failed") === 0, "the prefix stays the one the transcript greps for");
  check(tabRunning[tabRunning.length - 1] === "slot-1:false", "and the tab stops showing a run");

  // a channel that never reached a host at all is the lost-session dialog
  els.task.value = "no host to reach";
  appended = []; lost = [];
  setStatus("idle");
  const dead = run();
  await tick();
  releaseHost.rej(new Error("ipc closed"));
  await dead;
  check(lost.length === 1 && appended.length === 0,
    "a call with no answer from a host is the lost session, not a one-line transcript error");
  check(els.task.value === "no host to reach" && badge.textContent === "idle",
    "and it keeps the message, like every other way a send can fail");

  // ---- 8) no task: a continuation is a claim, not a send ----
  els.task.value = "";
  hostCalls = []; tabRunning = [];
  setStatus("idle");
  const cont = run();
  await tick();
  check(badge.textContent === "running" && sending === false,
    "a click with an empty box claims the open turn instead of waiting for a row that will not come");
  check(tabRunning[tabRunning.length - 1] === "slot-1:true", "...and the tab shows it");
  releaseHost.res({ ok: true });
  await cont;
  check(els.task.value === "", "an empty box stays empty");

  // ---- 9) the wiring the isolated slices cannot see ----
  const events = read("ui/src/renderer/stream-events.ts");
  const userBranch = events.slice(events.indexOf('ev.type === "user_message"'));
  check(/noteUserMessage\(ev\.content\);/.test(userBranch.slice(0, userBranch.indexOf('ev.type === "final"'))),
    "stream-events.ts hands the log's own user_message row to the outbox in that branch");

  const project = read("ui/src/renderer/project.ts");
  const activate = project.slice(project.indexOf("async function activateTab"), project.indexOf("const changed = state.activeTabId"));
  check(/closeSSE\(\);/.test(activate) && activate.indexOf("endSend()") > activate.indexOf("closeSSE()"),
    "activateTab ends the wait when it drops the stream that could have confirmed it (the text stays)");

  check(/import \{ endSend, resumeTurn \} from "\.\/render-events";/.test(project),
    "project.ts takes it from the outbox's own module");
  check(/export let sending = false;/.test(view),
    "sending is a live binding the other modules read, exactly like busy");
  check(!/setTimeout\([^)]*endSend|setTimeout\([^)]*beginSend/.test(src + view),
    "no timer anywhere in the wait: it ends on a fact (the row, the status, the call), never on a guess");

  // ---- 10) the CSS that draws the wait ----
  const css = read("ui/style.css");
  check(/\.badge\.sending \{[^}]*var\(--muted\)/.test(css), "the badge's sending state is muted, not alarming");
  check(/#run-btn\.sending:disabled \{[^}]*opacity: 1/.test(css),
    "a disabled run button keeps its full strength: a wait is not a dead control");
  check(/#run-btn\.sending::before \{[^}]*older-spin/.test(css),
    "...and the spinner is the sheet's existing motion (older-spin), not a second language");
  check(/#task-input\[aria-busy="true"\] \{[^}]*cursor: progress/.test(css),
    "the locked box shows a progress cursor");

  summary("send-outbox");
})();
