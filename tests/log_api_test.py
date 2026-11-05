"""The .clc as a byte-addressed log the HOST drives: GET/POST /api/log (P2).

Run: .venv/bin/python -m tests.log_api_test

The loop lives in the host half (TODO.md D1), so the three ports it drives —
`read`, `append`, `slideWindow` (ui/run.js, ui/compaction.js) — have to exist on
the execution layer, which stays the only writer of the file. This suite pins
what a client can rely on:

  1. GET /api/log answers ONE shape — {items, windowBytes, cprStart,
     lastCompaction} — and `items` is the resident WINDOW plus the head of the
     open turn. That head is the point: compaction happens DURING a turn and
     slides cpr_start past the turn's `user_message`, and the host's loop
     answers its `task` from that line instead of holding it in a variable
     (agent/loop.py's `run(task)` did; TODO.md I6 forbids it). A read that
     stopped at cpr_start would resume a turn with no task.
  2. POST /api/log appends ONE line through the same writer every other path
     uses, answers the offset the log stamped on it (what a follow-up slide
     addresses), and REFUSES anything that is not one of the six durable types
     — a delta or a status frame is a page event and must never reach disk.
     Refused, not dropped: a silent success would leave the client's bug in
     place.
  3. POST /api/log/window slides the model window start (a fixed-width header
     write that keeps every offset stable) and answers 400 — never a silent
     no-op — for an offset outside the event region. `set_cpr_start` ignores
     such a value in silence; the endpoint must not.
  4. Both writers answer 409 on a READ-ONLY project instead of letting
     project.open's no-op writer swallow the line: the host builds its next
     step on "persisted", and that answer has to be true.
  5. LazyEventLog.turn_start() answers the turn boundary from either side of
     the window: resident when the turn opened after the newest compaction,
     a bounded backward walk when it opened before it — and the head survives
     a slide PAST the task line.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from pathlib import Path

from agent.base import Broadcaster, RunState
from agent.config import Config
from agent.core.lazy import LazyEventLog
from agent.events import (
    AssistantMessageEvent,
    CompactionEvent,
    FinalEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
)
from agent.project import create_project, open_project_lazy
from agent.server import build
from tests.testsupport import check, http_get, http_post


def build_clc(path: Path) -> dict[str, int]:
    """A .clc whose turn TWO is still open and whose window starts inside it.

    turn one: task, answer, final                 (summarized: behind the window)
    turn two: task, tool_call, tool_result,       (the open turn)
              COMPACTION <-- cpr_start here
              answer
    """
    project = create_project(path, "logapi", model="fake-model")
    log = project.log
    offs: dict[str, int] = {}

    def put(ev) -> int:
        log.append(ev)
        return ev.log_offset  # type: ignore[attr-defined]

    offs["u1"] = put(UserMessageEvent(content="turn one task"))
    put(AssistantMessageEvent(content="answered one"))
    offs["f1"] = put(FinalEvent(status="completed", summary="turn one done"))
    offs["u2"] = put(UserMessageEvent(content="turn two task"))
    put(ToolCallEvent(name="read", arguments='{"path":"a.txt"}', tool_call_id="c1"))
    put(ToolResultEvent(tool_call_id="c1", content="file body"))
    offs["comp"] = put(CompactionEvent(summary="summary of turn one"))
    put(AssistantMessageEvent(content="after compaction"))
    log.set_cpr_start(offs["comp"])  # exactly what a mid-turn compaction does
    return offs


def offsets_from(path: Path) -> dict[str, int]:
    """The fixture's offsets as they sit in the FILE — read back, not remembered."""
    log = open_project_lazy(path, workspace=None).log
    offs: dict[str, int] = {}
    users: list[int] = []
    for off, ev in log.read_page(0, log.file_bytes() - log.event_start()):
        if ev.type == "user_message":
            users.append(off)
        elif ev.type == "final":
            offs["f1"] = off
        elif ev.type == "compaction":
            offs["comp"] = off
    offs["u1"], offs["u2"] = users[0], users[1]
    return offs


