"use strict";

// The execution-endpoint table (ui/executors.ts): the ONE place that answers
// "where does this session's work happen?".
//
// Before this table the answer was a `kind: "local" | "tunnel"` pair with two
// branches behind it, and "the tunnel" was the process-wide singleton — a second
// device could not be described at all. Now this machine is one row among the
// hops, with a durable id and what can be asked of it right now, and nothing above
// the table branches on WHICH kind it is. This runner is about the table's own
// promises, so host-core can keep making claims over it:
//
//   * an id is held and compared, never parsed — and this module never BUILDS one
//     itself: a machine trio becomes an id only through tunnel-core's tunnelId;
//   * capabilities are "what is true NOW" (a hop that is up but between forwards
//     takes commands and runs no session — the SSH-tools degradation);
//   * the far side starts its own supervisor, so ready() is not this client's to
//     perform, and restart() is a request to that machine;
//   * a host with no local mode (the phone, N4) is an endpoint with no supervisor
//     capability — not a missing row.
//
// Run: node tests/executors-test.js

const { check, summary } = require("./harness.js");
const { createExecutors, LOCAL_ID, isLocal } = require("../ui/executors");
const { tunnelId } = require("../ui/tunnel-core");

const LOCAL_BASE = "http://127.0.0.1:8890";
const FAR = { host: "far.example", user: "me", port: 22 };
const FAR_ID = "me@far.example:22"; // user@host:port, as tunnel-core spells it
const FAR_BASE = "http://127.0.0.1:8891";

// a hop module holding ONE hop, whose `lifecycle` answers whatever the scenario
// says a hop says — the same surface ui/ssh-tunnel.ts exposes
function hopWorld(state) {
  const calls = [];
  const hop = {
    tunnelId: FAR_ID,
    connect: { connectTunnel: async () => ({ ok: true }) },
    lifecycle: {
      tunnelStatus: () => ({
        active: !!state.active,
        url: state.url || null,
        target: state.target === undefined ? FAR : state.target,
        execBridge: state.execBridge,
      }),
      openSessionForward: async (port) => {
        calls.push(["forward", port]);
        return { localPort: port + 1000, close: () => {} };
      },
      restartRemoteServer: async () => {
        calls.push(["restart"]);
        return true;
      },
    },
    remote: { remoteExec: async () => ({}) },
  };
  return {
    calls,
    tunnel: {
      primaryTunnel: () => hop,
      tunnelFor: (id) => (id === FAR_ID ? hop : null),
      listTunnels: () => (state.listed ? [hop] : []),
    },
  };
}

function localWorld(has) {
  const wakes = [];
  return {
    wakes,
    local: has
      ? {
          base: () => LOCAL_BASE,
          wake: async () => {
            wakes.push(1);
            return true;
          },
        }
      : null,
  };
}

