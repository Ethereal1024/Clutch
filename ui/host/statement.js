// One statement, ready to run: a template, the facts it may name, a runner.
//
// Ported from `agent/tools/statement.py`. A call has exactly one form —
//
//     render(template, the model's arguments ∪ the host's facts) → a runner → an envelope
//
// — and nothing here asks WHAT KIND of component is being called. A statement is
// a line of text; its placeholders are facts with providers; the runner is a
// transport. The question a declaration answers is "where does `{port}` come
// from", never "am I a daemon". WHICH of these builders runs for a component is
// the declaration's own type (`residentRun` / `perCallRun` / `clientRun`, the JS
// spelling of `catalog.Run`), dispatched by the type itself — `run.statement(...)`
// — so there is no second copy of that decision here and no branch to keep in
// step with it.
//
// The facts, and who answers them:
//
//   `{py} {dir} {name} {script}`   the ARTIFACT — the one lookup an installed
//                                  onefile, an installed package and a dev checkout
//                                  all go through (`rendezvous.resolve`), rendered
//                                  here as the line's PREFIX and shq-quoted (this
//                                  text is a shell line, not Popen words);
//   `{port} {token} {pid}`         a running SERVICE — one record per
//                                  (component, workspace root), whose published
//                                  values are the only place these come from;
//   `{base} …`                     the HOST — the component's declared `vars`
//                                  (`catalog.Component.vars`), each naming a fact
//                                  only the host knows (hostVars below).
//
// A provider that cannot answer RAISES; a fact is never invented and a component
// this host cannot drive is never rendered at all (`orient.moduleBlockedReason`
// is the sentence the client shows instead).
//
// The one runner that renders NOTHING is the client's (`clientStatement`). A
// component whose process lives on the client declared the statement itself, and
// this host sends the template VERBATIM with the model's arguments: the client
// validates it against the declaration it installed, turns it into argv words and
// forks its plugin. Rendering it here would be a second implementation of the
// client's own shell — and a statement the client never declared would be one
// this host invented.
//
// The ONE structural difference from the Python: what that module gets by
// `import` (the artifact lookup, the service table, the channel) is INJECTED here
// as the `host` bundle, because on deployment B those answers belong to the
// machine the statement is spoken to, and this layer is the part that must not
// care. `host` is exactly four questions:
//
//   resolve(name)        -> {argv, directory, importable} | null  (the artifact HERE)
//   unavailable(name)    -> the sentence to show when there is none
//   service(root, name, protect) -> {vars()}   (a live service for this root)
//   send/reasonFor       the client's channel (see `client` below)
//
// Every one of them is answered by `orient.js` on this host, and by a scripted
// one in the tests.
//
// Like every file in `ui/host/`, this one touches NO local filesystem (plan §7
// ban X1): the two path spells it needs are lexical, from `fs.js`.

"use strict";

const { shq } = require("./exec");
const { basename, isInside, normalise } = require("./fs");
const inst = require("./inst");
const { envelope } = require("./tools");

// ---------------------------------------------------------------- the errors --
//
// `rendezvous.RendezvousError` and `channel.ChannelError`: the two sentences a
// caller turns into `ERROR: …` for the model (`registry.ExtensionTool.execute`).
// They live here because this is the file that raises the first and catches the
// second, so a caller has one import for both.

class RendezvousError extends Error {
  constructor(message) {
    super(message);
    this.name = "RendezvousError";
  }
}

class ChannelError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChannelError";
  }
}

// ------------------------------------------------------------- host facts -----

