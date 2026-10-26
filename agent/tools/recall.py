"""Recall: the two host tools that read the session's own project log.

A .clc is ONE long-lived log per project, resumed across sessions, and the model
only ever sees the window since the newest compaction (core/lazy.py) — on a real
project that is a few percent of the file. Everything older is on disk and is
not lost: it is exactly where the durable facts of this project live (a
decision, a constraint, what an earlier session was asked). These two tools are
how the model reads it, and they are the whole memory story now: the component
that used to keep a SEPARATE list of titles and bodies is gone, because the log
already is that list — written as the conversation happens, never a second
thing to keep in sync.

The shape is the workspace's own: `grep_memory` is a grep (a pattern, a type
filter, a hit cap) and `read_memory` is a read (1-based lines, `offset`,
`limit`, a footer telling the next offset), because the model already knows how
to use those. What is different is the OUTPUT: a line of raw JSONL is ~1.6 KB
of escapes per event, so 100 hits would be ~40k tokens of noise. Both tools
project each line through events.event_text — the same rendering the compaction
summarizer reads — so a hit is one readable line and a page is a readable
transcript.

They are host tools, not a component's: the file they read is the one file this
host writes and protects (the same bytes the loop appends to), and reading it
back means using the reader the open already holds — a seek locally, one
byte-range read on a remote host. A component would have to be handed those
bytes over a second channel to say the same thing.

Both are read-only and side-effect free. The guard the rest of the surface runs
under — the project file is protected, not even a named read may touch it — is
deliberately inverted here: this IS that file, and it is the one file the agent
must be able to read.
"""

from __future__ import annotations

import fnmatch
import json
import posixpath
import re
import threading
import time
from collections import deque
from typing import Iterator, NamedTuple

from ..config import Config
from ..core.lazy import _SECTION, LazyEventLog
from ..events import DURABLE_TYPES, event_from_dict, event_text
from .envelope import Envelope
from .workspace import Workspace

# How much of the file one scan pulls at a time. A local read is a seek + read;
# a remote one is one byte-range exec, so a bigger chunk is a cheaper scan (a
# 30 MB log is 8 reads, not 30).
_CHUNK = 4 * 1024 * 1024

# One event's body in a `read_memory` page, and the page's own budget: enough
# for a turn to make sense, small enough that four pages never cost a context.
_EVENT_CHARS = 1200
_PAGE_CHARS = 16000

# A hit line shows the line of the event that MATCHED, clipped here.
_HIT_CHARS = 300


class Record(NamedTuple):
    """One readable line of the log: its 1-based number, its event type, when it
    happened, and its model-facing text."""

    line: int
    type: str
    stamp: str  # "MM-DD HH:MM", "" for a note an older build wrote
    text: str


# ------------------------------------------------------------------ the scan


