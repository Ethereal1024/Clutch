"""The project picker's answers: what a name may be, "+ Folder", and Create.

Run: .venv/bin/python -m tests.picker_api_test

New Project is a create in a directory the user picked (POST /api/project/new):
the .clc's parent is the session's working directory, so the location is chosen
once, at creation. The picker therefore only needs to make folders, and this
suite pins the three things that can go wrong there:

  1. `valid_name` (agent/browsing.py) is the ONE name policy the picker's
     create row and mkdir share, so what the UI accepts is exactly what the host
     accepts: no separator, no control character, no "." or "..".
  2. POST /api/fs/mkdir makes one folder in the directory on screen, and
     "already exists" is answered as data (200 + error, like every other picker
     failure) rather than as an exception.
  3. POST /api/project/new refuses a path that is already a file: a create opens
     a new conversation, and the file it would have written over is an existing
     one (the reason the picker's Create row can be hit with a typed name that
     is already there — no stat stands between that button and the write).
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.base import Broadcaster, RunState
from agent.browsing import valid_name
from agent.config import Config
from agent.core.project_lock import ProjectLock
from agent.server import build
from tests.testsupport import check, http_post


def _serve() -> tuple[str, object]:
    cfg = Config(host="127.0.0.1", port=0)
    state = RunState()
    srv = build(cfg, Broadcaster(), state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{cfg.port}", srv


def _post(base: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    st, out = http_post(base + url, body)
    try:
        return st, json.loads(out)
    except ValueError:
        return st, {"raw": out}


def name_policy() -> None:
    check(valid_name("notes") is None, "an ordinary name is a name")
    check(valid_name("notes 2.txt") is None, "spaces and dots are fine in a name")
    for bad, why in (
        ("", "empty"),
        ("   ", "blank"),
        (".", "dot"),
        ("..", "dot dot"),
        ("a/b", "separator"),
        ("a\\b", "backslash"),
        ("a\nb", "newline"),
        ("a\0b", "nul"),
    ):
        check(valid_name(bad) is not None, f"{why} is refused as a name")


def mkdir_route(base: str) -> None:
    tmp = Path(tempfile.mkdtemp())
    st, got = _post(base, "/api/fs/mkdir", {"dir": str(tmp), "name": "notes"})
    check(st == 200, f"a new folder is 200 (got {st}: {got})")
    check(got["error"] is None, f"and reports no error: {got}")
    check(got["path"] == str(tmp / "notes"), f"answering the folder it made: {got['path']}")
    check((tmp / "notes").is_dir(), "the folder is on disk")

    st, got = _post(base, "/api/fs/mkdir", {"dir": str(tmp), "name": "notes"})
    check(st == 200, f"a name already taken is still 200 (got {st})")
    check("already exists" in (got["error"] or ""), f"answered as data: {got}")

    st, got = _post(base, "/api/fs/mkdir", {"dir": str(tmp), "name": "a/b"})
    check(st == 400, f"a name with a separator is 400 (got {st})")
    check("separator" in got.get("error", ""), f"and says why: {got}")

    st, got = _post(base, "/api/fs/mkdir", {"dir": str(tmp / "nope"), "name": "x"})
    check(st == 200, f"a directory that is not there is 200 (got {st})")
    check("no such directory" in (got["error"] or ""), f"with its own sentence: {got}")


def create_route(base: str) -> None:
    tmp = Path(tempfile.mkdtemp())
    kept = tmp / "kept.clc"
    original = "# clutch project v1\nname: kept\n---\n"
    kept.write_text(original, encoding="utf-8", newline="\n")

    st, got = _post(base, "/api/project/new", {"dir": str(tmp), "name": "kept"})
    check(st == 409, f"an existing .clc is a 409 (got {st}: {got})")
    check(got.get("code") == "project_exists", f"the refusal carries the code: {got}")
    check(
        got.get("error") == "kept.clc already exists — open it instead",
        f"and says what to do instead: {got}",
    )
    check(
        kept.read_text(encoding="utf-8") == original,
        "the refused create left the .clc byte-for-byte alone",
    )

    # the name that is CHECKED is the name that is WRITTEN (with_suffix): a typed
    # "kept.txt" would have landed on kept.clc
    st, got = _post(base, "/api/project/new", {"dir": str(tmp), "name": "kept.txt"})
    check(
        st == 409 and got.get("code") == "project_exists",
        f"a name that only differs in extension is the same .clc: {got}",
    )
    check(kept.read_text(encoding="utf-8") == original, "and nothing was truncated for it either")

    # a refused create hands its lock back: the next attempt over the same path
    # is still "already exists", not "open in another window"
    st, got = _post(base, "/api/project/new", {"dir": str(tmp), "name": "kept"})
    check(got.get("code") == "project_exists", f"the refusal released the write lock: {got}")

    # the guard refuses a file, not a name: a free one still creates
    st, got = _post(base, "/api/project/new", {"dir": str(tmp), "name": "fresh"})
    check(st == 200, f"a free name still creates (got {st}: {got})")
    check(got.get("project") == str(tmp / "fresh.clc"), f"answering the path it created: {got}")
    fresh = tmp / "fresh.clc"
    check(fresh.is_file(), "the file is on disk")
    created = fresh.read_bytes()

    # the same session creating the project it ALREADY has open: the lock comes
    # back reused (one window, one lock), so the answer is still the existence
    # one — and it must leave that lock HELD. A refusal that released it would
    # hand a live project's write lock to the next window that asked.
    st, got = _post(base, "/api/project/new", {"dir": str(tmp), "name": "fresh"})
    check(st == 409 and got.get("code") == "project_exists", f"a path this session holds is still refused: {got}")
    check(fresh.read_bytes() == created, "and the open project was not truncated")
    check(ProjectLock.inspect(str(fresh))["held"], "the refusal left the live project's write lock in place")


def main() -> None:
    name_policy()
    base, srv = _serve()
    try:
        mkdir_route(base)
        create_route(base)
    finally:
        srv.shutdown()
        srv.server_close()
    print("picker_api_test: all checks passed")


if __name__ == "__main__":
    main()
