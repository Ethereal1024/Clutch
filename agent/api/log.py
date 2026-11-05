"""The .clc as a byte-addressed log the HOST drives (P2).

The main loop lives in the host half now (TODO.md D1): the model calls, the
context, the compaction, the prompts and the tool orchestration are all client-
side, and what is left here is the execution layer — including the file. So the
log has to be reachable from outside this process, and these three endpoints are
exactly the ports `ui/run.js` and `ui/compaction.js` already declare:

  GET  /api/log          {items, windowBytes, cprStart, lastCompaction}
  POST /api/log          {event}  -> append ONE durable line, answer it persisted
  POST /api/log/window   {offset} -> slide the model window start (header write)

Nothing here decides anything. An append is one line through the same
`append_jsonl` every other writer uses, a read is one range read of the window
plus the open turn's head, a slide is one fixed-width header write. The events
themselves are the host's judgement; this side only refuses what is not a
DURABLE event at all — a delta, a status frame, a retry notice belongs to the
page's live feed and must never reach disk (agent/events.py's DURABLE_TYPES).
Refused, not dropped: a client that appends a delta has a bug, and a silent
success would leave it in place (TODO.md I3).

The window is `[cpr_start, file_end)` — the model's context, unchanged from
agent/core/lazy.py. `items` reaches back a little further, to the line that
opened the turn still in progress (`LazyEventLog.turn_start`): compaction
happens DURING a turn and slides `cpr_start` past that turn's task line, and the
host's loop answers its `task` from it rather than holding it in a variable
(agent/loop.py's `run(task)` held it; I6 forbids keeping it). The compactor
filters `items` by `offset >= cprStart` itself, so the extra head costs it
nothing.
"""

from __future__ import annotations

import json

from ..core.lazy import LazyEventLog
from ..events import DURABLE_TYPES, event_from_dict, event_to_json


def _wire(event) -> dict:
    """One durable event as the host reads it: the same JSON the .clc line holds."""
    return json.loads(event_to_json(event))


def _items(log: LazyEventLog) -> list[dict]:
    """The resident window plus the head of the open turn, in file order.

    The two ranges are adjacent by construction (the head is at or before the
    window start), so a reader never sees a gap and never has to stitch.

    The resident list is materialized ONCE, at open, and a slide only moves the
    boundary — it never grows or shortens that list. So the window is the
    resident records at/after the boundary (the filter agent/core/compaction.py:91
    applies to its own reads), and a boundary that moved BELOW the first resident
    record is served from disk for the uncovered span instead of being dropped:
    a client that slides back gets the records it asked for, never a short
    answer it cannot tell from a short log.
    """
    head = log.turn_start()
    start = log.cpr_start()
    window = [(off, ev) for off, ev in log.items() if off >= start]
    pairs = []
    if head < start:
        pairs.extend(log.read_page(head, start))
    first = window[0][0] if window else log.file_bytes() - log.event_start()
    if start < first:
        pairs.extend(log.read_page(start, first))
    pairs.extend(window)
    return [{"offset": off, "event": _wire(ev)} for off, ev in pairs]


class LogMixin:
    "The .clc as a byte-addressed log: read the window, append a line, slide it."

    # ---- API implementations ----

    def _log_get(self) -> None:
        project = self._state.project
        if project is None:
            return self._json({"error": "no project is open"}, status=409)
        log = project.log
        last = log.last_compaction()
        self._json(
            {
                "project": str(project.path),
                "items": _items(log),
                "windowBytes": log.window_bytes(),
                "cprStart": log.cpr_start(),
                "lastCompaction": _wire(last) if last is not None else None,
            }
        )

    def _log_append(self) -> None:
        project = self._state.project
        if project is None:
            return self._json({"error": "no project is open"}, status=409)
        if project.read_only:
            # a read-only project's writer drops lines silently (project.open's
            # no-op writer); an append endpoint must not: it is the host asking,
            # and "it worked" would be a lie it builds the next step on
            return self._json({"error": "project is read-only", "code": "read_only"}, status=409)
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        raw = body.get("event")
        if not isinstance(raw, dict):
            return self._json({"error": "event is required", "code": "not_durable"}, status=400)
        kind = raw.get("type")
        if kind not in DURABLE_TYPES:
            # the six durable types are the whole file's vocabulary; a delta or a
            # status frame is a page event (agent/events.py)
            return self._json(
                {"error": f"not a durable event type: {kind}", "code": "not_durable"},
                status=400,
            )
        try:
            event = event_from_dict(raw)
        except (TypeError, ValueError) as e:
            return self._json({"error": f"bad event: {e}", "code": "bad_event"}, status=400)
        event = project.log.append(event)
        # the persisted record answers with the offset the log stamped on it:
        # that number is what a follow-up `slideWindow` addresses and what the
        # page's watermark skips, so the caller must not have to compute it
        self._json({"offset": event.log_offset, "event": _wire(event)})  # type: ignore[attr-defined]

    def _log_window(self) -> None:
        project = self._state.project
        if project is None:
            return self._json({"error": "no project is open"}, status=409)
        if project.read_only:
            return self._json({"error": "project is read-only", "code": "read_only"}, status=409)
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        offset = body.get("offset")
        if not isinstance(offset, int) or isinstance(offset, bool):
            return self._json({"error": "offset must be an integer"}, status=400)
        log = project.log
        # the slide is a fixed-width header write; an offset outside the event
        # region is a client bug, and set_cpr_start() would ignore it in silence
        region = log.window_bytes() + log.cpr_start()
        if not 0 <= offset <= region:
            return self._json(
                {"error": f"offset {offset} is outside the event region [0, {region}]"},
                status=400,
            )
        log.set_cpr_start(offset)
        self._json({"cprStart": log.cpr_start(), "windowBytes": log.window_bytes()})
