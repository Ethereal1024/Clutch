// The model connection on the far-root host: one streamed turn, the retry
// policy around it, and the errors a caller can act on.
//
// Ported from `agent/llm/client.py` (the contract + error normalization),
// `llm/clients/openai_client.py` and `llm/clients/chunk_handle.py` (chat
// completions -> our event protocol), `llm/clients/openai_responses_client.py`
// and `response_handle.py` (the Responses protocol), `llm/clients/stream_runner.py`
// (attempts, the redial ladder, the silence watchdog) and `llm/proxy.py`
// (which proxy a URL should use).
//
// Why there is no SDK: deployment B has no Python, and the OpenAI SDK is a
// Python package. The wire is small — JSON in, SSE out — and it is exactly what
// `ui/llm-proxy.js` already speaks in this process with `http`/`https`, so this
// file is the same dialect without the reverse proxy in front of it.
//
// What is NOT ported, and why:
//   * `BaseOpenaiClient.repoint` / `_live` / socket interrupts. A re-point exists
//     because a REMOTE session's endpoint is a reverse-forwarded port on the
//     client that can move under it. On B the endpoint is this machine's own
//     settings and no tunnel stands between the client and the provider, so
//     there is no port to chase. `endpointAlive` stays: the silence watchdog
//     needs it (a path that went away parks a read the run cannot otherwise
//     notice).
//   * `keepalive.py`'s three socket options. Node exposes SO_KEEPALIVE through
//     `socket.setKeepAlive(true, idleMs)` but not TCP_KEEPINTVL/TCP_KEEPCNT;
//     the idle knob is applied (20s, the Python constant) and the read budget +
//     stall probe cover the rest. The behaviour that matters — a black hole is
//     noticed in ~35s instead of 240s — is the combination of the two, and both
//     are here.
//
// Cancellation: `cancel` is the run's Stop. It is checked before an attempt, by
// the watchdog while an attempt is parked in a read (closing the connection is
// the only way to make that read return now), and while waiting between
// attempts. A Stop reads as LlmError(code="cancelled"), never as a retry.

"use strict";

const http = require("http");
const https = require("https");
const tls = require("tls");

// ---- the numbers (agent/core/config.py defaults + stream_runner.py) ----

const DEFAULT_REQUEST_TIMEOUT_S = 60;
const DEFAULT_READ_TIMEOUT_S = 240;
const DEFAULT_RETRYABLE_STATUS = [429, 500, 502, 503, 504];

// The redial ladder's cap: 1,2,4,...,128s and hold there.
const MAX_REDIAL_BACKOFF_S = 128;
// How often the guard checks Stop while an attempt is parked in a read.
const GUARD_POLL_S = 0.25;
// How long an attempt may deliver NOTHING before the endpoint's own path is
// probed. Silence has two causes — a provider thinking (healthy) and a path
// that went away (dead) — and only a failed probe closes an attempt, so a slow
// provider is never punished for thinking.
const STALL_PROBE_S = 20;
// How often the pre-flight re-asks a path it knows is gone, and how long it
// waits before issuing the request anyway (a witness that never answers must
// not replace retrying with waiting).
const PATH_POLL_S = 10;
const PATH_WAIT_MAX_S = 180;
// The probe's own budget: the streaming read budget is for chunk gaps and would
// make the probe useless as a watchdog.
const ENDPOINT_PROBE_TIMEOUT_S = 6;
// One provider error body is a diagnostic, not a payload.
const ERROR_BODY_LIMIT = 64 * 1024;

const API_PROTOCOLS = ["chat", "responses"];

// The Responses API names its top level "high"; the knob's levels are the chat
// protocol's. Anything else passes through untouched.
const REASONING_EFFORT = { low: "low", medium: "medium", max: "high" };

const SOCK_SCHEMES = ["socks://", "socks4://", "socks4a://", "socks5://", "socks5h://"];

// ---- errors (client.py) ----

// LlmError is a normal JS error with the fields Python's dataclass carries.
// `message` is the human text (`str(LlmError)` is empty in Python, so every
// consumer reads `.message`; here it is the standard Error field).
class LlmError extends Error {
  constructor({ code = "unknown", status = null, retryable = false, message = "" } = {}) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.status = status === undefined ? null : status;
    this.retryable = Boolean(retryable);
  }
}

function timeoutError(phase) {
  if (phase === "connect") {
    return new LlmError({
      code: "timeout",
      retryable: true,
      message:
        "Connect timed out: no route to the API endpoint " +
        "(network to the provider, a proxy, or the base_url).",
    });
  }
  return new LlmError({
    code: "timeout",
    retryable: true,
    message:
      "Read timed out: the API sent no data for a long stretch " +
      "(provider stall or a buffering relay).",
  });
}

function cancelled(message) {
  return new LlmError({ code: "cancelled", retryable: false, message });
}

// The watchdog's verdict as an error: a probe down the attempt's own path found
// nothing serving it while the attempt stayed silent. Retryable — the path
// coming back is exactly what a redial waits for.
function pathGone() {
  return new LlmError({
    code: "connection",
    retryable: true,
    message: "endpoint stopped answering — the connection path went away",
  });
}

function isContextOverflow(...texts) {
  return texts.some((t) => typeof t === "string" && t.toLowerCase().includes("context"));
}

