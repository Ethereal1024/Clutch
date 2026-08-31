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


def _make_reader(path, workspace: Workspace | None) -> tuple[Callable[[int, int], bytes], int]:
    """Range reader for a .clc over local or remote (exec-bridge) storage.

    Returns ``(read(lo, hi) -> bytes, total_bytes)``. Local: binary streaming
    straight off the file (workspace is a pure path wrapper on the same host, so
    its presence changes nothing). Remote: EVERY read is a byte-range exec
    (``tail -c +A | head -c B | base64`` — base64 keeps the round trip exact even
    when a range cuts mid-multibyte-character), so opening a big .clc over SSH
    transfers only the header + the window, never the whole file.
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

    Resident durable events are the WINDOW ``[cpr_start, event region end)``:
    the newest compaction line and everything after it. Older history (before
    cpr_start) is never resident — the UI pages it with ``read_page``, a pure
    disk read that does not touch this log (model context and history browsing
    are fully decoupled).

    The window contract is preserved across reopen: ``cpr_start`` is a byte
    offset relative to the event region, persisted in the .clc header, so a
    lazily reopened log resolves the same boundary as the live one did. A
    compaction slides the window: it summarizes the whole current window, appends
    the new CompactionEvent at the file end, and moves cpr_start to that line's
    start (the window collapses to just the new summary).
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
        """Open-time materialization: ONLY the window ``[cpr_start, event
        region end)`` is resident — nothing else. History before cpr_start
        (the raw task included) stays on disk and is paged by the UI's
        scroll-up channel, so opening a compacted file is one range read."""
        # clamp a stale/out-of-range cpr_start to 0 (everything loads, and a
        # compaction's summary is never lost)
        region_len = self._file_bytes - self._base
        self._cpr_start = stored_cpr_start if 0 <= stored_cpr_start <= region_len else 0
        # A legacy file (no cpr_start header line) cannot persist its compaction
        # boundary, so the whole history (past summaries included) would be
        # treated as the window and re-summarized on EVERY open — the UI flashes
        # "compressing context" each session and the file grows with redundant
        # full-history summaries. Derive the boundary from the newest compaction
        # line instead (the same scan the migration script uses); a never-
        # compacted file scans to 0 (whole region, as before).
        if not self._cpr_line_off and region_len > 0:
            from ..project import _last_compaction_rel  # project imports lazy at module load

            # scan the event region for the newest compaction line: `whole`
            # starts AT the region, so its byte positions are already relative
            # to the region start (base=0) — exactly cpr_start's semantics
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
        return list(zip(self._offsets, self._events))

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
        """Slide the window start to a new boundary (a fresh compaction line):
        persist it in the header's fixed-width line (in-place write, stable
        offsets) and update the resident value."""
        if not 0 <= off <= (self._file_bytes - self._base):
            return  # defensive: never record a boundary outside the event region
        if self._path and self._write_at is not None and self._cpr_line_off:
            # the whole fixed-width line (prefix included — the line never
            # shifts, so the in-place write keeps every other offset stable).
            # _cpr_line_off 0/None = a file whose header has no cpr_start line:
            # never write there (offset 0 is the header prefix) — migration is
            # the script's job, so the boundary just stays in memory.
            self._write_at(self._cpr_line_off, f"cpr_start={off:010d}".encode("ascii"))
        self._cpr_start = off

    def note_bytes_written(self, n: int) -> None:
        """Count bytes the MemoryStore appended to the same file (memory lines
        and the [memories] marker): they grow the file but are not events, so
        the log's own bookkeeping would otherwise undercount the on-disk size,
        drifting every later event offset (and the persisted window boundary)."""
        self._file_bytes += n

    # ------------------------------------------------- history paging (decoupled)

    def read_page(self, lo: int, hi: int) -> list[tuple[int, Event]]:
        """Pure disk read of [lo, hi) (relative offsets): parse and return the
        durable events WITHOUT touching the resident log. This is the UI's
        scroll-up history channel — the bytes before cpr_start are read on
        demand and never enter the model context."""
        lo = max(0, lo)
        hi = min(hi, self._file_bytes - self._base)
        if lo >= hi:
            return []
        return _parse_with_offsets(self._read(self._base + lo, self._base + hi), lo)
