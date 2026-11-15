// The live channel on the far-root host: the SSE wire and the catch-up behind it.
//
// Ported from `agent/api/events.py` (the encoder, `_owed_records`, and the
// replay prelude of `_sse`) and `agent/events.py` (the defaults an event
// carries). A frame is a STRING here: whatever writes it — a Node response
// behind the tunnel or an in-process pipe — only puts bytes on the wire, so the
// contract this file owns is the text, and it has to be the text the Python host
// writes. A, B and C render the same renderer, and the renderer parses one
// framing whichever host answers it (plan §5).
//
// Three shapes, and the difference is not cosmetic:
//
//   * TRANSIENT — the bare event JSON, `data: {...}\n\n`. A status, a permission
//     ask, a crashed run's final: they are STATE, never appended to the log, so
//     a catch-up cannot recover them and only a reconnect can re-send them.
//   * DURABLE — `{"offset": N, "event": {...}}`, where N is the .clc byte offset
//     the record lives at. The renderer keeps that number as its watermark, so
//     the next reconnect is answered with exactly what it has not painted. The
//     log stamps the same number on the event when it appends (`logOffset`), so
//     a LIVE durable frame and a replayed one have the same shape.
//   * HOST ANNOUNCEMENT — a small object this file makes up (`history`,
//     `replayed`, `resync`): the replay block's prologue, epilogue and the one
//     way to say "the offset you sent is past the end of this log".
//
// On escaping: `event_to_json` is `json.dumps(..., ensure_ascii=False)`, but the
// two call sites that build a payload OF a payload are bare `json.dumps(...)` —
// ASCII-escaping by default. So a wrapped frame and a raw announcement escape
// non-ASCII while a bare event does not. That is the Python host's own
// inconsistency; it is frozen here rather than tidied, because a frame is bytes
// and the goldens were captured from that encoder.
//
// What this file does NOT do: own a socket or a project. The caller decides
// which log is being watched, whether a run is in flight, and which subscriber
// is owed which frame; the prelude only turns (log, since, busy) into frames,
// and the broadcaster only bounds and fans out what a run publishes.

const { eventFromDict, eventToJson, dumps } = require("./clc");

// `agent/server.py`: the keepalive is a NAMED event, not the usual comment
// heartbeat — a comment never reaches a listener, so an EventSource cannot tell
// a live-but-idle stream from a socket that died an hour ago. The renderer's
// SSE_KEEPALIVE_MS must match this value.
const SSE_KEEPALIVE_SEC = 15;
const SSE_PING_FRAME = "event: ping\ndata: {}\n\n";

// The two things a stream says that are not events. `history` carries the byte
// count the older-pill accounts for (everything before the model's window);
// `replayed` closes the catch-up block explicitly, so the renderer paints it in
// one pass and scrolls once.
function historyFrame(older) {
  return writeSseRaw({ type: "history", older: Math.max(0, Math.trunc(older)) });
}

function replayedFrame(count) {
  return writeSseRaw({ type: "replayed", count: Math.max(0, Math.trunc(count)) });
}

// `{"type": "resync"}`: the window's offset is past the end of this log (the
// file was replaced under it), so the pane cannot be continued from it at all
// and the renderer starts over.
function resyncFrame() {
  return writeSseRaw({ type: "resync" });
}

function frame(payload) {
  return `data: ${payload}\n\n`;
}

function requireOffset(offset) {
  const value = Number(offset);
  if (!Number.isInteger(value)) throw new TypeError(`sse: offset must be an integer byte offset (${offset})`);
  return value;
}

// `EventsMixin._write_sse`: with an offset the payload is `{offset, event}`,
// otherwise the bare event JSON. An event the log appended carries its own
// `logOffset`, so the live frame is the replay frame; a transient one has none.
//
// The wrapped shape is built by TEXT, not by re-serializing a parsed copy: the
// event JSON is already the exact Python dumps of the event (field order, ", "
// separators, `1700000000.0`), and re-parsing it would turn that float into an
// integer that prints as `1700000000`. Only the escaping differs, hence ascii.
function writeSse(event, offset) {
  const explicit = offset === undefined || offset === null ? null : requireOffset(offset);
  const own = event && event.logOffset !== undefined && event.logOffset !== null ? requireOffset(event.logOffset) : null;
  const at = explicit === null ? own : explicit;
  if (at === null) return frame(eventToJson(event));
  return frame(`{"offset": ${at}, "event": ${eventToJson(event, { ascii: true })}}`);
}

// `EventsMixin._write_sse_raw`: a host-made announcement (`json.dumps(obj)`).
function writeSseRaw(obj) {
  return frame(dumps(obj, false, true));
}

