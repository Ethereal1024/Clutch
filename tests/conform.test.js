"use strict";

// The /api/* seam contract (docs/ssh-scheme-plan.md §5), kept honest in two parts.
//
// A, C and B render the same renderer; A and C answer it over HTTP from the Python
// host, B answers the same routes in-process from ui/host/api.js. The payloads must
// therefore be equal, and the goldens in tests/fixtures/conformance/ are what
// "equal" means. tests/conformance_capture.py writes them from the real Python
// host; this runner is the other half:
//
//   1. the fixture set is COMPLETE and SELF-CONSISTENT (every endpoint in the
//      manifest has its file, every case it lists is there, every recorded status
//      is a number, and no golden leaked a machine path through the <ROOT>/<HOME>/
//      <TMP> normalization);
//   2. the four tools' frozen text, compared between the Python component
//      (clutch-workspace) and lib/tools.js of clutch-ssh-workspace — the part of
//      the seam that already exists on BOTH sides.
//
// `pending` is the M0 deliverable, not a TODO: it names the milestone that owes the
// route. When ui/host/api.js exists, an endpoint flips to `enforced` in
// tests/fixtures/conformance/manifest.json and THIS file starts comparing it
// case-by-case; an `enforced` endpoint with no in-process handler is a failure, so
// the marker cannot be flipped by wishful editing.
//
// Run: node tests/conform.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const { check, summary } = require("./harness");

const FIX = path.resolve(__dirname, "fixtures", "conformance");
const MANIFEST = path.join(FIX, "manifest.json");

// The in-process host the M1/M4 milestones add (ui/host/api.js). Absent in the
// M0-only state: then every endpoint must still be `pending`, and this runner
// asserts exactly that.
function loadHost() {
  try {
    return require(path.resolve(__dirname, "..", "ui", "host", "api.js"));
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes("ui/host/api.js")) return null;
    if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(path.join("ui", "host", "api"))) return null;
    throw e;
  }
}

// The stateful half of the comparison: a per-route runner replays every
// `enforced` endpoint against these goldens (it has to build a project, seed the
// journal, claim the .clc, or hold a log — state this runner has no way to
// invent). Each runner owns the endpoints it is the natural home for:
//
//   host-workspace.test.js  the in-process /api/* table (ui/host/api.js)
//   host-events.test.js     the SSE encoder and its catch-up (ui/host/events.js)
//
// Their union is therefore the ONLY acceptable content of the `enforced` set: a
// marker without a replay is a claim, and a replay without a marker is a route
// nobody classified.
const REPLAYERS = ["host-workspace.test.js", "host-events.test.js"];

