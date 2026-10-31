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
// Not every turn ends with an answer. A session released mid-run, a run the window
// saw fail: the transcript stops where it stood, and what the window has drawn so
// far is the process of a turn whose end it cannot see. Those rows fold too — at
// the moment the session goes away (foldOpenTurn), not when some later run
// finally ends, which was the report against a window left with the whole
// disconnected stretch expanded — and the fold is left OPEN: the user's next
// message does not start a new task, it carries the SAME turn on, so everything
// between the interruption and the answer the turn finally lands on joins that
// fold, and the block ends up hanging off the original instruction and sitting
// directly above the answer, exactly like a turn that was never interrupted. The
// statuses that end a turn are `completed` and `aborted` (the user's own Stop);
// every other ending is an interruption (turnEnded, turnSpan, mergeOpenFold).
//
// A turn only folds while it is in the pane. Two other ways its rows reach the
// reader are covered here as well: a replayed project — the same `final` events,
// replayed into the same pane — and a page of older records paged in above the
// window, which can arrive carrying the front half of a turn whose divider this
// window already had (foldClosedRegions at the bottom). That turn is often folded
// ALREADY, under the row the window happened to start on, and a page that brings
// its own task row completes it: the fold is then completed too, never folded
// again (absorbIntoRegion).
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// what a fold's head says about what it hides: one row of the middle, one step —
// recomputed when a page adds rows to a fold that is already on screen
function foldLabel(n) {
  return `process · ${n} ${n === 1 ? "step" : "steps"}`;
}

// Did this ending finish the turn? `completed` is the answer the task landed on,
// and `aborted` is the user's own Stop — what they stopped is over, and the next
// message is a new task. Everything else ends a turn nobody asked to end: the
// error a released session writes for a run in flight (agent/server.py
// record_release), a run the window saw fail. Those turns are INTERRUPTED, and
// the next run carries the same one on (turnSpan, mergeOpenFold) instead of
// opening a new one.
function turnEnded(status) {
  const s = String(status || "").trim();
  return s === "completed" || s === "aborted";
}

// Where the turn that ends at `turnEnd` really begins: its own region, widened
// back over every interruption divider above it. A divider only ends a turn when
// it says so (turnEnded); an interruption closed nothing, so the region below it
// is the rest of the turn above, and folding it as its own would anchor the block
// on the message that carried the turn on rather than on the instruction that
// started it — the reported shape: the interrupted stretch left expanded above a
// fold that hung off the continuation.
//
// Each step lands on the index just after the divider above the one it stepped
// over, so the invariant "the span starts after a divider, or at the pane's first
// row" holds and the walk always terminates.
function turnSpan(kids, turnEnd) {
  let span = 0;
  for (let i = turnEnd - 1; i >= 0; i--) {
    if (kids[i].matches(".completion")) { span = i + 1; break; }
  }
  while (span > 0) {
    const above = kids[span - 1];
    if (!above.matches(".completion") || turnEnded(above.textContent)) break;
    let from = 0;
    for (let i = span - 2; i >= 0; i--) {
      if (kids[i].matches(".completion")) { from = i + 1; break; }
    }
    span = from;
  }
  return span;
}

// The fold an interrupted turn was left in, among the rows of its span: the one
// a later ending adds its rows to (mergeOpenFold). Open folds only — a finished
// fold in the same rows is a turn of its own that a page of history has already
// completed, and absorbIntoRegion is what takes new rows for that one.
//
// There is at most ONE open fold in a pane, and it is the newest: every ending
// reaches back through the interruptions above it (turnSpan) and closes the open
// fold it finds (mergeOpenFold), so an interrupted block cannot outlive the next
// ending of any kind, and a second one cannot be made beside it. That is why the
// first open fold is also the right one.
function openFoldAt(kids, from, to) {
  for (let i = from; i < to; i++) {
    if (kids[i].matches(".turn-fold") && kids[i].dataset.turnOpen === "1") return i;
  }
  return -1;
}

