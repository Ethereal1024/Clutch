"""Reconstruct the EXACT compaction prompt byte-for-byte for a chosen compaction
in a real .clc, using the repo's real code (LazyEventLog + Compactor._serialize +
prompts.render). Prints byte lengths vs the cap so we know whether the summary
prompt was truncated, and dumps the head/tail the model actually saw."""

import sys

sys.path.insert(0, ".")

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render


def resolve(p):
    if p == "cur":
        return "-".join(["compact", "fix"]) + "." + "clc"
    return p


def load_events(path):
    raw = open(path, "rb").read()
    sep = raw.find(b"---\n")
    base = sep + 4
    region = raw[base:]
    return base, _parse_with_offsets(region + b"\n", 0)


def main():
    path = resolve(sys.argv[1])
    which = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    base, events = load_events(path)
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    print(f"file={path} base={base} events={len(events)} compactions={[(i, events[i][0]) for i in comps]}")
    k = which
    ci = comps[k]
    start = 0 if k == 0 else comps[k - 1]
    prev_off = events[start][0] if k > 0 else 0
    cur_off = events[ci][0]
    window = [e for o, e in events if prev_off <= o < cur_off]
    prev_summary = events[comps[k - 1]][1].summary if k > 0 else ""
    cfg = Config()
    log = LazyEventLog.in_memory()
    # emulate exactly what the log looked like at the moment of that compaction:
    # the previous compaction event becomes the log's newest compaction
    if k > 0:
        log.append(events[comps[k - 1]][1])
    comp = Compactor(cfg, log, None)  # type: ignore[arg-type]
    text = comp._serialize(window)
    cap = cfg.llm_context_window_bytes - len(prev_summary.encode("utf-8")) - 8192
    prompt = render("compaction.md", history=text, previous_summary=prev_summary or "(none)")
    stored = events[ci][1].summary
    print(f"\n=== compaction #{k} at off={cur_off}")
    print(f"window events={len(window)} window_json_bytes={cur_off - prev_off}")
    print(f"prev_summary bytes={len(prev_summary.encode('utf-8'))} cap={cap}")
    print(f"serialized text bytes={len(text.encode('utf-8'))} chars={len(text)}")
    print(f"prompt bytes={len(prompt.encode('utf-8'))}")
    print(f"truncated={'[... earlier transcript elided ...]' in text or False}")
    print(f"stored summary len={len(stored)} starts={stored[:120]!r}")
    print("\n--- prompt HEAD 1200 ---")
    print(prompt[:1200])
    print("\n--- prompt TAIL 1200 ---")
    print(prompt[-1200:])


if __name__ == "__main__":
    main()
