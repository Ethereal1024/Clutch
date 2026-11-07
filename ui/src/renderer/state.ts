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

export const state = {
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