// Tidy an OpenAI-style error body. Python sees the SDK's rendering,
// `Error code: 429 - {'error': {'message': …}}`; this side builds the same raw
// text from the response body, so one cleaner serves both. Anything that does
// not parse stays verbatim.
function cleanProviderMessage(raw, status) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  const at = text.indexOf(" - ");
  if (at < 0) return text;
  let data;
  try {
    data = JSON.parse(text.slice(at + 3));
  } catch (e) {
    return text;
  }
  const err = data && typeof data === "object" ? data.error : null;
  if (!err || typeof err !== "object" || typeof err.message !== "string" || !err.message.trim()) return text;
  const extra = [];
  if (err.code) extra.push(`code ${err.code}`);
  if (status !== null && status !== undefined) extra.push(`HTTP ${status}`);
  const tidied = err.message.trim();
  return extra.length ? `${tidied} (${extra.join(", ")})` : tidied;
}

// An HTTP response that was not 2xx: its status and body are what classify()
// needs, and both are gone by the time a socket error could carry them.
class HttpStatusError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body || "";
  }
}

// Certificate failures, in the three shapes the platform reports them. Kept
// beside classify() because the verdict is one sentence plus the code: this
// module has no URL to name (the request functions own the target), so the
// message carries the reason and the knob, and the caller names the endpoint
// from its own settings.
const TLS_UNTRUSTED_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "INVALID_CA",
  "CERT_SIGNATURE_FAILURE",
]);
const TLS_STALE_CODES = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"]);
const TLS_CODES = new Set([...TLS_UNTRUSTED_CODES, ...TLS_STALE_CODES, "ERR_TLS_CERT_ALTNAME_INVALID"]);

function tlsMessage(code, reason) {
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return `TLS certificate: ${reason} — the certificate does not cover the base_url's host, so either that host is wrong or something in the path answers for it.`;
  }
  if (TLS_STALE_CODES.has(code)) {
    return `TLS certificate: ${reason} — check this machine's clock, and whether something in the path presents its own certificate.`;
  }
  return `TLS certificate not trusted: ${reason} — this host verifies against Node's own CA list, not the system one, so a proxy that inspects HTTPS is the usual cause (the browser trusts its root CA, the agent does not). Point NODE_EXTRA_CA_CERTS at that root CA, or start the host with --use-system-ca, and reopen it.`;
}

function classify(e, retryableStatus = DEFAULT_RETRYABLE_STATUS) {
  if (e instanceof LlmError) return e;
  if (e instanceof HttpStatusError) {
    const raw = `Error code: ${e.status} - ${e.body}`;
    if (e.status === 400 && isContextOverflow(e.body)) {
      return new LlmError({
        code: "context_window_exceeded",
        status: 400,
        retryable: false,
        message: cleanProviderMessage(raw, 400),
      });
    }
    if (e.status === 429) {
      // the SDK raises RateLimitError before APIStatusError: 429 is always
      // retryable, whatever retryable_status says
      return new LlmError({
        code: "rate_limit",
        status: 429,
        retryable: true,
        message: cleanProviderMessage(raw, 429),
      });
    }
    return new LlmError({
      code: "api_error",
      status: e.status,
      retryable: retryableStatus.includes(e.status),
      message: cleanProviderMessage(raw, e.status),
    });
  }
  if (e && e.__llmTimeout) return timeoutError(e.__llmTimeout);
  const code = e && typeof e.code === "string" ? e.code : "";
  const text = e && e.message ? String(e.message) : "";
  // A handshake this process refused, before any HTTP: not a dead path (so the
  // ladder must not redial it) and not the provider's verdict. The bare OpenSSL
  // sentence names neither the cause nor the knob, and the cause is usually a
  // TLS-inspecting proxy — its root CA is in the SYSTEM store, which the browser
  // reads and Node's bundled list does not.
  if (TLS_CODES.has(code)) {
    return new LlmError({
      code: "tls",
      retryable: false,
      message: tlsMessage(code, text || code),
    });
  }
  const transportCode =
    /^(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|ERR_STREAM_PREMATURE_CLOSE)$/.test(
      code
    );
  // a mangled body / parse failure also says "unexpected end of..." — only
  // socket-shaped messages mean the transport died; assertion errors never do
  const transportText =
    /socket hang up|aborted|premature close|closed/i.test(text) && !code.startsWith("ERR_ASSERTION");
  if (transportCode || transportText) {
    const phase = e && e.__llmPhase ? e.__llmPhase : "stream";
    return new LlmError({
      code: "connection",
      retryable: true,
      message:
        phase === "connect"
          ? `Cannot reach the API endpoint: ${text}`
          : text
          ? `Connection interrupted: ${text}`
          : "Connection interrupted.",
    });
  }
  return new LlmError({ code: "unknown", retryable: false, message: text });
}

// ---- proxy resolution (llm/proxy.py) ----

function envValue(key, env) {
  return env[key.toLowerCase()] || env[key.toUpperCase()] || "";
}

function noProxyMatch(hostname, env) {
  const noProxy = envValue("no_proxy", env).trim();
  if (!noProxy || noProxy === "*") return false;
  for (let entry of noProxy.split(",")) {
    entry = entry.trim().replace(/^\*+/, "");
    if (!entry) continue;
    if (hostname === entry || hostname.endsWith("." + entry)) return true;
  }
  return false;
}

