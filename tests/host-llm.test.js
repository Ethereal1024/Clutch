// Standalone check for ui/host/llm.js — the model connection on the far-root
// host (deployment B's answer to agent/llm/*).
// Run: node tests/host-llm.test.js
//
// What is asserted, and why:
//   * the CONTRACT other modules read: LlmError codes/texts, the retry notice
//     shape, the finish event's `tool_calls` field;
//   * both wire protocols against real sockets (a local http upstream), because
//     the request shape is what an OpenAI-compatible provider actually judges;
//   * the two timeout clocks separately, since conflating them is the classic
//     bug: a stream that outlives the CONNECT budget must not read as an
//     unreachable endpoint;
//   * the retry ladder end to end: 429/500 redialed, 400-overflow/404 reported,
//     a mid-stream drop retried WITH discard, a dead port ending in
//     "(after N attempts)".

"use strict";

const http = require("http");
const net = require("net");
const {
  LlmError,
  classify,
  cleanProviderMessage,
  isContextOverflow,
  timeoutError,
  getProxyForUrl,
  resolveProxy,
  createLlmClient,
  chatEvents,
  responsesEvents,
  toResponsesInput,
  toResponsesTools,
  runStreaming,
  API_PROTOCOLS,
  DEFAULT_REQUEST_TIMEOUT_S,
  DEFAULT_READ_TIMEOUT_S,
  DEFAULT_RETRYABLE_STATUS,
  MAX_REDIAL_BACKOFF_S,
  GUARD_POLL_S,
  STALL_PROBE_S,
  PATH_POLL_S,
  PATH_WAIT_MAX_S,
  ENDPOINT_PROBE_TIMEOUT_S,
  REASONING_EFFORT,
} = require("../ui/host/llm");
const { check, summary } = require("./harness");

// ---- helpers ----

function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({
        srv,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            if (srv.closeAllConnections) srv.closeAllConnections();
            srv.close(() => r());
          }),
      });
    });
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// A scripted SSE upstream: records every request (method/url/headers/body) and
// lets the script decide how the body runs.
async function upstream(script) {
  const requests = [];
  const server = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, rawBody: raw };
      try {
        record.body = JSON.parse(raw);
      } catch (e) {
        record.body = raw;
      }
      requests.push(record);
      try {
        script(req, res, record, requests.length);
      } catch (e) {
        res.destroy();
      }
    });
  });
  return { ...server, requests };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

// `chatEvents`/`responsesEvents` consume PAYLOADS (the data lines of one
// event), which is what `ssePayloads` hands them. The unit cases below are
// written as wire frames for readability, so peel the frame off.
const asPayload = (s) => (s.startsWith("data:") ? s.slice(5).replace(/\n\n$/, "").replace(/^ /, "") : s);

function sseHead(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
}

function scripted(frames, tail = "data: [DONE]\n\n") {
  return (req, res) => {
    sseHead(res);
    for (const f of frames) res.write(typeof f === "string" ? f : frame(f));
    res.end(tail);
  };
}

function chatSse(...chunks) {
  return chunks.map((c) => frame(c));
}

function client(url, opts = {}) {
  return createLlmClient({
    apiKey: "sk-test",
    baseUrl: url + "/v1",
    model: "test-model",
    env: {},
    timings: { backoffBaseS: 0.005, stallS: 60, guardPollS: 0.01, pathPollS: 0.01, pathWaitMaxS: 0.05 },
    ...opts,
  });
}

async function* payloads(list) {
  for (const item of list) yield item;
}

// the unit cases are written as wire frames; the handlers consume payloads
const unitFrames = (list) => payloads(list.map(asPayload));

async function drain(iterator) {
  const events = [];
  try {
    for await (const ev of iterator) events.push(ev);
    return { events, error: null };
  } catch (e) {
    return { events, error: e };
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ hung: true, label }), ms)),
  ]);
}

