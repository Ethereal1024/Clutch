"use strict";

// The `.clc` port (`ui/host/clc.js`), replayed against the golden capture.
//
// `tests/clc_capture.py` froze, per fixture, everything the Python host knows
// about a project file: the meta, the event region's start, the fixed-width
// `cpr_start` line and the window it opens, every durable `(offset, line)`, the
// deliberate disagreement between the two readers on a BOM line, byte-range
// pages, and page alignment — plus the three lifecycle records (append, the
// in-place window slide, a read-only open) and the two NDJSON open streams.
// This file builds the same project on a real `sh` (a CO-LOCATED FAR ROOT — not
// the local-root capability deployment B must never have, plan §7 ban X1) and
// compares the port's answers with those records. Nothing here hard-codes an
// offset: the fixtures stay the single source of truth, and a byte off is a
// failure.
//
// Run: node tests/host-clc.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");

const { check, summary } = require("./harness");
const { farShell } = require("./host-workspace.test");

const FIX = path.resolve(__dirname, "fixtures", "clc");
const HOST = path.resolve(__dirname, "..", "ui", "host");
const clc = require(path.join(HOST, "clc.js"));
const { createWorkspace } = require(path.join(HOST, "fs.js"));

const HEAD = 1 << 16; // project/__init__.py: the header lives in the first 64 KiB
const ROOT_TOKEN = "<ROOT>";
const GOLDEN = JSON.parse(fs.readFileSync(path.join(FIX, "expected.json"), "utf8"));

// canonical JSON: sorted keys, arrays in order — the same comparison the
// conformance replay uses, so an equal answer compares equal regardless of key
// insertion order.
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

function same(actual, expected) {
  return canon(actual) === canon(expected);
}

// The capture wrote `<ROOT>` where the temp work dir stood; expand it back so a
// golden line can be compared with a real one.
function expand(value, root) {
  if (typeof value === "string") return value.split(ROOT_TOKEN).join(root);
  if (Array.isArray(value)) return value.map((item) => expand(item, root));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = expand(value[key], root);
    return out;
  }
  return value;
}

// `event_to_json` of every materialized pair — what the golden recorded.
function pairLines(pairs) {
  return pairs.map(([offset, event]) => [offset, clc.eventToJson(event)]);
}

