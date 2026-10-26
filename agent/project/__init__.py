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

This package is the module's public face as well as its lifecycle: creating and
opening a .clc, and the lock that makes the window which opened it the only
writer. What the file's BYTES are — the header layout, the fixed-width
cpr_start line at its stable offset, the event region's boundary — lives in
format.py, and every name the host calls is re-exported here:
`project.<name>` is the handle the rest of the host uses (agent/core/lazy.py
imports `_last_compaction_rel` from here, late).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..core.lazy import LazyEventLog, _make_reader
from ..core.project_lock import LockHandle, ProjectLock, ProjectOpenConflict
from .format import (
    _CPR_START_LINE_W,
    ProjectMeta,
    _cpr_line_offset,
    _event_region_start,
    _find_cpr_line,
    _header_text,
    _last_compaction_rel,
    _make_write_at,
    _parse_cpr_start,
    _parse_meta_lines,
    _read_line_at,
    _write_header,
)


@dataclass
class Project:
    path: Path
    meta: ProjectMeta = field(default_factory=ProjectMeta)
    log: LazyEventLog = field(default_factory=LazyEventLog.in_memory)
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
    degradation layer) the file is written on the remote host.

    A created project is opened for WRITE like any other, so it takes the same
    exclusive lock — BEFORE the header lands: from its first byte the file
    belongs to the window that created it. Without that lock the brand-new .clc
    is a writable project nobody claims, and a second window opening it for write
    would append to it concurrently with its creator (the one writer the lock
    exists to prevent). Raises ProjectOpenConflict when another window already
    holds the path (it has that .clc open, or created it first)."""
    path = path.with_suffix(".clc")
    lock = _acquire_lock(path, read_only=False)
    try:
        return _create_project_locked(path, name, model, workspace, lock)
    except Exception:
        ProjectLock.release(lock)
        raise


def _create_project_locked(path: Path, name: str, model: str, workspace, lock: LockHandle) -> Project:
    meta = ProjectMeta(name=name, model=model)
    writer = _writer_for(workspace)
    if workspace is not None:
        workspace.write(str(path), _header_text(meta))
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_header(path, meta)
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
    return Project(path=path, meta=meta, log=log, lock=lock)


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
    # one reader covers the header + the log (nothing below rewrites the file)
    # the header lives at the very start of the file: a tiny range read
    head = read(0, min(total, 1 << 16))
    meta = _parse_meta_lines(head.decode("utf-8", "replace").splitlines())
    base = _event_region_start(head)  # first durable line; header-only files: right after the separator
    # cpr_start comes from the header's fixed-width line; stale values clamp to 0
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
    if on_progress is not None:
        on_progress(total, total)
        # runtime paging reads must not fire the open-progress callbacks
        log._read = raw_read
    return Project(path=path, meta=meta, log=log, read_only=read_only, lock=lock)


__all__ = [
    # the model of an open .clc
    "Project",
    "ProjectMeta",
    # the lifecycle
    "create_project",
    "open_project_lazy",
    # format.py's own, re-exported because agent/core/lazy.py imports it by this
    # name (a late import inside the open, so the module-level cycle
    # project -> core.lazy -> project never closes)
    "_last_compaction_rel",
]

