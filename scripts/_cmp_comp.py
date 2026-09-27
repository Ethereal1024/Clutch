"""Compare prompts of a GOOD and a BAD compaction from the same log: size,
last events, and marker strings that could switch the model's behaviour.

usage: _cmp_comp.py <file> <k_good> <k_bad>
"""

import sys
from collections import Counter

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render

MARKERS = [
    "<template>",
    "Output exactly the Markdown structure",
    "## Objective",
    "</conversation>",
    "<conversation>",
    "Prior summary:",
    "DSML",
    "<｜｜DSML｜｜",
    "compaction",
    "compact",
    "[Assistant reasoning]",
    "[Assistant tool call]",
    "[Tool result]",
    "[Assistant]:",
    "[User]:",
]


def build(path, k):
    raw = open(path, "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    ci = comps[k]
    prev_off = events[comps[k - 1]][0] if k > 0 else 0
    window = [e for o, e in events if prev_off <= o < events[ci][0]]
    prev = events[comps[k - 1]][1].summary if k > 0 else ""
    comp = Compactor(Config(), LazyEventLog.in_memory(), None)  # type: ignore[arg-type]
    text = comp._serialize(window)
    prompt = render("compaction.md", history=text, previous_summary=prev or "(none)")
    stored = events[ci][1].summary
    return window, text, prev, prompt, stored


def main():
    path, kg, kb = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    for label, k in (("GOOD", kg), ("BAD", kb)):
        window, text, prev, prompt, stored = build(path, k)
        print(f"\n===== {label} k={k}")
        print(f"  window events={len(window)} jsonB={sum(1 for _ in window)}")
        print(f"  serialized={len(text.encode())}B prev={len(prev.encode())}B prompt={len(prompt.encode())}B")
        print(f"  stored starts: {stored[:70]!r}")
        print(f"  last 6 window events: {[e.type for e in window[-6:]]}")
        print(f"  event type counts: {Counter(e.type for e in window)}")
        for m in MARKERS:
            print(f"    {m!r:38} in text: {text.count(m):>4}   in prompt: {prompt.count(m):>4}")
        print(f"  transcript HEAD: {text[:200]!r}")
        print(f"  transcript TAIL: {text[-300:]!r}")
        # reasoning share
        import re

        rs = sum(len(m) for m in re.findall(r"^\[Assistant reasoning\]: .*$", text, re.M))
        print(f"  reasoning share: {rs}B / {len(text.encode())}B")


if __name__ == "__main__":
    main()
