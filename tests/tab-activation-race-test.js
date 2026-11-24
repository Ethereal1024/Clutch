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
  check(/if \(same && opening && opening\.id === tab\.id\) \{\s*await opening\.promise;/.test(activate),
    "a double click joins the open already in flight instead of replaying twice");
  // one landing point: an activation's state is applied where the activation ends,
  // and only while it is still the current one
  check((activate.match(/apply\(/g) || []).length === 1 &&
        /if \(next && !isStale\(seq\)\) apply\(next\);/.test(activate),
    "and a superseded activation paints nothing: its state lands at one checked point");
}

// ---- 2. only the current generation may paint ---------------------------------
{
  const open = fnBody("openInTab");
  check(/const ctl = new AbortController\(\);/.test(open) && /signal: ctl\.signal/.test(open),
    "the full replay is abortable at the transport");
  check(/if \(isStale\(seq\)\) return null;/.test(open),
    "a superseded replay returns without touching the pane");
  const staleAt = open.indexOf("if (isStale(seq)) return null;");
  const clearAt = open.indexOf("clearStream();");
  const metaAt = open.indexOf("setProjectInfo({");
  const finishAt = open.indexOf("finishOpen();");
  check(staleAt > -1 && staleAt < clearAt && staleAt < metaAt && staleAt < finishAt,
    "the generation is checked before clearing, painting, setting the project and reconnecting");
  check(/if \(isStale\(seq, e\)\) return null;/.test(open),
    "a superseded or aborted replay says nothing (no 'Failed to open project' toast)");
  check((open.match(/isStale\(seq/g) || []).length >= 4,
    "the guard is applied at every await boundary, not once at the end");
  // A failed open does not paint: it RETURNS the state the pane must show, and
  // the activation applies that once, at its end. This is why no failure path can
  // leave a load card standing over an open that is over.
  check(/catch \(e\) \{[\s\S]*return paneBlocked\(/.test(open) &&
        !/\bfinally\b/.test(open),
    "a failed open hands its state back instead of painting it where it stands");
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

// ---- 4. switching back restores the log's TAIL, not the gap the tab left ------
{
  const restore = fnBody("restoreTabView");
  check(/apiFetch\("\/api\/session", \{ base, signal \}\)/.test(restore),
    "the tail restore first asks WHICH project this session has open");
  check(/openPath !== \(tab\.projectKey \|\| tab\.path\)/.test(restore),
    "and refuses to paint another project's log when the session was replaced");
  check(/\/api\/history\?before=\$\{cursor\}&limit=\$\{RESTORE_PAGE_BYTES\}&align=turn/.test(restore),
    "it pages the visible byte range from the log instead of re-streaming the file");
  check(/const tail = mem && typeof mem\.bytes === "number"/.test(restore) &&
        /let cursor = tail === null \? m\.high \+ 1 : tail;/.test(restore),
    "the range STARTS at the log's tail (/api/session's memory.bytes), not at the offset " +
    "the tab was left on: what the project wrote while the tab was away is newer than its " +
    "memento, and restoring only [oldest, high] handed exactly that to the reconnect");
  check(/const target = typeof m\.oldest === "number" \? m\.oldest : m\.high;/.test(restore),
    "and it ends where the tab's painted range began, so the gap is painted BEHIND the card " +
    "instead of bursting into a pane that is already on screen");
  check(/await typesetProgressively\(eventsEl/.test(restore),
    "the restored math is typeset on the same phase the full replay uses");
  check(/for \(let i = pages\.length - 1; i >= 0; i--\)/.test(restore),
    "backward pages are painted oldest-first");
  check(/const ctl = new AbortController\(\);\s*\n\s*viewAbort = ctl;/.test(restore) &&
        /\{ base, signal \}/.test(restore),
    "the walk's own requests are cancellable, so a superseded restore stops pulling pages " +
    "off the tunnel instead of stacking behind the next switch");
  check(/if \(viewAbort\) \{\s*\n\s*try \{\s*\n\s*viewAbort\.abort\(\);/.test(fnBody("supersedeOpen")),
    "and the next tab click is what aborts them");
  check(/if \(isStale\(seq\)\) return true;/.test(restore),
    "a newer activation stops the restore mid-paint");
  check(/if \(await restoreTabView\(tab, base, seq\)\) return isStale\(seq\) \? null : paneTab\(tab\.id\);/.test(fnBody("activateTab")),
    "activation tries the tail restore befor the full open");
  check(/return await openInTab\(tab, base, readOnly, seq\);/.test(fnBody("activateTab")),
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

// ---- 7. a cached switch paints BEFORE it claims -------------------------------
//
// The reported bug: switching between two tabs on this machine always flashed
// the load card for at least one IPC round trip, even with a DOM cache, because
// the card was painted first and the cache restored after the claim. The cache
// is synchronous and DOM-only, so it has to go up before anything is awaited.
{
  const activate = fnBody("activateTab");
  const paint = fnBody("paintCachedView");
  check(/const cached = paintCachedView\(tab\);\s*\n\s*if \(!cached\) beginPaneLoad\(tab\);/.test(activate),
    "the cached picture goes up before the claim, and only a tab with no cache shows the load card");
  check(activate.indexOf("paintCachedView(tab)") < activate.indexOf("claimTab(tab)"),
    "and that order is the one that matters: nothing awaited may come first");
  check(/if \(tab\.machine && !hopUpFor\(tab\)\) return false;/.test(paint),
    "a tab that names a MACHINE keeps the card only while its claim still has to DIAL — conn-flow reports that " +
    "attempt there; a tab already on its hop is the instant path like any local one (it used to keep the card " +
    "always, which is the remote tab that rebuilt itself from the network on every switch back)");
  check(/if \(!restoreDomCache\(tab\.id\)\) return false;/.test(paint) && /setProjectInfo\(\{/.test(paint) &&
        /setOlderPill\(m\.older\)/.test(paint),
    "the cache itself is DOM-only (no await), and it carries this tab's workdir and older pill with it");
  check(/if \(cached\) \{\s*finishOpen\(\);\s*return paneTab\(tab\.id\);/.test(activate),
    "the claim that follows only buys the SSE base: no second restore replays what is already painted");
  check(!/restoreDomCache\(tab\.id\)\) \{/.test(activate),
    "and the old restore-after-the-claim branch is gone, so a cached switch cannot land twice");
  check(/\[data-view\]/.test(require("fs").readFileSync(path.join(ROOT, "ui/src/renderer/pane.ts"), "utf8")),
    "visibility is still the pane's single decision (pane.ts), not a z-index race in this flow");
}

summary("tab-activation-race-test.js");
