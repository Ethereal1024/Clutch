// One tool call, run where the tools are: POST /api/exec from the host half (P3).
//
// The loop moved here (TODO.md D1) and the execution layer kept the only thing
// it can really decide — what happens when a call runs, and whether it may. So
// this file is the host's side of that one request, and it holds no policy at
// all: it sends the model's own call (`name`, the raw JSON `arguments`, the
// `tool_call_id` that identifies it on both sides) and folds the answer into the
// shape the loop's `runTool` port speaks:
//
//   POST /api/exec {name, arguments, tool_call_id, mode}
//     -> {tool_call_id, content, is_error, diff}   ->   {content, isError, diff}
//
// Everything a TOOL did comes back as a 200 with `is_error: true` — an unknown
// tool, unparsable arguments, a denied permission, a command that failed. Those
// are results the model has to read, so they are answered, not thrown. A THROW
// here therefore means the request itself could not be satisfied: no project
// open (409), a read-only project (409), the session went away. Turning one of
// those into a tool result would feed the model a sentence about a session that
// is not there.
//
// ONE 409 is not that: "a call with this tool_call_id is already in flight"
// (agent/api/exec.py). It says the session is running THIS call right now —
// under another wheel of the same turn, or under the request this window
// dropped when the tunnel healed and the page resumed. The work exists and its
// answer is coming; a throw here ended the turn and marked the tab idle while
// the command kept running with nobody to read it, which is the "could not
// resume the turn" the reader saw. So the client waits and asks again: the
// answer is memoized under (tool_call_id, name, arguments) in the same lock
// that drops the in-flight entry, so the repeat sees either "in flight" or the
// answer itself — never a second run of the tool.
//
// Stop reaches a command that is still running: aborting the request's signal
// sends `POST /api/exec/cancel {tool_call_id}` BEFORE dropping the connection,
// because a client that walks away from a socket cannot kill a process group by
// leaving (a tool that runs a command polls that id; agent/tools/transport.py).
// The exec request itself has no timeout: it can be blocked on a permission
// prompt, and a prompt is answered by a person, not by a clock.
//
// The session is 127.0.0.1 on both sides of the SSH tunnel, so this keeps the
// plain global fetch (ui/net-fetch.js says so).

"use strict";

const CANCEL_TIMEOUT_MS = 10_000; // one tiny JSON call to the same machine
const IN_FLIGHT_POLL_MS = 2_000; // how often to ask again while a call is still running
const MODES = ["chat", "work"];

/**
 * The session's base URL, normalized. `unknown` in, `string` out: this IS the
 * validator (it throws on a non-URL), so callers' option bags can type `base`
 * as optional without a cast at every call site.
 * @param {unknown} base
 * @returns {string}
 */
function sessionBase(base) {
  if (typeof base !== "string" || !base.trim()) {
    throw new TypeError("tool-client: base is required (http://127.0.0.1:<port>)");
  }
  return base.replace(/\/+$/, "");
}

/**
 * @param {string} url
 * @param {{ method: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal }} opts
 * @returns {Promise<any>} the parsed answer (each port below checks its own shape)
 */
async function call(
  url,
  { method, body, timeoutMs, signal }: { method: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal },
) {
  const ctl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  // the caller's Stop and our own timeout are one signal to fetch, and the
  // caller's reason for aborting must survive (a Stop is not a timeout)
  const onAbort = () => ctl.abort(signal && signal.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let r;
  let text;
  try {
    r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    text = await r.text();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (e) {
    /* a non-JSON answer is reported as the status below */
  }
  if (!r.ok) {
    const why = (parsed && parsed.error) || `${r.status} ${r.statusText}`;
    /** @type {Error & { status?: number, code?: string }} */
    const err: Error & { status?: number; code?: string } = new Error(`${method} ${url} answered ${r.status}: ${why}`);
    err.status = r.status;
    if (parsed && parsed.code) err.code = parsed.code;
    throw err;
  }
  return parsed;
}

/**
 * Whether this refusal means "the call you are asking about is still running",
 * which is the one 409 worth waiting on: the session keeps `tool_call_id` in
 * `exec_cancels` for exactly as long as a call with it is on the wire.
 */
function alreadyInFlight(e: any) {
  return Boolean(e && e.status === 409 && /already in flight/.test(String(e.message || "")));
}

/**
 * Wait before asking again — and give the wait up the moment the caller's Stop
 * arrives. A pause that ignored the abort would leave the turn open on a call
 * nobody is reading, which is the bug this file is fixing.
 */
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject((signal && signal.reason) || new Error("aborted"));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }
  });
}

