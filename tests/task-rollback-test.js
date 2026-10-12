"use strict";

// The rollback gesture (ui/js/task-rollback.js): a right-click on a desktop, a
// long press on a phone, on a SENT USER MESSAGE — and the workspace goes back to
// what it was before that message was sent, with the message back in the box.
//
// The file is loaded for real (a classic script in a vm context, exactly as the
// page loads it) and driven through the event objects the two gestures really
// deliver, because what can go wrong here is not the request: it is WHICH row
// answers the gesture, whether the timer beats the finger's own long-press, and
// whether a desktop right-click and the click still answers. The server side of
// the rollback has its own tests (tests/selfcheck.py, tests/server_test.py).
//
// Run: node tests/task-rollback-test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, summary } = require("./harness.js");

// ---- a pane of rows, with the two things the gestures use: closest() and
// addEventListener (the file registers its handlers at load, on `eventsEl`) ----
function makeNode(cls) {
  const classes = new Set(String(cls || "").split(/\s+/).filter(Boolean));
  const n = { className: cls || "", children: [], parent: null, dataset: {}, listeners: {}, _taskText: undefined };
  n.matches = (sel) => sel.split(".").filter(Boolean).every((c) => classes.has(c));
  n.closest = (sel) => {
    let cur = n;
    while (cur) {
      if (cur.matches(sel)) return cur;
      cur = cur.parent;
    }
    return null;
  };
  n.appendChild = (ch) => {
    ch.parent = n;
    n.children.push(ch);
    return ch;
  };
  n.addEventListener = (type, fn) => {
    (n.listeners[type] = n.listeners[type] || []).push(fn);
  };
  return n;
}

// a sent task row: the class the renderer gives it, the byte offset the wire
// stamped on it, the raw text it keeps (what goes back into the box), and a
// child to press on — gestures land on the markdown inside the row, never on
// the row itself, which is the whole reason the handler uses closest()
function taskRow(text, offset, cls) {
  const row = makeNode(cls || "event user");
  row._taskText = text;
  if (offset !== undefined) row.dataset.offset = String(offset);
  const body = makeNode("body");
  row.appendChild(body);
  return row;
}

const pane = makeNode("events");
const ctx = { console, eventsEl: pane, busy: false, pageSink: null };

// ---- the stubs the file calls out to ----
let apiCalls = [];
let anchors = []; // what GET /api/workspace/checkpoints answers
let rollbackAnswer = { status: "ok", restored: ["a.py"], deleted: ["b.py", "c.py"], count: 3 };
let askAnswer = true;
let asks = [];
let notices = [];
let filled = [];
let treeRefreshes = 0;
let holdRollback = false;
let releaseRollback = () => {};

ctx.apiFetch = async (url, opts = {}) => {
  apiCalls.push({ url, method: opts.method || "GET", body: opts.body });
  if (url === "/api/workspace/checkpoints") return { anchors };
  if (url === "/api/workspace/rollback") {
    if (holdRollback) await new Promise((r) => { releaseRollback = r; });
    if (rollbackAnswer instanceof Error) throw rollbackAnswer;
    return rollbackAnswer;
  }
  throw new Error("unexpected request: " + url);
};
ctx.askConfirm = (opts) => {
  asks.push(opts);
  return Promise.resolve(askAnswer);
};
ctx.notice = (msg, kind) => notices.push({ msg, kind });
ctx.fillTaskInput = (text) => filled.push(text);
ctx.refreshTree = () => {
  treeRefreshes++;
};

// ---- a clock the test owns: the long press is 500ms of silence, and the
// same-gesture window is 800ms of it ----
let now = 100000;
let timers = [];
let nextTimer = 1;
ctx.performance = { now: () => now };
ctx.setTimeout = (fn, ms) => {
  const id = nextTimer++;
  timers.push({ id, at: now + (ms || 0), fn });
  return id;
};
ctx.clearTimeout = (id) => {
  timers = timers.filter((t) => t.id !== id);
};
function advance(ms) {
  now += ms;
  const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
  timers = timers.filter((t) => t.at > now);
  for (const t of due) t.fn();
}

vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "ui", "js", "task-rollback.js"), "utf8"),
  ctx
);

// lexical bindings (let, not global properties) are poked through the context;
// everything else here is a plain global the file reads by name
const set = (expr) => vm.runInContext(expr, ctx);

function reset(opts = {}) {
  apiCalls = [];
  asks = [];
  notices = [];
  filled = [];
  treeRefreshes = 0;
  timers = [];
  anchors = opts.anchors === undefined ? [] : opts.anchors;
  rollbackAnswer = opts.rollbackAnswer === undefined ? { status: "ok", restored: ["a.py"], deleted: ["b.py", "c.py"], count: 3 } : opts.rollbackAnswer;
  askAnswer = opts.askAnswer === undefined ? true : opts.askAnswer;
  holdRollback = !!opts.holdRollback;
  releaseRollback = () => {};
  ctx.busy = !!opts.busy;
  // rollbackAnchors is the set GET /api/workspace/checkpoints fills: null means
  // "not asked yet", which this file treats as "ask the server" rather than
  // "refuse" — a stale window must still be able to roll back
  set(`rollbackAnchors = ${opts.known === undefined ? "null" : `new Set(${JSON.stringify(opts.known)})`};`);
  set("rollbackBusy = false;");
  set("lastRollbackGestureAt = -1e9;"); // no gesture in flight
}
const flush = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 6; i++) await flush();
}

function fire(type, ev) {
  for (const fn of (pane.listeners[type] || []).slice()) fn(ev);
}
function rightClick(target) {
  const ev = { target, preventDefault() { ev.defaultPrevented = true; } };
  fire("contextmenu", ev);
  return ev;
}
function touch(type, target, x = 40, y = 40, count = 1) {
  const touches = Array.from({ length: count }, () => ({ clientX: x, clientY: y }));
  const ev = { target, touches, preventDefault() { ev.defaultPrevented = true; } };
  fire(type, ev);
  return ev;
}

const rollbackPosts = () => apiCalls.filter((c) => c.url === "/api/workspace/rollback");
const anchorGets = () => apiCalls.filter((c) => c.url === "/api/workspace/checkpoints");

