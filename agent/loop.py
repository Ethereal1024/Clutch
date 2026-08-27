"""Harness main loop (event-stream driven).

Per run:
1. Append user_message event.
2. while True:
   a. derive model messages from the event log
   b. call LLM, parse (content, tool_calls, finish_reason)
   c. no tool call -> candidate done -> run verification gate;
      pass => stop, fail => feed output back and continue
   d. tool call(s) -> execute each, feed result back as tool_result
   e. budget / doom-loop checks
3. Terminate -> append final event.

Events are the single source of truth: log, GUI and context all derive from them.
"""

from __future__ import annotations

import sys
from typing import Any, Callable, Dict, List, Optional

from .config import Config
from .core import context
from .core import errors as agent_errors
from .core.parse import ParseError, parse_arguments, parse_message
from .core.terminate import Terminator
from .events import (
    AssistantMessageEvent,
    Event,
    EventLog,
    FinalEvent,
    StateUpdateEvent,
    StepStartEvent,
    TextDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
)
from .llm.client import LlmClient, LlmError
from .prompts import render
from .tools.registry import ToolRegistry
from .tools.sandbox import Sandbox

# Callback for subscribers (GUI/SSE); the engine does not care who listens.
EventSink = Callable[[Event], None]


class Agent:
    def __init__(
        self,
        llm: LlmClient,
        registry: ToolRegistry,
        sandbox: Sandbox,
        config: Config,
        log: Optional[EventLog] = None,
        sink: Optional[EventSink] = None,
    ) -> None:
        self.llm = llm
        self.registry = registry
        self.sandbox = sandbox
        self.config = config
        self.terminator = Terminator(config)
        self.log = log or EventLog(path=config.log_path)
        self.sink = sink

    def _emit(self, event: Event) -> None:
        self.log.append(event)
        if self.sink:
            # isolate the sink: a failing subscriber must not kill the agent
            try:
                self.sink(event)
            except Exception:  # noqa: BLE001 -- subscriber failure is non-fatal
                print(f"[clutch] sink error: {event.type}", file=sys.stderr)

    def _finish(self, status: str, summary: str) -> str:
        self._emit(FinalEvent(status=status, summary=summary))
        self._emit(StateUpdateEvent(value="finished"))
        return "ABORTED" if status != "completed" else summary

    def run(self, task: str) -> str:
        self._emit(StateUpdateEvent(value="running"))
        self._emit(UserMessageEvent(content=task))

        turn = 0
        while True:
            turn += 1
            # budget is enforced at the top so every path terminates
            if self.terminator.check_turn_budget(turn):
                return self._finish(
                    "aborted", render("budget_exceeded.md", max_turns=self.config.max_turns)
                )
            self._emit(StepStartEvent())
            msgs = context.derive_messages(self.log, self.config, task)

            try:
                message = self.llm.chat(msgs, tools=self.registry.schemas())
            except LlmError as e:
                if e.code == "context_window_exceeded":
                    raise agent_errors.context_window_error(e.message)
                raise agent_errors.AgentError(code=e.code, message=e.message)
            except Exception as e:  # noqa: BLE001 -- normalize unexpected errors
                raise agent_errors.AgentError(code="llm_unknown", message=str(e))

            content, tool_calls, finish_reason = parse_message(message)

            # max-tokens truncation: drop incomplete tool calls, ask to be concise
            if finish_reason == "length":
                self._emit(UserMessageEvent(content=render("max_tokens.md")))
                continue

            if content:
                self._emit(TextDeltaEvent(content=content))

            # ---- tool calls: execute and feed results back ----
            if tool_calls:
                tc_events: List[ToolCallEvent] = []
                for tc in tool_calls:
                    ev = ToolCallEvent(
                        name=tc["name"], arguments=tc["arguments"], tool_call_id=tc["id"]
                    )
                    self._emit(ev)
                    tc_events.append(ev)

                # record the assistant turn with tool_calls before executing
                self._emit(
                    AssistantMessageEvent(
                        content=content,
                        tool_calls=[
                            {"id": ev.tool_call_id, "name": ev.name, "arguments": ev.arguments}
                            for ev in tc_events
                        ],
                    )
                )

                for ev in tc_events:
                    if self.terminator.record_call(ev.name, ev.arguments):
                        # doom loop: repeated identical calls; escalate to abort unless disabled
                        if self.config.abort_on_doom_loop:
                            return self._finish("aborted", render("doom_loop.md"))
                        result = {"content": render("doom_loop.md"), "error": True}
                    else:
                        result = self._execute_tool(ev)
                    self._emit(
                        ToolResultEvent(
                            tool_call_id=ev.tool_call_id,
                            content=result.get("content", ""),
                            is_error=result.get("error", False),
                        )
                    )
                continue

            # ---- no tool call: candidate done -> verification gate ----
            self._emit(AssistantMessageEvent(content=content))
            v = self.terminator.verify(self.sandbox)
            if v.done:
                return self._finish("completed", content)

            # gate failed: feed verification output back and keep iterating
            self._emit(UserMessageEvent(content=render("verify_failed.md", output=v.verify_output)))

    def _execute_tool(self, ev: ToolCallEvent) -> Dict[str, Any]:
        """Parse arguments and run the tool; any failure feeds back as tool error."""
        try:
            args = parse_arguments(ev.arguments)
        except ParseError as e:
            return {"content": f"ERROR: {e.message}", "error": True}
        return self.registry.execute(self.sandbox, self.config, ev.name, args)
