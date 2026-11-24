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
opening a .clc. The WRITE CLAIM that makes one session a project's only writer is
not taken here — it belongs to a run (agent/base.py RunState.claim_run), because
an open window that is idle writes nothing: appends only happen inside a turn.
What the file's BYTES are — the header layout, the fixed-width cpr_start line at
its stable offset, the event region's boundary — lives in format.py, and every
name the host calls is re-exported here:
`project.<name>` is the handle the rest of the host uses (agent/core/lazy.py
imports `_last_compaction_rel` from here, late).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..core.lazy import LazyEventLog, _make_reader, _make_size
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
    # An explicit "never write this file" open mode: a viewer of another
    # window's .clc (agent/api/events.py opens those read-only) and the test
    # fixtures that pin the refusal. An ordinary open is writable — the WRITE
    # CLAIM is the run's, not the open's, and it is taken from RunState when a
    # turn starts (agent/base.py claim_run), never here.
    read_only: bool = False

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
    """Take the write claim unless read-only. Raises ProjectOpenConflict when
    another session holds it. Used by CREATE only: see the module docstring."""
    if read_only:
        return None
    lock = ProjectLock.acquire(str(path))
    if lock is None:
        raise ProjectOpenConflict(str(path))
    return lock


class ProjectExists(Exception):
    """Create refused: a file is already at the target path.

    A create must never truncate a project. The file it would write over is a
    whole conversation, and both ways into a create reach this — the picker's
    Create button (a typed name, no stat) and the typed-path offer — so the
    existence answer has to come from the one place that writes: here, under
    the lock, before a byte is written."""

    def __init__(self, path: str) -> None:
        super().__init__(str(path))
        self.path = str(path)


def _refuse_existing(path: Path, workspace) -> None:
    """Raise ProjectExists when `path` is already a file in the backend that
    will be written to.

    The probe has to be the WRITER's own: a local create stats the path, a
    remote one asks the far shell (`size` is `wc -c`/getsize, O(1) metadata —
    no content moves), and "not there" is that backend's FileNotFoundError."""
    if workspace is None:
        if path.exists():
            raise ProjectExists(str(path))
        return
    try:
        workspace.size(str(path))
    except FileNotFoundError:
        return
    raise ProjectExists(str(path))


def create_project(path: Path, name: str, model: str = "", workspace=None) -> Project:
    """Create a new .clc file and return the Project. With a workspace (SSH
    degradation layer) the file is written on the remote host.

    The claim here covers the CREATE, and only the create: taking the lock makes
    "is this path free, and is this header the first thing in it" one atomic
    question, so two windows cannot create over each other and a create cannot
    land inside another session's run. It is handed straight back — the project
    it returns is idle, and an idle project holds no claim (the run does, when
    one starts). Raises ProjectOpenConflict when another session is running the
    path (or created it first), and ProjectExists when the path is already a file
    nobody is running — a create opens a new conversation, it never overwrites
    one."""
    path = path.with_suffix(".clc")
    # A path this window already holds comes back as the SAME handle (ProjectLock's
    # reuse branch), so "release what this create took" must not release that one:
    # the .clc being refused below may be the project this session is running, and
    # handing its claim to nobody is worse than the create failing.
    reused = ProjectLock.held(str(path))
    lock = _acquire_lock(path, read_only=False)
    try:
        _refuse_existing(path, workspace)
        project = _create_project_locked(path, name, model, workspace)
    except Exception:
        if not reused:
            ProjectLock.release(lock)
        raise
    if not reused:
        ProjectLock.release(lock)
    return project


def _create_project_locked(path: Path, name: str, model: str, workspace) -> Project:
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
        size=_make_size(path, workspace),
    )
    return Project(path=path, meta=meta, log=log)


def open_project_lazy(path: Path, on_progress=None, workspace=None, read_only: bool = False) -> Project:
    """Open an existing .clc lazily: read only the header and the model WINDOW —
    everything at or after the newest compaction line (its start is persisted as
    ``cpr_start`` in the header, so the boundary is one header read, no scan).
    Nothing else is resident: earlier records (already-summarized history, the
    raw task included) stay on disk and are pulled in ONLY by the UI's scroll-up
    paging (/api/history), which never touches the resident log: history
    browsing is fully decoupled from the model context.

    Opening takes NO lock. The claim that makes one session the file's only
    writer belongs to a RUN (RunState.claim_run), not to an open window: an idle
    project is unclaimed, so any number of windows may have it open, and the one
    that starts a turn takes the claim (409 run_active when somebody else is
    already running it). ``read_only`` is therefore an explicit mode — "never
    write this file" — not a fallback for a conflict.

    Every file goes through this one path: a compaction-free (or tiny) file
    simply has cpr_start 0, so the whole event region materializes at open. A
    file with no cpr_start header line behaves the same (cpr_start 0 — full
    window): legacy .clc files are converted to the header format by the
    migration script, never by the open itself.
    """
    path = path.with_suffix(".clc")
    return _open_project_lazy_locked(path, on_progress, workspace, read_only)


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


def _open_project_lazy_locked(path, on_progress, workspace, read_only) -> Project:
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
        size=_make_size(path, workspace),
    )
    if on_progress is not None:
        on_progress(total, total)
        # runtime paging reads must not fire the open-progress callbacks
        log._read = raw_read
    return Project(path=path, meta=meta, log=log, read_only=read_only)


__all__ = [
    # the model of an open .clc
    "Project",
    "ProjectMeta",
    # the lifecycle
    "create_project",
    "open_project_lazy",
    # a create's refusal of a path already taken (the one write that must not
    # happen: an existing .clc is a conversation, not a spare filename)
    "ProjectExists",
    # format.py's own, re-exported because agent/core/lazy.py imports it by this
    # name (a late import inside the open, so the module-level cycle
    # project -> core.lazy -> project never closes)
    "_last_compaction_rel",
]

