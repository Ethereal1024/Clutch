// the finished turn, folded — the middle of a task you did not ask to re-read
//
// A task's transcript is the process: the calls it made, the results, the
// thinking, the compaction notes. What a reader comes back for is the two ends —
// what they asked and what came back — and the prose the run speaks on the way.
// So the prose (the `.event.text` rows) stays in plain sight and SPLITS the turn
// into segments: every run of process rows between two pieces of prose folds into
// its own row that says how much of it there is, whether the turn has ended or is
// still running. The reader opens a block whenever they want to audit the process
// behind the text around it. Nothing is dropped and nothing is re-fetched: the
// same nodes are moved into the same fold every collapsible row in this pane
// already uses (js/stream-text.js wrapFold), so opening it is the animation the
// reader knows.
//
// A turn is foldable WHILE it is still running, too, and the prose a run speaks
// mid-run cuts it into the same segments: each run of process rows between two
// pieces of prose gets its own block, built the first time that segment draws a
// process row and filled in as the rows arrive. A reader who folds one mid-run
// gets a ring in its head saying the run has not finished (the "the turn still
// drawing into the pane" section below, foldLiveRow and after).
//
// Not every turn ends with an answer. A session released mid-run, a run the window
// saw fail: the transcript stops where it stood, and what the window has drawn so
// far is the process of a turn whose end it cannot see. Those rows fold too — at
// the moment the session goes away (foldOpenTurn), not when some later run
// finally ends, which was the report against a window left with the whole
// disconnected stretch expanded — and the fold is left OPEN: the user's next
// message does not start a new task, it carries the SAME turn on, so the run that
// continues it draws into that same fold — everything between the interruption and
// the next piece of prose joins it — and the block ends up hanging off the
// original instruction and sitting directly above the prose that follows, exactly
// like a turn that was never interrupted. The statuses that end a turn are
// `completed` and `aborted` (the user's own Stop); every other ending is an
// interruption (turnEnded, turnSpan, mergeOpenFold).
//
// A turn only folds while it is in the pane. Two other ways its rows reach the
// reader are covered here as well: a replayed project — the same `final` events,
// replayed into the same pane — and a page of older records paged in above the
// window, which can arrive carrying the front half of a turn whose divider this
// window already had (foldClosedRegions at the bottom). That turn is often folded
// ALREADY, under the row the window happened to start on, and a page that brings
// its own task row completes it: the fold is then completed too, never folded
// again (foldSegmentRows).
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
// completed, and foldSegmentRows is what takes new rows for that one.
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

// The turn's own head, among the rows `[span, to)`: its FIRST user row. A run
// emits user rows of its own (the max-tokens / empty-response notices are
// user_message events) and an interruption leaves the message that carried the
// turn on below its divider, so the scan stops at the first divider or block it
// meets — past one of those, a user row is never the turn's task, and anchoring on
// it would hang the fold off the continuation instead of the instruction (the
// reported shape). The pane's FIRST region relaxes to the row the pane itself
// starts on: cpr_start is the newest compaction line (agent/core/lazy.py) and a
// compaction fires while a run is working, so a reopened project's first turn has
// its task row above the window for good (foldRegion's notice). Everywhere else a
// region with no task row is a shape this file does not recognize: -1, and the
// caller leaves it alone.
function turnHead(kids, span, to) {
  for (let i = span; i < to; i++) {
    if (kids[i].matches(".event.user")) return i;
    if (kids[i].matches(".completion") || kids[i].matches(".turn-fold")) break;
  }
  return span === 0 ? 0 : -1;
}

// Where the segment a row belongs to begins: after the prose (holdsTheLine) the
// run last spoke strictly between the turn's head and that row. Prose splits the
// turn, so what comes after it is the NEXT segment and folds on its own; with no
// prose in between, the segment starts right under the head. Never above the head:
// the turn's instruction is not part of any middle.
function segmentFrom(kids, head, at) {
  for (let i = at - 1; i > head; i--) {
    if (holdsTheLine(kids[i])) return i + 1;
  }
  return head + 1;
}

