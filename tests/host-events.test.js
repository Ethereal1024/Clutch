"use strict";

// The SSE wire (`ui/host/events.js`), replayed against the golden capture.
//
// `tests/conformance_capture.py::_sse_frames` froze five frames from the REAL
// Python encoder (`EventsMixin._write_sse` / `_write_sse_raw`): the two payload
// shapes (a transient event is its bare JSON, a durable one is `{offset,
// event}`) and the three announcements the replay block is made of. A, B and C
// render the same renderer, so this file's whole contract is those bytes.
//
// The rest of the file pins what a frame can silently get wrong and no golden
// covers, because the capture uses ASCII and a fixed offset:
//
//   * `offset` is a byte offset, so `0` is a real watermark and must wrap;
//   * the wrapped shape is built by TEXT, not by re-serializing a parsed copy —
//     re-parsing would print `1700000000` for an epoch that must stay
//     `1700000000.0`, and the renderer's watermark arithmetic would not notice;
//   * the Python encoder ASCII-escapes the payloads it builds OF a payload (the
//     wrapped shape and a raw announcement) and does not escape a bare event —
//     a Chinese task is a durable frame, so this is the difference between
//     "identical bytes" and "identical after parsing";
//   * the catch-up is a function of (log, since): a record AT the watermark is
//     already painted, records before the model window live only on disk, and
//     an offset past the end of the log is a resync, not an empty replay.
//
// Run: node tests/host-events.test.js

const fs = require("fs");
const path = require("path");

const { check, summary } = require("./harness");

const HOST = path.resolve(__dirname, "..", "ui", "host");
const FIX = path.resolve(__dirname, "fixtures", "conformance");
const ROOT = path.resolve(__dirname, "..");

const events = require(path.join(HOST, "events.js"));
const clc = require(path.join(HOST, "clc.js"));

// What the manifest may mark `enforced` on the strength of this runner.
const COVERED = ["sse.frames"];

const GOLDEN = JSON.parse(fs.readFileSync(path.join(FIX, "sse_frames.json"), "utf8"));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIX, "manifest.json"), "utf8"));

// `_sse_frames`' fixed stamp: the defaults are time() and uuid4, so a frame
// would otherwise never repeat.
const STAMP = { timestamp: 1700000000.0, id: "000000000000" };

function make(data) {
  return clc.eventFromDict({ ...STAMP, ...data });
}

// ---- 1. the five goldens, byte for byte ----------------------------------

function goldenFrames() {
  const entry = MANIFEST.endpoints.find((ep) => ep.id === GOLDEN.endpoint);
  check(Boolean(entry), "sse.frames: the manifest owns this fixture");
  check(GOLDEN.cases.length === 5, `sse.frames: the fixture holds the five frozen frames (${GOLDEN.cases.length})`);
  const ids = GOLDEN.cases.map((c) => c.id);
  check(
    entry && JSON.stringify(ids) === JSON.stringify(entry.cases),
    "sse.frames: the manifest lists exactly the cases in the file"
  );

  const frameOf = new Map(GOLDEN.cases.map((c) => [c.id, c.frame]));
  const same = (id, got) => {
    const want = frameOf.get(id);
    check(want === got, `${id}: the host writes the captured frame byte for byte`);
    if (want !== got && want !== undefined) {
      console.log("  want:", JSON.stringify(want));
      console.log("  got :", JSON.stringify(got));
    }
  };

  // a transient event: no log offset, so the bare event JSON
  same("sse.transient.state-update", events.writeSse(make({ type: "state_update", key: "execution_status", value: "idle" })));
  same("sse.transient.state-update", events.stateUpdateFrame("idle", STAMP));
  // a durable one: the offset the record lives at, wrapped
  same("sse.durable.user-message", events.writeSse(make({ type: "user_message", content: "fixed task" }), 4096));
  // the three announcements
  same("sse.raw.history", events.historyFrame(1024));
  same("sse.raw.replayed", events.replayedFrame(3));
  same("sse.raw.resync", events.resyncFrame());

  for (const c of GOLDEN.cases) {
    check(c.frame.startsWith("data: ") && c.frame.endsWith("\n\n"), `${c.id}: is one framed SSE payload`);
    check(c.frame.split("\n").length === 3, `${c.id}: the payload is ONE line (a raw newline would split the frame)`);
  }
}

