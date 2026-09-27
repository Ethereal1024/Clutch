"""Run one prompt variant over every compaction of a real .clc and compare the
model's reply kind with the kind that is actually stored in the log.

usage: _probe_corpus.py <file> <variant> [trials] [k_from] [k_to]

Prints one line per compaction:  k stored=SUM/CONT model=SUM/CONT  chars
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

from _probe_struct import build, classify, collect, messages  # noqa: E402

from agent.core.lazy import _parse_with_offsets  # noqa: E402
from agent.llm.factory import create_llm_client  # noqa: E402


def n_comps(path):
    raw = open(path, "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    return [i for i, (o, e) in enumerate(events) if e.type == "compaction"], events


def main():
    path = sys.argv[1]
    variant = sys.argv[2]
    trials = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    ks = [int(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 and "," in sys.argv[4] else None
    k_from = int(sys.argv[4]) if len(sys.argv) > 4 and ks is None else 0
    k_to = int(sys.argv[5]) if len(sys.argv) > 5 else 10**9
    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    comps, events = n_comps(path)
    agree = total = 0
    sums = 0
    for k in (ks if ks else range(k_from, min(k_to, len(comps)))):
        stored = events[comps[k]][1].summary or ""
        skind = "SUM" if stored.lstrip().startswith(("## Objective", "# Objective")) else "CONT"
        text, prev = build(path, k)
        msgs = messages(variant, text, prev)
        client = create_llm_client(
            api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
        )
        got = []
        for _ in range(trials):
            got.append(classify(collect(client, msgs)))
        kinds = set(got)
        mkind = got[0] if len(kinds) == 1 else "MIXED"
        total += 1
        agree += mkind == skind
        sums += mkind == "SUMMARY"
        print(f"k={k:>3} stored={skind} model={mkind:<12} {len(got[0]) if got else 0:>6}ch", flush=True)
    print(f"\n{variant}: {total} windows, agreement with stored kind {agree}/{total}, SUMMARY {sums}/{total}")


if __name__ == "__main__":
    main()
