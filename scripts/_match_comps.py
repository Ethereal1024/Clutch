"""Is a stored summary VERBATIM text that also appears later in the log?

If yes, the summary was copied out of the session (a code bug).  If no, the
summarizer model really produced it, so the bug is in the prompt/serialization.

usage: _match_comps.py <file> [--head]
"""

import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets


def flatten(s, n=140):
    return " ".join(s.split())[:n]


def main():
    path = sys.argv[1]
    show = "--head" in sys.argv
    raw = open(path, "rb").read()
    base = raw.find(b"---\n") + 4
    body = raw[base:]
    events = [(o, e) for o, e in _parse_with_offsets(body + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    cfg = Config()
    n_sum = n_cont = hits = 0
    for k, ci in enumerate(comps):
        off = events[ci][0]
        stored = events[ci][1].summary or ""
        kind = "SUM" if stored.lstrip().startswith(("## Objective", "# Objective")) else "CONT"
        n_sum += kind == "SUM"
        n_cont += kind == "CONT"
        # probe: does an interior chunk of the summary recur later in the file?
        probe = None
        for line in stored.splitlines():
            line = line.strip()
            if len(line) >= 60 and not line.startswith("#"):
                probe = line[:60]
                break
        # search strictly AFTER this compaction event's own record
        after = events[ci + 1][0] if ci + 1 < len(events) else len(body)
        found = -1
        if probe:
            found = body.find(probe.encode(), after)
        if found != -1:
            hits += 1
        prev_off = events[comps[k - 1]][0] if k > 0 else 0
        window = [e for o, e in events if prev_off <= o < off]
        comp = Compactor(cfg, LazyEventLog.in_memory(), None)  # type: ignore[arg-type]
        text = comp._serialize(window)
        print(f"k={k:>3} {kind:<4} serB={len(text.encode()):>7} later_copy={found - off if found != -1 else -1}")
        if show:
            print("   TAIL:", flatten(text[-400:], 300))
            print("   SUM :", flatten(stored, 300))
            print("   LAST:", window[-1].type if window else "-")
    print(f"\nSUM={n_sum} CONT={n_cont} verbatim_later={hits}/{len(comps)}")


if __name__ == "__main__":
    main()
