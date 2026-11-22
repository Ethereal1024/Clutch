// Dispatch: one component tool call, from the tool's declaration to the model's
// envelope.
//
// Ported from three Python seams that only make sense together:
//
//   * `registry.ExtensionTool.execute` / `_run_statement` — what ONE call does, in
//     one order: is this component drivable for this call, prepare its statement,
//     remember the file the write is about to replace, run, then record the
//     mutation;
//   * `prompt.module_blocked_reason` — the "why not", answered BEFORE anything is
//     prepared (a component this host cannot drive must not be half-prepared and
//     then explained);
//   * `registry._file_before` — the undo record, which is the HOST's bookkeeping
//     and not something a component declares.
//
// What is deliberately NOT here: the tool table. Turning a declaration into a tool
// (`tools.js::extensionTool`) and applying the `gate` word plus `entries` belongs
// to the caller that owns the config and the skill library — this file answers the
// questions a CALL asks and nothing more. That is also why there is no `entries`
// and no skill scan: publishing a fact is `facts.py`'s door, a backend feature, and
// on deployment B nothing publishes one, so the `skills` gate fails closed exactly
// as it does today.
//
// Two bundles are INJECTED rather than imported, because in the Python they are
// module imports and here they belong to the machine that answers them:
//
//   `host`    { resolve, unavailable, service?, transport? } — the ARTIFACT bundle
//             (`statement.js`'s header). On deployment B there is no artifact
//             machine: `resolve` answers null, `unavailable` is the sentence, and
//             `service`/`transport` do not exist at all (this host launches
//             nothing on either side of the wire);
//   `client`  { reasonFor, send } — the channel to the component's own process.
//             `channelOf` below wires the ONE this app has, from
//             `ui/plugin-host.js`.
//
// The catalog itself is the third injection (`components(name)`): on B it is built
// out of the client components this app holds, and every one of them is a
// `ClientRun`.
//
// Like every file in `ui/host/`, this one touches NO local filesystem (plan §7 ban
// X1) and requires no module outside this directory — the plugin host is handed in
// as an object, never `require`d (`channelOf`).

"use strict";

const { TransportError } = require("./exec");
const { FileNotFoundError, OSError, ValueError } = require("./fs");
const { InstError } = require("./inst");
const { ChannelError, RendezvousError, prepare: prepareStatement } = require("./statement");
const { envelope, failureEnvelope, setting } = require("./tools");

// The argument a write's undo record reads when the tool's declaration names none
// — the same fallback `declarationOf` applies, so a hand-built tool and a declared
// one agree.
const DEFAULT_SNAPSHOT_ARG = "path";

// The one sentence for a name no declaration answers to. Python says it in
// `rendezvous.unavailable_reason` (the table lookup happens there); here the table
// is this file's injection, so the sentence is this file's — once, and about the
// thing that is actually missing.
function unknownComponent(name) {
  return `unknown component: ${name}`;
}

// --------------------------------------------------------------- the channel --

// `channel.call` / `Channel.reason_for`, wired to the client this app holds.
//
// Three things and no policy:
//
//   * `reasonFor` is the SAME sentence `call()` would refuse with — it is
//     `plugin-host.refuse`'s answer, so a component that is not installed, whose
//     payload is unreadable, or which the user stopped is refused in one spelling
//     whether the question is asked before preparing a statement or after;
//   * `send` maps every rejection to `ChannelError`, which is the class the
//     statement layer turns into the model's `ERROR: …` (Python: `channel.call`
//     raises `ChannelError` for every transport verdict of its own). The WORDS
//     stay the plugin host's — it is the only side that knows why a fork died —
//     and this function adds none of its own;
//   * the caller's `timeout` is NOT forwarded. In the Python it only bounds the
//     socket wait around a call whose real deadline is the client's own
//     `CALL_TIMEOUT_MS` (that is what `GRACE_S` is for), and here the listener is
//     in this process: the fork's budget is the deadline, and it is
//     `plugin-host.js`'s number, not a second one derived here.
function channelOf(pluginHost) {
  if (!pluginHost || typeof pluginHost.call !== "function" || typeof pluginHost.refuse !== "function") {
    throw new TypeError("channelOf needs the client's plugin host (refuse, call)");
  }
  return Object.freeze({
    reasonFor(name) {
      const reason = pluginHost.refuse(String(name));
      return typeof reason === "string" ? reason : "";
    },
    async send(module, template, args, _timeout, options = {}) {
      const where = options && options.root ? String(options.root) : "";
      const fence = Array.isArray(options && options.fence) ? options.fence.map((glob) => String(glob)) : [];
      try {
        return await pluginHost.call({
          name: String(module),
          command: String(template),
          args: args && typeof args === "object" ? args : {},
          root: where,
          fence,
        });
      } catch (error) {
        throw new ChannelError(error && error.message !== undefined ? String(error.message) : String(error));
      }
    },
  });
}

