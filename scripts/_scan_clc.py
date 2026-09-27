"""Cross-check every web_fetch in a .clc against the URLs web_search handed over.

Usage: python3 scripts/_scan_clc.py FILE.clc [FILE.clc ...]

Prints, per fetch call: the URL, whether it was seen verbatim in an earlier
web_search result (i.e. the model copied it), and the tool's verdict.
"""

from __future__ import annotations

import json
import sys
from collections import Counter

for path in sys.argv[1:]:
    seen_urls: set[str] = set()
    counts: Counter[str] = Counter()
    rows: list[tuple[int, str, str, str]] = []
    prev_call: tuple[str, str] | None = None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for ln, raw in enumerate(f, 1):
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "tool_call":
                if ev.get("name") == "web_fetch":
                    try:
                        args = json.loads(ev.get("arguments") or "{}")
                    except ValueError:
                        args = {}
                    prev_call = ("web_fetch", str(args.get("url", "")))
                elif ev.get("name") == "web_search":
                    prev_call = ("web_search", "")
                else:
                    prev_call = None
            elif t == "tool_result" and prev_call is not None:
                name, url = prev_call
                content = ev.get("content") or ""
                if name == "web_search":
                    for tok in content.split():
                        if tok.startswith("http"):
                            seen_urls.add(tok.rstrip(".,)"))
                else:
                    verdict = "?"
                    if content.startswith("ERROR"):
                        verdict = content.split("\n")[0][:90]
                        if "timed out" in content:
                            verdict = "TIMEOUT"
                        elif " 404 " in content or content.startswith("ERROR: HTTP 404"):
                            verdict = "HTTP 404"
                    else:
                        verdict = "OK"
                    counts[verdict.split(":")[0] if not verdict.startswith("ERROR") else verdict] += 1
                    rows.append((ln, url, "COPIED" if url in seen_urls else "GUESSED", verdict))
                prev_call = None
    print(f"\n===== {path}")
    for ln, url, origin, verdict in rows:
        print(f"[{ln:6}] {origin:7} {verdict:12} {url}")
    print(f"-- {len(seen_urls)} search URLs seen; fetch verdicts: {dict(counts)}")
