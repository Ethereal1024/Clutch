// ui/llm-client.js is the host's model client: one streaming turn, the retry
// ladder around it, and the errors the loop acts on. Every check here talks to a
// real HTTP server over a real socket — SSE chunks, a mid-stream reset, a body
// that goes quiet — because those are the failures the client exists to tell
// apart. The probe and the retry policy are driven directly where a network
// cannot be half-killed on purpose.
// Run: node tests/llm-client.test.js
const http = require("http");
const { check, summary } = require("./harness.js");
const {
  createLlmClient,
  LlmError,
  backoffMs,
  probeAlive,
  READ_TIMEOUT_MS,
  STALL_PROBE_MS,
  MAX_BACKOFF_MS,
} = require("../ui/llm-client.js");

// ---- a provider that answers exactly what a test tells it to ----
function serve(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        /* a malformed request body is the client's bug; the handler sees null */
      }
      requests.push({ url: req.url, headers: req.headers, body, raw });
      handler({ req, res, body, index: requests.length - 1, requests });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        requests,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            if (server.closeAllConnections) server.closeAllConnections();
            server.close(() => done());
          }),
      })
    );
  });
}

const head = (res) => res.writeHead(200, { "Content-Type": "text/event-stream" });
const chunk = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const end = (res) => res.end("data: [DONE]\n\n");
const say = (text) => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
const think = (text) => ({ choices: [{ delta: { reasoning_content: text }, finish_reason: null }] });
const stop = (reason = "stop") => ({ choices: [{ delta: {}, finish_reason: reason }] });

const MSGS = [{ role: "user", content: "do it" }];

async function collect(client, args) {
  const events = [];
  for await (const ev of client.stream({ messages: MSGS, ...args })) events.push(ev);
  return events;
}