// `statement.host_vars`: the host facts a component's declaration asks for, by
// their published names (`catalog.Component.vars`: "host.port_url" -> `{base}`).
//
// These are the values only the host knows and only a particular component needs:
// the project file's content service. The prefix of a one-process line is NOT
// here — that is the artifact's own launch (`launchPrefix`), so a checkout, a
// package and an installed onefile all drive the same declaration.
function hostVars(component, config) {
  // NB: a key here must never be one of a tool's own argument names — the
  // renderer fills {name} from the CALL's arguments, and a host var of the same
  // name would silently overwrite the model's value (a component whose statement
  // takes `{name}` as the model's own argument is exactly that).
  const port = config && config.port !== undefined && config.port !== null ? String(config.port) : "";
  const facts = {
    // Python's Config always has a port (`agent/config.py:122`, 8890). This host
    // has one only when the session supplied it, and a fact with no value is left
    // out rather than invented: `http://127.0.0.1:undefined` is a URL a component
    // would try to dial, while an omitted fact drops the optional group that
    // names it (inst.render) instead of rendering an empty word.
    "host.port_url": () => (port ? `http://127.0.0.1:${port}` : ""),
  };
  const out = {};
  const declared = (component && component.vars) || {};
  for (const [name, fact] of Object.entries(declared)) {
    const make = facts[fact];
    if (!make) continue;
    const resolved = make();
    if (resolved) out[name] = resolved;
  }
  return out;
}

// ---------------------------------------------------------------- the launch --

// `statement.launch_prefix`: how a one-process component STARTS, as a line prefix
// ("" for a service, whose process is started when a statement needs it).
//
// This is the launch contract: the artifact's shape decides the prefix — an
// interpreter plus an entry-point file for a checkout, `-m <package>` with its
// directory on PYTHONPATH for a package, a bare executable for an installed
// onefile — and the declaration only says which flags follow it. A component
// therefore needs no second implementation to be installed as a binary.
function launchPrefix(component, host) {
  if (component && component.run && component.run.kind === "resident") {
    // Its launch starts a process that STAYS; a statement is the loopback call
    // that process answers, with no prefix of its own.
    return "";
  }
  const resolved = host.resolve(component.name);
  if (!resolved) throw new RendezvousError(host.unavailable(component.name));
  const words = (resolved.argv || []).map((word) => shq(String(word)));
  if (resolved.importable) words.unshift(`PYTHONPATH=${shq(String(resolved.directory))}`);
  return words.join(" ");
}

// ----------------------------------------------------------------- the fence --

// `rendezvous.fence_globs`: the workspace's protected paths as the client's fence
// globs.
//
// The client matches a glob against several spellings of the path a request names
// (as-given, basename, root-relative), so a fence has to be given in those
// spellings too. Over-fencing is the safe direction: the host protects a handful
// of project files, never a whole tree. The paths are POSIX and lexical — the far
// root's symlinks are invisible from here (`fs.js`), and `Path.resolve()`'s
// symlink walk is the one part of the Python this host cannot reproduce.
function fenceGlobs(protectedPaths, root) {
  const base = normalise(String(root));
  const out = new Set();
  for (const raw of protectedPaths || []) {
    // The "as-given" spelling is the given path the way Python's `Path()` holds
    // it — lexically normalised, so `./demo.clc` and `demo.clc` are one glob
    // rather than two (`fence_globs` adds `str(Path(raw))`, not `raw`).
    const path = normalise(String(raw));
    out.add(path);
    out.add(basename(path));
    if (!isInside(path, base)) continue; // `relative_to` raises: the path is not under this root
    const relative = path === base ? "" : path.slice(base === "/" ? 1 : base.length + 1);
    out.add(relative);
  }
  return [...out].filter((glob) => glob && glob !== "." && glob !== "/").sort();
}

// ------------------------------------------------------------- the statements --

function timeoutOf(options) {
  const timeout = options && options.timeout !== undefined && options.timeout !== null ? Number(options.timeout) : NaN;
  if (!Number.isFinite(timeout)) throw new TypeError("a statement run needs its timeout (seconds)");
  return timeout;
}

