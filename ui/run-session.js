// Composition root for one session's run loop (P3-2 wiring).
//
// The loop (ui/run-host.js) needs five ports: log, llm, tools, session, and
// contextWindowBytes. All five are now concrete: the log lives at the session's
// HTTP (ui/log-client.js), the model speaks one of two OpenAI wire protocols
// (ui/llm-client.js), the tools are read from the session's declarations
// (ui/tool-decl.js), and the session facts come from GET /api/session. This file
// is the ONE place that fetches those two endpoints and wires everything together.
//
//   createSessionRun({
//     base,            session base URL (http://127.0.0.1:<port>)
//     mode?,           "work" | "chat" — overrides the session's own mode when
//                      provided (for tests that do not start a real session)
//     onEvent?(event), forwarded to createRunHost as-is
//     warn?(msg),      forwarded to createRunHost and createTools as-is
//   }) -> Promise<{start, stop, step, drive, state}>
//
// Construction is async because it must fetch the two session endpoints before
// it can build the tools and LLM client. The returned object is createRunHost's
// own answer — there is one state machine and no second vocabulary.
//
// Desktop (ui/main.js) and Android (android/host/android-host.js) wire the
// same function to their respective `run:*` handlers. A test can drive it
// against a fake HTTP server that serves the two endpoints.
//
// LLM credentials come from ui/llm-proxy.js (getUpstream/getApiKey/
// readSettingsFile) — the same source the proxy itself reads, so a settings
// save is honored immediately on the next run.

"use strict";

const { createRunHost } = require("./run-host");
const { createLogClient } = require("./log-client");
const { createToolClient } = require("./tool-client");
const { createTools } = require("./tool-decl");
const { createLlmClient } = require("./llm-client");
const { getUpstream, getApiKey } = require("./llm-proxy");

// readSettingsFile is not a named export of llm-proxy.js but we need it for
// model / api_protocol / reasoning_effort. Require it from settings-mirror,
// which is the shared settings reader on both desktop and Android.
const { readSettings } = require("./settings-mirror");

// One JSON GET from the session — no body, plain fetch with a timeout.
const FETCH_TIMEOUT_MS = 30_000;

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let r;
  let text;
  try {
    r = await fetch(url, { signal: ctl.signal });
    text = await r.text();
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`GET ${url}: no answer within ${FETCH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`GET ${url}: response is not JSON (${r.status})`);
  }
  if (!r.ok) {
    const why = (parsed && parsed.error) || `${r.status} ${r.statusText}`;
    const err = new Error(`GET ${url} answered ${r.status}: ${why}`);
    err.status = r.status;
    throw err;
  }
  return parsed;
}

function sessionBase(base) {
  if (typeof base !== "string" || !base.trim()) {
    throw new TypeError("run-session: base is required (http://127.0.0.1:<port>)");
  }
  return base.replace(/\/+$/, "");
}

async function createSessionRun({ base, mode: modeOverride, onEvent, warn } = {}) {
  const root = sessionBase(base);

  // Fetch the two session endpoints in parallel — both are cheap GETs that
  // answer in milliseconds on loopback; nothing in the loop can proceed until
  // both arrive.
  const [declsData, sessionData] = await Promise.all([
    fetchJson(`${root}/api/declarations`),
    fetchJson(`${root}/api/session`),
  ]);

  // Validate the session response — these are the five keys the loop's ports
  // need; a missing one is a session that cannot be driven safely.
  if (!sessionData || typeof sessionData !== "object") {
    throw new TypeError("run-session: GET /api/session must answer an object");
  }
  const { mode, shell, components, contextWindowBytes, memory } = sessionData;
  if (typeof contextWindowBytes !== "number" || !Number.isFinite(contextWindowBytes) || contextWindowBytes <= 0) {
    throw new TypeError("run-session: GET /api/session must answer a positive contextWindowBytes");
  }

  // mode: caller override wins (allows chat sessions from the same endpoint),
  // otherwise trust the session.
  const resolvedMode = typeof modeOverride === "string" ? modeOverride : (typeof mode === "string" ? mode : "work");

  // Tool surface: the declarations data, the session mode, and the log's open
  // state (whether a project is open) all feed createTools. The session's own
  // `project` flag is encoded in the declarations response.
  const tools = createTools({
    declarations: Array.isArray(declsData.declarations) ? declsData.declarations : [],
    available:    declsData.available   && typeof declsData.available   === "object" ? declsData.available   : {},
    config:       declsData.config      && typeof declsData.config      === "object" ? declsData.config      : {},
    backends:     Array.isArray(declsData.backends) ? declsData.backends : [],
    facts:        declsData.facts       && typeof declsData.facts       === "object" ? declsData.facts       : {},
    host:         declsData.host        && typeof declsData.host        === "object" ? declsData.host        : {},
    project:      Boolean(declsData.project),
    mode:         resolvedMode,
    warn:         typeof warn === "function" ? warn : undefined,
  });

  // LLM client: credentials from the local settings file — the same source the
  // proxy reads — so a settings save is honored on the next run without restarting.
  const settings = readSettings();
  const llm = createLlmClient({
    baseUrl:         getUpstream(),
    apiKey:          getApiKey(),
    model:           settings.model || "",
    protocol:        settings.api_protocol || "chat",
    reasoningEffort: settings.reasoning_effort || undefined,
  });

  // Log and tool clients: one base URL, the mode from the resolved session.
  const logClient  = createLogClient({ base: root });
  const toolClient = createToolClient({ base: root, mode: resolvedMode });

  // createRunHost is synchronous; all async work is above.
  return createRunHost({
    log: logClient,
    llm,
    tools: {
      schemas:  () => tools.schemas(),
      ui:       (name) => tools.ui(name),
      pathArg:  (name) => tools.pathArg(name),
      run:      ({ call, signal }) => toolClient.run({ call, signal }),
    },
    session: {
      mode:       resolvedMode,
      components: typeof components === "string" ? components : "",
      shell:      typeof shell === "string" ? shell : "",
      memory:     memory || null,
    },
    contextWindowBytes,
    onEvent,
    warn: typeof warn === "function" ? warn : undefined,
  });
}

module.exports = { createSessionRun, FETCH_TIMEOUT_MS };