// `EventsMixin._owed_records`: the durable records a (re)connecting window is
// owed, in file order.
//
// Without `since`: the resident window — what a window that has painted nothing
// wants, with the older-pill accounting for the rest. With `since`: every record
// AFTER that byte offset, from DISK as well as memory. The resident window
// starts at the newest compaction line, so a window that was away longer than
// that would otherwise be handed a transcript with a silent hole in it.
//
// `readPage` is [lo, hi) and strict: a record AT the watermark is one this
// window has already painted (the renderer would skip it anyway, but sending it
// back is a wire cost with no reader).
async function owedRecords(log, since) {
  if (since === null || since === undefined) return log.items();
  const start = log.cprStart;
  const older = since < start ? await log.readPage(since + 1, start) : [];
  return older.concat(log.items().filter(([off]) => off > since));
}

// The status frame is a RESET for a window that has nothing in flight (a project
// switch, an interrupted run) — and it is also what a RECONNECTING window gets.
// Saying "idle" there was a lie the moment a run was still in flight, so the
// caller reports the host's real state: in flight for the project this stream
// watches = running, anything else = idle.
function stateUpdateFrame(value, stamp) {
  const data = { type: "state_update", key: "execution_status", value };
  if (stamp && stamp.timestamp !== undefined) data.timestamp = stamp.timestamp;
  if (stamp && stamp.id !== undefined) data.id = stamp.id;
  return writeSse(eventFromDict(data));
}

// `EventsMixin._sse` minus the socket: the status frame, then — when the caller
// asked for a replay or named an offset — the catch-up block. The live tail that
// follows it needs a broadcaster queue and a peer, so it belongs to whoever owns
// the connection.
//
// `options`:
//   since   — the .clc byte offset the window has painted up to (`null`/absent
//             for a window that has painted nothing). The ONE way the wire says
//             "I am up to here".
//   replay  — the legacy spelling of "no since yet" (0.1.18 clients); a client
//             that sent `since` is always answered, which is why `since !== null`
//             forces the block.
//   busy    — the host's real state: a run is in flight FOR THIS PROJECT.
//   log     — the project's LazyEventLog, or null when nothing is open (the
//             status frame is still owed: the window paints it as a reset).
//   stamp   — test seam: a fixed {timestamp, id} for the status frame, whose
//             production defaults are now and a uuid4 hex12 and would make the
//             frame unrepeatable.
async function ssePrelude(log, options = {}) {
  const since = options.since === undefined || options.since === null ? null : requireOffset(options.since);
  const replay = options.replay === undefined ? true : Boolean(options.replay);
  const frames = [stateUpdateFrame(options.busy ? "running" : "idle", options.stamp)];
  // a window that named an offset is owed an answer even if replay was turned
  // off: the legacy flag cannot cancel a promise the newer field made
  if (!replay && since === null) return frames;
  if (!log) return frames;
  if (since !== null && since > log.cprStart + log.windowBytes) {
    frames.push(resyncFrame());
    return frames.concat(await replayBlock(log, null));
  }
  return frames.concat(await replayBlock(log, since));
}

// ---- the fan-out (agent/base.py: Broadcaster / LAGGED) --------------------
//
// Every subscriber owns a BOUNDED queue. A window that stopped draining is not
// owed an unbounded buffer: every durable event is already in the project log
// and the subscriber carries the byte offset it has painted, so what a slow
// window needs is not a backlog but its own re-read. Past this depth the queue
// is emptied and ONE marker is left, which ends that stream; the window's
// reconnect then asks for everything after its offset — idempotent, because the
// watermark makes a replay of already-painted records a no-op.
//
// The bound is DEPTH of frames, not bytes: a run's deltas are a few bytes each,
// so this is tens of KB of text. `agent/base.py` states the same number.
const SUBSCRIBER_QUEUE_MAX = 4096;

// A marker, not an event: never serialized, never part of a log. Identity is
// the whole meaning ("the frames you lost are in the log you can re-read"), so
// it is a frozen singleton and every consumer compares it by identity.
const LAGGED = Object.freeze({ lagged: true });

function isLagged(value) {
  return value === LAGGED;
}

// One subscriber's queue. Deliberately tiny and synchronous: the host is one
// Node event loop, so there is no `queue.Queue` to emulate — only the bound and
// the drain-to-one-marker rule matter, and both are policy, not threading.
class SubscriberQueue {
  constructor(project, max) {
    this.project = project === undefined || project === null ? null : String(project);
    this.max = max;
    this._items = [];
  }

  get size() {
    return this._items.length;
  }

  push(item) {
    if (this._items.length >= this.max) return false;
    this._items.push(item);
    return true;
  }