// `statement.Statement`: one statement this host runs itself, ready to render and
// run.
//
// `vars` are the host values the template may name (a service's port/token/pid, a
// one-process component's endpoint/root facts); `runner` is the transport that
// carries the rendered line — the workspace's own when the statement is spoken to
// a service, the app host's otherwise; `prefix` is how the component's own
// process starts ("" for a service, whose line is the whole loopback call).
// `module` is the component that declared it: what a failure names.
function hostStatement(fields = {}) {
  const runner = fields.runner;
  const vars = fields.vars || {};
  const prefix = fields.prefix || "";
  const module = String(fields.module || "");
  if (!runner || typeof runner.run !== "function") {
    throw new TypeError(`the statement of ${module || "a component"} needs a runner with run(line, timeout, {cancel})`);
  }

  // The terminal line for one call: the component's template filled from the call
  // (model arguments, then the host's values), behind the prefix its launch
  // contributes. Every caller renders through here, so "prefix + rendered
  // template" is written once.
  function line(template, args, defaults) {
    const command = inst.render(template, args, { vars, defaults: defaults || {} });
    return prefix ? `${prefix} ${command}` : command;
  }

  return Object.freeze({
    vars,
    runner,
    prefix,
    module,
    line,
    // Carry out one statement: the line is rendered here, run through this host's
    // transport, and its output unwrapped. A transport failure is deliberately
    // NOT answered here: the caller maps it to the model's own words
    // (orient.runStatement), so a timeout, a Stop and an unrunnable command keep
    // reading differently.
    async run(template, args, defaults, options) {
      const timeout = timeoutOf(options);
      const result = await runner.run(line(template, args, defaults), timeout, {
        cancel: (options && options.cancel) || null,
      });
      return inst.unwrap(result, { service: `the ${module} service` });
    },
  });
}

// `statement.ClientStatement`: one statement the CLIENT runs — the template IS
// the statement.
//
// There is nothing to render here and nothing to start: the template is the
// declaration the client installed for one of its own tools, sent VERBATIM with
// the model's arguments. The client validates it against that declaration, turns
// it into argv words and forks its plugin — so a line rendered here would be a
// second implementation of a shell this host does not own, and a template the
// client never declared would be one this host made up.
//
// `root`/`fence` are the two facts the client's plugin cannot derive on its own
// side of the wire: the workspace the call is about, and the globs of the paths
// it protects. They are read from the live workspace when the call is prepared and
// ride WITH it, because this host keeps no other copy of where the far root is.
//
// `defaults` is accepted and IGNORED, exactly as in the Python: the host's
// defaults are part of the host's rendering, and this statement is the client's.
function clientStatement(fields = {}) {
  const module = String(fields.module || "");
  const root = String(fields.root || "");
  const fence = (fields.fence || []).map((glob) => String(glob));
  const send = fields.send;
  if (typeof send !== "function") {
    throw new TypeError(`the statement of ${module || "a component"} is the client's, and this host has no channel to send it`);
  }

  return Object.freeze({
    module,
    root,
    fence,
    // Send the template as it stands; the answer is the client's. `cancel` is not
    // used here either: a client call is bounded by its own deadline (the client
    // kills the fork), which is the same contract `channel.call` has.
    async run(template, args, _defaults, options) {
      const timeout = timeoutOf(options);
      let reply;
      try {
        reply = await send(module, template, args || {}, timeout, { root, fence });
      } catch (error) {
        if (error instanceof ChannelError) return envelope(`ERROR: ${error.message}`, { error: true });
        throw error;
      }
      const content = reply && reply.content !== undefined && reply.content !== null ? String(reply.content) : "";
      return envelope(content, { error: Boolean(reply && reply.error) });
    },
  });
}