// ---- 2. the offset rule --------------------------------------------------

function offsetRule() {
  const ev = make({ type: "user_message", content: "x" });
  check(events.writeSse(ev, 0).startsWith('data: {"offset": 0, "event": '), "offset 0 is a watermark, not 'no offset'");
  check(events.writeSse(ev) === `data: ${clc.eventToJson(ev)}\n\n`, "no offset: the bare event JSON");

  const stamped = make({ type: "user_message", content: "x" });
  stamped.logOffset = 7;
  check(events.writeSse(stamped).includes('{"offset": 7, "event": '), "an appended event carries its own logOffset");
  check(events.writeSse(stamped, 9).includes('{"offset": 9, "event": '), "an explicit offset wins over logOffset");
  check(
    events.writeSse(stamped, null) === events.writeSse(stamped),
    "an explicit null means 'not given': the event's own logOffset answers"
  );

  let threw = false;
  try {
    events.writeSse(ev, 1.5);
  } catch (error) {
    threw = error instanceof TypeError;
  }
  check(threw, "a non-integer offset is refused (a byte offset is an integer)");

  // the float that must survive: the wrapped event is not a re-parse of it
  const epoch = events.writeSse(make({ type: "user_message", content: "x" }), 1);
  check(epoch.includes('"timestamp": 1700000000.0'), "the wrapped epoch keeps its '.0'");
}

// ---- 3. the escaping the Python encoder actually uses -------------------

function escaping() {
  const wrapped = events.writeSse(make({ type: "user_message", content: "héllo中😀\u007f" }), 1);
  check(
    wrapped ===
      'data: {"offset": 1, "event": {"type": "user_message", "timestamp": 1700000000.0, "id": "000000000000", "content": "h\\u00e9llo\\u4e2d\\ud83d\\ude00\\u007f"}}\n\n',
    "a wrapped frame ASCII-escapes its content (json.dumps' default, astral as a surrogate pair)"
  );
  const bare = events.writeSse(make({ type: "user_message", content: "héllo中😀" }));
  check(bare.includes("héllo中😀"), "a bare frame keeps the event's UTF-8 (event_to_json: ensure_ascii=False)");
  check(!bare.includes("\\u"), "a bare frame escapes nothing it does not have to");
  const raw = events.writeSseRaw({ type: "note", text: "中" });
  check(raw === 'data: {"type": "note", "text": "\\u4e2d"}\n\n', "a raw announcement is json.dumps(obj): ASCII-escaped");

  // the .clc writer must NOT acquire the escaping: the line's bytes are the
  // offset contract every recorded offset was computed from
  const line = clc.eventToJson(make({ type: "user_message", content: "中" }));
  check(line.includes("中"), "the .clc line keeps raw UTF-8 (the byte offsets depend on it)");
  check(clc.lineBytes(make({ type: "user_message", content: "中" })) === Buffer.byteLength(`${line}\n`, "utf8"), "lineBytes counts the same bytes");
}

// ---- 4. the keepalive is the same fact on all three sides ---------------

function keepalive() {
  const server = fs.readFileSync(path.join(ROOT, "agent", "server.py"), "utf8");
  const sec = /^SSE_KEEPALIVE_SEC = (\d+)$/m.exec(server);
  check(sec !== null, "agent/server.py declares SSE_KEEPALIVE_SEC");
  check(
    sec !== null && Number(sec[1]) === events.SSE_KEEPALIVE_SEC,
    `the host's keepalive matches the Python host (${events.SSE_KEEPALIVE_SEC}s)`
  );
  const ping = /^SSE_PING_FRAME = b"([^"]*)"$/m.exec(server);
  check(ping !== null, "agent/server.py declares SSE_PING_FRAME");
  check(
    ping !== null && ping[1].replace(/\\n/g, "\n") === events.SSE_PING_FRAME,
    "the host's ping frame is the named event the renderer listens for"
  );
  const renderer = fs.readFileSync(path.join(ROOT, "ui", "js", "sse-stream.js"), "utf8");
  const ms = /const SSE_KEEPALIVE_MS = (\d+);/.exec(renderer);
  check(ms !== null, "ui/js/sse-stream.js declares SSE_KEEPALIVE_MS");
  check(
    ms !== null && Number(ms[1]) === events.SSE_KEEPALIVE_SEC * 1000,
    "the renderer's keepalive and the host's are the same interval (a cache that can only be refreshed by the stream)"
  );
}

