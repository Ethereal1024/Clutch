"""Isolate WHICH structural tag inside the transcript flips the summarizer into
"continue the conversation" mode.

variants: conv, tmpl, objective, prior, instr (the instruction text itself)

usage: _probe_marker.py <file> <k> <family> [...]
"""

import re
import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render

FAMILIES = {
    "conv": re.compile(r"</?conversation>"),
    "tmpl": re.compile(r"</?template>"),
    "objective": re.compile(r"^#{1,6}\s*Objective\s*$", re.M),
    "prior": re.compile(r"^Prior summary:\s*$", re.M),
    "instr": re.compile(r"^Output exactly the Markdown structure.*$", re.M),
}


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
    return comp._serialize(window), prev


def neutralize(text, family):
    pat = FAMILIES[family]
    return pat.sub(lambda m: m.group(0).replace("<", "[").replace(">", "]"), text)


def classify(out):
    if "## Objective" in out and "## Work State" in out:
        return "SUMMARY"
    if "DSML" in out or "[Assistant tool call]" in out:
        return "CONTINUATION"
    return "OTHER"


def main():
    import json
    from pathlib import Path

    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    from agent.llm.factory import create_llm_client

    client = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    path, k = sys.argv[1], int(sys.argv[2])
    text, prev = build(path, k)
    print(f"k={k} transcript={len(text.encode())}B")
    for family in sys.argv[3:]:
        body = text if family == "none" else neutralize(text, family)
        content = render("compaction.md", history=body, previous_summary=prev or "(none)")
        out = collect(client, content)
        n = len(FAMILIES[family].findall(text)) if family in FAMILIES else "-"
        print(f"{family}: neutralized {n} occurrences -> {classify(out)} ({len(out)} chars)")
        print("   ", out[:160].replace("\n", " ").replace("\uff5c", "|"))


def collect(client, content):
    evs = []
    try:
        for ev in client.stream([{"role": "user", "content": content}], tools=None, cancel=None):
            evs.append(ev)
            if len(evs) > 20000:
                break
    except Exception as e:  # noqa: BLE001
        print("ERROR:", type(e).__name__, getattr(e, "code", None), getattr(e, "message", None) or e)
        return ""
    return "".join(e.get("delta", "") for e in evs if e["type"] == "text")


if __name__ == "__main__":
    main()
