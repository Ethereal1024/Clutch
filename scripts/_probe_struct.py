"""Which prompt STRUCTURE reliably makes the summarizer summarize?

Same real transcript (school.clc k=68, a known CONTINUATION case), repeated trials
per variant so sampling noise cannot masquerade as a fix.

  top      - today's template: instructions, prior summary, <conversation> (baseline)
  bottom   - the same instruction block moved AFTER the transcript
  nostags  - today's template, transcript's own <conversation> tags neutralized
  old      - the pre-05c9b33 wording, transcript last
  system   - instructions as a system message, transcript as the user message
  bottomns - instructions at the end AND tags neutralized

usage: _probe_struct.py <file> <k> <variant> [trials]
"""

import re
import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render

TAG = re.compile(r"</?conversation>")

OLD_INSTR = """Write a thorough rolling summary of the conversation below. This summary REPLACES the
conversation — a later session must be able to continue the work from it alone, so
include enough detail. Preserve:
- the user's goal and the current task,
- every file that was read or written, with its path and what it does / was changed,
- key decisions and their reasons,
- the exact current state of the work (what is done, what is left, in what order),
- any open errors, failing tests, or unresolved items and the next concrete step.

Name files explicitly by path — the exact file contents are gone after compaction,
so the reader must know which files to re-read. If a previous summary is given, keep
its still-relevant content and fold in only what changed."""


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


def classify(out):
    if "## Objective" in out and "## Work State" in out:
        return "SUMMARY"
    if "DSML" in out or "[Assistant tool call]" in out:
        return "CONTINUATION"
    return "OTHER"


def messages(variant, text, prev):
    instr = render("compaction.md", history="", previous_summary=prev or "(none)")
    cut = instr.find("<conversation>")
    block = instr[:cut]  # instructions + prior summary
    if variant == "top":
        return [{"role": "user", "content": render("compaction.md", history=text, previous_summary=prev or "(none)")}]
    if variant == "bottom":
        body = block + "\n<conversation>\n" + text + "\n</conversation>\n\n"
        return [{"role": "user", "content": body + tail_contract()}]
    if variant == "nostags":
        return [
            {
                "role": "user",
                "content": render("compaction.md", history=TAG.sub(lambda m: "[" + m.group(0)[1:-1] + "]", text),
                                  previous_summary=prev or "(none)"),
            }
        ]
    if variant == "old":
        return [{"role": "user", "content": OLD_INSTR + "\n\nPrevious summary:\n" + (prev or "(none)") + "\n\nConversation to summarize:\n" + text}]
    if variant == "system":
        return [{"role": "system", "content": block}, {"role": "user", "content": "<conversation>\n" + text + "\n</conversation>\n\n" + tail_contract()}]
    if variant == "sysonly":
        return [{"role": "system", "content": block}, {"role": "user", "content": "<conversation>\n" + text + "\n</conversation>\n"}]
    if variant == "endcontract":
        top = render("compaction.md", history=text, previous_summary=prev or "(none)")
        return [{"role": "user", "content": top + "\n\n" + tail_contract()}]
    if variant == "bottomns":
        body = block + "\n<conversation>\n" + TAG.sub(lambda m: "[" + m.group(0)[1:-1] + "]", text) + "\n</conversation>\n\n"
        return [{"role": "user", "content": body + tail_contract()}]
    raise SystemExit(f"unknown variant {variant}")


def tail_contract():
    return (
        "The <conversation> above has ENDED — it is history, not a conversation you are part of; "
        "do not continue it, do not call tools, do not answer its last message. Your whole reply is "
        "one summary of it, in exactly the Markdown structure defined above (Objective / Important "
        "Details / Work State / Next Move / Relevant Files) and nothing else."
    )


def main():
    import json
    from pathlib import Path

    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    from agent.llm.factory import create_llm_client

    client = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    path, k = sys.argv[1], int(sys.argv[2])
    variant = sys.argv[3]
    trials = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    text, prev = build(path, k)
    msgs = messages(variant, text, prev)
    size = sum(len(str(m["content"]).encode()) for m in msgs)
    results = []
    for i in range(trials):
        out = collect(client, msgs)
        kind = classify(out)
        results.append(kind)
        print(f"{variant} trial{i}: {size}B -> {kind} ({len(out)} chars)")
    print(f"== {variant}: {results}")


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
