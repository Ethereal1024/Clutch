// the renderer's shared mutable state — the bindings more than one file writes
//
// Every other cross-file name is a function or a constant: import it and use it.
// These are the exceptions. A `let` is private to its module, and an ESM import
// is a read-only view of a binding — so a variable that one file declares and
// another file overwrites cannot be a module-level `let` at all. Putting them in
// one object gives that traffic a single address: "who can change this?" has one
// answer, and it is written down here instead of inferred from who happens to
// declare what.
//
// The grouping is by the file that used to declare the binding, because that is
// where the reasoning lives (each comment travelled with its variable).

// A machine a project file can live on: this one (null) or the far side of an
// SSH tunnel. `port` is the SSH port, kept as the store writes it.
export type Machine = { host: string; user: string; port: string };

export const state = {
  // ---- tab-bar.ts / slots.ts ----
  // One entry per tab. `id` is ALSO the tab's session slot: the host claims one
  // supervisor session per id, which is what lets two tabs run at once.
  tabs: [] as Array<{
    id: string;
    path: string;
    name: string;
    // Which machine this tab's .clc lives on. A tab is a file on ONE machine,
    // and a session claimed on another cannot open it — the host answers "not a
    // .clc project file" (agent/api/project.py) for a path that machine does not
    // have. undefined = not known yet (a store written before this field),
    // null = this machine, an object = the far side of a tunnel. Recorded from
    // what the HOST claimed (slots.ts), never guessed from the path.
    machine?: Machine | null;
    // Why this tab cannot be reopened right now (slots.ts sets it, activation
    // says it once, a successful claim clears it).
    unreachable?: string | null;
    // this tab's session URL (null until claimed / after release)
    base?: string | null;
    // the host-canonical path once the tab is open (the resource identity)
    projectKey?: string;
    // this tab's own run is in flight (whether or not the tab is visible)
    running?: boolean;
    // a permission/confirm ask is waiting in this tab (badge, never focus steal)
    needsInput?: boolean;
  }>,
  activeTabId: null as string | null,

  // ---- app.ts ----
  // the session base this window talks to; null until resolveApiBase() has an
  // answer, and null again when the session goes away (js/backend-lifecycle.ts)
  apiBase: null as string | null,

  // ---- tool-render.ts ----
  // the HOST's own default `ui` block (GET /api/host), fetched once at boot:
  // host.json may override any compiled-in constant, and the constants stay as
  // the fallback for a host that predates the endpoint (js/boot.ts sets this).
  hostUiDefaults: null,

  // ---- conn-flow.ts ----
  // the pending answer of the SSH password prompt (conn-flow.ts resolves it)
  passResolve: null,
  // every listing request takes the next token; an answer whose token is stale
  // (a newer request went out, fs-browser.ts) must not paint
  fsListToken: 0,

  // ---- project.ts ----
  // byte offset of the oldest loaded (rendered) non-task event
  oldestOffset: null,
  // the highest offset this window has painted; everything at or below it is a
  // record it already rendered. Reset with the pane.
  streamHighOffset: null,

  // ---- sse-stream.ts ----
  // a run is in flight and the stream is at risk (a backend switch or a lost
  // link mid-run): the ring predicts a reconnect instead of a fresh turn
  sseRunAtRisk: false,
  // the stream dropped mid-run and nobody has asked the host whether the run
  // survived; asked once, answered once (js/stream-events.ts clears it)
  sseRunLostPending: false,
  // the run this window was watching has ended (painted its ending already)
  runSettled: false,

  // ---- stream-events.ts ----
  // the paint work a catch-up (`history` … `replayed`) has queued but not run:
  // the block is DATA until the server closes it, and its closing frame paints
  // the whole block in one task — a tunnel delivers each record in its own SSE
  // frame, so a paint per frame is a paint per record (the reported "a pile of
  // messages loads itself" / "一次性闪过很多消息"). Each entry is the thunk that
  // renders one record; settleCatchUp() runs them and closes the bracket, and
  // every way the block can end goes through it (the watermark already counts
  // these rows, so a dropped one would never be asked for again).
  owedRecords: [] as Array<() => void>,

  // ---- stream-text.ts ----
  // the coalesced-render frame handles: a token arrives, the frame repaints
  textRenderRaf: 0,
  thinkingRenderRaf: 0,

  // ---- stream-view.ts ----
  // latched tail-follow: reaching the bottom (or ↓) pins the view; only a user's
  // upward scroll breaks the latch
  followTail: true,
  // ignore latch changes ~120ms after the input box resizes: the clamp scroll
  // event can fire before the shrunken viewport is observable
  suppressLatchUntil: 0,
  // the most recent agent text block (created by streaming text_delta)
  lastTextEl: null,
  lastTextContent: "",
  // that block is CLOSED and takes no more deltas: either it holds a durable
  // assistant_message's text, which is the whole of that model step's prose (a
  // text_delta still arriving for the same step is a copy of what the block already
  // says — the delta feed and the log's own SSE feed are unordered), or a cut ended
  // it and only the record that owns it may write it now (stream-events.ts)
  textSealed: false,
  // The block the pane DREW for the newest durable assistant_message, and the text
  // it holds. A record no live block adopts paints a block of its own — a STORED
  // session (no deltas at all), a replayed transcript, a tail a restored tab
  // rebuilt. The run's `final` repeats exactly that record's text (run-state.ts
  // foldRun closes a completed turn by writing its last assistant_message as the
  // summary), so it has to complete THIS block; painting a block of its own is the
  // reported "one answer, twice" (stream-events.ts).
  lastRecordEl: null,
  lastRecordText: "",
  // the thinking (reasoning) block
  thinkingEl: null,
  thinkingContent: "",
  // live "compressing context" block (compaction_delta)
  compactionEl: null,
  // live "reconnecting…" chip (llm_retry), removed once the stream resumes
  retryNoteEl: null,
  // the block currently collecting consecutive tool_calls (for merging)
  toolGroupEl: null,
};
