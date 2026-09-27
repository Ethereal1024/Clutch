"""What does the model actually see for web_search/web_fetch on this host?

Usage: python3 scripts/_desc_dump.py
"""

from __future__ import annotations

import json
from pathlib import Path

from agent.config import Config
from agent.tools.registry import build_tools

tools = {t.name: t for t in build_tools(Config())}
print("tools:", sorted(tools))
for name in ("web_search", "web_fetch"):
    t = tools.get(name)
    if t is None:
        print(f"\n### {name}: NOT OFFERED")
        continue
    print(f"\n### {name}\n{t.description}\n--- schema ---")
    print(json.dumps(t.parameters, ensure_ascii=False, indent=1))
