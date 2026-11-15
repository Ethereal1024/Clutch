"use strict";

// The two Python specs M5 deletes, ported to the far-root host.
//
// `tests/remote_path_test.py` and the MockBridge half of
// `tests/transport_test.py` are `RemoteWorkspace`'s specification: a remote path
// is NEVER resolved against this machine's filesystem, the remote home is the
// far user's, `~` expands through the bridge, create-project writes the remote
// spelling, listings parse `ls -1AF`, writes are byte-exact and chunked under the
// exec cap, protected files are hidden, `list_many` batches a level into ONE
// exec, and a channel deadline is a `TransportError(timeout=true)` rather than
// an exit code. Deleting those files without moving the spec would delete the
// only written form of the constraint "a far root never touches the local
// filesystem" — so it moves here, one Python assertion group at a time:
//
//   remote_path_test.py                  -> `remotePathSpecs()` + the
//                                           local-filesystem guard below
//   transport_test.py (MockBridge half)  -> `transportSpecs()`
//   check_decoding / LocalTransport half -> STAYS in Python (the `local` path,
//                                           deployment A/C; M5 keeps it)
//
// Two doubles, on purpose:
//
// - `scriptedRemote()` is the Python `FakeBridge` ported: a tiny remote `sh`
//   that records every exec and stores printf-written files. It lets the root be
//   `/home/u/proj` — a path that does NOT exist on this machine — which is the
//   whole point of the macOS regression (its autofs spelling of /home made the
//   app host mkdir `/System/...` on a Linux remote).
// - `farShell()` (shared with tests/host-workspace.test.js and
//   tests/host-clc.test.js) is a REAL `sh -c` rooted in a temp tree: a
//   CO-LOCATED FAR ROOT, not the local-root capability deployment B must never
//   have (docs/ssh-scheme-plan.md §7, ban X1). Byte-level round trips need a real
//   shell; the path-spelling specs need a fake one.
//
// Run: node tests/host-remote-path.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");

const { check, summary } = require("./harness");
const { farShell } = require("./host-workspace.test");

const HOST = path.resolve(__dirname, "..", "ui", "host");
const { createWorkspace, joinPath, POSIX_SCRATCH_DIRS } = require(path.join(HOST, "fs.js"));
const { createExec, TransportError, EXEC_CHUNK_BYTES, EXEC_MAX_COMMAND_BYTES } = require(path.join(HOST, "exec.js"));
const clc = require(path.join(HOST, "clc.js"));
const { createApi } = require(path.join(HOST, "api.js"));

const TEMP_DIRS = [];
function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

function maxCommandBytes(shell) {
  return shell.state.commands.reduce((max, command) => Math.max(max, Buffer.byteLength(command, "utf8")), 0);
}

// ---- "a far root never touches the local filesystem" ---------------------
//
// The Python test proved it by patching `Path.resolve` to the macOS autofs
// rewrite; JavaScript has no such global, so the same claim is pinned twice:
//
//   1. STATICALLY — no `ui/host/*` module even loads `fs`, `path` or `os`, so
//      there is no local filesystem API in reach. This is the structural half:
//      the guarantee is that the code cannot ask, not that it happens not to.
//   2. AT RUNTIME — with every `fs` entry point replaced by a throwing recorder,
//      a full session (construct, write, read, tree, list, create a project,
//      open it) still passes and the recorder stays empty.

