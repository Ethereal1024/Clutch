"""Discriminated-union event protocol.

Events are the single source of truth: session log, GUI rendering and context
derivation all come from the event stream. Borrows the LLMEvent idea from opencode
and the kind/id/timestamp discriminated-union pattern from OpenHands.
"""

from __future__ import annotations

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
            append_jsonl(self._path, event_to_json(event), self._writer)
        return event

    def events(self) -> list[Event]:
        return list(self._events)

    # ------------------------------------------------------------------
    # Durable-index operations (shared with the lazy log — see core/lazy.py).
    # "Durable positions" index the DURABLE event sequence, which is exactly
    # what the .clc persists, so a lazily reopened (durable-only) log resolves
    # the same indices as the live one.
    # ------------------------------------------------------------------

    def _durable(self) -> list[Event]:
        return [e for e in self._events if e.type in DURABLE_TYPES]

    def tail_from(self, ts: int, compaction: CompactionEvent) -> list[Event]:
        """Durable events at durable positions >= ts — the preserved recent
        tail the model consumes, minus compaction events. A stale out-of-range
        ts (an older .clc computed against a log that included transients) is
        clamped to the compaction's own durable position."""
        durable = self._durable()
        if ts > len(durable):
            ts = next((i for i, e in enumerate(durable) if e is compaction), len(durable))
        return [e for e in durable[ts:] if not isinstance(e, CompactionEvent)]

    def tail_start_index(self, budget: int) -> int:
        """Durable index where the preserved recent tail begins, sized to
        ``budget`` tokens (~4 chars each, walking from the end) and split at an
        assistant-turn boundary so the tail never starts mid-turn. For a fully
        loaded log durable positions ARE file seqs."""
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
            # ~3 chars/token, matching estimate_tokens in core/compaction.py (was
            # 4: the tail over-shot its budget by ~30%, inflating the post-compaction
            # footprint and shortening the run before the next compaction)
            total += size // 3
            if total >= budget:
                j = i
                while j > 0 and not isinstance(durable[j], AssistantMessageEvent):
                    j -= 1
                tail_start = j
                break
        return tail_start

    def materialize_range(self, lo: int, hi: int) -> list[tuple[int, Event]]:
        """Ensure durable positions [lo, hi) are materialized; return (position,
        event) pairs in file order. The base log keeps everything resident, so
        this is just a slice."""
        durable = self._durable()
        lo = max(0, lo)
        hi = min(hi, len(durable))
        return [(i, ev) for i, ev in enumerate(durable) if lo <= i < hi]

    @contextlib.contextmanager
    def materialize(self, lo: int, hi: int) -> Iterator[None]:
        """Context: materialize + pin durable positions [lo, hi) against any
        eviction for the block. The base log never evicts, so this is a no-op
        (kept so the compactor works uniformly over both log kinds)."""
        self.materialize_range(lo, hi)
        yield

    def durable_index_of(self, event: Event) -> int:
        """Durable index of a loaded event (identity); the compactor's no-op
        guard compares against it."""
        return self._durable().index(event)
