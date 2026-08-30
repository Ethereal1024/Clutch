"""Lazy .clc loading for large conversations.

Opening a .clc materializes only what the model needs: the raw task plus the
preserved recent tail the last compaction kept (everything at or after the
compaction's stored ``tail_start``). Earlier records stay on disk and are pulled
in on demand — the UI pages them with GET /api/history, and a compaction
re-materializes the head so its summary input is byte-identical to a fully
loaded log.

The whole design is BYTE-addressed — no index table, no event-sequence
numbering. ``tail_start`` is a byte offset relative to the event region (the
first durable line, the raw task), which is exactly what the .clc persists, so a
lazily reopened log resolves the same boundary as the live one did. Every read is
a byte range (local fd seek / remote exec tail) — O(1) positioned, never a full
file scan — which is what makes the remote path cheap: opening a big .clc over
SSH transfers only the header plus the preserved tail, not the whole file.
"""

from __future__ import annotations

import bisect
import contextlib
import json
import os
from typing import Callable, Iterator

from ..events import (
    DURABLE_TYPES,
    AssistantMessageEvent,
    CompactionEvent,
    Event,
    ToolResultEvent,
    UserMessageEvent,
    _line_bytes,
    event_from_dict,
    event_to_json,
)
from ..tools.workspace import LocalWorkspace, Workspace
from .persist import append_jsonl

# Never keep more materialized events than this in memory; the preserved tail,
# the raw task and anything inside an active materialize() context are pinned
# and can never be evicted.
_LRU_EVENT_CAP = 20_000
# minimum event-region size before lazy loading is worth it; tiny histories go
# through the plain open_project path instead (bytes — with no index there is no
# event count, so the file size is the natural threshold)
_LAZY_MIN_BYTES = 256 * 1024
# tail scan: start by reading the last 64KB of the .clc looking for the last
# compaction event and the [memories] marker, doubling back until found. Capped
# so a never-compacted giant file does not scan the whole thing to *confirm*
# there is no compaction (it opens fully-loaded anyway).
_TAIL_SCAN_INIT = 1 << 16
_TAIL_SCAN_MAX = 8 * (1 << 20)

_SEPARATOR = "----"
_SECTION = "[memories]"  # the memory.py section marker written to every .clc


def parse_durable(text: str) -> list[Event]:
    """Parse a raw byte range back into durable events. Robust to the file's
    formatting quirks (BOMs, empty lines), like open_project's plain read."""
    events: list[Event] = []
    for line in text.splitlines():
        line = line.strip().lstrip("\ufeff")
        if not line or line.startswith(_SEPARATOR) or line.startswith(_SECTION):
            continue
        try:
            data = json.loads(line)
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        # the [memories] content lines are valid JSON but NOT events (no `type`);
        # they belong to the MemoryStore, parsed separately — skip them here so
        # the returned list is exactly the durable events in the range
        if not isinstance(data, dict) or "type" not in data:
            continue
        ev = event_from_dict(data)
        if ev.type in DURABLE_TYPES:
            events.append(ev)
    return events


def _parse_with_offsets(raw: bytes, base_rel: int) -> list[tuple[int, Event]]:
    """Parse a byte range into (relative_offset, event) pairs.

    ``base_rel`` is the range's start offset relative to the event region. A
    range whose start/end cuts mid-line yields a mangled first/last line — both
    are dropped (JSON parse failure / missing trailing newline), so the returned
    offsets are always exact line starts (UTF-8 safe: a line starts at ``{``).
    Splitting on raw BYTES keeps offsets exact even when a cut lands inside a
    multibyte character (the mangled line decodes with a replacement char and
    fails JSON; the byte counter never saw the replacement).
    """
    if not raw.endswith(b"\n"):
        raw = raw.rsplit(b"\n", 1)[0]  # drop a trailing line cut by the range end
    out: list[tuple[int, Event]] = []
    pos = 0
    for seg in raw.split(b"\n"):
        off = base_rel + pos
        pos += len(seg) + 1  # BYTES, exact
        if not seg or seg.startswith(_SEPARATOR.encode()) or seg.startswith(_SECTION.encode()):
            continue
        line = seg.decode("utf-8", "replace")
        stripped = line.strip()
        if not stripped:
            continue
        try:
            data = json.loads(line)
        except (ValueError, TypeError, json.JSONDecodeError):
            continue  # mangled first line (range start mid-line) or a corrupt line
        if not isinstance(data, dict) or "type" not in data:
            continue
        ev = event_from_dict(data)
        if ev.type in DURABLE_TYPES:
            out.append((off, ev))
    return out


