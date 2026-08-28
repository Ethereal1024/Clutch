"""Conversation history and context management.

The event log is the single source of truth; model-visible messages are derived from it.
Strategy:
- sticky: system prompt + the original task are never evicted
- windowing: keep the last N turns; older tool results fold into one omitted line
- char budget: if kept tool output exceeds a soft budget, fold the oldest results
- truncation: oversized tool output is head/tail trimmed at the tools layer
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Dict, List

from ..config import Config
from ..events import AssistantMessageEvent, EventLog, ToolResultEvent, UserMessageEvent
from ..prompts import render
from ..skills import cached_library


def _to_messages(events: List[Any]) -> List[Dict[str, Any]]:
    """Project events to OpenAI messages; assistant and tool results must stay paired."""
    msgs: List[Dict[str, Any]] = []
    for ev in events:
        if isinstance(ev, UserMessageEvent):
            msgs.append({"role": "user", "content": ev.content})
        elif isinstance(ev, AssistantMessageEvent):
            msg: Dict[str, Any] = {"role": "assistant"}
            if ev.content:
                msg["content"] = ev.content
            if ev.reasoning:
                # DeepSeek requires thinking content to be passed back to the API
                msg["reasoning_content"] = ev.reasoning
            if ev.tool_calls:
                msg["tool_calls"] = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in ev.tool_calls
                ]
            msgs.append(msg)
        elif isinstance(ev, ToolResultEvent):
            msgs.append({"role": "tool", "tool_call_id": ev.tool_call_id, "content": ev.content})
    return msgs


def derive_messages(log: EventLog, config: Config, task: str) -> List[Dict[str, Any]]:
    """Derive model messages from the event log, applying windowing + char budget."""
    events = log.events()
    assistant_idx = [i for i, e in enumerate(events) if isinstance(e, AssistantMessageEvent)]

    if len(assistant_idx) > config.max_history_turns:
        cutoff = assistant_idx[-config.max_history_turns]
        kept = events[cutoff:]
        dropped = cutoff  # windowing evicts every event before the cutoff, not just tool results
        msgs = [
            {"role": "user", "content": render("context_omitted.md", count=dropped)}
        ] + _to_messages(kept)
    else:
        kept = events
        msgs = _to_messages(events)

    # char budget: fold the oldest tool results until the kept output fits.
    # fold on copies so the source-of-truth event log is never mutated.
    tool_results = [i for i, e in enumerate(kept) if isinstance(e, ToolResultEvent)]
    if tool_results:
        total = sum(len(e.content) for e in kept if isinstance(e, ToolResultEvent))
        if total > config.context_char_budget:
            folded_idx: set[int] = set()
            for i in tool_results:
                if total <= config.context_char_budget:
                    break
                total -= len(kept[i].content)
                folded_idx.add(i)
            kept = [
                replace(e, content="(output omitted by char budget)") if i in folded_idx else e
                for i, e in enumerate(kept)
            ]
            msgs = [
                {"role": "user", "content": render("context_omitted.md", count=len(folded_idx))}
            ] + _to_messages(kept)

    system = render("system.md")
    if config.enable_skills:
        # model-visible catalog: the model decides whether to load a skill
        catalog = cached_library(config.skills_dir).to_catalog_section()
        if catalog:
            system += "\n\n" + catalog

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": render("task.md", task=task)},
    ] + msgs
