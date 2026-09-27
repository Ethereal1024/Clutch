"""Feed the EXACT reconstructed compaction prompt of a real .clc compaction to
the real model, and print what comes back — reproduces (or not) the bad-summary
bug on a known-bad compaction.

usage: _probe0.py [file|cur] [index] [--raw]
"""

import sys
from pathlib import Path

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render


def resolve(p):
    if p == "cur":
        return "-".join(["compact", "fix"]) + "." + "clc"
    return p


def main():
    import json

    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    from agent.llm.factory import create_llm_client

    model = cfg["model"]
    for i, a in enumerate(sys.argv):
        if a == "--model":
            model = sys.argv[i + 1]
    client = create_llm_client(
        api_key=cfg["api_key"], model=model, base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    path = resolve(sys.argv[1])
    k = int(sys.argv[2])
    raw = open(path, "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    ci = comps[k]
    start = 0 if k == 0 else comps[k - 1]
    prev_off = events[start][0] if k > 0 else 0
    window = [e for o, e in events if prev_off <= o < events[ci][0]]
    prev = events[comps[k - 1]][1].summary if k > 0 else ""
    comp = Compactor(Config(), LazyEventLog.in_memory(), client)  # type: ignore[arg-type]
    text = comp._serialize(window)
    prompt = render("compaction.md", history=text, previous_summary=prev or "(none)")
    print(f"model={model} prompt bytes={len(prompt.encode('utf-8'))} events={len(window)}")
    evs = []
    try:
        for ev in client.stream([{"role": "user", "content": prompt}], tools=None, cancel=None):
            evs.append(ev)
            if len(evs) > 20000:
                break
    except Exception as e:  # noqa: BLE001
        print("ERROR:", type(e).__name__, getattr(e, "code", None), getattr(e, "message", None) or e)
        return
    out = "".join(e.get("delta", "") for e in evs if e["type"] == "text")
    reasoning = "".join(e.get("delta", "") for e in evs if e["type"] == "reasoning")
    print("event kinds:", sorted({e["type"] for e in evs}), "n=", len(evs))
    print(f"reasoning len={len(reasoning)}")
    print(f"TEXT len={len(out)}")
    print(out[:3000])


if __name__ == "__main__":
    main()
