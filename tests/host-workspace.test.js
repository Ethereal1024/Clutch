"use strict";

// The M1 port, replayed against the M0 goldens.
//
// `tests/conform.test.js` proves the goldens are complete and untouched; this
// file proves `ui/host/*.js` ANSWERS them. It is a REPLAY, not a re-creation: the
// request for every case is built from the golden's own `path` and `request`
// (with the <ROOT>/<HOME>/<TMP> tokens expanded back to this run's temp dirs),
// so the assertions cannot drift from what `tests/conformance_capture.py` sent to
// the Python host. The scenario ORDER mirrors the capture's: the journal is
// seeded where the capture seeded it, the .clc is protected after a run would
// have claimed it, `busy` is set for exactly one call.
//
// The far side is a real POSIX shell (`sh -c`) rooted in a temp fixture tree —
// the same trick `tests/conform.test.js` uses for the four tools. That is a
// CO-LOCATED FAR ROOT, not the local-root capability deployment B must never
// have (docs/ssh-scheme-plan.md §7, ban X1): nothing here reads or writes the
// app host's own project directories through a workspace API.
//
// Run: node tests/host-workspace.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { check, summary } = require("./harness");

const FIX = path.resolve(__dirname, "fixtures", "conformance");
const HOST = path.resolve(__dirname, "..", "ui", "host");
const { createBrowser, createWorkspace } = require(path.join(HOST, "fs.js"));
const { createApi } = require(path.join(HOST, "api.js"));
const { createProject, streamOpen } = require(path.join(HOST, "clc.js"));

// The endpoints whose `/api/*` answers this replay compares. `conform.test.js`
// cross-checks this list against the `enforced` markers in the manifest, so a
// route cannot be declared enforced without being replayed here, and a route
// replayed here cannot stay `pending`.
const COVERED = [
  "workspace.tree",
  "workspace.revert",
  "workspace.checkpoints",
  "workspace.rollback",
  "fs.list",
  "routing",
  "project.lifecycle",
  "history",
];

// ---- the fixture tree, byte for byte what the capture used ----------------

const FIXTURE_FILES = {
  "alpha.txt": "alpha\nbeta\ngamma\n",
  "gamma.txt": "created by task two\n",
  "sub/beta.md": "# beta\n\nfixed\n",
  "sub/deep/leaf.txt": "leaf\n",
  ".hidden.txt": "hidden\n",
};
const PROJECT_NAME = "demo";
// log offsets, not line numbers: two distinct values pin `rollbackAnchors`
const ANCHOR_A = 1024;
const ANCHOR_B = 4096;

const TEMP_DIRS = [];

function writeFixture(root) {
  for (const [rel, text] of Object.entries(FIXTURE_FILES)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, "utf8");
  }
}

// ---- the far side --------------------------------------------------------

