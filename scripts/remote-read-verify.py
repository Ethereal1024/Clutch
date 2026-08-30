"""Verify the REMOTE byte-range path end to end.

Simulates the exec bridge: read_range = file slice -> base64 -> decode (the
wire format the RemoteWorkspace uses, which keeps mid-multibyte cuts exact),
size = metadata. Opens a CHINESE-content .clc through the simulated remote
workspace and checks the byte offsets / tail boundary / paging / derive are
identical to the local path.

Run: uv run python scripts/tmp-remote-read-verify.py
"""
import base64
import tempfile
from pathlib import Path

from agent.config import Config
from agent.core.context import derive_messages
from agent.core.lazy import _make_reader
from agent.events import (
    AssistantMessageEvent,
    CompactionEvent,
    EventLog,
    UserMessageEvent,
    _line_bytes,
    event_from_dict,
    event_to_json,
)
from agent.project import open_project_lazy


class FakeRemoteWorkspace:
    """read/read_range/size over a local file, with read_range round-tripping
    through base64 exactly like the exec bridge (any byte offset survives)."""

    def __init__(self, path: Path):
        self._path = path
        self.range_calls = 0
        self.range_bytes = 0

    def read(self, path: str) -> str:
        return Path(path).read_text(encoding="utf-8", errors="replace")

    def read_range(self, path: str, lo: int, hi: int) -> bytes:
        self.range_calls += 1
        self.range_bytes += hi - lo
        raw = self._path.read_bytes()[lo:hi]
        return base64.b64decode(base64.b64encode(raw))  # wire round trip

    def size(self, path: str) -> int:
        return self._path.stat().st_size

    def append_line(self, path: str, line: str) -> None:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def run(self, command: str, timeout: float):
        from agent.tools.workspace import CommandResult

        return CommandResult(code=0, stdout="", stderr="")


def build_cn(path: Path, n_mid: int = 8000) -> int:
    """Chinese-content .clc big enough that the lazy path is honest (the real
    256KB threshold) and the remote transfer is a true slice of the file. A
    [memories] section sits at the tail so the backward scan stops early."""
    events = [UserMessageEvent(content="写一个排序算法并解释")]
    for i in range(1, n_mid):
        events.append(
            AssistantMessageEvent(content=f"这是第 {i} 轮的中文回复内容，包含多字节字符测试")
            if i % 2
            else UserMessageEvent(content=f"用户第 {i} 次提问，也需要中文")
        )
    tail_start = sum(_line_bytes(ev) for ev in events[: n_mid - 300])
    events.append(CompactionEvent(summary="之前的对话已总结", tail_start=tail_start))
    for i in range(n_mid + 1, n_mid + 61):
        events.append(AssistantMessageEvent(content=f"最近的中文回复 {i}"))
    lines = ["# clutch project v1", "name: cn", "model: fake-model", "---"]
    for ev in events:
        lines.append(event_to_json(ev))
    lines.append("[memories]")
    lines.append('{"title": "项目约定", "content": "中文记忆内容", "updated": 0}')
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return tail_start


def load_full(path: Path) -> EventLog:
    log = EventLog()
    text = path.read_text(encoding="utf-8")
    in_ev = False
    running = 0
    for line in text.split("\n"):
        s = line.strip()
        if not in_ev:
            if s == "---":
                in_ev = True
            continue
        if s == "[memories]":
            break
        if s:
            try:
                ev = event_from_dict(__import__("json").loads(line))
                log._events.append(ev)
                if ev.type in ("user_message", "assistant_message", "tool_call", "tool_result", "final", "compaction"):
                    log._offsets.append(running)
            except Exception:
                pass
            running += len(line.encode("utf-8")) + 1
    return log


def main() -> None:
    from agent.core import lazy as lazy_mod

    ok = True

    def check(cond, label):
        nonlocal ok
        print(("ok:  " if cond else "FAIL: ") + label)
        ok = ok and cond

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "cn.clc"
        tail_start = build_cn(p)
        ws = FakeRemoteWorkspace(p)

        # force lazy + remote reader path
        old = lazy_mod._LAZY_MIN_BYTES
        lazy_mod._LAZY_MIN_BYTES = 64
        try:
            proj = open_project_lazy(p, workspace=ws)
        finally:
            lazy_mod._LAZY_MIN_BYTES = old

        log = proj.log
        check(proj.meta.name == "cn", "remote lazy open parses the header")
        check(log._tail_start == tail_start, f"remote tail_start matches local ({log._tail_start})")
        check(log.items()[0] == (0, log.events()[0]), "task at offset 0")
        check(all(off >= tail_start for off, _ in log.items()[1:]), "tail offsets inside the tail")

        full = load_full(p)
        check(
            derive_messages(log, Config(), "t") == derive_messages(full, Config(), "t"),
            "remote lazy derive == full derive (Chinese content)",
        )
        check(
            log.tail_start_index(500) == full.tail_start_index(500),
            "remote tail_start_index EXACTLY matches full (Chinese)",
        )

        # paging with a NON-line-aligned lo (mid-multibyte cuts) must stay exact
        before = tail_start
        page = log.materialize_range(before - 3000, before)
        check(len(page) > 0, "remote paging returns events")
        check(all(off < before for off, _ in page), "paged offsets strictly before the cursor")
        lo0 = page[0][0]
        page2 = log.materialize_range(lo0 - 3000, lo0)
        check(all(off < lo0 for off, _ in page2), "second page also exact")
        # every returned offset must be a REAL line start — offsets are RELATIVE
        # to the event region (base), so check raw[base + off]
        base = proj.log._base
        raw = p.read_bytes()
        all_exact = all(
            raw[base + off : base + off + 1] == b"{"
            for off, _ in (list(log.items()) + page + page2)
            if off > 0
        )
        check(all_exact, "every materialized offset points at a real line start (byte-exact)")

        # transfer accounting: the whole open read far less than the file
        total = ws.size(str(p))
        print(f"    remote open: file={total//1024}KB transferred={ws.range_bytes//1024}KB ({100*ws.range_bytes//total}%) calls={ws.range_calls}")
        check(ws.range_bytes < total // 3, f"remote open transferred only a slice ({100*ws.range_bytes//total}% of file)")

    print()
    print("REMOTE READ VERIFY PASSED" if ok else "REMOTE READ VERIFY FAILED")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