async function main() {
  const state = { active: false, url: null };
  const { tunnel, calls } = hopWorld(state);
  const here = localWorld(true);
  const ex = createExecutors({ tunnel, local: here.local, log: () => {} });

  // ---- 1. this machine is a row, and it is named in the same key space ----
  check(LOCAL_ID === "local" && isLocal(LOCAL_ID) && !isLocal(FAR_ID),
    "this machine has an id among the endpoints, and it is a value — not a flag beside them");
  const mine = ex.get(LOCAL_ID);
  check(mine && mine.id === LOCAL_ID && mine.remote === false,
    "get(LOCAL_ID) answers this machine, and it is not remote");
  check(typeof mine.ready === "function" && typeof mine.restart === "function" &&
        typeof mine.forward === "function" && typeof mine.capabilities === "function",
    "an endpoint answers the four questions a claim asks it (capabilities, ready/restart, forward)");
  check(mine.capabilities().supervisor && mine.capabilities().exec,
    "this machine can host a session and run a command");
  check(mine.base() === LOCAL_BASE && mine.status().active && mine.status().url === LOCAL_BASE,
    "its base is this app's own supervisor, and its status says so");
  const fwd = await mine.forward(30001);
  check(fwd.localPort === 30001,
    "a port on this machine is reached as it is: the local forward is the identity, not a tunnel");
  await mine.ready();
  await mine.restart();
  check(here.wakes.length === 2,
    "ready() and restart() both wake this machine's supervisor — it is a child of this app, so starting it is ours");

  // ---- 2. a host with no local mode: an endpoint that cannot serve a claim ----
  {
    const phone = createExecutors({ tunnel, local: localWorld(false).local });
    const herePhone = phone.get(LOCAL_ID);
    check(herePhone && herePhone.capabilities().exec && !herePhone.capabilities().supervisor,
      "a build with no local supervisor (the phone, N4) is an endpoint that takes commands and hosts no session");
    check(herePhone.base() === null && herePhone.status().active === false,
      "and it says so: no base, not active — never a missing row");
    check((await herePhone.ready()) === false,
      "so ready() is false here; a claim must not read that as 'the far side is starting one'");
    check(phone.defaultId() === null,
      "with no hop serving and no local supervisor there is no default endpoint at all");
  }

  // ---- 3. a hop is an endpoint too: id from the module, facts from the hop ----
  check(ex.get(FAR_ID) !== null && ex.get(FAR_ID).remote === true,
    "a hop is named by its id (tunnel-core's building), and it is remote");
  // an id with no live hop behind it is still an endpoint — get() creates no
  // process and no connection, and "cannot serve yet" is capabilities(), not null
  const unknown = ex.get("me@nowhere:22");
  check(unknown !== null && unknown.remote === true && unknown.base() === null &&
        unknown.capabilities().supervisor === false,
    "a hop this process does not hold is an endpoint that cannot serve yet — never a null the caller must guard");
  check(ex.get(null) === null && ex.get(undefined) === null, "and no id is no endpoint");
  const far = ex.get(FAR_ID);
  check(far.capabilities().supervisor === false && far.capabilities().exec === false,
    "a hop that is not up cannot host a session and carries no exec bridge yet");
  check(far.base() === null && far.status().active === false,
    "its base exists only while it is serving (an inactive URL is no URL)");
  check(far.target() === null || far.target().host === FAR.host,
    "its machine record comes from the hop's own status, never from the id's text");

  // ---- 4. the far side starts its own supervisor; this client may only ask ----
  check((await far.ready()) === true,
    "ready() on a hop is not this client's to perform: the far host starts its own, so there is nothing to wait for");
  check((await far.restart()) === true && calls.some((c) => c[0] === "restart"),
    "restart() asks THAT machine to reboot, rather than spawning anything here");
  const farFwd = await far.forward(30002);
  check(farFwd.localPort === 30002 + 1000 && calls.some((c) => c[0] === "forward" && c[1] === 30002),
    "forward(p) is the hop's own forward: a port here reaches the session listening on p over there");

  // ---- 5. up and serving: the facts change together ----
  state.active = true;
  state.url = FAR_BASE;
  state.execBridge = 42001;
  check(far.base() === FAR_BASE && far.capabilities().supervisor && far.capabilities().exec,
    "a serving hop has a base, hosts a session and carries the exec bridge");
  check(far.status().active && far.status().url === FAR_BASE && far.target().host === FAR.host,
    "and its status says the same three things the page and the picker read");
  state.execBridge = null; // up, between forwards: the SSH-tools degradation
  check(far.capabilities().supervisor && !far.capabilities().exec,
    "a hop that is up but carries no exec bridge hosts a session and takes no command — the degradation, said as a capability");
  state.active = false;
  state.url = null;

  // ---- 6. a pin names an endpoint; only this module turns it into an id ----
  check(ex.resolve({ kind: "executor", id: FAR_ID }) === FAR_ID,
    "a pin by id is that id");
  check(ex.resolve({ kind: "executor", id: LOCAL_ID }) === LOCAL_ID,
    "and this machine is named the same way: one id space, no flag");
  check(ex.resolve({ kind: "executor", target: { host: FAR.host, user: FAR.user, port: FAR.port } }) === FAR_ID,
    "a pin by machine trio becomes the id tunnel-core builds — the renderer never assembles one");
  check(ex.resolve({ kind: "executor", target: { host: FAR.host, user: FAR.user, port: "6001" } }) ===
        tunnelId(FAR.host, FAR.user, "6001"),
    "a stored port keeps its spelling (a tab remembers \"6001\"): the trio is resolved by the same builder, not by hand");
  check(ex.resolve({ kind: "executor", target: { host: FAR.host } }) === tunnelId(FAR.host, undefined, 22),
    "a trio with no user and no port is the same builder's default (:22), not a second guess");
  check(ex.resolve({ kind: "local" }) === null && ex.resolve({ kind: "tunnel", target: FAR }) === null &&
        ex.resolve({ kind: "executor" }) === null && ex.resolve(null) === null,
    "the retired pin shapes (and an empty one) name nothing: a pin from an older store resolves to no endpoint, never to an arbitrary one");

  // ---- 7. the default endpoint: the hop that is serving, else this machine ----
  check(ex.defaultId() === LOCAL_ID && ex.base(ex.defaultId()) === LOCAL_BASE,
    "with no hop serving, the default endpoint is this machine");
  state.active = true;
  state.url = FAR_BASE;
  state.target = FAR;
  check(ex.defaultId() === FAR_ID && ex.base(ex.defaultId()) === FAR_BASE,
    "with a hop serving, the default is that hop — 'a window is on whatever is connected', said once");
  state.target = null; // a hop that cannot name its machine cannot be a slot's default
  check(ex.defaultId() === LOCAL_ID,
    "a serving hop with no machine record is not a default: an id has to name one");

  // ---- 8. the table the picker draws: this machine first, then the hops ----
  state.target = FAR;
  state.listed = true;
  const rows = ex.list();
  check(rows.length === 2 && rows[0].id === LOCAL_ID && rows[1].id === FAR_ID,
    "every endpoint this process can name: this machine first, then the hops it holds");
  check(rows[0].capabilities.supervisor && rows[1].capabilities.supervisor && rows[1].target.host === FAR.host,
    "and each row says what is true of it now, so a known device can be drawn without inventing either answer");
  state.active = false;
  state.url = null;
  const down = ex.list();
  check(down.length === 2 && down[1].active === false && down[1].capabilities.supervisor === false &&
        down[1].base === null,
    "a hop that went down keeps its row: known, not up — never a device that disappeared from the list");

  // ---- 9. no hop module at all (a host that can only work here) ----
  {
    const solo = createExecutors({ tunnel: null, local: localWorld(true).local });
    check(solo.get(FAR_ID) === null && solo.get(LOCAL_ID) !== null,
      "a process that can hold no hops names only itself");
    check(solo.list().length === 1 && solo.list()[0].id === LOCAL_ID,
      "and its table has one row");
    check(solo.defaultId() === LOCAL_ID, "which is also the default");
  }

  // ---- 10. the module's own defaults: nothing to say, nothing to do ----
  {
    const bare = createExecutors();
    check(bare.get(LOCAL_ID) !== null && bare.get(LOCAL_ID).base() === null && bare.defaultId() === null,
      "createExecutors() with no shell wiring is a table with this machine in it and nothing behind it");
    check(bare.list().length === 1 && bare.list()[0].active === false,
      "no shell, no supervisor, no hop: one row that is honestly inactive");
  }

  summary("executors");
}

main().catch((e) => {
  console.error("FAIL:", (e && (e.stack || e.message)) || e);
  process.exit(1);
});
