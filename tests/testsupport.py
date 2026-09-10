"""Shared assertion helper for the standalone test runners.

Each runner (selfcheck / loop_test / server_test / supervisor_test / transport_test)
is a plain `python -m tests.X` module; check() fails fast with a non-zero exit on
the first broken assertion.
"""

from __future__ import annotations

import os
import sys

from agent.tools.localshell import local_shell


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


def check(cond: bool, name: str) -> None:
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok:   {name}")
