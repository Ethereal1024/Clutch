"""Project file (.clc) handling.

A clutch project is a single .clc file that holds the conversation
history. The working directory is the directory containing the .clc file.

Format:
    # clutch project v1
    name: my-app
    model: deepseek-v4-flash
    ---
    <JSONL events follow>

The header is a few key: value lines before the `---` separator; everything
after is one JSON event per line.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .core.lazy import LazyEventLog, _make_reader
from .core.project_lock import LockHandle, ProjectLock, ProjectOpenConflict
from .events import DURABLE_TYPES
from .memory import (
    SECTION,
    MemoryStore,
    empty_index_line,
    parse_index_line,
)

HEADER_PREFIX = "# clutch project v1"
SEPARATOR = "---"

# the window start (the newest compaction line's offset, relative to the event
# region) lives in a fixed-width header line so a compaction can update it with
# one in-place write (stable offsets for the file's lifetime). 10 digits = up
# to ~10 GB of event region — far beyond any real .clc.
_CPR_START_PREFIX = "cpr_start="
_CPR_START_FIELD_W = 10
_CPR_START_LINE_W = len(_CPR_START_PREFIX) + _CPR_START_FIELD_W  # 20 bytes
_CPR_START_LINE_BYTES = _CPR_START_LINE_W + 1  # + newline = 21


@dataclass
class ProjectMeta:
    name: str = ""
    model: str = ""


@dataclass
class Project:
    path: Path
    meta: ProjectMeta = field(default_factory=ProjectMeta)
    log: LazyEventLog = field(default_factory=LazyEventLog.in_memory)
    memories: MemoryStore | None = None
    read_only: bool = False
    # the write lock held on this .clc (None for read-only opens): the window
    # that opened the project for write is the only writer until it exits
    lock: LockHandle | None = None

    @property
    def workdir(self) -> Path:
        return self.path.parent

    def events(self):
        return self.log.events()


def _writer_for(workspace, read_only: bool = False) -> Callable[[str, str], None] | None:
    """The .clc LineWriter for a workspace (remote bridge) or None (local open).

    read_only swaps in a no-op writer: appends are dropped silently, so a
    read-only project can never rewrite the file (compaction rewrites included),
    while reads behave exactly like a normal open."""
    if read_only:
        return lambda path, line: None
    return workspace.append_line if workspace is not None else None


def _acquire_lock(path: Path, read_only: bool) -> LockHandle | None:
    """Take the write lock unless read-only. Raises ProjectOpenConflict when
    another window holds it."""
    if read_only:
        return None
    lock = ProjectLock.acquire(str(path))
    if lock is None:
        raise ProjectOpenConflict(str(path))
    return lock


def create_project(path: Path, name: str, model: str = "", workspace=None) -> Project:
    """Create a new .clc file and return the Project. With a workspace (SSH
    degradation layer) the file is written on the remote host."""
    path = path.with_suffix(".clc")
    meta = ProjectMeta(name=name, model=model)
    writer = _writer_for(workspace)
    if workspace is not None:
        workspace.write(str(path), _header_text(meta))
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_header(path, meta)
    index_off = _index_line_offset(meta)
    # every project opens as a lazy log (one code path for every file size):
    # a fresh file's event region is empty and starts right after the separator
    read, total = _make_reader(path, workspace)
    base = _event_region_start(_header_text(meta).encode("utf-8"))
    log = LazyEventLog(
        str(path),
        read,
        total,
        base,
        writer=writer,
        cpr_start=0,
        cpr_line_off=_cpr_line_offset(meta),
        write_at=_make_write_at(path, workspace),
    )
    memories = MemoryStore(str(path), writer=writer, index_offset=index_off, workspace=workspace, log=log)
    return Project(path=path, meta=meta, log=log, memories=memories)


def open_project_lazy(path: Path, on_progress=None, workspace=None, read_only: bool = False) -> Project:
    """Open an existing .clc lazily: read only the header and the model WINDOW —
    everything at or after the newest compaction line (its start is persisted as
    ``cpr_start`` in the header, so the boundary is one header read, no scan).
    Nothing else is resident: earlier records (already-summarized history, the
    raw task included) stay on disk and are pulled in ONLY by the UI's scroll-up
    paging (/api/history), which never touches the resident log: history
    browsing is fully decoupled from the model context.

    Every file goes through this one path: a compaction-free (or tiny) file
    simply has cpr_start 0, so the whole event region materializes at open. A
    file with no cpr_start header line behaves the same (cpr_start 0 — full
    window): legacy .clc files are converted to the header format by the
    migration script, never by the open itself.
    """
    path = path.with_suffix(".clc")
    lock = _acquire_lock(path, read_only)
    try:
        return _open_project_lazy_locked(path, on_progress, workspace, read_only, lock)
    except Exception:
        ProjectLock.release(lock)
        raise


def _wrap_progress(raw_read, total, on_progress):
    """Progress-reporting reader wrapper: the open reads only a few ranges
    (header, window), but on a compaction-free file the window IS the whole
    file, so opening is not instant: report progress per percent of bytes
    pulled (same throttle policy as the old per-line full parse)."""
    if on_progress is None:
        return raw_read
    seen = [-1]

    def read(lo: int, hi: int) -> bytes:
        data = raw_read(lo, hi)
        pct = min(hi, total) * 100 // (total or 1)
        if pct > seen[0]:
            seen[0] = pct
            on_progress(min(hi, total), total)
        return data

    return read


def _open_project_lazy_locked(path, on_progress, workspace, read_only, lock) -> Project:
    writer = _writer_for(workspace, read_only)
    raw_read, total = _make_reader(path, workspace)
    read = raw_read
    if on_progress is not None:
        read = _wrap_progress(raw_read, total, on_progress)
    # nothing below rewrites the file (legacy conversion is the migration
    # script's job), so one reader covers the memories load, the header and the
    # log
    memories = _load_memories(path, read, total, writer, workspace)
    # the header lives at the very start of the file: a tiny range read
    head = read(0, min(total, 1 << 16))
    meta = _parse_meta_lines(head.decode("utf-8", "replace").splitlines())
    base = _event_region_start(head)  # first durable line; header-only files: right after the separator
    # the window start (cpr_start) comes from the header's fixed-width line —
    # no scan, no index. A stale/out-of-range value clamps to 0 (everything
    # loads; a compaction's summary is never lost).
    cpr_line_off = _find_cpr_line(head)
    cpr_rel = (
        _parse_cpr_start(_read_line_at(read, cpr_line_off, total, _CPR_START_LINE_W))
        if cpr_line_off is not None
        else 0
    )
    log = LazyEventLog(
        str(path),
        read,
        total,
        base,
        writer=writer,
        cpr_start=cpr_rel,
        cpr_line_off=cpr_line_off or 0,
        write_at=None if read_only else _make_write_at(path, workspace),
    )
    # the MemoryStore appends memory lines to the same file; count those bytes
    # into the log so event offsets and the persisted window boundary stay exact
    memories._log = log
    if on_progress is not None:
        on_progress(total, total)
        # runtime paging reads must not fire the open-progress callbacks
        log._read = raw_read
    return Project(path=path, meta=meta, log=log, memories=memories, read_only=read_only, lock=lock)


def _event_region_start(head: bytes) -> int:
    """Absolute byte offset of the event region start in a header read: the
    first durable event line (the raw task in a never-compacted file), or —
    for a header-only file — the byte position right after the separator where
    the first event will land."""
    pos = 0
    for seg in head.split(b"\n"):
        stripped = seg.strip()
        if not stripped or stripped.startswith(SEPARATOR.encode()) or stripped.startswith(SECTION.encode()):
            pos += len(seg) + 1
            continue
        try:
            data = json.loads(seg.decode("utf-8", "replace"))
        except (ValueError, TypeError, json.JSONDecodeError):
            pos += len(seg) + 1
            continue
        if isinstance(data, dict) and data.get("type") in DURABLE_TYPES:
            return pos
        pos += len(seg) + 1
    # header-only file (no durable line yet): the event region starts right
    # after the separator — rfind keeps this exact even when the trailing
    # newline split produced a phantom empty segment (pos would overcount +1)
    sep = head.rfind(SEPARATOR.encode())
    if sep >= 0:
        return sep + len(SEPARATOR) + 1
    return pos


def _find_index_line(head: bytes) -> int | None:
    """Absolute byte offset of the header's memory index line in a header read
    (None = legacy .clc without one)."""
    pos = 0
    for seg in head.split(b"\n"):
        if seg.startswith(b"memory_index="):
            return pos
        pos += len(seg) + 1
    return None


def _find_cpr_line(head: bytes) -> int | None:
    """Absolute byte offset of the header's cpr_start line in a header read
    (None = a file without one; the open then treats the whole event region as
    the window — the migration script converts such files)."""
    pos = 0
    for seg in head.split(b"\n"):
        if seg.startswith(_CPR_START_PREFIX.encode()):
            return pos
        pos += len(seg) + 1
    return None


def _parse_cpr_start(line: str) -> int:
    """Parse a cpr_start header line → the window-start byte offset (relative
    to the event region). 0 for a missing/malformed value (full load)."""
    if not line.startswith(_CPR_START_PREFIX):
        return 0
    v = line[len(_CPR_START_PREFIX) :].strip()
    try:
        return int(v)
    except ValueError:
        return 0


def _last_compaction_rel(raw: bytes, base: int) -> int:
    """Relative byte offset of the LAST compaction line in the event region
    (0 when the file has never been compacted). Scans raw .clc bytes for
    ``{"type": "compaction"`` line starts — the boundary a migrated file's
    cpr_start must point at. Shared by the migration script and tests."""
    last = 0
    pos = 0
    for seg in raw.split(b"\n"):
        if seg.lstrip().startswith(b'{"type": "compaction"'):
            off = pos - base
            if off >= 0:
                last = off
        pos += len(seg) + 1
    return last


def _make_write_at(path, workspace):
    """In-place writer for the header's fixed-width cpr_start line (the
    compaction's window-start update): local seek+write, or the workspace's
    write_at (local/remote exec). None only when the project is read-only."""
    if workspace is not None:
        return lambda off, data: workspace.write_at(str(path), off, data)

    def write_at(off: int, data: bytes) -> None:
        with open(path, "r+b") as f:
            f.seek(off)
            f.write(data)

    return write_at


def _read_line_at(read, off: int, total: int, width: int) -> str:
    """Read the single line starting at byte offset ``off`` (a fixed-width
    header line: at most ``width`` bytes, never past the file end)."""
    raw = read(off, min(off + width + 4, total))
    return raw.split(b"\n", 1)[0].decode("utf-8", "replace")


def _load_memories(path, read, total, writer, workspace) -> MemoryStore:
    """Build the MemoryStore for an open: read the header index line and
    range-read exactly the indexed memory lines when present (O(1) in the file
    size — the distance from the first memory to the tail no longer matters);
    the [memories] section scan as the no-index / corrupt-index fallback. No
    runtime migration: legacy .clc files are converted by the migration script,
    so a file without an index line stays as-is (memories still load via scan)."""
    from .memory import _MEMORY_INDEX_LINE_W

    head = read(0, min(total, 1 << 16))
    index_off = _find_index_line(head)
    if index_off is not None:
        parsed = parse_index_line(_read_line_at(read, index_off, total, _MEMORY_INDEX_LINE_W))
        if parsed is not None:
            count, h, offs = parsed
            return MemoryStore.from_index(str(path), read, total, writer, index_off, count, h, offs, workspace)
    # no usable index: fall back to scanning the [memories] section
    mem_off = _find_memories_section(read, total)
    if mem_off is not None:
        mem_text = read(mem_off, total).decode("utf-8", "replace")
        return MemoryStore.parse(mem_text.splitlines(), str(path), writer=writer, workspace=workspace)
    return MemoryStore(str(path), writer=writer, workspace=workspace)


def _find_memories_section(read, total) -> int | None:
    """Absolute offset of the [memories] section marker, or None. Forward scan
    of the raw bytes — the section sits after the event region, and the marker
    never appears inside an event line (JSON escapes it). Only reached for
    read-only opens of legacy files whose memory index is absent."""
    if total <= 0:
        return None
    i = read(0, total).find(SECTION.encode())
    return i if i >= 0 else None


def _parse_meta_lines(lines: list[str]) -> ProjectMeta:
    """Parse header lines (up to the --- separator) into ProjectMeta."""
    meta = ProjectMeta()
    for line in lines:
        line = line.strip()
        if line == SEPARATOR:
            break
        _apply_meta(meta, line)
    return meta
def _header_text(meta: ProjectMeta, index_line: str | None = None, cpr_start: int = 0) -> str:
    """Header for a NEW .clc: meta lines + the fixed-width cpr_start line
    (window start; 0 = everything) + the fixed-width memory index line (empty
    by default) + the event-region separator. Both index lines are always
    present at a fixed width, so their absolute offsets are stable for the
    file's lifetime (the event region's relative offsets never shift)."""
    if index_line is None:
        index_line = empty_index_line()
    return (
        "\n".join(
            [
                HEADER_PREFIX,
                f"name: {meta.name}",
                f"model: {meta.model or ''}",
                f"{_CPR_START_PREFIX}{cpr_start:0{_CPR_START_FIELD_W}d}",
                index_line,
                SEPARATOR,
            ]
        )
        + "\n"
    )


def _cpr_line_offset(meta: ProjectMeta) -> int:
    """Absolute offset of the header's cpr_start line (fixed-width: 21 bytes
    with newline) — the compaction's in-place window-start write target."""
    return (
        len((HEADER_PREFIX + "\n").encode("utf-8"))
        + len((f"name: {meta.name}\n").encode("utf-8"))
        + len((f"model: {meta.model or ''}\n").encode("utf-8"))
    )


def _index_line_offset(meta: ProjectMeta) -> int:
    """Absolute byte offset of the memory index line in a freshly created .clc
    (header layout: prefix / name / model / cpr_start / index / separator)."""
    return _cpr_line_offset(meta) + _CPR_START_LINE_BYTES


def _write_header(path: Path, meta: ProjectMeta) -> None:
    path.write_text(_header_text(meta), encoding="utf-8")


def _apply_meta(meta: ProjectMeta, line: str) -> None:
    """Apply one header line to meta; ignore comments and malformed lines."""
    if line.startswith("#") or ":" not in line:
        return
    k, v = line.split(":", 1)
    k = k.strip()
    v = v.strip()
    if k == "name":
        meta.name = v
    elif k == "model":
        meta.model = v