// The proxy a URL should be reached through, or null for a direct connection.
// httpx cannot parse socks:// at all, and a `socks` value would otherwise reach
// the transport and crash it — so it is skipped here, exactly as Python does.
function getProxyForUrl(inputUrl, env = process.env) {
  if (!inputUrl) return null;
  let parsed;
  try {
    parsed = new URL(String(inputUrl));
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = (parsed.hostname || "").replace(/^\[|\]$/g, "");
  if (!hostname || noProxyMatch(hostname, env)) return null;
  // loopback never needs a proxy (a local mock, a local provider)
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return null;

  const scheme = parsed.protocol.slice(0, -1);
  const proxy = envValue(`${scheme}_proxy`, env) || envValue("all_proxy", env);
  if (!proxy) return null;
  if (SOCK_SCHEMES.some((s) => proxy.toLowerCase().startsWith(s))) return null;
  if (proxy.includes("://")) return proxy;
  return `${scheme}://${proxy}`;
}

// The configured value wins over the environment: "auto" (default) resolves per
// URL, false/null forces a direct connection (tests, a provider on the LAN a
// machine-wide proxy would break), a string is that proxy.
function resolveProxy(url, setting, env) {
  if (setting === false || setting === null) return null;
  if (setting && setting !== "auto") return String(setting);
  return getProxyForUrl(url, env);
}

// ---- small async plumbing ----

const nowMs = () => Date.now();

function isCancelled(cancel) {
  if (!cancel) return false;
  if (typeof cancel.isSet === "function") return Boolean(cancel.isSet());
  if (typeof cancel.is_set === "function") return Boolean(cancel.is_set());
  return Boolean(cancel.aborted);
}

// Wait `ms`, returning true when the wait was cut short by Stop. The poll keeps
// a 2-minute backoff responsive without needing an EventEmitter contract.
function sleep(ms, cancel) {
  return new Promise((resolve) => {
    if (!cancel) {
      const timer = setTimeout(() => resolve(false), ms);
      if (timer.unref) timer.unref();
      return;
    }
    const started = nowMs();
    const tick = () => {
      if (isCancelled(cancel)) return resolve(true);
      const left = ms - (nowMs() - started);
      if (left <= 0) return resolve(false);
      const timer = setTimeout(tick, Math.min(25, left));
      if (timer.unref) timer.unref();
    };
    tick();
  });
}

async function pathOk(probe) {
  try {
    return Boolean(await probe());
  } catch (e) {
    return false; // a probe that blows up is not an answer
  }
}

// The frames a response delivers, one SSE payload at a time. Buffered by bytes,
// split on "\n" (the spec's \r\n tolerated), and a payload is the "data:" lines
// of one event joined by newlines. Fields this side does not use (event/id/
// retry, comments) are skipped — the payload's own JSON says what it is.
async function* ssePayloads(res) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let data = null;

  const consume = (text, out) => {
    buffer += text;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (data !== null) {
          out.push(data);
          data = null;
        }
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data = data === null ? value : `${data}\n${value}`;
    }
  };

  for await (const chunk of res) {
    const out = [];
    consume(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }), out);
    for (const payload of out) yield payload;
  }
  const out = [];
  const tail = decoder.decode();
  if (tail) consume(tail, out);
  if (buffer.length) consume("\n", out); // a last line with no newline
  for (const payload of out) yield payload;
  if (data !== null) yield data; // an event with no closing blank line
}

