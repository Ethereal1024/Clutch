"""Loop self-check driven by a scripted fake LLM (no network, no cost).

Run: uv run python -m agent.loop_test
Covers: tool execution, verify-fail -> iterate -> pass, budget abort,
doom-loop abort, max-tokens truncation, sink isolation.
"""

from __future__ import annotations

import sys
import tempfile
from typing import Any, Dict, List

from .config import Config
from .core import context
from .events import EventLog
from .llm.client import LlmClient
from .loop import Agent
from .tools.registry import ToolRegistry, build_default_tools
from .tools.sandbox import Sandbox


class FakeLLM:
    """Yields canned responses in order, then always the final one."""

    def __init__(self, responses: List[Dict[str, Any]], fallback: Dict[str, Any]) -> None:
        self._responses = list(responses)
        self._fallback = fallback
        self.calls: List[Dict[str, Any]] = []

    def chat(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Dict[str, Any]:
        self.calls.append(messages)
        if self._responses:
            return self._responses.pop(0)
        return dict(self._fallback)


def _resp(content: str = "", tool_calls: List[Dict[str, Any]] = None, finish: str = "stop") -> Dict[str, Any]:
    m: Dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        m["tool_calls"] = tool_calls
    m["finish_reason"] = finish
    return m


def _tool_call(name: str, arguments: str, cid: str = "call_1") -> Dict[str, Any]:
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": arguments}}


def check(cond: bool, name: str) -> None:
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok:   {name}")


def _agent(fake: FakeLLM, config: Config, sandbox: Sandbox, log: EventLog | None = None) -> Agent:
    return Agent(
        llm=fake,  # type: ignore[arg-type] -- duck-typed chat()
        registry=ToolRegistry(build_default_tools(config)),
        sandbox=sandbox,
        config=config,
        log=log or EventLog(),
    )


def main() -> None:
    config = Config(verify_command="echo ok")

    # 0. no verify command (default): a generic task completes directly, no gate runs
    with tempfile.TemporaryDirectory() as tmp:
        sb = Sandbox(tmp)
        no_gate = Config()  # verify_command defaults to ""
        fake = FakeLLM(
            responses=[_resp(content="done")],
            fallback=_resp(content="done"),
        )
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(no_gate)),
            sandbox=sb,
            config=no_gate,
        )
        result = agent.run("write an intro file")
        check(result == "done", "no verify command: natural finish, no gate")
        check(len(fake.calls) == 1, "no verify command: no extra LLM round trips")

    # 1. tool execution round trip: write a file, then no-tool answer -> verify passes
    with tempfile.TemporaryDirectory() as tmp:
        sb = Sandbox(tmp)
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
        sb = Sandbox(tmp)
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
        sb = Sandbox(tmp)
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
        sb = Sandbox(tmp)
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
        sb = Sandbox(tmp)
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
        sb = Sandbox(tmp)
        fake = FakeLLM(responses=[_resp(content="done")], fallback=_resp(content="done"))

        def bad_sink(_ev: Any) -> None:
            raise RuntimeError("subscriber down")

        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            sandbox=sb,
            config=config,
            sink=bad_sink,
        )
        result = agent.run("t")
        check(result == "done", "throwing sink does not kill agent")

    # 7. cancellation: a pre-set cancel event aborts before any LLM call
    import threading

    with tempfile.TemporaryDirectory() as tmp:
        sb = Sandbox(tmp)
        fake = FakeLLM(responses=[_resp(content="done")], fallback=_resp(content="done"))
        cancel = threading.Event()
        cancel.set()
        agent = Agent(
            llm=fake,  # type: ignore[arg-type]
            registry=ToolRegistry(build_default_tools(config)),
            sandbox=sb,
            config=config,
            cancel=cancel,
        )
        result = agent.run("t")
        check(result == "ABORTED", "pre-set cancel aborts before LLM call")
        check(len(fake.calls) == 0, "cancel prevents any LLM call")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
