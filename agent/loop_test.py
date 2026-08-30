"""Loop self-check driven by a scripted fake LLM (no network, no cost).

Run: uv run python -m agent.loop_test
Covers: tool execution, verify-fail -> iterate -> pass, budget abort,
doom-loop abort, max-tokens truncation, sink isolation.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from .config import Config
from .core.compaction import Compactor
from .events import AssistantMessageEvent, CompactionEvent, EventLog, FinalEvent, StateUpdateEvent, UserMessageEvent
from .loop import Agent
from .testsupport import check
from .tools.registry import ToolRegistry, build_default_tools
from .tools.workspace import LocalWorkspace, Workspace, shq


class FakeLLM:
    """Yields canned responses in order, then always the final one."""

    def __init__(
        self, responses: list[dict[str, Any]], fallback: dict[str, Any], usage: dict[str, Any] | None = None
    ) -> None:
        self._responses = list(responses)
        self._fallback = fallback
        self.usage = usage  # attached to every finish event (overflow probe)
        self.calls: list[list[dict[str, Any]]] = []

    def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        self.calls.append(messages)
        if self._responses:
            return self._responses.pop(0)
        return dict(self._fallback)

    def stream(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]):
        """Emit the canned response as stream events (text chunks, tool_calls, finish)."""
        self.calls.append(messages)
        resp = dict(self._responses.pop(0)) if self._responses else dict(self._fallback)
        content = resp.get("content") or ""
        finish = resp.get("finish_reason") or "stop"
        for i in range(0, len(content), 4):  # small chunks to exercise accumulation
            yield {"type": "text", "delta": content[i : i + 4]}
        tool_calls = resp.get("tool_calls") or []
        for idx, tc in enumerate(tool_calls):
            fn = tc.get("function", {})
            yield {
                "type": "tool_call_start",
                "index": idx,
                "id": tc.get("id", f"call_{idx}"),
                "name": fn.get("name", ""),
            }
            args = fn.get("arguments", "{}")
            for i in range(0, len(args), 4):
                yield {"type": "tool_call_delta", "index": idx, "delta": args[i : i + 4]}
        yield {
            "type": "finish",
            "reason": finish,
            "content": content,
            "tool_calls": [
                {
                    "id": tc.get("id", f"call_{idx}"),
                    "name": tc.get("function", {}).get("name", ""),
                    "arguments": tc.get("function", {}).get("arguments", "{}"),
                }
                for idx, tc in enumerate(tool_calls)
            ],
            "usage": self.usage,
        }


def _resp(content: str = "", tool_calls: list[dict[str, Any]] | None = None, finish: str = "stop") -> dict[str, Any]:
    m: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        m["tool_calls"] = tool_calls
    m["finish_reason"] = finish
    return m


def _tool_call(name: str, arguments: str, cid: str = "call_1") -> dict[str, Any]:
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": arguments}}


def _agent(fake: FakeLLM, config: Config, workspace: Workspace, log: EventLog | None = None) -> Agent:
    return Agent(
        llm=fake,  # type: ignore[arg-type] -- duck-typed chat()
        registry=ToolRegistry(build_default_tools(config)),
        workspace=workspace,
        config=config,
        log=log or EventLog(),
    )


def main() -> int:
    config = Config(verify_command="echo ok")

    # 0. no verify command (default): a generic task completes directly, no gate runs
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        no_gate = Config()  # verify_command defaults to ""
        fake = FakeLLM(
            responses=[_resp(content="done")],
            fallback=_resp(content="done"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(no_gate)),
            workspace=sb,
            config=no_gate,
        )
        result = agent.run("write an intro file")
        check(result == "done", "no verify command: natural finish, no gate")
        check(len(fake.calls) == 1, "no verify command: no extra LLM round trips")

    # 1. tool execution round trip: write a file, then no-tool answer -> verify passes
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", '{"path": "a.txt", "content": "hi"}')]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        result = _agent(fake, config, sb).run("write a.txt")
        check(result == "done", "tool exec then natural finish")
        check((sb.root / "a.txt").read_text() == "hi", "tool actually wrote file")
        check(fake.calls[1][-1]["role"] == "tool", "tool result fed back")

    # 2. verify gate fails (marker absent), model writes marker, then passes
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        gate_cfg = Config(verify_command="test -f ok.txt")
        fake = FakeLLM(
            responses=[
                _resp(content="first attempt"),
                _resp(tool_calls=[_tool_call("write_file", '{"path": "ok.txt", "content": "1"}')]),
                _resp(content="second attempt"),
            ],
            fallback=_resp(content="final"),
        )
        agent = _agent(fake, gate_cfg, sb)
        result = agent.run("t")
        check(result == "second attempt", "verify fail fed back then passed")
        # verify-fail feedback is a user message (not orphan tool msg)
        last_call = fake.calls[1]
        check(last_call[-1]["role"] == "user", "verify-fail feedback is a user message")
        check("verification gate did NOT pass" in last_call[-1]["content"], "verify feedback carries output")

    # 3. budget abort: model keeps returning tool calls until turns exhausted
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        budget = Config(verify_command="echo ok", max_turns=3)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
            ],
            fallback=_resp(content="never"),
        )
        result = _agent(fake, budget, sb).run("t")
        check(result == "ABORTED", "budget abort even when only tool calls")
        check(len(fake.calls) == 3, "budget stops after max_turns calls")

    # 4. doom-loop abort: 4 identical calls in a row
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
            ],
            fallback=_resp(content="never"),
        )
        result = _agent(fake, config, sb).run("t")
        check(result == "ABORTED", "doom-loop aborts run")

    # 5. max-tokens truncation: drop tool calls, feed user message, model retries
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[
                _resp(content="", tool_calls=[_tool_call("read_file", '{"path": "."}')], finish="length"),
                _resp(content="recovered"),
            ],
            fallback=_resp(content="recovered"),
        )
        result = _agent(fake, config, sb).run("t")
        check(result == "recovered", "max-tokens truncation recovered")
        check("max_tokens" in fake.calls[1][-1]["content"], "truncation feedback shown")

    # 6. sink isolation: a throwing sink must not kill the agent
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(responses=[_resp(content="done")], fallback=_resp(content="done"))

        def bad_sink(_ev: Any) -> None:
            raise RuntimeError("subscriber down")

        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            sink=bad_sink,
        )
        result = agent.run("t")
        check(result == "done", "throwing sink does not kill agent")

    # 7. cancellation: a pre-set cancel event aborts before any LLM call
    import threading

    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(responses=[_resp(content="done")], fallback=_resp(content="done"))
        cancel = threading.Event()
        cancel.set()
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            cancel=cancel,
        )
        result = agent.run("t")
        check(result == "ABORTED", "pre-set cancel aborts before LLM call")
        check(len(fake.calls) == 0, "cancel prevents any LLM call")

    # 8. permission gate: allow executes the tool
    from agent.core.permission import PermissionEvaluator, PermissionGate, Rule

    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        always_allow = PermissionEvaluator(rules=[Rule("allow", "*", "")])
        gate = PermissionGate(evaluator=always_allow)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", '{"path": "a.txt", "content": "hi"}')]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            gate=gate,
        )
        result = agent.run("t")
        check(result == "done", "permission allow executes tool")
        check((sb.root / "a.txt").read_text() == "hi", "allowed tool wrote file")

    # 9. permission gate: deny raises, tool error fed back, model recovers
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        deny_all = PermissionEvaluator(rules=[Rule("deny", "*", "")])
        gate = PermissionGate(evaluator=deny_all)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", '{"path": "a.txt", "content": "hi"}')]),
                _resp(content="gave up"),
            ],
            fallback=_resp(content="gave up"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            gate=gate,
        )
        result = agent.run("t")
        check(result == "gave up", "permission deny feeds error and agent continues")
        check(not (sb.root / "a.txt").exists(), "denied tool did not run")

    # 10. permission gate: ask blocks until the UI resolves; allow lets it proceed
    import threading as _threading

    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        ask_all = PermissionEvaluator(rules=[Rule("ask", "*", "")])
        gate = PermissionGate(evaluator=ask_all)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", '{"path": "a.txt", "content": "hi"}')]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            gate=gate,
        )

        def _auto_allow() -> None:
            _threading.Event().wait(0.2)  # let the agent block on ask
            for rid in gate.pending_ids():
                gate.resolve(rid, True)

        resolver = _threading.Thread(target=_auto_allow, daemon=True)
        resolver.start()
        result = agent.run("t")
        check(result == "done", "permission ask resolved by UI then executes")
        check((sb.root / "a.txt").read_text() == "hi", "asked-and-allowed tool wrote file")

    # 10b. sandbox escape: a user-approved external write executes (the old flat
    # denial is gone — the ask gate approves, the tool writes outside)
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        outside = Path(tmp).parent / f"{Path(tmp).name}.out.txt"
        gate = PermissionGate(evaluator=PermissionEvaluator())
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", json.dumps({"path": str(outside), "content": "hi"}))]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            gate=gate,
        )

        def _auto_approve() -> None:
            _threading.Event().wait(0.2)
            for rid in gate.pending_ids():
                gate.resolve(rid, True)

        r = _threading.Thread(target=_auto_approve, daemon=True)
        r.start()
        result = agent.run("t")
        check(result == "done", "approved external write completes the run")
        check(outside.read_text() == "hi", "approved external write executed")

    # 10c. sandbox escape denied: error fed back, nothing written outside
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        outside = Path(tmp).parent / f"{Path(tmp).name}.denied.txt"
        gate = PermissionGate(evaluator=PermissionEvaluator())
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", json.dumps({"path": str(outside), "content": "hi"}))]),
                _resp(content="gave up"),
            ],
            fallback=_resp(content="gave up"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            gate=gate,
        )

        def _auto_deny() -> None:
            _threading.Event().wait(0.2)
            for rid in gate.pending_ids():
                gate.resolve(rid, False)

        r = _threading.Thread(target=_auto_deny, daemon=True)
        r.start()
        result = agent.run("t")
        check(result == "gave up", "denied external write: agent continues")
        check(not outside.exists(), "denied external write did not execute")

    # 10d. run_command escape: `echo > /outside` asks and an approved one runs
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        outside = Path(tmp).parent / f"{Path(tmp).name}.echo.txt"
        gate = PermissionGate(evaluator=PermissionEvaluator())
        cmd = f"echo hi > {shq(str(outside))}"
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("run_command", json.dumps({"command": cmd}))]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            gate=gate,
        )

        def _auto_approve2() -> None:
            _threading.Event().wait(0.2)
            for rid in gate.pending_ids():
                gate.resolve(rid, True)

        r = _threading.Thread(target=_auto_approve2, daemon=True)
        r.start()
        result = agent.run("t")
        check(result == "done", "approved run_command escape completes the run")
        check(outside.read_text().strip() == "hi", "approved run_command escape executed")

    # 11. fatal LLM error (context overflow) -> graceful error final, no crash
    from agent.core.errors import AgentError

    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)

        class BoomLLM:
            def stream(self, messages, tools):
                raise AgentError(
                    code="context_window_exceeded",
                    message="Context window is full; cannot continue. Restart with a more focused task.",
                )

        log = EventLog()
        agent = Agent(
            llm=BoomLLM(),  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            log=log,
        )
        result = agent.run("t")
        check(result == "ABORTED", "fatal LLM error aborts run")
        finals = [e for e in log.events() if isinstance(e, FinalEvent)]
        check(bool(finals) and finals[-1].status == "error", "fatal LLM error emits error final")
        check(
            any(isinstance(e, StateUpdateEvent) and e.value == "error" for e in log.events()),
            "error state emitted",
        )

    # 12. Stop mid-stream: cancel set while the LLM is streaming aborts promptly —
    # the partial turn is dropped (no verify gate, no phantom 'done'), and the
    # stream is not consumed to the end.
    import threading

    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        cancel = threading.Event()

        class InterruptingLLM:
            def __init__(self) -> None:
                self.consumed = 0

            def stream(self, messages, tools):
                self.consumed += 1
                yield {"type": "text", "delta": "part1"}
                cancel.set()  # Stop arrives between chunks
                yield {"type": "text", "delta": "part2"}
                yield {"type": "finish", "reason": "stop", "content": "part1part2", "tool_calls": []}

        fake = InterruptingLLM()
        gate_cfg = Config(verify_command="echo ok")
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(gate_cfg)),
            workspace=sb,
            config=gate_cfg,
            cancel=cancel,
        )
        result = agent.run("t")
        check(result == "ABORTED", "Stop mid-stream aborts the run")
        check(fake.consumed == 1, "stream not consumed past the cancel point")
        finals = [e for e in agent.log.events() if isinstance(e, FinalEvent)]
        check(bool(finals) and finals[-1].status == "aborted", "aborted final, not a phantom completed")
        check(
            not any(e.type == "tool_call" for e in agent.log.events()),
            "no verify/tool path ran on the partial turn",
        )

    # 13. compaction: context overflow rolls the older turns into a summary and the
    # run continues (no abort); the summary is persisted as a CompactionEvent. Two
    # real work turns give the head something to summarize (a compaction after only
    # one turn would have nothing but the task, so the guard correctly skips it).
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        (sb.root / "a.txt").write_text("some content\n" * 30)
        cfg = Config(
            verify_command="echo ok",
            llm_context_window=1000,
            compaction_reserved=200,
            compaction_tail_tokens=1,
        )
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("read_file", '{"path": "a.txt"}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "a.txt"}')]),
                _resp(content="SUMMARY"),
                _resp(content="final answer"),
            ],
            fallback=_resp(content="fallback"),
            usage={"prompt_tokens": 900, "completion_tokens": 100, "total_tokens": 1000},
        )
        agent = Agent(llm=fake, registry=ToolRegistry(build_default_tools(cfg)), workspace=sb, config=cfg)
        result = agent.run("t")
        check(result == "final answer", "run completes after compaction")
        comps = [e for e in agent.log.events() if isinstance(e, CompactionEvent)]
        check(len(comps) == 1, "context overflow triggered one compaction")
        check(comps[0].summary == "SUMMARY", "compaction summary recorded")

    # 13b. compaction live progress: the compactor streams compaction_delta events
    # through its sink as the summary call writes (start marker, throttled char
    # counts), so a long compression never looks frozen in the UI — and a failed
    # summary call sends done=True so the live block closes instead of hanging.
    with tempfile.TemporaryDirectory() as tmp:
        log13 = EventLog()
        log13.append(UserMessageEvent(content="original task"))
        log13.append(AssistantMessageEvent(content="x" * 300))
        log13.append(AssistantMessageEvent(content="z" * 300))
        progress: list[object] = []
        fake13 = FakeLLM(
            responses=[_resp(content="S" * 600)],
            fallback=_resp(content="x"),
            usage={"prompt_tokens": 50, "completion_tokens": 150, "total_tokens": 200},
        )
        comp13 = Compactor(
            Config(llm_context_window=1000, compaction_reserved=200, compaction_tail_tokens=1),
            log13,
            fake13,
            sink=progress.append,
        )
        check(comp13.compact() is True, "compaction with progress sink succeeds")
        deltas = [e for e in progress if e.type == "compaction_delta"]
        check(len(deltas) >= 4, "progress events stream during compaction")
        check(deltas[0].chars == 0 and not deltas[0].done, "a start marker broadcasts first")
        check(deltas[-1].chars == 600, "final progress carries the total summary chars")
        check(not any(e.done for e in deltas), "no done marker on success")

        # failed summary call: the live block must be closed so the UI can't hang
        class BoomLlm:
            def stream(self, messages, tools=None):
                yield {"type": "text", "delta": "partial"}
                raise RuntimeError("boom")

        log13b = EventLog()
        log13b.append(UserMessageEvent(content="original task"))
        log13b.append(AssistantMessageEvent(content="x" * 300))
        log13b.append(AssistantMessageEvent(content="z" * 300))
        failed: list[object] = []
        comp13b = Compactor(
            Config(llm_context_window=1000, compaction_reserved=200, compaction_tail_tokens=1),
            log13b,
            BoomLlm(),
            sink=failed.append,
        )
        check(comp13b.compact() is False, "failed summary call returns False")
        check(
            any(e.type == "compaction_delta" and e.done for e in failed),
            "done marker closes the live block on failure",
        )

    # 13c. an empty reply (no visible text) is NOT a completion: it is fed back
    # as an error and retried, so the user never sees a silent "completed" with
    # no agent output on screen
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        empty_gate = Config(verify_command="echo ok")
        fake13c = FakeLLM(
            responses=[_resp(content=""), _resp(content="real answer")],
            fallback=_resp(content="done"),
        )
        agent13c = _agent(fake13c, empty_gate, sb)
        result13c = agent13c.run("t")
        check(result13c == "real answer", "empty reply is retried, not completed")
        check(len(fake13c.calls) == 2, "empty reply costs exactly one retry")
        check(
            any(
                isinstance(e, UserMessageEvent) and "no visible text" in e.content
                for e in agent13c.log.events()
            ),
            "retry prompt mentions the empty reply",
        )

    # 14. resumed long session with NO reported usage: the token estimate of the
    # derived context triggers compaction on the first turn — the resume case that
    # turn-count windowing used to brutalise (no usage, so the old usage-only check
    # could never fire).
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        cfg = Config(llm_context_window=1000, compaction_reserved=200, compaction_tail_tokens=1)
        log = EventLog()
        log.append(UserMessageEvent(content="original task"))
        for i in range(3):
            log.append(AssistantMessageEvent(content=f"blah {i} " + "x" * 1200))
        fake = FakeLLM(
            responses=[_resp(content="SUMMARY"), _resp(content="resumed answer")],
            fallback=_resp(content="fallback"),
            usage=None,
        )
        agent = Agent(llm=fake, registry=ToolRegistry(build_default_tools(cfg)), workspace=sb, config=cfg, log=log)
        result = agent.run("t")
        check(result == "resumed answer", "resumed run completes")
        comps = [e for e in agent.log.events() if isinstance(e, CompactionEvent)]
        check(len(comps) == 1, "estimate-based trigger compacted on the first turn")
        check(comps[0].summary == "SUMMARY", "resume compaction summary recorded")

    # 15. tool-call argument streaming: the loop forwards the model's tool_call
    # deltas as ToolCallDeltaEvent so the UI can render a write/edit as it happens;
    # the concatenated deltas equal the final arguments.
    from .events import ToolCallDeltaEvent

    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        streamed: list[ToolCallDeltaEvent] = []
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", '{"path": "a.txt", "content": "hi"}')]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            sink=lambda ev: streamed.append(ev) if isinstance(ev, ToolCallDeltaEvent) else None,
        )
        result = agent.run("t")
        check(result == "done", "streaming run completes")
        check(len(streamed) >= 2, "tool-call deltas streamed to the sink")
        check(streamed[0].name == "write_file", "the start delta carries the tool name")
        joined = "".join(e.delta for e in streamed)
        check(joined == '{"path": "a.txt", "content": "hi"}', "streamed deltas reassemble the arguments")

    # 15b. chat-mode toolset: schema pruning + system-prompt mode note
    from .core import context as _context

    chat_cfg = Config(mode="chat", verify_command="echo ok")
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        chat_names = [t.name for t in build_default_tools(chat_cfg)]
        check("write_file" not in chat_names and "edit_file" not in chat_names, "chat mode prunes write tools")
        check("run_command" in chat_names and "read_file" in chat_names, "chat mode keeps read tools")
        log = EventLog()
        log.append(UserMessageEvent(content="hi"))
        msgs = _context.derive_messages(log, chat_cfg, "t")
        check("chat (read-only)" in msgs[0]["content"], "chat system prompt carries the read-only note")
        check("work (full access)" not in msgs[0]["content"], "chat system prompt carries no work note")
        msgs_work = _context.derive_messages(log, Config(mode="work"), "t")
        check("work (full access)" in msgs_work[0]["content"], "work system prompt carries the work note")
        check("chat (read-only)" not in msgs_work[0]["content"], "work system prompt has no chat note")

    # 15d. project memory: all stored titles are listed with an active recall
    # prompt, and the base prompt always carries the save guidance
    from .memory import MemoryStore

    with tempfile.TemporaryDirectory() as tmp:
        mem_path = str(Path(tmp) / "p.clc")
        store = MemoryStore(mem_path)
        store.save("user prefers utf-8", "always write files as utf-8")
        store.save("branch naming", "use feature/ prefix")
        msgs_mem = _context.derive_messages(log, chat_cfg, "t", memories=store)
        sys_mem = msgs_mem[0]["content"]
        check(
            "Project memories from earlier sessions" in sys_mem,
            "stored titles are listed under the active recall prompt",
        )
        check("user prefers utf-8" in sys_mem and "branch naming" in sys_mem, "all stored titles are listed")
        check(
            "save_memory whenever you learn a durable fact" in sys_mem,
            "base prompt carries the save guidance",
        )
        msgs_empty = _context.derive_messages(log, chat_cfg, "t", memories=MemoryStore(mem_path))
        check(
            "Project memories from earlier sessions" not in msgs_empty[0]["content"],
            "no title section when the store is empty",
        )
        check(
            "save_memory whenever you learn a durable fact" in msgs_empty[0]["content"],
            "save guidance is present even without stored memories",
        )

    # 15c. chat-mode run_command: read-only commands run, writes/unknowns are
    # rejected and fed back as errors (default deny), nothing touches the disk
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("run_command", '{"command": "touch x.txt"}')]),
                _resp(tool_calls=[_tool_call("run_command", '{"command": "ls"}')]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        agent = _agent(fake, chat_cfg, sb)
        result = agent.run("t")
        check(result == "done", "chat run completes")
        check(not (sb.root / "x.txt").exists(), "chat mode rejected the write command")
        first_result = [e for e in agent.log.events() if getattr(e, "type", "") == "tool_result"][0]
        check(
            "read-only" in first_result.content or "CHAT MODE" in first_result.content,
            "rejection fed back as an error",
        )

    # 15d. chat mode cannot reach write_file even if the model tries (unknown tool)
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("write_file", '{"path": "a.txt", "content": "hi"}')]),
                _resp(content="done"),
            ],
            fallback=_resp(content="done"),
        )
        agent = _agent(fake, chat_cfg, sb)
        result = agent.run("t")
        check(result == "done", "chat run with attempted write completes")
        check(not (sb.root / "a.txt").exists(), "write_file unknown in chat mode: nothing written")

    # 15e. classify_command unit checks (static read-only classifier)
    from .tools.shell import classify_command

    for cmd, exp in [
        ("ls -la", "read"),
        ("nvidia-smi", "read"),
        ("git status", "read"),
        ("git commit -m x", "write"),
        ("echo hi > f", "write"),
        ("echo hi | grep x", "read"),
        ("find . -delete", "write"),
        ("sed -i s/a/b/ f", "write"),
        ("python3 foo.py", "unknown"),
        ("echo hi && rm x", "write"),
    ]:
        got, _ = classify_command(cmd)
        check(got == exp, f"classify {cmd!r} == {exp!r} (got {got!r})")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
