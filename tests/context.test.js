// ui/context.js derives the messages a model turn is asked with, from the log
// alone. These checks drive the pure projection against hand-built event lists:
// the window/head split a compaction makes, the pairing repair a death mid-batch
// leaves behind, and the system message's optional facts (mode, components,
// shell, the memory anchor). One check wires it into the real loop, because the
// port shape is the thing that has to fit.
// Run: node tests/context.test.js
const { check, summary } = require("./harness.js");
const { render } = require("../ui/prompt.js");
const {
  size,
  recentWorkingFiles,
  toMessages,
  repairDangling,
  systemMessage,
  deriveMessages,
  createDerive,
} = require("../ui/context.js");
const { createRun } = require("../ui/run.js");

const user = (content) => ({ type: "user_message", content });
const said = (content, tool_calls = [], reasoning = "") => ({
  type: "assistant_message",
  content,
  tool_calls,
  reasoning,
});
const call = (id, args = "{}", path_arg = "") => ({
  type: "tool_call",
  name: "run_command",
  arguments: args,
  tool_call_id: id,
  ui: {},
  path_arg,
});
const result = (id, content = "ok") => ({
  type: "tool_result",
  tool_call_id: id,
  content,
  is_error: false,
  diff: "",
});
const compact = (summary) => ({ type: "compaction", summary });

