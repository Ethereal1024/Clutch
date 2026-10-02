#!/usr/bin/env python3
"""Sample per-thread CPU of a Linux process to tell "JS main thread pegged"
(a busy renderer loop) from "everything idle-waiting" (a transport stall).

Usage: proc_threads.py <pid> [seconds]

Prints the top threads by CPU-time delta, their state and wchan, so a Blink
"CrRendererMain" thread spinning at ~100% of a core is immediately visible.
"""
from __future__ import annotations

import os
import sys
import time


def read_threads(pid: int) -> dict[int, tuple[str, int, str]]:
    out: dict[int, tuple[str, int, str]] = {}
    taskdir = f"/proc/{pid}/task"
    for tid in os.listdir(taskdir):
        try:
            with open(f"{taskdir}/{tid}/stat", "rb") as fh:
                data = fh.read().decode("utf-8", "replace")
            # comm may contain spaces/parens -> slice between first '(' and last ')'
            name = data[data.index("(") + 1 : data.rindex(")")]
            rest = data[data.rindex(")") + 2 :].split()
            state = rest[0]
            utime = int(rest[11])  # field 14 overall
            stime = int(rest[12])  # field 15 overall
            try:
                wchan = open(f"{taskdir}/{tid}/wchan").read().strip() or "-"
            except OSError:
                wchan = "?"
            out[int(tid)] = (name, utime + stime, f"{state}/{wchan}")
        except (OSError, ValueError, IndexError):
            continue
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pid = int(sys.argv[1])
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    before = read_threads(pid)
    time.sleep(secs)
    after = read_threads(pid)
    rows = []
    for tid, (name, ticks, state) in after.items():
        prev = before.get(tid, (name, ticks, state))[1]
        rows.append((ticks - prev, tid, name, state))
    rows.sort(reverse=True)
    hz = os.sysconf("SC_CLK_TCK")
    print(f"pid={pid} over {secs:.1f}s (ticks @{hz}Hz; 100 ticks/s == 1 core)")
    total = 0
    for delta, tid, name, state in rows[:12]:
        pct = delta / hz / secs * 100
        total += delta
        print(f"  {delta:6d} {pct:6.1f}%  tid={tid:<8} {name:<24} {state}")
    print(f"  total {total / hz / secs * 100:6.1f}% of one core")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
