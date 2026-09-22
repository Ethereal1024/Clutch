"""clutch-memory behavior: the full save/load/search surface over the
.clc content contract, against real files via the stub server."""

from __future__ import annotations

import contextlib
import io
import json

import pytest

from memory import INDEX_LINE_W, SECTION, ClcClient, ClcError, MemoryStore, main
from tests.stub_server import start_stub

# NB: the host serializes the prefix as a list element, so the real line
# starts "memory_index=,CC,HH,..." — comma right after '='. Frozen contract.
HEADER = "\n".join(
    [
        "# clutch project v1",
        "name: demo",
        "model: fake",
        "cpr_start=0000000000",
        "memory_index=,00,00," + ",".join(["0" * 16] * 10),
        "---",
    ]
) + "\n"


@pytest.fixture()
def clc(tmp_path):
    """A freshly-created .clc (the header every new project carries)."""
    p = tmp_path / "demo.clc"
    p.write_text(HEADER, encoding="utf-8", newline="\n")
    return p


@pytest.fixture()
def env(clc):
    srv, url = start_stub(str(clc))
    yield clc, url
    srv.shutdown()
    srv.server_close()


def store(url: str) -> MemoryStore:
    return MemoryStore(ClcClient(url))


# ------------------------------------------------------------------ the ring

def test_save_load_roundtrip(env):
    clc, url = env
    store(url).save("tone", "be terse, cite files")
    m = store(url).load_all()["tone"]  # a NEW process/store: disk is truth
    assert m["content"] == "be terse, cite files"
    assert m["updated"] > 0


def test_save_multibyte_and_specials(env):
    clc, url = env
    # CJK + quotes + a newline: the newline must stay escaped (one JSONL line)
    store(url).save("决策", 'constitution says "inst" —\nsecond line')
    raw = clc.read_bytes()
    m = store(url).load_all()["决策"]
    assert m["content"] == 'constitution says "inst" —\nsecond line'
    # the memory line is a single physical line: nothing between it and EOF
    tail = raw[raw.index(b'{"title":'):]
    assert tail.count(b"\n") == 1


def test_index_patched_in_place(env):
    clc, url = env
    before = clc.read_bytes()
    rec = store(url).save("a", "x")
    after = clc.read_bytes()
    # header bytes before the index line are untouched, the separator is
    # exactly where it was (the write never shifted the event region)
    idx = before.index(b"memory_index=")
    sep = before.index(b"---")
    assert after[:idx] == before[:idx]
    assert after[sep : sep + 3] == b"---"
    line = after[idx : idx + INDEX_LINE_W].decode()
    assert line.startswith("memory_index=,01,00,")
    assert f"{rec['offset']:016d}" in line
    assert len(line) == INDEX_LINE_W


def test_file_grows_by_exactly_the_appended_lines(env):
    clc, url = env
    s = store(url)
    size0 = len(clc.read_bytes())
    r1 = s.save("one", "first")
    line1 = r1["size"] - r1["offset"]  # the memory line + its newline
    assert r1["size"] == size0 + len(SECTION) + 1 + line1  # marker written once, first
    r2 = s.save("two", "second")
    assert r2["offset"] == r1["size"]  # appended at the tail, no gaps
    assert r2["size"] == r1["size"] + (r2["size"] - r2["offset"])  # no marker again


def test_marker_written_once(env):
    clc, url = env
    s = store(url)
    s.save("a", "1")
    s.save("b", "2")
    s.save("c", "3")
    assert clc.read_bytes().count(SECTION.encode()) == 1


def test_ring_keeps_last_ten(env):
    clc, url = env
    s = store(url)
    for i in range(12):
        s.save(f"m{i:02d}", f"content {i}")
    items = s.load_all()
    assert set(items) == {f"m{i:02d}" for i in range(2, 12)}  # oldest two evicted
    assert "m00" not in items and "m11" in items


def test_resave_same_title_newest_wins(env):
    clc, url = env
    s = store(url)
    s.save("tone", "old")
    s.save("tone", "new")
    assert s.load_all()["tone"]["content"] == "new"


def test_load_missing_title(env):
    _, url = env
    assert "nope" not in store(url).load_all()


def test_legacy_file_without_index(env):
    clc, url = env
    clc.write_text("# clutch project v1\nname: demo\n---\n", encoding="utf-8", newline="\n")
    with pytest.raises(ClcError, match="memory_index"):
        store(url).save("a", "b")


# ---------------------------------------------------------------------- CLI

def run_cli(url: str, *argv: str) -> tuple[int, dict]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(["--endpoint", url, *argv])
    return code, json.loads(out.getvalue())


def test_cli_save_load_search_list(env):
    _, url = env
    code, r = run_cli(url, "save", "--title", "port", "--content", "daemon on 7777")
    assert code == 0 and r["title"] == "port" and r["offset"] > 0
    code, r = run_cli(url, "load", "--title", "port")
    assert code == 0 and r["content"] == "daemon on 7777"
    code, r = run_cli(url, "search", "--query", "7777")
    assert code == 0 and [m["title"] for m in r["matches"]] == ["port"]
    code, r = run_cli(url, "search", "--query", "DAEMON")  # case-insensitive
    assert code == 0 and len(r["matches"]) == 1
    code, r = run_cli(url, "list")
    assert code == 0 and r["count"] == 1 and r["memories"][0]["title"] == "port"
    assert "content" not in r["memories"][0]  # list stays short
    code, r = run_cli(url, "load", "--title", "missing")
    assert code == 1 and r["error"] == "memory not found"


def test_cli_dead_endpoint():
    code, r = run_cli("http://127.0.0.1:1", "list")
    assert code == 2 and r["error"]
