"""Conversation history and context management.

The event log is the single source of truth; model-visible messages are derived from it.
Strategy (no turn-count windowing, no incremental tool-output folding — compaction is
the only budget guard, matching opencode / Claude Code):
- sticky: system prompt + the original task are never evicted
- compaction: the newest CompactionEvent's summary is the head; only the recent
  tail it designates is projected (token-driven, see Compactor.should_compact)
- truncation: oversized tool output is head/tail trimmed at the tools layer
"""

from __future__ import annotations

from typing import Any

from ..config import Config
from ..events import (
    AssistantMessageEvent,
    CompactionEvent,
    EventLog,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
)
from ..prompts import render
from ..skills import cached_library


def _recent_working_files(tail_events: list[Any], cap: int = 6) -> list[str]:
    """Distinct file paths the model was reading/writing in the preserved tail
    (most recent first), so a post-compaction context can tell it to re-read them."""
    import json as _json

    out: list[str] = []
    seen: set[str] = set()
    for ev in reversed(tail_events):
        if not isinstance(ev, ToolCallEvent) or ev.name not in ("read_file", "write_file", "edit_file"):
            continue
        try:
            args = _json.loads(ev.arguments or "{}")
        except (ValueError, TypeError):
            continue
        path = args.get("path") if isinstance(args, dict) else None
        if isinstance(path, str) and path and path not in seen:
            seen.add(path)
            out.append(path)
            if len(out) >= cap:
                break
    return out


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
    """Derive model messages from the event log, applying compaction head.
    ``memories`` (a MemoryStore) contributes a resident title list to the system
    prompt so the model can recall long-term facts. Tool output is NOT folded
    here — it accumulates until compaction (Compactor.compact) rolls the older
    turns into a summary, so the model's file-content working set is not silently
    starved and re-reads are not forced."""
    full_events = log.events()
    # the original task lives at index 0 (emitted at run start); task.md re-injects
    # it below, so exclude that raw copy here — otherwise every context carries the
    # task twice.
    raw_task = full_events[0] if full_events and isinstance(full_events[0], UserMessageEvent) else None
    events = full_events
    head_msgs: list[dict[str, Any]] = []
    # if the log was compacted, the newest CompactionEvent's summary is the head
    # (it replaces everything before its tail_start), and only the recent tail is
    # projected below.
    compaction = next((e for e in reversed(events) if isinstance(e, CompactionEvent)), None)
    if compaction is not None:
        head_msgs = [{"role": "user", "content": render("compaction_head.md", summary=compaction.summary)}]
        # tail_start is an index into the DURABLE event sequence (what the .clc
        # persists); log.tail_from slices the durable sequence from there and
        # clamps a stale out-of-range index from an older .clc, so the recent
        # tail is kept — never silently dropped. Works for a fully loaded log
        # and a lazily reopened one alike.
        tail_events = log.tail_from(compaction.tail_start, compaction)
        files = _recent_working_files(tail_events)
        if files:
            # the exact contents of these files were compacted away; the model must
            # re-read them before editing (never rewrite from the summary's memory)
            head_msgs.append(
                {"role": "user", "content": render("compaction_files.md", files=", ".join(files))}
            )
        events = tail_events
    if raw_task is not None and events and events[0] is raw_task:
        events = events[1:]

    msgs = _to_messages(events)

    system = render("system.md")
    if config.mode == "chat":
        # read-only mode contract: tell the model what it can/cannot do so it
        # never attempts a write in the first place (schema pruning is the hard
        # boundary, this is the soft guide)
        system += "\n\n" + render("mode_chat.md")
    elif config.mode == "work":
        # work mode contract: symmetric with chat — without this the model only
        # infers its full access from the tool list, so a mode switch was only
        # ever announced in one direction (chat announced, work stayed silent)
        system += "\n\n" + render("mode_work.md")
    if config.enable_skills:
        # model-visible catalog: the model decides whether to load a skill
        catalog = cached_library(config.skills_dir).to_catalog_section()
        if catalog:
            system += "\n\n" + catalog
    if memories is not None:
        items = memories.items()
        if items:
            # all titles up front: the model picks the exact one to load, so no
            # fuzzy matching is needed on load_memory (titles are short)
            titles = [m.title for m in sorted(items.values(), key=lambda m: -m.updated)]
            system += (
                "\n\nProject memories from earlier sessions — search_memory or load_memory "
                "before acting if any relate to this task:\n"
                + "\n".join(f"- {t}" for t in titles)
            )

    return (
        [
            {"role": "system", "content": system},
            {"role": "user", "content": render("task.md", task=task)},
        ]
        + head_msgs
        + msgs
    )