// A push->pull bridge, because the request has to be issued EAGERLY (the retry
// ladder's source() runs between attempts) while the consumer is an async
// iterator. `fail` wins over anything still buffered: a dead attempt's tail is
// not part of the next one.
class PayloadQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.done = false;
    this.error = null;
  }

  push(value) {
    if (this.error || this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.items.push(value);
  }

  finish() {
    if (this.done || this.error) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error) {
    if (this.done || this.error) return;
    this.error = error;
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next() {
    if (this.error) return Promise.reject(this.error);
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

// ---- one HTTP request, direct or through a proxy ----
//
// `openRequest` issues the request immediately and reports through callbacks:
//   onResponse(res)   response headers arrived (any status)
//   onError(err)      the attempt failed before a complete body was consumed
// It returns `close()`, which tears down whatever is holding the connection
// (request, tunnel, TLS socket) and is safe to call twice or after the end.
// Timeouts are httpx's split: a tight one to establish a connection, a generous
// one for the gap between reads.
function openRequest(
  target,
  {
    method = "GET",
    headers = {},
    body = null,
    proxy = null,
    tlsOptions = {},
    connectTimeoutS = 15,
    readTimeoutS = DEFAULT_READ_TIMEOUT_S,
    onResponse,
    onError,
  }
) {
  let settled = false;
  let response = null;
  let request = null;
  let connectRequest = null;
  let tlsSocket = null;
  let connectTimer = null;
  let readTimer = null;

  const stopConnectClock = () => {
    if (!connectTimer) return;
    clearTimeout(connectTimer);
    connectTimer = null;
  };

  const clearTimers = () => {
    stopConnectClock();
    if (readTimer) clearTimeout(readTimer);
    readTimer = null;
  };

  // Teardown never touches `settled`: both `close()` (the caller stopped it)
  // and `fail()` (the attempt died) go through it, and `fail` must be able to
  // report after the sockets are gone. Destroying is idempotent, so a `fail`
  // that races a `close` is harmless.
  const teardown = () => {
    clearTimers();
    for (const thing of [response, tlsSocket, connectRequest, request]) {
      if (!thing) continue;
      try {
        thing.destroy();
      } catch (e) {
        /* already gone */
      }
    }
  };

  function close() {
    settled = true;
    teardown();
  }

  function fail(error) {
    if (settled) return;
    settled = true;
    try {
      onError(error);
    } finally {
      teardown();
    }
  }

  // A synchronous setup failure (an unparsable target, an option Node rejects) is
  // reported the way every other failure is: asynchronously, through onError,
  // never as an exception escaping the caller.
  function refuse(error) {
    error.__llmPhase = "connect";
    setTimeout(() => fail(error), 0);
    return close;
  }

  // Build one request and put it on the wire. A constructor (or the request
  // itself, in `end`) that throws is a connect-phase failure, not a crash.
  function send(factory) {
    try {
      wire(factory());
    } catch (e) {
      return refuse(e);
    }
    return close;
  }

  // The connect budget only covers establishing the connection. It is spent
  // when the socket is up: a stream that outlives it is slow, not unreachable.
  // For a tunnel `wire()` is only reached after `secureConnect`, so the TLS
  // handshake is still charged to the connect budget, as httpx charges it.
  const socketUp = () => {
    const socket = request && request.socket;
    return !!(socket && !socket.connecting);
  };

  const armConnect = (seconds) => {
    stopConnectClock();
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (socketUp()) return; // raced the event, not a timeout
      const error = new Error("connect timed out");
      error.__llmTimeout = "connect";
      fail(error);
    }, Math.max(1, seconds * 1000));
    if (connectTimer.unref) connectTimer.unref();
  };

  const armRead = (seconds) => {
    if (readTimer) clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const error = new Error("read timed out");
      error.__llmTimeout = "read";
      fail(error);
    }, Math.max(1, seconds * 1000));
    if (readTimer.unref) readTimer.unref();
  };

  const onSocket = (socket) => {
    try {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 20000); // keepalive.py's idle knob
    } catch (e) {
      /* not a TCP socket, or already gone */
    }
  };

  const wire = (req) => {
    request = req;
    req.on("socket", (socket) => {
      onSocket(socket);
      if (!socket.connecting) {
        stopConnectClock();
        return;
      }
      socket.once("connect", stopConnectClock);
      socket.once("secureConnect", stopConnectClock);
    });
    req.on("response", (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      clearTimers();
      response = res;
      // the body's chunk gaps (the read budget) — a headers-only timeout would
      // have fired above, before the response arrived
      res.setTimeout(Math.max(1, readTimeoutS * 1000), () => {
        const error = new Error("read timed out");
        error.__llmTimeout = "read";
        res.destroy(error);
      });
      onResponse(res);
    });
    req.on("error", (error) => {
      if (!error.__llmPhase) error.__llmPhase = response ? "stream" : "connect";
      fail(error);
    });
    req.end(body === null ? undefined : body);
    armRead(readTimeoutS);
  };

  let parsed;
  try {
    parsed = new URL(String(target));
  } catch (e) {
    return refuse(new Error(`invalid URL: ${target}`));
  }

  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const path = `${parsed.pathname || "/"}${parsed.search || ""}`;

  armConnect(connectTimeoutS);
  if (!proxy) {
    const mod = parsed.protocol === "https:" ? https : http;
    return send(() =>
      mod.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port,
          path,
          method,
          headers,
          ...tlsOptions,
        },
        undefined
      )
    );
  }

  // ---- through a proxy ----
  const proxyUrl = new URL(proxy);
  const proxyTls = proxyUrl.protocol === "https:";
  const proxyMod = proxyTls ? https : http;
  const proxyPort = proxyUrl.port || (proxyTls ? "443" : "80");
  const proxyHeaders = { ...headers };
  if (proxyUrl.username || proxyUrl.password) {
    const user = decodeURIComponent(proxyUrl.username);
    const pass = decodeURIComponent(proxyUrl.password);
    proxyHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }

  if (parsed.protocol === "http:") {
    // absolute-form request: the proxy parses the target itself
    return send(() =>
      proxyMod.request(
        {
          protocol: proxyUrl.protocol,
          hostname: proxyUrl.hostname,
          port: proxyPort,
          method,
          path: parsed.href,
          headers: { ...proxyHeaders, Host: parsed.host },
          ...tlsOptions,
        },
        undefined
      )
    );
  }

  // https through a proxy: CONNECT, then TLS on the same socket. Node cannot
  // proxy an https request without an agent, and the only agent in this repo
  // (`proxy-agent`) is ESM-only — unavailable on the embedded node the phone
  // runs. Thirty lines of CONNECT is the portable answer.
  const authority = `${parsed.hostname}:${port}`;
  try {
    connectRequest = proxyMod.request({
      protocol: proxyUrl.protocol,
      hostname: proxyUrl.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      headers: { ...proxyHeaders, Host: authority },
      ...tlsOptions,
    });
  } catch (e) {
    return refuse(e);
  }
  connectRequest.on("connect", (res, socket) => {
    if (settled) {
      socket.destroy();
      return;
    }
    if (res.statusCode !== 200) {
      const error = new HttpStatusError(res.statusCode, `proxy CONNECT failed for ${authority}`);
      fail(error);
      return;
    }
    tlsSocket = tls.connect({ socket, servername: parsed.hostname, ...tlsOptions });
    tlsSocket.on("error", (error) => {
      error.__llmPhase = "connect";
      fail(error);
    });
    tlsSocket.once("secureConnect", () => {
      if (settled) return;
      armRead(readTimeoutS);
      let req;
      try {
        req = https.request({
          protocol: "https:",
          hostname: parsed.hostname,
          port,
          path,
          method,
          headers,
          agent: false,
          createConnection: () => tlsSocket,
          ...tlsOptions,
        });
      } catch (e) {
        e.__llmPhase = "connect";
        fail(e);
        return;
      }
      wire(req);
    });
  });
  connectRequest.on("error", (error) => {
    error.__llmPhase = "connect";
    fail(error);
  });
  connectRequest.end();
  return close;
}

