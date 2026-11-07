// The log's vocabulary is written twice, in two languages, and that is the one
// copy that cannot be removed: the renderer names a durable event in order to
// fold it, the machine names one in order to write or accept it, and neither can
// import the other's source (no build step — D14 — and the log itself is the
// contract, P2). Both halves used to be a hand-copied set, which meant a name
// added on one side and forgotten on the other changed NOTHING that any test
// could see: a durable name unknown to the machine's writer would be dropped as
// a display fact, and a durable name unknown to the renderer's fold would be a
// line in the file that no reader could build. Silent, and in a file the user
// keeps forever.
//
// P7-2 splits that into the two things it actually is:
//
//   * ONE fact on the JS side — ui/run-state.js holds a `DurableEventType`
//     union beside a `Record<DurableEventType, true>`, so `npm run typecheck`
//     rejects a name added to the type and not the record, or the reverse. A
//     type can say "the renderer agrees with itself"; that is all it can say.
//   * ONE assertion across the language boundary — this suite. It reads
//     agent/events.py as text (there is no Python↔JS type bridge to abuse) and
//     fails when the two sets differ by a single name.
//
// What is pinned here:
//
//   1. The two sets are EQUAL, not merely overlapping — a name on either side
//      alone is a failure, and the message names the direction.
//   2. Every durable name is a real event on the machine side (agent/events.py
//      has a class whose `type` is that name), so `/api/log` never answers a
//      type no reader can build.
//   3. One Python definition and no second copy: the endpoints import the set,
//      they do not re-list it. (A second literal is how the first drift starts.)
//   4. No third JS copy either. The only other set of these names in the
//      renderer is compaction's transcript, and it is pinned to the four a
//      summarizer reads minus the six — so adding a durable type cannot slide
//      into a summarizer's window without this file going red.
//   5. The display-only names are in neither set, and are real events: the
//      direction that is easy to forget, because a delta that became durable
//      would be written to the user's .clc forever.
//
// Run: node tests/durable-types.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The renderer's vocabulary, as the fold itself sees it.
const { DURABLE_TYPES } = require("../ui/run-state.js");

// The six names, spelled once here only so a failure can be read without
// opening two files. Nothing below trusts this list: every check compares the
// two real sources, and this one is compared to both.
const SIX = ["user_message", "assistant_message", "tool_call", "tool_result", "final", "compaction"];
const DISPLAY_ONLY = [
  "text_delta",
  "reasoning_delta",
  "tool_call_delta",
  "compaction_delta",
  "step_start",
  "state_update",
  "permission_request",
  "llm_retry",
];

const sorted = (set) => [...set].sort();

// ---- 1. the machine's list, read as text (it is the contract, not an import) ----
const py = read("agent/events.py");
// the source, not the build output: this asserts on how the file is written
const runState = read("ui/src/host/run-state.ts");
const assignments = [...py.matchAll(/^DURABLE_TYPES = \{([^}]*)\}/gm)];
check(assignments.length === 1, `agent/events.py defines DURABLE_TYPES exactly once (found ${assignments.length})`);

const pyNames = new Set([...(assignments[0] ? assignments[0][1] : "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
const jsNames = new Set(DURABLE_TYPES);

check(sorted(pyNames).join(",") === SIX.slice().sort().join(","), `the machine writes six durable types (got ${sorted(pyNames).join(",")})`);
check(sorted(jsNames).join(",") === SIX.slice().sort().join(","), `the renderer folds six durable types (got ${sorted(jsNames).join(",")})`);

const onlyPy = sorted(pyNames).filter((n) => !jsNames.has(n));
const onlyJs = sorted(jsNames).filter((n) => !pyNames.has(n));
check(
  onlyPy.length === 0 && onlyJs.length === 0,
  `the two halves name the SAME events (only in Python: ${onlyPy.join(",") || "—"}; only in JS: ${onlyJs.join(",") || "—"})`
);

// ---- 2. a durable name is a real event class on the machine side ----
// `EVENT_TYPES` is built from the classes themselves, so the class default is
// where a name actually lives; reading the defaults is reading the registry
// without importing Python.
const classTypes = new Set([...py.matchAll(/^    type: str = "([a-z_]+)"$/gm)].map((m) => m[1]));
const classless = sorted(pyNames).filter((n) => !classTypes.has(n));
check(classless.length === 0, `every durable type has an event class (no class for: ${classless.join(",") || "—"})`);

// ---- 3. one Python definition, and the endpoints import it ----
function pyFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__pycache__") continue;
      out.push(...pyFiles(rel));
    } else if (ent.name.endsWith(".py")) {
      out.push(rel);
    }
  }
  return out;
}

