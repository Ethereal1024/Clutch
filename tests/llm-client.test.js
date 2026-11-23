// ui/llm-client.js is the host's model client: one streaming turn, the retry
// ladder around it, and the errors the loop acts on. Every check here talks to a
// real HTTP server over a real socket — SSE chunks, a mid-stream reset, a body
// that goes quiet — because those are the failures the client exists to tell
// apart. The probe and the retry policy are driven directly where a network
// cannot be half-killed on purpose.
// Run: node tests/llm-client.test.js
const http = require("http");
const https = require("https");
const { check, summary } = require("./harness.js");
const {
  createLlmClient,
  LlmError,
  backoffMs,
  probeAlive,
  transportError,
  READ_TIMEOUT_MS,
  STALL_PROBE_MS,
  MAX_BACKOFF_MS,
} = require("../ui/llm-client.js");
const { installSystemTrust } = require("../ui/system-ca.js");

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

// A real HTTPS peer presenting a certificate nobody trusts, because that is the
// failure the classification has to reach: the handshake dies before a response
// exists, so nothing but the socket's own error can carry the verdict. Node
// cannot mint a certificate, so openssl does — and a machine without it skips
// this case (the mapping itself is pinned without a socket, below).
function selfSignedHttps() {
  const fs = require("fs");
  const os = require("os");
  const nodePath = require("path");
  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "clutch-selfsigned-"));
  const keyPath = nodePath.join(dir, "key.pem");
  const certPath = nodePath.join(dir, "cert.pem");
  const mint = (extra) => {
    try {
      execFileSync(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certPath, "-subj", "/CN=127.0.0.1", ...extra],
        { stdio: "ignore" }
      );
      return true;
    } catch (e) {
      return false;
    }
  };
  // the SAN matters: a chain error is what we want, and a hostname mismatch
  // would answer first on a certificate that names no IP (openssl < 1.1.1 has
  // no -addext, so the bare form is the fallback)
  if (!mint(["-addext", "subjectAltName=IP:127.0.0.1"]) && !mint([])) return null;
  let server;
  try {
    server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    });
  } catch (e) {
    return null;
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        base: `https://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            if (server.closeAllConnections) server.closeAllConnections();
            server.close(() => done());
          }),
      })
    );
  });
}

// A real HTTPS peer whose leaf is signed by a CA this machine does NOT have —
// the stand-in for "the root is only in the OS store". The CA comes back with
// the server so a test can install it exactly the way system-ca.ts installs the
// machine's store, and the same peer then answers as a REFUSED handshake when
// nothing installed it: the two ends of the reported failure in one server.
function mintedCaHttps() {
  const fs = require("fs");
  const os = require("os");
  const nodePath = require("path");
  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "clutch-minted-ca-"));
  const at = (name) => nodePath.join(dir, name);
  const run = (args) => {
    try {
      execFileSync("openssl", args, { stdio: "ignore" });
      return true;
    } catch (e) {
      return false;
    }
  };
  const minted =
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=clutch-test-ca", "-keyout", at("ca.key"), "-out", at("ca.pem")]) &&
    run(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", at("leaf.key"), "-out", at("leaf.csr")]);
  if (!minted) return null;
  fs.writeFileSync(at("ext"), "subjectAltName=IP:127.0.0.1\n");
  const signed = run(["x509", "-req", "-in", at("leaf.csr"), "-CA", at("ca.pem"), "-CAkey", at("ca.key"), "-CAcreateserial", "-days", "1", "-extfile", at("ext"), "-out", at("leaf.pem")]);
  if (!signed) return null;
  let server;
  try {
    server = https.createServer({ key: fs.readFileSync(at("leaf.key")), cert: fs.readFileSync(at("leaf.pem")) }, (req, res) => {
      head(res);
      chunk(res, say("trusted answer"));
      // a finish_reason is what ends the turn: without it the body looks like a
      // stream that died mid-answer, which the client (correctly) retries
      chunk(res, stop("stop"));
      end(res);
    });
  } catch (e) {
    return null;
  }
  const caPem = fs.readFileSync(at("ca.pem"), "utf8");
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        base: `https://127.0.0.1:${server.address().port}`,
        caPem,
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

  // ---- 1b. a refused certificate is its own verdict, and it says what to do ----
  //
  // The reported dead end: "run failed: self signed certificate; if the root CA
  // is installed locally, try running Node.js with --use-system-ca". True, and
  // useless — a reader is left with neither the host that refused nor the reason
  // their browser is happy with the same URL. This app reaches the model itself
  // (Electron main / Node), whose trust list is Node's own and not the OS store,
  // so an HTTPS-inspecting proxy is trusted by the browser and refused here.
  {
    const untrusted = Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const verdict = transportError(untrusted, "https://api.example.test/v1/chat/completions");
    check(verdict instanceof LlmError && verdict.code === "tls", "an untrusted certificate is a TLS verdict, not an 'unknown' transport failure");
    check(verdict.retryable === false, "and it is final: a trust decision does not heal on a redial (D12's ladder is for a dead path)");
    check(/api\.example\.test/.test(verdict.message), "it names the host the handshake was for");
    check(/self signed certificate/.test(verdict.message), "and keeps the certificate's own reason");
    check(
      /NODE_EXTRA_CA_CERTS/.test(verdict.message) && /--use-system-ca/.test(verdict.message),
      "and the knob that fixes a proxy's root CA (the browser trusts the OS store, this app does not)"
    );

    const expired = transportError(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }), "https://api.example.test/v1");
    check(expired.code === "tls" && /clock/.test(expired.message), "an expired certificate points at the clock, not at the proxy");

    const wrongName = transportError(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "https://api.example.test/v1");
    check(wrongName.code === "tls" && /does not cover that name/.test(wrongName.message), "a hostname mismatch says the certificate does not cover the name");

    const refused = transportError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }), "https://api.example.test/v1");
    check(refused.code === "connection" && refused.retryable, "a refused connection is still the retryable transport error it always was");

    const peer = await selfSignedHttps();
    if (!peer) {
      console.log("skip: no openssl on this machine — the real-socket case is covered by the mapping above");
    } else {
      try {
        const client = createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k" });
        let err = null;
        try {
          await collect(client, {});
        } catch (e) {
          err = e;
        }
        check(err && err.code === "tls" && err.retryable === false, "a real self-signed handshake ends the turn as a TLS verdict, with no redial");
        check(err && new RegExp(peer.base.replace(/^https:\/\//, "").replace(/[.:]/g, "\\$&")).test(err.message), "…naming the host the base_url pointed at");
      } finally {
        await peer.close();
      }
    }
  }

  // ---- 1c. a root the MACHINE trusts is trusted; a root in neither store is not ----
  //
  // The follow-up to 1b, and the same reported failure from the other end: the
  // fix is that the main process adopts the OS certificate store (system-ca.ts),
  // not that verification is relaxed. So the same peer is asked the same
  // question twice — once with its root installed the way the machine's store
  // is, once without — and a third time against the REAL store install, which
  // must still refuse a root that is in neither store. The last one is what
  // separates "trusts the machine's roots" from "trusts anything".
  {
    const peer = await mintedCaHttps();
    if (!peer) {
      console.log("skip: no openssl on this machine — system-ca.test.js covers the tiers without a socket");
    } else {
      const turn = async () => {
        try {
          const events = await collect(createLlmClient({ baseUrl: peer.base, model: "m", apiKey: "k" }), {});
          return { events, err: null };
        } catch (e) {
          return { events: null, err: e };
        }
      };
      try {
        // the stand-in for the OS store: this runtime has no global install (no
        // setDefaultCACertificates), so the merged list rides on the request —
        // exactly the tier-2 path, through the client's real request site
        const runtime = { getCACertificates: (kind) => (kind === "system" ? [peer.caPem] : []) };
        check(installSystemTrust({ tlsModule: runtime }).tier === "request", "a runtime without the global API installs per request");
        {
          const { events, err } = await turn();
          check(!err && events.some((e) => e.content === "trusted answer"), "a certificate rooted in the machine's store is trusted, and the turn completes");
        }
        // nothing installed: the same peer, the same client, the handshake dies
        installSystemTrust({ tlsModule: { getCACertificates: () => [] } });
        {
          const { err } = await turn();
          check(err && err.code === "tls" && err.retryable === false, "with no store adopted the same peer is refused, as a TLS verdict");
        }
        // and the real runtime: adopting the OS store does not trust a throwaway
        // root that no store on this machine has
        installSystemTrust();
        {
          const { err } = await turn();
          check(err && err.code === "tls", "adopting the OS store trusts the machine's roots, not any root");
        }
      } finally {
        await peer.close();
      }
    }
  }

  // ---- 2a. relay shapes: the answer is not always in `delta.content` ----
  //
  // The reported "pika" config kept producing empty replies: a non-streaming
  // relay (or one that repeats the message in its last chunk) puts the text in
  // `message.content`, and block-shaped content is a list, not a string. Both
  // used to reach the loop as an empty answer, which then retried forever.
  {
    const finalMessage = await serve(({ res }) => {
      head(res);
      chunk(res, { choices: [{ message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }] });
      end(res);
    });
    const blockContent = await serve(({ res }) => {
      head(res);
      chunk(res, say([{ type: "text", text: "a" }, { type: "text", text: "b" }]));
      chunk(res, stop("stop"));
      end(res);
    });
    const legacyText = await serve(({ res }) => {
      head(res);
      chunk(res, { choices: [{ text: "legacy completion", finish_reason: "stop" }] });
      end(res);
    });
    const both = await serve(({ res }) => {
      head(res);
      chunk(res, say("hello"));
      chunk(res, { choices: [{ message: { content: "hello FULL" }, finish_reason: "stop" }] });
      end(res);
    });
    try {
      const mk = (base) => createLlmClient({ baseUrl: base, model: "test-model", apiKey: "sk-test" });
      {
        const events = await collect(mk(finalMessage.base));
        const fin = events[events.length - 1];
        check(fin.content === "hello there", "a final chunk's `message.content` is the answer");
      }
      {
        const events = await collect(mk(blockContent.base));
        const fin = events[events.length - 1];
        check(fin.content === "ab", "block-shaped content is joined as text, never emptied");
      }
      {
        const events = await collect(mk(legacyText.base));
        const fin = events[events.length - 1];
        check(fin.content === "legacy completion", "a legacy `choice.text` answer is accepted");
      }
      {
        const events = await collect(mk(both.base));
        const fin = events[events.length - 1];
        check(fin.content === "hello", "when deltas streamed, the repeated message is not appended twice");
      }
    } finally {
      await finalMessage.close();
      await blockContent.close();
      await legacyText.close();
      await both.close();
    }
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

  // ---- 14. a chunk boundary inside a character does not corrupt the answer ----

  // TCP hands over whatever slices it likes, and a slice can end in the middle
  // of a UTF-8 sequence. Decoding each chunk on its own (`chunk.toString("utf8")`)
  // turned the split character into U+FFFD — the "�" glyphs a transcript showed
  // as "1 或 2 ���" and "仍在 2cm ��" — and because the answer is persisted as it
  // streams, the lost bytes were gone for good. A decoder has to carry the
  // incomplete tail into the next chunk.
  {
    const answer = "焦距仍能恢复到 0.04%~0.4%，落点 p95 ≤3cm ✓";
    const wire = Buffer.from(
      `data: ${JSON.stringify(say(answer))}\n\n` +
        `data: ${JSON.stringify(stop())}\n\n` +
        "data: [DONE]\n\n",
      "utf8"
    );
    // one byte into the answer's first character: an incomplete 3-byte sequence
    const at = wire.indexOf(Buffer.from(answer[0], "utf8")) + 1;
    const up = await serve(({ res }) => {
      head(res);
      res.write(wire.subarray(0, at));
      setTimeout(() => res.end(wire.subarray(at)), 40);
    });
    try {
      const events = await collect(createLlmClient({ baseUrl: up.base, model: "m", apiKey: "k" }));
      const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
      const finish = events[events.length - 1];
      check(text === answer, "a character split across two chunks arrives whole, with no replacement glyph");
      check(!/\ufffd/.test(text + ((finish && finish.content) || "")), "…and the finish that assembles it carries none either");
    } finally {
      await up.close();
    }
  }

  // the error body is read the same way: a provider's own words are what a
  // reader acts on, so a 401 written in Chinese must not arrive as diamonds
  {
    const message = "上游拒绝了这次请求：额度不足";
    const body = Buffer.from(JSON.stringify({ error: { message } }), "utf8");
    const at = body.indexOf(Buffer.from("拒", "utf8")) + 1;
    const up = await serve(({ res }) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.write(body.subarray(0, at));
      setTimeout(() => res.end(body.subarray(at)), 40);
    });
    try {
      const client = createLlmClient({ baseUrl: up.base, model: "m", apiKey: "k" });
      const err = await client.ask({ messages: MSGS }).then(() => null, (e) => e);
      check(err && err.code === "api_error", "a split error body is still an api_error");
      check(err && err.message.includes(message), "the provider's message survives a mid-character split");
      check(err && !/\ufffd/.test(err.message), "…with no replacement glyph in it");
    } finally {
      await up.close();
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
