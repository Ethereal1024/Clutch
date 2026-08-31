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
from .core.compaction import Compactor
from .core.lazy import LazyEventLog
from .core.parse import ParseError, parse_arguments
from .core.permission import PermissionGate, PermissionRequired
from .core.terminate import Terminator
from .events import (
    AssistantMessageEvent,
    Event,
    FinalEvent,
    ReasoningDeltaEvent,
    StateUpdateEvent,
    StepStartEvent,
    TextDeltaEvent,
    ToolCallDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
)
from .llm.client import LlmClient, LlmError
from .prompts import render
from .tools.registry import ToolRegistry
from .tools.workspace import Workspace

# Callback for subscribers (GUI/SSE).
EventSink = Callable[[Event], None]


class Agent:
    def __init__(
        self,
        llm: LlmClient,
        registry: ToolRegistry,
        workspace: Workspace,
        config: Config,
        log: LazyEventLog | None = None,
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
        self.log = log or LazyEventLog.in_memory()
        self.sink = sink
        self.cancel = cancel
        self.gate = gate
        # compaction lives in the Compactor (dedicated model built lazily)
        self.compactor = Compactor(
            config, self.log, llm, llm_factory=compactor_factory, sink=self.sink, cancel=self.cancel
        )
        # durable project-memory store, if any
        self.memories = memories

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
    ) -> tuple[str, list[dict[str, Any]], str, str]:
        """Stream one LLM turn; emits incremental reasoning/text events.

        Returns (content, tool_calls, finish_reason, reasoning). tool_calls
        entries are [{id, name, arguments(raw json string)}].
        """
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_accum: dict[int, dict[str, Any]] = {}
        finish_reason = "stop"

        try:
            for ev in self.llm.stream(msgs, tools=self.registry.schemas()):
                # abort mid-stream: check the cancel flag between chunks
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
                    # live tool-call row: name arrives first, args stream after
                    self._emit(ToolCallDeltaEvent(tool_call_id=ev["id"], name=ev["name"], delta=""))
                elif t == "tool_call_delta":
                    entry = tool_accum.setdefault(ev["index"], {"id": "", "name": "", "args": ""})
                    entry["args"] += ev["delta"]
                    # stream args so the UI shows the call as it is generated
                    self._emit(ToolCallDeltaEvent(tool_call_id=entry["id"], name="", delta=ev["delta"]))
                elif t == "finish":
                    finish_reason = ev["reason"]
                    content = "".join(content_parts)
                    tool_calls = [
                        {"id": e["id"], "name": e["name"], "arguments": e["args"]} for e in tool_accum.values()
                    ]
                    return content, tool_calls, finish_reason, "".join(reasoning_parts)
        except LlmError as e:
            if e.code == "context_window_exceeded":
                raise agent_errors.context_window_error(e.message) from e
            raise agent_errors.AgentError(code=e.code, message=e.message) from e
        # any non-LlmError here is a genuine bug; let it propagate
        return "".join(content_parts), [], finish_reason, "".join(reasoning_parts)

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
                # derive once per turn; compaction check and LLM call share it
                msgs = context.derive_messages(self.log, self.config, task, memories=self.memories)
                # near the window: compact and continue instead of dropping/aborting
                if self.compactor.should_compact():
                    if self.compactor.compact():
                        continue  # log changed; the next iteration re-derives
                    # failed compaction: the derived messages are still valid
                self._emit(StepStartEvent())

                try:
                    content, tool_calls, finish_reason, reasoning = self._llm_call(msgs)
                except agent_errors.AgentError as e:
                    if e.code == "context_window_exceeded":
                        # last resort: force a compaction and retry once
                        if self.compactor.compact():
                            continue
                    raise
                # partial turn left by Stop: not a done candidate, skip the verify gate
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

                    # record the assistant turn BEFORE the tool-call events, so a
                    # stored session replays as text → tools → results
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
                if not content.strip():
                    # empty reply is NOT a completion: feed it back as an error
                    self._emit(UserMessageEvent(content=render("empty_response.md")))
                    continue
                v = self.terminator.verify(self.workspace)
                if v.done:
                    return self._finish("completed", content)

                # gate failed: feed verification output back and keep iterating
                self._emit(UserMessageEvent(content=render("verify_failed.md", output=v.verify_output)))
        except agent_errors.AgentError as e:
            # fatal LLM/context failures terminate gracefully
            return self._finish("error", str(e))

    def _execute_tool(self, ev: ToolCallEvent) -> dict[str, Any]:
        """Parse args, check permission, then run the tool; denials feed an error back."""
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
        try:
            return self.registry.execute(self.workspace, self.config, ev.name, args)
        finally:
            # a user-approved escape is scoped to the one call it was granted for
            self.workspace.clear_allowed()
