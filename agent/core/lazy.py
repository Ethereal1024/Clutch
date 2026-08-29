"""Lazy .clc loading for large conversations.

Opening a .clc materializes only what the model needs: durable seq 0 (the raw
task) plus the preserved recent tail the last compaction kept (seqs
``[tail_start, N)``). Earlier records stay on disk and are pulled in on demand —
the UI pages them with GET /api/history, and a compaction re-materializes the
head so its summary input is byte-identical to a fully loaded log.

The load stays consistent with the compaction file format: ``tail_start`` is an
index into the *durable* event sequence, which is exactly what the .clc
persists, so a lazily reopened log resolves the same index as the live one did.
"""

from __future__ import annotations

import bisect
import contextlib
import json
import os
import re
from dataclasses import dataclass, field
from typing import Callable, Iterator

from ..events import (
    DURABLE_TYPES,
    AssistantMessageEvent,
    CompactionEvent,
    Event,
    ToolResultEvent,
    UserMessageEvent,
    event_from_dict,
    event_to_json,
)
from ..tools.workspace import LocalWorkspace, Workspace
from .persist import append_jsonl

# Never keep more materialized events than this in memory; the preserved tail,
# seq 0 and anything inside an active materialize() context are pinned and can
# never be evicted.
_LRU_EVENT_CAP = 20_000
# minimum number of durable records before lazy loading is worth it; tiny
# histories go through the plain open_project path instead
_LAZY_MIN_DURABLE = 512
# report index parsing progress once per this many lines
_INDEX_PROGRESS_EVERY = 10_000

# .clc line grammar: SEPARATOR lines separate sections, SECTION lines give a
# section its name, everything else is a JSON event line. Bytes pattern: the
# index scans raw file bytes via the range reader (local fd or remote fetch).
_SEPARATOR = "----"
_SECTION = "[memories]"  # the memory.py section marker written to every .clc
_DURABLE_LINE_RE = re.compile(rb'^\{"type": "([a-z_]+)"')
# JSON string escape lengths (guaranteed upper bounds for byte offsets)
_JSON_ESCAPES = {
    '"': 1, "\\": 1, "/": 1,
    "b": 1, "f": 1, "n": 1, "r": 1, "t": 1,
    "u": 5,  # \uXXXX
}
for _c in "0123456789abcdefABCDEF":
    _JSON_ESCAPES[_c] = 1


def _len_json_str(s: str) -> int:
    """Upper bound of the encoded byte length of a JSON string value ``s``."""
    n = 2
    for ch in s:
        if ch < " ":
            n += 1 + _JSON_ESCAPES.get(ch, 1)
        elif ch in _JSON_ESCAPES:
            n += 1 + _JSON_ESCAPES[ch]
        else:
            n += len(ch.encode("utf-8"))
    return n


@dataclass
class DurableIndex:
    """Offsets of every durable event line in the .clc (no JSON parsing).

    Durable positions ARE the file seqs the log assigns: non-durable (transient)
    lines, separators and section headers are skipped, so ``offsets[i]`` is where
    durable event ``i`` starts. For a well-formed modern .clc this equals the
    total line count up to that point.
    """

    offsets: list[int] = field(default_factory=list)
    types: list[str] = field(default_factory=list)
    memory_lines: list[int] = field(default_factory=list)
    total_bytes: int = 0
    newest_compaction: int = -1  # file seq of the last compaction line, if any

    def __len__(self) -> int:
        return len(self.offsets)


def _index_line(line: bytes, index: DurableIndex, line_start: int, line_end: int) -> None:
    """Record one .clc line's offset in the index if it is a durable event."""
    if line_start == 0 and line.startswith(_SEPARATOR.encode()):
        return  # file preamble separator
    if line.rstrip(b"\r\n") == _SECTION.encode():
        index.memory_lines.append(line_end)  # content begins right after this line
        return
    m = _DURABLE_LINE_RE.match(line)
    if m is None:
        return
    etype = m.group(1).decode("ascii")
    if etype not in DURABLE_TYPES:
        return
    index.offsets.append(line_start)
    index.types.append(etype)
    if etype == "compaction":
        index.newest_compaction = len(index.offsets) - 1


