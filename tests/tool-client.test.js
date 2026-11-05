// ui/tool-client.js: one tool call, run by the execution layer (P3).
//
// The loop is in the host now (TODO.md D1); what stayed behind is the one thing
// only the machine can decide — whether a call may run, and what it did. This
// runner drives the REAL client against a real local HTTP server, so what is
// checked is the request it really sends, the answer it really folds, and the
// one thing it does without waiting for a reply: Stop.
//
//  1. `run()` sends the model's own call verbatim — `name`, the raw JSON
//     `arguments` string, the `tool_call_id` that names it on both sides — plus
//     the session's mode, and turns `{content, is_error, diff}` into the loop's
//     `{content, isError, diff}`.
//  2. A tool's own failure is a RESULT (`is_error: true`, 200), not an
//     exception: the model has to read it. An exception means the request
//     itself could not be satisfied (no project, read-only, session gone).
//  3. `cancel()` is one id on the wire; Stop fires it for a call still in
//     flight BEFORE dropping that call's connection, because leaving a socket
//     cannot kill a process group.
//  4. Nothing is guessed: a missing `content`, somebody else's `tool_call_id`,
//     pre-parsed `arguments` — refused, not filled in.
// Run: node tests/tool-client.test.js
"use strict";

const http = require("http");
const { check, summary } = require("./harness.js");
const { createToolClient } = require("../ui/tool-client.js");

// ---- the session's two endpoints, faked only at the socket ------------------

