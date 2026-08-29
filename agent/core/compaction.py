"""Context-window compaction: roll the older conversation into a summary.

Compaction is pure context management — token estimation, tail budgeting,
serialization, the summary call — so it lives here (next to core/context.py,
which owns message derivation from the log) instead of inside the run loop.
The loop only asks `should_compact` / `compact`; everything about how much to
preserve, what to summarize and with which LLM is this class's business.
"""

from __future__ import annotations

import sys
from typing import Any, Callable

from ..config import Config
from ..events import (
    DURABLE_TYPES,
    AssistantMessageEvent,
    CompactionDeltaEvent,
    CompactionEvent,
    EventLog,
    ToolResultEvent,
    UserMessageEvent,
)
from ..llm.client import LlmClient
from ..prompts import render


class Compactor:
    """Roll the older conversation into a summary (opencode-style). Best-effort:
    compact() returns False when nothing was compacted (too little to summarize,
    no NEW head since the last compaction, or the summary call failed) so the
    loop never spins on a failed or no-op compaction.

    tail_start is an index into the DURABLE event sequence (what the .clc
    persists). The in-memory log also holds transient streaming deltas; an
    index over those would be stale after a reopen, silently dropping the
    whole recent tail (see derive_messages)."""

    def __init__(
        self,
        config: Config,
        log: EventLog,
        llm: LlmClient,
        llm_factory: Callable[[], LlmClient] | None = None,
        sink: Callable[[object], None] | None = None,
    ) -> None:
        self.config = config
        self.log = log
        self.llm = llm
        # summarizer used by compaction; built lazily on first compaction when a
        # dedicated compaction_model is configured, otherwise the main llm is used
        self.llm_factory = llm_factory
        self.compactor_llm: LlmClient | None = None
        # provider-reported usage of the most recent LLM call (context size probe)
        self.last_usage: dict[str, Any] | None = None
        # live-progress sink (the run's event broadcaster): compaction can take a
        # while, so the UI gets compaction_delta events instead of looking frozen
        self.sink = sink

    def _report_progress(self, chars: int, done: bool = False) -> None:
        """Broadcast in-flight compaction progress; never fatal."""
        if not self.sink:
            return
        try:
            self.sink(CompactionDeltaEvent(chars=chars, done=done))
        except Exception:  # noqa: BLE001 -- subscriber failure is non-fatal
            pass

    def record_usage(self, usage: dict[str, Any] | None) -> None:
        """Provider-reported usage of the most recent LLM call (context probe)."""
        self.last_usage = usage

    def should_compact(self, msgs: list[dict[str, Any]]) -> bool:
        """True when the next LLM call would push the context near the model window.

        Either trigger fires: the previous call's provider-reported usage crossing
        the threshold (authoritative), or a char-based token estimate of the derived
        context ``msgs`` doing so (covers resumed sessions, missing usage, and the
        one-turn race — the last call's usage never includes the turn just added)."""
        if not self.config.compaction_enabled:
            return False
        threshold = self.config.llm_context_window - self.config.compaction_reserved
        if self.last_usage:
            used = self.last_usage.get("total_tokens")
            if used and used >= threshold:
                return True
        return self.estimate_tokens(msgs) >= threshold

    @staticmethod
    def estimate_tokens(msgs: list[dict[str, Any]]) -> int:
        """Cheap token estimate of the derived context. Uses ~3 chars/token (real
        English/code ratio is ~3-4): deliberately conservative so compaction fires
        before the window fills. Contrast the tail budget in tail_start_index,
        which is generous (4 chars/token) to keep as much recent work as possible."""
        chars = 0
        for m in msgs:
            chars += len(m.get("content") or "")
            chars += len(m.get("reasoning_content") or "")
            for tc in m.get("tool_calls") or []:
                chars += len(tc.get("function", {}).get("arguments", ""))
        return chars // 3

    def compact(self) -> bool:
        """Roll the older durable events into a CompactionEvent; False on no-op.

        Works uniformly over a fully-loaded EventLog and a lazy LazyEventLog: the
        tail boundary comes from the log's durable sequence, and the head being
        summarized is re-materialized under a pin so a lazy log can never drop it
        mid-compaction (its summary input stays byte-identical to a full load).
        """
        try:
            events = self.log.events()
            tail_start = self.log.tail_start_index(self._tail_budget())
            if tail_start <= 1:
                return False  # nothing meaningful to compact
            prev = next((e for e in reversed(events) if isinstance(e, CompactionEvent)), None)
            # compare against the last compaction's durable POSITION, not its stored
            # tail_start — a loaded .clc from before this fix carries a stale index
            if prev is not None and tail_start <= self.log.durable_index_of(prev):
                return False  # nothing new since the last compaction: don't re-summarize the same head
            # the summary call can take a while (a long head, a slow model): tell
            # the UI it started before the first token lands, then stream progress
            self._report_progress(0)
            with self.log.materialize(0, tail_start):
                durable = [e for e in self.log.events() if e.type in DURABLE_TYPES]
                head = durable[:tail_start]
                summary, chars = self._summarize(self._serialize(head), self._previous_summary(events))
            if not summary:
                self._report_progress(chars, done=True)
                return False
            self.log.append(CompactionEvent(summary=summary, tail_start=tail_start))
            return True
        except Exception as e:  # noqa: BLE001 -- compaction must never kill the run
            print(f"[clutch] compaction failed: {e}", file=sys.stderr)
            self._report_progress(0, done=True)
            return False

    def _tail_budget(self) -> int:
        """Tail token budget: configured, else a fraction of the usable window
        (deliberately generous vs the 3 chars/token in estimate_tokens: the tail
        is what survives, so as much of it as possible)."""
        budget = self.config.compaction_tail_tokens
        if budget is None:
            usable = self.config.llm_context_window - self.config.compaction_reserved
            budget = min(15_000, max(2_000, usable // 4))
        return budget

    def tail_start_index(self, events: list[Any]) -> int:
        """Index (into the DURABLE event sequence) where the preserved recent tail
        begins for the tail budget. Delegates to the log's own durable sequence
        (accepted for call-compat; identical to walking ``events`` for a fully
        loaded log). Transient streaming deltas are skipped so the index is stable
        when the log is persisted and reopened. Clutch turns share the task user
        message, so the tail is split at an assistant-turn boundary; everything
        before it is summarized away."""
        return self.log.tail_start_index(self._tail_budget())

    def _previous_summary(self, events: list[Any]) -> str:
        comp = next((e for e in reversed(events) if isinstance(e, CompactionEvent)), None)
        return comp.summary if comp else ""

    def _serialize(self, events: list[Any]) -> str:
        """Compact transcript of the old portion, for the summary prompt."""
        lines = []
        for ev in events:
            if isinstance(ev, UserMessageEvent):
                lines.append(f"[User]: {ev.content}")
            elif isinstance(ev, AssistantMessageEvent):
                if ev.content:
                    lines.append(f"[Assistant]: {ev.content}")
                if ev.reasoning:
                    lines.append(f"[Assistant reasoning]: {ev.reasoning}")
                for tc in ev.tool_calls:
                    lines.append(f"[Assistant tool call]: {tc['name']}({tc['arguments']})")
            elif isinstance(ev, ToolResultEvent):
                out = ev.content
                if len(out) > 500:
                    out = out[:500] + "\n[truncated]"
                lines.append(f"[Tool result]: {out}")
        text = "\n".join(lines)
        cap = max(8_000, (self.config.llm_context_window - self.config.compaction_reserved) // 3)
        return text[-cap:] if len(text) > cap else text

    def _summarize(self, history: str, previous: str) -> tuple[str, int]:
        llm = self.compactor_llm
        if llm is None and self.llm_factory is not None:
            llm = self.llm_factory()
            self.compactor_llm = llm
        if llm is None:
            llm = self.llm
        prompt = render("compaction.md", history=history, previous_summary=previous or "(none)")
        parts: list[str] = []
        chars = 0
        reported = 0
        for ev in llm.stream([{"role": "user", "content": prompt}], tools=None):
            if ev["type"] == "text":
                parts.append(ev["delta"])
                chars += len(ev["delta"])
                # throttle progress broadcasts: ~every 200 chars is plenty for a
                # live counter without flooding the SSE channel
                if chars - reported >= 200:
                    reported = chars
                    self._report_progress(chars)
            elif ev["type"] == "finish":
                break
        return "".join(parts).strip(), chars