def _tail_scan(read: Callable[[int, int], bytes], total: int) -> tuple[tuple[int, Event] | None, int | None]:
    """Scan BACKWARD from the file tail for the last compaction event and the
    last ``[memories]`` marker — the two things a reopen needs before it can
    materialize. No index: a backward doubling read (64KB up to 8MB) finds the
    last compaction in the overwhelming case (a compaction is followed only by
    the conversation since it), and the memories marker sits right after it.

    Each pass reads ONLY the newly-added span [lo, scanned_to) (never the whole
    file repeatedly); a line cut by a span edge is dropped here and parsed whole
    by the next, earlier pass. A file with no memories marker scans to the span
    cap — same open cost as the old index pass, but without JSON parsing.

    Returns ``((abs_line_start, event) | None, memories_marker_abs | None)``.
    """
    chunk = _TAIL_SCAN_INIT
    scanned_to = total
    comp: tuple[int, Event] | None = None
    mem: int | None = None
    while True:
        lo = max(0, scanned_to - chunk)
        raw = read(lo, scanned_to)
        pos = 0
        first = True
        for seg in raw.split(b"\n"):
            line_start = lo + pos
            pos += len(seg) + 1  # BYTES, exact (a mid-multibyte cut still counts)
            if first:
                first = False
                if lo > 0:
                    continue  # line mangled by the span start: parsed whole next pass
            if not seg or seg.startswith(_SEPARATOR.encode()):
                continue
            line = seg.decode("utf-8", "replace")
            stripped = line.strip()
            if stripped == _SECTION:
                mem = line_start  # last occurrence wins (later in the scan = later in the file)
                continue
            if not stripped:
                continue
            try:
                data = json.loads(line)
            except (ValueError, TypeError, json.JSONDecodeError):
                continue
            if isinstance(data, dict) and data.get("type") == "compaction":
                comp = (line_start, event_from_dict(data))
        scanned_to = lo
        if comp is not None and mem is not None:
            break
        if lo == 0 or total - scanned_to >= _TAIL_SCAN_MAX:
            break
        chunk *= 2
    return comp, mem


def _make_reader(path, workspace: Workspace | None) -> tuple[Callable[[int, int], bytes], int]:
    """Range reader for a .clc over local or remote (exec-bridge) storage.

    Returns ``(read(lo, hi) -> bytes, total_bytes)``. Local: binary streaming
    straight off the file (workspace is a pure path wrapper on the same host, so
    its presence changes nothing). Remote: EVERY read is a byte-range exec
    (``tail -c +A | head -c B | base64`` — base64 keeps the round trip exact even
    when a range cuts mid-multibyte-character), so opening a big .clc over SSH
    transfers only the header + the preserved tail, never the whole file.
    """
    if workspace is not None and not isinstance(workspace, LocalWorkspace):
        total = workspace.size(str(path))

        def read(lo: int, hi: int) -> bytes:
            return workspace.read_range(str(path), lo, hi)

        return read, total
    f = open(path, "rb")

    def read(lo: int, hi: int) -> bytes:
        f.seek(lo)
        return f.read(hi - lo)

    return read, os.path.getsize(path)


