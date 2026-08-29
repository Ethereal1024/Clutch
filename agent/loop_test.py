"""Loop self-check driven by a scripted fake LLM (no network, no cost).

Run: uv run python -m agent.loop_test
Covers: tool execution, verify-fail -> iterate -> pass, budget abort,
doom-loop abort, max-tokens truncation, sink isolation.
"""

from __future__ import annotations

import sys
import tempfile
from typing import Any

from .config import Config
from .events import AssistantMessageEvent, CompactionEvent, EventLog, FinalEvent, StateUpdateEvent, UserMessageEvent
from .loop import Agent
from .testsupport import check
from .tools.registry import ToolRegistry, build_default_tools
from .tools.workspace import LocalWorkspace, Workspace


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
                _resp(tool_calls=[_tool_call("list_dir", "{}")]),
                _resp(tool_calls=[_tool_call("list_dir", "{}")]),
                _resp(tool_calls=[_tool_call("list_dir", "{}")]),
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
                _resp(tool_calls=[_tool_call("list_dir", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("list_dir", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("list_dir", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("list_dir", '{"path": "."}')]),
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
                _resp(content="", tool_calls=[_tool_call("list_dir", "{}")], finish="length"),
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
    # run continues (no abort); the summary is persisted as a CompactionEvent.
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        cfg = Config(
            verify_command="echo ok",
            llm_context_window=1000,
            compaction_reserved=200,
            compaction_tail_tokens=1,
        )
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("list_dir", "{}")]),
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

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
