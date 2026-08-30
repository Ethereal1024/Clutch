"""Self-check: validates core logic without needing the LLM.

Run: uv run python -m agent.selfcheck
Covers: parsing, message derivation, workspace path safety, tool execution,
doom-loop detection, verification gate.
"""

from __future__ import annotations

import contextlib
import json
import sys
import tempfile

from .config import Config
from .core.compaction import Compactor
from .core.context import derive_messages
from .core.parse import ParseError, parse_arguments
from .core.terminate import Terminator
from .events import (
    DURABLE_TYPES,
    AssistantMessageEvent,
    CompactionEvent,
    EventLog,
    StepStartEvent,
    TextDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
    event_from_dict,
    event_to_json,
)
from .skills import load_skill_library
from .testsupport import check
from .tools.registry import ToolRegistry, build_default_tools
from .tools.workspace import LocalWorkspace


@contextlib.contextmanager
def _lazy_forced():
    """Force the lazy open path in tests: the synthetic .clc is far below the
    real byte threshold."""
    from .core import lazy as lazy_mod

    old = lazy_mod._LAZY_MIN_BYTES
    lazy_mod._LAZY_MIN_BYTES = 64
    try:
        yield
    finally:
        lazy_mod._LAZY_MIN_BYTES = old


def _event_region_base(path: Path) -> int:
    """Absolute byte offset of the first durable line (the raw task)."""
    from .core.lazy import _make_reader

    read, total = _make_reader(path, None)
    head = read(0, min(total, 1 << 16))
    from .project import _event_region_start

    base = _event_region_start(head)
    return base or 0


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

    # 2d. dangling block with empty content + only reasoning must NOT leak a
    # reasoning-only assistant (API rejects: "content or tool_calls must be set")
    log = EventLog()
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

    # 2e. compaction: the newest CompactionEvent's summary becomes the head; only
    # the recent tail (from tail_start) is projected, old turns are omitted
    log = EventLog()
    log.append(UserMessageEvent(content="old task"))
    log.append(AssistantMessageEvent(content="old turn done"))
    tail_start = log._running  # byte offset of the next durable line (the recent tail's start)
    log.append(UserMessageEvent(content="recent task"))
    log.append(AssistantMessageEvent(content="recent answer"))
    log.append(CompactionEvent(summary="old work summarized", tail_start=tail_start))
    msgs = derive_messages(log, config, "test")
    head = [m for m in msgs if m["role"] == "user" and "Previous conversation summary" in m.get("content", "")]
    check(len(head) == 1 and "old work summarized" in head[0]["content"], "compaction summary injected as head")
    check(msgs[-1] == {"role": "assistant", "content": "recent answer"}, "tail kept after the compaction head")
    check(
        not any(m["role"] == "assistant" and m.get("content") == "old turn done" for m in msgs),
        "pre-tail turns omitted by compaction",
    )

    # 2e2. after compaction, the files the model was working on are listed so it
    # re-reads them instead of writing their content from the summary's memory
    log2 = EventLog()
    log2.append(UserMessageEvent(content="task"))
    log2.append(AssistantMessageEvent(content="old work"))
    log2.append(ToolCallEvent(name="read_file", arguments='{"path": "a.py"}', tool_call_id="c0"))
    tail_start2 = len(log2.events())
    log2.append(ToolCallEvent(name="write_file", arguments='{"path": "a.py", "content": "x"}', tool_call_id="c1"))
    log2.append(
        ToolCallEvent(
            name="edit_file",
            arguments='{"path": "b.py", "old_string": "a", "new_string": "b"}',
            tool_call_id="c2",
        )
    )
    log2.append(CompactionEvent(summary="s", tail_start=tail_start2))
    msgs2 = derive_messages(log2, config, "test")
    notes = [m for m in msgs2 if m["role"] == "user" and "Conversation compacted" in m.get("content", "")]
    check(
        len(notes) == 1 and "a.py" in notes[0]["content"] and "b.py" in notes[0]["content"],
        "compaction note lists the working files to re-read",
    )

    # 2h. tail_start is a BYTE offset into the DURABLE sequence. Transient
    # streaming deltas live only in the in-memory log and are never persisted,
    # so they never occupy byte offsets — a reopened (durable-only) log resolves
    # the same boundary as the live one.
    # 2h1: transients interleaved in a live log must not shift the durable bytes
    live = EventLog()
    live.append(UserMessageEvent(content="task"))
    live.append(TextDeltaEvent(content="x"))
    live.append(AssistantMessageEvent(content="work a"))
    live.append(StepStartEvent())
    live.append(UserMessageEvent(content="recent"))
    live.append(AssistantMessageEvent(content="recent work"))
    tail = Compactor(Config(compaction_tail_tokens=1), live, None).tail_start_index(live.events())
    durable = [e for e in live.events() if e.type in DURABLE_TYPES]
    check(tail == live._offsets[-1],
          "tail_start is the last durable event's byte offset (transients never shift it)")
    check(
        durable[-1].type == "assistant_message" and durable[-1].content == "recent work",
        "durable tail starts at the preserved recent turn",
    )
    # 2h2: persist the durable events and reopen — the same byte tail still works
    reopened = EventLog()
    for line in (event_to_json(e) for e in durable):
        reopened.append(event_from_dict(json.loads(line)))
    reopened.append(CompactionEvent(summary="s", tail_start=tail))
    rmsgs = derive_messages(reopened, Config(), "t")
    check(
        any(m["role"] == "assistant" and m.get("content") == "recent work" for m in rmsgs),
        "reopen keeps the recent tail (index stable across persistence)",
    )
    # 2h3: a stale out-of-range tail_start (older .clc) is clamped to the
    # compaction's own durable position so post-compaction history is NOT lost
    stale = EventLog()
    stale.append(UserMessageEvent(content="task"))
    stale.append(AssistantMessageEvent(content="old summarized work"))
    stale.append(CompactionEvent(summary="old work", tail_start=999))
    stale.append(UserMessageEvent(content="recent turn"))
    stale.append(AssistantMessageEvent(content="recent answer"))
    smsgs = derive_messages(stale, Config(), "t")
    check(
        any(m["role"] == "assistant" and m.get("content") == "recent answer" for m in smsgs),
        "stale out-of-range tail_start clamped; recent history preserved",
    )
    check(
        not any(m["role"] == "assistant" and m.get("content") == "old summarized work" for m in smsgs),
        "pre-compaction work stays summarized away",
    )

    # 2f. no turn-count windowing: a long log projects EVERYTHING (compaction is the
    # only turn-level budget guard), and the raw task copy (index 0) is not sent
    # twice — task.md re-injects it once
    big = EventLog()
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

    # 2g. no incremental tool-output folding: everything is preserved verbatim in the
    # derived context (reads accumulate until compaction; only compaction trims)
    cblog = EventLog()
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
        # whole-file truncation tells the model how to continue, so it pages
        # forward instead of re-reading the same head
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
        # read_file on a directory lists its entries (the old list_dir tool)
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
        # write_file rules must match the PATH, not the content: a report whose text
        # contains "~" (e.g. "16:07 UTC ~ 16:09 UTC") must not trigger an ask — that
        # was teaching the model a fake "large-file limit" via permission timeouts
        check(
            pe.evaluate("write_file", '{"content": "16:07 UTC ~ 16:09 UTC", "path": "report.md"}', ws) == "allow",
            "write_file content with ~ does not prompt (path-only matching)",
        )
        check(
            pe.evaluate("write_file", '{"content": "x", "path": "~/x"}', ws) == "ask",
            "write_file path with ~ still asks",
        )

        # 9b. gate: an ask blocks until resolved (no timeout — the model must never
        # see "permission request timed out"); resolve(False) unblocks as a deny
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

        # 9d. sandbox escapes: real resolution (not regex) flags external paths for
        # an ask; the approval is granted for that one path until cleared
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

        # 9f. auto-allow (eval harness / unattended) fails CLOSED on escapes — no
        # user is attached to approve, so the sandbox stays intact; rule asks are
        # still auto-allowed as before
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
        r = reg.execute(ws, config, "read_file", {"path": "."})
        check(proj.path.name not in r["content"], "read_file on a directory hides .clc")

    # 10b. project memory: saved memories persist to the [memories] section of the
    # .clc and survive a reopen; the memory tools read/write them.
    with tempfile.TemporaryDirectory() as ptmp:
        proj = create_project(Path(ptmp) / "mem", "mem")
        check(proj.memories is not None, "create_project attaches a MemoryStore")
        proj.memories.save("user prefers dark theme", "the user likes dark mode")
        proj.memories.save("stack is flask", "the backend uses Flask + SQLite")
        raw = proj.path.read_text(encoding="utf-8")
        check("[memories]" in raw, "memories section written to the .clc")
        check("dark theme" in raw and "flask" in raw, "memory lines persisted as JSONL")

        reloaded = open_project(proj.path)
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

    # 11. lazy .clc loading: a compaction file opens with only the raw task +
    # the preserved tail materialized; earlier records stay on disk (older_bytes)
    # and are paged on demand; a stale stored tail_start clamps to the last
    # compaction's offset and derives the same context as a full load.
    with tempfile.TemporaryDirectory() as ptmp, _lazy_forced():
        from .core import lazy as lazy_mod
        from .core.lazy import LazyEventLog, _make_reader, _tail_scan, parse_durable
        from .events import _line_bytes
        from .project import _event_region_start, open_project_lazy

        p = Path(ptmp) / "big.clc"
        events = [UserMessageEvent(content="task")]
        for i in range(1, 100):
            events.append(
                AssistantMessageEvent(content=f"old work {i}")
                if i % 2 == 0
                else UserMessageEvent(content=f"old ask {i}")
            )
        tail_start = sum(_line_bytes(ev) for ev in events[:90])
        lines = ["# clutch project v1", "name: lazy", "model: fake-model", "---"]
        for ev in events:
            lines.append(event_to_json(ev))
        lines.append(event_to_json(CompactionEvent(summary="old work summarized", tail_start=tail_start)))
        for i in range(101, 121):
            lines.append(event_to_json(AssistantMessageEvent(content=f"recent {i}")))
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")

        proj = open_project_lazy(p, workspace=None)
        log = proj.log
        check(isinstance(log, LazyEventLog), "compaction file opens lazily")
        offs = [off for off, _ in log.items()]
        check(offs[0] == 0 and all(o >= tail_start for o in offs[1:]),
              "lazy open materializes only the task + the preserved tail (byte offsets)")
        check(log.older_bytes() == tail_start - log._task_end,
              "older_bytes counts the on-disk middle bytes")
        read, total = _make_reader(p, None)
        comp, _mem = _tail_scan(read, total)
        check(comp is not None and comp[1].tail_start == tail_start,
              "stored tail_start read from the last compaction line")

        # paging: materialize the middle on demand, then derive == full load
        page = log.materialize_range(log.task_end, tail_start)
        check(len(page) == 89, "materialize_range pages the middle on demand")
        full = EventLog()
        for ev in parse_durable(p.read_text(encoding="utf-8")):
            full.append(ev)
        check(
            derive_messages(log, config, "task") == derive_messages(full, config, "task"),
            "lazy derive == full derive (paged middle)",
        )
        check(
            not any(m["role"] == "assistant" and m.get("content") == "old work 42" for m in derive_messages(log, config, "task")),
            "middle stays summarized away after paging",
        )

        # stale tail_start from an old .clc clamps to the compaction offset
        stale = p.read_text(encoding="utf-8").replace('"tail_start": %d' % tail_start, '"tail_start": 999999')
        p.write_text(stale, encoding="utf-8")
        proj2 = open_project_lazy(p, workspace=None)
        check(isinstance(proj2.log, LazyEventLog), "stale tail_start still opens lazily")
        check(proj2.log._tail_start == comp[0] - _event_region_base(p),
              "stale tail_start clamped to the compaction offset")
        stale_full = EventLog()
        for ev in parse_durable(p.read_text(encoding="utf-8")):
            stale_full.append(ev)
        check(
            derive_messages(proj2.log, config, "task") == derive_messages(stale_full, config, "task"),
            "stale-clamped lazy log derives the same context as the full log",
        )
        check(
            any("old work summarized" in m.get("content", "") for m in derive_messages(proj2.log, config, "task")),
            "compaction summary head survives the stale clamp",
        )

    # 12. lazy open handles a [memories] section: the index records the marker and
    # parse_durable skips the memory lines (valid JSON with no `type`), so opening
    # a .clc that has memories (even with events after them) neither crashes nor
    # silently drops them.
    with tempfile.TemporaryDirectory() as ptmp, _lazy_forced():
        from .project import open_project_lazy

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
        lines.append(event_to_json(CompactionEvent(summary="mid summarized", tail_start=20)))
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
            any(m["role"] == "assistant" and m.get("content") == "after memory" for m in derive_messages(proj.log, config, "task")),
            "events after the memory section still load",
        )

    # 13. LLM endpoint configurability: provider presets, env defaults,
    # resolution precedence and the client factory must not be hard-locked to
    # DeepSeek (the bug this section guards: URL locked to api.deepseek.com).
    from agent.config import PROVIDER_PRESETS, provider_preset, resolve_llm_endpoint
    from agent.llm import create_llm_client
    from agent.llm.factory import OPENAI_COMPATIBLE_PROVIDERS

    check(provider_preset("zhipu") == ("https://open.bigmodel.cn/api/paas/v4", "glm-4-flash"), "zhipu preset (base_url, model)")
    check("deepseek" in PROVIDER_PRESETS and "openai" in PROVIDER_PRESETS, "deepseek/openai presets present")
    check(provider_preset("bogus") == ("", ""), "unknown provider preset is empty")
    check({"deepseek", "zhipu", "openai", "moonshot", "ollama", "custom"} <= OPENAI_COMPATIBLE_PROVIDERS, "all presets are OpenAI-compatible")

    saved_zhipu = {"provider": "zhipu"}
    prov, url, model = resolve_llm_endpoint(cli={}, env={}, saved=saved_zhipu, defaults=Config())
    check(prov == "zhipu" and url == "https://open.bigmodel.cn/api/paas/v4" and model == "glm-4-flash", "saved provider moves the whole endpoint")
    prov, url, model = resolve_llm_endpoint(
        cli={"provider": "zhipu", "base_url": "https://my-gateway.example/v1", "model": "glm-4-air"},
        env={},
        saved={},
        defaults=Config(),
    )
    check(
        prov == "zhipu" and url == "https://my-gateway.example/v1" and model == "glm-4-air",
        "explicit CLI base_url/model override the preset",
    )
    prov, url, model = resolve_llm_endpoint(
        cli={},
        env={"CLUTCH_PROVIDER": "zhipu", "CLUTCH_BASE_URL": "", "CLUTCH_MODEL": ""},
        saved={"provider": "openai"},
        defaults=Config(),
    )
    check(
        prov == "zhipu" and url == "https://open.bigmodel.cn/api/paas/v4",
        "env provider beats saved settings; preset fills the URL",
    )
    try:
        resolve_llm_endpoint(cli={"provider": "bogus"}, env={}, saved={}, defaults=Config())
        check(False, "unknown provider rejected by resolver")
    except ValueError:
        check(True, "unknown provider rejected by resolver")

    old_env = {
        k: os.environ.get(k) for k in ("CLUTCH_PROVIDER", "CLUTCH_MODEL", "CLUTCH_BASE_URL", "CLUTCH_API_KEY")
    }
    try:
        os.environ["CLUTCH_PROVIDER"] = "zhipu"
        os.environ["CLUTCH_MODEL"] = "glm-4-flash"
        os.environ["CLUTCH_BASE_URL"] = "https://open.bigmodel.cn/api/paas/v4"
        os.environ["CLUTCH_API_KEY"] = "sk-env"
        ecfg = Config()
        check(ecfg.provider == "zhipu" and ecfg.model == "glm-4-flash", "Config reads CLUTCH_PROVIDER/CLUTCH_MODEL")
        check(ecfg.base_url == "https://open.bigmodel.cn/api/paas/v4" and ecfg.api_key == "sk-env", "Config reads CLUTCH_BASE_URL/CLUTCH_API_KEY")
    finally:
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    client = create_llm_client(
        provider="zhipu",
        api_key="sk-test",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        model="glm-4-flash",
    )
    check(client.model == "glm-4-flash" and client.api_key == "sk-test", "factory builds a zhipu (OpenAI-compatible) client")
    try:
        create_llm_client(provider="bogus", api_key="k", base_url="u", model="m")
        check(False, "factory rejects unknown provider")
    except ValueError:
        check(True, "factory rejects unknown provider")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
