"""Self-check: validates core logic without needing the LLM.

Run: uv run python -m tests.selfcheck
Covers: parsing, message derivation, workspace path safety, tool execution,
doom-loop detection, verification gate.
"""

from __future__ import annotations

import json
import sys
import tempfile

from agent.config import Config
from agent.core.context import derive_messages
from agent.core.lazy import LazyEventLog
from agent.core.parse import ParseError, parse_arguments
from agent.core.terminate import Terminator
from agent.events import (
    DURABLE_TYPES,
    AssistantMessageEvent,
    CompactionEvent,
    StepStartEvent,
    TextDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
    event_from_dict,
    event_to_json,
)
from agent.skills import load_skill_library
from agent.tools.registry import ToolRegistry, build_default_tools
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check


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
    log = LazyEventLog.in_memory()
    log.append(AssistantMessageEvent(content="", tool_calls=[{"id": "c1", "name": "read_file", "arguments": "{}"}]))
    log.append(ToolResultEvent(tool_call_id="c1", content="file content"))
    msgs = derive_messages(log, config, "test")
    check(msgs[0]["role"] == "system", "derive_messages prepends system")
    check(msgs[2]["role"] == "assistant" and msgs[2]["tool_calls"][0]["id"] == "c1", "assistant tool_calls preserved")
    check(msgs[3] == {"role": "tool", "tool_call_id": "c1", "content": "file content"}, "tool result paired")

    # 2b. dangling tool_calls are stripped, the user turn survives
    log = LazyEventLog.in_memory()
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

    # 2c. real text + dangling tool_calls: text kept, calls dropped
    log = LazyEventLog.in_memory()
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

    # 2d. reasoning-only assistant must not leak (API rejects it)
    log = LazyEventLog.in_memory()
    log.append(
        AssistantMessageEvent(
            content="",
            reasoning="thinking that never led anywhere",
            tool_calls=[{"id": "c1", "name": "read_file", "arguments": "{}"}],
        )
    )
    msgs = derive_messages(log, config, "test")
    check(
        not any(m["role"] == "assistant" for m in msgs),
        "reasoning-only dangling assistant dropped entirely",
    )
    valid_assistants = all(m["role"] != "assistant" or m.get("content") or "tool_calls" in m for m in msgs)
    check(valid_assistants, "every surviving assistant has content or tool_calls")

    # 2e. compaction: newest summary is the head; only events after it project
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content="old task"))
    log.append(AssistantMessageEvent(content="old turn done"))
    log.append(CompactionEvent(summary="old work summarized"))
    log.append(UserMessageEvent(content="recent task"))
    log.append(AssistantMessageEvent(content="recent answer"))
    msgs = derive_messages(log, config, "test")
    head = [m for m in msgs if m["role"] == "user" and "Previous conversation summary" in m.get("content", "")]
    check(len(head) == 1 and "old work summarized" in head[0]["content"], "compaction summary injected as head")
    check(msgs[-1] == {"role": "assistant", "content": "recent answer"}, "window kept after the compaction head")
    check(
        not any(m["role"] == "assistant" and m.get("content") == "old turn done" for m in msgs),
        "pre-window turns omitted by compaction",
    )

    # 2e2. window files are listed so the model re-reads them
    log2 = LazyEventLog.in_memory()
    log2.append(UserMessageEvent(content="task"))
    log2.append(AssistantMessageEvent(content="old work"))
    log2.append(CompactionEvent(summary="s"))
    log2.append(
        ToolCallEvent(
            name="write_file",
            arguments='{"path": "a.py", "content": "x"}',
            tool_call_id="c1",
        )
    )
    log2.append(
        ToolCallEvent(
            name="edit_file",
            arguments='{"path": "b.py", "old_string": "a", "new_string": "b"}',
            tool_call_id="c2",
        )
    )
    msgs2 = derive_messages(log2, config, "test")
    notes = [m for m in msgs2 if m["role"] == "user" and "Conversation compacted" in m.get("content", "")]
    check(
        len(notes) == 1 and "a.py" in notes[0]["content"] and "b.py" in notes[0]["content"],
        "compaction note lists the working files to re-read",
    )

    # 2h. reopened (durable-only) log derives the same context as the live one
    live = LazyEventLog.in_memory()
    live.append(UserMessageEvent(content="task"))
    live.append(TextDeltaEvent(content="x"))
    live.append(AssistantMessageEvent(content="work a"))
    live.append(CompactionEvent(summary="mid summary"))
    live.append(StepStartEvent())
    live.append(UserMessageEvent(content="recent"))
    live.append(AssistantMessageEvent(content="recent work"))
    durable = [e for e in live.events() if e.type in DURABLE_TYPES]
    msgs_live = derive_messages(live, config, "test")
    check(msgs_live[-1] == {"role": "assistant", "content": "recent work"},
          "window = the events after the newest summary line")
    check(
        not any(m["role"] == "assistant" and m.get("content") == "work a" for m in msgs_live),
        "pre-window work stays summarized away",
    )
    # persist the durable events and reopen — the same window derives the same context
    reopened = LazyEventLog.in_memory()
    for line in (event_to_json(e) for e in durable):
        reopened.append(event_from_dict(json.loads(line)))
    check(
        derive_messages(reopened, Config(), "test") == derive_messages(live, config, "test"),
        "reopen keeps the same window (index stable across persistence)",
    )

    # 2f. long log projects everything; the raw task copy is not sent twice
    big = LazyEventLog.in_memory()
    big.append(UserMessageEvent(content="original task"))
    for i in range(30):
        big.append(AssistantMessageEvent(content=f"turn {i}"))
    msgs = derive_messages(big, config, "test")
    assistants = [m for m in msgs if m["role"] == "assistant"]
    check(len(assistants) == 30, "no windowing: all turns projected")
    check(not any("omitted" in (m.get("content") or "") for m in msgs), "no omitted note without windowing")
    check(
        len([m for m in msgs if m["role"] == "user" and "Task: test" in m.get("content", "")]) == 1,
        "task injected exactly once (raw copy dropped)",
    )
    check(
        not any(m["role"] == "user" and m.get("content") == "original task" for m in msgs),
        "raw task copy excluded from projection",
    )

    # 2g. tool output is preserved verbatim (only compaction trims)
    cblog = LazyEventLog.in_memory()
    cblog.append(UserMessageEvent(content="t"))
    cblog.append(AssistantMessageEvent(content="a", tool_calls=[{"id": "c1", "name": "read_file", "arguments": "{}"}]))
    cblog.append(ToolResultEvent(tool_call_id="c1", content="x" * 40))
    cblog.append(ToolResultEvent(tool_call_id="c2", content="y" * 40))
    cmsgs = derive_messages(cblog, Config(), "test")
    tool_msgs = [m for m in cmsgs if m["role"] == "tool"]
    check([m["content"] for m in tool_msgs] == ["x" * 40, "y" * 40], "no incremental tool-output folding")

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
        reg.execute(sb, config, "write_file", {"path": "multi.txt", "content": "line1\nline2\nline3\nline4\nline5\n"})
        r = reg.execute(sb, config, "read_file", {"path": "multi.txt", "offset": 2, "limit": 2})
        check(
            r["content"].startswith("2: line2\n3: line3") and "use offset=4 to continue" in r["content"],
            "read_file line-range returns numbered slice with continue hint",
        )
        r = reg.execute(sb, config, "read_file", {"path": "multi.txt", "offset": 4, "limit": 2})
        check(r["content"] == "4: line4\n5: line5", "read_file range covering the tail has no footer")
        # truncation tells the model how to continue
        big_body = "".join(f"line {i}\n" for i in range(3000))
        reg.execute(sb, config, "write_file", {"path": "big.txt", "content": big_body})
        r = reg.execute(sb, config, "read_file", {"path": "big.txt", "max_chars": 2000})
        check(
            "[truncated" in r["content"] and "use offset=" in r["content"],
            "whole-file truncation hints the next offset",
        )
        # an explicit range that cannot fit the budget is an error, not a silent cut
        r = reg.execute(sb, config, "read_file", {"path": "big.txt", "offset": 1, "limit": 3000, "max_chars": 2000})
        check(r["error"] and "smaller limit" in r["content"], "oversized explicit range errors instead of truncating")
        r = reg.execute(sb, config, "read_file", {"path": "big.txt", "offset": 1, "limit": 100, "max_chars": 2000})
        check(not r["error"], "range within budget still succeeds")
        r = reg.execute(sb, config, "grep", {"pattern": "line[23]"})
        check("multi.txt:" in r["content"] and "2: line2" in r["content"], "grep tool finds hits with line numbers")
        r = reg.execute(sb, config, "grep", {"pattern": "no_such_token_zzz"})
        check("no matches" in r["content"], "grep tool reports no matches")
        r = reg.execute(sb, config, "grep", {"pattern": "(", "path": "."})
        check(r["error"], "grep tool rejects invalid regex")
        # edit_file: targeted replacement (one occurrence), diff, and error cases
        reg.execute(sb, config, "write_file", {"path": "edit.txt", "content": "alpha\nbeta\ngamma\n"})
        r = reg.execute(sb, config, "edit_file", {"path": "edit.txt", "old_string": "beta", "new_string": "BETA"})
        check(not r["error"] and "+1 -1" in r["content"], "edit_file replaces one occurrence with a diff")
        check((sb.root / "edit.txt").read_text() == "alpha\nBETA\ngamma\n", "edit_file applied the replacement")
        r = reg.execute(sb, config, "edit_file", {"path": "edit.txt", "old_string": "nope", "new_string": "x"})
        check(r["error"] and "not found" in r["content"], "edit_file reports a missing old_string")
        reg.execute(sb, config, "write_file", {"path": "dup.txt", "content": "x\ny\nx\n"})
        r = reg.execute(sb, config, "edit_file", {"path": "dup.txt", "old_string": "x", "new_string": "z"})
        check(r["error"] and "appears 2 times" in r["content"], "edit_file rejects an ambiguous old_string")
        r = reg.execute(sb, config, "edit_file", {"path": "missing.txt", "old_string": "a", "new_string": "b"})
        check(r["error"] and "use write_file" in r["content"], "edit_file points to write_file for new files")
        # undo stack: write/edit snapshot the previous content; restore pops it back
        r = reg.execute(sb, config, "edit_file", {"path": "edit.txt", "old_string": "BETA", "new_string": "corrupted"})
        check(not r["error"] and (sb.root / "edit.txt").read_text() == "alpha\ncorrupted\ngamma\n", "edit applied")
        check(sb.restore(sb.resolve("edit.txt")) == "alpha\nBETA\ngamma\n", "workspace.restore pops the snapshot")
        check((sb.root / "edit.txt").read_text() == "alpha\nBETA\ngamma\n", "restore wrote the previous content back")
        check(sb.restore(sb.resolve("edit.txt")) == "alpha\nbeta\ngamma\n", "second restore pops the next snapshot")
        check(sb.restore(sb.resolve("edit.txt")) is None, "restore with no snapshot returns None")
        # read_file on a directory lists its entries
        r = reg.execute(sb, config, "read_file", {"path": "."})
        check("edit.txt" in r["content"] and not r["error"], "read_file on a directory lists entries")
        r = reg.execute(sb, config, "read_file", {"path": ".", "offset": 1, "limit": 5})
        check(r["error"] and "directory" in r["content"], "directory read with a range errors")
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

    # 7. skills: catalog + load_skill
    from pathlib import Path

    lib = load_skill_library(Path(__file__).resolve().parents[1] / "agent" / "skills")
    check(len(lib.skills) >= 1, "skill library loads at least one skill")
    first = lib.names()[0]
    check(lib.get(first) is not None and bool(lib.get(first).content), "skill content retrievable by name")
    check(lib.get("no-such-skill") is None, "unknown skill name returns None")
    catalog = lib.to_catalog_section()
    check(first in catalog and catalog.startswith("Available skills"), "catalog lists skill names")

    disabled = Config(enable_skills=False)
    sys_off = derive_messages(LazyEventLog.in_memory(), disabled, "t")[0]["content"]
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

    # 8. proxy: socks scheme must never crash the client
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
        # write_file rules match the PATH, not the content ("~" in a report must not ask)
        check(
            pe.evaluate("write_file", '{"content": "16:07 UTC ~ 16:09 UTC", "path": "report.md"}', ws) == "allow",
            "write_file content with ~ does not prompt (path-only matching)",
        )
        check(
            pe.evaluate("write_file", '{"content": "x", "path": "~/x"}', ws) == "ask",
            "write_file path with ~ still asks",
        )

        # absolute paths INSIDE the workspace are not escapes; must not prompt
        sub = Path(wtmp) / "sub"
        sub.mkdir()
        check(
            pe.evaluate("write_file", f'{{"path": "{sub}/new.py"}}', ws) == "allow",
            "write_file on an absolute path inside the workspace does not prompt",
        )
        check(
            pe.evaluate("run_command", f'{{"command": "cat {sub}/a.txt"}}', ws) == "allow",
            "run_command on an inside absolute path does not prompt",
        )
        check(
            pe.evaluate("run_command", f'{{"command": "cd {wtmp} && ls"}}', ws) == "allow",
            "run_command with the workdir as cwd does not prompt",
        )
        check(
            bool(pe.escaped_paths("run_command", '{"command": "cat /etc/passwd"}', ws)),
            "external absolute path still surfaces an escape",
        )
        check(
            pe.evaluate("write_file", '{"path": "/etc/x"}', ws) == "ask",
            "write_file on an absolute path outside still asks",
        )

        # 9b. gate: an ask blocks until resolved; resolve(False) denies
        import threading as _threading

        from agent.core.permission import PermissionGate, PermissionRequired

        gate = PermissionGate(evaluator=pe)
        outcome: dict = {}

        def _require() -> None:
            try:
                gate.require("run_command", '{"command": "rm -rf /tmp/x"}', ws)
                outcome["raised"] = None
            except PermissionRequired as e:
                outcome["raised"] = e.reason

        t = _threading.Thread(target=_require, daemon=True)
        t.start()
        import time as _time

        _time.sleep(0.2)
        check(len(gate.pending_ids()) == 1, "ask stays pending while waiting for the user")
        check(gate.resolve("perm-1", False), "pending ask resolved by the UI")
        t.join(timeout=2)
        check(outcome.get("raised") == "denied by user", "denied ask unblocks the agent with 'denied by user'")

        # 9c. no UI attached (on_ask returns False): the gate denies instead of hanging
        gate2 = PermissionGate(evaluator=pe, on_ask=lambda *a: False)
        try:
            gate2.require("run_command", '{"command": "rm -rf /tmp/x"}', ws)
            check(False, "no-UI ask is denied, not executed")
        except PermissionRequired as e:
            check(
                "no user interface" in e.reason,
                f"no-UI ask denies with a clear reason ({e.reason!r})",
            )
        check(len(gate2.pending_ids()) == 0, "no-UI ask leaves no pending entry")

        # 9d. sandbox escapes: real resolution flags external paths for an ask
        check(
            pe.escaped_paths("read_file", '{"path": "/etc/passwd"}', ws) == frozenset({Path("/etc/passwd").resolve()}),
            "escaped_paths flags an external read",
        )
        check(
            pe.escaped_paths("run_command", '{"command": "cat /etc/passwd"}', ws)
            == frozenset({Path("/etc/passwd").resolve()}),
            "escaped_paths flags external tokens in run_command",
        )
        check(pe.escaped_paths("read_file", '{"path": "a.txt"}', ws) == frozenset(), "in-sandbox path has no escapes")
        # scratch exemption: the workspace must not itself be inside /tmp
        with tempfile.TemporaryDirectory(dir=Path.home()) as home_tmp:
            home_ws = LocalWorkspace(home_tmp)
            check(
                pe.escaped_paths(
                    "run_command",
                    '{"command": "uv run python -m x >/tmp/out.log 2>&1 && tail -25 /tmp/out.log"}',
                    home_ws,
                )
                == frozenset(),
                "scratch redirect targets (/tmp, /dev/null) are not escapes",
            )
            check(
                pe.escaped_paths("run_command", '{"command": "echo hi > /tmp/../etc/hack"}', home_ws)
                == frozenset({Path("/etc/hack")}),
                "a '..' that walks out of a scratch dir is still an escape",
            )
        check(
            pe.escaped_paths("write_file", '{"content": "/etc/passwd ~ ../x", "path": "a.txt"}', ws) == frozenset(),
            "content is not scanned for escapes",
        )
        ext = ws.root.parent / "approved.txt"
        check(
            pe.escaped_paths("write_file", f'{{"path": "{ext}"}}', ws) == frozenset({ext}),
            "escaped_paths flags an external write target",
        )

        # 9e. a user-approved escape is resolvable during the call, then cleared
        ws3 = LocalWorkspace(wtmp)
        approving = PermissionGate(evaluator=pe, on_ask=lambda *a: True)
        got: dict = {}

        def _require_escape() -> None:
            try:
                approving.require("write_file", f'{{"path": "{ext}"}}', ws3)
                got["ok"] = True
            except PermissionRequired as e:
                got["err"] = e.reason

        t2 = _threading.Thread(target=_require_escape, daemon=True)
        t2.start()
        _time.sleep(0.15)
        for rid in approving.pending_ids():
            approving.resolve(rid, True)
        t2.join(timeout=2)
        check(got.get("ok"), "escape ask approved by the user")
        check(ws3.resolve(str(ext)) == ext, "approved escape resolvable during the call")
        ws3.clear_allowed()
        try:
            ws3.resolve(str(ext))
            check(False, "cleared escape is refused again")
        except ValueError:
            check(True, "cleared escape is refused again")

        # 9f. auto-allow fails closed on escapes; rule asks stay auto-allowed
        unattended = PermissionGate(evaluator=pe, auto_allow=True)
        try:
            unattended.require("read_file", '{"path": "/etc/passwd"}', ws)
            check(False, "auto-allow refuses a sandbox escape")
        except PermissionRequired as e:
            check("user approval" in e.reason, f"auto-allow fails closed on escapes ({e.reason!r})")
        try:
            unattended.require("run_command", '{"command": "rm old.txt"}', ws)
            check(True, "auto-allow still permits non-escape rule asks")
        except PermissionRequired:
            check(False, "auto-allow still permits non-escape rule asks")

    # 10. project file: .clc round-trip + protected visibility
    from agent.project import create_project, open_project_lazy

    with tempfile.TemporaryDirectory() as ptmp:
        proj = create_project(Path(ptmp) / "demo", "demo")
        check(isinstance(proj.log, LazyEventLog), "create_project opens the lazy log (one code path)")
        proj.log.append(UserMessageEvent(content="hi"))
        proj.log.append(UserMessageEvent(content="there"))
        check(proj.path.exists(), "project .clc created")
        check(proj.workdir == Path(ptmp), "project workdir is parent dir")
        reloaded = open_project_lazy(proj.path)
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
        r = reg.execute(ws, config, "read_file", {"path": "."})
        check(proj.path.name not in r["content"], "read_file on a directory hides .clc")

    # 10b. project memory: memories persist to the .clc and survive reopen
    with tempfile.TemporaryDirectory() as ptmp:
        proj = create_project(Path(ptmp) / "mem", "mem")
        check(proj.memories is not None, "create_project attaches a MemoryStore")
        proj.memories.save("user prefers dark theme", "the user likes dark mode")
        proj.memories.save("stack is flask", "the backend uses Flask + SQLite")
        raw = proj.path.read_text(encoding="utf-8")
        check("[memories]" in raw, "memories section written to the .clc")
        check("dark theme" in raw and "flask" in raw, "memory lines persisted as JSONL")

        reloaded = open_project_lazy(proj.path)
        check(
            reloaded.memories.get("stack is flask") is not None,
            "memories loaded back on reopen",
        )
        check(len(reloaded.memories.search("flask")) == 1, "memory search matches content")

        # memory tools (registered when a MemoryStore is provided)
        ws = LocalWorkspace(str(ptmp))
        mreg = ToolRegistry(build_default_tools(config, memories=reloaded.memories))
        r = mreg.execute(ws, config, "load_memory", {"name": "stack is flask"})
        check(not r["error"] and "Flask" in r["content"], "load_memory returns content")
        r = mreg.execute(ws, config, "search_memory", {"query": "theme"})
        check(not r["error"] and "dark theme" in r["content"], "search_memory finds by title")
        r = mreg.execute(ws, config, "save_memory", {"title": "new fact", "content": "keep it"})
        check(not r["error"], "save_memory tool works")
        check(reloaded.memories.get("new fact") is not None, "save_memory updated the store")
        # without a store there are no memory tools
        check(
            "save_memory" not in ToolRegistry(build_default_tools(config)).names(),
            "no memory tools without a MemoryStore",
        )

    # 10c. fixed-width header memory index (in-place update, offsets stable)
    from agent.events import _line_bytes
    from agent.memory import _MEMORY_INDEX_PREFIX, parse_index_line

    with tempfile.TemporaryDirectory() as ptmp:
        proj = create_project(Path(ptmp) / "ring", "ring")
        for i in range(12):
            proj.memories.save(f"fact {i}", f"content {i}")
        idx = [line for line in proj.path.read_text(encoding="utf-8").split("\n")
               if line.startswith(_MEMORY_INDEX_PREFIX)][0]
        check(len(idx.encode()) == 189, "index line fixed width 189 bytes")
        parsed = parse_index_line(idx)
        check(parsed is not None and parsed[0] == 10 and parsed[1] == 2, "ring full: count=10 head=2 after 12 saves")
        reopened = open_project_lazy(proj.path)
        items = reopened.memories.items()
        check(
            len(items) == 10 and "fact 0" not in items and "fact 11" in items,
            "FIFO: oldest evicted, newest kept on reopen",
        )
        off_before = reopened.memories._index_offset
        reopened.memories.save("fact 12", "c12")
        reopened.memories.save("fact 13", "c13")
        reopened2 = open_project_lazy(proj.path)
        items2 = reopened2.memories.items()
        check(
            len(items2) == 10 and "fact 3" not in items2 and "fact 13" in items2,
            "saves after reopen keep the FIFO ring",
        )
        check(reopened2.memories._index_offset == off_before, "index line never moves (absolute offset stable)")

        # legacy file without an index: open never migrates, file untouched
        legacy = Path(ptmp) / "legacy.clc"
        evs = [UserMessageEvent(content="task")]
        for i in range(1, 60):
            evs.append(AssistantMessageEvent(content=f"w{i}") if i % 2 else UserMessageEvent(content=f"a{i}"))
        evs.append(CompactionEvent(summary="sum"))
        for i in range(61, 70):
            evs.append(AssistantMessageEvent(content=f"r{i}"))
        legacy.write_text(
            "\n".join(
                ["# clutch project v1", "name: legacy", "model: fake-model", "---"]
                + [event_to_json(e) for e in evs]
                + ["[memories]", '{"title": "m1", "content": "one", "updated": 0}']
                + [event_to_json(AssistantMessageEvent(content=f"after{i}")) for i in range(70, 75)]
            )
            + "\n",
            encoding="utf-8",
        )
        legacy_before = legacy.read_bytes()
        mig = open_project_lazy(legacy)
        check(mig.memories.get("m1") is not None, "legacy file memories load via section scan")
        check(legacy.read_bytes() == legacy_before, "writable open never rewrites a legacy file")
        # legacy file: open derives the compaction boundary from the newest line
        check(mig.log.cpr_start() > 0, "legacy file with a compaction derives its window boundary")
        check(
            all(e.type != "user_message" or i == 0 for i, e in enumerate(mig.events())),
            "legacy window materializes only from the last compaction onward",
        )
        mig.memories.save("m2", "two")
        check(open_project_lazy(legacy).memories.get("m2") is not None, "post-open save persists (scan fallback)")

        # corrupt index: fall back to the section scan, file untouched
        corrupt = Path(ptmp) / "corrupt.clc"
        cproj = create_project(corrupt, "c")
        cproj.memories.save("a", "A")
        cproj.memories.save("b", "B")
        corrupt.write_text(
            cproj.path.read_text(encoding="utf-8").replace(_MEMORY_INDEX_PREFIX, _MEMORY_INDEX_PREFIX + "ZZ", 1),
            encoding="utf-8",
        )
        corrupt_before = corrupt.read_bytes()
        creopened = open_project_lazy(corrupt)
        check(len(creopened.memories.items()) == 2, "corrupt index falls back to the section scan (no memory loss)")
        check(corrupt.read_bytes() == corrupt_before, "corrupt index not rewritten by the open")

        # read-only open of a legacy file: legacy scan loads, file untouched
        ro = Path(ptmp) / "ro.clc"
        ro.write_text(
            "# clutch project v1\nname: ro\nmodel: m\n---\n"
            + event_to_json(UserMessageEvent(content="task")) + "\n"
            + "[memories]\n" + '{"title": "ro1", "content": "readonly", "updated": 0}\n',
            encoding="utf-8",
        )
        before = ro.read_bytes()
        roproj = open_project_lazy(ro, read_only=True)
        check(roproj.memories.get("ro1") is not None, "read_only: legacy scan loads memories")
        check(ro.read_bytes() == before, "read_only: file untouched (no migration)")

    # 11. windowed .clc loading: only the model window materializes; older
    # history stays on disk and is paged via pure-disk read_page
    with tempfile.TemporaryDirectory() as ptmp:
        from agent.core.lazy import _make_reader, parse_durable
        from agent.events import _line_bytes
        from agent.project import open_project_lazy

        p = Path(ptmp) / "big.clc"
        events = [UserMessageEvent(content="task")]
        for i in range(1, 100):
            events.append(
                AssistantMessageEvent(content=f"old work {i}")
                if i % 2 == 0
                else UserMessageEvent(content=f"old ask {i}")
            )
        comp_off = sum(_line_bytes(ev) for ev in events[:90])
        lines = [
            "# clutch project v1", "name: lazy", "model: fake-model",
            f"cpr_start={comp_off:010d}", "---",
        ]
        for ev in events:
            lines.append(event_to_json(ev))
        lines.append(event_to_json(CompactionEvent(summary="old work summarized")))
        for i in range(101, 121):
            lines.append(event_to_json(AssistantMessageEvent(content=f"recent {i}")))
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")

        proj = open_project_lazy(p, workspace=None)
        log = proj.log
        check(isinstance(log, LazyEventLog), "compaction file opens lazily")
        offs = [off for off, _ in log.items()]
        check(all(o >= comp_off for o in offs),
              "lazy open materializes only the model window (the task is not resident)")
        check(log.cpr_start() == comp_off, "cpr_start read from the header line")
        check(log.window_bytes() == (log._file_bytes - log._base) - comp_off,
              "window_bytes = the file bytes past the cpr_start boundary")
        check(max(0, log.cpr_start()) == comp_off,
              "older counts the on-disk bytes before the window (cpr_start)")
        read, total = _make_reader(p, None)
        check(total == log._file_bytes, "reader sees the full file bytes")

        # paging: pure-disk read of pre-window history; derived context == a full load
        page = log.read_page(0, comp_off)
        check(len(page) == 90, "read_page pages the task + the on-disk middle on demand (90 events)")
        check(
            all(off >= comp_off for off, _ in log.items()),
            "read_page left the resident log untouched (history stays on disk)",
        )
        full = LazyEventLog.in_memory()
        for ev in parse_durable(p.read_text(encoding="utf-8")):
            full.append(ev)
        check(
            derive_messages(log, config, "task") == derive_messages(full, config, "task"),
            "lazy derive == full derive (middle paged separately)",
        )
        check(
            not any(
                m["role"] == "assistant" and m.get("content") == "old work 42"
                for m in derive_messages(log, config, "task")
            ),
            "middle stays summarized away (the window excludes it)",
        )

        # no cpr_start line: full window; open never migrates it
        legacy = Path(ptmp) / "legacy.clc"
        legacy.write_text(
            "\n".join(
                ["# clutch project v1", "name: old", "model: fake-model", "---"]
                + [event_to_json(ev) for ev in events]
                + [event_to_json(CompactionEvent(summary="old work summarized"))]
                + [event_to_json(AssistantMessageEvent(content=f"recent {i}")) for i in range(101, 121)]
            )
            + "\n",
            encoding="utf-8",
        )
        legacy_before = legacy.read_bytes()
        up = open_project_lazy(legacy, workspace=None)
        check(isinstance(up.log, LazyEventLog) and up.log.cpr_start() > 0,
              "legacy .clc derives its window boundary from the newest compaction")
        check(len(up.log.items()) == 1 + 20,
              "legacy window materializes only the compaction + the recent tail")
        check(
            derive_messages(up.log, config, "task") == derive_messages(full, config, "task"),
            "legacy derive == full derive",
        )
        check(
            legacy.read_bytes() == legacy_before,
            "open never rewrites a legacy file (no cpr_start inserted)",
        )

    # 12. lazy open handles a [memories] section (parse_durable skips memory lines)
    with tempfile.TemporaryDirectory() as ptmp:
        from agent.project import open_project_lazy

        p = Path(ptmp) / "mem.clc"
        lines = [
            "# clutch project v1", "name: mem", "model: fake-model", "---",
            event_to_json(UserMessageEvent(content="task")),
        ]
        for i in range(1, 40):
            lines.append(
                event_to_json(
                    AssistantMessageEvent(content=f"work {i}")
                    if i % 2 == 0
                    else UserMessageEvent(content=f"ask {i}")
                )
            )
        lines.append(event_to_json(CompactionEvent(summary="mid summarized")))
        for i in range(40, 50):
            lines.append(event_to_json(AssistantMessageEvent(content=f"recent {i}")))
        lines.append("[memories]")
        lines.append('{"title": "a durable fact", "content": "the detail", "updated": 0}')
        lines.append(event_to_json(AssistantMessageEvent(content="after memory")))
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")

        proj = open_project_lazy(p, workspace=None)
        check(
            proj.memories is not None and len(proj.memories.items()) == 1,
            "lazy open preserves the memory instead of crashing",
        )
        check(
            proj.memories.get("a durable fact") is not None
            and proj.memories.get("a durable fact").content == "the detail",
            "memory content survives lazy open",
        )
        check(
            any(
                m["role"] == "assistant" and m.get("content") == "after memory"
                for m in derive_messages(proj.log, config, "task")
            ),
            "events after the memory section still load",
        )

    # 13. LLM endpoint configurability: one flat settings surface + legacy migration
    from agent.config import flatten_settings
    from agent.llm import create_llm_client

    flat = {"base_url": "https://x.example/v1", "model": "m1", "api_key": "k1", "reasoning_effort": "low"}
    check(flatten_settings(dict(flat)) == flat, "flat settings read through verbatim")
    check(
        flatten_settings(
            {
                "profiles": {"a": {"base_url": "u1"}, "zhipu-53": {"base_url": "u2", "model": "m2", "api_key": "k2"}},
                "active": "zhipu-53",
            }
        )
        == {"base_url": "u2", "model": "m2", "api_key": "k2"},
        "legacy profile map migrates to the active profile",
    )
    check(flatten_settings({}) == {}, "empty settings flatten to empty")

    client = create_llm_client(
        api_key="sk-test",
        base_url="https://open.bigmodel.cn/api/coding/paas/v4",
        model="glm-5.3",
    )
    check(client.model == "glm-5.3" and client.api_key == "sk-test", "factory builds a client from url+key+model")
    try:
        create_llm_client(api_key="", base_url="u", model="m")
        check(False, "factory rejects missing api_key")
    except RuntimeError:
        check(True, "factory rejects missing api_key")

    old_env = {
        k: os.environ.get(k) for k in ("CLUTCH_MODEL", "CLUTCH_BASE_URL", "CLUTCH_API_KEY")
    }
    try:
        os.environ["CLUTCH_MODEL"] = "glm-5.3"
        os.environ["CLUTCH_BASE_URL"] = "https://open.bigmodel.cn/api/coding/paas/v4"
        os.environ["CLUTCH_API_KEY"] = "sk-env"
        ecfg = Config()
        check(ecfg.model == "glm-5.3" and ecfg.base_url == "https://open.bigmodel.cn/api/coding/paas/v4",
              "Config reads CLUTCH_MODEL/CLUTCH_BASE_URL")
        check(ecfg.api_key == "sk-env", "Config reads CLUTCH_API_KEY")
    finally:
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # 13b. provider error strings are tidied to the provider's own message
    from agent.llm.client import _clean_provider_message

    m = _clean_provider_message(
        "Error code: 429 - {'error': {'code': '1113', 'message': '余额不足或无可用资源包,请充值。'}}", 429
    )
    check(
        m == "余额不足或无可用资源包,请充值。 (code 1113, HTTP 429)",
        f"error envelope tidied to the provider message ({m!r})",
    )
    m = _clean_provider_message(
        "Error code: 402 - {'error': {'message': 'Insufficient Balance', 'type': 'unknown_error', "
        "'param': None, 'code': 'invalid_request_error'}}",
        402,
    )
    check(m == "Insufficient Balance (code invalid_request_error, HTTP 402)", f"402 error tidied ({m!r})")
    check(
        _clean_provider_message("Connection error: connection reset by peer", None)
        == "Connection error: connection reset by peer",
        "non-dict error text passes through verbatim",
    )

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
