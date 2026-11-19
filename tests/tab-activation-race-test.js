// Tab activation races (reported: "two tabs, both showing the other project").
//
// Opening a project is a long NDJSON replay, and a tab click can supersede it at
// any moment. Three invariants keep the one visible stream honest:
//   1. every activation takes a generation and aborts the previous fetch;
//   2. the previous tab's SSE is closed BEFORE the next replay starts (otherwise
//      its durable records land in the new pane);
//   3. only the current generation may mutate the view (clearStream,
//      setProjectInfo, addEvent, reconnectSSE, resumeTurn).
//
// Switching BACK to a tab must also restore only the byte range it had painted
// (memento oldest..high) after confirming the session still has that project,
// instead of replaying the whole file.
//
// Like the other renderer runners, this is a source contract: the functions are
// async, stateful and import the whole page, so the shapes are the tripwire.
// Run: node tests/tab-activation-race-test.js
const fs = require("fs");
const path = require("path");
const { check, summary, slicer } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const project = read("ui/src/renderer/project.ts");
const slots = read("ui/src/renderer/slots.ts");
const sse = read("ui/src/renderer/sse-stream.ts");
const tabBar = read("ui/src/renderer/tab-bar.ts");
const { fnBody } = slicer(project);

// ---- 1. activation generation + abort -----------------------------------------
{
  check(/let openSeq = 0;/.test(project), "one activation generation counter exists");
  check(/let openAbort: AbortController \| null = null;/.test(project),
    "the in-flight replay has an abort handle");
  const activate = fnBody("activateTab");
  check(/const seq = supersedeOpen\(\);/.test(activate),
    "activating a tab invalidates whatever replay was in flight");
  check(/closeSSE\(\);/.test(activate),
    "and closes the PREVIOUS tab's stream before the next replay starts");
  check(activate.indexOf("closeSSE()") < activate.indexOf("claimTab("),
    "the close happens before the claim/replay, not at its end");
  check(/const seq = supersedeOpen\(\);[\s\S]{0,400}closeSSE\(\);/.test(activate),
    "supersede and close are adjacent: no old stream survives the switch");
  check(/if \(same && opening && opening\.id === tab\.id\) return opening\.promise;/.test(activate),
    "a double click joins the open already in flight instead of replaying twice");
}

// ---- 2. only the current generation may paint ---------------------------------
{
  const open = fnBody("openInTab");
  check(/const ctl = new AbortController\(\);/.test(open) && /signal: ctl\.signal/.test(open),
    "the full replay is abortable at the transport");
  check(/if \(isStale\(seq\)\) return;/.test(open),
    "a superseded replay returns without touching the pane");
  const staleAt = open.indexOf("if (isStale(seq)) return;");
  const clearAt = open.indexOf("clearStream();");
  const metaAt = open.indexOf("setProjectInfo({");
  const finishAt = open.indexOf("finishOpen();");
  check(staleAt > -1 && staleAt < clearAt && staleAt < metaAt && staleAt < finishAt,
    "the generation is checked before clearing, painting, setting the project and reconnecting");
  check(/if \(isStale\(seq, e\)\) return;/.test(open),
    "a superseded or aborted replay says nothing (no 'Failed to open project' toast)");
  check((open.match(/isStale\(seq/g) || []).length >= 4,
    "the guard is applied at every await boundary, not once at the end");
}

// ---- 3. every entry point supersedes -------------------------------------------
{
  check(/export function showWelcome\(\) \{\s*\n\s*supersedeOpen\(\);/.test(project),
    "closing the last tab cancels a replay that would repaint after it");
  const create = fnBody("createProject");
  check(/const seq = supersedeOpen\(\);/.test(create) && /closeSSE\(\);/.test(create),
    "creating a project also supersedes and closes");
  check(/if \(isStale\(seq\)\) return;/.test(create),
    "and its answer may not paint over a newer tab");
}

// ---- 4. switching back restores the painted range, not the whole file ---------
{
  const restore = fnBody("restoreTabView");
  check(/apiFetch\("\/api\/session", \{ base \}\)/.test(restore),
    "the tail restore first asks WHICH project this session has open");
  check(/openPath !== \(tab\.projectKey \|\| tab\.path\)/.test(restore),
    "and refuses to paint another project's log when the session was replaced");
  check(/\/api\/history\?before=\$\{cursor\}&limit=\$\{RESTORE_PAGE_BYTES\}&align=turn/.test(restore),
    "it pages the visible byte range from the log instead of re-streaming the file");
  check(/const target = typeof m\.oldest === "number" \? m\.oldest : cursor - 1;/.test(restore),
    "the range ends at the oldest record the tab had painted");
  check(/for \(let i = pages\.length - 1; i >= 0; i--\)/.test(restore),
    "backward pages are painted oldest-first");
  check(/if \(isStale\(seq\)\) return true;/.test(restore),
    "a newer activation stops the restore mid-paint");
  check(/if \(await restoreTabView\(tab, base, seq\)\) return;/.test(fnBody("activateTab")),
    "activation tries the tail restore befor the full open");
  check(/await openInTab\(tab, base, readOnly, seq\);/.test(fnBody("activateTab")),
    "a first visit (or a replaced session) still takes the full open");
}

// ---- 5. the memento carries the range -----------------------------------------
{
  check(/oldest: state\.oldestOffset,/.test(slots), "the memento records the oldest painted offset");
  check(/older: typeof extra\.older === "number" \? extra\.older : 0,/.test(slots),
    "and the unloaded-byte count the older pill had");
  check(/workdir: extra\.workdir \|\| ""/.test(slots), "and the workdir the tree showed");
  check(/saveMemento\(prev\.id, \{ older: olderRemaining, workdir: els\.workspace\.textContent \|\| "" \}\)/.test(fnBody("activateTab")),
    "activation saves that range when leaving a tab");
  // the other way out of a tab is creating a project in a new one, and it leaves
  // the same tab behind: the memento AND the badge watcher that keeps a run
  // behind it honest (nothing else is listening to that session any more)
  check(/const prev = activeTab\(\);[\s\S]*?if \(prev\.running\) watchTab\(prev\);/.test(fnBody("createProject")),
    "and creating a project in a new tab leaves the old one the same way — its memento, and its run's watcher");
  check(/localStorage\.setItem\(MEMENTO_KEY\(slotId\)/.test(slots) &&
    /return mementos\.get\(slotId\) \|\| readStoredMemento\(slotId\);/.test(slots),
    "the range is persisted per tab id, so a page reload can restore the tail too (guarded by /api/session)");
}

// ---- 6. a restored store cannot give two tabs one slot ------------------------
{
  check(/seenId\.has\(t\.id\)/.test(tabBar) && /seenPath\.has\(t\.path\)/.test(tabBar),
    "restored tabs are deduped by id (one slot) and by path (one writer)");
}

summary("tab-activation-race-test.js");
