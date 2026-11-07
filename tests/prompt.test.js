// ui/prompt.js is the loop's own words, loaded from files: `load` reads a
// template, `render` fills it. These checks pin the placeholder grammar to
// Python's string.Template, the real templates to a documented set of slots,
// and every caller in ui/ to the slots of the template it renders — a template
// that grows a `$name` nobody passes fails here instead of reaching a model
// with "$name" in it. The last section pins the split: these words live here
// and nowhere else, while agent/prompts/ holds only what the MACHINE says.
// Run: node tests/prompt.test.js
const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness.js");
const { PROMPTS_DIR, SAY, isName, substitute, names, load, render, say } = require("../ui/prompt.js");

const UI_DIR = path.join(__dirname, "..", "ui");
const AGENT_PROMPTS = path.join(__dirname, "..", "agent", "prompts");

// What each template asks for. This is the contract: a template whose slots are
// not listed here fails the "no orphan template" check, and a listed slot the
// template does not mention fails the equality check.
//
// `HOME` is the one slot that is never filled: env_windows_cmd.md states that
// `$HOME` does not exist on that host, so the dollar must survive rendering.
const SLOTS = {
  "budget_exceeded.md": ["max_turns"],
  "cancelled.md": [],
  "compaction.md": ["previous_summary", "history"],
  "compaction_files.md": ["files"],
  "compaction_head.md": ["summary"],
  "doom_loop.md": ["tool"],
  "empty_response.md": [],
  "env_windows_bash.md": [],
  "env_windows_cmd.md": ["HOME"],
  "max_tokens.md": [],
  "mode_chat.md": [],
  "mode_work.md": [],
  "recall.md": ["name", "size"],
  "system.md": [],
  "task.md": ["task"],
};

// Slots a template states about the world rather than for the caller to fill.
const LITERAL = new Set(["HOME"]);

