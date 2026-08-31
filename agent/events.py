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
from typing import Any


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> float:
    return time.time()


def _line_bytes(event: Event) -> int:
    """UTF-8 byte length of the event's JSONL line as append_jsonl writes it
    (``event_to_json(event) + "\\n"``) — the unit the durable byte offsets are
    accumulated in, matching the .clc layout on disk."""
    return len((event_to_json(event) + "\n").encode("utf-8"))


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
class ToolCallDeltaEvent(Event):
    """Streamed tool-call argument chunks (live display only, never persisted).

    Mirrors text_delta: the model's tool-call arguments arrive as a stream of
    deltas while it generates them; the final ToolCallEvent carries the complete
    arguments. The UI renders these live so the user watches e.g. a write_file
    content being produced instead of waiting for the finished result."""

    type: str = "tool_call_delta"
    tool_call_id: str = ""
    name: str = ""  # set on the first (start) delta only
    delta: str = ""


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
    Everything before it is summarized into ``summary`` and omitted from the
    derived context (derive_messages injects the summary as the head).

    The context window is ``[cpr_start, file_end)``: cpr_start is persisted in
    the .clc HEADER (the start of the newest compaction line), so the window
    boundary is a header read, not a scan. The event line itself carries only
    the summary — no boundary fields."""

    type: str = "compaction"
    summary: str = ""


@dataclass
class CompactionDeltaEvent(Event):
    """Live progress of an in-flight compaction summary (transient, not durable):
    how many characters of the new summary have streamed in so far, and a final
    done=True when the compaction aborts/fails so the UI never hangs on the
    live progress block."""

    type: str = "compaction_delta"
    chars: int = 0
    done: bool = False


EVENT_TYPES: dict[str, type] = {
    cls.type: cls
    for cls in [
        UserMessageEvent,
        StepStartEvent,
        TextDeltaEvent,
        ReasoningDeltaEvent,
        AssistantMessageEvent,
        ToolCallEvent,
        ToolCallDeltaEvent,
        ToolResultEvent,
        StateUpdateEvent,
        FinalEvent,
        PermissionRequestEvent,
        CompactionEvent,
        CompactionDeltaEvent,
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
