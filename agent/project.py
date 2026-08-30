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
import os
from dataclasses import dataclass, field
from pathlib import Path

from .events import DURABLE_TYPES, EventLog, event_from_dict, event_to_json
from .core.project_lock import LockHandle, ProjectLock, ProjectOpenConflict
from .memory import SECTION, MemoryStore
from .tools.workspace import _REMOTE_IO_TIMEOUT, shq

HEADER_PREFIX = "# clutch project v1"
SEPARATOR = "---"


@dataclass
class ProjectMeta:
    name: str = ""
    model: str = ""


@dataclass
class Project:
    path: Path
    meta: ProjectMeta = field(default_factory=ProjectMeta)
    log: EventLog = field(default_factory=EventLog)
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


def _acquire_lock(path: Path, workspace, read_only: bool) -> LockHandle | None:
    """Take the write lock unless read-only. Raises ProjectOpenConflict when
    another window holds it."""
    if read_only:
        return None
    lock = ProjectLock.acquire(str(path), workspace)
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
    # EventLog(path=..., writer=None) persists every append to the .clc file
    # after the header via the local open fallback
    log = EventLog(path=str(path), writer=writer)
    return Project(path=path, meta=meta, log=log, memories=MemoryStore(str(path), writer=writer))


def open_project(path: Path, on_progress=None, workspace=None, read_only: bool = False) -> Project:
    """Load an existing .clc file. on_progress(done, total) is called as the
    file is parsed (byte-based, single pass). With a workspace the file is
    pulled from the remote host and the log persists back through it.
    read_only opens without the write lock: the log keeps no-op appends and
    legacy rewrites are skipped, so the file is never modified."""
    path = path.with_suffix(".clc")
    lock = _acquire_lock(path, workspace, read_only)
    try:
        meta, loaded, memory_lines = _read_file(path, on_progress, workspace)
    except Exception:
        ProjectLock.release(lock)
        raise
    writer = _writer_for(workspace, read_only)
    memories = MemoryStore.parse(memory_lines, str(path), writer=writer)
    # older files stored streaming deltas (text/reasoning) that are redundant for
    # replay and context — assistant_message carries the final text + reasoning.
    # Compact them away so the .clc stays small and future loads stay fast.
    durable = [e for e in loaded.events() if e.type in DURABLE_TYPES]
    if not read_only and len(durable) != len(loaded.events()):
        _rewrite_durable(path, meta, durable, workspace, memories)
    # EventLog(path=..., writer=None) persists every append to the .clc file
    # after the header via the local open fallback
    log = EventLog(path=str(path), writer=writer)
    log._events.extend(durable)
    return Project(path=path, meta=meta, log=log, memories=memories, read_only=read_only, lock=lock)


def open_project_lazy(path: Path, on_progress=None, workspace=None, read_only: bool = False) -> Project:
    """Open an existing .clc lazily: read only the header, the raw task and the
    preserved recent tail the last compaction kept (everything at or after its
    stored byte ``tail_start``). Earlier records stay on disk and are pulled in
    on demand (UI paging via /api/history, compaction head re-materialization).

    Small histories and compaction-free files fall back to a plain fully-loaded
    EventLog — byte-identical behavior to open_project. No index scan anywhere:
    the tail boundary comes straight from the last compaction's persisted byte
    offset, found by a short backward read from the file tail.
    """
    path = path.with_suffix(".clc")
    lock = _acquire_lock(path, workspace, read_only)
    try:
        return _open_project_lazy_locked(path, on_progress, workspace, read_only, lock)
    except Exception:
        ProjectLock.release(lock)
        raise


def _open_project_lazy_locked(path, on_progress, workspace, read_only, lock) -> Project:
    from .core.lazy import (
        LazyEventLog,
        _LAZY_MIN_BYTES,
        _make_reader,
        _tail_scan,
        parse_durable,
    )

    read, total = _make_reader(path, workspace)
    # the header lives at the very start of the file: a tiny range read, no
    # separate full pass (unlike read_header, which would double the remote cost)
    head = read(0, min(total, 1 << 16)).decode("utf-8", "replace")
    meta = _parse_meta_lines(head.splitlines())
    base = _event_region_start(head)  # raw task's line start (absolute); None = no events
    writer = _writer_for(workspace, read_only)
    if base is None:
        memories = MemoryStore(str(path), writer=writer)
        log = EventLog(path=str(path), writer=writer)
        return Project(path=path, meta=meta, log=log, memories=memories, read_only=read_only, lock=lock)

    # the last compaction's stored tail_start + the [memories] section: both
    # found by scanning BACKWARD from the file tail (no index)
    comp, mem_off = _tail_scan(read, total)
    if mem_off is not None:
        mem_text = read(mem_off, total).decode("utf-8", "replace")
        memories = MemoryStore.parse(mem_text.splitlines(), str(path), writer=writer)
    else:
        memories = MemoryStore(str(path), writer=writer)

    if comp is None or total - base < _LAZY_MIN_BYTES:
        # nothing to be lazy about: plain read + durable parse, same as open_project
        log = EventLog(path=str(path), writer=writer)
        for ev in parse_durable(read(0, total).decode("utf-8", "replace")):
            log.append(ev)
        return Project(path=path, meta=meta, log=log, memories=memories, read_only=read_only, lock=lock)

    comp_off_abs, comp_ev = comp
    tail_rel = comp_ev.tail_start
    comp_rel = comp_off_abs - base
    if not 0 <= tail_rel <= comp_rel:
        tail_rel = comp_rel  # stale/out-of-range: keep the compaction (its summary) visible
    log = LazyEventLog(str(path), read, total, base, writer=writer, tail_start=tail_rel)
    return Project(path=path, meta=meta, log=log, memories=memories, read_only=read_only, lock=lock)


