// The in-process `/api/*` table the renderer talks to on deployment B.
//
// On A and C the renderer is an HTTP client of the Python host. On B there is no
// process to be a client OF: the same requests are answered by a function call in
// the Electron main process. That makes this file a SHAPE port, not a rewrite —
// every route below is `agent/api/*.py` with the same statuses, the same error
// strings, and the same JSON bodies, because the renderer cannot tell which host
// answered (plan §5).
//
// The statuses and sentences are NOT incidental. `no workspace open` answers both
// "no workspace" and "you sent no path"; `not a directory: …` is an HTTP 200 with
// a non-null `error`; `offset (a non-negative integer) is required` is one answer
// for four different bad inputs. The goldens in `tests/fixtures/conformance/`
// froze all of them from the Python host, and `tests/host-workspace.test.js`
// replays them against this file.
//
// M1 covers the workspace domain: the tree, undo, checkpoints, whole-task
// rollback, and the directory picker. The session routes (run/events/history)
// arrive with M2 and M4; an unimplemented route answers exactly what an unknown
// route answers, which is also what the Python host does for a route it does not
// have — so a half-built host cannot lie about being complete.
//
// createApi(state) -> {handle, routes, has(route)}
//   state = {workspace, project, busy, fsList}   (the RunState fields these routes read)
//   M4 routes also read:
//     state.buildWorkspace(root) -> workspace  (injected by index.js)
//     state.setProject(project, ws)            (injected by index.js)
//     state.config                             (host config; model name for createProject)
//   the picker's write side reads the browser itself, so it works before a
//   project (and therefore a workspace) exists — same fallback as fsList:
//     state.fsMkdir(dir, name) -> {path, error}   (+ Folder)

"use strict";

const { ValueError, dirname } = require("./fs");
const { createProject, streamOpen, eventToJson, ProjectExists } = require("./clc");

// A route the host does not answer (yet) and a route that does not exist are the
// same answer, because the renderer's only question is "did this work".
const NOT_FOUND = { status: 404, body: { error: "not found" } };

function json(body, status = 200) {
  return { status, body };
}

// Parse one level of the query string. `parse_qs` in Python collects repeated
// keys; URLSearchParams is the same thing with the same encoding rules, and
// `getAll` is what `expanded=a&expanded=b` needs.
function query(route) {
  const at = String(route).indexOf("?");
  return new URLSearchParams(at < 0 ? "" : String(route).slice(at + 1));
}

function pathname(route) {
  const text = String(route);
  const at = text.indexOf("?");
  return at < 0 ? text : text.slice(0, at);
}

