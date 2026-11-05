// The model client — the host's half of agent/llm/: one streaming turn, the
// retry policy that wraps it, and the error vocabulary the loop acts on.
//
// This is the JS side of a merge: ui/llm-proxy.js already owns where the
// upstream is, which key goes with it and which proxy reaches it, and it serves
// the two OpenAI wire protocols the client speaks. The client reuses exactly
// those answers (joinUpstream / getUpstream / getApiKey / getAgent) instead of
// having a second settings reader, and the proxy keeps existing only until the
// backend stops running a loop of its own (P1-3/P3) — after that nothing on the
// far side asks the host for a model.
//
// The retry policy is agent/llm/llm_clients/stream_runner.py's, with the one
// decision D12 made explicit:
//
//   * an attempt that fails is ANNOUNCED (a `retry` notice carrying the attempt
//     number, the reason and `discard`) and then retried — from scratch, with
//     backoff 1,2,4,… capped at 60s;
//   * there is no attempt cap and no "unbounded" boolean: a dead endpoint is
//     retried for as long as the turn is open, and Stop is the only exit. A run
//     that gives up is a run that looks frozen with no error, which is the
//     failure mode D12 removed;
//   * `discard: true` means "this attempt already streamed part of its answer
//     before it died — drop what you took". The loop and the compactor rebuild
//     their turn from accumulators, so both honor it; a caller that cannot must
//     not pass midStreamRetry, and then a mid-stream failure is raised instead
//     of replayed.
//
// Numbers are the loop's, not the proxy's: llm_read_timeout = 240s is a budget
// for CHUNK GAPS (agent/config.py), and the 20s stall probe is stream_runner's
// STALL_PROBE_S. ui/llm-proxy.js's 90s upstream timeout is a proxy budget for a
// different pair of ends; it is not inherited here.
//
// One deliberate difference from the Python runner: that one is a thread parked
// in a blocking read, so it needs a watchdog thread, an endpoint probe, and a
// pre-flight that waits for a dead path to come back before issuing the next
// request (all three exist to reach a read that cannot be woken otherwise).
// Node never parks its loop: this client owns the socket, so the silence clock
// destroys the attempt directly, and the redial ladder is the whole recovery.
// The probe survives for the thing it is actually for — telling "the provider is
// thinking" (keep waiting) from "the path went away" (kill now) — which is a
// judgement about the network, not about the thread model.

const http = require("http");
const https = require("https");
const { joinUpstream, getAgent } = require("./llm-proxy");

const READ_TIMEOUT_MS = 240000; // agent/config.py: llm_read_timeout
const STALL_PROBE_MS = 20000; // stream_runner.py: STALL_PROBE_S
const PROBE_TIMEOUT_MS = 6000; // stream_runner's probe budget
const CONNECT_TIMEOUT_MS = 15000; // openai_base: connect=min(15, request_timeout)
const MAX_BACKOFF_MS = 60000; // D12: the ladder stops doubling here
const GUARD_POLL_MS = 250; // stream_runner.py: GUARD_POLL_S

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// One failure, in the shape the loop acts on. `retryable` is the ONLY thing the
// ladder reads; `code` is what the loop (and the UI) says happened.
class LlmError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

const cancelled = (why = "stop requested") => new LlmError("cancelled", why, false);

// The provider's own words, not the SDK dump: an error body is
// {"error": {"message", "code"}}, and the user wants that sentence with the
// status beside it (client.py's _clean_provider_message).
function providerMessage(status, raw) {
  const text = String(raw || "").trim();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return text || `HTTP ${status}`;
  }
  const err = data && data.error;
  if (!err || typeof err.message !== "string" || !err.message.trim()) return text || `HTTP ${status}`;
  const extra = [];
  if (err.code) extra.push(`code ${err.code}`);
  if (status) extra.push(`HTTP ${status}`);
  return extra.length ? `${err.message.trim()} (${extra.join(", ")})` : err.message.trim();
}

