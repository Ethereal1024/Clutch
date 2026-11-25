// One execution endpoint: a machine a session's work can happen on.
//
// There was no such thing before this file. host-core answered "where does this
// run?" with `kind: "local" | "tunnel"` — two shapes, two special cases, and
// "the tunnel" was the process-wide singleton, so a second device could not be
// described at all. An executor is that description: a durable id, what can be
// asked of it right now, and the few operations a claim performs on it. Nothing
// above this file branches on which KIND it is — this machine is one executor
// among the others (see LOCAL_ID), not a special case beside them.
//
// The answers, and what each one means:
//
//   id            `user@host:port` for a hop — tunnel-core's tunnelId, the ONE
//                 place a key is built — or LOCAL_ID for this machine. Held and
//                 compared, never parsed: upper layers may compare two of them
//                 without knowing what one is made of.
//   remote        whether the work happens somewhere other than this process.
//                 That is the whole difference in practice: a remote endpoint
//                 needs a forward, and its supervisor is somebody else's to keep
//                 alive.
//   capabilities  what can be asked of it RIGHT NOW: `supervisor` (a session can
//                 be claimed on it) and `exec` (this process can run a command
//                 on it, through the exec bridge). An endpoint with exec and no
//                 supervisor is the SSH-tools degradation — the far side takes
//                 commands but runs no session.
//   status()      { active, url, target } — what the page and the picker are told
//   base()        the supervisor base a session is claimed on, or null
//   ready()       make the supervisor answer, when starting it is OURS to do: the
//                 local one is a child of this app, the far side starts its own
//   restart()     it is up (or was) and is not answering — reboot it
//   forward(p)    the port THIS process reaches a session listening on `p` over
//                 there; the identity when "over there" is here
//   target()      the machine record, for a tab that has to remember it
//
// The table is built by a shell, not by this module: `tunnel` is the hop module
// it holds hops in (ui/ssh-tunnel.js), `local` is what this shell can say about
// its own supervisor. Android passes no `local` — N4, no local supervisor — and
// then this machine is simply an endpoint with no supervisor capability.
const { tunnelId } = require("./tunnel-core");

// The reserved id of this machine in the same key space as the hops. It is not a
// flag beside the ids: giving "here" an id is what lets every caller hold ONE
// thing (an id) instead of an id and an `if`.
const LOCAL_ID = "local";

function isLocal(id) {
  return id === LOCAL_ID;
}

// A hop's status, whatever it answers with. An id with no live hop is a real
// endpoint that has nothing to say yet, so an empty answer is normal here and
// not a failure.
function statusOf(tunnel, id) {
  try {
    const hop = id == null ? tunnel.primaryTunnel() : tunnel.tunnelFor(id);
    return (hop && hop.lifecycle && hop.lifecycle.tunnelStatus()) || {};
  } catch (e) {
    return {};
  }
}

function createExecutors({ tunnel = null, local = null, log = (..._a) => {} } = {}) {
  const instances = new Map();

  const localBase = () => (local && typeof local.base === "function" ? local.base() : null);

  function localExecutor() {
    return {
      id: LOCAL_ID,
      remote: false,
      capabilities: () => ({ supervisor: !!localBase(), exec: true }),
      status: () => ({ active: !!localBase(), url: localBase(), target: null }),
      base: localBase,
      target: () => null,
      ready: async () => (local && local.wake ? Boolean(await local.wake()) : false),
      restart: async () => (local && local.wake ? Boolean(await local.wake()) : false),
      // the session listens on a port of THIS machine: nothing to forward
      forward: async (port) => ({ localPort: port, close: () => {} }),
    };
  }

  function tunnelExecutor(id) {
    const hop = () => tunnel.tunnelFor(id);
    const status = () => statusOf(tunnel, id);
    const base = () => {
      const ts = status();
      return ts.active && ts.url ? String(ts.url) : null;
    };
    return {
      id,
      remote: true,
      capabilities: () => {
        const ts = status();
        return { supervisor: !!(ts.active && ts.url), exec: !!ts.execBridge };
      },
      status,
      base,
      target: () => {
        const t = status().target;
        return t ? { host: t.host, user: t.user, port: t.port } : null;
      },
      // the far side starts its own supervisor: nothing here may start it
      ready: async () => true,
      restart: async () => {
        try {
          return Boolean(await hop().lifecycle.restartRemoteServer());
        } catch (e) {
          log(`[executor] restarting ${id} failed: ${(e && e.message) || e}`);
          return false;
        }
      },
      forward: (port) => hop().lifecycle.openSessionForward(port),
    };
  }

  // The executor an id names. Never null for a well-formed id: an endpoint with
  // no live hop is still an endpoint — it just cannot serve a claim yet, which is
  // what capabilities() is for. `get` creates no process and no connection.
  function get(id) {
    if (id == null) return null;
    const key = String(id);
    if (!isLocal(key) && !tunnel) return null;
    if (instances.has(key)) return instances.get(key);
    const ex = isLocal(key) ? localExecutor() : tunnelExecutor(key);
    instances.set(key, ex);
    return ex;
  }

  function base(id) {
    const ex = get(id);
    return ex ? ex.base() : null;
  }

  // A slot's pin, as an executor id. A pin names an endpoint either by its id or
  // by the machine it is (a tab remembers host/user/port: that triple IS the
  // connection record, and the id is derived from it HERE, in the one place a
  // key is built). An upper layer never assembles an id itself.
  function resolve(pin) {
    if (!pin || pin.kind !== "executor") return null;
    if (pin.id) return String(pin.id);
    const t = pin.target;
    if (t && t.host) return tunnelId(t.host, t.user, t.port);
    return null;
  }

  // The endpoint a slot with NO pin claims on: the hop that is serving, else this
  // machine. That is the rule every call site predating tabs already obeys ("a
  // window is on whatever is connected"), said once instead of per caller.
  function defaultId() {
    if (tunnel) {
      const ts = statusOf(tunnel, null);
      if (ts.active && ts.url && ts.target) {
        return tunnelId(ts.target.host, ts.target.user, ts.target.port);
      }
    }
    return localBase() ? LOCAL_ID : null;
  }

  function rowOf(ex) {
    const ts = ex.status();
    return {
      id: ex.id,
      remote: ex.remote,
      active: !!ts.active,
      base: ex.base(),
      target: ex.target() || null,
      capabilities: ex.capabilities(),
    };
  }

  // Every endpoint this process can name: this machine first, then the hops it
  // holds. A row says what is true now, so the picker can draw a device that is
  // known but not up without inventing either answer.
  function list() {
    const rows = [rowOf(get(LOCAL_ID))];
    if (tunnel) {
      let hops = [];
      try {
        hops = tunnel.listTunnels() || [];
      } catch (e) {
        hops = [];
      }
      for (const hop of hops) {
        if (!hop || !hop.tunnelId) continue;
        rows.push(rowOf(get(hop.tunnelId)));
      }
    }
    return rows;
  }

  return { get, base, resolve, defaultId, list, isLocal, localId: () => LOCAL_ID };
}

module.exports = { createExecutors, LOCAL_ID, isLocal };
