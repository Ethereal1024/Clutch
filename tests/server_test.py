"""Server end-to-end check: boots the HTTP server in a thread and exercises it.

Run: uv run python -m tests.server_test
API/health/project are always checked. If a key is saved in ~/.clutch/settings.json
(the GUI settings; the Python side never reads env), also runs a
real task through /api/run, collects SSE events, and checks the workspace tree and
.clc persistence. Skips the real-run section when no key is present (network-free).
"""

from __future__ import annotations

import base64
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


def _saved_api_key() -> str:
    """The API key persisted by the GUI settings; the Python side never reads env."""
    try:
        d = json.loads(Path.home().joinpath(".clutch", "settings.json").read_text(encoding="utf-8"))
        return d.get("api_key") or ""
    except (OSError, json.JSONDecodeError):
        return ""


@contextlib.contextmanager
def _lock_held_elsewhere(clc_path: str, lock_path: str):
    """Another window (process) holding this .clc's write lock, while the block
    runs. POSIX: a flock on a fresh fd of the lock file. Windows: the product
    locks a byte range (LockFileEx), which no in-process trick can imitate, so a
    real holder PROCESS is the only faithful stand-in."""
    if fcntl is not None:
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


def _saved_endpoint() -> tuple[str, str]:
    """The (base_url, model) persisted by the GUI settings — the endpoint the
    saved key belongs to."""
    try:
        d = json.loads(Path.home().joinpath(".clutch", "settings.json").read_text(encoding="utf-8"))
        return d.get("base_url") or "", d.get("model") or ""
    except (OSError, json.JSONDecodeError):
        return "", ""


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

        with (
            mock.patch.object(server_mod, "load_settings", fake_load),
            mock.patch.object(server_mod, "save_settings", fake_save),
        ):
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


def _run_without_project_rejected(base_url) -> None:
    # 2. run without a project is rejected
    st, body = http_post(f"{base_url}/api/run", {"task": "hi"})
    check(st == 400, "run without project rejected")


def _empty_task_rejected(base_url) -> None:
    # 2b. reject empty task
    st, body = http_post(f"{base_url}/api/run", {"task": "   "})
    check(st == 400, "empty task rejected")


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
    # restore the saved endpoint so the real-run section targets a working pairing
    saved_url, saved_model = _saved_endpoint()
    check(bool(saved_url and saved_model), "saved endpoint present for the real-run section")
    st, body = http_post(f"{base_url}/api/settings", {"base_url": saved_url, "model": saved_model})
    check(st == 200, "settings restored")


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


def _symlink_marking(base_url, proj_dir, clc) -> None:
    # 3d. symlinks are marked with their resolved target in the browser + tree
    if not _symlinks_supported(proj_dir):
        # Windows without Developer Mode / SeCreateSymbolicLinkPrivilege
        # (a non-admin shell): os.symlink raises WinError 1314. The server's
        # symlink marking is already covered on hosts that can create them.
        print("skip: symlink checks (this host cannot create symlinks)")
    else:
        _check_symlink_marking(base_url, proj_dir, clc)


def _lazy_open_and_history(base_url, sdir) -> tuple[Path, int]:
    # 3e. lazy .clc: open reports older bytes; history pages by byte range
    from agent.events import AssistantMessageEvent, CompactionEvent, UserMessageEvent, _line_bytes, event_to_json

    lazy_dir = Path(sdir) / "lazywork"
    lazy_dir.mkdir()
    lclc = lazy_dir / "big.clc"
    levents = [UserMessageEvent(content="task")]
    for i in range(1, 500):
        levents.append(AssistantMessageEvent(content=f"old work {i}"))
    # compaction line offset = window start (persisted in header)
    comp_off = sum(_line_bytes(ev) for ev in levents[:450])
    levents.append(CompactionEvent(summary="old work summarized"))
    for i in range(501, 531):
        levents.append(AssistantMessageEvent(content=f"recent {i}"))
    from agent.memory import empty_index_line

    lazy_lines = [
        "# clutch project v1", "name: lazybig", "model: fake-model",
        f"cpr_start={comp_off:010d}", empty_index_line(), "---",
    ]
    for ev in levents:
        lazy_lines.append(event_to_json(ev))
    # newline="\n": byte-addressed .clc — CRLF would shift every offset
    lclc.write_text("\n".join(lazy_lines) + "\n", encoding="utf-8", newline="\n")

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
    st, body = http_get(f"{base_url}/api/history?before=1&limit=1000000")
    h3 = json.loads(body)
    check(h3.get("events") == [] and h3.get("older") == 0, "history before the task is empty")
    return lclc, comp_off


