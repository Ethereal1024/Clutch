"""Standalone verification of the window-based lazy .clc loading path.

Builds a synthetic .clc with a compaction, opens it lazily, and checks:
  1. ONLY the model WINDOW (everything since the newest compaction line, from
     the header's cpr_start) is materialized; everything before it (the raw
     task and the summarized middle) stays on disk (older = cpr_start)
  2. read_page pages that earlier history with a PURE DISK read — the resident
     log never grows (history browsing is decoupled from the model context)
  3. derive_messages on the lazy log == derive_messages on a fully loaded log
  4. compact() works on the lazy log (input = the resident window, zero disk
     reads), slides cpr_start to the new summary line via an in-place
     fixed-width header write, and derive_messages sees the fresh summary head
  5. the window contract survives a reopen: the persisted cpr_start resolves
     the SAME boundary, and the header write kept every event offset stable
  6. an out-of-range cpr_start clamps to 0 (nothing lost, full window)
  7. a .clc with no cpr_start line: never compacted → full window (cpr_start 0);
     compacted → the open DERIVES the boundary from the newest compaction line
     (a legacy file cannot persist it, so without the derive every session would
     re-summarize the whole history — the "compressing context every turn"
     failure). The file itself is never rewritten (migration is the script's job)

Run: uv run python -m tests.lazy_check
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.context import derive_messages
from agent.core.lazy import LazyEventLog
from agent.events import (
    AssistantMessageEvent,
    CompactionEvent,
    UserMessageEvent,
    _line_bytes,
    event_from_dict,
    event_to_json,
)
from agent.project import open_project_lazy

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


def build_clc(path: Path, recent: int = 9) -> dict:
    """Write a synthetic cpr_start .clc and return the byte-layout bookkeeping.

    Event region: 0 task; 1..99 middle (summarized); 100 compaction; 101..(100+
    recent) window tail. The header's cpr_start is the compaction line's
    relative byte offset, so a lazy open materializes ONLY the (1+recent)
    window events; the task and the 99 middle events stay on disk, pageable via
    read_page.
    """
    events = [UserMessageEvent(content="task")]
    for i in range(1, 100):
        events.append(
            UserMessageEvent(content=f"old ask {i}")
            if i % 2
            else AssistantMessageEvent(content=f"old work {i}")
        )
    comp_off = sum(_line_bytes(ev) for ev in events)  # the compaction line's start
    events.append(CompactionEvent(summary="old work summarized"))
    for i in range(101, 101 + recent):
        events.append(AssistantMessageEvent(content=f"recent {i}"))

    lines = [
        "# clutch project v1", "name: lazy-test", "model: fake-model",
        f"cpr_start={comp_off:010d}", "---",
    ]
    for ev in events:
        lines.append(event_to_json(ev))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {
        "total": len(events),
        "comp_off": comp_off,
        "before_window": 1 + 99,  # the task + the 99 summarized middle events
        "window": 1 + recent,     # compaction line + the recent tail
    }


def main() -> None:
    config = Config()
    tmp = Path(tempfile.mkdtemp(prefix="clutch-lazy-"))
    path = tmp / "proj.clc"
    book = build_clc(path)

    _run(config, tmp, path, book)
    # a tiny history opens through the same lazy path (no compaction → cpr_start 0)
    with tempfile.TemporaryDirectory() as d:
        p3 = Path(d) / "tiny.clc"
        p3.write_text("\n".join([
            "# clutch project v1", "name: tiny", "model: fake-model", "---",
            event_to_json(UserMessageEvent(content="hi")),
        ]) + "\n", encoding="utf-8")
        proj = open_project_lazy(p3, workspace=None)
        check(isinstance(proj.log, LazyEventLog), "tiny history opens through the lazy path")
        check([e.content for e in proj.events()] == ["hi"], "tiny history events intact")
        check(proj.log.cpr_start() == 0, "tiny history has a full window (cpr_start 0)")
    print()
    if failures:
        print(f"{len(failures)} FAILURES:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("lazy path: all passed")


def _run(config: Config, tmp: Path, path: Path, book: dict) -> None:
    # ---- 1. lazy open: only the model window resident ----------------------
    project = open_project_lazy(path, workspace=None)
    log = project.log
    check(isinstance(log, LazyEventLog), "compaction file opens as a LazyEventLog")
    loaded = log.items()
    check(len(loaded) == book["window"],
          f"resident = only the model window ({len(loaded)} events)")
    check(loaded[0][0] == book["comp_off"], "the window starts at the compaction line's byte offset")
    check(all(off >= book["comp_off"] for off, _ in loaded),
          "every resident offset is inside the window (the task is not resident)")
    check(log.cpr_start() == book["comp_off"], "cpr_start read from the header line")
    check(max(0, log.cpr_start()) == book["comp_off"],
          "older == the on-disk bytes before the window (cpr_start)")
    check(project.meta.name == "lazy-test", "meta parsed from the header range read")
    check(project.memories is not None and not project.memories.items(), "empty MemoryStore attached")

    # ---- 2. read_page: pure disk paging, resident untouched ----------------
    page = log.read_page(0, book["comp_off"])
    check(len(page) == book["before_window"] and page[0][0] == 0 and page[-1][0] < book["comp_off"],
          "read_page pages the task + 99 middle events in order")
    check(all(off >= book["comp_off"] for off, _ in log.items()),
          "the paged history NEVER entered the resident log")
    check(max(0, log.cpr_start()) == book["comp_off"],
          "older is unchanged by paging (pure disk read, no materialization)")

    # ---- 3. lazy derive == full derive -------------------------------------
    full = _load_full(path)
    msgs_base = derive_messages(full, config, "task")
    msgs_lazy = derive_messages(log, config, "task")
    check(msgs_base == msgs_lazy, "derive_messages(lazy log) == derive_messages(full log)")
    check(msgs_lazy[-1] == {"role": "assistant", "content": "recent 109"},
          "lazy context ends with the newest window event")
    check(
        not any(m.get("content", "") in ("old work 42", "old ask 43") for m in msgs_lazy),
        "the summarized middle never enters the model context",
    )

    # ---- 4. compact() on the lazy log --------------------------------------
    p_long = tmp / "long.clc"
    book_long = build_clc(p_long, recent=400)
    long_log = open_project_lazy(p_long, workspace=None).log
    check(max(0, long_log.cpr_start()) == book_long["comp_off"],
          "long-window file lazy-opens with the middle unloaded")
    comp = _make_compactor(long_log)
    ok = comp.compact()
    check(ok, "compact() succeeds on the lazy log (input = the resident window)")
    check(isinstance(long_log.events()[-1], CompactionEvent),
          "compact() appended a new CompactionEvent")
    new_off = long_log.items()[-1][0]
    check(new_off > book_long["comp_off"], f"new cpr_start ({new_off}) slides past the old boundary")
    check(long_log.cpr_start() == new_off, "cpr_start moved to the new summary line")
    check(long_log.window_bytes() == _line_bytes(long_log.events()[-1]),
          "the window collapsed to just the new summary line")
    check(not comp.compact(), "second compact() is a no-op (the window holds only the summary)")
    check(not comp.should_compact(), "should_compact is False right after compaction")
    long_log.append(AssistantMessageEvent(content="post-compaction turn " + "q" * 100))
    check(not comp.should_compact(), "one new turn after compaction does NOT re-trigger (200K window)")

    # ---- 5. the window contract survives a reopen --------------------------
    # header write is an in-place fixed-width update: offsets stay stable
    header = p_long.read_text(encoding="utf-8").split("---", 1)[0]
    check(f"cpr_start={new_off:010d}" in header,
          "the header line holds the new 10-digit boundary (in-place write)")
    r1 = open_project_lazy(p_long, workspace=None).log
    check(r1.cpr_start() == new_off, "reopen reads the new cpr_start from the header")
    offs_r = [off for off, _ in r1.items()]
    check(offs_r[0] == new_off,
          "reopen materializes the collapsed window (first resident = the new summary line)")
    msgs_re = derive_messages(r1, config, "task")
    check(any("NEW SUMMARY" in m.get("content", "") for m in msgs_re),
          "reopen derives the fresh summary head")

    # ---- 6. out-of-range cpr_start clamps to 0 -----------------------------
    with tempfile.TemporaryDirectory() as d:
        p2 = Path(d) / "old.clc"
        b2 = build_clc(p2, recent=9)
        text2 = p2.read_text(encoding="utf-8").replace(
            f"cpr_start={b2['comp_off']:010d}", "cpr_start=9999999999"
        )
        p2.write_text(text2, encoding="utf-8")
        proj = open_project_lazy(p2, workspace=None)
        check(proj.log.cpr_start() == 0, "out-of-range cpr_start clamps to 0 (full window)")
        check(len(proj.log.items()) == b2["total"], "clamped file materializes everything")
        check(max(0, proj.log.cpr_start()) == 0, "older = 0 with a full window")

    # ---- 7. legacy .clc (no cpr_start line): full window, never migrated ----
    with tempfile.TemporaryDirectory() as d:
        p3 = Path(d) / "legacy.clc"
        evs = [UserMessageEvent(content="task"), AssistantMessageEvent(content="work")]
        p3.write_text(
            "\n".join(
                ["# clutch project v1", "name: old", "model: fake-model", "---"]
                + [event_to_json(e) for e in evs]
            )
            + "\n",
            encoding="utf-8",
        )
        before = p3.read_bytes()
        proj = open_project_lazy(p3, workspace=None)
        check(proj.log.cpr_start() == 0, "legacy .clc opens with cpr_start 0 (full window)")
        check(len(proj.log.items()) == 2, "legacy file materializes everything")
        check(p3.read_bytes() == before, "writable open never migrates the file (script's job)")
        # read-only open: same behavior, file untouched
        ro = Path(d) / "ro.clc"
        ro.write_text(
            "# clutch project v1\nname: ro\nmodel: m\n---\n"
            + event_to_json(UserMessageEvent(content="hi")) + "\n",
            encoding="utf-8",
        )
        before = ro.read_bytes()
        proj_ro = open_project_lazy(ro, workspace=None, read_only=True)
        check(proj_ro.log.cpr_start() == 0, "read-only legacy open: full window, no migration")
        check(ro.read_bytes() == before, "read-only open leaves the file untouched")

        # legacy file with a compaction: boundary derived from the newest compaction line
        l2 = Path(d) / "legacy-comp.clc"
        evs2 = [
            UserMessageEvent(content="task"),
            AssistantMessageEvent(content="old work"),
            CompactionEvent(summary="old summarized"),
            AssistantMessageEvent(content="recent work"),
        ]
        l2.write_text(
            "\n".join(
                ["# clutch project v1", "name: oldc", "model: fake-model", "---"]
                + [event_to_json(e) for e in evs2]
            )
            + "\n",
            encoding="utf-8",
        )
        proj2 = open_project_lazy(l2, workspace=None)
        check(proj2.log.cpr_start() > 0, "legacy file with a compaction derives the boundary")
        check(
            [e.type for e in proj2.events()] == ["compaction", "assistant_message"],
            "window materializes only from the last compaction onward (history not re-summarized)",
        )
        check(
            not Compactor(Config(llm_context_window_bytes=200_000), proj2.log, FakeLlm()).should_compact(),
            "no spurious compaction on a legacy file with an existing summary",
        )

    print()
    if failures:
        print(f"{len(failures)} FAILURES:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("lazy path: all passed")


def _load_full(path: Path) -> LazyEventLog:
    """Fully load a .clc into an in-memory lazy log (cross-check for the range reader)."""
    log = LazyEventLog.in_memory()
    text = path.read_text(encoding="utf-8")
    in_events = False
    for line in text.split("\n"):
        stripped = line.strip()
        if not in_events:
            if stripped == "---":
                in_events = True
            continue
        if stripped == "[memories]":
            break
        if not stripped:
            continue
        try:
            ev = event_from_dict(json.loads(line))
        except (ValueError, TypeError):
            continue
        if ev.type in ("user_message", "assistant_message", "tool_call", "tool_result", "final", "compaction"):
            log.append(ev)
    return log


def _make_reader(path: Path):
    from agent.core.lazy import _make_reader
    return _make_reader(path, None)


def _make_compactor(log):
    return Compactor(Config(llm_context_window_bytes=200_000), log, FakeLlm())


if __name__ == "__main__":
    main()
