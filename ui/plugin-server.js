// The client's half of the plugin channel: a loopback listener the far side's
// reverse forward dials, and the ONE door into this client's plugin domain.
//
// The target-side half is agent/tools/channel.py, and the two files are one
// contract read from opposite ends: `POST /call`, `Authorization: Bearer <token>`,
// body `{component, command, args}`, answer `{content, error?}` where `content` is
// the model-facing text. The `command` is the tool's statement exactly as THIS
// client declared it in its component.json — the session sends it back verbatim
// and this side renders it into argv (ui/plugin-host.js `renderArgv`), refusing a
// template it did not declare. Anything else the target's channel would refuse is
// refused HERE first, with a sentence the model can act on.
//
// Why a listener with a token at all: this window's machine holds the bytes, the
// keys and the egress, and the far side asks it to run things. Loopback is not a
// boundary — every process on this machine can dial 127.0.0.1 — so the token the
// push carries is what makes "a request from the session I pushed to" a claim
// rather than an assumption. The listener is its own port and process-level
// object: it is NEVER the supervisor's /api/components port (which installs
// code) and never the model proxy's (which carries an API key).
//
// What this file is not: a privilege fence. A plugin runs as this app, with its
// uid, its files and its environment (ui/plugin-child.js says so plainly). What
// the fork buys is containment in TIME — killable, non-blocking — and what the
// token buys is that only the session we told may ask.

"use strict";

const crypto = require("crypto");
const http = require("http");

const { createPluginHost, CALL_TIMEOUT_MS } = require("./plugin-host");

// The one path the target's channel calls (agent/tools/channel.py CALL_PATH).
const CALL_PATH = "/call";

// A call's arguments are model-produced: a path, a query, a URL. Anything
// approaching a megabyte is not a call, and the target refuses to send it.
const MAX_CALL_BYTES = 1 << 20;

// How many calls may be running at once. Each one is a forked process, so this
// is the bound on what one session can make this machine do at a time. A far
// side that is looping gets a sentence, not a fork bomb.
const MAX_CONCURRENT = 4;

// A token shorter than this is not a secret, it is a spelling. The generator
// below is what production uses; the constant exists so a caller-supplied token
// (a test, an operator) cannot be `"x"`.
const MIN_TOKEN = 16;

// 24 bytes of randomness, hex: 48 characters, no separators (the target refuses
// spaces and control characters in a token, and a header value must not carry
// them anyway).
function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Same length AND same bytes, in constant time. `timingSafeEqual` throws on a
// length mismatch, which is itself the answer: a wrong-length token is a wrong
// token, and the length of the real one is not a secret worth protecting from
// arithmetic that takes the same time either way.
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerOf(header) {
  const text = String(header || "");
  const match = /^Bearer\s+(\S+)$/i.exec(text.trim());
  return match ? match[1] : "";
}

// What this client DECLARES to a session, from what it actually holds: one entry
// per installed, enabled plugin, projected onto the words the session's parser
// knows. The projection is a whitelist on purpose — `entry` names a file on THIS
// machine, `digest` and `location` describe bytes the session will never see, and
// `launch` would be an implementation the session must never try to start. What
// travels is what the session needs to offer the tools and nothing more.
function declarations(host) {
  const out = [];
  const seen = new Set();
  let records;
  try {
    records = host.list();
  } catch (e) {
    return out; // an unreadable table is "no plugins to declare", not a crash
  }
  for (const record of records) {
    if (!record || record.disabled || seen.has(record.name)) continue;
    let target;
    try {
      target = host.resolve(record.name);
    } catch (e) {
      continue; // a bad name in the table is a row this client cannot run
    }
    if (!target) continue;
    seen.add(record.name);
    const declaration = target.declaration || {};
    const tools = (Array.isArray(declaration.tools) ? declaration.tools : [])
      .map(toolOf)
      .filter(Boolean);
    if (!tools.length) continue; // a plugin that publishes no tool has nothing to offer a session
    const out_one = {
      name: record.name,
      version: String(record.version || declaration.version || ""),
      interface: "plugin",
      runs_on: "other",
      tools,
    };
    if (typeof declaration.subject === "string" && declaration.subject) out_one.subject = declaration.subject;
    if (declaration.requires) out_one.requires = declaration.requires;
    if (declaration.ui && typeof declaration.ui === "object") out_one.ui = declaration.ui;
    if (typeof declaration.prompt === "string" && declaration.prompt) out_one.prompt = declaration.prompt;
    out.push(out_one);
  }
  return out;
}

// One tool, projected: everything the session's declaration parser reads about a
// tool (name, description, parameters, policy words) plus the STATEMENT it runs —
// the `command` template, which is what the session sends back on a call and what
// makes the wire contract checkable on this side. `defaults`, not being something
// the client renders, is still dropped.
const TOOL_POLICY = ["access", "access_arg", "snapshot_arg", "modes", "gate", "preview"];

function toolOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "");
  if (!name) return null;
  const tool = { name };
  if (typeof raw.command === "string" && raw.command) tool.command = raw.command;
  if (typeof raw.description === "string") tool.description = raw.description;
  if (raw.parameters && typeof raw.parameters === "object") tool.parameters = raw.parameters;
  for (const word of TOOL_POLICY) {
    if (raw[word] !== undefined && raw[word] !== null && raw[word] !== "") tool[word] = raw[word];
  }
  return tool;
}

