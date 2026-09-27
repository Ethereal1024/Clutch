"""Bisect the discriminator between a SUMMARY-producing and a
CONTINUATION-producing real compaction prompt.

variants:
  plain:K  - the prompt exactly as the code builds it for compaction K
  strip:K  - same, but the transcript's own copies of the prompt's STRUCTURAL
             TAGS are neutralized ('</conversation>' -> '[/conversation]', ...)
  swap:K   - same as plain:K but the leading instruction block is repeated after
             the transcript (the tailins control)

usage: _probe_bisect.py <file> variant [...]
"""

import re
import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render

OLD = re.compile(r"</?conversation>|</?template>|^#{1,6} Objective$|^Prior summary:$", re.M)


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


def sanitize(text):
    return OLD.sub(lambda m: m.group(0).replace("<", "[").replace(">", "]"), text)


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
    path = sys.argv[1]
    for v in sys.argv[2:]:
        mode, k = v.split(":")
        text, prev = build(path, int(k))
        full = render("compaction.md", history=text, previous_summary=prev or "(none)")
        if mode == "plain":
            content = full
        elif mode == "strip":
            content = render("compaction.md", history=sanitize(text), previous_summary=prev or "(none)")
        elif mode == "swap":
            cut = render("compaction.md", history="", previous_summary=prev or "(none)").find("<conversation>")
            head_block = render("compaction.md", history="", previous_summary=prev or "(none)")[:cut]
            body = render("compaction.md", history="", previous_summary=prev or "(none)")[:cut]
            content = body + "\n<conversation>\n" + text + "\n</conversation>\n\n" + head_block
        elif mode == "clean":
            # strip + the instructions moved after the transcript (both fixes)
            cut = render("compaction.md", history="", previous_summary=prev or "(none)").find("<conversation>")
            head_block = render("compaction.md", history="", previous_summary=prev or "(none)")[:cut]
            content = head_block + "\n<conversation>\n" + sanitize(text) + "\n</conversation>\n\n" + head_block
        else:
            raise SystemExit(f"unknown mode {mode}")
        out = collect(client, content)
        print(f"{v}: bytes={len(content.encode())} -> {classify(out)} ({len(out)} chars)")
        print("   ", out[:200].replace("\n", " ").replace("\uff5c", "|"))


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
