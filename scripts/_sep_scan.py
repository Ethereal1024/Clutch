"""Find a string feature that perfectly separates SUM from CONT over all compactions.

For every compaction: serialize the window (as production does), then test a pile
of candidate markers. A marker present in all CONT and none of the SUM (or the
reverse) is the discriminator; anything weaker is printed as a near-miss.

usage: _sep_scan.py <file>
"""

import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets

CANDIDATES = [
    "<conversation>",
    "</conversation>",
    "<template>",
    "</template>",
    "## Objective",
    "## Work State",
    "## Next Move",
    "## Relevant Files",
    "Previous conversation summary",
    "compaction.md",
    "compaction_head.md",
    "compaction.py",
    "[Assistant tool call]",
    "[Tool result]",
    "[User]:",
    "[Assistant reasoning]",
    "DSML",
    "\uff5c",
    "summar",
    "Summary",
    "REPLACES",
    "prior-summary",
    "Prior summary",
    "_serialize",
    "_summarize",
    "Objective",
    "compact",
]


def main():
    raw = open(sys.argv[1], "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    comp = Compactor(Config(), LazyEventLog.in_memory(), None)  # type: ignore[arg-type]
    kinds, texts = [], []
    for k, ci in enumerate(comps):
        off = events[ci][0]
        prev_off = events[comps[k - 1]][0] if k > 0 else 0
        win = [e for o, e in events if prev_off <= o < off]
        stored = events[ci][1].summary or ""
        kinds.append("SUM" if stored.lstrip().startswith(("## Objective", "# Objective")) else "CONT")
        texts.append(comp._serialize(win))
    n_cont = sum(1 for x in kinds if x == "CONT")
    print(f"{len(kinds)} compactions: SUM={len(kinds) - n_cont} CONT={n_cont}\n")
    rows = []
    for c in CANDIDATES:
        a = b = cc = d = 0
        for kind, t in zip(kinds, texts):
            if c in t:
                if kind == "SUM":
                    a += 1
                else:
                    b += 1
            elif kind == "SUM":
                cc += 1
            else:
                d += 1
        rows.append((abs(b - d), c, a, b, cc, d, (b == 0) or (d == 0)))
    rows.sort(key=lambda r: (not r[6], r[0]))
    print(f"{'marker':<34}{'inSUM':>6}{'inCONT':>7}{'noSUM':>6}{'noCONT':>7}  perfect")
    for _, c, a, b, cc, d, p in rows:
        print(f"{c[:34]!r:<34}{a:>6}{b:>7}{cc:>6}{d:>7}  {'YES' if p else ''}")


if __name__ == "__main__":
    main()
