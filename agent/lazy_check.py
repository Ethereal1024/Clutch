"""Standalone verification of the lazy .clc loading path (byte-addressed).

Builds a synthetic .clc with a compaction, opens it lazily, and checks:
  1. only the raw task + the preserved tail are materialized (older_bytes ==
     the on-disk middle BYTES)
  2. the tail scan finds the last compaction and its stored byte tail_start
  3. materialize_range pages the middle on demand; LRU eviction drops middle
     events (pinned task/tail survive); older_bytes tracks the honest remainder
  4. derive_messages on the lazy log == derive_messages on a fully loaded log
  5. compact() works on the lazy log (head re-materialized under the pin, guard
     prevents a no-op re-summary) and derive_messages sees the new summary
  6. tail_start_index matches the fully loaded log EXACTLY (both walk the same
     events from the end with len(content)//3 — no index, no approximation)
  7. a stale out-of-range tail_start clamps to the compaction and still derives
     the same context as a full load

Run: uv run python -m agent.lazy_check
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from .config import Config
from .core import lazy as lazy_mod
from .core.compaction import Compactor
from .core.context import derive_messages
from .core.lazy import LazyEventLog, _tail_scan, parse_durable
from .events import (
    AssistantMessageEvent,
    CompactionEvent,
    EventLog,
    StepStartEvent,
    TextDeltaEvent,
    ToolResultEvent,
    UserMessageEvent,
    _line_bytes,
    event_from_dict,
    event_to_json,
)
from .project import open_project_lazy

failures = []


def check(cond: bool, label: str) -> None:
    print(f"{'ok:  ' if cond else 'FAIL: '}{label}")
    if not cond:
        failures.append(label)


class FakeLlm:
    """Compaction summarizer stub: returns a fixed summary."""

    def __init__(self, summary: str = "NEW SUMMARY") -> None:
        self.summary = summary

    def stream(self, msgs, tools=None):
        yield {"type": "text", "delta": self.summary}
        yield {"type": "finish"}


def build_clc(path: Path, with_transients: bool = True, recent: int = 9) -> dict:
    """Write a synthetic .clc and return the byte-layout bookkeeping.

    Event region: 0 task; 1..99 middle; 100 compaction; 101..(100+recent) tail.
    The compaction's tail_start (BYTES) is the line start of the 90th durable
    event (10 before the compaction). Transient lines are interleaved to prove
    byte offsets track the real file layout (transients occupy bytes too) —
    offsets are measured from the written file, exactly like the lazy log does.
    """
    events = [UserMessageEvent(content="task")]
    for i in range(1, 100):
        events.append(
            UserMessageEvent(content=f"old ask {i}")
            if i % 2
            else AssistantMessageEvent(content=f"old work {i}")
        )
    events.append(CompactionEvent(summary="old work summarized", tail_start=0))  # patched below
    for i in range(101, 101 + recent):
        events.append(AssistantMessageEvent(content=f"recent {i}"))

    lines = ["# clutch project v1", "name: lazy-test", "model: fake-model", "---"]
    for ev in events:
        lines.append(event_to_json(ev))
        if with_transients and ev.type in ("assistant_message", "user_message"):
            lines.append(event_to_json(TextDeltaEvent(content="x")))
            lines.append(event_to_json(StepStartEvent()))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # measure the REAL byte layout from the written file (transients included),
    # matching the lazy log's file-based offsets
    text = path.read_text(encoding="utf-8")
    pos = 0
    base = None
    task_end = 0
    durable_seen = 0
    tail_start = 0
    comp_offset = 0
    for line in text.split("\n"):
        stripped = line.strip()
        line_bytes = len(line.encode("utf-8")) + 1
        if base is None:
            is_durable = _is_durable_line(stripped, line)
            if is_durable:
                base = pos
                task_end = pos + line_bytes
            pos += line_bytes
            continue
        if _is_durable_line(stripped, line):
            durable_seen += 1
            if durable_seen == 90:
                tail_start = pos - base
            if '"compaction"' in line:
                comp_offset = pos - base
        pos += line_bytes
    # patch the compaction's stored tail_start into the file (byte offset)
    patched = text.replace('"tail_start": 0', f'"tail_start": {tail_start}')
    path.write_text(patched, encoding="utf-8")
    return {
        "total": len(events),
        "tail_start": tail_start,
        "task_end": task_end - (base or 0),
        "comp_offset": comp_offset,
    }


def _is_durable_line(stripped: str, line: str) -> bool:
    if not stripped or stripped.startswith(("----", "[memories]")):
        return False
    try:
        data = json.loads(line)
    except ValueError:
        return False
    return isinstance(data, dict) and data.get("type") in (
        "user_message", "assistant_message", "tool_call", "tool_result", "final", "compaction"
    )


def main() -> None:
    config = Config()
    tmp = Path(tempfile.mkdtemp(prefix="clutch-lazy-"))
    path = tmp / "proj.clc"
    book = build_clc(path, with_transients=True)

    # force the lazy path: the synthetic file is far below the real byte
    # threshold, which the final check exercises explicitly
    old_min = lazy_mod._LAZY_MIN_BYTES
    lazy_mod._LAZY_MIN_BYTES = 64
    try:
        _run(config, tmp, path, book)
    finally:
        lazy_mod._LAZY_MIN_BYTES = old_min
    # a tiny history still opens as a plain EventLog (open_project equivalence)
    with tempfile.TemporaryDirectory() as d:
        p3 = Path(d) / "tiny.clc"
        p3.write_text("\n".join([
            "# clutch project v1", "name: tiny", "model: fake-model", "---",
            event_to_json(UserMessageEvent(content="hi")),
        ]) + "\n", encoding="utf-8")
        proj = open_project_lazy(p3, workspace=None)
        check(type(proj.log).__name__ == "EventLog",
              "sub-threshold history opens through the plain EventLog path")
    print()
    if failures:
        print(f"{len(failures)} FAILURES:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("lazy path: all passed")


def _run(config: Config, tmp: Path, path: Path, book: dict) -> None:
    # ---- 1. lazy open: only task + tail resident ---------------------------
    project = open_project_lazy(path, workspace=None)
    log = project.log
    check(isinstance(log, LazyEventLog), "compaction file opens as a LazyEventLog")
    loaded = log.items()
    check(len(loaded) == 1 + (book["total"] - 90),
          f"resident = task + tail ({len(loaded)} events)")
    check(loaded[0] == (0, project.events()[0]) and loaded[0][1].content == "task",
          "offset 0 (the raw task) is resident first")
    check(loaded[1][0] == book["tail_start"], "tail starts at the stored tail_start BYTE offset")
    check(all(off >= book["tail_start"] for off, _ in loaded[1:]),
          "every non-task resident offset is inside the preserved tail")
    check(log.older_bytes() == book["tail_start"] - book["task_end"],
          "older_bytes == the on-disk middle bytes")
    check(project.meta.name == "lazy-test", "meta parsed from the header range read")
    check(project.memories is not None and not project.memories.items(), "empty MemoryStore attached")

    # ---- 2. tail scan finds the last compaction + stored tail_start --------
    from .core.lazy import _make_reader
    read, total = _make_reader(path, None)
    comp, mem = _tail_scan(read, total)
    check(comp is not None, "tail scan finds the compaction event")
    check(comp[1].tail_start == book["tail_start"],
          "stored tail_start extracted from the compaction line")
    check(mem is None, "no [memories] marker in the plain file")

    # ---- 3. paging + LRU eviction -----------------------------------------
    page = log.materialize_range(book["task_end"], book["tail_start"])
    check(len(page) == 89 and page[0][0] > book["task_end"] and page[-1][0] < book["tail_start"],
          "materialize_range pages the 89 middle events in order")
    check(log.older_bytes() == 0, "older_bytes drops to 0 after paging the middle")
    # a second page request overlaps: returns the same events, no dupes
    again = log.materialize_range(book["task_end"], book["tail_start"])
    check(len(again) == 89, "overlapping page returns the same events without duplicates")

    # LRU: shrink the cap and load the whole middle; middle must evict, task+tail
    # must survive, and older_bytes must report the honest disk remainder
    old_cap = lazy_mod._LRU_EVENT_CAP
    lazy_mod._LRU_EVENT_CAP = 25
    try:
        log2 = open_project_lazy(path, workspace=None).log
        log2.materialize_range(book["task_end"], book["tail_start"])  # all 89 middle events
        offsets = [off for off, _ in log2.items()]
        check(len(offsets) <= 25, f"resident bounded by LRU cap ({len(offsets)} <= 25)")
        check(0 in offsets and offsets[-1] >= book["tail_start"], "task + tail tail-end survive eviction")
        check(log2._tail_start in offsets, "tail start survives eviction")
        check(log2.older_bytes() > 0, "older_bytes reports the honest remainder after eviction")
        # pinned: inside materialize(0, tail_start) nothing middle can be evicted
        with log2.materialize(0, book["tail_start"]):
            log2.materialize_range(book["task_end"], book["tail_start"])
            mid = sum(1 for off in log2._offsets if book["task_end"] < off < book["tail_start"])
            check(mid == 89, "materialize() pins the whole head mid-block")
    finally:
        lazy_mod._LRU_EVENT_CAP = old_cap

    # ---- 4. lazy derive == full derive ------------------------------------
    base = _load_full(path)
    lazy_proj = open_project_lazy(path, workspace=None)
    msgs_base = derive_messages(base, config, "task")
    msgs_lazy = derive_messages(lazy_proj.log, config, "task")
    check(msgs_base == msgs_lazy, "derive_messages(lazy log) == derive_messages(full log)")
    check(msgs_lazy[-1] == {"role": "assistant", "content": "recent 109"},
          "lazy context ends with the newest tail event")

    # ---- 5. compact() on the lazy log -------------------------------------
    p_long = tmp / "long.clc"
    book_long = build_clc(p_long, with_transients=True, recent=400)
    long_log = open_project_lazy(p_long, workspace=None).log
    check(long_log.older_bytes() == book_long["tail_start"] - book_long["task_end"],
          "long-tail file lazy-opens with the middle unloaded")
    comp = _make_compactor(long_log)
    ok = comp.compact()
    check(ok, "compact() succeeds on the lazy log (new head materialized under pin)")
    check(isinstance(long_log.events()[-1], CompactionEvent),
          "compact() appended a new CompactionEvent")
    new_ts = long_log.events()[-1].tail_start
    check(new_ts > book_long["tail_start"] and new_ts > 100,
          f"new tail_start ({new_ts}) covers the old head and pre-compaction tail")
    check(long_log.older_bytes() == 0,
          "after compaction everything relevant is resident (older_bytes 0, pill gone)")
    check(not comp.compact(), "second compact() is a no-op (nothing new since last compaction)")

    # ---- 6. tail_start_index matches the full log EXACTLY -----------------
    # The lazy log sizes from its materialized tail — the SAME events the full
    # log walks from the end — with the same len(content)//3, so the byte
    # boundaries are identical (no index, no approximation).
    p_edge = tmp / "edge.clc"
    edge_events = [UserMessageEvent(content="task")]
    for i in range(1, 880):
        if i == 176:
            edge_events.append(CompactionEvent(summary="old", tail_start=sum(_line_bytes(ev) for ev in edge_events)))
        else:
            edge_events.append(
                UserMessageEvent(content="u" * 80) if i % 2 else AssistantMessageEvent(content="a" * 80)
            )
    edge_lines = ["# clutch project v1", "name: edge", "model: fake-model", "---"]
    edge_lines += [event_to_json(ev) for ev in edge_events]
    p_edge.write_text("\n".join(edge_lines) + "\n", encoding="utf-8")
    read_e, _te = _make_reader(p_edge, None)
    comp_e_scan, _mem = _tail_scan(read_e, _te)
    from .project import _event_region_start
    base_e = _event_region_start(read_e(0, min(_te, 1 << 16)))
    comp_rel = comp_e_scan[0] - base_e
    lazy_e = open_project_lazy(p_edge, workspace=None).log
    full_e = _load_full(p_edge)
    want_e = full_e.tail_start_index(2000)
    got_e = lazy_e.tail_start_index(2000)
    check(want_e > comp_rel, f"budget boundary lands inside the preserved tail ({want_e} > {comp_rel})")
    check(got_e == want_e,
          f"lazy tail_start_index EXACTLY matches the full log ({got_e} == {want_e})")
    comp_e = Compactor(Config(compaction_tail_tokens=2000), lazy_e, FakeLlm())
    check(comp_e.compact(), "compact succeeds on the byte boundary")
    last_e = lazy_e.events()[-1]
    check(isinstance(last_e, CompactionEvent) and last_e.tail_start == got_e,
          f"compaction persists the byte tail_start ({got_e})")
    msgs2 = derive_messages(long_log, config, "task")
    head = [m for m in msgs2 if "NEW SUMMARY" in m.get("content", "")]
    check(len(head) == 1, "derive_messages sees the fresh summary head after lazy compaction")

    # ---- 7. stale tail_start clamp ----------------------------------------
    with tempfile.TemporaryDirectory() as d:
        p2 = Path(d) / "old.clc"
        book2 = build_clc(p2, with_transients=False)
        # simulate an old file: tail_start beyond the compaction's own offset
        text = p2.read_text(encoding="utf-8").replace('"tail_start": %d' % book2["tail_start"], '"tail_start": 999999')
        p2.write_text(text, encoding="utf-8")
        proj = open_project_lazy(p2, workspace=None)
        check(isinstance(proj.log, LazyEventLog), "stale tail_start still opens lazily")
        check(proj.log._tail_start == book2["comp_offset"],
              f"stale tail_start clamped to the compaction's offset ({proj.log._tail_start})")
        stale_full = _load_full(p2)
        msgs_stale = derive_messages(proj.log, config, "task")
        check(msgs_stale == derive_messages(stale_full, config, "task"),
              "stale tail_start derives the same context as the full log")
        check(
            any("old work summarized" in m.get("content", "") for m in msgs_stale),
            "the compaction summary head survives the stale-clamp lazy open",
        )
        check(
            not any(m.get("content", "") in ("old work 42", "old ask 43") for m in msgs_stale),
            "pre-compaction middle stays summarized away in the stale-clamp lazy open",
        )

    print()
    if failures:
        print(f"{len(failures)} FAILURES:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("lazy path: all passed")


def _load_full(path: Path) -> EventLog:
    """Fully load a .clc into an EventLog with REAL file-based byte offsets
    (every line occupies bytes, transients included) — the same base the lazy
    log measures against, so tail_from/tail_start_index agree."""
    log = EventLog()
    text = path.read_text(encoding="utf-8")
    in_events = False
    running = 0
    for line in text.split("\n"):
        stripped = line.strip()
        if not in_events:
            if stripped == "---":
                in_events = True
            continue
        if stripped == "[memories]":
            break
        if stripped:
            try:
                ev = event_from_dict(json.loads(line))
                log._events.append(ev)
                if ev.type in ("user_message", "assistant_message", "tool_call", "tool_result", "final", "compaction"):
                    log._offsets.append(running)
            except ValueError:
                pass
            running += len(line.encode("utf-8")) + 1
    return log


def _make_reader(path: Path):
    from .core.lazy import _make_reader
    return _make_reader(path, None)


def _make_compactor(log):
    from .core.compaction import Compactor
    return Compactor(Config(compaction_tail_tokens=50), log, FakeLlm())


if __name__ == "__main__":
    main()
