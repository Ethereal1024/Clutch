// The client's plugin PATH: the listener, the reverse channel it answers on, and
// the push that tells a session what this client runs.
//
// Three facts have to line up before a session can call a plugin, and they are
// produced by three different layers: the listener (ui/plugin-server.js) answers
// /call on this machine, the reverse forward (tunnel-connect) puts it on the far
// side's loopback under a port sshd picks, and the session child (agent/server.py
// /api/channel) must be TOLD that port, that token, and what sits behind them.
// This file is the one place those three are kept in step, because each of them
// can change on its own:
//
//   * the tunnel connects and disconnects (a new far-side port each hop);
//   * a window claims a session, and that claim is what names a session base;
//   * the user installs, stops or removes a plugin, which changes the list.
//
// The rules that keep it honest:
//
//   * NOTHING is pushed before the forward is installed. A session told to dial a
//     port nobody serves fails every call with "the channel is not answering",
//     which is a worse lie than "this host has no channel".
//   * A declaration ABOUT another machine (`subject: foreign-fs` — the far side's
//     filesystem, clutch-ssh-workspace) is only offered while a hop is live
//     (snapshot): its tools are only meaningful where the tunnel reaches, and on
//     this side the same names belong to the local component.
//   * A push is the WHOLE set (agent/tools/channel.py refuses a partial one), so
//     a change is a re-push, and "I have no plugins" is a DELETE — the session's
//     refusal is then a sentence about the state, not a dial that times out.
//   * A push is remembered per session base, so a window that re-claims the same
//     session does not re-publish, and a base that FAILED is not remembered (the
//     next sync retries it).
//   * The token and the port travel; nothing about the bytes does. What this
//     client runs is its own business (PLUGIN_PLAN.md 零之四.1).
//
// It is deliberately NOT part of the supervisor: a frontend component is managed
// by the frontend, and the session child is the process that holds tool state.

"use strict";

const http = require("http");

const { registerChannel, channels, tunnelLog, state: tunnelState } = require("./tunnel-core");
const { createPluginServer } = require("./plugin-server");

// A push is a few hundred bytes of JSON to a loopback port of our own session.
// If that does not answer in five seconds, the session is not there — retrying
// inside this call would only make the caller wait for the same silence again.
const PUSH_TIMEOUT_MS = 5000;

// One object, one lifetime (the app's), because the listener and the row outlive
// any single tunnel: only the far-side PORT and the session bases change.
const state = {
  server: null, // the /call listener (ui/plugin-server.js)
  chan: null, // the tunnel-core row that routes the far side's connection to it
  client: null, // the ssh client the forward was installed for
  installing: null, // the in-flight install, so ten asks are one forward
  installingFor: null, // …and which client it is about
  bases: new Set(), // session bases this client serves (/api/channel of each)
  told: new Map(), // base -> the declaration JSON it was last told
};

function log(...args) {
  tunnelLog("[plugin]", ...args);
}

// The session's own local forward is always a loopback http address (`wb.url` is
// `http://127.0.0.1:<port>` for a local session and for a tunnelled one alike).
// The push carries the token, so this is also the fence around it: a base that is
// not that is a bug or a misconfiguration, and it must not be the thing that
// sends a secret onto the internet.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// One HTTP call at a session base: the answer body as JSON, or a thrown sentence.
// Never through the proxy stack: this is loopback at both ends (the session base
// is a local forward), and a system proxy would send it to the internet.
function session(method, base, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(String(base).replace(/\/+$/, "") + "/api/channel");
    } catch (e) {
      reject(new Error(`not a session base: ${JSON.stringify(base)}`));
      return;
    }
    if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
      reject(new Error(`not a session base: ${JSON.stringify(base)} is not a loopback http address`));
      return;
    }
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": body.length }
          : {},
        timeout: PUSH_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch (e) {
            parsed = null;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const why = parsed && parsed.error ? parsed.error : `HTTP ${res.statusCode}`;
            reject(new Error(why));
            return;
          }
          resolve(parsed || {});
        });
      }
    );
    req.setTimeout(PUSH_TIMEOUT_MS, () => req.destroy(new Error(`the session did not answer within ${PUSH_TIMEOUT_MS}ms`)));
    // A dead forward fails the request itself; the sentence is all the caller
    // needs, and an unhandled 'error' would be an uncaught main-process throw.
    req.on("error", (e) => reject(new Error(String((e && e.message) || e))));
    if (body) req.write(body);
    req.end();
  });
}

