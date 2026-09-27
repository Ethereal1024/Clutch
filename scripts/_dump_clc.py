"""Dump a slice of a .clc session log: python3 scripts/_dump_clc.py FILE LO HI [chars]"""

from __future__ import annotations

import json
import sys

path, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
chars = int(sys.argv[4]) if len(sys.argv) > 4 else 700

with open(path, "r", encoding="utf-8", errors="replace") as f:
    for ln, raw in enumerate(f, 1):
        if ln < lo or ln > hi:
            continue
        try:
            ev = json.loads(raw)
        except ValueError:
            print(f"[{ln}] <unparsed>")
            continue
        t = ev.get("type")
        if t == "tool_call":
            print(f"[{ln}] CALL {ev.get('name')} {ev.get('arguments', '')[:300]}")
        elif t == "tool_result":
            content = (ev.get("content") or "").replace("\n", "\\n")
            print(f"[{ln}] RESULT {content[:chars]}")
        elif t == "assistant_message":
            print(f"[{ln}] ASSISTANT {(ev.get('content') or '')[:chars]}")
        elif t == "user_message":
            print(f"[{ln}] USER {(ev.get('content') or '')[:300]}")
        else:
            print(f"[{ln}] {t}")
