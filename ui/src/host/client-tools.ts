// Client-native tools: sleep, start_tick, end_tick — the loop's own clocks.
//
// These three are not work, they are WAITING, and where they wait is the whole
// question. The loop lives in this half (ui/src/host/run.ts) and so does the
// project log's writer (ui/log-client.js), so the client is the only place that
// can suspend a step without a round trip and append a tick line without asking
// permission: nothing an execution layer could decide is involved (they write no
// file, run no command, and have no path argument for a policy to judge). So the
// loop answers them itself — run-host.js dispatches by name (NAMES below) before
// the tool client sees the call — and a call for one of these names that reaches
// the exec endpoint anyway is refused there by name
// (agent/tools/registry.py:ToolRegistry._invoke) instead of running.
//
//   sleep(N)        suspend the loop for N seconds; Stop ends it early
//   start_tick(N)   append a user message every N seconds, and ask for the turn
//                   to be driven — never interrupting a step already in flight
//   end_tick()      stop the ticker
//
// The ticker is a FACTORY, not a module: one per run. A module-level interval
// would let one window's end_tick stop another window's clock, and would keep
// ticking after the run that started it was torn down. What the tick does NOT
// do is own the turn's lease or the busy markers — that is run-session.ts, and
// the `wake` port is how this file asks it to drive (it answers "nothing to do"
// when a step is already running).

"use strict";

type ToolResult = { content: string; isError: boolean; diff: string };

/**
 * What a client-native tool is given:
 *
 *   log.append   write the durable user_message a tick is (the same append the
 *                loop writes its own events with — one writer, one log)
 *   wake()       "drive the turn if nothing else is" (run-session.ts). Absent in
 *                a host with no session around it (a test, the phone's early
 *                boot): the tick then only appends, which is still the whole
 *                durable fact.
 *   warn(msg)    one line for a timer that could not append. Never thrown: a
 *                clock that cannot write must not kill the loop it wakes.
 */
type ClientToolContext = {
  log: { append: (event: any) => Promise<any> };
  wake?: () => void;
  warn?: (message: string) => void;
};

const NAMES = ["sleep", "start_tick", "end_tick"];
// The longest a single tool call may suspend or tick, in seconds: one hour is
// longer than any wait the loop has a reason to sit through, and a model that
// asks for more is asking for a clock it cannot use (Stop is the way out of a
// wait, and a tick this long would never fire inside a session).
const MAX_SECONDS = 3600;

function ok(content: string): ToolResult {
  return { content, isError: false, diff: "" };
}

function fail(content: string): ToolResult {
  return { content, isError: true, diff: "" };
}

/**
 * A timer that Stop can end. Answers true when it ran its full length and false
 * when the signal aborted it first — the caller says which in the tool result,
 * because "you stopped me" and "I waited a minute" are different answers.
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<boolean>}
 */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => done(true), ms);
    function done(full: boolean) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(full);
    }
    function onAbort() {
      done(false);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The three tools, wired to one run's log and one run's wake.
 * @param {ClientToolContext} context
 */
function createClientTools(context: ClientToolContext) {
  const ctx = context || ({} as ClientToolContext);
  // The ticker's state, and this factory's whole memory: one interval per run,
  // replaced by a second start_tick and cleared by end_tick.
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  function stopTick(): boolean {
    if (tickTimer === null) return false;
    clearInterval(tickTimer);
    tickTimer = null;
    return true;
  }

  /**
   * One tick: the durable line first (it is what the loop's next derive reads),
   * then the ask. A tick that cannot append says so once and keeps the clock
   * running — a transient log failure must not silently end the heartbeat.
   */
  async function beat(seconds: number): Promise<void> {
    if (!ctx.log || typeof ctx.log.append !== "function") return;
    try {
      await ctx.log.append({
        type: "user_message",
        content: `[tick: every ${seconds}s, at ${new Date().toISOString()}]`,
      });
    } catch (e) {
      if (typeof ctx.warn === "function") {
        ctx.warn(`tick: could not append to the log (${(e && (e as Error).message) || e})`);
      }
      return;
    }
    // The message is on disk whether or not anything is driving: `wake` is the
    // request to continue, and the session decides (a step in flight already has
    // its next derive coming; an idle turn is started by the line above).
    if (typeof ctx.wake !== "function") return;
    try {
      ctx.wake();
    } catch (e) {
      if (typeof ctx.warn === "function") {
        ctx.warn(`tick: could not drive the turn (${(e && (e as Error).message) || e})`);
      }
    }
  }

  /**
   * sleep(seconds): suspend the loop for N seconds. Stop (the step's own abort
   * signal) ends it early, so the turn closes as aborted instead of the user
   * waiting out an hour-long timer they cancelled.
   */
  async function sleep(args: any, signal?: AbortSignal): Promise<ToolResult> {
    const seconds = Number(args && args.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return fail(
        `sleep: seconds must be a positive number, got ${JSON.stringify(args && args.seconds)} — ` +
          "use start_tick for a periodic wakeup"
      );
    }
    if (seconds > MAX_SECONDS) {
      return fail(`sleep: max duration is ${MAX_SECONDS} seconds (1 hour)`);
    }
    const full = await wait(seconds * 1000, signal);
    if (!full) return fail(`sleep interrupted after ${seconds}s: the user stopped this run`);
    return ok(`slept for ${seconds}s`);
  }

  /** start_tick(seconds): a user message every N seconds, until end_tick. */
  function startTick(args: any): ToolResult {
    const seconds = Number(args && args.seconds);
    if (!Number.isFinite(seconds) || seconds < 1) {
      return fail(`start_tick: seconds must be at least 1, got ${JSON.stringify(args && args.seconds)}`);
    }
    if (seconds > MAX_SECONDS) {
      return fail(`start_tick: max interval is ${MAX_SECONDS} seconds (1 hour)`);
    }
    if (!ctx.log || typeof ctx.log.append !== "function") {
      return fail("start_tick: this host has no log to write the tick to");
    }
    // One clock per run: a second start_tick is a NEW interval, not a second
    // heartbeat (two would interleave in the log with no way to tell them apart).
    stopTick();
    const timer = setInterval(() => {
      void beat(seconds);
    }, seconds * 1000);
    // a heartbeat is not a reason for the host process to stay alive (the run
    // lease's own timer says the same, and for the same reason)
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    tickTimer = timer;
    return ok(`ticker started: a user message every ${seconds}s`);
  }

  /** end_tick(): stop the ticker. Nothing to stop is an answer, not an error. */
  function endTick(): ToolResult {
    if (!stopTick()) return ok("end_tick: no ticker was running");
    return ok("ticker stopped");
  }

  return {
    names: () => NAMES.slice(),

    /** @param {string} name */
    has(name: string): boolean {
      return NAMES.includes(name);
    },

    /**
     * Run one client-native tool call.
     * @param {string} name
     * @param {any} args the model's parsed arguments
     * @param {AbortSignal} [signal] Stop, for the one tool that waits
     * @returns {Promise<ToolResult>}
     */
    async run(name: string, args: any, signal?: AbortSignal): Promise<ToolResult> {
      if (name === "sleep") return sleep(args, signal);
      if (name === "start_tick") return startTick(args);
      if (name === "end_tick") return endTick();
      return fail(`unknown client-native tool: ${name}`);
    },

    /** Stop the ticker without a call: the run that owns it is going away. */
    dispose(): void {
      stopTick();
    },
  };
}

module.exports = { createClientTools, NAMES, MAX_SECONDS };