// "maximum context length", "context_length_exceeded", …: the one failure the
// loop answers by compacting instead of aborting, whichever wire protocol and
// whichever wording (client.py is_context_overflow).
const isContextOverflow = (text) => /context/i.test(String(text || ""));

function statusError(status, raw) {
  const message = providerMessage(status, raw);
  if (status === 400 && isContextOverflow(message + " " + raw)) {
    return new LlmError("context_window_exceeded", message, false);
  }
  return new LlmError("api_error", message, RETRYABLE_STATUS.has(status));
}

// Transport failures, named by phase: a connect failure points at routing / a
// proxy / the base_url, a reset mid-body at the provider or a relay between
// (client.py's timeout_error / classify).
function transportError(e) {
  if (e instanceof LlmError) return e;
  const code = e && e.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return new LlmError("connection", `Cannot reach the API endpoint: ${e.message}`, true);
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new LlmError("timeout", "Connect timed out: no route to the API endpoint (network to the provider, a proxy, or the base_url).", true);
  }
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "ERR_STREAM_PREMATURE_CLOSE") {
    return new LlmError("connection", `Connection interrupted: ${e.message}`, true);
  }
  if (code === "ERR_STREAM_DESTROYED" || code === "ABORT_ERR") {
    // our own destroy (stop / watchdog): the caller decides what it meant
    return e.llm || new LlmError("connection", String((e && e.message) || e), true);
  }
  return new LlmError("unknown", String((e && e.message) || e), false);
}

// The ladder: 1,2,4,…,MAX_BACKOFF_MS and hold there. Exported because the
// doubling is policy, not implementation: tests assert the shape, the loop never
// sees it.
function backoffMs(attempt, cap = MAX_BACKOFF_MS) {
  return Math.min(cap, 1000 * 2 ** attempt);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelled());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(cancelled());
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Is anything still serving this base URL? ANY HTTP response counts — 200, 401,
// even a 404 — because the question is whether the transport reaches a peer at
// all. A refused connection, a timeout or a shattered reply is "gone"
// (openai_base.endpoint_alive).
function probeAlive(baseUrl, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let target;
    try {
      target = new URL(String(baseUrl).replace(/\/?$/, "/"));
    } catch (e) {
      return done(false);
    }
    const transport = target.protocol === "http:" ? http : https;
    let req;
    try {
      req = transport.request(target, { method: "GET", agent: getAgent(target), timeout: timeoutMs }, (res) => {
        res.destroy();
        done(true);
      });
    } catch (e) {
      return done(false);
    }
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
    req.end();
  });
}

