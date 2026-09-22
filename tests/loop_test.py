"""Loop self-check with a scripted fake LLM (no network).

Run: uv run python -m tests.loop_test
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog
from agent.events import (
    AssistantMessageEvent,
    CompactionEvent,
    FinalEvent,
    LlmRetryEvent,
    StateUpdateEvent,
    TextDeltaEvent,
    ToolResultEvent,
    UserMessageEvent,
)
from agent.llm.client import LlmError
from agent.loop import Agent
from agent.tools.registry import ToolRegistry, build_default_tools
from agent.tools.workspace import LocalWorkspace, Workspace, shq
from tests.testsupport import check, posix_shell_argv


class FakeLLM:
    """Yields canned responses in order, then always the final one."""

    def __init__(self, responses: list[dict[str, Any]], fallback: dict[str, Any]) -> None:
        self._responses = list(responses)
        self._fallback = fallback
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
        }


def _resp(content: str = "", tool_calls: list[dict[str, Any]] | None = None, finish: str = "stop") -> dict[str, Any]:
    m: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        m["tool_calls"] = tool_calls
    m["finish_reason"] = finish
    return m


def _tool_call(name: str, arguments: str, cid: str = "call_1") -> dict[str, Any]:
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": arguments}}


def _agent(fake: FakeLLM, config: Config, workspace: Workspace, log: LazyEventLog | None = None) -> Agent:
    return Agent(
        llm=fake,  # type: ignore[arg-type] -- duck-typed chat()
        registry=ToolRegistry(build_default_tools(config)),
        workspace=workspace,
        config=config,
        log=log or LazyEventLog.in_memory(),
    )


def main() -> int:
    config = Config()

    # 0. natural finish: a no-tool answer completes in one round trip
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[_resp(content="done")],
            fallback=_resp(content="done"),
        )
        result = _agent(fake, config, sb).run("write an intro file")
        check(result == "done", "natural finish completes the task")
        check(len(fake.calls) == 1, "no extra LLM round trips on natural finish")

    # 1. tool execution round trip: write a file, then a no-tool answer completes
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

    # 3. budget abort: model keeps returning tool calls until turns exhausted
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        budget = Config(max_turns=3)
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

    # 4. doom-loop: first detection warns (feeds back), repeating the exact call aborts
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(content="course corrected"),
            ],
            fallback=_resp(content="course corrected"),
        )
        agent = _agent(fake, config, sb)
        result = agent.run("t")
        check(result == "course corrected", "first doom-loop detection warns, does not abort")
        results = [e for e in agent.log.events() if isinstance(e, ToolResultEvent)]
        check(
            bool(results) and "Dead loop detected" in results[-1].content,
            "doom warning fed back inside the tool result",
        )

    # 4b. repeating the exact warned call aborts the run
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "."}')]),
            ],
            fallback=_resp(content="never"),
        )
        result = _agent(fake, config, sb).run("t")
        check(result == "ABORTED", "repeating the warned call aborts the run")

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

    # 10b. sandbox escape: approved external write executes
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

        seen: list[Any] = []
        agent = Agent(
            llm=BoomLLM(),  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            sink=seen.append,
        )
        result = agent.run("t")
        check(result == "ABORTED", "fatal LLM error aborts run")
        finals = [e for e in agent.log.events() if isinstance(e, FinalEvent)]
        check(bool(finals) and finals[-1].status == "error", "fatal LLM error emits error final")
        check(
            any(isinstance(e, StateUpdateEvent) and e.value == "error" for e in seen),
            "error state emitted",
        )

    # 12. Stop mid-stream: cancel aborts promptly, partial turn dropped
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
        cfg = Config()
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(cfg)),
            workspace=sb,
            config=cfg,
            cancel=cancel,
        )
        result = agent.run("t")
        check(result == "ABORTED", "Stop mid-stream aborts the run")
        check(fake.consumed == 1, "stream not consumed past the cancel point")
        finals = [e for e in agent.log.events() if isinstance(e, FinalEvent)]
        check(bool(finals) and finals[-1].status == "aborted", "aborted final, not a phantom completed")
        check(
            not any(e.type == "tool_call" for e in agent.log.events()),
            "no tool path ran on the partial turn",
        )

    # 12b. mid-stream transport drop: the client's retry notice reaches the live
    # sink BEFORE the recovered text, and nothing transient touches the durable log
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        live: list[Any] = []

        class ReconnectingLlm:
            """Client-shaped recovery: the first stream attempt died before its
            first token (network drop / read timeout); the client reconnects with
            backoff and the second attempt delivers. From the loop's perspective
            the stream yields a "retry" notice, then the recovered text."""

            def stream(self, messages, tools=None):
                yield {
                    "type": "retry",
                    "attempt": 1,
                    "max": 3,
                    "code": "timeout",
                    "message": "Request timed out. — retrying (1/3)",
                }
                yield {"type": "text", "delta": "recovered"}
                yield {"type": "finish", "reason": "stop", "content": "recovered", "tool_calls": []}

        agent = Agent(
            llm=ReconnectingLlm(),  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            workspace=sb,
            config=config,
            sink=live.append,
        )
        result = agent.run("t")
        check(result == "recovered", "run completes after a pre-token retry")
        retries = [e for e in live if isinstance(e, LlmRetryEvent)]
        check(len(retries) == 1, "retry notice reached the live sink")
        check(retries[0].attempt == 1 and retries[0].max_retries == 3, "retry notice carries attempt/max")
        check("retrying (1/3)" in retries[0].message, "retry notice names the attempt and budget")
        texts = [e for e in live if isinstance(e, TextDeltaEvent)]
        check(
            bool(texts) and "".join(e.content for e in texts) == "recovered",
            "recovered text streamed after the retry",
        )
        check(live.index(retries[0]) < live.index(texts[0]), "retry notice precedes the recovered text")
        check(
            not any(isinstance(e, LlmRetryEvent) for e in agent.log.events()),
            "retry notice never lands in the durable log",
        )

    # 13. compaction: overflow rolls older turns into a summary, run continues
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        (sb.root / "a.txt").write_text("some content\n" * 30)
        cfg = Config(llm_context_window_bytes=1200)
        fake = FakeLLM(
            responses=[
                _resp(tool_calls=[_tool_call("read_file", '{"path": "a.txt"}')]),
                _resp(tool_calls=[_tool_call("read_file", '{"path": "a.txt"}')]),
                _resp(content="SUMMARY"),
                _resp(content="final answer"),
            ],
            fallback=_resp(content="fallback"),
        )
        agent = Agent(llm=fake, registry=ToolRegistry(build_default_tools(cfg)), workspace=sb, config=cfg)
        result = agent.run("t")
        check(result == "final answer", "run completes after compaction")
        comps = [e for e in agent.log.events() if isinstance(e, CompactionEvent)]
        check(len(comps) == 1, "context overflow triggered one compaction")
        check(comps[0].summary == "SUMMARY", "compaction summary recorded")

    # 13b. compaction progress: delta events stream; done=True closes on failure
    with tempfile.TemporaryDirectory() as tmp:
        log13 = LazyEventLog.in_memory()
        log13.append(UserMessageEvent(content="original task"))
        log13.append(AssistantMessageEvent(content="x" * 300))
        log13.append(AssistantMessageEvent(content="z" * 300))
        progress: list[object] = []
        fake13 = FakeLLM(
            responses=[_resp(content="S" * 600)],
            fallback=_resp(content="x"),
        )
        comp13 = Compactor(
            Config(llm_context_window_bytes=1000),
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

        # failed summary: the live block must close
        class BoomLlm:
            def stream(self, messages, tools=None):
                yield {"type": "text", "delta": "partial"}
                raise RuntimeError("boom")

        log13b = LazyEventLog.in_memory()
        log13b.append(UserMessageEvent(content="original task"))
        log13b.append(AssistantMessageEvent(content="x" * 300))
        log13b.append(AssistantMessageEvent(content="z" * 300))
        failed: list[object] = []
        comp13b = Compactor(
            Config(llm_context_window_bytes=1000),
            log13b,
            BoomLlm(),
            sink=failed.append,
        )
        check(comp13b.compact() is False, "failed summary call returns False")
        check(
            any(e.type == "compaction_delta" and e.done for e in failed),
            "done marker closes the live block on failure",
        )

    # 13d. summary prompt capped: multi-MB head not serialized in full
    log13d = LazyEventLog.in_memory()
    log13d.append(UserMessageEvent(content="task"))
    for i in range(1500):
        log13d.append(AssistantMessageEvent(content=f"old work {i} " + "x" * 500))
    prompt_len: dict[str, int] = {}

    class CaptureLlm:
        def stream(self, messages, tools=None):
            prompt_len["n"] = len(messages[0]["content"].encode("utf-8"))
            yield {"type": "text", "delta": "S" * 60}
            yield {"type": "finish", "reason": "stop"}

    comp13d = Compactor(Config(llm_context_window_bytes=200_000), log13d, CaptureLlm())
    check(comp13d.compact() is True, "compaction with a multi-MB head succeeds")
    check(
        prompt_len["n"] <= 200_000 - 8_192 + 5_000,
        f"summary prompt capped to window minus previous summary + template "
        f"({prompt_len['n']} <= ~197000)",
    )

    # 13f. second compaction input is the whole current window, not a capped slice
    log13f = LazyEventLog.in_memory()
    log13f.append(UserMessageEvent(content="task"))
    for i in range(600):
        log13f.append(AssistantMessageEvent(content=f"old work {i} " + "x" * 200))
    prompt_n: dict[str, str] = {}

    class CaptureLlm2:
        def stream(self, messages, tools=None):
            prompt_n["n"] = messages[0]["content"]
            yield {"type": "text", "delta": "S" * 60}
            yield {"type": "finish", "reason": "stop"}

    comp13f = Compactor(Config(llm_context_window_bytes=200_000), log13f, CaptureLlm2())
    check(comp13f.compact() is True, "first compaction succeeds")
    check(log13f.window_bytes() < 200_000,
          "window collapsed to just the new summary line after compaction")
    marker = "new work 0 "
    for i in range(600):
        log13f.append(AssistantMessageEvent(content=f"new work {i} " + "y" * 200))
    check(comp13f.compact() is True, "second compaction succeeds")
    check(
        marker in prompt_n["n"],
        "second compaction input carries the whole post-compaction window "
        "verbatim (first appended event included, not a capped slice)",
    )
    check(comp13f.compact() is False,
          "third compaction is a no-op (the window holds only the summary line)")

    # 13e. cancel aborts an in-flight compaction
    import threading  # noqa: PLC0415

    cancel = threading.Event()
    log13e = LazyEventLog.in_memory()
    log13e.append(UserMessageEvent(content="task"))
    for i in range(400):
        log13e.append(AssistantMessageEvent(content=f"work {i} " + "x" * 200))
    calls: list[int] = []

    class SlowLlm:
        def stream(self, messages, tools=None):
            calls.append(1)
            yield {"type": "text", "delta": "partial"}
            cancel.set()  # the user hits stop mid-summary
            yield {"type": "text", "delta": "more"}
            yield {"type": "finish", "reason": "stop"}

    comp13e = Compactor(Config(llm_context_window_bytes=200_000), log13e, SlowLlm(), cancel=cancel)
    check(comp13e.compact() is False, "cancel mid-summary aborts compaction")
    check(len(calls) == 1, "summary stream interrupted once, not completed")

    # 13c. empty reply is fed back as an error and retried
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        fake13c = FakeLLM(
            responses=[_resp(content=""), _resp(content="real answer")],
            fallback=_resp(content="done"),
        )
        agent13c = _agent(fake13c, config, sb)
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

    # 13g. compaction summary transport drop: the client's retry notice is
    # mirrored into the live progress block; the resumed summary lands intact
    log13g = LazyEventLog.in_memory()
    log13g.append(UserMessageEvent(content="task"))
    log13g.append(AssistantMessageEvent(content="x" * 300))
    notes: list[object] = []

    class ReconnectingSummaryLlm:
        def stream(self, messages, tools=None):
            yield {
                "type": "retry",
                "attempt": 1,
                "max": 3,
                "code": "timeout",
                "message": "Request timed out. — retrying (1/3)",
            }
            yield {"type": "text", "delta": "the summary"}
            yield {"type": "finish", "reason": "stop"}

    comp13g = Compactor(
        Config(llm_context_window_bytes=1000),
        log13g,
        ReconnectingSummaryLlm(),
        sink=notes.append,
    )
    check(comp13g.compact() is True, "compaction survives a pre-token retry")
    deltas13g = [e for e in notes if e.type == "compaction_delta"]
    check(
        any(e.note and "retrying" in e.note for e in deltas13g),
        "retry notice mirrored into the live compaction block",
    )
    comps13g = [e for e in log13g.events() if isinstance(e, CompactionEvent)]
    check(
        len(comps13g) == 1 and comps13g[0].summary == "the summary",
        "resumed summary streamed once, no duplication",
    )

    # 14. resumed session: the byte trigger fires on the first turn
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        cfg = Config(llm_context_window_bytes=1000)
        log = LazyEventLog.in_memory()
        log.append(UserMessageEvent(content="original task"))
        for i in range(3):
            log.append(AssistantMessageEvent(content=f"blah {i} " + "x" * 1200))
        fake = FakeLLM(
            responses=[_resp(content="SUMMARY"), _resp(content="resumed answer")],
            fallback=_resp(content="fallback"),
        )
        agent = Agent(llm=fake, registry=ToolRegistry(build_default_tools(cfg)), workspace=sb, config=cfg, log=log)
        result = agent.run("t")
        check(result == "resumed answer", "resumed run completes")
        comps = [e for e in agent.log.events() if isinstance(e, CompactionEvent)]
        check(len(comps) == 1, "byte trigger compacted on the first turn")
        check(comps[0].summary == "SUMMARY", "resume compaction summary recorded")

    # 15. tool-call argument streaming: deltas reassemble to the final arguments
    from agent.events import ToolCallDeltaEvent

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
    from agent.core import context as _context

    chat_cfg = Config(mode="chat")
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        chat_names = [t.name for t in build_default_tools(chat_cfg)]
        check("write_file" not in chat_names and "edit_file" not in chat_names, "chat mode prunes write tools")
        check("run_command" in chat_names and "read_file" in chat_names, "chat mode keeps read tools")
        log = LazyEventLog.in_memory()
        log.append(UserMessageEvent(content="hi"))
        msgs = _context.derive_messages(log, chat_cfg, "t")
        check("chat (read-only)" in msgs[0]["content"], "chat system prompt carries the read-only note")
        check("work (full access)" not in msgs[0]["content"], "chat system prompt carries no work note")
        msgs_work = _context.derive_messages(log, Config(mode="work"), "t")
        check("work (full access)" in msgs_work[0]["content"], "work system prompt carries the work note")
        check("chat (read-only)" not in msgs_work[0]["content"], "work system prompt has no chat note")

    # 15d. project memory: titles listed; base prompt carries save guidance
    from agent.memory import MemoryStore

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
            "Project memories from earlier sessions: none stored yet" in msgs_empty[0]["content"],
            "empty store states no memories so the model skips the probing search",
        )
        check(
            "user prefers utf-8" not in msgs_empty[0]["content"],
            "no titles when the store is empty",
        )
        check(
            "save_memory whenever you learn a durable fact" in msgs_empty[0]["content"],
            "save guidance is present even without stored memories",
        )

    # 15c. chat run_command: reads run, writes/unknowns rejected (default deny)
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
    from agent.tools.shell import classify_command

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

    # 16. Stop during a tool call: the cancel event reaches the RUNNING
    # run_command and kills the command tree, so the run aborts promptly —
    # it must NOT wait out the command. (The Stop-latency bug: cancel was
    # only checked between tools, so a long build ignored Stop until it
    # finished; the click landed but nothing happened for minutes.)
    import threading
    import time as _time

    if posix_shell_argv() is None:
        print("SKIP: no POSIX shell — section 16 needs one to run `sleep`")
    else:
        with tempfile.TemporaryDirectory() as tmp:
            sb = LocalWorkspace(tmp)
            cancel = threading.Event()

            class ToolThenStopLlm:
                """First call: a run_command that would sleep far longer than
                any sane test. Second call (only reached if Stop failed)."""

                def __init__(self) -> None:
                    self.calls = 0

                def stream(self, messages, tools):
                    self.calls += 1
                    if self.calls == 1:
                        args = json.dumps({"command": "sleep 120"})
                        yield {"type": "tool_call_start", "index": 0, "id": "c1", "name": "run_command"}
                        for i in range(0, len(args), 4):  # the loop accumulates from deltas
                            yield {"type": "tool_call_delta", "index": 0, "delta": args[i : i + 4]}
                        yield {"type": "finish", "reason": "tool_calls", "content": "", "tool_calls": []}
                        return
                    yield {"type": "text", "delta": "kept going"}
                    yield {"type": "finish", "reason": "stop", "content": "kept going", "tool_calls": []}

            fake = ToolThenStopLlm()
            cfg = Config()
            agent = Agent(
                llm=fake,  # type: ignore[arg-type]
                registry=ToolRegistry(build_default_tools(cfg)),
                workspace=sb,
                config=cfg,
                cancel=cancel,
            )
            threading.Timer(1.0, cancel.set).start()  # Stop lands while sleep 120 runs
            t0 = _time.monotonic()
            result = agent.run("t")
            elapsed = _time.monotonic() - t0
            check(result == "ABORTED", "Stop during run_command aborts the run")
            check(fake.calls == 1, "no LLM call happens after the abort")
            check(elapsed < 10, f"abort is prompt, not after the command (took {elapsed:.1f}s)")
            finals = [e for e in agent.log.events() if isinstance(e, FinalEvent)]
            check(bool(finals) and finals[-1].status == "aborted", "aborted final")
            aborted_result = [e for e in agent.log.events() if getattr(e, "type", "") == "tool_result"]
            check(
                bool(aborted_result) and "Stop" in aborted_result[-1].content,
                "the killed command says it was aborted by Stop",
            )

    # 17. window overflow: the loop compacts the overflowing window and retries
    #     the same turn once instead of aborting. Both wire protocols normalize
    #     the provider's own wording onto context_window_exceeded for exactly
    #     this path (see llm_client_test 1b / 5g.2); here it arrives as the
    #     client contract raises it, through the loop's own LlmError mapping.
    with tempfile.TemporaryDirectory() as tmp:
        sb = LocalWorkspace(tmp)
        cfg = Config(llm_context_window_bytes=10_000_000)  # the byte trigger never fires: only the error does
        log = LazyEventLog.in_memory()
        log.append(UserMessageEvent(content="earlier task"))
        log.append(AssistantMessageEvent(content="earlier answer " + "x" * 200))

        class OverflowOnceLlm:
            """Call 1 overflows; call 2 is the summarizer; call 3 is the retry."""

            def __init__(self) -> None:
                self.calls = 0
                self.seen: list[list[dict[str, Any]]] = []

            def stream(self, messages, tools=None):
                self.calls += 1
                self.seen.append(messages)
                if self.calls == 1:
                    raise LlmError(
                        code="context_window_exceeded",
                        message="This model's maximum context length is 128000 tokens",
                    )
                yield {"type": "text", "delta": "SUMMARY" if self.calls == 2 else "recovered"}
                yield {"type": "finish", "reason": "stop", "tool_calls": []}

        fake17 = OverflowOnceLlm()
        agent = Agent(
            llm=fake17,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(cfg)),
            workspace=sb,
            config=cfg,
            log=log,
        )
        result = agent.run("t")
        check(result == "recovered", "an overflowed turn compacts and continues")
        check(fake17.calls == 3, "the turn was retried exactly once after the summary")
        comps17 = [e for e in agent.log.events() if isinstance(e, CompactionEvent)]
        check(len(comps17) == 1 and comps17[0].summary == "SUMMARY", "the overflow forced one compaction")
        check(agent.log.cpr_start() > 0, "the window slid to the summary: the overflowed history is gone")
        check("earlier answer" in str(fake17.seen[1]), "the summarizer saw the window that overflowed")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
