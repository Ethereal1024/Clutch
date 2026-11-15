// Assembler for deployment B — the far-root JS host.
//
// On A and C the renderer is an HTTP client of a Python process. On B there is
// no process: the renderer talks to this file's `handle` function in the
// Electron main process (or an Android bridge), and every `/api/*` request is
// answered in-process by the same route table `api.js` exports.
//
// This file ports agent/base.py: RunState / build_workspace / set_project.
// The rest of agent/base.py (the HTTP server, the sessions, the mode switch) is
// A/C-only; the session claim machine already lives in ui/host-core.js.
//
// The host described here is far-root-only (plan §1, §7 ban X1). It builds
// workspaces over a shell transport (`shell.run`), never over the local fs.
//
// createBHost(options) -> { handle, api, state, orient, registry }
//
//   options.shell       far exec transport — { run(command, opts) }
//   options.render      render(name, vars) -> string  (prompt templates)
//   options.pluginHost  { refuse(name), refusalFor(name, why), call(…) }
//                       — the plugin-host IPC object that owns the channel to
//                       ClientRun components.  Omit on a deployment where no
//                       client-side components are registered.
//   options.components  components(name) -> spec | null
//                       — the catalog of client-side component declarations
//                       this session is allowed to drive.  Defaults to () => null
//                       (no components, every tool-call for an unknown name is
//                       blocked by moduleBlockedReason).
//   options.config      host config object (commandTimeout, model, port, …).
//                       Passed through to buildTools / createRegistry.
//
// The run loop (loop.js), the LLM client (llm.js), and the permission gate
// (permission.js) are NOT assembled here: they are wired by the IPC handler
// that owns the renderer connection, because they need callbacks that live at
// the IPC layer (gate.onAsk, gate.onRemind, sink for SSE events, cancel signal).
// This file assembles the parts that do not need a live window:
//   - the workspace factory (buildWorkspace)
//   - the project lifecycle state (setProject)
//   - the tool-and-registry table (registry)
//   - the orient seam (orient.runStatement for the tool executor)
//   - the in-process /api/* handler (handle)

"use strict";

const { createWorkspace, createBrowser } = require("./fs");
const { createApi } = require("./api");
const { buildTools, createRegistry } = require("./tools");
const { createOrient, channelOf } = require("./orient");

// ---- stubs used when no pluginHost is wired --------------------------------
//
// On a deployment that has no ClientRun components (e.g. a test environment
// that only exercises workspace / project / history routes), `pluginHost` is
// omitted. The stubs below satisfy orient's interface without crashing:
// - `stubHost.unavailable` is the message orient emits in moduleBlockedReason
//   for non-client components ("any non-ClientRun component is unavailable on B
//   because B has no local process to run it").
// - `stubClient` returns a non-null reason for every name, so moduleBlockedReason
//   never falls through to a silent null.

function stubHost() {
  return {
    resolve: () => null,
    unavailable: (name) => `${name} is not available on this deployment`,
  };
}

function stubClient() {
  return {
    reasonFor: (name) => `no plugin host configured (${name})`,
    send: async () => {
      throw new Error("no plugin host configured on this deployment");
    },
  };
}

// ---- createBHost -----------------------------------------------------------

function createBHost(options = {}) {
  const {
    shell,
    render,
    pluginHost = null,
    components = () => null,
    config = {},
  } = options;

  if (typeof render !== "function") throw new TypeError("createBHost: render(name, vars) is required");
  if (!shell || typeof shell.run !== "function") throw new TypeError("createBHost: shell.run is required");

  // One browser per host: `createBrowser` issues a single `echo $HOME` to
  // learn the far user's home directory; every workspace and every fsList call
  // share that result.  The browser is NOT a workspace — it exists before any
  // project is open, so the project picker can list directories immediately.
  const browser = createBrowser({ transport: shell });

  // ---- RunState ----------------------------------------------------------
  //
  // Mirrors agent/base.py:RunState. The three public fields (`workspace`,
  // `project`, `busy`) are read directly by the api.js route handlers;
  // `buildWorkspace` and `setProject` are the two mutating operations.
  //
  // `fsList` is wired to the browser so `/api/fs/list` works before any project
  // is opened (the directory picker needs it to list the far home).
  const state = {
    workspace: null,
    project: null,
    busy: false,
    fsList: browser.fsList,
    config,

    // Build a workspace rooted at `root` over the far shell.  Every call
    // creates a fresh workspace object; the caller decides whether to keep it
    // (state.setProject) or discard it.
    buildWorkspace(root) {
      return createWorkspace({ root, browser });
    },

    // Replace the active project (and optionally the workspace).  The old
    // project's lock is not held in JS (plan §4: no ProjectLock on B), so
    // this is a plain assignment.  Pass null to clear.
    setProject(project, ws = null) {
      state.project = project || null;
      if (ws !== null) state.workspace = ws;
    },
  };

  // ---- channel and host stubs for orient ---------------------------------
  //
  // `client` (channelOf) is the seam orient uses to drive ClientRun
  // components; on B every registered component is a ClientRun, so this is
  // the only code path that should ever be reached.
  //
  // `host` (artifact resolver) is the seam orient uses for Resident/PerCall
  // components — those need a local binary / Python interpreter, which B does
  // not have.  host.resolve always returns null; host.unavailable returns the
  // "not on this deployment" sentence that moduleBlockedReason shows to the
  // model.
  const client = pluginHost ? channelOf(pluginHost) : stubClient();
  const host = pluginHost || stubHost();

  // ---- orient: prepare + runStatement ------------------------------------
  //
  // `createOrient` closes over `render`, `components`, `host`, and `client`.
  // Its `runStatement` method is passed to `buildTools` below so that every
  // ExtensionTool carries the same dispatch logic.
  const orient = createOrient({ render, components, host, client });

  // ---- tools and registry ------------------------------------------------
  //
  // `buildTools` returns the wired tool declarations (SystemTools + the
  // component ExtensionTools for any registered component).  `createRegistry`
  // wraps them in the lookup table the run loop calls.
  //
  // `entries` is null: B has no fact publisher (no `facts.py` equivalent), so
  // the `skills` gate is always closed — the same verdict as "no skills
  // configured", which is correct for a deployment that has no local backend.
  const tools = buildTools({ config, render, runStatement: orient.runStatement, entries: null });
  const registry = createRegistry({ tools, config, render });

  // ---- in-process /api/* handler -----------------------------------------
  //
  // `createApi(state)` registers all route handlers that close over `state`.
  // Mutating `state.workspace`, `state.project`, or `state.busy` after this
  // call is safe: the routes read from the live object on every request.
  const api = createApi(state);

  return { handle: api.handle, api, state, orient, registry };
}

module.exports = { createBHost };
