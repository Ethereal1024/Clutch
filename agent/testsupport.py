"""Shared assertion helper for the standalone test runners.

Each runner (selfcheck / loop_test / server_test) is a plain `python -m agent.X`
module; check() fails fast with a non-zero exit on the first broken assertion.
"""

from __future__ import annotations

import sys


def check(cond: bool, name: str) -> None:
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok:   {name}")
