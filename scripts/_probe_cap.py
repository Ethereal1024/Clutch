"""Does a bounded transcript budget restore summarization — with the ORIGINAL
top-contract template (no prompt edits at all)?

Root cause under test: commit 2511de4 replaced the summarizer's transcript cap
`max(8_000, (llm_context_window - compaction_reserved) // 3)` (= 39_333 chars)
with `llm_context_window_bytes - prev - 8192` (~490 KB). Compaction fires when
the window reaches llm_context_window_bytes, so the new cap can never bind and
the summarizer sees the whole window (200-500 KB) while the "reply with a
summary" contract sits at the top, hundreds of KB from the generation point.

usage: _probe_cap.py <file> <k:cap[:mode][,k:cap[:mode]...]> [trials]
  cap  = transcript cap in BYTES; 0 = uncapped (today's behaviour)
  mode = tail (pre-2511de4 trimming) | both (keep both ends)
"""

import string
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, ".")
sys.path.insert(0, "scripts")

from _probe_struct import classify, collect  # noqa: E402

from agent.core.lazy import _parse_with_offsets  # noqa: E402


def window(path, k):
    raw = open(path, "rb").read()
    base = raw.find(b"---\n") + 4
    events = [(o, e) for o, e in _parse_with_offsets(raw[base:] + b"\n", 0)]
    comps = [i for i, (o, e) in enumerate(events) if e.type == "compaction"]
    ci = comps[k]
    prev_off = events[comps[k - 1]][0] if k > 0 else 0
    win = [e for o, e in events if prev_off <= o < events[ci][0]]
    prev = events[comps[k - 1]][1].summary if k > 0 else ""
    return win, prev


def serialize(events, cap, mode):
    lines = []
    for ev in events:
        t = ev.type
        if t == "user_message":
            lines.append(f"[User]: {ev.content}")
        elif t == "assistant_message":
            if ev.content:
                lines.append(f"[Assistant]: {ev.content}")
            if ev.reasoning:
                lines.append(f"[Assistant reasoning]: {ev.reasoning}")
            for tc in ev.tool_calls:
                lines.append(f"[Assistant tool call]: {tc['name']}({tc['arguments']})")
        elif t == "tool_result":
            out = ev.content
            if len(out) > 500:
                out = out[:500] + "\n[truncated]"
            lines.append(f"[Tool result]: {out}")
    text = "\n".join(lines)
    if not cap or len(text) <= cap:
        return text
    if mode == "tail":  # pre-2511de4
        return text[-cap:]
    marker = "\n[... earlier transcript elided ...]\n"
    budget = max(cap - len(marker), 0)
    head, tail = text[: budget // 4], text[-budget + budget // 4 :]
    nl = head.rfind("\n")
    head = head[:nl] if nl != -1 else ""
    nl = tail.find("\n")
    if nl != -1:
        tail = tail[nl + 1 :]
    return head + marker + tail


def top_prompt(history, prev):
    """The template as it stands at git HEAD (contract only at the top)."""
    raw = subprocess.run(
        ["git", "show", "HEAD:agent/prompts/compaction.md"], capture_output=True, text=True, check=True
    ).stdout
    return string.Template(raw).safe_substitute(history=history, previous_summary=prev or "(none)")


def work_prompt(history, prev):
    """The working-tree template (identical to HEAD plus the trailing contract)."""
    raw = open("agent/prompts/compaction.md", encoding="utf-8").read()
    return string.Template(raw).safe_substitute(history=history, previous_summary=prev or "(none)")


def main():
    path = sys.argv[1]
    specs = []
    for item in sys.argv[2].split(","):
        bits = item.split(":")
        specs.append((int(bits[0]), int(bits[1]), bits[2] if len(bits) > 2 else "tail"))
    trials = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    tmpl = sys.argv[4] if len(sys.argv) > 4 else "top"
    build_prompt = work_prompt if tmpl == "work" else top_prompt

    import json

    from agent.llm.factory import create_llm_client

    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    client = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    cache: dict[int, tuple] = {}
    for k, cap, mode in specs:
        if k not in cache:
            cache[k] = window(path, k)
        win, prev = cache[k]
        text = serialize(win, cap, mode)
        prompt = build_prompt(text, prev)
        size = len(prompt.encode())
        outs = [collect(client, [{"role": "user", "content": prompt}]) for _ in range(trials)]
        kinds = [classify(o) for o in outs]
        kind = kinds[0] if len(set(kinds)) == 1 else "MIXED:" + ",".join(kinds)
        snippet = (outs[0] or "")[:110].replace("\n", "\\n")
        print(
            f"k={k:>3} cap={cap:>7} mode={mode:<4} prompt={size:>8}B -> {kind:<12} | {snippet}",
            flush=True,
        )
    print("\ndone", flush=True)


if __name__ == "__main__":
    main()