function threw(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

// ---- 1. the constants the settings/UI assert against ----

check(Array.isArray(API_PROTOCOLS) && API_PROTOCOLS.join(",") === "chat,responses", "both wire protocols are supported");
check(DEFAULT_REQUEST_TIMEOUT_S === 60 && DEFAULT_READ_TIMEOUT_S === 240, "timeout defaults match Config (60s connect, 240s read)");
check(DEFAULT_RETRYABLE_STATUS.join(",") === "429,500,502,503,504", "retryable statuses are the SDK's set");
check(MAX_REDIAL_BACKOFF_S === 128, "the redial ladder is capped at 128s");
check(GUARD_POLL_S === 0.25 && STALL_PROBE_S === 20, "the silence guard polls every 0.25s and probes after 20s");
check(PATH_POLL_S === 10 && PATH_WAIT_MAX_S === 180, "a known-dead path is re-asked every 10s, but not for long");
check(ENDPOINT_PROBE_TIMEOUT_S === 6, "the probe has its own 6s budget");
check(
  REASONING_EFFORT.low === "low" && REASONING_EFFORT.medium === "medium" && REASONING_EFFORT.max === "high",
  "max effort is named high on the Responses wire"
);

// ---- 2. error normalization (client.py) ----

check(isContextOverflow("This model's maximum context length is 128000", null), "context overflow is recognized in the provider's words");
check(!isContextOverflow("rate limited", undefined, 42), "non-strings cannot claim overflow");
check(
  timeoutError("connect").message.startsWith("Connect timed out: no route to the API endpoint") &&
    timeoutError("read").message.startsWith("Read timed out: the API sent no data for a long stretch"),
  "timeout texts are Python's, verbatim (the UI shows them as-is)"
);
check(timeoutError("read").code === "timeout" && timeoutError("read").retryable, "a timeout is retryable");

const tidy = cleanProviderMessage('Error code: 429 - {"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}', 429);
check(tidy === "Rate limit reached (code rate_limit_exceeded, HTTP 429)", "a provider error body is tidied, keeping its code and status");
check(
  cleanProviderMessage("Error code: 500 - not json at all", 500) === "Error code: 500 - not json at all",
  "a body that is not JSON stays verbatim (a diagnostic, not a parse)"
);
check(cleanProviderMessage("plain failure", null) === "plain failure", "a message with no ' - ' separator passes through");
check(
  cleanProviderMessage('Error code: 400 - {"error":{"message":"   "}}', 400) === 'Error code: 400 - {"error":{"message":"   "}}',
  "an empty provider message is not a tidied one"
);

// Status-code classification (400-overflow / 429 / 5xx / 404) is reachable only
// through a real response — `openStream` is the sole producer of the status
// error — so those cases are asserted against a local upstream in §10.

const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
  code: "ECONNREFUSED",
  __llmPhase: "connect",
});
const refusedErr = classify(refused);
check(refusedErr.code === "connection" && refusedErr.retryable, "a refused connection is a retryable transport error");
check(refusedErr.message === "Cannot reach the API endpoint: connect ECONNREFUSED 127.0.0.1:9", "…with the connect-phase wording");

const hup = classify(Object.assign(new Error("socket hang up"), { code: "" }));
check(hup.code === "connection" && hup.message === "Connection interrupted: socket hang up", "a mid-stream hang-up is 'Connection interrupted: …'");

const assertion = classify(Object.assign(new Error("premature close of the test fixture"), { code: "ERR_ASSERTION" }));
check(assertion.code === "unknown" && !assertion.retryable, "an assertion error is never a transport error (precedence guard)");

const marked = new Error("x");
marked.__llmTimeout = "connect";
check(classify(marked).message.startsWith("Connect timed out:"), "a connect-budget error keeps the connect text");

const passthrough = new LlmError({ code: "context_window_exceeded", retryable: false, message: "too long" });
check(classify(passthrough) === passthrough, "an LlmError is passed through untouched (a provider verdict is final)");

check(classify(new Error("cannot parse")).code === "unknown", "an unclassified error stays unknown and non-retryable");

// ---- 3. proxy resolution (llm/proxy.py) ----