def _event_region_start(head: str) -> int | None:
    """Absolute byte offset of the first durable event line in the header read
    (the event region start — the raw task). None when the file has no events."""
    pos = 0
    for line in head.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith(SEPARATOR) or stripped.startswith(SECTION):
            pos += len(line) + 1
            continue
        try:
            data = json.loads(line)
        except (ValueError, TypeError, json.JSONDecodeError):
            pos += len(line) + 1
            continue
        if isinstance(data, dict) and data.get("type") in DURABLE_TYPES:
            return pos
        pos += len(line) + 1
    return None


def _parse_meta_lines(lines: list[str]) -> ProjectMeta:
    """Parse header lines (up to the --- separator) into ProjectMeta."""
    meta = ProjectMeta()
    for line in lines:
        line = line.strip()
        if line == SEPARATOR:
            break
        _apply_meta(meta, line)
    return meta


def read_header(path: Path, workspace=None) -> ProjectMeta:
    """Read only the header of a .clc file (up to the --- separator), fast."""
    path = path.with_suffix(".clc")
    meta = ProjectMeta()
    if workspace is not None:
        lines = workspace.read(str(path)).splitlines()
    else:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    for line in lines:
        line = line.rstrip("\n")
        if line.strip() == SEPARATOR:
            break
        _apply_meta(meta, line)
    return meta


def _header_text(meta: ProjectMeta) -> str:
    return (
        "\n".join(
            [
                HEADER_PREFIX,
                f"name: {meta.name}",
                f"model: {meta.model or ''}",
                SEPARATOR,
            ]
        )
        + "\n"
    )


def _write_header(path: Path, meta: ProjectMeta) -> None:
    path.write_text(_header_text(meta), encoding="utf-8")


def _rewrite_durable(
    path: Path, meta: ProjectMeta, events: list, workspace=None, memories: MemoryStore | None = None
) -> None:
    """Atomically rewrite the .clc keeping only durable block events (and the
    [memories] section). A crash mid-write must not leave a truncated file, so
    write a tmp then swap it in. With a workspace the tmp+mv happen on the host."""
    body = "".join(event_to_json(ev) + "\n" for ev in events)
    memories_text = memories.serialize() if memories is not None else ""
    content = _header_text(meta) + body + memories_text
    if workspace is not None:
        tmp = str(path) + ".tmp"
        workspace.write(tmp, content)
        workspace.run(f"mv -f {shq(tmp)} {shq(str(path))}", _REMOTE_IO_TIMEOUT)
        return
    tmp = path.with_suffix(".clc.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


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


def _read_file(path: Path, on_progress=None, workspace=None) -> tuple[ProjectMeta, EventLog, list[str]]:
    meta = ProjectMeta()
    log = EventLog()
    memory_lines: list[str] = []
    in_events = False
    in_memories = False

    def parse(line: str) -> None:
        nonlocal in_events, in_memories
        stripped = line.strip()
        if in_memories:
            memory_lines.append(line)
            return
        if not in_events:
            if stripped == SEPARATOR:
                in_events = True
                return
            _apply_meta(meta, line)
            return
        if stripped == SECTION:
            in_memories = True
            return
        if stripped:
            # every line occupies bytes in the file (transients included), so
            # the running byte offset advances per line — a durable event's
            # offset is its line start, matching the lazy log's file-based
            # offsets (a .clc written today has no transients, so appends and
            # loads agree; an older file with deltas stays consistent too)
            try:
                ev = event_from_dict(json.loads(line))
                log._events.append(ev)
                if ev.type in DURABLE_TYPES:
                    log._offsets.append(log._running)
            except ValueError:
                pass  # skip corrupt lines; keep the rest of the history
            log._running += len(line.encode("utf-8")) + 1

    if workspace is not None:
        # remote: one workspace.read round trip; progress counted in chars
        text = workspace.read(str(path))
        total = len(text) or 1
        consumed = 0
        last_pct = -1
        for line in text.splitlines():
            consumed += len(line) + 1
            pct = consumed * 100 // total
            if on_progress and pct != last_pct:
                last_pct = pct
                on_progress(consumed, total)
            parse(line)
        return meta, log, memory_lines

    total = path.stat().st_size or 1
    consumed = 0
    last_pct = -1
    with open(path, encoding="utf-8") as f:
        for line in f:
            consumed += len(line)
            # throttle: at most one progress line per whole percent — a per-line
            # callback on a 10k-line log would flood the UI with setPct updates
            pct = consumed * 100 // total
            if on_progress and pct != last_pct:
                last_pct = pct
                on_progress(consumed, total)
            parse(line.rstrip("\n"))
    return meta, log, memory_lines
