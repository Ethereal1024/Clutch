"""Project memory: durable facts stored in a `[memories]` section of the .clc.

Each memory is a short title (a one-line summary) + full content, kept as one
JSONL line per memory inside the project's single .clc file (so the project
stays one file, and the remote/exec persistence path is reused). The model can
save/load/search memories through tools; the system prompt carries the resident
title list so the model can pick what to load.

Memory lines live scattered among the event lines (both are appended to the
file's end), so locating them must NOT depend on scanning from a marker to the
file end. Every .clc therefore carries a FIXED-WIDTH memory index line in the
header (between the meta lines and the ``---`` separator): a ring buffer of the
last ``MEMORY_INDEX_SLOTS`` (10) memory-line byte offsets plus a FIFO head. The
index is updated IN PLACE by the agent on every save (never appended), so an
open reads the header line and range-reads exactly the indexed lines — O(1) in
the file size, unaffected by how far the first memory sits from the tail.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .core.persist import append_jsonl

SECTION = "[memories]"
MAX_TITLE_CHARS = 80
MAX_CONTENT_CHARS = 4000

# --- fixed-width header memory index ---
# Zero-padded fields keep the line length constant (stable event-region
# offsets); slots are absolute byte offsets, 0 = empty.
MEMORY_INDEX_SLOTS = 10
_MEMORY_INDEX_PREFIX = "memory_index="
_MEMORY_INDEX_FIELD_W = 16  # decimal offset width: up to ~90 PB, plenty
_MEMORY_INDEX_LINE_W = (
    len(_MEMORY_INDEX_PREFIX)  # 13
    + 2                        # count field
    + 2                        # head field
    + MEMORY_INDEX_SLOTS * _MEMORY_INDEX_FIELD_W  # 160
    + (3 + MEMORY_INDEX_SLOTS - 1)  # commas between the 3 + SLOTS fields
)  # = 189 bytes, fixed
# how many bytes to read when pulling one memory line by its offset (content is
# capped at MAX_CONTENT_CHARS ≈ 13 KB UTF-8, so 32 KB always covers a full line)
_MEMORY_READ_CHUNK = 32 * 1024


def _index_line(count: int, head: int, offsets: list[int]) -> str:
    """Serialize the index line (offsets: one value per ring slot, length
    MEMORY_INDEX_SLOTS)."""
    parts = [_MEMORY_INDEX_PREFIX, f"{count:02d}", f"{head:02d}"]
    parts += [f"{o:0{_MEMORY_INDEX_FIELD_W}d}" for o in offsets]
    return ",".join(parts)


def empty_index_line() -> str:
    """An all-empty index line (no memories)."""
    return _index_line(0, 0, [0] * MEMORY_INDEX_SLOTS)


def parse_index_line(line: str) -> tuple[int, int, list[int]] | None:
    """Parse an index line → (count, head, offsets). None = not an index line
    or corrupt (callers fall back to the legacy [memories] scan)."""
    if not line.startswith(_MEMORY_INDEX_PREFIX):
        return None
    fields = line.strip().split(",")
    if len(fields) != 3 + MEMORY_INDEX_SLOTS or fields[0] != _MEMORY_INDEX_PREFIX:
        return None  # exact prefix: "memory_index=ZZ,..." must NOT parse
    try:
        count = int(fields[1])
        head = int(fields[2])
        offsets = [int(x) for x in fields[3:]]
    except ValueError:
        return None
    if not (0 <= count <= MEMORY_INDEX_SLOTS and 0 <= head < MEMORY_INDEX_SLOTS):
        return None
    return count, head, offsets


def ring_add(count: int, head: int, offsets: list[int], off: int) -> tuple[int, int]:
    """Push a new offset into the ring (FIFO: evict the oldest when full).
    Returns the new (count, head)."""
    if count < MEMORY_INDEX_SLOTS:
        offsets[(head + count) % MEMORY_INDEX_SLOTS] = off
        return count + 1, head
    offsets[head] = off
    return count, (head + 1) % MEMORY_INDEX_SLOTS


def ring_items(count: int, head: int, offsets: list[int]) -> list[int]:
    """Valid offsets in FIFO order (oldest first)."""
    return [offsets[(head + i) % MEMORY_INDEX_SLOTS] for i in range(count)]


def index_line_from_offsets(hits: list[int]) -> str:
    """Build an index line from memory-line offsets in file order (the most
    recent MEMORY_INDEX_SLOTS survive, oldest first in the ring)."""
    take = hits[-MEMORY_INDEX_SLOTS:]
    return _index_line(len(take), 0, take + [0] * (MEMORY_INDEX_SLOTS - len(take)))


@dataclass
class Memory:
    title: str
    content: str
    updated: float = field(default_factory=time.time)


def _to_line(m: Memory) -> str:
    return json.dumps({"title": m.title, "content": m.content, "updated": m.updated}, ensure_ascii=False)


class MemoryStore:
    """In-memory view of the project's memories + persistence to the .clc.

    ``writer(path, line)`` appends one line (local open or the remote exec
    bridge); None = local append. ``index_offset`` is the absolute byte offset
    of the header's fixed-width memory index line (None = legacy file without
    one): saves then append the memory line and update the index IN PLACE via
    the workspace's read_range/size/write_at, keeping memory lookup O(1).
    """

    def __init__(
        self,
        path: str,
        writer: Callable[[str, str], None] | None = None,
        items: dict[str, Memory] | None = None,
        index_offset: int | None = None,
        workspace=None,
        log=None,
    ) -> None:
        self._path = path
        self._writer = writer
        self._workspace = workspace
        self._items: dict[str, Memory] = items or {}
        self._section_written = bool(items)  # a loaded section already exists
        self._index_offset = index_offset
        # the project's LazyEventLog: appends count bytes into the log (keeps
        # event offsets and the window boundary exact); None before open
        self._log = log

    def items(self) -> dict[str, Memory]:
        return dict(self._items)

    def get(self, title: str) -> Memory | None:
        return self._items.get(title)

    def search(self, query: str) -> list[Memory]:
        q = query.lower()
        return [m for m in self._items.values() if q in m.title.lower() or q in m.content.lower()]

    def save(self, title: str, content: str) -> Memory:
        m = Memory(title=title, content=content)
        if not self._section_written:
            # keep the [memories] section marker for diagnostics and as the
            # legacy scan fallback's anchor (written once, like before)
            self._append(SECTION)
            self._note_bytes(len(SECTION) + 1)
            self._section_written = True
        if self._index_offset is not None:
            parsed = self._read_index()
            if parsed is not None:
                count, head, offsets = parsed
                if title not in self._items and len(self._items) >= MEMORY_INDEX_SLOTS:
                    # mirror the disk ring's FIFO eviction: drop the oldest
                    # resident entry (dict insertion order == index order)
                    del self._items[next(iter(self._items))]
                off = self._file_size()
                line = _to_line(m)
                self._append(line)
                self._note_bytes(len(line) + 1)
                count, head = ring_add(count, head, offsets, off)
                self._write_at(self._index_offset, _index_line(count, head, offsets).encode("ascii"))
                self._items[title] = m
                return m
            # corrupt index line: fall through to the plain append path (the
            # migration script rebuilds a stale index on the next conversion)
        line = _to_line(m)
        self._append(line)
        self._note_bytes(len(line) + 1)
        self._items[title] = m
        return m

    def _note_bytes(self, n: int) -> None:
        """Tell the project's log that ``n`` file bytes were appended by a
        memory write, so its on-disk-size bookkeeping stays exact (see
        LazyEventLog.note_bytes_written)."""
        if self._log is not None:
            self._log.note_bytes_written(n)

    # -- index I/O -----------------------------------------------------------

    def _read_index(self) -> tuple[int, int, list[int]] | None:
        raw = self._read_range(self._index_offset, self._index_offset + _MEMORY_INDEX_LINE_W + 1)
        return parse_index_line(raw.decode("utf-8", "replace"))

    def _read_range(self, lo: int, hi: int) -> bytes:
        if self._workspace is not None:
            return self._workspace.read_range(self._path, lo, hi)
        with open(self._path, "rb") as f:
            f.seek(lo)
            return f.read(hi - lo)

    def _file_size(self) -> int:
        if self._workspace is not None:
            return self._workspace.size(self._path)
        return os.path.getsize(self._path)

    def _write_at(self, offset: int, data: bytes) -> None:
        if self._workspace is not None:
            self._workspace.write_at(self._path, offset, data)
        else:
            with open(self._path, "r+b") as f:
                f.seek(offset)
                f.write(data)

    # -- construction --------------------------------------------------------

    @classmethod
    def from_index(
        cls,
        path: str,
        reader,
        total: int,
        writer: Callable[[str, str], None] | None,
        index_offset: int,
        count: int,
        head: int,
        offsets: list[int],
        workspace=None,
        log=None,
    ) -> "MemoryStore":
        """Load memories by range-reading exactly the indexed lines (O(1): the
        header index points straight at each line, no section scan)."""
        items: dict[str, Memory] = {}
        for off in ring_items(count, head, offsets):
            if off <= 0:
                continue
            raw = reader(off, min(off + _MEMORY_READ_CHUNK, total))
            line = raw.split(b"\n", 1)[0].decode("utf-8", "replace")
            try:
                d: dict[str, Any] = json.loads(line)
                items[d["title"]] = Memory(d["title"], d.get("content", ""), d.get("updated", 0))
            except (ValueError, KeyError, TypeError):
                continue
        return cls(path, writer=writer, items=items, index_offset=index_offset, workspace=workspace, log=log)

    def _append(self, line: str) -> None:
        append_jsonl(self._path, line, self._writer)

    @classmethod
    def parse(
        cls,
        raw_lines: list[str],
        path: str,
        writer: Callable[[str, str], None] | None = None,
        workspace=None,
        log=None,
    ) -> "MemoryStore":
        """Loader for a [memories] section scan: parse memory lines out of the
        raw text (used for files without a header index and as the corrupt-index
        fallback)."""
        items: dict[str, Memory] = {}
        for line in raw_lines:
            line = line.strip()
            if not line:
                continue
            try:
                d: dict[str, Any] = json.loads(line)
                items[d["title"]] = Memory(d["title"], d.get("content", ""), d.get("updated", 0))
            except (ValueError, KeyError, TypeError):
                continue
        return cls(path, writer=writer, items=items, workspace=workspace, log=log)