def _record(lineno: int, raw: bytes) -> Record | None:
    """One raw line of the .clc → the line a reader sees, or None to skip it.

    Skipped: the header separator, blank lines, anything that is not JSON (a
    range cut mid-line, a corrupted tail), a JSON object that is not an event,
    and a non-durable event (a delta never reaches disk anyway). A memory line
    an older build wrote is kept — the fact it carries is as durable as any turn
    — and reads as a note.
    """
    line = raw.strip()
    if not line or line.startswith(b"---") or line.startswith(_SECTION.encode()):
        return None
    try:
        data = json.loads(line.decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if "type" in data:
        try:
            ev = event_from_dict(data)
        except (ValueError, TypeError):
            return None
        if ev.type not in DURABLE_TYPES:
            return None
        text = event_text(ev)
        stamp = time.strftime("%m-%d %H:%M", time.localtime(ev.timestamp or 0))
        return Record(lineno, ev.type, stamp, text) if text else None
    title = data.get("title")
    if isinstance(title, str) and title:
        content = data.get("content")
        body = content if isinstance(content, str) else ""
        return Record(lineno, "note", "", f"[Note] {title}: {body}")
    return None


def _scan(log: LazyEventLog, cancel: threading.Event | None = None) -> Iterator[Record]:
    """Every readable line of the WHOLE log, in file order, streamed from disk.

    One pass, chunk by chunk, so a 30 MB log costs the bytes it reads and never
    a copy in memory. Line numbers count what a reader SEES — the header is not
    part of the log and a blank or unreadable line is not a line — which is what
    makes `grep_memory`'s line numbers and `read_memory`'s `offset` the same
    numbering.
    """
    lo = log.event_start()
    end = log.file_bytes()
    lineno = 0
    carry = b""  # a line split by the chunk boundary
    while lo < end:
        if cancel is not None and cancel.is_set():
            return
        chunk = log.read_raw(lo, min(lo + _CHUNK, end))
        if not chunk:
            return  # the file shrank under us: nothing more to read
        lo += len(chunk)
        pieces = (carry + chunk).split(b"\n")
        carry = pieces.pop() if lo < end else b""
        for raw in pieces:
            rec = _record(lineno + 1, raw)
            if rec is not None:
                lineno = rec.line
                yield rec
    if carry:
        rec = _record(lineno + 1, carry)
        if rec is not None:
            yield rec


def _name(log: LazyEventLog) -> str:
    """The log's own file name (a remote path is not this machine's Path)."""
    return posixpath.basename(str(log.path).replace("\\", "/")) or "project log"


def _no_log() -> Envelope:
    return Envelope("ERROR: this session has no project log to read — no project is open.", error=True)


# --------------------------------------------------------------- grep_memory


def grep_memory(
    workspace: Workspace,
    config: Config,
    pattern: str = "",
    include: str | None = None,
    max_hits: int = 20,
    log: LazyEventLog | None = None,
    cancel: threading.Event | None = None,
) -> Envelope:
    """Find the lines of the project log that match a regular expression.

    `pattern` is a Python regex, matched MULTILINE against one event's readable
    text; `include` narrows by event type as a glob (`tool_*`, `compaction`,
    `note`, `user_message`); `max_hits` caps the hits, and the answer says when
    it stopped there. Read-only: the log is never written.
    """
    if log is None or not str(log.path):
        return _no_log()
    try:
        rx = re.compile(pattern, re.MULTILINE)
    except re.error as e:
        return Envelope(f"ERROR: {pattern!r} is not a valid regular expression: {e}", error=True)
    max_hits = max(1, min(int(max_hits or 20), 200))
    hits: list[str] = []
    scanned = 0
    stopped = False
    for rec in _scan(log, cancel):
        scanned = rec.line
        if include and not fnmatch.fnmatchcase(rec.type, include):
            continue
        if not rx.search(rec.text):
            continue
        hits.append(f"line {rec.line}: [{_tag(rec)}] {_hit(rec.text, rx)}")
        if len(hits) >= max_hits:
            stopped = True
            break
    head = f"{_name(log)}: /{pattern}/"
    if include:
        head += f" in {include}"
    if not hits:
        return Envelope(f"{head} — no line matches ({scanned} lines scanned)")
    out = [head, "", *hits, ""]
    if stopped:
        out.append(
            f"(stopped at max_hits={max_hits}; raise it or narrow the pattern — "
            f"{scanned}+ lines scanned)"
        )
    else:
        out.append(f"({len(hits)} hits, {scanned} lines scanned)")
    return Envelope("\n".join(out))


def _tag(rec: Record) -> str:
    """How a line is labelled in both tools: type and, when the file recorded
    one, a timestamp. A legacy note has no time of its own — an older build
    wrote the body alone — so it carries the type only."""
    return f"{rec.type} {rec.stamp}" if rec.stamp else rec.type


def _hit(text: str, rx: re.Pattern[str]) -> str:
    """The line inside an event that matched (or its first line when the match
    spans lines), clipped — a hit is a pointer to a line, not the transcript."""
    lines = text.splitlines()
    line = next((ln for ln in lines if rx.search(ln)), lines[0] if lines else text)
    line = line.strip()
    return line if len(line) <= _HIT_CHARS else line[:_HIT_CHARS] + "…"


# --------------------------------------------------------------- read_memory


def read_memory(
    workspace: Workspace,
    config: Config,
    offset: int | None = None,
    limit: int = 40,
    log: LazyEventLog | None = None,
    cancel: threading.Event | None = None,
) -> Envelope:
    """Read a page of the project log by 1-based line number.

    With no `offset`, the page is the TAIL — the newest `limit` lines, which is
    what a session resuming a long log needs first (the head is an older
    session's task, not this one's). `offset` reads from any line `grep_memory`
    named. Each event is clipped at a page-friendly length, the page at a
    budget, and the footer says which offset comes next.
    """
    if log is None or not str(log.path):
        return _no_log()
    limit = max(1, min(int(limit or 40), 200))
    if offset is not None and int(offset) < 1:
        return Envelope("ERROR: offset is a 1-based line number (1 is the first line).", error=True)
    start = None if offset is None else int(offset)
    # no offset: the newest `limit` lines, as they stream past
    tail: deque[Record] = deque(maxlen=limit)
    # a named offset: the page from there on, within the same budget
    page: list[Record] = []
    total = 0
    for rec in _scan(log, cancel):
        total = rec.line
        if start is None:
            tail.append(rec)
        elif rec.line >= start and len(page) < limit:
            page.append(rec)
    records = list(tail) if start is None else page
    if start is not None and not records:
        return Envelope(
            f"ERROR: offset {start} is past the end of {_name(log)} (the log has {total} lines).",
            error=True,
        )
    if not records:
        return Envelope(f"{_name(log)}: the log has no readable lines yet.")
    first, last = records[0].line, records[-1].line
    out = [f"{_name(log)}: lines {first}-{last} of {total}", ""]
    used = 0
    for i, rec in enumerate(records):
        body, cut = _body(rec.text)
        if i > 0 and used + len(body) > _PAGE_CHARS:
            last = records[i - 1].line
            break
        out.append(f"line {rec.line}  [{_tag(rec)}]")
        out.append(body + (f"\n[cut at {_EVENT_CHARS} chars]" if cut else ""))
        out.append("")
        used += len(body)
    hints = []
    if last < total:
        hints.append(f"offset={last + 1} to continue")
    if first > 1:
        hints.append(f"offset={max(1, first - limit)} for earlier lines")
    out.append(
        f"(showing lines {first}-{last} of {total}"
        + ("; " + ", ".join(hints) if hints else "; the whole log")
        + ")"
    )
    return Envelope("\n".join(out))


def _body(text: str) -> tuple[str, bool]:
    """One event's text, clipped for a page; (text, was it cut)."""
    if len(text) <= _EVENT_CHARS:
        return text, False
    return text[:_EVENT_CHARS], True


__all__ = ["grep_memory", "read_memory"]
