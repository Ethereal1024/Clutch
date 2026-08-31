"""Window-based lazy .clc loading.

The model context is the WINDOW ``[cpr_start, file_end)``: everything from the
newest compaction line's start to the file end, and ONLY that. ``cpr_start`` is
a byte offset relative to the event region, persisted as a fixed-width line in
the .clc header, so opening materializes the window with one range read — no
tail scan, no index, O(1). Everything before cpr_start (already-summarized
history) stays on disk and is NEVER loaded into the log; the UI pages it on
demand via /api/history with a pure disk read that does not touch the resident
log, so history browsing is fully decoupled from the model context.

The whole design is BYTE-addressed — no index table, no event-sequence
numbering. Every read is a byte range (local fd seek / remote exec tail) —
O(1) positioned, never a full file scan — which is what makes the remote path
cheap: opening a big .clc over SSH transfers only the header plus the window.
"""

from __future__ import annotations

import json
import os
from typing import Callable

from ..events import (
    DURABLE_TYPES,
    CompactionEvent,
    Event,
    _line_bytes,
    event_from_dict,
    event_to_json,
)
from ..tools.workspace import LocalWorkspace, Workspace
from .persist import append_jsonl

_SEPARATOR = "---"  # the .clc header separator (project.SEPARATOR)
_SECTION = "[memories]"  # the memory.py section marker written to every .clc


def parse_durable(text: str) -> list[Event]:
    """Parse raw .clc text back into durable events. Robust to the file's
    formatting quirks (BOMs, empty lines), like the range reader's parse."""
    events: list[Event] = []
    for line in text.splitlines():
        line = line.strip().lstrip("\ufeff")
        if not line or line.startswith(_SEPARATOR) or line.startswith(_SECTION):
            continue
        try:
            data = json.loads(line)
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        # [memories] lines are valid JSON but not events; skip them
        if not isinstance(data, dict) or "type" not in data:
            continue
        ev = event_from_dict(data)
        if ev.type in DURABLE_TYPES:
            events.append(ev)
    return events


def _parse_with_offsets(raw: bytes, base_rel: int) -> list[tuple[int, Event]]:
    """Parse a byte range into (relative_offset, event) pairs; a range cut
    mid-line yields a mangled first/last line, which is dropped (JSON fails).
    Splitting on raw bytes keeps offsets exact across multibyte characters.
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


def _make_reader(path, workspace: Workspace | None) -> tuple[Callable[[int, int], bytes], int]:
    """Range reader for a .clc over local or remote (exec-bridge) storage;
    returns (read(lo, hi) -> bytes, total_bytes). Remote reads are byte-range
    execs, so opening a big .clc over SSH transfers only header + window.
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
    """The event log over a byte-addressed .clc.

    Resident events are the window ``[cpr_start, event region end)``; older
    history stays on disk, paged by the UI. Compaction appends a summary line
    and slides cpr_start to it, collapsing the window to the new summary.
    """

    def __init__(
        self,
        path: str,
        read: Callable[[int, int], bytes],
        total: int,
        base: int,
        writer: Callable[[str, str], None] | None = None,
        cpr_start: int = 0,
        cpr_line_off: int = 0,
        write_at: Callable[[int, bytes], None] | None = None,
    ) -> None:
        self._path = path
        self._read = read
        self._base = base  # event region start (absolute): the first durable line
        self._writer = writer
        self._write_at = write_at  # in-place header write (None = read-only / in-memory)
        self._cpr_line_off = cpr_line_off  # absolute offset of the header's cpr_start line
        self._file_bytes = total  # grows as events append
        self._events: list[Event] = []
        self._offsets: list[int] = []  # parallel: relative byte offsets (unique)
        self._cpr_start = 0  # window start (relative): the newest compaction line start
        self._materialize_open(cpr_start)

    # ------------------------------------------------------------------ core

    @property
    def path(self) -> str:
        return self._path

    def _materialize_open(self, stored_cpr_start: int) -> None:
        """Open-time materialization: ONLY the window [cpr_start, end) is resident;
        earlier history stays on disk (opening a compacted file is one range read)."""
        # clamp a stale/out-of-range cpr_start to 0 (never lose a compaction summary)
        region_len = self._file_bytes - self._base
        self._cpr_start = stored_cpr_start if 0 <= stored_cpr_start <= region_len else 0
        # legacy file (no header cpr_start): derive the boundary from the newest
        # compaction line, else every open would re-summarize the whole history
        if not self._cpr_line_off and region_len > 0:
            from ..project import _last_compaction_rel  # project imports lazy at module load

            # whole starts at the region, so its offsets are already cpr_start-relative
            whole = self._read(self._base, self._file_bytes)
            self._cpr_start = _last_compaction_rel(whole, 0)
        window = self._read(self._base + self._cpr_start, self._file_bytes)
        for off, ev in _parse_with_offsets(window, self._cpr_start):
            self._events.append(ev)
            self._offsets.append(off)

    @classmethod
    def in_memory(cls) -> LazyEventLog:
        """An in-memory log: no file, no persistence. Serves as the scratch
        log for tests and as the Agent's default when no project is open."""
        return cls("", lambda lo, hi: b"", 0, 0)

    def append(self, event: Event) -> Event:
        if event.type in DURABLE_TYPES:
            self._events.append(event)
            self._offsets.append(self._file_bytes - self._base)
            self._file_bytes += _line_bytes(event)
            if self._path:
                append_jsonl(self._path, event_to_json(event), self._writer)
        return event

    def events(self) -> list[Event]:
        """All materialized durable events, in file order (the window)."""
        return list(self._events)

    def items(self) -> list[tuple[int, Event]]:
        """Materialized (relative_byte_offset, event) pairs, in file order."""
        return list(zip(self._offsets, self._events, strict=True))

    # ------------------------------------------------------------- the window

    def cpr_start(self) -> int:
        """Window start (relative byte offset): the newest compaction line's
        start, or 0 for a compaction-free file."""
        return self._cpr_start

    def window_bytes(self) -> int:
        """Bytes of the model window [cpr_start, event region end)."""
        return (self._file_bytes - self._base) - self._cpr_start

    def last_compaction(self) -> CompactionEvent | None:
        """The most recent materialized CompactionEvent (or None)."""
        return next((e for e in reversed(self._events) if isinstance(e, CompactionEvent)), None)

    def set_cpr_start(self, off: int) -> None:
        """Slide the window start to a new boundary; persist it in the header's
        fixed-width line (in-place write keeps every other offset stable)."""
        if not 0 <= off <= (self._file_bytes - self._base):
            return  # defensive: never record a boundary outside the event region
        if self._path and self._write_at is not None and self._cpr_line_off:
            # no cpr_start line (0/None): never write there; boundary stays in memory
            self._write_at(self._cpr_line_off, f"cpr_start={off:010d}".encode("ascii"))
        self._cpr_start = off

    def note_bytes_written(self, n: int) -> None:
        """Count bytes the MemoryStore appended to the same file (memory lines
        are not events, so the log's own bookkeeping would undercount the size)."""
        self._file_bytes += n

    # ------------------------------------------------- history paging (decoupled)

    def read_page(self, lo: int, hi: int) -> list[tuple[int, Event]]:
        """Pure disk read of [lo, hi): parse durable events without touching the
        resident log (the UI's scroll-up history channel)."""
        lo = max(0, lo)
        hi = min(hi, self._file_bytes - self._base)
        if lo >= hi:
            return []
        return _parse_with_offsets(self._read(self._base + lo, self._base + hi), lo)