const HOST_MODULES = ["exec.js", "fs.js", "journal.js", "clc.js", "events.js", "api.js", "llm.js", "loop.js", "permission.js", "tools.js", "inst.js", "statement.js", "orient.js", "index.js"];
const LOCAL_APIS = /require\((["'])(?:node:)?(?:fs|path|os)(?:\/promises)?\1\)|\bprocess\.cwd\(|\bhomedir\(\)|process\.env\.HOME/;

function staticGuard() {
  const offenders = [];
  for (const name of HOST_MODULES) {
    const source = fs.readFileSync(path.join(HOST, name), "utf8");
    if (LOCAL_APIS.test(source)) offenders.push(name);
  }
  check(
    offenders.length === 0,
    `ui/host never loads a host fs/path/os module or asks for a local home (${offenders.join(", ") || "none"})`
  );
}

// Every way the local filesystem can be read or written through node's `fs`.
// `existsSync`/`stat` are in the list because "just checking" IS touching it —
// the macOS bug was a resolve, not a write.
const FS_ENTRIES = [
  "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "mkdir", "mkdirSync", "rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync",
  "rename", "renameSync", "stat", "statSync", "lstat", "lstatSync", "existsSync",
  "readdir", "readdirSync", "open", "openSync", "createReadStream", "createWriteStream",
  "realpath", "realpathSync", "access", "accessSync", "copyFile", "copyFileSync",
];

async function withoutLocalFs(what, body) {
  const saved = new Map();
  const touched = [];
  for (const name of FS_ENTRIES) {
    if (typeof fs[name] !== "function") continue;
    saved.set(name, fs[name]);
    fs[name] = function recorded(...args) {
      touched.push(`${name}(${args.map((arg) => (typeof arg === "string" ? arg : typeof arg)).join(", ")})`);
      throw new Error(`the far-root host touched the LOCAL filesystem: fs.${name}`);
    };
  }
  try {
    await body();
  } finally {
    for (const [name, fn] of saved) fs[name] = fn;
  }
  check(touched.length === 0, `${what}: the local filesystem is never touched (${touched.join("; ") || "0 calls"})`);
}

async function localFilesystemGuard() {
  staticGuard();

  const base = mkTemp("host-guard");
  const home = path.join(base, "home");
  const root = path.join(base, "root");
  fs.mkdirSync(home);
  fs.mkdirSync(root);

  await withoutLocalFs("construct + write + read + tree + create/open a project", async () => {
    const shell = farShell(home);
    const workspace = createWorkspace({ root, transport: shell });
    await workspace.write("sub/a.txt", "hello\n");
    check((await workspace.read("sub/a.txt")) === "hello\n", "guarded session: a write/read round trip still works");
    check((await workspace.size("sub/a.txt")) === 6, "guarded session: size still works");
    const tree = await workspace.tree();
    check(tree.map((node) => node.name).join(",") === "sub", "guarded session: the tree still walks");
    const listing = await workspace.fsList();
    check(listing.path === home, "guarded session: the picker still lists the far home");
    const project = await clc.createProject({ path: path.join(root, "demo"), name: "demo", model: "m", workspace });
    check(project.path === path.join(root, "demo.clc"), "guarded session: createProject lands on the far side");
    const opened = await clc.openProject({ path: project.path, workspace });
    check(opened.meta.name === "demo", "guarded session: openProject reads it back");
  });
}

// ---- the Python FakeBridge, ported ---------------------------------------
//
// A tiny remote `sh`: records every exec, stores printf-written files, answers
// echo $HOME / wc -c / cat / tail|head. It is what lets a workspace be rooted at
// `/home/u/proj` without that path existing here.

function unshq(text) {
  let out = String(text);
  if (out.length >= 2 && out.startsWith("'") && out.endsWith("'")) out = out.slice(1, -1);
  return out.split("'\\''").join("'");
}

function scriptedRemote(home = "/home/u") {
  const files = new Map();
  const commands = [];

  function fragment(command) {
    commands.push(command);
    if (command === "echo $HOME") return { code: 0, stdout: `${home}\n`, stderr: "" };
    let m = command.match(/^mkdir -p '.*'$/s);
    if (m) return { code: 0, stdout: "", stderr: "" };
    m = command.match(/^wc -c < ('.*')$/s);
    if (m) {
      const at = unshq(m[1]);
      return files.has(at)
        ? { code: 0, stdout: String(Buffer.byteLength(files.get(at), "utf8")), stderr: "" }
        : { code: 1, stdout: "", stderr: "no such file" };
    }
    m = command.match(/^cat ('.*')$/s);
    if (m) {
      const at = unshq(m[1]);
      return files.has(at)
        ? { code: 0, bytes: Buffer.from(files.get(at), "utf8"), stderr: "" }
        : { code: 1, stdout: "", stderr: "no such file" };
    }
    // `printf '%s'` (byte-exact) and `printf '%s\n'` (one terminator); the content
    // group is greedy so a chunk full of quotes survives the split.
    m = command.match(/^printf '(%s(?:\\n)?)' (.*) (>>|>) ('.*')$/s);
    if (m) {
      const body = unshq(m[2]) + (m[1] === "%s\\n" ? "\n" : "");
      const at = unshq(m[4]);
      files.set(at, m[3] === ">" ? body : (files.get(at) || "") + body);
      return { code: 0, stdout: "", stderr: "" };
    }
    m = command.match(/^tail -c \+(\d+) ('.*') \| head -c (\d+)$/s);
    if (m) {
      const buffer = Buffer.from(files.get(unshq(m[2])) || "", "utf8");
      const from = Number(m[1]) - 1;
      return { code: 0, bytes: buffer.slice(from, from + Number(m[3])), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  function run(command, options = {}) {
    let result = { code: 0, stdout: "", stderr: "" };
    // the real remote sh sequences `a && b` the same way: stop at the first
    // failing group
    for (const part of String(command).split(" && ")) {
      result = fragment(part);
      if (result.code !== 0) return result;
    }
    if (options.binary && result.bytes) {
      return { code: result.code, stdout_b64: result.bytes.toString("base64"), stderr: result.stderr };
    }
    return {
      code: result.code,
      stdout: result.bytes ? result.bytes.toString("utf8") : result.stdout,
      stderr: result.stderr,
    };
  }

  return { run, files, commands };
}

async function remotePathSpecs() {
  const bridge = scriptedRemote("/home/u");
  const workspace = createWorkspace({ root: "/home/u/proj", transport: bridge });

  await workspace.write("sub/f.txt", "hello");
  check(
    bridge.commands[0].startsWith("mkdir -p '/home/u/proj/sub'"),
    "write mkdirs the REMOTE spelling"
  );
  check(
    bridge.commands.every((command) => !command.includes("/System")),
    "no /System reaches the remote"
  );
  check(
    (await workspace.resolve("a/../b.txt")) === "/home/u/proj/b.txt",
    "resolve normalizes lexically"
  );
  check(workspace.realpath(workspace.root) === "/home/u/proj", "root normalization is lexical");

  let escape = null;
  try {
    await workspace.resolve("../../etc/passwd");
  } catch (error) {
    escape = error;
  }
  check(Boolean(escape && escape.name === "ValueError"), "lexical escape is still rejected");

  const before = bridge.commands.length;
  const answer = await workspace.run("ls", 5);
  const sent = bridge.commands.slice(before);
  check(
    sent.join(" | ") === "cd '/home/u/proj' | ls",
    "run() states its own cd into the un-rewritten root (one command, no remembered cwd)"
  );
  check(answer.code === 0, "run() answers the command's exit code");

  workspace.protect("/home/u/proj/x.clc");
  check(workspace.isProtected("/home/u/proj/x.clc"), "protect round-trips without the local resolve");

  // ~ expands through the bridge to the REMOTE home, never a local expanduser
  check((await workspace.home()) === "/home/u", "home() asks the remote over the bridge");
  check(
    (await workspace.escapePath("~/.ssh/id_rsa")) === "/home/u/.ssh/id_rsa",
    "~ expands to the REMOTE home"
  );
  const atHome = createWorkspace({ root: "/home/u", transport: bridge });
  check((await atHome.escapePath("~/.ssh")) === null, "a ~ inside the workspace root stays inside");

  // create-project: the exact flow that failed on macOS
  const project = await clc.createProject({
    path: "/home/u/proj/demo",
    name: "demo",
    model: "m",
    workspace,
  });
  check(project.path === "/home/u/proj/demo.clc", "project path keeps the remote spelling");
  check(
    bridge.commands.some((command) => command.includes("'/home/u/proj/demo.clc'")),
    "the header is written to the remote path"
  );
  check(
    bridge.commands.every((command) => !command.includes("/System")),
    "create_project sends no /System"
  );

  // POSIX flavor on any app host: there is no WindowsPath to leak into a command
  check(workspace.root.startsWith("/") && !workspace.root.includes("\\"), "root is spelled POSIX");
  check(POSIX_SCRATCH_DIRS.every((dir) => dir.startsWith("/")), "scratch dirs are POSIX absolute");
  check(
    (await workspace.resolve("/tmp/clutch-test.log")) === "/tmp/clutch-test.log",
    "scratch-escape keeps the remote spelling"
  );
  check((await workspace.escapePath("a/../b.txt")) === null, "a relative token staying inside is not an escape");
  check(
    (await workspace.escapePath("../outside.txt")) === "/home/u/outside.txt",
    "an escape verdict is lexically normalized"
  );
  check(
    workspace.normJoin("/home/u/proj", "sub/../x.txt") === "/home/u/proj/x.txt",
    "norm_join uses POSIX rules"
  );
  check(
    workspace.realpath("C:\\Users\\x\\y.clc") === "C:/Users/x/y.clc",
    "realpath tolerates backslash-mangled input"
  );
  check(
    bridge.commands.every((command) => !command.includes("\\")),
    "no command carries a backslash separator"
  );

  // The macOS hazard, simulated the only way a JS host can be hit by it: the
  // near host's official resolver rewrites /home. Nothing in ui/host calls it.
  const nearResolve = path.resolve;
  let rewrites = 0;
  path.resolve = function macResolve(...args) {
    const out = nearResolve.apply(path, args);
    if (out === "/home" || out.startsWith("/home/")) {
      rewrites += 1;
      return `/System/Volumes/Data/home${out.slice("/home".length)}`;
    }
    return out;
  };
  let localVerdict = "";
  try {
    localVerdict = path.resolve("/home/u/proj");
    const again = createWorkspace({ root: "/home/u/proj", transport: scriptedRemote() });
    await again.write("sub/g.txt", "hello");
    check(again.realpath(again.root) === "/home/u/proj", "an active local rewrite does not reach the far path");
  } finally {
    path.resolve = nearResolve;
  }
  check(
    localVerdict === "/System/Volumes/Data/home/u/proj",
    "the near host's resolver WOULD rewrite /home (the hazard is real)"
  );
  check(rewrites === 1, "and the far-root host never asks it: a remote path is never resolved locally");
}

// ---- the MockBridge half of transport_test.py, ported ---------------------

async function transportSpecs() {
  const base = mkTemp("host-transport");
  const home = path.join(base, "home");
  const root = path.join(base, "root");
  fs.mkdirSync(home);
  fs.mkdirSync(root);

  // constructing a far workspace must not create the root here (macOS SSH
  // regression: a local mkdir of /home/<user> failed with ENOTSUP)
  const missing = path.join(base, "init-made", "deep");
  createWorkspace({ root: missing, transport: farShell(home) });
  check(!fs.existsSync(missing), "createWorkspace never mkdirs the far root locally");

  const shell = farShell(home);
  const workspace = createWorkspace({ root, transport: shell });

  // quoting round trip: $, backticks, quotes, tab, newline
  const tricky = "l1\nwith $VAR `bt` 'sq' \"dq\"\n\ttab\tend\n";
  await workspace.write("sub/deep/f.txt", tricky);
  check((await workspace.read("sub/deep/f.txt")) === tricky, "remote write/read byte-identical");
  check(
    (await workspace.read("sub/deep/f.txt")) === fs.readFileSync(path.join(root, "sub/deep/f.txt"), "utf8"),
    "and equal to the bytes the far side really holds"
  );

  // byte-exact: printf adds no newline
  await workspace.write("no-nl.txt", "abc");
  check((await workspace.read("no-nl.txt")) === "abc", "remote write is byte-exact (no added newline)");
  check((await workspace.size("no-nl.txt")) === 3, "size counts bytes, not lines");

  // large content: chunked under the cap, bytes exact
  const big = Array.from(
    { length: 300 },
    (_, i) => `line ${String(i).padStart(4, "0")} with $VAR and 'quotes' and "dquotes" and \ttab\t\n`
  ).join("");
  await workspace.write("big.txt", big);
  check((await workspace.read("big.txt")) === big, "a large remote write is byte-exact (chunked)");
  check(
    maxCommandBytes(shell) <= EXEC_CHUNK_BYTES + 200,
    `exec commands stay under the chunk cap (max ${maxCommandBytes(shell)} bytes)`
  );

  // the .clc case: ONE huge single-line event appends without a split
  const event = `{"type": "tool_result", "content": "${"x".repeat(24000)}"}`;
  await workspace.appendLine("session.clc", event);
  check(
    fs.readFileSync(path.join(root, "session.clc"), "utf8") === `${event}\n`,
    "a huge single-line append is byte-exact with exactly one trailing newline"
  );
  check(
    maxCommandBytes(shell) <= EXEC_CHUNK_BYTES + 200,
    `the append is chunked under the cap (max ${maxCommandBytes(shell)} bytes)`
  );

  // ls parsing, error mapping, cd semantics
  const entries = (await workspace.listMany(["."]))["."];
  check(entries.includes("sub/") && entries.includes("no-nl.txt"), "a remote listing marks dirs with '/'");
  let missingRead = null;
  try {
    await workspace.read("missing.txt");
  } catch (error) {
    missingRead = error;
  }
  check(Boolean(missingRead && missingRead.name === "FileNotFoundError"), "remote read raises FileNotFoundError");
  const pwd = await workspace.run("pwd", 30);
  check(pwd.code === 0 && pwd.stdout.trim() === workspace.root, "remote run's cwd is the root");

  // oversized run_command: rejected up front, never reaches the far side
  const callsBefore = shell.state.calls;
  let oversized = null;
  try {
    await workspace.run(`echo ${"x".repeat(20000)}`, 30);
  } catch (error) {
    oversized = error;
  }
  check(Boolean(oversized && oversized instanceof TransportError), "an oversized command raises TransportError");
  check(shell.state.calls === callsBefore, "and it never reaches the far side");

  // protected hiding: the ONE place that knows a name is hidden
  await workspace.write("sub/secret.txt", "x");
  workspace.protect(joinPath(joinPath(workspace.root, "sub"), "secret.txt"));
  fs.mkdirSync(path.join(root, "sub", "keep"), { recursive: true });
  workspace.protect(joinPath(joinPath(workspace.root, "sub"), "keep"));
  const kept = (await workspace.listMany(["sub"]))["sub"];
  check(!kept.includes("secret.txt"), "a listing hides a protected FILE");
  check(kept.includes("keep/"), "but still lists a protected DIRECTORY (the agent sees it, cannot read inside)");

  // list_many: one exec per level, missing/non-dir -> []
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, "a", "inner"));
  fs.mkdirSync(path.join(root, "b"));
  fs.writeFileSync(path.join(root, "b", "f.txt"), "x");
  fs.writeFileSync(path.join(root, ".dot.txt"), "x");
  shell.state.calls = 0;
  const many = await workspace.listMany([".", "a", "b", "missing", "no-nl.txt"]);
  check(shell.state.calls === 1, `listMany batches the whole level into one exec (got ${shell.state.calls})`);
  check(
    ["sub/", "no-nl.txt", "a/", "b/"].every((name) => many["."].includes(name)),
    "listMany lists the root, dirs suffixed"
  );
  check(many.a.join(",") === "inner/" && many.b.join(",") === "f.txt", "listMany lists each named dir");
  check(many.missing.length === 0 && many["no-nl.txt"].length === 0, "a missing or non-dir path maps to []");
  check(many["."].includes(".dot.txt"), "listMany itself does not filter hidden names (one policy, in `visible`)");
  check(maxCommandBytes(shell) <= EXEC_CHUNK_BYTES + 200, "the listMany command stays under the exec cap");

  // append_line round trip with characters the shell would otherwise eat
  await workspace.appendLine("log.txt", '{"a": "$x"}');
  await workspace.appendLine("log.txt", "second");
  check((await workspace.read("log.txt")) === '{"a": "$x"}\nsecond\n', "remote append_line round-trips");

  // a level too long for one command: several groups, every marker still lands
  const dirs = [];
  for (let i = 0; i < 60; i += 1) {
    const name = `d${String(i).padStart(2, "0")}-${"x".repeat(40)}`;
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "f.txt"), "x");
    dirs.push(name);
  }
  shell.state.calls = 0;
  const grouped = await workspace.listMany(dirs);
  check(shell.state.calls >= 2, `a long level is split across execs (got ${shell.state.calls})`);
  check(
    dirs.every((name) => grouped[name].join(",") === "f.txt"),
    "every group's marker lands on its own directory"
  );
  check(
    shell.state.commands.every((command) => Buffer.byteLength(command, "utf8") <= EXEC_MAX_COMMAND_BYTES),
    "and no group exceeds the wire limit"
  );

  // the channel's deadline is a verdict, not an exit code
  const dead = createExec({ run: async () => ({ code: -1, stdout: "", stderr: "" }) });
  let timedOut = null;
  try {
    await dead.run("ls", { timeout: 1 });
  } catch (error) {
    timedOut = error;
  }
  check(
    Boolean(timedOut && timedOut instanceof TransportError && timedOut.timeout && !timedOut.aborted),
    "a channel deadline surfaces as TransportError(timeout=true)"
  );
  const silent = createExec({ run: async () => ({}) });
  let noCode = null;
  try {
    await silent.run("ls");
  } catch (error) {
    noCode = error;
  }
  check(Boolean(noCode && noCode instanceof TransportError), "an answer without an exit code is a TransportError");

  // "a remote root refuses the file tools instead of serving the wrong machine":
  // in JS the same claim is X1 — no local-root fallback exists to serve it.
  const bare = createApi({});
  const picker = await bare.handle("GET", "/api/fs/list");
  check(
    picker.status === 400 && picker.body.error === "no workspace open",
    "fs.list without a far shell answers 400, not an empty directory"
  );
  const tree = await bare.handle("GET", "/api/workspace/tree");
  check(tree.status === 200 && tree.body.tree.length === 0 && tree.body.root === null, "and the tree is empty, not local");
  let refusal = null;
  try {
    await clc.openProject({ path: "/home/u/proj/demo.clc", workspace: null });
  } catch (error) {
    refusal = error;
  }
  check(
    Boolean(refusal && refusal instanceof TypeError && /no local root/.test(refusal.message)),
    "clc refuses to open a project without a workspace (no local-root fallback)"
  );
}

async function main() {
  await localFilesystemGuard();
  await remotePathSpecs();
  await transportSpecs();

  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  summary("host-remote-path");
}

if (require.main === module) {
  main().catch((error) => {
    check(false, `suite crashed: ${(error && error.stack) || error}`);
    summary("host-remote-path");
  });
}