async function capture(names, work) {
  // the fixtures are copied, never mutated in place: `append`/`set_cpr_start`/
  // `read_only` each write their own copy, exactly as the capture did.
  const at = (name) => path.join(work, name);
  const shell = farShell(work);
  const workspace = createWorkspace({ root: work, transport: shell });
  const { append, set_cpr_start: slide, read_only: readonly } = GOLDEN;
  const TS = GOLDEN.timestamp;

  // ---- one frozen record per fixture ------------------------------------
  for (const name of names) {
    const golden = GOLDEN.files[name];
    const bytes = fs.readFileSync(at(name));
    const project = await clc.openProject({ path: at(name), workspace });
    const log = project.log;

    check(same({ name: project.meta.name, model: project.meta.model }, golden.meta), `${name}: meta`);
    check(project.readOnly === false, `${name}: a writable open`);
    check(log.eventStart === golden.eventStart, `${name}: event region starts at ${golden.eventStart}`);
    check(
      clc.findCprLine(bytes.subarray(0, HEAD)) === golden.cprLineOffset,
      `${name}: cpr_start line at ${golden.cprLineOffset}`,
    );
    check(log.cprStart === golden.cprStart, `${name}: window starts at ${golden.cprStart}`);
    check(log.windowBytes === golden.windowBytes, `${name}: window is ${golden.windowBytes} bytes`);
    check(log.fileBytes === golden.fileBytes, `${name}: file is ${golden.fileBytes} bytes`);
    check(same(pairLines(log.items()), golden.items), `${name}: ${golden.items.length} durable (offset, line) pairs`);

    const compaction = log.lastCompaction();
    check(
      same(compaction ? clc.eventToJson(compaction) : null, golden.lastCompaction),
      `${name}: last compaction`,
    );

    // the OTHER reader (tools/recall.py) walks the whole text; on noise.clc it
    // disagrees with the byte reader about the BOM line, and that is contract
    const durable = clc.parseDurable(bytes.toString("utf8")).map((event) => clc.eventToJson(event));
    check(same(durable, golden.durable), `${name}: the text reader yields ${golden.durable.length} events`);

    const rawHead = bytes.subarray(0, Math.min(golden.fileBytes, 24)).toString("utf8");
    check(
      (await log.readRaw(0, Math.min(golden.fileBytes, 24))).toString("utf8") === rawHead,
      `${name}: readRaw reads the bytes it says it does`,
    );

    for (const page of golden.pages) {
      const got = pairLines(await log.readPage(page.lo, page.hi));
      check(same(got, page.items), `${name}: page [${page.lo}, ${page.hi}) has ${page.items.length} events`);
    }

    for (const item of golden.aligned) {
      const got = await log.alignedStart(item.lo, item.reach);
      check(got === item.result, `${name}: alignedStart(${item.lo}, reach ${item.reach}) = ${item.result}`);
    }
  }

  // ---- the header a create writes is itself contract ---------------------
  const meta = { name: "demo", model: "test-model" };
  check(clc.headerText(meta, 0) === GOLDEN.header.text, "header: byte-identical text");
  check(clc.cprLineOffset(meta) === GOLDEN.header.cprLineOffset, "header: cpr_start line offset");
  check(
    clc.eventRegionStart(Buffer.from(GOLDEN.header.text, "utf8")) === GOLDEN.header.eventRegionStart,
    "header: event region starts right after the separator",
  );
  check(clc.CPR_START_LINE_BYTES === GOLDEN.header.cprLineBytes, "header: the cpr_start line is 21 bytes");
  check(Buffer.byteLength(GOLDEN.header.text, "utf8") === GOLDEN.header.size, "header: size");
  check(GOLDEN.header.text.slice(0, 8) === GOLDEN.header.readStart, "header: starts with the format line");

  // `createProject` on a name with no suffix writes the same bytes and adds .clc
  const created = await clc.createProject({ path: at("created"), workspace, ...meta });
  check(created.path === at("created.clc"), "createProject: with_suffix('.clc')");
  check(fs.readFileSync(at("created.clc")).toString("utf8") === GOLDEN.header.text, "createProject: the header bytes");
  check(created.log.fileBytes === GOLDEN.header.size, "createProject: a header-only log");

  // ---- append: a durable line lands at its own offset --------------------
  fs.copyFileSync(path.join(FIX, "plain.clc"), at("append.clc"));
  const before = fs.statSync(at("append.clc")).size;
  const appended = await clc.openProject({ path: at("append.clc"), workspace });
  const event = clc.eventFromDict({
    type: "final",
    timestamp: TS,
    id: "000000000099",
    status: "aborted",
    summary: "appended by the golden",
  });
  await appended.log.append(event);
  const pairs = appended.log.items();
  check(pairs[pairs.length - 1][0] === append.offset, `append: lands at offset ${append.offset}`);
  check(clc.eventToJson(event) === append.line, "append: the exact line");
  check(clc.lineBytes(event) === append.bytes, `append: ${append.bytes} bytes with its newline`);
  check(before === append.fileBytesBefore, "append: size before");
  check(fs.statSync(at("append.clc")).size === append.fileBytesAfter, "append: the file grew by exactly that line");

  // ---- compaction: the window slides IN PLACE in the header ---------------
  fs.copyFileSync(path.join(FIX, "plain.clc"), at("slide.clc"));
  const sliding = await clc.openProject({ path: at("slide.clc"), workspace });
  const target = sliding.log.items()[5][0]; // the second turn's user_message
  const sizeBefore = fs.statSync(at("slide.clc")).size;
  await sliding.log.setCprStart(target);
  const slid = fs.readFileSync(at("slide.clc"));
  const lineOff = clc.findCprLine(slid);
  const line = slid.subarray(lineOff, lineOff + clc.CPR_START_LINE_BYTES).toString("ascii");
  check(target === slide.offset, `set_cpr_start: target offset ${slide.offset}`);
  check(line === slide.headerLine, "set_cpr_start: the fixed-width header line");
  check(sizeBefore === slide.fileBytesBefore, "set_cpr_start: size before");
  check(slid.length === slide.fileBytes, "set_cpr_start: the write is in place, size unchanged");

  const reopened = await clc.openProject({ path: at("slide.clc"), workspace });
  check(reopened.log.cprStart === slide.cprStart, `set_cpr_start: reopen starts at ${slide.cprStart}`);
  check(reopened.log.windowBytes === slide.windowBytes, `set_cpr_start: window is ${slide.windowBytes} bytes`);
  check(same(pairLines(reopened.log.items()), slide.items), "set_cpr_start: only the window's events materialize");

  // ---- a read-only open appends nothing and rewrites nothing --------------
  fs.copyFileSync(path.join(FIX, "plain.clc"), at("ro.clc"));
  const roBefore = fs.readFileSync(at("ro.clc"));
  const ro = await clc.openProject({ path: at("ro.clc"), workspace, readOnly: true });
  await ro.log.append(
    clc.eventFromDict({ type: "final", timestamp: TS, id: "000000000098", status: "error", summary: "must not land" }),
  );
  await ro.log.setCprStart(ro.log.items()[0][0]);
  check(ro.readOnly === readonly.readOnly, "read_only: the project says read-only");
  check(fs.readFileSync(at("ro.clc")).equals(roBefore), "read_only: not one byte on disk changed");
  check(fs.statSync(at("ro.clc")).size === readonly.fileBytes, "read_only: the file did not grow");
  check(ro.log.cprStart === readonly.cprStart, "read_only: the boundary stays in memory");
  check(ro.log.windowBytes === readonly.windowBytes, "read_only: the in-memory append widens the window");

  // ---- POST /api/project/open: the NDJSON body ---------------------------
  for (const name of ["fresh.clc", "plain.clc"]) {
    const lines = [];
    await clc.streamOpen({ path: at(name), workspace, emit: (line) => lines.push(line) });
    const want = expand(GOLDEN.open[name], work);
    check(same(lines, want), `${name}: open stream is ${want.length} lines, byte for byte`);
  }

  // ---- ban X1: there is no local-root way into this module ----------------
  let noWorkspace = null;
  try {
    await clc.openProject({ path: at("plain.clc") });
  } catch (error) {
    noWorkspace = error;
  }
  check(noWorkspace instanceof TypeError, "X1: openProject without a workspace throws TypeError");
  let noCreate = null;
  try {
    await clc.createProject({ path: at("nope"), name: "x", model: "y" });
  } catch (error) {
    noCreate = error;
  }
  check(noCreate instanceof TypeError, "X1: createProject without a workspace throws TypeError");

  // ---- the constants the offsets are built from --------------------------
  check(clc.CPR_START_LINE_W === 20, "constants: cpr_start line is 20 bytes without its newline");
  check(clc.ALIGN_REACH === 4 * 1024 * 1024, "constants: ALIGN_REACH");
  check(clc.DURABLE_TYPES.size === 6 && clc.DURABLE_TYPES.has("compaction"), "constants: six durable types");
  check(clc.HEADER_PREFIX === "# clutch project v1" && clc.SEPARATOR === "---", "constants: header prefix and separator");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clc-replay-"));
  const work = path.join(tmp, "work");
  fs.mkdirSync(work, { recursive: true });
  const names = Object.keys(GOLDEN.files);
  // The `.clc` bytes are generated, not committed (`.gitignore`: *.clc) — only
  // expected.json is in git. A fresh checkout must freeze them first, and the
  // failure should say so instead of dying inside copyFileSync.
  const missing = names.filter((name) => !fs.existsSync(path.join(FIX, name)));
  if (missing.length) {
    check(
      false,
      `the golden capture is incomplete (${missing.join(", ")} missing from tests/fixtures/clc) — ` +
        "regenerate it with: .venv/bin/python -m tests.clc_capture"
    );
    return;
  }
  for (const name of names) fs.copyFileSync(path.join(FIX, name), path.join(work, name));
  try {
    await capture(names, work);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  summary("host-clc");
}

if (require.main === module) {
  main().catch((error) => {
    check(false, `suite crashed: ${(error && error.stack) || error}`);
    summary("host-clc");
  });
}
