"""Conversation history and context management.

The event log is the single source of truth; model-visible messages are derived from it.
Strategy (no turn-count windowing, no incremental tool-output folding — compaction is
the only budget guard, matching opencode / Claude Code):
- window: only the events since the newest compaction line ([cpr_start, file_end))
  are projected; everything before it is rolled into the summary head
- compaction: the newest CompactionEvent's summary is the head (byte-driven, see
  Compactor.should_compact)
- truncation: oversized tool output is head/tail trimmed at the tools layer
"""

from __future__ import annotations

from typing import Any

from ..config import Config
from ..events import (
    AssistantMessageEvent,
    CompactionEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
)
from ..prompts import render
from ..skills import cached_library
from .lazy import LazyEventLog


def _recent_working_files(tail_events: list[Any], cap: int = 6) -> list[str]:
    """Distinct file paths the model was reading/writing in the window
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
                # some APIs require reasoning content to be passed back
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

    Drop assistant tool_calls without their tool results, plus orphan tool
    messages. Healthy logs are untouched.
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
                # interrupted block: drop tool_calls; only real text can stand alone
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


def derive_messages(log: LazyEventLog, config: Config, task: str, memories: Any | None = None) -> list[dict[str, Any]]:
    """Derive model messages from the event log, applying the compaction head.

    memories contributes a resident title list to the system prompt. Tool
    output is not folded here; it accumulates until compaction.
    """
    full_events = log.events()
    # a never-compacted file has the raw task at index 0; skip it (task.md
    # re-injects the current task). A compacted file starts at the summary line.
    raw_task = full_events[0] if full_events and isinstance(full_events[0], UserMessageEvent) else None
    events = full_events
    head_msgs: list[dict[str, Any]] = []
    # newest CompactionEvent summary is the head; only events after it are the window
    compaction = next((e for e in reversed(events) if isinstance(e, CompactionEvent)), None)
    if compaction is not None:
        head_msgs = [{"role": "user", "content": render("compaction_head.md", summary=compaction.summary)}]
        # slice to the last summary: summarized history never re-enters the context
        last_idx = len(events) - 1 - next(
            i for i, e in enumerate(reversed(events)) if isinstance(e, CompactionEvent)
        )
        tail_events = events[last_idx + 1:]
        files = _recent_working_files(tail_events)
        if files:
            # compacted-away files: the model must re-read them before editing
            head_msgs.append(
                {"role": "user", "content": render("compaction_files.md", files=", ".join(files))}
            )
        events = tail_events
    if raw_task is not None and events and events[0] is raw_task:
        events = events[1:]

    msgs = _to_messages(events)

    system = render("system.md")
    if config.mode == "chat":
        # read-only contract: tell the model before it attempts a write
        system += "\n\n" + render("mode_chat.md")
    elif config.mode == "work":
        # work contract: announce full access (mirror of chat mode)
        system += "\n\n" + render("mode_work.md")
    if config.enable_skills:
        # model-visible catalog: the model decides whether to load a skill
        catalog = cached_library(config.skills_dir).to_catalog_section()
        if catalog:
            system += "\n\n" + catalog
    if memories is not None:
        items = memories.items()
        if items:
            # complete title list up front; search stays as content-recall fallback
            titles = [m.title for m in sorted(items.values(), key=lambda m: -m.updated)]
            system += (
                "\n\nProject memories from earlier sessions (complete set, newest first) — "
                "load_memory with the exact title for its content; only search_memory "
                "when no listed title matches:\n"
                + "\n".join(f"- {t}" for t in titles)
            )
        else:
            # empty store stated explicitly, so the model skips probing
            system += "\n\nProject memories from earlier sessions: none stored yet."

    return (
        [
            {"role": "system", "content": system},
            {"role": "user", "content": render("task.md", task=task)},
        ]
        + head_msgs
        + msgs
    )