async function main() {
  // ---- 1) the desktop gesture: right-click a sent message ----
  const row = taskRow("fix the parser", 120);
  pane.appendChild(row);
  reset();
  const ev = rightClick(row.children[0]); // the press lands on the markdown, not the row
  await settle();
  check(ev.defaultPrevented === true, "the browser's own menu is suppressed");
  check(asks.length === 1, "a right-click on a sent message asks before touching the workspace");
  check(/roll back/i.test(asks[0].title || ""), "the question says what it is (" + JSON.stringify(asks[0].title) + ")");
  check(/shell command/i.test(asks[0].text || ""), "the question admits what it cannot undo (run_command edits)");
  check(rollbackPosts().length === 1 && rollbackPosts()[0].method === "POST" &&
        rollbackPosts()[0].body && rollbackPosts()[0].body.offset === 120,
        "confirming posts that message's own offset to the rollback endpoint");
  check(filled.length === 1 && filled[0] === "fix the parser",
        "the message goes back into the input box (" + JSON.stringify(filled[0]) + ")");
  check(treeRefreshes >= 1, "the file tree is refreshed: files just came back or went away");
  check(notices.length === 1 && /rolled back 3 files/.test(notices[0].msg) && /2 deleted/.test(notices[0].msg),
        "the outcome is reported without a second question (" + JSON.stringify(notices[0].msg) + ")");
  check(anchorGets().length === 1,
        "the anchors are re-read: those journal entries are gone from the server now");

  // ---- 2) a gesture anywhere else in the transcript is not ours ----
  const toolRow = taskRow("read_file …", 300, "event tool_group");
  pane.appendChild(toolRow);
  reset();
  const ev2 = rightClick(toolRow.children[0]);
  await settle();
  check(ev2.defaultPrevented === undefined && asks.length === 0 && apiCalls.length === 0,
        "right-clicking a tool row leaves the browser's menu alone");
  check(rightClick(pane).defaultPrevented === undefined, "right-clicking the pane's background does nothing");

  // ---- 3) cancelling the question changes nothing ----
  reset({ askAnswer: false });
  rightClick(row.children[0]);
  await settle();
  check(rollbackPosts().length === 0 && filled.length === 0 && treeRefreshes === 0,
        "declining the question sends no request and touches no box");

  // ---- 4) a task that changed nothing is answered honestly ----
  reset({ known: [999] }); // the server says this offset has no journal entries
  rightClick(row.children[0]);
  await settle();
  check(asks.length === 0 && rollbackPosts().length === 0 && notices.length === 1 &&
        /no file changes/.test(notices[0].msg),
        "a message whose task changed no file is told so, instead of asked");

  // ---- 5) ...and one that did is asked, from the same set ----
  reset({ known: [120] });
  rightClick(row.children[0]);
  await settle();
  check(asks.length === 1 && rollbackPosts().length === 1, "an offset in the set is rollback-able");

  // ---- 6) an unknown set (never asked, or the read failed) still offers it:
  // the server owns the truth, and a refused round trip is better than a lie ----
  reset({ known: undefined });
  rightClick(row.children[0]);
  await settle();
  check(asks.length === 1 && rollbackPosts().length === 1, "an unknown set asks rather than refuses");

  // ---- 7) a run is writing those files right now ----
  reset({ busy: true });
  rightClick(row.children[0]);
  await settle();
  check(rollbackPosts().length === 0 && asks.length === 0 &&
        notices.length === 1 && /run is active/.test(notices[0].msg),
        "an active run refuses with a reason instead of racing it");

  // ---- 8) a row with no offset cannot name a task ----
  const bare = taskRow("a message from before offsets", undefined);
  pane.appendChild(bare);
  reset();
  rightClick(bare.children[0]);
  await settle();
  check(apiCalls.length === 0 && asks.length === 0, "a row without a byte offset is left alone");

  // ---- 9) the phone gesture: a long press, and only a long press ----
  reset();
  touch("touchstart", row.children[0]);
  advance(499);
  await settle();
  check(asks.length === 0, "a 499ms touch is a tap, not a rollback");
  advance(1);
  await settle();
  check(asks.length === 1 && rollbackPosts().length === 1, "500ms of rest on a message opens the same question");
  touch("touchend", row.children[0]);

  // a finger that moves is scrolling: the press is abandoned
  reset();
  touch("touchstart", row.children[0], 40, 40);
  advance(200);
  touch("touchmove", row.children[0], 40, 90); // 50px away: a scroll
  advance(1000);
  await settle();
  check(asks.length === 0, "a touch that wanders more than a few pixels is a scroll, not a press");

  // a real scroll is often only a few pixels before the finger settles: the
  // slop has to leave room for that or a normal flick would open the dialog
  reset();
  touch("touchstart", row.children[0], 40, 40);
  advance(200);
  touch("touchmove", row.children[0], 41, 48); // 8px: still a press
  advance(300);
  await settle();
  check(asks.length === 1, "a small wobble inside the slop still counts as a press");

  // lifting the finger ends the press
  reset();
  touch("touchstart", row.children[0]);
  advance(300);
  touch("touchend", row.children[0]);
  advance(1000);
  await settle();
  check(asks.length === 0, "letting go before the timer fires cancels the press");

  // two fingers are a pinch or a two-finger scroll, never a press
  reset();
  touch("touchstart", row.children[0], 40, 40, 2);
  advance(1000);
  await settle();
  check(asks.length === 0, "a multi-touch start is not a press on a message");
  touch("touchcancel", row.children[0]);

  // a press that began on a tool row is not a press on a message
  reset();
  touch("touchstart", toolRow.children[0]);
  advance(1000);
  await settle();
  check(asks.length === 0, "a long press on a tool row opens nothing");
  touch("touchend", toolRow.children[0]);

  // ---- 10) one gesture, one question: Chrome on Android fires contextmenu for
  // the long press too, and a second dialog over the first would be a trap ----
  reset();
  touch("touchstart", row.children[0]);
  advance(500);
  await settle();
  const afterPress = asks.length;
  rightClick(row.children[0]); // the platform's own contextmenu for the SAME press
  await settle();
  check(afterPress === 1 && asks.length === 1, "the platform's contextmenu on the same long press is the same gesture");
  advance(1000); // a genuinely new press
  // the successful rollback above re-read the anchors, and the server no longer
  // has this row's offset (its entries were just undone): drop the set so this
  // check is about the gesture window and not about the set
  set("rollbackAnchors = null;");
  rightClick(row.children[0]);
  await settle();
  check(asks.length === 2, "a later press opens its own question");

  // ---- 11) a request that fails says so, and does not claim to have rolled back ----
  reset({ rollbackAnswer: new Error("no recorded changes for that task") });
  rightClick(row.children[0]);
  await settle();
  check(filled.length === 0 && notices.length >= 1 && /roll back failed: no recorded changes/.test(notices[0].msg),
        "a refused rollback is reported as a failure, and the box is left as it was");
  check(anchorGets().length === 1, "a refusal re-reads the anchors: another window may have moved them");

  // a second gesture while the first request is in flight is not sent twice:
  // the dialog is answered but the server has not answered yet
  reset({ holdRollback: true });
  rightClick(row.children[0]);
  await settle();
  advance(1000); // a genuinely new gesture, so the same-gesture window is not what refuses
  rightClick(row.children[0]);
  await settle();
  check(rollbackPosts().length === 1, "a second gesture while the rollback is in flight is not sent");
  releaseRollback();
  await settle();
  check(rollbackPosts().length === 1 && filled.length === 1, "the in-flight rollback still finishes normally");

  // ---- 12) the wiring the page has to carry ----
  const uiDir = path.join(__dirname, "..", "ui");
  const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  const events = fs.readFileSync(path.join(uiDir, "js", "stream-events.js"), "utf8");
  const project = fs.readFileSync(path.join(uiDir, "js", "project.js"), "utf8");
  const mobile = fs.readFileSync(path.join(uiDir, "mobile.css"), "utf8");
  const iTask = html.indexOf('<script src="js/task-rollback.js"></script>');
  check(/<script src="js\/task-rollback\.js"><\/script>/.test(html), "the page loads task-rollback.js");
  check(html.indexOf('<script src="js/stream-events.js"></script>') < iTask &&
        html.indexOf('<script src="js/stream-view.js"></script>') < iTask,
        "it loads after the pane and the run state it reads (eventsEl, busy)");
  check(events.indexOf("autoFoldTurn();") !== -1 &&
        /autoFoldTurn\(\);[\s\S]{0,300}refreshRollbackAnchors\(\);/.test(events),
        "the end of a run re-reads the anchors, so its own message can be rolled back");
  check(/refreshRollbackAnchors\(\)/.test(project), "opening a project reads the anchors its replay can offer");
  check(/\.event\.user[^}]*user-select:\s*none/.test(mobile),
        "the platform's own long-press callout is suppressed on a message, so the press is ours");
  check(/user-select:\s*none[\s\S]{0,200}-webkit-touch-callout:\s*none|webkit-touch-callout:\s*none[\s\S]{0,200}user-select:\s*none/.test(mobile),
        "and the callout is disabled by its own property, not only by selection");
  check(vm.runInContext("LONG_PRESS_MS", ctx) >= 400 && vm.runInContext("LONG_PRESS_MS", ctx) <= 800,
        "the long press is in the range a finger feels as a press");

  summary("task-rollback");
}

main();
