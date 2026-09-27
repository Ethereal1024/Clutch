"""Locate the bad compaction summaries and their source assistant text in school.clc.

Run: PYTHONPATH=. .venv/bin/python scripts/_probe_evidence.py
"""

from __future__ import annotations

import json

PATH = "school.clc"

BAD = [
    "I have the first repro",
    "I have enough evidence",
    "Let me trace exactly",
    "I'll continue by verifying",
    "Let me find the code change",
]


def events():
    out = []
    with open(PATH, encoding="utf-8", errors="replace") as f:
        for ln, raw in enumerate(f, 1):
            raw = raw.strip()
            if not raw.startswith("{"):
                continue
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            out.append((ln, ev))
    return out


def main() -> None:
    evs = events()
    print(f"parsed {len(evs)} events")
    for key in BAD:
        print(f"\n===== {key!r}")
        for ln, ev in evs:
            t = ev.get("type")
            blob = ""
            if t == "assistant_message":
                blob = (ev.get("content") or "") + "\n<<REASONING>>\n" + (ev.get("reasoning") or "")
            elif t == "compaction":
                blob = ev.get("summary") or ""
            elif t == "user_message":
                blob = ev.get("content") or ""
            if key in blob:
                where = []
                if t == "assistant_message":
                    if key in (ev.get("content") or ""):
                        where.append("content")
                    if key in (ev.get("reasoning") or ""):
                        where.append("reasoning")
                print(f"  line {ln} {t} {'/'.join(where)} len={len(blob)}")
                i = blob.find(key)
                print("    ...", repr(blob[max(0, i - 60):i + 220]))
    # print the assistant turns immediately preceding each bad compaction
    print("\n===== assistant turns preceding each bad compaction =====")
    for idx, (ln, ev) in enumerate(evs):
        if ev.get("type") != "compaction":
            continue
        s = ev.get("summary") or ""
        if "## Objective" in s:
            continue
        # walk back to the previous assistant_message
        prev = None
        for j in range(idx - 1, max(0, idx - 40), -1):
            if evs[j][1].get("type") == "assistant_message" and (evs[j][1].get("content") or evs[j][1].get("tool_calls")):
                prev = evs[j]
                break
        print(f"\n-- compaction line {ln} len={len(s)}")
        print("   summary head:", repr(s[:160]))
        if prev:
            pln, pev = prev
            print(f"   prev assistant line {pln} content:", repr((pev.get("content") or "")[:160]))
            print("   prev assistant reasoning:", repr((pev.get("reasoning") or "")[:160]))


if __name__ == "__main__":
    main()