// One attempt: issue the request, translate the SSE body into the event
// protocol the loop consumes (reasoning / text / tool_call_start /
// tool_call_delta / finish). Yields parsed provider objects; `close()` kills the
// attempt from the outside (the watchdog, Stop) — the only lever a parked body
// cannot ignore.
async function* attempt({ url, headers, body, signal, readTimeoutMs, stallMs, probe, midStreamRetry }) {
  if (signal && signal.aborted) throw cancelled();
  const target = new URL(url);
  const transport = target.protocol === "http:" ? http : https;

  let res = null;
  let done = false;
  let lastActivity = Date.now();
  let delivered = false;
  let probing = false;

  const req = transport.request(target, { method: "POST", agent: getAgent(target), headers });

  // Kill the attempt with a failure the caller can classify. A read parked on the
  // body is woken by destroying the response; before the headers exist, by
  // destroying the request.
  const kill = (err) => {
    const e = err instanceof LlmError ? err : transportError(err);
    if (res) res.destroy(e);
    else req.destroy(e);
  };

  const onAbort = () => kill(cancelled());

  const connectTimer = setTimeout(() => {
    kill(new LlmError("timeout", "Connect timed out: no route to the API endpoint (network to the provider, a proxy, or the base_url).", true));
  }, CONNECT_TIMEOUT_MS);

  // The watchdog answers the one question the clock cannot: while this attempt
  // has delivered nothing for stallMs, is its path still there? A provider
  // thinking is left alone; a path that went away is killed now, because waiting
  // out the read budget is exactly the "still running" ghost this replaces.
  const watchdog = setInterval(async () => {
    if (done) return;
    if (probe === null || probing) return;
    if (Date.now() - lastActivity < stallMs) return;
    if (delivered && !midStreamRetry) return; // a retry would duplicate what the caller keeps
    probing = true;
    const before = lastActivity;
    let alive = false;
    try {
      alive = Boolean(await probe());
    } catch (e) {
      // a probe that blows up is not an answer, so it cannot be a "yes"
      alive = false;
    }
    probing = false;
    if (done) return;
    if (lastActivity !== before) return; // it answered while we were asking
    if (alive) return;
    kill(new LlmError("connection", "endpoint stopped answering — the connection path went away", true));
  }, GUARD_POLL_MS);

  const cleanup = () => {
    done = true;
    clearTimeout(connectTimer);
    clearInterval(watchdog);
    if (signal) signal.removeEventListener("abort", onAbort);
    if (res) res.destroy();
    req.destroy();
  };

  try {
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const response = await new Promise((resolve, reject) => {
      req.on("response", resolve);
      req.on("error", reject);
      req.end(body);
    });
    clearTimeout(connectTimer);
    res = response;

    if (res.statusCode < 200 || res.statusCode >= 300) {
      let raw = "";
      for await (const chunk of res) raw += chunk;
      delivered = true; // the status line was delivered: a retry must discard
      throw statusError(res.statusCode, raw);
    }

    // The read budget is for chunk gaps, and it is measured per read: every byte
    // restarts it. A provider that keeps sending is never cut off, however long
    // the answer is; one that goes quiet for 240s is retried.
    res.setTimeout(readTimeoutMs, () => {
      res.destroy(
        Object.assign(new Error("Read timed out: the API sent no data for a long stretch (provider stall or a buffering relay)."), {
          llm: new LlmError("timeout", "Read timed out: the API sent no data for a long stretch (provider stall or a buffering relay).", true),
        })
      );
    });

    let buffer = "";
    for await (const chunk of res) {
      lastActivity = Date.now();
      buffer += chunk.toString("utf8");
      let cut;
      // SSE blocks end at a blank line; \r\n is normalized because providers
      // differ and a split block is a JSON parse error nobody should debug twice
      buffer = buffer.replace(/\r\n/g, "\n");
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue; // ": keepalive" comments and event: names
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") return;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch (e) {
            throw new LlmError("protocol", `the provider sent a line this client cannot read: ${payload.slice(0, 120)}`, false);
          }
          if (obj && obj.error) {
            throw new LlmError("api_error", providerMessage(null, JSON.stringify(obj)), false);
          }
          delivered = true;
          yield obj;
        }
      }
    }
    // The body ended. What that MEANS is the wire's to say (WIRES.*.ended): a
    // chat answer without its finish chunk is truncated and redialled, while the
    // responses feed reports its own terminal event and can legitimately end
    // without one.
    return;
  } finally {
    cleanup();
  }
}

// One provider chunk -> our events, exactly agent/llm/llm_clients/chunk_handle's
// four handlers. State is the caller's accumulators: content, reasoning, and the
// tool calls by index (the provider streams one call as many fragments).
function translateChat(obj, state) {
  const out = [];
  const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
  const delta = choice && choice.delta;
  if (delta) {
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) {
      state.reasoning.push(reasoning);
      out.push({ type: "reasoning", delta: reasoning });
    }
    if (delta.content) {
      state.content.push(delta.content);
      out.push({ type: "text", delta: delta.content });
    }
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const idx = tc.index;
      if (!state.toolArgs.has(idx)) {
        state.toolArgs.set(idx, { id: (tc.id || ""), name: (tc.function && tc.function.name) || "", args: "" });
        const entry = state.toolArgs.get(idx);
        out.push({ type: "tool_call_start", index: idx, id: entry.id, name: entry.name });
      }
      const entry = state.toolArgs.get(idx);
      if (tc.id) entry.id = tc.id;
      if (tc.function) {
        if (tc.function.name) entry.name = tc.function.name;
        if (tc.function.arguments) {
          entry.args += tc.function.arguments;
          out.push({ type: "tool_call_delta", index: idx, delta: tc.function.arguments });
        }
      }
    }
  }
  if (choice && choice.finish_reason) {
    state.finished = true;
    state.reason = choice.finish_reason;
    out.push({
      type: "finish",
      reason: choice.finish_reason,
      content: state.content.join(""),
      tool_calls: [...state.toolArgs.values()].map((e) => ({ id: e.id, name: e.name, arguments: e.args })),
      reasoning: state.reasoning.join(""),
    });
  }
  return out;
}

