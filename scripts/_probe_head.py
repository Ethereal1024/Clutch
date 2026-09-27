"""Two discriminators for the long-input compaction failure.

  askhead - the real failing prompt (instructions at the top, 228 KB) with ONE
            plain line appended at the end asking the model to quote the very
            FIRST characters of the <conversation> block. If it can, the head of
            the message is still visible to the model (no provider trimming);
            the failure is instruction-following, not a lost prefix.
  headq   - same, but the question is about a marker planted at the START of the
            transcript, so the answer cannot be guessed.
  size:N  - transcript tail of N bytes with the normal template (cliff hunting)

usage: _probe_head.py <file> <k> variant [...]
"""

import sys
from pathlib import Path

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render


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


MARKER = "ZQ7-MARKER-4417"


def main():
    import json

    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    from agent.llm.factory import create_llm_client

    client = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    path = sys.argv[1]
    k = int(sys.argv[2])
    text, prev = build(path, k)
    print("transcript head:", repr(text[:160]))
    full = render("compaction.md", history=text, previous_summary=prev or "(none)")
    for v in sys.argv[3:]:
        if v == "askhead":
            msgs = [
                {
                    "role": "user",
                    "content": full
                    + "\n\nDiagnostic task, answer this only: output the first 80 characters that appear right after "
                    "the '<conversation>' line above, verbatim, inside a code block. Nothing else.",
                }
            ]
        elif v == "marker":
            # plant a marker as the FIRST transcript line, keeping the size the same
            body = MARKER + ": remember this token\n" + text
            msgs = [
                {
                    "role": "user",
                    "content": render("compaction.md", history=body, previous_summary=prev or "(none)")
                    + f"\n\nDiagnostic task, answer this only: what value follows the token '{MARKER}' in the "
                    "<conversation> above? Reply with the value alone.",
                }
            ]
        elif v.startswith("size:"):
            n = int(v.split(":")[1])
            body = text.encode()[-n:].decode("utf-8", "ignore")
            msgs = [{"role": "user", "content": render("compaction.md", history=body, previous_summary=prev or "(none)")}]
        else:
            raise SystemExit(f"unknown variant {v}")
        out = collect(client, msgs)
        print(f"\n### {v} -> {len(out)} chars\n{out[:600]}")


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
