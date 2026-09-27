"""Dump a specific event's full text from school.clc.

Usage: PYTHONPATH=. .venv/bin/python scripts/_dump_event.py LINE [content|reasoning|summary]
"""

from __future__ import annotations

import json
import sys

PATH = "school.clc"
target = int(sys.argv[1])
field = sys.argv[2] if len(sys.argv) > 2 else "content"

with open(PATH, encoding="utf-8", errors="replace") as f:
    for ln, raw in enumerate(f, 1):
        if ln != target:
            continue
        ev = json.loads(raw)
        print(f"type={ev.get('type')} ts={ev.get('timestamp')}")
        print("=" * 60)
        if field == "reasoning":
            print(ev.get("reasoning") or "(none)")
        elif field == "summary":
            print(ev.get("summary") or "(none)")
        else:
            print(ev.get("content") or "(none)")
        break