const redefinitions = pyFiles("agent").filter((rel) => /^DURABLE_TYPES = /m.test(read(rel)));
check(
  redefinitions.join(",") === "agent/events.py",
  `the machine has ONE definition of the set (redefined in: ${redefinitions.join(",") || "—"})`
);

// The one place it is enforced on the way in: the append endpoint. If that ever
// stops consulting the imported set, "durable" would mean two different things.
check(
  /kind not in DURABLE_TYPES/.test(read("agent/api/log.py")),
  "the append endpoint refuses a non-durable kind by the imported set, not its own list"
);

// ---- 4. no third copy in the renderer ----
// Any bracket literal in ui/*.js or ui/js/*.js that names three or more of the
// six is a copy of the vocabulary. Two files are allowed to have one, and only
// these two: the fact itself, and compaction's transcript (which is not the
// same set — see below).
const uiDirs = ["ui", "ui/js"];
const uiJsFiles = [];
for (const dir of uiDirs) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    if (name.endsWith(".js")) uiJsFiles.push(path.posix.join(dir, name));
  }
}
const ALLOWED = new Set(["ui/compaction.js"]);
const copies = [];
for (const rel of uiJsFiles) {
  const src = read(rel);
  for (const m of src.matchAll(/\[([^\[\]]*)\]/g)) {
    const named = SIX.filter((t) => new RegExp(`"${t}"`).test(m[1]));
    if (named.length >= 3) copies.push(rel);
  }
}
check(
  [...new Set(copies)].sort().join(",") === [...ALLOWED].sort().join(","),
  `the only bracket list of the names is compaction's transcript — the fact itself is a typed record, not a list (found: ${[...new Set(copies)].sort().join(",") || "—"})`
);
// ...and the fact is where it says it is: all six names are keys of the record
// the set is derived from, so "the set" and "the vocabulary" cannot be two
// different objects in this file.
check(
  SIX.every((t) => new RegExp(`^  ${t}: true,$`, "m").test(runState)),
  "every durable type is a key of the typed record the set is built from"
);

// ...and the transcript is a DELIBERATE subset, not the same set: a summarizer
// reads the conversation, so a final (a run's verdict) and a compaction line
// (the head the window already carries) are not something said. Pinning both
// directions means a seventh durable type cannot slip into the transcript, and
// a transcript entry cannot disappear while the fold still counts on it.
const { TRANSCRIPT } = require("../ui/compaction.js");
const transcript = new Set(TRANSCRIPT);
const dropped = sorted(DURABLE_TYPES).filter((t) => !transcript.has(t));
check(dropped.join(",") === "compaction,final", `the transcript is the durable set minus the head and the verdict (dropped: ${dropped.join(",") || "—"})`);
const extra = sorted(transcript).filter((t) => !DURABLE_TYPES.has(t));
check(extra.length === 0, `nothing outside the durable set is in a transcript (extra: ${extra.join(",") || "—"})`);

// ---- 5. the display-only names are in neither set, and are real events ----
const leaked = DISPLAY_ONLY.filter((n) => pyNames.has(n) || jsNames.has(n));
check(leaked.length === 0, `no display-only name is durable on either side (leaked: ${leaked.join(",") || "—"})`);
const unknown = DISPLAY_ONLY.filter((n) => !classTypes.has(n));
check(unknown.length === 0, `the display-only names are real events, not typos in this list (unknown: ${unknown.join(",") || "—"})`);

// ---- 6. the fold actually reads the one set ----
check(/DURABLE_TYPES\.has\(/.test(runState), "the fold's predicate is the set, not a second inline list");
check(/ReadonlySet<DurableEventType>/.test(runState), "the set's declared type is the one union: the gate holds the two statements together");

summary("durable-types");