// ---------------------------------------------------------------- the orient --

// `registry.ExtensionTool.execute` + `prompt.module_blocked_reason` +
// `registry._file_before`, over one injected catalog.
//
// The returned object is the whole of what a call needs:
//
//   moduleBlockedReason(name)  the sentence ("") — asked before preparing anything
//   prepare(name, workspace, config)  the component's statement, ready to run
//   fileBefore(workspace, args, arg)  the undo record a write needs
//   runStatement(tool, call)   the function `tools.js` injects as a tool's `run`
function createOrient(options = {}) {
  const render = options.render;
  if (typeof render !== "function") throw new TypeError("createOrient needs render(name, vars)");
  const components = options.components;
  if (typeof components !== "function") {
    throw new TypeError("createOrient needs components(name), the catalog this host can see");
  }
  const artifact = options.host || {};
  if (typeof artifact.resolve !== "function" || typeof artifact.unavailable !== "function") {
    throw new TypeError("createOrient needs host.resolve(name) and host.unavailable(name)");
  }
  const client = options.client;
  if (!client || typeof client.reasonFor !== "function" || typeof client.send !== "function") {
    throw new TypeError("createOrient needs client.reasonFor(name) and client.send(...)");
  }
  // The bundle `statement.js` asks (`resolve` / `unavailable` / `service` /
  // `transport` / `reasonFor` / `send`): one object, because a component's
  // declaration is the only thing that decides which of them a call needs, and the
  // channel's two answers are the client's and win over any of the same name on
  // the artifact bundle.
  const host = Object.freeze({ ...artifact, reasonFor: client.reasonFor, send: client.send });

  function componentOf(name) {
    const wanted = String(name);
    const found = components(wanted);
    return found || null;
  }

  function isClientRun(component) {
    return Boolean(component && component.run && component.run.kind === "clientRun");
  }

  // Why this host cannot run `name`'s statements for THIS call ("" = it can).
  //
  // One question where the Python asks three. `prompt.module_blocked_reason` asks
  // "is this component here and drivable", then two symmetric clauses about where
  // the workspace root lives: a component with a process on this machine only
  // serves a root that is here, and a component whose statements are the client's
  // only serves a root that is elsewhere. This host only ever serves a FAR root
  // (plan §1), so both clauses collapse:
  //
  //   * the first becomes the artifact question itself — a `service`/`launch`
  //     component's code would have to be installed on THIS machine, and a
  //     far-root host holds no such artifact, so `host.unavailable` already says
  //     "not installed on this host": the same verdict the clause would add a
  //     second sentence to;
  //   * the second is unreachable, because it needs a LOCAL root.
  //
  // Both halves are therefore answered by the bundle that owns the fact, and a
  // sentence that only repeats another is not written down twice.
  function moduleBlockedReason(name) {
    const component = componentOf(name);
    if (!component) return unknownComponent(String(name));
    // The client's own door: for these components a live channel IS the artifact,
    // and `unavailable_reason` asks exactly that question (tools/channel.py).
    if (isClientRun(component)) return client.reasonFor(String(name)) || "";
    return artifact.unavailable(String(name)) || "";
  }

  // The component's statement, ready to run. A name no declaration answers to has
  // no statement at all, and says so rather than being prepared against a
  // stand-in.
  function prepare(name, workspace, config) {
    const component = componentOf(name);
    if (!component) throw new RendezvousError(unknownComponent(String(name)));
    return prepareStatement(component, workspace, config, host);
  }

  // `registry._file_before`: the file a component's write is about to replace or
  // create — `{path, existed, previous}`, or null when there is nothing the host
  // could remember.
  //
  // One resolution, two records that need different halves of it: the per-file
  // undo stack only wants a file whose content is actually lost, while the turn
  // journal also has to know whether the write CREATED the path (a creation is
  // undone by deleting, which the undo stack cannot express).
  //
  // Two divergences from the Python, both because the far root is read through one
  // shell command (`fs.js::read` is `cat`) and a local `Path.read_text` is not:
  //
  //   * an EMPTY argument names the root itself, a directory — Python's read
  //     raises `IsADirectoryError` and remembers nothing, so the same answer is
  //     given here before the read is tried;
  //   * any other failed read arrives as `FileNotFoundError` (that is the only
  //     failure `fs.js::read` reports), so a path that exists but cannot be read —
  //     a directory, a permission — is recorded as a creation where Python
  //     records nothing. The record is bounded: `rm -f` cannot delete a directory,
  //     a creation gets no undo snapshot, and a rollback reports an entry it could
  //     not apply by omission instead of guessing.
  async function fileBefore(workspace, args, arg) {
    const key = arg === undefined || arg === null || arg === "" ? DEFAULT_SNAPSHOT_ARG : String(arg);
    const given = args && typeof args === "object" ? args : {};
    const raw = given[key] === undefined || given[key] === null ? "" : String(given[key]);
    if (!raw) return null;
    let path;
    try {
      path = await workspace.resolve(raw);
    } catch (error) {
      if (error instanceof OSError || error instanceof ValueError) return null;
      throw error;
    }
    try {
      return { path, existed: true, previous: await workspace.read(String(path)) };
    } catch (error) {
      if (error instanceof FileNotFoundError) return { path, existed: false, previous: "" };
      if (error instanceof OSError) return null;
      throw error;
    }
  }

  // `registry.ExtensionTool._run_statement`: the template the declaration carries,
  // then its runner. Two steps and no branch — the line itself (rendered here, or
  // sent verbatim to the client) and the transport — because neither asks what kind
  // of component this is.
  //
  // `InstError` is the model's own mistake (a missing argument, an unrenderable
  // statement) and `TransportError` is the transport's verdict (a Stop, a budget, a
  // command that never ran). Those two are answered in words; anything else is a
  // bug and goes up to the tool boundary, which is the only place that decides a
  // tool must never throw into the loop.
  async function executeStatement(ready, tool, call) {
    const timeout = setting(call.config, "commandTimeout");
    try {
      return await ready.run(tool.template, call.args || {}, tool.defaults || {}, {
        timeout,
        cancel: call.cancel || null,
      });
    } catch (error) {
      if (error instanceof InstError) {
        return envelope(render("errors/invalid_arguments.md", { error: error.message }), { error: true });
      }
      if (error instanceof TransportError) {
        return failureEnvelope(error, { render, timeoutSeconds: timeout });
      }
      throw error;
    }
  }

  // One component tool call: prepare the statement, run it, and keep the undo
  // record a write makes necessary.
  //
  // The order is the Python's, and every step is there for a reason found the hard
  // way. A component this host cannot drive is answered with the reason and never
  // prepared; a statement that cannot be prepared (no artifact here, no live
  // channel for a client's) is answered with the rendezvous sentence; the undo
  // record is taken BEFORE the run and kept only when the run actually replaced
  // something, because a refused or failed edit must not leave a snapshot the UI
  // could "restore".
  //
  // The undo record has TWO gates, exactly as in `registry._invoke`: the tool's own
  // declaration (`tool.snapshot`: "this statement overwrites the path its
  // `snapshotArg` names") AND where the statement runs (`ready.local`,
  // `statement.Statement.local`). The second is not a policy but the record's own
  // scope: this host's snapshot remembers content it read from a file on THIS
  // machine, while a statement the client runs writes the CLIENT's filesystem —
  // where this process can neither read the old content nor restore it. Taking the
  // record anyway journals a path on the wrong machine (and, worse, a create where
  // the client's file already exists), so the client's write is the client's to
  // undo.
  async function runStatement(tool, call) {
    const args = call.args && typeof call.args === "object" ? call.args : {};
    const name = String(tool.owner || "");
    const blocked = moduleBlockedReason(name);
    if (blocked) {
      // `registry._invoke`'s sentence, word for word. A session holds the
      // declarations it was assembled with, so a component removed while it runs
      // leaves a tool here that cannot work: the call is DEAD, and the sentence has
      // to correct the model rather than send it to investigate the host. The name
      // is `tool.name` — the word the model actually called.
      return envelope(
        `ERROR: ${tool.name} is not available in this session (${blocked}); ` +
          "do not call it again — use the tools this request offers.",
        { error: true }
      );
    }

    let ready;
    try {
      ready = prepare(name, call.workspace, call.config);
    } catch (error) {
      if (error instanceof RendezvousError) return envelope(`ERROR: ${error.message}`, { error: true });
      throw error; // a wiring bug is not the model's mistake: the tool boundary says so
    }

    const remembered =
      tool.snapshot && ready.local ? await fileBefore(call.workspace, args, tool.snapshotArg) : null;
    const result = await executeStatement(ready, tool, call);
    if (remembered !== null && !result.error) {
      // the undo stack keeps its old rule (only content that was actually lost is
      // restorable); the journal keeps the fuller record
      if (remembered.existed && remembered.previous) {
        call.workspace.snapshot(remembered.path, remembered.previous);
      }
      call.workspace.recordMutation(remembered.path, remembered.existed, remembered.previous);
    }
    return result;
  }

  return Object.freeze({
    host,
    components,
    moduleBlockedReason,
    prepare,
    fileBefore,
    runStatement,
  });
}

module.exports = {
  DEFAULT_SNAPSHOT_ARG,
  unknownComponent,
  channelOf,
  createOrient,
};
