"""Standalone verification of the lazy .clc loading path (phase 1 + paging).

Builds a synthetic .clc with a compaction, opens it lazily, and checks:
  1. only seq 0 + the preserved tail are materialized (older_count == tail_start-1)
  2. the durable-only index skips transient lines correctly
  3. materialize_range pages the middle on demand; LRU eviction drops middle
     events (pinned head/tail survive); older_count tracks the honest remainder
  4. derive_messages on the lazy log == derive_messages on a fully loaded log
  5. compact() works on the lazy log (head re-materialized under the pin, guard
     prevents a no-op re-summary) and derive_messages sees the new summary
  6. tail_from clamps a stale out-of-range tail_start

Run: uv run python -m agent.lazy_check
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from .config import Config
from .core import lazy as lazy_mod
from .core.context import derive_messages
from .core.lazy import LazyEventLog, _stored_tail_start, index_file, parse_durable
from .events import (
    AssistantMessageEvent,
    CompactionEvent,
    EventLog,
    StepStartEvent,
    TextDeltaEvent,
    ToolResultEvent,
    UserMessageEvent,
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
    """Write a synthetic .clc and return the durable-layout bookkeeping.

    Durable seqs: 0 task; 1..99 middle; 100 compaction (tail_start=90);
    101..(100+recent) recent tail. Transient lines are interleaved to prove the
    index (and thus seq numbering) skips them.
    """
    lines = [
        "# clutch project v1",
        "name: lazy-test",
        "model: fake-model",
        "---",
    ]

    def add(ev):
        lines.append(event_to_json(ev))
        if with_transients and ev.type in ("assistant_message", "user_message"):
            lines.append(event_to_json(TextDeltaEvent(content="x")))
            lines.append(event_to_json(StepStartEvent()))

    add(UserMessageEvent(content="task"))
    for i in range(1, 100):
        if i % 2:
            add(UserMessageEvent(content=f"old ask {i}"))
        else:
            add(AssistantMessageEvent(content=f"old work {i}"))
    add(CompactionEvent(summary="old work summarized", tail_start=90))
    for i in range(101, 101 + recent):
        add(AssistantMessageEvent(content=f"recent {i}"))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"total": 101 + recent, "tail_start": 90}


def main() -> None:
    config = Config()
    tmp = Path(tempfile.mkdtemp(prefix="clutch-lazy-"))
    path = tmp / "proj.clc"
    book = build_clc(path, with_transients=True)

    # force the lazy path: the synthetic file is far below the real 512-event
    # threshold, which the final check exercises explicitly
    old_min = lazy_mod._LAZY_MIN_DURABLE
    lazy_mod._LAZY_MIN_DURABLE = 32
    try:
        _run(config, tmp, path, book)
    finally:
        lazy_mod._LAZY_MIN_DURABLE = old_min
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
    # ---- 1. lazy open: only seq 0 + tail resident -------------------------
    project = open_project_lazy(path, workspace=None)
    log = project.log
    check(isinstance(log, LazyEventLog), "compaction file opens as a LazyEventLog")
    loaded = log.items()
    check(len(loaded) == 1 + (book["total"] - book["tail_start"]),
          f"resident = seq0 + tail ({len(loaded)} events)")
    check(loaded[0] == (0, project.events()[0]) and loaded[0][1].content == "task",
          "seq 0 (the raw task) is resident first")
    check(loaded[1][0] == book["tail_start"], "tail starts at the stored tail_start seq")
    check(all(s >= book["tail_start"] for s, _ in loaded[1:]),
          "every non-zero resident seq is inside the preserved tail")
    check(log.older_count() == book["tail_start"] - 1,
          "older_count == events still on disk before the tail")
    check(project.meta.name == "lazy-test", "meta parsed from the header range read")
    check(project.memories is not None and not project.memories.items(), "empty MemoryStore attached")

    # ---- 2. durable-only index skips transients ----------------------------
    idx = index_file(*_make_local_reader(path), None)
    check(len(idx) == book["total"], f"index counts only durable lines ({len(idx)})")
    check(idx.newest_compaction == 100, "newest_compaction seq detected")
    read, _total = _make_local_reader(path)
    check(_stored_tail_start(read, idx) == 90,
          "stored tail_start extracted from the single compaction line")

    # ---- 3. paging + LRU eviction -----------------------------------------
    page = log.materialize_range(1, 60)
    check(len(page) == 59 and page[0][0] == 1 and page[-1][0] == 59,
          "materialize_range(1,60) returns seqs 1..59 in order")
    check(log.older_count() == book["tail_start"] - 1 - 59,
          "older_count shrinks by the paged count")
    # a second page request overlaps: returns the same events, no dupes
    again = log.materialize_range(30, 70)
    check(len(again) == 40 and again[0][0] == 30 and again[-1][0] == 69,
          "overlapping page returns seqs 30..69 without duplicates")

    # LRU: shrink the cap and load the whole middle; middle must evict, 0+tail
    # must survive, and older_count must report the honest disk remainder
    old_cap = lazy_mod._LRU_EVENT_CAP
    lazy_mod._LRU_EVENT_CAP = 25
    try:
        log2 = open_project_lazy(path, workspace=None).log
        log2.materialize_range(1, book["tail_start"])  # all 89 middle events
        seqs = [s for s, _ in log2.items()]
        check(len(seqs) <= 25, f"resident bounded by LRU cap ({len(seqs)} <= 25)")
        check(0 in seqs and seqs[-1] == book["total"] - 1, "seq 0 + tail tail-end survive eviction")
        check(log2._tail_start in seqs, "tail start survives eviction")
        resident_mid = sum(1 for s in seqs if 0 < s < book["tail_start"])
        check(log2.older_count() == (book["tail_start"] - 1) - resident_mid,
              "older_count is the honest on-disk remainder after eviction")
        # pinned: inside materialize(0, tail_start) nothing middle can be evicted
        with log2.materialize(0, book["tail_start"]):
            log2.materialize_range(1, book["tail_start"] + 10)
            mid = sum(1 for s in log2._seqs if 0 < s < book["tail_start"])
            check(mid == book["tail_start"] - 1, "materialize() pins the whole head mid-block")
    finally:
        lazy_mod._LRU_EVENT_CAP = old_cap

    # ---- 4. lazy derive == full derive ------------------------------------
    base = EventLog()
    for ev in parse_durable(path.read_text(encoding="utf-8")):
        base.append(ev)
    lazy_proj = open_project_lazy(path, workspace=None)
    msgs_base = derive_messages(base, config, "task")
    msgs_lazy = derive_messages(lazy_proj.log, config, "task")
    check(msgs_base == msgs_lazy, "derive_messages(lazy log) == derive_messages(full log)")
    check(msgs_lazy[-1] == {"role": "assistant", "content": "recent 109"},
          "lazy context ends with the newest tail event")

    # ---- 5. compact() on the lazy log -------------------------------------
    # needs a long post-compaction tail: with only 9 recent events the budget
    # walk stays inside the preserved tail and the no-op guard correctly fires
    p_long = tmp / "long.clc"
    book_long = build_clc(p_long, with_transients=True, recent=400)
    long_proj = open_project_lazy(p_long, workspace=None)
    long_log = long_proj.log
    check(long_log.older_count() == book_long["tail_start"] - 1,
          "long-tail file lazy-opens with the middle unloaded")
    comp = _make_compactor(long_log)
    ok = comp.compact()
    check(ok, "compact() succeeds on the lazy log (new head materialized under pin)")
    check(isinstance(long_log.events()[-1], CompactionEvent),
          "compact() appended a new CompactionEvent")
    new_ts = long_log.events()[-1].tail_start
    check(new_ts > book_long["tail_start"] and new_ts > 100,
          f"new tail_start ({new_ts}) covers the old head and pre-compaction tail")
    check(long_log.older_count() == 0,
          "after compaction everything relevant is resident (older_count 0, pill gone)")
    check(not comp.compact(), "second compact() is a no-op (nothing new since last compaction)")
    msgs2 = derive_messages(long_log, config, "task")
    head = [m for m in msgs2 if "NEW SUMMARY" in m.get("content", "")]
    check(len(head) == 1, "derive_messages sees the fresh summary head after lazy compaction")

    # ---- 6. stale tail_start clamp ----------------------------------------
    with tempfile.TemporaryDirectory() as d:
        p2 = Path(d) / "old.clc"
        build_clc(p2, with_transients=False)
        # simulate an old file: tail_start beyond the durable count
        text = p2.read_text(encoding="utf-8").replace('"tail_start": 90', '"tail_start": 500')
        p2.write_text(text, encoding="utf-8")
        proj = open_project_lazy(p2, workspace=None)
        check(isinstance(proj.log, LazyEventLog), "stale tail_start still opens lazily")
        check(proj.log._tail_start == 100,
              f"stale tail_start clamped to the compaction's durable position ({proj.log._tail_start})")
        check(proj.log.older_count() == 99, "older count = durable middle still on disk")
        stale_full = EventLog()
        for ev in parse_durable(p2.read_text(encoding="utf-8")):
            stale_full.append(ev)
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


def _make_local_reader(path: Path):
    from .core.lazy import _make_reader
    return _make_reader(path, None)


def _make_compactor(log):
    from .core.compaction import Compactor
    return Compactor(Config(compaction_tail_tokens=50), log, FakeLlm())


if __name__ == "__main__":
    main()
