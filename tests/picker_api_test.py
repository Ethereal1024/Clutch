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
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.base import Broadcaster, RunState
from agent.browsing import valid_name
from agent.config import Config
from agent.core.project_lock import ProjectLock
from agent.server import build
from tests.testsupport import check, http_get, http_post


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


def _get(base: str, url: str) -> tuple[int, dict]:
    st, out = http_get(base + url)
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


def stat_route(base: str) -> None:
    """GET /api/fs/stat — the address bar's one question.

    The bar routes a typed path three ways (navigate / open / offer a create), so
    it asks the host what is there before it does any of them. An ABSENT path is
    the third answer, not a failure: while this route was missing from this host,
    typing a new .clc and pressing Enter answered 404 {"error": "not found"},
    which the picker showed as "Could not check path: not found" — and the create
    offer never appeared, so no new file could be made from the bar at all.
    """
    tmp = Path(tempfile.mkdtemp())
    (tmp / "here.clc").write_text("x", encoding="utf-8")

    st, got = _get(base, "/api/fs/stat?path=" + quote(str(tmp)))
    check(st == 200, f"a directory is 200 (got {st}: {got})")
    check(got.get("type") == "dir", f"and says it is one: {got}")

    st, got = _get(base, "/api/fs/stat?path=" + quote(str(tmp / "here.clc")))
    check(st == 200 and got.get("type") == "file", f"an existing file is a file: {got}")

    fresh = tmp / "not-yet.clc"
    st, got = _get(base, "/api/fs/stat?path=" + quote(str(fresh)))
    check(st == 200, f"an absent path is 200, never 404: the create offer ({got})")
    check(
        got.get("type") == "none" and got.get("error") is None,
        f"and absent is data in `type`, not an error: {got}",
    )
    check(
        got.get("path") == str(fresh),
        f"naming the path a create would produce (the offer splits it): {got}",
    )

    # a relative name means "under home", the same root the listing starts from —
    # so the answer a typed name gets and the directory it lands in cannot disagree
    st, got = _get(base, "/api/fs/stat?path=clutch-not-here-yet.clc")
    check(
        got.get("type") == "none" and got.get("path") == str(Path.home() / "clutch-not-here-yet.clc"),
        f"a relative name resolves under home: {got}",
    )

    # the create the offer leads to still works in that directory, and the answer
    # the bar was given names exactly the file the create writes
    st, got = _post(base, "/api/project/new", {"dir": str(tmp), "name": "not-yet.clc"})
    check(st == 200 and got.get("project") == str(fresh), f"the offered path is created: {got}")
    check(fresh.is_file(), "and the file is on disk where the offer said it would be")


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


def stat_remote_transport() -> None:
    """The same three answers over the SSH bridge — about the REMOTE filesystem.

    A remote picker that answered from the app host's own disk would offer to
    create a file on the wrong machine, so the stat has to be one exec over the
    bridge, exactly like the listing it sits beside.
    """
    import re

    import agent.browsing as browsing
    from agent.tools.transport import CommandResult

    state = RunState()
    state.backend_mode = "ssh"
    state.bridge_url = "http://127.0.0.1:1"  # never dialled: the transport is faked
    state.remote_root = "/home/u/proj"
    seen: list[str] = []

    class FakeTransport:
        def __init__(self, url: str) -> None:
            self.url = url

        def run(self, command: str, timeout: float, cancel=None, *, binary: bool = False):
            seen.append(command)
            found = re.search(r"'([^']*)'", command)
            target = (found.group(1) if found else "").rstrip("/")
            if target == "/home/u/proj":
                return CommandResult(code=0, stdout="dir\n", stderr="")
            if target == "/home/u/proj/notes.clc":
                return CommandResult(code=0, stdout="file\n", stderr="")
            return CommandResult(code=0, stdout="none\n", stderr="")

    real = browsing.SshTransport
    browsing.SshTransport = FakeTransport  # type: ignore[assignment]
    try:
        got = browsing.fs_stat(state, "")
        check(got == {"path": "/home/u/proj", "type": "dir", "error": None}, f"remote: the browse root is a dir: {got}")
        got = browsing.fs_stat(state, "notes.clc")
        check(
            got == {"path": "/home/u/proj/notes.clc", "type": "file", "error": None},
            f"remote: a relative name lands under the remote root: {got}",
        )
        got = browsing.fs_stat(state, "brand-new.clc")
        check(
            got == {"path": "/home/u/proj/brand-new.clc", "type": "none", "error": None},
            f"remote: an absent file is the create offer, not a failure: {got}",
        )
    finally:
        browsing.SshTransport = real  # type: ignore[assignment]
    check(len(seen) == 3, f"each stat is ONE exec over the bridge (got {len(seen)})")
    check(
        all("test -d" in c and "test -f" in c for c in seen),
        f"and that exec asks both questions in one round trip: {seen}",
    )


def main() -> None:
    name_policy()
    stat_remote_transport()
    base, srv = _serve()
    try:
        mkdir_route(base)
        stat_route(base)
        create_route(base)
    finally:
        srv.shutdown()
        srv.server_close()
    print("picker_api_test: all checks passed")


if __name__ == "__main__":
    main()