  // The next frame, or undefined. LAGGED is handed out like any other item: it
  // is the consumer's `break`, not the queue's.
  shift() {
    return this._items.length ? this._items.shift() : undefined;
  }

  peek() {
    return this._items.length ? this._items[0] : undefined;
  }

  // Everything pending, oldest first, then empty.
  drain() {
    const items = this._items;
    this._items = [];
    return items;
  }

  clear() {
    this._items.length = 0;
  }
}

// `Broadcaster`: fan events out to subscribers, one bounded queue each. A
// subscriber may name the project it watches (null = every project) — the live
// tail filters another window's run out of its stream, so a stream watching a
// different project is no audience for this one's permission prompt.
function createBroadcaster() {
  const subs = new Map(); // queue -> watched project (or null)

  function subscribe(project) {
    const q = new SubscriberQueue(project === undefined ? null : project, SUBSCRIBER_QUEUE_MAX);
    subs.set(q, q.project);
    return q;
  }

  function unsubscribe(q) {
    subs.delete(q);
  }

  function publish(event) {
    for (const q of [...subs.keys()]) {
      if (q.push(event)) continue;
      // One marker, one remedy: the stream ends and the window re-reads the log
      // after its own offset. (`agent/base.py` also handles the case of another
      // publisher refilling the queue between the drain and the marker; one
      // event loop cannot interleave, so the retry is unnecessary here.)
      q.clear();
      q.push(LAGGED);
    }
  }

  // Live subscribers, i.e. "is anyone watching the UI?". With a project: only
  // the ones that would actually SEE that project's events — its own watchers
  // plus the unfiltered ones — because a window on another project cannot
  // answer this project's prompt.
  function count(project) {
    if (project === undefined || project === null) return subs.size;
    let n = 0;
    for (const watched of subs.values()) if (!watched || watched === project) n += 1;
    return n;
  }

  return { subscribe, unsubscribe, publish, count };
}

// The live tail's filter: does this subscriber see the run of `runProject`?
// No run project = every stream gets it; an unfiltered subscriber always does.
function wantsEvent(queue, runProject) {
  if (!runProject) return true;
  if (!queue || !queue.project) return true;
  return queue.project === runProject;
}

async function replayBlock(log, since) {
  const owed = await owedRecords(log, since);
  const frames = [historyFrame(log.cprStart)];
  for (const [off, event] of owed) frames.push(writeSse(event, off));
  frames.push(replayedFrame(owed.length));
  return frames;
}

// ---- the log as text (`events.event_text`) -------------------------------

// One durable event as the text a READER of the log sees. The one projection
// both readers share — the compaction transcript (`loop.js`) and the model's own
// project-log reader (`tools.js`, `recall.py`) — so what a summary is made of and
// what a later session can look up are one rendering of one log.
//
// A line is rendered as ITSELF: the tool calls an assistant turn made are their
// own `tool_call` records, so they are not repeated inside the assistant_message
// that precedes them. `limit` caps one event's BODY and says so where the cut
// happened; the marker is part of the text, never a silent trim.
function eventText(ev, limit = null) {
  if (!ev || typeof ev !== "object") return "";
  switch (ev.type) {
    case "user_message":
      return `[User]: ${clip(ev.content, limit)}`;
    case "assistant_message": {
      const parts = [];
      if (ev.content) parts.push(`[Assistant]: ${clip(ev.content, limit)}`);
      if (ev.reasoning) parts.push(`[Assistant reasoning]: ${clip(ev.reasoning, limit)}`);
      return parts.join("\n");
    }
    case "tool_call":
      return `[Assistant tool call]: ${clip(`${ev.name}(${ev.arguments})`, limit)}`;
    case "tool_result":
      return `[Tool result]: ${clip(ev.content, limit)}`;
    case "compaction":
      return `[Compaction summary]: ${clip(ev.summary, limit)}`;
    case "final":
      return `[Final]: ${clip(ev.summary || ev.status, limit)}`;
    default:
      return "";
  }
}

function clip(text, limit) {
  const value = String(text === undefined || text === null ? "" : text);
  if (limit === null || limit === undefined || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}

module.exports = {
  // the wire
  writeSse,
  writeSseRaw,
  stateUpdateFrame,
  historyFrame,
  replayedFrame,
  resyncFrame,
  // the catch-up
  owedRecords,
  ssePrelude,
  // the one projection of an event into readable text (events.event_text)
  eventText,
  // the fan-out (agent/base.py)
  createBroadcaster,
  SubscriberQueue,
  wantsEvent,
  LAGGED,
  isLagged,
  SUBSCRIBER_QUEUE_MAX,
  // constants the renderer and the tests assert against
  SSE_KEEPALIVE_SEC,
  SSE_PING_FRAME,
};