// Fold this turn's middle, folding the one region of `root` that ends at
// `turnEnd`: the index, in root's children, of the divider that closed the turn.
// `root` is the pane for a live or replayed `final`, and the pane again for the
// regions a paged-in history has just handed back — never the off-DOM sink the
// pager renders into, whose rows are about to move.
//
// A region, read off the transcript instead of guessed. appendCompletion put THIS
// run's divider in the pane just before this is called (js/stream-events.js), so
// the turn is the region between the divider before that one and it. A region is
// what makes the opener unambiguous: a run emits user rows of its own (the
// max-tokens / empty-response notices are user_message events), and the turn's
// OWN task is the first user row in the region, never the newest — the newest is a
// notice, and anchoring on it would leave the turn unfolded.
function foldRegion(root, turnEnd) {
  const kids = Array.from(root.children);
  // the ending this region closes on: a divider, except for a turn that is still
  // in flight (foldOpenTurn folds one that has no ending yet)
  const divider = kids[turnEnd] && kids[turnEnd].matches(".completion") ? kids[turnEnd] : null;
  // The turn this region belongs to, which is not always "everything since the
  // divider above it": an interruption closed nothing, so the region a later
  // ending closes can span several of them (turnSpan).
  const span = turnSpan(kids, turnEnd);
  // The fold this turn ALREADY has and an interruption left open: this ending is
  // the rest of that turn, not a new task's (mergeOpenFold). It is looked for by
  // the fold's own mark rather than by the divider's, because an interrupted fold
  // has no ending of its own — its divider is one of the rows it took in.
  const openAt = openFoldAt(kids, span, turnEnd);
  if (openAt >= 0) {
    mergeOpenFold(root, openAt, turnEnd, divider);
    return;
  }
  // What "this region is folded" is recorded on is the DIVIDER, not the head. The
  // divider is the one node in the region a fold never moves, so its mark survives
  // everything a fold does; a head does not — the pane's first region is folded
  // under whatever row the window happened to start on (the compaction notice
  // below), and a page of history that brings the turn's real task row moves that
  // head up. Keyed on the head, the next pass missed the fold entirely and built a
  // second one AROUND it: a fold inside a fold, its inner head buried in a
  // `display: none` subtree, its step count counting the inner fold as one step
  // (ui-fix.clc, the second press of "load earlier records").
  if (divider && divider.dataset.turnFolded === "1") {
    absorbIntoRegion(root, span); // the rows a page just brought still belong in it
    return;
  }
  let start = -1;
  for (let i = span; i < turnEnd; i++) {
    if (kids[i].matches(".event.user")) { start = i; break; }
  }
  // No task row in the region means one thing only: the pane starts INSIDE this
  // turn. cpr_start is the newest compaction line (agent/core/lazy.py) and a
  // compaction fires while a run is working, so a reopened project's first turn
  // is the one that was running when the context filled — its task row is above
  // the window and cannot be paged in backwards from here. Reading that as "no
  // turn" left the top of every reopened project unfolded, next to a divider that
  // said `completed` while the turn just below it (whose task row is inside the
  // window) folded: two identical endings, one fold. That asymmetry is the report
  // against ui-fix.clc (996–1051 folded, 878–995 did not, both `completed`).
  //
  // The region still has a head — the row the pane itself starts on — and the
  // middle under it is as re-readable as any other turn's, so the fold hangs off
  // that head. It stays in plain sight: it is the compaction notice that says why
  // the window begins here, and it takes the place the task row takes in a turn
  // that has one. Only the pane's FIRST region is read this way: a region in the
  // middle of the transcript with no task row is a shape this file does not
  // recognize, and guessing on one is what this early return is for.
  if (start < 0) {
    if (span !== 0) return;
    start = span;
  }
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
  // one glyph for both states: the quarter turn that makes it point down is
  // `transform: rotate(90deg)` under `[aria-expanded="true"]` (ui/style.css), so
  // the caret keeps its advance width and the label never shifts under the
  // reader's finger — a glyph SWAP cannot be transitioned, and this one moves
  // with the fold it opens. The state it is drawn from is the attribute below,
  // which is also what a screen reader reads. The glyph itself is the icon face's
  // FILLED triangle rather than the `▸` the other fold toggles in this pane use:
  // that one is drawn 3x4px at 12px and this caret is the only control a whole
  // block of the transcript hangs off (ui/style.css has the sizes).
  caret.textContent = "▶";
  const label = document.createElement("span");
  label.textContent = foldLabel(mid.length);
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
  // The rows sit one level deeper than the clip: `.fold-inner` clips, and
  // `.fold-body` is what the close SLIDES (up by its own height, js/stream-text.js
  // foldAnim) so the last row stays glued to the shrinking box's bottom edge instead
  // of being sliced off at the crop line — the rows leave under the hanging head.
  // It is the only thing that can move there: a transform on the box would carry the
  // clip window with it and leave a gap where the rows were.
  const body = document.createElement("div");
  body.className = "fold-body";
  inner.appendChild(body);
  fold.appendChild(inner);
  wrap.appendChild(head);
  wrap.appendChild(fold);

  // the wrapper takes the first folded row's place FIRST (insertBefore needs a
  // reference node still in `root`), and the rows then move in behind it: the
  // task row stays above the fold, the closing answer and the completion divider
  // stay below it
  root.insertBefore(wrap, mid[0]);
  const frag = document.createDocumentFragment();
  for (const el of mid) frag.appendChild(el); // moves each row out of the pane
  body.appendChild(frag);
  // where the fold keeps the two things a later page needs to add to: the rows it
  // holds (absorbIntoRegion prepends to them) and the count in its head
  wrap._body = body;
  wrap._label = label;
  head.onclick = () => {
    // toggleFold answers with where the fold is GOING, not with the class list it
    // is passing through: mid-flight a second click reverses the move instead of
    // re-running it, and the caret/attribute follow the answer either way.
    const open = toggleFold(fold);
    head.setAttribute("aria-expanded", open ? "true" : "false");
  };

  // Collapse it. Live runs animate the close (the reader watched those rows
  // arrive); a replayed turn gets the end state at once — a project open must not
  // run one animation per turn of its history — and foldCollapse itself lands the
  // end state immediately for a reduced-motion reader.
  if (foldsLandClosed()) {
    fold.classList.remove("open");
    fold.classList.add("hidden");
  } else {
    foldCollapse(fold);
  }
  // The region is folded, and the mark goes on its divider (see the top of this
  // function): a page that completes this turn is then a page that ADDS to the
  // fold, not one that folds it again.
  if (divider) divider.dataset.turnFolded = "1";
  // ...and if that ending was an interruption (or there is none yet: the turn is
  // still in flight), the fold is left OPEN. The mark is what the next ending
  // looks for: unmarked, the fold below would be treated as a finished turn of its
  // own and the rows that carry the turn on would fold into a SECOND block hanging
  // off the message that continued it. Marked, they join this one (mergeOpenFold).
  if (!turnEnded(divider ? divider.textContent : "")) wrap.dataset.turnOpen = "1";
  // The block is a row of the pane now, and where its head sits against the pane's
  // top edge is a state nothing else has announced: with the block already scrolled
  // past (a long turn folding under a reader who is inside it) the head pins on this
  // frame, not on the next scroll event (js/stream-text.js paintStuck).
  queueStuck();
}