// --------------------------------------------------------- the three Run types --
//
// `catalog.Resident` / `PerCall` / `ClientRun`: WHERE a component's statements run,
// as a type rather than as fields that may all be null. Each carries the one
// method the registry needs — `statement(component, workspace, config, host)` —
// so the answer is the type's and there is no branch to keep in step with it.
//
// They differ in that ONE thing. The facts each one needs (how the artifact
// starts, whether a service is up, what the client holds) come from the `host`
// bundle, because in the Python those are module imports and here they belong to
// the machine that answers them.
//
// On deployment B only `clientRun` is ever constructed: this host launches nothing
// on either side of the wire, and `plugin-host.clientSide` refuses a declaration
// that would need a process here. The other two are the translation of
// `catalog.Resident.statement` / `catalog.PerCall.statement` for a caller that
// DOES have an artifact machine (the tests do); no type in this host builds one.

function residentRun() {
  return Object.freeze({
    kind: "resident",
    statement(component, workspace, config, host) {
      return resident(component, workspace, host);
    },
  });
}

function perCallRun() {
  return Object.freeze({
    kind: "perCall",
    statement(component, workspace, config, host) {
      return perCall(component, config, host);
    },
  });
}

function clientRun() {
  return Object.freeze({
    kind: "clientRun",
    statement(component, workspace, config, host) {
      return client(component, workspace, host);
    },
  });
}

// What one call of `component` needs before it can be rendered and run. The type
// is the whole decision — a component without one is a wiring bug, never a tool
// that answers "no implementation" after the model has already called it.
function prepare(component, workspace, config, host) {
  const run = component && component.run;
  if (!run || typeof run.statement !== "function") {
    const name = component && component.name ? component.name : "a component";
    throw new TypeError(`${name} declares no run (residentRun / perCallRun / clientRun)`);
  }
  return run.statement(component, workspace, config, host);
}

// ----------------------------------------------------- the three builders -----

// `statement.resident`: a component with a SERVICE belongs to one workspace, so
// its statement is carried by that workspace's own transport — a loopback call has
// to be issued by the machine the files are on — and the host bundle decides which
// workspace, whether one is running, or whether one has to be started.
function resident(component, workspace, host) {
  if (!host || typeof host.service !== "function") {
    throw new TypeError(`${component.name} publishes a service: the statement needs host.service(root, name, protect)`);
  }
  const live = host.service(workspace.root, component.name, workspace.protectedSet());
  return hostStatement({ vars: live.vars(), runner: workspace, module: component.name });
}

// `statement.per_call`: a component this host starts once per call — the artifact's
// own line, run on the app host's machine, whatever kind of workspace the call
// came from.
function perCall(component, config, host) {
  if (!host || typeof host.transport !== "function") {
    throw new TypeError(`${component.name} runs once per call: the statement needs host.transport()`);
  }
  return hostStatement({
    vars: hostVars(component, config),
    runner: host.transport(),
    prefix: launchPrefix(component, host),
    module: component.name,
  });
}

// `statement.client`: a component with no process here — the statement is the
// client's, and a declaration no live channel holds has no statement at all: fail
// closed, with the channel's own sentence, before anything could be prepared for
// it.
function client(component, workspace, host) {
  if (!host || typeof host.reasonFor !== "function" || typeof host.send !== "function") {
    throw new TypeError(`${component.name} runs on its client: the statement needs host.reasonFor / host.send`);
  }
  const reason = host.reasonFor(component.name);
  if (reason) throw new RendezvousError(reason);
  // The two facts the client's plugin cannot work out on its own side of the wire:
  // which root the call is about, and what the host protects under it. Read HERE,
  // once, from the live workspace — the same root the local path would have used.
  return clientStatement({
    module: component.name,
    root: String(workspace.root),
    fence: fenceGlobs(typeof workspace.protectedSet === "function" ? workspace.protectedSet() : [], workspace.root),
    send: host.send,
  });
}

module.exports = {
  ChannelError,
  RendezvousError,
  hostVars,
  launchPrefix,
  fenceGlobs,
  hostStatement,
  clientStatement,
  residentRun,
  perCallRun,
  clientRun,
  prepare,
  resident,
  perCall,
  client,
};
