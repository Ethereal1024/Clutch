"""Discriminated-union event protocol.

Events are the single source of truth: session log, GUI rendering and context
derivation all come from the event stream. Borrows the LLMEvent idea from opencode
and the kind/id/timestamp discriminated-union pattern from OpenHands.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Callable


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> float:
    return time.time()


@dataclass
class Event:
    type: str
    timestamp: float = field(default_factory=_now)
    id: str = field(default_factory=_new_id)


@dataclass
class UserMessageEvent(Event):
    type: str = "user_message"
    content: str = ""


@dataclass
class StepStartEvent(Event):
    type: str = "step_start"


@dataclass
class TextDeltaEvent(Event):
    type: str = "text_delta"
    content: str = ""


@dataclass
class ReasoningDeltaEvent(Event):
    """Streamed thinking tokens (DeepSeek reasoning_content). Displayed as a
    distinct 'thinking' block so the user sees the model working."""

    type: str = "reasoning_delta"
    content: str = ""


@dataclass
class AssistantMessageEvent(Event):
    type: str = "assistant_message"
    content: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)  # [{id,name,arguments}]
    reasoning: str = ""  # thinking content, must be passed back to DeepSeek


@dataclass
class ToolCallEvent(Event):
    type: str = "tool_call"
    name: str = ""
    arguments: str = ""  # raw JSON string
    tool_call_id: str = ""


@dataclass
class ToolResultEvent(Event):
    type: str = "tool_result"
    tool_call_id: str = ""
    content: str = ""  # model-visible content
    is_error: bool = False
    diff: str = ""  # unified diff (UI display only, not model-visible)


@dataclass
class StateUpdateEvent(Event):
    """State machine: idle / running / waiting / finished / error."""

    type: str = "state_update"
    key: str = "execution_status"
    value: str = ""


@dataclass
class FinalEvent(Event):
    type: str = "final"
    status: str = ""  # completed / aborted / error
    summary: str = ""


@dataclass
class PermissionRequestEvent(Event):
    type: str = "permission_request"
    request_id: str = ""
    tool: str = ""
    args_repr: str = ""
    reason: str = ""


@dataclass
class CompactionEvent(Event):
    """Rolling summary produced when the conversation nears the context limit.
    tail_start is the event-log index where the preserved recent tail begins;
    everything before it is summarized into ``summary`` and omitted from the
    derived context (derive_messages injects the summary as the head)."""

    type: str = "compaction"
    summary: str = ""
    tail_start: int = 0


EVENT_TYPES: dict[str, type] = {
    cls.type: cls
    for cls in [
        UserMessageEvent,
        StepStartEvent,
        TextDeltaEvent,
        ReasoningDeltaEvent,
        AssistantMessageEvent,
        ToolCallEvent,
        ToolResultEvent,
        StateUpdateEvent,
        FinalEvent,
        PermissionRequestEvent,
        CompactionEvent,
    ]
}


def event_to_json(event: Event) -> str:
    return json.dumps(asdict(event), ensure_ascii=False)


def event_from_dict(data: dict[str, str]) -> Event:
    cls = EVENT_TYPES.get(data["type"])
    if cls is None:
        raise ValueError(f"unknown event type: {data.get('type')}")
    fields = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
    return cls(**fields)


# Only final/durable events are persisted to .clc (opencode stores parts, not
# streaming deltas): text_delta/reasoning_delta/step_start/state_update are
# display-transient and never written to disk.
DURABLE_TYPES = {"user_message", "assistant_message", "tool_call", "tool_result", "final", "compaction"}


class EventLog:
    """Append-only event log (memory) + JSONL persistence.

    Context management = log management: model-visible messages are derived from the
    log (see core/context.py). Persistence supports replay/debug/resume; GUI history
    is rebuilt from it too.

    Memory keeps every event (so context derivation and tests are unchanged); only
    DURABLE_TYPES are written to the .clc file.
    """

    def __init__(self, path: str | None = None, writer: Callable[[str, str], None] | None = None) -> None:
        """writer(path, line) persists one durable line instead of the local file
        append — the SSH degradation layer routes .clc appends through the exec
        bridge. Default None keeps the local open(path, "a") behavior."""
        self._events: list[Event] = []
        self._path = path
        self._writer = writer

    def append(self, event: Event) -> Event:
        self._events.append(event)
        if self._path and event.type in DURABLE_TYPES:
            if self._writer:
                self._writer(self._path, event_to_json(event))
            else:
                with open(self._path, "a", encoding="utf-8") as f:
                    f.write(event_to_json(event) + "\n")
        return event

    def events(self) -> list[Event]:
        return list(self._events)