// The rest of an interrupted turn, after a fold has already been made for its
// beginning: the ending the turn stopped on, the message the user carried it on
// with, and every step either of them drew go into that fold's body — and the
// fold is re-seated where the turn's visible tail begins, directly above the
// answer the turn finally landed on (or above the ending when it stopped without
// one, so the reason a run is not going on stays readable).
//
// What the reader ends up with is one block, hanging off the instruction that
// started the task rather than off the message that continued it, with the two
// ends of the turn — that instruction and the answer — in plain sight around it,
// which is the shape of a turn that was never interrupted at all.
//
// Nothing here invents an ending: the divider that just landed is the log's own,
// so a session that comes back and states how the run ended, and a run that fails
// without the window noticing, are both just the next ending of the same turn.
function mergeOpenFold(root, foldAt, turnEnd, divider) {
  const kids = Array.from(root.children);
  const wrap = kids[foldAt];
  const rest = kids.slice(foldAt + 1, turnEnd);
  // the tail that stays in plain sight: the turn's closing prose if there is any
  // — the answer, which the completed divider follows. With no prose at all the
  // whole stretch is process (the ending that stopped it is the divider this call
  // was made for, and it and its reason are outside `rest` by construction).
  let end = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].matches(".event.text")) { end = i; break; }
  }
  const add = rest.slice(0, end);
  if (add.length) {
    // file order: the body gains these rows at its END (absorbIntoRegion is the
    // one that prepends, for rows that arrive above the fold)
    const frag = document.createDocumentFragment();
    for (const el of add) frag.appendChild(el);
    wrap._body.appendChild(frag);
    if (wrap._label) wrap._label.textContent = foldLabel(wrap._body.children.length);
  }
  // the fold ends where the turn's middle ends: the answer (or the ending that
  // stopped it) is the row directly under the block now — and the head it hangs
  // on never moved, so the block still starts at the original instruction
  const tail = rest[end] || null;
  if (tail) root.insertBefore(wrap, tail);
  // The ending this ending closes is the log's own record either way; the mark
  // that says "this turn is folded" goes on it, exactly as foldRegion puts it
  // there, so a page of history and a replayed final still add to this fold
  // instead of building a second one.
  if (divider) divider.dataset.turnFolded = "1";
  // finished only on an answer or on the user's own Stop: another interruption
  // leaves the fold open for the run that carries on from it
  if (turnEnded(divider ? divider.textContent : "")) delete wrap.dataset.turnOpen;
  queueStuck(); // the block moved: recompute whether its head pins
}

