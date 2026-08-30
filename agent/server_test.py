"""Server end-to-end check: boots the HTTP server in a thread and exercises it.

Run: uv run python -m agent.server_test
API/health/project are always checked. If a key is saved in ~/.clutch/settings.json
(the GUI settings; the Python side never reads env), also runs a
real task through /api/run, collects SSE events, and checks the workspace tree and
.clc persistence. Skips the real-run section when no key is present (network-free).
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

from .config import Config
from .server import Broadcaster, RunState, build
from .testsupport import check


def _saved_api_key() -> str:
    """The API key persisted by the GUI settings; the Python side never reads env."""
    try:
        d = json.loads(Path.home().joinpath(".clutch", "settings.json").read_text(encoding="utf-8"))
        return d.get("api_key") or ""
    except (OSError, json.JSONDecodeError):
        return ""


def http_get(url: str) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def http_post(url: str, body: dict) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


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

        # 2. run without a project is rejected
        st, body = http_post(f"{base_url}/api/run", {"task": "hi"})
        check(st == 400, "run without project rejected")

        # 2b. reject empty task
        st, body = http_post(f"{base_url}/api/run", {"task": "   "})
        check(st == 400, "empty task rejected")

        # 2c. settings: persist an API key in-memory + to user dir
        st, body = http_post(f"{base_url}/api/settings", {"api_key": "sk-test-123"})
        check(st == 200, "settings accepted")
        check(state.api_key == "sk-test-123", "settings stored in state")
        state.api_key = None

        # 2d. settings: the LLM endpoint (provider/model/base_url) is
        # configurable, not hard-locked to DeepSeek — switching provider moves
        # the whole endpoint to that provider's preset
        st, body = http_post(f"{base_url}/api/settings", {"provider": "zhipu", "api_key": "sk-test-123"})
        check(st == 200, "provider switch accepted")
        check(config.provider == "zhipu", "settings stores provider in live config")
        check(
            config.base_url == "https://open.bigmodel.cn/api/paas/v4",
            "provider preset fills the base_url (zhipu)",
        )
        check(config.model == "glm-4-flash", "provider preset fills the model (zhipu)")
        st, body = http_get(f"{base_url}/api/settings")
        data = json.loads(body)
        check(
            data.get("provider") == "zhipu"
            and data.get("base_url") == "https://open.bigmodel.cn/api/paas/v4"
            and data.get("model") == "glm-4-flash",
            "GET /api/settings returns the live LLM endpoint config",
        )

        # 2d2. multi-API profiles: save a named profile (doesn't clobber the
        # migrated "default" one), switch active, list without leaking keys
        st, body = http_post(
            f"{base_url}/api/settings",
            {"profile_name": "zhipu-53", "provider": "zhipu", "model": "glm-5.3", "api_key": "sk-zp-123"},
        )
        check(st == 200, "named profile save accepted")
        st, body = http_get(f"{base_url}/api/settings")
        data = json.loads(body)
        check(data.get("active") == "zhipu-53", "saving a profile activates it")
        names = [p["name"] for p in data.get("profiles", [])]
        check("zhipu-53" in names and "default" in names, "profiles list keeps saved + migrated profiles")
        zp = next(p for p in data["profiles"] if p["name"] == "zhipu-53")
        check(zp["model"] == "glm-5.3" and zp["has_api_key"] is True, "profile carries model + key flag")
        check('"api_key"' not in body, "GET /api/settings never leaks api keys")

        # 2d3. reasoning_effort passthrough: saved per profile, applied live,
        # validated, and clearable with an explicit empty value
        st, body = http_post(
            f"{base_url}/api/settings",
            {"profile_name": "zhipu-53", "provider": "zhipu", "model": "glm-5.3", "reasoning_effort": "max"},
        )
        check(st == 200, "profile save with reasoning_effort accepted")
        check(config.llm_reasoning_effort == "max", "reasoning_effort applied to live config")
        st, body = http_get(f"{base_url}/api/settings")
        data = json.loads(body)
        zp = next(p for p in data["profiles"] if p["name"] == "zhipu-53")
        check(zp.get("reasoning_effort") == "max", "GET reports the saved reasoning_effort")
        st, body = http_post(f"{base_url}/api/settings", {"reasoning_effort": "turbo"})
        check(st == 400, "invalid reasoning_effort rejected")
        st, body = http_post(
            f"{base_url}/api/settings",
            {"profile_name": "zhipu-53", "reasoning_effort": ""},
        )
        check(st == 200, "empty reasoning_effort accepted (clears the knob)")
        check(config.llm_reasoning_effort is None, "empty reasoning_effort clears live config")
        st, body = http_get(f"{base_url}/api/settings")
        data = json.loads(body)
        zp = next(p for p in data["profiles"] if p["name"] == "zhipu-53")
        check(zp.get("reasoning_effort", "") == "", "cleared knob not echoed on GET")

        # switching active applies the profile's config to the live server
        st, body = http_post(f"{base_url}/api/settings", {"activate": "default"})
        check(st == 200, "activate switch accepted")
        check(config.provider == "zhipu", "switch applies the profile to live config")
        st, body = http_get(f"{base_url}/api/settings")
        data = json.loads(body)
        check(data.get("active") == "default", "active reverted to default")
        check(any(p["name"] == "zhipu-53" for p in data["profiles"]), "switched-away profile still saved")
        # switching to an unknown profile is rejected
        st, body = http_post(f"{base_url}/api/settings", {"activate": "nope"})
        check(st == 400, "activate unknown profile rejected")
        # delete a profile
        st, body = http_post(f"{base_url}/api/settings", {"delete": "zhipu-53"})
        check(st == 200, "profile delete accepted")
        st, body = http_get(f"{base_url}/api/settings")
        data = json.loads(body)
        check(not any(p["name"] == "zhipu-53" for p in data["profiles"]), "deleted profile gone")
        # saving without profile_name targets the active profile (legacy UI path)
        st, body = http_post(
            f"{base_url}/api/settings",
            {"provider": "deepseek", "base_url": "https://api.deepseek.com", "model": "deepseek-v4-flash"},
        )
        check(st == 200, "legacy-style save still works")

        st, body = http_post(f"{base_url}/api/settings", {"provider": "no-such-provider"})
        check(st == 400, "unknown provider rejected")
        st, body = http_post(f"{base_url}/api/settings", {})
        check(st == 400, "empty settings body rejected")
        # restore DeepSeek defaults so later real-run sections still target DeepSeek
        st, body = http_post(
            f"{base_url}/api/settings",
            {
                "provider": "deepseek",
                "base_url": "https://api.deepseek.com",
                "model": "deepseek-v4-flash",
            },
        )
        check(st == 200, "settings restored to deepseek")
        check(config.provider == "deepseek", "restored provider in live config")

        # 3. create a project
        st, body = http_post(f"{base_url}/api/project/new", {"dir": str(proj_dir), "name": "demo"})
        check(st == 200, "project created")
        pdata = json.loads(body)
        check(pdata.get("name") == "demo", "project name returned")
        clc = Path(pdata["project"])
        check(clc.suffix == ".clc" and clc.exists(), ".clc file exists")
        check(pdata.get("workdir") == str(proj_dir), "workdir is project dir")

        # 3b. reopen the project (NDJSON stream: progress, meta, count, events)
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
        check(st == 200, "project reopened")
        lines = [json.loads(l) for l in body.splitlines() if l.strip()]
        meta = next((m["meta"] for m in lines if m.get("meta")), None)
        check(meta is not None and meta.get("name") == "demo", "reopened project name")

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

        # 3d. symlinks are marked with their resolved target in the browser + tree
        symf = proj_dir / "demo_link"
        symf.symlink_to(clc)
        st, body = http_get(f"{base_url}/api/fs/list?path={quote(str(proj_dir))}")
        data = json.loads(body)
        link_ent = next((e for e in data["entries"] if e["name"] == "demo_link"), None)
        check(link_ent is not None and link_ent.get("link") == str(clc.resolve()), "fs list marks symlink target")

        linked = proj_dir / "linked"
        linked.mkdir()
        (linked / "inner.txt").write_text("x")
        symd = proj_dir / "linkdir"
        symd.symlink_to(linked, target_is_directory=True)
        st, body = http_get(f"{base_url}/api/workspace/tree")
        data = json.loads(body)
        lnode = next((n for n in data.get("tree", []) if n["name"] == "linkdir"), None)
        check(lnode is not None and lnode.get("link") == str(linked.resolve()), "tree marks symlink dir")
        check(lnode is not None and "children" not in lnode, "tree does not recurse into symlink dir")

        # 3e. lazy .clc (compaction + enough durable events): the open stream
        # reports the on-disk older count and wraps every event as {seq, event};
        # /api/history pages the middle records; the SSE replay opens with a
        # history info line before the seq-wrapped tail.
        from .events import AssistantMessageEvent, CompactionEvent, UserMessageEvent, event_to_json

        lazy_dir = Path(sdir) / "lazywork"
        lazy_dir.mkdir()
        lclc = lazy_dir / "big.clc"
        lazy_lines = [
            "# clutch project v1", "name: lazybig", "model: fake-model", "---",
            event_to_json(UserMessageEvent(content="task")),
        ]
        for i in range(1, 500):
            lazy_lines.append(event_to_json(AssistantMessageEvent(content=f"old work {i}")))
        lazy_lines.append(event_to_json(CompactionEvent(summary="old work summarized", tail_start=450)))
        for i in range(501, 531):
            lazy_lines.append(event_to_json(AssistantMessageEvent(content=f"recent {i}")))
        lclc.write_text("\n".join(lazy_lines) + "\n", encoding="utf-8")

        st, body = http_post(f"{base_url}/api/project/open", {"path": str(lclc)})
        check(st == 200, "lazy project reopened")
        llines = [json.loads(l) for l in body.splitlines() if l.strip()]
        lmeta = next((m["meta"] for m in llines if m.get("meta")), None)
        check(lmeta is not None and lmeta.get("name") == "lazybig", "lazy project name")
        lcount = next((m for m in llines if m.get("count") is not None), None)
        check(lcount is not None and lcount.get("older") == 449, "lazy open reports the older count")
        lsevs = [m for m in llines if m.get("event") and m.get("seq") is not None]
        check([m["seq"] for m in lsevs] == [0] + list(range(450, 531)),
              "lazy open streams seq 0 + the preserved tail")
        check(all(isinstance(m.get("seq"), int) and "event" in m for m in lsevs),
              "lazy open events are {seq, event} wrapped")

        st, body = http_get(f"{base_url}/api/history?before=450&limit=500")
        h = json.loads(body)
        check(st == 200 and h.get("older") == 0, "history after the last page reports older=0")
        check([e["seq"] for e in h["events"]] == list(range(1, 450)),
              "history pages the on-disk middle")
        st, body = http_get(f"{base_url}/api/history?before=450&limit=100")
        h2 = json.loads(body)
        check([e["seq"] for e in h2["events"]] == list(range(350, 450)),
              "history respects the limit clamp")
        st, body = http_get(f"{base_url}/api/history?before=1&limit=100")
        h3 = json.loads(body)
        check(h3.get("events") == [] and h3.get("older") == 0, "history before seq 1 is empty")

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
                            if seen_hist and "seq" in ev and "event" in ev:
                                done2.set()
                                break
            except Exception as e:  # noqa: BLE001
                print(f"  [sse2] {e}")

        rt2 = threading.Thread(target=sse_reader2, daemon=True)
        rt2.start()
        check(done2.wait(timeout=30), "SSE lazy replay opens with a history line")
        hist_idx = next((i for i, e in enumerate(evs2) if e.get("type") == "history"), None)
        first_seq = next((i for i, e in enumerate(evs2) if "seq" in e and "event" in e), None)
        check(hist_idx is not None and isinstance(evs2[hist_idx].get("older"), int),
              "history line carries the older count")
        check(first_seq is not None and hist_idx is not None and hist_idx < first_seq,
              "history line precedes the seq-wrapped replay")
        check(evs2[first_seq]["seq"] == 0, "SSE replay starts at seq 0")

        # switch back to the demo project so the real-run section stays untouched
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
        check(st == 200, "switched back to the demo project")

        # ---- multi-window isolation: two SSE subscribers on different projects ----
        from .events import FinalEvent

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
        state.busy = True  # busy -> 409, but the switch already happened
        st, _ = http_post(f"{base_url}/api/run", {"task": "noop", "project": str(clc2)})
        check(st == 409, "busy run rejected during switch test")
        check(str(state.project.path) == str(clc2.resolve()), "run with project= switched the active project")
        state.busy = False
        state.api_key = None
        # restore the demo project so the real-run section stays untouched
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
        check(st == 200, "switched back to the demo project after isolation")

        # ---- 3f. per-window write lock: one writer per .clc ----
        # (the reopen above holds the demo lock in-process; simulate ANOTHER
        # window by dropping our handle and flocking a fresh fd — flock is
        # exclusive even between two fds of one process, so this models the
        # other process exactly)
        import fcntl

        from .core.project_lock import ProjectLock, _local_lock_path

        lock_path = _local_lock_path(str(clc))
        handle = state.project.lock if state.project is not None else None
        check(handle is not None and handle.kind == "local", "open project holds a local lock")
        ProjectLock.release(handle)

        with open(lock_path, "a+") as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
            check(st == 409, "second window open -> 409")
            err = json.loads(body)
            check(err.get("code") == "project_open_conflict", "409 carries project_open_conflict")

            # read-only open succeeds despite the lock, carries the flag in meta
            st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc), "read_only": True})
            check(st == 200, "read-only open succeeds while another window holds the lock")
            ro_meta = next(
                (m["meta"] for m in (json.loads(l) for l in body.splitlines() if l.strip()) if m.get("meta")),
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

            fcntl.flock(other, fcntl.LOCK_UN)  # the "other window" closes

        # the other window released -> the demo project opens normally again
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
        check(st == 200, "open works after the other window released")
        check(state.project is not None and not state.project.read_only, "reopen is writable again")

        # ---- 3g. remote (ssh) lock over the exec bridge ----
        from unittest import mock

        from agent.tools.transport import LocalTransport
        from agent.tools.workspace import RemoteWorkspace

        with tempfile.TemporaryDirectory() as rdir:
            root = Path(rdir)

            def make_ws():
                # RemoteWorkspace hard-codes SshTransport; swap in a local one so
                # the noclobber/rm commands run for real on a local dir
                with mock.patch("agent.tools.workspace.SshTransport", lambda url: LocalTransport(str(root))):
                    return RemoteWorkspace(str(root), "http://bridge.invalid")

            rclc = str(root / "remote.clc")
            (root / "remote.clc").write_text("x\n")
            ws1 = make_ws()
            h1 = ProjectLock.acquire(rclc, ws1)
            check(h1 is not None and h1.kind == "remote", "remote lock acquired")
            check((root / ".clc.lock").exists(), "remote lock file created on the host")

            # a second window (fresh process state) is refused
            saved_held = dict(ProjectLock._held)
            ProjectLock._held.clear()
            try:
                h2 = ProjectLock.acquire(rclc, make_ws())
                check(h2 is None, "second window remote lock refused")

                # stale TTL: an aged lock is reclaimed
                (root / ".clc.lock").write_text(str(int(time.time()) - 7 * 3600))
                h3 = ProjectLock.acquire(rclc, make_ws())
                check(h3 is not None, "stale remote lock reclaimed after TTL")
                ProjectLock.release(h3)
                check(not (root / ".clc.lock").exists(), "remote lock file removed on release")

                # fresh acquire after release works
                h4 = ProjectLock.acquire(rclc, make_ws())
                check(h4 is not None, "fresh remote acquire after release")
                ProjectLock.release(h4)
                check(not (root / ".clc.lock").exists(), "release cleans up the lock file")
            finally:
                ProjectLock._held.update(saved_held)  # restore the demo handle

        # 4. real run (only with a key saved in ~/.clutch/settings.json)
        key = _saved_api_key()
        if not key:
            print("\n(no API key in ~/.clutch/settings.json - real-run section skipped)")
            print("\nall passed (network-free)")
            return 0
        state.api_key = key  # the server uses the UI-saved key (no env fallback)

        st, body = http_post(
            f"{base_url}/api/run",
            {
                "task": (
                    "write a file hello.txt containing the word hi using write_file, "
                    "then read it with run_command cat hello.txt"
                ),
                "verify": "echo ok",
            },
        )
        check(st == 200 and body != "", "run accepted")

        # 4b. duplicate run rejected (busy)
        st, _ = http_post(f"{base_url}/api/run", {"task": "another"})
        check(st == 409, "concurrent run rejected")

        # collect SSE events
        events: list[dict] = []
        done = threading.Event()

        def sse_reader() -> None:
            try:
                with urllib.request.urlopen(f"{base_url}/api/events", timeout=90) as r:
                    for raw in r:
                        line = raw.decode().strip()
                        if line.startswith("data: "):
                            ev = json.loads(line[6:])
                            events.append(ev)
                            if ev["type"] == "final":
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

        # 5. workspace tree after run (file preview endpoint was removed)
        st, body = http_get(f"{base_url}/api/workspace/tree")
        data = json.loads(body)
        check(st == 200 and data.get("root"), "workspace tree has root")
        names = [n["name"] for n in data.get("tree", [])]
        check("hello.txt" in names, "workspace shows created file")
        check(clc.name not in names, ".clc file hidden from workspace tree")

        # 5b. user-side undo endpoint: routing + guards (restore logic is tested in
        # selfcheck); the run created hello.txt, so it has no snapshot to revert
        st, body = http_post(f"{base_url}/api/workspace/revert", {"path": "hello.txt"})
        check(st == 404, "revert on a never-snapshot file returns 404")
        st, body = http_post(f"{base_url}/api/workspace/revert", {"path": "../escape"})
        check(st == 400, "revert rejects an escaping path")
        st, body = http_post(f"{base_url}/api/workspace/revert", {"path": clc.name})
        check(st == 400, "revert refuses the protected .clc")
        st, body = http_post(f"{base_url}/api/workspace/revert", {})
        check(st == 400, "revert requires a path")

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

        # 7. stop is safe on idle
        st, _ = http_post(f"{base_url}/api/stop", {})
        check(st == 200, "stop on idle is safe")

        srv.shutdown()
        print("\nall passed (full)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