// `agent/api/base.py: _read_body` — a body that is not a JSON OBJECT is the same
// user error as a body that is not JSON at all (so `null`, `[]` and `"x"` all
// answer `bad json body`, and so does an empty body).
function readBody(raw) {
  if (raw === undefined || raw === null) return null;
  let value = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) {
    try {
      value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
    } catch (error) {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function createApi(state = {}) {
  const routes = new Map();

  function route(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }

  // ---- the workspace ------------------------------------------------------

  // `{tree, root}` — dirs before files, hidden filtered unless asked for, and a
  // lazy partial walk (only the root, the expanded dirs, and one level below).
  route("GET", "/api/workspace/tree", async (api, req) => {
    const qs = query(req.route);
    const expanded = qs.getAll("expanded");
    const showHidden = qs.get("hidden") === "1";
    const workspace = state.workspace;
    if (!workspace) return json({ tree: [], root: null });
    return json({ tree: await workspace.tree(expanded, showHidden), root: String(workspace.root) });
  });

  // User-side undo: restore the last snapshot of a file (the write/edit tools
  // record one before every overwrite). Backs the "↶ undo" button.
  route("POST", "/api/workspace/revert", async (api, req) => {
    const body = readBody(req.body);
    if (body === null) return json({ error: "bad json body" }, 400);
    const path = String(body.path == null ? "" : body.path).trim();
    const workspace = state.workspace;
    // no workspace and no path share one answer on purpose: the client's problem
    // is the same either way, and it has one sentence for it
    if (!workspace || !path) return json({ error: "no workspace open" }, 400);
    let target;
    try {
      target = await workspace.resolve(path);
    } catch (error) {
      if (error instanceof ValueError) return json({ error: error.message }, 400);
      throw error;
    }
    if (workspace.isProtected(target)) return json({ error: "protected file" }, 400);
    const content = await workspace.restore(target);
    if (content === null) return json({ error: "no snapshot to restore" }, 404);
    return json({ status: "ok", path: String(target) });
  });

  // Which tasks a whole-task rollback can be offered for: the journal's anchors,
  // the log offsets under which file mutations were recorded. A task that changed
  // nothing is absent on purpose — "roll back to here" would restore exactly the
  // state the workspace is already in.
  route("GET", "/api/workspace/checkpoints", async () => {
    const workspace = state.workspace;
    return json({ anchors: workspace ? workspace.rollbackAnchors() : [] });
  });

  // Roll the workspace back to a sent task: undo every file mutation recorded at
  // or after that task's log offset, newest first. Refused while a run is live
  // (409) — the run is writing those files right now.
  route("POST", "/api/workspace/rollback", async (api, req) => {
    const body = readBody(req.body);
    if (body === null) return json({ error: "bad json body" }, 400);
    const offset = body.offset;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      return json({ error: "offset (a non-negative integer) is required" }, 400);
    }
    const workspace = state.workspace;
    if (!workspace) return json({ error: "no workspace open" }, 400);
    if (state.busy) return json({ error: "a run is active; stop it before rolling back" }, 409);
    const project = state.project;
    if (project && project.readOnly) {
      return json({ error: "project was opened read-only; it cannot be rolled back here" }, 409);
    }
    const report = await workspace.rollbackFrom(offset);
    if (report === null) return json({ error: "no recorded changes for that task" }, 404);
    return json({
      status: "ok",
      restored: report.restored,
      deleted: report.deleted,
      count: report.restored.length + report.deleted.length,
    });
  });

  // ---- the project picker's directory browser ----------------------------

  // One level, starting at the far user's home. A non-directory is an HTTP 200
  // with `error` set — the UI checks data.error, and this is the answer the
  // Python host has always given.
  //
  // The picker OUTLIVES any one workspace: before a project is open there is
  // still a far shell to browse, so the host passes the browser in as
  // `state.fsList`. A workspace exposes the same function (one `echo $HOME`,
  // one envelope), so a driver that only has a workspace still answers.
  route("GET", "/api/fs/list", async (api, req) => {
    const qs = query(req.route);
    const raw = qs.get("path") || "";
    const showHidden = qs.get("hidden") === "1";
    const listing = state.fsList || (state.workspace && state.workspace.fsList);
    if (typeof listing !== "function") {
      // no far shell and no workspace: the host was built without either, which
      // is a wiring bug, not an empty directory. Answering `entries: []` here
      // would render as a home with nothing in it and hide the bug.
      return json({ error: "no workspace open" }, 400);
    }
    return json(await listing(raw, showHidden));
  });

  // Stat a path: type is "dir", "file", or "none". Used by the address bar to
  // route an input — navigate into a directory, open a .clc file, or offer to
  // create when nothing is there yet.
  route("GET", "/api/fs/stat", async (api, req) => {
    const qs = query(req.route);
    const raw = qs.get("path") || "";
    const stat = state.fsStat || (state.browser && state.browser.fsStat);
    if (typeof stat !== "function") return json({ error: "no workspace open" }, 400);
    return json(await stat(raw));
  });

  // One new folder inside the directory on screen — the picker's "+ Folder".
  // A bad name is the client's mistake (400); a name already taken is an answer
  // the row shows in place (200 + error), the same split /api/project/new uses
  // for a create it could not perform.
  route("POST", "/api/fs/mkdir", async (api, req) => {
    const body = readBody(req.body);
    if (body === null) return json({ error: "bad json body" }, 400);
    const mkdir = state.fsMkdir || (state.browser && state.browser.fsMkdir);
    if (typeof mkdir !== "function") return json({ error: "no workspace open" }, 400);
    const rawDir = String(body.dir == null ? "" : body.dir).trim();
    const name = String(body.name == null ? "" : body.name);
    const result = await mkdir(rawDir, name);
    if (result.path === null || result.path === undefined) return json({ error: result.error }, 400);
    return json(result);
  });

  // ---- project lifecycle -------------------------------------------------

  // Create a fresh .clc at dir/name. `state.buildWorkspace` and `state.setProject`
  // are injected by `index.js`; if they are absent the host is wired incorrectly.
  route("POST", "/api/project/new", async (api, req) => {
    if (state.busy) return json({ error: "a run is active; wait for it to finish" }, 409);
    const body = readBody(req.body);
    if (body === null) return json({ error: "bad json body" }, 400);
    const dir = String(body.dir == null ? "" : body.dir).trim();
    const name = String(body.name == null ? "" : body.name).trim();
    if (!dir || !name) return json({ error: "dir and name are required" }, 400);
    const ws = state.buildWorkspace(dir);
    let project;
    try {
      project = await createProject({
        path: dir + "/" + name,
        name,
        model: String((state.config && state.config.model) || ""),
        workspace: ws,
      });
    } catch (e) {
      // a name already taken by a file: a create never truncates a project, so
      // the answer is the same 409 + code the Python host gives
      if (e instanceof ProjectExists) {
        const base = String(e.path).replace(/\/+$/, "");
        const slash = base.lastIndexOf("/");
        return json(
          {
            error: `${slash >= 0 ? base.slice(slash + 1) : base} already exists — open it instead`,
            code: "project_exists",
          },
          409
        );
      }
      return json({ error: `cannot create project: ${(e && e.message) || e}` }, 400);
    }
    if (typeof state.setProject === "function") state.setProject(project, ws);
    return json({ status: "ok", project: String(project.path), name: project.meta.name, workdir: dir });
  });

  // Open an existing .clc; the NDJSON body is streamed as a collected array so
  // in-process callers do not need a streaming interface.
  // Returns `{status, ndjson: object[]}` for NDJSON, `{status, body}` for errors.
  route("POST", "/api/project/open", async (api, req) => {
    if (state.busy) return json({ error: "a run is active; wait for it to finish" }, 409);
    const body = readBody(req.body);
    if (body === null) return json({ error: "bad json body" }, 400);
    const pathVal = String(body.path == null ? "" : body.path).trim();
    if (!pathVal) return json({ error: "path is required" }, 400);
    const readOnly =
      Boolean(body.read_only) ||
      String(body.read_only == null ? "" : body.read_only).toLowerCase() === "true";
    const ws = state.buildWorkspace(dirname(pathVal));
    const lines = [];
    let project;
    try {
      project = await streamOpen({
        path: pathVal,
        workspace: ws,
        readOnly,
        emit: (obj) => lines.push(obj),
      });
    } catch (e) {
      return json({ error: `cannot open project: ${(e && e.message) || e}` }, 400);
    }
    if (typeof state.setProject === "function") state.setProject(project, ws);
    return { status: 200, ndjson: lines };
  });

  // ---- history -----------------------------------------------------------

  // Scroll-up paging for the lazily-opened project log. `before` and `limit`
  // are byte offsets. `align=turn` widens the page back to the task boundary.
  route("GET", "/api/history", async (api, req) => {
    const qs = query(req.route);
    let before = 0;
    let limit = 262144;
    try {
      const rawBefore = qs.get("before");
      const rawLimit = qs.get("limit");
      before = rawBefore !== null ? Math.max(0, parseInt(rawBefore, 10)) : 0;
      limit =
        rawLimit !== null
          ? Math.min(Math.max(parseInt(rawLimit, 10), 4096), 4 * 1024 * 1024)
          : 262144;
      if (isNaN(before) || isNaN(limit)) return json({ error: "bad query" }, 400);
    } catch (e) {
      return json({ error: "bad query" }, 400);
    }
    const rawAlign = qs.get("align");
    const align = rawAlign === "1" || rawAlign === "turn" || rawAlign === "true";
    const project = state.project;
    const log = project && project.log ? project.log : null;
    if (!log) return json({ events: [], older: 0 });
    let lo = Math.max(0, before - limit);
    if (align) lo = log.alignedStart(lo);
    const pairs = log.readPage(lo, before);
    return json({
      events: pairs.map(([off, ev]) => ({ offset: off, event: JSON.parse(eventToJson(ev)) })),
      older: Math.max(0, lo),
    });
  });

  async function handle(method, routePath, body) {
    const key = `${String(method || "GET").toUpperCase()} ${pathname(routePath)}`;
    const handler = routes.get(key);
    if (!handler) return { ...NOT_FOUND };
    return handler(api, { route: String(routePath), body });
  }

  const api = {
    state,
    handle,
    routes,
    has: (method, routePath) => routes.has(`${String(method).toUpperCase()} ${pathname(routePath)}`),
  };
  return api;
}

module.exports = { createApi, readBody, query, pathname, NOT_FOUND };