async function main() {
  // ---- 1. the policy numbers are the loop's, not the proxy's ----
  {
    check(READ_TIMEOUT_MS === 240000, "the read budget is llm_read_timeout (240s), not the proxy's 90s");
    check(STALL_PROBE_MS === 20000, "the stall clock is STALL_PROBE_S (20s)");
    check(MAX_BACKOFF_MS === 60000, "the ladder stops doubling at 60s (D12)");
    const ladder = [0, 1, 2, 3, 4, 5, 6, 7, 12].map((n) => backoffMs(n));
    check(
      ladder.join(",") === "1000,2000,4000,8000,16000,32000,60000,60000,60000",
      "1,2,4,8,16,32 then hold at 60 — a doubling ladder with a ceiling"
    );
    check(backoffMs(9, 100) === 100, "the ceiling is a parameter, so a test does not wait a minute");

    let err = null;
    try {
      createLlmClient({ baseUrl: "https://x", model: "m" });
    } catch (e) {
      err = e;
    }
    check(err && /apiKey/.test(err.message), "a client without its key refuses to exist");
    err = null;
    try {
      createLlmClient({ baseUrl: "https://x", model: "m", apiKey: "k", protocol: "grpc" });
    } catch (e) {
      err = e;
    }
    check(
      err && /unknown LLM protocol: grpc \(the host speaks chat and responses\)/.test(err.message),
      "a third protocol is refused by name, and the two the host speaks are named back"
    );
  }

  // ---- 2. one whole turn: reasoning, text, two calls split across chunks ----
  {
    const peer = await serve(({ res }) => {
      head(res);
      chunk(res, think("let me think"));
      chunk(res, say("let me "));
      chunk(res, say("look"));
      chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run_command", arguments: "" } }] }, finish_reason: null }] });
      chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }, finish_reason: null }] });
      chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] });
      chunk(res, { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: null }] });
      chunk(res, stop("tool_calls"));
      end(res);
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "test-model", apiKey: "sk-test" });
      const events = await collect(client);
      check(
        events.map((e) => e.type).join(",") ===
          "reasoning,text,text,tool_call_start,tool_call_delta,tool_call_delta,tool_call_start,tool_call_delta,finish",
        "the event protocol is reasoning → text → tool starts/deltas → finish (a call that arrives whole still gets its start and its one delta, as chunk_handle does)"
      );
      const fin = events[events.length - 1];
      check(fin.reason === "tool_calls" && fin.content === "let me look", "the finish carries the accumulated text");
      check(
        fin.tool_calls.length === 2 && fin.tool_calls[0].id === "c1" && fin.tool_calls[0].arguments === '{"cmd":"ls"}' && fin.tool_calls[1].name === "read_file",
        "and the calls rebuilt from their fragments, in index order"
      );
      check(fin.reasoning === "let me think", "reasoning is accumulated beside the text, never inside it");

      // the wire: base URL + the resource, the client's key, the protocol body
      const req = peer.requests[0];
      check(req.url === "/chat/completions", "the request lands on the chat-completions resource");
      check(req.headers.authorization === "Bearer sk-test", "the client's own key is sent");
      check(req.body && req.body.model === "test-model" && req.body.stream === true, "the body names the model and asks for a stream");
      check(req.body.messages.length === 1 && req.body.tools === undefined, "no tools declared, no tools sent");
    } finally {
      await peer.close();
    }
  }

  // ---- 3. an upstream with a path keeps it; tools and reasoning ride along ----
  {
    const peer = await serve(({ res }) => {
      head(res);
      chunk(res, say("ok"));
      chunk(res, stop());
      end(res);
    });
    try {
      const client = createLlmClient({
        baseUrl: peer.base + "/api/paas/v4",
        model: "glm",
        apiKey: "k",
        reasoningEffort: "high",
      });
      const tools = [{ type: "function", function: { name: "run_command", parameters: { type: "object" } } }];
      const asked = await client.ask({ messages: MSGS, tools });
      check(asked.content === "ok" && asked.finishReason === "stop", "ask() answers the loop's shape");
      check(peer.requests[0].url === "/api/paas/v4/chat/completions", "a base URL with its own path is joined, not replaced");
      check(peer.requests[0].body.tools.length === 1, "declared tools reach the provider");
      check(
        peer.requests[0].body.thinking && peer.requests[0].body.thinking.reasoning_effort === "high",
        "reasoning_effort rides in the provider's thinking block"
      );
    } finally {
      await peer.close();
    }
  }

  // ---- 4. a mid-stream reset is announced and redialled, not fatal ----
  {
    const peer = await serve(({ res, index }) => {
      head(res);
      if (index === 0) {
        chunk(res, say("half a sen"));
        // Wait for the half to reach the client before killing the socket: this
        // section is about a turn that already took text, so the clock has to be
        // a real mid-stream drop, not a connection that died in the handshake.
        setTimeout(() => res.socket.destroy(), 25);
        return;
      }
      chunk(res, say("the whole answer"));
      chunk(res, stop());
      end(res);
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k", backoffCapMs: 5 });
      const notices = [];
      const asked = await client.ask({ messages: MSGS, onRetry: (n) => notices.push(n) });
      check(peer.requests.length === 2, "the dead attempt was redialled");
      check(notices.length === 1, "exactly one retry was announced");
      const n = notices[0];
      check(n.attempt === 1 && n.max === 0, "the notice numbers the retry and says there is no cap");
      check(n.code === "connection" && n.discard === true, "it names the failure and asks the caller to discard the dead half");
      check(/retrying \(1\/…\)/.test(n.message), "and says what is happening, in words a UI can show");
      check(
        asked.content === "the whole answer",
        "the retried answer is the only text: the discarded half never reached the turn"
      );
      const events = await collect(client);
      check(events[events.length - 1].content === "the whole answer", "a fresh turn starts clean after the retry");
    } finally {
      await peer.close();
    }
  }

  // ---- 5. a truncated body is a transport failure, not a short answer ----
  {
    const peer = await serve(({ res, index }) => {
      head(res);
      chunk(res, say("almost"));
      if (index === 0) {
        end(res); // [DONE] but no finish chunk: the turn never completed
        return;
      }
      chunk(res, stop());
      end(res);
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k", backoffCapMs: 5 });
      const notices = [];
      const asked = await client.ask({ messages: MSGS, onRetry: (n) => notices.push(n) });
      check(peer.requests.length === 2, "a body that ends without its finish is redialled");
      check(notices.length === 1 && /ended before its finish/.test(notices[0].message), "and the reason is named");
      check(asked.content === "almost", "the second attempt's answer is what the turn got");
    } finally {
      await peer.close();
    }
  }

  // ---- 6. provider failures the ladder must not touch ----
  {
    const peer = await serve(({ res }) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "messages: invalid role", code: "invalid_request" } }));
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k", backoffCapMs: 5 });
      let err = null;
      try {
        await client.ask({ messages: MSGS });
      } catch (e) {
        err = e;
      }
      check(err instanceof LlmError && err.code === "api_error" && !err.retryable, "a malformed request is not retried");
      check(/messages: invalid role \(code invalid_request, HTTP 400\)/.test(err.message), "the provider's own words and status, not a dump");
      check(peer.requests.length === 1, "one request, one refusal");
    } finally {
      await peer.close();
    }
  }

  // ---- 7. the context window is the loop's cue to compact, not an error ----
  {
    const peer = await serve(({ res }) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens" } }));
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k", backoffCapMs: 5 });
      let err = null;
      try {
        await client.ask({ messages: MSGS });
      } catch (e) {
        err = e;
      }
      check(err && err.code === "context_window_exceeded" && !err.retryable, "an overflow is its own code: compact and try again, never redial blindly");
      check(peer.requests.length === 1, "and it is not retried");
    } finally {
      await peer.close();
    }
  }

  // ---- 8. an auth failure is final and readable ----
  {
    const peer = await serve(({ res }) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k", backoffCapMs: 5 });
      let err = null;
      try {
        await client.ask({ messages: MSGS });
      } catch (e) {
        err = e;
      }
      check(err && err.code === "api_error" && !err.retryable, "a rejected key is not a transient failure");
      check(err.message === "Invalid API key (HTTP 401)", "the sentence a user can act on");
    } finally {
      await peer.close();
    }
  }

  // ---- 9. Stop reaches a read that is already parked ----
  {
    const peer = await serve(({ res }) => {
      head(res);
      chunk(res, say("partial"));
      // ... and then nothing: a Stop has to be able to end this from outside
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k" });
      const ac = new AbortController();
      let err = null;
      const turn = client.ask({
        messages: MSGS,
        signal: ac.signal,
        onEvent: (ev) => {
          if (ev.type === "text") ac.abort();
        },
      });
      try {
        await turn;
      } catch (e) {
        err = e;
      }
      check(err instanceof LlmError && err.code === "cancelled", "a stop mid-stream ends the turn as cancelled");
      check(peer.requests.length === 1, "and it is not retried");
      check(ac.signal.aborted, "the caller's signal is what said so");
    } finally {
      await peer.close();
    }
  }

  // ---- 10. the watchdog tells a thinking provider from a dead path ----
  {
    // path gone: silence past the stall clock and the probe says nothing is there
    const dead = await serve(({ res, index }) => {
      head(res);
      if (index === 0) {
        chunk(res, say("half"));
        return; // silence, with the socket still open
      }
      chunk(res, say("done"));
      chunk(res, stop());
      end(res);
    });
    try {
      let asked = 0;
      const client = createLlmClient({
        baseUrl: dead.base,
        model: "m",
        apiKey: "k",
        stallMs: 40,
        backoffCapMs: 5,
        probe: async () => (asked += 1, false),
      });
      const started = Date.now();
      const notices = [];
      const out = await client.ask({ messages: MSGS, onRetry: (n) => notices.push(n) });
      check(asked > 0, "silence past the stall clock asks the path whether it is still there");
      check(notices.length === 1 && /connection path went away/.test(notices[0].message), "a path that answers nothing is killed and named");
      check(out.content === "done", "and the redial completes the turn");
      check(Date.now() - started >= 40, "the attempt was left alone until the stall clock ran out");
    } finally {
      await dead.close();
    }

    // provider thinking: the same silence, but the path is there — never killed
    const slow = await serve(({ res }) => {
      head(res);
      chunk(res, say("still "));
      setTimeout(() => {
        chunk(res, say("here"));
        chunk(res, stop());
        end(res);
      }, 700);
    });
    try {
      const client = createLlmClient({
        baseUrl: slow.base,
        model: "m",
        apiKey: "k",
        stallMs: 40,
        backoffCapMs: 5,
        probe: async () => true,
      });
      const notices = [];
      const out = await client.ask({ messages: MSGS, onRetry: (n) => notices.push(n) });
      check(notices.length === 0 && slow.requests.length === 1, "a provider that is thinking is not punished for it");
      check(out.content === "still here", "the long pause costs nothing but the wait");
    } finally {
      await slow.close();
    }
  }

  // ---- 11. never gives up: the ladder has no last attempt ----
  {
    const peer = await serve(({ res }) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream unavailable" } }));
    });
    try {
      const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k", backoffCapMs: 1 });
      const ac = new AbortController();
      const seen = [];
      let err = null;
      try {
        for await (const ev of client.stream({ messages: MSGS, signal: ac.signal })) {
          if (ev.type === "retry") {
            seen.push(ev);
            if (seen.length === 4) ac.abort(); // the only exit there is
          }
        }
      } catch (e) {
        err = e;
      }
      check(seen.length === 4, "four failures, four announcements — no giving up before the cap that does not exist");
      check(seen.map((n) => n.attempt).join(",") === "1,2,3,4", "each notice names its own attempt");
      check(seen.every((n) => n.max === 0 && n.code === "api_error"), "and the reason, with no attempt cap to report");
      check(err && err.code === "cancelled", "Stop is what ended it");
      check(peer.requests.length === 4, "four attempts reached the provider");
    } finally {
      await peer.close();
    }
  }

  // ---- 12. the probe itself: any response means the path is there ----
  {
    const peer = await serve(({ res }) => {
      res.writeHead(404).end("no route here");
    });
    const port = new URL(peer.base).port;
    try {
      check((await probeAlive(peer.base, 2000)) === true, "a 404 still means something is serving the path");
    } finally {
      await peer.close();
    }
    check((await probeAlive(peer.base, 300)) === false, `a closed port (${port}) is a path that went away`);
    check((await probeAlive("not a url", 300)) === false, "a base URL that cannot even be parsed is not an answer");
  }

  // ---- 13. the responses wire: a different shape, the same turn ----
  {
    const HISTORY = [
      { role: "system", content: "be brief" },
      { role: "system", content: "answer in Chinese" },
      { role: "user", content: "ls it" },
      {
        role: "assistant",
        content: "running",
        tool_calls: [{ id: "c1", function: { name: "run_command", arguments: '{"cmd":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ];
    const TOOLS = [
      { type: "function", function: { name: "run_command", description: "run", parameters: { type: "object" } } },
    ];

    const peer = await serve(({ res }) => {
      head(res);
      chunk(res, { type: "response.reasoning_text.delta", delta: "thinking" });
      chunk(res, { type: "response.reasoning_summary_part.added" });
      chunk(res, { type: "response.output_text.delta", delta: "let me " });
      chunk(res, { type: "response.output_text.delta", delta: "look" });
      chunk(res, {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", call_id: "c9", name: "run_command" },
      });
      chunk(res, { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"cmd":' });
      chunk(res, { type: "response.function_call_arguments.delta", output_index: 1, delta: '"ls"}' });
      chunk(res, { type: "response.function_call_arguments.done", output_index: 1, arguments: '{"cmd":"ls"}' });
      chunk(res, { type: "response.completed", response: { output: [] } });
      res.end();
    });
    try {
      const client = createLlmClient({
        baseUrl: peer.base,
        model: "test-model",
        apiKey: "sk-test",
        protocol: "responses",
        reasoningEffort: "max",
      });
      check(client.url === `${peer.base}/responses`, "the responses wire puts the client on the responses resource");

      const asked = await client.ask({ messages: HISTORY, tools: TOOLS });
      const req = peer.requests[0];
      check(req.url === "/responses", "the request lands on /responses");
      const body = req.body;
      check(
        body.model === "test-model" && body.stream === true && body.store === false,
        "the body names the model, asks for a stream, and never stores the conversation"
      );
      check(body.messages === undefined, "there is no chat-shaped messages array on this wire");
      check(body.instructions === "be brief\n\nanswer in Chinese", "system prompts become the top-level instructions");
      check(
        JSON.stringify(body.input) ===
          JSON.stringify([
            { role: "user", content: "ls it" },
            { role: "assistant", content: "running" },
            { type: "function_call", call_id: "c1", name: "run_command", arguments: '{"cmd":"ls"}' },
            { type: "function_call_output", call_id: "c1", output: "a.txt" },
          ]),
        "the history replays as items: messages, their calls, and the calls' outputs"
      );
      check(
        body.tools && body.tools[0].name === "run_command" && body.tools[0].function === undefined,
        "tools are flat here, with no nested function object"
      );
      check(body.reasoning && body.reasoning.effort === "high", "the knob's max is the API's high");

      check(
        asked.finishReason === "tool_calls" && asked.content === "let me look" && asked.toolCalls.length === 1,
        "the turn ends as a tool turn with the text that preceded the call"
      );
      check(asked.toolCalls[0].id === "c9" && asked.toolCalls[0].arguments === '{"cmd":"ls"}', "and the call is whole");
      check(asked.reasoning === "thinking\n\n", "reasoning summary parts are joined by a paragraph break");
      check(peer.requests.length === 1, "one turn, one request");
    } finally {
      await peer.close();
    }

    // a provider that answers a stream request without streaming: the terminal
    // Response's own output is the turn
    const buffered = await serve(({ res }) => {
      head(res);
      chunk(res, {
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "all " },
                { type: "output_text", text: "at once" },
              ],
            },
            { type: "function_call", call_id: "c7", name: "read_file", arguments: '{"path":"a"}' },
          ],
        },
      });
      res.end();
    });
    try {
      const client = createLlmClient({ baseUrl: buffered.base, model: "m", apiKey: "k", protocol: "responses" });
      const out = await client.ask({ messages: MSGS });
      check(
        out.content === "all at once" && out.toolCalls.length === 1 && out.toolCalls[0].id === "c7" && out.finishReason === "tool_calls",
        "a feed with no deltas falls back to the terminal response's output — not to nothing"
      );
    } finally {
      await buffered.close();
    }

    // truncation: max_output_tokens is the loop's "length", content_filter a stop
    for (const [reason, expected] of [
      ["max_output_tokens", "length"],
      ["content_filter", "stop"],
    ]) {
      const cut = await serve(({ res }) => {
        head(res);
        chunk(res, { type: "response.output_text.delta", delta: "half an ans" });
        chunk(res, { type: "response.incomplete", response: { incomplete_details: { reason } } });
        res.end();
      });
      try {
        const client = createLlmClient({ baseUrl: cut.base, model: "m", apiKey: "k", protocol: "responses" });
        const out = await client.ask({ messages: MSGS });
        check(out.finishReason === expected, `${reason} ends the turn as ${expected}`);
        check(out.content === "half an ans" && cut.requests.length === 1, "with what did arrive, and no blind redial");
      } finally {
        await cut.close();
      }
    }

    // a failed turn is terminal: the provider's words, and no second request
    const overflow = await serve(({ res }) => {
      head(res);
      chunk(res, {
        type: "response.failed",
        response: { error: { code: "context_length_exceeded", message: "this model's maximum context length is 8192 tokens" } },
      });
      res.end();
    });
    try {
      const client = createLlmClient({ baseUrl: overflow.base, model: "m", apiKey: "k", protocol: "responses", backoffCapMs: 1 });
      let err = null;
      try {
        await client.ask({ messages: MSGS });
      } catch (e) {
        err = e;
      }
      check(err && err.code === "context_window_exceeded", "an overflow is still the code the loop compacts on");
      check(err && /maximum context length/.test(err.message), "the provider's own sentence, untouched");
      check(overflow.requests.length === 1, "and it is not redialled");
    } finally {
      await overflow.close();
    }

    const refused = await serve(({ res }) => {
      head(res);
      chunk(res, { type: "error", code: "invalid_request", message: "tools[0] is malformed" });
      res.end();
    });
    try {
      const client = createLlmClient({ baseUrl: refused.base, model: "m", apiKey: "k", protocol: "responses", backoffCapMs: 1 });
      let err = null;
      try {
        await client.ask({ messages: MSGS });
      } catch (e) {
        err = e;
      }
      check(err && err.code === "invalid_request" && err.retryable === false, "an in-stream error keeps its own code and is not retried");
      check(refused.requests.length === 1, "one request, one refusal");
    } finally {
      await refused.close();
    }

    // a relay that drops the terminal event: whatever arrived is the answer
    const dropped = await serve(({ res }) => {
      head(res);
      chunk(res, { type: "response.output_text.delta", delta: "almost done" });
      res.end();
    });
    try {
      const client = createLlmClient({ baseUrl: dropped.base, model: "m", apiKey: "k", protocol: "responses", backoffCapMs: 1 });
      const out = await client.ask({ messages: MSGS });
      check(out.content === "almost done" && out.finishReason === "stop", "a feed without its terminal event still yields a finish");
      check(dropped.requests.length === 1, "no redial for a feed that reported no failure");
    } finally {
      await dropped.close();
    }

    // the retry ladder is the wire's too: a 503 is announced and redialled
    const flaky = await serve(({ res, index }) => {
      if (index === 0) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "busy" } }));
        return;
      }
      head(res);
      chunk(res, { type: "response.output_text.delta", delta: "second try" });
      chunk(res, { type: "response.completed", response: { output: [] } });
      res.end();
    });
    try {
      const client = createLlmClient({ baseUrl: flaky.base, model: "m", apiKey: "k", protocol: "responses", backoffCapMs: 1 });
      const notices = [];
      const out = await client.ask({ messages: MSGS, onRetry: (n) => notices.push(n) });
      check(notices.length === 1 && notices[0].code === "api_error", "a transient provider failure is announced on this wire too");
      check(out.content === "second try" && flaky.requests.length === 2, "and the redial completes the turn");
    } finally {
      await flaky.close();
    }
  }

  summary("llm-client: one streaming turn, the retry ladder, and the errors the loop acts on");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
