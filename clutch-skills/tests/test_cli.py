"""The CLI the host will actually call: flags in, text or one JSON object out.

Every test drives `python -m clutch_skills` as a subprocess, so what is asserted
is the exit code and the bytes on stdout/stderr — the contract a caller reads.
"""

from __future__ import annotations

import json
from pathlib import Path

from conftest import ALPHA_NOTES, ALPHA_SKILL, BETA_SKILL, write_skill

from clutch_skills import __version__, server

CATALOG_LINES = [
    "Available skills (call load_skill to read one when relevant):",
    "- alpha: the first skill",
    "- beta: ",
]


def records(discovery_home: Path) -> list[dict]:
    """The daemons this test's CLI calls published (one per served root)."""
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(discovery_home.glob("s-*.json"))]


# -- the happy path -----------------------------------------------------------


def test_list_renders_the_catalog_for_a_human(library: Path, run):
    proc = run("--root", library, "list")
    assert proc.returncode == 0
    assert proc.stdout.splitlines() == CATALOG_LINES
    assert proc.stderr == ""


def test_json_answers_with_the_service_shape_and_nothing_else(library: Path, jok):
    assert jok("--root", library, "list") == server.catalog_payload(library)
    assert jok("--root", library, "show", "alpha") == server.skill_payload(library, "alpha", "")


def test_show_prints_the_file_text_verbatim(library: Path, run):
    proc = run("--root", library, "show", "alpha")
    assert (proc.returncode, proc.stdout) == (0, ALPHA_SKILL)
    proc = run("--root", library, "show", "alpha", "--file", "notes.md")
    assert (proc.returncode, proc.stdout) == (0, ALPHA_NOTES)


def test_a_skill_is_found_by_its_directory_name_too(library: Path, jok):
    write_skill(library, "delta", "---\nname: delta-alias\ndescription: aliased\n---\n\nbody\n")
    assert jok("--root", library, "show", "delta")["name"] == "delta-alias"


def test_health_and_root_describe_the_running_service(library: Path, run, jok, discovery_home: Path):
    assert run("--root", library, "health").returncode == 0
    pid = records(discovery_home)[0]["pid"]
    assert run("--root", library, "health").stdout.splitlines() == [
        f"ok root={library.resolve()} pid={pid} skills=2"
    ]
    assert jok("--root", library, "root") == {"ok": True, "root": str(library.resolve()), "pid": pid, "skills": 2}


# -- one daemon per root, reused ---------------------------------------------


def test_a_second_call_reuses_the_daemon_the_first_one_started(library: Path, run, discovery_home: Path):
    assert run("--root", library, "list").returncode == 0
    first = records(discovery_home)
    assert run("--root", library, "list").returncode == 0
    assert records(discovery_home) == first  # same file, same port, same pid


def test_repointing_moves_the_daemon_to_the_new_key(library: Path, tmp_path: Path, run, discovery_home: Path):
    other = tmp_path / "other"
    write_skill(other, "zeta", "---\nname: zeta\ndescription: the other root\n---\n\nZ\n")
    assert run("--root", library, "list").returncode == 0
    pid = records(discovery_home)[0]["pid"]

    proc = run("--root", library, "root", other)
    assert proc.returncode == 0
    assert proc.stdout.splitlines() == [f"root: {other.resolve()} (1 skills)"]
    # discovery follows the root (the key IS the root) and keeps the same process
    assert len(records(discovery_home)) == 1
    assert records(discovery_home)[0]["root"] == str(other.resolve())
    assert records(discovery_home)[0]["pid"] == pid
    assert run("--root", other, "list").stdout.splitlines() == [
        "Available skills (call load_skill to read one when relevant):",
        "- zeta: the other root",
    ]


def test_an_explicit_url_or_port_talks_to_that_service(library: Path, run, discovery_home: Path):
    assert run("--root", library, "list").returncode == 0
    port = records(discovery_home)[0]["port"]
    assert run("--root", library, "--port", port, "list").stdout.splitlines() == CATALOG_LINES
    assert run("--root", library, "--url", f"http://127.0.0.1:{port}", "list").stdout.splitlines() == CATALOG_LINES


# -- refusals -----------------------------------------------------------------


def test_an_unknown_skill_is_exit_1_and_names_the_available_ones(library: Path, run):
    proc = run("--root", library, "show", "alphi")
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "unknown skill: alphi" in proc.stderr
    assert "available: alpha, beta" in proc.stderr


def test_unknown_skill_json_carries_the_available_names(library: Path, jerr):
    code, body = jerr("--root", library, "show", "alphi")
    assert code == 1
    assert body["available"] == ["alpha", "beta"]


def test_a_bad_file_is_exit_1(library: Path, jerr):
    assert jerr("--root", library, "show", "alpha", "--file", "../loose.txt")[0] == 1
    assert jerr("--root", library, "show", "alpha", "--file", "nope.md") == (1, {"error": "not a file: nope.md"})


def test_a_root_that_is_not_a_directory_is_exit_1_not_transport(tmp_path: Path, jerr, run, discovery_home: Path):
    missing = tmp_path / "missing"
    code, body = jerr("--root", missing, "list")
    assert code == 1
    assert body["error"] == f"skills root is not a directory: {missing}"
    assert records(discovery_home) == []  # nothing was started for it
    assert run("--root", missing, "list").returncode == 1


def test_usage_and_transport_trouble_are_exit_2(library: Path, run):
    assert run("--root", library, "nonsense").returncode == 2  # argparse
    assert run("--root", library, "show").returncode == 2  # missing NAME
    proc = run("--root", library, "--url", "http://127.0.0.1:1", "list")
    assert proc.returncode == 2
    assert "unreachable" in proc.stderr


def test_version_prints_and_exits_0(run):
    proc = run("--version")
    assert (proc.returncode, proc.stdout.strip()) == (0, f"clutch-skills {__version__}")


# -- --no-server: this process answers the reads ---------------------------------


def test_no_server_answers_list_and_show_without_starting_anything(library: Path, run, discovery_home: Path):
    proc = run("--root", library, "--no-server", "list")
    assert (proc.returncode, proc.stdout.splitlines()) == (0, CATALOG_LINES)
    assert run("--root", library, "--no-server", "show", "beta").stdout == BETA_SKILL
    assert records(discovery_home) == []


def test_no_server_refuses_what_only_a_service_can_answer(library: Path, jerr, discovery_home: Path):
    for command in ("health", "root"):
        code, body = jerr("--root", library, "--no-server", command)
        assert code == 2
        assert "--no-server cannot answer" in body["error"]
    assert records(discovery_home) == []


def test_no_server_still_reports_a_bad_skill(tmp_path: Path, run):
    empty = tmp_path / "empty"
    empty.mkdir()
    proc = run("--root", empty, "--no-server", "show", "alpha")
    assert proc.returncode == 1
    assert "unknown skill: alpha" in proc.stderr


def test_the_default_root_is_the_bundled_library(run):
    proc = run("--no-server", "list")
    assert proc.returncode == 0
    assert proc.stdout.strip() == f"(no skills in {server.BUNDLED_ROOT.resolve()})"