def _clc_read_and_append(base_url, lclc) -> dict:
    # 3f. /api/clc*: byte-level .clc service for decoupled tool modules —
    # exact bytes back (b64), append hands back the write offset, patch is
    # strictly in place, and the event log's size bookkeeping stays exact.
    disk0 = os.path.getsize(lclc)
    st, body = http_get(f"{base_url}/api/clc?lo=0&hi=16")
    c = json.loads(body)
    check(st == 200 and c.get("size") == disk0, "clc read reports the file size")
    check(base64.b64decode(c["b64"]) == b"# clutch project", "clc read returns exact bytes")
    st, body = http_get(f"{base_url}/api/clc?lo=0&hi=0")
    check(json.loads(body)["b64"] == "", "empty range is an empty payload")
    st, body = http_get(f"{base_url}/api/clc?lo=5&hi=3")
    check(st == 400, "clc read rejects lo > hi")
    st, body = http_get(f"{base_url}/api/clc?lo=99999999&hi=99999999")
    check(st == 200 and json.loads(body)["b64"] == "", "clc read clamps out-of-range hi")

    mem_line = '{"title": "tone", "content": "be terse", "updated": 1234.5}'
    st, body = http_post(f"{base_url}/api/clc/append", {"line": mem_line})
    a = json.loads(body)
    check(st == 200 and a.get("offset") == disk0, "append returns the pre-append size as offset")
    check(a.get("size") == disk0 + len(mem_line) + 1, "append size counts the newline")
    st, body = http_get(f"{base_url}/api/clc?lo={a['offset']}&hi={a['size']}")
    check(
        base64.b64decode(json.loads(body)["b64"]) == (mem_line + "\n").encode(),
        "append lands at the returned offset",
    )
    st, body = http_post(f"{base_url}/api/clc/append", {"line": "two\nlines"})
    check(st == 400, "append rejects embedded newlines")
    return a


