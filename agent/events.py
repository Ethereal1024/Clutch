"""Discriminated-union event protocol.

Events are the single source of truth: session log, GUI rendering and context
derivation all come from the event stream. Borrows the LLMEvent idea from opencode
and the kind/id/timestamp discriminated-union pattern from OpenHands.
"""

from __future__ import annotations

import bisect
import contextlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterator

from .core.persist import append_jsonl


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
    tail_start is the event-log index where the preserved recent tail begins;
    everything before it is summarized into ``summary`` and omitted from the
    derived context (derive_messages injects the summary as the head)."""

    type: str = "compaction"
    summary: str = ""
    tail_start: int = 0


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


class EventLog:
    """Append-only event log (memory) + JSONL persistence.

    Context management = log management: model-visible messages are derived from the
    log (see core/context.py). Persistence supports replay/debug/resume; GUI history
    is rebuilt from it too.

    Memory keeps every event (so context derivation and tests are unchanged); only
    DURABLE_TYPES are written to the .clc file.

    Byte-offset contract (shared with the lazy log — see core/lazy.py): every
    durable event is tracked with its BYTE OFFSET relative to the event region
    (the first durable line, i.e. the raw task). The compaction boundary
    ``tail_start`` is such a relative byte offset, so both a fully loaded log and
    a lazily reopened one resolve the same boundary against the same .clc.
    """

    def __init__(self, path: str | None = None, writer: Callable[[str, str], None] | None = None) -> None:
        """writer(path, line) persists one durable line instead of the local file
        append — the SSH degradation layer routes .clc appends through the exec
        bridge. Default None keeps the local open(path, "a") behavior."""
        self._events: list[Event] = []
        self._path = path
        self._writer = writer
        # parallel to _durable(): each durable event's byte offset relative to the
        # event region (accumulated from serialized line lengths, matching the
        # .clc layout that append_jsonl writes)
        self._offsets: list[int] = []
        self._running: int = 0

    def append(self, event: Event) -> Event:
        self._events.append(event)
        if event.type in DURABLE_TYPES:
            self._offsets.append(self._running)
            self._running += _line_bytes(event)
            if self._path:
                append_jsonl(self._path, event_to_json(event), self._writer)
        return event

    def events(self) -> list[Event]:
        return list(self._events)

    # ------------------------------------------------------------------
    # Durable byte-offset operations (shared with the lazy log — see core/lazy.py).
    # "Durable offsets" are each durable event's byte position relative to the
    # event region; a lazily reopened (durable-only) log resolves the same
    # offsets against the same file, so the compaction boundary ``tail_start``
    # (a byte offset) stays consistent across persistence.
    # ------------------------------------------------------------------

    def _durable(self) -> list[Event]:
        return [e for e in self._events if e.type in DURABLE_TYPES]

    def tail_from(self, ts: int, compaction: CompactionEvent) -> list[Event]:
        """Durable events at byte offsets >= ts — the preserved recent tail the
        model consumes, minus compaction events. A stale out-of-range ts is
        clamped to the compaction's own offset."""
        durable = self._durable()
        if ts > (self._offsets[-1] if self._offsets else 0):
            ts = next((self._offsets[i] for i, e in enumerate(durable) if e is compaction), 0)
        i = bisect.bisect_left(self._offsets, ts)
        return [e for e in durable[i:] if not isinstance(e, CompactionEvent)]

    def tail_start_index(self, budget: int) -> int:
        """Byte offset (relative to the event region) where the preserved recent
        tail begins, sized to ``budget`` tokens (~3 chars each, walking from the
        end) and split at an assistant-turn boundary so the tail never starts
        mid-turn. Walking from the end over the full durable sequence: the tail
        is exactly what survives, so the boundary is precise (matches the lazy
        log, which sizes from its materialized tail — the same events)."""
        durable = self._durable()
        total = 0
        tail_start = 0
        for i in range(len(durable) - 1, -1, -1):
            ev = durable[i]
            if isinstance(ev, (UserMessageEvent, ToolResultEvent)):
                size = len(ev.content)
            elif isinstance(ev, AssistantMessageEvent):
                size = len(ev.content) + len(ev.reasoning)
            else:
                continue
            total += size // 3
            if total >= budget:
                j = i
                while j > 0 and not isinstance(durable[j], AssistantMessageEvent):
                    j -= 1
                tail_start = self._offsets[j]
                break
        return tail_start

    def events_before(self, byte_offset: int) -> list[Event]:
        """Durable events whose byte offset < ``byte_offset`` (the compaction
        head: everything before the preserved tail boundary)."""
        return [e for e, off in zip(self._durable(), self._offsets) if off < byte_offset]

    def compact_min_tail(self) -> int:
        """Smallest tail_start that leaves a compactible head — the task plus at
        least one more event (the second durable event's line start). A boundary
        at or before it means there is nothing to summarize."""
        return self._offsets[1] if len(self._offsets) > 1 else self._running

    def materialize_range(self, lo: int, hi: int) -> list[tuple[int, Event]]:
        """Durable events with byte offsets in [lo, hi); return (offset, event)
        pairs in file order. The base log keeps everything resident, so this is
        just a slice."""
        durable = self._durable()
        return [(off, ev) for off, ev in zip(self._offsets, durable) if lo <= off < hi]

    @contextlib.contextmanager
    def materialize(self, lo: int, hi: int) -> Iterator[None]:
        """Context: materialize + pin byte offsets [lo, hi) against any eviction
        for the block. The base log never evicts, so this is a no-op (kept so
        the compactor works uniformly over both log kinds)."""
        self.materialize_range(lo, hi)
        yield