function createPluginServer(options = {}) {
  const log = options.log || (() => {});
  const host = options.host || createPluginHost({ root: options.root, log });
  const token = String(options.token || newToken());
  if (token.length < MIN_TOKEN) {
    throw new Error(`a plugin channel token must be at least ${MIN_TOKEN} characters`);
  }
  if (/\s/.test(token)) throw new Error("a plugin channel token may not contain whitespace");
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CALL_TIMEOUT_MS;
  const maxConcurrent = Number.isFinite(options.maxConcurrent) ? options.maxConcurrent : MAX_CONCURRENT;

  let server = null;
  let bound = null;
  let running = 0;
  let stopped = false;

  function answer(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      // No browser is the caller and no page should be able to read an answer:
      // the only client is the target's channel, over the forward.
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  // One request's whole life, after the token has been checked. Every refusal is
  // a sentence with a status, because the target turns a non-2xx into
  // "the client refused the call to …: <its sentence>" and a 2xx+error into the
  // model's own error envelope — two different things, and the difference has to
  // be a decision made HERE, not guessed there.
  function dispatch(req, res) {
    const url = String(req.url || "").split("?")[0];
    if (req.method !== "POST" || url !== CALL_PATH) {
      answer(res, 404, { error: `nothing here (the plugin channel serves POST ${CALL_PATH})` });
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_CALL_BYTES) {
      answer(res, 413, { error: `the call body is larger than ${MAX_CALL_BYTES} bytes` });
      return;
    }
    const chunks = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      total += chunk.length;
      if (total > MAX_CALL_BYTES) {
        over = true;
        chunks.length = 0;
        // The answer is written first and the socket is torn down after it is
        // out: an unbounded body must not be read to its end to learn it is too
        // big, and a half-read body must not look like a complete call.
        res.end(JSON.stringify({ error: `the call body is larger than ${MAX_CALL_BYTES} bytes` }), () => {
          try {
            req.destroy();
          } catch (e) {
            /* already gone */
          }
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      /* the caller hung up: nothing to answer */
    });
    req.on("end", () => {
      if (over) return;
      let call;
      try {
        call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (e) {
        answer(res, 400, { error: "the call was not JSON" });
        return;
      }
      const name = call && typeof call === "object" ? String(call.component || "") : "";
      const command = call && typeof call === "object" ? String(call.command || "") : "";
      if (!name || !command) {
        answer(res, 400, { error: "a call names a component and a statement" });
        return;
      }
      const args = call.args && typeof call.args === "object" ? call.args : {};
      if (running >= maxConcurrent) {
        answer(res, 429, {
          error:
            `this client is already running ${running} plugin calls ` +
            `(each one is a forked process); try again when one finishes`,
        });
        return;
      }
      running += 1;
      const started = Date.now();
      const where = `${name} (${command})`;
      host.call({ name, command, args, timeoutMs }).then(
        (envelope) => {
          running -= 1;
          answer(res, 200, { content: String(envelope.content), error: !!envelope.error });
          log(`[plugin] ${where} answered in ${Date.now() - started}ms`);
        },
        (e) => {
          running -= 1;
          // The host's refusals (not installed, stopped, no such statement) and a
          // plugin that threw are the SAME thing to the model: this call did not
          // produce an answer, and the sentence says why. A 2xx with `error:true`
          // keeps the sentence intact; a 4xx/5xx would have the target prefix it
          // with "the client refused the call", which is false — it ran and
          // failed.
          answer(res, 200, { content: String((e && e.message) || e || "the plugin failed"), error: true });
          log(`[plugin] ${where} failed in ${Date.now() - started}ms: ${String((e && e.message) || e)}`);
        }
      );
    });
  }

  function handle(req, res) {
    if (!tokenMatches(bearerOf(req.headers["authorization"]), token)) {
      // The token is never echoed, and neither is what the caller sent: a wrong
      // token must not be a way to measure the right one.
      answer(res, 401, { error: "bad or missing token for this client's plugin channel" });
      return;
    }
    dispatch(req, res);
  }

  function listen(port = 0) {
    if (server) return Promise.resolve(bound);
    server = http.createServer(handle);
    // A request that is never answered must not keep the process' event loop (or
    // a caller) waiting past the deadline the host already enforces.
    server.headersTimeout = Math.max(timeoutMs + 5000, 10000);
    server.requestTimeout = Math.max(timeoutMs + 5000, 10000);
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        bound = server.address().port;
        stopped = false;
        log(`[plugin] listening 127.0.0.1:${bound}`);
        resolve(bound);
      });
    });
  }

  function stop() {
    const srv = server;
    server = null;
    bound = null;
    stopped = true;
    if (!srv) return Promise.resolve();
    return new Promise((resolve) => {
      srv.close(() => resolve());
      // Connections that are idle or mid-call are not waited for: a Stop is the
      // whole of it (the same rule the forked child's kill follows).
      if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
      setTimeout(resolve, 1000).unref();
    });
  }

  return {
    host,
    token,
    declarations: () => declarations(host),
    listen,
    stop,
    port: () => bound,
    running: () => running,
    stopped: () => stopped,
  };
}

module.exports = {
  CALL_PATH,
  MAX_CALL_BYTES,
  MAX_CONCURRENT,
  MIN_TOKEN,
  newToken,
  tokenMatches,
  declarations,
  createPluginServer,
};
