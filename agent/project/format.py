"""The .clc byte format: the header layout, its fixed-width lines, the event region.

A .clc is byte-addressed, not line-addressed. The header is `HEADER_PREFIX` /
name / model / cpr_start / memory index / `SEPARATOR`, and its last two lines are
FIXED-WIDTH — `cpr_start=0000000000` (the window start, relative to the event
region) and the memory index — so their absolute offsets are the same in every
file and a compaction updates the window start with ONE in-place write
(_make_write_at) instead of rewriting the file.

Everything here either builds those lines (_header_text, _write_header,
_cpr_line_offset, _index_line_offset) or finds things by byte offset in a header
read that never touches the rest of the file: the index line, the cpr_start line,
the event region's first durable line, and — for a legacy file with no cpr_start —
the newest compaction line (_last_compaction_rel: the boundary the migration
script writes into the header, and the one name agent/core/lazy.py imports from
the package).

No open, no lock, no memory store: the lifecycle that uses all of this is
__init__.py.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..events import DURABLE_TYPES
from ..memory import SECTION, empty_index_line

HEADER_PREFIX = "# clutch project v1"
SEPARATOR = "---"

# the window start lives in a fixed-width header line so a compaction updates it
# with one in-place write (stable offsets). 10 digits = ~10 GB of event region.
_CPR_START_PREFIX = "cpr_start="
_CPR_START_FIELD_W = 10
_CPR_START_LINE_W = len(_CPR_START_PREFIX) + _CPR_START_FIELD_W  # 20 bytes
_CPR_START_LINE_BYTES = _CPR_START_LINE_W + 1  # + newline = 21


@dataclass
class ProjectMeta:
    name: str = ""
    model: str = ""


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
        except ValueError:
            pos += len(seg) + 1
            continue
        if isinstance(data, dict) and data.get("type") in DURABLE_TYPES:
            return pos
        pos += len(seg) + 1
    # header-only file: the event region starts after the separator (rfind keeps this exact)
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
    # newline="\n": the header is BYTE-addressed (the fixed-width cpr_start /
    # index lines are located by offset). Windows text mode would write \r\n and
    # push every modeled offset one byte short per line, so an in-place
    # cpr_start/index update would overwrite the wrong bytes.
    path.write_text(_header_text(meta), encoding="utf-8", newline="\n")


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
