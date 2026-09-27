"""Compare the serialized window's head/tail for good (SUM) vs bad (CONT) compactions.

usage: _tail_cmp.py <file> k [k ...]
"""

import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets


def main():
    raw = open(sys.argv[1], "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    comp = Compactor(Config(), LazyEventLog.in_memory(), None)  # type: ignore[arg-type]
    for arg in sys.argv[2:]:
        k = int(arg)
        ci = comps[k]
        off = events[ci][0]
        prev_off = events[comps[k - 1]][0] if k > 0 else 0
        win = [e for o, e in events if prev_off <= o < off]
        prev = events[comps[k - 1]][1].summary if k > 0 else ""
        stored = events[ci][1].summary or ""
        t = comp._serialize(win)
        print("#" * 20, "k", k, "stored:", "SUM" if stored.lstrip().startswith("##") else "CONT")
        print("  prev:", "SUM" if prev.lstrip().startswith("##") else "CONT", len(prev), repr(prev[:150]))
        lines = t.split("\n")
        print("  nlines", len(lines), "serB", len(t.encode()))
        print("  first:", repr(lines[0][:200]))
        for L in lines[-4:]:
            print("   >", repr(L[-260:]))
        print("  last event:", win[-1].type if win else "-", "| 2nd last:", win[-2].type if len(win) > 1 else "-")


if __name__ == "__main__":
    main()