// What a session should be told right now, as the exact bytes that would be
// pushed. Compared as JSON because the push is a replacement: "the same set" has
// to mean the same bytes, or every sync would be a new generation.
// A `foreign-fs` declaration (clutch-ssh-workspace, catalog.FOREIGN_FS) is a
// promise about ANOTHER machine: its tools arrive over this client's reverse
// channel and run on the far side of the hop that carries it. Without a live hop
// there is nothing to run them on, and the session's own `workspace-fs`
// component is the one that works for those names — so a declaration pushed then
// would shadow working tools with ones that can only answer "no tunnel". The hop
// is `state.client`: set when a forward is installed for a live ssh client,
// cleared by stop() and by the tunnel's own hopLost().
const FOREIGN_FS = "foreign-fs";

function snapshot() {
  const components = state.server ? state.server.declarations() : [];
  if (state.client) return components;
  return components.filter((c) => c.subject !== FOREIGN_FS);
}

async function pushTo(base) {
  const components = snapshot();
  const text = JSON.stringify(components);
  if (state.told.get(base) === text) return { base, status: "unchanged" };
  if (!state.chan || state.chan.remote() == null) {
    // no far-side port (the forward never landed): say nothing rather than name
    // a port that would answer nothing
    return { base, status: "no-forward" };
  }
  if (!components.length) {
    const answer = await session("DELETE", base);
    state.told.set(base, text);
    log(`nothing to declare to ${base}; the session was told so`);
    return { base, status: "cleared", answer };
  }
  const answer = await session("POST", base, {
    port: state.chan.remote(),
    token: state.server.token,
    components,
  });
  state.told.set(base, text);
  log(`declared ${components.map((c) => c.name).join(", ")} to ${base} on far-side port ${state.chan.remote()}`);
  return { base, status: "pushed", answer };
}

// Every session this client serves, brought up to date. Failures are per base
// and never fatal: one unreachable session must not stop this client from
// serving the others, and an unpushed base is retried on the next sync.
async function sync() {
  const results = [];
  for (const base of [...state.bases]) {
    try {
      results.push(await pushTo(base));
    } catch (e) {
      state.told.delete(base); // the next sync tries again
      results.push({ base, status: "failed", error: String((e && e.message) || e) });
      log(`declaring to ${base} failed: ${(e && e.message) || e}`);
    }
  }
  return results;
}

// Bring the whole path up for `client`: the listener, the row, the far-side port,
// and every session this client serves. It is not called when a hop comes up, and
// that is deliberate — the hop's job is the hop, and asking the far side for a
// loopback port nobody has claimed a session on would be a listener held on the
// far machine for a facility no one has used yet (the same reason the model path
// is per hop, not per connect). A claim is the first moment a session could
// possibly call a plugin, so a claim is the first moment this is worth doing.
//
// Idempotent: the listener is one, the row is one, and an install already in
// flight is joined rather than repeated — ten windows asking for the same tunnel
// must not ask sshd for ten forwards. A NEW client supersedes the old install
// (its forward belongs to a hop that is gone, and tunnel-connect's ladder reports
// it as abandoned), so the stale one must not clear the new one's slot on its way
// out: that would let a third caller start a third install on one row.
function start(client) {
  if (!client) return Promise.resolve(false);
  if (state.installing && state.installingFor === client) return state.installing;
  state.client = client;
  const run = async () => {
    try {
      if (!state.server) {
        // `host` is the client plugin domain the APP owns (ui/main.js): the page
        // installs into it through the components view, and this server is what
        // declares what it holds. One table, one writer, one reader — a server
        // that made its own would declare a domain nothing was ever installed
        // into, and the page and the session would disagree about what exists.
        state.server = createPluginServer({ log, host: host || undefined });
        await state.server.listen();
        log(`listening 127.0.0.1:${state.server.port()} for this client's plugins`);
      }
      if (!state.chan) {
        // No contract port: unlike the model path, nothing on the far side is
        // configured with this number in advance, so the far side always picks
        // and there is nothing to collide with. The row exists only while a
        // listener does — a row with nothing behind it would route a connection
        // into a refusal.
        state.chan = registerChannel("plugin", {
          local: () => (state.server ? state.server.port() : null),
          what: "client plugins",
        });
      }
      const { installReverseForward } = require("./tunnel-connect"); // lazy: tunnel-connect is this file's sibling, not its dependency
      const ok = await installReverseForward(client, state.chan);
      if (!ok) {
        log("the far side would not forward a port for this client's plugins");
        return false;
      }
      await sync();
      return true;
    } finally {
      if (state.installing === run) {
        state.installing = null;
        state.installingFor = null;
      }
    }
  };
  state.installing = run();
  state.installingFor = client;
  return state.installing;
}