// The 2xx body as one SSE attempt. `onFrames` is not used: the queue is the
// contract, and the protocol translation above it consumes it.
function openStream(target, options) {
  const queue = new PayloadQueue();
  let closed = false;

  const close = openRequest(target, {
    method: "POST",
    headers: options.headers,
    body: options.body,
    proxy: options.proxy,
    tlsOptions: options.tlsOptions,
    connectTimeoutS: options.connectTimeoutS,
    readTimeoutS: options.readTimeoutS,
    onResponse: (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        collectBody(res, (body) => queue.fail(new HttpStatusError(res.statusCode, body)));
        return;
      }
      res.on("error", (error) => {
        if (!error.__llmPhase) error.__llmPhase = "stream";
        queue.fail(error);
      });
      pump();
      async function pump() {
        try {
          for await (const payload of ssePayloads(res)) {
            if (closed) return;
            queue.push(payload);
          }
          queue.finish();
        } catch (error) {
          if (!error.__llmPhase) error.__llmPhase = "stream";
          queue.fail(error);
        }
      }
    },
    onError: (error) => queue.fail(error),
  });

  return {
    frames: queue,
    close() {
      closed = true;
      close();
    },
  };
}

function collectBody(res, done) {
  let text = "";
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    done(text);
  };
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    if (settled) return;
    if (text.length < ERROR_BODY_LIMIT) text += chunk;
    if (text.length >= ERROR_BODY_LIMIT) {
      res.destroy();
      finish();
    }
  });
  res.on("end", finish);
  res.on("error", finish);
  res.on("close", finish);
}

// ---- chat completions -> our event protocol (chunk_handle.py) ----

function finishFromChat(state, reason) {
  return {
    type: "finish",
    reason,
    content: state.contentParts.join(""),
    // the field name is the wire contract every consumer reads (Python's
    // chunk_handle emits `tool_calls`): the loop rebuilds the turn from deltas,
    // but a caller that only sees the finish must still find the calls here
    tool_calls: [...state.toolArgs.values()].map((e) => ({ id: e.id, name: e.name, arguments: e.args })),
  };
}

function chatEvents(frames) {
  return (async function* () {
    const state = { contentParts: [], toolArgs: new Map(), finished: false };
    for await (const payload of frames) {
      if (payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch (e) {
        continue; // a keepalive comment parsed as a frame, or a torn chunk
      }
      if (!chunk || !Array.isArray(chunk.choices) || !chunk.choices.length) continue;
      if (state.finished) break;
      const choice = chunk.choices[0];
      const delta = choice.delta || null;
      if (delta) {
        const reasoning = delta.reasoning_content || delta.reasoning;
        if (reasoning) yield { type: "reasoning", delta: reasoning };
        if (delta.content) {
          state.contentParts.push(delta.content);
          yield { type: "text", delta: delta.content };
        }
        for (const call of delta.tool_calls || []) {
          const index = call.index;
          if (!state.toolArgs.has(index)) {
            state.toolArgs.set(index, {
              id: call.id || "",
              name: (call.function && call.function.name) || "",
              args: "",
            });
            const entry = state.toolArgs.get(index);
            yield { type: "tool_call_start", index, id: entry.id, name: entry.name };
          }
          const entry = state.toolArgs.get(index);
          if (call.id) entry.id = call.id;
          if (call.function) {
            if (call.function.name) entry.name = call.function.name;
            if (call.function.arguments) {
              entry.args += call.function.arguments;
              yield { type: "tool_call_delta", index, delta: call.function.arguments };
            }
          }
        }
      }
      if (choice.finish_reason) {
        state.finished = true;
        yield finishFromChat(state, choice.finish_reason);
        return;
      }
    }
    // the stream ended without a finish chunk (a relay that dropped it):
    // report what arrived instead of leaving the turn without a finish
    yield finishFromChat(state, "stop");
  })();
}

// ---- Responses protocol -> our event protocol (response_handle.py) ----

function responsesText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" ? block.text || "" : "")).join("");
  }
  return "";
}