// ---- the responses wire (agent/llm/llm_clients/openai_responses_client.py) ----
// A second protocol behind the same contract, and a different SHAPE of the same
// turn: the conversation is a flat list of items (message / function_call /
// function_call_output) instead of [{role, content}], the system prompt is the
// top-level `instructions` string, tools are flat (no nested `function`), and
// the stream is a typed event feed instead of chunks. Three bridges live here
// and nothing downstream learns which protocol produced a turn: the request
// body, the event translation (response_handle.py), and the turn's end.

// The knob's levels are the chat protocol's; the Responses API calls its top
// level "high". Anything else passes through untouched.
const RESPONSES_EFFORT = { low: "low", medium: "medium", max: "high" };

// Chat-style message content -> text. Plain strings everywhere in this repo; the
// list branch is defensive for a provider-shaped content list.
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : "")).join("");
  }
  return "";
}

// Chat-completions history -> (instructions, input items). String content is
// used (both protocols' item types accept a string), so no input_text /
// output_text block typing can mismatch a role.
function toResponsesInput(messages) {
  const instructions = [];
  const items = [];
  for (const msg of messages) {
    const role = msg && msg.role;
    if (role === "system") {
      const text = textOf(msg.content);
      if (text) instructions.push(text);
    } else if (role === "user" || role === "assistant") {
      const text = textOf(msg.content);
      if (text) items.push({ role, content: text });
      for (const call of msg.tool_calls || []) {
        const fn = call.function || {};
        items.push({
          type: "function_call",
          call_id: call.id || "",
          name: fn.name || "",
          arguments: fn.arguments || "",
        });
      }
    } else if (role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: textOf(msg.content),
      });
    }
  }
  return { instructions: instructions.join("\n\n"), items };
}

// Chat-completions function schemas -> flat Responses tools.
function toResponsesTools(schemas) {
  return (schemas || []).map((schema) => {
    const fn = schema.function || {};
    const tool = { type: "function", name: fn.name || "", parameters: fn.parameters || {} };
    if (fn.description) tool.description = fn.description;
    return tool;
  });
}

// Where a streamed delta belongs: the output item's index, or its item_id when a
// provider omits output_index (the two are used consistently within one stream,
// so a tool_call_start and its deltas still line up).
function responsesKey(event) {
  const idx = event ? event.output_index : undefined;
  return idx === undefined || idx === null ? (event && event.item_id) || "" : idx;
}

function responseToolCalls(response) {
  const calls = [];
  for (const item of (response && response.output) || []) {
    if (item.type !== "function_call") continue;
    calls.push({ id: item.call_id || item.id || "", name: item.name || "", arguments: item.arguments || "" });
  }
  return calls;
}

function responseText(response) {
  const parts = [];
  for (const item of (response && response.output) || []) {
    if (item.type !== "message") continue;
    for (const block of item.content || []) {
      if (block.type === "output_text") parts.push(block.text || "");
      else if (block.type === "refusal") parts.push(block.refusal || "");
    }
  }
  return parts.join("");
}

// The turn's final event. Falls back to the terminal Response's own output when
// the stream carried no deltas (a buffering relay, or a provider that answered a
// stream request without streaming).
function responsesFinish(state, reason, response) {
  let toolCalls = [...state.toolArgs.values()].map((e) => ({ id: e.id, name: e.name, arguments: e.args }));
  if (!toolCalls.length && response) toolCalls = responseToolCalls(response);
  let content = state.content.join("");
  if (!content && response) content = responseText(response);
  const why = reason || (toolCalls.length ? "tool_calls" : "stop");
  return { type: "finish", reason: why, content, tool_calls: toolCalls, reasoning: state.reasoning.join("") };
}

