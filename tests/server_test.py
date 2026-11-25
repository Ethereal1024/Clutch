"""Server end-to-end check: boots the HTTP server in a thread and exercises it.

Run: uv run python -m tests.server_test
API/health/project are always checked. The turn sections drive a TURN the way
the client does — claim the run slot, append the task line, run the tool call
through /api/exec, append the result and the final, release — so the workspace
tree, the rollback journal and the persisted transcript are checked with no
model and no network. There is no POST /api/run: the loop that drove a turn
lives in the client (P4), and a regression gate pins its absence.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

try:  # POSIX; Windows locks a byte range instead (see project_lock._acquire_local)
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

from agent.config import Config
from agent.server import Broadcaster, RunState, build
from agent.tools import catalog
from tests.testsupport import check, http_get, http_post, ui_source


@contextlib.contextmanager
def _lock_held_elsewhere(clc_path: str, lock_path: str, record: bool = False):
    """Another window (process) holding this .clc's write lock, while the block
    runs. POSIX: a flock on a fresh fd of the lock file. Windows: the product
    locks a byte range (LockFileEx), which no in-process trick can imitate, so a
    real holder PROCESS is the only faithful stand-in.

    ``record=True`` always uses that holder process, on every platform: a bare
    flock takes the lock but writes no OWNER RECORD, and a test of the 409's
    ``owner`` report needs a holder that says who it is."""
    if fcntl is not None and not record:
        with open(lock_path, "a+") as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(other, fcntl.LOCK_UN)
        return
    child = subprocess.Popen(
        [sys.executable, "-c", _HOLDER_CHILD, str(Path(__file__).resolve().parents[1]), clc_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None
        line = child.stdout.readline().strip()
        if line != "held":
            raise RuntimeError(f"lock-holder child did not take the lock: {line!r}")
        yield
    finally:
        if child.stdin is not None:
            child.stdin.close()
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            child.kill()


# a second "window": acquire the .clc lock exactly like the app does, then hold
# it until the parent closes our stdin (exit releases it — the OS drops the
# kernel lock either way)
_HOLDER_CHILD = (
    "import sys; sys.path.insert(0, sys.argv[1]);"
    "from agent.core.project_lock import ProjectLock;"
    "h = ProjectLock.acquire(sys.argv[2]);"
    "print('held' if h is not None else 'refused', flush=True);"
    "sys.stdin.readline() if h is None else sys.stdin.read();"
    "ProjectLock.release(h)"
)


def _symlinks_supported(dir_path: Path) -> bool:
    """Whether this host can create symlinks at all: Windows without Developer
    Mode / SeCreateSymbolicLinkPrivilege fails os.symlink with WinError 1314,
    which is an environment limit, not a server bug."""
    probe = dir_path / ".clutch-symlink-probe"
    try:
        probe.symlink_to(dir_path)
    except OSError:
        return False
    try:
        probe.unlink()
    except OSError:
        pass
    return True


def _check_symlink_marking(base_url: str, proj_dir: Path, clc: Path) -> None:
    """Symlinks must be marked with their resolved target, and a symlinked dir
    must not be recursed into (the tree walker follows entries, not links)."""
    symf = proj_dir / "demo_link"
    symf.symlink_to(clc)
    _, body = http_get(f"{base_url}/api/fs/list?path={quote(str(proj_dir))}")
    data = json.loads(body)
    link_ent = next((e for e in data["entries"] if e["name"] == "demo_link"), None)
    check(link_ent is not None and link_ent.get("link") == str(clc.resolve()), "fs list marks symlink target")

    linked = proj_dir / "linked"
    linked.mkdir()
    (linked / "inner.txt").write_text("x")
    symd = proj_dir / "linkdir"
    symd.symlink_to(linked, target_is_directory=True)
    _, body = http_get(f"{base_url}/api/workspace/tree")
    data = json.loads(body)
    lnode = next((n for n in data.get("tree", []) if n["name"] == "linkdir"), None)
    check(lnode is not None and lnode.get("link") == str(linked.resolve()), "tree marks symlink dir")
    check(lnode is not None and "children" not in lnode, "tree does not recurse into symlink dir")

    # a symlink LOOP is a legitimate directory entry, not a fatal one: Path.resolve()
    # raises RuntimeError("Symlink loop from ...") for it (and RuntimeError is not an
    # OSError), so one looping pair used to take down the whole listing and the whole
    # tree — the entry must be reported like any other unresolvable target instead
    (proj_dir / "loopa").symlink_to("loopb")
    (proj_dir / "loopb").symlink_to("loopa")
    _, body = http_get(f"{base_url}/api/fs/list?path={quote(str(proj_dir))}")
    data = json.loads(body)
    check(
        any(e["name"] == "loopa" for e in data.get("entries", [])),
        "fs list survives a symlink loop",
    )
    _, body = http_get(f"{base_url}/api/workspace/tree")
    data = json.loads(body)
    check(
        any(n["name"] == "loopa" for n in data.get("tree", [])),
        "workspace tree survives a symlink loop",
    )


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill a spawned holder process AND its children. On Windows a venv's
    python.exe is a redirector that re-executes the real interpreter as a CHILD
    (Popen's pid is only the launcher), so a plain kill leaves the true lock
    holder — the process the OS would have to reap for the lock to drop — alive."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.kill(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    proc.wait(timeout=15)


def _saved_knob(name: str) -> str | None:
    """A knob's value in the PERSISTED settings store (None = not stored), read
    through the server's own loader — the test patches it onto a temp file, so
    this is the same view the next server start would see."""
    import agent.server as server_mod
    from agent.config import flatten_settings

    return flatten_settings(server_mod.load_settings()).get(name) or None


def main() -> int:
    # isolate settings persistence to a temp file so the test never touches ~/.clutch
    from unittest import mock

    import agent.server as server_mod

    with tempfile.TemporaryDirectory() as sdir0:
        fake_settings = Path(sdir0) / "settings.json"

        def fake_load() -> dict:
            try:
                return json.loads(fake_settings.read_text())
            except (OSError, json.JSONDecodeError):
                return {}

        def fake_save(data: dict) -> None:
            fake_settings.write_text(json.dumps(data))

        # no parentheses around the list: 3.8 parses `with (a, b):` as ONE
        # tuple expression and dies with `AttributeError: __enter__`.
        with mock.patch.object(server_mod, "load_settings", fake_load), \
                mock.patch.object(server_mod, "save_settings", fake_save):
            _run_server_test()


def _health_and_cors(base_url) -> None:
    # 1. health + CORS + API-only routing (no static files)
    st, body = http_get(f"{base_url}/api/health")
    check(st == 200 and '"ok": true' in body, "health ok")
    req = urllib.request.Request(f"{base_url}/api/health")
    with urllib.request.urlopen(req, timeout=15) as r:
        check(r.headers.get("Access-Control-Allow-Origin") == "*", "CORS allow-origin present")
    st, _ = http_get(f"{base_url}/")
    check(st == 404, "root is not served (API-only server)")
    st, _ = http_get(f"{base_url}/app.js")
    check(st == 404, "static assets not served")


def _run_endpoint_retired(base_url) -> None:
    # 2. there is no POST /api/run any more (P4): the loop that drove a turn
    # lives in the client, so a task is never sent to this process at all. The
    # gate is a REGRESSION check rather than a validation check — a resurrected
    # endpoint would be a second driver on the same .clc, which is the one thing
    # the lease (POST /api/run/state) exists to prevent. The two refusals this
    # section used to make ("no project", "empty task") were its validations, so
    # the endpoint's absence covers both.
    for body in ({"task": "hi"}, {"task": "   "}, {"task": "hi", "project": "/tmp/x.clc"}):
        st, _ = http_post(f"{base_url}/api/run", body)
        check(st == 404, f"POST /api/run is gone, whatever the body ({sorted(body)})")


def _settings_api_key(base_url, state) -> None:
    # 2c. settings: persist an API key in-memory + to user dir
    st, body = http_post(f"{base_url}/api/settings", {"api_key": "sk-test-123"})
    check(st == 200, "settings accepted")
    check(state.api_key == "sk-test-123", "settings stored in state")
    state.api_key = None


def _settings_endpoint(base_url, config) -> None:
    # 2d. settings: one flat LLM endpoint (base_url/model/api_key)
    st, body = http_post(
        f"{base_url}/api/settings",
        {"base_url": "https://open.bigmodel.cn/api/coding/paas/v4", "model": "glm-5.3", "api_key": "sk-test-123"},
    )
    check(st == 200, "settings save accepted")
    check(
        config.base_url == "https://open.bigmodel.cn/api/coding/paas/v4" and config.model == "glm-5.3",
        "settings applied to live config",
    )
    st, body = http_get(f"{base_url}/api/settings")
    data = json.loads(body)
    check(
        data.get("base_url") == "https://open.bigmodel.cn/api/coding/paas/v4"
        and data.get("model") == "glm-5.3"
        and data.get("has_api_key") is True,
        "GET /api/settings returns the live LLM endpoint config",
    )
    check("api_key" not in data or not data["api_key"], "GET /api/settings never leaks api keys")


def _settings_reasoning_effort(base_url, config) -> None:
    # 2d2. reasoning_effort passthrough: applied live, validated, clearable
    st, body = http_post(f"{base_url}/api/settings", {"reasoning_effort": "max"})
    check(st == 200, "reasoning_effort save accepted")
    check(config.llm_reasoning_effort == "max", "reasoning_effort applied to live config")
    st, body = http_get(f"{base_url}/api/settings")
    check(json.loads(body).get("reasoning_effort") == "max", "GET reports the saved reasoning_effort")
    st, body = http_post(f"{base_url}/api/settings", {"reasoning_effort": "turbo"})
    check(st == 400, "invalid reasoning_effort rejected")
    st, body = http_post(f"{base_url}/api/settings", {"reasoning_effort": ""})
    check(st == 200, "empty reasoning_effort accepted (clears the knob)")
    check(config.llm_reasoning_effort is None, "empty reasoning_effort clears live config")


def _settings_api_protocol(base_url, config) -> None:
    # 2d3. api_protocol knob: same shape (applied live, validated, clearable)
    check(json.loads(http_get(f"{base_url}/api/settings")[1]).get("api_protocol") == "",
          "GET reports an unset api_protocol")
    st, body = http_post(f"{base_url}/api/settings", {"api_protocol": "responses"})
    check(st == 200, "api_protocol save accepted")
    check(config.llm_api_protocol == "responses", "api_protocol applied to live config")
    st, body = http_get(f"{base_url}/api/settings")
    check(json.loads(body).get("api_protocol") == "responses", "GET reports the saved api_protocol")
    check(_saved_knob("api_protocol") == "responses", "api_protocol persisted to the settings file")
    st, body = http_post(f"{base_url}/api/settings", {"api_protocol": "carrier-pigeon"})
    check(st == 400, "invalid api_protocol rejected")
    st, body = http_post(f"{base_url}/api/settings", {"api_protocol": ""})
    check(st == 200, "empty api_protocol accepted (clears the knob)")
    check(config.llm_api_protocol is None, "empty api_protocol clears live config")
    check(_saved_knob("api_protocol") is None, "cleared api_protocol leaves the settings file")

    # partial save: sending only the model keeps the saved base_url
    st, body = http_post(f"{base_url}/api/settings", {"model": "glm-5.3"})
    check(st == 200, "partial save accepted")
    check(config.base_url == "https://open.bigmodel.cn/api/coding/paas/v4", "partial save keeps the saved base_url")
    st, body = http_post(f"{base_url}/api/settings", {})
    check(st == 400, "empty settings body rejected")


def _host_defaults_table(base_url) -> None:
    # 2e. the host's own tables a renderer needs (GET /api/host): the ui
    # defaults the document (host.json) merged over the built-ins, served
    # rather than duplicated -- app.js's copy is only the fallback
    st, body = http_get(f"{base_url}/api/host")
    data = json.loads(body)
    check(st == 200 and "ui" in data, "GET /api/host answers with the host's ui table")
    check(data["ui"].get("chip") == catalog.DEFAULTS.get("chip"), "the served ui table IS catalog.DEFAULTS")
    check("mutates" not in data["ui"], "the host derives mutates per tool; the table holds no default for it")


def _create_project(base_url, proj_dir) -> Path:
    # 3. create a project
    st, body = http_post(f"{base_url}/api/project/new", {"dir": str(proj_dir), "name": "demo"})
    check(st == 200, "project created")
    pdata = json.loads(body)
    check(pdata.get("name") == "demo", "project name returned")
    clc = Path(pdata["project"])
    check(clc.suffix == ".clc" and clc.exists(), ".clc file exists")
    check(pdata.get("workdir") == str(proj_dir), "workdir is project dir")
    return clc


def _reopen_project(base_url, clc) -> None:
    # 3b. reopen the project (NDJSON stream: progress, meta, count, events)
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "project reopened")
    lines = [json.loads(line) for line in body.splitlines() if line.strip()]
    meta = next((m["meta"] for m in lines if m.get("meta")), None)
    check(meta is not None and meta.get("name") == "demo", "reopened project name")


def _file_browser(base_url, proj_dir) -> None:
    # 3c. server file browser (/api/fs/list)
    st, body = http_get(f"{base_url}/api/fs/list?path={quote(str(proj_dir))}")
    data = json.loads(body)
    check(
        data.get("error") is None and any(e["name"] == "demo.clc" and not e["dir"] for e in data["entries"]),
        "fs list shows the project file",
    )
    st, body = http_get(f"{base_url}/api/fs/list")
    data = json.loads(body)
    check(data.get("path") == str(Path.home()), "fs list defaults to home")
    st, body = http_get(f"{base_url}/api/fs/list?path=/nonexistent_clutch_xyz")
    data = json.loads(body)
    check(data.get("error"), "fs list reports a bad path")
    # 3c-bis. the address bar's one question (/api/fs/stat): navigate, open, or
    # offer a create. An ABSENT path is an answer, not an error — while this route
    # was missing from this host, the picker's answer to a typed new filename was
    # a 404 {"error": "not found"}, shown as "could not check path: not found",
    # and no new .clc could be created from the filename bar at all.
    st, body = http_get(f"{base_url}/api/fs/stat?path={quote(str(proj_dir))}")
    data = json.loads(body)
    check(st == 200 and data.get("type") == "dir", "fs stat: a directory is a directory")
    check(data.get("path") == str(proj_dir), "fs stat answers the path it resolved")
    st, body = http_get(f"{base_url}/api/fs/stat?path={quote(str(proj_dir / 'demo.clc'))}")
    data = json.loads(body)
    check(st == 200 and data.get("type") == "file", "fs stat: a project file is a file")
    fresh = proj_dir / "not-yet.clc"
    st, body = http_get(f"{base_url}/api/fs/stat?path={quote(str(fresh))}")
    data = json.loads(body)
    check(st == 200, "fs stat: an absent path is 200, never 404 (the create offer)")
    check(data.get("type") == "none" and data.get("error") is None, "fs stat: absent is data, not an error")
    check(data.get("path") == str(fresh), "fs stat names the path a create would produce")
    st, body = http_get(f"{base_url}/api/fs/stat?path=clutch-not-here.clc")
    data = json.loads(body)
    check(
        data.get("type") == "none" and data.get("path") == str(Path.home() / "clutch-not-here.clc"),
        "fs stat: a relative name means under home, the same root the listing starts from",
    )


def _symlink_marking(base_url, proj_dir, clc) -> None:
    # 3d. symlinks are marked with their resolved target in the browser + tree
    if not _symlinks_supported(proj_dir):
        # Windows without Developer Mode / SeCreateSymbolicLinkPrivilege
        # (a non-admin shell): os.symlink raises WinError 1314. The server's
        # symlink marking is already covered on hosts that can create them.
        print("skip: symlink checks (this host cannot create symlinks)")
    else:
        _check_symlink_marking(base_url, proj_dir, clc)


def _sse_adopts_the_window_project(base_url, clc, proj_dir, state) -> None:
    """3d-bis. A session that has no project ADOPTS the one its stream names.

    The window's open project lives in the RENDERER; the process serving it can
    be replaced under it (a tunnel end, the host's self-heal, a re-claim --
    ui/host-core.js claimWindowBackend), and a fresh session starts with no
    project and therefore no workspace. Every project-scoped view then answers
    "nothing open" -- the reported blank workspace panel after a reconnect,
    which only recovered when the user sent a task, the one other place a window
    names its project (/api/run). The SSE subscription is that same statement,
    and it arrives on its own: the stream that names a project makes it the
    session's (agent/api/events.py _adopt_for_sse).

    The replacement is staged with /api/backend, the one endpoint that drops the
    session's whole project context while the .clc stays on disk, unheld — the
    state a reconnecting window finds itself in.
    """
    (proj_dir / "adopt.txt").write_text("x", encoding="utf-8")  # something to find in the tree
    st, _ = http_post(f"{base_url}/api/backend", {"mode": "local"})
    check(st == 200, "the session's project context is dropped (a replaced session)")
    check(state.project is None and state.workspace is None, "and it starts with nothing open")
    st, body = http_get(f"{base_url}/api/workspace/tree")
    check(st == 200 and json.loads(body) == {"tree": [], "root": None},
          "every project-scoped view answers 'nothing open' (the blank panel)")

    # the reconnecting window names its project: the stream adopts it
    frames = _sse_collect(f"{base_url}/api/events?project={quote(str(clc))}")
    check(state.project is not None and str(state.project.path) == str(clc.resolve()),
          "the stream's ?project= becomes the session's project")
    check(any(f.get("type") == "replayed" for f in frames),
          "and the block that stream is owed is served (a project-less session serves none)")
    st, body = http_get(f"{base_url}/api/workspace/tree")
    data = json.loads(body)
    check(data.get("root") == str(proj_dir.resolve()), "the tree is rooted at the window's workdir")
    check("adopt.txt" in [n["name"] for n in data.get("tree", [])],
          "the workspace panel repaints WITHOUT the user sending a message")
    check(not state.project.read_only, "adopted for write: this window is the file's one writer again")


def _lazy_open_and_history(base_url, sdir) -> tuple[Path, int]:
    # 3e. lazy .clc: open reports older bytes; history pages by byte range
    from agent.events import AssistantMessageEvent, CompactionEvent, UserMessageEvent, _line_bytes, event_to_json

    lazy_dir = Path(sdir) / "lazywork"
    lazy_dir.mkdir()
    lclc = lazy_dir / "big.clc"
    levents = [UserMessageEvent(content="task")]
    for i in range(1, 500):
        levents.append(AssistantMessageEvent(content=f"old work {i}"))
    # a SECOND turn opens inside the pageable middle: `align=turn` has to have a
    # task row to walk back to that is not offset 0 (/api/history)
    levents.insert(300, UserMessageEvent(content="task two"))
    # compaction line offset = window start (persisted in header)
    comp_off = sum(_line_bytes(ev) for ev in levents[:450])
    levents.append(CompactionEvent(summary="old work summarized"))
    for i in range(501, 531):
        levents.append(AssistantMessageEvent(content=f"recent {i}"))
    lazy_lines = [
        "# clutch project v1", "name: lazybig", "model: fake-model",
        f"cpr_start={comp_off:010d}", "---",
    ]
    for ev in levents:
        lazy_lines.append(event_to_json(ev))
    # newline="\n": byte-addressed .clc — CRLF would shift every offset
    with open(lclc, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lazy_lines) + "\n")

    # every open is lazy now (one code path)
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(lclc)})
    check(st == 200, "lazy project reopened")
    llines = [json.loads(line) for line in body.splitlines() if line.strip()]
    lmeta = next((m["meta"] for m in llines if m.get("meta")), None)
    check(lmeta is not None and lmeta.get("name") == "lazybig", "lazy project name")
    lcount = next((m for m in llines if m.get("count") is not None), None)
    check(lcount is not None and lcount.get("older") == comp_off,
          "lazy open reports the older bytes (window start = cpr_start)")
    lsevs = [m for m in llines if m.get("event") and m.get("offset") is not None]
    check(lsevs and lsevs[0]["offset"] == comp_off,
          "lazy open streams the window first (offset cpr_start)")
    check(all(m["offset"] >= comp_off for m in lsevs),
          "window events carry byte offsets at/after the compaction line")
    check(all(isinstance(m.get("offset"), int) and "event" in m for m in lsevs),
          "lazy open events are {offset, event} wrapped")

    st, body = http_get(f"{base_url}/api/history?before={comp_off}&limit=1000000")
    h = json.loads(body)
    check(st == 200 and h.get("older") == 0, "history after the last page reports older=0")
    check(len(h["events"]) == 450, "history pages the task + the on-disk middle (450 events)")
    check(h["events"][0]["offset"] == 0 and h["events"][-1]["offset"] < comp_off,
          "history events carry byte offsets inside the paged region")
    st, body = http_get(f"{base_url}/api/history?before={comp_off}&limit=1000")
    h2 = json.loads(body)
    check(len(h2["events"]) < len(h["events"]), "history respects the byte-window clamp")
    # align=turn: a page is whole turns, not a byte window that cuts one (the UI
    # asks for 1 MiB; the median finished turn is ~278 KB, so an unaligned cut lands
    # mid-turn about every time, and the pane then folds a region whose head it has
    # never seen — ui/src/renderer/auto-fold.ts absorbIntoRegion is what reconciles that later)
    loffs = []
    pos = 0
    for ev in levents[:450]:
        loffs.append(pos)
        pos += _line_bytes(ev)
    task2_off = loffs[300]
    check(h2["events"][0]["event"]["type"] != "user_message",
          "the unaligned page at this offset opens mid-turn (that is the shape being fixed)")
    st, body = http_get(f"{base_url}/api/history?before={comp_off}&limit=1000&align=turn")
    h4 = json.loads(body)
    check(st == 200 and h4["events"][0]["offset"] == task2_off
          and h4["events"][0]["event"]["content"] == "task two",
          "align=turn opens the page on the task row the byte budget cut")
    check(h4.get("older") == task2_off,
          "and older is the widened start, so the next page resumes from the same task row")
    check(len(h4["events"]) > len(h2["events"]),
          "so the aligned page carries its whole turn, not the middle the window cut into")
    # the page after that one begins EXACTLY on the task row: widening it again would
    # hand the reader the turn before the one they asked for, page after page
    st, body = http_get(
        f"{base_url}/api/history?before={task2_off + 4096}&limit=4096&align=turn"
    )
    h5 = json.loads(body)
    check(h5["events"][0]["offset"] == task2_off and h5.get("older") == task2_off
          and len(h5["events"]) > 1,
          "a page whose budget already starts on a task row is left there (not widened "
          "into the turn before it)")
    st, body = http_get(f"{base_url}/api/history?before=1&limit=1000000")
    h3 = json.loads(body)
    check(h3.get("events") == [] and h3.get("older") == 0, "history before the task is empty")
    return lclc, comp_off


def _clc_sse_replay(base_url, clc, comp_off) -> None:
    evs2: list[dict] = []
    done2 = threading.Event()

    def sse_reader2() -> None:
        try:
            with urllib.request.urlopen(f"{base_url}/api/events", timeout=30) as r:
                seen_hist = False
                for raw in r:
                    line = raw.decode().strip()
                    if line.startswith("data: "):
                        ev = json.loads(line[6:])
                        evs2.append(ev)
                        if ev.get("type") == "history":
                            seen_hist = True
                        if seen_hist and "offset" in ev and "event" in ev:
                            done2.set()
                            break
        except Exception as e:  # noqa: BLE001
            print(f"  [sse2] {e}")

    rt2 = threading.Thread(target=sse_reader2, daemon=True)
    rt2.start()
    check(done2.wait(timeout=30), "SSE lazy replay opens with a history line")
    hist_idx = next((i for i, e in enumerate(evs2) if e.get("type") == "history"), None)
    first_off = next((i for i, e in enumerate(evs2) if "offset" in e and "event" in e), None)
    check(hist_idx is not None and isinstance(evs2[hist_idx].get("older"), int),
          "history line carries the older count")
    check(first_off is not None and hist_idx is not None and hist_idx < first_off,
          "history line precedes the offset-wrapped replay")
    check(evs2[first_off]["offset"] == comp_off, "SSE replay starts at the window's byte offset")

    # switch back to the demo project so the real-run section stays untouched
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "switched back to the demo project")


def _sse_collect(url: str, timeout: float = 30) -> list[dict]:
    """Read one SSE stream until its replay block closes (the `replayed` frame).

    The block boundary is a frame of its own (agent/api/events.py) because the
    renderer paints a catch-up in one pass: without it "the replay is over" is not
    on the wire, and the only way to guess it is a timeout.
    """
    out: list[dict] = []
    deadline = time.time() + timeout
    try:
        with contextlib.closing(urllib.request.urlopen(url, timeout=timeout)) as r:
            while time.time() < deadline:
                raw = r.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                try:
                    ev = json.loads(line[6:])
                except ValueError:
                    continue
                out.append(ev)
                if ev.get("type") == "replayed":
                    break
    except Exception as e:  # noqa: BLE001
        print(f"  [since] {e}")
    return out


def _records(frames: list[dict]) -> list[dict]:
    return [f for f in frames if "offset" in f and "event" in f]


def _sse_since_offset(base_url, lclc, clc, comp_off) -> None:
    # 3e-bis. `since=<offset>`: the ONE thing a (re)connecting window says about
    # what it already has. Every branch the phone's resume path used to carry --
    # probe the pipe, guess whether a replay is needed, fall back to the window --
    # is a decision made from a byte offset the client owns and the server can
    # honour. The window is [cpr_start, end): a `since` inside it is served from
    # memory, a `since` BEFORE it must also read the disk, or a window that was
    # away longer than the resident window silently loses the records in between.

    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(lclc)})
    check(st == 200, "lazy project reopened for the since= checks")

    win = _sse_collect(f"{base_url}/api/events?project={quote(str(lclc))}")
    recs = _records(win)
    check(bool(recs) and recs[0]["offset"] == comp_off,
          "no since: the resident window is served from its start")
    win_n = len(recs)
    last_off = recs[-1]["offset"]
    check(win[0].get("type") == "state_update" and win[0].get("key") == "execution_status",
          "every connect opens with the session's own run state, before any record")
    check(win[1] == {"type": "history", "older": comp_off},
          "the history line still opens the block with the on-disk count")
    check(win[-1] == {"type": "replayed", "count": win_n},
          "and the block is closed by a replayed frame with its record count")

    # a window that has painted the resident window asks for what came after it
    mid = _sse_collect(f"{base_url}/api/events?project={quote(str(lclc))}&since={comp_off}")
    mid_recs = _records(mid)
    check(all(r["offset"] > comp_off for r in mid_recs),
          "since=<window start>: nothing at or below the watermark comes back")
    check(len(mid_recs) == win_n - 1 and mid_recs[-1]["offset"] == last_off,
          "and the rest of the window is still owed, in order")
    check([r["offset"] for r in mid_recs] == sorted(r["offset"] for r in mid_recs),
          "replayed records are strictly in log order")

    # a window that was away longer than the resident window reaches the disk
    zero = _sse_collect(f"{base_url}/api/events?project={quote(str(lclc))}&since=0")
    zero_recs = _records(zero)
    on_disk = len(zero_recs) - win_n
    check(on_disk == 449,
          f"since=0 reads past the window start into the disk ({on_disk} older records)")
    check(zero_recs[0]["offset"] > 0,
          "a since is inclusive: the record AT the watermark is not sent back")
    check(zero_recs[-1]["offset"] == last_off,
          "the catch-up runs from the disk, through the window start, to the last record")
    check([r["offset"] for r in zero_recs] == sorted(r["offset"] for r in zero_recs),
          "and it is one strictly increasing sequence, not two blocks glued together")

    # at the head: nothing is owed, and the stream still opens (the status frame,
    # then the tail) -- a window that reconnects while idle must not be dropped
    end = _sse_collect(f"{base_url}/api/events?project={quote(str(lclc))}&since={last_off + 100000}")
    check(any(f.get("type") == "resync" for f in end),
          "a since past the end of the log is reported, not silently ignored")
    check(len(_records(end)) == win_n,
          "and the window is served instead of the offset that cannot be honoured")

    # a malformed since is the same as no since (never a silent half-answer)
    bad = _sse_collect(f"{base_url}/api/events?project={quote(str(lclc))}&since=nonsense")
    check(len(_records(bad)) == win_n, "an unparsable since falls back to the window")

    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "switched back to the demo project after the since= checks")


def _broadcaster_bounded() -> None:
    # A subscriber that stops draining must not become an unbounded buffer: every
    # durable frame is in the log the client can re-read, so the honest answer is
    # to end its stream (LAGGED), not to hold the run's whole output in memory for
    # a window that is not reading.
    #
    # Its OWN broadcaster, not the server's: the bound is a property of the
    # class, and the frames below are stand-ins (a raw dict is a page event, not
    # an Event) that a live SSE stream would rightly choke on. Publishing them
    # into the serving one races the reader threads the earlier sections left
    # behind and turns this unit check into six tracebacks from those threads.
    from agent.base import LAGGED, SUBSCRIBER_QUEUE_MAX

    broadcaster = Broadcaster()
    q = broadcaster.subscribe()
    try:
        for i in range(SUBSCRIBER_QUEUE_MAX):
            broadcaster.publish({"type": "text_delta", "content": str(i)})
        check(q.qsize() == SUBSCRIBER_QUEUE_MAX, "a draining-equal subscriber buffers its frames")

        broadcaster.publish({"type": "text_delta", "content": "one too many"})
        check(q.qsize() == 1, "the frame that overflows the bound drops the backlog")
        check(q.get_nowait() is LAGGED,
              "and leaves one marker: the stream ends, the client re-reads the log")

        # the subscriber that DOES drain is untouched: the bound is per queue
        q2 = broadcaster.subscribe()
        try:
            for i in range(SUBSCRIBER_QUEUE_MAX + 50):
                broadcaster.publish({"type": "text_delta", "content": str(i)})
                q2.get_nowait()
            check(q2.empty(), "a subscriber that keeps up is never marked")
        finally:
            broadcaster.unsubscribe(q2)
    finally:
        broadcaster.unsubscribe(q)


def _sse_keepalive(base_url) -> None:
    # ---- SSE keepalive: the idle stream reasserts itself BY NAME ----
    # The mouse hole this closes: the renderer cached the server state
    # ("running" drives the Stop button) and could only refresh it from this
    # stream, while a half-open socket raises no error on either side. The
    # old heartbeat was an SSE comment, which reaches no listener at all, so
    # a dead stream looked exactly like an idle one and the window froze on
    # "thinking" while the run went on. The frame must therefore be a NAMED
    # event, and the client must be able to derive its staleness window from
    # the very constant that paces it here.
    import agent.server as server_mod

    keepalive_saved = server_mod.SSE_KEEPALIVE_SEC
    server_mod.SSE_KEEPALIVE_SEC = 0.2  # patched in globally: the loop reads it per wait
    try:
        with contextlib.closing(urllib.request.urlopen(f"{base_url}/api/events", timeout=15)) as r:
            lines: list[str] = []
            deadline = time.time() + 15
            while time.time() < deadline:
                raw = r.readline()
                if not raw:
                    break
                lines.append(raw.decode("utf-8", "replace").strip())
                if lines[-2:] == ["event: ping", "data: {}"]:
                    break
            check(
                lines[-2:] == ["event: ping", "data: {}"],
                "an idle stream keeps the connection provably alive by name",
            )
            check(
                not [ln for ln in lines if ln.startswith(":")],
                "the keepalive is not an SSE comment (invisible to EventSource)",
            )
    finally:
        server_mod.SSE_KEEPALIVE_SEC = keepalive_saved

    app_js = ui_source()                       # every renderer module, in page order
    m = re.search(r"const SSE_KEEPALIVE_MS = (\d+);", app_js)
    check(
        m is not None and int(m.group(1)) == int(server_mod.SSE_KEEPALIVE_SEC * 1000),
        "the renderer liveness window matches the server keepalive (one constant, two languages)",
    )


def _ghost_subscriber(base_url, broadcaster) -> None:
    # ---- a HALF-CLOSED stream must stop counting as an audience ----
    # The mirror of the keepalive above: a tunnel torn down without a
    # close-notify (the app quit, the network went away) leaves the socket
    # writable — every keepalive lands in the kernel buffer of a window that
    # will never read it, so NO write raises and the server keeps counting a
    # GHOST as a watcher. That count is what decides whether a prompt still has
    # anyone to answer it (the permission gate's is_attached), so a ghost leaves
    # a run waiting on a window that will never answer. The FIN has to be looked
    # FOR, not waited for.
    import socket as socket_
    from urllib.parse import urlsplit

    import agent.server as server_mod

    keepalive_saved = server_mod.SSE_KEEPALIVE_SEC
    server_mod.SSE_KEEPALIVE_SEC = 0.2  # the tick that would notice is patched in globally
    ghost = None
    try:
        # the audience is compared by IDENTITY, not as a count: another
        # section's stream may end at any moment and would move a plain count
        # under this test's feet (the identity of the ghost's own queue cannot)
        before = set(broadcaster._subs)

        def new() -> set:
            """The subscribers that were not an audience when this section began."""
            return set(broadcaster._subs) - before

        parts = urlsplit(base_url)
        ghost = socket_.create_connection((parts.hostname, parts.port), timeout=15)
        ghost.sendall(b"GET /api/events HTTP/1.1\r\nHost: clutch\r\n\r\n")
        buf = b""
        deadline = time.time() + 15
        while time.time() < deadline and b"event: ping" not in buf:
            chunk = ghost.recv(4096)
            if not chunk:
                break
            buf += chunk
        check(b"event: ping" in buf, "a raw stream subscribes and is streamed to")
        check(len(new()) == 1, "and it counts as an audience while it is really there")

        # a HALF-close: the client's read side stays open (so the server's
        # writes keep succeeding — the exact live symptom), while the FIN says
        # nobody will ever read them
        ghost.shutdown(socket_.SHUT_WR)
        deadline = time.time() + 15
        while time.time() < deadline and new():
            time.sleep(0.05)
        check(
            new() == set(),
            "a half-closed stream is dropped from the audience (never written into as a ghost)",
        )
    finally:
        if ghost is not None:
            ghost.close()
        server_mod.SSE_KEEPALIVE_SEC = keepalive_saved


def _ghost_writer(base_url, broadcaster) -> None:
    # ---- a stream nobody can READ must end by itself ----
    # The keepalive section above drops a ghost by looking for its FIN while the
    # stream is IDLE. These are the two shapes that survive that check, and both
    # of them wedge a run: while the subscriber stays in the Broadcaster,
    # count(project) keeps answering "a UI is watching" — so the gate hands a
    # permission ask to a queue nobody drains, and its detach grace (the one
    # thing that ends a prompt nobody can answer) never starts.
    #
    #   * the peer CLOSED its socket while a busy run keeps this stream in its
    #     live branch: the idle tick that looks for the FIN never runs, and the
    #     kernel buffer swallows writes for megabytes before any of them fails;
    #   * the peer is merely not READING (a hung window, a tunnel whose client
    #     side is gone while its kernel keeps ACKing): no FIN ever arrives, so
    #     the write itself blocks — forever, with no send deadline, which also
    #     means the handler never reaches its `finally: unsubscribe()` at all.
    #
    # Both must end as the same fact the gate depends on: count() back to zero.
    import socket as socket_
    from urllib.parse import urlsplit

    import agent.server as server_mod
    from agent.events import AssistantMessageEvent

    parts = urlsplit(base_url)
    before = set(broadcaster._subs)

    def new() -> set:
        """The subscribers that were not an audience when this section began."""
        return set(broadcaster._subs) - before

    def subscribe(read_open_frames: bool) -> socket_.socket:
        """A raw SSE subscriber with no event loop behind it: a socket whose
        bytes are read only if the caller asks (the tiny receive buffer is what
        makes a reader-less window back up quickly)."""
        s = socket_.socket()
        s.setsockopt(socket_.SOL_SOCKET, socket_.SO_RCVBUF, 2048)
        s.settimeout(15)
        s.connect((parts.hostname, parts.port))
        s.sendall(b"GET /api/events HTTP/1.1\r\nHost: clutch\r\n\r\n")
        if read_open_frames:
            buf = b""
            deadline = time.time() + 15
            while time.time() < deadline and b'"type": "state_update"' not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
        return s

    keepalive_saved = server_mod.SSE_KEEPALIVE_SEC
    # the live branch is the one under test: an idle tick must be far away, so
    # the ONLY thing that can notice this peer's FIN is the write path itself
    server_mod.SSE_KEEPALIVE_SEC = 30
    fin_ghost = None
    try:
        fin_ghost = subscribe(read_open_frames=True)
        check(len(new()) == 1, "a busy stream has one subscriber to lose")
        fin_ghost.shutdown(socket_.SHUT_WR)  # the CLOSE, with events still flowing
        deadline = time.time() + 10
        while time.time() < deadline and new():
            broadcaster.publish(AssistantMessageEvent(content="tick"))
            time.sleep(0.02)
        check(
            new() == set(),
            "a stream that never idles still drops a peer whose FIN arrived",
        )
    finally:
        if fin_ghost is not None:
            fin_ghost.close()
        server_mod.SSE_KEEPALIVE_SEC = keepalive_saved

    # the second shape: nobody ever reads this socket, and nobody closes it (the
    # hung window, the tunnel whose client side vanished). Nothing is left to
    # notice but the write itself, so the write has a deadline (armed when the
    # stream opens — patched small here: the real bound is for a slow link, not
    # something this test can afford to wait out).
    write_saved = server_mod.SSE_WRITE_TIMEOUT_S
    server_mod.SSE_WRITE_TIMEOUT_S = 0.5
    silent = None
    try:
        silent = subscribe(read_open_frames=False)  # never read a byte
        # nothing is read back, so the subscription is proven by the count, not
        # by a frame: give the handler its moment to register
        deadline = time.time() + 10
        while time.time() < deadline and not new():
            time.sleep(0.05)
        check(len(new()) == 1, "the reader-less window is an audience until its buffer fills")
        for _ in range(12):  # enough to overrun any kernel buffer the pair may hold
            broadcaster.publish(AssistantMessageEvent(content="x" * 1_000_000))
            time.sleep(0.05)
        deadline = time.time() + 20
        while time.time() < deadline and new():
            time.sleep(0.1)
        check(
            new() == set(),
            "a stream whose peer stopped reading ends on the send deadline "
            "(so its handler reaches unsubscribe instead of blocking forever)",
        )
    finally:
        if silent is not None:
            silent.close()
        server_mod.SSE_WRITE_TIMEOUT_S = write_saved


def _connecting_stream_status(base_url, clc, state, broadcaster) -> None:
    import agent.server as server_mod

    # ---- the connecting stream carries the HOST's status, not a flat idle ----
    # A stream is also what a RECONNECTING window gets: an EventSource retry,
    # a phone coming back from the background, a tunnel healer. Telling it
    # "idle" while a run is in flight left a running task painted as idle for
    # the rest of the run (the run emits its own "running" only once, at the
    # start), so the frame must be derived from the host's own state.
    #
    # These probes hang up right after the first frame, and the server only
    # notices a hung-up subscriber when its next keepalive write fails — so
    # the keepalive is shortened for this section (the same lever the section
    # above uses) and the block waits for its own subscribers to be gone
    # before handing the broadcaster back to the isolation section.
    def first_status(url: str) -> str | None:
        frame = status_frame(url)
        return None if frame is None else frame.get("value")

    def status_frame(url: str) -> dict | None:
        with contextlib.closing(urllib.request.urlopen(url, timeout=15)) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data: "):
                    continue
                ev = json.loads(line[6:])
                if ev.get("type") == "state_update" and ev.get("key") == "execution_status":
                    return ev
        return None

    subscribers_before = broadcaster.count()
    probe_keepalive_saved = server_mod.SSE_KEEPALIVE_SEC
    server_mod.SSE_KEEPALIVE_SEC = 0.2
    try:
        check(first_status(f"{base_url}/api/events?replay=0") == "idle",
              "nothing in flight: a connecting window is told idle")
        # the run slot is the lease the client holds while it drives a turn
        # (POST /api/run/state): claiming it is what "a run is in flight" means
        # to this process now
        state.claim_run(str(clc))
        try:
            live = first_status(
                f"{base_url}/api/events?replay=0&project={quote(str(clc))}")
            other = first_status(
                f"{base_url}/api/events?replay=0&project={quote(str(clc.parent / 'elsewhere.clc'))}")
        finally:
            state.release_run(str(clc))
        check(live == "running",
              "reconnecting into a live run of THIS project is told running")
        check(other == "idle",
              "another project's run is still not leaked into this window's status")
        check(first_status(f"{base_url}/api/events?replay=0") == "idle",
              "a finished run reports idle again")

        # the frame answers the page's TWO "not writable" questions separately,
        # because they end differently: opened here as a viewer (this window may
        # never write) vs. another window RUNNING it right now (over with that
        # run, and then this window may send again)
        from agent.core.project_lock import _local_lock_path
        with _lock_held_elsewhere(str(clc), _local_lock_path(str(clc)), record=True):
            held = status_frame(f"{base_url}/api/events?replay=0&project={quote(str(clc))}")
        check(
            held is not None
            and held.get("read_only") is False
            and held.get("running_elsewhere") is True,
            f"a foreign run is running_elsewhere, not a read-only open ({held})",
        )
        after = status_frame(f"{base_url}/api/events?replay=0&project={quote(str(clc))}")
        check(
            after is not None and after.get("running_elsewhere") is False,
            f"and the end of that run is reported on connect too ({after})",
        )
        # hand the broadcaster back clean: no probe subscriber outlives this
        # block (a stale subscriber inflates broadcaster.count(), which the
        # isolation section below uses as "both windows are connected")
        deadline = time.time() + 10
        while broadcaster.count() > subscribers_before and time.time() < deadline:
            time.sleep(0.05)
        check(broadcaster.count() <= subscribers_before,
              "the status probes hang up cleanly (they leave no subscriber behind)")
    finally:
        server_mod.SSE_KEEPALIVE_SEC = probe_keepalive_saved


def _live_frame_shape(base_url, clc, state, broadcaster) -> None:
    import agent.server as server_mod
    from agent.events import AssistantMessageEvent, StateUpdateEvent, TextDeltaEvent

    # ---- a LIVE durable frame is stamped with the offset a replay will use ----
    # The renderer's reconnect watermark is the highest log offset it has already
    # painted: a replayed record at or below it is one this window has seen. A
    # record painted AS IT STREAMED must therefore arrive with the same offset a
    # replay of it would carry (the log stamps it at append; agent/api/events.py
    # wraps the frame), or nothing was recorded, and every reconnect repaints the
    # whole window — the transcript visibly doubled. A transient delta and a
    # host-made announcement are never appended: they stay bare, since they are
    # never replayed and there is nothing to dedupe.
    frames: list[dict] = []
    seen = threading.Event()

    def live_reader() -> None:
        try:
            with urllib.request.urlopen(f"{base_url}/api/events?replay=0", timeout=20) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if not line.startswith("data: "):
                        continue
                    ev = json.loads(line[6:])
                    frames.append(ev)
                    if ev.get("type") == "text_delta":
                        seen.set()  # published last: everything before it is in
                        return
        except Exception as e:  # noqa: BLE001
            print(f"  [live] {e}")

    subscribers_before = broadcaster.count()
    live_saved = server_mod.SSE_KEEPALIVE_SEC
    server_mod.SSE_KEEPALIVE_SEC = 0.2  # reap this probe's subscriber (see above)
    try:
        threading.Thread(target=live_reader, daemon=True).start()
        deadline = time.time() + 10
        while broadcaster.count() <= subscribers_before and time.time() < deadline:
            time.sleep(0.05)
        check(broadcaster.count() > subscribers_before, "the live-frame probe subscribed")

        # exactly what Agent._emit does: append the durable record, then publish
        live = AssistantMessageEvent(content="live frame probe")
        state.project.log.append(live)
        broadcaster.publish(live)
        delta = TextDeltaEvent(content="tok")
        state.project.log.append(delta)  # transient: never recorded
        broadcaster.publish(delta)
        broadcaster.publish(StateUpdateEvent(value="running"))  # host-made, never appended

        check(seen.wait(timeout=15), "the live stream delivered the frames")
        wrapped = [
            f for f in frames
            if isinstance(f.get("event"), dict) and f["event"].get("content") == "live frame probe"
        ]
        own = state.project.log.items()[-1][0]  # the log's own offset for that record
        check(bool(wrapped) and wrapped[0].get("offset") == own,
              f"a live durable frame is {{offset, event}} at the log's offset ({own})")
        deltas = [f for f in frames if f.get("type") == "text_delta"]
        check(len(deltas) == 1 and "offset" not in deltas[0],
              "a transient delta stays a bare frame (never replayed, nothing to dedupe)")
        statuses = [f for f in frames if f.get("type") == "state_update"]
        check(bool(statuses) and "offset" not in statuses[0],
              "a host-made status stays a bare frame")
        deadline = time.time() + 10
        while broadcaster.count() > subscribers_before and time.time() < deadline:
            time.sleep(0.05)
        check(broadcaster.count() <= subscribers_before,
              "the live-frame probe hangs up cleanly (no subscriber left behind)")
    finally:
        server_mod.SSE_KEEPALIVE_SEC = live_saved


def _multi_window_isolation(base_url, clc, proj_dir, state, broadcaster) -> Path:
    # ---- multi-window isolation: two SSE subscribers on different projects ----
    from agent.events import FinalEvent

    st, body = http_post(f"{base_url}/api/project/new", {"dir": str(proj_dir), "name": "iso-b"})
    check(st == 200, "second project created for isolation")
    clc2 = Path(json.loads(body)["project"])
    # reopen the demo project so the active project is A's file again
    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "active project is A again")

    evs_a: list[dict] = []
    evs_b: list[dict] = []
    done_a = threading.Event()
    done_b = threading.Event()

    def iso_reader(evs: list[dict], done: threading.Event, url: str, want: str) -> None:
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if line.startswith("data: "):
                        ev = json.loads(line[6:])
                        evs.append(ev)
                        if ev.get("type") == "final" and ev.get("summary") == want:
                            done.set()
                            break
        except Exception as e:  # noqa: BLE001
            print(f"  [iso] {e}")

    threading.Thread(
        target=iso_reader,
        args=(evs_a, done_a, f"{base_url}/api/events?project={quote(str(clc))}&replay=1", "iso-a"),
        daemon=True,
    ).start()
    threading.Thread(
        target=iso_reader,
        args=(evs_b, done_b, f"{base_url}/api/events?project={quote(str(clc2))}&replay=1", "iso-b"),
        daemon=True,
    ).start()
    deadline = time.time() + 10
    while broadcaster.count() < 2 and time.time() < deadline:
        time.sleep(0.05)
    check(broadcaster.count() >= 2, "both SSE subscribers connected")
    check(
        str(state.project.path) == str(clc.resolve()),
        "a subscriber on ANOTHER window's project never becomes the session's active one",
    )

    # a run on project A must reach only A's subscriber
    state.run_project = str(clc)
    broadcaster.publish(FinalEvent(status="completed", summary="iso-a"))
    check(done_a.wait(timeout=10), "A's subscriber received A's run final")
    time.sleep(0.3)  # give B's loop a chance to (wrongly) deliver the same event
    check(not any(e.get("summary") == "iso-a" for e in evs_b), "B's subscriber never saw A's run final")

    # a run on project B reaches only B's subscriber
    state.run_project = str(clc2)
    broadcaster.publish(FinalEvent(status="completed", summary="iso-b"))
    check(done_b.wait(timeout=10), "B's subscriber received B's run final")

    # a project switch while the run slot is held is refused: the project a run
    # is writing must not be swapped (and its write lock released) underneath it.
    # This used to be checked by sending a task with `project=`, a field only the
    # deleted /api/run knew; the gate itself lives in api/project and reads the
    # same lease.
    state.claim_run(str(clc))
    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(clc2)})
    check(st == 409, "a project switch during a run is refused")
    check(
        str(state.project.path) == str(clc.resolve()),
        "a busy server never switches away from (and unlocks) the project of the live run",
    )
    state.release_run(str(clc))
    # not busy: the switch happens, exactly as the run path used to do it
    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(clc2)})
    check(st == 200, "an idle session switches projects")
    check(str(state.project.path) == str(clc2.resolve()), "the switch took effect")
    # restore the demo project so the real-run section stays untouched
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "switched back to the demo project after isolation")
    return clc2


def _the_claim_belongs_to_the_run(base_url, clc, clc2, state) -> None:
    # ---- 3f. the write claim is the RUN's, not the open window's ----
    # The reported shape: one window merely LOOKING at a project made every other
    # window read-only for as long as it stayed open, and a client that connected
    # to an idle project could only ever watch it. Nothing writes a .clc outside a
    # run (the append, the window slide and the release line all sit under the
    # claim), so the claim has no business outliving the turn: it is taken when a
    # run starts and handed back when it ends, and "one writer per .clc" holds
    # exactly where it matters — while somebody is running.
    from agent.core.project_lock import ProjectLock, _local_lock_path

    def lock_free(path) -> bool:
        """Whether a second INDEPENDENT claim on this .clc still succeeds — the
        kernel truth, not the session's bookkeeping. The probe takes and drops the
        lock at once, so it leaves nothing held."""
        h = ProjectLock._acquire_local(str(path))
        if h is None:
            return False
        ProjectLock.release(h)
        return True

    def append() -> tuple[int, str]:
        return http_post(
            f"{base_url}/api/log",
            {"event": {"type": "user_message", "content": "claim probe"}},
        )

    def run_tool() -> tuple[int, str]:
        return http_post(
            f"{base_url}/api/exec",
            {"name": "run_command", "arguments": json.dumps({"command": "echo claim"}), "tool_call_id": "c1"},
        )

    # opened here and IDLE: nothing is claimed, so another window may run it too
    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "the demo opens")
    check(state._claim_lock is None, "an idle session holds no write claim")
    check(lock_free(clc), "an idle project is claimable by another window")
    check(not state.project.read_only, "and an idle open is not read-only")

    # ...but it may not write either: without the claim this session does not own
    # the turn, and a line appended here would land after a context it never read
    st, body = append()
    check(st == 409 and json.loads(body).get("code") == "not_running",
          "an idle session's append is refused (not_running)")
    st, body = run_tool()
    check(st == 409 and json.loads(body).get("code") == "not_running",
          "an idle session's exec is refused (not_running)")

    # ANOTHER window is running it now. Opening the file is a READ, so it no
    # longer conflicts — the same .clc opens here for write (the claim is taken
    # by whoever runs, not by whoever looks) ...
    with _lock_held_elsewhere(str(clc), _local_lock_path(str(clc)), record=True):
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
        check(st == 200, "opening a project another window RUNS is not a conflict")
        check(state.project is not None and not state.project.read_only,
              "and the open is not silently downgraded to read-only")

        # ...and a RUN here is refused, naming who has it: the caller's only
        # useful next move is to go and stop it THERE, which needs a name
        st, body = http_post(f"{base_url}/api/run/state", {"busy": True, "project": str(clc)})
        check(st == 409, "a second run on the same .clc is refused")
        err = json.loads(body)
        check(err.get("code") == "run_active", "409 carries run_active")
        owner = err.get("owner")
        check(isinstance(owner, dict) and isinstance(owner.get("pid"), int),
              "the refusal carries the holder's own statement about itself")

        # read-only is an explicit MODE now, not a fallback: asked for it, the
        # open says so in meta and both writers are refused for that reason
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc), "read_only": True})
        check(st == 200, "a read-only open is honoured while another window runs the file")
        ro_meta = next(
            (m["meta"] for m in (json.loads(line) for line in body.splitlines() if line.strip()) if m.get("meta")),
            None,
        )
        check(ro_meta is not None and ro_meta.get("read_only") is True, "meta carries read_only")
        check(state.project is not None and state.project.read_only, "project is read-only")
        st, body = append()
        check(st == 409 and json.loads(body).get("code") == "read_only",
              "an append on a read-only project is refused (read_only, not not_running)")
        st, body = run_tool()
        check(st == 409 and json.loads(body).get("code") == "read_only",
              "an exec on a read-only project is refused before any tool runs")

        # a different project opens (and runs) fine: the claim is per-path
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc2)})
        check(st == 200, "different project opens while another holds demo's claim")

    # the other window's run ended: the .clc is free, and this window is neither
    # read-only nor a writer — idle, exactly as an opener should be
    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "the demo opens again once the other run ended")
    check(not state.project.read_only and lock_free(clc),
          "an idle reopen is writable-by-run AND unclaimed")

    # a run claims it: this file now has exactly one writer
    check(state.claim_run(str(clc)) == "", "the run takes the claim")
    check(state.owns_claim(str(clc)), "and this session is the claimant")
    check(not lock_free(clc), "another window cannot claim a RUNNING project")
    st, _ = append()
    check(st == 200, "the claimant appends")
    st, body = run_tool()
    check(st == 200, "and the claimant's tool runs")

    # the turn ends: the claim goes back with it, and the next opener — another
    # window, or a later turn here — takes it without a reopen
    check(state.release_run(str(clc)) is True, "the turn hands the claim back")
    check(lock_free(clc), "the .clc is claimable again the moment the run ended")
    st, body = append()
    check(st == 409 and json.loads(body).get("code") == "not_running",
          "and this idle session may not append any more")


def _the_claim_never_outlives_its_run(base_url, clc, clc2, state, sdir) -> None:
    from agent.core.project_lock import ProjectLock, _local_lock_path

    # ---- 3f-bis. the claim never outlives its run ----
    # A session holds at most ONE claim, and it is the claim of the turn it is
    # driving. Two ways it could outlive that turn, both closed here: a project
    # switch under a live run (refused, so the claim cannot be left behind on a
    # file nobody drives) and a CREATE, which claims the path only long enough to
    # write the header — the project it returns is idle, like any other open.
    def lock_free(path) -> bool:
        """Whether a second INDEPENDENT claim on this .clc still succeeds — the
        kernel truth, not the server's bookkeeping. The probe claims and
        immediately releases, so it leaves nothing held."""
        h = ProjectLock._acquire_local(str(path))
        if h is None:
            return False
        ProjectLock.release(h)
        return True

    def open_project(path, read_only: bool = False) -> int:
        body = {"path": str(path)}
        if read_only:
            body["read_only"] = True
        st, _ = http_post(f"{base_url}/api/project/open", body)
        return st

    check(open_project(clc) == 200 and state._claim_lock is None,
          "an opened project is idle: it holds nothing")
    check(lock_free(clc), "so a second window may run it")

    check(state.claim_run(str(clc)) == "", "a run claims it")
    check(not lock_free(clc), "the .clc has one writer while the run is in flight")
    st, _ = http_post(f"{base_url}/api/project/open", {"path": str(clc2)})
    check(st == 409, "a project switch under a live run is refused")
    check(state.owns_claim(str(clc)), "so the claim cannot be left behind on the project it was taken for")

    check(state.release_run(str(clc)) is True, "the turn ends")
    check(lock_free(clc), "and the file is free again, with nothing to reopen")
    check(open_project(clc2) == 200, "an idle session switches projects")
    check(str(state.project.path) == str(clc2.resolve()), "the switch took effect")
    check(state._claim_lock is None, "a switch carries no claim with it")
    check(lock_free(clc2), "the switched-to project is idle too")

    # a run on the switched-to project owns it, and only until it ends
    check(state.claim_run(str(clc2)) == "", "the other project is claimed by its own run")
    check(not lock_free(clc2), "and it is the file's one writer meanwhile")
    state.release_run(str(clc2))
    check(lock_free(clc2), "the claim is handed back with the run")

    # a created project is claimed for the CREATE only: taking the lock is what
    # makes "the path is free and this header is its first byte" one question,
    # and the project handed back is idle — an idle project is claimed by nobody
    lkdir = Path(sdir) / "lockwork"
    lkdir.mkdir()
    st, body = http_post(f"{base_url}/api/project/new", {"dir": str(lkdir), "name": "created"})
    check(st == 200, "project created")
    created = Path(json.loads(body)["project"])
    check(state._claim_lock is None, "a created project comes back idle (its claim covered the create)")
    check(lock_free(created), "so a second window may run the project this one just created")
    check(open_project(clc) == 200, "moved on to another project")

    # ...but a create must never TAKE a path another window is RUNNING
    victim = lkdir / "taken.clc"
    with _lock_held_elsewhere(str(victim), _local_lock_path(str(victim))):
        st, body = http_post(f"{base_url}/api/project/new", {"dir": str(lkdir), "name": "taken"})
        check(st == 409, "create over another window's running path is refused")
        check(json.loads(body).get("code") == "project_open_conflict", "the create conflict carries the code")
        check(not victim.exists(), "the refused create wrote nothing at all")

    st = open_project(clc)
    check(st == 200, "demo reopened for the turn section")


def _remote_workspace_locks_locally() -> None:
    # ---- 3g. remote workspaces lock locally (kernel lock keyed by .clc path) ----
    from agent.core.project_lock import ProjectLock, _local_lock_path

    with tempfile.TemporaryDirectory() as rdir:
        root = Path(rdir)
        rclc = str(root / "remote.clc")
        (root / "remote.clc").write_text("x\n")

        h1 = ProjectLock.acquire(rclc)
        check(h1 is not None, "remote-path lock acquired (local kernel lock)")
        check(not (root / ".clc.lock").exists(), "no lock file is written on the remote host")
        check(Path(_local_lock_path(rclc)).exists(), "lock file lives in the local temp dir")

        # a second window (fresh process state) is refused — the lock is held
        saved_held = dict(ProjectLock._held)
        ProjectLock._held.clear()
        try:
            h2 = ProjectLock.acquire(rclc)
            check(h2 is None, "second window on the same remote project refused")
        finally:
            ProjectLock._held.update(saved_held)  # restore the demo handle

        ProjectLock.release(h1)
        check(ProjectLock.acquire(rclc) is not None, "fresh acquire after release")
        ProjectLock.release_all()

        # read-only remote dir must open for write (old lock file could not be created there)
        ro = root / "ro-dir"
        ro.mkdir()
        (ro / "proj.clc").write_text("x\n")
        ro.chmod(0o500)  # directory not writable by the ssh user
        try:
            h3 = ProjectLock.acquire(str(ro / "proj.clc"))
            check(h3 is not None, "acquire works in a read-only remote dir (no remote write)")
            ProjectLock.release(h3)
        finally:
            ro.chmod(0o700)  # restore so the temp dir cleans up


def _dying_holder_frees_the_lock() -> None:
    from agent.core.project_lock import ProjectLock

    # ---- 3h. a dying holder frees the lock ----
    # Both backends are KERNEL locks (flock / LockFileEx), so the OS drops the
    # lock when the holder dies — no pid check, no reclaim. Killing the holder
    # is therefore enough, but it does have to be the TRUE holder: see
    # _kill_tree (the venv python.exe is a redirector).
    with tempfile.TemporaryDirectory() as rdir:
        root = Path(rdir)
        rclc = str(root / "remote2.clc")
        (root / "remote2.clc").write_text("x\n")
        snippet = (
            "import sys,time; sys.path.insert(0,sys.argv[1]);"
            "from agent.core.project_lock import ProjectLock;"
            "ProjectLock.acquire(sys.argv[2]);"
            "print('LOCKED', flush=True);"
            "time.sleep(120)"
        )
        holder = subprocess.Popen(
            [sys.executable, "-c", snippet, str(Path(__file__).resolve().parents[1]), rclc],
            stdout=subprocess.PIPE,
        )
        try:
            deadline = time.time() + 15
            locked = False
            while time.time() < deadline:
                if holder.poll() is not None:
                    break
                if holder.stdout.readline().decode("utf-8", "replace").strip() == "LOCKED":
                    locked = True
                    break
                time.sleep(0.1)
            check(locked, "holder subprocess took the lock")
            check(ProjectLock.acquire(rclc) is None, "lock held by the live holder")
            _kill_tree(holder)
            freed = None
            for _ in range(50):  # the kernel drops the lock at process death
                freed = ProjectLock.acquire(rclc)
                if freed is not None:
                    break
                time.sleep(0.1)
            check(freed is not None, "lock freed when the holder died")
            ProjectLock.release_all()
        finally:
            if holder.poll() is None:
                _kill_tree(holder)


def _the_claim_lifecycle() -> None:
    # ---- 3g. the claim has one shape: a RUN takes it, and lets it go ----
    # `reclaim_write_claim` and the read-only FALLBACK it existed to cure are both
    # gone: read-only is how a session OPENED the file ("never write this"), never
    # something it settles into after a conflict. What a conflict means now is
    # "somebody is RUNNING this", and it ends by itself when that run ends — no
    # retry loop, no latch, nothing to reclaim. These are the four states the
    # claim can be in, driven on one session.
    from agent.core.project_lock import ProjectLock
    from agent.project import create_project, open_project_lazy
    from agent.server import RunState
    from agent.tools.workspace import LocalWorkspace

    with tempfile.TemporaryDirectory() as wdir:
        root = Path(wdir)
        ws = LocalWorkspace(str(root))
        state = RunState()
        state.set_project(create_project(root / "heal", "heal", workspace=ws), workspace=ws)
        key = str(state.project.path)

        def lock_free() -> bool:
            """Whether a SECOND independent claim on this .clc still succeeds —
            the kernel's answer, not the session's bookkeeping."""
            h = ProjectLock._acquire_local(key)
            if h is None:
                return False
            ProjectLock.release(h)
            return True

        # 1. IDLE — the open project, claimed by nobody. Anyone may run it.
        check(not state.busy and not state.owns_claim(key), "an idle session owns no claim")
        check(not state.foreign_claim(key), "and nobody else's claim is there either")
        check(lock_free(), "the kernel agrees the .clc is free")

        # 2. RUNNING — one claim, on this file, held by the kernel.
        check(state.claim_run(key) == "", "a run takes the claim")
        check(state.owns_claim(key) and state.owns_claim(), "this session is the claimant")
        check(not state.owns_claim(key + ".other"), "the claim is on a PATH, not on everything")
        check(not state.foreign_claim(key), "our own claim is never 'foreign'")
        check(state.busy and not lock_free(), "the run holds the slot and the file")
        check(state.claim_run(key) == "", "a heartbeat renews the claim it already has")

        # 3. RELEASED — the turn ended, and the file is free at once.
        check(state.release_run(key) is True, "the turn hands the claim back")
        check(not state.busy and not state.owns_claim(key), "the session is idle again")
        check(lock_free(), "and so is the .clc")
        check(state.release_run(key) is False, "a second release is a fact, not an error")

        # 4. A FOREIGN RUN — somebody else holds it: a claim here is refused, and
        # the refusal is what the UI turns into the read-only view.
        from agent.core.project_lock import _local_lock_path

        with _lock_held_elsewhere(key, _local_lock_path(key)):
            check(state.foreign_claim(key), "another session's run is visible as a foreign claim")
            check(not state.owns_claim(key), "and it is not ours")
            check(state.claim_run(key) == "run_active", "a second run on the file is refused")
            check(state._claim_lock is None, "the refusal takes nothing")
        check(not state.foreign_claim(key), "the foreign run ended: the claim is nobody's again")
        check(state.claim_run(key) == "", "and the next run takes it without a reopen")
        state.release_run(key)

        # read-only is a MODE, set at open and never a fallback: a session that
        # opened the file that way refuses its own run instead of guessing
        state.set_project(open_project_lazy(Path(key), workspace=ws, read_only=True), workspace=ws)
        check(state.project.read_only, "the project is read-only because it was OPENED that way")
        check(state.claim_run(key) == "read_only", "a read-only project never claims a run")
        check(state._claim_lock is None and lock_free(), "and it leaves the .clc exactly as it found it")
        state.set_project(open_project_lazy(Path(key), workspace=ws), workspace=ws)
        check(not state.project.read_only, "reopened for write, with no claim taken by the open")

        # a lease nobody renewed is no claim at all: the watch loop hands it back,
        # because the host that would have released it is gone and the kernel
        # cannot see a lease
        check(state.claim_run(key, ttl_s=0.05) == "", "a run takes a short lease")
        deadline = time.time() + 5
        while time.time() < deadline and state.busy:
            time.sleep(0.01)
        check(not state.busy, "the lease lapsed with its host gone")
        check(state.owns_claim(key), "the claim itself is still here (the kernel lock it stands on)")
        check(state.drop_expired_claim() is True, "the watch loop hands the lapsed claim back")
        check(not state.owns_claim(key) and lock_free(), "so the file can be claimed again")
        check(state.drop_expired_claim() is False, "with nothing left to drop")

        # a backend switch invalidates the project — and the claim taken on it
        state.set_project(open_project_lazy(Path(key), workspace=ws), workspace=ws)
        check(state.claim_run(key) == "", "a run claims the project")
        state.set_backend("local")
        check(state._claim_lock is None and lock_free(), "a mode switch takes the claim with the project")


def _lock_claim_identity() -> None:
    # ---- 3h. a .clc's claim names a PROCESS the kernel can check ----
    # The incident was a timer: a session guessed from silence that a window was
    # gone, so a .clc stayed claimed for hours when nothing guessed, and a claim
    # could be handed back under a live writer when something guessed wrong. The
    # replacement is evidence: the claim record names the WINDOW process, and only
    # the kernel may say whether it still exists (agent/core/procstat.py). The
    # decision to end such a session belongs to the host's reconciler
    # (agent/core/lock_reconcile.py), never to the session itself. This section
    # drives the SERVER side: what a session writes into the record, and that it
    # has no path at all to give a claim back on its own.
    import socket as socket_

    import agent.server as server_mod
    from agent.core import procstat
    from agent.core.project_lock import ProjectLock
    from agent.project import create_project
    from agent.tools.workspace import LocalWorkspace

    # -- peer_gone: the FIN of a half-closed stream, noticed, nothing consumed
    # (a ghost subscriber must stop counting as an audience, or the gate keeps
    # asking a prompt nobody can answer)
    alive, far = socket_.socketpair()
    try:
        check(server_mod.peer_gone(None) is False, "no connection is not a gone peer")
        check(server_mod.peer_gone(alive) is False, "a quiet open peer is not gone")
        far.send(b"GET / HTTP/1.1\r\n")
        check(
            server_mod.peer_gone(alive) is False,
            "a peer with a pending request is not gone (data comes before the FIN)",
        )
        check(alive.recv(18) == b"GET / HTTP/1.1\r\n", "and peer_gone consumed none of what it peeked")
        far.close()
        deadline = time.time() + 5
        while time.time() < deadline and not server_mod.peer_gone(alive):
            time.sleep(0.05)
        check(server_mod.peer_gone(alive) is True, "the peer's FIN is seen while the stream still looks writable")
    finally:
        alive.close()

    state = RunState()
    with tempfile.TemporaryDirectory() as wdir:
        root = Path(wdir)
        ws = LocalWorkspace(str(root))
        project = create_project(root / "watched", "watched", workspace=ws)
        state.set_project(project, workspace=ws)
        key = str(state.project.path)

        def claimed() -> bool:
            """Whether a SECOND independent claim on this .clc is still refused —
            the kernel's answer, not the server's bookkeeping."""
            h = ProjectLock._acquire_local(key)
            if h is None:
                return True
            ProjectLock.release(h)
            return False

        check(state.claim_run(key) == "", "a run takes the claim")
        check(not state.project.read_only and state.owns_claim(key), "the running project is write-claimed")
        check(claimed(), "and the kernel agrees the .clc is locked")

        # -- what the claim says: an identity the kernel can re-check, never
        # "somebody was watching a moment ago". A pid alone is not an identity
        # (the kernel recycles it), so the record carries the start tick and the
        # boot it belongs to; that is what the reconciler re-reads before it
        # signals anything.
        record = ProjectLock.owner(key)
        check(record is not None, "taking the claim writes an owner record")
        check(record.get("pid") == os.getpid(), "it names the serving process")
        check(
            record.get("starttime") == procstat.starttime(os.getpid()),
            "with the start tick the kernel prints for it (a recycled pid cannot match)",
        )
        check(record.get("boot_id") == procstat.boot_id(), "pinned to this boot")
        check(
            os.path.abspath(record.get("project") or "") == os.path.abspath(key),
            "and it says which .clc it is a claim on",
        )
        check(
            procstat.state(record["pid"], record.get("starttime", ""), record.get("boot_id", "")) == "live",
            "the kernel confirms the recorded holder is that very process",
        )

        # -- no self-release and no silence timer: a session cannot hand its claim
        # back by guessing. The flock dies with the PROCESS, and the decision to
        # end a session belongs to the host, which can see the window's pid.
        # Both absent names are REGRESSION GUARDS: the timer and the in-process
        # downgrade they used to drive are what the incident was made of.
        check(
            not hasattr(server_mod, "unattended_lock_watchdog") and not hasattr(server_mod, "release_orphaned_session"),
            "the session runs no silence watchdog (the timer that guessed is gone)",
        )
        check(
            not hasattr(RunState, "release_write_claim"),
            "and offers no way to hand its claim back while its window is unreachable",
        )
        check(claimed(), "so the claim stands for as long as this process holds it")

        # ...and it is the RUN that ends it — not silence, not a timeout — so the
        # record is gone with the claim instead of naming a session that no longer
        # holds anything
        check(state.release_run(key) is True, "the turn hands the claim back")
        check(not claimed(), "the .clc is free the moment the run ended")
        check(ProjectLock.owner(key) is None, "and the record went with the claim")


def _a_foreign_run_is_followed() -> None:
    # ---- 3h-bis. a page watching a project that ANOTHER window starts running ----
    # The other half of "the claim belongs to the run": the .clc this session
    # merely looks at can become somebody's run at any moment, and this process
    # can only learn that by asking. The watch loop asks the kernel, and says
    # three things on the wire, all of them TRANSITIONS: the project is somebody
    # else's run now (`running_elsewhere`, which is the page's pill and its
    # disabled composer), the lines that run appends (read out of the file with
    # `catch_up`, since the writer is another process), and — when the run ends —
    # that the composer is the user's again, with no reload and no retry.
    from queue import Empty

    import agent.server as server_mod
    from agent.core.persist import append_jsonl
    from agent.core.project_lock import _local_lock_path
    from agent.events import UserMessageEvent, event_to_json
    from agent.project import create_project
    from agent.tools.workspace import LocalWorkspace

    with tempfile.TemporaryDirectory() as wdir:
        root = Path(wdir)
        ws = LocalWorkspace(str(root))
        state = RunState()
        bc = Broadcaster()
        state.set_project(create_project(root / "watched", "watched", workspace=ws), workspace=ws)
        key = str(state.project.path)
        threading.Thread(
            target=server_mod.claim_watch_loop, args=(state, bc, 0.05), daemon=True
        ).start()
        q = bc.subscribe(key)
        try:

            def drain(key_: str, value: object, timeout: float = 10.0):
                """The next announcement of this key/value, or None."""
                deadline = time.time() + timeout
                while time.time() < deadline:
                    try:
                        ev = q.get_nowait()
                    except Empty:
                        time.sleep(0.02)
                        continue
                    if getattr(ev, "key", None) == key_ and getattr(ev, "value", None) == value:
                        return ev
                return None

            check(
                drain("running_elsewhere", False) is not None,
                "an idle project is announced nobody's run (the state a page connects to)",
            )

            # another window STARTS running it: nothing is opened here, no
            # conflict is reported anywhere, the page is simply told
            with _lock_held_elsewhere(key, _local_lock_path(key), record=True):
                check(
                    drain("running_elsewhere", True) is not None,
                    "a foreign run turns the page read-only, without a reload",
                )
                # that run's line, written the way the other window writes it
                line = event_to_json(UserMessageEvent(content="from the other window"))
                append_jsonl(key, line)
                seen = None
                deadline = time.time() + 10
                while time.time() < deadline and seen is None:
                    try:
                        ev = q.get_nowait()
                    except Empty:
                        time.sleep(0.02)
                        continue
                    if getattr(ev, "content", None) == "from the other window":
                        seen = ev
                check(seen is not None, "the foreign run's line is followed into this window's stream")

            check(
                drain("running_elsewhere", False) is not None,
                "the end of that run gives the composer back, unprompted",
            )
            check(state.claim_run(key) == "", "and the next run here claims the file with no reload")
            state.release_run(key)
        finally:
            bc.unsubscribe(q)


def _session_release_is_recorded() -> None:
    # ---- 3i. a session released mid-run still leaves a settled transcript ----
    # The outage's shape: the host releases a session whose run was in flight
    # (a stale reap, the last window's exit, /api/shutdown), the run's process
    # dies mid-turn, and the .clc tail ends in a tool_result or an
    # assistant_message with NO final — so the window could only watch
    # `running` flip to `idle`, with nothing anywhere saying what happened.
    # The release is the one thing no code of the run's own can report, so the
    # departing process writes it now, through the REAL stop ladder (soft
    # SIGTERM to the process group, then KILL_GRACE_S) and against a run that
    # genuinely never finishes: an endpoint that accepts and never answers.
    import socket

    import agent.procmgr.kill as procmgr_kill
    import agent.server as server_mod
    from agent.supervisor import PORT_BANNER_RE

    if os.name != "posix":
        print("(no deliverable graceful signal on Windows - release section skipped)")
        return

    hang = socket.socket()
    hang.bind(("127.0.0.1", 0))
    hang.listen(5)  # connect completes; no response ever comes
    hang_port = hang.getsockname()[1]

    def spawn_session() -> tuple[subprocess.Popen, int]:
        """A real session child, spawned the way the supervisor spawns one."""
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "agent.server",
                "--port",
                "0",
                "--base-url",
                f"http://127.0.0.1:{hang_port}/v1",
                "--model",
                "hang-model",
            ],
            cwd=str(Path(__file__).resolve().parents[1]),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            # the supervisor's own spawn: own process group, so the ladder's
            # killpg reaches this child (and its tools) and nothing else
            start_new_session=True,
        )
        port = None
        deadline = time.time() + 30
        while time.time() < deadline:
            line = proc.stdout.readline().decode("utf-8", "replace")
            if not line:
                break
            m = PORT_BANNER_RE.search(line)
            if m:
                port = int(m.group(1))
                break
        check(port is not None, "released-run session printed its port banner")
        return proc, port

    def events_in(path: Path) -> list[dict]:
        """The .clc's durable EVENT lines. A .clc opens with `key=value` meta
        lines and a `---` separator; only the event region is JSON, and an
        event line is the bare event dict (no wrapper — the {event: ...} shape
        belongs to the NDJSON/SSE wire, not the file)."""
        out: list[dict] = []
        for ln in path.read_text(encoding="utf-8").splitlines():
            if not ln.startswith("{"):
                continue
            try:
                ev = json.loads(ln)
            except ValueError:  # a memory line, or a torn write: not an event
                continue
            if isinstance(ev, dict) and "type" in ev:
                out.append(ev)
        return out

    try:
        with tempfile.TemporaryDirectory() as rdir:
            proc, port = spawn_session()
            try:
                base = f"http://127.0.0.1:{port}"
                st, body = http_post(f"{base}/api/project/new", {"dir": rdir, "name": "released"})
                check(st == 200, "released-run session owns a project")
                clc = Path(json.loads(body)["project"])
                _, body = http_get(f"{base}/api/health")
                check(json.loads(body).get("in_flight") is False, "health: no run before one starts")

                # a turn is in flight when a CLIENT holds the run slot on this
                # session (POST /api/run/state). The loop is not here any more,
                # so this is the only way the host can know a turn is open —
                # and the release handler reads exactly this flag.
                st, _ = http_post(f"{base}/api/run/state", {"busy": True, "project": str(clc)})
                check(st == 200, "the client claims the run slot against an open project")
                _, body = http_get(f"{base}/api/health")
                check(json.loads(body).get("in_flight") is True, "health: the run is in flight")

                # the turn's opening line, written the way the client writes it:
                # the outage's shape is a turn whose task line is in the .clc and
                # whose final never arrives
                st, _ = http_post(f"{base}/api/log", {"event": {"type": "user_message", "content": "hold the line"}})
                check(st == 200, "the turn's task line is in the .clc")
                evs = events_in(clc)
                check(evs and evs[-1]["type"] != "final", "the run in flight has no final yet (the outage's shape)")

                t0 = time.time()
                procmgr_kill.stop_process(proc, None)  # the REAL ladder, not a bare kill
                took = time.time() - t0
                check(proc.poll() is not None, "the released session is gone")
                check(
                    took < procmgr_kill.KILL_GRACE_S + 2.0,
                    "the soft signal was enough (the record cost us no hard kill)",
                )

                final = events_in(clc)[-1]
                check(final["type"] == "final", "the released run's last durable line is a final")
                check(
                    final.get("status") == "released",
                    "the release is recorded as released — neither a completion nor an in-session error",
                )
                check(
                    final.get("summary") == server_mod.RELEASED_SUMMARY,
                    "the final names the release: the host took the session while the run was in flight",
                )
            finally:
                if proc.poll() is None:
                    _kill_tree(proc)

            # the record belongs to a RUN, not to every session shutdown: a
            # released session with nothing in flight writes no ending at all
            proc2, port2 = spawn_session()
            try:
                base2 = f"http://127.0.0.1:{port2}"
                st, body = http_post(f"{base2}/api/project/new", {"dir": rdir, "name": "idle"})
                check(st == 200, "idle session owns a project")
                clc2 = Path(json.loads(body)["project"])
                procmgr_kill.stop_process(proc2, None)
                check(proc2.poll() is not None, "the idle session is gone")
                check(
                    not any(ev["type"] == "final" for ev in events_in(clc2)),
                    "a released session with no run in flight invents no ending",
                )
            finally:
                if proc2.poll() is None:
                    _kill_tree(proc2)

        # -- the ending is written ONCE, whatever brings the session down
        # Two sources can signal the same process within a moment of each other:
        # the host's reap ladder, and its lock reconciler ending an orphan's
        # process group (agent/core/lock_reconcile.py). A signal handler runs
        # once per delivery, so a second SIGTERM would append a second final to a
        # .clc whose tail holds exactly one ending.
        with tempfile.TemporaryDirectory() as gdir:
            from agent.events import UserMessageEvent
            from agent.project import create_project
            from agent.tools.workspace import LocalWorkspace

            gws = LocalWorkspace(gdir)
            gproject = create_project(Path(gdir) / "once", "once", workspace=gws)
            gstate = server_mod.RunState()
            gstate.set_project(gproject, workspace=gws)
            gstate.claim_run(str(gproject.path))
            # the run's shape: an open turn in the log (record_release reads the
            # log, not the lease — a run whose turn is already finalled has
            # nothing to report and correctly writes no second ending)
            gproject.log.append(UserMessageEvent(content="hold the line"))
            server_mod.record_release(gstate)
            server_mod.record_release(gstate)  # the second delivery
            finals = [ev for ev in events_in(Path(gproject.path)) if ev["type"] == "final"]
            check(len(finals) == 1, f"a double release writes one ending, not two (got {len(finals)})")
    finally:
        hang.close()


def _scripted_turn(base_url, clc) -> None:
    """4. ONE turn, driven the way the client drives it — and no model anywhere.

    This section used to be "send a task to /api/run and let the loop finish",
    which is why it only ran on a machine with a key saved: it called a real
    model. The loop lives in the client now (P4), so what the SERVER does for a
    turn is exactly this, verb by verb: claim the run slot, append the task
    line, run the call through /api/exec, append its result and the final,
    release. No key, no endpoint, no network — and the sections that used to be
    skipped on a keyless machine (workspace tree, rollback, the persisted
    transcript) now always run.
    """
    arguments = json.dumps({"path": "hello.txt", "content": "hi"})
    st, _ = http_post(f"{base_url}/api/run/state", {"busy": True, "project": str(clc)})
    check(st == 200, "the turn claims the run slot")
    st, _ = http_post(
        f"{base_url}/api/log",
        {"event": {"type": "user_message", "content": "write hello.txt containing hi"}},
    )
    check(st == 200, "the task line is durable before anything runs")
    st, _ = http_post(
        f"{base_url}/api/log",
        {
            "event": {
                "type": "tool_call",
                "name": "write_file",
                "arguments": arguments,
                "tool_call_id": "t1",
            }
        },
    )
    check(st == 200, "the call is durable before it runs (a crash leaves it unanswered)")
    st, body = http_post(
        f"{base_url}/api/exec",
        {"name": "write_file", "arguments": arguments, "tool_call_id": "t1"},
    )
    result = json.loads(body)
    check(st == 200 and result.get("is_error") is False, f"the tool ran on this machine ({body[:120]})")
    st, _ = http_post(
        f"{base_url}/api/log",
        {
            "event": {
                "type": "tool_result",
                "tool_call_id": "t1",
                "content": result.get("content", ""),
                "is_error": False,
                "diff": result.get("diff", ""),
            }
        },
    )
    check(st == 200, "the result is durable")
    st, _ = http_post(
        f"{base_url}/api/log",
        {"event": {"type": "final", "status": "completed", "summary": "wrote hello.txt"}},
    )
    check(st == 200, "the turn closes with a final")
    st, body = http_post(f"{base_url}/api/run/state", {"busy": False, "project": str(clc)})
    check(st == 200 and json.loads(body).get("released") is True, "the turn gives the slot back")


def _lease_shape(base_url, clc) -> None:
    # 4b. the slot is ONE lease, not a latch: a second claim on the same project
    # RENEWS it (a turn heartbeats), a claim naming another project is refused
    # (two drivers would write the same turn twice), and a release from a
    # non-holder is a fact rather than an error (Stop can arrive twice).
    st, body = http_post(f"{base_url}/api/run/state", {"busy": True, "project": str(clc), "ttl_ms": 5000})
    check(st == 200 and json.loads(body).get("lease_ms") == 5000, "a claim answers with the lease taken")
    st, body = http_post(f"{base_url}/api/run/state", {"busy": True, "project": str(clc), "ttl_ms": 5000})
    check(st == 200 and json.loads(body).get("busy") is True, "renewing the same claim is not a second driver")
    st, body = http_post(
        f"{base_url}/api/run/state", {"busy": True, "project": str(clc.parent / "other.clc")}
    )
    check(
        st == 409 and json.loads(body).get("code") == "project_mismatch",
        "a claim naming a project this session does not have open is refused",
    )
    st, body = http_post(f"{base_url}/api/run/state", {"busy": False, "project": str(clc)})
    check(st == 200 and json.loads(body).get("released") is True, "the holder gives the slot back")
    st, body = http_post(f"{base_url}/api/run/state", {"busy": False, "project": str(clc)})
    check(st == 200 and json.loads(body).get("released") is False, "a second release is not an error")


def _collect_run_events(base_url) -> None:
    # 4c. the turn is on the wire: every durable line is in the replay a
    # (re)connecting window gets, in order, each carrying the offset it was
    # stamped with. Read from the replay rather than from a live stream because
    # the turn has already closed — the live frames are these same objects, and
    # the replay is the only copy that cannot race the turn it is reading.
    records = _records(_sse_collect(f"{base_url}/api/events?replay=1"))
    events = [r["event"] for r in records if isinstance(r.get("event"), dict)]
    types = [e["type"] for e in events]
    check("tool_call" in types, "the tool call is on the wire")
    check("tool_result" in types, "the tool result is on the wire")
    check("user_message" in types and "final" in types, "the turn is bracketed by its task line and its final")
    finals = [e for e in events if e["type"] == "final"]
    check(finals and finals[-1]["status"] == "completed", "final status completed")
    check(all(isinstance(r.get("offset"), int) for r in records), "every replayed line carries its log offset")


def _workspace_tree(base_url, clc) -> None:
    # 5. workspace tree after run
    st, body = http_get(f"{base_url}/api/workspace/tree")
    data = json.loads(body)
    check(st == 200 and data.get("root"), "workspace tree has root")
    names = [n["name"] for n in data.get("tree", [])]
    check("hello.txt" in names, "workspace shows created file")
    check(clc.name not in names, ".clc file hidden from workspace tree")


def _rollback_endpoint(base_url, state) -> None:
    """5c. whole-task rollback: routing + guards on an idle, journal-less project.

    The journal itself (which mutations it holds, what a rollback puts back) is
    exercised in selfcheck against a real workspace; what is checked HERE is the
    endpoint contract the UI's long-press depends on before any run has happened:
    an honest empty checkpoint list, and a refusal — never a silent success — for
    an offset that is not a non-negative integer or that has nothing recorded.
    """
    st, body = http_get(f"{base_url}/api/workspace/checkpoints")
    data = json.loads(body)
    check(
        st == 200 and data.get("anchors") == [],
        "checkpoints answers an empty journal before any run",
    )
    for bad in (None, -1, True, "12"):
        st, _ = http_post(f"{base_url}/api/workspace/rollback", {} if bad is None else {"offset": bad})
        check(st == 400, f"rollback rejects a bad offset ({bad!r})")
    st, _ = http_post(f"{base_url}/api/workspace/rollback", {"offset": 1})
    check(st == 404, "rollback with nothing recorded for that task is refused")
    check(not state.busy, "the rollback guards above ran on an idle session")


def _undo_endpoint(base_url, clc) -> None:
    # 5b. undo endpoint: routing + guards (restore logic in selfcheck)
    st, body = http_post(f"{base_url}/api/workspace/revert", {"path": "hello.txt"})
    check(st == 404, "revert on a never-snapshot file returns 404")
    st, body = http_post(f"{base_url}/api/workspace/revert", {"path": "../escape"})
    check(st == 400, "revert rejects an escaping path")
    st, body = http_post(f"{base_url}/api/workspace/revert", {"path": clc.name})
    check(st == 400, "revert refuses the protected .clc")
    st, body = http_post(f"{base_url}/api/workspace/revert", {})
    check(st == 400, "revert requires a path")


def _rollback_after_real_run(base_url, clc) -> None:
    """5d. whole-task rollback on a REAL turn's own journal.

    This is the only place the two halves of the feature meet on the wire: the
    anchor the UI puts on a user row comes from the replay frame's ``offset``
    (agent/api/events.py), and the journal's anchor comes from the log offset the
    task line opened the checkpoint with — claim them equal here or "roll back
    to this message" addresses a different point of the log than the row does.

    Conditional on the journal being non-empty: only TOOL-declared writes are
    journaled, and a model free to run `echo ... > hello.txt` through a shell
    journals nothing, which is not a failure of the rollback (the deterministic
    anchor chain is covered by tests/selfcheck.py). The guards before the turn
    (_rollback_endpoint) proved the journal was empty, so every anchor here is
    one this turn recorded.
    """
    st, body = http_get(f"{base_url}/api/workspace/checkpoints")
    data = json.loads(body)
    anchors = data.get("anchors")
    check(st == 200 and isinstance(anchors, list), "checkpoints lists the journal after a run")
    check(
        all(isinstance(a, int) and not isinstance(a, bool) and a >= 0 for a in anchors or []),
        f"every anchor is a log offset (got {anchors})",
    )
    if not anchors:
        print("  (the run journaled no tool-declared write - the rollback-to-a-run check is skipped)")
        return

    user_offsets = {
        f["offset"]
        for f in _records(_sse_collect(f"{base_url}/api/events"))
        if isinstance(f.get("event"), dict) and f["event"].get("type") == "user_message"
    }
    anchored = user_offsets & set(anchors)
    check(
        bool(anchored),
        f"the journal's anchor is the wire offset of the run's user message (anchors {anchors}, wire {user_offsets})",
    )
    if not anchored:
        return  # nothing to aim a rollback at; the checks below would only guess
    anchor = min(anchored)

    clc_before = clc.read_text()
    st, body = http_post(f"{base_url}/api/workspace/rollback", {"offset": anchor})
    report = json.loads(body)
    check(st == 200, f"rollback to the run's own anchor is accepted ({body[:120]})")
    check(
        any(Path(p).name == "hello.txt" for p in (report.get("deleted") or [])),
        f"the rollback reports deleting the file the run created ({body[:160]})",
    )
    tree = json.loads(http_get(f"{base_url}/api/workspace/tree")[1])
    check(
        "hello.txt" not in [n["name"] for n in tree.get("tree", [])],
        "the file the run created is gone from the workspace tree",
    )
    check(clc.read_text() == clc_before, "the .clc transcript is untouched: a rollback undoes files, never history")
    st, _ = http_post(f"{base_url}/api/workspace/rollback", {"offset": anchor})
    check(st == 404, "the same run cannot be rolled back twice")


def _clc_persisted_conversation(base_url, clc) -> None:
    # 6. .clc persisted the conversation
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "project reopened after run")
    # /api/project/open streams NDJSON: meta, progress, event lines, done
    ev_types = [
        json.loads(line)["event"]["type"]
        for line in body.splitlines()
        if line.strip() and "event" in json.loads(line)
    ]
    check("user_message" in ev_types and "final" in ev_types, ".clc persisted conversation")


def _stop_is_safe_on_idle(base_url) -> None:
    # 7. Stop is safe on idle: the verb is gone, and its replacement is already
    # idempotent (a release from a non-holder answers released:false). The
    # regression gate is what keeps a resurrected /api/stop from becoming a
    # second, un-scoped way to deny a permission prompt.
    st, _ = http_post(f"{base_url}/api/stop", {})
    check(st == 404, "POST /api/stop is gone (the client cancels per tool call)")


def _run_server_test() -> int:
    config = Config(port=8899)
    broadcaster = Broadcaster()
    state = RunState()

    with tempfile.TemporaryDirectory() as sdir:
        proj_dir = Path(sdir) / "work"
        proj_dir.mkdir()
        srv = build(config, broadcaster, state)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        base_url = f"http://127.0.0.1:{config.port}"

        time.sleep(0.5)

        _health_and_cors(base_url)
        _run_endpoint_retired(base_url)
        _settings_api_key(base_url, state)
        _settings_endpoint(base_url, config)
        _settings_reasoning_effort(base_url, config)
        _settings_api_protocol(base_url, config)
        _host_defaults_table(base_url)
        clc = _create_project(base_url, proj_dir)
        _reopen_project(base_url, clc)
        _file_browser(base_url, proj_dir)
        _symlink_marking(base_url, proj_dir, clc)
        _sse_adopts_the_window_project(base_url, clc, proj_dir, state)
        _rollback_endpoint(base_url, state)
        lclc, comp_off = _lazy_open_and_history(base_url, sdir)
        _clc_sse_replay(base_url, clc, comp_off)
        _sse_since_offset(base_url, lclc, clc, comp_off)
        _broadcaster_bounded()
        _sse_keepalive(base_url)
        _ghost_subscriber(base_url, broadcaster)
        _ghost_writer(base_url, broadcaster)
        _connecting_stream_status(base_url, clc, state, broadcaster)
        _live_frame_shape(base_url, clc, state, broadcaster)
        clc2 = _multi_window_isolation(base_url, clc, proj_dir, state, broadcaster)
        _the_claim_belongs_to_the_run(base_url, clc, clc2, state)
        _the_claim_never_outlives_its_run(base_url, clc, clc2, state, sdir)
        _remote_workspace_locks_locally()
        _dying_holder_frees_the_lock()
        _the_claim_lifecycle()
        _lock_claim_identity()
        _a_foreign_run_is_followed()
        _session_release_is_recorded()
        _scripted_turn(base_url, clc)
        _lease_shape(base_url, clc)
        _collect_run_events(base_url)
        _workspace_tree(base_url, clc)
        _undo_endpoint(base_url, clc)
        _rollback_after_real_run(base_url, clc)
        _clc_persisted_conversation(base_url, clc)
        _stop_is_safe_on_idle(base_url)

        srv.shutdown()
        print("\nall passed (full)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