check(getProxyForUrl("https://api.deepseek.com/v1", { https_proxy: "http://p:8080" }) === "http://p:8080", "https_proxy serves an https target");
check(getProxyForUrl("https://api.deepseek.com/v1", { http_proxy: "http://p:8080" }) === null, "http_proxy does not serve an https target");
check(getProxyForUrl("http://api.test/v1", { HTTP_PROXY: "http://p:8080" }) === "http://p:8080", "the uppercase variable is honored");
check(getProxyForUrl("http://api.test/v1", { all_proxy: "http://all:3128" }) === "http://all:3128", "all_proxy is the fallback");
check(getProxyForUrl("http://api.test/v1", { http_proxy: "proxy:3128" }) === "http://proxy:3128", "a scheme-less proxy value gets the target's scheme");
check(getProxyForUrl("https://api.test/v1", { https_proxy: "socks5://p:1080" }) === null, "a socks proxy is skipped (httpx cannot use it)");
check(getProxyForUrl("http://127.0.0.1:8080/v1", { http_proxy: "http://p:8080" }) === null, "loopback is never proxied");
check(getProxyForUrl("http://localhost:8080/v1", { http_proxy: "http://p:8080" }) === null, "…including the localhost name");
check(
  getProxyForUrl("http://api.test/v1", { http_proxy: "http://p:8080", no_proxy: "api.test" }) === null,
  "no_proxy excludes an exact host"
);
check(
  getProxyForUrl("http://api.test:9000/v1", { http_proxy: "http://p:8080", no_proxy: "test" }) === null,
  "no_proxy excludes a domain suffix"
);
check(
  getProxyForUrl("http://api.test/v1", { http_proxy: "http://p:8080", no_proxy: ".test" }) === "http://p:8080",
  "a leading-dot no_proxy entry matches nothing, as in Python (frozen behavior)"
);
check(
  getProxyForUrl("http://other.example/v1", { http_proxy: "http://p:8080", no_proxy: ".test" }) === "http://p:8080",
  "…without excluding everyone else"
);
check(
  getProxyForUrl("http://api.test/v1", { http_proxy: "http://p:8080", no_proxy: "*" }) === "http://p:8080",
  "no_proxy='*' matches nothing, as in Python (frozen behavior)"
);
check(getProxyForUrl("ftp://api.test/x", { http_proxy: "http://p:8080" }) === null, "a non-http scheme has no proxy");
check(getProxyForUrl("", { http_proxy: "http://p:8080" }) === null, "an empty URL has no proxy");
check(resolveProxy("http://api.test/x", false, { http_proxy: "http://p:8080" }) === null, "an explicit false setting forces a direct connection");
check(resolveProxy("http://api.test/x", null, { http_proxy: "http://p:8080" }) === null, "…and so does null");
check(resolveProxy("http://api.test/x", "http://fixed:1", { http_proxy: "http://p:8080" }) === "http://fixed:1", "a configured proxy URL wins over the environment");
check(resolveProxy("http://api.test/x", "auto", { http_proxy: "http://p:8080" }) === "http://p:8080", "auto resolves per URL from the environment");

// ---- 4. createLlmClient argument errors (factory.py) ----

check(threw(() => createLlmClient({ baseUrl: "http://x/v1", model: "m" })).message === "missing LLM argument: api_key", "a missing api_key is named");
check(threw(() => createLlmClient({ apiKey: "k", model: "m" })).message === "missing LLM argument: base_url", "a missing base_url is named");
check(threw(() => createLlmClient({ apiKey: "k", baseUrl: "http://x/v1" })).message === "missing LLM argument: model", "a missing model is named");
check(
  threw(() => createLlmClient({ apiKey: "k", baseUrl: "http://x/v1", model: "m", protocol: "audio" })).message ===
    "unknown LLM protocol: audio (expected one of chat, responses)",
  "an unknown protocol lists the valid ones"
);
check(
  createLlmClient({ apiKey: "k", baseUrl: "http://x/v1", model: "m" }).protocol === "chat",
  "the default protocol is chat"
);

// ---- 5. chat completions -> events (chunk_handle.py) ----