def index_file(
    read: Callable[[int, int], bytes],
    total: int,
    on_progress: Callable[[int, int], None] | None = None,
) -> DurableIndex:
    """Scan a .clc once, recording durable line byte offsets (single pass, no
    JSON parse — offsets only). ``read(lo, hi)`` returns bytes [lo, hi)."""
    index = DurableIndex()
    index.total_bytes = total
    buf = b""
    pos = 0
    line_start = 0
    last_report = 0
    while pos < total:
        chunk = read(pos, min(pos + (1 << 20), total))
        if not chunk:
            break
        buf += chunk
        pos += len(chunk)
        while True:
            nl = buf.find(b"\n")
            if nl < 0:
                break
            line = buf[:nl]
            _index_line(line, index, line_start, line_start + nl)
            line_start += nl + 1
            buf = buf[nl + 1 :]
            if on_progress is not None and line_start - last_report >= _INDEX_PROGRESS_EVERY:
                on_progress(line_start, total)
                last_report = line_start
    if buf:
        _index_line(buf, index, line_start, line_start + len(buf))
        line_start += len(buf)
    if on_progress is not None:
        on_progress(line_start, total)
    return index


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
        # the returned list is exactly the durable events in the range (and the
        # index scan's DurableIndex, which only records event lines, stays aligned)
        if not isinstance(data, dict) or "type" not in data:
            continue
        ev = event_from_dict(data)
        if ev.type in DURABLE_TYPES:
            events.append(ev)
    return events


def _make_reader(path, workspace: Workspace | None) -> tuple[Callable[[int, int], bytes], int]:
    """Range reader for a .clc over local or remote (exec-bridge) storage.

    Returns ``(read(lo, hi) -> bytes, total_bytes)``. Local: binary streaming
    straight off the file (workspace is a pure path wrapper on the same host, so
    its presence changes nothing). Remote: one whole-file fetch for the index
    pass (same cost as plain open, but no JSON parsing); the fetched bytes are
    sliced for every range read, and their byte offsets match the remote file's
    (valid-UTF-8 round trip), so materialization is always consistent with the
    index.
    """
    if workspace is not None and not isinstance(workspace, LocalWorkspace):
        text = workspace.read(str(path))
        data = text.encode("utf-8")
        return (lambda lo, hi: data[lo:hi]), len(data)
    f = open(path, "rb")

    def read(lo: int, hi: int) -> bytes:
        f.seek(lo)
        return f.read(hi - lo)

    return read, os.path.getsize(path)