// ---- 5. the catch-up: (log, since) -> frames ----------------------------

// A real LazyEventLog over an in-memory .clc event region. `cprStart` is the
// newest compaction line's offset, so the window is only its tail while the
// earlier records still exist on "disk" — which is exactly the hole `since` is
// there to fill.
function encode(list) {
  const lines = list.map((event) => `${clc.eventToJson(event)}\n`);
  const buf = Buffer.from(lines.join(""), "utf8");
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += Buffer.byteLength(line, "utf8");
  }
  return { buf, offsets };
}

async function openAt(buf, cprStart = 0) {
  return clc.LazyEventLog.open({
    path: "",
    read: async (lo, hi) => buf.subarray(lo, hi),
    total: buf.length,
    base: 0,
    cprStart,
    // a non-zero offset means "this file HAS a cpr_start line", so the log
    // trusts the stored boundary instead of deriving it from a compaction line
    cprLineOff: cprStart ? 1 : 0,
    writer: null,
  });
}

function payloads(frames) {
  return frames.map((frame) => frame.slice("data: ".length, -"\n\n".length));
}

function offsetsOf(frames) {
  return payloads(frames)
    .filter((payload) => payload.startsWith('{"offset"'))
    .map((payload) => JSON.parse(payload).offset);
}

// the type of each frame, unwrapping the durable `{offset, event}` shape
function kinds(frames) {
  return payloads(frames).map((payload) => {
    const parsed = JSON.parse(payload);
    return parsed.event ? parsed.event.type : parsed.type;
  });
}

async function catchUp() {
  const list = [
    make({ type: "user_message", content: "one" }),
    make({ type: "assistant_message", content: "two" }),
    make({ type: "compaction", summary: "summary" }),
    make({ type: "assistant_message", content: "three" }),
  ];
  const { buf, offsets } = encode(list);
  const log = await openAt(buf, 0);
  // the same log, windowed at the compaction line: records [0] and [1] are now
  // disk-only, which is the state a reconnecting window is in
  const windowed = await openAt(buf, offsets[2]);
  const start = windowed.cprStart;
  const total = buf.length;
  check(start === offsets[2], "the window starts at the compaction line");
  check(windowed.items().length === 2, "only the window is resident");
  check(windowed.windowBytes === total - start, "window_bytes is the rest of the region");

  // without `since`: the resident window, and nothing else
  const cold = await events.owedRecords(windowed, null);
  check(JSON.stringify(cold.map(([off]) => off)) === JSON.stringify([offsets[2], offsets[3]]), "no since: the resident window, in file order");
  check(cold.length === 2, "no since: nothing before the window is sent (the older-pill accounts for it)");

  // `since` = 0: only the record AT the watermark is skipped, and the disk half
  // still fills the hole the window left
  const fromZero = await events.owedRecords(windowed, 0);
  check(
    JSON.stringify(fromZero.map(([off]) => off)) === JSON.stringify([offsets[1], offsets[2], offsets[3]]),
    "since=0: the record AT the watermark is already painted, the rest arrives in file order"
  );
  check(new Set(fromZero.map(([off]) => off)).size === fromZero.length, "no record is sent twice");

  // the strictness in the other direction: a record AT `since` is not re-sent
  const atOne = await events.owedRecords(windowed, offsets[1]);
  check(
    JSON.stringify(atOne.map(([off]) => off)) === JSON.stringify([offsets[2], offsets[3]]),
    "since at a record: that record is not re-sent"
  );
  // and one past the last record is an empty catch-up, not an error
  check((await events.owedRecords(windowed, offsets[3])).length === 0, "since at the last record: nothing is owed");

  // a compaction-free log has no disk-only half: the resident window is all of
  // it. (It must not contain a compaction line: without a `cpr_start` header a
  // legacy log derives its window from the newest compaction line.)
  const plain = encode([
    make({ type: "user_message", content: "a" }),
    make({ type: "assistant_message", content: "b" }),
  ]);
  const plainLog = await openAt(plain.buf, 0);
  check(plainLog.cprStart === 0, "no compaction: the window starts at the region start");
  check((await events.owedRecords(plainLog, null)).length === 2, "no compaction: the window is the whole log");
}