def _clc_patch_memory_index(base_url, lclc, state, a) -> None:
    # the module's real flow: patch the header's fixed-width memory index in
    # place to point at the appended line (never growing the file)
    from agent.memory import index_line_from_offsets, parse_index_line, ring_add, ring_items

    st, body = http_get(f"{base_url}/api/clc?lo=0&hi={min(a['size'], 4096)}")
    head_raw = base64.b64decode(json.loads(body)["b64"])
    idx_off, idx_ln = 0, b""
    for ln in head_raw.split(b"\n"):
        if ln.startswith(b"memory_index="):
            idx_ln = ln
            break
        idx_off += len(ln) + 1
    check(bool(idx_ln), "clc read exposes the header memory_index line")
    count, hdr_head, offsets = parse_index_line(idx_ln.decode())
    check(count == 0, "fresh project index is empty")
    count, hdr_head = ring_add(count, hdr_head, offsets, a["offset"])
    new_ln = index_line_from_offsets(ring_items(count, hdr_head, offsets)).encode("ascii")
    check(len(new_ln) == len(idx_ln), "rebuilt index line keeps the fixed width")
    st, body = http_post(f"{base_url}/api/clc/patch", {"offset": idx_off, "b64": base64.b64encode(new_ln).decode()})
    check(st == 200 and json.loads(body).get("size") == a["size"], "patch keeps the file size")
    st, body = http_get(f"{base_url}/api/clc?lo=0&hi={min(a['size'], 4096)}")
    again = parse_index_line(base64.b64decode(json.loads(body)["b64"])[idx_off:].split(b"\n", 1)[0].decode())
    check(again is not None and a["offset"] in again[2], "patched index points at the appended line")
    st, body = http_post(f"{base_url}/api/clc/patch", {"offset": a["size"], "b64": base64.b64encode(b"x").decode()})
    check(st == 400, "patch refuses to grow the file")
    st, body = http_post(
        f"{base_url}/api/clc/patch", {"offset": a["size"] - 1, "b64": base64.b64encode(b"xy").decode()}
    )
    check(st == 400, "patch refuses an overwrite past EOF")
    st, body = http_post(f"{base_url}/api/clc/patch", {"offset": -1, "b64": ""})
    check(st == 400, "patch rejects a negative offset")
    st, body = http_post(f"{base_url}/api/clc/patch", {"offset": 0, "b64": "!!not-b64!!"})
    check(st == 400, "patch rejects invalid base64")

    # note_bytes_written kept the lazy log's window math exact: its byte
    # total still equals the on-disk size after the endpoint appends
    check(
        state.project.log._file_bytes == os.path.getsize(lclc),
        "endpoint appends are bookkept into the event log",
    )


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


def _broadcaster_bounded(broadcaster) -> None:
    # A subscriber that stops draining must not become an unbounded buffer: every
    # durable frame is in the log the client can re-read, so the honest answer is
    # to end its stream (LAGGED), not to hold the run's whole output in memory for
    # a window that is not reading.
    from agent.base import LAGGED, SUBSCRIBER_QUEUE_MAX

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
    # GHOST as a watcher. That count is what decides whether a project is
    # watched at all (the permission gate's is_attached, and the watchdog that
    # hands a .clc's write lock back), so a ghost silently holds the lock of a
    # project nobody has open. The FIN has to be looked FOR, not waited for.
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
        with contextlib.closing(urllib.request.urlopen(url, timeout=15)) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data: "):
                    continue
                ev = json.loads(line[6:])
                if ev.get("type") == "state_update" and ev.get("key") == "execution_status":
                    return ev.get("value")
        return None

    subscribers_before = broadcaster.count()
    probe_keepalive_saved = server_mod.SSE_KEEPALIVE_SEC
    server_mod.SSE_KEEPALIVE_SEC = 0.2
    try:
        check(first_status(f"{base_url}/api/events?replay=0") == "idle",
              "nothing in flight: a connecting window is told idle")
        state.busy = True
        state.run_project = str(clc)
        try:
            live = first_status(
                f"{base_url}/api/events?replay=0&project={quote(str(clc))}")
            other = first_status(
                f"{base_url}/api/events?replay=0&project={quote(str(clc.parent / 'elsewhere.clc'))}")
        finally:
            state.busy = False
            state.run_project = None
        check(live == "running",
              "reconnecting into a live run of THIS project is told running")
        check(other == "idle",
              "another project's run is still not leaked into this window's status")
        check(first_status(f"{base_url}/api/events?replay=0") == "idle",
              "a finished run reports idle again")
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

    # a run carrying project=<path> switches the active project before starting
    state.run_project = None
    state.api_key = "sk-fake"  # let start_task reach the busy check without LLM init
    state.busy = True  # busy -> 409, and the project of the live run is left alone
    st, _ = http_post(f"{base_url}/api/run", {"task": "noop", "project": str(clc2)})
    check(st == 409, "busy run rejected during switch test")
    check(
        str(state.project.path) == str(clc.resolve()),
        "a busy server never switches away from (and unlocks) the project of the live run",
    )
    state.busy = False
    state.api_key = None
    # not busy: the switch happens (the run itself fails without a key, which
    # is the part the lock section below builds on)
    st, _ = http_post(f"{base_url}/api/run", {"task": "noop", "project": str(clc2)})
    check(st == 500, "run without an LLM key fails")
    check(str(state.project.path) == str(clc2.resolve()), "run with project= switched the active project")
    # restore the demo project so the real-run section stays untouched
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "switched back to the demo project after isolation")
    return clc2