function replayedEndpoints() {
  const covered = [];
  for (const file of REPLAYERS) {
    try {
      covered.push(...(require(`./${file}`).COVERED || []));
    } catch (e) {
      return { error: `${file}: ${(e && e.message) || String(e)}` };
    }
  }
  return covered;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---- 1. the fixture set --------------------------------------------------

function fixtureShape() {
  check(fs.existsSync(MANIFEST), "the goldens have a manifest (run python -m tests.conformance_capture)");
  if (!fs.existsSync(MANIFEST)) return null;
  const manifest = readJson(MANIFEST);
  check(manifest.format === 1, "manifest.format is the version this runner understands");
  check(Array.isArray(manifest.endpoints) && manifest.endpoints.length > 0, "the manifest lists endpoints");
  check(
    Array.isArray(manifest.normalizations) && manifest.normalizations.includes("<ROOT>"),
    "the manifest names the path tokens the goldens are normalized with"
  );

  const host = loadHost();
  const ids = new Set();
  let cases = 0;
  let pending = 0;
  let enforced = 0;

  for (const ep of manifest.endpoints) {
    check(!ids.has(ep.id), `${ep.id}: endpoint ids are unique`);
    ids.add(ep.id);
    check(["pending", "enforced"].includes(ep.status), `${ep.id}: has an enforcement marker`);
    if (ep.status === "pending") pending++;
    else enforced++;

    const file = path.join(FIX, ep.file);
    const here = fs.existsSync(file);
    check(here, `${ep.id}: its golden file exists (${ep.file})`);
    if (!here) continue;
    const doc = readJson(file);
    check(doc.endpoint === ep.id, `${ep.id}: the file names the endpoint it belongs to`);
    check(
      JSON.stringify(doc.cases.map((c) => c.id)) === JSON.stringify(ep.cases),
      `${ep.id}: the manifest lists exactly the cases in the file`
    );

    for (const c of doc.cases) {
      cases++;
      if ("frame" in c) {
        // an SSE frame is produced by the encoder, not by a request: its whole
        // contract is the bytes, so the case records the text and nothing else
        check(
          typeof c.frame === "string" && c.frame.startsWith("data: ") && c.frame.endsWith("\n\n"),
          `${ep.id}/${c.id}: records one framed SSE payload`
        );
        continue;
      }
      check(typeof c.status === "number" && Number.isInteger(c.status), `${ep.id}/${c.id}: records an HTTP status`);
      check(typeof c.method === "string" && c.method.length > 0, `${ep.id}/${c.id}: records the method`);
      check(typeof c.path === "string" && c.path.startsWith("/"), `${ep.id}/${c.id}: records the route`);
      check("body" in c || "ndjson" in c, `${ep.id}/${c.id}: records an answer`);
      if ("masked" in c) {
        // a masked field is compared by TYPE only: the value itself is the
        // machine's (a home listing), and freezing it would freeze this host
        const body = c.body || {};
        for (const key of c.masked) {
          check(
            body[key] && typeof body[key] === "object" && "__masked__" in body[key],
            `${ep.id}/${c.id}: masked field ${key} records its type, not its contents`
          );
        }
      }
    }
  }

  check(cases >= 30, `the fixture set covers the contract (${cases} cases)`);
  check(pending + enforced === manifest.endpoints.length, "every endpoint carries exactly one marker");

  if (host === null) {
    check(pending === manifest.endpoints.length, "no in-process host yet, so no endpoint is marked enforced");
    console.log(`note: ${pending} endpoint(s) pending -> ${manifest.endpoints.map((e) => `${e.id} (${e.owner})`).join(", ")}`);
  } else {
    check(enforced > 0, "an in-process host exists, so at least one endpoint is enforced");
    check(typeof host.createApi === "function", "ui/host/api.js exposes createApi(state)");
    check(typeof host.readBody === "function", "ui/host/api.js exposes readBody (the one body contract)");

    const covered = replayedEndpoints();
    if (!Array.isArray(covered)) {
      check(false, `a host runner must load (${covered.error})`);
    } else {
      const marked = manifest.endpoints
        .filter((e) => e.status === "enforced")
        .map((e) => e.id)
        .sort();
      const replayed = [...covered].sort();
      check(
        JSON.stringify(marked) === JSON.stringify(replayed),
        `every enforced endpoint is replayed by a host runner (${marked.join(", ") || "none"})`
      );
      for (const id of replayed) {
        check(manifest.endpoints.some((e) => e.id === id), `${id}: replayed endpoint exists in the manifest`);
      }
      console.log(`note: ${replayed.length} enforced, ${pending} pending -> ${manifest.endpoints.filter((e) => e.status === "pending").map((e) => `${e.id} (${e.owner})`).join(", ") || "none"}`);
    }
  }
  return manifest;
}

// ---- 1b. no golden may leak a machine path ------------------------------
//
// The capture replaces the workspace root, the home dir and the temp dir with
// tokens. A path it failed to replace would compare against the WRONG machine's
// path on the next host — silently, because the shape is right. Values only: an
// absolute path inside a sentence ("not a directory: <ROOT>/x") is legitimately
// only detected by the same rule applied to the whole string below.
const PATH_ALLOWLIST = new Set(["/nonexistent_clutch_xyz"]);

function leaks(value, where, out) {
  if (typeof value === "string") {
    if (value.startsWith("/")) {
      const ok = /^<(ROOT|HOME|TMP)>/.test(value) || PATH_ALLOWLIST.has(value);
      if (!ok) out.push(`${where}: ${value}`);
    } else {
      // a sentence can carry a path too: any absolute-looking run must be tokenized
      for (const m of value.match(/(?:^|[\s:'"])(\/[A-Za-z0-9_.-]+\/[^\s'"]*)/g) || []) {
        if (!/^[\s:'"]*<(ROOT|HOME|TMP)>/.test(m) && !PATH_ALLOWLIST.has(m.trim().replace(/^[\s:'"]+/, ""))) {
          out.push(`${where}: ${value}`);
        }
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => leaks(v, `${where}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) leaks(value[k], `${where}.${k}`, out);
  }
}

function noLeakedPaths(manifest) {
  const found = [];
  for (const ep of manifest.endpoints) {
    const doc = readJson(path.join(FIX, ep.file));
    // the case-level `path` is the HTTP ROUTE, not a filesystem path: check the
    // answers and the request bodies, which are the only places a machine path
    // can hide
    const checkable = doc.cases.map((c) => ({ body: c.body, ndjson: c.ndjson, frame: c.frame, request: c.request }));
    leaks(checkable, ep.id, found);
  }
  check(found.length === 0, `no golden carries a machine path (${found.length ? found.join(" | ") : "clean"})`);
}

// ---- 2. the four tools' frozen text -------------------------------------
//
// The one pair of implementations that already exists twice: the Python component
// (clutch-workspace) and this repo's lib/tools.js. Same fixture tree on both
// sides, same answers — modulo the two divergences the plan documents (POSIX ERE
// vs Python re, raw bytes vs universal newlines).

const PYTHON = process.env.PYTHON || (fs.existsSync(".venv/bin/python") ? path.resolve(".venv/bin/python") : "python3");
const COMPONENT = path.resolve("clutch-workspace");

function runShell(cwd) {
  return (command) =>
    new Promise((resolve) => {
      execFile("sh", ["-c", command], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || "" });
      });
    });
}

function component(cwd, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON,
      ["-m", "clutch_workspace", "--json"].concat(args),
      { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: Object.assign({}, process.env, { PYTHONPATH: COMPONENT }) },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(error.message + "\n" + stderr));
          return;
        }
        let envelope;
        try {
          envelope = JSON.parse(stdout);
        } catch (e) {
          reject(new Error("not an envelope: " + stdout.slice(0, 300)));
          return;
        }
        resolve(envelope);
      }
    );
    if (typeof stdin === "string") child.stdin.end(stdin);
  });
}

function fixture(root) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# hi\n\nnotes about ssh-workspace\n");
  fs.writeFileSync(path.join(root, "version"), "0.1.64\n");
  fs.writeFileSync(path.join(root, "no-newline.txt"), "no trailing newline");
  fs.writeFileSync(path.join(root, "src", "a.py"), "def build_x():\n    return 1\n");
  fs.writeFileSync(path.join(root, "src", "b.py"), "def build_y():\n    return 2\n");
  fs.writeFileSync(path.join(root, "src", "notes.md"), "ssh-workspace in a markdown file\n");
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "ssh-workspace guide\n\nssh-workspace again\n");
  fs.writeFileSync(path.join(root, ".hidden"), "ssh-workspace hidden\n");
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0x73, 0x73, 0x68]));
  fs.writeFileSync(path.join(root, "dup.txt"), "same\nsame\n");
  fs.writeFileSync(path.join(root, "long.txt"), `${"a".repeat(400)}TAIL\n`);
  fs.writeFileSync(path.join(root, "many.txt"), "hit\n".repeat(250));
  fs.mkdirSync(path.join(root, "empty"), { recursive: true });
  fs.writeFileSync(path.join(root, "empty-file.txt"), "");
  fs.writeFileSync(path.join(root, "crlf.txt"), "one\r\ntwo\r\n");
  fs.writeFileSync(path.join(root, "unicode-é.txt"), "unicode name\n");
  fs.writeFileSync(path.join(root, "z.txt"), "first\n");
}

// The frozen texts the plan pins: `N: text`, `(empty directory)`, `(no matches)`,
// `(Results capped at 100; …)`, `OK: wrote {path} (+A -D lines)`,
// `OK: edited {path} (+A -D lines)`, `file not found: {path}`, the read-limit hint,
// `old_string not found in {path}`, `old_string appears {n} times in {path}`,
// `(showing lines X-Y of N; …)`, `[truncated, file is N chars; …]`.
const TOOL_CASES = [
  { tool: "read_file", args: { path: "README.md" } },
  { tool: "read_file", args: { path: "no-newline.txt" } },
  { tool: "read_file", args: { path: "." } },
  { tool: "read_file", args: { path: "src" } },
  { tool: "read_file", args: { path: "docs", offset: 1 } },
  { tool: "read_file", args: { path: "README.md", offset: 1, limit: 2 } },
  { tool: "read_file", args: { path: "README.md", offset: 2 } },
  { tool: "read_file", args: { path: "README.md", offset: 9 } },
  { tool: "read_file", args: { path: "README.md", offset: 1, limit: 500, max_chars: 10 } },
  { tool: "read_file", args: { path: "nope.txt" } },
  { tool: "grep", args: { pattern: "ssh-workspace" } },
  { tool: "grep", args: { pattern: "ssh-workspace", include: "*.md" } },
  { tool: "grep", args: { pattern: "ssh-workspace", path: "src" } },
  { tool: "grep", args: { pattern: "return", path: "src/a.py" } },
  { tool: "grep", args: { pattern: "zzzzz" } },
  { tool: "grep", args: { pattern: "ssh-workspace", path: "nope" } },
  { tool: "grep", args: { pattern: "ssh-workspace", include: "src/*.py" } },
  { tool: "write_file", args: { path: "made.txt", content: "hello\nthere\n" } },
  { tool: "write_file", args: { path: "README.md", content: "# hi\n\nnotes about ssh-workspace, edited\n" } },
  { tool: "write_file", args: { path: "deep/er/new.txt", content: "" } },
  { tool: "edit_file", args: { path: "dup.txt", old_string: "same", new_string: "other" } },
  { tool: "edit_file", args: { path: "no-newline.txt", old_string: "trailing", new_string: "TRAILING" } },
  { tool: "edit_file", args: { path: "nope.txt", old_string: "a", new_string: "b" } },
  { tool: "edit_file", args: { path: "README.md", old_string: "absent", new_string: "b" } },
  { tool: "edit_file", args: { path: "src/a.py", old_string: "return 1", new_string: "return 11" } },
  { tool: "read_file", args: { path: "long.txt" } },
  { tool: "read_file", args: { path: "many.txt" } },
  { tool: "read_file", args: { path: "empty" } },
  { tool: "read_file", args: { path: "empty-file.txt" } },
  { tool: "read_file", args: { path: "crlf.txt" }, diverge: "bytes" },
  { tool: "read_file", args: { path: "unicode-é.txt" } },
  { tool: "grep", args: { pattern: "hit" } },
  { tool: "grep", args: { pattern: "aaa" } },
  { tool: "grep", args: { pattern: "two", path: "crlf.txt" }, diverge: "bytes" },
  { tool: "grep", args: { pattern: "first", include: "?.txt" } },
  { tool: "grep", args: { pattern: "unicode" } },
  { tool: "read_file", args: { path: "./src/../README.md" } },
  { tool: "write_file", args: { path: "z.txt", content: "first\n" } },
  { tool: "write_file", args: { path: "many-lines.txt", content: "same\nsame\nsame\n".repeat(100) } },
];

function cliArgs(tool, args) {
  const out = [tool];
  if (tool === "read_file") {
    if (args.path !== undefined) out.push("--path", args.path);
    if (args.offset) out.push("--offset", String(args.offset));
    if (args.limit) out.push("--limit", String(args.limit));
    if (args.max_chars) out.push("--max-chars", String(args.max_chars));
  } else if (tool === "grep") {
    out.push("--pattern", args.pattern);
    if (args.path) out.push("--path", args.path);
    if (args.include) out.push("--include", args.include);
  } else if (tool === "write_file") {
    out.push("--path", args.path, "--content", "-");
  } else if (tool === "edit_file") {
    out.push("--path", args.path, "--old-string", args.old_string, "--new-string", args.new_string);
  }
  return out;
}

async function toolsConformance() {
  let tools;
  try {
    tools = require(path.resolve(__dirname, "..", "clutch-ssh-workspace", "lib", "tools"));
  } catch (e) {
    console.log(`skip: four-tool comparison (clutch-ssh-workspace/lib/tools.js not installed: ${e.code || e.message})`);
    return;
  }
  const A = fs.mkdtempSync(path.join(os.tmpdir(), "conform-a-"));
  const B = fs.mkdtempSync(path.join(os.tmpdir(), "conform-b-"));
  TEMP_DIRS.push(A, B);
  fixture(A);
  fixture(B);
  const ctx = {
    env: Object.assign({}, process.env, {
      CLUTCH_SSH_WORKSPACE: B,
      CLUTCH_EXEC_CHUNK_BYTES: "3500",
      CLUTCH_EXEC_MAX_COMMAND_BYTES: "6000",
    }),
    run: runShell(B),
  };
  let bad = 0;
  let known = 0;
  try {
    // a probe first: the Python side must be runnable, else say so instead of
    // reporting 39 mismatches against a broken interpreter
    const probe = await component(A, ["read_file", "--path", "README.md"]);
    if (!probe || typeof probe.content !== "string") {
      console.log("skip: four-tool comparison (the component answered no envelope)");
      return;
    }
  } catch (e) {
    console.log(`skip: four-tool comparison (${String(e.message).split("\n")[0]})`);
    return;
  }
  for (const { tool, args, diverge } of TOOL_CASES) {
    const want = await component(A, cliArgs(tool, args), tool === "write_file" ? args.content : undefined);
    const got = await tools.run(ctx, tool, args);
    const same = want.content === got.content && (want.diff || "") === got.diff && !!want.error === !!got.code;
    if (same) continue;
    if (diverge === "bytes") {
      known++;
      continue;
    }
    bad++;
    console.log(`  MISMATCH ${tool} ${JSON.stringify(args)}`);
    if (want.content !== got.content) {
      console.log("    content want:", JSON.stringify(String(want.content).slice(0, 300)));
      console.log("    content got :", JSON.stringify(String(got.content).slice(0, 300)));
    }
    if ((want.diff || "") !== got.diff) {
      console.log("    diff want:", JSON.stringify(String(want.diff || "").slice(0, 200)));
      console.log("    diff got :", JSON.stringify(String(got.diff || "").slice(0, 200)));
    }
    if (!!want.error !== !!got.code) console.log("    error want:", want.error, "got:", got.code);
  }
  check(bad === 0, `four tools: the frozen texts match the Python component (${TOOL_CASES.length} cases, ${known} documented divergence(s))`);
  check(known <= 2, "four tools: no NEW documented divergence appeared");
}

const TEMP_DIRS = [];

function cleanup() {
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  const manifest = fixtureShape();
  if (manifest) noLeakedPaths(manifest);
  await toolsConformance();
  cleanup();
  summary("conform");
}

main().catch((e) => {
  check(false, `suite crashed: ${(e && e.stack) || e}`);
  summary("conform");
});