// Chat-completions history -> (instructions, input items). Plain-string content
// is used (both protocols' item types accept a string), so no
// input_text/output_text block typing can mismatch a role.
function toResponsesInput(messages) {
  const instructions = [];
  const items = [];
  for (const msg of messages || []) {
    const role = msg.role;
    if (role === "system") {
      const text = responsesText(msg.content);
      if (text) instructions.push(text);
    } else if (role === "user" || role === "assistant") {
      const text = responsesText(msg.content);
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
        output: responsesText(msg.content),
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

function responseToolCalls(response) {
  const calls = [];
  for (const item of (response && response.output) || []) {
    if (!item || item.type !== "function_call") continue;
    calls.push({
      id: item.call_id || item.id || "",
      name: item.name || "",
      arguments: item.arguments || "",
    });
  }
  return calls;
}

function responseText(response) {
  const parts = [];
  for (const item of (response && response.output) || []) {
    if (!item || item.type !== "message") continue;
    for (const block of item.content || []) {
      if (!block) continue;
      if (block.type === "output_text") parts.push(block.text || "");
      else if (block.type === "refusal") parts.push(block.refusal || "");
    }
  }
  return parts.join("");
}

function responsesFinish(state, reason, response) {
  let toolCalls = [...state.toolArgs.values()].map((e) => ({ id: e.id, name: e.name, arguments: e.args }));
  if (!toolCalls.length && response) toolCalls = responseToolCalls(response);
  let content = state.contentParts.join("");
  if (!content && response) content = responseText(response);
  if (reason === undefined || reason === null) reason = toolCalls.length ? "tool_calls" : "stop";
  return { type: "finish", reason, content, tool_calls: toolCalls };
}

// A provider-level failure keeps its own code, EXCEPT a window overflow: the
// provider's wording is normalized to the one code the loop answers by
// compacting and retrying.
function failureCode(code, message) {
  return isContextOverflow(code, message) ? "context_window_exceeded" : code;
}

function responsesEvents(frames) {
  return (async function* () {
    const state = { contentParts: [], toolArgs: new Map(), finished: false, reasoningStarted: false };
    const keyOf = (event) =>
      event.output_index === undefined || event.output_index === null
        ? event.item_id || ""
        : event.output_index;

    for await (const payload of frames) {
      let event;
      try {
        event = JSON.parse(payload);
      } catch (e) {
        continue;
      }
      if (!event || typeof event !== "object") continue;
      const type = event.type || "";

      if (type === "response.reasoning_summary_part.added") {
        // a new summary part starts a paragraph; the first one has nothing to
        // separate from
        if (state.reasoningStarted) yield { type: "reasoning", delta: "\n\n" };
        continue;
      }
      if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
        const delta = event.delta || "";
        if (delta) {
          state.reasoningStarted = true;
          yield { type: "reasoning", delta };
        }
        continue;
      }
      if (type === "response.output_text.delta" || type === "response.refusal.delta") {
        const delta = event.delta || "";
        if (delta) {
          state.contentParts.push(delta);
          yield { type: "text", delta };
        }
        continue;
      }
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = event.item;
        if (!item || item.type !== "function_call") continue;
        const key = keyOf(event);
        let entry = state.toolArgs.get(key);
        const fresh = entry === undefined;
        if (fresh) {
          entry = { id: "", name: "", args: "" };
          state.toolArgs.set(key, entry);
        }
        // the item is authoritative (done carries the complete arguments): a
        // delta that never arrived cannot leave a call short
        entry.id = item.call_id || item.id || entry.id;
        entry.name = item.name || entry.name;
        entry.args = item.arguments || entry.args;
        if (fresh) yield { type: "tool_call_start", index: key, id: entry.id, name: entry.name };
        continue;
      }
      if (type === "response.function_call_arguments.delta") {
        const delta = event.delta || "";
        if (!delta) continue;
        const key = keyOf(event);
        if (!state.toolArgs.has(key)) state.toolArgs.set(key, { id: "", name: "", args: "" });
        state.toolArgs.get(key).args += delta;
        yield { type: "tool_call_delta", index: key, delta };
        continue;
      }
      if (type === "response.function_call_arguments.done") {
        const key = keyOf(event);
        if (!state.toolArgs.has(key)) state.toolArgs.set(key, { id: "", name: "", args: "" });
        const entry = state.toolArgs.get(key);
        entry.args = event.arguments || entry.args;
        continue;
      }
      if (type === "response.completed") {
        state.finished = true;
        const reason = state.toolArgs.size || responseToolCalls(event.response).length ? "tool_calls" : "stop";
        yield responsesFinish(state, reason, event.response);
        return;
      }
      if (type === "response.incomplete") {
        const details = (event.response && event.response.incomplete_details) || {};
        // max_output_tokens = the turn was truncated: the loop drops partial
        // tool calls and asks for a concise retry
        const reason = details.reason === "max_output_tokens" ? "length" : "stop";
        state.finished = true;
        yield responsesFinish(state, reason, event.response);
        return;
      }
      if (type === "response.failed" || type === "error") {
        const error = (event.response && event.response.error) || event;
        const code = String(error.code || (type === "error" ? "error" : "failed"));
        const message = String(
          error.message ||
            (type === "error" ? "the provider reported an error" : "the provider reported a failed response")
        );
        throw new LlmError({ code: failureCode(code, message), retryable: false, message });
      }
    }
    // the feed ended without a terminal event (a relay that dropped it):
    // report what arrived instead of leaving the turn without a finish
    yield responsesFinish(state, undefined, null);
  })();
}

// ---- the retry ladder (stream_runner.py) ----

function startWatchdog({ cancel, close, watch, midStreamRetry, stallS, guardPollS }) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (isCancelled(cancel)) {
      stop();
      quietClose(close);
      return;
    }
    const probe = watch.probe;
    if (!probe || watch.nudged || watch.probing) return;
    if (nowMs() - watch.last < stallS * 1000) return;
    if (watch.delivered && !midStreamRetry) return; // a retry would duplicate what the caller keeps
    const before = watch.last;
    watch.probing = true;
    Promise.resolve()
      .then(() => probe())
      .then(
        (alive) => {
          watch.probing = false;
          if (stopped || watch.nudged || watch.last !== before) return; // it answered: the path is up
          if (alive) return;
          watch.nudged = true;
          quietClose(close);
        },
        () => {
          watch.probing = false;
          if (stopped || watch.nudged || watch.last !== before) return;
          watch.nudged = true; // a probe that blows up is not an answer: it cannot be one
          quietClose(close);
        }
      );
  };
  const timer = setInterval(tick, Math.max(1, guardPollS * 1000));
  if (timer.unref) timer.unref();
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}

