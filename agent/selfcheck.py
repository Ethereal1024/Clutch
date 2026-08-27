"""Self-check: validates core logic without needing the LLM.

Run: uv run python -m agent.selfcheck
Covers: parsing, message derivation, sandbox path safety, tool execution,
doom-loop detection, verification gate.
"""

from __future__ import annotations

import sys
import tempfile

from .config import Config
from .core.context import derive_messages
from .core.parse import ParseError, parse_arguments
from .core.terminate import Terminator
from .events import AssistantMessageEvent, EventLog, ToolResultEvent
from .tools.registry import ToolRegistry, build_default_tools
from .tools.sandbox import Sandbox
from .skills import load_skill_library


def check(cond: bool, name: str) -> None:
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok:   {name}")


def main() -> None:
    config = Config()

    # 1. argument parsing
    d = parse_arguments('{"path": "a.py", "content": "x"}')
    check(d == {"path": "a.py", "content": "x"}, "parse_arguments valid json")
    try:
        parse_arguments("{bad json")
        check(False, "parse_arguments rejects invalid json")
    except ParseError:
        check(True, "parse_arguments rejects invalid json")

    # 2. message derivation: assistant(tool_calls) -> paired tool result
    log = EventLog()
    log.append(AssistantMessageEvent(content="", tool_calls=[{"id": "c1", "name": "read_file", "arguments": "{}"}]))
    log.append(ToolResultEvent(tool_call_id="c1", content="file content"))
    msgs = derive_messages(log, config, "test")
    check(msgs[0]["role"] == "system", "derive_messages prepends system")
    check(msgs[2]["role"] == "assistant" and msgs[2]["tool_calls"][0]["id"] == "c1", "assistant tool_calls preserved")
    check(msgs[3] == {"role": "tool", "tool_call_id": "c1", "content": "file content"}, "tool result paired")

    # 3. sandbox path escape protection
    with tempfile.TemporaryDirectory() as tmp:
        sb = Sandbox(tmp)
        try:
            sb.resolve("../outside.txt")
            check(False, "sandbox blocks path escape")
        except ValueError:
            check(True, "sandbox blocks path escape")
        p = sb.resolve("sub/x.py")
        check(str(p).startswith(tmp), "sandbox resolves inside")

        # 4. tool execution + write/read roundtrip
        reg = ToolRegistry(build_default_tools(config))
        r = reg.execute(sb, config, "write_file", {"path": "a.txt", "content": "hello"})
        check(not r.get("error"), "write_file ok")
        r = reg.execute(sb, config, "read_file", {"path": "a.txt"})
        check(r["content"].strip() == "hello", "read_file roundtrip")
        r = reg.execute(sb, config, "run_command", {"command": "echo hi"})
        check("hi" in r["content"], "run_command executes")
        r = reg.execute(sb, config, "run_command", {"command": "nonexistent_cmd_xyz"})
        check(r.get("error"), "run_command reports missing cmd")
        r = reg.execute(sb, config, "no_such_tool", {})
        check(r.get("error"), "registry rejects unknown tool")
        r = reg.execute(sb, config, "write_file", {"path": "../../escape.txt", "content": "x"})
        check(r.get("error"), "tool blocks path escape")

        # 5. doom-loop detection
        term = Terminator(config)
        hit = False
        for _ in range(4):
            hit = term.record_call("run_command", '{"command": "ls"}')
        check(hit, "doom-loop detected after 4 identical calls")
        term2 = Terminator(config)
        for i in range(4):
            term2.record_call("run_command", f'{{"command": "ls{i}"}}')
        check(not term2.record_call("run_command", '{"command": "ls1"}'), "varying calls not doom-loop")

        # 6. verification gate
        vterm = Terminator(Config(verify_command="echo pass"))
        v = vterm.verify(sb)
        check(v.done and v.status == "completed", "verify gate passes on success")
        vterm2 = Terminator(Config(verify_command="false"))
        v = vterm2.verify(sb)
        check(not v.done and v.status == "verify_failed", "verify gate fails on failure")

    # 7. skills: frontmatter parse + keyword match + task-driven injection
    from pathlib import Path

    lib = load_skill_library(Path(__file__).resolve().parent / "skills")
    check(len(lib.skills) >= 1, "skill library loads at least web-design")
    matched = lib.match("build a landing page for our product with html and css")
    check(any(s.name == "web-design" for s in matched), "web-design matches on frontend keywords")
    check(lib.match("implement a sorting algorithm") == [], "unrelated task matches nothing")
    section = lib.to_system_section("make a website")
    check("app.test.js" in section, "skill content injected as system section")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
