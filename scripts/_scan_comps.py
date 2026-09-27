"""List every compaction event in a .clc: offset, size, and whether the summary
looks like a real summary (starts with '## Objective') or the model's raw
next-action text (the bug symptom)."""

import datetime
import json
import re
import sys


def scan(path: str) -> None:
    data = open(path, "rb").read()
    sep = data.find(b"\n---\n")
    base = sep + 5
    head = data[:sep].decode("utf-8", "replace")
    m = re.search(r"cpr_start=(\d+)", head)
    cpr = int(m.group(1)) if m else 0
    print(f"file={path} bytes={len(data)} base={base} cpr_start={cpr}")
    body = data[base:]
    off = 0
    comps = []
    for seg in body.split(b"\n"):
        o = off
        off += len(seg) + 1
        if not seg.strip():
            continue
        try:
            d = json.loads(seg.decode("utf-8", "replace"))
        except Exception:
            continue
        if isinstance(d, dict) and d.get("type") == "compaction":
            comps.append((o, d.get("summary", ""), d.get("timestamp")))
    print("compactions:", len(comps))
    for i, (o, s, ts) in enumerate(comps):
        t = datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M") if ts else "?"
        ok = s.lstrip().startswith("## Objective")
        print(f"#{i} off={o} ts={t} len={len(s)} ok={ok} :: {s[:120]!r}")
        if not ok:
            print("    tail:", repr(s[-200:]))


if __name__ == "__main__":
    for p in sys.argv[1:] or ["school.clc"]:
        scan(p)