def _write_lock_one_writer(base_url, clc, clc2, state) -> None:
    # ---- 3f. per-window write lock: one writer per .clc ----
    # the server under test released its own lock first...
    from agent.core.project_lock import ProjectLock, _local_lock_path

    lock_path = _local_lock_path(str(clc))
    handle = state.project.lock if state.project is not None else None
    check(handle is not None, "open project holds a local lock")
    ProjectLock.release(handle)

    # ...and ANOTHER window (process) now holds it
    with _lock_held_elsewhere(str(clc), lock_path):
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
        check(st == 409, "second window open -> 409")
        err = json.loads(body)
        check(err.get("code") == "project_open_conflict", "409 carries project_open_conflict")

        # read-only open succeeds despite the lock, carries the flag in meta
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc), "read_only": True})
        check(st == 200, "read-only open succeeds while another window holds the lock")
        ro_meta = next(
            (m["meta"] for m in (json.loads(line) for line in body.splitlines() if line.strip()) if m.get("meta")),
            None,
        )
        check(ro_meta is not None and ro_meta.get("read_only") is True, "meta carries read_only")
        check(state.project is not None and state.project.read_only, "project is read-only")

        # a run on the read-only project is refused
        st, body = http_post(f"{base_url}/api/run", {"task": "hi"})
        check(st == 409, "run on a read-only project rejected")

        # a different project opens fine (the lock is per-path)
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc2)})
        check(st == 200, "different project opens while another holds demo's lock")

    # a read-only FALLBACK is not a life sentence: the window that held the lock
    # is gone, so asking for the claim again must succeed instead of answering
    # "close the other window first" for the rest of the session. Without the
    # retry the window is stuck read-only even though the .clc is free — the
    # user's "the project is locked AGAIN" long after the lock was handed back.
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc), "read_only": True})
    check(st == 200, "a free .clc still opens read-only when the flag is given")
    check(state.project is not None and state.project.read_only, "the fallback is read-only")
    check(state.project.lock is None, "and it holds no write lock")
    state.api_key = None  # no key: the run fails AFTER the claim is (re)taken
    st, body = http_post(f"{base_url}/api/run", {"task": "hi"})
    check(st == 500, "a run re-opens a read-only project once its lock is free (never 409)")
    check(state.project is not None and not state.project.read_only, "the window is writable again")
    check(state.project.lock is not None, "and it holds the write lock again")

    # the other window released -> the demo project opens normally again
    st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
    check(st == 200, "open works after the other window released")
    check(state.project is not None and not state.project.read_only, "reopen is writable again")


