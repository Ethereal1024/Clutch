"""Server end-to-end check: boots the HTTP server in a thread and exercises it.

Run: uv run python -m agent.server_test
API/health/project are always checked. If DEEPSEEK_API_KEY is set, also runs a
real task through /api/run, collects SSE events, and checks the workspace tree and
.clc persistence. Skips the real-run section when no key is present (network-free).
"""

from __future__ import annotations

import json
import os
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

        # 3. create a project
        st, body = http_post(f"{base_url}/api/project/new", {"dir": str(proj_dir), "name": "demo"})
        check(st == 200, "project created")
        pdata = json.loads(body)
        check(pdata.get("name") == "demo", "project name returned")
        clc = Path(pdata["project"])
        check(clc.suffix == ".clc" and clc.exists(), ".clc file exists")
        check(pdata.get("workdir") == str(proj_dir), "workdir is project dir")

        # 3b. reopen the project (NDJSON stream: meta line carries the name)
        st, body = http_post(f"{base_url}/api/project/open", {"path": str(clc)})
        check(st == 200, "project reopened")
        rdata = json.loads(body.splitlines()[0])
        check(rdata.get("meta", {}).get("name") == "demo", "reopened project name")

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

        # 4. real run (only with key)
        key = os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            print("\n(DEEPSEEK_API_KEY not set - real-run section skipped)")
            print("\nall passed (network-free)")
            return 0

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
