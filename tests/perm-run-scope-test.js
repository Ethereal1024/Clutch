"use strict";

// A permission request_id belongs to ONE run: answering an ask must never mute
// the NEXT run's prompt.
//
// The reported bug (fixed twice before, still alive): the dialog stops appearing
// and the run hangs until Stop. What made it: an id is minted per RUN
// (agent/core/permission.py builds a gate per start_task; hosts before 0.1.31
// restarted their counter at 1 inside every gate, so "perm-1" named every run's
// first ask), while ui/js/permissions.js remembered the ids the WINDOW had
// answered for as long as the page lived. So run 2's first ask carried the id the
// user had already answered in run 1, openPerm returned on its first line, no
// dialog was ever drawn, the run stayed blocked in gate.require — which waits
// forever by design — and the only way out was Stop, which answers every pending
// ask "denied by user" (the reply that teaches the model the user said no).
//
// This runner drives the REAL renderer — openPerm / respondPerm / closePerm and
// the answered marks (js/permissions.js), addEvent / applyStreamEvent
// (js/stream-events.js), renderEvent / appendCompletion (js/render-events.js) —
// against stubs, so an edit that takes the run boundary out of the dedupe fails
// here instead of in a user's window:
//
//   1. a re-announced copy of a LIVE ask is still deduped (the mark still works)
//      while a different id is not muted by it;
//   2. a run's end dismisses the prompt it left waiting — and forgets the ids it
//      answered, so the next run's ask prompts again;
//   3. a live ask is never dropped because the pane happens to be "loading",
//      while the loading guard still drops a replayed status frame.

const { check, summary, slicer, uiModules } = require("./harness.js");

const mods = uiModules();
const src = mods.map((m) => m.code).join("\n");
const permsSrc = mods.find((m) => m.file === "js/permissions.js").code;
const streamSrc = mods.find((m) => m.file === "js/stream-events.js").code;
const renderSrc = mods.find((m) => m.file === "js/render-events.js").code;
const slice = slicer(src);

// ---- the page's DOM, reduced to what these paths touch ----
function fakeEl(tag) {
  const set = new Set();
  const el = {
    tag,
    className: "",
    textContent: "",
    innerHTML: "",
    children: [],
    removed: false,
    classList: {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (x) => set.has(x),
      toggle: (x, on) =>
        on === undefined ? (set.has(x) ? set.delete(x) : set.add(x)) : on ? set.add(x) : set.delete(x),
    },
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    querySelector: () => null,
    remove() {
      el.removed = true;
    },
    matches: () => false,
    addEventListener: () => {},
    setAttribute: () => {},
  };
  return el;
}

const nodes = new Map();
const el = (sel) => {
  if (!nodes.has(sel)) nodes.set(sel, fakeEl(sel));
  return nodes.get(sel);
};
global.$ = (sel) => el(sel);
global.els = { trust: fakeEl("button"), task: fakeEl("textarea") };
global.document = { createElement: (tag) => fakeEl(tag), addEventListener: () => {} };

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const statuses = [];
global.setStatus = (s) => statuses.push(s);
global.permReason = (r) => r;
global.extractCommand = () => null;
global.renderMarkdown = (s) => s; // the user_message row this runner walks through
global.closeModal = (m) => m.classList.add("hidden"); // every close ends up here
const posts = [];
global.apiFetch = async (url, opts) => {
  posts.push({ url, body: opts && opts.body });
  return {};
};

// ---- the streaming state addEvent and applyStreamEvent read ----
let loading = false;
global.stream = {
  classList: { contains: (c) => c === "loading" && loading },
  scrollHeight: 1000,
  scrollTop: 0,
};
global.eventsEl = fakeEl("div");
global.pageSink = null;
global.streamHighOffset = null;
global.oldestOffset = null;
global.olderRemaining = 0;
global.toolGroupEl = null;
global.lastTextEl = null;
global.lastTextContent = "";
global.thinkingEl = null;
global.thinkingContent = "";
global.textRenderRaf = 0;
global.thinkingRenderRaf = 0;
global.compactionEl = null;
global.retryNoteEl = null;
global.catchUp = false;
global.followTail = true;
global.gliding = false;
global.glideRaf = 0;
global.sseRunLostPending = false;
global.runSettled = true;
global.toolCalls = {};
global.setOlderPill = () => {};
global.flushTextRender = () => {};
global.flushThinkingRender = () => {}; // addEvent finalizes the reasoning block too
global.highlightCode = () => {};
global.typesetMath = () => {};
global.autoScroll = () => {};
global.setJumpVisible = () => {};
global.clearStream = () => {};
global.beginCatchUp = () => {};
global.endCatchUp = () => {};
global.clearStreamPreviews = () => {};
global.clearRetryNote = () => {};
global.refreshTree = () => {};
global.announceRunLost = () => {};

// ---- the real renderer, in ONE evaluation ----
//
// On the page these are classic scripts, so they share one global scope: a
// `let`/`const` at the top of js/permissions.js (pendingPerm, answeredPerm) is
// visible to the functions js/stream-events.js declares. Separate evals would
// NOT reproduce that (a sloppy indirect eval keeps its lexical declarations
// private and leaks only functions), so the modules are concatenated the way the
// page's script tags concatenate them — the marks stay private to the renderer,
// exactly as on the page, and are observed by BEHAVIOR, not by reaching in.
const renderer = [
  permsSrc.replace('"use strict";', ""), // the directive would privatize the declarations
  slice.fnBody("addEvent"),
  slice.fnBody("applyStreamEvent"),
  slice.fnBody("appendCompletion"),
  slice.fnBody("renderEvent"),
].join("\n\n");
(0, eval)(renderer);