// A transport with `run(command, {timeout, binary})` — the same shape
// `ui/tunnel-remote.js` has — answered by a real `sh` whose HOME is the fixture
// home, so `echo $HOME` and `~` expansion mean something in the test.
function farShell(home) {
  const state = { calls: 0, commands: [] };
  function run(command, options = {}) {
    state.calls += 1;
    state.commands.push(String(command));
    const result = spawnSync("sh", ["-c", String(command)], {
      cwd: home,
      env: Object.assign({}, process.env, { HOME: home, LC_ALL: "C" }),
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = result.stdout || Buffer.alloc(0);
    const answer = {
      code: typeof result.status === "number" ? result.status : -1,
      stderr: String(result.stderr || ""),
    };
    // mirror the real channel: text unless the caller asked for bytes
    if (options.binary) answer.stdout_b64 = out.toString("base64");
    else answer.stdout = out.toString("utf8");
    return answer;
  }
  return { run, state };
}

// ---- comparing an answer with a golden -----------------------------------
//
// Same rules as the manifest's `comparison`: status equals, the body's canonical
// JSON equals, and a `masked` field is compared by TYPE only. Paths are
// normalized with the same longest-prefix-first tokens the capture wrote.

function makeNormalizer(pairs) {
  const ordered = pairs.filter((pair) => pair[0]).sort((a, b) => b[0].length - a[0].length);
  function text(value) {
    let out = String(value);
    for (const [prefix, token] of ordered) if (out.includes(prefix)) out = out.split(prefix).join(token);
    return out;
  }
  function value(v) {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(value);
    if (v && typeof v === "object") {
      const out = {};
      for (const key of Object.keys(v)) out[key] = value(v[key]);
      return out;
    }
    return v;
  }
  return { text, value };
}

// Python's `type(v).__name__`, which is what `_mask` records
function maskKind(v) {
  if (Array.isArray(v)) return "list";
  if (v === null) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  return typeof v;
}

function maskFields(body, keys) {
  const out = Object.assign({}, body);
  for (const key of keys) {
    if (!(key in out)) continue;
    const value = out[key];
    // the golden already carries the marker; masking it again would compare
    // "object" against "list" and fail on a correct answer
    if (value && typeof value === "object" && !Array.isArray(value) && "__masked__" in value) continue;
    out[key] = { __masked__: maskKind(value) };
  }
  return out;
}

// canonical JSON: sorted keys, arrays in order (the golden's own spelling)
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// ---- the replay ----------------------------------------------------------

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-conform-"));
  TEMP_DIRS.push(base);
  // <TMP>/work is the project, <TMP>/home is the far user's home: the capture's
  // root sat in its temp dir, and the picker's default listing is that home.
  const root = path.join(base, "work");
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  writeFixture(root);
  // `POST /api/project/new` is now an M4 route: the replay calls it to create
  // demo.clc, so the manual pre-creation is no longer needed.

  const normalizer = makeNormalizer([
    [root, "<ROOT>"],
    [home, "<HOME>"],
    [base, "<TMP>"],
  ]);
  // the goldens carry tokens; this is the reverse, so the request is the one the
  // capture actually sent (longest token first: <ROOT> sits inside <TMP>)
  const expand = (text) =>
    String(text)
      .split("<ROOT>")
      .join(root)
      .split("<HOME>")
      .join(home)
      .split("<TMP>")
      .join(base);

  const manifest = JSON.parse(fs.readFileSync(path.join(FIX, "manifest.json"), "utf8"));
  const cases = new Map(); // case id -> {endpoint, case, seen}
  for (const id of COVERED) {
    const ep = manifest.endpoints.find((row) => row.id === id);
    check(Boolean(ep), `${id}: the manifest lists the endpoint`);
    if (!ep) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(FIX, ep.file), "utf8"));
    for (const one of doc.cases) {
      check(!cases.has(one.id), `${one.id}: case ids are unique across the replayed set`);
      cases.set(one.id, { endpoint: id, case: one, seen: false });
    }
  }

  const shell = farShell(home);
  const browser = createBrowser({ transport: shell });
  let workspace = null;

  // M4: a single mutable state object so `buildWorkspace` / `setProject` are
  // available to the project-lifecycle routes throughout the whole replay.
  const mainState = {
    workspace: null,
    project: null,
    busy: false,
    fsList: browser.fsList,
    fsMkdir: browser.fsMkdir,
    config: {},
  };
  mainState.buildWorkspace = (r) => createWorkspace({ root: r, browser });
  mainState.setProject = (project, ws = null) => {
    mainState.project = project || null;
    if (ws !== null) mainState.workspace = ws;
  };
  let api = createApi(mainState);

  async function replay(cid) {
    const entry = cases.get(cid);
    check(Boolean(entry), `${cid}: is a case this replay knows`);
    if (!entry) return null;
    if (entry.seen) check(false, `${cid}: replayed once`);
    entry.seen = true;
    const one = entry.case;
    const route = expand(one.path);
    let body;
    if (one.request && Object.prototype.hasOwnProperty.call(one.request, "raw")) body = one.request.raw;
    else if (one.request) body = JSON.stringify(normalizeRequest(one.request));
    const got = await api.handle(one.method, route, body);
    check(got.status === one.status, `${cid}: ${one.method} ${one.path} -> ${one.status} (got ${got.status})`);
    if (one.ndjson) {
      // NDJSON response: compare the collected line array after normalizing real paths
      const wantLines = one.ndjson;
      const haveLines = (got.ndjson || []).map((x) => normalizer.value(x));
      check(canon(wantLines) === canon(haveLines), `${cid}: ndjson matches the golden`);
      if (canon(wantLines) !== canon(haveLines)) {
        console.log(`   want: ${canon(wantLines)}`);
        console.log(`   got : ${canon(haveLines)}`);
      }
    } else {
      const want = one.masked ? maskFields(normalizer.value(one.body), one.masked) : normalizer.value(one.body);
      const have = one.masked ? maskFields(normalizer.value(got.body), one.masked) : normalizer.value(got.body);
      if (want !== undefined || have !== undefined) {
        check(canon(want) === canon(have), `${cid}: body matches the golden`);
        if (canon(want) !== canon(have)) {
          console.log(`   want: ${canon(want)}`);
          console.log(`   got : ${canon(have)}`);
        }
      }
    }
    return got;
  }

  // Expand <ROOT>/<HOME>/<TMP> tokens in request fields (e.g. `dir`, `path`)
  // before JSON-encoding them, so the route receives real filesystem paths.
  function normalizeRequest(req) {
    if (!req || typeof req !== "object" || Array.isArray(req)) return req;
    const out = {};
    for (const key of Object.keys(req)) {
      const v = req[key];
      out[key] = typeof v === "string" ? expand(v) : v;
    }
    return out;
  }

  // ---- history: no project open yet ---------------------------------------
  // Must run before project.new so state.project is null.
  await replay("history.no-project");

  // ---- project new --------------------------------------------------------
  // Creates demo.clc in the fixture root; subsequent replays (including the
  // tree golden which expects the file to be present) rely on it existing.
  await replay("project.new.ok");
  await replay("project.new.missing-name");

  // ---- project open -------------------------------------------------------
  // Open the just-created demo.clc.  These replays set state.project to the
  // real project object, which the workspace tests below then overwrite with
  // their own stubs.
  await replay("project.open.ok");
  await replay("project.open.read-only");

  // ---- before workspace is open -------------------------------------------
  // (the capture's `_no_project`: every one of these is the same "nothing here
  // yet" answer, not an exception)
  api.state.workspace = null;
  api.state.project = null;
  await replay("tree.no-workspace");
  await replay("checkpoints.no-workspace");
  await replay("revert.no-workspace");
  await replay("rollback.no-workspace");

  // ---- the project is open ------------------------------------------------
  workspace = createWorkspace({ root, browser });
  api.state.workspace = workspace;
  api.state.project = { readOnly: false };
  api.state.busy = false;

  // One exec per tree LEVEL, not per directory: `listMany` is the only real
  // capability gap the plan found in the JS port (§3 P1), so the round-trip count
  // is part of the contract these cases pin.
  for (const [cid, tripes] of [
    ["tree.root", 2], // root, then sub
    ["tree.hidden", 2],
    ["tree.expanded", 3], // root, sub, sub/deep
  ]) {
    const before = shell.state.calls;
    await replay(cid);
    const used = shell.state.calls - before;
    check(used === tripes, `${cid}: ${tripes} exec(s) for the whole walk (got ${used})`);
  }

  await replay("fs.list.dir");
  await replay("fs.list.not-a-directory");
  await replay("fs.list.unknown-path");
  await replay("fs.list.home"); // the one listing that is masked: shape, not home contents

  await replay("checkpoints.fresh");

  await replay("revert.no-snapshot");
  await replay("revert.escape");
  await replay("revert.no-path");
  await replay("revert.bad-json");

  await replay("rollback.no-record");
  await replay("rollback.bad-offset-missing");
  await replay("rollback.bad-offset-negative");
  await replay("rollback.bad-offset-boolean");
  await replay("rollback.bad-offset-string");
  await replay("rollback.bad-json");

  // the router answers before it has any session routes, which is also what the
  // Python host does for a route it does not have
  await replay("routing.unknown-get");
  await replay("routing.unknown-post");

  // ---- a run has claimed the project: the .clc leaves the tree ------------
  const clc = path.join(root, `${PROJECT_NAME}.clc`);
  workspace.protect(clc); // exactly what `start_task` does for every run
  await replay("tree.protected");
  await replay("revert.protected");

  // ---- the journal -------------------------------------------------------
  const alpha = path.join(root, "alpha.txt");
  const beta = path.join(root, "sub", "beta.md");
  const gamma = path.join(root, "gamma.txt");

  // the undo stack is seeded through the public API — the same call the
  // write_file/edit_file tools make before an overwrite
  workspace.snapshot(alpha, "alpha\n");
  await replay("revert.ok");
  check(fs.readFileSync(alpha, "utf8") === "alpha\n", "revert.ok: the file really is back to its snapshot");

  workspace.beginTurn(ANCHOR_A);
  workspace.recordMutation(alpha, true, FIXTURE_FILES["alpha.txt"]);
  workspace.beginTurn(ANCHOR_B);
  workspace.recordMutation(gamma, false);
  workspace.recordMutation(beta, true, FIXTURE_FILES["sub/beta.md"]);
  await replay("checkpoints.anchors");

  await replay("rollback.ok");
  // the report is half the answer; the tree is the other half
  check(fs.readFileSync(alpha, "utf8") === FIXTURE_FILES["alpha.txt"], "rollback.ok: an overwritten file is restored");
  check(fs.readFileSync(beta, "utf8") === FIXTURE_FILES["sub/beta.md"], "rollback.ok: a nested overwrite is restored");
  check(!fs.existsSync(gamma), "rollback.ok: a file the task CREATED is deleted");

  // guards: the journal is left untouched by both refusals, so the read-only
  // case must answer 409 without an anchor of its own
  workspace.beginTurn(ANCHOR_B);
  workspace.recordMutation(alpha, true, "x");
  api.state.busy = true;
  await replay("rollback.run-active");
  api.state.busy = false;
  api.state.project = { readOnly: true };
  await replay("rollback.read-only");

  // ---- the workspace domain itself (not reachable through these routes) ---
  // The six capabilities P1 needs before the Python ssh branch can go, exercised
  // on bytes rather than through a golden: a write that loses a newline or a
  // read that decodes what it should have passed through is exactly the port bug
  // no payload comparison would catch.

  await workspace.write("made.txt", "hello\nworld\n");
  check(fs.readFileSync(path.join(root, "made.txt"), "utf8") === "hello\nworld\n", "write: exact bytes");
  await workspace.write("deep/er/new.txt", "");
  check(fs.readFileSync(path.join(root, "deep/er/new.txt"), "utf8") === "", "write: an empty body still creates the file");
  await workspace.appendLine("made.txt", '{"n":1}');
  check(
    fs.readFileSync(path.join(root, "made.txt"), "utf8") === 'hello\nworld\n{"n":1}\n',
    "appendLine: exactly one LF per line (the .clc offset arithmetic depends on it)"
  );
  check((await workspace.read("made.txt")) === 'hello\nworld\n{"n":1}\n', "read: text round-trip");
  check((await workspace.size("made.txt")) === 20, "size: wc -c counts bytes, not characters");
  check((await workspace.readRange("made.txt", 6, 11)).toString("utf8") === "world", "readRange: a byte window");
  await workspace.writeAt("made.txt", 6, "WORLD");
  check(fs.readFileSync(path.join(root, "made.txt"), "utf8") === 'hello\nWORLD\n{"n":1}\n', "writeAt: in place, no truncation");
  await workspace.delete("made.txt");
  check(!fs.existsSync(path.join(root, "made.txt")), "delete: removes the file");
  await workspace.delete("made.txt"); // rm -f: already gone is not an error
  check(true, "delete: a path that is already gone is not an error");

  // bytes are not text: a range may cut a multibyte character in half and the
  // caller must get the raw head bytes, or the .clc reader corrupts memory
  await workspace.write("uni.txt", "é!\n");
  const half = await workspace.readRange("uni.txt", 0, 1);
  check(Buffer.isBuffer(half) && half.length === 1 && half[0] === 0xc3, "readRange: binary mode returns raw bytes mid-character");

  // a body larger than one exec is chunked, and the file is still byte-exact
  const big = "x".repeat(20000);
  const beforeBig = shell.state.calls;
  await workspace.write("big.txt", big);
  check(fs.readFileSync(path.join(root, "big.txt"), "utf8") === big, "write: a 20 KB body survives the 3.5 KB chunk budget");
  check(shell.state.calls - beforeBig > 1, "write: a large body really is sent in several execs");

  // path safety: one ValueError, one per-call grant
  let escaped = null;
  try {
    await workspace.read("../escape");
  } catch (e) {
    escaped = e;
  }
  check(escaped && escaped.name === "ValueError", "resolve: an escape raises ValueError (the API's 400)");
  check((await workspace.escapePath("../x")) === path.join(base, "x"), "escapePath: a token outside the root is named");
  const outside = path.join(home, "allowed.txt");
  fs.writeFileSync(outside, "ok\n", "utf8");
  let denied = null;
  try {
    await workspace.read(outside);
  } catch (e) {
    denied = e;
  }
  check(denied && denied.name === "ValueError", "resolve: an absolute path outside the root is refused");
  workspace.allow([outside]);
  check((await workspace.read(outside)) === "ok\n", "allow: a granted absolute path is readable");
  workspace.clearAllowed();
  denied = null;
  try {
    await workspace.read(outside);
  } catch (e) {
    denied = e;
  }
  check(denied && denied.name === "ValueError", "clearAllowed: the grant lasts one tool call");

  // listMany: the P1 gap. Several directories, ONE round trip.
  const beforeList = shell.state.calls;
  const many = await workspace.listMany(["sub", "sub/deep", "nope"]);
  check(shell.state.calls - beforeList === 1, "listMany: three directories in ONE exec");
  check(canon(many.sub) === canon(["deep/", "beta.md"]), "listMany: dirs before files, dirs suffixed");
  check(canon(many["sub/deep"]) === canon(["leaf.txt"]), "listMany: a nested level");
  check(canon(many.nope) === canon([]), "listMany: a missing directory is [] not an error");

  // the protected filter is keyed by ABSOLUTE path: a nested file that happens to
  // share the .clc's name is still the agent's to see
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "sub", `${PROJECT_NAME}.clc`), "", "utf8");
  const nested = await workspace.listMany(["sub"]);
  check(nested.sub.includes(`${PROJECT_NAME}.clc`), "listMany: the protected filter is per directory, not per file name");
  fs.unlinkSync(path.join(root, "sub", `${PROJECT_NAME}.clc`));

  // ---- the picker's write side: mkdir -------------------------------------
  //
  // No goldens cover these (they are new on both hosts, so the capture has
  // nothing to freeze yet), so this section states the contract directly — the
  // same statuses and sentences `agent/api/workspace.py` answers, which
  // `tests/picker_api_test.py` pins on the Python side.

  await api.handle("POST", "/api/fs/mkdir", JSON.stringify({ dir: root, name: "fresh" }));
  check(fs.existsSync(path.join(root, "fresh")) && fs.statSync(path.join(root, "fresh")).isDirectory(), "mkdir: creates the folder the row names");
  let mk = await api.handle("POST", "/api/fs/mkdir", JSON.stringify({ dir: root, name: "fresh" }));
  check(mk.status === 200 && mk.body.error === "already exists: fresh", "mkdir: a taken name is 200 data, not an error status");
  mk = await api.handle("POST", "/api/fs/mkdir", JSON.stringify({ dir: root, name: "a/b" }));
  check(mk.status === 400 && mk.body.error === "a name cannot contain a path separator or a control character", "mkdir: a separator is the client's 400");
  mk = await api.handle("POST", "/api/fs/mkdir", JSON.stringify({ dir: root, name: ".." }));
  check(mk.status === 400 && mk.body.error === "that name is reserved", "mkdir: .. names a directory, not a new entry");
  mk = await api.handle("POST", "/api/fs/mkdir", "not json");
  check(mk.status === 400 && mk.body.error === "bad json body", "mkdir: a body that is not an object is 400");

  // ---- the create's one refusal: a file is already there ------------------
  //
  // The write that must never happen: `POST /api/project/new` over an existing
  // .clc would truncate a whole conversation. Both hosts answer it the same way
  // — 409 + `project_exists`, the same sentence — and the file keeps every byte
  // it had. (Not a golden yet: the capture has no such case to freeze, so this
  // states the contract the way the mkdir section above does.)

  const kept = "# clutch project v1\nname: kept\n---\n";
  fs.writeFileSync(path.join(root, "kept.clc"), kept, "utf8");
  api.state.busy = false;
  let create = await api.handle("POST", "/api/project/new", JSON.stringify({ dir: root, name: "kept" }));
  check(create.status === 409, `new: an existing .clc is a 409 (got ${create.status})`);
  check(create.body.code === "project_exists", `new: the refusal carries the code (got ${create.body.code})`);
  check(create.body.error === "kept.clc already exists — open it instead", `new: and says what to do: ${create.body.error}`);
  check(fs.readFileSync(path.join(root, "kept.clc"), "utf8") === kept, "new: the refused create left the .clc byte-for-byte alone");
  // `withSuffix` is the path the create WRITES: a typed "kept.txt" is kept.clc
  create = await api.handle("POST", "/api/project/new", JSON.stringify({ dir: root, name: "kept.txt" }));
  check(create.status === 409 && create.body.code === "project_exists", "new: a name that only differs in extension maps to the same .clc");
  check(fs.readFileSync(path.join(root, "kept.clc"), "utf8") === kept, "new: and nothing was truncated for it either");
  // the guard refuses a file, not a name: a free one still creates
  create = await api.handle("POST", "/api/project/new", JSON.stringify({ dir: root, name: "fresh-one" }));
  check(create.status === 200, `new: a free name still creates (got ${create.status}: ${JSON.stringify(create.body)})`);
  check(fs.existsSync(path.join(root, "fresh-one.clc")), "new: and the file is on the far side");

  // ---- every case the marker claims was actually replayed ----------------
  for (const [cid, entry] of cases) check(entry.seen, `${cid}: replayed`);
  check(cases.size > 35, `the replay covers the M1+M4 contract (${cases.size} cases)`);

  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  summary("host-workspace");
}

// `farShell` is shared with tests/host-clc.test.js: one double, so the .clc
// replay and the `/api/*` replay cannot disagree about what "the far side" is.
module.exports = { COVERED, farShell };

if (require.main === module) {
  main().catch((e) => {
    check(false, `suite crashed: ${(e && e.stack) || e}`);
    summary("host-workspace");
  });
}
