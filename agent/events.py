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
from typing import Any, Dict, List, Optional


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
class AssistantMessageEvent(Event):
    type: str = "assistant_message"
    content: str = ""
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)  # [{id,name,arguments}]


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


EVENT_TYPES: Dict[str, type] = {
    cls.type: cls
    for cls in [
        UserMessageEvent,
        StepStartEvent,
        TextDeltaEvent,
        AssistantMessageEvent,
        ToolCallEvent,
        ToolResultEvent,
        StateUpdateEvent,
        FinalEvent,
    ]
}


def event_to_json(event: Event) -> str:
    return json.dumps(asdict(event), ensure_ascii=False)


def event_from_dict(data: Dict[str, Any]) -> Event:
    cls = EVENT_TYPES.get(data.get("type"))
    if cls is None:
        raise ValueError(f"unknown event type: {data.get('type')}")
    fields = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
    return cls(**fields)


class EventLog:
    """Append-only event log (memory) + JSONL persistence.

    Context management = log management: model-visible messages are derived from the
    log (see core/context.py). Persistence supports replay/debug/resume; GUI history
    is rebuilt from it too.
    """

    def __init__(self, path: Optional[str] = None) -> None:
        self._events: List[Event] = []
        self._path = path

    def append(self, event: Event) -> Event:
        self._events.append(event)
        if self._path:
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(event_to_json(event) + "\n")
        return event

    def events(self) -> List[Event]:
        return list(self._events)

    def count(self) -> int:
        return len(self._events)

    @classmethod
    def load(cls, path: str) -> "EventLog":
        log = cls(path=path)
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    log._events.append(event_from_dict(json.loads(line)))
        return log