// The block itself: the head the reader presses, the fold it opens, and the rows
// that go inside it — in the place `ref` held, which is the first row of the middle.
// One builder because there are two moments that make a block out of the same parts:
// a turn's ending (foldRegion), and a run still drawing rows into the pane
// (openRunBlock), and the second one has to leave exactly the shape the first one
// would have made or the ending's merge would re-order what the reader watched.
//
// The wrapper takes the first folded row's place FIRST (insertBefore needs a
// reference node still in `root`), and the rows then move in behind it: the rows
// above the middle (the task, or the prose a live block was opened under) stay where
// they are, and everything the turn goes on to draw stays below the block.
function buildFold(root, ref, rows) {
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
  label.textContent = foldLabel(rows.length);
  // The mark of a run that is still going, drawn where the label runs out. No
  // text: a block the reader folded while the session is running has to be able to
  // tell them it is still filling in, and the count beside it says how much is in
  // there, not that more is on the way (ui/style.css draws it, and only for the
  // closed state of a live block).
  const spin = document.createElement("span");
  spin.className = "turn-fold-spin";
  spin.setAttribute("aria-hidden", "true");
  head.appendChild(caret);
  head.appendChild(label);
  head.appendChild(spin);

  // the fold starts OPEN and is closed by the caller: the rows are in their final
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

  root.insertBefore(wrap, ref);
  const frag = document.createDocumentFragment();
  for (const el of rows) frag.appendChild(el); // moves each row out of the pane
  body.appendChild(frag);
  // where the fold keeps what a later page, or a run that is still going, needs to
  // add to: the rows it holds (absorbInto prepends to them, a live row appends
  // to them), the count in its head, and the two parts a state is set on
  wrap._body = body;
  wrap._label = label;
  wrap._head = head;
  wrap._fold = fold;
  head.onclick = () => {
    // toggleFold answers with where the fold is GOING, not with the class list it
    // is passing through: mid-flight a second click reverses the move instead of
    // re-running it, and the caret/attribute follow the answer either way.
    const open = toggleFold(fold);
    head.setAttribute("aria-expanded", open ? "true" : "false");
    // the reader has now said what this block should look like, and a run that
    // ends later does not get to overrule them (settleRunBlocks)
    wrap._touched = true;
  };
  return wrap;
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
  // The head the turn hangs on — its own task row, or the row the pane starts on —
  // and the shape rule that comes with it (turnHead): null is a region this file
  // does not recognize.
  const start = turnHead(kids, span, turnEnd);
  const opener = start >= 0 ? kids[start] : null;
  // What "this region is folded" is recorded on is the DIVIDER, not the head. The
  // divider is the one node in the region a fold never moves, so its mark survives
  // everything a fold does; a head does not — the pane's first region is folded
  // under whatever row the window happened to start on (the compaction notice
  // below), and a page of history that brings the turn's real task row moves that
  // head up. Keyed on the head, the next pass missed the fold entirely and built a
  // second one AROUND it: a fold inside a fold, its inner head buried in a
  // `display: none` subtree, its step count counting the inner fold as one step
  // (ui-fix.clc, the second press of "load earlier records").
  //
  // A region the divergence above already claimed — the fold an interruption left
  // open, or a divider that says this turn was folded — takes its rows whatever its
  // shape is: the row it hangs on is known (openFoldAt, or the divider), and the
  // rows a page just brought still belong in it.
  const claimed = openAt >= 0 || !!(divider && divider.dataset.turnFolded === "1");
  if (!claimed) {
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
    if (!opener) return;
    // folded already: a second `final` for the same turn (a reconnect replays one)
    // must not fold the fold, and must not re-collapse a fold the reader opened
    if (opener.dataset.turnFolded === "1") return;
  }
  // The middle is what the turn goes on to draw, cut at its prose: everything after
  // the head (or, when the region has no head this file can read, everything from
  // the open fold — or, failing that, the start of the span). mergeOpenFold folds
  // each segment of it into the block that segment already has or into a new one.
  const from = opener ? start + 1 : (openAt >= 0 ? openAt : span);
  mergeOpenFold(root, from, turnEnd, divider, opener);
}

