"""Bisect WHY the runtime compaction gets a "continue the transcript" reply.

Replays one real compaction's prompt against the real model in several variants
so the trigger becomes observable:

  full     - the prompt as the code builds it (instructions + transcript)
  noinstr  - the transcript alone (what the model would see if the instruction
             block never made it into the message)
  tools    - the full prompt, but the request carries the tool schemas (what the
             model would see if the compactor leaked the agent's tools)
  tail     - instructions + only the transcript's tail (what a tiny cap would
             produce via the old tail-only truncation)

usage: _probe_variants.py <file|cur> <compaction-index> <variant> [...] 
"""

import sys
from pathlib import Path

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render
from agent.tools.registry import ToolRegistry, build_tools


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
    start = 0 if k == 0 else comps[k - 1]
    prev_off = events[start][0] if k > 0 else 0
    window = [e for o, e in events if prev_off <= o < events[ci][0]]
    prev = events[comps[k - 1]][1].summary if k > 0 else ""
    comp = Compactor(Config(), LazyEventLog.in_memory(), None)  # type: ignore[arg-type]
    text = comp._serialize(window)
    return text, prev


def classify(out: str) -> str:
    if "## Objective" in out and "## Work State" in out:
        return "SUMMARY"
    if "DSML" in out or "[Assistant tool call]" in out:
        return "CONTINUATION(toolcall)"
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
    variants = sys.argv[3:] or ["full"]
    text, prev = build(path, k)
    full = render("compaction.md", history=text, previous_summary=prev or "(none)")
    schemas = ToolRegistry(build_tools(Config())).schemas()
    print(f"file={path} compaction#{k} transcript bytes={len(text.encode('utf-8'))} tools={len(schemas)}")
    for v in variants:
        if v == "full":
            prompt, tools = full, None
        elif v == "noinstr":
            prompt, tools = text, None
        elif v == "tools":
            prompt, tools = full, schemas
        elif v == "tail":
            prompt = render("compaction.md", history=text[-40000:], previous_summary=prev or "(none)")
            tools = None
        else:
            raise SystemExit(f"unknown variant {v}")
        out = collect(client, prompt, tools)
        print(f"\n### variant={v} prompt={len(prompt.encode('utf-8'))} -> {classify(out)} ({len(out)} chars)")
        print(out[:500])


def collect(client, prompt, tools):
    evs = []
    try:
        for ev in client.stream([{"role": "user", "content": prompt}], tools=tools, cancel=None):
            evs.append(ev)
            if len(evs) > 20000:
                break
    except Exception as e:  # noqa: BLE001
        print("ERROR:", type(e).__name__, getattr(e, "code", None), getattr(e, "message", None) or e)
        return ""
    return "".join(e.get("delta", "") for e in evs if e["type"] == "text")


if __name__ == "__main__":
    main()
