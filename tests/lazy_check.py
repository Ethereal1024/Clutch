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
  8. a durable append STAMPS the record with the offset a replay/serve will use,
     and _write_sse puts it on the live frame ({offset, event}) while a transient
     delta stays bare — the renderer's reconnect watermark rests on this
  9. a history page can open on a TURN boundary: aligned_start walks the window's
     start back to the turn's task row (so a byte window, which always splits
     turns, stops cutting a fold away from its head), keeps a window that already
     starts on one, and leaves the offset alone past its reach budget

Run: uv run python -m tests.lazy_check
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from agent.api.events import EventsMixin
from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.context import derive_messages
from agent.core.lazy import LazyEventLog
from agent.events import (
    AssistantMessageEvent,
    CompactionEvent,
    TextDeltaEvent,
    UserMessageEvent,
    _line_bytes,
    event_from_dict,
    event_to_json,
)
from agent.project import open_project_lazy
from tests.testsupport import collecting_check

check, failures = collecting_check()


class FakeLlm:
    """Compaction summarizer stub: returns a fixed summary."""

    def __init__(self, summary: str = "NEW SUMMARY") -> None:
        self.summary = summary

    def stream(self, msgs, tools=None, cancel=None):
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
    # newline="\n": the .clc is BYTE-addressed (offsets above are counted in LF
    # bytes) — Windows text mode would write CRLF and shift every offset by one
    # byte per line, so the fixture must match what the product writes.
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
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
        ]) + "\n", encoding="utf-8", newline="\n")
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
        p2.write_text(text2, encoding="utf-8", newline="\n")
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
            newline="\n",
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
            newline="\n",
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
            newline="\n",
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

    # ---- 8. a live append stamps the offset the replay will send ------------
    # The renderer skips a replayed record whose offset it already painted (the
    # transcript visibly doubled after a reconnect). A record painted LIVE has no
    # replay row to be compared against unless the live frame carries the same
    # offset, so the log stamps it on the event and _write_sse puts it on the
    # wire as {offset, event} — the same shape the replay sends.
    with tempfile.TemporaryDirectory() as d:
        p4 = Path(d) / "live.clc"
        build_clc(p4, recent=3)
        lg = open_project_lazy(p4, workspace=None).log
        last_before = lg.items()[-1][0]
        live_ev = AssistantMessageEvent(content="live turn")
        lg.append(live_ev)
        live_off = lg.items()[-1][0]
        check(live_off > last_before, "the appended record sits past the resident window")
        check(getattr(live_ev, "log_offset", None) == live_off,
              "the log stamps the record with its own byte offset (the live frame's offset)")
        delta = TextDeltaEvent(content="tok")
        lg.append(delta)
        check(not hasattr(delta, "log_offset"),
              "a transient delta is never appended, so it carries no offset (a bare frame)")

        # a reopen is the replay's own read: it must resolve the SAME offset
        reopened = open_project_lazy(p4, workspace=None).log
        roff, rev = reopened.items()[-1]
        check(roff == live_off and rev.content == "live turn",
              "a reopen (the replay's read) resolves the same offset and the same record")

        # ... and the wire shape the live path builds for it
        class _Wfile:
            def __init__(self) -> None:
                self.buf = b""

            def write(self, data: bytes) -> None:
                self.buf += data

            def flush(self) -> None:
                pass

        sse = EventsMixin.__new__(EventsMixin)  # _write_sse needs only self.wfile
        sse.wfile = _Wfile()
        sse._write_sse(live_ev)
        frame = json.loads(sse.wfile.buf.decode().split("data: ", 1)[1].strip())
        check(frame.get("offset") == live_off and frame.get("event", {}).get("content") == "live turn",
              "the live frame is {offset, event} — the shape the watermark dedupes on")
        sse.wfile = _Wfile()
        sse._write_sse(delta)
        bare = json.loads(sse.wfile.buf.decode().split("data: ", 1)[1].strip())
        check(bare.get("type") == "text_delta" and "offset" not in bare,
              "a delta stays a bare frame (nothing to dedupe, nothing replayed)")

    # ---- 9. a history page opens on a TURN boundary (align=turn) -----------
    # A page is a byte window (/api/history), and a byte window splits turns: the
    # UI asks for 1 MiB while the median finished turn in a real project is ~278 KB
    # (ui-fix.clc), so a cut lands inside a turn about every time. `align=turn` walks
    # the window's START back to the turn's own task row (aligned_start), which makes
    # "a page of history" and "whole turns" the same unit — the renderer then never
    # folds a region whose head it has not seen, and never has to reconcile that fold
    # when a later page brings the head (ui/js/auto-fold.js absorbIntoRegion).
    with tempfile.TemporaryDirectory() as d:
        p9 = Path(d) / "align.clc"
        evs = [UserMessageEvent(content="task one")]
        evs += [AssistantMessageEvent(content=f"turn one step {i} " + "x" * 120) for i in range(12)]
        evs.append(UserMessageEvent(content="task two"))
        evs += [AssistantMessageEvent(content=f"turn two step {i} " + "x" * 120) for i in range(12)]
        offs: list[int] = []
        body: list[str] = []
        pos = 0
        for ev in evs:
            offs.append(pos)  # the record's offset in the event region (what history sends)
            body.append(event_to_json(ev))
            pos += _line_bytes(ev)
        header = "\n".join(
            ["# clutch project v1", "name: align-test", "model: fake-model", "---"]
        ) + "\n"
        p9.write_text(header + "\n".join(body) + "\n", encoding="utf-8", newline="\n")
        alg = open_project_lazy(p9, workspace=None).log
        task1, task2 = offs[0], offs[13]
        check(task1 == 0 and task2 > 0,
              "the alignment fixture's second task row sits at a byte offset of its own")
        # each page after the first begins EXACTLY on a record (`lo` is the oldest
        # rendered event's offset, ui/js/stream-events.js): re-walking it would hand
        # the reader the turn BEFORE the one they asked for, on every page
        check(alg.aligned_start(task2) == task2,
              "a window that already starts on a task row stays where it is")
        inside2 = offs[13 + 6]  # a row in the middle of turn two
        check(alg.aligned_start(inside2) == task2,
              "a window cut inside a turn opens on that turn's task row")
        check(alg.aligned_start(offs[6]) == task1,
              "and a window cut inside the FIRST turn opens on its task row")
        check(alg.aligned_start(inside2 + 1) == task2,
              "a window cut mid-record is walked back the same way (the partial line is "
              "not a record, so it cannot pass for an aligned start)")
        check(alg.aligned_start(inside2, reach=10) == inside2,
              "a task row out of reach leaves the window where it was — a turn bigger "
              "than the budget is split, never widened into the whole history")
        # the page the UI would get: it opens on the task row and runs to the end
        aligned = alg.read_page(alg.aligned_start(inside2), 10 ** 9)
        check(aligned and aligned[0][0] == task2 and aligned[0][1].content == "task two",
              "the aligned page's first record IS the turn's task row")
        check([e.type for _, e in aligned].count("user_message") == 1,
              "so a page starts inside exactly one turn (the one it opens on)")
        plain = alg.read_page(inside2, 10 ** 9)
        check(plain[0][1].type != "user_message" and len(aligned) > len(plain),
              "the unaligned window at the same offset opens mid-turn, which is the "
              "fold-without-a-head the alignment exists to prevent")

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
