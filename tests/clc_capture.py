"""Golden capture for the .clc byte format and the lazy window (M1: ui/host/clc.js).

A .clc is BYTE-addressed: the header's fixed-width `cpr_start` line, the event
region's first line, every durable event's offset, and the line an append writes
are contract, not implementation detail. They are produced HERE, by the Python
host that deployment A/C still runs, and replayed by
`tests/host-clc.test.js` against `ui/host/clc.js` over a real POSIX shell — the
same shape as the `/api/*` goldens in `tests/fixtures/conformance/` (M0): the
Python host freezes the bytes, the JS host must reproduce them.

    .venv/bin/python -m tests.clc_capture            # write tests/fixtures/clc/
    .venv/bin/python -m tests.clc_capture --check    # regenerate and compare

The fixtures cover every branch of `core/lazy.py` + `project/format.py` that can
change an offset or a window boundary:

  plain.clc      the whole region materializes (cpr_start=0), two turns
  compacted.clc  cpr_start points at the newest compaction line; window is that line
  legacy.clc     NO cpr_start line: the boundary is derived from the compaction line
  torn.clc       a last line cut by the end of the file (the reader must drop it)
  noise.clc      [memories] / separator / transient / corrupt / BOM lines: the BYTE
                 parser skips the BOM line, the string parser (parse_durable) keeps it

plus three lifecycle records on copies of plain.clc: `append` (its offset, its
line, the file's growth), `set_cpr_start` (the in-place header write, 21 bytes,
size unchanged), and a read-only open (an append and a window slide that touch
nothing on disk).

Determinism: every event carries an explicit `timestamp` (1700000000.0) and a
zero-padded `id`, because the defaults are `time.time()` / `uuid4()`. The project
names and models are compile-time constants, so nothing machine-specific lands in
the bytes; the only paths are in the `open` section, and they carry the `<ROOT>`
token the conform goldens use.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from agent.core.lazy import parse_durable, _make_reader
from agent.events import (
    AssistantMessageEvent,
    CompactionEvent,
    FinalEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserMessageEvent,
    event_to_json,
)
from agent.project import create_project, open_project_lazy
from agent.project.format import (
    _CPR_START_LINE_BYTES,
    ProjectMeta,
    _cpr_line_offset,
    _event_region_start,
    _find_cpr_line,
    _header_text,
)

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "clc"
ROOT_TOKEN = "<ROOT>"
TS = 1700000000.0  # 2023-11-14T22:13:20Z, the conform capture's SSE timestamp
HEAD = 1 << 16  # project/__init__.py: the header lives in the first 64 KiB


def _event(cls, n: int, **kw):
    """One event with a pinned clock and id: the only way these bytes reproduce."""
    return cls(timestamp=TS, id=f"{n:012d}", **kw)


def _line(event) -> bytes:
    return (event_to_json(event) + "\n").encode("utf-8")


def _dump(obj) -> str:
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


# ---- the fixtures --------------------------------------------------------


def _turn_one():
    return [
        _event(UserMessageEvent, 1, content="alpha task\n"),
        _event(
            AssistantMessageEvent,
            2,
            content="reading alpha\n",
            reasoning="the file is small",
            tool_calls=[{"id": "c1", "name": "read_file", "arguments": '{"path": "alpha.txt"}'}],
        ),
        _event(
            ToolCallEvent,
            3,
            name="read_file",
            arguments='{"path": "alpha.txt"}',
            tool_call_id="c1",
            ui={"title": "read file", "lines": 3},
            path_arg="path",
        ),
        _event(ToolResultEvent, 4, tool_call_id="c1", content="alpha\n", is_error=False, diff=""),
        _event(FinalEvent, 5, status="completed", summary="done"),
    ]


def _turn_two():
    return [
        _event(UserMessageEvent, 6, content="beta 任务\n"),  # multibyte: offsets are bytes
        _event(AssistantMessageEvent, 7, content="beta done\n"),
        _event(FinalEvent, 8, status="completed", summary=""),
    ]


def _plain_events():
    return _turn_one() + _turn_two()


def _build_fresh(directory: Path, stem: str, name: str, model: str, events=()):
    project = create_project(directory / stem, name, model=model)
    for event in events:
        project.log.append(event)
    return project


def _write_raw(path: Path, header: str, lines) -> None:
    path.write_bytes(header.encode("utf-8") + b"".join(lines))


def _build_legacy(directory: Path) -> Path:
    """A .clc written before the header carried cpr_start: the window boundary has
    to come from the newest compaction line (lazy.py's legacy branch)."""
    path = directory / "legacy.clc"
    header = f"# clutch project v1\nname: old\nmodel: m\n---\n"
    lines = [
        _line(_event(UserMessageEvent, 11, content="first task\n")),
        _line(_event(FinalEvent, 12, status="completed", summary="one")),
        _line(_event(CompactionEvent, 13, summary="summary of the first task")),
        _line(_event(UserMessageEvent, 14, content="second task\n")),
        _line(_event(FinalEvent, 15, status="completed", summary="two")),
    ]
    _write_raw(path, header, lines)
    return path


def _build_noise(directory: Path) -> Path:
    """Every line the byte parser must step over WITHOUT losing an offset."""
    path = directory / "noise.clc"
    head = _header_text(ProjectMeta(name="noise", model="m"), 0)
    body = b"".join(
        [
            b"[memories]\n",
            b'{"type": "state_update", "key": "execution_status", "value": "idle"}\n',
            b"---\n",
            b"{not json\n",
            _line(_event(UserMessageEvent, 21, content="noise task\n")),
            b"\xef\xbb\xbf" + _line(_event(UserMessageEvent, 22, content="bom task\n")),
            b"\n",
            _line(_event(FinalEvent, 23, status="completed", summary="noisy")),
        ]
    )
    path.write_bytes(head.encode("utf-8") + body)
    return path


# ---- the records ---------------------------------------------------------


def _page_ranges(region: int) -> list[tuple[int, int]]:
    return [
        (0, region),  # the whole region
        (0, region // 2),  # a range that ends mid-line
        (region // 3, region),
        (1, max(1, min(region, 40))),  # starts mid-line: the mangled first line is dropped
        (region, region),  # empty
        (region + 5, region + 9),  # past the end: clamped to empty
    ]


def _align_cases(region: int, pairs) -> list[tuple[int, int]]:
    cases = [(0, 4 * 1024 * 1024), (region, 4 * 1024 * 1024)]
    if pairs:
        cases.append((pairs[0][0], 4 * 1024 * 1024))  # already on a task row
        cases.append((pairs[-1][0], 4 * 1024 * 1024))
        cases.append((pairs[-1][0] + 1, 16))  # a reach too small to find the turn
    return cases


def _record(path: Path, read_only: bool = False) -> dict:
    project = open_project_lazy(path, read_only=read_only)
    log = project.log
    region = log.file_bytes() - log.event_start()
    pairs = log.items()
    head = path.read_bytes()[:HEAD]
    cpr_line_off = _find_cpr_line(head)
    return {
        "size": path.stat().st_size,
        "meta": {"name": project.meta.name, "model": project.meta.model},
        "eventStart": log.event_start(),
        "cprLineOffset": cpr_line_off,
        "cprStart": log.cpr_start(),
        "windowBytes": log.window_bytes(),
        "fileBytes": log.file_bytes(),
        "items": [[off, event_to_json(ev)] for off, ev in pairs],
        "lastCompaction": (
            event_to_json(ev) if (ev := log.last_compaction()) is not None else None
        ),
        # the whole-file text parser (tools/recall.py): a DIFFERENT reader than the
        # byte one, and on noise.clc it deliberately disagrees about the BOM line
        "durable": [event_to_json(ev) for ev in parse_durable(path.read_text(encoding="utf-8"))],
        "rawHead": log.read_raw(0, min(log.file_bytes(), 24)).decode("utf-8", "replace"),
        "pages": [
            {
                "lo": lo,
                "hi": hi,
                "items": [[off, event_to_json(ev)] for off, ev in log.read_page(lo, hi)],
            }
            for lo, hi in _page_ranges(region)
        ],
        "aligned": [
            {"lo": lo, "reach": reach, "result": log.aligned_start(lo, reach)}
            for lo, reach in _align_cases(region, pairs)
        ],
    }


def _open_lines(path: Path, token_dir: Path) -> list[dict]:
    """The NDJSON body of `POST /api/project/open` (api/project.py:
    _open_stream_start), without the HTTP: progress, meta, count, events, done."""
    progress: list[tuple[int, int]] = []
    project = open_project_lazy(path, on_progress=lambda done, total: progress.append((done, total)))
    lines: list[dict] = [{"progress": {"done": d, "total": t}} for d, t in progress]
    meta = {
        "project": str(path).replace(str(token_dir), ROOT_TOKEN),
        "name": project.meta.name,
        "workdir": str(path.parent).replace(str(token_dir), ROOT_TOKEN),
        "read_only": project.read_only,
    }
    lines.append({"meta": meta})
    pairs = project.log.items()
    lines.append({"count": len(pairs), "older": max(0, project.log.cpr_start())})
    lines += [{"offset": off, "event": json.loads(event_to_json(ev))} for off, ev in pairs]
    lines.append({"done": True})
    return lines


def _append_record(source: Path, work: Path) -> dict:
    shutil.copyfile(source, work)
    project = open_project_lazy(work)
    before = work.stat().st_size
    event = _event(FinalEvent, 99, status="aborted", summary="appended by the golden")
    project.log.append(event)
    return {
        "offset": project.log.items()[-1][0],
        "line": event_to_json(event),
        "bytes": len(_line(event)),
        "fileBytesBefore": before,
        "fileBytesAfter": work.stat().st_size,
    }


def _cpr_record(source: Path, work: Path) -> dict:
    shutil.copyfile(source, work)
    project = open_project_lazy(work)
    log = project.log
    target = log.items()[5][0]  # the second turn's user_message
    size_before = work.stat().st_size
    log.set_cpr_start(target)
    head = work.read_bytes()[:HEAD]
    off = _find_cpr_line(head)
    line = work.read_bytes()[off : off + _CPR_START_LINE_BYTES].decode("ascii")
    reopened = open_project_lazy(work)
    return {
        "offset": target,
        "headerLine": line,
        "fileBytesBefore": size_before,
        "fileBytes": work.stat().st_size,
        "cprStart": reopened.log.cpr_start(),
        "windowBytes": reopened.log.window_bytes(),
        "items": [[o, event_to_json(ev)] for o, ev in reopened.log.items()],
    }


def _read_only_record(source: Path, work: Path) -> dict:
    shutil.copyfile(source, work)
    before = work.read_bytes()
    project = open_project_lazy(work, read_only=True)
    project.log.append(_event(FinalEvent, 98, status="error", summary="must not land"))
    project.log.set_cpr_start(project.log.items()[0][0])
    return {
        "unchanged": work.read_bytes() == before,
        "fileBytes": work.stat().st_size,
        "cprStart": project.log.cpr_start(),
        "windowBytes": project.log.window_bytes(),
        "readOnly": project.read_only,
    }


def capture() -> dict[str, bytes]:
    with tempfile.TemporaryDirectory(prefix="clc-") as tmp:
        directory = Path(tmp) / "work"
        directory.mkdir()
        files: dict[str, bytes] = {}

        fresh = _build_fresh(directory, "fresh", "demo", "test-model")
        fresh_path = fresh.path
        files["fresh.clc"] = fresh_path.read_bytes()

        plain = _build_fresh(directory, "plain", "plain", "test-model", _plain_events())
        files["plain.clc"] = plain.path.read_bytes()

        compact = _build_fresh(directory, "compacted", "compacted", "test-model", _turn_one())
        compaction = _event(CompactionEvent, 9, summary="the first turn, summarized")
        compact.log.append(compaction)
        compact.log.append(_event(UserMessageEvent, 10, content="second task\n"))
        # the compaction's own offset becomes the window start, in place
        compact.log.set_cpr_start(compact.log.items()[-2][0])
        files["compacted.clc"] = compact.path.read_bytes()

        legacy = _build_legacy(directory)
        files["legacy.clc"] = legacy.read_bytes()

        torn = directory / "torn.clc"
        torn.write_bytes(plain.path.read_bytes() + b'{"type": "user_mess')
        files["torn.clc"] = torn.read_bytes()

        noise = _build_noise(directory)
        files["noise.clc"] = noise.read_bytes()

        records = {name: _record(directory / name) for name in files}

        expected = {
            "format": 1,
            "source": "agent/core/lazy.py + agent/project/format.py (deployment A/C)",
            "generated_by": "tests/clc_capture.py",
            "timestamp": TS,
            "tokens": {"root": ROOT_TOKEN},
            "files": records,
            # `POST /api/project/open`: the header-only case reports progress TWICE
            # (the header read, then the completion call) — deterministic, not a bug
            "open": {
                "fresh.clc": _open_lines(fresh_path, directory),
                "plain.clc": _open_lines(directory / "plain.clc", directory),
            },
            "append": _append_record(directory / "plain.clc", directory / "append.clc"),
            "set_cpr_start": _cpr_record(directory / "plain.clc", directory / "slide.clc"),
            "read_only": _read_only_record(directory / "plain.clc", directory / "ro.clc"),
        }
        # the header a create writes is itself contract: one in-place write target
        meta = ProjectMeta(name="demo", model="test-model")
        expected["header"] = {
            "text": _header_text(meta),
            "cprLineOffset": _cpr_line_offset(meta),
            "eventRegionStart": _event_region_start(_header_text(meta).encode("utf-8")),
            "cprLineBytes": _CPR_START_LINE_BYTES,
        }
        # a fresh project's own reader agrees with the constants above
        read, total = _make_reader(fresh_path, None)
        expected["header"]["size"] = total
        expected["header"]["readStart"] = read(0, 8).decode("utf-8")

        files["expected.json"] = _dump(expected).encode("utf-8")
        return files


# ---- writing and checking ------------------------------------------------


def write(files: dict[str, bytes]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (OUT / name).write_bytes(data)


def verify(files: dict[str, bytes]) -> int:
    bad = []
    for name, data in sorted(files.items()):
        target = OUT / name
        if not target.exists():
            bad.append(f"{name}: missing")
        elif target.read_bytes() != data:
            bad.append(f"{name}: differs")
    if bad:
        print("clc goldens DO NOT reproduce:")
        for line in bad:
            print("  " + line)
        return 1
    print(f"clc goldens reproduce: {len(files)} files byte-identical")
    return 0


def main(argv: list[str]) -> int:
    files = capture()
    if "--check" in argv:
        return verify(files)
    write(files)
    print(f"wrote {len(files)} files to {OUT.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