async function prelude() {
  const list = [
    make({ type: "user_message", content: "one" }),
    make({ type: "assistant_message", content: "two" }),
    make({ type: "compaction", summary: "summary" }),
    make({ type: "assistant_message", content: "three" }),
  ];
  const { buf, offsets } = encode(list);
  const log = await openAt(buf, offsets[2]);
  const total = buf.length;

  const fresh = await events.ssePrelude(log, { stamp: STAMP });
  check(fresh[0] === events.stateUpdateFrame("idle", STAMP), "a stream opens with the status frame");
  check(JSON.stringify(kinds(fresh)) === JSON.stringify(["state_update", "history", "compaction", "assistant_message", "replayed"]), "then history, the owed records, then replayed");
  check(fresh[fresh.length - 1] === events.replayedFrame(2), "the block is closed with the number of records it sent");
  check(payloads(fresh)[1] === `{"type": "history", "older": ${offsets[2]}}`, "history carries the model window's start, in bytes");

  const busy = await events.ssePrelude(log, { stamp: STAMP, busy: true });
  check(busy[0] === events.stateUpdateFrame("running", STAMP), "a run in flight reports running, not a reset to idle");

  const catchUp = await events.ssePrelude(log, { stamp: STAMP, since: 0 });
  check(JSON.stringify(offsetsOf(catchUp)) === JSON.stringify([offsets[1], offsets[2], offsets[3]]), "since: the disk half and the window, in order");

  const nothing = await events.ssePrelude(log, { stamp: STAMP, since: offsets[3] });
  check(nothing[nothing.length - 1] === events.replayedFrame(0), "an up-to-date window is owed an empty block, not silence");

  const resync = await events.ssePrelude(log, { stamp: STAMP, since: total + 1 });
  check(
    JSON.stringify(kinds(resync)) === JSON.stringify(["state_update", "resync", "history", "compaction", "assistant_message", "replayed"]),
    "an offset past the end of the log is a resync followed by the window"
  );
  const edge = await events.ssePrelude(log, { stamp: STAMP, since: total });
  check(kinds(edge).includes("history") && !kinds(edge).includes("resync"), "an offset AT the end is still this log's (no resync)");

  const legacy = await events.ssePrelude(log, { stamp: STAMP, replay: false });
  check(legacy.length === 1, "the legacy replay=false still gets the status frame and nothing else");
  const forced = await events.ssePrelude(log, { stamp: STAMP, replay: false, since: 0 });
  check(forced.length > 1, "a legacy flag cannot cancel an explicit since");

  const empty = await events.ssePrelude(null, { stamp: STAMP, since: 0 });
  check(empty.length === 1, "nothing open: the status frame is still owed (the window paints it as a reset)");

  const twice = await events.ssePrelude(log, { stamp: STAMP, since: 0 });
  check(JSON.stringify(twice) === JSON.stringify(catchUp), "the prelude is a function of its inputs (no clock, no uuid in a replay)");
}

function manifestMarker() {
  const entry = MANIFEST.endpoints.find((ep) => ep.id === "sse.frames");
  check(entry && entry.owner === "M2", "sse.frames is M2's to enforce");
  check(entry && entry.status === "enforced", "sse.frames is marked enforced now that the host answers it");
}

// ---- 7. the fan-out: bounded queues, one marker, project filtering -------