// A folded region can still gain rows — above itself, one page at a time. A page
// prepends, so the head a fold hangs on can only ever gain PREDECESSORS; the fold
// itself never needs to move down. What it does need is to take those rows in: they
// are the same turn's middle, which is one region with one head, and a second fold
// over the first is exactly the shape this function exists to prevent.
//
// The rows between the head and the fold go into the fold's body, at its top, in
// file order; the fold is then re-seated directly under the head, which is how a
// fold that hung on the compaction notice ends up hanging on the turn's own task row
// once the page brings it (`divider.dataset.turnFolded` is what got us here, so the
// divider's own row never moves and the caller's index is still good).
function absorbIntoRegion(root, turnStart) {
  const kids = Array.from(root.children);
  const at = kids.findIndex((el, i) => i >= turnStart && el.matches(".turn-fold"));
  if (at < 0) return; // no fold among this region's rows: nothing to add to
  const wrap = kids[at];
  // the head: the region's first user row — the same rule foldRegion applies, and
  // the same one relaxation for the pane's own first region, where the row the
  // window starts on takes the place a task row takes
  let head = -1;
  for (let i = turnStart; i < at; i++) {
    if (kids[i].matches(".event.user")) { head = i; break; }
  }
  if (head < 0 && turnStart === 0) head = 0;
  if (head < 0 || at - head < 2) return; // the fold is already flush under its head

  const loose = kids.slice(head + 1, at);
  root.insertBefore(wrap, kids[head + 1]); // up, under the head the page completed
  // each row goes in at the BODY's top, so they go in from the back: prepending
  // forward would hand the body the region's rows in reverse file order
  for (let i = loose.length - 1; i >= 0; i--) {
    const el = loose[i];
    wrap._body.insertBefore(el, wrap._body.children[0] || null);
  }
  // the head row the fold hung on before is one of `loose` when the page replaced it
  // (the compaction notice now sits in the middle it explains): the mark moves with
  // the head, so a second pass over this region still finds it folded
  for (const el of loose) delete el.dataset.turnFolded;
  kids[head].dataset.turnFolded = "1";
  if (wrap._label) wrap._label.textContent = foldLabel(wrap._body.children.length);
  queueStuck(); // the head moved with the block: recompute whether it pins
}