// A provider-level failure keeps its own code, EXCEPT a window overflow: there
// the provider's wording ("context_length_exceeded", "maximum context length")
// is normalized to the one code the loop answers by compacting and retrying.
function failureCode(code, message) {
  return isContextOverflow(`${code} ${message}`) ? "context_window_exceeded" : code;
}

function responsesReasoning(event, state, out) {
  const type = event.type || "";
  if (type === "response.reasoning_summary_part.added") {
    // a new summary part starts a paragraph: the panel must not run them together
    if (state.reasoningStarted) out.push({ type: "reasoning", delta: "\n\n" });
    return;
  }
  if (type !== "response.reasoning_text.delta" && type !== "response.reasoning_summary_text.delta") return;
  const delta = event.delta || "";
  if (!delta) return;
  state.reasoningStarted = true;
  state.reasoning.push(delta);
  out.push({ type: "reasoning", delta });
}

// Assistant-visible text. A refusal is the turn's visible content too: the user
// must see it, so it streams on the same channel.
function responsesContent(event, state, out) {
  const type = event.type || "";
  if (type !== "response.output_text.delta" && type !== "response.refusal.delta") return;
  const delta = event.delta || "";
  if (!delta) return;
  state.content.push(delta);
  out.push({ type: "text", delta });
}

// Function calls are ITEMS, not a delta list: output_item.added announces
// {call_id, name} and function_call_arguments.delta streams the JSON, both keyed
// by output_index — so a call is fully identified before its arguments arrive
// (chat sends id/name in the same delta as the first argument fragment).
function responsesToolCall(event, state, out) {
  const type = event.type || "";
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = event.item;
    if (!item || item.type !== "function_call") return;
    const key = responsesKey(event);
    let entry = state.toolArgs.get(key);
    const fresh = entry === undefined;
    if (fresh) {
      entry = { id: "", name: "", args: "" };
      state.toolArgs.set(key, entry);
    }
    // the item is authoritative (output_item.done carries the complete
    // arguments): a delta that never arrived cannot leave a call short
    entry.id = item.call_id || item.id || entry.id;
    entry.name = item.name || entry.name;
    entry.args = item.arguments || entry.args;
    if (fresh) out.push({ type: "tool_call_start", index: key, id: entry.id, name: entry.name });
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const delta = event.delta || "";
    if (!delta) return;
    const key = responsesKey(event);
    let entry = state.toolArgs.get(key);
    if (!entry) {
      entry = { id: "", name: "", args: "" };
      state.toolArgs.set(key, entry);
    }
    entry.args += delta;
    out.push({ type: "tool_call_delta", index: key, delta });
    return;
  }
  if (type === "response.function_call_arguments.done") {
    const key = responsesKey(event);
    let entry = state.toolArgs.get(key);
    if (!entry) {
      entry = { id: "", name: "", args: "" };
      state.toolArgs.set(key, entry);
    }
    entry.args = event.arguments || entry.args;
  }
}

// Turn end. completed / incomplete carry the final Response and close the turn;
// failed and the mid-stream error event raise instead, because a failed turn is
// terminal — the provider said the request itself was bad, or it already
// reached the caller — and its own message is what the user needs to see.
function responsesCompletion(event, state, out) {
  const type = event.type || "";
  if (type === "response.completed") {
    const response = event.response || null;
    state.finished = true;
    // tool calls outrank text: a turn that asked for tools is not an answer
    state.reason = state.toolArgs.size || responseToolCalls(response).length ? "tool_calls" : "stop";
    out.push(responsesFinish(state, state.reason, response));
    return;
  }
  if (type === "response.incomplete") {
    const response = event.response || null;
    const detail = response && response.incomplete_details;
    // max_output_tokens = the turn was truncated: report it as "length" so the
    // loop drops partial tool calls and asks for a concise retry. Anything else
    // (content_filter) ends the turn like a stop.
    const reason = detail && detail.reason === "max_output_tokens" ? "length" : "stop";
    state.finished = true;
    state.reason = reason;
    out.push(responsesFinish(state, reason, response));
    return;
  }
  if (type !== "response.failed" && type !== "error") return;
  const failed = type === "response.failed";
  const error = (failed ? (event.response && event.response.error) : event) || {};
  const code = String(error.code || (failed ? "failed" : "error"));
  const message = String(
    error.message || (failed ? "the provider reported a failed response" : "the provider reported an error")
  );
  throw new LlmError(failureCode(code, message), message, false);
}