// A subscriber that stopped draining must not be buffered forever, and the one
// thing it is owed is "you lost frames, re-read from your own offset". Both
// halves are policy (agent/base.py), so they are pinned here rather than where
// the socket lives.
function broadcast() {
  const base = fs.readFileSync(path.join(ROOT, "agent", "base.py"), "utf8");
  const bound = /^SUBSCRIBER_QUEUE_MAX = (\d+)$/m.exec(base);
  check(bound !== null, "agent/base.py declares SUBSCRIBER_QUEUE_MAX");
  check(
    bound !== null && Number(bound[1]) === events.SUBSCRIBER_QUEUE_MAX,
    `the host's queue bound matches the Python host (${events.SUBSCRIBER_QUEUE_MAX} frames)`
  );
  check(
    /if ev is LAGGED/.test(fs.readFileSync(path.join(ROOT, "agent", "api", "events.py"), "utf8")),
    "agent/api/events.py ends the stream on LAGGED (the marker IS the remedy)"
  );

  const bus = events.createBroadcaster();
  check(bus.count() === 0, "nobody watching yet");

  const all = bus.subscribe();
  const mine = bus.subscribe("projects/a.clc");
  const theirs = bus.subscribe("projects/b.clc");
  check(bus.count() === 3, "every subscription is counted");
  check(bus.count("projects/a.clc") === 2, "a project counts its own watchers PLUS the unfiltered ones");
  check(bus.count("projects/c.clc") === 1, "…and a project nobody watches only counts the unfiltered one");

  const ev1 = { type: "text_delta", delta: "a" };
  bus.publish(ev1);
  check(all.shift() === ev1 && mine.shift() === ev1 && theirs.shift() === ev1, "a publish fans out to every subscriber");
  check(all.peek() === undefined, "a drained queue is empty");

  // the live tail's filter: another window's run is not this stream's business
  check(events.wantsEvent(all, "projects/b.clc") === true, "an unfiltered stream sees every project");
  check(events.wantsEvent(theirs, "projects/b.clc") === true, "a stream sees its own project");
  check(events.wantsEvent(theirs, "projects/a.clc") === false, "a stream does not see another project's run");
  check(events.wantsEvent(theirs, null) === true, "with no run project there is nothing to filter");

  // the bound: a subscriber that never drains is emptied to ONE marker
  const slow = bus.subscribe();
  for (let i = 0; i <= events.SUBSCRIBER_QUEUE_MAX; i += 1) bus.publish({ type: "text_delta", delta: String(i) });
  check(slow.peek() === events.LAGGED, "past the bound the queue holds the marker, not the backlog");
  check(slow.size === 1, "exactly one marker is left, whatever was dropped");
  check(events.isLagged(slow.shift()) === true, "and the consumer can recognise it by identity");
  check(events.LAGGED !== events.LAGGED.toString && !("type" in events.LAGGED), "the marker is not an event: it has no type to serialize");
  check(slow.size === 0, "the stream is expected to end here, not to drain the marker and continue");

  // a run publishes deltas: a bounded depth of small frames, never bytes
  const chatty = bus.subscribe();
  bus.publish({ type: "text_delta", delta: "x".repeat(64) });
  check(chatty.size === 1, "one frame per publish, however large the frame");

  // unsubscribing IS the count that answers "is anyone watching?"
  bus.unsubscribe(chatty);
  check(bus.count() === 4, "an unsubscribe drops the subscriber");
  bus.unsubscribe(slow);
  check(bus.count("projects/a.clc") === 2, "and it stops counting toward its project (its own watcher + the unfiltered one)");
  const before = bus.count();
  bus.publish({ type: "text_delta", delta: "gone" });
  check(bus.count() === before && all.peek() !== undefined, "a publish after an unsubscribe still reaches the rest");
  check(mine.project === "projects/a.clc" && all.project === null, "the queue remembers which project it watches");
}

async function main() {
  goldenFrames();
  offsetRule();
  escaping();
  keepalive();
  await catchUp();
  await prelude();
  broadcast();
  manifestMarker();
  summary("host-events");
}

module.exports = { COVERED };

if (require.main === module) {
  main().catch((error) => {
    check(false, `suite crashed: ${(error && error.stack) || error}`);
    summary("host-events");
  });
}