function fakeSession() {
  const requests = [];
  let answer = () => ({ status: 200, body: {} });
  const open = new Set();
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
      const a = answer(req, body);
      if (!a) {
        open.add(res); // a call still running: no answer, no close
        return;
      }
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
    hang() {
      answer = () => undefined; // every request waits: a call blocked on a prompt
    },
    close() {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close();
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

// A request the client sends without awaiting (the Stop path): wait for it to
// reach the server rather than guess how many turns of the event loop that takes.
async function waitFor(fn, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

const CALL = { id: "call_1", name: "run_command", arguments: '{"command":"ls"}' };
const ANSWER = { tool_call_id: "call_1", content: "a.txt\nb.txt", is_error: false, diff: "" };

async function main() {
  const fake = fakeSession();
  const base = await listen(fake);

  // ---- 1. the call, verbatim, and its fold --------------------------------
  const tools = createToolClient({ base, mode: "work" });
  fake.setAnswer(() => ({ status: 200, body: ANSWER }));
  const result = await tools.run({ call: CALL });
  const sent = fake.requests[fake.requests.length - 1];
  check(sent.method === "POST" && sent.url === "/api/exec", "run() is POST /api/exec");
  check(
    same(Object.keys(sent.body).sort(), ["arguments", "mode", "name", "tool_call_id"]),
    "the request is exactly the call plus the mode — no policy, no derived fields"
  );
  check(sent.body.name === "run_command" && sent.body.tool_call_id === "call_1", "the call's own name and id");
  check(
    sent.body.arguments === '{"command":"ls"}',
    "the arguments go as the model's raw JSON string (the machine's policy parses it, not us)"
  );
  check(sent.body.mode === "work", "the session's mode rides along");
  check(/application\/json/.test(sent.headers["content-type"]), "the request is JSON");
  check(result.content === "a.txt\nb.txt" && result.isError === false, "the answer is folded into the loop's result");
  check(result.diff === "", "and its diff is carried as the host speaks it");

  fake.setAnswer(() => ({
    status: 200,
    body: { tool_call_id: "call_1", content: "no such file", is_error: true, diff: "x" },
  }));
  const failed = await tools.run({ call: CALL });
  check(failed.isError === true && failed.content === "no such file", "a tool's own failure is a result, not an exception");
  check(failed.diff === "x", "a tool's diff survives its failure");

  fake.setAnswer(() => ({ status: 200, body: { tool_call_id: "call_1", content: "ok", is_error: false } }));
  const noDiff = await tools.run({ call: CALL });
  check(noDiff.diff === "", "an answer without a diff is empty, not undefined");

  // ---- 2. a refusal of the CALL is a result; a refusal of the REQUEST is not
  fake.setAnswer(() => ({ status: 409, body: { error: "no project is open" } }));
  const closed = await rejects(tools.run({ call: CALL }));
  check(closed !== null, "a session with no project is an error here");
  check(closed && closed.status === 409, "with the wire's status");
  check(closed && /no project is open/.test(closed.message), "and the session's own sentence (the model must not read it)");

  fake.setAnswer(() => ({ status: 409, body: { error: "project is read-only", code: "read_only" } }));
  const ro = await rejects(tools.run({ call: CALL }));
  check(ro && ro.status === 409 && ro.code === "read_only", "a read-only project carries the machine's code");

  fake.setAnswer(() => ({
    status: 400,
    body: { error: "arguments must be the model's raw JSON string" },
  }));
  const shape = await rejects(tools.run({ call: CALL }));
  check(shape && shape.status === 400, "a client bug is surfaced, not turned into a tool result");

  // ---- 3. nothing is guessed ----------------------------------------------
  let before = fake.requests.length;
  const dict = await rejects(tools.run({ call: { ...CALL, arguments: { command: "ls" } } }));
  check(dict instanceof TypeError, "pre-parsed arguments are refused (two shapes for one fact)");
  check(fake.requests.length === before, "and nothing was sent for them");

  const noId = await rejects(tools.run({ call: { ...CALL, id: "" } }));
  const noName = await rejects(tools.run({ call: { ...CALL, name: undefined } }));
  check(noId instanceof TypeError && noName instanceof TypeError, "a call without its id or name is refused");
  check(fake.requests.length === before, "and neither was sent");

  fake.setAnswer(() => ({ status: 200, body: { ...ANSWER, tool_call_id: "call_other" } }));
  const wrong = await rejects(tools.run({ call: CALL }));
  check(wrong !== null && /answered tool_call_id/.test(wrong.message), "an answer addressed to another call is refused, not applied");

  fake.setAnswer(() => ({ status: 200, body: { tool_call_id: "call_1", is_error: false, diff: "" } }));
  const noContent = await rejects(tools.run({ call: CALL }));
  check(noContent instanceof TypeError, "an answer without its content is refused, not defaulted to empty");

  // ---- 4. mode -------------------------------------------------------------
  let badMode = null;
  try {
    createToolClient({ base, mode: "auto" });
  } catch (e) {
    badMode = e;
  }
  check(badMode instanceof TypeError, "an unknown mode throws at construction, not on the first call");

  fake.setAnswer(() => ({ status: 200, body: ANSWER }));
  const chat = createToolClient({ base, mode: "chat" });
  await chat.run({ call: CALL });
  check(fake.requests[fake.requests.length - 1].body.mode === "chat", "mode: chat reaches the session");

  const host = createToolClient({ base });
  await host.run({ call: CALL });
  const bare = fake.requests[fake.requests.length - 1].body;
  check(!Object.prototype.hasOwnProperty.call(bare, "mode"), "an unset mode is omitted, not sent as undefined");

  // ---- 5. cancel -----------------------------------------------------------
  fake.setAnswer(() => ({ status: 200, body: { status: "cancelling" } }));
  const cancelled = await tools.cancel("call_1");
  const c = fake.requests[fake.requests.length - 1];
  check(c.method === "POST" && c.url === "/api/exec/cancel", "cancel() is POST /api/exec/cancel");
  check(same(c.body, { tool_call_id: "call_1" }), "the one id names the call to interrupt");
  check(cancelled.status === "cancelling", "and the machine's answer is handed back");

  fake.setAnswer(() => ({ status: 404, body: { error: "no call in flight with this tool_call_id" } }));
  const gone = await rejects(tools.cancel("call_1"));
  check(gone && gone.status === 404, "a cancel for nothing in flight is an error with its status");
  check(gone && /no call in flight/.test(gone.message), "and its sentence, for the caller that has to decide");

  before = fake.requests.length;
  const noCancelId = await rejects(tools.cancel(""));
  check(noCancelId instanceof TypeError && fake.requests.length === before, "cancel without an id is refused before asking");

  // ---- 6. Stop reaches a call still running -------------------------------
  fake.hang();
  const ctl = new AbortController();
  const running = rejectCatcher(tools.run({ call: { ...CALL, id: "call_9" }, signal: ctl.signal }));
  check(await waitFor(() => fake.requests.some((r) => r.url === "/api/exec")), "the call is in flight");

  fake.setAnswer(() => ({ status: 200, body: { status: "cancelling" } }));
  ctl.abort();
  const aborted = await running;
  check(aborted !== null, "Stop makes the call reject rather than answer");
  const sawCancel = await waitFor(() =>
    fake.requests.some((r) => r.url === "/api/exec/cancel" && r.body && r.body.tool_call_id === "call_9")
  );
  check(sawCancel, "Stop tells the session which call to interrupt, on its own connection");
  const after = fake.requests.filter((r) => r.url === "/api/exec/cancel").pop();
  check(same(Object.keys(after.body), ["tool_call_id"]), "and that is all it sends");

  // ---- 7. a client without a session has no address to fall back to --------
  let noBase = null;
  try {
    createToolClient({});
  } catch (e) {
    noBase = e;
  }
  check(noBase instanceof TypeError && /base is required/.test(String(noBase.message)), "no base is an error at construction");

  const trailing = createToolClient({ base: `${base}/`, mode: "work" });
  fake.setAnswer(() => ({ status: 200, body: ANSWER }));
  await trailing.run({ call: CALL });
  check(fake.requests[fake.requests.length - 1].url === "/api/exec", "a trailing slash is not a second path");

  fake.close();
  summary("tool-client");
}

async function rejectCatcher(promise) {
  return rejects(promise);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