// The rest of a turn whose middle has already been folded once: the ending the
// turn stopped on, the message the reader carried it on with, every step either of
// them drew, and the prose the run spoke in between. The prose splits what is left
// into segments, and each segment joins the block that segment already has or gets
// one of its own (foldSegmentRows) — so what the reader ends up with is the blocks
// the turn's process was always going to be folded into, hanging off the
// instruction that started the task rather than off the message that continued it,
// with the two ends of the turn — that instruction and the answer — and the prose
// in between all in plain sight.
//
// Nothing here invents an ending: the divider that just landed is the log's own,
// so a session that comes back and states how the run ended, and a run that fails
// without the window noticing, are both just the next ending of the same turn.
function mergeOpenFold(root, from, turnEnd, divider, headRow) {
  const wrap = foldSegmentRows(root, from, turnEnd, !foldsLandClosed());
  // The row the turn hangs on is marked folded for the same reason the divider is:
  // a page that completes this turn then ADDS to the block instead of folding it
  // again (foldRegion's `claimed`). It is a row a fold never moves — the turn's own
  // task, or the row the pane happens to start on — so the mark can stay on it for
  // the next pass, and can only be taken off when nothing under it was folded.
  if (headRow) {
    if (wrap) headRow.dataset.turnFolded = "1";
    else delete headRow.dataset.turnFolded;
  }
  // The ending this ending closes is the log's own record either way; the mark
  // that says "this turn is folded" goes on it, exactly as foldRegion puts it
  // there, so a page of history and a replayed final still add to this fold
  // instead of building a second one. Set only: an ending that folded nothing
  // leaves everything as it found it.
  if (wrap && divider) divider.dataset.turnFolded = "1";
  // Only the newest block can take rows from the run that carries on — and only
  // while the turn is still going: an answer or the user's own Stop ends it, and a
  // block left marked open would swallow the next turn's rows (openFoldAt).
  setTurnOpen(root, wrap && !turnEnded(divider ? divider.textContent : "") ? wrap : null);
  queueStuck(); // the block moved: recompute whether its head pins
}

// Fold every stretch of process in `[from, to)` into a block of its own, cut at the
// prose the run wrote between them: prose is where a turn can be read across, so it
// stays in the pane and the rows before and after it are two segments that fold
// apart. A segment that already holds a block — the turn's own fold, a block an
// interruption left open, or one an earlier segment got — takes its rows into THAT
// block instead of getting a second one around it; the fold is re-seated under
// whatever came in above it, which is how a fold that hung on the compaction notice
// ends up hanging on the turn's own task row once the page brings it.
//
// `animate` says how a block MADE here lands: a fold the reader watched arrive
// closes with the slide every other fold does, and a page of replayed history lands
// closed without moving (foldsLandClosed).
//
// Answers with the NEWEST block this pass put rows in — the row arriving next
// belongs to it — or null when there was nothing to fold.
function foldSegmentRows(root, from, to, animate) {
  const rows = Array.from(root.children).slice(from, to);
  const segs = [];
  let seg = [];
  for (const el of rows) {
    if (!holdsTheLine(el)) { seg.push(el); continue; }
    if (seg.length) segs.push(seg);
    seg = [];
  }
  if (seg.length) segs.push(seg);
  let newest = null;
  for (const loose of segs) {
    // a `.live` row is the run talking ABOUT itself, not a step of it: it is news,
    // and it stays where it was put
    const mid = loose.filter((el) => !el.matches(".live"));
    if (!mid.length) continue;
    const at = mid.findIndex((el) => el.matches(".turn-fold"));
    if (at < 0) {
      const made = buildFold(root, mid[0], mid);
      if (animate) foldCollapse(made._fold);
      else closeBlock(made);
      // the rows are inside a block now: no mark of their own is left to be read
      // as "this region is folded" by a later pass
      for (const el of mid) delete el.dataset.turnFolded;
      newest = made;
      continue;
    }
    const wrap = mid[at];
    const above = mid.slice(0, at);
    const below = mid.slice(at + 1);
    if (above.length) root.insertBefore(wrap, above[0]); // up, under the head
    absorbInto(root, wrap, above, true);
    absorbInto(root, wrap, below, false);
    newest = wrap;
  }
  return newest;
}