(async () => {
  const chatFrames = [
    frame({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    frame({ choices: [{ delta: { content: "Hel" } }] }),
    frame({ choices: [{ delta: { content: "lo" } }] }),
    ": keepalive\n\n",
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
    frame({ choices: [{ delta: { content: "AFTER-THE-END" } }] }),
  ];
  const chat = await drain(chatEvents(unitFrames(chatFrames)));
  const kinds = chat.events.map((e) => e.type);
  check(chat.error === null, "the chat feed drains without error");
  check(
    kinds.join(",") === "reasoning,text,text,tool_call_start,tool_call_delta,tool_call_delta,finish",
    `chat frames map to reasoning/text/tool events, then one finish (got ${kinds.join(",")})`
  );
  check(chat.events[0].delta === "thinking", "reasoning_content becomes a reasoning delta");
  check(chat.events[1].delta === "Hel" && chat.events[2].delta === "lo", "content deltas keep their order");
  check(
    chat.events[3].index === 0 && chat.events[3].id === "call_1" && chat.events[3].name === "read_file",
    "a fragmented tool call opens once, with its id and name"
  );
  check(
    chat.events[4].delta === '{"pa' && chat.events[5].delta === 'th":"a"}',
    "fragmented arguments arrive as deltas, in order"
  );
  const chatFinish = chat.events[chat.events.length - 1];
  check(chatFinish.reason === "tool_calls", "the finish carries the provider's finish_reason");
  check(chatFinish.content === "Hello", "the finish carries the accumulated content");
  check(
    chatFinish.tool_calls.length === 1 &&
      chatFinish.tool_calls[0].id === "call_1" &&
      chatFinish.tool_calls[0].name === "read_file" &&
      chatFinish.tool_calls[0].arguments === '{"path":"a"}',
    "the finish carries the whole tool_calls field (the wire contract consumers read)"
  );
  check(!kinds.includes("text") || !chat.events.some((e) => e.delta === "AFTER-THE-END"), "nothing after the finish chunk is consumed");

  const truncated = await drain(
    chatEvents(unitFrames([frame({ choices: [{ delta: { content: "half an answer" } }] }), "data: [DONE]\n\n"]))
  );
  check(
    truncated.events.length === 2 &&
      truncated.events[0].type === "text" &&
      truncated.events[1].type === "finish" &&
      truncated.events[1].reason === "stop",
    "a stream that ends without a finish chunk still reports a finish (stop), not silence"
  );
  check(truncated.events[1].content === "half an answer", "…with what did arrive");

  const noise = await drain(chatEvents(unitFrames([": ping\n\n", "data: [DONE]\n\n", "{not json}"])));
  check(
    noise.events.length === 1 && noise.events[0].type === "finish" && noise.events[0].content === "",
    "keepalives, [DONE] and torn payloads are skipped, leaving an empty finish"
  );

  // ---- 6. Responses protocol -> events (response_handle.py) ----

  const responsesFrames = [
    frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_0" } }),
    frame({ type: "response.reasoning_summary_part.added", output_index: 0, part: { type: "summary_text" } }),
    frame({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "pondering" }),
    frame({ type: "response.reasoning_summary_part.added", output_index: 0, part: { type: "summary_text" } }),
    frame({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "harder" }),
    frame({ type: "response.output_text.delta", output_index: 0, delta: "Look" }),
    frame({ type: "response.output_text.delta", output_index: 0, delta: " here" }),
    frame({
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "grep", arguments: "" },
    }),
    frame({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"q":' }),
    frame({ type: "response.function_call_arguments.delta", output_index: 1, delta: '"x"}' }),
    frame({
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "grep", arguments: '{"q":"x"}' },
    }),
    frame({
      type: "response.completed",
      response: {
        output: [
          { type: "message", content: [{ type: "output_text", text: "Look here" }] },
          { type: "function_call", call_id: "call_9", name: "grep", arguments: '{"q":"x"}' },
        ],
      },
    }),
  ];
  const resp = await drain(responsesEvents(unitFrames(responsesFrames)));
  const rKinds = resp.events.map((e) => e.type);
  check(resp.error === null, "the responses feed drains without error");
  check(
    rKinds.join(",") === "reasoning,reasoning,reasoning,text,text,tool_call_start,tool_call_delta,tool_call_delta,finish",
    `responses frames map to the same vocabulary (got ${rKinds.join(",")})`
  );
  check(resp.events[0].delta === "pondering", "a reasoning summary delta is a reasoning delta");
  check(resp.events[1].delta === "\n\n" && resp.events[2].delta === "harder", "a new summary part starts a paragraph");
  check(resp.events[3].delta === "Look" && resp.events[4].delta === " here", "output_text deltas are text deltas");
  check(
    resp.events[5].type === "tool_call_start" && resp.events[5].index === 1 && resp.events[5].name === "grep",
    "output_item.added opens a function call, keyed by output_index"
  );
  check(resp.events[6].delta === '{"q":' && resp.events[7].delta === '"x"}', "argument deltas are forwarded");
  const respFinish = resp.events[resp.events.length - 1];
  check(respFinish.reason === "tool_calls" && respFinish.content === "Look here", "completed closes with tool_calls and the text");
  check(
    respFinish.tool_calls.length === 1 && respFinish.tool_calls[0].arguments === '{"q":"x"}' && respFinish.tool_calls[0].id === "call_9",
    "the item (done) is authoritative for the arguments, and call_id is the id"
  );

  const truncatedResp = await drain(
    responsesEvents(
      unitFrames([
        frame({ type: "response.output_text.delta", delta: "partial" }),
        frame({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }),
      ])
    )
  );
  const truncFinish = truncatedResp.events[truncatedResp.events.length - 1];
  check(truncFinish.type === "finish" && truncFinish.reason === "length", "a truncated turn reads as length (the loop retries concisely)");
  check(truncFinish.content === "partial", "…keeping the deltas that did arrive");

  const filtered = await drain(
    responsesEvents(
      unitFrames([frame({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } })])
    )
  );
  check(filtered.events[0].reason === "stop", "a filter stop reads as stop, not length");

  const failed = await drain(
    responsesEvents(
      unitFrames([
        frame({
          type: "response.failed",
          response: { error: { code: "context_length_exceeded", message: "Your input exceeds the context window" } },
        }),
      ])
    )
  );
  check(
    failed.error instanceof LlmError &&
      failed.error.code === "context_window_exceeded" &&
      !failed.error.retryable &&
      /context window/.test(failed.error.message),
    "a failed response is normalized to context_window_exceeded and keeps the provider's message"
  );

  const midError = await drain(responsesEvents(unitFrames([frame({ type: "error", code: "server_error", message: "boom" })])));
  check(midError.error && midError.error.code === "server_error" && midError.error.message === "boom", "an 'error' event becomes an LlmError");

  const dropped = await drain(responsesEvents(unitFrames([frame({ type: "response.output_text.delta", delta: "cut" })])));
  check(
    dropped.events.length === 2 && dropped.events[1].type === "finish" && dropped.events[1].reason === "stop",
    "a feed that ends without a terminal event still finishes (a relay dropped it)"
  );

  // ---- 7. history translation ----

  const translated = toResponsesInput([
    { role: "system", content: "be terse" },
    { role: "system", content: "be kind" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "calling",
      tool_calls: [{ id: "call_1", function: { name: "grep", arguments: '{"q":"x"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "found" },
  ]);
  check(translated.instructions === "be terse\n\nbe kind", "system messages become the instructions, joined");
  check(
    translated.items.map((i) => i.type || i.role).join(",") === "user,assistant,function_call,function_call_output",
    "history becomes protocol items in order"
  );
  check(translated.items[2].call_id === "call_1" && translated.items[2].name === "grep", "a tool call becomes a function_call item");
  check(
    translated.items[3].call_id === "call_1" && translated.items[3].output === "found",
    "a tool result becomes a function_call_output item"
  );

  const flatTools = toResponsesTools([
    { type: "function", function: { name: "grep", description: "search", parameters: { type: "object" } } },
  ]);
  check(
    flatTools.length === 1 &&
      flatTools[0].type === "function" &&
      flatTools[0].name === "grep" &&
      flatTools[0].description === "search" &&
      !flatTools[0].function,
    "chat tool schemas are flattened for the Responses wire"
  );

  // ---- 8. a real chat request (URL, headers, body) ----

  {
    const up = await upstream(
      scripted(
        chatSse(
          { choices: [{ delta: { content: "Hi" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] }
        )
      )
    );
    const llm = client(up.url, { reasoningEffort: "medium" });
    const out = await drain(
      llm.stream(
        [{ role: "user", content: "hello" }],
        { tools: [{ type: "function", function: { name: "grep", parameters: { type: "object" } } }] }
      )
    );
    const req = up.requests[0];
    check(out.error === null && out.events[out.events.length - 1].type === "finish", "a chat turn completes against a real socket");
    check(req.method === "POST" && req.url === "/v1/chat/completions", "the chat path is <base>/chat/completions");
    check(req.headers.authorization === "Bearer sk-test", "the client's key is sent as a bearer token");
    check(/text\/event-stream/.test(req.headers.accept || ""), "the request asks for an SSE body");
    check(req.headers["content-type"] === "application/json", "the request body is JSON");
    check(
      req.body.model === "test-model" && req.body.stream === true && Array.isArray(req.body.messages),
      "the body carries model/messages/stream"
    );
    check(req.body.tools && req.body.tools[0].function.name === "grep", "tool schemas pass through unchanged on the chat wire");
    check(
      req.body.thinking && req.body.thinking.type === "enabled" && req.body.thinking.reasoning_effort === "medium",
      "reasoning effort is extra_body (thinking.reasoning_effort), not a nested setting"
    );
    await up.close();
  }

  {
    const up = await upstream(scripted(chatSse({ choices: [{ delta: { content: "x" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })));
    const llm = client(up.url, { maxRetries: 1 });
    await drain(llm.stream([{ role: "user", content: "hi" }]));
    check(!Object.prototype.hasOwnProperty.call(up.requests[0].body, "tools"), "no tools means no tools key (the provider's default)");
    check(!Object.prototype.hasOwnProperty.call(up.requests[0].body, "thinking"), "no effort means no thinking key");
    await up.close();
  }

  // ---- 9. a real responses request ----

  {
    const up = await upstream(
      scripted([
        frame({ type: "response.output_text.delta", delta: "ok" }),
        frame({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] } }),
      ])
    );
    const llm = client(up.url, { protocol: "responses", reasoningEffort: "max" });
    const out = await drain(
      llm.stream([{ role: "system", content: "be terse" }, { role: "user", content: "hello" }], {
        tools: [{ type: "function", function: { name: "grep", parameters: { type: "object" } } }],
      })
    );
    const req = up.requests[0];
    check(out.error === null && out.events[out.events.length - 1].reason === "stop", "a responses turn completes against a real socket");
    check(req.url === "/v1/responses", "the responses path is <base>/responses");
    check(req.body.instructions === "be terse", "the system prompt becomes instructions");
    check(Array.isArray(req.body.input) && req.body.input[0].role === "user", "the history becomes input items");
    check(req.body.store === false && req.body.stream === true, "store=false and stream=true are sent");
    check(req.body.tools && req.body.tools[0].name === "grep" && !req.body.tools[0].function, "responses tools are flat");
    check(req.body.reasoning && req.body.reasoning.effort === "high", "max effort is renamed to high on the responses wire");
    await up.close();
  }

  // ---- 10. HTTP status handling through the client ----

  {
    const up = await upstream((req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model not found" } }));
    });
    const llm = client(up.url, { maxRetries: 3 });
    const out = await drain(llm.stream([{ role: "user", content: "hi" }]));
    check(out.error && out.error.code === "api_error" && out.error.status === 404 && !out.error.retryable, "a 404 is an api_error and is not retried");
    check(/model not found/.test(out.error.message), "…and its message reaches the caller");
    check(up.requests.length === 1, "…after exactly one attempt");
    await up.close();
  }

  {
    const up = await upstream((req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }));
    });
    const llm = client(up.url, { maxRetries: 3 });
    const out = await drain(llm.stream([{ role: "user", content: "hi" }]));
    check(
      out.error && out.error.code === "context_window_exceeded" && out.error.status === 400 && !out.error.retryable,
      "a 400 that says 'context' is the one code the loop answers by compacting"
    );
    check(up.requests.length === 1, "…and it is not retried as-is");
    await up.close();
  }

  {
    const up = await upstream((req, res, _record, n) => {
      if (n === 1) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }));
        return;
      }
      scripted(chatSse({ choices: [{ delta: { content: "after" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }))(
        req,
        res
      );
    });
    const llm = client(up.url, { maxRetries: 3 });
    const out = await drain(llm.stream([{ role: "user", content: "hi" }]));
    const notice = out.events.find((e) => e.type === "retry");
    check(out.error === null && out.events[out.events.length - 1].type === "finish", "a 429 is retried and the turn completes");
    check(
      notice && notice.code === "rate_limit" && notice.attempt === 1 && notice.max === 3 && notice.discard === false,
      "the retry notice names the code, the attempt and the budget — and nothing was delivered"
    );
    check(
      notice && notice.message === "Rate limit reached (code rate_limit_exceeded, HTTP 429) — retrying (1/3)",
      "the notice's text is Python's, including the tidied provider message"
    );
    check(up.requests.length === 2, "…after exactly two attempts");
    await up.close();
  }

  {
    const up = await upstream((req, res, _record, n) => {
      if (n === 1) {
        res.writeHead(500);
        res.end("upstream exploded");
        return;
      }
      scripted(chatSse({ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }))(req, res);
    });
    const llm = client(up.url, { maxRetries: 2 });
    const out = await drain(llm.stream([{ role: "user", content: "hi" }]));
    const notice = out.events.find((e) => e.type === "retry");
    check(out.error === null, "a 500 is retried and the turn completes");
    check(notice && notice.code === "api_error" && notice.max === 2, "…announced as api_error with the attempt budget");
    await up.close();
  }

  {
    const up = await upstream((req, res) => {
      res.writeHead(500);
      res.end("always down");
    });
    const llm = client(up.url, { maxRetries: 2 });
    const out = await drain(llm.stream([{ role: "user", content: "hi" }]));
    check(
      out.error && out.error.code === "api_error" && /\(after 2 attempts\)$/.test(out.error.message),
      "an exhausted budget says how many attempts it spent"
    );
    check(up.requests.length === 2, "…and it really made that many");
    await up.close();
  }

  // ---- 11. a mid-stream drop is retried WITH discard ----

  {
    const up = await upstream((req, res, _record, n) => {
      sseHead(res);
      if (n === 1) {
        res.write(frame({ choices: [{ delta: { content: "par" } }] }));
        setTimeout(() => req.socket.destroy(), 40);
        return;
      }
      res.write(frame({ choices: [{ delta: { content: "complete" } }] }));
      res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
    });
    const llm = client(up.url, { maxRetries: 2 });
    const out = await drain(llm.stream([{ role: "user", content: "hi" }]));
    const notice = out.events.find((e) => e.type === "retry");
    const finish = out.events[out.events.length - 1];
    check(out.error === null && finish.type === "finish", "a mid-stream drop is retried instead of ending the run");
    check(
      notice && notice.discard === true && notice.code === "connection",
      "the notice tells the caller to DISCARD the dead attempt's output"
    );
    check(out.events[0].type === "text" && out.events[0].delta === "par", "the dead attempt's output did reach the caller first");
    check(finish.content === "complete", "the finish is built from the second attempt only");
    check(up.requests.length === 2, "…after exactly two attempts");
    await up.close();
  }

  // ---- 12. a dead endpoint stops with Python's message ----

  {
    const dead = await freePort();
    const llm = createLlmClient({
      apiKey: "sk-test",
      baseUrl: `http://127.0.0.1:${dead}/v1`,
      model: "test-model",
      maxRetries: 1,
      env: {},
      timings: { backoffBaseS: 0.005 },
    });
    const out = await withTimeout(drain(llm.stream([{ role: "user", content: "hi" }])), 5000, "dead endpoint");
    check(!out.hung, "a dead endpoint does not park the caller");
    check(
      out.error && out.error.code === "connection" && out.error.retryable,
      "a refused connection is reported as a retryable connection error"
    );
    check(
      out.error && /^Cannot reach the API endpoint: .*ECONNREFUSED/.test(out.error.message) && /\(after 1 attempts\)$/.test(out.error.message),
      "the message names the phase and the spent attempts"
    );
  }

  // ---- 13. the two timeout clocks are separate ----

  {
    // headers arrive AFTER the connect budget, but the socket is up: not a
    // connect timeout (a stream is not an unreachable endpoint)
    const up = await upstream((req, res) => {
      setTimeout(() => {
        sseHead(res);
        res.write(frame({ choices: [{ delta: { content: "late" } }] }));
        res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        res.end("data: [DONE]\n\n");
      }, 450);
    });
    const llm = client(up.url, { requestTimeout: 0.2, maxRetries: 1 });
    const out = await withTimeout(drain(llm.stream([{ role: "user", content: "hi" }])), 5000, "slow connect");
    check(!out.hung, "a slow answer does not hang the caller");
    check(
      out.error === null && out.events[out.events.length - 1].type === "finish",
      `a response slower than the connect budget is not a connect timeout (got ${out.error ? out.error.message : "finish"})`
    );
    await up.close();
  }

  {
    // a stream that keeps arriving for longer than the connect budget stays
    // alive: the connect clock was spent when the socket came up
    const up = await upstream((req, res) => {
      sseHead(res);
      let n = 0;
      const tick = setInterval(() => {
        n += 1;
        res.write(frame({ choices: [{ delta: { content: "." } }] }));
        if (n === 6) {
          clearInterval(tick);
          res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
          res.end("data: [DONE]\n\n");
        }
      }, 100);
    });
    const llm = client(up.url, { requestTimeout: 0.2, maxRetries: 1 });
    const out = await withTimeout(drain(llm.stream([{ role: "user", content: "hi" }])), 5000, "long stream");
    check(
      !out.hung && out.error === null && out.events.filter((e) => e.type === "text").length === 6,
      "a stream that outlives the connect budget runs to its end (the clock was cleared on connect)"
    );
    await up.close();
  }

  {
    // headers then silence: the READ budget is what notices
    const up = await upstream((req, res) => {
      sseHead(res);
      res.write(frame({ choices: [{ delta: { content: "then silence" } }] }));
      // and never another byte
    });
    const llm = client(up.url, { readTimeout: 0.2, maxRetries: 1 });
    const out = await withTimeout(drain(llm.stream([{ role: "user", content: "hi" }])), 4000, "read timeout");
    check(!out.hung, "a stalled read is noticed instead of parked (the fail/close ordering bug)");
    check(
      out.error && out.error.code === "timeout" && /^Read timed out: the API sent no data/.test(out.error.message),
      "a silent stream is reported as a read timeout"
    );
    check(out.error && /\(after 1 attempts\)$/.test(out.error.message), "…with the attempts it spent");
    await up.close();
  }

  // ---- 14. Stop (cancellation) ----

  {
    const up = await upstream((req, res) => {
      sseHead(res);
      res.write(frame({ choices: [{ delta: { content: "one" } }] }));
      // park forever: only closing the socket ends this read
    });
    const llm = client(up.url, { maxRetries: 0, guardPollS: 0.01 });
    const ac = new AbortController();
    const iterator = llm.stream([{ role: "user", content: "hi" }], { cancel: ac.signal })[Symbol.asyncIterator]();
    const first = await withTimeout(iterator.next(), 3000, "first event");
    check(!first.hung && first.value && first.value.type === "text", "the turn starts streaming before Stop");
    ac.abort();
    const rest = await withTimeout(drain(iterator), 3000, "stop");
    check(!rest.hung, "a Stop breaks a parked read at once (the watchdog closes the socket)");
    check(rest.error && rest.error.code === "cancelled" && !rest.error.retryable, "a Stop reads as cancelled, never as a retryable failure");
    await up.close();
  }

  // ---- 15. endpointAlive (the watchdog's witness) ----

  {
    const up = await upstream((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no such path");
    });
    const llm = client(up.url);
    check((await llm.endpointAlive()) === true, "any HTTP response means the path is alive (even a 404)");
    await up.close();
    const dead = await freePort();
    const deadClient = createLlmClient({ apiKey: "k", baseUrl: `http://127.0.0.1:${dead}/v1`, model: "m", env: {} });
    check((await deadClient.endpointAlive()) === false, "a refused probe means the path is gone");
    check((await deadClient.endpointAlive(0.2)) === false, "…and the probe honors its own budget");
  }

  // ---- 16. proxies: absolute-form, and a refused CONNECT ----

  {
    let proxied = null;
    const proxy = await listen((req, res) => {
      proxied = { method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization };
      sseHead(res);
      res.write(frame({ choices: [{ delta: { content: "via proxy" } }] }));
      res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
    });
    const llm = createLlmClient({
      apiKey: "sk-proxy",
      baseUrl: "http://api.example.test/v1",
      model: "m",
      proxy: `http://127.0.0.1:${proxy.port}`,
      env: {},
    });
    const out = await withTimeout(drain(llm.stream([{ role: "user", content: "hi" }])), 5000, "http proxy");
    check(!out.hung && out.error === null && out.events[out.events.length - 1].type === "finish", "an http target streams through a proxy");
    check(proxied && proxied.method === "POST", "the proxy receives the POST");
    check(
      proxied && proxied.url === "http://api.example.test/v1/chat/completions",
      "an http-over-proxy request uses absolute-form (the proxy parses the target)"
    );
    check(proxied && proxied.host === "api.example.test", "the Host header is the target, not the proxy");
    check(proxied && proxied.auth === "Bearer sk-proxy", "the client's own headers survive the proxy hop");
    await proxy.close();
  }

  {
    let connectUrl = null;
    const proxy = await listen(() => {});
    proxy.srv.on("connect", (req, socket) => {
      connectUrl = req.url;
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
    });
    const llm = createLlmClient({
      apiKey: "sk",
      baseUrl: "https://api.example.test/v1",
      model: "m",
      proxy: `http://127.0.0.1:${proxy.port}`,
      maxRetries: 1,
      env: {},
      timings: { backoffBaseS: 0.005 },
    });
    const out = await withTimeout(drain(llm.stream([{ role: "user", content: "hi" }])), 5000, "connect tunnel");
    check(connectUrl === "api.example.test:443", "an https target goes through CONNECT to host:port");
    check(
      out.error && out.error.status === 403 && /proxy CONNECT failed for api\.example\.test:443/.test(out.error.message),
      "a refused tunnel is reported with the proxy's status and the authority"
    );
    await proxy.close();
  }

  summary("host-llm", "all checks passed");
})().catch((e) => {
  console.log("FAIL: unexpected throw — " + ((e && e.stack) || e));
  process.exit(1);
});