def _write_lock_follows_the_active_project(base_url, clc, clc2, state, sdir) -> None:
    from agent.core.project_lock import ProjectLock, _local_lock_path

    # ---- 3f-bis. the write lock FOLLOWS the active project ----
    # A window holds the write lock on at most its CURRENTLY-open project:
    # the moment the active project is replaced — by another project opened
    # for write or read-only, by a created one, by a run that switches — the
    # lock of the project left behind goes back to the pool. A lock that
    # outlives its project is unreachable (nothing keeps the handle, so
    # nothing could ever release it) and locks every other window out of that
    # .clc until this server exits.
    def lock_free(path: Path) -> bool:
        """Whether a second INDEPENDENT claim on this .clc still succeeds —
        the kernel truth, not the server's bookkeeping. The probe claims and
        immediately releases, so it leaves nothing held."""
        h = ProjectLock._acquire_local(str(path))
        if h is None:
            return False
        ProjectLock.release(h)
        return True

    def open_project(path: Path, read_only: bool = False) -> int:
        body = {"path": str(path)}
        if read_only:
            body["read_only"] = True
        st, _ = http_post(f"{base_url}/api/project/open", body)
        return st

    st = open_project(clc)
    check(st == 200 and state.project.lock is not None, "demo is open for write (lock held)")
    check(not lock_free(clc), "another window cannot claim the open project")

    # a read-only open gives the write claim up: the project left behind is
    # free again (and the read-only one never claims anything)
    st = open_project(clc2, read_only=True)
    check(st == 200, "b opens read-only")
    check(state.project.read_only and state.project.lock is None, "a read-only project holds no lock")
    check(lock_free(clc), "the project left for a read-only one hands its write lock back")

    # a WRITE reopen of the same project keeps the lock (it is reused, never
    # dropped and re-taken: another window's claim during that window would
    # be a spurious conflict)
    check(open_project(clc) == 200 and open_project(clc) == 200, "demo reopened for write twice")
    check(not lock_free(clc), "reopening the same project for write keeps the lock")

    # a created project is write-locked like an opened one (the window that
    # created it is its only writer from the first byte)
    lkdir = Path(sdir) / "lockwork"
    lkdir.mkdir()
    st, body = http_post(f"{base_url}/api/project/new", {"dir": str(lkdir), "name": "created"})
    check(st == 200, "project created")
    created = Path(json.loads(body)["project"])
    check(state.project.lock is not None, "a created project holds a write lock")
    check(not lock_free(created), "a second window cannot claim a created project")
    check(open_project(clc) == 200, "moved on to another project")
    check(lock_free(created), "the created project hands its lock back when left")

    # a create must never TAKE a path another window holds
    victim = lkdir / "taken.clc"
    with _lock_held_elsewhere(str(victim), _local_lock_path(str(victim))):
        st, body = http_post(f"{base_url}/api/project/new", {"dir": str(lkdir), "name": "taken"})
        check(st == 409, "create over another window's path is refused")
        check(json.loads(body).get("code") == "project_open_conflict", "the create conflict carries the code")
        check(not victim.exists(), "the refused create wrote nothing at all")

    # a run that switches the active project hands the old lock back too
    check(open_project(clc) == 200, "demo open for write again")
    state.api_key = None  # no key: the run fails, the switch is what is under test
    st, _ = http_post(f"{base_url}/api/run", {"task": "noop", "project": str(clc2)})
    check(st == 500, "run without a key fails (switch only)")
    check(str(state.project.path) == str(clc2.resolve()), "the run switched the active project")
    check(not lock_free(clc2), "the switched-to project holds the write lock")
    check(lock_free(clc), "the switched-away project hands its write lock back")

    st = open_project(clc)
    check(st == 200, "demo reopened for the real-run section")


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


