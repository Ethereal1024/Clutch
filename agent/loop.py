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
import threading
from typing import Any, Callable

from .config import Config
from .core import context
from .core import errors as agent_errors
from .core.parse import ParseError, parse_arguments
from .core.permission import PermissionGate, PermissionRequired
from .core.terminate import Terminator
from .events import (
    AssistantMessageEvent,
    CompactionEvent,
    Event,
    EventLog,
    FinalEvent,
    ReasoningDeltaEvent,
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
from .tools.workspace import Workspace

# Callback for subscribers (GUI/SSE); the engine does not care who listens.
EventSink = Callable[[Event], None]


class Agent:
    def __init__(
        self,
        llm: LlmClient,
        registry: ToolRegistry,
        workspace: Workspace,
        config: Config,
        log: EventLog | None = None,
        sink: EventSink | None = None,
        cancel: threading.Event | None = None,
        gate: PermissionGate | None = None,
        compactor_factory: Callable[[], LlmClient] | None = None,
        memories: Any | None = None,
    ) -> None:
        self.llm = llm
        self.registry = registry
        self.workspace = workspace
        self.config = config
        self.terminator = Terminator(config)
        self.log = log or EventLog()
        self.sink = sink
        self.cancel = cancel
        self.gate = gate
        # summarizer used by compaction; built lazily on first compaction when a
        # dedicated compaction_model is configured, otherwise the main llm is used
        self.compactor_factory = compactor_factory
        self.compactor_llm: LlmClient | None = None
        # project memory store (durable facts in the .clc), if any
        self.memories = memories
        # provider-reported usage of the most recent LLM call (context size probe)
        self._last_usage: dict[str, Any] | None = None

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
        state = "error" if status == "error" else "finished"
        self._emit(StateUpdateEvent(value=state))
        return "ABORTED" if status != "completed" else summary

    def _llm_call(
        self, msgs: list[dict[str, Any]]
    ) -> tuple[str, list[dict[str, Any]], str, str, dict[str, Any] | None]:
        """Stream one LLM turn; emits incremental reasoning/text events.

        Returns (content, tool_calls, finish_reason, reasoning, usage). tool_calls
        entries are [{id, name, arguments(raw json string)}]; usage is the
        provider-reported token usage of this call (None when unavailable).
        """
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_accum: dict[int, dict[str, Any]] = {}
        finish_reason = "stop"

        try:
            for ev in self.llm.stream(msgs, tools=self.registry.schemas()):
                # Stop must abort mid-stream, not after the whole turn: check the
                # cancel flag between chunks and give up the partial generation.
                if self.cancel and self.cancel.is_set():
                    break
                t = ev["type"]
                if t == "reasoning":
                    reasoning_parts.append(ev["delta"])
                    self._emit(ReasoningDeltaEvent(content=ev["delta"]))
                elif t == "text":
                    content_parts.append(ev["delta"])
                    # incremental text: the UI accumulates + re-renders markdown
                    self._emit(TextDeltaEvent(content=ev["delta"]))
                elif t == "tool_call_start":
                    tool_accum.setdefault(ev["index"], {"id": ev["id"], "name": ev["name"], "args": ""})
                elif t == "tool_call_delta":
                    entry = tool_accum.setdefault(ev["index"], {"id": "", "name": "", "args": ""})
                    entry["args"] += ev["delta"]
                elif t == "finish":
                    finish_reason = ev["reason"]
                    content = "".join(content_parts)
                    tool_calls = [
                        {"id": e["id"], "name": e["name"], "arguments": e["args"]} for e in tool_accum.values()
                    ]
                    return content, tool_calls, finish_reason, "".join(reasoning_parts), ev.get("usage")
        except LlmError as e:
            if e.code == "context_window_exceeded":
                raise agent_errors.context_window_error(e.message) from e
            raise agent_errors.AgentError(code=e.code, message=e.message) from e
        # any non-LlmError here is a genuine bug (openai SDK errors are all
        # normalized by _classify); let it propagate as a traceback instead of
        # masking it as llm_unknown

        return "".join(content_parts), [], finish_reason, "".join(reasoning_parts), None

    def run(self, task: str) -> str:
        self._emit(StateUpdateEvent(value="running"))
        self._emit(UserMessageEvent(content=task))

        turn = 0
        try:
            while True:
                if self.cancel and self.cancel.is_set():
                    return self._finish("aborted", render("cancelled.md"))
                turn += 1
                # optional safety net; off by default (max_turns=0 means no limit)
                if self.terminator.check_turn_budget(turn):
                    return self._finish(
                        "aborted",
                        render("budget_exceeded.md", max_turns=self.config.max_turns),
                    )
                # context near the window: roll the older turns into a summary and
                # continue with a fresh (compacted) context instead of dropping or
                # aborting. Uses the previous turn's usage, so the first turn never
                # triggers it.
                if self._should_compact():
                    self._compact()
                    self._last_usage = None  # don't re-trigger on the stale usage
                    continue
                self._emit(StepStartEvent())
                msgs = context.derive_messages(self.log, self.config, task, memories=self.memories)

                content, tool_calls, finish_reason, reasoning, usage = self._llm_call(msgs)
                self._last_usage = usage
                # Stop during streaming left a partial (empty) turn; never treat it
                # as a done candidate or run the verify gate on it.
                if self.cancel and self.cancel.is_set():
                    return self._finish("aborted", render("cancelled.md"))

                # max-tokens truncation: drop incomplete tool calls, ask to be concise
                if finish_reason == "length":
                    self._emit(UserMessageEvent(content=render("max_tokens.md")))
                    continue

                # ---- tool calls: execute and feed results back ----
                if tool_calls:
                    tc_events: list[ToolCallEvent] = []
                    for tc in tool_calls:
                        tc_events.append(
                            ToolCallEvent(
                                name=tc["name"],
                                arguments=tc["arguments"],
                                tool_call_id=tc["id"],
                            )
                        )

                    # record the assistant turn (text + tool_calls) BEFORE the tool
                    # call events, so a stored session replays as text → tools →
                    # results (opencode's message/part ordering)
                    self._emit(
                        AssistantMessageEvent(
                            content=content,
                            tool_calls=[
                                {
                                    "id": ev.tool_call_id,
                                    "name": ev.name,
                                    "arguments": ev.arguments,
                                }
                                for ev in tc_events
                            ],
                            reasoning=reasoning,
                        )
                    )
                    for ev in tc_events:
                        self._emit(ev)

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
                                diff=result.get("diff", ""),
                            )
                        )
                    continue

                # ---- no tool call: candidate done -> verification gate ----
                self._emit(AssistantMessageEvent(content=content, reasoning=reasoning))
                v = self.terminator.verify(self.workspace)
                if v.done:
                    return self._finish("completed", content)

                # gate failed: feed verification output back and keep iterating
                self._emit(UserMessageEvent(content=render("verify_failed.md", output=v.verify_output)))
        except agent_errors.AgentError as e:
            # fatal LLM/context failures terminate gracefully instead of dying
            # silently in the worker thread
            return self._finish("error", str(e))

    def _should_compact(self) -> bool:
        """True when the last LLM call pushed the context near the model window."""
        if not self.config.compaction_enabled or not self._last_usage:
            return False
        used = self._last_usage.get("total_tokens")
        if not used:
            return False
        return used >= self.config.llm_context_window - self.config.compaction_reserved

    def _compact(self) -> None:
        """Roll the older conversation into a summary (opencode-style). Best-effort:
        any failure falls back to the existing windowing and the run continues."""
        try:
            events = self.log.events()
            tail_start = self._tail_start_index(events)
            if tail_start <= 1:
                return  # nothing meaningful to compact
            head = events[:tail_start]
            summary = self._summarize(self._serialize(head), self._previous_summary(events))
            if not summary:
                return
            self.log.append(CompactionEvent(summary=summary, tail_start=tail_start))
        except Exception as e:  # noqa: BLE001 -- compaction must never kill the run
            print(f"[clutch] compaction failed: {e}", file=sys.stderr)

    def _tail_start_index(self, events: list[Any]) -> int:
        """Index where the preserved recent tail begins, sized to the tail budget
        (~4 chars per token). Clutch turns share the task user message, so the tail
        is split at an assistant-turn boundary; everything before it is summarized
        away."""
        budget = self.config.compaction_tail_tokens
        if budget is None:
            usable = self.config.llm_context_window - self.config.compaction_reserved
            budget = min(15_000, max(2_000, usable // 4))
        total = 0
        tail_start = 0
        for i in range(len(events) - 1, -1, -1):
            ev = events[i]
            size = len(ev.content) if isinstance(ev, (UserMessageEvent, ToolResultEvent)) else 0
            if isinstance(ev, AssistantMessageEvent):
                size = len(ev.content) + len(ev.reasoning)
            total += size // 4
            if total >= budget:
                j = i
                while j > 0 and not isinstance(events[j], AssistantMessageEvent):
                    j -= 1
                tail_start = j
                break
        return tail_start

    def _previous_summary(self, events: list[Any]) -> str:
        comp = next((e for e in reversed(events) if isinstance(e, CompactionEvent)), None)
        return comp.summary if comp else ""

    def _serialize(self, events: list[Any]) -> str:
        """Compact transcript of the old portion, for the summary prompt."""
        lines = []
        for ev in events:
            if isinstance(ev, UserMessageEvent):
                lines.append(f"[User]: {ev.content}")
            elif isinstance(ev, AssistantMessageEvent):
                if ev.content:
                    lines.append(f"[Assistant]: {ev.content}")
                if ev.reasoning:
                    lines.append(f"[Assistant reasoning]: {ev.reasoning}")
                for tc in ev.tool_calls:
                    lines.append(f"[Assistant tool call]: {tc['name']}({tc['arguments']})")
            elif isinstance(ev, ToolResultEvent):
                out = ev.content
                if len(out) > 500:
                    out = out[:500] + "\n[truncated]"
                lines.append(f"[Tool result]: {out}")
        text = "\n".join(lines)
        cap = max(8_000, (self.config.llm_context_window - self.config.compaction_reserved) // 3)
        return text[-cap:] if len(text) > cap else text

    def _summarize(self, history: str, previous: str) -> str:
        llm = self.compactor_llm
        if llm is None and self.compactor_factory is not None:
            llm = self.compactor_factory()
            self.compactor_llm = llm
        if llm is None:
            llm = self.llm
        prompt = render("compaction.md", history=history, previous_summary=previous or "(none)")
        parts: list[str] = []
        for ev in llm.stream([{"role": "user", "content": prompt}], tools=None):
            if ev["type"] == "text":
                parts.append(ev["delta"])
            elif ev["type"] == "finish":
                break
        return "".join(parts).strip()

    def _execute_tool(self, ev: ToolCallEvent) -> dict[str, Any]:
        """Parse arguments, check permission, then run the tool.

        A denied or user-rejected action feeds an error back to the model
        (error-as-data), so it can change its approach instead of crashing.
        """
        try:
            args = parse_arguments(ev.arguments)
        except ParseError as e:
            return {"content": f"ERROR: {e.message}", "error": True}
        args_repr = ev.arguments
        if self.gate is not None:
            try:
                self.gate.require(ev.name, args_repr, self.workspace)
            except PermissionRequired as e:
                return {"content": f"ERROR: {e.reason}", "error": True}
        return self.registry.execute(self.workspace, self.config, ev.name, args)
