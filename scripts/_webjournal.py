"""Print every web_search/web_fetch call in a .clc with its result head.

Usage: python3 scripts/_webjournal.py FILE.clc [head_chars]
"""

from __future__ import annotations

import json
import sys

path = sys.argv[1]
head = int(sys.argv[2]) if len(sys.argv) > 2 else 160
pending: str | None = None

with open(path, "r", encoding="utf-8", errors="replace") as f:
    for ln, raw in enumerate(f, 1):
        try:
            ev = json.loads(raw)
        except ValueError:
            continue
        t = ev.get("type")
        if t == "user_message" and "web" not in (ev.get("content") or "")[:20]:
            pass
        if t == "tool_call":
            name = ev.get("name")
            if name in ("web_search", "web_fetch"):
                pending = f"[{ln}] {name} {ev.get('arguments', '')[:200]}"
            else:
                if pending:
                    print(pending + "   << result not captured")
                    pending = None
        elif t == "tool_result" and pending is not None:
            content = (ev.get("content") or "").replace("\n", "\\n")
            print(f"{pending}\n      -> {content[:head]}")
            pending = None
