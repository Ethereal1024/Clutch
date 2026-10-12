// the finished turn, folded — the middle of a task you did not ask to re-read
//
// A task's transcript is the process: the calls it made, the results, the
// thinking, the compaction notes. What a reader comes back for is the two ends —
// what they asked and what came back. So when a task ends (the `final` event,
// ui/js/stream-events.js), everything between the task row and the task's closing
// answer folds into one row that says how much of it there is; the reader opens
// it whenever they want to audit the process. Nothing is dropped and nothing is
// re-fetched: the same nodes are moved into the same fold every collapsible row
// in this pane already uses (js/stream-text.js wrapFold), so opening it is the
// animation the reader knows.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// Fold this turn's middle. Called once per finished task, live or replayed: a
// replayed `final` folds the turn it closes exactly like a live one, which is
// what makes a reopened project read the same way it did when it was running.
function autoFoldTurn() {
  // The history pager renders older records into an off-DOM sink to measure and
  // prepend them in one pass (js/project.js loadOlder): folding THERE would build
  // rows the pane is about to be handed already-shaped, and the "one turn" this
  // function reasons about does not exist in a sink that holds a window of them.
  if (pageSink) return;
  if (!eventsEl) return;
  const kids = Array.from(eventsEl.children);

  // This turn, read off the transcript instead of guessed. appendCompletion put
  // THIS run's divider in the pane just before this call (js/stream-events.js),
  // so the turn is the region between the divider before that one and it. A
  // region is what makes the opener unambiguous: a run emits user rows of its
  // own (the max-tokens / empty-response notices are user_message events), and
  // the turn's OWN task is the first user row in the region, never the newest —
  // the newest is a notice, and anchoring on it would leave the turn unfolded.
  let turnEnd = kids.length; // exclusive: this run's own divider
  for (let i = kids.length - 1; i >= 0; i--) {
    if (kids[i].matches(".completion")) { turnEnd = i; break; }
  }
  let turnStart = 0;
  for (let i = turnEnd - 1; i >= 0; i--) {
    if (kids[i].matches(".completion")) { turnStart = i + 1; break; }
  }
  let start = -1;
  for (let i = turnStart; i < turnEnd; i++) {
    if (kids[i].matches(".event.user")) { start = i; break; }
  }
  if (start < 0) return; // a window that opens mid-turn: the task row was paged away
  const opener = kids[start];
  // folded already: a second `final` for the same turn (a reconnect replays one)
  // must not fold the fold, and must not re-collapse a fold the reader opened
  if (opener.dataset.turnFolded === "1") return;

  // the middle: everything between the task row and the turn's closing prose,
  // which is the answer and stays in plain sight — along with anything the run
  // did after it (a run that ended mid-flight keeps its last steps above the
  // divider, where the reader can see what it stopped on). With no prose at all (a failed
  // run, a task that only called tools) there is no answer to keep, and the whole
  // region folds — the divider and its reason are outside it either way.
  const rest = kids.slice(start + 1, turnEnd);
  let end = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].matches(".event.text")) { end = i; break; }
  }
  const mid = rest.slice(0, end);
  if (!mid.length) return; // task → answer: there is no middle to hide

  opener.dataset.turnFolded = "1"; // before the move: the rows are about to leave

  const wrap = document.createElement("div");
  wrap.className = "turn-fold";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "turn-fold-head";
  head.setAttribute("aria-expanded", "false");
  const caret = document.createElement("span");
  caret.className = "turn-fold-caret";
  caret.textContent = "▸";
  const label = document.createElement("span");
  label.textContent = `process · ${mid.length} ${mid.length === 1 ? "step" : "steps"}`;
  head.appendChild(caret);
  head.appendChild(label);

  // the fold starts OPEN and is closed just below: the rows are in their final
  // place for the one synchronous pass either way, so the open state is never
  // painted, and the close is the animation the reader sees (.fold is 0fr in CSS;
  // .open is 1fr — see ui/style.css and js/stream-text.js)
  const fold = document.createElement("div");
  fold.className = "fold open";
  const inner = document.createElement("div");
  inner.className = "fold-inner";
  fold.appendChild(inner);
  wrap.appendChild(head);
  wrap.appendChild(fold);

  // the wrapper takes the first folded row's place FIRST (insertBefore needs a
  // reference node still in the pane), and the rows then move in behind it: the
  // task row stays above the fold, the closing answer and the completion divider
  // stay below it
  eventsEl.insertBefore(wrap, mid[0]);
  const frag = document.createDocumentFragment();
  for (const el of mid) frag.appendChild(el); // moves each row out of the pane
  inner.appendChild(frag);
  head.onclick = () => {
    const wasHidden = toggleFold(fold);
    caret.textContent = wasHidden ? "▾" : "▸";
    head.setAttribute("aria-expanded", wasHidden ? "true" : "false");
  };

  // Collapse it. Live runs animate the close (the reader watched those rows
  // arrive); a replayed turn gets the end state at once — a project open must not
  // run one animation per turn of its history — and foldCollapse itself lands the
  // end state immediately for a reduced-motion reader.
  if (stream.classList.contains("loading")) {
    fold.classList.remove("open");
    fold.classList.add("hidden");
  } else {
    foldCollapse(fold);
  }
}
