"""Harness: a real skills daemon per test, isolated rendezvous, no leftovers.

Behavior is exercised the way the host will drive it — the CLI as a subprocess
(`python -m clutch_skills`) and the service over real HTTP — so a test cannot
pass by accident of the internals it happens to import. Imports from the package
are limited to constants and to `discovery`, which is how a test finds the port
the daemon published and which pids to reap.

Every test gets its own discovery directory, and the autouse teardown kills
whatever daemons it left behind: a leaked daemon would keep serving the next
test's root and make failures unreproducible.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # so tests (and the helpers below) can import the package
    sys.path.insert(0, str(ROOT))

from clutch_skills import discovery  # noqa: E402

ALPHA_SKILL = """---
name: alpha
description: the first skill
---

# Alpha

Alpha body text.
"""

BETA_SKILL = "# Beta\n\nNo frontmatter here, so name = directory name.\n"

ALPHA_NOTES = "# Alpha notes\n\nWhat alpha knows beyond SKILL.md.\n"

SKILL_MD = "SKILL.md"


def write_skill(root: Path, directory: str, text: str, **files: str) -> Path:
    """Create one skill directory (SKILL.md + optional extra files)."""
    target = Path(root) / directory
    target.mkdir(parents=True, exist_ok=True)
    (target / SKILL_MD).write_text(text, encoding="utf-8", newline="\n")
    for name, content in files.items():
        (target / name.replace("__", ".")).write_text(content, encoding="utf-8", newline="\n")
    return target


def env(**extra: str) -> dict:
    """The environment a spawned CLI/daemon gets: our package importable, UTF-8."""
    out = dict(os.environ, PYTHONPATH=str(ROOT), PYTHONUTF8="1")
    out.update(extra)
    return out


def wait_for_port(root: Path | str, timeout: float = 10.0) -> dict:
    """Poll until the daemon serving `root` publishes itself; return the record."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        record = discovery.read(str(root))
        if record:
            return record
        time.sleep(0.05)
    raise AssertionError(f"no daemon published for {root} within {timeout:g}s")


def stop(pid: int, proc: subprocess.Popen | None = None) -> None:
    """SIGTERM a daemon, escalating to SIGKILL; never raises.

    A process we spawned ourselves is a zombie the moment it exits, and
    `os.kill(pid, 0)` keeps reporting it alive until someone reaps it — so when a
    handle is available, liveness comes from the handle, not from the signal
    probe. Otherwise every teardown would burn its full escalation budget.
    """

    def alive() -> bool:
        return proc.poll() is None if proc is not None else discovery.pid_alive(pid)

    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not alive():
            break
        try:
            os.kill(pid, sig)
        except OSError:
            break
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and alive():
            time.sleep(0.05)
    if proc is not None and proc.poll() is None:
        proc.wait(timeout=10)


@pytest.fixture(autouse=True)
def discovery_home(tmp_path_factory, monkeypatch):
    """Per-test rendezvous directory, swept clean of daemons afterwards."""
    disc = tmp_path_factory.mktemp("discovery")
    monkeypatch.setenv("CLUTCH_SKILLS_DISCOVERY_DIR", str(disc))
    yield disc
    for leftover in disc.glob("s-*.json"):
        try:
            stop(json.loads(leftover.read_text(encoding="utf-8"))["pid"])
        except (OSError, ValueError, KeyError):
            pass


@pytest.fixture
def library(tmp_path: Path) -> Path:
    """A skills root: two skills, one directory without SKILL.md, one loose file."""
    root = tmp_path / "skills"
    root.mkdir()
    write_skill(root, "alpha", ALPHA_SKILL, notes__md=ALPHA_NOTES)
    write_skill(root, "beta", BETA_SKILL)
    (root / "gamma").mkdir()  # no SKILL.md -> not a skill
    (root / "loose.txt").write_text("not a skill\n", encoding="utf-8")
    return root


def _cli(*args: object, cwd: Path | str, timeout: float = 60.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "clutch_skills", *(str(a) for a in args)],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env(),
        timeout=timeout,
    )


@pytest.fixture
def run(tmp_path: Path):
    """The CLI as a subprocess; cwd is the module root unless a test says otherwise."""

    def _run(*args: object, cwd: Path | str | None = None):
        return _cli(*args, cwd=cwd if cwd is not None else ROOT)

    return _run


@pytest.fixture
def jok(run):
    """A `--json` run that must succeed: the parsed object on stdout."""

    def _jok(*args: object, cwd: Path | str | None = None) -> dict:
        proc = run("--json", *args, cwd=cwd)
        assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
        return json.loads(proc.stdout)

    return _jok


@pytest.fixture
def jerr(run):
    """A `--json` run that must fail: (exit code, object) — one line of stdout,
    nothing but the object, so a caller parses stdout and never prose."""

    def _jerr(*args: object, cwd: Path | str | None = None) -> tuple[int, dict]:
        proc = run("--json", *args, cwd=cwd)
        assert proc.returncode != 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
        assert proc.stdout.strip().count("\n") == 0, f"one object, got {proc.stdout!r}"
        return proc.returncode, json.loads(proc.stdout)

    return _jerr


@pytest.fixture
def start_daemon(tmp_path: Path):
    """Spawn a real service process (`python -m clutch_skills.server`) and reap it."""
    started: list[subprocess.Popen] = []

    def _start(root: Path | str, *extra: object) -> subprocess.Popen:
        proc = subprocess.Popen(
            [sys.executable, "-m", "clutch_skills.server", "--root", str(root), *(str(e) for e in extra)],
            cwd=str(ROOT),
            env=env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
        )
        started.append(proc)
        return proc

    yield _start
    for proc in started:
        stop(proc.pid, proc)
        proc.stdout.close()  # type: ignore[union-attr]
        proc.wait(timeout=10)
