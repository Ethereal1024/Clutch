// ui/log-client.js: the .clc's three ports over the session's HTTP (P2).
//
// The loop and the compactor speak events and offsets; the execution layer
// speaks JSON. This runner drives the REAL client against a real local HTTP
// server, so what is checked is the wire it really sends and the answer it
// really folds — not a mock of its own assumptions. What it pins:
//
//  1. `read()` is `GET /api/log` with no body, and the snapshot it answers is
//     handed on untouched (the loop's next step is built from it).
//  2. `append()` nests the event under `event` (the wire's shape) and answers it
//     AS PERSISTED: the offset the server stamped lives BESIDE the record on the
//     wire and is folded ONTO it here, because compaction slides the window to
//     `written.log_offset`.
//  3. A refusal is an ERROR carrying the session's own sentence and its code —
//     never an empty log (an empty log reads as "the turn finished") and never a
//     quiet success (I3).
//  4. `slideWindow` is one integer on the wire, and its answer is the new
//     boundary — a 200 without one is a bug, not a no-op.
// Run: node tests/log-client.test.js
"use strict";

const http = require("http");
const { check, summary } = require("./harness.js");
const { createLogClient } = require("../ui/log-client.js");

// ---- the session's endpoints, faked only at the socket ----------------------

function fakeSession() {
  const requests = [];
  let answer = () => ({ status: 200, body: {} });
  let hang = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch (e) {
        body = text;
      }
      requests.push({ method: req.method, url: req.url, body, headers: req.headers });
      if (hang) return; // a dead session: no answer, no close
      const a = answer(req, body) || {};
      res.writeHead(a.status || 200, { "Content-Type": "application/json" });
      res.end(a.raw !== undefined ? a.raw : JSON.stringify(a.body === undefined ? {} : a.body));
    });
  });
  return {
    requests,
    server,
    setAnswer(fn) {
      answer = fn;
    },
    setHang(v) {
      hang = v;
    },
  };
}