class LazyEventLog:
    """EventLog facade over a byte-addressed .clc.

    Resident durable events are kept in one ordered list with their relative
    byte offsets. A bounded LRU (cap ``_LRU_EVENT_CAP``) drops materialized
    *middle* records (offsets strictly between the task end and the preserved
    tail) when the log grows past it; the task, the preserved tail and anything
    inside an active materialize() context are pinned. Eviction is invisible to
    the UI: pages it rendered keep their DOM copies and are only re-fetched from
    disk on a reconnect.

    The compaction contract is preserved: ``tail_start`` is a byte offset
    relative to the event region, ``events()``/``items()`` return durable events
    with their offsets, and compact() re-materializes the head under a pin so
    its summary matches a fully loaded log.
    """

    def __init__(
        self,
        path: str,
        read: Callable[[int, int], bytes],
        total: int,
        base: int,
        writer: Callable[[str, str], None] | None = None,
        tail_start: int = 0,
    ) -> None:
        self._path = path
        self._read = read
        self._total = total  # file size at open (bytes, absolute)
        self._base = base  # event region start (absolute): the raw task's line start
        self._writer = writer
        self._file_bytes = total  # grows as events append
        self._events: list[Event] = []
        self._offsets: list[int] = []  # parallel: relative byte offsets (unique)
        self._lru: list[int] = []  # evictable (middle) event offsets, load order
        self._in_use: set[int] = set()  # pinned by an active materialize() context
        self._pin_range: tuple[int, int] | None = None  # active materialize() [lo, hi)
        self._tail_start = 0
        self._task_end = 0  # byte offset just past the raw task line
        self._mid_offsets: list[int] = []  # materialized middle offsets (older count)
        self._mid_fully_loaded = False  # the whole middle [task_end, tail_start) is resident
        self._materialize_open(tail_start)

    # ------------------------------------------------------------------ core

    @property
    def path(self) -> str:
        return self._path

    @property
    def task_end(self) -> int:
        """Byte offset just past the raw task line (relative): paging never
        reads at or before this — the task is always resident."""
        return self._task_end

    def _materialize_open(self, stored_tail_start: int) -> None:
        """Open-time materialization: the raw task (from a tiny head read) plus
        the preserved tail [tail_start, event region end). The middle stays on
        disk — that is the whole point of the lazy load."""
        # 1. task: the first durable line of the event region
        head = self._read(self._base, min(self._base + (1 << 16), self._total))
        pos = 0
        for seg in head.split(b"\n"):
            rel = pos
            pos += len(seg) + 1  # BYTES, exact
            if not seg or seg.startswith(_SEPARATOR.encode()) or seg.startswith(_SECTION.encode()):
                continue
            line = seg.decode("utf-8", "replace")
            stripped = line.strip()
            if not stripped:
                continue
            try:
                data = json.loads(line)
            except (ValueError, TypeError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict) or "type" not in data:
                continue
            ev = event_from_dict(data)
            if ev.type in DURABLE_TYPES:
                self._events.append(ev)
                self._offsets.append(0)
                self._task_end = rel + len(seg) + 1
                break
        # 2. clamp the stored tail_start to the event region (stale/out-of-range
        # values fall back to the tail of the region: everything loads, and a
        # compaction's summary is never lost)
        region_len = self._file_bytes - self._base
        self._tail_start = stored_tail_start if 0 <= stored_tail_start <= region_len else 0
        # 3. the preserved tail
        tail = self._read(self._base + self._tail_start, self._file_bytes)
        for off, ev in _parse_with_offsets(tail, self._tail_start):
            self._events.append(ev)
            self._offsets.append(off)

    def append(self, event: Event) -> Event:
        if event.type in DURABLE_TYPES:
            self._events.append(event)
            self._offsets.append(self._file_bytes - self._base)
            self._file_bytes += _line_bytes(event)
            if self._path:
                append_jsonl(self._path, event_to_json(event), self._writer)
        return event

    def events(self) -> list[Event]:
        """All materialized durable events, in file order."""
        return list(self._events)

    def items(self) -> list[tuple[int, Event]]:
        """Materialized (relative_byte_offset, event) pairs, in file order."""
        return list(zip(self._offsets, self._events))

    def __len__(self) -> int:
        return len(self._events)

    def __getitem__(self, idx: int) -> Event:
        return self._events[idx]

    # ------------------------------------------------------- durable slicing

    def tail_from(self, ts: int, compaction: CompactionEvent) -> list[Event]:
        """Durable events at byte offsets >= ts (the preserved tail), minus
        compaction events. Offsets are relative to the event region — exactly
        what the .clc persists — so a reopened lazy log slices identically to
        the live one. A stale out-of-range ts falls back to the tail boundary
        itself."""
        if ts > (self._offsets[-1] if self._offsets else 0):
            ts = self._tail_start
        i = bisect.bisect_left(self._offsets, ts)
        return [e for e in self._events[i:] if not isinstance(e, CompactionEvent)]

    # ----------------------------------------------------------- compaction

    def tail_start_index(self, budget: int) -> int:
        """Byte offset (relative to the event region) where the preserved recent
        tail begins, sized to ``budget`` tokens (~3 chars each) and split at an
        assistant-turn boundary. Sizes come from the materialized tail — which
        IS the full preserved tail [tail_start, N) — so the walk matches
        EventLog.tail_start_index exactly (same events, same len(content)//3):
        byte-addressing needs no index, no content reads, and no approximation.
        """
        tail_idx = bisect.bisect_left(self._offsets, self._tail_start)
        total = 0
        tail_start = 0
        for i in range(len(self._events) - 1, tail_idx - 1, -1):
            ev = self._events[i]
            if isinstance(ev, (UserMessageEvent, ToolResultEvent)):
                size = len(ev.content)
            elif isinstance(ev, AssistantMessageEvent):
                size = len(ev.content) + len(ev.reasoning)
            else:
                continue
            total += size // 3
            if total >= budget:
                j = i
                while j > tail_idx and not isinstance(self._events[j], AssistantMessageEvent):
                    j -= 1
                tail_start = self._offsets[j]
                break
        return tail_start

    def events_before(self, byte_offset: int) -> list[Event]:
        """Materialized durable events whose byte offset < ``byte_offset`` (the
        compaction head: everything before the preserved tail boundary)."""
        return [e for e, off in zip(self._events, self._offsets) if off < byte_offset]

    def compact_min_tail(self) -> int:
        """Smallest tail_start that leaves a compactible head. The lazy boundary
        never drops below the preserved tail (which sits past the task), so any
        computed boundary has a real head; keep the task-end floor anyway."""
        return self._task_end

    # ------------------------------------------------------------ materialize

    def older_bytes(self) -> int:
        """Event-region bytes still on disk between the task end and the
        preserved tail: pages not yet materialized, plus any that LRU eviction
        dropped (evicted pages only matter on a reconnect, where this honest
        count resets the UI's pill). 0 once the whole middle is resident."""
        if self._mid_fully_loaded:
            return 0
        if not self._mid_offsets:
            return max(0, self._tail_start - self._task_end)
        return max(0, min(self._mid_offsets) - self._task_end)

    def materialize_range(self, lo: int, hi: int) -> list[tuple[int, Event]]:
        """Ensure the byte range [lo, hi) (relative offsets) is materialized
        (reading the missing slices from disk in one pass) and return (offset,
        event) pairs in file order. Drops LRU victims afterwards."""
        lo = max(0, lo)
        hi = min(hi, self._file_bytes - self._base)
        if lo >= hi:
            return []
        text = self._read(self._base + lo, self._base + hi)
        for off, ev in _parse_with_offsets(text, lo):
            if not self._is_loaded(off):
                self._insert(off, ev)
                if self._task_end < off < self._tail_start:
                    self._lru.append(off)
                    self._mid_offsets.append(off)
        if lo <= self._task_end and hi >= self._tail_start:
            self._mid_fully_loaded = True  # the whole middle is now resident
        self._evict_lru()
        return [(off, ev) for off, ev in zip(self._offsets, self._events) if lo <= off < hi]

    @contextlib.contextmanager
    def materialize(self, lo: int, hi: int) -> Iterator[None]:
        """Pin byte offsets [lo, hi) against LRU eviction for the block and
        materialize them. The compactor uses this so the summarized head can
        never be dropped mid-compaction."""
        prev = self._pin_range
        self._pin_range = (lo, hi)
        try:
            self.materialize_range(lo, hi)
            yield
        finally:
            self._pin_range = prev

    # -------------------------------------------------------------- internals

    def _is_loaded(self, off: int) -> bool:
        i = bisect.bisect_left(self._offsets, off)
        return i < len(self._offsets) and self._offsets[i] == off

    def _insert(self, off: int, ev: Event) -> None:
        i = bisect.bisect_left(self._offsets, off)
        self._offsets.insert(i, off)
        self._events.insert(i, ev)

    def _evict_lru(self) -> None:
        """Drop evictable materialized events beyond the LRU cap, oldest-loaded
        first. Pinned offsets, the task, the preserved tail and the active
        materialize() range are never dropped."""
        while len(self._events) > _LRU_EVENT_CAP:
            victim = None
            for off in self._lru:
                if off in self._in_use:
                    continue
                if self._pin_range is not None and self._pin_range[0] <= off < self._pin_range[1]:
                    continue
                victim = off
                break
            if victim is None:
                break  # everything evictable is pinned right now
            i = bisect.bisect_left(self._offsets, victim)
            del self._offsets[i]
            del self._events[i]
            self._lru.remove(victim)
            if victim in self._mid_offsets:
                self._mid_offsets.remove(victim)
            self._mid_fully_loaded = False  # eviction reopened the middle