class LazyEventLog:
    """EventLog facade over a lazily-indexed .clc.

    Resident events are kept in two parallel lists: ``_seqs`` (file seqs) and
    ``_events`` (durable events), both sorted by seq. A bounded LRU (cap
    ``_LRU_EVENT_CAP``) drops materialized *middle* records (seqs strictly
    between 0 and the preserved tail) when the log grows past it; seq 0, the
    preserved tail and anything inside an active materialize() context are
    pinned. Eviction is invisible to the UI: pages it rendered keep their DOM
    copies and are only re-fetched from disk on a reconnect.

    The compaction contract is preserved: ``tail_start`` is an index into the
    durable sequence, ``events()``/``items()`` return durable events with their
    file seqs, and compact() re-materializes the head under a pin so its summary
    matches a fully loaded log.
    """

    def __init__(
        self,
        path: str,
        index: DurableIndex,
        read: Callable[[int, int], bytes],
        writer: Callable[[str, str], None] | None = None,
        tail_start: int = 0,
    ) -> None:
        self._path = path
        self._index = index
        self._read = read
        self._writer = writer
        self._seqs: list[int] = []
        self._events: list[Event] = []
        self._lru: list[int] = []  # load order of evictable (middle) seqs
        self._in_use: set[int] = set()  # pinned by an active materialize() context
        self._compaction_seq = index.newest_compaction
        self._next_seq = len(index)
        self._tail_start = self._resolve_tail_start(tail_start)

    def _resolve_tail_start(self, tail_start: int) -> int:
        """Clamp a stored tail_start from disk into the durable range.

        Older .clc files wrote an index into the FULL event log (transients
        included); when the stored value is out of range, fall back to the last
        compaction's own durable position (the newest preserved tail boundary).
        The clamp is INCLUSIVE of the compaction event (its durable position,
        like EventLog.tail_from): a lazy log must keep the newest compaction
        resident or derive_messages can never find the summary head and would
        re-derive the whole pre-compaction middle instead.
        """
        if 0 < tail_start <= len(self._index):
            return tail_start
        if self._compaction_seq >= 0:
            return self._compaction_seq
        return 0

    # ------------------------------------------------------------------ core

    @property
    def path(self) -> str:
        return self._path

    def append(self, event: Event) -> Event:
        if event.type in DURABLE_TYPES:
            self._events.append(event)
            self._seqs.append(self._next_seq)
            self._next_seq += 1
            if self._path:
                append_jsonl(self._path, event_to_json(event), self._writer)
        return event

    def events(self) -> list[Event]:
        """All materialized durable events, in file order."""
        return list(self._events)

    def items(self) -> list[tuple[int, Event]]:
        """Materialized durable (file_seq, event) pairs, in file order."""
        return list(zip(self._seqs, self._events))

    def __len__(self) -> int:
        return len(self._events)

    def __getitem__(self, idx: int) -> Event:
        return self._events[idx]

    # ------------------------------------------------------- durable slicing

    def tail_from(self, ts: int, compaction: CompactionEvent) -> list[Event]:
        """Durable events at durable positions >= ts (the preserved tail),
        minus compaction events. Positions index the durable sequence — exactly
        what the .clc persists — so a reopened lazy log slices identically to
        the live one. A stale out-of-range ts (computed against a log that
        included transients) is clamped to the compaction's own durable
        position (inclusive, then filtered), matching EventLog.tail_from. The
        slice is taken by seq, not list index, so LRU-evicted middle holes
        don't shift it."""
        if ts > self._next_seq:
            ts = self._compaction_seq if self._compaction_seq >= 0 else len(self._index)
        ts = max(0, min(ts, self._next_seq))
        i = bisect.bisect_left(self._seqs, ts)
        return [e for e in self._events[i:] if not isinstance(e, CompactionEvent)]

    # ----------------------------------------------------------- compaction

    def tail_start_index(self, budget: int) -> int:
        """Durable file-seq where the preserved tail begins for ``budget``
        tokens — the same walk as EventLog.tail_start_index over the materialized
        durable sequence."""
        durable = self._events
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
            total += size // 4
            if total >= budget:
                j = i
                while j > 0 and not isinstance(durable[j], AssistantMessageEvent):
                    j -= 1
                tail_start = self._seqs[j]
                break
        return tail_start

    def durable_index_of(self, event: Event) -> int:
        """File seq of a materialized event (identity); the compactor's no-op
        guard compares against it."""
        i = self._events.index(event)
        return self._seqs[i]

    # ------------------------------------------------------------ materialize

    def older_count(self) -> int:
        """Durable events still on disk strictly between seq 0 and the preserved
        tail: pages not yet materialized, plus any that LRU eviction dropped
        (evicted pages only matter on a reconnect, where this honest count
        resets the UI's pill)."""
        resident = sum(1 for s in self._seqs if 0 < s < self._tail_start)
        return max(0, self._tail_start - 1 - resident)

    def materialize_range(self, lo: int, hi: int) -> list[tuple[int, Event]]:
        """Ensure durable file seqs [lo, hi) are materialized (reading the
        missing slices from disk in one pass) and return (seq, event) pairs in
        file order. Drops LRU victims afterwards."""
        lo = max(0, lo)
        hi = min(hi, len(self._index))
        if lo >= hi:
            return []
        missing = [s for s in range(lo, hi) if not self._is_loaded(s)]
        if missing:
            first, last = missing[0], missing[-1]
            start_off = self._index.offsets[first]
            end_off = self._index.offsets[last + 1] if last + 1 < len(self._index) else self._index.total_bytes
            parsed = parse_durable(self._read(start_off, end_off).decode("utf-8", "replace"))
            for s, ev in zip(range(first, last + 1), parsed):
                if not self._is_loaded(s):
                    self._insert(s, ev)
                    if 0 < s < self._tail_start:
                        self._lru.append(s)
        self._evict_lru()
        return [(s, ev) for s, ev in zip(self._seqs, self._events) if lo <= s < hi]

    @contextlib.contextmanager
    def materialize(self, lo: int, hi: int) -> Iterator[None]:
        """Pin durable file seqs [lo, hi) against LRU eviction for the block and
        materialize them. The compactor uses this so the summarized head can
        never be dropped mid-compaction."""
        self._in_use.update(range(lo, hi))
        try:
            self.materialize_range(lo, hi)
            yield
        finally:
            self._in_use.difference_update(range(lo, hi))

    # -------------------------------------------------------------- internals

    def _is_loaded(self, seq: int) -> bool:
        i = bisect.bisect_left(self._seqs, seq)
        return i < len(self._seqs) and self._seqs[i] == seq

    def _insert(self, seq: int, ev: Event) -> None:
        i = bisect.bisect_left(self._seqs, seq)
        self._seqs.insert(i, seq)
        self._events.insert(i, ev)

    def _evict_lru(self) -> None:
        """Drop evictable materialized events beyond the LRU cap, oldest-loaded
        first. Pinned seqs, seq 0 and the preserved tail are never dropped."""
        while len(self._events) > _LRU_EVENT_CAP:
            victim = None
            for seq in self._lru:
                if seq not in self._in_use:
                    victim = seq
                    break
            if victim is None:
                break  # everything evictable is pinned right now
            i = bisect.bisect_left(self._seqs, victim)
            del self._seqs[i]
            del self._events[i]
            self._lru.remove(victim)


def _stored_tail_start(read: Callable[[int, int], bytes], index: DurableIndex) -> int:
    """Extract the last compaction's stored tail_start without parsing the whole
    file — parse only its single line."""
    if index.newest_compaction < 0:
        return 0
    start = index.offsets[index.newest_compaction]
    end = index.offsets[index.newest_compaction + 1] if index.newest_compaction + 1 < len(index) else index.total_bytes
    try:
        ev = event_from_dict(json.loads(read(start, end).decode("utf-8", "replace")))
        return int(getattr(ev, "tail_start", 0) or 0)
    except (ValueError, TypeError, json.JSONDecodeError):
        return 0