async function listen(fake) {
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${fake.server.address().port}`;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return null;
}

const SNAPSHOT = {
  project: "/tmp/p/p.clc",
  items: [
    { offset: 0, event: { type: "user_message", content: "do it" } },
    { offset: 64, event: { type: "assistant_message", content: "doing" } },
  ],
  windowBytes: 128,
  cprStart: 64,
  lastCompaction: null,
};

async function main() {
  const fake = fakeSession();
  const base = await listen(fake);
  const log = createLogClient({ base });

  // ---- 1. read ------------------------------------------------------------
  fake.setAnswer(() => ({ status: 200, body: SNAPSHOT }));
  const got = await log.read();
  const sent = fake.requests[fake.requests.length - 1];
  check(sent.method === "GET" && sent.url === "/api/log", "read() is GET /api/log");
  check(sent.body === undefined, "read() sends no body (the log is addressed by the session's project)");
  check(same(got, SNAPSHOT), "read() hands the snapshot on untouched — items, sizes, boundary, last compaction");

  fake.setAnswer(() => ({ status: 200, body: { items: [] } }));
  const err = await rejects(log.read());
  check(err && err instanceof TypeError, "a read without a boundary is refused, not treated as an empty log");
  check(err && /windowBytes/.test(err.message), "and says which half of the contract is missing");

  // ---- 2. append ----------------------------------------------------------
  fake.setAnswer(() => ({
    status: 200,
    body: { offset: 1234, event: { type: "assistant_message", content: "next" } },
  }));
  const written = await log.append({ type: "assistant_message", content: "next" });
  const post = fake.requests[fake.requests.length - 1];
  check(post.method === "POST" && post.url === "/api/log", "append() is POST /api/log");
  check(
    post.headers["content-type"] === "application/json",
    "append() sends JSON (the endpoint parses a body, not a query)"
  );
  check(
    same(post.body, { event: { type: "assistant_message", content: "next" } }),
    "append() nests the event under `event`, exactly as the event is"
  );
  check(written.log_offset === 1234, "append() folds the answered offset onto the record as log_offset");
  check(written.content === "next" && written.type === "assistant_message", "and keeps the persisted record's own fields");
  check(written.offset === undefined, "the wire's `offset` key does not survive as a second spelling");

  fake.setAnswer(() => ({ status: 400, body: { error: "not a durable event type: text_delta", code: "not_durable" } }));
  const refused = await rejects(log.append({ type: "text_delta", content: "x" }));
  check(refused !== null, "a non-durable event is refused by the session (a client bug is not swallowed)");
  check(refused && refused.status === 400, "with the wire's status on the error");
  check(refused && refused.code === "not_durable", "and the machine's code, so a caller can act on the refusal");
  check(refused && /not a durable event type: text_delta/.test(refused.message), "and the session's own sentence");

  const before = fake.requests.length;
  const bad = await rejects(log.append({ content: "no type" }));
  check(bad instanceof TypeError && fake.requests.length === before, "append() refuses an event with no type before asking");

  fake.setAnswer(() => ({ status: 200, body: { offset: 7 } }));
  const noEvent = await rejects(log.append({ type: "final", status: "done", summary: "ok" }));
  check(noEvent instanceof TypeError, "an append answered without its record is refused, not guessed");

  // ---- 3. slideWindow -----------------------------------------------------
  fake.setAnswer(() => ({ status: 200, body: { cprStart: 1234, windowBytes: 16 } }));
  const slid = await log.slideWindow(1234);
  const win = fake.requests[fake.requests.length - 1];
  check(win.method === "POST" && win.url === "/api/log/window", "slideWindow() is POST /api/log/window");
  check(same(win.body, { offset: 1234 }), "the new start is the one integer the slide takes");
  check(slid.cprStart === 1234 && slid.windowBytes === 16, "and the answer is the boundary that is now in force");

  const n = fake.requests.length;
  const badOffset = await rejects(log.slideWindow("1234"));
  const nan = await rejects(log.slideWindow(NaN));
  check(badOffset instanceof TypeError && nan instanceof TypeError, "a non-number offset is refused before asking");
  check(fake.requests.length === n, "and nothing was sent for it");

  fake.setAnswer(() => ({ status: 200, body: {} }));
  const noBoundary = await rejects(log.slideWindow(10));
  check(noBoundary instanceof TypeError, "a slide answered without its new boundary is refused");

  fake.setAnswer(() => ({ status: 409, body: { error: "project is read-only", code: "read_only" } }));
  const ro = await rejects(log.slideWindow(10));
  check(ro && ro.status === 409 && ro.code === "read_only", "a read-only session refuses the slide, and it is an error here");
  check(ro && /project is read-only/.test(ro.message), "the refusal is quoted in the message");

  fake.setAnswer(() => ({ status: 200, body: { items: [], windowBytes: 0, cprStart: 0 } }));
  const trailing = createLogClient({ base: `${base}/` });
  check((await trailing.read()) !== null, "a trailing slash on the base is not a second path");

  // ---- 4. nothing is invented ---------------------------------------------
  let noBase = null;
  try {
    createLogClient({});
  } catch (e) {
    noBase = e;
  }
  check(noBase instanceof TypeError, "a client without a session address throws at construction, not at first use");
  check(/base is required/.test(String(noBase && noBase.message)), "and there is no default address to fall back to");

  fake.setHang(true);
  const slow = createLogClient({ base, timeoutMs: 150 });
  const dead = await rejects(slow.read());
  check(dead !== null, "a session that never answers is an error, not a hang");
  check(dead && /no answer within 150ms/.test(dead.message), "the error says what it waited for");
  fake.setHang(false);

  fake.setAnswer(() => ({ status: 200, raw: "not json" }));
  const junk = await rejects(log.read());
  check(junk instanceof TypeError, "a 200 that is not the contract is refused, not half-used");

  fake.server.close();
  summary("log-client");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
