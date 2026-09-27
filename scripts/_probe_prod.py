"""End-to-end: run the PRODUCTION compaction path (real Compactor, real prompt
template, real model) against a real window from school.clc and print what gets
stored as the summary.

usage: _probe_prod.py <file> <k> [k...]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, ".")
sys.path.insert(0, "scripts")

from _probe_cap import window  # noqa: E402

from agent.config import Config  # noqa: E402
from agent.core.compaction import Compactor  # noqa: E402
from agent.core.lazy import LazyEventLog  # noqa: E402
from agent.llm.factory import create_llm_client  # noqa: E402


def main():
    path = sys.argv[1]
    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    llm = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    for k in [int(x) for x in sys.argv[2:]]:
        events, _prev = window(path, k)
        log = LazyEventLog.in_memory()
        for ev in events:
            log.append(ev)
        conf = Config()
        comp = Compactor(conf, log, llm)
        window_events = [e for _o, e in log.items() if _o >= log.cpr_start()]
        text = comp._serialize(window_events)
        print(
            f"--- k={k}: window={sum(len(repr(e).encode()) for e in window_events)}B "
            f"transcript={len(text.encode())}B (whole window, no cap)",
            flush=True,
        )
        ok = comp.compact()
        comps = [e for _, e in log.items() if e.type == "compaction"]
        stored = comps[-1].summary if comps else ""
        print(f"    compact()={ok} stored={len(stored)}B head={stored[:160]!r}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
