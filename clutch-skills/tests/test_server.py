"""The service over real HTTP: a daemon process, the discovery file, and the
wire contract — here the status codes carry the meaning (200 ok, 400 a
caller-fixable request, 404 an unknown skill), so they are asserted literally.
"""

from __future__ import annotations

import json
import os
import signal
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from conftest import ALPHA_NOTES, ALPHA_SKILL, wait_for_port, write_skill

from clutch_skills import discovery, server


def http(method: str, url: str, payload: dict | None = None) -> tuple[int, dict]:
    """One request; the response body as parsed JSON whatever the status."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"} if data else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        with err:
            return err.code, json.loads(err.read().decode("utf-8"))


def skill_url(base: str, name: str = "", file: str = "") -> str:
    query = {"name": name}
    if file:
        query["file"] = file
    return f"{base}/skill?{urllib.parse.urlencode(query)}"


def test_health_names_the_root_the_daemon_and_the_catalog_size(library: Path, start_daemon, discovery_home: Path):
    start_daemon(library)
    record = wait_for_port(library)
    status, body = http("GET", f"http://127.0.0.1:{record['port']}/health")
    assert status == 200
    assert body == {"ok": True, "root": str(library.resolve()), "pid": record["pid"], "skills": 2}
    assert discovery.discovery_file(str(library)).parent == discovery_home


def test_catalog_is_the_scan_result(library: Path, start_daemon):
    start_daemon(library)
    base = f"http://127.0.0.1:{wait_for_port(library)['port']}"
    status, body = http("GET", f"{base}/skills")
    assert status == 200
    assert body == {
        "root": str(library.resolve()),
        "skills": [
            {"name": "alpha", "description": "the first skill", "dir": "alpha"},
            {"name": "beta", "description": "", "dir": "beta"},
        ],
    }


def test_skill_answers_content_and_defaults_to_skill_md(library: Path, start_daemon):
    start_daemon(library)
    base = f"http://127.0.0.1:{wait_for_port(library)['port']}"
    status, body = http("GET", skill_url(base, "alpha"))
    assert status == 200
    assert body["name"] == "alpha"
    assert body["description"] == "the first skill"
    assert body["dir"] == "alpha"
    assert body["file"] == "SKILL.md"
    assert body["content"] == ALPHA_SKILL
    status, body = http("GET", skill_url(base, "alpha", "notes.md"))
    assert (status, body["file"], body["content"]) == (200, "notes.md", ALPHA_NOTES)


def test_unknown_skill_is_404_and_carries_the_available_names(library: Path, start_daemon):
    start_daemon(library)
    base = f"http://127.0.0.1:{wait_for_port(library)['port']}"
    status, body = http("GET", skill_url(base, "alphi"))
    assert status == 404
    assert body["available"] == ["alpha", "beta"]
    assert "alphi" in body["error"]


def test_a_bad_file_is_400_and_says_why(library: Path, start_daemon):
    start_daemon(library)
    base = f"http://127.0.0.1:{wait_for_port(library)['port']}"
    for file, code in (("../loose.txt", 400), ("nope.md", 400), ("/etc/passwd", 400)):
        status, body = http("GET", skill_url(base, "alpha", file))
        assert status == code, body
        assert "error" in body and "available" not in body


def test_root_is_repointed_in_place_and_rekeys_discovery(library: Path, start_daemon, tmp_path: Path):
    other = tmp_path / "other"
    write_skill(other, "zeta", "---\nname: zeta\ndescription: the other root\n---\n\nZ\n")
    start_daemon(library)
    record = wait_for_port(library)
    base = f"http://127.0.0.1:{record['port']}"

    status, body = http("POST", f"{base}/root", {"root": str(other)})
    assert status == 200
    assert body == {"ok": True, "root": str(other.resolve()), "pid": record["pid"], "skills": 1}
    # the same process now serves the new library...
    assert http("GET", f"{base}/skills")[1]["skills"] == [
        {"name": "zeta", "description": "the other root", "dir": "zeta"}
    ]
    # ...and discovery moved to the new key, because the key IS the root
    assert discovery.read(str(other))["port"] == record["port"]
    assert discovery.read(str(library)) is None


def test_a_junk_root_request_is_400_and_an_unknown_path_is_404(library: Path, start_daemon):
    start_daemon(library)
    base = f"http://127.0.0.1:{wait_for_port(library)['port']}"
    assert http("POST", f"{base}/root", {"root": 12})[0] == 400
    assert http("POST", f"{base}/root", {})[0] == 400
    assert http("GET", f"{base}/nope")[0] == 404
    assert http("POST", f"{base}/nope", {})[0] == 404


def test_a_root_that_is_not_a_directory_is_400(library: Path, start_daemon, tmp_path: Path):
    start_daemon(library)
    base = f"http://127.0.0.1:{wait_for_port(library)['port']}"
    status, body = http("POST", f"{base}/root", {"root": str(tmp_path / "missing")})
    assert status == 400
    assert "no-root" not in body["error"]  # the reason, not the code
    assert body["error"].startswith("skills root is not a directory")


def test_sigterm_exits_and_unpublishes(library: Path, start_daemon):
    proc = start_daemon(library)
    wait_for_port(library)
    discovery_file = discovery.discovery_file(str(library))
    assert discovery_file.exists()
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=15) == 0
    assert not discovery_file.exists()
    stdout = proc.stdout.read()  # type: ignore[union-attr]
    assert "clutch-skills stopped" in stdout


def test_the_idle_watchdog_shuts_an_unused_daemon_down(library: Path, start_daemon):
    proc = start_daemon(library, "--idle", "0.4")
    wait_for_port(library)
    discovery_file = discovery.discovery_file(str(library))
    assert proc.wait(timeout=15) == 0  # no request ever came, so it left
    assert not discovery_file.exists()


def test_a_daemon_that_cannot_bind_a_root_says_so_and_exits_1(tmp_path: Path, start_daemon):
    proc = start_daemon(tmp_path / "missing")
    assert proc.wait(timeout=15) == 1
    stderr = proc.stdout.read()  # type: ignore[union-attr]  # stderr is merged into stdout
    assert "not a directory" in stderr
    assert discovery.discovery_file(str(tmp_path / "missing")).exists() is False


def test_payload_builders_are_the_single_source_of_the_wire_shape(library: Path):
    """The CLI's --no-server path and the service must answer identically: both
    go through these functions, so the shapes cannot drift apart."""
    service = server.Service(library, idle=1, publish=False)
    assert server.catalog_payload(library)["skills"] == service.catalog()["skills"]
    assert server.skill_payload(library, "alpha", "")["content"] == ALPHA_SKILL
    assert server.health_payload(library, os.getpid())["skills"] == 2
    assert server.BUNDLED_ROOT.is_dir()  # the default root ships with the module