// the prompt is open iff #perm-modal lost its "hidden" class — the only signal
// the page's own code gives, and the one the user sees
const promptOpen = () => !el("#perm-modal").classList.contains("hidden");
const promptTool = () => el("#perm-tool").textContent;

const ask = (id, tool) => ({
  type: "permission_request",
  request_id: id,
  tool: tool || "run_command",
  args_repr: '{"command": "rm -rf /tmp/x"}',
  reason: "permission ask",
});

async function main() {
  // ---- 1) a live ask draws the dialog ----
  addEvent(ask("perm-abc-1"));
  check(promptOpen(), "a live ask opens the prompt");
  check(promptTool() === "Tool: run_command — permission ask", `the prompt names the call (${promptTool()})`);

  // ---- 2) answering posts the verdict and closes it ----
  await respondPerm(true);
  check(posts.length === 1 && posts[0].body.request_id === "perm-abc-1", "the verdict is posted for that ask");
  check(!promptOpen(), "and the prompt closes");

  // ---- 3) a re-announced copy of that LIVE ask is not a second dialog ----
  // (permission.py REANNOUNCE_S / events.py re-deliver the same request_id while
  // it waits: the mark is what keeps that copy from re-prompting)
  addEvent(ask("perm-abc-1"));
  check(!promptOpen(), "a re-announced copy of the ask just answered stays silent");
  check(posts.length === 1, "no second verdict is sent for it");

  // ---- 3b) ...while a DIFFERENT id is not muted by that mark ----
  addEvent(ask("perm-abc-2"));
  check(promptOpen(), "a different request_id is a new ask, not a duplicate");
  await respondPerm(false);
  check(posts.length === 2 && posts[1].body.allow === false, "the deny verdict is posted");

  // ---- 4) the run ends: the waiting prompt goes, and so do the marks ----
  addEvent(ask("perm-abc-4"));
  check(promptOpen(), "a fresh ask waits");
  addEvent({ type: "final", status: "completed" });
  check(!promptOpen(), "the run's end dismisses the prompt it left waiting");
  check(posts.length === 2, "dismissal is not a verdict on it");
  // the next run's first ask, carrying an id the last run ANSWERED (what every
  // host before 0.1.31 did) must prompt again — this is the reported hang
  addEvent(ask("perm-abc-1"));
  check(promptOpen(), "the next run's ask with the id the last run used prompts again");
  await respondPerm(true);
  check(posts.length === 3, "and it is answerable");

  // ---- 5) a new task frame forgets the marks too (a missing final, a reload
  //         mid-run: the run boundary is honoured wherever it shows up) ----
  addEvent({ type: "user_message", content: "next task" });
  addEvent(ask("perm-abc-2")); // answered above, before the task frame
  check(promptOpen(), "a new task forgets the previous run's marks as well");
  await respondPerm(true);
  check(posts.length === 4, "and that ask is answerable too");

  // ---- 6) "loading" (the /api/project/open reconstruction) drops replayed
  //         status frames, but NEVER a live prompt ----
  addEvent({ type: "final", status: "completed" });
  loading = true;
  const before = statuses.length;
  addEvent({ type: "state_update", key: "execution_status", value: "running" });
  check(statuses.length === before, "a status frame during the loading reconstruction is still dropped");
  addEvent(ask("perm-abc-3", "write_file"));
  check(promptOpen(), "a live ask is shown even while the pane is loading");
  check(promptTool() === "Tool: write_file — permission ask", "with its own call attached");
  loading = false;
  await respondPerm(true);
  check(posts.length === 5, "and it can be answered");

  // ---- 7) no prompt means no verdict (a stray Enter/click answers nothing) ----
  await respondPerm(true);
  check(posts.length === 5, "answering with no prompt open posts nothing");

  // ---- 8) the wiring this runner relies on is the page's own ----
  check(
    /case "permission_request": \{[\s\S]{0,80}?openPerm\(ev\)/.test(renderSrc),
    "renderEvent routes permission_request to openPerm",
  );
  check(
    /if \(answeredPerm\.has\(ev\.request_id\)\) return;/.test(permsSrc),
    "openPerm keys its dedupe on the request_id the host minted",
  );
  check(
    /function forgetAnsweredPerm\(\)/.test(permsSrc) && /answeredPerm\.clear\(\)/.test(permsSrc),
    "the marks can be forgotten without touching the live-ask dedupe",
  );
  const finalBranch = streamSrc.slice(
    streamSrc.indexOf('if (ev.type === "final")'),
    streamSrc.indexOf('if (ev.type === "tool_call" && ev.tool_call_id)'),
  );
  check(/forgetAnsweredPerm\(\);/.test(finalBranch), "a run's end forgets the ids it answered");
  const userBranch = streamSrc.slice(
    streamSrc.indexOf('if (ev && ev.type === "user_message")'),
    streamSrc.indexOf("} else if (ev && ev.type === \"final\")"),
  );
  check(/forgetAnsweredPerm\(\);/.test(userBranch), "a task frame forgets them as well");
  check(
    /if \(stream\.classList\.contains\("loading"\) && ev\.type === "state_update"\)/.test(streamSrc),
    "the loading guard covers replayed status frames only — never a live prompt",
  );

  summary("perm-run-scope-test", "a new run's prompt is never muted by an id the last one used");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
