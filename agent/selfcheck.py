"""Self-check: validates core logic without needing the LLM.

Run: uv run python -m agent.selfcheck
Covers: parsing, message derivation, workspace path safety, tool execution,
doom-loop detection, verification gate.
"""

from __future__ import annotations

import sys
import tempfile

from .config import Config
from .core.context import derive_messages
from .core.parse import ParseError, parse_arguments
from .core.terminate import Terminator
from .events import AssistantMessageEvent, EventLog, ToolResultEvent, UserMessageEvent
from .skills import load_skill_library
from .testsupport import check
from .tools.registry import ToolRegistry, build_default_tools
from .tools.workspace import LocalWorkspace


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

    # 2b. dangling tool_calls (crash/connection drop left the .clc mid-batch) must not
    # reach the API: the incomplete assistant block is stripped, the user turn survives
    log = EventLog()
    log.append(
        AssistantMessageEvent(
            content="",
            tool_calls=[
                {"id": "c1", "name": "read_file", "arguments": "{}"},
                {"id": "c2", "name": "read_file", "arguments": "{}"},
            ],
        )
    )
    log.append(ToolResultEvent(tool_call_id="c1", content="only c1 landed"))
    log.append(UserMessageEvent(content="continue"))
    msgs = derive_messages(log, config, "test")
    check(
        not any(m["role"] == "assistant" and "tool_calls" in m for m in msgs),
        "dangling tool_calls stripped from context",
    )
    check(not any(m["role"] == "tool" for m in msgs), "orphan/partial tool messages dropped")
    check(msgs[-1] == {"role": "user", "content": "continue"}, "user turn survives dangling block")

    # 2c. assistant with real text + dangling tool_calls keeps the text, drops the calls
    log = EventLog()
    log.append(
        AssistantMessageEvent(
            content="I started exploring",
            tool_calls=[{"id": "c1", "name": "read_file", "arguments": "{}"}],
        )
    )
    msgs = derive_messages(log, config, "test")
    last_assistant = [m for m in msgs if m["role"] == "assistant"][-1]
    check(
        last_assistant.get("content") == "I started exploring" and "tool_calls" not in last_assistant,
        "dangling block keeps text, drops tool_calls",
    )

    # 3. workspace path escape protection
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        try:
            sb.resolve("../outside.txt")
            check(False, "workspace blocks path escape")
        except ValueError:
            check(True, "workspace blocks path escape")
        p = sb.resolve("sub/x.py")
        check(str(p).startswith(tmp), "workspace resolves inside")
        try:
            sb.resolve("../../etc/passwd")
            check(False, "workspace.resolve rejects outside path")
        except ValueError:
            check(True, "workspace.resolve rejects outside path")

        # 4. tool execution + write/read roundtrip
        reg = ToolRegistry(build_default_tools(config))
        r = reg.execute(sb, config, "write_file", {"path": "a.txt", "content": "hello"})
        check(not r["error"], "write_file ok")
        r = reg.execute(sb, config, "read_file", {"path": "a.txt"})
        check(r["content"].strip() == "hello", "read_file roundtrip")
        r = reg.execute(sb, config, "run_command", {"command": "echo hi"})
        check("hi" in r["content"], "run_command executes")
        r = reg.execute(sb, config, "run_command", {"command": "echo a && echo b"})
        check("a" in r["content"] and "b" in r["content"], "run_command supports && (shell semantics)")
        r = reg.execute(sb, config, "run_command", {"command": "echo hi | tr a-z A-Z"})
        check("HI" in r["content"], "run_command supports pipes")
        r = reg.execute(sb, config, "run_command", {"command": "echo data > out.txt && cat out.txt"})
        check("data" in r["content"], "run_command supports redirects")
        r = reg.execute(sb, config, "run_command", {"command": "python3 -m json.tool --help 2>&1 || true"})
        check(not r["error"], "run_command allows python3 -m module mode")
        r = reg.execute(sb, config, "run_command", {"command": "python3"})
        check(r["error"], "run_command still blocks bare python")
        r = reg.execute(sb, config, "run_command", {"command": "nonexistent_cmd_xyz"})
        check(r["error"], "run_command reports missing cmd")
        r = reg.execute(sb, config, "no_such_tool", {})
        check(r["error"], "registry rejects unknown tool")
        r = reg.execute(sb, config, "write_file", {"path": "../../escape.txt", "content": "x"})
        check(r["error"], "tool blocks path escape")
        r = reg.execute(sb, config, "run_command", {"command": "cat /home/user/secret.txt"})
        check(r["error"], "run_command blocks absolute path escape")
        r = reg.execute(sb, config, "run_command", {"command": "cat ../../etc/passwd"})
        check(r["error"], "run_command blocks .. path escape")
        r = reg.execute(sb, config, "run_command", {"command": "ls -la"})
        check(not r["error"], "run_command allows normal relative commands")
        reg.execute(sb, config, "write_file", {"path": "good.py", "content": "print(1)\n"})
        r = reg.execute(sb, config, "run_command", {"command": "python3 good.py"})
        check(not r["error"] and "1" in r["content"], "syntax check passes good python")
        reg.execute(sb, config, "write_file", {"path": "bad.py", "content": "if True print(1)\n"})
        r = reg.execute(sb, config, "run_command", {"command": "python3 bad.py"})
        check(r["error"] and "syntax check failed" in r["content"], "syntax check rejects bad python")

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

    # 7. skills: catalog + load_skill (model-chosen; no keyword matching, no hardcoded skill)
    from pathlib import Path

    lib = load_skill_library(Path(__file__).resolve().parent / "skills")
    check(len(lib.skills) >= 1, "skill library loads at least one skill")
    first = lib.names()[0]
    check(lib.get(first) is not None and bool(lib.get(first).content), "skill content retrievable by name")
    check(lib.get("no-such-skill") is None, "unknown skill name returns None")
    catalog = lib.to_catalog_section()
    check(first in catalog and catalog.startswith("Available skills"), "catalog lists skill names")

    disabled = Config(enable_skills=False)
    sys_off = derive_messages(EventLog(), disabled, "t")[0]["content"]
    check("Available skills (call load_skill" not in sys_off, "no catalog when skills disabled")
    check("load_skill" not in ToolRegistry(build_default_tools(disabled)).names(), "no load_skill tool when disabled")

    with tempfile.TemporaryDirectory() as stmp:
        sws = LocalWorkspace(stmp)
        reg = ToolRegistry(build_default_tools(config))
        r = reg.execute(sws, config, "load_skill", {"name": first})
        check(not r["error"] and bool(r.get("content")), "load_skill returns skill content")
        r = reg.execute(sws, config, "load_skill", {"name": "no-such-skill"})
        check(r["error"], "load_skill rejects unknown skill")
        r = reg.execute(sws, config, "load_skill", {"name": first, "file": "../escape.txt"})
        check(r["error"], "load_skill blocks path escape from skill dir")

    # 8. proxy: socks scheme must never crash the client (the user's environment bug)
    import os

    from agent.llm.proxy import get_proxy_for_url

    saved = {
        k: os.environ.get(k) for k in ("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY")
    }
    try:
        # environment with ALL_PROXY=socks:// must yield None (direct), not crash
        os.environ["ALL_PROXY"] = "socks://127.0.0.1:7890/"
        os.environ["all_proxy"] = "socks://127.0.0.1:7890/"
        os.environ.pop("https_proxy", None)
        os.environ.pop("HTTPS_PROXY", None)
        os.environ.pop("no_proxy", None)
        os.environ.pop("NO_PROXY", None)
        check(get_proxy_for_url("https://api.deepseek.com") is None, "socks all_proxy skipped (no crash)")

        # http proxy is passed through for httpx
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7890/"
        check(
            get_proxy_for_url("https://api.deepseek.com") == "http://127.0.0.1:7890/",
            "http https_proxy passed through",
        )

        # no_proxy match -> direct
        os.environ["NO_PROXY"] = "api.deepseek.com"
        check(get_proxy_for_url("https://api.deepseek.com") is None, "no_proxy bypasses proxy")
        os.environ.pop("NO_PROXY", None)
        check(
            get_proxy_for_url("https://api.deepseek.com") == "http://127.0.0.1:7890/",
            "proxy restored after no_proxy cleared",
        )
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # 9. permission: rules match the actual command, not the JSON envelope
    from agent.core.permission import PermissionEvaluator

    with tempfile.TemporaryDirectory() as wtmp:
        ws = LocalWorkspace(wtmp)
        pe = PermissionEvaluator()
        check(
            pe.evaluate("run_command", '{"command": "rm old.txt"}', ws) == "ask",
            "permission asks on rm",
        )
        check(
            pe.evaluate("run_command", '{"command": "rm -rf /tmp/x"}', ws) == "ask",
            "permission asks on rm -rf",
        )
        check(
            pe.evaluate("run_command", '{"command": "echo hi"}', ws) == "allow",
            "permission allows harmless command",
        )
        check(
            pe.evaluate("write_file", '{"path": "a.txt"}', ws) == "allow",
            "permission allows in-workspace write",
        )
        check(
            pe.evaluate("write_file", '{"path": "../x.txt"}', ws) == "ask",
            "permission asks on escaping write",
        )

    # 10. project file: .clc round-trip + protected visibility
    from agent.project import create_project, open_project

    with tempfile.TemporaryDirectory() as ptmp:
        proj = create_project(Path(ptmp) / "demo", "demo")
        proj.log.append(UserMessageEvent(content="hi"))
        proj.log.append(UserMessageEvent(content="there"))
        check(proj.path.exists(), "project .clc created")
        check(proj.workdir == Path(ptmp), "project workdir is parent dir")
        reloaded = open_project(proj.path)
        check(
            [e.content for e in reloaded.events()] == ["hi", "there"],
            "project round-trips events",
        )
        ws = LocalWorkspace(str(ptmp))
        ws.protect(proj.path)
        check(ws.is_protected(proj.path), "workspace protects .clc")
        reg = ToolRegistry(build_default_tools(config))
        r = reg.execute(ws, config, "read_file", {"path": proj.path.name})
        check(r["error"], "read_file refuses protected .clc")
        r = reg.execute(ws, config, "list_dir", {"path": "."})
        check(proj.path.name not in r["content"], "list_dir hides .clc")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