function main() {
  // ---- 1. bytes, in the units the prompt reads ----
  {
    check(size(0) === "1 KB", "an empty log is 1 KB, not 0 KB");
    check(size(500) === "1 KB", "a small log rounds up to 1 KB");
    check(size(1024) === "1 KB", "1024 bytes is 1 KB");
    check(size(2048) === "2 KB", "2048 bytes is 2 KB");
    check(size(1024 * 1024) === "1.0 MB", "a megabyte is spelled 1.0 MB");
    check(size(Math.round(1.5 * 1024 * 1024)) === "1.5 MB", "half a megabyte is a decimal");
    check(size("broken") === "1 KB", "a number that is not a number is not NaN in the prompt");
  }

  // ---- 2. events to messages ----
  {
    const msgs = toMessages([
      user("hi"),
      said("", [{ id: "c1", name: "run_command", arguments: '{"cmd":"ls"}' }], "thinking"),
      result("c1", "a.txt"),
      said("that is all"),
    ]);
    check(msgs.length === 4, "every visible event is a message");
    check(msgs[0].role === "user" && msgs[0].content === "hi", "a user message is text");
    check(msgs[1].role === "assistant", "an assistant turn keeps its role");
    check(!("content" in msgs[1]), "an assistant turn that said nothing has no content key");
    check(msgs[1].reasoning_content === "thinking", "reasoning is replayed (some APIs require it)");
    check(
      msgs[1].tool_calls.length === 1 &&
        msgs[1].tool_calls[0].type === "function" &&
        msgs[1].tool_calls[0].id === "c1" &&
        msgs[1].tool_calls[0].function.name === "run_command" &&
        msgs[1].tool_calls[0].function.arguments === '{"cmd":"ls"}',
      "a call is replayed in the wire's shape"
    );
    check(msgs[2].role === "tool" && msgs[2].tool_call_id === "c1", "a result answers its call");
    check(msgs[3].content === "that is all", "the final assistant turn is text");
    check(
      !("tool_calls" in msgs[3]) && !("reasoning_content" in msgs[3]),
      "a turn with no calls and no reasoning carries neither key"
    );

    const ignored = toMessages([
      call("c1"),
      { type: "final", status: "completed", summary: "done" },
      compact("s"),
      { type: "state_update", state: "running" },
    ]);
    check(ignored.length === 0, "calls, finals, compactions and display events are not model-visible");

    check(toMessages([]).length === 0, "no events is no messages");
    check(toMessages(null).length === 0, "nothing at all is no messages");
  }

  // ---- 3. the pairing repair ----
  {
    const complete = toMessages([user("q"), said("", [{ id: "c1", name: "t", arguments: "{}" }]), result("c1")]);
    check(complete.length === 3, "a complete call block is kept as-is");

    const interrupted = toMessages([
      user("q"),
      said("let me look", [{ id: "c1", name: "t", arguments: "{}" }]),
    ]);
    check(interrupted.length === 2, "an unanswered call block is cut back to its text");
    check(interrupted[1].content === "let me look" && !("tool_calls" in interrupted[1]), "text that stood alone still stands");

    const silent = toMessages([user("q"), said("", [{ id: "c1", name: "t", arguments: "{}" }])]);
    check(silent.length === 1, "an unanswered call with no text leaves nothing at all");

    const orphan = repairDangling([{ role: "user", content: "q" }, { role: "tool", tool_call_id: "x", content: "r" }]);
    check(orphan.length === 1, "an orphan tool message is dropped");

    const emptyAssistant = repairDangling([{ role: "user", content: "q" }, { role: "assistant" }]);
    check(emptyAssistant.length === 1, "an assistant message with no text cannot stand alone");

    const halfAnswered = repairDangling([
      {
        role: "assistant",
        content: "calling two",
        tool_calls: [
          { id: "a", type: "function", function: { name: "t", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "t", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "1" },
    ]);
    check(halfAnswered.length === 1 && halfAnswered[0].content === "calling two", "half a batch is not a block: the calls go, the text stays");
  }

  // ---- 4. the files a compaction rolled away ----
  {
    const files = recentWorkingFiles([
      call("1", '{"path":"a.txt"}', "path"), // older: comes last
      result("1"),
      call("2", '{"path":"b.txt"}', "path"),
      call("3", '{"path":"a.txt"}', "path"),
      call("4", '{"path":"c.txt"}', "path"),
    ]);
    check(files.join(",") === "c.txt,a.txt,b.txt", "most recent first, no duplicates");

    check(
      recentWorkingFiles([
        call("1", '{"cmd":"ls"}', ""),
        call("2", '{"path":"a.txt"}', "path"),
        call("3", "not json", "path"),
        call("4", '{"path":42}', "path"),
        call("5", '{"path":"b.txt"}', "path"),
      ]).join(",") === "b.txt,a.txt",
      "only a path the tool named counts, and a broken argument list is skipped"
    );

    let many = [];
    for (let i = 0; i < 9; i++) many.push(call(String(i), `{"path":"f${i}.txt"}`, "path"));
    check(recentWorkingFiles(many).length === 6, "the list is capped at six");
    check(recentWorkingFiles(many, 2).length === 2, "the cap is the caller's");
  }

  // ---- 5. the system message's optional facts ----
  {
    const base = render("system.md");
    check(systemMessage({}) === base, "no facts is the bare system message");
    check(systemMessage({ mode: "chat" }).endsWith(render("mode_chat.md")), "chat mode states its read-only contract");
    check(systemMessage({ mode: "work" }).endsWith(render("mode_work.md")), "work mode states full access");
    check(systemMessage({ mode: "" }) === base, "no mode states nothing");
    check(systemMessage({ mode: "debug" }) === base, "an unknown mode is not a mode");
    check(
      systemMessage({ components: "## tools\n- read" }).endsWith("## tools\n- read"),
      "the components' own words are placed, not rewritten"
    );
    check(systemMessage({ components: "" }) === base, "no components is no section");
    check(systemMessage({ shell: "bash" }).endsWith(render("env_windows_bash.md")), "a Windows host speaking bash says so");
    check(systemMessage({ shell: "cmd" }).endsWith(render("env_windows_cmd.md")), "a Windows host speaking cmd says so");
    check(systemMessage({ shell: "posix-sh" }) === base, "POSIX sh adds nothing");

    const anchor = systemMessage({ memory: { path: "/home/me/p/state.clc", bytes: 4096 } });
    check(anchor.endsWith(render("recall.md", { name: "state.clc", size: "4 KB" })), "the memory anchor names the log and its size");
    check(systemMessage({ memory: { bytes: 4096 } }) === base, "no path is no anchor: nothing to promise a reader");
    check(
      systemMessage({ memory: { path: "C:\\proj\\state.clc", bytes: 10 } }).includes("state.clc"),
      "the anchor is a file name, whatever the separator"
    );

    const order = systemMessage({ mode: "work", components: "C", shell: "bash", memory: { path: "s.clc", bytes: 1 } });
    check(
      order === [base, render("mode_work.md"), "C", render("env_windows_bash.md"), render("recall.md", { name: "s.clc", size: "1 KB" })].join("\n\n"),
      "the sections are placed in order, separated by a blank line"
    );
  }

  // ---- 6. derive: the task, the window, the head ----
  {
    const first = deriveMessages({ events: [user("add a flag")], task: "add a flag" });
    check(first.length === 2, "a fresh turn is the system message and the task");
    check(first[0].role === "system" && first[0].content === render("system.md"), "the system message comes first");
    check(first[1].content === render("task.md", { task: "add a flag" }), "the task is re-injected as its own message");

    // the log's first user message IS the task: it came from the task line
    check(deriveMessages({ events: [user("t")], task: "t" }).length === 2, "the task is not in the context twice");
    // ...but in a continued session it is the project's first requirement
    const continued = deriveMessages({ events: [user("first ask"), user("second ask")], task: "second ask" });
    check(continued.length === 4, "a continued session keeps its first requirement");
    check(continued[2].content === "first ask", "and that is the old ask, not the new task");
    check(continued[3].content === "second ask", "the new task is still re-injected");

    // a log that opens with something else is left alone
    const noUser = deriveMessages({ events: [said("hello")], task: "t" });
    check(noUser.length === 3 && noUser[2].content === "hello", "a log that does not open with the task is untouched");

    const compacted = deriveMessages({
      events: [
        user("old task"),
        said("old work"),
        compact("the summary"),
        call("c1", '{"path":"a.txt"}', "path"),
        result("c1"),
        said("", [{ id: "c2", name: "t", arguments: "{}" }]),
        call("c2", '{"path":"b.txt"}', "path"),
        result("c2"),
        said("new work"),
      ],
      task: "new task",
    });
    check(compacted.length === 7, "the head, the task, and only the window");
    check(compacted[2].content === render("compaction_head.md", { summary: "the summary" }), "the summary is the head");
    check(compacted[3].content === render("compaction_files.md", { files: "b.txt, a.txt" }), "rolled-away files are named for re-reading");
    check(!compacted.some((m) => m.content === "old work"), "summarized history never re-enters the context");
    check(compacted[4].role === "assistant" && compacted[5].role === "tool", "the window is projected after the head");
    check(compacted[6].content === "new work", "and it ends where the log does");

    // a result whose assistant turn sits before the compaction has no owner in
    // the window: it is dropped rather than sent as an orphan tool message
    const orphaned = deriveMessages({
      events: [compact("s"), call("c1"), result("c1"), said("after")],
      task: "t",
    });
    check(orphaned.length === 4 && orphaned[3].content === "after", "a window that opens mid-batch is repaired");

    const noFiles = deriveMessages({ events: [user("q"), compact("s"), said("after")], task: "q" });
    check(noFiles.length === 4, "no working files is no re-read note");
    check(noFiles[2].content === render("compaction_head.md", { summary: "s" }), "the head still lands");

    const twice = deriveMessages({ events: [compact("first"), said("a"), compact("second"), said("b")], task: "t" });
    check(twice[2].content === render("compaction_head.md", { summary: "second" }), "the NEWEST compaction is the head");
    check(twice.length === 4, "and only what follows it is the window");

    const repaired = deriveMessages({
      events: [user("q"), said("looking", [{ id: "c1", name: "t", arguments: "{}" }])],
      task: "q",
    });
    check(repaired.length === 3, "the window is repaired before the model sees it");

    let threw = null;
    try {
      deriveMessages({ events: "not events", task: "t" });
    } catch (e) {
      threw = e;
    }
    check(threw instanceof TypeError, "events must be the log");
    threw = null;
    try {
      deriveMessages({ events: [] });
    } catch (e) {
      threw = e;
    }
    check(threw instanceof TypeError, "a turn without a task is not a turn");
  }

  // ---- 7. the port the loop calls ----
  {
    const derive = createDerive({ mode: "chat", shell: "bash", components: "## tools" });
    const msgs = derive({ events: [user("t")], task: "t" });
    check(msgs[0].content.includes(render("mode_chat.md")), "createDerive pins the session's facts");
    check(msgs[0].content.includes(render("env_windows_bash.md")), "including the shell");
    check(msgs[0].content.includes("## tools"), "and the components");
    check(msgs[0].content.endsWith(render("env_windows_bash.md")), "placed before the shell hint");

    // wired into the real loop: `derive({events, task})` is run.js's port shape
    let asked = null;
    const log = [];
    const run = createRun({
      read: async () => log.slice(),
      append: async (ev) => {
        log.push(ev);
        return { ...ev, log_offset: log.length - 1 };
      },
      derive: createDerive({ mode: "work" }),
      model: async ({ messages }) => {
        asked = messages;
        return { content: "done", toolCalls: [], finishReason: "stop" };
      },
      runTool: async () => ({ content: "", isError: false, diff: "" }),
      text: (key) => `note:${key}`,
      shouldCompact: async () => false,
      compact: async () => false,
    });
    return (async () => {
      await run.start("ship it");
      await run.drive();
      check(asked && asked[1].content === render("task.md", { task: "ship it" }), "the loop's first ask carries the task line");
      check(asked[0].content.includes(render("mode_work.md")), "and the session's mode contract");
      check(log[log.length - 1].type === "final", "and the turn closes as usual");
      summary("context: the messages a turn is asked with (size / projection / repair / head / ports)");
    })();
  }
}

main();