// The four handlers, in the order response_handle.py runs them. They touch
// disjoint event types, so the order only mirrors the Python list.
const RESPONSES_HANDLERS = [responsesReasoning, responsesContent, responsesToolCall, responsesCompletion];

function translateResponses(event, state) {
  const out = [];
  for (const handle of RESPONSES_HANDLERS) handle(event, state, out);
  return out;
}

// The two wires, named by the same `protocol` setting the Python factory reads.
// `ended` is what a body that stopped says: chat without a finish chunk is a
// truncated answer (a transport failure the ladder redials); the responses feed
// carries its output in the terminal event, and a relay that dropped it leaves
// the accumulated answer as the turn's answer rather than silently truncating.
const WIRES = {
  chat: {
    path: "/v1/chat/completions",
    body: ({ model, messages, tools, reasoningEffort }) => {
      const body = { model, messages, stream: true };
      if (Array.isArray(tools) && tools.length) body.tools = tools;
      if (reasoningEffort) body.thinking = { type: "enabled", reasoning_effort: reasoningEffort };
      return body;
    },
    translate: translateChat,
    ended: () => {
      throw new LlmError("connection", "the stream ended before its finish", true);
    },
  },
  responses: {
    path: "/v1/responses",
    body: ({ model, messages, tools, reasoningEffort }) => {
      const { instructions, items } = toResponsesInput(messages);
      const body = {
        model,
        input: items,
        stream: true,
        // our own event log IS the history: never retain a conversation server-side
        store: false,
      };
      if (instructions) body.instructions = instructions;
      if (Array.isArray(tools) && tools.length) body.tools = toResponsesTools(tools);
      if (reasoningEffort) body.reasoning = { effort: RESPONSES_EFFORT[reasoningEffort] || reasoningEffort };
      return body;
    },
    translate: translateResponses,
    ended: (state) => [responsesFinish(state, null, null)],
  },
};