// Take rows that stood outside a block into its body, in the file order they hold
// in the pane — at its top when they stood ABOVE the block (`atTop`), at its end
// otherwise. That is the order the ending's merge puts them in too, which is why a
// turn watched live and the same turn replayed land on one shape.
//
// Rows that are not direct children of `root` any more are skipped: they are inside
// a block already. So are `.live` rows, for the reason above. Answers whether the
// READER's own message was among them.
function absorbInto(root, wrap, rows, atTop) {
  let reader = false;
  // the top of the body is filled from the back: prepending forward would hand it
  // the rows in reverse file order
  for (const el of atTop ? rows.slice().reverse() : rows) {
    if (!el || el.parentNode !== root) continue; // already in a block
    if (el.matches(".live")) continue;
    if (atTop) wrap._body.insertBefore(el, wrap._body.children[0] || null);
    else wrap._body.appendChild(el); // a move: the row leaves the pane
    delete el.dataset.turnFolded; // the row is inside a block now: no mark of its own
    if (el.matches(".event.user")) reader = true;
  }
  if (wrap._label) wrap._label.textContent = foldLabel(wrap._body.children.length);
  queueStuck(); // the block grew: whether its head pins has changed
  return reader;
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
  // and the block a run was drawing into stops saying it is still filling in, and
  // closes if the reader never had an opinion about it
  settleRunBlocks();
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

/* ── the turn still drawing into the pane: foldable WHILE it runs ──────────────
   A finished turn folds when its ending lands; a run that is still working used to
   leave every row expanded until then, so the one moment the reader most wants the
   process out of the way — a long task, a small screen, an answer they are waiting
   for — was the one moment there was nothing to fold. So the block is built the
   first time the run draws a process row, and the rows go into it as they arrive:
   the reader can open and close the live block at will, and what is inside it is
   already where the ending's fold would put it.

   A folded block also has to say that it is still filling in. The reader folded it
   themselves and nothing else in the transcript announces the run; so the closed
   state of a LIVE block carries a ring in its head (ui/style.css,
   `.turn-fold-spin`), the same ring the older-records pill spins while it waits.
   No word for it: the count beside it already changes as rows land, and a label
   that said "running" would be one more thing to read on a row whose whole job is
   to be one line. The marks are the DOM's, not the reader's: `data-turn-live` is
   what the sheet draws the ring from, and it goes away with the run
   (settleRunBlocks, and clearRunLive when a dropped session takes the ending with
   it).

   Nothing here invents a fold where the ending's own would differ: the block is
   anchored over the run's first process rows of the SEGMENT — the place the
   ending's fold takes — and it only ever absorbs rows that stand between that
   block and the row arriving now, up to the prose that ends the segment. Prose
   settles the block where it stands and the rows after it fold into a block of
   their own, which is the shape the ending's fold leaves the turn in (a turn is
   as many blocks as it drew stretches of process, and every one of them is a row
   of the pane the reader can press). */

// Is a run drawing into this pane right now? `busy` is the view's own answer
// (js/stream-view.js setStatus: running, or waiting on a permission), and the rest
// are the states where rows still arrive but nothing is running: the catch-up block
// a reconnect replays (those rows are history, and folding them one at a time would
// fold a turn the reader is watching arrive), the project-open reconstruction, and
// the history pager, whose rows render into an off-DOM sink in any case.
function runInFlight() {
  return !!busy && !catchUp && !paging && !pageSink && !stream.classList.contains("loading");
}

// A row the RUN drew as process, as opposed to the ends of the turn — its task and
// the prose it answers with — which stay in plain sight. A `.live` row is the run
// talking ABOUT itself (the "reconnecting" chip, the compaction in progress), not a
// step of it: that is news, and it stays visible where it was put.
function runProcessRow(el) {
  if (!el.matches(".event")) return false;
  if (el.matches(".event.user") || el.matches(".event.text") || el.matches(".live")) return false;
  return true;
}

// The row that ends a segment: prose the run spoke. It stays in plain sight — it is
// the run talking TO the reader, between the task and the answer — and everything on
// either side of it folds apart: the rows above it are a segment whose block is done,
// the rows below are a segment of their own (foldSegmentRows, and segmentFrom for the
// live path). Cutting here is also what keeps a body in FILE order: rows absorbed
// later are only ever APPENDED (mergeOpenFold), so a step put in front of the text it
// came after could never be put back where it was.
//
// A divider that ENDED its turn is not read here but in openRunBlock, which can tell
// the difference between the ending this run drew and the `completed` line of the turn
// before it (a new task stands under one of those, always).
function holdsTheLine(el) {
  return el.matches(".event.text");
}

// One row the pane just gained: put it in the turn's block, or make the block here
// if this is the run's first process row. Called from the observer below, not from
// the append sites — the pane is appended to in a dozen places (js/stream-events.js
// addEvent, the coalesced text and thinking renderers, tool groups,
// js/render-events.js), and this file loads AFTER all of them, so none of them may
// name it (the app's classic-script load order: tests/ui-load-order-test.js). An
// observer sees every one of those appends, and it runs in the microtask before the
// frame is painted: a row is never painted in the pane and then watched jumping
// into the block.
function foldLiveRow(el) {
  if (!eventsEl || !el || !runInFlight()) return;
  if (el.parentNode !== eventsEl) return; // already in a block, or in the pager's sink
  // Prose is where a segment ends: the block the rows above it were going into stops
  // filling in, and the rows that follow fold into a block of their own (openRunBlock).
  // It settles exactly as the ending would leave it — the last thing this segment's
  // run draws is the text it spoke — and the prose itself stays in the pane, in plain
  // sight, where the reader is looking.
  if (el.matches(".event.text")) { settleRunBlocks(); return; }
  if (!runProcessRow(el)) return;
  const wrap = openRunBlock(el);
  if (!wrap) return; // prose stands before it, or this turn has its block
  takeIntoBlock(wrap, el);
  // Moving the row into the block changed where the pane's bottom is by the room a
  // head takes, and the append that drew this row already scrolled: the reader
  // watching the run would see the tail sit one head short of the edge until the
  // next row lands. autoScroll is the file's own latch (js/stream-view.js): a
  // reader who scrolled up is not moved, and one at the tail is put back on it.
  autoScroll();
}

// The block this row belongs in, made if the run has not drawn this segment's
// process yet. Null means "leave the row in the pane": the row stands in a segment
// this file cannot place, or in one that already has its block.
function openRunBlock(el) {
  const kids = Array.from(eventsEl.children);
  const at = kids.indexOf(el);
  if (at < 0) return null;
  // A row that stands after a divider which really ENDED its turn belongs to no run
  // in flight: the run's own `final` lands before the view's own status does, so a
  // straggler can arrive with `busy` still true, and a block made over it would hang
  // off a divider the next ending has already closed. It is left in the pane. An
  // interruption closed nothing, so its divider is not one of these.
  //
  // The walk stops at the row's own TASK: a `.event.user` between the divider and the
  // row is the message this run was started from, so every divider above it closed a
  // turn that is already over. That is what a new task looks like — which is why every
  // turn but the pane's first has a `completed` divider somewhere above it, and why
  // reading the nearest one as "this row belongs to no run" left the whole transcript
  // unfoldable while it streamed: no head was ever made. Only a divider the row stands
  // directly under, with its own task above that, can say the row is a straggler.
  for (let i = at - 1; i >= 0; i--) {
    if (kids[i].matches(".event.user")) break;
    if (!kids[i].matches(".completion")) continue;
    if (turnEnded(kids[i].textContent)) return null;
    break;
  }
  // The turn this run belongs to: the span an ending will reach back through
  // (turnSpan). Its head and this row's SEGMENT of that turn are read next, so a
  // stretch of process after prose the run spoke gets a block of its own
  // (segmentFrom) instead of joining the one above the prose.
  const span = turnSpan(kids, kids.length);
  const head = turnHead(kids, span, at);
  // No head is a shape this file does not recognize; the pane's FIRST region relaxes
  // to the row the window starts on (turnHead), everywhere else the task is the head.
  // A row standing ON the head is the turn's end, not its middle.
  if (head < 0 || at <= head) return null;
  const from = segmentFrom(kids, head, at);
  const rows = kids.slice(from, at);
  // The segment may already have its block: the one an interruption left open, whose
  // rows this run is carrying on, or one made before the prose. What stands between
  // it and this row is the same segment's middle — the divider an interruption stopped
  // on, its note, the message the reader carried the turn on with — and the ending
  // appends exactly these into the body (mergeOpenFold). Taking them in now, in file
  // order, is what makes a turn watched live the same shape as the same turn replayed.
  const open = rows.findIndex((row) => row.matches(".turn-fold"));
  if (open >= 0) {
    const wrap = rows[open];
    const above = rows.slice(0, open).filter((row) => !row.matches(".live"));
    const below = rows.slice(open + 1).filter((row) => !row.matches(".live"));
    if (above.length) eventsEl.insertBefore(wrap, above[0]); // up, under the head
    const aboveReader = absorbInto(eventsEl, wrap, above, true);
    const belowReader = absorbInto(eventsEl, wrap, below, false);
    markLive(wrap);
    // …and when one of them was the reader's own message the block opens: what they
    // just wrote is not something this file hides on its own initiative, and the head
    // that says where it went is now right there to fold it again.
    if (aboveReader || belowReader) openBlock(wrap);
    return wrap;
  }
  // No block in this segment yet: make one over the process rows the run has drawn
  // since the segment began — the place the ending's fold would take. Whatever stands
  // above them (the task, or the prose the segment starts after) keeps its own row.
  const mid = kids.slice(from, at + 1).filter((row) => !row.matches(".live"));
  if (!mid.length) return null;
  for (const row of mid) delete row.dataset.turnFolded; // inside a block now
  const wrap = buildFold(eventsEl, mid[0], mid);
  // A run's steps are process, and the reader wants that middle out of the way BY
  // DEFAULT while it streams — that is the whole point of folding a long task on a
  // phone. So the block lands folded: the head says how many steps are in there, the
  // ring says more are still coming, and one press opens it. No animation: the block
  // was never painted open, so there is no move for the reader to follow.
  closeBlock(wrap);
  markLive(wrap);
  // …and a segment the reader's own message carries on opens, as above
  if (mid.some((row) => row.matches(".event.user"))) openBlock(wrap);
  return wrap;
}

// The two states a block is put in from here, without the animation a reader's own
// press plays: both are end states of a decision this file made, not a move the reader
// is following.
function closeBlock(wrap) {
  if (!wrap._fold) return;
  wrap._fold.classList.remove("open");
  wrap._fold.classList.add("hidden");
  if (wrap._head) wrap._head.setAttribute("aria-expanded", "false");
}

function openBlock(wrap) {
  if (!wrap._fold) return;
  wrap._fold.classList.remove("hidden");
  wrap._fold.classList.add("open");
  if (wrap._head) wrap._head.setAttribute("aria-expanded", "true");
}


// This block is the turn in flight: it takes the rows the run is still drawing, and
// while it is folded its head says so with the ring. It is marked OPEN because the
// turn has not ended — an ending still has to add its rows to THIS block
// (mergeOpenFold) instead of building a second one above the continuation. The STATE
// of the fold is the reader's: a block this file makes lands folded, a block they
// opened stays open, and the state a block was left in by an interrupted session is
// theirs no longer once the run is going again (openBlock, when their own message
// carries the turn on).
function markLive(wrap) {
  // the block the run is filling in is the one a later row joins — including a block
  // this file did not make in this pass (a fold a page of history left open)
  setTurnOpen(wrap.parentNode || eventsEl, wrap);
  if (wrap.dataset.turnLive === "1") return;
  wrap.dataset.turnLive = "1";
  wrap.setAttribute("aria-busy", "true"); // what a screen reader hears instead of the ring
  if (!wrap._fold || !wrap._fold.classList.contains("open")) return;
  wrap._head.setAttribute("aria-expanded", "true");
}

// The one block a later row may join (openFoldAt): `wrap`, or none at all while the
// turn is not going. Every other block in the pane loses the mark, so "the open fold"
// is always a single, unambiguous row.
function setTurnOpen(root, wrap) {
  for (const el of Array.from(root.children)) {
    if (el.matches(".turn-fold") && el !== wrap) delete el.dataset.turnOpen;
  }
  if (wrap) wrap.dataset.turnOpen = "1";
}

// The row joins the block at the body's end, which is the order the rows were drawn
// in — the same place and the same order the ending's merge appends the rows that
// stood outside it, so the body reads in file order whichever way a row got in.
function takeIntoBlock(wrap, el) {
  wrap._body.appendChild(el); // a move: the row leaves the pane
  if (wrap._label) wrap._label.textContent = foldLabel(wrap._body.children.length);
  queueStuck(); // the block grew: whether its head pins has changed
}

// Every block in the pane a run is still filling in.
function liveBlocks() {
  if (!eventsEl) return [];
  return Array.from(eventsEl.children).filter((el) =>
    el.matches(".turn-fold") && el.dataset.turnLive === "1");
}

// The run is over: the block stops saying it is still filling in and — if the reader
// never touched it — closes where it stands, which is the state the fold the ending
// makes lands in (foldRegion collapses the block it builds).
//
// A block the reader toggled is left as they left it. They said what they want to
// see while the rows were still arriving, and the ending is not news to a block they
// have been reading for the whole run.
function settleRunBlocks() {
  for (const wrap of liveBlocks()) {
    delete wrap.dataset.turnLive;
    wrap.setAttribute("aria-busy", "false");
    if (wrap._touched) continue;
    const fold = wrap._fold;
    if (!fold || fold.classList.contains("hidden")) continue; // already closed
    if (foldsLandClosed()) {
      fold.classList.remove("open");
      fold.classList.add("hidden");
    } else {
      foldCollapse(fold);
    }
    if (wrap._head) wrap._head.setAttribute("aria-expanded", "false");
  }
}

// The liveness alone goes when the session the run lived in is gone: no ending is
// coming to this window, so nothing is still filling the block in — but the block
// itself stays exactly where it is, open or closed, because the reader may still be
// reading it, and the rest of the turn adds to it (foldOpenTurn, mergeOpenFold).
function clearRunLive() {
  for (const wrap of liveBlocks()) {
    delete wrap.dataset.turnLive;
    wrap.setAttribute("aria-busy", "false");
  }
}

// The pane's own child list, watched while the page is open. `subtree` is
// deliberately off: a record whose target is deeper than the pane is a body or a
// tool group's list filling in, not a row of the transcript.
function watchLiveRows() {
  if (!eventsEl || typeof MutationObserver === "undefined") return;
  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.target !== eventsEl) continue;
      for (const node of rec.addedNodes) {
        if (node && node.nodeType === 1) foldLiveRow(node);
      }
    }
  });
  mo.observe(eventsEl, { childList: true });
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
// the fold of the turn it was running happens here (foldOpenTurn). Liveness goes
// first: a block the run was still filling in is not being filled in any more, and
// the ring in its head has to stop turning before the block is folded.
if (eventsEl) eventsEl.addEventListener("clutch:turn-interrupted", () => {
  clearRunLive();
  foldOpenTurn();
});
// Every row the pane gains, from the moment the page is open: a run that is in
// flight is folded as it draws (foldLiveRow). The observer, not the append sites —
// see the note above foldLiveRow.
if (eventsEl) watchLiveRows();
