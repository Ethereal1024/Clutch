"""Mechanism probe: why does a LONG transcript make the model ignore the
compaction instructions and continue the conversation instead?

Takes a real compaction prompt (rebuilt by the repo's own code) and replays
variants of it against the real model:

  full    - instructions + full transcript (known bad)
  size:N  - instructions + transcript tail of N bytes (find the cliff)
  tailins - instructions moved AFTER the transcript
  sys     - instructions as a system message, transcript as the user message
  noreas  - transcript with [Assistant reasoning] lines stripped
  head    - instructions + transcript HEAD only (same size as a failing tail)

usage: _probe_mech.py <file> <k> variant [...]
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


def classify(out: str) -> str:
    if "## Objective" in out and "## Work State" in out:
        return "SUMMARY"
    if "DSML" in out or "[Assistant tool call]" in out:
        return "CONTINUATION"
    return "OTHER"


def main():
    import json

    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    from agent.llm.factory import create_llm_client

    client = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    path = resolve(sys.argv[1])
    k = int(sys.argv[2])
    text, prev = build(path, k)
    instr = render("compaction.md", history="", previous_summary=prev or "(none)")
    # the instruction block up to where the transcript begins
    cut = instr.find("<conversation>")
    head_block = instr[:cut]
    full = render("compaction.md", history=text, previous_summary=prev or "(none)")
    print(f"file={path} k={k} transcript={len(text.encode())}B full_prompt={len(full.encode())}B")
    for v in sys.argv[3:]:
        if v == "full":
            msgs = [{"role": "user", "content": full}]
        elif v.startswith("size:"):
            n = int(v.split(":")[1])
            body = text.encode()[-n:].decode("utf-8", "ignore")
            msgs = [{"role": "user", "content": render("compaction.md", history=body, previous_summary=prev or "(none)")}]
        elif v.startswith("head:"):
            n = int(v.split(":")[1])
            body = text.encode()[:n].decode("utf-8", "ignore")
            msgs = [{"role": "user", "content": render("compaction.md", history=body, previous_summary=prev or "(none)")}]
        elif v == "tailins":
            msgs = [{"role": "user", "content": render("compaction.md", history="", previous_summary=prev or "(none)")
                      .replace("$history", "") + "\n\n<conversation>\n" + text + "\n</conversation>\n\n" + head_block}]
        elif v == "sys":
            body = render("compaction.md", history=text, previous_summary=prev or "(none)").replace(head_block, "")
            msgs = [{"role": "system", "content": head_block}, {"role": "user", "content": body}]
        elif v == "noreas":
            lines = [ln for ln in text.splitlines() if not ln.startswith("[Assistant reasoning]:")]
            msgs = [{"role": "user", "content": render("compaction.md", history="\n".join(lines), previous_summary=prev or "(none)")}]
        else:
            raise SystemExit(f"unknown variant {v}")
        out = collect(client, msgs)
        print(f"\n### {v} bytes={sum(len(str(m['content']).encode()) for m in msgs)} -> {classify(out)} ({len(out)} chars)")
        print(out[:400])


def collect(client, msgs):
    evs = []
    try:
        for ev in client.stream(msgs, tools=None, cancel=None):
            evs.append(ev)
            if len(evs) > 20000:
                break
    except Exception as e:  # noqa: BLE001
        print("ERROR:", type(e).__name__, getattr(e, "code", None), getattr(e, "message", None) or e)
        return ""
    return "".join(e.get("delta", "") for e in evs if e["type"] == "text")


if __name__ == "__main__":
    main()