def turn_head_check(tmp: Path) -> None:
    """turn_start(): the boundary on both sides of the window (5)."""
    path = tmp / "head" / "head.clc"
    offs = build_clc(path)
    check(offsets_from(path) == offs, "the builder's offsets are the file's offsets")
    log = open_project_lazy(path, workspace=None).log
    check(isinstance(log, LazyEventLog), "the fixture opens through the lazy path")
    check(log.cpr_start() == offs["comp"], "the window starts at the compaction line")
    head = log.turn_start()
    check(head == offs["u2"], "turn_start() answers the open turn's task line")
    check(head < log.cpr_start(), "and that line sits BEFORE the window start (the reason it exists)")
    check(
        [ev.type for _off, ev in log.read_page(head, log.cpr_start())]
        == ["user_message", "tool_call", "tool_result"],
        "the head range holds the open turn's records and nothing of the summarized history",
    )
    check(
        [ev.content for _off, ev in log.read_page(head, log.cpr_start()) if ev.type == "user_message"]
        == ["turn two task"],
        "the head carries the task the resumed turn is answering",
    )

    # the fast path: no compaction, so the boundary is already resident
    small = tmp / "small" / "small.clc"
    proj = create_project(small, "small", model="fake-model")
    proj.log.append(UserMessageEvent(content="first task"))
    proj.log.append(FinalEvent(status="completed", summary="done"))
    u2 = proj.log.append(UserMessageEvent(content="second task")).log_offset  # type: ignore[attr-defined]
    log2 = open_project_lazy(small, workspace=None).log
    check(log2.cpr_start() == 0, "a compaction-free file has a full window")
    check(log2.turn_start() == u2, "turn_start() is answered from the resident log when it can be")

    # a finished turn: the newest final is the last boundary, so there is no head
    proj.log.append(FinalEvent(status="completed", summary="done too"))
    log3 = open_project_lazy(small, workspace=None).log
    check(
        log3.turn_start() == log3.items()[-1][0],
        "a finished turn's boundary is its own final (nothing to resume)",
    )

    # a file whose FIRST turn is still open has no boundary at all
    fresh = tmp / "fresh" / "fresh.clc"
    fp = create_project(fresh, "fresh", model="fake-model")
    fp.log.append(UserMessageEvent(content="only task"))
    check(
        open_project_lazy(fresh, workspace=None).log.turn_start() == 0,
        "a turn that opens the file starts at offset 0",
    )


