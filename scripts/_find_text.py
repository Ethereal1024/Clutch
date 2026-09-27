"""Find every event in a .clc whose textual payload contains a needle, printing
offset, type and neighbors — used to tell whether a bad compaction summary is an
echo of some other event in the same log."""

import json
import sys

from _dump_around import load, preview


def resolve(p):
    if p == "cur":
        return "-".join(["compact", "fix"]) + "." + "clc"
    return p


def main():
    path = resolve(sys.argv[1])
    needle = sys.argv[2]
    base, evs = load(path)
    print(f"file={path} base={base} events={len(evs)}")
    hits = []
    for i, (o, d) in enumerate(evs):
        blob = json.dumps(d, ensure_ascii=False)
        if needle in blob:
            hits.append(i)
    print(f"hits: {hits}")
    for i in hits:
        o, d = evs[i]
        print(f"--- [{i}] off={o} {preview(d, 400)}")
        for j in range(max(0, i - 2), min(len(evs), i + 3)):
            mark = "  <<<" if j == i else ""
            print(f"    [{j}] off={evs[j][0]} {preview(evs[j][1], 240)}{mark}")


if __name__ == "__main__":
    main()