// Fold this run's turn: the region that ends at the pane's newest divider. Called
// once per finished task, live or replayed — a replayed `final` folds the turn it
// closes exactly like a live one, which is what makes a reopened project read the
// same way it did when it was running.
function autoFoldTurn() {
  // The history pager renders older records into an off-DOM sink to measure and
  // prepend them in one pass (js/project.js loadOlder): folding THERE would build
  // rows the pane is about to be handed already-shaped, and the "one turn" this
  // function reasons about does not exist in a sink that holds a window of them.
  // What the sink therefore could not fold is folded after the prepend, by
  // foldClosedRegions below.
  if (pageSink) return;
  if (!eventsEl) return;
  const kids = Array.from(eventsEl.children);
  let turnEnd = kids.length; // exclusive: this run's own divider
  for (let i = kids.length - 1; i >= 0; i--) {
    if (kids[i].matches(".completion")) { turnEnd = i; break; }
  }
  foldRegion(eventsEl, turnEnd);
}

// Fold the turn that is still IN FLIGHT, and leave it open.
//
// Called when the session the run lived in is gone (js/backend-lifecycle.js
// dropStaleBackend announces it as clutch:turn-interrupted): no ending is coming
// to the window that drew these rows, and leaving them expanded until some later
// run finally ends meant the disconnected stretch of a turn never folded at all —
// the report. So the rows the window did receive fold now, and the fold says
// "this is process" and nothing more.
//
// The ending is deliberately NOT invented here. The departing session writes its
// own (agent/server.py record_release) and the window reads it from the log when a
// session answers again; a window that invented one would show two, and it would
// be guessing at the one fact it cannot see. What the open fold buys is that
// whenever that ending does arrive — or the user simply carries the turn on with
// another message — it joins this fold instead of starting a second turn
// (mergeOpenFold).
function foldOpenTurn() {
  if (pageSink) return;
  if (!eventsEl) return;
  const kids = Array.from(eventsEl.children);
  // nothing in flight: the pane already ends on a divider
  if (!kids.length || kids[kids.length - 1].matches(".completion")) return;
  // the turn ends at the pane's end: there is no divider to fold up to, and
  // foldRegion reads that as what it is — a turn with no ending yet
  foldRegion(eventsEl, kids.length);
}

// Every region of `root` that is closed already, in one pass: the pane after the
// history pager has prepended a page into it. That page can carry the end of a
// turn this window opened in the middle of — cpr_start is the newest compaction
// line (agent/core/lazy.py) and a compaction fires while a run is working, so the
// window's first region is a turn whose task row is above the window, and its
// `final` landed while the sink was the render target and folding was refused. The
// dividers are the regions' ends — the one node the fold never moves — so they are
// the handles. Each is looked up again by identity, because folding the region
// before it moved its rows out of root and shifted every index under it.
function foldClosedRegions(root) {
  if (!root) return;
  const ends = Array.from(root.children).filter((el) => el.matches(".completion"));
  for (const divider of ends) {
    const at = Array.from(root.children).indexOf(divider);
    if (at >= 0) foldRegion(root, at);
  }
}

// Does a fold land closed without animating? A live run animates (the reader
// watched those rows arrive); a replayed project open lands every fold of its
// history at once, and folding a page of prepended history is that same replay.
// It must be instant there for a second reason: the pager measures the fold it
// just made to re-anchor the view (js/project.js loadOlder), and an animation still
// in flight would carry the rows out from under that measurement.
function foldsLandClosed() {
  return stream.classList.contains("loading") || paging;
}

// The pager cannot call foldClosedRegions: the page loads js/project.js before
// this file, and a classic script may only name what the files above it declared
// (tests/ui-load-order-test.js pins that). So loadOlder announces the prepend by
// name and the folding happens here, where the pane's shape is known.
if (eventsEl) eventsEl.addEventListener("clutch:page-prepended", () => foldClosedRegions(eventsEl));
// The same door, for the same reason: js/backend-lifecycle.js drops a dead session
// and loads before this file, so it announces that the run's session is gone and
// the fold of the turn it was running happens here (foldOpenTurn).
if (eventsEl) eventsEl.addEventListener("clutch:turn-interrupted", () => foldOpenTurn());
