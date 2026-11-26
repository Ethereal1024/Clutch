// ui/client-tools.js: the three tools the loop answers itself — sleep,
// start_tick, end_tick.
//
// They are the loop's clocks, and every fact they touch is this process's own:
// the timer that suspends a step, the interval that appends a line, and the
// `wake` that asks the session to continue. So the checks here drive the REAL
// factory over a fake log and a counting wake, and look at what it wrote, what
// it asked, and what it did when it was told to stop.
//
// The suite is time-based by nature (a tick is an interval), so the intervals
// are the smallest the tool allows and every margin is generous: a heartbeat
// that fires late is still a heartbeat, and a timer that was NOT replaced is
// the one failure the margins are chosen to expose.
// Run: node tests/client-tools.test.js
const { check, summary } = require("./harness.js");
const { createClientTools, NAMES, MAX_SECONDS } = require("../ui/client-tools.js");

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeLog() {
  const events = [];
  return {
    events,
    append: async (event) => {
      events.push(event);
      return { ...event, log_offset: events.length - 1 };
    },
  };
}

function wiring(extra = {}) {
  const log = fakeLog();
  let wakes = 0;
  const warns = [];
  const tools = createClientTools({
    log,
    wake: () => {
      wakes += 1;
    },
    warn: (m) => warns.push(m),
    ...extra,
  });
  return { tools, log, warns, wakes: () => wakes };
}

const TICK = /^\[tick: every (\d+)s, at \d{4}-\d{2}-\d{2}T/;

async function main() {
  // ------------------------------------------------------------ 1. the names
  {
    const { tools } = wiring();
    check(JSON.stringify(NAMES) === JSON.stringify(["sleep", "start_tick", "end_tick"]), "the client answers three tools, in order");
    check(
      JSON.stringify(tools.names()) === JSON.stringify(NAMES),
      "and a factory hands back exactly those names"
    );
    for (const name of NAMES) check(tools.has(name), `has("${name}") is true`);
    check(!tools.has("trigger"), "trigger is not one of them — the execution layer owns it");
    check(!tools.has("run_command"), "and neither is the host's command tool");
    const unknown = await tools.run("nope", {});
    check(unknown.isError && /unknown client-native tool/.test(unknown.content), "a name it does not answer is a failed call, not a throw");
    tools.dispose();
  }

  // --------------------------------------------------------- 2. sleep's guard
  {
    const { tools } = wiring();
    for (const bad of [0, -1, "abc", undefined, null, NaN]) {
      const r = await tools.run("sleep", { seconds: bad });
      const label = typeof bad === "number" ? String(bad) : JSON.stringify(bad);
      check(r.isError && /positive number/.test(r.content), `sleep(${label}) is rejected`);
      check(!r.diff, "and a rejection changes no file");
    }
    const big = await tools.run("sleep", { seconds: MAX_SECONDS + 1 });
    check(big.isError && big.content.includes(`${MAX_SECONDS}`), "sleep longer than an hour is rejected, and says the cap");
    check(MAX_SECONDS === 3600, "the cap is one hour");
    tools.dispose();
  }

  // ------------------------------------------------------- 3. sleep's actual
  {
    const { tools } = wiring();
    const started = Date.now();
    const r = await tools.run("sleep", { seconds: 0.05 });
    const waited = Date.now() - started;
    check(!r.isError && r.content === "slept for 0.05s", "a short sleep resolves and reports its length");
    check(waited >= 45, `and it really waited (${waited}ms)`);
    tools.dispose();
  }

  // --------------------------------------------------- 4. sleep under an abort
  {
    const { tools } = wiring();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const started = Date.now();
    const r = await tools.run("sleep", { seconds: 30 }, ctl.signal);
    const waited = Date.now() - started;
    check(r.isError, "an aborted sleep is a failed call, not a full one");
    check(/interrupted after 30s/.test(r.content) && /stopped this run/.test(r.content), "and it says the user stopped it");
    check(waited < 1000, `Stop does not wait out the timer (${waited}ms, not 30s)`);
    tools.dispose();
  }

  // ------------------------------------------------------ 5. start_tick / wake
  {
    const { tools, log, wakes } = wiring();
    const r = await tools.run("start_tick", { seconds: 1 });
    check(/ticker started/.test(r.content), "start_tick answers at once and says the interval it started");
    await nap(1400);
    tools.dispose();
    check(log.events.length >= 1, `the tick appended a user message (${log.events.length})`);
    const line = log.events[0] || {};
    check(line.type === "user_message", "of the durable type the fold reads");
    check(TICK.test(line.content || ""), `with the interval and when it fired: ${JSON.stringify(line.content)}`);
    check(((line.content || "").match(TICK) || [])[1] === "1", "the interval in the line is the one that was asked for");
    check(wakes() >= 1, "and the loop was asked to continue");
  }

  // -------------------------------------------------- 6. a second start_tick
  {
    const { tools, log } = wiring();
    await tools.run("start_tick", { seconds: 1 });
    await tools.run("start_tick", { seconds: 3 });
    // The 1s clock must be GONE: 1.4 seconds after a 3s interval began, one
    // that was never replaced would already have fired.
    await nap(1400);
    const early = log.events.length;
    tools.dispose();
    check(early === 0, `a second start_tick replaces the first, not doubles it (${early} lines)`);
  }

  // ------------------------------------------------------------ 7. validation
  {
    const { tools, log } = wiring();
    const zero = await tools.run("start_tick", { seconds: 0 });
    check(zero.isError && /at least 1/.test(zero.content), "a tick faster than a second is rejected");
    const big = await tools.run("start_tick", { seconds: MAX_SECONDS + 1 });
    check(big.isError && big.content.includes(`${MAX_SECONDS}`), "and one longer than an hour is rejected");
    check(log.events.length === 0, "neither wrote anything");
    tools.dispose();
  }

  // ---------------------------------------------------------------- 8. no log
  {
    const { createClientTools: make } = require("../ui/client-tools.js");
    const bare = make({});
    const r = await bare.run("start_tick", { seconds: 1 });
    check(r.isError && /no log/.test(r.content), "a host with no log refuses a ticker instead of ticking into nothing");
    const end = await bare.run("end_tick", {});
    check(!end.isError, "but end_tick with nothing running is still not an error");
    bare.dispose();
  }

  // -------------------------------------------------------------- 9. end_tick
  {
    const { tools, log } = wiring();
    const idle = await tools.run("end_tick", {});
    check(!idle.isError && /no ticker/.test(idle.content), "end_tick with no ticker running says so, without failing");
    await tools.run("start_tick", { seconds: 1 });
    const stopped = await tools.run("end_tick", {});
    check(!stopped.isError && /stopped/.test(stopped.content), "end_tick after start_tick stops it");
    await nap(1300);
    check(log.events.length === 0, "and nothing fires afterwards");
    const again = await tools.run("end_tick", {});
    check(!again.isError, "a second end_tick is harmless");
    tools.dispose();
  }

  // -------------------------------------------------------------- 10. dispose
  {
    const { tools, log } = wiring();
    await tools.run("start_tick", { seconds: 1 });
    tools.dispose(); // the run that owns the ticker is going away
    await nap(1300);
    check(log.events.length === 0, "dispose() silences the ticker without a call — the run it belonged to is gone");
  }

  summary("client-tools: the loop's own clocks (names / sleep / ticker / dispose)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