/**
 * @param {{ base?: string, mode?: string, cancelTimeoutMs?: number, inFlightPollMs?: number }} [opts]
 */
function createToolClient({
  base,
  mode,
  cancelTimeoutMs = CANCEL_TIMEOUT_MS,
  inFlightPollMs = IN_FLIGHT_POLL_MS,
}: { base?: string; mode?: string; cancelTimeoutMs?: number; inFlightPollMs?: number } = {}) {
  const root = sessionBase(base);
  if (mode !== undefined && !MODES.includes(mode)) {
    throw new TypeError(`tool-client: mode is ${MODES.join(" or ")}`);
  }

  // The one call whose answer nobody waits for: Stop has already dropped the
  // request, and the point of this is the machine's effect, not its reply.
  async function cancel(tool_call_id) {
    if (typeof tool_call_id !== "string" || !tool_call_id) {
      throw new TypeError("tool-client: cancel needs a tool_call_id");
    }
    return call(`${root}/api/exec/cancel`, {
      method: "POST",
      body: { tool_call_id },
      timeoutMs: cancelTimeoutMs,
    });
  }

  return {
    cancel,

    /**
     * @param {{ call?: any, signal?: AbortSignal }} [opts]
     * @returns {Promise<{ content: string, isError: boolean, diff: string }>}
     */
    async run({ call: one, signal }: { call?: any; signal?: AbortSignal } = {}) {
      if (!one || typeof one !== "object") throw new TypeError("tool-client: run needs the call");
      const id = one.id;
      const name = one.name;
      if (typeof id !== "string" || !id) throw new TypeError("tool-client: the call has no id");
      if (typeof name !== "string" || !name) throw new TypeError("tool-client: the call has no tool name");
      if (typeof one.arguments !== "string") {
        // the raw JSON text is what the execution layer's policy reads; a
        // pre-parsed tree here would be a second shape for the same fact
        throw new TypeError("tool-client: the call's arguments must be the model's raw JSON string");
      }

      const onAbort = () => {
        // send the interrupt on its own connection; the request we are about to
        // drop is the one whose command this has to reach
        cancel(id).catch(() => {
          /* the call may already have answered: nothing is in flight, nothing to do */
        });
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      let answer;
      try {
        // A call the session says is ALREADY in flight is not a refusal to fix
        // the turn over: it is this same call, running, with its answer coming.
        // Waiting is what keeps the turn honest — the tab stays running, the
        // command stays watched, and when it ends the memo hands the real
        // result to this repeat instead of the tool running twice.
        for (;;) {
          try {
            answer = await call(`${root}/api/exec`, {
              method: "POST",
              body: { name, arguments: one.arguments, tool_call_id: id, mode },
            });
            break;
          } catch (e) {
            if (!alreadyInFlight(e)) throw e;
            await pause(inFlightPollMs, signal);
          }
        }
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      if (answer.tool_call_id !== id) {
        // two calls in flight, or an answer to somebody else's question: the
        // loop would write it against this call, so it is a bug worth stopping on
        throw new Error(`tool-client: /api/exec answered tool_call_id ${JSON.stringify(answer.tool_call_id)} for ${JSON.stringify(id)}`);
      }
      if (typeof answer.content !== "string") {
        // an answer without its content is not a tool result: defaulting it to
        // "" would hand the model an empty observation it cannot tell from a
        // tool that said nothing
        throw new TypeError("tool-client: /api/exec must answer {tool_call_id, content, is_error, diff}");
      }
      return {
        content: answer.content,
        isError: Boolean(answer.is_error),
        diff: typeof answer.diff === "string" ? answer.diff : "",
      };
    },
  };
}

module.exports = { createToolClient, CANCEL_TIMEOUT_MS };