def _unattended_lock_watchdog() -> None:
    # ---- 3h. a .clc's write lock never outlives its audience ----
    # The flock only dies with the PROCESS, so a window that is GONE — the app
    # quit, its client was killed, its session was reaped — leaves the .clc
    # claimed and every other window answered "already open in another window"
    # for as long as this server lives. What says a window is still there is its
    # SSE stream, and that stream has to be inspected (a half-closed tunnel
    # raises nothing on a write, so writes land in a buffer nobody reads):
    # otherwise a GHOST subscriber keeps the lock of a project nobody is
    # looking at. This section drives the watchdog and the release it calls on
    # its OWN state/broadcaster, so no background thread can touch the server
    # the other sections share.
    import socket as socket_

    from agent.core.project_lock import ProjectLock
    from agent.project import create_project, open_project_lazy
    from agent.server import peer_gone, unattended_lock_watchdog
    from agent.tools.workspace import LocalWorkspace

    # -- peer_gone: the FIN of a half-closed stream, noticed, nothing consumed
    alive, far = socket_.socketpair()
    try:
        check(peer_gone(None) is False, "no connection is not a gone peer")
        check(peer_gone(alive) is False, "a quiet open peer is not gone")
        far.send(b"GET / HTTP/1.1\r\n")
        check(peer_gone(alive) is False, "a peer with a pending request is not gone (data comes before the FIN)")
        check(alive.recv(18) == b"GET / HTTP/1.1\r\n", "and peer_gone consumed none of what it peeked")
        far.close()
        deadline = time.time() + 5
        while time.time() < deadline and not peer_gone(alive):
            time.sleep(0.05)
        check(peer_gone(alive) is True, "the peer's FIN is seen while the stream still looks writable")
    finally:
        alive.close()

    state = RunState()
    broadcaster = Broadcaster()
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

        check(not state.project.read_only and state.project.lock is not None, "the active project is write-claimed")
        check(claimed(), "and the kernel agrees the .clc is locked")

        # -- release_write_claim: the window stays, the claim goes
        check(state.release_write_claim() is True, "an unattended claim is handed back")
        check(state.project is not None and str(state.project.path) == key, "the project stays ACTIVE")
        check(state.project.read_only and state.project.lock is None, "it is read-only and holds no lock")
        check(not claimed(), "the .clc is free for another window")

        # -- a run in flight IS an editor: its claim must stand
        state.set_project(open_project_lazy(project.path, workspace=ws), workspace=ws)
        check(not state.project.read_only and claimed(), "the project is re-claimed for write")
        state.busy = True
        check(state.release_write_claim() is False, "a busy server never hands the claim back")
        check(claimed(), "the claim stands while the run is in flight")
        state.busy = False
        check(state.release_write_claim() is True, "and it goes back the moment the run ends")

        # -- the watchdog: a watching window keeps it, silence hands it back
        state.set_project(open_project_lazy(project.path, workspace=ws), workspace=ws)
        unattended_lock_watchdog(state, broadcaster, grace_s=0.3, poll_s=0.05)
        q = broadcaster.subscribe(key)  # a subscriber that publishes nothing is an audience
        try:
            time.sleep(1.0)  # several grace windows' worth of ticks
            check(not state.project.read_only and claimed(), "a watching window keeps the write lock")
        finally:
            broadcaster.unsubscribe(q)
        deadline = time.time() + 10
        while time.time() < deadline and not state.project.read_only:
            time.sleep(0.05)
        check(state.project.read_only, "nobody watching: the watchdog hands the lock back")
        check(not claimed(), "and the .clc is free again for any other window")


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

                st, _ = http_post(f"{base}/api/run", {"task": "hold the line", "project": str(clc)})
                check(st == 200, "run accepted against an endpoint that never answers")
                _, body = http_get(f"{base}/api/health")
                check(json.loads(body).get("in_flight") is True, "health: the run is in flight")

                deadline = time.time() + 10
                while time.time() < deadline and "user_message" not in clc.read_text(encoding="utf-8"):
                    time.sleep(0.05)
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
                check(final.get("status") == "error", "the release is recorded as an error, not a completion")
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
    finally:
        hang.close()


def _start_real_run(base_url, state) -> bool:
    # 4. real run (only with a key saved in ~/.clutch/settings.json)
    key = _saved_api_key()
    if not key:
        print("\n(no API key in ~/.clutch/settings.json - real-run section skipped)")
        print("\nall passed (network-free)")
        return False
    state.api_key = key  # the server uses the UI-saved key (no env fallback)

    st, body = http_post(
        f"{base_url}/api/run",
        {
            "task": (
                "write a file hello.txt containing the word hi using write_file, "
                "then read it with run_command cat hello.txt"
            ),
        },
    )
    check(st == 200 and body != "", "run accepted")
    return True


def _duplicate_run_rejected(base_url) -> None:
    # 4b. duplicate run rejected (busy)
    st, _ = http_post(f"{base_url}/api/run", {"task": "another"})
    check(st == 409, "concurrent run rejected")


