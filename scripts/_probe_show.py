"""Show the summarizer's raw reply for a given compaction window (fidelity check).

usage: _probe_show.py <file> <k> [chars] [trials]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

from _probe_struct import build, collect  # noqa: E402  (same directory)

from agent.llm.factory import create_llm_client  # noqa: E402


def main():
    path, k = sys.argv[1], int(sys.argv[2])
    nchars = int(sys.argv[3]) if len(sys.argv) > 3 else 900
    trials = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    client = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    text, prev = build(path, k)
    msgs = [{"role": "user", "content": open("agent/prompts/compaction.md").read().replace(
        "$history", text).replace("$previous_summary", prev or "(none)")}]
    prompt = msgs[0]["content"]
    print(f"prompt {len(prompt.encode())}B  prev {len(prev)}  cjk+ascii split:")
    cjk = sum(1 for ch in prompt if "\u4e00" <= ch <= "\u9fff")
    print(f"  cjk chars={cjk}  nonascii={sum(1 for ch in prompt if ord(ch) > 127)}  len={len(prompt)}")
    print("  head:", repr(prompt[:150]))
    print("  tail:", repr(prompt[-150:]))
    for i in range(trials):
        out = collect(client, msgs)
        print(f"--- trial{i}: {len(out)} chars")
        print(out[:nchars])
        print("...")


if __name__ == "__main__":
    main()
