"""Why did the relevance guard reject this query? Prints bing's parsed items
plus the token sets the guard compares.

Usage: python3 scripts/_guard_debug.py "query"
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ws", Path(__file__).resolve().parent.parent / "clutch-websearch" / "websearch.py"
)
ws = importlib.util.module_from_spec(spec)
sys.modules["ws"] = ws  # dataclasses resolves cls.__module__ through sys.modules
spec.loader.exec_module(ws)

query = sys.argv[1]
s = ws.load_settings()
limit = 8
print("available backends:", ws.available_backends(s))
for name in ("bing", "ddg"):
    try:
        results = ws.all_backends()[name].search(query, limit, s, ws._http_get)
    except Exception as e:  # noqa: BLE001
        print(f"\n--- {name}: FAILED {type(e).__name__}: {e}")
        continue
    print(f"\n--- {name}: {len(results)} raw items; guard says relevant={ws.looks_relevant(query, results)}")
    for i, r in enumerate(results, 1):
        print(f"{i}. {r['title']}\n   {r['url']}\n   {r['snippet'][:120]}")
words, grams = ws._query_terms(query)
print("\nquery terms:", sorted(words), "| grams:", sorted(grams)[:12])
