"""Context-window compaction: roll the older conversation into a summary.

Compaction is pure context management — byte budgeting, serialization, the
summary call — so it lives here (next to core/context.py, which owns message
derivation from the log) instead of inside the run loop. The loop only asks
`should_compact` / `compact`; everything about when to fire and what to
summarize is this class's business.

Every budget is BYTES: the window and the window-usage comparison are exact
byte arithmetic — no token estimation anywhere.

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
        llm_factory: Callable[[], LlmClient] | None = None,
        sink: Callable[[object], None] | None = None,
        cancel: threading.Event | None = None,
    ) -> None:
        self.config = config
        self.log = log
        self.llm = llm
        # summarizer used by compaction; built lazily on first compaction when a
        # dedicated compaction_model is configured, otherwise the main llm is used
        self.llm_factory = llm_factory
        self.compactor_llm: LlmClient | None = None
        # live-progress sink (the run's event broadcaster): compaction can take a
        # while, so the UI gets compaction_delta events instead of looking frozen
        self.sink = sink
        # run-cancel flag: compaction is synchronous, so it must check the stop
        # signal itself or the UI's stop button freezes during a long summary
        self.cancel = cancel

    def _report_progress(self, chars: int, done: bool = False) -> None:
        """Broadcast in-flight compaction progress; never fatal."""
        if not self.sink:
            return
        try:
            self.sink(CompactionDeltaEvent(chars=chars, done=done))
        except Exception:  # noqa: BLE001 -- subscriber failure is non-fatal
            pass

    def should_compact(self) -> bool:
        """True when the current window (everything since the newest compaction
        line) fills the model window.

        Pure byte comparison, O(1): the window's exact on-disk bytes — no token
        estimation, no per-event walk. The window itself is a conservative byte
        estimate (≈128K tokens × 1.5 中文/token × 3 字节/汉字 ≈ 500K), so
        firing at the full window still leaves real headroom for the completion
        output."""
        if not self.config.compaction_enabled:
            return False
        return self.log.window_bytes() >= self.config.llm_context_window_bytes

    def compact(self) -> bool:
        """Roll the whole current window into a CompactionEvent; False on no-op.

        Works uniformly over any LazyEventLog (in-memory included): the window
        is already resident, so compaction reads NO disk. Input = the window's
        durable events verbatim (the task included on the FIRST compaction,
        when cpr_start is 0 and the task is still inside the window). After the
        summary the new CompactionEvent is appended and cpr_start slides to its
        line's start — the window is now just the new summary, so the
        summarized history can never re-enter the context."""
        try:
            if self.cancel and self.cancel.is_set():
                return False  # stop requested: don't start a long summary
            # the input is the WINDOW — the resident events at/after cpr_start
            # (the task joins on the FIRST compaction, when cpr_start is 0);
            # resident events before cpr_start are already-summarized history
            # and never enter a summary again
            window = [ev for off, ev in self.log.items() if off >= self.log.cpr_start()]
            # nothing new since the last compaction (the window holds only the
            # summary line itself, or is empty): never re-summarize the same head
            if len(window) <= 1:
                return False
            # the summary call can take a while (a long window, a slow model):
            # tell the UI it started before the first token lands, then stream
            # progress
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
            # LlmError is a dataclass whose str() is empty (Exception args never
            # set); log the .message field so failures are diagnosable
            print(f"[clutch] compaction failed: {getattr(e, 'message', '') or e}", file=sys.stderr)
            self._report_progress(0, done=True)
            return False

    def _previous_summary(self) -> str:
        comp = self.log.last_compaction()
        return comp.summary if comp else ""

    def _serialize(self, events: list[Event]) -> str:
        """Compact transcript of the window, for the summary prompt.

        Capped to fit the model's own window TOGETHER with the previous summary
        and the template, keeping the MOST RECENT part of the window (cut at a
        line boundary). The cap is dynamic: a big previous summary shrinks the
        head budget automatically. In steady state the window is bounded by the
        context window itself and the cap never bites — it only defends the
        FIRST compaction, whose input is the whole (multi-MB) history.
        An uncapped head is exactly what made every compaction fail before: the
        API rejected the multi-MB prompt, the window never shrank, and the UI
        flashed "compressing context" on every turn.
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
        text = "\n".join(lines)
        cap = self.config.llm_context_window_bytes - len(self._previous_summary().encode("utf-8")) - 8192
        if len(text.encode("utf-8")) > cap:
            text = text.encode("utf-8")[-cap:].decode("utf-8", "replace")
            nl = text.find("\n")
            if nl != -1:
                text = text[nl + 1:]  # drop the partial first line
        return text

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
            # stop must interrupt the summary call, not just the main turn
            if self.cancel and self.cancel.is_set():
                return "", chars
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