function files(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

// ---- every `render("<file>", { ... })` call in the host's modules ----
//
// Read as source, with a brace matcher rather than a regex: the values are real
// expressions (`path.basename(String(memory.path))`), and a caller that grows
// one must not fall out of the scan.
function renderCalls(file) {
  const src = fs.readFileSync(path.join(UI_DIR, file), "utf8");
  const calls = [];
  const at = "render(";
  let i = src.indexOf(at);
  while (i >= 0) {
    let p = i + at.length;
    while (src[p] === " ") p++;
    if (src[p] === '"') {
      const end = src.indexOf('"', p + 1);
      const template = src.slice(p + 1, end);
      p = end + 1;
      while (src[p] === " ") p++;
      let keys = [];
      if (src[p] === ",") {
        p++;
        while (src[p] === " ") p++;
        if (src[p] === "{") {
          // balanced body of the object literal
          let depth = 0, s = p, body = "";
          for (; p < src.length; p++) {
            if (src[p] === "{") {
              depth++;
              if (depth === 1) continue;
            } else if (src[p] === "}") {
              depth--;
              if (depth === 0) break;
            }
            body += src[p];
          }
          // top-level keys: `k: value` or the shorthand `k`
          let d = 0, piece = "";
          for (const ch of body + ",") {
            if ("{([".includes(ch)) d++;
            else if ("})]".includes(ch)) d--;
            if (ch === "," && d === 0) {
              const key = piece.trim().split(":")[0].trim();
              if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
              piece = "";
            } else piece += ch;
          }
        }
      }
      calls.push({ file, template, keys });
    }
    i = src.indexOf(at, i + 1);
  }
  return calls;
}

function main() {
  // ---- 1. the placeholder grammar (string.Template.safe_substitute) ----
  {
    check(substitute("Task: $task", { task: "ship it" }) === "Task: ship it", "$name is filled");
    check(substitute("${task}!", { task: "go" }) === "go!", "${name} is filled");
    check(substitute("$a and $b", { a: "1" }) === "1 and $b", "an unknown $name stays verbatim");
    check(substitute("${a} ${b}", { a: "1" }) === "1 ${b}", "an unknown ${name} stays verbatim");
    check(substitute("cost: $$5", {}) === "cost: $5", "$$ is one literal dollar");
    check(substitute("$a $a", { a: "x" }) === "x x", "a repeated slot is filled every time");
    check(substitute("$a", { a: "$b" }) === "$b", "a value is text, not a second round of slots");
    check(substitute("$a", { a: 0 }) === "0", "0 is a value");
    check(substitute("$a", { a: "" }) === "", "the empty string is a value");
    check(substitute("$a", { a: null }) === "$a", "null is not a value: the slot stays verbatim");
    check(substitute("$a", { a: undefined }) === "$a", "undefined is not a value");
    check(substitute("$a", {}) === "$a", "a missing key is not an error");
    check(substitute("$1", {}) === "$1", "$1 is not a placeholder");
    check(substitute("${}", {}) === "${}", "an empty ${} is not a placeholder");
    check(substitute("${1x}", {}) === "${1x}", "a ${name} starting with a digit is not a placeholder");
    check(substitute("end$", {}) === "end$", "a trailing dollar is literal");
    check(substitute("$name.", { name: "x" }) === "x.", "a name ends at the first non-name character");
    check(substitute("", {}) === "", "empty text stays empty");
    check(substitute("$a", null) === "$a", "no variables at all is safe");
    check(
      substitute("100%_ok and $x", {}) === "100%_ok and $x",
      "a non-dollar run is copied untouched"
    );
    check(isName("HOME") && isName("_x9") && isName("a"), "a name is [_a-zA-Z][_a-zA-Z0-9]*");
    check(!isName("9a") && !isName("") && !isName("a-b"), "and nothing else");
  }

  // ---- 2. load / render over the real files ----
  {
    const system = load("system.md");
    check(system === fs.readFileSync(path.join(PROMPTS_DIR, "system.md"), "utf8"), "load reads the template");
    check(/^You are clutch/.test(system), "system.md is the loop's own system message");
    check(render("task.md", { task: "do it" }) === "Task: do it\n", "render fills a template");
    check(render("cancelled.md") === load("cancelled.md"), "render with no variables is the file");
    check(render("task.md", { other: "x" }) === "Task: $task\n", "an unfilled slot survives render");

    let threw = 0;
    for (const bad of ["", null, "../system.md", "prompts/system.md", "/etc/passwd"]) {
      try {
        load(bad);
      } catch (e) {
        threw += e instanceof TypeError ? 1 : 0;
      }
    }
    check(threw === 5, "load takes a file name, never a path");

    let missing = false;
    try {
      load("nope.md");
    } catch (e) {
      missing = e && e.code === "ENOENT";
    }
    check(missing, "a template that does not exist is an error, not an empty prompt");
  }

  // ---- 3. the templates and their slots ----
  {
    const present = files(PROMPTS_DIR);
    check(present.length === Object.keys(SLOTS).length, "ui/prompts holds every top-level template");
    check(
      present.every((f) => SLOTS[f]),
      "no template without a documented set of slots: " + present.filter((f) => !SLOTS[f]).join(", ")
    );
    check(
      Object.keys(SLOTS).every((f) => present.includes(f)),
      "no documented template missing from ui/prompts"
    );
    const wrong = [];
    for (const [file, expected] of Object.entries(SLOTS)) {
      const got = names(load(file)).sort();
      if (got.join(",") !== expected.slice().sort().join(",")) wrong.push(`${file}: ${got.join(",")}`);
    }
    check(!wrong.length, "each template asks for exactly its documented slots" + (wrong.length ? ": " + wrong.join("; ") : ""));

    // a rendered prompt never contains a slot the caller was supposed to fill
    const leftovers = [];
    for (const [file, expected] of Object.entries(SLOTS)) {
      const vars = {};
      for (const k of expected) vars[k] = `«${k}»`;
      const still = names(render(file, vars)).filter((n) => !LITERAL.has(n));
      if (still.length) leftovers.push(`${file}: ${still.join(",")}`);
    }
    check(!leftovers.length, "rendering with its slots leaves no placeholder behind" + (leftovers.length ? ": " + leftovers.join("; ") : ""));
    check(
      render("env_windows_cmd.md").includes("$HOME"),
      "env_windows_cmd.md keeps $HOME: on that host it is a variable that does not exist, not a slot"
    );
  }

  // ---- 4. the caller and the template agree ----
  //
  // Every render call in the host's own modules names a template and the
  // variables it has. Compared against SLOTS, so a template that grows a slot —
  // or a caller that forgets one — fails here rather than reaching the model.
  {
    const calls = [...renderCalls("context.js"), ...renderCalls("prompt.js")].filter(
      (c) => SLOTS[c.template]
    );
    check(calls.length >= 8, "the caller's render calls are visible to this check");
    const mismatch = [];
    for (const c of calls) {
      const needed = SLOTS[c.template].filter((n) => !LITERAL.has(n)).sort().join(",");
      const given = c.keys.slice().sort().join(",");
      if (needed !== given) mismatch.push(`${c.file}: ${c.template} needs [${needed}] got [${given}]`);
    }
    check(!mismatch.length, "every render call passes exactly the template's slots" + (mismatch.length ? ": " + mismatch.join("; ") : ""));
    const named = new Set(calls.map((c) => c.template));
    check(named.has("system.md") && named.has("task.md"), "the two every-turn templates are among them");
  }

  // ---- 5. the loop's prose (run.js's `text` port) ----
  {
    check(say("cancelled") === load("cancelled.md"), "say(cancelled) is the cancelled note");
    check(say("empty_response").includes("no visible text"), "say(empty_response) tells the model to answer visibly");
    check(say("max_tokens").includes("max_tokens limit"), "say(max_tokens) explains the truncation");
    // the two guard notes are the ones with slots: the loop passes what it ended
    // the turn for, so these are the only SAY entries a caller fills (P4-3)
    check(say("doom_loop", { tool: "run_command" }).includes("`run_command`"), "say(doom_loop) names the tool it was given");
    check(!say("doom_loop", { tool: "run_command" }).includes("$tool"), "and leaves no slot behind");
    check(
      say("budget_exceeded", { max_turns: 3 }).includes("maximum of 3 turns"),
      "say(budget_exceeded) states the limit it was given"
    );
    check(!say("budget_exceeded", { max_turns: 3 }).includes("$max_turns"), "and leaves no slot behind");
    check(
      Object.keys(SAY).join(",") === "budget_exceeded,cancelled,doom_loop,empty_response,max_tokens",
      "the loop's five notes are the map"
    );
    let threw = null;
    try {
      say("nope");
    } catch (e) {
      threw = e;
    }
    check(threw && /not one of/.test(threw.message), "an unknown note is an error, not silence");
  }

  // ---- 6. the split: the host owns the loop's words, the machine its own ----
  //
  // A template the loop assembles a turn from lives in ui/prompts/ and nowhere
  // else. agent/prompts/ keeps what the MACHINE says while executing: the
  // answers registry.py and transport.py render at the model (`unknown_tool.md`,
  // `errors/*`) and the per-tool prose host.py hands it. Two copies of one
  // event's words would be two answers to it, so the copies stay deleted.
  {
    const machineTop = files(AGENT_PROMPTS);
    check(
      machineTop.join(",") === "unknown_tool.md",
      "agent/prompts keeps one top-level template, the unknown-tool answer: " + machineTop.join(",")
    );
    const twice = files(PROMPTS_DIR).filter((f) => machineTop.includes(f));
    check(
      !twice.length,
      "no top-level template the loop renders is written on the machine side too" +
        (twice.length ? ": " + twice.join(", ") : "")
    );

    // Everything else the machine holds is execution text as well: an answer
    // under errors/, or prose under tools/ naming a tool the model may call.
    const mdUnder = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.isDirectory()) return mdUnder(path.join(dir, e.name)).map((f) => e.name + "/" + f);
        return e.name.endsWith(".md") ? [e.name] : [];
      });
    const stray = mdUnder(AGENT_PROMPTS).filter(
      (f) => !f.startsWith("errors/") && !f.startsWith("tools/") && f !== "unknown_tool.md"
    );
    check(
      !stray.length,
      "everything else under agent/prompts is execution text" + (stray.length ? ": " + stray.join(", ") : "")
    );

    // The one accepted duplication: the frozen machine bundle ships agent/ only,
    // so the client cannot read this prose from there and keeps its own copy.
    // Same names, same bytes — a reader on either side sees one text.
    const uiTools = files(path.join(PROMPTS_DIR, "tools"));
    const machineTools = files(path.join(AGENT_PROMPTS, "tools"));
    check(
      uiTools.length > 0 && uiTools.join(",") === machineTools.join(","),
      "the tool prose is the same set of names on both sides"
    );
    const diff = uiTools.filter((f) => {
      const there = path.join(AGENT_PROMPTS, "tools", f);
      return !fs.existsSync(there) ||
        fs.readFileSync(path.join(PROMPTS_DIR, "tools", f), "utf8") !== fs.readFileSync(there, "utf8");
    });
    check(!diff.length, "and byte-identical" + (diff.length ? ": " + diff.join(", ") : ""));
  }

  summary("prompt: the loop's words, loaded from files (grammar / real templates / callers / the host-machine split)");
}

main();
