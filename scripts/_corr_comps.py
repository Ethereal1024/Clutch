"""Correlate stored-summary kind (SUMMARY vs CONTINUATION) with prompt features
across every compaction of a real .clc.

usage: _corr_comps.py <file>
"""

import sys
from collections import Counter

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets

FEATS = {
    "conv_tag": "</conversation>",
    "tmpl_tag": "<template>",
    "objective": "## Objective",
    "word_compaction": "compaction",
    "dsml_ascii": "DSML",
    "dsml_cjk": "\uff5c",  # fullwidth vertical bar in the CJK DSML marker
}


def main():
    path = sys.argv[1]
    raw = open(path, "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    cfg = Config()
    tally = {"SUM": Counter(), "CONT": Counter()}
    n = Counter()
    print(f"{'k':>3} {'serB':>7} {'prevB':>6} {'kind':<5} " + " ".join(f"{f:>8}" for f in FEATS) + "  last")
    for k, ci in enumerate(comps):
        prev_off = events[comps[k - 1]][0] if k > 0 else 0
        window = [e for o, e in events if prev_off <= o < events[ci][0]]
        stored = events[ci][1].summary or ""
        prev = events[comps[k - 1]][1].summary if k > 0 else ""
        comp = Compactor(cfg, LazyEventLog.in_memory(), None)  # type: ignore[arg-type]
        text = comp._serialize(window)
        kind = "SUM" if stored.lstrip().startswith(("## Objective", "# Objective")) else "CONT"
        n[kind] += 1
        row = []
        for f, m in FEATS.items():
            c = text.count(m)
            if c:
                tally[kind][f] += 1
            row.append(c)
        last = window[-1].type if window else "-"
        print(
            f"{k:>3} {len(text.encode()):>7} {len(prev.encode()):>6} {kind:<5} "
            + " ".join(f"{c:>8}" for c in row)
            + f"  {last}"
        )
    print(f"\ntotals: {dict(n)}")
    for kind in ("SUMMARY", "CONT"):
        print(f"  {kind}: compactions whose transcript contains the marker -> {dict(tally[kind])}")


if __name__ == "__main__":
    main()
