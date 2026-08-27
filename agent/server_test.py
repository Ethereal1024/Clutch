"""Server end-to-end check: boots the HTTP server in a thread and exercises it.

Run: uv run python -m agent.server_test [--task "optional real task"]
Static/health/sessions are always checked. If DEEPSEEK_API_KEY is set, also runs a
real task through /api/run, collects SSE events, and checks the sandbox tree + session
file. Skips the real-run section when no key is present (network-free mode).
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

from .config import Config
from .server import Broadcaster, RunState, build

BASE = Path(__file__).resolve().parent.parent
UI_DIR = BASE / "ui"


def check(cond: bool, name: str) -> None:
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok:   {name}")


def http_get(url: str) -> tuple[int, str]:
    with urllib.request.urlopen(url, timeout=15) as r:
        return r.status, r.read().decode("utf-8", errors="replace")


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
    config = Config(port=8899)
    broadcaster = Broadcaster()

    with tempfile.TemporaryDirectory() as sdir:
        sessions_dir = Path(sdir) / "sessions"
        sessions_dir.mkdir()
        state = RunState(sessions_dir)
        srv = build(config, UI_DIR, sessions_dir, broadcaster, state)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        base_url = f"http://127.0.0.1:{config.port}"

        time.sleep(0.5)

        # 1. health + static
        st, body = http_get(f"{base_url}/api/health")
        check(st == 200 and '"ok": true' in body, "health ok")
        st, _ = http_get(f"{base_url}/")
        check(st == 200, "index served")
        st, _ = http_get(f"{base_url}/app.js")
        check(st == 200, "app.js served")
        st, body = http_get(f"{base_url}/api/sessions")
        check(st == 200 and '"sessions": []' in body, "sessions empty initially")

        # 2. reject empty task
        st, body = http_post(f"{base_url}/api/run", {"task": "   "})
        check(st == 400, "empty task rejected")

        # 3. real run (only with key)
        key = os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            print("\n(DEEPSEEK_API_KEY not set - real-run section skipped)")
            print("\nall passed (network-free)")
            return 0

        st, body = http_post(f"{base_url}/api/run", {
            "task": "write a file hello.txt containing the word hi using write_file, then read it with run_command cat hello.txt",
            "verify": "echo ok",
        })
        check(st == 200 and body != "", "run accepted")

        # 3b. duplicate run rejected (busy)
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

        # 4. sandbox tree + file after run
        st, body = http_get(f"{base_url}/api/sandbox/tree")
        data = json.loads(body)
        check(st == 200 and data.get("root"), "sandbox tree has root")
        st, body = http_get(f"{base_url}/api/sandbox/file?path=hello.txt")
        check(st == 200 and "hi" in body, "sandbox file readable")

        # 5. session persisted + replay
        st, body = http_get(f"{base_url}/api/sessions")
        sessions = json.loads(body)["sessions"]
        check(len(sessions) == 1, "session file persisted")
        path = sessions[0]["path"]
        st, body = http_get(f"{base_url}/api/sessions/replay?path={path}")
        replay = json.loads(body)
        check("events" in replay and len(replay["events"]) > 0, "session replay works")

        # 6. stop is safe on idle
        st, _ = http_post(f"{base_url}/api/stop", {})
        check(st == 200, "stop on idle is safe")

        srv.shutdown()
        print("\nall passed (full)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
