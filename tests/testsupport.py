"""Shared helpers for the standalone test runners: no test framework, each runner
is a plain `python -m tests.X` module. What is shared here is only what more than
one runner needs — the canonical list of suites lives in README.md, not here.

- check()            fails fast: prints and exits non-zero on the first broken
                     assertion (the default)
- collecting_check() returns (check, failures) for runners that report every
                     broken assertion at the end (lazy_check, ui_fonts_check)
- http_get() / http_post()   drive the local HTTP API
- wait_gone()        prove a process did not leak (poll the pid until it is gone)
- posix_shell_argv() run POSIX sh text on this host for the mock "remote"
"""

from __future__ import annotations

import json
import os
import shlex
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable

from agent.tools.localshell import local_shell
from agent.tools.rendezvous import _pid_alive


def posix_shell_argv() -> list[str] | None:
    """How to run POSIX sh command text on THIS host, or None when the host has
    no POSIX shell at all.

    The mock "remote" side of the transport tests speaks POSIX sh — the real
    remote always does (exec-bridge.js runs `sh -c` there). On a POSIX app host
    that is /bin/sh; on Windows it has to be a real bash (Git for Windows /
    MSYS2), because subprocess(shell=True)/child_process.exec there is cmd.exe,
    which cannot run heredocs, `printf` or `base64` and would fail the mock for
    an environment reason rather than a product one.
    """
    if os.name != "nt":
        return ["/bin/sh", "-c"]
    shell = local_shell()  # the app's own detection (CLUTCH_BASH, Git dirs, PATH)
    return list(shell.argv) if shell.posix and shell.argv else None


def shell_words(command: str) -> list[str]:
    """How the SHELL will see a rendered command line: the argv a POSIX sh hands
    the child, with quoting resolved. Both statement suites assert on the words the
    module receives, so the reading is defined once."""
    return shlex.split(command, posix=True)


def wait_gone(pid: int, seconds: float = 5.0) -> bool:
    """True once `pid` is no longer alive, polling — a killed process is not reaped
    instantly, so a single liveness probe races the OS. Runners use this to prove a
    process did NOT leak (a daemon that dies with its parent, one that stops on
    release, one that survives a detach)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.05)
    return False


def check(cond: bool, name: str) -> None:
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok:   {name}")


def collecting_check(indent: str = "") -> tuple[Callable[[bool, str], None], list[str]]:
    """Counterpart of check() for runners that summarize at the end: the returned
    check() prints and records instead of exiting, so the runner can report every
    failure (the banner wording differs per runner, hence it stays there)."""
    failures: list[str] = []

    def check(cond: bool, label: str) -> None:
        print(f"{indent}{'ok:  ' if cond else 'FAIL: '}{label}")
        if not cond:
            failures.append(label)

    return check, failures


def http_get(url: str) -> tuple[int, str]:
    """GET a local endpoint; returns (status, body) without raising on 4xx/5xx."""
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def http_post(url: str, body: dict | None = None) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
