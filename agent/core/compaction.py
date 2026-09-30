"""Context-window compaction: roll the older conversation into a summary.

Compaction is pure context management — window sizing, serialization, the
summary call — so it lives here (next to core/context.py, which owns message
derivation from the log) instead of inside the run loop. The loop only asks
`should_compact` / `compact`; everything about when to fire and what to
summarize is this class's business.

Byte arithmetic throughout: the window and the window-usage comparison are exact
bytes — no token estimation anywhere.

The model window is [cpr_start, file_end): everything since the newest
compaction line. compact() summarizes the WHOLE current window (already
resident in the log — zero disk reads), appends the new CompactionEvent, and
slides cpr_start to that line's start (persisted in the .clc header with one
in-place write). The window collapses to just the new summary, so the
summarized history can never re-enter the context.
"""

from __future__ import annotations

import sys
import threading
from typing import Callable

from ..config import Config
from ..events import (
    AssistantMessageEvent,
    CompactionDeltaEvent,
    CompactionEvent,
    Event,
    ToolResultEvent,
    UserMessageEvent,
)
from ..llm.client import LlmClient
from ..prompts import render
from .lazy import LazyEventLog


class Compactor:
    """Roll the current window into a summary. Best-effort: compact() returns
    False when nothing was compacted (nothing new since the last compaction, or
    the summary call failed) so the loop never spins on a no-op."""

    def __init__(
        self,
        config: Config,
        log: LazyEventLog,
        llm: LlmClient,
        sink: Callable[[object], None] | None = None,
        cancel: threading.Event | None = None,
    ) -> None:
        self.config = config
        self.log = log
        self.llm = llm
        # progress sink: the UI gets compaction_delta events instead of looking frozen
        self.sink = sink
        # stop flag: compaction is synchronous, so it checks cancel itself
        self.cancel = cancel

    def _report_progress(self, chars: int, done: bool = False, note: str = "") -> None:
        """Broadcast in-flight compaction progress; never fatal. A ``note``
        overrides the live paragraph (e.g. the summary stream dropped and is
        being retried) so the UI never shows a frozen block."""
        if not self.sink:
            return
        try:
            self.sink(CompactionDeltaEvent(chars=chars, done=done, note=note))
        except Exception:  # noqa: BLE001 -- subscriber failure is non-fatal
            pass

    def should_compact(self) -> bool:
        """True when the current window fills the model window: pure byte
        comparison, O(1) — no token estimation, no per-event walk."""
        return self.log.window_bytes() >= self.config.llm_context_window_bytes

    def compact(self) -> bool:
        """Roll the whole current window into a CompactionEvent; False on no-op.
        The window is resident, so compaction reads no disk; the new summary
        line becomes the new window start, so history never re-enters context."""
        try:
            if self.cancel and self.cancel.is_set():
                return False  # stop requested: don't start a long summary
            # the window: resident events at/after cpr_start (before it is already-summarized)
            window = [ev for off, ev in self.log.items() if off >= self.log.cpr_start()]
            # nothing new since the last compaction: never re-summarize the same head
            if len(window) <= 1:
                return False
            # long call: announce start before the first token lands
            self._report_progress(0)
            summary, chars = self._summarize(
                self._serialize(window), self._previous_summary()
            )
            if not summary:
                self._report_progress(chars, done=True)
                return False
            self.log.append(CompactionEvent(summary=summary))
            # slide the window to the new summary line's start (header write)
            self.log.set_cpr_start(self.log.items()[-1][0])
            return True
        except Exception as e:  # noqa: BLE001 -- compaction must never kill the run
            # a Stop that landed mid-summary reads as a quiet bail, not a failure
            if self.cancel is not None and self.cancel.is_set():
                self._report_progress(0, done=True)
                return False
            # LlmError's str() is empty; log the .message field
            print(f"[clutch] compaction failed: {getattr(e, 'message', '') or e}", file=sys.stderr)
            self._report_progress(0, done=True)
            return False

    def _previous_summary(self) -> str:
        comp = self.log.last_compaction()
        return comp.summary if comp else ""

    def _serialize(self, events: list[Event]) -> str:
        """Compact transcript of the window: the summarizer's whole input.

        There is no length cap and nothing is elided; what tells the summarizer
        this is someone else's session is the prompt's framing (see
        prompts/compaction.md). The only cut is per event: one tool result is
        trimmed, so a single huge read cannot drown the rest of the window.
        """
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
        return "\n".join(lines)

    def _summarize(self, history: str, previous: str) -> tuple[str, int]:
        prompt = render("compaction.md", history=history, previous_summary=previous or "(none)")
        parts: list[str] = []
        chars = 0
        reported = 0
        for ev in self.llm.stream([{"role": "user", "content": prompt}], tools=None, cancel=self.cancel):
            # stop must interrupt the summary call, not just the main turn
            if self.cancel and self.cancel.is_set():
                return "", chars
            t = ev["type"]
            if t == "retry":
                # transport hiccup: the client is reconnecting with backoff —
                # mirror the notice into the live compaction block instead of
                # letting it sit silently. discard=true means the dead attempt
                # had already streamed part of the summary: no byte of that is
                # part of the summary, so it goes and the counter restarts at 0
                if ev.get("discard"):
                    parts.clear()
                    chars = 0
                    reported = 0
                self._report_progress(chars, note=ev.get("message", ""))
                continue
            if t == "text":
                parts.append(ev["delta"])
                chars += len(ev["delta"])
                # throttle: ~every 200 chars is plenty for a live counter
                if chars - reported >= 200:
                    reported = chars
                    self._report_progress(chars)
            elif t == "finish":
                break
        return "".join(parts).strip(), chars