function createLlmClient(options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || "").trim();
  const model = String(opts.model || "").trim();
  const apiKey = String(opts.apiKey || "");
  for (const [name, value] of [["baseUrl", baseUrl], ["model", model], ["apiKey", apiKey]]) {
    if (!value) throw new Error(`missing LLM argument: ${name}`);
  }
  const protocol = opts.protocol || "chat";
  const wire = WIRES[protocol];
  if (!wire) {
    // saying which wires exist beats speaking one at a provider and calling the
    // 404 a network failure
    throw new Error(`unknown LLM protocol: ${protocol} (the host speaks ${Object.keys(WIRES).join(" and ")})`);
  }
  const readTimeoutMs = opts.readTimeoutMs || READ_TIMEOUT_MS;
  const stallMs = opts.stallMs || STALL_PROBE_MS;
  const probeTimeoutMs = opts.probeTimeoutMs || PROBE_TIMEOUT_MS;
  const backoffCapMs = opts.backoffCapMs || MAX_BACKOFF_MS;
  // callers may hand in the endpoint's own liveness check (the Python client
  // does: probe=self.endpoint_alive); tests use it to tell the watchdog's two
  // answers apart without a network that can be half-killed
  const probe = opts.probe === undefined ? () => probeAlive(baseUrl, probeTimeoutMs) : opts.probe;
  const midStreamRetry = opts.midStreamRetry === undefined ? true : Boolean(opts.midStreamRetry);

  const url = joinUpstream(baseUrl, wire.path);
  const headers = () => ({
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: "Bearer " + apiKey,
  });
  // The request body is the wire's, assembled where the client is configured:
  // reasoning_effort rides in the provider's own block (chat's `thinking`,
  // responses' `reasoning`), tools only when there are any.
  const requestBody = (messages, tools) =>
    JSON.stringify(wire.body({ model, messages, tools, reasoningEffort: opts.reasoningEffort }));

  // The turn as events, retrying transport failures around a single attempt.
  // `finish` is the last event (reaching it ends the turn); a provider-level
  // failure is thrown as LlmError and passed through untouched.
  async function* stream({ messages, tools, signal }) {
    if (!Array.isArray(messages) || !messages.length) throw new TypeError("llm: messages are required");
    const body = requestBody(messages, tools);
    let attemptNo = 0;
    for (;;) {
      const state = { content: [], reasoning: [], toolArgs: new Map(), finished: false, reason: "stop" };
      let delivered = false;
      try {
        for await (const obj of attempt({
          url,
          headers: headers(),
          body,
          signal,
          readTimeoutMs,
          stallMs,
          probe,
          midStreamRetry,
        })) {
          for (const ev of wire.translate(obj, state)) {
            delivered = true;
            yield ev;
            if (ev.type === "finish") return;
          }
        }
        // The body ended without a finish. What that means is the wire's:
        // chat's missing finish chunk is a truncated answer (a transport
        // failure the ladder redials), while the responses feed carries its
        // output in the terminal event and a relay that dropped it leaves the
        // accumulated answer as the turn's answer.
        for (const ev of wire.ended(state)) {
          delivered = true;
          yield ev;
          if (ev.type === "finish") return;
        }
      } catch (e) {
        const err = e instanceof LlmError ? e : transportError(e);
        if (signal && signal.aborted) throw cancelled();
        // a partly delivered attempt is only re-runnable when the caller
        // promised to discard what it already took
        const rerunnable = !delivered || midStreamRetry;
        if (!err.retryable || !rerunnable) throw err;
        // announce BEFORE the backoff, so the caller can record the attempt and
        // the UI can show recovery instead of a frozen spinner
        yield {
          type: "retry",
          attempt: attemptNo + 1,
          max: 0, // no cap: 0 follows the loop's own "0 means no limit" convention
          code: err.code,
          discard: delivered,
          message: `${err.message} — retrying (${attemptNo + 1}/…)`,
        };
        await sleep(backoffMs(attemptNo, backoffCapMs), signal);
      }
      attemptNo += 1;
    }
  }

  // The stream, accumulated into the one answer the loop's model port wants.
  // `onEvent` sees every display delta; `onRetry` sees the retry notices (D12's
  // per-attempt record). A retry with discard=true wipes what this attempt had
  // accumulated, so the retried answer is not appended to a dead half-sentence.
  async function ask({ messages, tools, signal, onEvent, onRetry } = {}) {
    const state = { content: [], reasoning: [], toolArgs: new Map(), finished: false, reason: "stop" };
    for await (const ev of stream({ messages, tools, signal })) {
      if (ev.type === "retry") {
        if (ev.discard) {
          state.content.length = 0;
          state.reasoning.length = 0;
          state.toolArgs.clear();
        }
        if (onRetry) onRetry(ev);
        continue;
      }
      if (ev.type === "reasoning") state.reasoning.push(ev.delta);
      if (onEvent) onEvent(ev);
      if (ev.type === "finish") {
        return {
          content: ev.content,
          reasoning: state.reasoning.join(""),
          toolCalls: ev.tool_calls,
          finishReason: ev.reason,
        };
      }
    }
    // stream() only returns after a finish event; falling out means it did not
    throw new LlmError("unknown", "the model stream ended without a finish", false);
  }

  return { stream, ask, url, model };
}

module.exports = {
  createLlmClient,
  LlmError,
  backoffMs,
  probeAlive,
  isContextOverflow,
  // the policy numbers, so a caller reads them from one place
  READ_TIMEOUT_MS,
  STALL_PROBE_MS,
  MAX_BACKOFF_MS,
};