def _collect_run_events(base_url) -> None:
    # collect SSE events
    events: list[dict] = []
    done = threading.Event()

    def sse_reader() -> None:
        try:
            # replay=0: this reader is after THIS run's frames, and a live durable
            # frame is wrapped in {offset, event} exactly like a replayed one, so
            # without the replay there is no second, historical copy to sort out
            with urllib.request.urlopen(f"{base_url}/api/events?replay=0", timeout=90) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if line.startswith("data: "):
                        ev = json.loads(line[6:])
                        # a durable record arrives with its log offset on it
                        if "event" in ev and isinstance(ev["event"], dict):
                            ev = ev["event"]
                        events.append(ev)
                        if ev.get("type") == "final":
                            done.set()
                            break
        except Exception as e:  # noqa: BLE001
            print(f"  [sse] {e}")

    rthread = threading.Thread(target=sse_reader, daemon=True)
    rthread.start()
    finished = done.wait(timeout=120)
    check(finished, "final event received within 120s")

    types = {e["type"] for e in events}
    check("tool_call" in types, "tool calls streamed")
    check("tool_result" in types, "tool results streamed")
    finals = [e for e in events if e["type"] == "final"]
    check(finals and finals[-1]["status"] == "completed", "final status completed")


def _workspace_tree(base_url, clc) -> None:
    # 5. workspace tree after run
    st, body = http_get(f"{base_url}/api/workspace/tree")
    data = json.loads(body)
    check(st == 200 and data.get("root"), "workspace tree has root")
    names = [n["name"] for n in data.get("tree", [])]
    check("hello.txt" in names, "workspace shows created file")
    check(clc.name not in names, ".clc file hidden from workspace tree")


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


def _stop_is_safe_on_idle(base_url, srv) -> None:
    # 7. stop is safe on idle
    st, _ = http_post(f"{base_url}/api/stop", {})
    check(st == 200, "stop on idle is safe")


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
        _run_without_project_rejected(base_url)
        _empty_task_rejected(base_url)
        _settings_api_key(base_url, state)
        _settings_endpoint(base_url, config)
        _settings_reasoning_effort(base_url, config)
        _settings_api_protocol(base_url, config)
        _host_defaults_table(base_url)
        clc = _create_project(base_url, proj_dir)
        _reopen_project(base_url, clc)
        _file_browser(base_url, proj_dir)
        _symlink_marking(base_url, proj_dir, clc)
        lclc, comp_off = _lazy_open_and_history(base_url, sdir)
        appended = _clc_read_and_append(base_url, lclc)
        _clc_patch_memory_index(base_url, lclc, state, appended)
        _clc_sse_replay(base_url, clc, comp_off)
        _sse_since_offset(base_url, lclc, clc, comp_off)
        _broadcaster_bounded(broadcaster)
        _sse_keepalive(base_url)
        _ghost_subscriber(base_url, broadcaster)
        _ghost_writer(base_url, broadcaster)
        _connecting_stream_status(base_url, clc, state, broadcaster)
        _live_frame_shape(base_url, clc, state, broadcaster)
        clc2 = _multi_window_isolation(base_url, clc, proj_dir, state, broadcaster)
        _write_lock_one_writer(base_url, clc, clc2, state)
        _write_lock_follows_the_active_project(base_url, clc, clc2, state, sdir)
        _remote_workspace_locks_locally()
        _dying_holder_frees_the_lock()
        _unattended_lock_watchdog()
        _session_release_is_recorded()
        if not _start_real_run(base_url, state):
            return 0
        _duplicate_run_rejected(base_url)
        _collect_run_events(base_url)
        _workspace_tree(base_url, clc)
        _undo_endpoint(base_url, clc)
        _clc_persisted_conversation(base_url, clc)
        _stop_is_safe_on_idle(base_url, srv)

        srv.shutdown()
        print("\nall passed (full)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
