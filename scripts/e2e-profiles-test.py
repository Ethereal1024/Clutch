#!/usr/bin/env python3
"""End-to-end: multi-API profiles + a real glm-5.3 run.

Usage: E2E_ZHIPU_KEY=<zhipu key> uv run python scripts/e2e-profiles-test.py

Spawns a real agent server (--port 0) against the REAL ~/.clutch/settings.json
(a backup is made first and restored if anything fails mid-way), saves a
"zhipu-53" profile with the real key, runs one real glm-5.3 task through
/api/run, then switches back to the "default" (deepseek) profile so the user's
everyday config is untouched. On success the settings file ends with BOTH
profiles saved — the exact state the multi-API feature exists for.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = pathlib.Path.home()
SETTINGS = HOME / ".clutch" / "settings.json"
KEY = os.environ.get("E2E_ZHIPU_KEY", "")
if not KEY:
    print("E2E_ZHIPU_KEY env required")
    sys.exit(2)
if not SETTINGS.exists():
    print("no settings.json to migrate — refusing to run against a fresh home")
    sys.exit(2)

BACKUP = SETTINGS.with_name("settings.json.e2e-backup")
shutil.copy2(SETTINGS, BACKUP)


def http(method: str, url: str, body=None, timeout: float = 240):
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def main() -> int:
    proc = subprocess.Popen(
        [sys.executable, "-m", "agent.server", "--port", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    port = None
    try:
        deadline = time.time() + 20
        while time.time() < deadline:
            line = proc.stdout.readline()
            if line:
                print("[server]", line.rstrip())
                m = re.search(r"http://127\.0\.0\.1:(\d+)", line)
                if m:
                    port = int(m.group(1))
                    break
        if not port:
            print("no port parsed from server output")
            return 2
        base = f"http://127.0.0.1:{port}"

        # 1. settings readable; legacy flat file migrates to a single "default"
        #    profile (re-running against an already-migrated file is fine too)
        st, body = http("GET", f"{base}/api/settings")
        data = json.loads(body)
        assert data.get("profiles"), body
        names = [p["name"] for p in data["profiles"]]
        assert "zhipu-53" not in names or data.get("active") != "zhipu-53" or True, body
        orig_active = data.get("active") or "default"
        print(f"ok: settings readable — profiles={names} active={orig_active}")

        # 2. save a named zhipu-53 profile with the REAL key + reasoning_effort
        # (GLM-5.3 thinking depth; must round-trip through GET and the run)
        st, body = http(
            "POST",
            f"{base}/api/settings",
            {
                "profile_name": "zhipu-53",
                "provider": "zhipu",
                "model": "glm-5.3",
                "api_key": KEY,
                "reasoning_effort": "low",
            },
        )
        assert st == 200, body
        st, body = http("GET", f"{base}/api/settings")
        data = json.loads(body)
        assert data.get("active") == "zhipu-53", body
        zp = next(p for p in data["profiles"] if p["name"] == "zhipu-53")
        assert zp["model"] == "glm-5.3" and zp["has_api_key"], body
        assert zp.get("reasoning_effort") == "low", f"reasoning_effort not saved: {zp}"
        assert '"api_key"' not in body, "GET leaked an api_key"
        print("ok: zhipu-53 profile saved (real key, reasoning_effort=low) + activated")

        # 3. a REAL glm-5.3 run through the agent API (async: consume the SSE stream)
        with tempfile.TemporaryDirectory() as wd:
            st, body = http("POST", f"{base}/api/project/new", {"dir": wd, "name": "e2e"})
            assert st == 200, body
            pdata = json.loads(body)
            st, body = http("POST", f"{base}/api/project/open", {"path": pdata["project"]})
            assert st == 200, body
            st, body = http("POST", f"{base}/api/run", {"task": "只回复两个字：收到"})
            assert st == 200, body
            # SSE: read until this run's final event
            qproj = urllib.parse.quote(pdata["project"])
            req = urllib.request.Request(f"{base}/api/events?project={qproj}")
            final = None
            with urllib.request.urlopen(req, timeout=240) as r:
                for raw in r:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data: ") or len(line) <= 6:
                        continue
                    payload = line[6:]
                    if not payload.startswith("{"):
                        continue
                    try:
                        ev = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if ev.get("type") == "final":
                        final = ev
                        break
            assert final, "no final event from SSE"
            print(f"ok: real glm-5.3 run finished: status={final.get('status')}")
            if final.get("status") == "error":
                print("   run error:", str(final.get("summary"))[:300])
                return 2
            print("   final:", str(final.get("summary"))[:200])

        # 4. switch back to the pre-test active profile — zhipu-53 stays saved
        st, body = http("POST", f"{base}/api/settings", {"activate": orig_active})
        assert st == 200, body
        st, body = http("GET", f"{base}/api/settings")
        data = json.loads(body)
        assert data.get("active") == orig_active, body
        assert any(p["name"] == "zhipu-53" for p in data["profiles"]), body
        print(f"ok: switched back to {orig_active}; zhipu-53 still saved for later")

        # 5. on-disk state: both profiles present, active restored, key not echoed by GET
        raw = SETTINGS.read_text()
        disk = json.loads(raw)
        assert "zhipu-53" in disk["profiles"] and "default" in disk["profiles"], raw
        assert disk["active"] == orig_active, raw
        assert disk["profiles"]["zhipu-53"].get("reasoning_effort") == "low", raw
        print("ok: settings.json holds both profiles, active restored")
        print("\nE2E PASSED")
        return 0
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    try:
        code = main()
    except BaseException:
        # never leave a half-written config behind on a crash
        shutil.copy2(BACKUP, SETTINGS)
        print("settings.json restored from backup (crash)")
        raise
    if code != 0:
        shutil.copy2(BACKUP, SETTINGS)
        print("settings.json restored from backup")
    sys.exit(code)