function quietClose(close) {
  try {
    close();
  } catch (e) {
    /* closing a raced attempt is not an error */
  }
}

// Drive `source()` to completion, retrying transport failures. `finish` is the
// last event a source yields; reaching it ends the turn. A source may raise
// LlmError itself for a provider-level failure — it is passed through untouched.
//
// `midStreamRetry` is the promise that the CALLER honors `discard`: with it on,
// an attempt that fails after delivering events is retried too, and the notice
// carries discard=true so the caller drops the dead attempt's output first.
async function* runStreaming(source, options) {
  const {
    maxRetries,
    retryableStatus = DEFAULT_RETRYABLE_STATUS,
    cancel = null,
    midStreamRetry = false,
    probe: initialProbe = null,
    stallS = STALL_PROBE_S,
    guardPollS = GUARD_POLL_S,
    pathPollS = PATH_POLL_S,
    pathWaitMaxS = PATH_WAIT_MAX_S,
    backoffBaseS = 1,
    backoffMaxS = MAX_REDIAL_BACKOFF_S,
  } = options;

  let probe = initialProbe;
  // A budget counted in ATTEMPTS is a budget in seconds, while the counterparty
  // is the client's own network: max_retries <= 0 means redial until Stop, and
  // the ladder holds at the cap.
  const unbounded = Math.trunc(Number(maxRetries) || 0) <= 0;
  const attempts = Math.max(1, Math.trunc(Number(maxRetries) || 0));
  const budget = unbounded ? 0 : attempts;
  let attemptNo = 0;

  while (unbounded || attemptNo < attempts) {
    let delivered = false;
    if (isCancelled(cancel)) throw cancelled("stop requested before the attempt started");
    let turn = null;
    let stopGuard = null;
    const watch = { last: nowMs(), probe, delivered: false, nudged: false, probing: false };
    let probedDead = false; // this attempt was issued against a "gone" verdict

    if (unbounded && probe && attemptNo > 0) {
      // Never re-issue a request down a path we can already see is gone: its
      // budget for response headers is the READ budget, so a redial into a dead
      // hop hands the run back to the very stall the watchdog exists to break.
      let waited = 0;
      while (!(await pathOk(probe))) {
        if (waited >= pathWaitMaxS) {
          // a witness is only worth waiting on while it is right; past this,
          // try anyway and let the attempt say whether the verdict was wrong
          probedDead = true;
          break;
        }
        if (await sleep(pathPollS * 1000, cancel)) {
          throw cancelled("stop requested while waiting for the endpoint to come back");
        }
        waited += pathPollS;
      }
    }

    try {
      turn = await source();
      if (cancel || watch.probe) {
        stopGuard = startWatchdog({
          cancel,
          close: () => turn.close(),
          watch,
          midStreamRetry,
          stallS,
          guardPollS,
        });
      }
      for await (const event of turn.events) {
        if (probedDead && !watch.delivered) {
          // the probe called this path gone and the path is delivering anyway:
          // the witness has been contradicted, drop it for the rest of the run
          probe = null;
          watch.probe = null;
        }
        watch.last = nowMs();
        if (event.type === "finish") {
          if (watch.nudged) throw pathGone(); // the close, not an answer
          yield event;
          return;
        }
        watch.delivered = true;
        delivered = true;
        yield event;
      }
      // a source that ends without a finish is a bug, not a retryable state
      throw new LlmError({ code: "unknown", retryable: false, message: "stream ended without a finish event" });
    } catch (e) {
      // a Stop that landed mid-read must read as cancellation, never as a
      // retryable transport error
      if (isCancelled(cancel)) throw cancelled("stop requested mid-stream");
      let lastErr = e instanceof LlmError ? e : classify(e, retryableStatus);
      if (watch.nudged && !(e instanceof LlmError)) {
        // the close's own error is noise on the way to the known truth
        lastErr = pathGone();
      }
      const rerunnable = !delivered || midStreamRetry;
      const exhausted = !unbounded && attemptNo === attempts - 1;
      if (!lastErr.retryable || !rerunnable || exhausted) {
        if (lastErr.retryable && exhausted) {
          lastErr.message = `${lastErr.message} (after ${attempts} attempts)`;
        }
        throw lastErr;
      }
      // announce before the backoff so the caller/UI shows the recovery
      yield {
        type: "retry",
        attempt: attemptNo + 1,
        max: budget,
        code: lastErr.code,
        discard: delivered,
        message: `${lastErr.message} — retrying (${attemptNo + 1}/${budget || "…"})`,
      };
      const delay = Math.min(backoffMaxS, backoffBaseS * 2 ** attemptNo);
      if (await sleep(delay * 1000, cancel)) {
        throw cancelled("stop requested during retry backoff");
      }
    } finally {
      if (stopGuard) stopGuard();
      if (turn) turn.close();
    }
    attemptNo += 1;
  }
}

