"""Per-compaction table for a real .clc: was the stored summary a real summary
or a continuation? and what did the prompt look like (bytes, truncation)?

usage: _scan_comps2.py <file> [max]
"""

import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.lazy import _parse_with_offsets


def main():
    path = sys.argv[1]
    cap_n = int(sys.argv[2]) if len(sys.argv) > 2 else 10 ** 9
    raw = open(path, "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    cfg = Config()
    print(f"file={path} events={len(events)} compactions={len(comps)} window={cfg.llm_context_window_bytes}")
    print(f"{'k':>3} {'line#':>6} {'jsonB':>8} {'serB':>8} {'prevB':>7} {'cap':>8} {'cut':>4} {'len':>7} kind")
    prev_summary = ""
    for k, ci in enumerate(comps):
        prev_off = events[comps[k - 1]][0] if k > 0 else 0
        cur_off = events[ci][0]
        window = [e for o, e in events if prev_off <= o < cur_off]
        s = events[ci][1].summary or ""
        # crude serialized-size reconstruction (same shape as _serialize)
        ser = sum(len((e.content or "").encode()) + 16 for e in window if hasattr(e, "content"))
        cap = cfg.llm_context_window_bytes - len(prev_summary.encode("utf-8")) - 8192
        kind = "SUMMARY" if s.lstrip().startswith(("## Objective", "# Objective")) else "CONT"
        if k < cap_n:
            print(
                f"{k:>3} {ci:>6} {cur_off - prev_off:>8} {ser:>8} {len(prev_summary.encode()):>7} "
                f"{cap:>8} {'Y' if ser > cap else 'n':>4} {len(s):>7} {kind} | {s[:90]!r}"
            )
        prev_summary = s


if __name__ == "__main__":
    main()
