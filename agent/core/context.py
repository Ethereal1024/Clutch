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
from typing import Any

from ..config import Config
from ..events import AssistantMessageEvent, CompactionEvent, EventLog, ToolResultEvent, UserMessageEvent
from ..prompts import render
from ..skills import cached_library


def _to_messages(events: list[Any]) -> list[dict[str, Any]]:
    """Project events to OpenAI messages; assistant and tool results must stay paired."""
    msgs: list[dict[str, Any]] = []
    for ev in events:
        if isinstance(ev, UserMessageEvent):
            msgs.append({"role": "user", "content": ev.content})
        elif isinstance(ev, AssistantMessageEvent):
            msg: dict[str, Any] = {"role": "assistant"}
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
    return _repair_dangling(msgs)


def _repair_dangling(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Enforce the OpenAI pairing contract when the log ends mid-batch.

    A crash / tunnel drop can persist an assistant's tool_calls without every
    tool result (the .clc is appended one durable event at a time). The API
    rejects an assistant message whose tool_calls are not each followed by a
    tool message, so such incomplete blocks are stripped here: the assistant
    loses its tool_calls (kept only if it has real text; a message that had
    nothing but calls/reasoning is dropped entirely) and the partial tool
    messages that belonged to the block are discarded, along with any orphan
    tool message. Every assistant that survives carries content or tool_calls,
    so the derived messages are always acceptable to the API. Healthy logs are
    untouched.
    """
    out: list[dict[str, Any]] = []
    i = 0
    while i < len(msgs):
        m = msgs[i]
        if m["role"] == "assistant" and "tool_calls" in m:
            ids = [tc["id"] for tc in m["tool_calls"]]
            j = i + 1
            responded: set[str] = set()
            while j < len(msgs) and msgs[j]["role"] == "tool":
                responded.add(msgs[j]["tool_call_id"])
                j += 1
            if all(tid in responded for tid in ids):
                out.extend(msgs[i:j])  # complete block: keep as-is
            else:
                # interrupted block: drop tool_calls (and the partial tool msgs).
                # reasoning_content alone cannot stand as an assistant message
                # ("content or tool_calls must be set"), so only real text keeps it.
                cleaned = {k: v for k, v in m.items() if k != "tool_calls"}
                if cleaned.get("content"):
                    out.append(cleaned)
            i = j
        elif m["role"] == "tool":
            i += 1  # orphan tool message (no owning assistant block): drop
        elif m["role"] == "assistant":
            # no tool_calls: only a message with real text can stand alone
            if m.get("content"):
                out.append(m)
            i += 1
        else:
            out.append(m)
            i += 1
    return out


def derive_messages(log: EventLog, config: Config, task: str, memories: Any | None = None) -> list[dict[str, Any]]:
    """Derive model messages from the event log, applying compaction head +
    windowing + char budget. ``memories`` (a MemoryStore) contributes a resident
    title list to the system prompt so the model can recall long-term facts."""
    events = log.events()
    head_msgs: list[dict[str, Any]] = []
    # if the log was compacted, the newest CompactionEvent's summary is the head
    # (it replaces everything before its tail_start), and only the recent tail is
    # projected below.
    compaction = next((e for e in reversed(events) if isinstance(e, CompactionEvent)), None)
    if compaction is not None:
        head_msgs = [{"role": "user", "content": render("compaction_head.md", summary=compaction.summary)}]
        events = [e for e in events[compaction.tail_start :] if not isinstance(e, CompactionEvent)]

    assistant_idx = [i for i, e in enumerate(events) if isinstance(e, AssistantMessageEvent)]

    if len(assistant_idx) > config.max_history_turns:
        cutoff = assistant_idx[-config.max_history_turns]
        kept = events[cutoff:]
        dropped = cutoff  # windowing evicts every event before the cutoff, not just tool results
        msgs = [{"role": "user", "content": render("context_omitted.md", count=dropped)}] + _to_messages(kept)
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
                ev = kept[i]
                if isinstance(ev, ToolResultEvent):
                    total -= len(ev.content)
                    folded_idx.add(i)
            kept = [
                replace(e, content="(output omitted by char budget)")
                if (i in folded_idx and isinstance(e, ToolResultEvent))
                else e
                for i, e in enumerate(kept)
            ]
            msgs = [{"role": "user", "content": render("context_omitted.md", count=len(folded_idx))}] + _to_messages(
                kept
            )

    system = render("system.md")
    if config.enable_skills:
        # model-visible catalog: the model decides whether to load a skill
        catalog = cached_library(config.skills_dir).to_catalog_section()
        if catalog:
            system += "\n\n" + catalog
    if memories is not None:
        items = memories.items()
        if items:
            titles = [m.title for m in sorted(items.values(), key=lambda m: -m.updated)][:20]
            system += "\n\nAvailable project memories (call load_memory to read one):\n" + "\n".join(
                f"- {t}" for t in titles
            )

    return (
        [
            {"role": "system", "content": system},
            {"role": "user", "content": render("task.md", task=task)},
        ]
        + head_msgs
        + msgs
    )