// A window's session is ready: remember where it is and tell it what we run.
// The base is kept even while a push fails, so the next sync retries it.
//
// This is also the moment the path is INSTALLED (the far-side port, the listener,
// the row), because the claim is what makes a session able to call anything here.
// The hop's client is read from the tunnel rather than handed in: no window calls
// this on behalf of a client it owns, and a hop that is already gone (no client)
// installs nothing — the base is remembered and the next claim on the next hop
// picks it up.
//
// A first push that fails is retried here too (a session that claimed before the
// tunnel finished, or after a first refusal), so it gets a path that really
// exists instead of a declaration naming nothing. The retry is bounded by the
// installer's own clocks, and it joins whatever install is already in flight.
async function offer(base) {
  if (!base) return [];
  state.bases.add(String(base));
  const client = tunnelState.sshClient;
  if (client && (!state.chan || state.chan.remote() == null)) {
    await start(client);
  }
  return sync();
}

// That session is going away (a window closed, the app is quitting). The session
// child's channel is memory, so a DELETE is courtesy: it makes the next call
// read "this host has no channel" instead of dialling a forward that is gone.
async function forget(base) {
  state.bases.delete(String(base));
  state.told.delete(String(base));
  try {
    await session("DELETE", base);
  } catch (e) {
    log(`clearing ${base} failed (the session is probably gone already): ${(e && e.message) || e}`);
  }
}

// The install set changed (a plugin was installed, stopped or removed): re-declare
// to everyone. A stopped plugin leaves the set, which is what makes its tools
// disappear from the session's surface.
function refresh() {
  return sync();
}

async function stop() {
  const bases = [...state.bases];
  state.bases.clear();
  state.told.clear();
  await Promise.all(bases.map((base) => forget(base)));
  if (state.chan) {
    channels.delete(state.chan.name);
    state.chan = null;
  }
  const server = state.server;
  state.server = null;
  state.client = null;
  state.installing = null;
  state.installingFor = null;
  if (server) await server.stop();
}

// The client plugin domain this path speaks for (ui/plugin-host.js), handed in by
// the shell that owns it. Absent, the server makes one over its default root —
// which is what the tests and a host with no components page still want.
let host = null;
function useHost(next) {
  host = next || null;
  return host;
}

// What the tunnel calls when its hop dies: the forward is gone, so the far-side
// port is no longer ours. The listener stays (a re-connect re-uses it) but the
// row must forget the port it was granted, or the next push would name a dead one.
//
// The bases go with the hop too: every session this client serves over that hop
// is either gone or about to be reaped, and the windows that still hold one
// re-claim through the backend (`api:base`) when the ladder puts them back — the
// same claim that offers them here in the first place. Keeping them would mean
// pushing a new port to a session nobody has re-established, whose answer is
// silence, once per base, on every sync.
function hopLost() {
  state.client = null;
  if (state.chan) state.chan.setRemote(null);
  state.bases.clear();
  state.told.clear(); // a new hop is a new port: the next sync really pushes
}

module.exports = {
  PUSH_TIMEOUT_MS,
  state,
  useHost,
  start,
  offer,
  forget,
  refresh,
  stop,
  hopLost,
  // exported for the tests: the two halves this file glues
  snapshot,
};