// ---- the client (factory.py) ----

function requireOption(name, value) {
  if (!value) throw new Error(`missing LLM argument: ${name}`);
}

function streamHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${apiKey}`,
  };
}

function normalizeBase(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

// One endpoint: the two wire protocols behind one contract. Options are the
// settings surface (base_url/model/api_key/reasoning_effort/api_protocol) plus
// the tunables Config owns in Python. `timings` and `proxy` are test/deployment
// seams, not user settings.
function createLlmClient(options = {}) {
  const {
    apiKey = "",
    baseUrl = "",
    model = "",
    protocol = null,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT_S,
    readTimeout = DEFAULT_READ_TIMEOUT_S,
    maxRetries = 0,
    retryableStatus = DEFAULT_RETRYABLE_STATUS,
    reasoningEffort = null,
    proxy = "auto",
    env = process.env,
    tlsOptions = {},
    timings = {},
  } = options;

  requireOption("api_key", apiKey);
  requireOption("base_url", baseUrl);
  requireOption("model", model);
  const wire = protocol || "chat";
  if (!API_PROTOCOLS.includes(wire)) {
    throw new Error(`unknown LLM protocol: ${wire} (expected one of ${API_PROTOCOLS.join(", ")})`);
  }

  const connectTimeout = Math.min(15, requestTimeout);
  const base = normalizeBase(baseUrl);

  function endpointAlive(timeoutS = ENDPOINT_PROBE_TIMEOUT_S) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      let target;
      try {
        target = new URL(`${base}/`);
      } catch (e) {
        finish(false);
        return;
      }
      // ANY HTTP response counts as alive — the question is whether the
      // transport reaches a peer at all, not what the peer thinks of the URL
      const close = openRequest(target, {
        method: "GET",
        proxy: resolveProxy(target.href, proxy, env),
        tlsOptions,
        connectTimeoutS: timeoutS,
        readTimeoutS: timeoutS,
        onResponse: (res) => {
          res.resume();
          finish(true);
          close();
        },
        onError: () => finish(false),
      });
    });
  }

  function sourceFor(messages, tools) {
    if (wire === "chat") {
      const body = { model, messages };
      if (tools && tools.length) body.tools = tools;
      if (reasoningEffort) {
        // extra_body in Python: merged into the top level, not nested under a key
        body.thinking = { type: "enabled", reasoning_effort: reasoningEffort };
      }
      body.stream = true;
      const target = `${base}/chat/completions`;
      return () => {
        const turn = openStream(target, {
          headers: streamHeaders(apiKey),
          body: JSON.stringify(body),
          proxy: resolveProxy(target, proxy, env),
          tlsOptions,
          connectTimeoutS: connectTimeout,
          readTimeoutS: readTimeout,
        });
        return { events: chatEvents(turn.frames), close: () => turn.close() };
      };
    }

    const { instructions, items } = toResponsesInput(messages);
    const body = { model, input: items, stream: true, store: false };
    if (instructions) body.instructions = instructions;
    if (tools && tools.length) body.tools = toResponsesTools(tools);
    if (reasoningEffort) {
      body.reasoning = { effort: REASONING_EFFORT[reasoningEffort] || reasoningEffort };
    }
    const target = `${base}/responses`;
    return () => {
      const turn = openStream(target, {
        headers: streamHeaders(apiKey),
        body: JSON.stringify(body),
        proxy: resolveProxy(target, proxy, env),
        tlsOptions,
        connectTimeoutS: connectTimeout,
        readTimeoutS: readTimeout,
      });
      return { events: responsesEvents(turn.frames), close: () => turn.close() };
    };
  }

  return {
    model,
    baseUrl,
    apiKey,
    protocol: wire,
    endpointAlive,

    // One streamed turn: reasoning / text / tool_call_start / tool_call_delta /
    // retry / finish, in that vocabulary, whichever wire protocol produced it.
    stream(messages, streamOptions = {}) {
      const cancel = streamOptions.cancel || null;
      const tools = streamOptions.tools || null;
      const source = sourceFor(messages, tools);
      return runStreaming(source, {
        maxRetries,
        retryableStatus,
        cancel,
        // our consumers honor discard (the loop and the compactor rebuild the
        // turn from their own accumulators), so a drop mid-answer costs a
        // reconnect instead of the whole run
        midStreamRetry: true,
        probe: () => endpointAlive(),
        ...timings,
      });
    },
  };
}

module.exports = {
  // the contract
  LlmError,
  classify,
  cleanProviderMessage,
  isContextOverflow,
  timeoutError,
  // proxy resolution
  getProxyForUrl,
  resolveProxy,
  // the two wire protocols
  createLlmClient,
  chatEvents,
  responsesEvents,
  toResponsesInput,
  toResponsesTools,
  // the retry policy for callers that build their own source
  runStreaming,
  // constants the settings/UI and the tests assert against
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
};