def open_server(tmp: Path, name: str, read_only: bool = False):
    """A real server (the routing + handler wiring, not just the functions)."""
    path = tmp / name / f"{name}.clc"
    offs = build_clc(path)
    cfg = Config(host="127.0.0.1", port=0)
    state = RunState()
    srv = build(cfg, Broadcaster(), state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{cfg.port}"
    project = open_project_lazy(path, workspace=None, read_only=read_only)
    check(project.read_only is read_only, f"the fixture opens read-only={read_only}")
    state.set_project(project)
    return base, srv, path, offs


def endpoint_check(tmp: Path) -> None:
    # ---- a server with NO project open: every port says so, rather than
    # inventing an empty log a host would happily drive forever
    empty_cfg = Config(host="127.0.0.1", port=0)
    empty_srv = build(empty_cfg, Broadcaster(), RunState())
    threading.Thread(target=empty_srv.serve_forever, daemon=True).start()
    empty_base = f"http://127.0.0.1:{empty_cfg.port}"
    try:
        for method, url, payload in (
            ("GET", "/api/log", None),
            ("POST", "/api/log", {"event": {"type": "user_message", "content": "x"}}),
            ("POST", "/api/log/window", {"offset": 0}),
        ):
            st, out = http_get(empty_base + url) if method == "GET" else http_post(empty_base + url, payload)
            check(st == 409, f"{method} {url} with no project open is 409 (got {st})")
            check(
                json.loads(out) == {"error": "no project is open"},
                f"{method} {url} answers why: {out[:120]}",
            )
    finally:
        empty_srv.shutdown()
        empty_srv.server_close()

    base, srv, path, offs = open_server(tmp, "api")
    try:
        # ---- 1. read
        st, out = http_get(base + "/api/log")
        check(st == 200, f"GET /api/log is 200 (got {st}: {out[:200]})")
        body = json.loads(out)
        check(
            set(body) == {"project", "items", "windowBytes", "cprStart", "lastCompaction"},
            f"GET /api/log answers one shape: {sorted(body)}",
        )
        check(body["project"] == str(path), "the answer names the .clc it read")
        check(body["cprStart"] == offs["comp"], "cprStart is the compaction line's offset")
        types = [it["event"]["type"] for it in body["items"]]
        check(
            types == ["user_message", "tool_call", "tool_result", "compaction", "assistant_message"],
            f"items is the open turn's head + the window, nothing summarized: {types}",
        )
        check(body["items"][0]["event"]["content"] == "turn two task", "the head IS the task")
        check(body["items"][0]["offset"] == offs["u2"], "the head keeps its file offset")
        check(
            [it["offset"] for it in body["items"]] == sorted(it["offset"] for it in body["items"]),
            "items arrive in file order",
        )
        check(
            body["lastCompaction"]["summary"] == "summary of turn one",
            "the newest compaction rides along (the loop's own context depends on it)",
        )
        log = open_project_lazy(path, workspace=None).log
        check(body["windowBytes"] == log.window_bytes(), "windowBytes is the window the compactor measures")
        check(
            log.file_bytes() - log.event_start() - body["cprStart"] == body["windowBytes"],
            "windowBytes == event region minus cprStart",
        )

        # ---- 2. append one durable line
        before = path.stat().st_size
        st, out = http_post(base + "/api/log", {"event": {"type": "assistant_message", "content": "next"}})
        check(st == 200, f"POST /api/log appends (got {st}: {out[:200]})")
        got = json.loads(out)
        check(set(got) == {"offset", "event"}, f"the append answers {sorted(got)}")
        check(got["event"]["content"] == "next", "the answer echoes the persisted record")
        check(path.stat().st_size > before, "the line is on disk, not only in memory")
        on_disk = path.read_bytes()[log.event_start() + got["offset"]:].split(b"\n")[0]
        check(
            json.loads(on_disk)["id"] == got["event"]["id"],
            "the answered offset points AT that line in the file",
        )
        st, out = http_get(base + "/api/log")
        body = json.loads(out)
        check(body["items"][-1]["event"]["content"] == "next", "the next read sees the append")
        check(body["items"][-1]["offset"] == got["offset"],
              "an appended line is inside the window, at the offset it was answered with")

        # ---- 2b. a non-durable event is REFUSED, not dropped
        size = path.stat().st_size
        for bad in (
            {"type": "text_delta", "content": "tok"},
            {"type": "state_update", "key": "execution_status", "value": "idle"},
            {"type": "llm_retry", "attempt": 1},
            {"type": "nonsense"},
            {"content": "no type at all"},
        ):
            st, out = http_post(base + "/api/log", {"event": bad})
            payload = json.loads(out)
            check(
                st == 400 and payload.get("code") == "not_durable",
                f"POST /api/log refuses {bad.get('type')!r} as not_durable: {st} {payload}",
            )
        st, out = http_post(base + "/api/log", {})
        check(
            st == 400 and json.loads(out).get("code") == "not_durable",
            "a body with no `event` is refused too",
        )
        check(path.stat().st_size == size, "a refused append wrote nothing")

        # ---- 3. slide the window
        region_end = path.stat().st_size - log.event_start()  # the whole event region
        check(
            body["windowBytes"] + body["cprStart"] == region_end,
            "the window plus its start is the whole event region",
        )
        for bad in (region_end + 1, -1, "12", None, True, 1.5):
            st, out = http_post(base + "/api/log/window", {"offset": bad})
            check(st == 400, f"an out-of-region offset {bad!r} is refused, not ignored: {st}")
        check(
            json.loads(http_get(base + "/api/log")[1])["cprStart"] == body["cprStart"],
            "a refused slide changed nothing",
        )

        # 3a. the real compaction sequence, driven the way the host drives it:
        # append the summary line, slide to ITS offset, read again
        st, out = http_post(
            base + "/api/log", {"event": {"type": "compaction", "summary": "summary two"}}
        )
        check(st == 200, f"a compaction line appends like any durable record: {st}")
        boundary = json.loads(out)["offset"]
        check(boundary >= region_end, "the summary line lands at the end of the event region")
        st, out = http_post(base + "/api/log/window", {"offset": boundary})
        check(st == 200, f"and the slide to it is 200 (got {st}: {out[:200]})")
        slid = json.loads(out)
        check(slid["cprStart"] == boundary, "the slide answers the new window start")
        check(
            slid["windowBytes"] == path.stat().st_size - log.event_start() - boundary,
            "and the new window is just the summary line",
        )
        forward = json.loads(http_get(base + "/api/log")[1])
        check(forward["cprStart"] == boundary, "the next read sees the slid window")
        check(
            forward["items"][-1]["offset"] == boundary
            and [it["offset"] for it in forward["items"]].count(boundary) == 1,
            "the summary line is the window's last record, exactly once",
        )
        check(
            forward["lastCompaction"]["summary"] == "summary two",
            "the newest compaction is the one just written (the loop's next head)",
        )
        # the head is the whole open turn up to the boundary — the records the
        # fold needs to see the turn whole, and nothing of the summarized turn
        check(
            [it["event"]["type"] for it in forward["items"][:-1]]
            == ["user_message", "tool_call", "tool_result", "compaction", "assistant_message", "assistant_message"],
            f"the head is the open turn's prefix, up to the new boundary: "
            f"{[it['event']['type'] for it in forward['items'][:-1]]}",
        )
        check(
            forward["items"][0]["event"]["content"] == "turn two task",
            "the task STILL rides along after the slide — the resumed turn",
        )
        check(forward["items"][0]["offset"] == offs["u2"], "still at its own file offset")
        check(
            all(it["offset"] < boundary for it in forward["items"][:-1]),
            "and every head record is behind the boundary it was read for",
        )

        # 3b. a boundary BELOW the resident records (the window was materialized
        # at open, so these records exist only on disk): the read serves them
        # from disk instead of answering a window it cannot actually see
        below = forward["items"][1]["offset"]  # the tool_call, past the task line
        st, out = http_post(base + "/api/log/window", {"offset": below})
        check(st == 200, "a backward slide is accepted (any in-region start is legal)")
        back = json.loads(http_get(base + "/api/log")[1])
        check(back["cprStart"] == below, "and the read honours it")
        check(
            back["windowBytes"] == path.stat().st_size - log.event_start() - below,
            "the window spans that boundary to the end of the file",
        )
        check(
            back["items"][0]["offset"] == offs["u2"] and back["items"][0]["event"]["type"] == "user_message",
            "the head is still the open turn's task",
        )
        check(
            [it["offset"] for it in back["items"][1:]]
            == [it["offset"] for it in forward["items"][1:]],
            "and every record from the boundary on is served — no silent truncation",
        )

        reopened = open_project_lazy(path, workspace=None).log
        check(
            reopened.cpr_start() == below,
            "the slide is a header write: a reopen resolves the same boundary",
        )
        check(offsets_from(path) == {**offs, "comp": boundary},
              "and every event offset is unchanged (fixed-width header line)")
        check(reopened.turn_start() == offs["u2"], "the head survives a reopen too")
    finally:
        srv.shutdown()
        srv.server_close()


def read_only_check(tmp: Path) -> None:
    """A read-only project must not answer "persisted" to a line it dropped (4)."""
    base, srv, path, _offs = open_server(tmp, "ro", read_only=True)
    try:
        size = path.stat().st_size
        st, out = http_post(base + "/api/log", {"event": {"type": "user_message", "content": "x"}})
        check(
            st == 409 and json.loads(out) == {"error": "project is read-only", "code": "read_only"},
            f"a read-only append is refused with a code: {st} {out}",
        )
        st, out = http_post(base + "/api/log/window", {"offset": 0})
        check(
            st == 409 and json.loads(out).get("code") == "read_only",
            f"a read-only slide is refused too: {st} {out}",
        )
        check(path.stat().st_size == size, "nothing was written to a read-only .clc")
        st, out = http_get(base + "/api/log")
        check(st == 200 and json.loads(out)["items"], "reading stays available on a read-only project")
    finally:
        srv.shutdown()
        srv.server_close()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="clutch-logapi-") as td:
        tmp = Path(td)
        print("turn_start(): the open turn's head")
        turn_head_check(tmp)
        print("endpoints: GET /api/log, POST /api/log, POST /api/log/window")
        endpoint_check(tmp)
        print("read-only: refuse, do not lie")
        read_only_check(tmp)
    print()
    print("log API: all passed")


if __name__ == "__main__":
    main()
